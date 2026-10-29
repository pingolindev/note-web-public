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

const { ME } = vi.hoisted(() => ({ ME: '0e0e0e0e-0000-4000-8000-00000000000e' }));

/**
 * A note is sealed with the key that OPENED it. A note this browser opened
 * through its own vault is saved, and edited live, under its own key,
 * whatever the inbox holds; only a note opened through an accepted share's
 * key uses that key. The sync's own rows never take a share's key, a
 * vault-opened note is never stamped foreign, and nothing the vault opens is
 * evicted when a share leaves the inbox.
 *
 * The keys: our own content key is all 1s, the share's all 7s.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const openable = new Set<string>();
const sealedWith: number[] = [];
const openedWithKey: number[] = [];
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'minted-wrap', nonce: 'minted-nonce' }),
  unwrapContentKeyWithVault: (wrap: string) => (openable.has(wrap) ? new Uint8Array(32).fill(1) : null),
  encryptWithContentKey: (plaintext: string, key: Uint8Array) => {
    sealedWith.push(key[0]);
    return { ciphertext: plaintext, nonce: 'n' };
  },
  decryptWithContentKey: (d: { ciphertext: string }, key: Uint8Array) => {
    openedWithKey.push(key[0]);
    return d.ciphertext;
  },
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: () => { throw new Error('vault-direct decrypt fails in this file'); },
}));
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
const THEIRS_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SENDER = '22222222-2222-4222-8222-222222222222';

function cachedNote(over: Record<string, unknown> = {}) {
  return {
    id: NOTE, title: 'Mine', body: 'my text', noteType: 'text', color: null,
    isPinned: false, isArchived: false, labels: [], sortOrder: 0, editMode: 'rich',
    notebookId: null, hasAttachments: false, version: 3,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', deleted: false,
    wrappedContentKey: 'own-wrap', wrappedContentKeyNonce: 'own-nonce', foreignOwner: false,
    ...over,
  };
}

/** An accepted share of NOTE, with the server-chosen key (all 7s). */
function shareOfNote(over: Record<string, unknown> = {}) {
  return {
    shareId: 's1', itemId: NOTE, ownerId: SENDER, permission: 'edit', sharerPublicKey: null,
    sharerEmail: 'sender@example.test', sharedAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    itemType: 1, sharePermission: 'edit', contentKey: new Uint8Array(32).fill(7), error: null,
    wrapTrust: 'unverified',
    note: { ...cachedNote({ title: 'Theirs', wrappedContentKey: null, wrappedContentKeyNonce: null, version: 0 }), openedVia: 'share' },
    ...over,
  };
}

let notes: typeof import('./notes');

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  openable.clear();
  cached.length = 0;
  sealedWith.length = 0;
  openedWithKey.length = 0;
  inboxEntry.mockReturnValue(undefined);
  apiRequest.mockResolvedValue({ success: true, data: { id: NOTE, version: 4, updated_at: '2026-09-03T00:00:00Z' } });
  notes = await import('./notes');
});

async function withCache(...rows: Record<string, unknown>[]) {
  cached.push(...rows);
  await notes.notesStore.hydrateFromCache();
}

describe('saving a note this browser opened through its own vault', () => {
  it('seals under its own key while an inbox share names it (a cache an older build wrote)', async () => {
    openable.add('own-wrap');
    await withCache(cachedNote());
    inboxEntry.mockReturnValue(shareOfNote());

    expect(await notes.notesStore.updateNote(NOTE, { title: 'Edited' })).toBe(true);
    expect(sealedWith).toEqual([1]);
    expect(apiRequest).toHaveBeenCalledWith(`/api/v1/items/${NOTE}`, expect.objectContaining({ method: 'PUT' }));
  });

  it('seals under its own key when it is marked as opened with the vault', async () => {
    openable.add('own-wrap');
    await withCache(cachedNote({ openedVia: 'vault' }));
    inboxEntry.mockReturnValue(shareOfNote());

    await notes.notesStore.updateNote(NOTE, { body: 'more' });
    expect(sealedWith).toEqual([1]);
  });

  it('never takes the share key for an own note its vault can\'t open: the save is refused', async () => {
    await withCache(cachedNote({ wrappedContentKey: 'reset-era-wrap' }));
    inboxEntry.mockReturnValue(shareOfNote());

    expect(await notes.notesStore.updateNote(NOTE, { title: 'Edited' })).toBe(false);
    expect(sealedWith).toEqual([]);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('saving a note an accepted share opened', () => {
  it('seals under the share key when only the inbox holds it (a fresh browser)', async () => {
    await withCache();
    inboxEntry.mockReturnValue(shareOfNote());

    await notes.notesStore.updateNote(NOTE, { title: 'Reply' });
    expect(sealedWith).toEqual([7]);
  });

  it('seals under the share key when the sync cached it as opened by the share', async () => {
    await withCache(cachedNote({ foreignOwner: true, openedVia: 'share', wrappedContentKey: 'their-wrap' }));
    inboxEntry.mockReturnValue(shareOfNote());

    await notes.notesStore.updateNote(NOTE, { title: 'Reply' });
    expect(sealedWith).toEqual([7]);
  });
});

describe('the sync', () => {
  const row = (userId: string, wrap: string | null) => ({
    id: NOTE, user_id: userId, item_type: 1,
    encrypted_content: JSON.stringify({ title: 'Server copy' }), content_nonce: 'n', version: 5,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-04T00:00:00Z',
    deleted: false, circle_id: null, content_size: 1,
    wrapped_content_key: wrap, wrapped_content_key_nonce: wrap ? 'w-n' : null,
  });
  const pull = (...items: unknown[]) =>
    apiRequest.mockResolvedValue({ success: true, data: { items, cursor: null, cursor_id: null, has_more: false } });

  it('never opens a row the server names as ours with a share key, under any spelling of our id', async () => {
    await withCache();
    inboxEntry.mockReturnValue(shareOfNote());
    pull(row(ME.toUpperCase(), 'reset-era-wrap'));

    await notes.notesStore.sync();

    expect(openedWithKey).not.toContain(7);
    expect(notes.notesStore.notes().find(n => n.id === NOTE)).toBeUndefined();
    expect(notes.notesStore.lockedOwnIds().has(NOTE)).toBe(true);
  });

  it('marks a row its vault opened as ours, whatever user_id it carries', async () => {
    openable.add('own-wrap');
    await withCache();
    inboxEntry.mockReturnValue(undefined);
    pull(row(SENDER, 'own-wrap'));

    await notes.notesStore.sync();

    const n = notes.notesStore.notes().find(x => x.id === NOTE)!;
    expect(n.openedVia).toBe('vault');
    expect(n.foreignOwner).toBe(false);
  });

  it('never stamps an own note foreign, and never evicts it when the share leaves the inbox', async () => {
    openable.add('own-wrap');
    await withCache(cachedNote());
    inboxEntry.mockReturnValue(shareOfNote());
    pull();
    await notes.notesStore.sync();
    expect(notes.notesStore.notes().find(n => n.id === NOTE)?.foreignOwner).toBe(false);

    inboxEntry.mockReturnValue(undefined);
    await notes.notesStore.sync();
    expect(notes.notesStore.notes().find(n => n.id === NOTE)).toBeDefined();
    expect(noteDb.removeNote).not.toHaveBeenCalled();
  });
});

describe('the own-note check the inbox asks', () => {
  it('answers for any spelling of a note this browser opened with its vault, and not for a share\'s', async () => {
    openable.add('own-wrap');
    await withCache(cachedNote(), cachedNote({ id: THEIRS_ID, foreignOwner: true, openedVia: 'share', wrappedContentKey: 'their-wrap' }));
    const { isOwnNote } = await import('../lib/ownNotes');
    expect(isOwnNote(NOTE)).toBe(true);
    expect(isOwnNote(NOTE.toUpperCase())).toBe(true);
    expect(isOwnNote(NOTE.replace(/-/g, ''))).toBe(true);
    expect(isOwnNote(THEIRS_ID)).toBe(false);
    expect(isOwnNote('not-an-id')).toBe(false);
  });
});

/**
 * The search for the note is a lookup (lib/listIndex; with 10,000 shares
 * and 1,000 notes a walk would cost 26 s of every sync). This is a trust
 * check: each test here is about an answer that must not go stale.
 */
describe('the own-note check is asked of the list as it is now', () => {
  it('a note is own from the moment it is in the list, and not once it has left', async () => {
    openable.add('own-wrap');
    const { isOwnNote } = await import('../lib/ownNotes');
    // Asked of the empty list first: that answer is not the one kept.
    expect(isOwnNote(NOTE)).toBe(false);
    await withCache(cachedNote());
    expect(isOwnNote(NOTE)).toBe(true);
    expect(isOwnNote(NOTE.toUpperCase())).toBe(true);
    notes.notesStore.permanentlyDelete(NOTE);
    expect(isOwnNote(NOTE)).toBe(false);
    expect(isOwnNote(NOTE.toUpperCase())).toBe(false);
  });

  it('how the note was opened is asked each time: the same list, another answer once the vault opens it', async () => {
    // A wrap the vault cannot open yet: neither can be told, so it is not "own".
    await withCache(cachedNote());
    const { isOwnNote } = await import('../lib/ownNotes');
    expect(isOwnNote(NOTE)).toBe(false);
    openable.add('own-wrap');
    expect(isOwnNote(NOTE)).toBe(true);
    openable.clear();
    expect(isOwnNote(NOTE)).toBe(false);
  });

  it('a note replaced in the list is judged as it is now', async () => {
    openable.add('own-wrap');
    await withCache(cachedNote({ openedVia: 'vault' }));
    const { isOwnNote } = await import('../lib/ownNotes');
    expect(isOwnNote(NOTE)).toBe(true);
    notes.notesStore.applyLocalPatch({ ...notes.notesStore.notes()[0], openedVia: 'share' });
    expect(isOwnNote(NOTE)).toBe(false);
    notes.notesStore.applyLocalPatch({ ...notes.notesStore.notes()[0], openedVia: 'vault' });
    expect(isOwnNote(NOTE)).toBe(true);
  });

  it('of two rows whose ids are one id spelled twice, the first decides, as when the list was walked', async () => {
    openable.add('own-wrap');
    await withCache(
      cachedNote({ id: NOTE.toUpperCase(), openedVia: 'share', foreignOwner: true }),
      cachedNote({ openedVia: 'vault' }),
    );
    const { isOwnNote } = await import('../lib/ownNotes');
    const walked = notes.notesStore.notes().find(x => x.id.toLowerCase() === NOTE)!;
    expect(walked.openedVia).toBe('share');
    expect(isOwnNote(NOTE)).toBe(false);
  });

  it('a row whose id is no id is nobody\'s note, and does not hide the ones after it', async () => {
    openable.add('own-wrap');
    await withCache(cachedNote({ id: 'not-an-id', openedVia: 'vault' }), cachedNote({ openedVia: 'vault' }));
    const { isOwnNote } = await import('../lib/ownNotes');
    expect(isOwnNote('not-an-id')).toBe(false);
    expect(isOwnNote(NOTE)).toBe(true);
  });
});

describe('a cache an older build wrote', () => {
  it('never evicts a note its vault opens, even one an older build stamped foreign', async () => {
    openable.add('own-wrap');
    await withCache(cachedNote({ foreignOwner: true }));
    inboxEntry.mockReturnValue(undefined);
    apiRequest.mockResolvedValue({ success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } });

    await notes.notesStore.sync();

    expect(notes.notesStore.notes().find(n => n.id === NOTE)).toBeDefined();
    expect(noteDb.removeNote).not.toHaveBeenCalled();
  });
});

describe('the live-collab key', () => {
  it('is the note\'s own key for a note its vault opened, whatever the inbox holds', () => {
    openable.add('own-wrap');
    const own = cachedNote() as unknown as import('./notes').NoteItem;
    expect(notes.collabKeyFor(own, shareOfNote())?.[0]).toBe(1);
  });

  it('is the share\'s key for a note the share opened', () => {
    const theirs = shareOfNote().note as unknown as import('./notes').NoteItem;
    expect(notes.collabKeyFor(theirs, shareOfNote())?.[0]).toBe(7);
  });

  it('is nothing for an own note its vault can\'t open, never the share\'s', () => {
    const locked = cachedNote({ wrappedContentKey: 'reset-era-wrap' }) as unknown as import('./notes').NoteItem;
    expect(notes.collabKeyFor(locked, shareOfNote())).toBeNull();
  });
});

describe('openedWith', () => {
  it('reads the mark, else decides from the key the note holds, never from a stamp', () => {
    openable.add('own-wrap');
    const n = (over: Record<string, unknown>) => cachedNote(over) as unknown as import('./notes').NoteItem;
    expect(notes.openedWith(n({ openedVia: 'share' }))).toBe('share');
    expect(notes.openedWith(n({}))).toBe('vault');
    expect(notes.openedWith(n({ foreignOwner: true }))).toBe('vault');
    expect(notes.openedWith(n({ wrappedContentKey: null, wrappedContentKeyNonce: null }))).toBe('vault');
    // A foreign stamp in a cache written by an older version was the server's
    // word about user_id, so it is ignored.
    expect(notes.openedWith(n({ wrappedContentKey: null, wrappedContentKeyNonce: null, foreignOwner: true }))).toBe('vault');
    expect(notes.openedWith(n({ wrappedContentKey: 'their-wrap', foreignOwner: true }))).toBeNull();
    expect(notes.openedWith(n({ wrappedContentKey: 'their-wrap', foreignOwner: false }))).toBeNull();
  });
});

describe('a cache an older build wrote, with a stamp the server could have planted', () => {
  it('never seals a stamped note whose wrap does not open under a served share\'s key: the save is refused', async () => {
    await withCache(cachedNote({ wrappedContentKey: 'their-wrap', foreignOwner: true }));
    inboxEntry.mockReturnValue(shareOfNote());

    expect(await notes.notesStore.updateNote(NOTE, { title: 'Edited' })).toBe(false);
    expect(sealedWith).toEqual([]);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(notes.notesStore.keyRefusedIds().has(NOTE)).toBe(true);
    const n = notes.notesStore.notes().find(x => x.id === NOTE)!;
    expect(notes.collabKeyFor(n, shareOfNote())).toBeNull();
  });

  it('keeps a legacy own note (no wrap) its own, stamped or not: a served share of it is refused and never used', async () => {
    await withCache(cachedNote({ wrappedContentKey: null, wrappedContentKeyNonce: null, foreignOwner: true }));
    const { isOwnNote } = await import('../lib/ownNotes');
    expect(isOwnNote(NOTE)).toBe(true);
    inboxEntry.mockReturnValue(shareOfNote());

    await notes.notesStore.updateNote(NOTE, { title: 'Edited' });
    expect(sealedWith).not.toContain(7);
    const n = notes.notesStore.notes().find(x => x.id === NOTE)!;
    expect(notes.collabKeyFor(n, shareOfNote())?.[0]).not.toBe(7);
  });
});
