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
 * A change made while no base is known reaches the server, whatever the sync
 * does first — and never at the cost of anything else in the list.
 *
 * WHY THESE EXIST
 *   With no base, the write a change asks for waits for the session's first
 *   pull, and the row that pull brought REPLACED the signals: the change was
 *   lost, and the held write sent the server's own blob back. The first row
 *   adopted is now merged with the session's changes and written at once. These
 *   pin that, and what the merge must not do: delete fields other clients wrote,
 *   read what a locked list set aside as this page's own changes, or merge
 *   against a session start that a later row has made stale. (A reload before
 *   the first pull still loses the change: the session's start is not kept.)
 *
 * Unlike notebooks.mergeBase.test.ts, the stores here read as empty until the
 * tab's account is confirmed, as lib/account does: the module loads first.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(7),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  // A list from before a password reset: no key here opens it.
  decryptNote: (d: { ciphertext: string }) => {
    if (d.ciphertext.startsWith('LOCKED:')) throw new Error('no key opens it');
    return d.ciphertext;
  },
  decryptNoteWithRecoveredVault: () => null,
  vaultKeyThatOpens: () => null,
}));

const stored = new Map<string, string>();
vi.mock('../lib/account', async (orig) => {
  const real = await orig<typeof import('../lib/account')>();
  return {
    ...real,
    scopedGetItem: (k: string) => (real.getTabAccount() ? stored.get(k) ?? null : null),
    scopedSetItem: (k: string, v: string) => { if (real.getTabAccount()) stored.set(k, v); },
    scopedRemoveItem: (k: string) => { if (real.getTabAccount()) stored.delete(k); },
  };
});

const ACCOUNT = '0e0e0e0e-0000-4000-8000-00000000000e';
const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
const N1 = '11111111-1111-4111-8111-111111111111';
const N2 = '22222222-2222-4222-8222-222222222222';
const NOTE = '33333333-3333-4333-8333-333333333333';
const Y2 = 'removed-elsewhere@example.test';
const W = 'stays@example.test';
const entry = (email: string) => ({ email, permission: 'edit' as const, publicKey: null, userId: null, signingPublicKey: null });
const nbs = [{ id: N1, name: 'A' }, { id: N2, name: 'B' }];
/** The server now: another device took Y2 off N2. */
const serverNow = { notebooks: nbs, labelColors: {}, notebookShares: { [N1]: [entry(W)], [N2]: [entry(W)] } };
/** This device's cache, from before that. */
const staleCache = { notebooks: nbs, labelColors: {}, notebookShares: { [N1]: [entry(W)], [N2]: [entry(Y2), entry(W)] } };
/** Fields this build does not model: a newer client's, and a repair record. */
const otherFields = {
  futureField: { written: 'by a newer client' },
  rescuedNotes: { [NOTE]: [{ wrappedKey: 'old-k', wrappedKeyNonce: 'old-n' }] },
};

type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];
let serverVersion = 5;
let putFails = false;
let notebooksStore: typeof import('./notebooks').notebooksStore;

function server() {
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
    calls.push(c);
    if (c.method === 'PUT' && url === `/api/v1/items/${META}`) {
      if (putFails) return { success: false, status: 503, error: 'unavailable' };
      if (c.body.expected_version !== serverVersion) return { success: false, status: 409, error: 'conflict' };
      serverVersion += 1;
      return { success: true, data: { version: serverVersion } };
    }
    return { success: false, status: 404 };
  });
}

const puts = () => calls.filter(c => c.method === 'PUT' && c.url === `/api/v1/items/${META}`);
const lastPut = () => JSON.parse(puts()[puts().length - 1].body.encrypted_content);
const emailsIn = (list: { email: string }[] | undefined) => (list ?? []).map(r => r.email);
const rowOf = (meta: object | string, version: number) => ({ id: META, item_type: 10, version, deleted: false,
  encrypted_content: typeof meta === 'string' ? meta : JSON.stringify(meta), content_nonce: 'n', updated_at: 't' });
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

/** As in the app: the store module loads before the account is confirmed. */
async function load() {
  const acct = await import('../lib/account');
  acct.setTabAccount(null);
  ({ notebooksStore } = await import('./notebooks'));
  acct.setTabAccount(ACCOUNT);
  notebooksStore.beginHoldsRead().loaded([]);
}

async function start(opts: { cache: object; savedBase?: object }) {
  stored.clear();
  stored.set('pingolin_note_metadata', JSON.stringify(opts.cache));
  if (opts.savedBase) stored.set('pingolin_note_metadata_base', JSON.stringify(opts.savedBase));
  await load();
}

/** A reload: this account's localStorage stays. */
async function reload() {
  vi.resetModules();
  await load();
}

beforeEach(async () => {
  await tick(30);
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  serverVersion = 5;
  putFails = false;
  server();
});

describe('fields this build does not model', () => {
  it('survive a change merged over the first row', async () => {
    await start({ cache: { ...staleCache, ...otherFields } });
    notebooksStore.setEditorModeFor(NOTE, 'markdown', 'hybrid');
    await tick();
    notebooksStore.loadFromSyncedItems([rowOf({ ...serverNow, ...otherFields }, 5)]);
    notebooksStore.markPulled();
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));
    const landed = lastPut();
    expect(landed.editorModes).toEqual({ [NOTE]: 'markdown' });
    expect(landed.futureField).toEqual(otherFields.futureField);
    expect(landed.rescuedNotes).toEqual(otherFields.rescuedNotes);
  });

  it('survive a write that changes nothing modelled (a resumed hold)', async () => {
    await start({ cache: { ...staleCache, ...otherFields } });
    await notebooksStore.holdRemovals(N1, ['not-listed@example.test']);
    notebooksStore.loadFromSyncedItems([rowOf({ ...serverNow, ...otherFields }, 5)]);
    notebooksStore.markPulled();
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));
    expect(lastPut().futureField).toEqual(otherFields.futureField);
  });

  it('survive a write before the first pull, with a saved base', async () => {
    const seen = { ...serverNow, ...otherFields };
    await start({ cache: seen, savedBase: { id: META, version: 5, blob: seen } });
    notebooksStore.setLabelColor('urgent', '#f00');
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));
    expect(lastPut().labelColors).toEqual({ urgent: '#f00' });
    expect(lastPut().futureField).toEqual(otherFields.futureField);
  });
});

describe('after a list no key here opens', () => {
  /** A change before the first pull; that pull brings a locked list, and the write over it fails. */
  async function lockedFirst(cache: object, extraItems: object[] = []) {
    await start({ cache });
    notebooksStore.setEditorModeFor(NOTE, 'markdown', 'hybrid');
    await tick();
    notebooksStore.loadFromSyncedItems([rowOf('LOCKED:sealed', 5), ...extraItems] as any);
    putFails = true;
    notebooksStore.markPulled();
    await vi.waitFor(() => expect(puts().length).toBe(1));
    await tick();
    putFails = false;
    serverVersion = 7;
  }

  it("people set aside are not written off another device's newer list", async () => {
    await lockedFirst(staleCache);
    expect(notebooksStore.getNotebookShares(N1)).toEqual([]);
    notebooksStore.loadFromSyncedItems([rowOf(serverNow, 7)]);
    expect(emailsIn(notebooksStore.getNotebookShares(N1))).toEqual([W]);
    notebooksStore.setLabelColor('later', '#0f0');
    // After the failed write is asked again (askTwice's moment).
    await vi.waitFor(() => expect(lastPut().labelColors).toHaveProperty('later'), { timeout: 3000 });
    expect(emailsIn(lastPut().notebookShares[N1])).toEqual([W]);
    expect(emailsIn(lastPut().notebookShares[N2])).toEqual([W]);
  });

  it("acceptances set aside are not dropped from another device's newer list", async () => {
    const ACC = '55555555-5555-4555-8555-555555555555';
    await lockedFirst({ ...staleCache, acceptedNotebooks: [ACC] });
    notebooksStore.loadFromSyncedItems([rowOf({ ...serverNow, acceptedNotebooks: [ACC] }, 7)]);
    expect(notebooksStore.acceptedNotebooks()).toEqual([ACC]);
  });

  it('a notebook kept from its item is not kept against a readable list without it', async () => {
    const Z = '44444444-4444-4444-8444-444444444444';
    await lockedFirst(staleCache, [{ id: Z, item_type: 2, version: 1, deleted: false, user_id: ACCOUNT,
      encrypted_content: JSON.stringify({ title: 'Z', body: '' }), content_nonce: 'n',
      wrapped_content_key: 'wk', wrapped_content_key_nonce: 'wn', updated_at: 't' }]);
    notebooksStore.markNotebookItemsComplete();
    expect(await notebooksStore.keepNotebooksWhileListLocked(ACCOUNT)).toBe(1);
    // Deleted on another device, its item's delete not through yet.
    notebooksStore.loadFromSyncedItems([rowOf(serverNow, 7)]);
    expect(notebooksStore.notebooks().map(n => n.id)).toEqual([N1, N2]);
  });
});

describe('a change made before the first pull is not lost', () => {
  it('is written at once, so the row delivered again carries it', async () => {
    await start({ cache: staleCache });
    notebooksStore.setEditorModeFor(NOTE, 'markdown', 'hybrid');
    await tick();
    notebooksStore.loadFromSyncedItems([rowOf(serverNow, 5)]);
    expect(notebooksStore.editorModes()).toEqual({ [NOTE]: 'markdown' });
    // Before the sync ends (no markPulled: a later page failed), the write is out.
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));
    expect(puts()[0].body.expected_version).toBe(5);
    expect(lastPut().editorModes).toEqual({ [NOTE]: 'markdown' });
    expect(emailsIn(lastPut().notebookShares[N2])).toEqual([W]);
    // The sync runs again and brings the row as the server now holds it.
    notebooksStore.loadFromSyncedItems([rowOf(lastPut(), 6)]);
    expect(notebooksStore.editorModes()).toEqual({ [NOTE]: 'markdown' });
  });

  it('when the write it asked for had failed', async () => {
    // The first pull did not bring the row (an incremental one); the write after it fails.
    await start({ cache: staleCache });
    notebooksStore.markPulled();
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      return { success: false, status: 503, error: 'unavailable' };
    });
    notebooksStore.setEditorModeFor(NOTE, 'markdown', 'hybrid');
    await tick(30);
    server();
    // A later sync brings the row (another device wrote it).
    notebooksStore.loadFromSyncedItems([rowOf(serverNow, 5)]);
    expect(notebooksStore.editorModes()).toEqual({ [NOTE]: 'markdown' });
    // Sent by the failed write, asked again (askTwice's moment).
    await vi.waitFor(() => expect(puts().map(p => JSON.parse(p.body.encrypted_content).editorModes))
      .toContainEqual({ [NOTE]: 'markdown' }), { timeout: 3000 });
  });

  it('is merged once: with a base known, a later row is adopted as it comes', async () => {
    await start({ cache: staleCache });
    notebooksStore.setLabelColor('made-before-the-pull', '#123');
    await tick();
    notebooksStore.loadFromSyncedItems([rowOf(serverNow, 5)]);
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));
    notebooksStore.loadFromSyncedItems([rowOf({ ...serverNow, labelColors: {} }, 9)]);
    expect(notebooksStore.labelColors()).toEqual({});
  });

  it('and never against the session start once a base was known, even after the row went', async () => {
    await start({ cache: staleCache });
    notebooksStore.setLabelColor('c', '#123');
    await tick();
    notebooksStore.loadFromSyncedItems([rowOf(serverNow, 5)]);
    await vi.waitFor(() => expect(puts().length).toBe(1)); // landed: v6, a base
    // The row is gone from the server, and the new one cannot be created yet.
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      if (opts?.method === 'PUT') return { success: false, status: 404, error: 'gone' };
      return { success: false, status: 500, error: 'down' };
    });
    notebooksStore.setLabelColor('d', '#456');
    await vi.waitFor(() => expect(stored.has('pingolin_note_metadata_base')).toBe(false));
    server();
    // A change asked with no base again: its write waits for a pull.
    notebooksStore.setLabelColor('e', '#789');
    await tick();
    // Another device made a row since, without 'c': it is not put back.
    notebooksStore.loadFromSyncedItems([rowOf(serverNow, 9)]);
    expect(notebooksStore.labelColors()).not.toHaveProperty('c');
  });
});

describe('the create-409 merge with no base', () => {
  it('does not undo a removal made before the first pull', async () => {
    const withOld = { ...serverNow, labelColors: { old: '#111' } };
    await start({ cache: withOld });
    notebooksStore.removeLabelColor('old');
    await tick();
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
      calls.push(c);
      if (c.method === 'POST' && url === '/api/v1/items') return { success: false, status: 409, error: 'exists' };
      if (url.startsWith('/api/v1/sync/pull')) return { success: true, data: { items: [rowOf(withOld, 5)], cursor: null, cursor_id: null, has_more: false } };
      if (c.method === 'PUT' && url === `/api/v1/items/${META}`) {
        if (c.body.expected_version !== serverVersion) return { success: false, status: 409 };
        serverVersion += 1;
        return { success: true, data: { version: serverVersion } };
      }
      return { success: false, status: 404 };
    });
    // An incremental first pull: the row did not change since the cursor, so it is not in it.
    notebooksStore.markPulled();
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));
    expect(lastPut().labelColors).toEqual({});
  });
});
