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
 * A metadata write built before this session's first sync merges against the
 * base this account last saw on the server, never against nothing.
 *
 * WHY THESE EXIST
 *   A write built before the first sync (a resume taking someone off a list, a
 *   pruned acceptance) POSTs, meets the existing row's 409 and merges. With no
 *   base to compare, every entry of the stale cache reads as a local addition:
 *   someone ANOTHER device had removed is written back onto the list that seals
 *   new notes.
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
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
}));

/** This account's localStorage, by store name. */
const stored = new Map<string, string>();
vi.mock('../lib/account', async (orig) => {
  const real = await orig<typeof import('../lib/account')>();
  return {
    ...real,
    scopedGetItem: (k: string) => stored.get(k) ?? null,
    scopedSetItem: (k: string, v: string) => { stored.set(k, v); },
    scopedRemoveItem: (k: string) => { stored.delete(k); },
  };
});

const ACCOUNT = '0e0e0e0e-0000-4000-8000-00000000000e';
const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
const N1 = '11111111-1111-4111-8111-111111111111';
const N2 = '22222222-2222-4222-8222-222222222222';
const X = 'removed-here@example.test';
const Y2 = 'removed-elsewhere@example.test';
const W = 'stays@example.test';
const entry = (email: string) => ({ email, permission: 'edit' as const, publicKey: null, userId: null, signingPublicKey: null });
const nbs = [{ id: N1, name: 'A' }, { id: N2, name: 'B' }];

/** What this device last saw on the server (version 4): X on N1, Y2 on N2. */
const seen = { notebooks: nbs, labelColors: {}, notebookShares: { [N1]: [entry(X), entry(W)], [N2]: [entry(Y2), entry(W)] } };
/** The server now (version 5): another device removed Y2 from N2; X is still on N1. */
const serverNow = { notebooks: nbs, labelColors: {}, notebookShares: { [N1]: [entry(X), entry(W)], [N2]: [entry(W)] } };
/** This device's cache: it took X off N1 (a removal whose write never landed), and it never saw Y2 go. */
const staleCache = { notebooks: nbs, labelColors: {}, notebookShares: { [N1]: [entry(W)], [N2]: [entry(Y2), entry(W)] } };

type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];
let serverVersion = 5;
let notebooksStore: typeof import('./notebooks').notebooksStore;

/** The server: a PUT at a stale version conflicts; a GET of the row gives what it holds now. */
function honestServer() {
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
    calls.push(c);
    if (c.method === 'PUT' && url === `/api/v1/items/${META}`) {
      if (c.body.expected_version !== serverVersion) return { success: false, status: 409, error: 'conflict' };
      serverVersion += 1;
      return { success: true, data: { version: serverVersion } };
    }
    if (c.method === 'GET' && url === `/api/v1/items/${META}`) {
      return { success: true, data: { id: META, version: serverVersion, encrypted_content: JSON.stringify(serverNow), content_nonce: 'n' } };
    }
    if (c.method === 'POST' && url === '/api/v1/items') return { success: false, status: 409, error: 'exists' };
    if (url.startsWith('/api/v1/sync/pull')) {
      return { success: true, data: { items: [{ id: META, item_type: 10, deleted: false, version: serverVersion,
        encrypted_content: JSON.stringify(serverNow), content_nonce: 'n', updated_at: 't' }], cursor: null, cursor_id: null, has_more: false } };
    }
    return { success: false, status: 404 };
  });
}

const writes = () => calls.filter(c => (c.method === 'PUT' && c.url === `/api/v1/items/${META}`) || (c.method === 'POST' && c.url === '/api/v1/items'));
const landedShares = () => {
  const puts = calls.filter(c => c.method === 'PUT' && c.url === `/api/v1/items/${META}`);
  return JSON.parse(puts[puts.length - 1].body.encrypted_content).notebookShares;
};
const emailsIn = (list: { email: string }[] | undefined) => (list ?? []).map(r => r.email);

async function start(opts: { savedBase: boolean }) {
  stored.clear();
  stored.set('pingolin_note_metadata', JSON.stringify(staleCache));
  if (opts.savedBase) stored.set('pingolin_note_metadata_base', JSON.stringify({ id: META, version: 4, blob: seen }));
  ({ notebooksStore } = await import('./notebooks'));
  const { setTabAccount } = await import('../lib/account');
  // The account is confirmed: its cache and base are read. (Through null first:
  // the account module outlives resetModules here, and a repeat is no change.)
  setTabAccount(null);
  setTabAccount(ACCOUNT);
  // Its removal jobs were read (none): the holds gate opens.
  notebooksStore.beginHoldsRead().loaded([]);
}

beforeEach(async () => {
  // Let the last test's writes settle first: they share this apiRequest.
  await new Promise(r => setTimeout(r, 30));
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  serverVersion = 5;
  honestServer();
});

describe('a write before the first sync, with the base this account saved', () => {
  it("does not put back someone another device removed", async () => {
    await start({ savedBase: true });
    expect(emailsIn(notebooksStore.getNotebookShares(N2))).toEqual([Y2, W]); // the stale cache

    await notebooksStore.holdRemovals(N1, [X]);

    expect(writes()[0].body.expected_version).toBe(4); // a PUT at the saved base, not a POST
    expect(emailsIn(landedShares()[N2])).toEqual([W]);
    expect(emailsIn(landedShares()[N1])).toEqual([W]);
    expect(emailsIn(notebooksStore.getNotebookShares(N2))).toEqual([W]);
  });

  it('does the same for a pruned acceptance, the other write built before the sync', async () => {
    await start({ savedBase: true });
    stored.set('pingolin_note_metadata', JSON.stringify({ ...staleCache, acceptedNotebooks: ['gone-nb'] }));
    const { setTabAccount } = await import('../lib/account');
    setTabAccount(null);
    setTabAccount(ACCOUNT);
    notebooksStore.beginHoldsRead().loaded([]);
    expect(notebooksStore.acceptedNotebooks()).toEqual(['gone-nb']);

    await notebooksStore.pruneAcceptances(new Set());

    expect(writes()[0].body.expected_version).toBe(4);
    expect(emailsIn(landedShares()[N2])).toEqual([W]);
  });

  it('keeps the base it lands on for the next start', async () => {
    await start({ savedBase: true });

    await notebooksStore.holdRemovals(N1, [X]);

    const base = JSON.parse(stored.get('pingolin_note_metadata_base')!);
    expect(base.id).toBe(META);
    expect(base.version).toBe(6);
    expect(emailsIn(base.blob.notebookShares[N2])).toEqual([W]);
  });
});

describe('the first run with no saved base', () => {
  it('builds no write before the first pull, then writes against the pulled row', async () => {
    await start({ savedBase: false });

    expect(await notebooksStore.holdRemovals(N1, [X])).toBe(false);
    expect(writes()).toEqual([]);

    // The session's first pull brings the row: now there is a base.
    notebooksStore.loadFromSyncedItems([{ id: META, item_type: 10, version: 5, deleted: false,
      encrypted_content: JSON.stringify(serverNow), content_nonce: 'n', updated_at: 't' }]);
    notebooksStore.markPulled();
    await vi.waitFor(() => expect(writes().length).toBeGreaterThan(0));

    expect(writes()[0].body.expected_version).toBe(5);
    expect(emailsIn(landedShares()[N1])).toEqual([W]);
    expect(emailsIn(landedShares()[N2])).toEqual([W]);
  });

  it('writes after a first pull that did not bring the row', async () => {
    await start({ savedBase: false });
    notebooksStore.setLabelColor('only-in-this-session', '#123');
    await new Promise(r => setTimeout(r, 20));
    expect(writes()).toEqual([]);

    notebooksStore.markPulled();

    // The held write goes, carrying this session's change.
    await vi.waitFor(() => expect(writes().some(c => c.body.encrypted_content.includes('only-in-this-session'))).toBe(true));
  });
});

/**
 * A change made before the first pull, when that pull brings the row.
 *
 * WHY THESE EXIST
 *   With no base, the write a change asks for waits for this session's first
 *   pull, and adopting the row that pull brings used to REPLACE the signals: a
 *   note's editor mode pinned in a fresh browser before its first sync was gone
 *   (the modal went back to the default), and the held write sent the server's
 *   own blob back. The change is now merged over the row, against the cache the
 *   session started from — so what another device removed stays removed.
 */
describe('a change made before the first pull that brings the row', () => {
  const NOTE = '33333333-3333-4333-8333-333333333333';
  const puts = () => calls.filter(c => c.method === 'PUT' && c.url === `/api/v1/items/${META}`);
  const lastPut = () => JSON.parse(puts()[puts().length - 1].body.encrypted_content);
  const row = (meta: object, version = 5) => ({ id: META, item_type: 10, version, deleted: false,
    encrypted_content: JSON.stringify(meta), content_nonce: 'n', updated_at: 't' });

  it("keeps a note's editor mode, and writes it at the pulled version", async () => {
    await start({ savedBase: false });
    notebooksStore.setEditorModeFor(NOTE, 'markdown', 'hybrid');
    await new Promise(r => setTimeout(r, 20));
    expect(puts()).toEqual([]);

    notebooksStore.loadFromSyncedItems([row(serverNow)]);
    expect(notebooksStore.editorModes()).toEqual({ [NOTE]: 'markdown' });

    notebooksStore.markPulled();
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));
    expect(puts()[0].body.expected_version).toBe(5);
    expect(lastPut().editorModes).toEqual({ [NOTE]: 'markdown' });
  });

  it('keeps a label colour and a notebook, and does not put back what another device removed', async () => {
    // The stale cache still lists Y2 on N2; the row, written since, does not.
    await start({ savedBase: false });
    notebooksStore.setLabelColor('made-before-the-pull', '#123');
    const nb = notebooksStore.create('Made before the pull');
    await new Promise(r => setTimeout(r, 20));

    notebooksStore.loadFromSyncedItems([row(serverNow)]);
    expect(emailsIn(notebooksStore.getNotebookShares(N2))).toEqual([W]);
    notebooksStore.markPulled();
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));

    const landed = lastPut();
    expect(landed.labelColors).toEqual({ 'made-before-the-pull': '#123' });
    expect(landed.notebooks.map((n: { id: string }) => n.id)).toEqual([N1, N2, nb.id]);
    expect(emailsIn(landed.notebookShares[N2])).toEqual([W]);
  });

  it('adopts the row as it is when nothing changed before the pull, and writes nothing', async () => {
    await start({ savedBase: false });

    notebooksStore.loadFromSyncedItems([row(serverNow)]);
    notebooksStore.markPulled();
    await new Promise(r => setTimeout(r, 30));

    expect(puts()).toEqual([]);
    expect(emailsIn(notebooksStore.getNotebookShares(N1))).toEqual([X, W]);
    expect(emailsIn(notebooksStore.getNotebookShares(N2))).toEqual([W]);
  });

  it("merges once: with a base known, a later row is adopted as it comes", async () => {
    await start({ savedBase: false });
    notebooksStore.setLabelColor('made-before-the-pull', '#123');
    notebooksStore.loadFromSyncedItems([row(serverNow)]);
    notebooksStore.markPulled();
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));

    // Another device took the colour off since: the next sync brings that.
    notebooksStore.loadFromSyncedItems([row({ ...serverNow, labelColors: {} }, 9)]);

    expect(notebooksStore.labelColors()).toEqual({});
  });

  it('keeps someone held off a list off it, through the merge', async () => {
    await start({ savedBase: false });
    expect(await notebooksStore.holdRemovals(N1, [X])).toBe(false);
    notebooksStore.setLabelColor('made-before-the-pull', '#123');

    // The row still lists X on N1.
    notebooksStore.loadFromSyncedItems([row(serverNow)]);
    expect(emailsIn(notebooksStore.getNotebookShares(N1))).toEqual([W]);
    notebooksStore.markPulled();
    await vi.waitFor(() => expect(puts().length).toBeGreaterThan(0));

    const landed = lastPut();
    expect(emailsIn(landed.notebookShares[N1])).toEqual([W]);
    expect(landed.labelColors).toEqual({ 'made-before-the-pull': '#123' });
  });
});

describe("a session's pull is its own", () => {
  it('is forgotten at an account change: the next account waits for its own pull', async () => {
    await start({ savedBase: false });
    notebooksStore.markPulled();
    const { setTabAccount } = await import('../lib/account');
    setTabAccount('0e0e0e0e-0000-4000-8000-00000000000b');
    notebooksStore.beginHoldsRead().loaded([]);

    notebooksStore.setLabelColor('urgent', '#f00');
    await new Promise(r => setTimeout(r, 20));

    expect(writes()).toEqual([]);
  });

  it('is forgotten at a sign-out', async () => {
    await start({ savedBase: false });
    notebooksStore.markPulled();
    notebooksStore.reset();

    notebooksStore.setLabelColor('urgent', '#f00');
    await new Promise(r => setTimeout(r, 20));

    expect(writes()).toEqual([]);
  });
});

describe('the saved base', () => {
  it('is saved from a sync, a landed write and a conflict re-read', async () => {
    await start({ savedBase: false });
    notebooksStore.loadFromSyncedItems([{ id: META, item_type: 10, version: 5, deleted: false,
      encrypted_content: JSON.stringify(serverNow), content_nonce: 'n', updated_at: 't' }]);
    expect(JSON.parse(stored.get('pingolin_note_metadata_base')!).version).toBe(5);

    notebooksStore.setLabelColor('urgent', '#f00');
    await vi.waitFor(() => expect(JSON.parse(stored.get('pingolin_note_metadata_base')!).version).toBe(6));

    // Another device wrote since: the next PUT conflicts and the row is re-read,
    // and here the retry fails, so what's kept is the re-read row itself.
    serverVersion = 9;
    let retries = 0;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
      calls.push(c);
      if (c.method === 'PUT') {
        if (c.body.expected_version !== serverVersion) return { success: false, status: 409, error: 'conflict' };
        retries++;
        return { success: false, status: 503, error: 'unavailable' };
      }
      if (c.method === 'GET' && url === `/api/v1/items/${META}`) {
        return { success: true, data: { id: META, version: serverVersion, encrypted_content: JSON.stringify(serverNow), content_nonce: 'n' } };
      }
      return { success: false, status: 404 };
    });
    notebooksStore.setLabelColor('later', '#0f0');
    await vi.waitFor(() => expect(retries).toBe(1));
    expect(JSON.parse(stored.get('pingolin_note_metadata_base')!).version).toBe(9);
  });

  it('is saved from the write that creates the row', async () => {
    await start({ savedBase: false });
    notebooksStore.markPulled(); // a new account: the pull found no metadata row
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      if (opts?.method === 'POST' && url === '/api/v1/items') return { success: true, data: { id: META, version: 1 } };
      return { success: false, status: 404 };
    });

    notebooksStore.setLabelColor('urgent', '#f00');

    await vi.waitFor(() => expect(stored.get('pingolin_note_metadata_base')).toBeDefined());
    expect(JSON.parse(stored.get('pingolin_note_metadata_base')!)).toMatchObject({ id: META, version: 1 });
  });

  it('goes with the row: a 404 on the remembered row drops it', async () => {
    await start({ savedBase: true });
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      calls.push({ url, method: opts?.method ?? 'GET', body: opts?.body });
      if (opts?.method === 'PUT') return { success: false, status: 404, error: 'gone' };
      if (opts?.method === 'POST') return { success: false, status: 500, error: 'down' };
      return { success: false, status: 404 };
    });

    notebooksStore.setLabelColor('urgent', '#f00');

    await vi.waitFor(() => expect(stored.has('pingolin_note_metadata_base')).toBe(false));
  });

  it('is swept with the metadata cache at a sign-out', async () => {
    const { ACCOUNT_SCOPED_STORES } = await import('../lib/account');
    expect(ACCOUNT_SCOPED_STORES).toContain('pingolin_note_metadata_base');
  });
});
