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
import { ASK_AGAIN_AFTER_MS } from '../lib/askTwice';

/**
 * Someone taken off a notebook's standing share list stays off it until the
 * server has the list without them.
 *
 * WHY THESE EXIST
 *   The list seals every NEW note in the notebook to its people. This client's
 *   list is REPLACED by the server's at a sync and MERGED with it on a
 *   conflicting write, and a merge with no base (the first write after a start)
 *   keeps every entry the server has. Without the hold, a removal whose write
 *   has not landed, or never will (the tab closed), is undone by the server's
 *   older list, and the next note goes to the person just removed.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

// Ciphertext IS the plaintext here, so a test can read what was written.
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(7),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
}));

type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];
let putOk = true;

let notebooksStore: typeof import('./notebooks').notebooksStore;

const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
const NB = '11111111-1111-4111-8111-111111111111';
const X = 'removed@example.test';
const Y = 'stays@example.test';
const entry = (email: string) => ({ email, permission: 'edit' as const, publicKey: null, userId: null, signingPublicKey: null });
/** The server's blob: it still lists X, as it does until the removal lands. */
const serverBlob = { notebooks: [{ id: NB, name: 'Family' }], labelColors: {}, notebookShares: { [NB]: [entry(X), entry(Y)] } };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  putOk = true;
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body as any };
    calls.push(c);
    if (c.method === 'PUT' && url === `/api/v1/items/${META}`) {
      return putOk ? { success: true, data: { version: 99 } } : { success: false, status: 503, error: 'unavailable' };
    }
    return { success: false, status: 404 };
  });
  ({ notebooksStore } = await import('./notebooks'));
});

function synced(version: number, meta: unknown) {
  notebooksStore.loadFromSyncedItems([{
    id: META, item_type: 10, version, deleted: false,
    encrypted_content: JSON.stringify(meta), content_nonce: 'n',
    updated_at: '2026-09-01T00:00:00Z',
  }]);
}

const emails = () => notebooksStore.getNotebookShares(NB).map(r => r.email);
const puts = () => calls.filter(c => c.method === 'PUT' && c.url === `/api/v1/items/${META}`);
const lastPutShares = () => JSON.parse(puts()[puts().length - 1].body.encrypted_content).notebookShares;

describe('a removal from the standing list', () => {
  it('survives a sync that brings the older list while its write has not landed', async () => {
    synced(1, serverBlob);
    putOk = false;

    expect(await notebooksStore.removeNotebookShare(NB, X)).toBe(false);
    expect(emails()).toEqual([Y]);

    synced(2, serverBlob);

    expect(emails()).toEqual([Y]);
    // And the removal is written again, without them.
    await vi.waitFor(() => expect(puts().length).toBe(2));
    expect(lastPutShares()).toEqual({ [NB]: [entry(Y)] });
  });

  it('survives the merge with no base, the first write after a start', async () => {
    // A start whose first pull didn't bring the metadata row: the client knows
    // no row and no base. Its create 409s, it adopts the server's row, and a
    // merge with no base keeps everything the server lists — X included.
    notebooksStore.markPulled();
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
      calls.push(c);
      if (c.method === 'POST' && url === '/api/v1/items') return { success: false, status: 409, error: 'exists' };
      if (url.startsWith('/api/v1/sync/pull')) {
        return { success: true, data: { items: [{ id: META, item_type: 10, deleted: false, version: 5,
          encrypted_content: JSON.stringify(serverBlob), content_nonce: 'n', updated_at: 't' }],
        cursor: null, cursor_id: null, has_more: false } };
      }
      if (c.method === 'PUT') return { success: true, data: { version: 6 } };
      return { success: false, status: 404 };
    });

    expect(await notebooksStore.holdRemovals(NB, [X])).toBe(true);

    expect(lastPutShares()).toEqual({ [NB]: [entry(Y)] });
    expect(emails()).toEqual([Y]);
  });

  it('ends when the first write creates the row', async () => {
    // A first pull that found no metadata row at all (a new account): the write is a create.
    notebooksStore.markPulled();
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      if (opts?.method === 'POST' && url === '/api/v1/items') return { success: true, data: { id: META, version: 1 } };
      return { success: false, status: 404 };
    });

    expect(await notebooksStore.holdRemovals(NB, [X])).toBe(true);
    synced(2, serverBlob);

    expect(emails()).toEqual([X, Y]);
  });

  it('ends once a write without them lands: a later re-add from another device stands', async () => {
    synced(1, serverBlob);

    expect(await notebooksStore.removeNotebookShare(NB, X)).toBe(true);
    // The notebook's owner shared with X again on another
    // device, after the removal.
    synced(3, serverBlob);

    expect(emails()).toEqual([X, Y]);
  });

  it('ends when the owner adds them back', async () => {
    synced(1, serverBlob);
    putOk = false;
    await notebooksStore.removeNotebookShare(NB, X);

    notebooksStore.addNotebookShare(NB, entry(X));
    synced(2, serverBlob);

    expect(emails()).toEqual([X, Y]);
  });

  /**
   * The page finishes an invitation by itself when its reader signs up. If it
   * wrote the result with `addNotebookShare` — the notebook owner's "add them
   * back" — a finish under way while the notebook owner removed that person
   * would lift the removal and put them back, keys and all.
   */
  it('is NOT ended by the page finishing their invitation: that write adds nobody', async () => {
    synced(1, serverBlob);
    putOk = false;
    await notebooksStore.removeNotebookShare(NB, X);
    const writes = puts().length;

    const withKeys = { ...entry(X), publicKey: 'cc'.repeat(32), userId: 'x-id', signingPublicKey: 'dd'.repeat(32) };
    expect(notebooksStore.finishNotebookShare(NB, withKeys)).toBe(false);
    expect(emails()).toEqual([Y]);
    expect(puts().length).toBe(writes);
    // Still held: the server's older list does not bring them back either.
    synced(2, serverBlob);
    expect(emails()).toEqual([Y]);
  });

  it('nor does it add someone who is simply not on the list', async () => {
    synced(1, { ...serverBlob, notebookShares: { [NB]: [entry(Y)] } });
    const withKeys = { ...entry(X), publicKey: 'cc'.repeat(32), userId: 'x-id', signingPublicKey: 'dd'.repeat(32) };
    expect(notebooksStore.finishNotebookShare(NB, withKeys)).toBe(false);
    expect(notebooksStore.finishNotebookShare('22222222-2222-4222-8222-222222222222', withKeys)).toBe(false);
    expect(emails()).toEqual([Y]);
    expect(puts()).toEqual([]);
  });

  it('it gives a waiting entry its keys, in place, and writes that', async () => {
    synced(1, serverBlob);
    const withKeys = { ...entry(X.toUpperCase()), publicKey: 'cc'.repeat(32), userId: 'x-id', signingPublicKey: 'dd'.repeat(32) };
    expect(notebooksStore.finishNotebookShare(NB, withKeys)).toBe(true);
    expect(notebooksStore.getNotebookShares(NB).map(r => [r.email, r.publicKey])).toEqual([[X.toUpperCase(), 'cc'.repeat(32)], [Y, null]]);
    await vi.waitFor(() => expect(puts().length).toBe(1));
    expect(lastPutShares()[NB].map((r: { publicKey: string | null }) => r.publicKey)).toEqual(['cc'.repeat(32), null]);
  });

  it('and leaves alone an entry that has its keys already: finished by hand, or changed since', async () => {
    const byHand = { ...entry(X), publicKey: 'ee'.repeat(32), userId: 'by-hand', signingPublicKey: 'ff'.repeat(32) };
    synced(1, { ...serverBlob, notebookShares: { [NB]: [byHand, entry(Y)] } });
    const withKeys = { ...entry(X), publicKey: 'cc'.repeat(32), userId: 'x-id', signingPublicKey: 'dd'.repeat(32) };
    expect(notebooksStore.finishNotebookShare(NB, withKeys)).toBe(false);
    expect(notebooksStore.getNotebookShares(NB)[0].userId).toBe('by-hand');
    expect(puts()).toEqual([]);
  });

  it('is not ended by a write that started before it', async () => {
    synced(1, serverBlob);
    // A write already on its way (a label colour), carrying the list with X.
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let first = true;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
      calls.push(c);
      if (c.method !== 'PUT') return { success: false, status: 404 };
      if (first) { first = false; await held; return { success: true, data: { version: 2 } }; }
      return { success: false, status: 503, error: 'unavailable' };
    });
    notebooksStore.setLabelColor('urgent', '#f00');
    await vi.waitFor(() => expect(puts().length).toBe(1));

    const removal = notebooksStore.removeNotebookShare(NB, X);
    release();

    // The first write landed WITH X; the removal's own write failed.
    expect(await removal).toBe(false);
    synced(3, serverBlob);
    expect(emails()).toEqual([Y]);
  });

  it('compares addresses without case', async () => {
    synced(1, { ...serverBlob, notebookShares: { [NB]: [entry('Removed@Example.TEST'), entry(Y)] } });
    putOk = false;

    await notebooksStore.removeNotebookShare(NB, X);
    synced(2, { ...serverBlob, notebookShares: { [NB]: [entry('REMOVED@example.test'), entry(Y)] } });

    expect(emails()).toEqual([Y]);
  });

  it('does not read as landed when a sign-out drops it while the write fails', async () => {
    synced(1, serverBlob);
    let fail!: () => void;
    const pending = new Promise<void>(r => { fail = r; });
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      if (opts?.method === 'PUT') { await pending; return { success: false, status: 503, error: 'unavailable' }; }
      return { success: false, status: 404 };
    });

    const removal = notebooksStore.holdRemovals(NB, [X]);
    await vi.waitFor(() => expect(puts().length).toBe(1));
    notebooksStore.reset();
    fail();

    expect(await removal).toBe(false);
  });

  it('ends at a sign-out', async () => {
    synced(1, serverBlob);
    putOk = false;
    await notebooksStore.removeNotebookShare(NB, X);

    notebooksStore.reset();
    synced(2, serverBlob);

    expect(emails()).toEqual([X, Y]);
  });

  it("ends with the account: another account's list is not filtered", async () => {
    synced(1, serverBlob);
    putOk = false;
    await notebooksStore.removeNotebookShare(NB, X);

    const { setTabAccount } = await import('../lib/account');
    setTabAccount('0e0e0e0e-0000-4000-8000-00000000000b');
    synced(2, serverBlob);

    expect(emails()).toEqual([X, Y]);
  });
});

describe("a notebook item read again for a removal's retry", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: NB, version: 7, deleted: false,
    // The crypto mock opens anything: the content IS the roster document.
    encrypted_content: JSON.stringify({ title: 'Family', members: [
      { userId: 'x-id', email: X, sharingPublicKey: 'aa', signingPublicKey: null, permission: 'edit' },
    ] }),
    content_nonce: 'n', wrapped_content_key: 'w', wrapped_content_key_nonce: 'wn', ...over,
  });
  const serve = (reply: unknown) => apiRequest.mockImplementation(async (url: string) =>
    (url === `/api/v1/items/${NB}` ? reply : { success: false, status: 404 }));

  it("reads the roster as the server holds it, over one this session doesn't know", async () => {
    serve({ success: true, data: item() });
    expect(notebooksStore.membersOf(NB)).toEqual([]);

    expect(await notebooksStore.refreshNotebookItem(NB)).toBe('live');

    expect(notebooksStore.membersOf(NB).map(m => m.email)).toEqual([X]);
    expect(notebooksStore.notebookVersion(NB)).toBe(7);
  });

  it("says 'deleted' for a tombstone, 'gone' for a 404, 'failed' for anything else", async () => {
    serve({ success: true, data: item() });
    expect(await notebooksStore.refreshNotebookItem(NB)).toBe('live');
    expect(notebooksStore.notebookVersion(NB)).toBe(7);

    serve({ success: true, data: item({ deleted: true }) });
    expect(await notebooksStore.refreshNotebookItem(NB)).toBe('deleted');
    // Marked taken-but-not-ours-to-write, as the sync marks a tombstone.
    expect(notebooksStore.notebookVersion(NB)).toBeNull();
    expect(notebooksStore.hasNotebookItem(NB)).toBe(false);

    serve({ success: false, status: 404 });
    expect(await notebooksStore.refreshNotebookItem(NB)).toBe('gone');

    serve({ success: false, status: 503 });
    expect(await notebooksStore.refreshNotebookItem(NB)).toBe('failed');

    // No wrap: nothing here can open it, so no roster is known.
    serve({ success: true, data: item({ wrapped_content_key: null }) });
    expect(await notebooksStore.refreshNotebookItem(NB)).toBe('failed');
  });
});

describe('a restore while a removal is held', () => {
  /** The removal's list write and its object revoke both failed, so the
   * object's rows still name X. A restore must not put X back. */
  it('leaves the held person off the list it builds from the rows', async () => {
    synced(1, { notebooks: [{ id: NB, name: 'Family' }], labelColors: {}, notebookShares: { [NB]: [entry(X)] } });
    putOk = false;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      if (opts?.method === 'PUT') return { success: false, status: 503, error: 'unavailable' };
      if (url === `/api/v1/items/${NB}/shares`) return { success: true, data: [{ id: 's1', recipient_email: X, permission: 'contribute' }] };
      return { success: false, status: 404 };
    });

    expect(await notebooksStore.removeNotebookShare(NB, X)).toBe(false);
    expect(await notebooksStore.restoreStandingShares([NB], () => [])).toBe(0);

    expect(emails()).toEqual([]);
    expect(NB in notebooksStore.notebookShares()).toBe(false);
  });

  it('still sets the others the rows name', async () => {
    synced(1, { notebooks: [{ id: NB, name: 'Family' }], labelColors: {}, notebookShares: { [NB]: [entry(X)] } });
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      if (opts?.method === 'PUT') return { success: false, status: 503, error: 'unavailable' };
      if (url === `/api/v1/items/${NB}/shares`) {
        return { success: true, data: [{ recipient_email: X, permission: 'contribute' }, { recipient_email: Y, permission: 'contribute' }] };
      }
      return { success: false, status: 404 };
    });
    await notebooksStore.removeNotebookShare(NB, X);

    expect(await notebooksStore.restoreStandingShares([NB], () => [])).toBe(1);

    expect(emails()).toEqual([Y]);
  });
});

/**
 * One note read that fails must not set every editor down as a reader for
 * good (an entry, once set, is never touched again). It is asked again; if
 * it still fails, no list is made, as for the notebook's own rows.
 */
describe('a restore that reads the notes\' rows', () => {
  const N1 = '33333333-3333-4333-8333-333333333333';
  function serveRows(noteFails: number) {
    let failures = noteFails;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      if (opts?.method === 'PUT') return { success: true, data: { id: 'meta', version: 2 } };
      if (url === `/api/v1/items/${NB}/shares`) return { success: true, data: [{ recipient_email: Y, permission: 'view' }] };
      if (url === `/api/v1/items/${N1}/shares`) {
        if (failures > 0) { failures--; return { success: false, status: 503 }; }
        return { success: true, data: [{ recipient_email: Y, permission: 'edit' }] };
      }
      return { success: false, status: 404 };
    });
  }
  afterEach(() => { vi.useRealTimers(); });

  it('asks a note\'s rows again, and sets down the right they then say', async () => {
    synced(1, { notebooks: [{ id: NB, name: 'Family' }], labelColors: {} });
    serveRows(1);
    vi.useFakeTimers();
    const p = notebooksStore.restoreStandingShares([NB], () => [N1]);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 2);
    expect(await p).toBe(1);
    expect(notebooksStore.notebookShares()[NB]).toEqual([expect.objectContaining({ email: Y, permission: 'edit' })]);
  });

  it('and makes no list when they cannot be read even asked again', async () => {
    synced(1, { notebooks: [{ id: NB, name: 'Family' }], labelColors: {} });
    serveRows(2);
    vi.useFakeTimers();
    const p = notebooksStore.restoreStandingShares([NB], () => [N1]);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 2);
    expect(await p).toBe(0);
    expect(NB in notebooksStore.notebookShares()).toBe(false);
  });
});

describe('a resume, with a removal whose person is still on the list', () => {
  async function resumeWith(noteIds: string[]) {
    const { resumeRekeyJobs } = await import('../lib/rekeyDrain');
    const { createJob } = await import('../lib/rekeyQueue');
    const jobs = new Map([[`rekey:${NB}`, createJob({ notebookId: NB, removedRecipient: X, noteIds, nowMs: 1 })]]);
    const rotated: string[] = [];
    await resumeRekeyJobs({
      listJobs: async () => [...jobs.values()],
      getJob: async notebookId => jobs.get(`rekey:${notebookId}`) ?? null,
      saveJob: async job => { jobs.set(job.id, job); },
      deleteJob: async id => { jobs.delete(id); },
      rotate: async id => { rotated.push(id); return true; },
      listNotebookNotes: async () => [],
      now: () => 2,
      dropFromStandingList: job => notebooksStore.holdRemovals(job.notebookId, job.removedRecipients),
      revokeObject: async () => true,
    });
    return { jobs, rotated };
  }

  it('takes them off it, writes that, and lets the job go', async () => {
    synced(1, serverBlob);

    const { jobs, rotated } = await resumeWith(['n1']);

    expect(emails()).toEqual([Y]);
    expect(lastPutShares()).toEqual({ [NB]: [entry(Y)] });
    expect(rotated).toEqual(['n1']);
    expect(jobs.size).toBe(0);
  });

  it('keeps the job while that write has not landed, and a sync with the old list does not bring them back', async () => {
    synced(1, serverBlob);
    putOk = false;

    const { jobs, rotated } = await resumeWith(['n1']);

    expect(emails()).toEqual([Y]);
    expect(rotated).toEqual(['n1']);
    expect(jobs.size).toBe(1);

    synced(2, serverBlob);
    expect(emails()).toEqual([Y]);
  });
});
