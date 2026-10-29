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

const { ME } = vi.hoisted(() => ({ ME: '0e0e0e0e-0000-4000-8000-00000000000e' }));

/**
 * Notes rescued from a copy this browser kept, after a password reset
 * (lib/noteRescue).
 *
 * WHY
 *   In the browser the account used before its reset, a note made there is
 *   still shown from that browser's copy, readable, but its key opens with
 *   nothing any more, so saving it fails, and it is not counted with the
 *   locked notes. It is re-saved from the copy, under this identity's key,
 *   when the copy is the server's latest version.
 *
 * Keys here are words: a wrap in `openable` opens, any other does not.
 */

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
const openable = new Set<string>();
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  unwrapContentKeyWithVault: (wrap: string) => (openable.has(wrap) ? new Uint8Array(32).fill(1) : null),
  vaultKeyThatOpens: (wrap: string) => (openable.has(wrap) ? 'current' : null),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  opensBoundToItem: () => true,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: () => { throw new Error('vault-direct decrypt fails in this file'); },
  getPinnedUserKeys: () => null,
}));
let answered = true;
vi.mock('../lib/previousIdentities', () => ({
  ensurePreviousIdentities: async () => 0,
  previousIdentitiesAnswered: () => answered,
}));
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: vi.fn(async () => ({ ok: true })),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => false, learnNotebookItem: async () => false, notebookItemState: async () => 'none', getNotebookShares: () => [], notebooks: () => [], membersOf: () => [],
    loadFromSyncedItems: () => {}, gcEditorModes: () => {}, markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
    pruneAcceptances: async () => {}, rememberAcceptances: () => {}, notebookOpenedVia: () => 'vault',
  },
}));
const incoming = new Set<string>();
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: (id: string) => (incoming.has(id) ? { note: {} } : undefined),
    load: async () => true, sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {}, applyLocalEdit: () => {},
  },
}));
/** Who the page is signed in as. */
let who = ME;
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: who, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const { cache, queue } = vi.hoisted(() => ({
  cache: new Map<string, Record<string, unknown>>(),
  queue: new Map<string, Record<string, unknown>>(),
}));
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

/** A note as the server holds it: its content opens with nothing here (its wrap is not openable). */
const row = (id: string, version: number, wrap = 'era-1') => ({
  id, user_id: ME, item_type: 1,
  encrypted_content: JSON.stringify({ title: `server ${id}` }), content_nonce: 'n', version,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  deleted: false, circle_id: null, content_size: 1,
  wrapped_content_key: wrap, wrapped_content_key_nonce: 'w-n',
});
/** This browser's copy of it: a card made here, readable, as the cache keeps it. */
const card = (id: string, version: number, over: Record<string, unknown> = {}) => ({
  id, title: `kept ${id}`, body: 'the body', noteType: 'text', color: null, isPinned: false, isArchived: false,
  labels: [], sortOrder: 0, editMode: 'rich', notebookId: null, hasAttachments: false,
  version, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deleted: false,
  wrappedContentKey: 'era-1', wrappedContentKeyNonce: 'w-n', contentKeyGeneration: 1, openedVia: 'vault', ...over,
});

let local: Storage;
let notesStore: typeof import('./notes').notesStore;
const rescue = vi.fn();
const keepOldKey = vi.fn();
const attachmentsOf = vi.fn();
const deps = (limit = 10) => ({
  rescue: (c: unknown, notebookId: string | null) => rescue(c, notebookId),
  keepOldKey: (id: string, w: unknown) => keepOldKey(id, w),
  attachmentsOf: (id: string) => attachmentsOf(id),
  limit,
});
const applied = (version: number) => ({ applied: { wrappedForVault: { wrappedKey: 'new-wrap', nonce: 'new-n' }, version, contentKeyGeneration: 2 } });

async function syncWith(rows: unknown[]) {
  apiRequest.mockResolvedValue({ success: true, data: { items: rows, cursor: '2026-10-08T00:00:00Z', cursor_id: 'x', has_more: false } });
  vi.resetModules();
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
  await notesStore.sync();
}
const shown = (id: string) => notesStore.notes().find(n => n?.id === id);

beforeEach(() => {
  local = memoryStorage();
  vi.stubGlobal('localStorage', local);
  openable.clear();
  incoming.clear();
  cache.clear();
  queue.clear();
  answered = true;
  who = ME;
  apiRequest.mockReset();
  rescue.mockReset().mockImplementation(async (c: { version: number }) => applied(c.version + 1));
  keepOldKey.mockReset().mockResolvedValue(true);
  attachmentsOf.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

describe('a note this browser kept a copy of, whose key opens with nothing here', () => {
  it('is re-saved from that copy, in place, when the copy is the server\'s latest version', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    expect(shown('n1')?.title).toBe('kept n1');
    expect(notesStore.cachedCopiesNoKeyOpens()).toBe(true);

    const r = await notesStore.rescueFromCopies(deps());
    expect(r).toEqual({ rescued: 1, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 });
    expect(rescue).toHaveBeenCalledTimes(1);
    expect(rescue.mock.calls[0][0]).toMatchObject({ id: 'n1', title: 'kept n1', body: 'the body', version: 3 });
    // In the notebook it is in: nothing moved.
    expect(rescue.mock.calls[0][1]).toBeNull();
    // It is this account's own note again, under the new key, everywhere this page keeps it.
    expect(shown('n1')).toMatchObject({ wrappedContentKey: 'new-wrap', wrappedContentKeyNonce: 'new-n', version: 4, contentKeyGeneration: 2, foreignOwner: false, openedVia: 'vault' });
    expect(cache.get('n1')).toMatchObject({ wrappedContentKey: 'new-wrap', version: 4 });
    expect(notesStore.lockedOwnIds().has('n1')).toBe(false);
    expect(notesStore.undecryptableIds().has('n1')).toBe(false);
    // Once: nothing is left to rescue.
    openable.add('new-wrap');
    expect(await notesStore.rescueFromCopies(deps())).toEqual({ rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 });
    expect(notesStore.cachedCopiesNoKeyOpens()).toBe(false);
  });

  it('an OLDER copy than the server\'s is not re-saved over it: the note stays locked, and is counted', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 4)]);
    const r = await notesStore.rescueFromCopies(deps());
    expect(r).toEqual({ rescued: 0, stale: 1, held: 0, waiting: 0, left: 0, movesQueued: 0 });
    expect(rescue).not.toHaveBeenCalled();
    expect(notesStore.lockedOwnIds().has('n1')).toBe(true);
    // Nothing stamped on the server's word: the card is positively ours already.
    expect(shown('n1')?.foreignOwner).toBeUndefined();
  });

  it('a card of unknown provenance is left alone, older or not: not rescued, not counted by the rescue, not stamped', async () => {
    cache.set('n1', card('n1', 3, { openedVia: undefined }));
    cache.set('n2', card('n2', 3, { openedVia: undefined }));
    await syncWith([row('n1', 4), row('n2', 3)]);
    expect(await notesStore.rescueFromCopies(deps())).toEqual({ rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 });
    expect(rescue).not.toHaveBeenCalled();
    expect(cache.get('n1')?.foreignOwner).toBeUndefined();
  });

  it('rows another account\'s pull recorded are never rescued by the account the page has now', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    who = '1f1f1f1f-0000-4000-8000-00000000001f';
    expect(await notesStore.rescueFromCopies(deps())).toEqual({ rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 });
    expect(rescue).not.toHaveBeenCalled();
  });

  it('nothing is re-saved before it is known what a recovery key brings back', async () => {
    answered = false;
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    expect(await notesStore.rescueFromCopies(deps())).toEqual({ rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 });
    expect(rescue).not.toHaveBeenCalled();
  });

  it('what was waiting to be sent is what is saved, and it leaves the queue', async () => {
    cache.set('n1', card('n1', 3));
    queue.set('n1', { id: 'n1', op: 'update', note: card('n1', 3, { title: 'edited here' }), queuedAt: '2026-10-08T00:00:00Z', account: ME });
    await syncWith([row('n1', 3)]);
    await notesStore.rescueFromCopies(deps());
    expect(rescue.mock.calls[0][0]).toMatchObject({ id: 'n1', title: 'edited here', version: 3 });
    expect(queue.has('n1')).toBe(false);
    expect(shown('n1')?.title).toBe('edited here');
  });

  it('the note whose save was refused for its key is saved by the rescue, with the edit, and can be saved again', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    // The editor's save: refused, the edit shown and kept to send.
    expect(await notesStore.updateNote('n1', { title: 'typed after the reset' })).toBe(false);
    expect(notesStore.keyRefusedIds().has('n1')).toBe(true);
    expect(queue.get('n1')).toMatchObject({ op: 'update' });

    expect((await notesStore.rescueFromCopies(deps())).rescued).toBe(1);
    expect(rescue.mock.calls[0][0]).toMatchObject({ id: 'n1', title: 'typed after the reset', version: 3 });
    expect(notesStore.keyRefusedIds().has('n1')).toBe(false);
    expect(queue.has('n1')).toBe(false);
    expect(shown('n1')).toMatchObject({ title: 'typed after the reset', wrappedContentKey: 'new-wrap', version: 4 });
  });

  it('a waiting MOVE is not claimed by the rescue: written where its sharing has it, and queued, under the new key, for the normal save', async () => {
    // The refused save of a move: the card shows the new notebook and remembers the old one.
    cache.set('n1', card('n1', 3, { notebookId: 'nb-new', movedFrom: 'nb-old' }));
    queue.set('n1', { id: 'n1', op: 'update', note: card('n1', 3, { notebookId: 'nb-new', title: 'moved' }), queuedAt: '2026-10-08T00:00:00Z', account: ME });
    await syncWith([row('n1', 3)]);
    const r = await notesStore.rescueFromCopies(deps());
    expect(r).toMatchObject({ rescued: 1, movesQueued: 1 });
    expect(rescue.mock.calls[0][0]).toMatchObject({ title: 'moved', notebookId: 'nb-new' });
    expect(rescue.mock.calls[0][1]).toBe('nb-old');
    // The card still owes the move; the queue holds the rescued card, new key and all.
    expect(shown('n1')).toMatchObject({ notebookId: 'nb-new', movedFrom: 'nb-old', wrappedContentKey: 'new-wrap', version: 4, contentKeyGeneration: 2 });
    expect(queue.get('n1')).toMatchObject({ op: 'update', note: { notebookId: 'nb-new', movedFrom: 'nb-old', wrappedContentKey: 'new-wrap', version: 4, contentKeyGeneration: 2 } });
  });

  it('a move that landed and still owes its sharing: the same, with nothing waiting before', async () => {
    cache.set('n1', card('n1', 3, { notebookId: 'nb-new', movedFrom: 'nb-old' }));
    await syncWith([row('n1', 3)]);
    expect((await notesStore.rescueFromCopies(deps())).movesQueued).toBe(1);
    expect(rescue.mock.calls[0][1]).toBe('nb-old');
    expect(queue.get('n1')).toMatchObject({ op: 'update', note: { notebookId: 'nb-new', movedFrom: 'nb-old', version: 4 } });
  });

  it('a card that says it waits for its create is left to that', async () => {
    cache.set('n1', card('n1', 3, { pendingSync: true }));
    await syncWith([row('n1', 3)]);
    expect((await notesStore.rescueFromCopies(deps())).rescued).toBe(0);
    expect(rescue).not.toHaveBeenCalled();
  });

  it('a create still waiting is not this: left alone', async () => {
    cache.set('n1', card('n1', 3));
    queue.set('n1', { id: 'n1', op: 'create', note: card('n1', 0), queuedAt: '2026-10-08T00:00:00Z', account: ME });
    await syncWith([row('n1', 3)]);
    expect((await notesStore.rescueFromCopies(deps())).rescued).toBe(0);
    expect(rescue).not.toHaveBeenCalled();
    expect(queue.has('n1')).toBe(true);
  });

  it('a note with attachments has its old key kept in the list FIRST; if that does not land, nothing is re-saved', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    attachmentsOf.mockResolvedValue([{ id: 'a1' }]);
    keepOldKey.mockResolvedValue(false);
    expect(await notesStore.rescueFromCopies(deps())).toEqual({ rescued: 0, stale: 0, held: 0, waiting: 1, left: 0, movesQueued: 0 });
    // With the attachments it has now: the only ones under that key.
    expect(keepOldKey).toHaveBeenCalledWith('n1', { wrappedKey: 'era-1', wrappedKeyNonce: 'w-n', attachmentIds: ['a1'] });
    expect(rescue).not.toHaveBeenCalled();

    keepOldKey.mockResolvedValue(true);
    expect((await notesStore.rescueFromCopies(deps())).rescued).toBe(1);
    expect(keepOldKey.mock.invocationCallOrder[1]).toBeLessThan(rescue.mock.invocationCallOrder[0]);
  });

  it('when its attachments cannot be listed, it waits', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    attachmentsOf.mockResolvedValue(null);
    expect((await notesStore.rescueFromCopies(deps())).waiting).toBe(1);
    expect(rescue).not.toHaveBeenCalled();
  });

  it('a rotation the server did not take (the note moved on meanwhile) takes nothing on, and waits', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    rescue.mockResolvedValue({});
    expect(await notesStore.rescueFromCopies(deps())).toEqual({ rescued: 0, stale: 0, held: 0, waiting: 1, left: 0, movesQueued: 0 });
    expect(shown('n1')).toMatchObject({ wrappedContentKey: 'era-1', version: 3 });
  });

  it('a key that opens now (a recovery key used meanwhile): read as it is, nothing re-saved', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    openable.add('era-1');
    expect((await notesStore.rescueFromCopies(deps())).rescued).toBe(0);
    expect(rescue).not.toHaveBeenCalled();
  });

  it('never a note that reached this account through a share, nor one marked as another\'s', async () => {
    cache.set('n1', card('n1', 3));
    cache.set('n2', card('n2', 3, { foreignOwner: true }));
    incoming.add('n1');
    await syncWith([row('n1', 3), row('n2', 3)]);
    expect(notesStore.cachedCopiesNoKeyOpens()).toBe(false);
    expect((await notesStore.rescueFromCopies(deps())).rescued).toBe(0);
    expect(rescue).not.toHaveBeenCalled();
  });

  it('never a row another account owns', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([{ ...row('n1', 3), user_id: '1f1f1f1f-0000-4000-8000-00000000001f' }]);
    expect((await notesStore.rescueFromCopies(deps())).rescued).toBe(0);
    expect(rescue).not.toHaveBeenCalled();
  });

  it('at most `limit` in one call; the rest are left for the next go', async () => {
    for (const id of ['n1', 'n2', 'n3']) cache.set(id, card(id, 3));
    await syncWith([row('n1', 3), row('n2', 3), row('n3', 3)]);
    const first = await notesStore.rescueFromCopies(deps(2));
    expect(first).toEqual({ rescued: 2, stale: 0, held: 0, waiting: 0, left: 1, movesQueued: 0 });
    expect((await notesStore.rescueFromCopies(deps(2)))).toEqual({ rescued: 1, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 });
  });

  it('a card of unknown provenance asks for no full pull either', async () => {
    cache.set('n1', card('n1', 3, { openedVia: undefined }));
    await syncWith([row('n1', 3)]);
    expect(notesStore.cachedCopiesNoKeyOpens()).toBe(false);
  });

  it('a card under another wrap than the row\'s, one that OPENS here say, is not rescued', async () => {
    cache.set('n1', card('n1', 3, { wrappedContentKey: 'opens-here' }));
    openable.add('opens-here');
    await syncWith([row('n1', 3)]);
    expect((await notesStore.rescueFromCopies(deps())).rescued).toBe(0);
    expect(rescue).not.toHaveBeenCalled();
  });

  it('a note shared with someone, as far as this page knows, is held: counted locked, never re-keyed', async () => {
    cache.set('n1', card('n1', 3, { isShared: true, sharedWithCount: 1 }));
    await syncWith([row('n1', 3)]);
    expect(await notesStore.rescueFromCopies(deps())).toEqual({ rescued: 0, stale: 0, held: 1, waiting: 0, left: 0, movesQueued: 0 });
    expect(rescue).not.toHaveBeenCalled();
    expect(notesStore.lockedOwnIds().has('n1')).toBe(true);
  });

  it('one the server says others hold, at the rescue: held, counted, remembered on the card, not tried again', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    rescue.mockResolvedValue({ remainingCount: 2 });
    expect((await notesStore.rescueFromCopies(deps())).held).toBe(1);
    expect(shown('n1')).toMatchObject({ isShared: true, sharedWithCount: 2, wrappedContentKey: 'era-1' });
    expect(notesStore.lockedOwnIds().has('n1')).toBe(true);
    rescue.mockClear();
    expect((await notesStore.rescueFromCopies(deps())).held).toBe(1);
    expect(rescue).not.toHaveBeenCalled();
  });

  it('another tab\'s edit, queued while the rescue was under way, stays in the queue', async () => {
    cache.set('n1', card('n1', 3));
    const first = { id: 'n1', op: 'update', note: card('n1', 3, { title: 'edited here' }), queuedAt: '2026-10-08T00:00:00Z', account: ME };
    queue.set('n1', first);
    await syncWith([row('n1', 3)]);
    rescue.mockImplementationOnce(async (c: { version: number }) => {
      queue.set('n1', { ...first, note: card('n1', 3, { title: 'from the other tab' }), queuedAt: '2026-10-08T00:00:05Z' });
      return applied(c.version + 1);
    });
    await notesStore.rescueFromCopies(deps());
    expect(queue.get('n1')).toMatchObject({ queuedAt: '2026-10-08T00:00:05Z' });
  });

  it('a note trashed while its rescue was under way stays in the trash', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    rescue.mockImplementationOnce(async (c: { version: number }) => {
      notesStore.applyLocalPatch({ ...shown('n1')!, deleted: true });
      return applied(c.version + 1);
    });
    await notesStore.rescueFromCopies(deps());
    expect(shown('n1')).toMatchObject({ deleted: true, wrappedContentKey: 'new-wrap', version: 4 });
  });

  it('a page older than the rescued copy does not lock the note again', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    await notesStore.rescueFromCopies(deps());
    openable.add('new-wrap');
    // A page from before the rescue: the old row, under the old wrap.
    await syncWith([row('n1', 3)]);
    expect(notesStore.lockedOwnIds().has('n1')).toBe(false);
    expect(notesStore.undecryptableIds().has('n1')).toBe(false);
    expect(shown('n1')).toMatchObject({ wrappedContentKey: 'new-wrap', version: 4 });
  });

  it('a save made while the rescue is under way waits for it, and is made under the new key', async () => {
    cache.set('n1', card('n1', 3));
    await syncWith([row('n1', 3)]);
    openable.add('new-wrap');
    apiRequest.mockImplementation(async (_url: string, opts?: { method?: string; body?: { expected_version?: number } }) => (
      opts?.method === 'PUT'
        ? { success: true, data: { version: (opts.body?.expected_version ?? 0) + 1, updated_at: 't', notebook_id: null } }
        : { success: true, data: { items: [], cursor: '2026-10-08T00:00:00Z', cursor_id: 'x', has_more: false } }));
    let saved: Promise<boolean> | undefined;
    rescue.mockImplementationOnce(async (c: { version: number }) => {
      saved = notesStore.updateNote('n1', { title: 'typed meanwhile' });
      await new Promise(r => setTimeout(r, 0));
      return applied(c.version + 1);
    });
    await notesStore.rescueFromCopies(deps());
    expect(await saved).toBe(true);
    const put = apiRequest.mock.calls.find(c => (c[1] as { method?: string } | undefined)?.method === 'PUT');
    expect((put?.[1] as { body: { expected_version: number } }).body.expected_version).toBe(4);
    expect(shown('n1')).toMatchObject({ title: 'typed meanwhile', wrappedContentKey: 'new-wrap', version: 5 });
  });

  it('a note with no copy here is nothing to rescue from', async () => {
    await syncWith([row('n1', 3)]);
    expect(await notesStore.rescueFromCopies(deps())).toEqual({ rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 });
    expect(rescue).not.toHaveBeenCalled();
  });
});
