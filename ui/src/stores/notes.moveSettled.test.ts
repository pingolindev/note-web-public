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

const { ME, queue } = vi.hoisted(() => ({
  ME: '0e0e0e0e-0000-4000-8000-00000000000e',
  /** The offline queue: one entry per note id, as the real store keeps it. */
  queue: new Map<string, Record<string, unknown>>(),
}));

/**
 * A move is carried through to who the note is shared with, whenever it is sent.
 *
 * Moving a note out of a notebook takes it from that notebook's people (and
 * gives the note a new key); moving it into one gives it to that notebook's
 * people. Comparing the notebook in the change with the notebook on the CARD,
 * at the moment the change is sent, works for a move that is sent at once. It
 * does not work for one that is sent LATER, because by then the card already
 * shows the move:
 *
 *   - a move made while the server could not be reached, replayed from the
 *     queue: the card and the change name the same notebook, so nobody would
 *     be taken off the note and nobody given it;
 *   - a move folded into a note's create that has landed or is on its way:
 *     the same, and the create would pass the note on to the notebook it was
 *     SENT in.
 *
 * In both, someone the note was moved away from would keep the note's key and
 * read every later edit, and a note moved into a shared notebook would reach
 * nobody.
 *
 * So the card remembers where the SERVER has the note for as long as a move
 * made here has not been carried through (`movedFrom`, lib/notebookMove), and
 * the sharing is brought in line from there.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
// Ciphertext IS the plaintext here: the store's crypto is not what is under test.
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
/** Who holds a share of each note, as the server would: what the three calls below leave behind. */
const { sharedWith, rotated, shareLog } = vi.hoisted(() => ({
  sharedWith: new Map<string, Set<string>>(),
  rotated: [] as string[],
  /** Every share and unshare, in order: `+ben@… note` / `-ben@… note`. */
  shareLog: [] as string[],
}));
const shareNoteWithRecipientResult = vi.fn(async (...a: unknown[]) => {
  const [noteId, , r] = a as [string, unknown, { email: string }];
  if (!sharedWith.has(noteId)) sharedWith.set(noteId, new Set());
  sharedWith.get(noteId)!.add(r.email);
  shareLog.push(`+${r.email}`);
  return { ok: true };
});
/** Set to make the next removal fail, as when the request gets no answer. */
const removals = { failNext: 0 };
const unshareNoteWithRecipient = vi.fn(async (...a: unknown[]) => {
  const [noteId, email] = a as [string, string];
  if (removals.failNext > 0) { removals.failNext -= 1; return false; }
  sharedWith.get(noteId)?.delete(email);
  shareLog.push(`-${email}`);
  return true;
});
const rotateContentKey = vi.fn(async (...a: unknown[]) => { rotated.push(a[0] as string); return { rotated: true }; });
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: (...a: unknown[]) => shareNoteWithRecipientResult(...a),
  unshareNoteWithRecipient: (...a: unknown[]) => unshareNoteWithRecipient(...a),
  rotateContentKey: (...a: unknown[]) => rotateContentKey(...a),
}));
vi.mock('../lib/recipientKeys', async () => {
  const real = await vi.importActual<typeof import('../lib/recipientKeys')>('../lib/recipientKeys');
  return { ...real, lookupDirectoryKeys: async () => new Map() };
});
/** Notebook `nb` is shared with Ben, `nb2` with Ben and Zoe, `solo` with nobody. */
const BEN = { email: 'ben@example.test', permission: 'edit' as const, publicKey: 'aa'.repeat(32), userId: 'ben-id', signingPublicKey: 'bb'.repeat(32) };
const ZOE = { email: 'zoe@example.test', permission: 'edit' as const, publicKey: 'cc'.repeat(32), userId: 'zoe-id', signingPublicKey: 'dd'.repeat(32) };
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => true,
    notebookItemState: async (id: string | null | undefined) => (id ? 'item' : 'none'),
    learnNotebookItem: async (id: string | null | undefined) => !!id,
    getNotebookShares: (id: string) => (id === 'nb' ? [BEN] : id === 'nb2' ? [BEN, ZOE] : []),
    notebooks: () => [{ id: 'nb', name: 'Wedding', noteCount: 0 }, { id: 'nb2', name: 'Trip', noteCount: 0 }, { id: 'solo', name: 'Mine', noteCount: 0 }],
    membersOf: () => [],
    notebookOpenedVia: () => 'vault',
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
  },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
/** The page's cache of cards: it keeps what it is given, so a reload finds it. */
const { cache } = vi.hoisted(() => ({ cache: new Map<string, Record<string, unknown>>() }));
/** Set to make the queue unreadable for the count of what is left. */
const { queueUnreadable } = vi.hoisted(() => ({ queueUnreadable: { now: false } }));
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
  countPending: vi.fn(async () => { if (queueUnreadable.now) throw new Error('the queue cannot be read'); return queue.size; }),
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
/**
 * The note server, as far as a note's create and update go. A create for an
 * id it has is `item_already_exists`; an update of a note it was never given
 * is the 403 the real one answers (the permission check comes before "not
 * found"); an update at another version is a conflict.
 */
const server = {
  /** Unreachable: a request gets no answer at all. */
  down: false,
  /** Reachable, and answers a create with this instead of taking it. */
  refuseCreates: null as null | { success: false; status: number; error_code?: string },
  /** A create is TAKEN and its answer lost. */
  loseCreateAnswer: false,
  /** Held until the test lets it go: a create on its way. */
  holdCreates: null as null | Promise<void>,
  /** Unreachable for updates only. */
  updatesDown: false,
  rows: new Map<string, Row>(),
  posts: [] as Body[],
  puts: [] as { id: string; body: Body }[],
  reads: [] as string[],
  deletes: [] as string[],
};
const UNREACHABLE = { success: false, error: 'Failed to fetch' };
const content = (b: Body) => JSON.parse(b.encrypted_content ?? '{}') as Record<string, unknown>;
const onServer = (id: string) => {
  const row = server.rows.get(id);
  return row ? { ...JSON.parse(row.encrypted_content) as Record<string, unknown>, version: row.version, notebook_id_on_row: row.notebook_id } : null;
};

let notesStore: typeof import('./notes').notesStore;

async function load() {
  vi.resetModules();
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
}

beforeEach(async () => {
  vi.clearAllMocks();
  queue.clear();
  cache.clear();
  sharedWith.clear(); rotated.length = 0; shareLog.length = 0; removals.failNext = 0;
  queueUnreadable.now = false;
  Object.assign(server, { down: false, refuseCreates: null, loseCreateAnswer: false, holdCreates: null, updatesDown: false });
  server.rows.clear();
  server.posts.length = 0; server.puts.length = 0; server.reads.length = 0; server.deletes.length = 0;
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: Body }) => {
    const method = opts?.method ?? 'GET';
    const body = opts?.body ?? {};
    if (url === '/api/v1/items' && method === 'POST') {
      server.posts.push(copy(body));
      if (server.holdCreates) await server.holdCreates;
      if (server.down) return UNREACHABLE;
      if (server.refuseCreates) return server.refuseCreates;
      const id = body.id!;
      if (server.rows.has(id)) return { success: false, status: 409, error_code: 'item_already_exists' };
      server.rows.set(id, {
        id, user_id: ME, item_type: 1, version: 1, deleted: false,
        encrypted_content: body.encrypted_content!, content_nonce: 'n',
        wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn', notebook_id: body.notebook_id ?? null,
        created_at: '2026-10-07T09:00:00Z', updated_at: '2026-10-07T09:00:00Z',
      });
      if (server.loseCreateAnswer) return UNREACHABLE;
      return { success: true, data: { id, version: 1, created_at: '2026-10-07T09:00:00Z', updated_at: '2026-10-07T09:00:00Z' } };
    }
    const item = /^\/api\/v1\/items\/([^/]+)$/.exec(url);
    if (item && method === 'GET') {
      server.reads.push(item[1]);
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
      if (body.notebook_id !== undefined) row.notebook_id = body.notebook_id;
      // As the server answers an update: the item, its notebook column included.
      return { success: true, data: { id: row.id, version: row.version, updated_at: '2026-10-07T09:05:00Z', notebook_id: row.notebook_id } };
    }
    if (item && method === 'DELETE') {
      server.deletes.push(item[1]);
      if (server.down) return UNREACHABLE;
      const row = server.rows.get(item[1]);
      if (!row) return { success: false, status: 404 };
      row.deleted = true;
      return { success: true, data: null };
    }
    return { success: false, status: 404 };
  });
  await load();
});

const card = (id: string) => notesStore.notes().find(n => n.id === id);
const entry = (id: string) => queue.get(id) as { op: string; note: Record<string, unknown>; edits?: Record<string, unknown> } | undefined;
const conflictCopies = () => server.posts.filter(p => String(content(p).title).includes('(conflict copy)'));

/** A note written while the server cannot be reached: queued, and on screen as waiting. */
async function writtenOffline(over: Record<string, unknown> = {}): Promise<string> {
  server.down = true;
  const r = await notesStore.createNote({ title: 'Written offline', body: 'first words', ...over });
  expect(r.queued).toBe(true);
  expect(queue.size).toBe(1);
  const id = [...queue.keys()][0];
  expect(card(id)?.pendingSync).toBe(true);
  return id;
}

/** Who holds a share of the note. */
const readers = (id: string) => [...(sharedWith.get(id) ?? [])].sort();
/** A note the server has, in `notebookId`, passed on to that notebook's people. */
async function onTheServerIn(notebookId: string | null): Promise<string> {
  const r = await notesStore.createNote({ title: 'Seating plan', body: 'first words', notebookId });
  expect(r.note).not.toBeNull();
  shareLog.length = 0;
  return r.note!.id;
}
/** The card says the note is in `to`; the server row and its readers are what `expectServer` reads. */
const where = (id: string) => ({ card: card(id)?.notebookId ?? null, row: server.rows.get(id)?.notebook_id ?? null, readers: readers(id) });

describe('the control: a move that is sent at once', () => {
  it('out of a shared notebook: taken from its people, and the note is re-keyed', async () => {
    const id = await onTheServerIn('nb');
    expect(readers(id)).toEqual(['ben@example.test']);
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(true);
    expect(where(id)).toEqual({ card: null, row: null, readers: [] });
    expect(rotated).toEqual([id]);
    expect(card(id)?.movedFrom).toBeUndefined();
  });

  it('into a shared notebook: given to its people', async () => {
    const id = await onTheServerIn(null);
    expect(await notesStore.updateNote(id, { notebookId: 'nb' })).toBe(true);
    expect(where(id)).toEqual({ card: 'nb', row: 'nb', readers: ['ben@example.test'] });
    expect(rotated).toEqual([]);
    expect(card(id)?.movedFrom).toBeUndefined();
  });
});

describe('a move made while the server cannot be reached, and sent later', () => {
  it('out of a shared notebook: when it is sent, the note is taken from the notebook\'s people and re-keyed', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(false);
    // Shown as it will be; nothing has reached the server, and Ben still has the note.
    expect(where(id)).toEqual({ card: null, row: 'nb', readers: ['ben@example.test'] });
    expect(card(id)?.movedFrom).toBe('nb');
    expect(entry(id)?.op).toBe('update');

    server.down = false;
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(where(id)).toEqual({ card: null, row: null, readers: [] });
    expect(rotated).toEqual([id]);
    expect(card(id)?.movedFrom).toBeUndefined();
  });

  it('into a shared notebook: when it is sent, the note is given to the notebook\'s people', async () => {
    const id = await onTheServerIn(null);
    server.down = true;
    expect(await notesStore.updateNote(id, { notebookId: 'nb' })).toBe(false);
    expect(where(id)).toEqual({ card: 'nb', row: null, readers: [] });
    expect(card(id)?.movedFrom).toBeNull();

    server.down = false;
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(where(id)).toEqual({ card: 'nb', row: 'nb', readers: ['ben@example.test'] });
    expect(rotated).toEqual([]);
    expect(card(id)?.movedFrom).toBeUndefined();
  });

  it('from one shared notebook to another: only who is not in the new one loses it, everyone in the new one has it', async () => {
    const id = await onTheServerIn('nb2');
    expect(readers(id)).toEqual(['ben@example.test', 'zoe@example.test']);
    server.down = true;
    await notesStore.updateNote(id, { notebookId: 'nb' });
    server.down = false;
    await notesStore.flushPending();
    expect(where(id)).toEqual({ card: 'nb', row: 'nb', readers: ['ben@example.test'] });
    expect(shareLog.filter(s => s.startsWith('-'))).toEqual(['-zoe@example.test']);
    expect(rotated).toEqual([id]);
  });

  it('moved twice before anything is sent: carried through from where the SERVER has it to where it ends', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { notebookId: null });
    await notesStore.updateNote(id, { notebookId: 'solo' });
    expect(card(id)?.movedFrom).toBe('nb');
    server.down = false;
    await notesStore.flushPending();
    expect(where(id)).toEqual({ card: 'solo', row: 'solo', readers: [] });
    expect(rotated).toEqual([id]);
    expect(card(id)?.movedFrom).toBeUndefined();
  });

  it('moved out and back before anything is sent: nothing is owed, and nobody loses the note', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { notebookId: null });
    await notesStore.updateNote(id, { notebookId: 'nb' });
    expect(card(id)?.movedFrom).toBeUndefined();
    server.down = false;
    await notesStore.flushPending();
    expect(where(id)).toEqual({ card: 'nb', row: 'nb', readers: ['ben@example.test'] });
    expect(shareLog.filter(s => s.startsWith('-'))).toEqual([]);
    expect(rotated).toEqual([]);
  });

  it('an edit of its words while the move waits takes the move with it', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { notebookId: null });
    server.down = false;
    // Not the drain: the person types, and that save is the one that gets through.
    expect(await notesStore.updateNote(id, { body: 'second words' })).toBe(true);
    expect(where(id)).toEqual({ card: null, row: null, readers: [] });
    expect(onServer(id)).toMatchObject({ body: 'second words', notebook_id: null });
    expect(rotated).toEqual([id]);
    expect(card(id)?.movedFrom).toBeUndefined();
  });

  it('the page is closed and opened again in between: the move is still carried through', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { notebookId: null });
    await load();
    expect(card(id)?.movedFrom).toBe('nb');
    server.down = false;
    await notesStore.flushPending();
    expect(where(id)).toEqual({ card: null, row: null, readers: [] });
    expect(rotated).toEqual([id]);
  });

  it('a removal that gets no answer is tried again at the next drain, until it is done', async () => {
    const id = await onTheServerIn('nb');
    server.down = true;
    await notesStore.updateNote(id, { notebookId: null });
    server.down = false;
    removals.failNext = 1;
    expect(await notesStore.flushPendingAndReport()).toBe(1);
    // The row has moved; Ben still has the note, and that is still owed.
    expect(where(id)).toEqual({ card: null, row: null, readers: ['ben@example.test'] });
    expect(card(id)?.movedFrom).toBe('nb');
    expect(rotated).toEqual([]);

    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(where(id)).toEqual({ card: null, row: null, readers: [] });
    expect(rotated).toEqual([id]);
    expect(card(id)?.movedFrom).toBeUndefined();
  });
});

describe('a move folded into a create that has landed, or is on its way', () => {
  /** A create that is held on its way until the test lets it go. */
  function holdCreates(): () => void {
    let letGo!: () => void;
    server.holdCreates = new Promise<void>(resolve => { letGo = resolve; });
    return () => { server.holdCreates = null; letGo(); };
  }

  it('written in a shared notebook and moved OUT while its create is on its way: its people never get it', async () => {
    const id = await writtenOffline({ notebookId: 'nb' });
    server.down = false;
    const letGo = holdCreates();
    const drain = notesStore.flushPending();
    await vi.waitFor(() => expect(server.posts.filter(p => p.id === id).length).toBe(2));
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(true);
    letGo();
    await drain;
    expect(where(id)).toEqual({ card: null, row: null, readers: [] });
    // Never given to Ben, not given and taken back: he was sent nothing.
    expect(shareLog.filter(s => s.startsWith('+'))).toEqual([]);
    expect(queue.size).toBe(0);
    expect(card(id)?.movedFrom).toBeUndefined();
    expect(conflictCopies()).toEqual([]);
  });

  it('written in a shared notebook, landed with its answer lost, then moved OUT: nobody keeps it', async () => {
    server.loseCreateAnswer = true;
    const r = await notesStore.createNote({ title: 'Written on the train', body: 'first words', notebookId: 'nb' });
    expect(r.queued).toBe(true);
    const id = [...queue.keys()][0];
    expect(server.rows.get(id)?.notebook_id).toBe('nb');
    server.loseCreateAnswer = false;
    // Someone it reached the first time, before the page died: it may have.
    sharedWith.set(id, new Set(['ben@example.test']));
    expect(await notesStore.updateNote(id, { notebookId: null })).toBe(true);
    await notesStore.flushPending();
    expect(where(id)).toEqual({ card: null, row: null, readers: [] });
    expect(shareLog.filter(s => s.startsWith('+'))).toEqual([]);
    expect(rotated).toEqual([id]);
    expect(queue.size).toBe(0);
    expect(card(id)?.movedFrom).toBeUndefined();
    expect(conflictCopies()).toEqual([]);
  });

  it('written in no notebook and moved INTO a shared one while its create is on its way: its people get it', async () => {
    const id = await writtenOffline();
    server.down = false;
    const letGo = holdCreates();
    const drain = notesStore.flushPending();
    await vi.waitFor(() => expect(server.posts.filter(p => p.id === id).length).toBe(2));
    expect(await notesStore.updateNote(id, { notebookId: 'nb' })).toBe(true);
    letGo();
    await drain;
    expect(where(id)).toEqual({ card: 'nb', row: 'nb', readers: ['ben@example.test'] });
    expect(rotated).toEqual([]);
    expect(queue.size).toBe(0);
    expect(card(id)?.movedFrom).toBeUndefined();
  });

  it('written in no notebook, landed with its answer lost, then moved INTO a shared one: its people get it', async () => {
    server.loseCreateAnswer = true;
    const r = await notesStore.createNote({ title: 'Written on the train', body: 'first words' });
    expect(r.queued).toBe(true);
    const id = [...queue.keys()][0];
    server.loseCreateAnswer = false;
    expect(await notesStore.updateNote(id, { notebookId: 'nb' })).toBe(true);
    await notesStore.flushPending();
    expect(where(id)).toEqual({ card: 'nb', row: 'nb', readers: ['ben@example.test'] });
    expect(queue.size).toBe(0);
    expect(card(id)?.movedFrom).toBeUndefined();
  });

  it('landed in one shared notebook and moved to another: everyone in the new one has it, whoever had it before', async () => {
    server.loseCreateAnswer = true;
    await notesStore.createNote({ title: 'Written on the train', body: 'first words', notebookId: 'nb' });
    const id = [...queue.keys()][0];
    server.loseCreateAnswer = false;
    // The first attempt never got as far as passing it on: Ben has nothing yet.
    expect(readers(id)).toEqual([]);
    expect(await notesStore.updateNote(id, { notebookId: 'nb2' })).toBe(true);
    await notesStore.flushPending();
    expect(where(id)).toEqual({ card: 'nb2', row: 'nb2', readers: ['ben@example.test', 'zoe@example.test'] });
    expect(queue.size).toBe(0);
  });

  it('a move that was already in the create when it was sent is not a move: passed on once, nothing taken away', async () => {
    const id = await writtenOffline();
    await notesStore.updateNote(id, { notebookId: 'nb' });
    server.down = false;
    await notesStore.flushPending();
    expect(where(id)).toEqual({ card: 'nb', row: 'nb', readers: ['ben@example.test'] });
    expect(shareLog).toEqual(['+ben@example.test']);
    expect(rotated).toEqual([]);
    expect(card(id)?.movedFrom).toBeUndefined();
  });
});
