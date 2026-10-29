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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Every sync waits for the load of the account's earlier identities before it
 * asks for a single note, and the load is made once and kept. Without a
 * limit, one request that never came back would stop every sync of the
 * session.
 */

const accountFetch = vi.fn();
vi.mock('./account', () => ({ accountFetch: (...a: unknown[]) => accountFetch(...a) }));
const bridge = vi.fn(async (): Promise<Uint8Array[] | null | 'no-answer'> => null);
vi.mock('./keyOps', () => ({ bridgePreviousVaultKeys: () => bridge() }));
vi.mock('./keyBridge', () => ({ inBridgeMode: () => false }));
const held = { priv: [] as Uint8Array[], vault: [] as Uint8Array[] };
vi.mock('./crypto', () => ({
  PREVIOUS_IDENTITY_LABEL: 'pingolin.previous-identity',
  getSharingPrivateKey: () => CURRENT,
  deriveAppKey: () => new Uint8Array(32),
  // Each row "opens" to a 32-byte key.
  decryptWithKey: () => new Uint8Array(32).fill(7),
  setPreviousIdentityKeys: (keys: Uint8Array[]) => { held.priv = keys; },
  setPreviousVaultKeys: (keys: Uint8Array[]) => { held.vault = keys; },
  addPreviousIdentityKeys: (keys: Uint8Array[]) => { held.priv = [...held.priv, ...keys]; return keys.length; },
  addPreviousVaultKeys: (keys: Uint8Array[]) => { held.vault = [...held.vault, ...keys]; return keys.length; },
  getPreviousVaultKeys: () => held.vault,
}));
const CURRENT = new Uint8Array(32).fill(1);

let lib: typeof import('./previousIdentities');

/** An answer with this many recovered identities. */
const answer = (rows: number) => ({
  ok: true,
  json: async () => ({ data: { identities: Array.from({ length: rows }, (_, i) => ({ key_version: i + 1, app_sealed_private_key: { nonce: 'n', ciphertext: 'c' } })) } }),
});
/** A request that never comes back, until it is aborted. */
const never = (init?: { signal?: AbortSignal }) => new Promise((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
  vi.resetModules();
  accountFetch.mockReset();
  bridge.mockReset();
  bridge.mockImplementation(async () => null);
  held.priv = []; held.vault = [];
  lib = await import('./previousIdentities');
});
afterEach(() => { vi.useRealTimers(); });

describe('the load of the account\'s earlier identities, which every sync waits for', () => {
  it('a request that never comes back is given up on, and the caller goes on with none', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    accountFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => { signals.push(init?.signal); return never(init); });
    let settled: number | 'waiting' = 'waiting';
    void lib.ensurePreviousIdentities('/api/v1').then((n) => { settled = n; });
    await vi.advanceTimersByTimeAsync(lib.LOAD_LIMIT_MS - 1);
    expect(settled).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(0);
    // The request is dropped, not left out on the connection.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('an answer whose body never ends is no answer either', async () => {
    accountFetch.mockImplementation(async (_url: string, init?: { signal?: AbortSignal }) => ({ ok: true, json: () => never(init) }));
    let settled: number | 'waiting' = 'waiting';
    void lib.ensurePreviousIdentities('/api/v1').then((n) => { settled = n; });
    await vi.advanceTimersByTimeAsync(lib.LOAD_LIMIT_MS);
    expect(settled).toBe(0);
  });

  it('a shell that does not answer is given up on too', async () => {
    bridge.mockImplementation(() => new Promise(() => {}));
    let settled: number | 'waiting' = 'waiting';
    void lib.ensurePreviousIdentities('/api/v1').then((n) => { settled = n; });
    await vi.advanceTimersByTimeAsync(lib.LOAD_LIMIT_MS);
    expect(settled).toBe(0);
    expect(accountFetch).not.toHaveBeenCalled();
  });

  it('a load with no answer is not kept: it is asked again, and then holds what the server says', async () => {
    accountFetch.mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => never(init));
    const first = lib.ensurePreviousIdentities('/api/v1');
    await vi.advanceTimersByTimeAsync(lib.LOAD_LIMIT_MS);
    expect(await first).toBe(0);

    accountFetch.mockImplementation(async () => answer(2));
    // Not at once: a server that keeps failing is not asked at every sync.
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    expect(accountFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(lib.RETRY_AFTER_MS - 1);
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    expect(accountFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(2);
    expect(accountFetch).toHaveBeenCalledTimes(2);
    expect(held.priv).toHaveLength(2);
  });

  it('a refusal or a failed request is no answer: not kept either', async () => {
    accountFetch.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    accountFetch.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); });
    await vi.advanceTimersByTimeAsync(lib.RETRY_AFTER_MS);
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    accountFetch.mockImplementation(async () => answer(1));
    await vi.advanceTimersByTimeAsync(lib.RETRY_AFTER_MS);
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(1);
    expect(accountFetch).toHaveBeenCalledTimes(3);
  });

  it('an answer IS kept, "nothing was recovered" included: one request for the session', async () => {
    accountFetch.mockImplementation(async () => answer(0));
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * lib.RETRY_AFTER_MS);
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    expect(accountFetch).toHaveBeenCalledTimes(1);
  });

  it('several syncs asking at once share the one load, and its limit', async () => {
    accountFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => never(init));
    const all = Promise.all([lib.ensurePreviousIdentities('/api/v1'), lib.ensurePreviousIdentities('/api/v1'), lib.ensurePreviousIdentities('/api/v1')]);
    await vi.advanceTimersByTimeAsync(lib.LOAD_LIMIT_MS);
    expect(await all).toEqual([0, 0, 0]);
    expect(accountFetch).toHaveBeenCalledTimes(1);
  });

  it('a sign-out starts again: the next account is asked at once, whatever the last one was told', async () => {
    accountFetch.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    lib.resetPreviousIdentities();
    accountFetch.mockImplementation(async () => answer(1));
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(1);
  });

  it('a load that answers after a sign-out does not count for the next account', async () => {
    let finish: (v: unknown) => void = () => {};
    accountFetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = lib.ensurePreviousIdentities('/api/v1');
    lib.resetPreviousIdentities();
    accountFetch.mockImplementation(async () => answer(0));
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    finish(answer(3));
    expect(await first).toBe(0);
    expect(held.priv).toEqual([]);
    // The next account's own answer is kept; the earlier load did not reopen the question.
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    expect(accountFetch).toHaveBeenCalledTimes(2);
  });

  it('nor does one that FAILS after a sign-out undo what the next account was told, or make it wait', async () => {
    let fail: (e: unknown) => void = () => {};
    accountFetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = lib.ensurePreviousIdentities('/api/v1');
    lib.resetPreviousIdentities();
    accountFetch.mockImplementation(async () => answer(2));
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(2);
    // The last account's request ends now, with no answer.
    fail(new TypeError('Failed to fetch'));
    expect(await first).toBe(0);
    // The next account still holds its answer, and is not asked again or told 0 while "waiting".
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(2);
    expect(accountFetch).toHaveBeenCalledTimes(2);
    expect(held.priv).toHaveLength(2);
  });

  it('a re-check that never comes back ends too, and adds nothing', async () => {
    accountFetch.mockImplementationOnce(async () => answer(0));
    expect(await lib.ensurePreviousIdentities('/api/v1')).toBe(0);
    accountFetch.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => never(init));
    let settled: number | 'waiting' = 'waiting';
    void lib.recheckPreviousIdentities('/api/v1').then((n) => { settled = n; });
    await vi.advanceTimersByTimeAsync(lib.LOAD_LIMIT_MS);
    expect(settled).toBe(0);
  });
});

/**
 * A notebook record nothing here opens is rebuilt only once it is KNOWN that
 * no key recovered from before a reset opens it (lib/notebookRepair).
 * "Answered" is that: a load or a re-check that got an answer, of any size,
 * this session.
 */
describe('whether this session has had an answer about earlier identities', () => {
  it('not before a load, and not after one that got no answer', async () => {
    expect(lib.previousIdentitiesAnswered()).toBe(false);
    accountFetch.mockResolvedValue({ ok: false, status: 503 });
    await lib.ensurePreviousIdentities('/api/v1');
    expect(lib.previousIdentitiesAnswered()).toBe(false);
  });

  it('after an answer, even one that recovered nothing', async () => {
    accountFetch.mockResolvedValue(answer(0));
    await lib.ensurePreviousIdentities('/api/v1');
    expect(lib.previousIdentitiesAnswered()).toBe(true);
  });

  it('after the shell\'s answer, in the key-bridge shell', async () => {
    bridge.mockImplementation(async () => []);
    await lib.ensurePreviousIdentities('/api/v1');
    expect(lib.previousIdentitiesAnswered()).toBe(true);
    expect(accountFetch).not.toHaveBeenCalled();
  });

  it('not after a failed call to the shell: that is no answer, and nothing is held', async () => {
    bridge.mockImplementation(async () => 'no-answer');
    await lib.ensurePreviousIdentities('/api/v1');
    expect(lib.previousIdentitiesAnswered()).toBe(false);
    expect(held.vault).toEqual([]);
    // Nor through a re-check that fails the same way.
    await lib.recheckPreviousIdentities('/api/v1');
    expect(lib.previousIdentitiesAnswered()).toBe(false);
  });

  it('after a re-check that got one, when the load had not', async () => {
    accountFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    await lib.ensurePreviousIdentities('/api/v1');
    expect(lib.previousIdentitiesAnswered()).toBe(false);
    // Within the wait after a failed load the load is not tried again: the
    // answer below is the re-check's own.
    accountFetch.mockResolvedValue(answer(1));
    await lib.recheckPreviousIdentities('/api/v1');
    expect(accountFetch).toHaveBeenCalledTimes(2);
    expect(lib.previousIdentitiesAnswered()).toBe(true);
  });

  it('forgotten at a sign-out or account switch', async () => {
    accountFetch.mockResolvedValue(answer(1));
    await lib.ensurePreviousIdentities('/api/v1');
    expect(lib.previousIdentitiesAnswered()).toBe(true);
    lib.resetPreviousIdentities();
    expect(lib.previousIdentitiesAnswered()).toBe(false);
  });

  it('a load overtaken by a sign-out marks nothing', async () => {
    let release: (v: unknown) => void = () => {};
    accountFetch.mockImplementation(() => new Promise((r) => { release = r; }));
    const loading = lib.ensurePreviousIdentities('/api/v1');
    // The request is out (after the shell is asked) before the sign-out comes.
    await vi.advanceTimersByTimeAsync(0);
    expect(accountFetch).toHaveBeenCalledTimes(1);
    lib.resetPreviousIdentities();
    release(answer(1));
    await loading;
    expect(lib.previousIdentitiesAnswered()).toBe(false);
  });
});
