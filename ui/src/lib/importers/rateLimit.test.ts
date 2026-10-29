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

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The write limit's answer, and only that answer, is sent again; one run's
 * writes stay under 200 per rolling 60 s.
 *
 * WHY THESE EXIST
 *   Taking the per-user write limit's 429 as the note's own answer would
 *   report notes that are present as "couldn't be restored".
 */

let tab: string | null = 'acct-a';
vi.mock('../account', () => ({
  getTabAccount: () => tab,
  ACCOUNT_MISMATCH: 'account_mismatch',
  AccountMismatchError: class extends Error { constructor() { super('This tab belongs to another account'); } },
}));

const { BACKOFF_MS, MAX_TOTAL_WAIT_MS, isRateLimited, retryAfterMs, sendWrite, writesForRun } = await import('./rateLimit');
type Answer = import('../apiClient').ApiResponse<unknown>;

/** A clock that only moves when slept on, recording every sleep. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, advance: (ms: number) => { t += ms; } };
}
const limited: Answer = { success: false, status: 429, error_code: 'rate_limit_exceeded', error: 'Rate limit exceeded. Please slow down.' };
const ok: Answer = { success: true, data: null };

beforeEach(() => { tab = 'acct-a'; });

describe('the write limit\'s answer', () => {
  it('is status 429 AND its own code, nothing less', () => {
    expect(isRateLimited(limited)).toBe(true);
    expect(isRateLimited({ ...limited, error_code: undefined })).toBe(false);
    expect(isRateLimited({ ...limited, status: 503 })).toBe(false);
    expect(isRateLimited({ ...limited, error_code: 'RATE_LIMIT_EXCEEDED' })).toBe(false);
    expect(isRateLimited(ok)).toBe(false);
  });

  it('reads Retry-After as seconds or a date, and nothing else', () => {
    expect(retryAfterMs('7', 0)).toBe(7000);
    expect(retryAfterMs(' 0 ', 0)).toBe(0);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs('soon', 0)).toBeNull();
  });

  it('never waits more than 60 s on one, and takes a negative, malformed or past one as none', () => {
    expect(retryAfterMs('600', 0)).toBe(60_000);
    expect(retryAfterMs(new Date(10_000_000).toUTCString(), 0)).toBe(60_000);
    expect(retryAfterMs('-5', 0)).toBeNull();
    expect(retryAfterMs('1.5', 0)).toBeNull();
    expect(retryAfterMs('2030', 0)).toBe(60_000); // seconds, capped
    expect(retryAfterMs(new Date(1_000).toUTCString(), 5_000)).toBeNull();
  });
});

describe('a write sent under the limit', () => {
  it('is sent again after the limit\'s answer, the same request, and then stands', async () => {
    const clock = fakeClock();
    const send = vi.fn<() => Promise<Answer>>().mockResolvedValueOnce(limited).mockResolvedValueOnce(ok);
    expect(await sendWrite(writesForRun(clock), send)).toBe(ok);
    expect(send).toHaveBeenCalledTimes(2);
    expect(clock.slept).toEqual([2000]);
  });

  it('gives up after five resends and 62 s, with the last answer', async () => {
    const clock = fakeClock();
    const send = vi.fn<() => Promise<Answer>>().mockResolvedValue(limited);
    expect(await sendWrite(writesForRun(clock), send)).toBe(limited);
    expect(send).toHaveBeenCalledTimes(1 + BACKOFF_MS.length);
    expect(clock.slept).toEqual([2000, 4000, 8000, 16000, 32000]);
  });

  it('stops waiting on Retry-After before 122 s in all, the schedule plus one capped wait', async () => {
    const clock = fakeClock();
    const send = vi.fn<() => Promise<Answer>>().mockResolvedValue({ ...limited, retryAfter: '60' });
    expect(await sendWrite(writesForRun(clock), send)).toMatchObject({ status: 429 });
    expect(clock.slept).toEqual([60_000, 60_000]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(clock.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_TOTAL_WAIT_MS);
  });

  it('falls back to the schedule when Retry-After is malformed', async () => {
    const clock = fakeClock();
    const send = vi.fn<() => Promise<Answer>>().mockResolvedValueOnce({ ...limited, retryAfter: 'later' }).mockResolvedValueOnce(ok);
    await sendWrite(writesForRun(clock), send);
    expect(clock.slept).toEqual([2000]);
  });

  it('waits what Retry-After says when the answer has one', async () => {
    const clock = fakeClock();
    const send = vi.fn<() => Promise<Answer>>().mockResolvedValueOnce({ ...limited, retryAfter: '7' }).mockResolvedValueOnce(ok);
    await sendWrite(writesForRun(clock), send);
    expect(clock.slept).toEqual([7000]);
  });

  it('is never sent again on any other answer', async () => {
    for (const other of [
      { success: false, status: 500, error: 'boom' },
      { success: false, status: 503, error: 'Rate limiting temporarily unavailable' },
      { success: false, status: 401, error: 'Unauthorized' },
      { success: false, status: 409, error: 'An item with this id already exists' },
      { success: false, status: 403, error_code: 'item_not_owned', error: 'no' },
      { success: false, error: 'Network error' },
      { success: false, error: 'This tab is signed in to another account', error_code: 'account_mismatch' },
    ] as Answer[]) {
      const clock = fakeClock();
      const send = vi.fn<() => Promise<Answer>>().mockResolvedValue(other);
      expect(await sendWrite(writesForRun(clock), send)).toBe(other);
      expect(send).toHaveBeenCalledTimes(1);
      expect(clock.slept).toEqual([]);
    }
  });

  it('lets a throw through as it was, sent once', async () => {
    const send = vi.fn<() => Promise<Answer>>().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(sendWrite(writesForRun(fakeClock()), send)).rejects.toThrow('Failed to fetch');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is not sent again once another account is the tab's, and answers with the account stop", async () => {
    const clock = fakeClock();
    const writes = writesForRun(clock);
    const send = vi.fn<() => Promise<Answer>>().mockImplementation(async () => { tab = 'acct-b'; return limited; });
    expect(await sendWrite(writes, send)).toMatchObject({ success: false, error_code: 'account_mismatch' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is never sent at all once another account is the tab's, the first send included", async () => {
    const writes = writesForRun(fakeClock());
    tab = 'acct-b';
    const send = vi.fn<() => Promise<Answer>>().mockResolvedValue(ok);
    expect(await sendWrite(writes, send)).toMatchObject({ success: false, error_code: 'account_mismatch' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("one run's budget", () => {
  it('never lets more than 200 writes into any rolling 60 s', async () => {
    const clock = fakeClock();
    const writes = writesForRun(clock);
    const at: number[] = [];
    for (let i = 0; i < 450; i++) {
      await writes.take();
      at.push(clock.now());
      clock.advance(10); // the write itself takes a little time
    }
    for (let i = 0; i < at.length; i++) {
      const inWindow = at.filter(t => t > at[i] - 60_000 && t <= at[i]).length;
      expect(inWindow).toBeLessThanOrEqual(200);
    }
    // and it waits no more than it has to: the 201st write goes as the 1st leaves the window
    expect(at[200] - at[0]).toBe(60_000);
  });

  it('is counted per run, for the account signed in when the run began', () => {
    expect(writesForRun(fakeClock()).account).toBe('acct-a');
    tab = 'acct-b';
    expect(writesForRun(fakeClock()).account).toBe('acct-b');
  });
});
