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
 * A move whose removal did not go through, and what comes after it, on the
 * harness of notes.moveSettled.test.ts:
 *
 *   - a second move while the first is still owed: moved back, or on to a
 *     notebook of nobody's, the people of the notebook in between do not
 *     keep the note (nor are they given the new key);
 *   - an edit in another tab does not take the owed job's place in the
 *     queue, and its save does not end the job;
 *   - the notebook the move left is deleted, and with it the list the job
 *     reads its people from: who the move owes is kept with the move.
 */

const { deletedNotebooks } = vi.hoisted(() => ({ deletedNotebooks: new Set<string>() }));
const { ME, queue } = vi.hoisted(() => ({
  ME: '0e0e0e0e-0000-4000-8000-00000000000e',
  queue: new Map<string, Record<string, unknown>>(),
}));

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap', nonce: 'wrapn' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  opensBoundToItem: () => true,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));
const { sharedWith, rotated, rotateTries, shareLog, removals, rotations } = vi.hoisted(() => ({
  sharedWith: new Map<string, Set<string>>(),
  /** Re-keys that were APPLIED. */
  rotated: [] as string[],
  /** Every re-key asked for, applied or not. */
  rotateTries: [] as string[],
  shareLog: [] as string[],
  removals: { failNext: 0, hang: false, gate: null as null | Promise<boolean> },
  rotations: { failNext: 0 },
}));
const shareNoteWithRecipientResult = vi.fn(async (...a: unknown[]) => {
  const [noteId, , r] = a as [string, unknown, { email: string }];
  if (!sharedWith.has(noteId)) sharedWith.set(noteId, new Set());
  sharedWith.get(noteId)!.add(r.email);
  shareLog.push(`+${r.email} ${noteId.slice(0, 8)}`);
  return { ok: true };
});
const unshareNoteWithRecipient = vi.fn(async (...a: unknown[]) => {
  const [noteId, email] = a as [string, string];
  if (removals.hang) return new Promise<boolean>(() => {});
  // Held until the test answers it: true, it went; false, no answer.
  if (removals.gate) { const ok = await removals.gate; removals.gate = null; if (!ok) return false; }
  if (removals.failNext > 0) { removals.failNext -= 1; return false; }
  sharedWith.get(noteId)?.delete(email);
  shareLog.push(`-${email} ${noteId.slice(0, 8)}`);
  return true;
});
const rotateContentKey = vi.fn(async (...a: unknown[]) => {
  rotateTries.push(a[0] as string);
  if (rotations.failNext > 0) { rotations.failNext -= 1; return { rotated: false }; }
  rotated.push(a[0] as string);
  return { rotated: true };
});
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: (...a: unknown[]) => shareNoteWithRecipientResult(...a),
  unshareNoteWithRecipient: (...a: unknown[]) => unshareNoteWithRecipient(...a),
  rotateContentKey: (...a: unknown[]) => rotateContentKey(...a),
}));
vi.mock('../lib/recipientKeys', async () => {
  const real = await vi.importActual<typeof import('../lib/recipientKeys')>('../lib/recipientKeys');
  return { ...real, lookupDirectoryKeys: async () => new Map() };
});
/** `nb`: Ben. `nb2`: Ben and Zoe. `solo`: nobody. `theirs`: someone else's notebook this account is a MEMBER of (roster: Kim). */
const BEN = { email: 'ben@example.test', permission: 'edit' as const, publicKey: 'aa'.repeat(32), userId: 'ben-id', signingPublicKey: 'bb'.repeat(32) };
const ZOE = { email: 'zoe@example.test', permission: 'edit' as const, publicKey: 'cc'.repeat(32), userId: 'zoe-id', signingPublicKey: 'dd'.repeat(32) };
const KIM = { email: 'kim@example.test', permission: 'contribute', sharingPublicKey: 'ee'.repeat(32), userId: 'kim-id', signingPublicKey: 'ff'.repeat(32) };
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => true,
    notebookItemState: async (id: string | null | undefined) => (id ? 'item' : 'none'),
    learnNotebookItem: async (id: string | null | undefined) => !!id,
    getNotebookShares: (id: string) => (deletedNotebooks.has(id) ? [] : id === 'nb' ? [BEN] : id === 'nb2' ? [BEN, ZOE] : id === 'gone' ? [ZOE] : []),
    notebooks: () => [{ id: 'nb', name: 'Wedding', noteCount: 0 }, { id: 'nb2', name: 'Trip', noteCount: 0 }, { id: 'solo', name: 'Mine', noteCount: 0 }],
    membersOf: (id: string) => (id === 'theirs' ? [KIM] : []),
    notebookOpenedVia: () => 'vault',
    acceptedNotebooks: () => [],
    loadFromSyncedItems: () => {}, gcEditorModes: () => {},
    markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
    pruneAcceptances: async () => {}, rememberAcceptances: () => {},
  },
}));
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: () => undefined,
    load: async () => true,
    sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {}, applyLocalEdit: () => {},
    sharedNotes: () => [], offeredNotebooks: () => null,
  },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }), keysUnavailable: () => null },
  getCachedOwner: () => ME,
}));
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const { cache } = vi.hoisted(() => ({ cache: new Map<string, Record<string, unknown>>() }));
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => [...cache.values()].map(copy),
  loadCursor: async () => null,
  loadCursorId: async () => null,
  getNote: vi.fn(async (id: string) => (cache.has(id) ? copy(cache.get(id)) : null)),
  putNote: vi.fn(async (n: { id: string }) => { cache.set(n.id, copy(n)); }),
  putNotes: vi.fn(async (ns: { id: string }[]) => { for (const n of ns) cache.set(n.id, copy(n)); }),
  removeNote: vi.fn(async (id: string) => { cache.delete(id); }),
  queuePending: vi.fn(async (e: { id: string }) => { queue.set(e.id, copy(e)); }),
  removePending: vi.fn(async (id: string) => { queue.delete(id); }),
  getPending: vi.fn(async (id: string) => (queue.has(id) ? copy(queue.get(id)) : null)),
  listPending: vi.fn(async () => [...queue.values()].map(copy)),
  countPending: vi.fn(async () => queue.size),
  saveCursor: async () => {},
  saveCursorId: async () => {},
}));

type Body = { id?: string; encrypted_content?: string; expected_version?: number; notebook_id?: string | null };
type Row = {
  id: string; user_id: string; item_type: number; version: number; deleted: boolean;
  encrypted_content: string; content_nonce: string;
  wrapped_content_key: string; wrapped_content_key_nonce: string; notebook_id: string | null;
  created_at: string; updated_at: string;
};
const server = {
  down: false,
  refuseCreates: null as null | { success: false; status: number; error_code?: string },
  loseCreateAnswer: false,
  holdCreates: null as null | Promise<void>,
  /** Held until the test lets it go: the POST of a "(conflict copy)" only. */
  holdCopies: null as null | Promise<void>,
  updatesDown: false,
  /** Unreachable for deletes only. */
  deletesDown: false,
  /** Notebooks the server will not place a note in on a PUT (it keeps the column, and answers 200). */
  noPlacing: new Set<string>(),
  /** A PUT is applied and its answer never comes: the page is closed while it waits. */
  losePutAnswer: false,
  rows: new Map<string, Row>(),
  posts: [] as Body[],
  puts: [] as { id: string; body: Body }[],
  pulls: 0,
  clock: 0,
};
const UNREACHABLE = { success: false, error: 'Failed to fetch' };
const content = (b: Body) => JSON.parse(b.encrypted_content ?? '{}') as Record<string, unknown>;
const tick = () => `2026-10-07T09:${String(10 + (++server.clock)).padStart(2, '0')}:00Z`;

let notesStore: typeof import('./notes').notesStore;
async function load() {
  vi.resetModules();
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
}
const lines: string[] = [];
/** What each step saw, for reading a failure (not printed). */
const obs = (label: string, v: unknown) => { lines.push(`${label} ${JSON.stringify(v)}`); };

beforeEach(async () => {
  vi.clearAllMocks();
  queue.clear(); cache.clear();
  sharedWith.clear(); rotated.length = 0; rotateTries.length = 0; shareLog.length = 0;
  removals.failNext = 0; removals.hang = false; removals.gate = null; rotations.failNext = 0;
  Object.assign(server, { down: false, refuseCreates: null, loseCreateAnswer: false, holdCreates: null, holdCopies: null, updatesDown: false, deletesDown: false, losePutAnswer: false, pulls: 0, clock: 0 });
  server.noPlacing.clear(); server.rows.clear(); server.posts.length = 0; server.puts.length = 0;
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: Body }) => {
    const method = opts?.method ?? 'GET';
    const body = opts?.body ?? {};
    if (url.startsWith('/api/v1/sync/pull')) {
      server.pulls++;
      if (server.down) return UNREACHABLE;
      return { success: true, data: { items: [...server.rows.values()].map(copy), cursor: '2026-10-07T10:00:00Z', cursor_id: null, has_more: false } };
    }
    if (url === '/api/v1/items' && method === 'POST') {
      server.posts.push(copy(body));
      if (server.holdCreates) await server.holdCreates;
      if (server.holdCopies && String(content(body).title).includes('(conflict copy)')) await server.holdCopies;
      if (server.down) return UNREACHABLE;
      if (server.refuseCreates) return server.refuseCreates;
      const id = body.id!;
      if (server.rows.has(id)) return { success: false, status: 409, error_code: 'item_already_exists' };
      const at = tick();
      server.rows.set(id, {
        id, user_id: ME, item_type: 1, version: 1, deleted: false,
        encrypted_content: body.encrypted_content!, content_nonce: 'n',
        wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn', notebook_id: body.notebook_id ?? null,
        created_at: at, updated_at: at,
      });
      if (server.loseCreateAnswer) return UNREACHABLE;
      return { success: true, data: { id, version: 1, created_at: at, updated_at: at, notebook_id: body.notebook_id ?? null } };
    }
    const item = /^\/api\/v1\/items\/([^/]+)$/.exec(url);
    if (item && method === 'GET') {
      if (server.down) return UNREACHABLE;
      const row = server.rows.get(item[1]);
      return row ? { success: true, data: copy(row) } : { success: false, status: 404 };
    }
    if (item && method === 'PUT') {
      server.puts.push({ id: item[1], body: copy(body) });
      if (server.down || server.updatesDown) return UNREACHABLE;
      const row = server.rows.get(item[1]);
      if (!row) return { success: false, status: 403, error_code: 'share_permission_denied' };
      if (body.expected_version !== row.version) return { success: false, status: 409, error_code: 'version_conflict' };
      row.version += 1;
      row.encrypted_content = body.encrypted_content!;
      if (body.notebook_id !== undefined && !(body.notebook_id && server.noPlacing.has(body.notebook_id))) row.notebook_id = body.notebook_id;
      row.updated_at = tick();
      if (server.losePutAnswer) return new Promise(() => {});
      return { success: true, data: { ...copy(row) } };
    }
    if (item && method === 'DELETE') {
      if (server.down || server.deletesDown) return UNREACHABLE;
      const row = server.rows.get(item[1]);
      if (!row) return { success: false, status: 404 };
      row.deleted = true;
      row.updated_at = tick();
      return { success: true, data: null };
    }
    return { success: false, status: 404 };
  });
  await load();
});

const card = (id: string) => notesStore.notes().find(n => n.id === id);
const entry = (id: string) => queue.get(id) as { op: string; note: Record<string, unknown>; edits?: Record<string, unknown> } | undefined;
const readers = (id: string) => [...(sharedWith.get(id) ?? [])].sort();
const conflictCopies = () => server.posts.filter(p => String(content(p).title).includes('(conflict copy)'));
const state = (id: string) => ({
  card: card(id)?.notebookId ?? null, movedFrom: card(id)?.movedFrom, cachedMovedFrom: cache.get(id)?.movedFrom,
  row: server.rows.get(id)?.notebook_id ?? null, readers: readers(id), rekeyed: rotated.filter(r => r === id).length,
  queued: entry(id)?.op ?? null,
});
async function onTheServerIn(notebookId: string | null): Promise<string> {
  const r = await notesStore.createNote({ title: 'Seating plan', body: 'first words', notebookId });
  expect(r.note).not.toBeNull();
  shareLog.length = 0;
  return r.note!.id;
}
async function writtenOffline(over: Record<string, unknown> = {}): Promise<string> {
  server.down = true;
  const r = await notesStore.createNote({ title: 'Written offline', body: 'first words', ...over });
  expect(r.queued).toBe(true);
  const id = [...queue.keys()][0];
  return id;
}
function holdCreates(): () => void {
  let letGo!: () => void;
  server.holdCreates = new Promise<void>(resolve => { letGo = resolve; });
  return () => { server.holdCreates = null; letGo(); };
}

describe('an owed move and an edit made in another tab', () => {
  it('another tab, which pulled after the move, edits the words online: Ben is still taken off, and the note re-keyed', async () => {
    const id = await onTheServerIn('nb');
    const tab1 = notesStore;
    vi.resetModules();
    const tab2 = (await import('./notes')).notesStore;
    await tab2.hydrateFromCache();
    removals.failNext = 1;
    expect(await tab1.updateNote(id, { notebookId: null })).toBe(true);
    obs('owed in tab 1', { ...state(id), sharingOnly: queue.get(id)?.sharingOnly });
    expect(queue.get(id)?.sharingOnly).toBe(true);
    // Tab 2 pulls (it sees the note out of nb) and the person types there.
    await tab2.sync();
    expect(await tab2.updateNote(id, { title: 'Typed in the other tab' })).toBe(true);
    // Both pages are opened again later.
    await load();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('another tab, loaded before the move and not pulled since, edits the words: Ben is still taken off', async () => {
    const id = await onTheServerIn('nb');
    const tab1 = notesStore;
    vi.resetModules();
    const tab2 = (await import('./notes')).notesStore;
    await tab2.hydrateFromCache();
    removals.failNext = 1;
    expect(await tab1.updateNote(id, { notebookId: null })).toBe(true);
    expect(queue.get(id)?.sharingOnly).toBe(true);
    await tab2.updateNote(id, { title: 'Typed in the other tab' });
    await load();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });
});

describe('a second move while the first one is still owed', () => {
  it('moved from nb (Ben) to gone (Zoe), Ben\'s removal gets no answer, then moved BACK to nb: Zoe does not keep it', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: 'gone' })).toBe(true);
    expect(await notesStore.updateNote(id, { notebookId: 'nb' })).toBe(true);
    await notesStore.flushPending();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual(['ben@example.test']);
  });

  it('moved from nb (Ben) to gone (Zoe), Ben\'s removal gets no answer, then moved on to solo (nobody): Zoe does not keep it', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: 'gone' })).toBe(true);
    expect(await notesStore.updateNote(id, { notebookId: 'solo' })).toBe(true);
    await notesStore.flushPending();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
  });
});

describe('the notebook a move left is deleted while the move is owed', () => {
  it('nb (Ben) -> solo, Ben\'s removal gets no answer; then nb is deleted (Sidebar: unshareNotebookChildren, remove): Ben does not keep the note', async () => {
    deletedNotebooks.clear();
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: 'solo' })).toBe(true);
    expect(card(id)?.movedFrom).toBe('nb');
    // The owner deletes the notebook "Wedding" (Sidebar.handleDelete).
    await notesStore.unshareNotebookChildren('nb');
    deletedNotebooks.add('nb');
    // Later (a reload), the queue drains.
    await load();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    deletedNotebooks.clear();
  });
});


describe('who the move owes is kept wherever the move is', () => {
  it('a move owed from before they were kept (queued by an earlier build): its next failed try keeps them in the queue, and after nb is deleted and a reload Ben is still taken off', async () => {
    deletedNotebooks.clear();
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: 'solo' })).toBe(true);
    // As an earlier build left it: the owed job and the card, with no list of people.
    const old = queue.get(id) as { note: Record<string, unknown> };
    delete old.note.movedFromPeople;
    queue.set(id, old);
    const cachedCard = cache.get(id)!;
    delete cachedCard.movedFromPeople;
    await load();
    // The next try fails too: who had it through nb is kept, in the queue entry as well as on the card
    // (the job takes the server's row for the note, and the card's record with it).
    removals.failNext = 1;
    await notesStore.flushPending();
    expect((queue.get(id) as { note: { movedFromPeople?: string[] } }).note.movedFromPeople).toEqual(['ben@example.test']);
    deletedNotebooks.add('nb');
    await load();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
    deletedNotebooks.clear();
  });

  it('the other tab\'s edit, made offline, carries who is owed: nb deleted, a reload, and Ben is still taken off', async () => {
    deletedNotebooks.clear();
    const id = await onTheServerIn('nb');
    const tab1 = notesStore;
    vi.resetModules();
    const tab2 = (await import('./notes')).notesStore;
    await tab2.hydrateFromCache();
    removals.failNext = 1;
    expect(await tab1.updateNote(id, { notebookId: null })).toBe(true);
    expect(queue.get(id)?.sharingOnly).toBe(true);
    // The other tab, offline, types: its edit takes the owed job's place in the queue.
    server.down = true;
    await tab2.updateNote(id, { title: 'Typed offline in the other tab' });
    expect((queue.get(id) as { note: { movedFrom?: string | null; movedFromPeople?: string[] } }).note)
      .toMatchObject({ movedFrom: 'nb', movedFromPeople: ['ben@example.test'] });
    deletedNotebooks.add('nb');
    server.down = false;
    await load();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
    deletedNotebooks.clear();
  });
  /** As the test above, to the other tab's offline edit; then `strip` takes the list off one of its two copies. */
  async function owedThenEditedOffline(strip: 'card' | 'queue'): Promise<string> {
    deletedNotebooks.clear();
    const id = await onTheServerIn('nb');
    const tab1 = notesStore;
    vi.resetModules();
    const tab2 = (await import('./notes')).notesStore;
    await tab2.hydrateFromCache();
    removals.failNext = 1;
    expect(await tab1.updateNote(id, { notebookId: null })).toBe(true);
    server.down = true;
    await tab2.updateNote(id, { title: 'Typed offline in the other tab' });
    if (strip === 'card') delete cache.get(id)!.movedFromPeople;
    else delete (queue.get(id) as { note: Record<string, unknown> }).note.movedFromPeople;
    deletedNotebooks.add('nb');
    server.down = false;
    await load();
    return id;
  }

  it('the card\'s copy of the list lost (an earlier build): the queued card\'s is read with it, and Ben is taken off', async () => {
    const id = await owedThenEditedOffline('card');
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    deletedNotebooks.clear();
  });

  it('the queue\'s copy lost: a pull keeps the card\'s with the move, and Ben is taken off', async () => {
    const id = await owedThenEditedOffline('queue');
    await notesStore.sync();
    expect(card(id)?.movedFromPeople).toEqual(['ben@example.test']);
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    deletedNotebooks.clear();
  });
  it('the two copies differ (taken at different tries): both are read, and everyone on either is taken off', async () => {
    deletedNotebooks.clear();
    const id = await onTheServerIn('nb2');
    expect(readers(id)).toEqual(['ben@example.test', 'zoe@example.test']);
    const tab1 = notesStore;
    vi.resetModules();
    const tab2 = (await import('./notes')).notesStore;
    await tab2.hydrateFromCache();
    removals.failNext = 2;
    expect(await tab1.updateNote(id, { notebookId: null })).toBe(true);
    server.down = true;
    await tab2.updateNote(id, { title: 'Typed offline in the other tab' });
    cache.get(id)!.movedFromPeople = ['ben@example.test'];
    (queue.get(id) as { note: Record<string, unknown> }).note.movedFromPeople = ['zoe@example.test'];
    deletedNotebooks.add('nb2');
    server.down = false;
    await load();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    deletedNotebooks.clear();
  });
});

describe('the note is put in the trash while its move is owed, then restored', () => {
  it('nb (Ben) -> solo, Ben\'s removal gets no answer; trashed and restored: Ben does not keep the note', async () => {
    const id = await onTheServerIn('nb');
    const base = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      const m = /^\/api\/v1\/items\/([^/]+)\/restore$/.exec(url);
      if (m && opts?.method === 'POST') {
        const row = server.rows.get(m[1]);
        if (!row) return { success: false, status: 404 };
        row.deleted = false; row.version += 1; row.updated_at = tick();
        return { success: true, data: null };
      }
      return base(url, opts);
    });
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: 'solo' })).toBe(true);
    expect(queue.get(id)?.sharingOnly).toBe(true);
    expect(await notesStore.deleteNote(id)).toBe(true);
    expect(await notesStore.restoreNote(id)).toBe(true);
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
  });
});

describe('the note is trashed on another device while its move is owed, then restored there', () => {
  it('nb (Ben) -> solo, Ben\'s removal gets no answer; trashed elsewhere, a drain, restored elsewhere: Ben does not keep the note', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: 'solo' })).toBe(true);
    expect(queue.get(id)?.sharingOnly).toBe(true);
    // The phone puts it in the trash.
    const row = server.rows.get(id)!;
    row.deleted = true; row.version += 1; row.updated_at = tick();
    await notesStore.flushPending();
    // The phone restores it.
    row.deleted = false; row.version += 1; row.updated_at = tick();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
  });
});

describe('a move made offline, and the note trashed before the move went', () => {
  it('the job keeps no words: nothing is sent for the trashed note, and no copy of it is made', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { notebookId: 'solo', title: 'Moved on the train' });
    expect(queue.get(id)?.op).toBe('update');
    expect(queue.get(id)?.sharingOnly).toBeFalsy();
    server.down = false;
    expect(await notesStore.deleteNote(id)).toBe(true);
    expect(queue.get(id)?.sharingOnly).toBe(true);
    const puts = server.puts.length;
    await notesStore.flushPending();
    expect(server.puts.length).toBe(puts);
    expect(conflictCopies()).toEqual([]);
  });
});

describe('the trashed note is purged while its move is owed', () => {
  it('the job ends: nothing is owed for a note that is gone', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: 'solo' })).toBe(true);
    expect(await notesStore.deleteNote(id)).toBe(true);
    expect(queue.get(id)?.sharingOnly).toBe(true);
    await notesStore.flushPending();
    expect(queue.get(id)?.sharingOnly).toBe(true);
    // Purged: the server has it no more.
    server.rows.delete(id);
    await notesStore.flushPending();
    expect(queue.has(id)).toBe(false);
  });
});

describe('the sign-out\'s flush while a drain is already going', () => {
  it('waits for that drain (NotesView: Promise.race([flushPending(), 10 s]) then logout)', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: 'solo' })).toBe(true);
    expect(queue.get(id)?.sharingOnly).toBe(true);
    // A drain starts (focus, online, interval) and its removal is slow.
    let answer!: (ok: boolean) => void;
    removals.gate = new Promise<boolean>(resolve => { answer = resolve; });
    const running = notesStore.flushPending();
    await vi.waitFor(() => expect(unshareNoteWithRecipient).toHaveBeenCalledTimes(2));
    // The person signs out: the sign-out's own flush.
    let signOutFlushEnded = false;
    void notesStore.flushPending().then(() => { signOutFlushEnded = true; });
    await new Promise(r => setTimeout(r, 20));
    answer(true);
    await running;
    expect(signOutFlushEnded).toBe(false);
  });
});

describe('the conflict copy a replay makes', () => {
  it('words typed offline on a card in nb, and another device moved the note to solo meanwhile: the copy is filed where the server has it', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { body: 'typed offline on the train' });
    const row = server.rows.get(id)!;
    row.encrypted_content = JSON.stringify({ ...JSON.parse(row.encrypted_content), notebook_id: 'solo' });
    row.notebook_id = 'solo'; row.version += 1; row.updated_at = tick();
    server.down = false;
    await notesStore.flushPending();
    expect(conflictCopies().map(p => p.notebook_id ?? null)).toEqual(['solo']);
  });

  it('words typed and the note moved to solo offline, and another device\'s words meanwhile: the copy is filed where the move puts it, never with nb\'s people', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { body: 'typed offline on the train' });
    await notesStore.updateNote(id, { notebookId: 'solo' });
    const row = server.rows.get(id)!;
    row.encrypted_content = JSON.stringify({ ...JSON.parse(row.encrypted_content), body: 'written on the phone' });
    row.version += 1; row.updated_at = tick();
    server.down = false;
    await notesStore.flushPending();
    expect(conflictCopies().map(p => p.notebook_id ?? null)).toEqual(['solo']);
  });
});
