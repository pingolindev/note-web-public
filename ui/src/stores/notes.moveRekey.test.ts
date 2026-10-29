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

// The signed-in account, as /auth/me names it (canonical, as the store compares).
const { ME, order } = vi.hoisted(() => ({
  ME: '0e0e0e0e-0000-4000-8000-00000000000e',
  order: [] as string[],
}));

/**
 * Moving a note out of a shared notebook revokes the dropped members with a
 * delete-only unshare and rotates AFTER that. The attachments the rotation
 * may bring forward must therefore be listed before anyone is dropped: a list
 * read after the unshare could hold a file the removed member put there, under
 * the key they still hold, and the re-key would present it as the owner's.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));

const ROWS = [{ id: 'att-1', encrypted_meta: 'm', meta_nonce: 'n', size_bytes: 10 }];
const listAttachmentsForRekey = vi.fn(async () => { order.push('list'); return ROWS; });
vi.mock('../lib/attachmentUpload', () => ({
  listAttachmentsForRekey: (...a: unknown[]) => listAttachmentsForRekey(...(a as [])),
}));

const rotateContentKey = vi.fn(async () => { order.push('rotate'); return { rotated: true }; });
const unshareNoteWithRecipient = vi.fn(async () => { order.push('unshare'); return true; });
const shareNoteWithRecipientResult = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
/** What the server has for a notebook, as the store asks it (default: an item). */
const notebookItemState = vi.fn(async (_id: string | null | undefined): Promise<'item' | 'none' | 'unknown'> => 'item');
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: (...a: unknown[]) => shareNoteWithRecipientResult(...a),
  unshareNoteWithRecipient: (...a: unknown[]) => unshareNoteWithRecipient(...(a as [])),
  rotateContentKey: (...a: unknown[]) => rotateContentKey(...(a as [])),
}));
vi.mock('../lib/recipientKeys', async () => {
  const real = await vi.importActual<typeof import('../lib/recipientKeys')>('../lib/recipientKeys');
  return { ...real, lookupDirectoryKeys: async () => null };
});

const STANDING = [{
  email: 'ben@example.test', permission: 'edit' as const,
  publicKey: 'aa'.repeat(32), userId: 'ben-id', signingPublicKey: 'bb'.repeat(32),
}];
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => true, learnNotebookItem: async () => true,
    notebookItemState: (id: string | null | undefined) => notebookItemState(id),
    getNotebookShares: (id: string) => (id === 'nb' ? STANDING : []),
    notebooks: () => [{ id: 'nb', name: 'Wedding', noteCount: 0 }, { id: 'quiet', name: 'Mine', noteCount: 0 }],
    membersOf: () => [],
    loadFromSyncedItems: () => {},
    gcEditorModes: () => {},
    markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
    pruneAcceptances: async () => {}, rememberAcceptances: () => {},
  },
}));
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: () => undefined,
    load: async () => true,
    sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {},
    applyLocalEdit: () => {},
  },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => [],
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
}));

let notesStore: typeof import('./notes').notesStore;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  order.length = 0;
  notebookItemState.mockImplementation(async () => 'item');
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: { id?: string; notebook_id?: string | null } }) => {
    if (url === '/api/v1/items' && opts?.method === 'POST') {
      return { success: true, data: { id: opts.body?.id, version: 1, created_at: 't', updated_at: 't' } };
    }
    if (url.startsWith('/api/v1/items/') && opts?.method === 'PUT') {
      // As the server answers an update: the item, its notebook column included.
      return { success: true, data: { version: 2, updated_at: 't2', notebook_id: opts.body?.notebook_id ?? null } };
    }
    return { success: false, status: 404 };
  });
  ({ notesStore } = await import('./notes'));
});

async function aNoteIn(notebookId: string | null): Promise<string> {
  await notesStore.createNote({ title: 'Seating plan', notebookId });
  const note = notesStore.notes().find(n => n.title === 'Seating plan');
  expect(note, 'the note was created').toBeTruthy();
  order.length = 0;
  return note!.id;
}

describe('moving a note out of a shared notebook', () => {
  it('lists its attachments BEFORE the first unshare, and hands exactly those to the rotation', async () => {
    const id = await aNoteIn('nb');
    expect(await notesStore.updateNote(id, { notebookId: 'quiet' })).toBe(true);

    expect(order).toEqual(['list', 'unshare', 'rotate']);
    expect(listAttachmentsForRekey).toHaveBeenCalledWith(id);
    expect(rotateContentKey).toHaveBeenCalledTimes(1);
    expect(rotateContentKey.mock.calls[0]).toEqual([id, [], undefined, { attachmentsListedBefore: ROWS }]);
  });

  it('hands over a failed listing as null, so nothing is listed after the removal', async () => {
    listAttachmentsForRekey.mockImplementationOnce(async () => { order.push('list'); return null as never; });
    const id = await aNoteIn('nb');
    await notesStore.updateNote(id, { notebookId: 'quiet' });

    expect(order).toEqual(['list', 'unshare', 'rotate']);
    expect(rotateContentKey.mock.calls[0]).toEqual([id, [], undefined, { attachmentsListedBefore: null }]);
  });

  it('lists nothing when nobody is dropped', async () => {
    const id = await aNoteIn('quiet');
    await notesStore.updateNote(id, { notebookId: 'nb' });

    expect(listAttachmentsForRekey).not.toHaveBeenCalled();
    expect(unshareNoteWithRecipient).not.toHaveBeenCalled();
    expect(rotateContentKey).not.toHaveBeenCalled();
  });
});

/**
 * For a MOVE: the server could not be asked whether the notebook exists as
 * an item. Saved anyway, the note's row would not name the notebook, and
 * the move's own sharing would hand the note, live, to a reader who had
 * declined that notebook. It waits instead.
 */
describe('moving a note into a shared notebook the server could not be asked about', () => {
  const puts = () => apiRequest.mock.calls.filter(c => String(c[0]).startsWith('/api/v1/items/') && c[1]?.method === 'PUT');

  it('is not saved and not shared: the move waits, and the page shows it as it will be', async () => {
    const id = await aNoteIn('quiet');
    shareNoteWithRecipientResult.mockClear();
    notebookItemState.mockImplementation(async () => 'unknown');

    expect(await notesStore.updateNote(id, { notebookId: 'nb' })).toBe(false);

    expect(puts()).toEqual([]);
    expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
    expect(notesStore.notes().find(n => n.id === id)!.notebookId).toBe('nb');
    // Asked once more before it waits.
    expect(notebookItemState.mock.calls.filter(c => c[0] === 'nb')).toHaveLength(2);
  });

  it('with an answer the second time, it is saved with its notebook and shared (the control)', async () => {
    const id = await aNoteIn('quiet');
    shareNoteWithRecipientResult.mockClear();
    notebookItemState.mockImplementationOnce(async () => 'unknown').mockImplementation(async () => 'item');

    expect(await notesStore.updateNote(id, { notebookId: 'nb' })).toBe(true);

    expect(puts().map(c => (c[1] as { body: { notebook_id?: string | null } }).body.notebook_id)).toEqual(['nb']);
    expect(shareNoteWithRecipientResult).toHaveBeenCalledTimes(1);
  });

  /**
   * A notebook that goes to nobody has nobody to leak to: saved at once. The
   * row cannot name a notebook the server did not vouch for, and it must not
   * go on naming the one the note has LEFT: the server goes by the row, and
   * would keep such a note away from a reader who had declined the old
   * notebook even when its owner later shares it with them by itself.
   * So `null`.
   */
  it('a move into a notebook shared with nobody does not wait, and takes the OLD notebook off the row', async () => {
    const id = await aNoteIn('nb');
    notebookItemState.mockImplementation(async () => 'unknown');

    expect(await notesStore.updateNote(id, { notebookId: 'quiet' })).toBe(true);

    const body = (puts()[0][1] as { body: Record<string, unknown> }).body;
    expect('notebook_id' in body).toBe(true);
    expect(body.notebook_id).toBeNull();
  });

  it('so does a move into a notebook the server has no item for', async () => {
    const id = await aNoteIn('nb');
    notebookItemState.mockImplementation(async () => 'none');

    expect(await notesStore.updateNote(id, { notebookId: 'quiet' })).toBe(true);

    const body = (puts()[0][1] as { body: Record<string, unknown> }).body;
    expect(body.notebook_id).toBeNull();
    expect('notebook_id' in body).toBe(true);
  });

  it('a move into a notebook the server does have is named, as ever', async () => {
    const id = await aNoteIn('nb');
    notebookItemState.mockImplementation(async () => 'item');

    expect(await notesStore.updateNote(id, { notebookId: 'quiet' })).toBe(true);

    expect((puts()[0][1] as { body: Record<string, unknown> }).body.notebook_id).toBe('quiet');
  });

  /** Not a move: whatever the row says is still right, and `null` would take a correct notebook off it. */
  it('an edit of a note in a notebook the server has no item for leaves the column alone', async () => {
    const id = await aNoteIn('quiet');
    notebookItemState.mockImplementation(async () => 'none');

    expect(await notesStore.updateNote(id, { title: 'Renamed' })).toBe(true);

    expect('notebook_id' in (puts()[0][1] as { body: Record<string, unknown> }).body).toBe(false);
  });

  /** An edit that moves nothing is saved too: no sharing follows an edit. */
  it('an edit of a note already in the shared notebook is saved, the column left alone', async () => {
    const id = await aNoteIn('nb');
    shareNoteWithRecipientResult.mockClear();
    notebookItemState.mockImplementation(async () => 'unknown');

    expect(await notesStore.updateNote(id, { title: 'Seating plan, v2' })).toBe(true);

    const body = (puts()[0][1] as { body: Record<string, unknown> }).body;
    expect('notebook_id' in body).toBe(false);
    expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
  });
});
