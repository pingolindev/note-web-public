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

// The signed-in account, as /auth/me names it: a canonical id (ids are
// compared canonically, so a made-up 'me' matches nothing).
const { ME } = vi.hoisted(() => ({ ME: '0e0e0e0e-0000-4000-8000-00000000000e' }));

/**
 * A note whose wrap will not open is REFUSED, not re-keyed; a note that opens
 * is saved without proposing a wrap change; and our own locked notes are
 * counted, somebody else's are not.
 *
 * WHY THESE EXIST
 *   Treating "the wrap did not open" like "there is no wrap" would mint a
 *   fresh content key, re-encrypt the note under it and PUT the new wrap,
 *   which the server stores over the owner's. Every other device, every
 *   recipient holding the old key and every attachment sealed under it would
 *   lose the note — and with a vault key that exists only in this tab, so
 *   would this one, the moment the tab closed.
 *
 *   And a reset account would open on the new-account empty state if nothing
 *   counted the notes it cannot open.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

/** Which wraps "open". The store's crypto is otherwise a pass-through. */
const openable = new Set<string>();
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => cryptoReady,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'minted-wrap', nonce: 'minted-nonce' }),
  unwrapContentKeyWithVault: (wrap: string) => (openable.has(wrap) ? new Uint8Array(32).fill(1) : null),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: () => { throw new Error('vault-direct decrypt fails in this file'); },
}));
let cryptoReady = true;
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipient: vi.fn(async () => true),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));
vi.mock('./notebooks', () => ({
  notebooksStore: {
    notebooks: () => [],
    hasNotebookItem: () => false, learnNotebookItem: async () => false, notebookItemState: async () => 'none',
    getNotebookShares: () => [],
    membersOf: () => [],
    loadFromSyncedItems: () => {},
    gcEditorModes: () => {},
    markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
    pruneAcceptances: async () => {}, rememberAcceptances: () => {},
  },
}));
const inboxEntry = vi.fn();
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: (id: string) => inboxEntry(id),
    load: async () => true,
    sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {},
    applyLocalEdit: () => {},
  },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
const cached: unknown[] = [];
const noteDb = {
  loadNotes: async () => cached,
  loadCursor: async () => null,
  loadCursorId: async () => null,
  putNote: vi.fn(async () => {}),
  putNotes: vi.fn(async () => {}),
  removeNote: vi.fn(async () => {}),
  queuePending: vi.fn(async () => {}),
  removePending: vi.fn(async () => {}),
  listPending: async () => [],
  getPending: async () => null,
  saveCursor: async () => {},
  saveCursorId: async () => {},
};
vi.mock('../lib/noteDb', () => noteDb);

const NOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function cachedNote(over: Record<string, unknown> = {}) {
  return {
    id: NOTE, title: 'Local title', body: 'local body', noteType: 'text', color: null,
    isPinned: false, isArchived: false, labels: [], sortOrder: 0, editMode: 'rich',
    notebookId: null, hasAttachments: false, version: 3,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', deleted: false,
    wrappedContentKey: 'old-wrap', wrappedContentKeyNonce: 'old-nonce', foreignOwner: false,
    ...over,
  };
}

let notes: typeof import('./notes');

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  cryptoReady = true;
  openable.clear();
  cached.length = 0;
  inboxEntry.mockReturnValue(undefined);
  notes = await import('./notes');
});

async function withCache(...rows: Record<string, unknown>[]) {
  cached.push(...rows);
  await notes.notesStore.hydrateFromCache();
}

describe('updateNote on a note whose wrap does not open', () => {
  it('refuses: no PUT, no minted key, the edit kept on this device and flagged', async () => {
    await withCache(cachedNote());
    const ok = await notes.notesStore.updateNote(NOTE, { title: 'Edited' });

    expect(ok).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(notes.notesStore.keyRefusedIds().has(NOTE)).toBe(true);
    // Local-first: the edit is on screen and in the queue, not thrown away…
    expect(notes.notesStore.notes().find(n => n.id === NOTE)?.title).toBe('Edited');
    expect(noteDb.queuePending).toHaveBeenCalledTimes(1);
    // …and the queue entry is KEPT for a drain that can open the key.
    expect(noteDb.removePending).not.toHaveBeenCalled();
  });

  it('saves normally once the key opens, and clears the flag', async () => {
    await withCache(cachedNote());
    await notes.notesStore.updateNote(NOTE, { title: 'Edited' });
    expect(notes.notesStore.keyRefusedIds().has(NOTE)).toBe(true);

    openable.add('old-wrap'); // e.g. the recovery key restored that identity
    apiRequest.mockResolvedValue({
      success: true,
      data: { id: NOTE, version: 4, updated_at: '2026-09-23T00:00:00Z' },
    });
    expect(await notes.notesStore.updateNote(NOTE, { title: 'Edited again' })).toBe(true);
    expect(notes.notesStore.keyRefusedIds().has(NOTE)).toBe(false);
  });
});

describe('updateNote never proposes a wrap change on a plain PUT', () => {
  it('omits the wrap when the note already has one that opens', async () => {
    openable.add('old-wrap');
    await withCache(cachedNote());
    apiRequest.mockResolvedValue({
      success: true,
      data: { id: NOTE, version: 4, updated_at: '2026-09-23T00:00:00Z' },
    });
    await notes.notesStore.updateNote(NOTE, { title: 'Edited' });

    const [url, opts] = apiRequest.mock.calls[0] as [string, { method: string; body: Record<string, unknown> }];
    expect(url).toBe(`/api/v1/items/${NOTE}`);
    expect(opts.method).toBe('PUT');
    expect('wrapped_content_key' in opts.body).toBe(false);
    expect('wrapped_content_key_nonce' in opts.body).toBe(false);
  });

  it('sends a first wrap for a legacy note that has none (the server allows NULL -> value)', async () => {
    await withCache(cachedNote({ wrappedContentKey: null, wrappedContentKeyNonce: null }));
    apiRequest.mockResolvedValue({
      success: true,
      data: { id: NOTE, version: 4, updated_at: '2026-09-23T00:00:00Z' },
    });
    expect(await notes.notesStore.updateNote(NOTE, { title: 'Edited' })).toBe(true);
    const [, opts] = apiRequest.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(opts.body.wrapped_content_key).toBe('minted-wrap');
    expect(opts.body.wrapped_content_key_nonce).toBe('minted-nonce');
  });
});

describe('createNote in a locked tab', () => {
  it('says it was refused because the tab is locked', async () => {
    cryptoReady = false;
    await withCache();
    const r = await notes.notesStore.createNote({ title: 'x', body: 'y' });
    expect(r).toEqual({ note: null, queued: false, locked: true });
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('lockedOwnFromCache', () => {
  const opensOnly = (...wraps: string[]) => (w: string) => wraps.includes(w);
  const none = () => false;

  it('counts our own wrapped notes whose wrap does not open', () => {
    const rows = [
      cachedNote({ id: 'a', wrappedContentKey: 'good' }),
      cachedNote({ id: 'b', wrappedContentKey: 'bad' }),
    ] as unknown as import('./notes').NoteItem[];
    expect([...notes.lockedOwnFromCache(rows, opensOnly('good'), none)]).toEqual(['b']);
  });

  it("never counts a note that is not positively ours, or an incoming share", () => {
    const rows = [
      cachedNote({ id: 'theirs', foreignOwner: true }),
      cachedNote({ id: 'unknown', foreignOwner: undefined }),
      cachedNote({ id: 'shared-in', foreignOwner: false }),
      cachedNote({ id: 'deleted', deleted: true }),
      cachedNote({ id: 'legacy', wrappedContentKey: null, wrappedContentKeyNonce: null }),
    ] as unknown as import('./notes').NoteItem[];
    const locked = notes.lockedOwnFromCache(rows, () => false, id => id === 'shared-in');
    expect([...locked]).toEqual([]);
  });

  it('counts a note made in this browser (its own vault, no stamp yet), as after a password reset', () => {
    const rows = [
      cachedNote({ id: 'made-here', foreignOwner: undefined, openedVia: 'vault' }),
      cachedNote({ id: 'opened-by-share', foreignOwner: undefined, openedVia: 'share' }),
      cachedNote({ id: 'stamped-foreign', foreignOwner: true, openedVia: 'vault' }),
    ] as unknown as import('./notes').NoteItem[];
    expect([...notes.lockedOwnFromCache(rows, () => false, () => false)]).toEqual(['made-here']);
  });
});

describe('sync counts our own undecryptable rows as locked, and not anyone else\'s', () => {
  it('marks an own row it cannot open, ignores a foreign one, and un-marks it once it opens', async () => {
    await withCache();
    const row = (id: string, userId: string, wrap: string) => ({
      id, user_id: userId, item_type: 1,
      encrypted_content: JSON.stringify({ title: id }), content_nonce: 'n', version: 1,
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
      deleted: false, circle_id: null, content_size: 1,
      wrapped_content_key: wrap, wrapped_content_key_nonce: 'w-n',
    });
    apiRequest.mockResolvedValue({
      success: true,
      data: {
        items: [row('mine', ME, 'reset-era-wrap'), row('theirs', 'someone', 'their-wrap')],
        cursor: null, cursor_id: null, has_more: false,
      },
    });
    await notes.notesStore.sync();
    expect([...notes.notesStore.lockedOwnIds()]).toEqual(['mine']);
    expect(notes.notesStore.undecryptableIds().has('theirs')).toBe(true);

    openable.add('reset-era-wrap');
    await notes.notesStore.sync();
    expect(notes.notesStore.lockedOwnIds().size).toBe(0);
  });
});
