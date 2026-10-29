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
 * Notebooks after a password reset, in the store (lib/notebookRepair): every
 * object a user encounters should be usable no matter what.
 *
 * WHY THESE EXIST
 *   After a reset the notebook list on the server opens with no key the page
 *   holds, so it cannot be read; a write meets the server's one-list-per-account
 *   rule (409), and the page cannot read the row it finds. Without the repair it
 *   gives up at every write, for good, and a notebook made after the reset is on
 *   no list anywhere: another device never shows it.
 *
 * Keys here are words. "cur:" opens with this identity's vault key, "old:" only
 * with one recovered from before a reset, and anything else with none. A
 * wrapped key starting "cur" or "old" opens the same way, and content under a
 * content key is "ck:".
 */

vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  encryptNote: (p: string) => ({ ciphertext: `cur:${p}`, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => {
    if (!d.ciphertext.startsWith('cur:')) throw new Error('wrong key');
    return d.ciphertext.slice(4);
  },
  decryptNoteWithRecoveredVault: (d: { ciphertext: string }) => d.ciphertext.startsWith('old:') ? d.ciphertext.slice(4) : null,
  vaultKeyThatOpens: (key: string) => key.startsWith('cur') ? 'current' : key.startsWith('old') ? 'recovered' : null,
  unwrapContentKeyWithVault: (key: string) => (key.startsWith('cur') || key.startsWith('old')) ? new Uint8Array(32).fill(7) : null,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'cur-new', nonce: 'cur-new-n' }),
  encryptWithContentKey: (p: string) => ({ ciphertext: `ck:${p}`, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext.startsWith('ck:') ? d.ciphertext.slice(3) : null,
}));

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE = '22222222-2222-4222-8222-222222222222';
const META = 'aaaaaaaa-0000-4000-8000-00000000000a';
const nb = (n: number) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;

interface Row {
  id: string; item_type: number; version: number; deleted: boolean; user_id: string;
  encrypted_content: string; content_nonce: string;
  wrapped_content_key: string | null; wrapped_content_key_nonce: string | null;
}
let server: Map<string, Row>;
let shares: Record<string, { id: string; recipient_email: string; permission: string; has_wrap?: boolean }[]>;
let metaPutFails = false;
type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];

const apiRequest = vi.fn(async (url: string, opts?: { method?: string; body?: any }) => {
  const method = opts?.method ?? 'GET';
  calls.push({ url, method, body: opts?.body });
  const id = /^\/api\/v1\/items\/([0-9a-f-]{36})$/.exec(url)?.[1];
  const sharesOf = /^\/api\/v1\/items\/([0-9a-f-]{36})\/shares$/.exec(url)?.[1];
  if (sharesOf) return { success: true, data: shares[sharesOf] ?? [] };
  if (url.startsWith('/api/v1/sync/pull')) {
    return { success: true, data: { items: [...server.values()], cursor: null, cursor_id: null, has_more: false } };
  }
  if (url === '/api/v1/items' && method === 'POST') {
    const live = [...server.values()].some(r => r.item_type === 10 && !r.deleted);
    if (opts!.body.item_type === 10 && live) return { success: false, status: 409, error: 'exists' };
    const row: Row = {
      id: opts!.body.item_type === 10 ? META : opts!.body.id, item_type: opts!.body.item_type, version: 1, deleted: false, user_id: ME,
      encrypted_content: opts!.body.encrypted_content, content_nonce: opts!.body.content_nonce,
      wrapped_content_key: null, wrapped_content_key_nonce: null,
    };
    server.set(row.id, row);
    return { success: true, data: { id: row.id, version: 1 } };
  }
  if (id && method === 'GET') {
    const row = server.get(id);
    return row ? { success: true, data: row } : { success: false, status: 404 };
  }
  if (id && method === 'PUT') {
    const row = server.get(id);
    if (!row) return { success: false, status: 404 };
    if (row.item_type === 10 && metaPutFails) return { success: false, status: 503 };
    const b = opts!.body;
    if (b.expected_version !== row.version) return { success: false, status: 409 };
    // The server's rule: a plain write never replaces a wrap there is.
    if (row.wrapped_content_key && b.wrapped_content_key && b.wrapped_content_key !== row.wrapped_content_key) {
      return { success: false, status: 409 };
    }
    row.encrypted_content = b.encrypted_content;
    row.content_nonce = b.content_nonce;
    if (b.wrapped_content_key) {
      row.wrapped_content_key = b.wrapped_content_key;
      row.wrapped_content_key_nonce = b.wrapped_content_key_nonce;
    }
    row.version++;
    return { success: true, data: { version: row.version } };
  }
  return { success: false, status: 404 };
});
vi.mock('../lib/apiClient', () => ({ apiRequest: (url: string, opts?: { method?: string; body?: unknown }) => apiRequest(url, opts as never) }));

let notebooksStore: typeof import('./notebooks').notebooksStore;

function put(row: Partial<Row> & { id: string; item_type: number }) {
  server.set(row.id, {
    version: 1, deleted: false, user_id: ME, encrypted_content: '', content_nonce: 'n',
    wrapped_content_key: null, wrapped_content_key_nonce: null, ...row,
  } as Row);
}
const syncAll = () => notebooksStore.loadFromSyncedItems([...server.values()]);
const metaWrites = () => calls.filter(c => (c.method === 'PUT' && c.url === `/api/v1/items/${META}`)
  || (c.method === 'POST' && c.url === '/api/v1/items' && c.body?.item_type === 10));
/** The list on the server now, opened as this identity opens it. */
const listNow = () => {
  const row = server.get(META)!;
  expect(row.encrypted_content.startsWith('cur:')).toBe(true);
  return JSON.parse(row.encrypted_content.slice(4));
};
const names = () => notebooksStore.notebooks().map(n => n.name);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  server = new Map();
  shares = {};
  metaPutFails = false;
  calls.length = 0;
  ({ notebooksStore } = await import('./notebooks'));
});

// People set aside at a locked list must survive a reload. Once a write over
// the locked list has gone out without them, a reload before
// confirmHeldPeople runs would lose them for good if they lived only in
// memory, though the server still lists them on the notebook. They are kept
// with the list (`heldAside`) until confirmed.
describe('people set aside at a locked list, and a reload before they are confirmed', () => {
  const N1 = nb(1);
  const STAYS = { email: 'stays@example.test', permission: 'edit', publicKey: 'aa', userId: 'u-stays' };

  it('a person the server still lists on the notebook is still on its standing list after the reload', async () => {
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: N1, name: 'Family' }], notebookShares: { [N1]: [STAYS] } })}`,
    });
    syncAll();
    notebooksStore.markPulled();
    expect(notebooksStore.getNotebookShares(N1).map(p => p.email)).toEqual(['stays@example.test']);
    // The reset: the list is under the old key now.
    server.get(META)!.encrypted_content = 'stranger:v3';
    server.get(META)!.version = 4;
    syncAll();
    expect(notebooksStore.listAfterReset().locked).toBe(true);
    // The server still lists the person on N1: nobody removed them.
    shares[N1] = [{ id: 's-stays', recipient_email: 'stays@example.test', permission: 'edit' }];

    // Any write before the repair run confirms them (here: a notebook made; a colour, an acceptance, the editor-mode GC after a pull do the same).
    notebooksStore.create('Made after the reset');
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(5));

    // The page reloads (or the tab closes) before the repair run's confirmHeldPeople.
    vi.resetModules();
    ({ notebooksStore } = await import('./notebooks'));
    syncAll();
    notebooksStore.markPulled();
    expect(notebooksStore.listAfterReset().locked).toBe(false);
    // The run after the reload: nothing is set aside any more.
    const back = await notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    expect(notebooksStore.getNotebookShares(N1).map(p => p.email)).toEqual(['stays@example.test']);
  });
  it('an invitation this account accepted is still accepted after the reload', async () => {
    const ACCEPTED = 'cccccccc-0000-4000-8000-000000000001';
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: N1, name: 'Family' }], acceptedNotebooks: [ACCEPTED] })}`,
    });
    syncAll();
    notebooksStore.markPulled();
    expect(notebooksStore.acceptedNotebooks()).toEqual([ACCEPTED]);
    server.get(META)!.encrypted_content = 'stranger:v3';
    server.get(META)!.version = 4;
    syncAll();
    notebooksStore.create('Made after the reset');
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(5));
    vi.resetModules();
    ({ notebooksStore } = await import('./notebooks'));
    syncAll();
    notebooksStore.markPulled();
    // Still offered to this account and never declined: the repair run after the reload confirms nothing (nothing is set aside).
    await notebooksStore.confirmHeldPeople({ offered: new Set([ACCEPTED]), declined: new Set() });
    expect(notebooksStore.acceptedNotebooks()).toEqual([ACCEPTED]);
  });
});

describe('people set aside, and the list opens again (another device wrote it since) before they are confirmed', () => {
  const N1 = nb(1);
  const STAYS = { email: 'stays@example.test', permission: 'edit', publicKey: 'aa', userId: 'u-stays' };
  const BOB = { email: 'bob@example.test', permission: 'edit', publicKey: 'bb', userId: 'u-bob' };

  it('someone the newer list took off is not put back on the server\'s word', async () => {
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: N1, name: 'Family' }], notebookShares: { [N1]: [STAYS, BOB] } })}`,
    });
    syncAll();
    notebooksStore.markPulled();
    // The reset locks the list here; this page sets STAYS and BOB aside.
    server.get(META)!.encrypted_content = 'stranger:v3';
    server.get(META)!.version = 4;
    syncAll();
    expect(notebooksStore.listAfterReset().locked).toBe(true);
    // Another device (signed in after the reset) took Bob off N1: its list, under this identity's key, lacks him.
    // Its revoke of Bob's row on the notebook did not land yet (the drain retries it), so the server still lists him.
    server.get(META)!.encrypted_content = `cur:${JSON.stringify({ notebooks: [{ id: N1, name: 'Family' }], notebookShares: { [N1]: [STAYS] } })}`;
    server.get(META)!.version = 5;
    syncAll();
    expect(notebooksStore.listAfterReset().locked).toBe(false);
    expect(notebooksStore.getNotebookShares(N1).map(p => p.email)).toEqual(['stays@example.test']);
    shares[N1] = [
      { id: 's-stays', recipient_email: 'stays@example.test', permission: 'edit' },
      { id: 's-bob', recipient_email: 'bob@example.test', permission: 'edit' },
    ];
    // The repair run's confirmation.
    await notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    await vi.waitFor(() => expect(server.get(META)!.version).toBeGreaterThanOrEqual(5));
    console.log('standing list of N1 after the confirmation:', JSON.stringify(notebooksStore.getNotebookShares(N1).map(p => p.email)),
      'on the server:', JSON.stringify((listNow().notebookShares?.[N1] ?? []).map((p: { email: string }) => p.email)));
    expect(notebooksStore.getNotebookShares(N1).map(p => p.email)).toEqual(['stays@example.test']);
  });
});

describe('a notebook whose rows could not be read at the confirmation', () => {
  const N1 = nb(1);
  const N2 = nb(2);
  const ANN = { email: 'ann@example.test', permission: 'edit', publicKey: 'aa', userId: 'u-ann' };
  const CAROL = { email: 'carol@example.test', permission: 'edit', publicKey: 'cc', userId: 'u-carol' };

  it('keeps its people for a later try: they are still there at the next load', async () => {
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: N1, name: 'Family' }, { id: N2, name: 'Trip' }], notebookShares: { [N1]: [ANN], [N2]: [CAROL] } })}`,
    });
    syncAll();
    notebooksStore.markPulled();
    server.get(META)!.encrypted_content = 'stranger:v3';
    server.get(META)!.version = 4;
    syncAll();
    shares[N1] = [{ id: 's-ann', recipient_email: 'ann@example.test', permission: 'edit' }];
    shares[N2] = [{ id: 's-carol', recipient_email: 'carol@example.test', permission: 'edit' }];
    // N2's rows do not answer, twice (askTwice): it stays set aside "for a later try".
    const base = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) =>
      url === `/api/v1/items/${N2}/shares` ? { success: false, status: 503 } : base(url, opts));
    vi.useFakeTimers();
    const p = notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    vi.useRealTimers();
    apiRequest.mockImplementation(base);
    // Any write of the list from here (the confirmation's own, or any other) goes out as this page holds it.
    notebooksStore.create('Made after the reset');
    await vi.waitFor(() => expect(server.get(META)!.encrypted_content.startsWith('cur:')).toBe(true));
    await new Promise(r => setTimeout(r, 50));
    // The next load (the repair runs once per load, NotesView onMount).
    vi.resetModules();
    ({ notebooksStore } = await import('./notebooks'));
    syncAll();
    notebooksStore.markPulled();
    await notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    expect(notebooksStore.getNotebookShares(N2).map(p => p.email)).toEqual(['carol@example.test']);
  });
});

describe('what is set aside, written with the list and taken off it', () => {
  const N1 = nb(1);
  const STAYS = { email: 'stays@example.test', permission: 'edit', publicKey: 'aa', userId: 'u-stays' };
  const BOB = { email: 'bob@example.test', permission: 'edit', publicKey: 'bb', userId: 'u-bob' };
  const lockedWith = async (people: object[]) => {
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: N1, name: 'Family' }], notebookShares: { [N1]: people } })}`,
    });
    syncAll();
    notebooksStore.markPulled();
    server.get(META)!.encrypted_content = 'stranger:v3';
    server.get(META)!.version = 4;
    syncAll();
    expect(notebooksStore.listAfterReset().locked).toBe(true);
  };

  it('someone set aside and then taken off the notebook on this page is not put back, though the server still lists them', async () => {
    await lockedWith([STAYS, BOB]);
    shares[N1] = [
      { id: 's-stays', recipient_email: 'stays@example.test', permission: 'edit' },
      { id: 's-bob', recipient_email: 'bob@example.test', permission: 'edit' },
    ];
    await notebooksStore.removeNotebookShare(N1, 'Bob@Example.test');
    await notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    expect(notebooksStore.getNotebookShares(N1).map(p => p.email)).toEqual(['stays@example.test']);
  });

  /**
   * A removal of Bob held from an earlier session (its job loaded at the start,
   * which takes nobody off the set-aside), his row not revoked yet: the server
   * still lists him, and he is not put back (`withoutHeld`).
   */
  it('someone whose removal is held from an earlier session is not put back, though the server still lists them', async () => {
    await lockedWith([STAYS, BOB]);
    shares[N1] = [
      { id: 's-stays', recipient_email: 'stays@example.test', permission: 'edit' },
      { id: 's-bob', recipient_email: 'bob@example.test', permission: 'edit' },
    ];
    notebooksStore.beginHoldsRead().loaded([
      { notebookId: N1, removedRecipients: ['Bob@Example.test'] },
    ]);
    await notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    expect(notebooksStore.getNotebookShares(N1).map(p => p.email)).toEqual(['stays@example.test']);
  });

  it('is in the list written while set aside, and off it once confirmed', async () => {
    await lockedWith([STAYS]);
    notebooksStore.create('Made after the reset');
    await vi.waitFor(() => expect(server.get(META)!.encrypted_content.startsWith('cur:')).toBe(true));
    await new Promise(r => setTimeout(r, 50));
    expect(listNow().heldAside).toEqual({ shares: { [N1]: [STAYS] }, accepted: [] });
    expect(listNow().notebookShares?.[N1] ?? []).toEqual([]);
    shares[N1] = [{ id: 's-stays', recipient_email: 'stays@example.test', permission: 'edit' }];
    expect(await notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() })).toBe(1);
    await vi.waitFor(() => expect(listNow().heldAside).toBeUndefined());
    expect(listNow().notebookShares[N1].map((p: { email: string }) => p.email)).toEqual(['stays@example.test']);
    expect(notebooksStore.heldAsideCount()).toBe(0);
  });
});
