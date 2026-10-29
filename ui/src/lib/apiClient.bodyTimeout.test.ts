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
 * A request's time limit covers its BODY, and it is a limit on SILENCE, not
 * on size.
 *
 * A limit that ended when the answer's headers arrived would leave a body
 * that stalls half-way waited for with no limit: the request would never
 * end, and neither would the sync that made it, nor anything waiting for
 * that sync (an import, the page's first load).
 *
 * One limit over headers and body together would fail a large answer on a
 * slow link at every try, however steadily it arrived: a pull page of a
 * hundred notes would never get through, and "Shared with me" would empty at
 * every sync. So the limit is on hearing NOTHING, and each piece of the body
 * that arrives moves it on; a second, generous limit ends an answer that
 * trickles for ever.
 *
 * HOW the pieces are heard of: the answer is read the ordinary way, with
 * `json()`, and a COPY of it is read piece by piece. Read through a reader
 * itself, the browser reports the request as cancelled although the page had
 * every byte. The answers below are real `Response`s, so that a copy is what
 * a browser's is: made before the answer is read or not at all, and fed the
 * same pieces at the same time.
 */
const accountFetch = vi.fn();
vi.mock('./account', () => ({
  accountFetch: (...a: unknown[]) => accountFetch(...a),
  AccountMismatchError: class AccountMismatchError extends Error {},
  ACCOUNT_MISMATCH: 'account_mismatch',
}));

let apiRequest: typeof import('./apiClient').apiRequest;
beforeEach(async () => {
  accountFetch.mockReset();
  vi.resetModules();
  ({ apiRequest } = await import('./apiClient'));
});

/** An answer whose headers are here and whose body never comes, unless the request is aborted. */
function stalledBody(seen: { signal?: AbortSignal }) {
  return (_url: string, init: RequestInit) => {
    seen.signal = init.signal as AbortSignal;
    return Promise.resolve({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: () => new Promise((_resolve, reject) => {
        seen.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
    });
  };
}

describe("a request's time limit", () => {
  it('ends a request whose BODY stalls after its headers arrived, and reports it as timed out', async () => {
    const seen: { signal?: AbortSignal } = {};
    accountFetch.mockImplementation(stalledBody(seen));
    const started = Date.now();
    const result = await apiRequest('/api/v1/sync/pull', { timeout: 40 });
    expect(result).toEqual({ success: false, error: 'Request timed out' });
    expect(seen.signal!.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a body that arrives in time is the answer, and nothing is aborted afterwards', async () => {
    let signal: AbortSignal | undefined;
    accountFetch.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return Promise.resolve({
        status: 200, ok: true, headers: { get: () => null },
        json: () => new Promise((resolve) => setTimeout(() => resolve({ success: true, data: { n: 1 } }), 10)),
      });
    });
    const result = await apiRequest<{ n: number }>('/api/v1/quota', { timeout: 60 });
    expect(result).toEqual({ success: true, data: { n: 1 } });
    // Well past the limit: the timer was cleared when the body had been read.
    await new Promise((r) => setTimeout(r, 120));
    expect(signal!.aborted).toBe(false);
  });

  it('an answer with no body at all (204) clears its timer too', async () => {
    let signal: AbortSignal | undefined;
    accountFetch.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return Promise.resolve({ status: 204, ok: true, headers: { get: () => null }, json: () => Promise.reject(new Error('no body')) });
    });
    expect(await apiRequest('/api/v1/quota', { timeout: 40 })).toEqual({ success: true, data: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(signal!.aborted).toBe(false);
  });

  /**
   * There are TWO limits, and the tests above only outwait the one on
   * silence: the limit on the whole answer is ten minutes unless a caller
   * says otherwise, so a request that left it running would go unnoticed
   * there. Here it is short, and every way a request ends is waited out
   * past it.
   */
  it('the limit on the whole answer is taken down too, however the request ended', async () => {
    const endings: [string, () => Promise<unknown>][] = [
      ['an answer', () => Promise.resolve({ status: 200, ok: true, headers: { get: () => null }, json: () => Promise.resolve({ success: true, data: { n: 1 } }) })],
      ['no body (204)', () => Promise.resolve({ status: 204, ok: true, headers: { get: () => null }, json: () => Promise.reject(new Error('no body')) })],
      ['a refusal', () => Promise.resolve({ status: 403, ok: false, headers: { get: () => null }, json: () => Promise.resolve({ success: false, error: 'no', error_code: 'forbidden' }) })],
      ['a body that is not JSON', () => Promise.resolve({ status: 502, ok: false, headers: { get: () => null }, json: () => Promise.reject(new SyntaxError('Unexpected token <')) })],
      ['no answer at all', () => Promise.reject(new TypeError('Failed to fetch'))],
    ];
    for (const [how, answer] of endings) {
      let signal: AbortSignal | undefined;
      accountFetch.mockImplementation((_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return answer();
      });
      await apiRequest('/api/v1/quota', { timeout: 30, answerLimit: 60 });
      // Past both limits.
      await new Promise((r) => setTimeout(r, 150));
      expect(signal!.aborted, how).toBe(false);
    }
  });

  it('a request that fails before any answer still clears its timer', async () => {
    let signal: AbortSignal | undefined;
    accountFetch.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    expect(await apiRequest('/api/v1/quota', { timeout: 40 })).toEqual({ success: false, error: 'Failed to fetch' });
    await new Promise((r) => setTimeout(r, 100));
    expect(signal!.aborted).toBe(false);
  });
});

/**
 * An answer whose body arrives in pieces, as a browser gives it. `pieces` is
 * what arrives and how long after the piece before it (ms); `then` is what
 * follows the last one: the end of the body, or nothing more (until aborted).
 */
function streamed(
  pieces: [number, Uint8Array][],
  then: 'ends' | 'stops',
  seen: { signal?: AbortSignal } = {},
  status = 200,
) {
  return (_url: string, init: RequestInit) => {
    seen.signal = init.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let at = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // As a browser does it: aborting the request fails the body, for whoever reads it.
        const aborted = () => {
          clearTimeout(timer);
          try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch { /* ended already */ }
        };
        if (seen.signal!.aborted) { aborted(); return; }
        seen.signal!.addEventListener('abort', aborted);
        const next = () => {
          if (at < pieces.length) {
            const [after, value] = pieces[at++];
            timer = setTimeout(() => { controller.enqueue(value); next(); }, after);
          } else if (then === 'ends') {
            controller.close();
          }
        };
        next();
      },
    });
    return Promise.resolve(new Response(body, { status }));
  };
}
const bytes = (text: string) => new TextEncoder().encode(text);
/** `text` cut into `n` pieces of bytes, each arriving `every` ms after the one before. */
function inPieces(text: string, n: number, every: number): [number, Uint8Array][] {
  const all = bytes(text);
  const size = Math.ceil(all.length / n);
  const out: [number, Uint8Array][] = [];
  for (let i = 0; i < all.length; i += size) out.push([every, all.slice(i, i + size)]);
  return out;
}

describe('a large answer on a slow link', () => {
  const PAGE = JSON.stringify({ success: true, data: { items: Array.from({ length: 40 }, (_, i) => `note ${i}`), has_more: false } });

  it('is the answer, however long it takes, as long as it keeps arriving', async () => {
    const seen: { signal?: AbortSignal } = {};
    // Ten pieces, 25 ms apart: 250 ms in all, against a limit of 60.
    accountFetch.mockImplementation(streamed(inPieces(PAGE, 10, 25), 'ends', seen));
    const result = await apiRequest<{ items: string[] }>('/api/v1/sync/pull', { timeout: 60 });
    expect(result.success).toBe(true);
    expect(result.success && result.data.items).toHaveLength(40);
    expect(seen.signal!.aborted).toBe(false);
    // And nothing is aborted afterwards: both timers were cleared.
    await new Promise((r) => setTimeout(r, 150));
    expect(seen.signal!.aborted).toBe(false);
  });

  it('is given up on when its body STOPS arriving: the limit runs from the last piece', async () => {
    const seen: { signal?: AbortSignal } = {};
    accountFetch.mockImplementation(streamed(inPieces(PAGE, 10, 20).slice(0, 3), 'stops', seen));
    const started = Date.now();
    const result = await apiRequest('/api/v1/sync/pull', { timeout: 60 });
    expect(result).toEqual({ success: false, error: 'Request timed out' });
    expect(seen.signal!.aborted).toBe(true);
    // Three pieces (60 ms), then the limit (60 ms) of silence: not before, and not much after.
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('says so at its headers and at each piece, to whoever asked to hear of it', async () => {
    const heard = vi.fn();
    // Four pieces, and the end a moment after the last of them (a piece of no bytes is not heard of): the
    // copy has handed over every piece well before the answer is whole, so the count does not turn on
    // which of the two is done first.
    accountFetch.mockImplementation(streamed([...inPieces(PAGE, 4, 5), [25, new Uint8Array(0)]], 'ends'));
    const result = await apiRequest('/api/v1/sync/pull', { timeout: 60, onProgress: heard });
    expect(result.success).toBe(true);
    expect(heard).toHaveBeenCalledTimes(5);
  });

  it('a listener that throws does not fail the request', async () => {
    accountFetch.mockImplementation(streamed(inPieces(PAGE, 3, 5), 'ends'));
    const result = await apiRequest('/api/v1/sync/pull', { timeout: 60, onProgress: () => { throw new Error('bookkeeping'); } });
    expect(result.success).toBe(true);
  });

  /** A piece of no bytes is not a sign of life: an answer made of those would never end. */
  it('pieces with nothing in them do not move the limit on', async () => {
    const seen: { signal?: AbortSignal } = {};
    const heard = vi.fn();
    const empty: [number, Uint8Array][] = Array.from({ length: 40 }, () => [10, new Uint8Array(0)] as [number, Uint8Array]);
    accountFetch.mockImplementation(streamed(empty, 'stops', seen));
    const started = Date.now();
    const result = await apiRequest('/api/v1/sync/pull', { timeout: 60, onProgress: heard });
    expect(result).toEqual({ success: false, error: 'Request timed out' });
    expect(Date.now() - started).toBeLessThan(300);
    expect(heard).toHaveBeenCalledTimes(1); // the headers
  });

  it('one that trickles for ever is ended by the limit on the whole answer', async () => {
    const seen: { signal?: AbortSignal } = {};
    const drip: [number, Uint8Array][] = Array.from({ length: 400 }, () => [10, bytes(' ')] as [number, Uint8Array]);
    accountFetch.mockImplementation(streamed(drip, 'stops', seen));
    const started = Date.now();
    const result = await apiRequest('/api/v1/sync/pull', { timeout: 60, answerLimit: 150 });
    expect(result).toEqual({ success: false, error: 'Request timed out' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('the limit on the whole answer is never shorter than the limit on silence', async () => {
    const seen: { signal?: AbortSignal } = {};
    accountFetch.mockImplementation(streamed([[40, bytes(PAGE)]], 'ends', seen));
    const result = await apiRequest('/api/v1/sync/pull', { timeout: 120, answerLimit: 5 });
    expect(result.success).toBe(true);
  });

  it('by default the whole answer has ten minutes, and the silence thirty seconds', async () => {
    const { ANSWER_LIMIT_MS } = await import('./apiClient');
    expect(ANSWER_LIMIT_MS).toBe(600_000);
    vi.useFakeTimers();
    try {
      const seen: { signal?: AbortSignal } = {};
      accountFetch.mockImplementation(streamed([], 'stops', seen));
      const asking = apiRequest('/api/v1/sync/pull');
      await vi.advanceTimersByTimeAsync(29_000);
      expect(seen.signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(seen.signal!.aborted).toBe(true);
      expect(await asking).toEqual({ success: false, error: 'Request timed out' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a character cut in two by the pieces is put together again', async () => {
    const text = JSON.stringify({ success: true, data: { title: 'Café à Zürich ✓' } });
    const all = bytes(text);
    // One byte at a time: every multi-byte character is split.
    const single: [number, Uint8Array][] = Array.from(all, (b) => [0, new Uint8Array([b])] as [number, Uint8Array]);
    accountFetch.mockImplementation(streamed(single, 'ends'));
    expect(await apiRequest('/api/v1/items/x', { timeout: 500 })).toEqual({ success: true, data: { title: 'Café à Zürich ✓' } });
  });

  it('a body that is not JSON is a failure with no status, as it was', async () => {
    accountFetch.mockImplementation(streamed([[0, bytes('<html>502 Bad Gateway</html>')]], 'ends'));
    const result = await apiRequest('/api/v1/quota', { timeout: 60 });
    expect(result.success).toBe(false);
    expect((result as { status?: number }).status).toBeUndefined();
  });

  it('a refusal is still read with its status and its code', async () => {
    accountFetch.mockImplementation(streamed(
      [[0, bytes(JSON.stringify({ success: false, error: 'Nope', error_code: 'item_already_exists' }))]], 'ends', {}, 409,
    ));
    expect(await apiRequest('/api/v1/items', { method: 'POST', body: {}, timeout: 60 })).toMatchObject({
      success: false, status: 409, error_code: 'item_already_exists', error: 'Nope',
    });
  });
});

/**
 * Reading the answer's own body through a stream reader, to hear of each
 * piece, makes Chromium report nearly every request of the page as
 * cancelled (net::ERR_ABORTED), with nothing in the page aborting anything
 * and every byte delivered. The page works; whatever WATCHES its requests
 * is told they failed, and cannot read what the page was served. Measured
 * in the page, the same GET six times each: `json()` finished 6 of 6; a
 * reader on the body 0 or 1; `tee`, `pipeThrough`, `pipeTo` and
 * `for await` 0 to 2; `json()` with a `clone()` read by a reader, 6 of 6.
 */
describe('how an answer is read', () => {
  type Used = { cloned: number; copyReaders: number; ownReaders: number; json: number; order: string[] };
  /** A stand-in answer that says which of its parts were used. Its copy hands over `pieces`. */
  function watched(used: Used, pieces: number, answer: unknown = { success: true, data: { n: 7 } }) {
    return {
      status: 200, ok: true, headers: { get: () => null },
      body: { getReader: () => { used.ownReaders++; throw new Error("the answer's own body is not read through a reader"); } },
      clone: () => {
        used.cloned++;
        used.order.push('copy');
        return {
          body: {
            getReader: () => {
              used.copyReaders++;
              let given = 0;
              return { read: async () => (given++ < pieces ? { done: false, value: new Uint8Array([1, 2, 3]) } : { done: true }) };
            },
          },
        };
      },
      json: async () => { used.json++; used.order.push('json'); return answer; },
    };
  }
  const fresh = (): Used => ({ cloned: 0, copyReaders: 0, ownReaders: 0, json: 0, order: [] });

  it('the answer itself is read with json(): what is read piece by piece is a copy of it', async () => {
    const used = fresh();
    accountFetch.mockResolvedValue(watched(used, 3));
    expect(await apiRequest('/api/v1/quota', { timeout: 500 })).toEqual({ success: true, data: { n: 7 } });
    expect(used.ownReaders).toBe(0);
    expect(used.json).toBe(1);
    expect(used.cloned).toBe(1);
    expect(used.copyReaders).toBe(1);
  });

  /** A body that is being read cannot be copied: a real answer throws, and no piece would be heard of. */
  it('the copy is made before the answer is read', async () => {
    const used = fresh();
    accountFetch.mockResolvedValue(watched(used, 1));
    await apiRequest('/api/v1/quota', { timeout: 500 });
    expect(used.order).toEqual(['copy', 'json']);
  });

  it('a refusal is read the same way', async () => {
    const used = fresh();
    accountFetch.mockResolvedValue({ ...watched(used, 2, { success: false, error: 'Nope', error_code: 'quota_exceeded' }), status: 402, ok: false });
    expect(await apiRequest('/api/v1/items', { method: 'POST', body: {}, timeout: 500 })).toMatchObject({ success: false, status: 402, error_code: 'quota_exceeded' });
    expect(used.ownReaders).toBe(0);
    expect(used.json).toBe(1);
  });

  /**
   * The copy may still be handing over its last pieces when the answer is
   * whole. They are not progress on anything: the caller is not told, and
   * the limit on silence is not started again on a request that is over.
   */
  it('pieces of the copy that come after the answer is whole are not heard of, and start no limit', async () => {
    let signal: AbortSignal | undefined;
    let handedOver = 0;
    accountFetch.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return Promise.resolve({
        status: 200, ok: true, headers: { get: () => null },
        json: async () => ({ success: true, data: 1 }),
        clone: () => ({
          body: {
            getReader: () => ({
              // Six pieces, each 15 ms after the one before: all of them after the answer.
              read: () => new Promise((resolve) => setTimeout(() => {
                handedOver++;
                resolve(handedOver <= 6 ? { done: false, value: new Uint8Array([1]) } : { done: true });
              }, 15)),
            }),
          },
        }),
      });
    });
    const heard = vi.fn();
    expect(await apiRequest('/api/v1/quota', { timeout: 40, onProgress: heard })).toEqual({ success: true, data: 1 });
    expect(heard).toHaveBeenCalledTimes(1); // the headers
    await new Promise((r) => setTimeout(r, 200));
    expect(handedOver).toBeGreaterThanOrEqual(6); // the copy did go on
    expect(heard).toHaveBeenCalledTimes(1);
    expect(signal!.aborted).toBe(false); // and well past the limit, nothing was aborted
  });

  it('an answer that cannot be copied is read all the same', async () => {
    const answer = { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ success: true, data: { n: 2 } }) };
    const standIns: Record<string, unknown> = {
      'no clone at all': answer,
      'a clone that throws': { ...answer, clone: () => { throw new TypeError('Body has already been consumed.'); } },
      'a copy with no body': { ...answer, clone: () => ({ body: null }) },
      'a copy whose body has no reader': { ...answer, clone: () => ({ body: {} }) },
      'a copy whose reader cannot be had': { ...answer, clone: () => ({ body: { getReader: () => { throw new TypeError('locked'); } } }) },
    };
    for (const [name, standIn] of Object.entries(standIns)) {
      accountFetch.mockResolvedValue(standIn);
      const heard = vi.fn();
      expect(await apiRequest('/api/v1/quota', { timeout: 500, onProgress: heard }), name).toEqual({ success: true, data: { n: 2 } });
      expect(heard, name).toHaveBeenCalledTimes(1); // the headers
    }
  });

  it('a copy whose reading fails does not fail the answer, and leaves no rejection behind', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      accountFetch.mockResolvedValue({
        status: 200, ok: true, headers: { get: () => null },
        json: () => new Promise((resolve) => setTimeout(() => resolve({ success: true, data: { n: 3 } }), 20)),
        clone: () => ({ body: { getReader: () => ({ read: () => Promise.reject(new TypeError('network error')) }) } }),
      });
      expect(await apiRequest('/api/v1/quota', { timeout: 500 })).toEqual({ success: true, data: { n: 3 } });
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
