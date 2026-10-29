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
 * The sharing a move owes is carried through, whatever comes between: a pull,
 * a closed page, another tab, a version conflict, a refused re-key, a member's
 * own note in another's notebook, a move the server does not place.
 *
 * The harness is notes.moveSettled.test.ts, with a sync pull, a removal that
 * can hang, a re-key that can fail, a roster for a notebook this account is a
 * MEMBER of, and a PUT answer that carries the row's notebook (as the
 * server's does).
 */

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
    getNotebookShares: (id: string) => (id === 'nb' ? [BEN] : id === 'nb2' ? [BEN, ZOE] : id === 'gone' ? [ZOE] : []),
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

describe('a move whose PUT landed and whose sharing is still owed, then a sync pull', () => {
  it('the removal gets no answer; a pull comes before the next drain (closing a note runs one): Ben is still taken off, and the note re-keyed', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(true);
    obs('after the save', state(id));
    await notesStore.sync();
    obs('after the pull', state(id));
    const left = await notesStore.flushPendingAndReport();
    obs('after the drain', { ...state(id), left, unshareCalls: unshareNoteWithRecipient.mock.calls.length });
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('the page closes between the PUT and the removal; it is opened again (NotesView: sync, THEN the queue)', async () => {
    const id = await onTheServerIn('nb');
    removals.hang = true;
    void notesStore.updateNote(id, { notebookId: null });
    await vi.waitFor(() => expect(cache.get(id)?.movedFrom).toBe('nb'));
    obs('the page dies here', state(id));
    removals.hang = false;
    await load();
    obs('reopened, from the cache', state(id));
    await notesStore.sync();
    obs('after the first sync', state(id));
    const left = await notesStore.flushPendingAndReport();
    obs('after the queue', { ...state(id), left });
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('triggerSync order (queue, then sync): the removal fails twice in a row, then a sync, then the queue', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 2;
    await notesStore.updateNote(id, { notebookId: null });
    await notesStore.flushPending();
    await notesStore.sync();
    obs('after flush+sync', state(id));
    await notesStore.flushPending();
    obs('after the next flush', state(id));
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('the same through the fold: landed (answer lost) in nb, moved out, the replay\'s removal fails, a pull, a drain', async () => {
    server.loseCreateAnswer = true;
    await notesStore.createNote({ title: 'Written on the train', body: 'first words', notebookId: 'nb' });
    const id = [...queue.keys()][0];
    server.loseCreateAnswer = false;
    sharedWith.set(id, new Set(['ben@example.test']));
    server.down = true;
    await notesStore.updateNote(id, { notebookId: null });
    server.down = false;
    removals.failNext = 1;
    await notesStore.flushPending();
    obs('after the replay', state(id));
    await notesStore.sync();
    await notesStore.flushPending();
    obs('after pull + drain', state(id));
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('control: the removal gets no answer, and the next drain comes with no pull in between', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    await notesStore.updateNote(id, { notebookId: null });
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('a pull BEFORE the PUT landed (offline move) is harmless: the move is read again from the row', async () => {
    const id = await onTheServerIn('nb');
    server.updatesDown = true;
    await notesStore.updateNote(id, { notebookId: null });
    obs('offline move', state(id));
    await notesStore.sync();
    obs('after a pull', state(id));
    server.updatesDown = false;
    await notesStore.flushPending();
    obs('after the drain', state(id));
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });
});

describe('a re-key that fails after the removal', () => {
  it('is tried again (the move is not settled until the note has a new key)', async () => {
    const id = await onTheServerIn('nb');
    rotations.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(true);
    obs('after the save', { ...state(id), rotateTries: rotateTries.length });
    const left = await notesStore.flushPendingAndReport();
    obs('after a drain', { ...state(id), rotateTries: rotateTries.length, left });
    expect(rotated).toEqual([id]);
  });
});

describe('two direct saves of one note at once', () => {
  it('the move lands second: what the person sees', async () => {
    const id = await onTheServerIn('nb');
    const [b, a] = await Promise.all([
      notesStore.updateNote(id, { body: 'typed first' }),
      notesStore.updateNote(id, { notebookId: null }),
    ]);
    obs('after both saves', { a, b, original: state(id), copies: conflictCopies().map(p => [content(p).title, p.notebook_id ?? null]) });
    // Either the move took (Ben removed) or the card says it did not.
    const tookEffect = (server.rows.get(id)?.notebook_id ?? null) === null;
    expect(tookEffect ? readers(id) : [card(id)?.notebookId]).toEqual(tookEffect ? [] : ['nb']);
  });

  it('a move OUT while an earlier move\'s sharing is still under way (the second save reads movedFrom): one re-key', async () => {
    const id = await onTheServerIn('nb2');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const realUnshare = unshareNoteWithRecipient.getMockImplementation()!;
    unshareNoteWithRecipient.mockImplementationOnce(async (...a: unknown[]) => { await gate; return realUnshare(...a); });
    const first = notesStore.updateNote(id, { notebookId: 'nb' });
    await vi.waitFor(() => expect(server.rows.get(id)?.notebook_id).toBe('nb'));
    const second = notesStore.updateNote(id, { body: 'typed while the first move was sharing' });
    await new Promise(r => setTimeout(r, 20));
    release();
    const [x, y] = await Promise.all([first, second]);
    obs('after both saves', { x, y, ...state(id), rotateTries: rotateTries.length, shareLog, copies: conflictCopies().length });
    expect(readers(id)).toEqual(['ben@example.test']);
  });
});

describe('whose people a move reads', () => {
  it('a MEMBER\'s own note in someone else\'s notebook, moved out: the roster is taken off it and the note re-keyed', async () => {
    const id = await onTheServerIn('theirs');
    obs('created in theirs', { readers: readers(id) });
    expect(readers(id)).toEqual(['kim@example.test']);
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(true);
    obs('moved out', state(id));
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('a move the server does not place (PUT 200, column kept): the target\'s people are not given it', async () => {
    const id = await onTheServerIn(null);
    server.noPlacing.add('gone');
    await notesStore.updateNote(id, { notebookId: 'gone' });
    obs('after the save', state(id));
    expect(server.rows.get(id)?.notebook_id ?? null).toBeNull();
    expect(readers(id)).toEqual([]);
  });
});

describe('a change folded in while a landed create keeps the card as a copy', () => {
  it('the second drain makes a second copy; no words are lost', async () => {
    server.loseCreateAnswer = true;
    await notesStore.createNote({ title: 'Written on the train', body: 'first words' });
    const id = [...queue.keys()][0];
    server.loseCreateAnswer = false;
    // Changed on another device since it landed.
    const row = server.rows.get(id)!;
    row.version = 2;
    row.encrypted_content = JSON.stringify({ ...JSON.parse(row.encrypted_content), body: 'words from the phone' });
    server.down = true;
    await notesStore.updateNote(id, { body: 'words from the web' });
    server.down = false;
    let letGo!: () => void;
    server.holdCopies = new Promise<void>(r => { letGo = r; });
    const drain = notesStore.flushPending();
    await vi.waitFor(() => expect(conflictCopies().length).toBe(1));
    await notesStore.updateNote(id, { title: 'a title typed meanwhile' });
    server.holdCopies = null; letGo();
    await drain;
    obs('after the first drain', { queued: entry(id)?.op, edits: entry(id)?.edits, copies: conflictCopies().map(p => [content(p).title, content(p).body]) });
    await notesStore.flushPending();
    obs('after the second drain', { queued: entry(id)?.op ?? null, copies: conflictCopies().map(p => [content(p).title, content(p).body]), row: JSON.parse(server.rows.get(id)!.encrypted_content).body });
    const kept = conflictCopies().map(p => content(p));
    expect(kept.some(k => k.title === 'a title typed meanwhile (conflict copy)' && k.body === 'words from the web')).toBe(true);
    expect(JSON.parse(server.rows.get(id)!.encrypted_content).body).toBe('words from the phone');
  });

  it('a MOVE folded into a REMADE card\'s create while it is being looked at is dropped (the row is taken as it is)', async () => {
    const W = 'cccccccc-3333-4333-8333-33333333333c';
    server.rows.set(W, {
      id: W, user_id: ME, item_type: 1, version: 3, deleted: false,
      encrypted_content: JSON.stringify({ title: 'Written offline', body: 'the first words', note_type: 'text', labels: [], notebook_id: 'nb' }), content_nonce: 'n',
      wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn', notebook_id: 'nb',
      created_at: '2026-10-06T09:00:00Z', updated_at: '2026-10-06T09:10:00Z',
    });
    sharedWith.set(W, new Set(['ben@example.test']));
    cache.set(W, {
      id: W, title: 'Written offline', body: 'the first words', noteType: 'text', color: null, isPinned: false, isArchived: false,
      labels: [], sortOrder: -1, editMode: 'rich', notebookId: 'nb', hasAttachments: false, version: 0,
      createdAt: '2026-10-06T09:00:00Z', updatedAt: '2026-10-06T09:00:00Z', deleted: false,
      wrappedContentKey: 'wrap', wrappedContentKeyNonce: 'wrapn', openedVia: 'vault', pendingSync: true,
    });
    await load();
    await notesStore.flushPending();
    obs('after the repair', { ...state(W), posts: server.posts.length });
    expect(card(W)?.notebookId).toBe('nb');
  });
});

describe('more paths a move can take', () => {
  it('a pull before the PUT forgets that the old notebook\'s people never had it: Ben (in both) is still given it', async () => {
    const id = await writtenOffline({ notebookId: 'nb' });
    server.down = false;
    const letGo = holdCreates();
    const drain = notesStore.flushPending();
    await vi.waitFor(() => expect(server.posts.filter(p => p.id === id).length).toBe(2));
    server.updatesDown = true;
    await notesStore.updateNote(id, { notebookId: 'nb2' });
    letGo();
    await drain;
    obs('landed in nb, moved to nb2, the move could not be sent', state(id));
    await notesStore.sync();
    obs('after a pull', state(id));
    server.updatesDown = false;
    await notesStore.flushPending();
    obs('after the drain', { ...state(id), shareLog });
    expect(readers(id)).toEqual(['ben@example.test', 'zoe@example.test']);
  });

  it('two tabs: the other tab (loaded before the move) replays the owed save; the removal is not lost and no copy is made', async () => {
    const id = await onTheServerIn('nb');
    const tab1 = notesStore;
    vi.resetModules();
    const tab2 = (await import('./notes')).notesStore;
    await tab2.hydrateFromCache();
    removals.failNext = 1;
    expect(await tab1.updateNote(id, { notebookId: null })).toBe(true);
    obs('tab 1 moved it, the removal got no answer', state(id));
    await tab2.flushPending();
    obs('tab 2 drained', { ...state(id), cachedMovedFrom: cache.get(id)?.movedFrom, copies: conflictCopies().map(p => [content(p).title, p.notebook_id ?? null]) });
    // Tab 1 is closed; the page is opened again.
    await load();
    await notesStore.sync();
    await notesStore.flushPending();
    obs('reopened', { ...state(id), copies: conflictCopies().length });
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
    expect(conflictCopies()).toEqual([]);
  });

  it('out (the removal gets no answer) and back in, online: Ben keeps it, nothing is owed, no re-key', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    await notesStore.updateNote(id, { notebookId: null });
    await notesStore.updateNote(id, { notebookId: 'nb' });
    const left = await notesStore.flushPendingAndReport();
    obs('after the drain', { ...state(id), left, shareLog });
    expect(readers(id)).toEqual(['ben@example.test']);
    expect(card(id)?.movedFrom).toBeUndefined();
    expect(left).toBe(0);
  });

  it('one of two removals gets no answer: no re-key until both are done', async () => {
    const id = await onTheServerIn('nb2');
    removals.failNext = 1;
    await notesStore.updateNote(id, { notebookId: 'solo' });
    obs('after the save', { ...state(id), rotateTries: rotateTries.length, shareLog });
    expect(rotateTries).toEqual([]);
    await notesStore.flushPending();
    obs('after a drain', { ...state(id), rotateTries: rotateTries.length, shareLog });
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });
});

describe('another device edits the note while its removal is owed', () => {
  it('the owed replay meets a conflict: Ben is still taken off, and no copy is made of words nobody wrote here', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    await notesStore.updateNote(id, { notebookId: null });
    // The person types on their phone: the row moves on (it is out of nb there too).
    const row = server.rows.get(id)!;
    row.version += 1;
    row.encrypted_content = JSON.stringify({ ...JSON.parse(row.encrypted_content), body: 'typed on the phone' });
    row.updated_at = tick();
    const left = await notesStore.flushPendingAndReport();
    obs('after the drain', { ...state(id), left, copies: conflictCopies().map(p => [content(p).title, content(p).body, p.notebook_id ?? null]) });
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
    expect(conflictCopies()).toEqual([]);
  });
});

describe('someone the owner took off THIS note by hand, who stands on both notebooks', () => {
  it('control: a move sent at once from nb2 to nb does not give it back to Ben', async () => {
    const id = await onTheServerIn('nb2');
    // The Share panel: Ben removed from this note alone (rotate-shares with his row), he still stands on nb and nb2.
    sharedWith.get(id)!.delete('ben@example.test');
    await notesStore.updateNote(id, { notebookId: 'nb' });
    obs('after the save', { ...state(id), shareLog });
    expect(readers(id)).not.toContain('ben@example.test');
  });

});

describe('the queued card says what is owed, the card no longer does', () => {
  it('moved out and edited offline (the queued card carries movedFrom), the removal fails at the replay, a pull, a drain: Ben is still taken off', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { notebookId: null });
    await notesStore.updateNote(id, { body: 'second words' });
    obs('queued card', { movedFrom: entry(id)?.note.movedFrom, notebookId: entry(id)?.note.notebookId });
    server.down = false;
    removals.failNext = 1;
    await notesStore.flushPending();
    obs('after the replay', { ...state(id), queuedMovedFrom: entry(id)?.note.movedFrom });
    await notesStore.sync();
    obs('after the pull', { ...state(id), queuedMovedFrom: entry(id)?.note.movedFrom });
    await notesStore.flushPending();
    obs('after the drain', state(id));
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });
});

describe('each record of an owed move is the one that saves it somewhere', () => {
  /** The note's words as the server holds them (its "ciphertext" is the plaintext here). */
  const onServer = (id: string) => {
    const row = server.rows.get(id);
    return row ? JSON.parse(row.encrypted_content) as Record<string, unknown> : null;
  };
  it('the PUT lands and its answer never comes; the page is opened again (sync, then the queue): only the queued card knows, and Ben is taken off', async () => {
    const id = await onTheServerIn('nb');
    server.losePutAnswer = true;
    void notesStore.updateNote(id, { notebookId: null });
    await vi.waitFor(() => expect(server.rows.get(id)!.notebook_id).toBeNull());
    // Closed while it waited: the card in the cache never heard of the move.
    expect(cache.get(id)?.movedFrom).toBeUndefined();
    server.losePutAnswer = false;
    await load();
    await notesStore.sync();
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('owed; a pull; then an edit of the words takes the queue entry\'s place: the card\'s record carries the move, and Ben is taken off', async () => {
    const id = await onTheServerIn('nb');
    removals.failNext = 1;
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(true);
    await notesStore.sync();
    server.updatesDown = true;
    await notesStore.updateNote(id, { title: 'New words' });
    server.updatesDown = false;
    expect(entry(id)?.op).toBe('update');
    await notesStore.flushPending();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
    expect(onServer(id)?.title).toBe('New words');
  });

  it('another tab, loaded before the move, replays the words the server has already: a conflict, no copy, and the move carried through', async () => {
    const id = await onTheServerIn('nb');
    const tab1 = notesStore;
    vi.resetModules();
    const tab2 = (await import('./notes')).notesStore;
    await tab2.hydrateFromCache();
    // Tab 1's removal never ends (it is closed mid-save): its entry still has the words.
    removals.hang = true;
    void tab1.updateNote(id, { notebookId: null });
    await vi.waitFor(() => expect(server.rows.get(id)!.notebook_id).toBeNull());
    expect(entry(id)?.op).toBe('update');
    removals.hang = false;
    await tab2.flushPending();
    expect(conflictCopies()).toEqual([]);
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('another tab replays the words after another device changed them: a copy is kept (the conflict rule), and the move the server has is still carried through', async () => {
    const id = await onTheServerIn('nb');
    const tab1 = notesStore;
    vi.resetModules();
    const tab2 = (await import('./notes')).notesStore;
    await tab2.hydrateFromCache();
    removals.hang = true;
    void tab1.updateNote(id, { notebookId: null });
    await vi.waitFor(() => expect(server.rows.get(id)!.notebook_id).toBeNull());
    removals.hang = false;
    // Another device writes new words after the move landed.
    const row = server.rows.get(id)!;
    row.encrypted_content = JSON.stringify({ ...JSON.parse(row.encrypted_content), title: 'Written elsewhere' });
    row.version += 1;
    await tab2.flushPending();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
    expect(onServer(id)?.title).toBe('Written elsewhere');
  });

  it('a move whose PUT meets a conflict made only of another device\'s reordering is sent again, and carried through', async () => {
    const id = await onTheServerIn('nb');
    const row = server.rows.get(id)!;
    row.encrypted_content = JSON.stringify({ ...JSON.parse(row.encrypted_content), sort_order: 9 });
    row.version += 1;
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(true);
    expect(conflictCopies()).toEqual([]);
    expect(server.rows.get(id)!.notebook_id).toBeNull();
    expect(readers(id)).toEqual([]);
    expect(rotated).toEqual([id]);
  });

  it('an edit queued while the removal is under way keeps its words: only this save\'s own entry becomes the sharing job', async () => {
    const id = await onTheServerIn('nb');
    let answer!: (ok: boolean) => void;
    removals.gate = new Promise<boolean>(resolve => { answer = resolve; });
    const moving = notesStore.updateNote(id, { notebookId: null });
    await vi.waitFor(() => expect(server.rows.get(id)!.notebook_id).toBeNull());
    server.updatesDown = true;
    void notesStore.updateNote(id, { title: 'Typed meanwhile' });
    await vi.waitFor(() => expect((entry(id)?.note as { title?: string } | undefined)?.title).toBe('Typed meanwhile'));
    answer(false);
    await moving;
    expect(queue.get(id)?.sharingOnly).toBeUndefined();
    server.updatesDown = false;
    await notesStore.flushPending();
    expect(onServer(id)?.title).toBe('Typed meanwhile');
    expect(readers(id)).toEqual([]);
  });
});

