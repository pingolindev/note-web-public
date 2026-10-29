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

const { ME, OTHER, NB, marks } = vi.hoisted(() => ({
  ME: '0e0e0e0e-0000-4000-8000-00000000000e',
  OTHER: '22222222-2222-4222-8222-222222222222',
  NB: '33333333-3333-4333-8333-333333333333',
  /** This page's pulls, as the notebooks store records them (markPulled / markFullyPulled). */
  marks: { any: false, full: false },
}));

/**
 * What makes a notebook's note list complete for a removal.
 *
 * A removal re-keys or revokes every note of the notebook. The list it takes
 * comes from memory only after a FULL pull of this session has read every
 * page: memory then holds every note that opens here, the trashed ones with
 * them (a pull has no `deleted` filter), and the pulled rows' server column
 * names the own notes that don't open. Before one there is no answer: the
 * cache memory starts from drops a trashed note, and a delta brings only what
 * changed.
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
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  // Only the wrap 'opens' opens here.
  unwrapContentKeyWithVault: (wrap: string) => (wrap === 'opens' ? new Uint8Array(32).fill(1) : null),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: () => { throw new Error('vault-direct decrypt fails in this file'); },
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: vi.fn(async () => ({ ok: true })),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => false, learnNotebookItem: async () => false, notebookItemState: async () => 'none', getNotebookShares: () => [], notebooks: () => [], membersOf: () => [],
    loadFromSyncedItems: () => {}, gcEditorModes: () => {}, markNotebookItemsComplete: () => {},
    markPulled: () => { marks.any = true; },
    markFullyPulled: () => { marks.full = true; },
    hasPulled: (full = false) => (full ? marks.full : marks.any),
    whenHoldsReady: async () => {},
    pruneAcceptances: async () => {}, rememberAcceptances: () => {},
  },
}));
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: { getByItemId: () => undefined, load: async () => true, sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {}, applyLocalEdit: () => {} },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
let cursor: string | null = null;
let cachedRows: unknown[] = [];
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => cachedRows,
  loadCursor: async () => cursor,
  loadCursorId: async () => null,
  putNote: vi.fn(async () => {}),
  putNotes: vi.fn(async () => {}),
  removeNote: vi.fn(async () => {}),
  queuePending: vi.fn(async () => {}),
  removePending: vi.fn(async () => {}),
  listPending: async () => [],
  getPending: async () => null,
  saveCursor: async (c: string) => { cursor = c; },
  saveCursorId: async () => {},
}));

const FULL = `since=${encodeURIComponent('1970-01-01T00:00:00Z')}`;
/** A pulled note row: its payload names `payloadNotebook`, its server column `column`. */
const row = (id: string, o: { owner?: string; wrap?: string; payloadNotebook?: string | null; column?: string | null; deleted?: boolean } = {}) => ({
  id, user_id: o.owner ?? ME, item_type: 1,
  encrypted_content: JSON.stringify({ title: id, notebook_id: o.payloadNotebook ?? null }), content_nonce: 'n', version: 2,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  deleted: o.deleted ?? false, circle_id: null, content_size: 1,
  wrapped_content_key: o.wrap ?? 'opens', wrapped_content_key_nonce: 'w-n',
  notebook_id: o.column ?? null,
});
const page = (items: unknown[], hasMore = false) =>
  ({ success: true, data: { items, cursor: '2026-10-01T00:00:00Z', cursor_id: 'c', has_more: hasMore } });
const pulls = () => apiRequest.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/v1/sync/pull'));

let notesStore: typeof import('./notes').notesStore;

/** A page load: a new session (no pull yet), memory from the cache. */
async function boot() {
  vi.resetModules();
  marks.any = false;
  marks.full = false;
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
}

beforeEach(() => {
  const local = memoryStorage();
  // This account had its one-time full pull on an earlier load: a sync here pulls from the cursor.
  local.setItem(`pingolin_note_opened_via_pulled.${ME}`, '1');
  vi.stubGlobal('localStorage', local);
  cursor = '2026-09-30T00:00:00Z';
  // The cache a reload starts from: the live note only. The trashed one was dropped from it (notes.ts sync).
  cachedRows = [{
    id: 'n1', title: 'n1', body: '', noteType: 'text', color: null, isPinned: false, isArchived: false,
    labels: [], sortOrder: 0, editMode: 'rich', notebookId: NB, hasAttachments: false, version: 2,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deleted: false,
    wrappedContentKey: 'opens', wrappedContentKeyNonce: 'w-n', openedVia: 'vault',
  }];
  apiRequest.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

/** n1 live and n2 trashed, both of NB and both opening here (n2 by its payload only: written while the notebook
 *  had no item, so no column); n3 of NB by its column only, not opening here; n4 of another notebook; n5 someone
 *  else's with NB's column. Over two pages. */
const ACCOUNT = [
  [row('n1', { payloadNotebook: NB, column: NB }), row('n4', { payloadNotebook: 'another', column: 'another' })],
  [row('n2', { payloadNotebook: NB, column: null, deleted: true }), row('n3', { wrap: 'locked', column: NB }),
    row('n5', { owner: OTHER, wrap: 'locked', column: NB })],
];

describe("a notebook's whole note list, for a removal", () => {
  it('is not answered after an incremental pull, and the next sync is asked to pull in full', async () => {
    apiRequest.mockResolvedValue(page([]));
    await boot();
    await notesStore.sync();
    expect(pulls()[0]).not.toContain(FULL);
    expect(notesStore.notebookNoteIds(NB)).toBeNull();

    await vi.waitFor(() => expect(pulls().length).toBe(2));
    expect(pulls()[1]).toContain(FULL);
  });

  it('after a full pull that read every page: every own note of the notebook, the trash and the ones that do not open included, and no other', async () => {
    cursor = null;
    apiRequest.mockResolvedValueOnce(page(ACCOUNT[0], true)).mockResolvedValueOnce(page(ACCOUNT[1]));
    await boot();
    await notesStore.sync();

    expect(pulls()).toHaveLength(2);
    expect(pulls()[0]).toContain(FULL);
    expect(notesStore.notebookNoteIds(NB)?.sort()).toEqual(['n1', 'n2', 'n3']);
    // n2 is in memory as trashed, n3 not at all (it doesn't open): both come in, by payload and by column.
    expect(notesStore.notes().find(n => n.id === 'n2')?.deleted).toBe(true);
    expect(notesStore.notes().some(n => n.id === 'n3')).toBe(false);
  });

  it('is not answered after a full pull that failed part-way', async () => {
    cursor = null;
    apiRequest.mockResolvedValueOnce(page(ACCOUNT[0], true)).mockResolvedValueOnce({ success: false, status: 503 })
      .mockResolvedValue(page([]));
    await boot();
    await notesStore.sync();

    expect(notesStore.notebookNoteIds(NB)).toBeNull();
  });

  it('a full pull asked for by a removal brings back the trash the cache dropped', async () => {
    apiRequest.mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page(ACCOUNT[0], true)).mockResolvedValueOnce(page(ACCOUNT[1]));
    await boot();
    await notesStore.sync();
    expect(notesStore.notebookNoteIds(NB)).toBeNull(); // asks for the full pull

    await vi.waitFor(() => expect(notesStore.notebookNoteIds(NB)?.sort()).toEqual(['n1', 'n2', 'n3']));
    expect(pulls()[1]).toContain(FULL);
  });
});
