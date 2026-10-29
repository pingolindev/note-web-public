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
 * An edit never replaces a waiting create.
 *
 * The queue holds one entry per note. A note written offline waits there as a
 * `create`; if editing its card queued an `update` under the same id in the
 * create's place, the replay would send a PUT for a note the server was never
 * given: refused (403), the entry dropped, and the card left saying "Not
 * synced" with nothing behind it. The count of unsent changes would be 0, and
 * the next sign-out would delete the only copy of the note.
 *
 * The rules are in lib/pendingNotes; these are the store, against a server
 * that behaves as the note server does and a queue that keeps what it is given.
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
const shareNoteWithRecipientResult = vi.fn();
const unshareNoteWithRecipient = vi.fn(async () => true);
const rotateContentKey = vi.fn(async () => ({ rotated: true }));
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: (...a: unknown[]) => shareNoteWithRecipientResult(...a),
  unshareNoteWithRecipient: (...a: unknown[]) => unshareNoteWithRecipient(...(a as [])),
  rotateContentKey: (...a: unknown[]) => rotateContentKey(...(a as [])),
}));
vi.mock('../lib/recipientKeys', async () => {
  const real = await vi.importActual<typeof import('../lib/recipientKeys')>('../lib/recipientKeys');
  return { ...real, lookupDirectoryKeys: async () => new Map() };
});
/** Notebook `nb` is shared with Ben. */
const BEN = { email: 'ben@example.test', permission: 'edit' as const, publicKey: 'aa'.repeat(32), userId: 'ben-id', signingPublicKey: 'bb'.repeat(32) };
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => true,
    notebookItemState: async (id: string | null | undefined) => (id ? 'item' : 'none'),
    learnNotebookItem: async (id: string | null | undefined) => !!id,
    getNotebookShares: (id: string) => (id === 'nb' ? [BEN] : []),
    notebooks: () => [{ id: 'nb', name: 'Wedding', noteCount: 0 }],
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
/** What the page finds in its cache when it loads: a test seeds it before `load()`. */
const cached: unknown[] = [];
/**
 * What the shared cache holds of one card NOW, as another tab may have left
 * it: `undefined` here means "as the page was loaded"; a test sets a card, or
 * `null` for one that another tab deleted.
 */
/** Set to make the queue unreadable for the count of what is left. */
const { queueUnreadable } = vi.hoisted(() => ({ queueUnreadable: { now: false } }));
const cacheNow = new Map<string, unknown>();
const inCache = (id: string) => (
  cacheNow.has(id) ? copy(cacheNow.get(id)) : copy((cached as { id: string }[]).find(n => n.id === id) ?? null)
);
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => cached,
  loadCursor: async () => null,
  loadCursorId: async () => null,
  // What the cache holds of one card: what the page was loaded with (`cached`), unless a test says otherwise.
  getNote: vi.fn(async (id: string) => inCache(id)),
  putNote: vi.fn(async () => {}),
  putNotes: vi.fn(async () => {}),
  removeNote: vi.fn(async () => {}),
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
  cached.length = 0;
  cacheNow.clear();
  queueUnreadable.now = false;
  Object.assign(server, { down: false, refuseCreates: null, loseCreateAnswer: false, holdCreates: null, updatesDown: false });
  server.rows.clear();
  server.posts.length = 0; server.puts.length = 0; server.reads.length = 0; server.deletes.length = 0;
  shareNoteWithRecipientResult.mockResolvedValue({ ok: true });
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
      return { success: true, data: { id: row.id, version: row.version, updated_at: '2026-10-07T09:05:00Z' } };
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

describe('a note that is still waiting to be created, and is edited', () => {
  it('the edit is folded into its create: the queue still holds a create, of the note as it is now', async () => {
    const id = await writtenOffline();
    expect(await notesStore.updateNote(id, { title: 'Edited offline' })).toBe(true);
    expect(entry(id)?.op).toBe('create');
    expect(entry(id)?.note.title).toBe('Edited offline');
    expect(entry(id)?.note.body).toBe('first words');
    expect(entry(id)?.edits).toEqual({ title: 'Edited offline' });
    // Nothing was sent as an update: there is no note on the server to update.
    expect(server.puts).toEqual([]);
    expect(card(id)?.title).toBe('Edited offline');
    expect(card(id)?.pendingSync).toBe(true);
  });

  it('when the server is back the note is created as it is now, and the queue is empty', async () => {
    const id = await writtenOffline();
    await notesStore.updateNote(id, { title: 'Edited offline', body: 'more words' });
    server.down = false;
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(onServer(id)).toMatchObject({ title: 'Edited offline', body: 'more words' });
    expect(queue.size).toBe(0);
    expect(card(id)?.pendingSync).toBeFalsy();
    expect(card(id)?.title).toBe('Edited offline');
    expect(card(id)?.version).toBe(onServer(id)!.version);
    expect(conflictCopies()).toEqual([]);
  });

  /** What a sign-out asks: with the entry dropped this was 0, and the wipe took the only copy. */
  it('it is still counted as unsent for as long as it is', async () => {
    const id = await writtenOffline();
    await notesStore.updateNote(id, { title: 'Edited offline' });
    expect(await notesStore.flushPendingAndReport()).toBe(1);
    expect(card(id)?.pendingSync).toBe(true);
    expect(server.puts).toEqual([]);
  });

  /** The server answers, and will not take the create just now. */
  it('a create answered 503, then a pin: the note is not dropped, and is pinned when it gets there', async () => {
    server.refuseCreates = { success: false, status: 503 };
    const r = await notesStore.createNote({ title: 'Written on a bad day' });
    expect(r.queued).toBe(true);
    const id = [...queue.keys()][0];
    expect(await notesStore.updateNote(id, { isPinned: true })).toBe(true);
    // Still a create, still counted, and no update was sent for the server to refuse.
    expect(entry(id)?.op).toBe('create');
    expect(server.puts).toEqual([]);
    expect(await notesStore.flushPendingAndReport()).toBe(1);

    server.refuseCreates = null;
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(onServer(id)).toMatchObject({ title: 'Written on a bad day', is_pinned: true });
    expect(card(id)?.isPinned).toBe(true);
    expect(card(id)?.pendingSync).toBeFalsy();
  });

  /**
   * The shell asks this before it wipes the device's copy, and "0" means
   * nothing is lost. A queue that cannot be read must never be answered as
   * an empty one.
   */
  it('when the queue cannot be read, the answer is a failure, never "0 left"', async () => {
    await writtenOffline();
    queueUnreadable.now = true;
    await expect(notesStore.flushPendingAndReport()).rejects.toThrow('the queue cannot be read');
    queueUnreadable.now = false;
    expect(await notesStore.flushPendingAndReport()).toBe(1);
  });

  /** A create cannot carry everything: it always files a note as not archived. */
  it('archiving it is kept: the update that follows the create carries it', async () => {
    const id = await writtenOffline();
    await notesStore.updateNote(id, { isArchived: true });
    expect(card(id)?.isArchived).toBe(true);
    server.down = false;
    await notesStore.flushPending();
    expect(content(server.posts[server.posts.length - 1]).is_archived).toBe(false);
    expect(server.puts.map(p => [p.id, p.body.expected_version, content(p.body).is_archived])).toEqual([[id, 1, true]]);
    expect(onServer(id)).toMatchObject({ is_archived: true, version: 2 });
    expect(card(id)?.isArchived).toBe(true);
    expect(card(id)?.version).toBe(2);
    expect(queue.size).toBe(0);
  });

  it('two edits in a row are both kept', async () => {
    const id = await writtenOffline();
    await notesStore.updateNote(id, { title: 'Edited offline' });
    await notesStore.updateNote(id, { labels: ['errands'], color: 'teal' });
    expect(entry(id)?.edits).toEqual({ title: 'Edited offline', labels: ['errands'], color: 'teal' });
    server.down = false;
    await notesStore.flushPending();
    expect(onServer(id)).toMatchObject({ title: 'Edited offline', labels: ['errands'], color: 'teal' });
  });

  it('taking a colour or a notebook AWAY is an edit too', async () => {
    const id = await writtenOffline({ color: 'teal', notebookId: 'nb' });
    await notesStore.updateNote(id, { color: null, notebookId: null });
    expect(entry(id)?.edits).toEqual({ color: null, notebookId: null });
    server.down = false;
    await notesStore.flushPending();
    expect(onServer(id)).toMatchObject({ color: null, notebook_id: null, notebook_id_on_row: null });
  });

  it('moved into a shared notebook while it waits: created there, and passed on to its people', async () => {
    const id = await writtenOffline();
    await notesStore.updateNote(id, { notebookId: 'nb' });
    server.down = false;
    await notesStore.flushPending();
    expect(onServer(id)).toMatchObject({ notebook_id: 'nb', notebook_id_on_row: 'nb' });
    expect(shareNoteWithRecipientResult.mock.calls.map(c => [c[0], (c[2] as { email: string }).email])).toEqual([[id, 'ben@example.test']]);
    // Nobody had it before, so nobody is taken off it and nothing is re-keyed.
    expect(unshareNoteWithRecipient).not.toHaveBeenCalled();
    expect(rotateContentKey).not.toHaveBeenCalled();
  });

  it('the editor is told it is saved, and nothing is asked of the server while it cannot be reached', async () => {
    const id = await writtenOffline();
    const before = server.puts.length;
    expect(await notesStore.updateNote(id, { body: 'second thoughts' })).toBe(true);
    expect(server.puts.length).toBe(before);
    // It was tried once more as the create it is, and that is all.
    expect(server.posts.filter(p => p.id === id).length).toBe(2);
  });
});

/**
 * The first attempt's answer was lost AFTER the server took the note. Sent
 * as an update at version 0, the edit would meet a conflict: a "(conflict
 * copy)" of a note nobody else had touched, and the original never passed
 * on to its notebook's people.
 */
describe('a create that had landed, edited before the page knew', () => {
  const landedUnknown = async (over: Record<string, unknown> = {}) => {
    server.loseCreateAnswer = true;
    const r = await notesStore.createNote({ title: 'Written on the train', body: 'first words', ...over });
    expect(r.queued).toBe(true);
    server.loseCreateAnswer = false;
    const id = [...queue.keys()][0];
    expect(onServer(id)).toMatchObject({ title: 'Written on the train', version: 1 });
    expect(card(id)?.pendingSync).toBe(true);
    return id;
  };

  it('takes the edit as an ordinary update of the row the server has: no conflict copy', async () => {
    const id = await landedUnknown();
    expect(await notesStore.updateNote(id, { title: 'Edited on the train' })).toBe(true);
    expect(server.puts.map(p => [p.id, p.body.expected_version, content(p.body).title])).toEqual([[id, 1, 'Edited on the train']]);
    expect(onServer(id)).toMatchObject({ title: 'Edited on the train', body: 'first words', version: 2 });
    expect(conflictCopies()).toEqual([]);
    expect(queue.size).toBe(0);
    expect(card(id)).toMatchObject({ title: 'Edited on the train', version: 2 });
    expect(card(id)?.pendingSync).toBeFalsy();
  });

  it('and is passed on to its notebook\'s people, which the lost answer had left undone', async () => {
    const id = await landedUnknown({ notebookId: 'nb' });
    await notesStore.updateNote(id, { title: 'Edited on the train' });
    expect(shareNoteWithRecipientResult.mock.calls.map(c => [c[0], (c[2] as { email: string }).email])).toEqual([[id, 'ben@example.test']]);
    expect(onServer(id)).toMatchObject({ title: 'Edited on the train', version: 2 });
  });

  it('the card shows the edit all the way through, not the older row the server had', async () => {
    const id = await landedUnknown({ notebookId: 'nb' });
    const seen: (string | undefined)[] = [];
    // The pass-on is the long step between the row being taken and the update being sent.
    shareNoteWithRecipientResult.mockImplementation(async () => { seen.push(card(id)?.title); return { ok: true }; });
    await notesStore.updateNote(id, { title: 'Edited on the train' });
    expect(seen).toEqual(['Edited on the train']);
  });

  it('put in the trash elsewhere meanwhile: the words written here are kept as a note of their own', async () => {
    const id = await landedUnknown();
    server.rows.get(id)!.deleted = true;
    await notesStore.updateNote(id, { body: 'words nobody else has' });
    expect(card(id)).toBeUndefined();
    expect(conflictCopies().map(p => [content(p).title, content(p).body])).toEqual([['Written on the train (conflict copy)', 'words nobody else has']]);
    expect(queue.has(id)).toBe(false);
    expect(server.puts).toEqual([]);
  });

  it('but a pin or a colour is nothing to rescue: no copy is made of a note deleted elsewhere', async () => {
    const id = await landedUnknown();
    server.rows.get(id)!.deleted = true;
    await notesStore.updateNote(id, { isPinned: true, color: 'teal' });
    expect(conflictCopies()).toEqual([]);
    expect(queue.has(id)).toBe(false);
    expect(card(id)).toBeUndefined();
  });

  it('and when the copy cannot be made just now, the entry and its words stay for the next try', async () => {
    const id = await landedUnknown();
    server.rows.get(id)!.deleted = true;
    server.refuseCreates = { success: false, status: 402, error_code: 'quota_notes_exceeded' };
    // (The replay of `id` itself must still be answered "already there".)
    const answer = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: Body }) => {
      if (url === '/api/v1/items' && opts?.method === 'POST' && opts.body?.id === id) {
        server.posts.push(copy(opts.body));
        return { success: false, status: 409, error_code: 'item_already_exists' };
      }
      return answer(url, opts);
    });
    await notesStore.updateNote(id, { body: 'words nobody else has' });
    expect(entry(id)?.op).toBe('create');
    expect(entry(id)?.note.body).toBe('words nobody else has');
  });

  /** The row as another of the person's devices left it, after the create had landed. */
  const editedElsewhere = (id: string, over: Record<string, unknown>) => {
    const row = server.rows.get(id)!;
    row.encrypted_content = JSON.stringify({ ...JSON.parse(row.encrypted_content), ...over });
    row.version += 1;
  };

  /**
   * The note has been on the server, and on the person's other devices,
   * since the first attempt. Words written there in the meantime must not
   * be replaced by the words written here with no sign of it.
   */
  it('edited on another device since it landed, and edited here: both are kept, and the row is not written over', async () => {
    const id = await landedUnknown();
    editedElsewhere(id, { body: 'words from the phone' });
    expect(await notesStore.updateNote(id, { body: 'words from the web' })).toBe(true);
    // Nothing was sent over the row.
    expect(server.puts).toEqual([]);
    expect(onServer(id)).toMatchObject({ body: 'words from the phone', version: 2 });
    // The words written here are a note of their own.
    expect(conflictCopies().map(p => [content(p).title, content(p).body])).toEqual([['Written on the train (conflict copy)', 'words from the web']]);
    // The card is the row, and nothing is left waiting.
    expect(card(id)).toMatchObject({ body: 'words from the phone', version: 2 });
    expect(card(id)?.pendingSync).toBeFalsy();
    expect(queue.has(id)).toBe(false);
  });

  it('a pin or a move made here goes onto the row as the other device left it: no words are at stake', async () => {
    const id = await landedUnknown();
    editedElsewhere(id, { body: 'words from the phone' });
    await notesStore.updateNote(id, { isPinned: true, notebookId: 'nb' });
    expect(conflictCopies()).toEqual([]);
    expect(server.puts.map(p => [p.body.expected_version, content(p.body).body, content(p.body).is_pinned])).toEqual([[2, 'words from the phone', true]]);
    expect(onServer(id)).toMatchObject({ body: 'words from the phone', is_pinned: true, notebook_id_on_row: 'nb', version: 3 });
    expect(queue.has(id)).toBe(false);
  });

  it('words written here that are the words the row has now are not a conflict', async () => {
    const id = await landedUnknown();
    editedElsewhere(id, { body: 'the same words' });
    await notesStore.updateNote(id, { body: 'the same words', color: 'teal' });
    expect(conflictCopies()).toEqual([]);
    expect(onServer(id)).toMatchObject({ body: 'the same words', color: 'teal', version: 3 });
  });

  it('when the copy cannot be made just now, the words stay in the queue and the row stays as it is', async () => {
    const id = await landedUnknown();
    editedElsewhere(id, { body: 'words from the phone' });
    const answer = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: Body }) => {
      // The copy is a create of another id: the server cannot take it just now.
      if (url === '/api/v1/items' && opts?.method === 'POST' && opts.body?.id !== id) {
        server.posts.push(copy(opts.body ?? {}));
        return { success: false, status: 402, error_code: 'quota_notes_exceeded' };
      }
      return answer(url, opts);
    });
    await notesStore.updateNote(id, { body: 'words from the web' });
    expect(entry(id)?.op).toBe('create');
    expect(entry(id)?.note.body).toBe('words from the web');
    expect(onServer(id)).toMatchObject({ body: 'words from the phone', version: 2 });
    expect(server.puts).toEqual([]);

    apiRequest.mockImplementation(answer);
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(conflictCopies().filter(p => server.rows.has(p.id!)).map(p => content(p).body)).toEqual(['words from the web']);
    expect(onServer(id)).toMatchObject({ body: 'words from the phone', version: 2 });
  });

  /**
   * A delete made HERE must not leave the note's create in the queue: its
   * replay would find the note deleted, take that for a delete made somewhere
   * else, and bring the words back as "(conflict copy)".
   */
  it('deleted HERE after it was edited: nothing comes back, and nothing is left in the queue', async () => {
    const id = await landedUnknown();
    // The edit's own replay cannot be sent, so the create is still waiting with the words in it.
    server.down = true;
    await notesStore.updateNote(id, { body: 'second thoughts' });
    server.down = false;
    expect(entry(id)?.op).toBe('create');
    expect(await notesStore.deleteNote(id)).toBe(true);
    expect(queue.has(id)).toBe(false);
    await notesStore.flushPending();
    expect(conflictCopies()).toEqual([]);
    expect(server.posts.filter(p => p.id !== id)).toEqual([]);
    expect(server.rows.get(id)?.deleted).toBe(true);
  });

  it('and in a shared notebook it reaches nobody', async () => {
    const id = await landedUnknown({ notebookId: 'nb' });
    server.down = true;
    await notesStore.updateNote(id, { body: 'second thoughts' });
    server.down = false;
    await notesStore.deleteNote(id);
    await notesStore.flushPending();
    expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
    expect(conflictCopies()).toEqual([]);
  });
});

describe('an edit made while the create is on its way', () => {
  /** The queued create is being replayed, and its request has not been answered yet. */
  const replayOnItsWay = async (over: Record<string, unknown> = {}) => {
    const id = await writtenOffline(over);
    server.down = false;
    let letGo: () => void = () => {};
    server.holdCreates = new Promise<void>((resolve) => { letGo = resolve; });
    const flushing = notesStore.flushPending();
    await new Promise(r => setTimeout(r, 10));
    expect(server.posts.filter(p => p.id === id).length).toBe(2);
    return { id, flushing, letGo: () => { server.holdCreates = null; letGo(); } };
  };

  it('is not sent beside it, and not lost: it follows as an update when the create has landed', async () => {
    const { id, flushing, letGo } = await replayOnItsWay();
    expect(await notesStore.updateNote(id, { title: 'Edited mid-flight' })).toBe(true);
    // Nothing more was sent: one create is on its way, and that is all.
    expect(server.posts.filter(p => p.id === id).length).toBe(2);
    expect(server.puts).toEqual([]);
    expect(card(id)?.title).toBe('Edited mid-flight');
    letGo();
    await flushing;
    expect(server.puts.map(p => [p.id, p.body.expected_version, content(p.body).title])).toEqual([[id, 1, 'Edited mid-flight']]);
    expect(onServer(id)).toMatchObject({ title: 'Edited mid-flight', version: 2 });
    expect(card(id)).toMatchObject({ title: 'Edited mid-flight', version: 2 });
    expect(queue.size).toBe(0);
    expect(conflictCopies()).toEqual([]);
  });

  it('when that update cannot be sent just now, it stays in the queue as an update', async () => {
    const { id, flushing, letGo } = await replayOnItsWay();
    await notesStore.updateNote(id, { title: 'Edited mid-flight' });
    server.updatesDown = true;
    letGo();
    await flushing;
    // The create is done with; what took its place is the edit, and the replay did not remove it.
    expect(entry(id)?.op).toBe('update');
    expect(entry(id)?.note).toMatchObject({ title: 'Edited mid-flight', version: 1 });
    expect(card(id)?.title).toBe('Edited mid-flight');
    expect(await notesStore.flushPendingAndReport()).toBe(1);

    server.updatesDown = false;
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(onServer(id)).toMatchObject({ title: 'Edited mid-flight', version: 2 });
    expect(conflictCopies()).toEqual([]);
  });

  /**
   * Between the create's answer and its end lies the pass-on to the notebook's
   * people, which is requests of its own: the card must not show the words
   * the create was SENT with for all that time.
   */
  it('the card does not go back to the older words while the create is finishing', async () => {
    const { id, flushing, letGo } = await replayOnItsWay({ notebookId: 'nb' });
    await notesStore.updateNote(id, { title: 'Edited mid-flight' });
    const seen: (string | undefined)[] = [];
    // The pass-on is the long step between the note being confirmed and the edit being sent.
    shareNoteWithRecipientResult.mockImplementation(async () => { seen.push(card(id)?.title); return { ok: true }; });
    const answer = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: Body }) => {
      if (opts?.method === 'PUT') seen.push(card(id)?.title);
      return answer(url, opts);
    });
    letGo();
    await flushing;
    // Seen during the pass-on, and again when the edit is sent.
    expect(seen).toEqual(['Edited mid-flight', 'Edited mid-flight']);
    expect(card(id)?.pendingSync).toBeFalsy();
  });

  /**
   * The server does not have the note yet, so the delete is answered "no
   * such note" and the card goes; then the create lands, and must not put
   * the note back.
   */
  it('a delete made here while it is on its way is not undone when it lands: the note is deleted there too', async () => {
    const { id, flushing, letGo } = await replayOnItsWay({ notebookId: 'nb' });
    expect(await notesStore.deleteNote(id)).toBe(true);
    expect(card(id)).toBeUndefined();
    letGo();
    await flushing;
    expect(server.deletes).toEqual([id, id]);
    expect(server.rows.get(id)?.deleted).toBe(true);
    expect(card(id)).toBeUndefined();
    expect(queue.has(id)).toBe(false);
    // And it was never passed on to the notebook's people.
    expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
  });

  it('when it cannot be deleted there just now, the note is shown: it exists, and the card is where to delete it', async () => {
    const { id, flushing, letGo } = await replayOnItsWay();
    await notesStore.deleteNote(id);
    const answer = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: Body }) => (
      opts?.method === 'DELETE' ? UNREACHABLE : answer(url, opts)
    ));
    letGo();
    await flushing;
    expect(server.rows.get(id)?.deleted).toBe(false);
    expect(card(id)).toMatchObject({ title: 'Written offline' });
    expect(card(id)?.pendingSync).toBeFalsy();
  });

  /** Deleted here, and its delete there unanswered: it must not go to its notebook's people. */
  it('and in a shared notebook it is shown all the same, and passed on to nobody', async () => {
    const { id, flushing, letGo } = await replayOnItsWay({ notebookId: 'nb' });
    await notesStore.deleteNote(id);
    const answer = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: Body }) => (
      opts?.method === 'DELETE' ? UNREACHABLE : answer(url, opts)
    ));
    letGo();
    await flushing;
    expect(card(id)).toMatchObject({ title: 'Written offline' });
    expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
  });

  it('a delete of another note, or one made when nothing is on its way, changes nothing of this', async () => {
    const r = await notesStore.createNote({ title: 'An ordinary note' });
    const other = r.note!.id;
    expect(await notesStore.deleteNote(other)).toBe(true);
    // Made again under the same id (a restore does this): it is not deleted because of a delete long over.
    server.rows.delete(other);
    expect((await notesStore.createNote({ title: 'Made again' }, other)).note).not.toBeNull();
    expect(server.rows.get(other)?.deleted).toBe(false);
    expect(server.deletes).toEqual([other]);
  });
});

/**
 * A queue an older build may have left behind. A page that was edited offline
 * holds an `update` where the create was; one that has replayed since holds
 * nothing at all behind a card that says "Not synced". The card is the only
 * copy of the note, and it is still there.
 */
describe('a queue the older page left behind', () => {
  const WAITING = 'cccccccc-3333-4333-8333-33333333333c';
  const waitingCard = (over: Record<string, unknown> = {}) => ({
    id: WAITING, title: 'Written offline', body: 'the only copy', noteType: 'text', color: null,
    isPinned: false, isArchived: false, labels: [], sortOrder: -1, editMode: 'rich',
    notebookId: null, hasAttachments: false, version: 0,
    createdAt: '2026-10-06T09:00:00Z', updatedAt: '2026-10-06T09:00:00Z', deleted: false,
    wrappedContentKey: 'wrap', wrappedContentKeyNonce: 'wrapn', openedVia: 'vault', pendingSync: true, ...over,
  });

  it('an update where the create was is sent as the create it replaced', async () => {
    cached.push(waitingCard({ title: 'Edited offline' }));
    queue.set(WAITING, { id: WAITING, op: 'update', queuedAt: '2026-10-06T09:01:00Z', note: waitingCard({ title: 'Edited offline' }) });
    await load();
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    // Created, never sent as an update of a note the server did not have.
    expect(server.posts.map(p => [p.id, content(p).title, content(p).body])).toEqual([[WAITING, 'Edited offline', 'the only copy']]);
    expect(server.puts.every(p => server.rows.has(p.id))).toBe(true);
    expect(server.puts.every(p => p.body.expected_version !== 0)).toBe(true);
    expect(onServer(WAITING)).toMatchObject({ title: 'Edited offline', body: 'the only copy' });
    expect(card(WAITING)?.pendingSync).toBeFalsy();
    expect(conflictCopies()).toEqual([]);
  });

  it('and when its first create HAD landed, the card\'s words go over the older row', async () => {
    server.rows.set(WAITING, {
      id: WAITING, user_id: ME, item_type: 1, version: 1, deleted: false,
      encrypted_content: JSON.stringify({ title: 'Written offline', body: 'the first words', note_type: 'text', labels: [] }), content_nonce: 'n',
      wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn', notebook_id: null,
      created_at: '2026-10-06T09:00:00Z', updated_at: '2026-10-06T09:00:00Z',
    });
    cached.push(waitingCard({ title: 'Edited offline' }));
    queue.set(WAITING, { id: WAITING, op: 'update', queuedAt: '2026-10-06T09:01:00Z', note: waitingCard({ title: 'Edited offline' }) });
    await load();
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(onServer(WAITING)).toMatchObject({ title: 'Edited offline', body: 'the only copy', version: 2 });
    expect(conflictCopies()).toEqual([]);
  });

  it('a card that says "Not synced" with nothing in the queue is sent after all', async () => {
    cached.push(waitingCard());
    await load();
    expect(queue.size).toBe(0);
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(onServer(WAITING)).toMatchObject({ title: 'Written offline', body: 'the only copy' });
    expect(card(WAITING)?.pendingSync).toBeFalsy();
  });

  it('and while the server cannot be reached it is counted, where it was not', async () => {
    cached.push(waitingCard());
    server.down = true;
    await load();
    expect(await notesStore.flushPendingAndReport()).toBe(1);
    expect(entry(WAITING)?.op).toBe('create');
    expect(card(WAITING)?.pendingSync).toBe(true);
  });

  it('editing such a card queues its create, with the edit in it', async () => {
    cached.push(waitingCard());
    server.down = true;
    await load();
    expect(await notesStore.updateNote(WAITING, { body: 'and a second line' })).toBe(true);
    expect(entry(WAITING)?.op).toBe('create');
    expect(entry(WAITING)?.note).toMatchObject({ title: 'Written offline', body: 'and a second line' });
    expect(server.puts).toEqual([]);
  });

  /**
   * A tab's cards are its own; the cache is shared by the account's tabs.
   * This page drew its card before ANOTHER tab sent the note (and went on
   * editing it), or deleted it. The card here still says "Not synced" and
   * the queue is empty, as in a queue an older build left behind: made again
   * from this card, the note's create would replace what was written since,
   * or bring a deleted note back.
   */
  it('a card another tab has SENT since is not made again: this page takes the card as the cache has it', async () => {
    cached.push(waitingCard());
    await load();
    cacheNow.set(WAITING, waitingCard({ pendingSync: false, version: 3, body: 'written since, in the other tab' }));
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(server.posts).toEqual([]);
    expect(server.puts).toEqual([]);
    expect(card(WAITING)).toMatchObject({ body: 'written since, in the other tab', version: 3 });
    expect(card(WAITING)?.pendingSync).toBeFalsy();
  });

  it('a card another tab has DELETED since is not made again', async () => {
    cached.push(waitingCard());
    await load();
    cacheNow.set(WAITING, null);
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(server.posts).toEqual([]);
    expect(queue.size).toBe(0);
  });

  /** The row has moved on since it landed, and the card may be the old one. */
  const landedAndChangedSince = (over: Record<string, unknown>) => server.rows.set(WAITING, {
    id: WAITING, user_id: ME, item_type: 1, version: 3, deleted: false,
    encrypted_content: JSON.stringify({ title: 'Written offline', body: 'the only copy', note_type: 'text', labels: [], ...over }), content_nonce: 'n',
    wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn', notebook_id: null,
    created_at: '2026-10-06T09:00:00Z', updated_at: '2026-10-06T09:05:00Z',
  });

  it('made again and found on the server CHANGED since: the row is taken as it is, and nothing of the card is sent over it', async () => {
    landedAndChangedSince({ is_pinned: true, color: 'teal' });
    cached.push(waitingCard());
    await load();
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(server.puts).toEqual([]);
    expect(conflictCopies()).toEqual([]);
    expect(onServer(WAITING)).toMatchObject({ is_pinned: true, color: 'teal', version: 3 });
    expect(card(WAITING)).toMatchObject({ isPinned: true, color: 'teal', version: 3 });
    expect(card(WAITING)?.pendingSync).toBeFalsy();
  });

  it('and when the card holds other words than that row, they are kept as a note of their own', async () => {
    landedAndChangedSince({ body: 'newer words, from another device' });
    cached.push(waitingCard());
    await load();
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(server.puts).toEqual([]);
    expect(onServer(WAITING)).toMatchObject({ body: 'newer words, from another device', version: 3 });
    expect(conflictCopies().map(p => [content(p).title, content(p).body])).toEqual([['Written offline (conflict copy)', 'the only copy']]);
    expect(card(WAITING)).toMatchObject({ body: 'newer words, from another device', version: 3 });
  });

  it('a card in the trash, or one that is not waiting, is left alone', async () => {
    cached.push(waitingCard({ deleted: true }));
    cached.push(waitingCard({ id: 'dddddddd-4444-4444-8444-44444444444d', pendingSync: false, version: 3 }));
    await load();
    await notesStore.flushPending();
    expect(server.posts).toEqual([]);
    expect(queue.size).toBe(0);
  });
});

describe('deleting a note that is still waiting to be created', () => {
  it('takes its create out of the queue: it is not made again at the next replay', async () => {
    server.refuseCreates = { success: false, status: 503 };
    await notesStore.createNote({ title: 'Never mind' });
    const id = [...queue.keys()][0];
    expect(await notesStore.deleteNote(id)).toBe(true);
    expect(card(id)).toBeUndefined();
    expect(queue.size).toBe(0);
    server.refuseCreates = null;
    const before = server.posts.length;
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(server.posts.length).toBe(before);
    expect(server.rows.has(id)).toBe(false);
  });

  it('a delete the server could not be asked about changes nothing: the note still waits', async () => {
    const id = await writtenOffline();
    expect(await notesStore.deleteNote(id)).toBe(false);
    expect(entry(id)?.op).toBe('create');
    expect(card(id)?.pendingSync).toBe(true);
  });
});

/** The control: none of this touches a note the server has. */
describe('a note the server has', () => {
  it('is edited as usual: queued as an update, sent, and its entry removed', async () => {
    const r = await notesStore.createNote({ title: 'An ordinary note' });
    const id = r.note!.id;
    expect(queue.size).toBe(0);
    const noteDb = await import('../lib/noteDb');
    vi.mocked(noteDb.queuePending).mockClear();
    expect(await notesStore.updateNote(id, { title: 'An ordinary note, edited' })).toBe(true);
    expect(vi.mocked(noteDb.queuePending).mock.calls.map(c => (c[0] as { op: string }).op)).toEqual(['update']);
    expect(server.puts.map(p => [p.id, p.body.expected_version])).toEqual([[id, 1]]);
    expect(server.posts.length).toBe(1);
    expect(queue.size).toBe(0);
  });

  it('edited while the server cannot be reached: an update waits, and is sent when it can be', async () => {
    const r = await notesStore.createNote({ title: 'An ordinary note' });
    const id = r.note!.id;
    server.down = true;
    expect(await notesStore.updateNote(id, { title: 'Edited offline' })).toBe(false);
    expect(entry(id)?.op).toBe('update');
    server.down = false;
    expect(await notesStore.flushPendingAndReport()).toBe(0);
    expect(onServer(id)).toMatchObject({ title: 'Edited offline', version: 2 });
    expect(server.posts.length).toBe(1);
  });

  it('a first create that goes through leaves nothing in the queue, and sends no update after it', async () => {
    await notesStore.createNote({ title: 'An ordinary note' });
    expect(queue.size).toBe(0);
    expect(server.puts).toEqual([]);
  });
});
