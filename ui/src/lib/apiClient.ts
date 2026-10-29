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
 * API client.
 */

import { accountFetch, AccountMismatchError, ACCOUNT_MISMATCH } from './account';

export interface ApiResult<T = unknown> {
  success: true;
  data: T;
}

/** Structured quota/entitlement detail carried on a `402` denial. Present
 *  only when the server attaches it — clients should also fall back to the
 *  `status`/`error_code` for gates that do not emit the object. */
export interface QuotaError {
  resource: string;
  is_count_limit: boolean;
  current: number;
  limit: number;
  tier: string;
}

export interface ApiError {
  success: false;
  error: string;
  status?: number;
  /** Machine-readable error code, e.g. `quota_notes_exceeded`. */
  error_code?: string;
  /** Structured quota detail on a `402` limit/entitlement denial. */
  quota?: QuotaError;
  /** The answer's Retry-After header as sent, on a non-OK status; absent
   *  otherwise. The note server may send none (lib/importers/rateLimit). */
  retryAfter?: string | null;
}

export type ApiResponse<T = unknown> = ApiResult<T> | ApiError;

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** How long the answer may be SILENT: before its headers, and between two pieces of its body. */
  timeout?: number;
  /** How long the whole answer may take, however steadily it arrives (default `ANSWER_LIMIT_MS`). */
  answerLimit?: number;
  /**
   * Called each time more of the answer has arrived: its headers, then each
   * piece of its body. For a caller that gives up on work that has gone quiet
   * (lib/oneAtATime): a large answer on a slow link is slow, not quiet.
   */
  onProgress?: () => void;
}

/**
 * The longest any one answer may take, however steadily it arrives. Generous
 * on purpose: it is there for an answer that trickles for ever, not for a
 * large one on a slow link (ten megabytes at 20 kB/s is under nine minutes).
 */
export const ANSWER_LIMIT_MS = 10 * 60_000;

/**
 * The answer's body as JSON; `heard` is told of each piece of it that arrives,
 * so that the caller can tell a body that is still ARRIVING from one that has
 * stopped (see `apiRequest`).
 *
 * The answer ITSELF is read the ordinary way, with `response.json()`. What is
 * read piece by piece is a COPY of it (`clone()`), and only to count: its
 * bytes are thrown away.
 *
 * Not the answer's own body through a reader: Chromium then reports the
 * request as CANCELLED (net::ERR_ABORTED) although the page is given every
 * byte — for nearly every request, with nothing in the page aborting
 * anything. The page works, and everything that watches its requests is told
 * they failed: the browser's own network panel, and every check that reads an
 * answer the page was served. The same holds for every other way of draining
 * the body in the page (`tee`, `pipeThrough`, `pipeTo`, `for await`); read by
 * `json()` with a copy watched, the request is reported finished.
 *
 * Where no copy can be made or read in pieces (an old browser, a test's
 * stand-in answer), the answer is read all the same and only its headers are
 * heard of.
 */
async function readJson(response: Response, heard: () => void): Promise<unknown> {
  watchCopy(response, heard);
  return response.json();
}

/** Tell `heard` of each piece of a copy of `response`'s body. Never throws, and never fails the answer. */
function watchCopy(response: Response, heard: () => void): void {
  let stream: ReadableStream<Uint8Array> | null | undefined;
  try {
    // Before the answer's own body is read: a body that is being read cannot be copied.
    stream = typeof response.clone === 'function' ? response.clone().body : null;
  } catch {
    return;
  }
  if (!stream || typeof stream.getReader !== 'function') return;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return;
  }
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      // A piece of no bytes is not a sign of life.
      if (value && value.byteLength > 0) heard();
    }
  })().catch(() => { /* an answer that fails says so itself, where it is read */ });
}

/**
 * Tell the Android shell the server just changed. In the shell (and only
 * there — the listener object is injected per-origin by the Android app's
 * WebAppActivity) the page is the app's ONLY editing surface, while
 * widgets, the reminder reconciler and the pinned-note notification read
 * the NATIVE Room mirror — without this they lag every in-app edit by up
 * to the 15-min periodic sync. One message per successful non-GET; the
 * shell folds bursts into a single unique+KEEP sync and rate-limits on its
 * side.
 */
function nudgeShellSync() {
  try {
    (window as { pingolinNudge?: { postMessage(m: string): void } })
      .pingolinNudge?.postMessage('sync');
  } catch {
    // Never let telemetry-grade signalling break a real request path.
  }
}

export async function apiRequest<T = unknown>(
  url: string,
  options: ApiOptions = {}
): Promise<ApiResponse<T>> {
  const { method = 'GET', body, headers = {}, timeout = 30000, answerLimit = ANSWER_LIMIT_MS, onProgress } = options;

  // TWO limits, and the first is on SILENCE, not on how long the answer takes:
  //
  // - `timeout` without hearing anything: before the headers, and between
  //   two pieces of the body. Each piece moves it on.
  // - `answerLimit` for the whole answer, for one that trickles for ever.
  //
  // One limit that ended when the headers arrived would wait for a stalled
  // body without end; one limit over headers AND body would fail every large
  // answer on a slow link, at every try: a pull page of a hundred notes would
  // never get through, and "Shared with me" would empty at every sync. Slow
  // is not stuck.
  const controller = new AbortController();
  let silence = setTimeout(() => controller.abort(), timeout);
  const whole = setTimeout(() => controller.abort(), Math.max(timeout, answerLimit));
  // Once the answer is whole (or has failed) nothing more is heard of it. The
  // copy that is watched for progress may still be handing over its last
  // pieces then: they must not start the limit again on a request that is
  // over, nor tell the caller of progress on it.
  let over = false;
  const heard = () => {
    if (over) return;
    clearTimeout(silence);
    silence = setTimeout(() => controller.abort(), timeout);
    try { onProgress?.(); } catch { /* the caller's bookkeeping never fails a request */ }
  };
  const done = () => {
    over = true;
    clearTimeout(silence);
    clearTimeout(whole);
  };

  try {
    const fetchOptions: RequestInit = {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      signal: controller.signal,
    };

    if (body !== undefined && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await accountFetch(url, fetchOptions);
    heard();

    if (response.status === 204) {
      done();
      if (method !== 'GET') nudgeShellSync();
      return { success: true, data: null as unknown as T };
    }

    // Aborting the signal fails the read below, which is reported like any
    // request that timed out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await readJson(response, heard) as any;
    done();

    if (!response.ok) {
      return {
        success: false,
        error: json.error || `Request failed: ${response.status}`,
        status: response.status,
        error_code: json.error_code,
        quota: json.quota,
        retryAfter: response.headers?.get?.('Retry-After') ?? null,
      };
    }

    if (json.success === false) {
      return {
        success: false,
        error: json.error || 'Unknown error',
        status: response.status,
        error_code: json.error_code,
        quota: json.quota,
      };
    }

    if (method !== 'GET') nudgeShellSync();
    return { success: true, data: json.data ?? json };
  } catch (err: unknown) {
    done();
    // Another account's session answered, or this tab has already stopped for
    // that reason: a hard stop, never a retry. The tab is wiping and reloading;
    // queued work stays queued for its own account (isAccountStop). No status:
    // callers read a 409 as a version conflict or "already exists" and would
    // fork or merge on it, and nothing may be written for this tab now.
    if (err instanceof AccountMismatchError) {
      return { success: false, error: err.message, error_code: ACCOUNT_MISMATCH };
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: 'Request timed out' };
    }
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

