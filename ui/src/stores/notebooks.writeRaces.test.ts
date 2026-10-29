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
 * Writes on their way, writes whose answer never came, and syncs in between.
 *
 * WHY THESE EXIST
 *   Changes the server has not confirmed are merged over every row this page
 *   sees, against the state they sit on ([unsent]). Before, a sync during a
 *   write replaced them, a conflict merged the blob that conflicted (dropping a
 *   change asked for meanwhile) against whatever base a sync had just set (so
 *   what that row removed came back), and a write that landed with its answer
 *   lost read as never written (so what another device removed after it came
 *   back at the next merge. Such a write is now asked again at once, so the
 *   server's version check settles it; where nothing says whether it landed,
 *   an update is taken as landed and the merge shares no more than both
 *   readings do. These pin each, with a server whose row other devices write,
 *   and whose writes can land without an answer, never answer, or fail.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
let cryptoReady = true;
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => cryptoReady,
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
const OTHER = '0f0f0f0f-0000-4000-8000-00000000000f';
const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
const N1 = '11111111-1111-4111-8111-111111111111';
const N2 = '22222222-2222-4222-8222-222222222222';
const NOTE = '33333333-3333-4333-8333-333333333333';
const NOTE2 = '66666666-6666-4666-8666-666666666666';
const ACC = '55555555-5555-4555-8555-555555555555';
const ACC2 = '44444444-4444-4444-8444-444444444444';
const W = 'stays@example.test';
const P = 'added-here@example.test';
const Q = 'added-elsewhere@example.test';
const Y = 'removed-elsewhere@example.test';
const V = 'view-only@example.test';
const entry = (email: string, permission: 'edit' | 'view' = 'edit') => ({ email, permission, publicKey: null, userId: null, signingPublicKey: null });
const nbs = [{ id: N1, name: 'A' }, { id: N2, name: 'B' }];
const R1 = { notebooks: nbs, labelColors: { work: '#111' }, notebookShares: { [N1]: [entry(W)], [N2]: [entry(Y), entry(W)] }, acceptedNotebooks: [ACC] };

type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];
/** The server's row; not `exists`: there is none (a new account, or gone). */
let row: { version: number; content: any; exists: boolean } = { version: 5, content: R1, exists: true };
/** How the next PUTs are answered, one entry each, in order: one lands and
 *  answers with a failure (a lost answer), lands and never answers (the page
 *  goes away), or fails and does not land. Past the list, they land. */
let putPlan: Array<'landButFail' | 'landSilently' | 'failNotApplied' | 'accountStop'> = [];
/** The same for the creates (POST). */
let postPlan: Array<'landButFail' | 'failNotApplied'> = [];
/** Hold the next PUT until released. */
let holdNextPut: { release: () => void; promise: Promise<void> } | null = null;
/** Hold the create-409's look for the row (/sync/pull) until released. */
let holdScan: { release: () => void; promise: Promise<void> } | null = null;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(r => { release = r; });
  return { release, promise };
}

function server() {
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
    calls.push(c);
    if (c.method === 'PUT' && url === `/api/v1/items/${META}`) {
      if (holdNextPut) { const h = holdNextPut; holdNextPut = null; await h.promise; }
      if (!row.exists) return { success: false, status: 404, error: 'not found' };
      if (putPlan[0] === 'failNotApplied') { putPlan.shift(); return { success: false, status: 503, error: 'unavailable' }; }
      // Refused in the page as another account's (lib/account): no status.
      if (putPlan[0] === 'accountStop') { putPlan.shift(); return { success: false, error: 'another account', error_code: 'account_mismatch' }; }
      if (c.body.expected_version !== row.version) return { success: false, status: 409, error: 'conflict' };
      row = { ...row, version: row.version + 1, content: JSON.parse(c.body.encrypted_content) };
      if (putPlan[0] === 'landButFail') { putPlan.shift(); return { success: false, status: 502, error: 'bad gateway' }; }
      if (putPlan[0] === 'landSilently') { putPlan.shift(); return new Promise(() => {}); }
      return { success: true, data: { version: row.version } };
    }
    if (c.method === 'POST' && url === '/api/v1/items' && c.body?.item_type === 10) {
      if (postPlan[0] === 'failNotApplied') { postPlan.shift(); return { success: false, status: 503, error: 'unavailable' }; }
      if (row.exists) return { success: false, status: 409, error: 'exists' };
      row = { version: 1, content: JSON.parse(c.body.encrypted_content), exists: true };
      if (postPlan[0] === 'landButFail') { postPlan.shift(); return { success: false, status: 502, error: 'bad gateway' }; }
      return { success: true, data: { id: META, version: 1 } };
    }
    if (c.method === 'GET' && url === `/api/v1/items/${META}`) {
      if (!row.exists) return { success: false, status: 404, error: 'not found' };
      return { success: true, data: rawRow() };
    }
    if (url.startsWith('/api/v1/sync/pull')) {
      if (holdScan) { const h = holdScan; holdScan = null; await h.promise; }
      return { success: true, data: { items: syncRow(), cursor: null, cursor_id: null, has_more: false } };
    }
    return { success: false, status: 404 };
  });
}

/** Another device writes the row. */
function otherDeviceWrites(content: any) { row = { ...row, version: row.version + 1, content }; }
const rawRow = () => ({ id: META, item_type: 10, version: row.version, deleted: false,
  encrypted_content: typeof row.content === 'string' ? row.content : JSON.stringify(row.content),
  content_nonce: 'n', updated_at: `t${row.version}` });
const syncRow = () => (row.exists ? [rawRow()] : []);
const puts = () => calls.filter(c => c.method === 'PUT' && c.url === `/api/v1/items/${META}`);
const writes = () => calls.filter(c => c.method === 'PUT' || c.method === 'POST');
const rightsIn = (list: { email: string; permission: string }[] | undefined) => Object.fromEntries((list ?? []).map(r => [r.email, r.permission]));
const emailsIn = (list: { email: string }[] | undefined) => (list ?? []).map(r => r.email);
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

type Store = typeof import('./notebooks').notebooksStore;
async function load(): Promise<Store> {
  const acct = await import('../lib/account');
  acct.setTabAccount(null);
  const { notebooksStore } = await import('./notebooks');
  acct.setTabAccount(ACCOUNT);
  notebooksStore.beginHoldsRead().loaded([]);
  return notebooksStore;
}
async function start(cache: object, savedBase?: object): Promise<Store> {
  stored.clear();
  stored.set('pingolin_note_metadata', JSON.stringify(cache));
  if (savedBase) stored.set('pingolin_note_metadata_base', JSON.stringify(savedBase));
  return load();
}
async function reload(): Promise<Store> { vi.resetModules(); return load(); }
/** Every write this page asked for, through: none runs into the next test. */
async function settle(...stores: Store[]) {
  for (let i = 0; i < 3; i++) { await Promise.all(stores.map(s => s.whenWritten())); await tick(); }
}

beforeEach(async () => {
  await tick(30);
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  row = { version: 5, content: R1, exists: true };
  putPlan = [];
  postPlan = [];
  holdNextPut = null;
  holdScan = null;
  cryptoReady = true;
  server();
});

describe('a sync while a write is on its way', () => {
  it('keeps the change, and the conflict does not put back what the synced row removed', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    const h = gate();
    holdNextPut = h;
    s.setLabelColor('mine', '#333');                   // PUT at v5, held
    await tick();
    otherDeviceWrites({ ...R1, notebookShares: { ...R1.notebookShares, [N2]: [entry(W)] } }); // Y off N2: v6
    s.loadFromSyncedItems(syncRow());
    expect(s.labelColors()).toEqual({ work: '#111', mine: '#333' });
    expect(emailsIn(s.getNotebookShares(N2))).toEqual([W]);
    h.release();                                       // 409, re-read v6, merged, written again
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N2])).toEqual([W]);
    expect(row.content.labelColors).toEqual({ work: '#111', mine: '#333' });
    expect(puts().length).toBe(2);                     // the conflict's retry only: no second write for the sync
  });

  it('a change asked for while a conflicting write is on its way is not dropped', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    const h = gate();
    holdNextPut = h;
    s.setEditorModeFor(NOTE, 'markdown', 'hybrid');   // PUT at v5, held
    await tick();
    s.setEditorModeFor(NOTE2, 'markdown', 'hybrid');  // asked while it is on its way
    otherDeviceWrites({ ...R1, labelColors: { work: '#111', theirs: '#444' } }); // v6
    h.release();
    await settle(s);
    expect(s.editorModes()).toEqual({ [NOTE]: 'markdown', [NOTE2]: 'markdown' });
    expect(row.content.editorModes).toEqual({ [NOTE]: 'markdown', [NOTE2]: 'markdown' });
    expect(row.content.labelColors).toEqual({ work: '#111', theirs: '#444' });
  });

  it('a change asked for while a write was on its way survives a sync before its own write lands', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    const first = gate();
    holdNextPut = first;
    s.setLabelColor('one', '#111111');                 // PUT at v5, held
    await tick();
    s.setLabelColor('two', '#222222');                 // asked while it is on its way
    const second = gate();
    first.release();                                   // the first lands (v6), without 'two'
    holdNextPut = second;                              // the second, built with 'two', is held
    await vi.waitFor(() => expect(puts().length).toBe(2));
    s.loadFromSyncedItems(syncRow());                  // a sync brings v6 meanwhile
    expect(s.labelColors()).toEqual({ work: '#111', one: '#111111', two: '#222222' });
    second.release();
    await settle(s);
    expect(row.content.labelColors).toEqual({ work: '#111', one: '#111111', two: '#222222' });
  });

});


describe('a write whose answer was lost', () => {
  it('is asked again at once: the conflict that answers shows it landed', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    putPlan = ['landButFail'];
    s.addNotebookShare(N1, entry(P));                  // PUT v5: lands (v6), answer lost; again: 409, re-read v6
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W, P]);
    const before = writes().length;
    s.setLabelColor('later', '#555');                  // the page knows the row's version now: one PUT
    await settle(s);
    expect(writes().length).toBe(before + 1);
    expect(row.content.labelColors).toEqual({ work: '#111', later: '#555' });
  });

  it('is asked again at once: one that did not land lands then', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    putPlan = ['failNotApplied'];
    s.addNotebookShare(N1, entry(P));                  // PUT v5: 503, did not land; again: lands (v6)
    await settle(s);
    expect(row.version).toBe(6);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W, P]);
  });

  it('waits for the holds before it is asked again', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    putPlan = ['failNotApplied'];
    s.setLabelColor('mine', '#333');
    await vi.waitFor(() => expect(writes().length).toBe(1));
    const read = s.beginHoldsRead();                   // a read of the holds begins meanwhile
    await tick(1500);
    expect(writes().length).toBe(1);
    read.loaded([]);
    await settle(s);
    expect(writes().length).toBe(2);
    expect(row.content.labelColors).toEqual({ work: '#111', mine: '#333' });
  });

  it('is not asked again once another account has the page', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    putPlan = ['failNotApplied'];
    s.setLabelColor('mine', '#333');
    await vi.waitFor(() => expect(writes().length).toBe(1));
    (await import('../lib/account')).setTabAccount(OTHER);  // with no reset() between
    s.beginHoldsRead().open();
    await settle(s);
    expect(writes().length).toBe(1);
    expect(row.version).toBe(5);
  });

  it('is not asked again when it was refused as another account\'s', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    putPlan = ['accountStop'];
    s.setLabelColor('mine', '#333');
    await settle(s);
    expect(writes().length).toBe(1);
    expect(row.version).toBe(5);
  });

  it('is not asked again once the page has signed out', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    putPlan = ['failNotApplied'];
    s.setLabelColor('mine', '#333');
    await vi.waitFor(() => expect(writes().length).toBe(1));
    s.reset();                                         // before it would be asked again
    await settle(s);
    expect(writes().length).toBe(1);
    expect(row.version).toBe(5);
  });
});

describe('a write whose answer was lost, and asked again without an answer either', () => {
  // It landed (v6); asked again, the server was not reached (503). Then the
  // phone wrote over it: nothing this page has says whether it landed, and an
  // update is taken as landed.
  async function landedThen(s: Store, change: () => unknown, phone: (content: any) => any) {
    putPlan = ['landButFail', 'failNotApplied'];
    void change();
    await settle(s);
    expect(row.version).toBe(6);
    otherDeviceWrites(phone(row.content));             // v7
  }
  const pOff = (c: any) => ({ ...c, notebookShares: { ...c.notebookShares, [N1]: [entry(W)] } });

  it('the next sync: who the phone took off stays off', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await landedThen(s, () => s.addNotebookShare(N1, entry(P)), pOff);
    s.loadFromSyncedItems(syncRow());
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    s.setLabelColor('later', '#555');
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W]);
    expect(row.content.labelColors).toEqual({ work: '#111', later: '#555' });
  });

  it('the next write, before any sync: the same', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await landedThen(s, () => s.addNotebookShare(N1, entry(P)), pOff);
    s.setLabelColor('later', '#555');                  // PUT v5: 409, re-read v7, merged
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W]);
    expect(row.content.labelColors).toEqual({ work: '#111', later: '#555' });
  });

  it('a person the phone made view-only again stays view-only', async () => {
    const withV = { ...R1, notebookShares: { ...R1.notebookShares, [N1]: [entry(W), entry(V, 'view')] } };
    row = { version: 5, content: withV, exists: true };
    const s = await start(withV, { id: META, version: 5, blob: withV });
    await landedThen(s, () => s.addNotebookShare(N1, entry(V)),
      c => ({ ...c, notebookShares: { ...c.notebookShares, [N1]: [entry(W), entry(V, 'view')] } }));
    s.loadFromSyncedItems(syncRow());
    expect(rightsIn(s.getNotebookShares(N1))).toEqual({ [W]: 'edit', [V]: 'view' });
    s.setLabelColor('later', '#555');
    await settle(s);
    expect(rightsIn(row.content.notebookShares[N1])).toEqual({ [W]: 'edit', [V]: 'view' });
  });

  it('an acceptance the phone took back stays taken back', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await landedThen(s, () => s.setNotebookAccepted(ACC2, true), c => ({ ...c, acceptedNotebooks: [ACC] }));
    s.setLabelColor('later', '#555');                  // PUT v5: 409, re-read v7
    await settle(s);
    expect(s.acceptedNotebooks()).toEqual([ACC]);
    expect(row.content.acceptedNotebooks).toEqual([ACC]);
  });

  it('a label colour the phone took off stays off', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await landedThen(s, () => s.setLabelColor('x', '#999'), c => ({ ...c, labelColors: { work: '#111' } }));
    s.loadFromSyncedItems(syncRow());
    expect(s.labelColors()).toEqual({ work: '#111' });
    s.setLabelColor('later', '#555');
    await settle(s);
    expect(row.content.labelColors).toEqual({ work: '#111', later: '#555' });
  });

  it("a note's own mode the phone took off stays off, at the next write", async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await landedThen(s, () => s.setEditorModeFor(NOTE, 'markdown', 'hybrid'), c => ({ ...c, editorModes: {} }));
    s.setLabelColor('later', '#555');                  // PUT v5: 409, re-read v7
    await settle(s);
    expect(s.editorModes()).toEqual({});
    expect(row.content.editorModes).toEqual({});
  });

  it('undone before anything else: what it added stays off', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    putPlan = ['landButFail', 'failNotApplied'];
    void s.setNotebookAccepted(ACC2, true);            // PUT v5: lands (v6), answer lost, twice
    await settle(s);
    expect(row.content.acceptedNotebooks).toEqual([ACC, ACC2]);
    void s.setNotebookAccepted(ACC2, false);           // PUT v5: 409; v6 is that write: it landed
    await settle(s);
    expect(s.acceptedNotebooks()).toEqual([ACC]);
    expect(row.content.acceptedNotebooks).toEqual([ACC]);
  });

  it('first run, merged over the first row: the same', async () => {
    const s = await start(R1);
    s.addNotebookShare(N1, entry(P));                  // before the first pull
    await tick();
    putPlan = ['landButFail', 'failNotApplied'];
    s.loadFromSyncedItems(syncRow());                  // merged; the write lands (v6), answer lost, twice
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W, P]);
    otherDeviceWrites(pOff(row.content));
    s.loadFromSyncedItems(syncRow());
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W]);
  });

  it('a sync page read before it landed settles nothing', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    const before = rawRow();                           // v5, read by a sync now
    await landedThen(s, () => s.addNotebookShare(N1, entry(P)), pOff);
    s.loadFromSyncedItems([before]);                   // the page from before arrives
    await settle(s);                                   // its write: PUT v5, 409, re-read v7
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W]);
  });

  it('a reload while it was on its way: the same', async () => {
    let s = await start(R1);
    s.addNotebookShare(N1, entry(P));
    await tick();
    putPlan = ['landSilently'];
    s.loadFromSyncedItems(syncRow());
    await vi.waitFor(() => expect(puts().length).toBe(1));
    s = await reload();
    otherDeviceWrites(pOff(row.content));
    s.loadFromSyncedItems(syncRow());
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W]);
  });
});

describe('a write that did not land', () => {
  it('when another device wrote: the change is kept', async () => {
    const s = await start(R1);
    s.setEditorModeFor(NOTE, 'markdown', 'hybrid');
    await tick();
    otherDeviceWrites({ ...R1, notebookShares: { ...R1.notebookShares, [N1]: [entry(W), entry(Q)] } }); // Q: another device
    putPlan = ['failNotApplied'];
    s.markPulled();                                    // a first pull without the row: POST, 409, merged, PUT 503
    await settle(s);
    expect(puts().length).toBe(1);
    otherDeviceWrites({ ...row.content, notebookShares: { ...row.content.notebookShares, [N1]: [entry(W)] } }); // Q off
    s.loadFromSyncedItems(syncRow());
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    expect(s.editorModes()).toEqual({ [NOTE]: 'markdown' });
    await settle(s);
    expect(row.content.editorModes).toEqual({ [NOTE]: 'markdown' });
  });

  // Asked again without an answer either, then writes from elsewhere.
  async function failedThen(s: Store, change: () => unknown, elsewhere: number) {
    putPlan = ['failNotApplied', 'failNotApplied'];
    void change();                                     // PUT v5: 503, twice; it did not land
    await settle(s);
    expect(row.version).toBe(5);
    otherDeviceWrites({ ...row.content, editorModes: { [NOTE]: 'markdown' } });                          // v6
    if (elsewhere > 1) otherDeviceWrites({ ...row.content, editorModes: { [NOTE]: 'markdown', [NOTE2]: 'markdown' } }); // v7
    s.setLabelColor('later', '#555');                  // PUT v5: 409, re-read, merged
    await settle(s);
    expect(row.content.labelColors).toEqual({ work: '#111', later: '#555' });
  }

  it('one write since: that version is not this write, and a person added is kept', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await failedThen(s, () => s.addNotebookShare(N1, entry(P)), 1);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W, P]);
  });

  it('two since, an un-accept stays un-accepted', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await failedThen(s, () => s.setNotebookAccepted(ACC, false), 2);
    expect(s.acceptedNotebooks()).toEqual([]);
    expect(row.content.acceptedNotebooks).toEqual([]);
    expect(row.content.editorModes).toEqual({ [NOTE]: 'markdown', [NOTE2]: 'markdown' });
  });

  it("two since, a notebook's cleared list stays cleared", async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await failedThen(s, () => s.clearNotebookShares(N2), 2);
    expect(emailsIn(s.getNotebookShares(N2))).toEqual([]);
    expect(emailsIn(row.content.notebookShares[N2])).toEqual([]);
  });

  it('two since, a person added is not written: of the two readings, the one that shares less', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    await failedThen(s, () => s.addNotebookShare(N1, entry(P)), 2);
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W]);
  });
});

describe('a write sent at an older version than one still unsettled', () => {
  it('does not take its place: the row it was sent past settles nothing', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    const v3 = { ...rawRow(), version: 3, updated_at: 't3' };   // a sync page two versions old
    putPlan = ['failNotApplied', 'failNotApplied'];
    s.addNotebookShare(N1, entry(P));                  // PUT v5: 503, twice
    await settle(s);
    putPlan = ['failNotApplied', 'failNotApplied'];
    s.loadFromSyncedItems([v3]);                       // the old page: its write goes at v3, 503 twice
    await settle(s);
    s.loadFromSyncedItems(syncRow());                  // v5: nothing has landed since
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W, P]);
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W, P]);
  });
});

describe('merged over one row, then another', () => {
  it('what the first added and the second took off stays off', async () => {
    const s = await start(R1);
    s.setEditorModeFor(NOTE, 'markdown', 'hybrid');
    await tick();
    otherDeviceWrites({ ...R1, notebookShares: { ...R1.notebookShares, [N1]: [entry(W), entry(Q)] } });
    s.loadFromSyncedItems(syncRow());                  // merged; the sync fails after: no markPulled
    otherDeviceWrites({ ...row.content, notebookShares: { ...row.content.notebookShares, [N1]: [entry(W)] } });
    s.loadFromSyncedItems(syncRow());                  // the next run brings the newer row
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    expect(s.editorModes()).toEqual({ [NOTE]: 'markdown' });
    await settle(s);
  });
});

describe('two tabs of one account', () => {
  it("one tab's unconfirmed change does not reach the other through storage", async () => {
    stored.clear();
    stored.set('pingolin_note_metadata', JSON.stringify(R1));
    const tabA = await load();
    vi.resetModules();
    const tabB = await load();
    tabA.setEditorModeFor(NOTE, 'markdown', 'hybrid');
    await tick();
    tabB.loadFromSyncedItems(syncRow());
    tabB.markPulled();
    otherDeviceWrites({ ...row.content, notebookShares: { ...row.content.notebookShares, [N1]: [entry(W), entry(Q)] } });
    tabB.loadFromSyncedItems(syncRow());
    const tabB2 = await reload();
    otherDeviceWrites({ ...row.content, notebookShares: { ...row.content.notebookShares, [N1]: [entry(W)] } });
    tabB2.loadFromSyncedItems(syncRow());
    expect(emailsIn(tabB2.getNotebookShares(N1))).toEqual([W]);
    await settle(tabA, tabB, tabB2);
  });
});

describe('the sign-out window', () => {
  it('a write asked for between the sweep and reset() does not empty the list at the next sign-in', async () => {
    const rich = { ...R1, editorModes: { [NOTE]: 'markdown' }, acceptedNotebooks: ['a1'] };
    row = { version: 5, content: rich, exists: true };
    const s = await start(rich);
    cryptoReady = false;                               // clearKeys: the keys go, every account store is swept
    stored.clear();
    s.setLabelColor('late', '#222');                   // asked for before reset()
    await tick();
    s.reset();
    cryptoReady = true;
    const again = await reload();                      // the same account signs in again
    again.loadFromSyncedItems(syncRow());
    expect(again.notebooks().map(n => n.id)).toEqual([N1, N2]);
    await settle(s, again);
    expect(row.content.notebooks.map((n: { id: string }) => n.id)).toEqual([N1, N2]);
    expect(row.content.labelColors).toEqual({ work: '#111' });
  });
});

describe('a write over a list no key here opens (not tracked)', () => {
  /** A list from before a password reset, which this page writes over. */
  async function overALockedList(): Promise<Store> {
    const s = await start(R1);                         // no base
    row = { version: 5, content: 'LOCKED:sealed', exists: true };
    s.loadFromSyncedItems(syncRow());
    s.markPulled();
    return s;
  }

  it('whose answer never came: who another device took off later stays off', async () => {
    const s = await overALockedList();
    putPlan = ['failNotApplied', 'failNotApplied'];
    s.setLabelColor('first', '#101');                  // 503, twice: it did not land
    await settle(s);
    otherDeviceWrites({ ...R1 });                      // a list that opens here: v6
    s.loadFromSyncedItems(syncRow());
    otherDeviceWrites({ ...row.content, notebookShares: { ...row.content.notebookShares, [N1]: [entry(W), entry(Q)] } }); // v7
    s.loadFromSyncedItems(syncRow());
    otherDeviceWrites({ ...row.content, notebookShares: { ...row.content.notebookShares, [N1]: [entry(W)] } });           // v8: Q off
    s.setLabelColor('later', '#555');                  // PUT v7: 409, re-read v8, merged
    await settle(s);
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W]);
  });

  it('whose answer never came: a label another device added, then took off, stays off', async () => {
    const s = await overALockedList();
    putPlan = ['failNotApplied', 'failNotApplied'];
    s.setLabelColor('first', '#101');                  // 503, twice: it did not land
    await settle(s);
    otherDeviceWrites({ ...R1 });                      // a list that opens here: v6
    s.loadFromSyncedItems(syncRow());
    otherDeviceWrites({ ...row.content, labelColors: { work: '#111', theirs: '#444' } });  // v7
    s.loadFromSyncedItems(syncRow());
    otherDeviceWrites({ ...row.content, labelColors: { work: '#111' } });                  // v8: theirs off
    s.setLabelColor('later', '#555');                  // PUT v7: 409, re-read v8, merged
    await settle(s);
    expect(row.content.labelColors).toEqual({ work: '#111', later: '#555' });
  });

  it("on its way when a list that opens is adopted: that list's people and acceptances stay", async () => {
    const s = await overALockedList();
    const h = gate();
    holdNextPut = h;
    s.setLabelColor('mine', '#777');                   // held
    await tick();
    otherDeviceWrites({ ...R1 });                      // a list that opens here: v6
    s.loadFromSyncedItems(syncRow());
    h.release();                                       // 409, re-read v6, merged
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W]);
    expect(emailsIn(row.content.notebookShares[N2])).toEqual([Y, W]);
    expect(row.content.acceptedNotebooks).toEqual([ACC]);
  });
});

describe('a write on its way when a sync merges, which then fails', () => {
  it('sends the merged change at the end of the next sync', async () => {
    const s = await start(R1);                         // no base
    s.setEditorModeFor(NOTE, 'markdown', 'hybrid');    // waits for the first pull
    await tick();
    const scan = gate();
    holdScan = scan;
    s.markPulled();                                    // a pull without the row: POST, 409, the look for the row is held
    await vi.waitFor(() => expect(calls.some(c => c.url.startsWith('/api/v1/sync/pull'))).toBe(true));
    s.loadFromSyncedItems(syncRow());                  // the next sync brings it meanwhile
    expect(s.editorModes()).toEqual({ [NOTE]: 'markdown' });
    putPlan = ['failNotApplied'];                      // the write after the merge: 503
    scan.release();
    await settle(s);
    expect(row.content.editorModes).toBeUndefined();
    s.markPulled();                                    // the end of the next sync
    await settle(s);
    expect(row.content.editorModes).toEqual({ [NOTE]: 'markdown' });
  });
});

describe('a new account: the row made here, its answer lost', () => {
  const fresh = { notebooks: nbs, labelColors: {} };

  it('is asked again at once: the row it then finds is that write', async () => {
    row = { version: 0, content: null, exists: false };
    const s = await start(fresh);
    s.addNotebookShare(N1, entry(P));                  // waits for the first pull
    await tick();
    postPlan = ['landButFail'];
    s.markPulled();                                    // no row: made (v1), answer lost; again: 409, found: it is v1
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([P]);
    const before = writes().length;
    s.setLabelColor('later', '#555');                  // the page knows the row now: one PUT
    await settle(s);
    expect(writes().length).toBe(before + 1);
    expect(row.content.labelColors).toEqual({ later: '#555' });
  });

  it('asked again without an answer: who another device took off since stays off', async () => {
    row = { version: 0, content: null, exists: false };
    const s = await start(fresh);
    s.addNotebookShare(N1, entry(P));
    await tick();
    postPlan = ['landButFail', 'failNotApplied'];
    s.markPulled();                                    // made (v1), answer lost; again: 503
    await settle(s);
    expect(row.version).toBe(1);
    otherDeviceWrites({ ...row.content, notebookShares: { [N1]: [] } });  // v2: the phone takes P off
    s.loadFromSyncedItems(syncRow());
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([]);
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([]);
  });

  it('asked again without an answer: a person the phone made view-only stays view-only', async () => {
    row = { version: 0, content: null, exists: false };
    const s = await start({ ...fresh, notebookShares: { [N1]: [entry(V, 'view')] } });
    s.addNotebookShare(N1, entry(V));                  // made an editor, before the first pull
    await tick();
    postPlan = ['landButFail', 'failNotApplied'];
    s.markPulled();
    await settle(s);
    expect(rightsIn(row.content.notebookShares[N1])).toEqual({ [V]: 'edit' });
    otherDeviceWrites({ ...row.content, notebookShares: { [N1]: [entry(V, 'view')] } });  // v2: view-only again
    s.loadFromSyncedItems(syncRow());
    expect(rightsIn(s.getNotebookShares(N1))).toEqual({ [V]: 'view' });
    await settle(s);
    expect(rightsIn(row.content.notebookShares[N1])).toEqual({ [V]: 'view' });
  });
});

describe('the row gone from the server', () => {
  it('a person added again, after another device made the row again, is written', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    row = { version: 0, content: null, exists: false };
    postPlan = ['failNotApplied', 'failNotApplied'];
    s.addNotebookShare(N1, entry(P));                  // PUT: 404; made again: 503, twice
    await settle(s);
    row = { version: 1, content: R1, exists: true };   // another device made it again, without P
    otherDeviceWrites({ ...R1, labelColors: { work: '#111', theirs: '#444' } });  // v2
    s.loadFromSyncedItems(syncRow());                  // nothing tracked: as it comes
    expect(emailsIn(s.getNotebookShares(N1))).toEqual([W]);
    const h = gate();
    holdNextPut = h;
    s.addNotebookShare(N1, entry(P));                  // added again: PUT v2, held
    await tick();
    otherDeviceWrites({ ...row.content, labelColors: { work: '#111', theirs: '#444', more: '#666' } });  // v3
    h.release();                                       // 409, re-read v3, merged
    await settle(s);
    expect(emailsIn(row.content.notebookShares[N1])).toEqual([W, P]);
  });

  it('the row made again carries every change made so far', async () => {
    const s = await start(R1, { id: META, version: 5, blob: R1 });
    row = { version: 0, content: null, exists: false };
    const h = gate();
    holdNextPut = h;
    s.setLabelColor('one', '#111111');                 // PUT, held: 404
    await tick();
    s.setLabelColor('two', '#222222');                 // asked while it is on its way
    h.release();
    await settle(s);
    const created = calls.filter(c => c.method === 'POST' && c.url === '/api/v1/items');
    expect(JSON.parse(created[0].body.encrypted_content).labelColors).toEqual({ work: '#111', one: '#111111', two: '#222222' });
    expect(row.content.labelColors).toEqual({ work: '#111', one: '#111111', two: '#222222' });
  });
});
