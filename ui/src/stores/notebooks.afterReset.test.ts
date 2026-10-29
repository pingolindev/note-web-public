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

describe('a notebook list no key here opens (from before a password reset)', () => {
  const LOCKED = 'stranger:{"notebooks":[{"id":"x","name":"Before"}]}';

  it('is not adopted, and the next write goes over it, carrying it whole', async () => {
    put({ id: META, item_type: 10, version: 3, encrypted_content: LOCKED, content_nonce: 'ln' });
    syncAll();
    expect(notebooksStore.listAfterReset()).toEqual({ locked: true, openedWithRecoveredKey: false });
    expect(names()).toEqual([]);

    notebooksStore.markPulled();
    notebooksStore.create('Made after the reset');
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(4));

    const list = listNow();
    expect(list.notebooks.map((n: { name: string }) => n.name)).toEqual(['Made after the reset']);
    expect(list.beforeReset).toEqual([{ ciphertext: LOCKED, nonce: 'ln' }]);
    expect(notebooksStore.listAfterReset().locked).toBe(false);
    // Once: the row is this identity's now, and the next write carries what it carried.
    notebooksStore.create('Another');
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(5));
    expect(listNow().beforeReset).toEqual([{ ciphertext: LOCKED, nonce: 'ln' }]);
  });

  /**
   * The same browser as before the reset holds a merge base: the list as it
   * last read it, at an older version. Kept, it would read every notebook of
   * that list as REMOVED on the server's part the first time another device
   * wrote the list over first.
   */
  it('a merge base from before the reset is dropped: another device writing first removes nothing of this one\'s', async () => {
    const A = { id: nb(1), name: 'A' };
    const B = { id: nb(2), name: 'B' };
    put({ id: META, item_type: 10, version: 2, encrypted_content: `cur:${JSON.stringify({ notebooks: [A, B] })}` });
    syncAll();
    notebooksStore.markPulled();
    // The reset: the row is now one no key here opens.
    server.get(META)!.encrypted_content = LOCKED;
    server.get(META)!.version = 3;
    syncAll();
    expect(notebooksStore.listAfterReset().locked).toBe(true);
    // Another device writes it over first, knowing nothing of A or B.
    server.get(META)!.encrypted_content = `cur:${JSON.stringify({ notebooks: [{ id: nb(4), name: 'D' }] })}`;
    server.get(META)!.version = 4;

    notebooksStore.create('C');
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(5));
    expect(listNow().notebooks.map((n: { name: string }) => n.name).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  /**
   * The same, with no version bump: a reset changes keys, not the row's version.
   * A base kept for a locked row at the base's own version would make the next
   * 409 merge drop A and B.
   */
  it('a merge base at the locked row\'s own version is dropped too: a reset changes keys, not versions', async () => {
    const A = { id: nb(1), name: 'A' };
    const B = { id: nb(2), name: 'B' };
    put({ id: META, item_type: 10, version: 3, encrypted_content: `cur:${JSON.stringify({ notebooks: [A, B] })}` });
    syncAll();
    notebooksStore.markPulled();
    // The reset: the same row, the same version, no key here opens it.
    server.get(META)!.encrypted_content = LOCKED;
    syncAll();
    expect(notebooksStore.listAfterReset().locked).toBe(true);
    // A fresh device writes it over first, knowing nothing of A or B.
    server.get(META)!.encrypted_content = `cur:${JSON.stringify({ notebooks: [{ id: nb(4), name: 'D' }] })}`;
    server.get(META)!.version = 4;

    notebooksStore.create('C');
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(5));
    expect(listNow().notebooks.map((n: { name: string }) => n.name).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  /** A list that opens again stops being held as locked. */
  it('once the list opens again (written over elsewhere, carrying the old one), it is no longer held as locked', async () => {
    put({ id: META, item_type: 10, version: 3, encrypted_content: LOCKED, content_nonce: 'ln' });
    syncAll();
    notebooksStore.markPulled();
    expect(notebooksStore.listAfterReset().locked).toBe(true);
    server.get(META)!.encrypted_content = `cur:${JSON.stringify({ notebooks: [{ id: nb(4), name: 'D' }], beforeReset: [{ ciphertext: LOCKED, nonce: 'ln' }] })}`;
    server.get(META)!.version = 4;
    syncAll();
    expect(notebooksStore.listAfterReset().locked).toBe(false);
  });

  /** The probe's road: a fresh device that never saw the row, whose create meets the 409. */
  it('found on a write the server refused because a list exists: written over, not given up on', async () => {
    put({ id: META, item_type: 10, version: 3, encrypted_content: LOCKED, content_nonce: 'ln' });
    notebooksStore.markPulled();
    notebooksStore.create('Made after the reset');
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(4));
    expect(listNow().notebooks.map((n: { name: string }) => n.name)).toEqual(['Made after the reset']);
    expect(listNow().beforeReset).toEqual([{ ciphertext: LOCKED, nonce: 'ln' }]);
    // The POST first, then the scan, then the write over the row it found.
    expect(metaWrites().map(c => c.method)).toEqual(['POST', 'PUT']);
  });

  it('while it is locked, every notebook of this account\'s whose record opens is put on the list; only after a full pull', async () => {
    put({ id: META, item_type: 10, version: 3, encrypted_content: LOCKED, content_nonce: 'ln' });
    put({ id: nb(1), item_type: 2, wrapped_content_key: 'cur-1', wrapped_content_key_nonce: 'n', encrypted_content: 'ck:{"title":"Made elsewhere","members":[]}' });
    put({ id: nb(2), item_type: 2, user_id: SOMEONE, wrapped_content_key: 'cur-2', wrapped_content_key_nonce: 'n', encrypted_content: 'ck:{"title":"Not mine","members":[]}' });
    put({ id: nb(3), item_type: 2, wrapped_content_key: 'stranger-3', wrapped_content_key_nonce: 'n', encrypted_content: 'ck:{"title":"Locked"}' });
    put({ id: nb(4), item_type: 2, deleted: true, wrapped_content_key: 'cur-4', wrapped_content_key_nonce: 'n', encrypted_content: 'ck:{"title":"Deleted"}' });
    syncAll();
    notebooksStore.markPulled();

    expect(await notebooksStore.keepNotebooksWhileListLocked(ME)).toBe(0);
    expect(metaWrites()).toEqual([]);

    notebooksStore.markNotebookItemsComplete();
    expect(await notebooksStore.keepNotebooksWhileListLocked(ME)).toBe(1);
    expect(names()).toEqual(['Made elsewhere']);
    expect(listNow().notebooks).toEqual([{ id: nb(1), name: 'Made elsewhere' }]);
    expect(listNow().beforeReset).toEqual([{ ciphertext: LOCKED, nonce: 'ln' }]);
  });

  it('nothing is added to a list that opens: a notebook missing from it may be one being deleted', async () => {
    put({ id: META, item_type: 10, version: 3, encrypted_content: 'cur:{"notebooks":[]}' });
    put({ id: nb(1), item_type: 2, wrapped_content_key: 'cur-1', wrapped_content_key_nonce: 'n', encrypted_content: 'ck:{"title":"Orphan"}' });
    syncAll();
    notebooksStore.markPulled();
    notebooksStore.markNotebookItemsComplete();
    expect(await notebooksStore.keepNotebooksWhileListLocked(ME)).toBe(0);
    expect(names()).toEqual([]);
  });
});

describe('a list that opens only with a key recovered from before a reset', () => {
  it('is read, and written again whole under this identity\'s key', async () => {
    const then = { notebooks: [{ id: nb(1), name: 'Kept' }], labelColors: { work: '#f00' }, editorModes: {}, acceptedNotebooks: [nb(9)] };
    put({ id: META, item_type: 10, version: 3, encrypted_content: `old:${JSON.stringify(then)}` });
    syncAll();
    expect(names()).toEqual(['Kept']);
    expect(notebooksStore.listAfterReset()).toEqual({ locked: false, openedWithRecoveredKey: true });
    notebooksStore.markPulled();

    expect(await notebooksStore.rewriteListUnderThisIdentity()).toBe(true);
    const list = listNow();
    expect(list.notebooks).toEqual(then.notebooks);
    expect(list.labelColors).toEqual(then.labelColors);
    expect(list.acceptedNotebooks).toEqual(then.acceptedNotebooks);
    expect(notebooksStore.listAfterReset().openedWithRecoveredKey).toBe(false);
    expect(await notebooksStore.rewriteListUnderThisIdentity()).toBe(false);
  });
});

describe('a carried list a recovery key opens now', () => {
  it('adds back only what is missing; never people, never acceptances; a deleted notebook stays gone', async () => {
    const earlier = {
      notebooks: [{ id: nb(5), name: 'Then' }, { id: nb(6), name: 'Deleted since' }, { id: nb(7), name: 'Still here' }],
      labelColors: { work: '#f00', home: '#0f0' },
      editorModes: { 'cccccccc-0000-4000-8000-00000000000c': 'markdown' },
      acceptedNotebooks: [nb(8)],
      notebookShares: { [nb(5)]: [{ email: 'removed-since@example.test', permission: 'edit', publicKey: null }] },
    };
    const kept = { ciphertext: 'stranger', nonce: 'sn' };
    const now = {
      notebooks: [{ id: nb(7), name: 'Still here, renamed' }],
      labelColors: { home: '#00f' },
      beforeReset: [{ ciphertext: `old:${JSON.stringify(earlier)}`, nonce: 'on' }, kept],
    };
    put({ id: META, item_type: 10, version: 3, encrypted_content: `cur:${JSON.stringify(now)}` });
    put({ id: nb(5), item_type: 2, wrapped_content_key: 'old-5', wrapped_content_key_nonce: 'n', encrypted_content: 'ck:{"title":"Then"}' });
    put({ id: nb(6), item_type: 2, deleted: true });
    shares[nb(5)] = [{ id: 's1', recipient_email: 'holds-it-now@example.test', permission: 'view' }];
    syncAll();
    notebooksStore.markPulled();
    // Not before a full pull has said which notebooks are deleted.
    expect(await notebooksStore.mergeBackEarlierLists(() => [])).toBe(0);
    expect(metaWrites()).toEqual([]);
    notebooksStore.markNotebookItemsComplete();

    expect(await notebooksStore.mergeBackEarlierLists(() => [])).toBe(1);
    const list = listNow();
    expect(list.notebooks).toEqual([{ id: nb(7), name: 'Still here, renamed' }, { id: nb(5), name: 'Then' }]);
    expect(list.labelColors).toEqual({ home: '#00f', work: '#f00' });
    expect(list.editorModes).toEqual(earlier.editorModes);
    expect(list.acceptedNotebooks).toEqual([]);
    expect(list.notebookShares[nb(5)].map((r: { email: string }) => r.email)).toEqual(['holds-it-now@example.test']);
    // The one no key opens stays carried; the one merged goes.
    expect(list.beforeReset).toEqual([kept]);
  });

  it('none that opens: nothing is written', async () => {
    put({ id: META, item_type: 10, version: 3, encrypted_content: `cur:${JSON.stringify({ notebooks: [], beforeReset: [{ ciphertext: 'stranger', nonce: 'n' }] })}` });
    syncAll();
    notebooksStore.markPulled();
    expect(await notebooksStore.mergeBackEarlierLists(() => [])).toBe(0);
    expect(metaWrites()).toEqual([]);
  });
});

describe('what is known of a notebook\'s record', () => {
  it('an owner id is compared in its canonical form', () => {
    // With letters in it: an id of digits alone reads the same in either case.
    const me = 'dddddddd-1111-4111-8111-11111111111d';
    expect(me.toUpperCase()).not.toBe(me);
    put({ id: nb(1), item_type: 2, user_id: me.toUpperCase(), wrapped_content_key: 'stranger-1', wrapped_content_key_nonce: 'n' });
    syncAll();
    expect(notebooksStore.recordStateOf(nb(1), me)).toBe('locked');
  });

  it('opens (either key), locked, keyless, or unknown for one not this account\'s', () => {
    put({ id: nb(1), item_type: 2, wrapped_content_key: 'cur-1', wrapped_content_key_nonce: 'n' });
    put({ id: nb(2), item_type: 2, wrapped_content_key: 'old-2', wrapped_content_key_nonce: 'n' });
    put({ id: nb(3), item_type: 2, wrapped_content_key: 'stranger-3', wrapped_content_key_nonce: 'n' });
    put({ id: nb(4), item_type: 2 });
    put({ id: nb(5), item_type: 2, user_id: SOMEONE, wrapped_content_key: 'stranger-5', wrapped_content_key_nonce: 'n' });
    put({ id: nb(6), item_type: 2, deleted: true, wrapped_content_key: 'stranger-6', wrapped_content_key_nonce: 'n' });
    syncAll();
    expect([1, 2, 3, 4, 5, 6, 7].map(n => notebooksStore.recordStateOf(nb(n), ME)))
      .toEqual(['opens', 'opens', 'locked', 'keyless', 'unknown', 'unknown', 'unknown']);
  });
});

describe('a notebook with no key', () => {
  function listed(id: string, name: string, extra: Record<string, unknown> = {}) {
    put({ id: META, item_type: 10, version: 3, encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id, name }], ...extra })}` });
  }

  it('is given one, keeping its content when a vault key here opens it', async () => {
    listed(nb(1), 'Listed name');
    put({ id: nb(1), item_type: 2, version: 4, encrypted_content: 'cur:{"title":"Old","color":"#abc","edit_mode":"rich"}' });
    syncAll();
    notebooksStore.markPulled();
    expect(await notebooksStore.giveNotebookAKey(nb(1), ME)).toBe(true);
    const row = server.get(nb(1))!;
    expect(row.wrapped_content_key).toBe('cur-new');
    expect(JSON.parse(row.encrypted_content.slice(3))).toEqual({ title: 'Listed name', color: '#abc', edit_mode: 'rich', members: [] });
    expect(notebooksStore.recordStateOf(nb(1), ME)).toBe('opens');
    expect(notebooksStore.notebookContentKey(nb(1))).not.toBeNull();
    // Its content opened: nothing had to be carried.
    expect(metaWrites()).toEqual([]);
  });

  it('whose content opens with no key here: the content is carried in the list FIRST, then the record is written new', async () => {
    listed(nb(1), 'Listed name');
    put({ id: nb(1), item_type: 2, version: 4, encrypted_content: 'stranger-content', content_nonce: 'sc' });
    syncAll();
    notebooksStore.markPulled();
    expect(await notebooksStore.giveNotebookAKey(nb(1), ME)).toBe(true);
    const metaAt = calls.findIndex(c => c.method === 'PUT' && c.url === `/api/v1/items/${META}`);
    const itemAt = calls.findIndex(c => c.method === 'PUT' && c.url === `/api/v1/items/${nb(1)}`);
    expect(metaAt).toBeGreaterThan(-1);
    expect(metaAt).toBeLessThan(itemAt);
    expect(listNow().rebuiltNotebooks).toEqual({
      [nb(1)]: [{ wrappedKey: null, wrappedKeyNonce: null, ciphertext: 'stranger-content', nonce: 'sc' }],
    });
    expect(JSON.parse(server.get(nb(1))!.encrypted_content.slice(3)).title).toBe('Listed name');
  });

  it('when carrying it does not land, the record is left as it is', async () => {
    listed(nb(1), 'Listed name');
    put({ id: nb(1), item_type: 2, version: 4, encrypted_content: 'stranger-content' });
    syncAll();
    notebooksStore.markPulled();
    metaPutFails = true;
    expect(await notebooksStore.giveNotebookAKey(nb(1), ME)).toBe(false);
    expect(server.get(nb(1))!.encrypted_content).toBe('stranger-content');
    expect(server.get(nb(1))!.wrapped_content_key).toBeNull();
  });

  it('nothing for a notebook not this account\'s, nor one that has a key by now (it is taken)', async () => {
    listed(nb(1), 'Listed name');
    put({ id: nb(1), item_type: 2, user_id: SOMEONE, encrypted_content: 'cur:{}' });
    syncAll();
    expect(await notebooksStore.giveNotebookAKey(nb(1), ME)).toBe(false);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);

    server.get(nb(1))!.user_id = ME;
    server.get(nb(1))!.wrapped_content_key = 'cur-other-device';
    server.get(nb(1))!.wrapped_content_key_nonce = 'n';
    expect(await notebooksStore.giveNotebookAKey(nb(1), ME)).toBe(true);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
    expect(notebooksStore.notebookWrap(nb(1))).toEqual({ key: 'cur-other-device', nonce: 'n' });
  });
});

describe('earlier records a recovery key opens now (2)', () => {
  it('a colour the rebuild could only write as none comes back', async () => {
    const opens = { wrappedKey: 'old-w', wrappedKeyNonce: 'n', ciphertext: 'ck:{"title":"Then","color":"#f00","is_pinned":true}', nonce: 'n' };
    const rebuilt = { title: 'Now', body: '', note_type: 'text', color: null, is_pinned: false, is_archived: false, labels: [], sort_order: 0, members: [] };
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: nb(1), name: 'Now' }], rebuiltNotebooks: { [nb(1)]: [opens] } })}`,
    });
    put({ id: nb(1), item_type: 2, version: 5, wrapped_content_key: 'cur-1', wrapped_content_key_nonce: 'n', encrypted_content: `ck:${JSON.stringify(rebuilt)}` });
    syncAll();
    notebooksStore.markPulled();
    expect(await notebooksStore.restoreFromEarlierRecords()).toBe(1);
    expect(JSON.parse(server.get(nb(1))!.encrypted_content.slice(3))).toEqual({ ...rebuilt, color: '#f00', is_pinned: true });
    expect(listNow().rebuiltNotebooks).toEqual({});
  });
});

describe('earlier records a recovery key opens now', () => {
  it('put back what the record lacks, never its name or people, and are no longer carried', async () => {
    const opens = { wrappedKey: 'old-w', wrappedKeyNonce: 'n', ciphertext: 'ck:{"title":"Then","color":"#f00","members":[{"userId":"x"}]}', nonce: 'n' };
    const locked = { wrappedKey: 'stranger-w', wrappedKeyNonce: 'n', ciphertext: 'ck:{"color":"#000"}', nonce: 'n' };
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: nb(1), name: 'Now' }], rebuiltNotebooks: { [nb(1)]: [opens, locked] } })}`,
    });
    put({ id: nb(1), item_type: 2, version: 5, wrapped_content_key: 'cur-1', wrapped_content_key_nonce: 'n', encrypted_content: 'ck:{"title":"Now","members":[]}' });
    syncAll();
    notebooksStore.markPulled();

    expect(await notebooksStore.restoreFromEarlierRecords()).toBe(1);
    expect(JSON.parse(server.get(nb(1))!.encrypted_content.slice(3))).toEqual({ title: 'Now', members: [], color: '#f00' });
    expect(server.get(nb(1))!.wrapped_content_key).toBe('cur-1');
    expect(listNow().rebuiltNotebooks).toEqual({ [nb(1)]: [locked] });
  });
});

describe('an earlier record whose write the server does not take', () => {
  it('is kept, for the next go: nothing is dropped from the list', async () => {
    const opens = { wrappedKey: 'old-w', wrappedKeyNonce: 'n', ciphertext: 'ck:{"title":"Then","color":"#f00"}', nonce: 'n' };
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: nb(1), name: 'Now' }], rebuiltNotebooks: { [nb(1)]: [opens] } })}`,
    });
    put({ id: nb(1), item_type: 2, version: 5, wrapped_content_key: 'cur-1', wrapped_content_key_nonce: 'n', encrypted_content: 'ck:{"title":"Now","members":[]}' });
    syncAll();
    notebooksStore.markPulled();
    // Moved on meanwhile: the write is refused.
    server.get(nb(1))!.version = 6;
    expect(await notebooksStore.restoreFromEarlierRecords()).toBe(0);
    expect(metaWrites()).toEqual([]);
  });
});

describe('an old key kept in the list for a rescued note\'s attachments (lib/noteRescue)', () => {
  const OLD = { wrappedKey: 'gone-wk', wrappedKeyNonce: 'gone-wn' };
  const OTHER = { wrappedKey: 'gone-wk-2', wrappedKeyNonce: 'gone-wn-2' };
  const NOTE = 'cccccccc-0000-4000-8000-00000000000c';
  const listWith = (extra: Record<string, unknown> = {}) =>
    put({ id: META, item_type: 10, version: 3, encrypted_content: `cur:${JSON.stringify({ notebooks: [{ id: nb(1), name: 'Kept' }], ...extra })}` });

  it('is in the list on the server before it is said to be kept, and the rest of the list is as it was', async () => {
    listWith();
    syncAll();
    expect(await notebooksStore.keepOldNoteKey(NOTE, OLD)).toBe(true);
    expect(listNow().rescuedNotes).toEqual({ [NOTE]: [OLD] });
    expect(listNow().notebooks.map((n: { name: string }) => n.name)).toEqual(['Kept']);
    expect(notebooksStore.keptNoteKeys()).toEqual({ [NOTE]: [OLD] });
  });

  it('a list write that does not land: not kept, and the rescue waits', async () => {
    listWith();
    syncAll();
    metaPutFails = true;
    expect(await notebooksStore.keepOldNoteKey(NOTE, OLD)).toBe(false);
  });

  it('one kept from before, written by another device, stays beside a new one; dropped only when named', async () => {
    listWith({ rescuedNotes: { [NOTE]: [OTHER] } });
    syncAll();
    expect(await notebooksStore.keepOldNoteKey(NOTE, OLD)).toBe(true);
    expect(listNow().rescuedNotes).toEqual({ [NOTE]: [OTHER, OLD] });
    await notebooksStore.dropKeptNoteKeys(NOTE, [OTHER]);
    expect(listNow().rescuedNotes).toEqual({ [NOTE]: [OLD] });
    await notebooksStore.dropKeptNoteKeys(NOTE, [OLD]);
    expect(listNow().rescuedNotes).toEqual({});
  });
});

describe('people and acceptances this browser held when its list turned out locked', () => {
  const N1 = nb(1);
  const STAYS = { email: 'stays@example.test', permission: 'edit', publicKey: 'aa', userId: 'u-stays' };
  const REMOVED = { email: 'removed-before-the-reset@example.test', permission: 'edit', publicKey: 'bb', userId: 'u-removed' };
  const ACCEPTED_STILL = 'cccccccc-0000-4000-8000-000000000001';
  const DECLINED_SINCE = 'cccccccc-0000-4000-8000-000000000005';

  /** This browser read the list at v3: N1 shared with two people, two invitations accepted. Then the reset. */
  async function heldThenLocked() {
    put({
      id: META, item_type: 10, version: 3,
      encrypted_content: `cur:${JSON.stringify({
        notebooks: [{ id: N1, name: 'Family' }],
        notebookShares: { [N1]: [STAYS, REMOVED] },
        acceptedNotebooks: [ACCEPTED_STILL, DECLINED_SINCE],
      })}`,
    });
    syncAll();
    notebooksStore.markPulled();
    expect(notebooksStore.getNotebookShares(N1).length).toBe(2);
    // Another device took one person off and declined one invitation (v4), then the reset locked it.
    server.get(META)!.encrypted_content = 'stranger:v4';
    server.get(META)!.version = 4;
    syncAll();
    expect(notebooksStore.listAfterReset().locked).toBe(true);
  }

  it('are set aside: nobody of them is sealed to, and a write over the locked list carries none of them', async () => {
    await heldThenLocked();
    expect(notebooksStore.getNotebookShares(N1)).toEqual([]);
    // Acceptances still decide what shows here.
    expect(notebooksStore.acceptedNotebooks()).toEqual([ACCEPTED_STILL, DECLINED_SINCE]);
    expect(notebooksStore.isNotebookAccepted(ACCEPTED_STILL)).toBe(true);
    notebooksStore.create('Made after the reset');
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(5));
    expect(listNow().notebookShares ?? {}).toEqual({});
    expect(listNow().acceptedNotebooks ?? []).toEqual([]);
  });

  it('are put back as far as the server confirms them: a person who still has a row, an invitation still offered and not declined', async () => {
    await heldThenLocked();
    shares[N1] = [{ id: 's-stays', recipient_email: 'stays@example.test', permission: 'edit' }];
    const back = await notebooksStore.confirmHeldPeople({
      offered: new Set([ACCEPTED_STILL, DECLINED_SINCE]),
      declined: new Set([DECLINED_SINCE]),
    });
    expect(back).toBe(2);
    expect(notebooksStore.getNotebookShares(N1).map(p => p.email)).toEqual(['stays@example.test']);
    await vi.waitFor(() => expect(server.get(META)!.version).toBe(5));
    expect(listNow().notebookShares[N1].map((p: { email: string }) => p.email)).toEqual(['stays@example.test']);
    expect(listNow().acceptedNotebooks).toEqual([ACCEPTED_STILL]);
    expect(notebooksStore.acceptedNotebooks()).toEqual([ACCEPTED_STILL]);
    expect(notebooksStore.heldAsideCount()).toBe(0);
  });

  it('nobody the server lists is added who was not set aside', async () => {
    await heldThenLocked();
    shares[N1] = [
      { id: 's-stays', recipient_email: 'stays@example.test', permission: 'edit' },
      { id: 's-mallory', recipient_email: 'mallory@evil.test', permission: 'edit' },
    ];
    await notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    expect(notebooksStore.getNotebookShares(N1).map(p => p.email)).toEqual(['stays@example.test']);
  });

  it('a notebook whose rows cannot be read, and acceptances the inbox has not answered for, stay set aside', async () => {
    await heldThenLocked();
    const base = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) =>
      url === `/api/v1/items/${N1}/shares` ? { success: false, status: 503 } : base(url, opts));
    vi.useFakeTimers();
    const p = notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe(0);
    vi.useRealTimers();
    expect(notebooksStore.getNotebookShares(N1)).toEqual([]);
    expect(notebooksStore.heldAsideCount()).toBe(4);
  });
});

describe('a carried list merged back keeps what IT carried', () => {
  it('a list from an earlier reset, earlier records, and rescued notes\' old keys go on being carried', async () => {
    const OLDER = { ciphertext: 'stranger:older', nonce: 'on' };
    const RECORD = { wrappedKey: 'rk', wrappedKeyNonce: 'rn', ciphertext: 'rc', nonce: 'rcn' };
    const KEY = { wrappedKey: 'gone-wk', wrappedKeyNonce: 'gone-wn' };
    const earlier = `old:${JSON.stringify({
      notebooks: [{ id: nb(1), name: 'Earlier' }],
      beforeReset: [OLDER],
      rebuiltNotebooks: { [nb(1)]: [RECORD] },
      rescuedNotes: { 'cccccccc-0000-4000-8000-00000000000c': [KEY] },
    })}`;
    put({ id: META, item_type: 10, version: 3, encrypted_content: `cur:${JSON.stringify({ notebooks: [], beforeReset: [{ ciphertext: earlier, nonce: 'en' }] })}` });
    syncAll();
    notebooksStore.markPulled();
    notebooksStore.markNotebookItemsComplete();
    await notebooksStore.mergeBackEarlierLists(() => []);
    await vi.waitFor(() => expect(listNow().rescuedNotes).toBeDefined());
    const list = listNow();
    expect(list.notebooks.map((n: { name: string }) => n.name)).toEqual(['Earlier']);
    expect(list.beforeReset).toEqual([OLDER]);
    expect(list.rebuiltNotebooks).toEqual({ [nb(1)]: [RECORD] });
    expect(list.rescuedNotes).toEqual({ 'cccccccc-0000-4000-8000-00000000000c': [KEY] });
  });
});

