/*
 * Copyright (c) 2026 Pingolin LLC
 * This file is part of Pingolin Note.
 *
 * Pingolin Note is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Pingolin Note is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Pingolin Note. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * The writes of a restore or an import, kept under the server's per-user write
 * limit, and sent again when they meet it.
 *
 * The note server allows each user 300 writes per rolling 60 s (reads are not
 * limited). Over it, the server answers 429 `rate_limit_exceeded` before any
 * handler runs, so that answer created and changed nothing. Taken as the
 * note's own answer, it would make a re-restore of a large file, or one
 * restore straight after another, report notes that were present as
 * "couldn't be restored".
 *
 * Two parts:
 *  - the budget: at most 200 writes per rolling 60 s for one run, which leaves
 *    the page's own saves, syncs and re-keying (the re-key drain shares this
 *    budget) room to land;
 *  - the resend: only on that 429, the SAME request again through apiRequest
 *    (so accountFetch still names the account), after the answer's Retry-After
 *    (at most 60 s) or 2, 4, 8, 16, 32 s, never more than 122 s in all; then
 *    the last answer stands.
 */

import type { ApiResponse } from '../apiClient';
import { ACCOUNT_MISMATCH, AccountMismatchError, getTabAccount } from '../account';

/** The note server's error_code for it, those exact bytes. */
export const RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded';

/** The waits before each resend when the answer names none: 62 s in all,
 *  longer than the window the limit counts over. */
export const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000] as const;

/** Writes one run may send per rolling window, and the window. */
export const WRITES_PER_WINDOW = 200;
export const WINDOW_MS = 60_000;

/** The most one Retry-After is waited, and the most a write waits in all: the
 *  schedule plus one capped wait. A header can't stall a restore beyond it. */
export const RETRY_AFTER_CAP_MS = 60_000;
export const MAX_TOTAL_WAIT_MS = BACKOFF_MS.reduce((a, b) => a + b, 0) + RETRY_AFTER_CAP_MS;

/** The limit's own answer, and nothing else: status 429 AND its code. */
export function isRateLimited(r: ApiResponse<unknown>): boolean {
  return !r.success && r.status === 429 && r.error_code === RATE_LIMIT_EXCEEDED;
}

/** A Retry-After value as milliseconds from `now`, at most RETRY_AFTER_CAP_MS:
 *  delta-seconds or an HTTP date. Null — the schedule then — when there is none,
 *  or it is malformed, negative or a date already past. */
export function retryAfterMs(raw: string | null | undefined, now: number): number | null {
  if (!raw) return null;
  const v = raw.trim();
  let ms: number;
  if (/^\d+$/.test(v)) {
    ms = Number(v) * 1000;
  } else {
    // An HTTP date names its weekday; anything else (a signed number, a word)
    // is not one, whatever Date.parse makes of it.
    if (!/^[A-Za-z]{3}, /.test(v)) return null;
    const at = Date.parse(v);
    if (Number.isNaN(at) || at <= now) return null;
    ms = at - now;
  }
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
};

/** One run's writes: its budget, the account it began for, and its clock. */
export interface Writes {
  /** Wait, if need be, until one more write fits in the window, and count it. */
  take(): Promise<void>;
  readonly account: string | null;
  readonly clock: Clock;
}

/** A fresh budget for one run, for the account signed in now. */
export function writesForRun(clock: Clock = realClock, limit = WRITES_PER_WINDOW, windowMs = WINDOW_MS): Writes {
  const sent: number[] = [];
  return {
    account: getTabAccount(),
    clock,
    async take() {
      for (;;) {
        const now = clock.now();
        while (sent.length > 0 && sent[0] <= now - windowMs) sent.shift();
        if (sent.length < limit) {
          sent.push(now);
          return;
        }
        await clock.sleep(sent[0] + windowMs - now);
      }
    },
  };
}

/** What accountFetch answers a request that is, or would be, another
 *  account's (apiClient: `isAccountStop`): the run's writes end there. */
function accountStop<T>(): ApiResponse<T> {
  return { success: false, error: new AccountMismatchError().message, error_code: ACCOUNT_MISMATCH };
}

/**
 * Send one write under `writes`' budget; if the limit answers, send the same
 * request again, at most BACKOFF_MS.length times. Every other answer, and a
 * throw, is returned (or thrown) as it was: those are the server's real answer
 * for this write, or not a write the server ever saw.
 *
 * Nothing is sent once another account is the tab's, the first send included:
 * the budget can hold a write for up to a minute, and a write sent then would
 * go out on the other account's session. The answer is then the account stop.
 */
export async function sendWrite<T>(writes: Writes, send: () => Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  await writes.take();
  if (getTabAccount() !== writes.account) return accountStop();
  let answer = await send();
  let waited = 0;
  for (const backoff of BACKOFF_MS) {
    if (!isRateLimited(answer)) return answer;
    const named = answer.success ? null : retryAfterMs(answer.retryAfter, writes.clock.now());
    const wait = named ?? backoff;
    if (waited + wait > MAX_TOTAL_WAIT_MS) return answer;
    waited += wait;
    await writes.clock.sleep(wait);
    // Another account signed in meanwhile: this run's write is not theirs to send.
    if (getTabAccount() !== writes.account) return accountStop();
    await writes.take();
    answer = await send();
  }
  return answer;
}
