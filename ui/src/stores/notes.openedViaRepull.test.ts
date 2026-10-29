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

const { ME, markPulled, holds } = vi.hoisted(() => ({
  ME: '0e0e0e0e-0000-4000-8000-00000000000e',
  markPulled: vi.fn(),
  /** The notebooks store's holds gate, as a test sets it. */
  holds: { ready: Promise.resolve() as Promise<void> },
}));

/**
 * A row cached by an older build carries no openedVia, and the foreign
 * stamp it may carry was the server's word. So once per account the sync
 * pulls in FULL, and every row it opens is marked with the key that opened
 * it. The mark is stored only after a pull that reached its last page, and
 * only while this tab owns the cache.
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
    loadFromSyncedItems: () => {}, gcEditorModes: () => {}, markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => markPulled(), whenHoldsReady: () => holds.ready,
    pruneAcceptances: async () => {}, rememberAcceptances: () => {},
  },
}));
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: { getByItemId: () => undefined, load: async () => true, sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {}, applyLocalEdit: () => {} },
}));
/** Who the shared cache belongs to (ownsSharedCache): us, unless a test says otherwise. */
let cacheOwner = ME;
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => cacheOwner,
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

const NOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MARK = `pingolin_note_opened_via_pulled.${ME}`;
const FULL = `since=${encodeURIComponent('1970-01-01T00:00:00Z')}`;

const row = (id: string, userId: string, wrap: string) => ({
  id, user_id: userId, item_type: 1,
  encrypted_content: JSON.stringify({ title: id }), content_nonce: 'n', version: 2,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
  deleted: false, circle_id: null, content_size: 1,
  wrapped_content_key: wrap, wrapped_content_key_nonce: 'w-n',
});
const page = (items: unknown[], hasMore = false) =>
  ({ success: true, data: { items, cursor: '2026-09-25T00:00:00Z', cursor_id: NOTE, has_more: hasMore } });
const pulls = () => apiRequest.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/v1/sync/pull'));

let local: Storage;
let notesStore: typeof import('./notes').notesStore;

async function boot() {
  vi.resetModules();
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
}

beforeEach(() => {
  local = memoryStorage();
  vi.stubGlobal('localStorage', local);
  openable.clear();
  cacheOwner = ME;
  // A browser that synced with an older build: a cursor, and a cached row
  // that build stamped foreign, with no openedVia.
  cursor = '2026-09-20T00:00:00Z';
  cachedRows = [{
    id: NOTE, title: 'Mine', body: '', noteType: 'text', color: null, isPinned: false, isArchived: false,
    labels: [], sortOrder: 0, editMode: 'rich', notebookId: null, hasAttachments: false, version: 1,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', deleted: false,
    wrappedContentKey: 'old-wrap', wrappedContentKeyNonce: 'o-n', foreignOwner: true,
  }];
  apiRequest.mockReset();
  markPulled.mockReset();
  holds.ready = Promise.resolve();
});
afterEach(() => vi.unstubAllGlobals());

describe('the one-time full pull that marks how each row was opened', () => {
  it('pulls in full once, marks the account, and pulls from the cursor after that', async () => {
    apiRequest.mockResolvedValue(page([]));
    await boot();
    await notesStore.sync();
    expect(pulls()[0]).toContain(FULL);
    expect(pulls()[0]).not.toContain('since_id');
    expect(local.getItem(MARK)).toBe('1');

    apiRequest.mockClear();
    await boot();
    await notesStore.sync();
    expect(pulls()[0]).not.toContain(FULL);
  });

  it('gives each row it opens the key that opened it, not the old stamp', async () => {
    // The server's row now carries a wrap our vault opens (e.g. our own key,
    // rotated since that cache was written).
    openable.add('own-wrap');
    apiRequest.mockResolvedValue(page([row(NOTE, OTHER, 'own-wrap')]));
    await boot();
    await notesStore.sync();
    const n = notesStore.notes().find(x => x.id === NOTE)!;
    expect(n.openedVia).toBe('vault');
    expect(n.foreignOwner).toBe(false);
  });

  it('leaves the mark unset when the pull fails part-way, so the next sync pulls in full again', async () => {
    apiRequest.mockResolvedValueOnce(page([row(NOTE, ME, 'old-wrap')], true))
      .mockResolvedValueOnce({ success: false, status: 503 });
    await boot();
    await notesStore.sync();
    expect(local.getItem(MARK)).toBeNull();

    apiRequest.mockReset();
    apiRequest.mockResolvedValue(page([]));
    await boot();
    await notesStore.sync();
    expect(pulls()[0]).toContain(FULL);
    expect(local.getItem(MARK)).toBe('1');
  });

  it('stores no mark while this tab does not own the cache', async () => {
    cacheOwner = OTHER;
    apiRequest.mockResolvedValue(page([]));
    await boot();
    await notesStore.sync();
    expect(pulls()[0]).toContain(FULL);
    expect(local.getItem(MARK)).toBeNull();
  });

  it('pulls in full at most once per page load when storage cannot keep the mark', async () => {
    const setItem = local.setItem.bind(local);
    local.setItem = (k: string, v: string) => {
      if (k === MARK) throw new Error('QuotaExceededError');
      setItem(k, v);
    };
    apiRequest.mockResolvedValue(page([]));
    await boot();
    await notesStore.sync();
    expect(local.getItem(MARK)).toBeNull();

    apiRequest.mockClear();
    await notesStore.sync();
    expect(pulls()[0]).not.toContain(FULL);
  });
});

describe('a finished pull tells the notebooks store', () => {
  // With no merge base, the notebooks store builds no write until this session
  // has pulled; this is the only place it learns that it has.
  it('after every pull that reached its last page', async () => {
    apiRequest.mockResolvedValue(page([]));
    await boot();
    await notesStore.sync();
    expect(markPulled).toHaveBeenCalledTimes(1);
  });

  it('not after a pull that failed part-way', async () => {
    apiRequest.mockResolvedValueOnce(page([row(NOTE, ME, 'old-wrap')], true))
      .mockResolvedValueOnce({ success: false, status: 503 });
    await boot();
    await notesStore.sync();
    expect(markPulled).not.toHaveBeenCalled();
  });
});

describe('the sync and the holds gate', () => {
  it('asks for no page until the removal holds are in place', async () => {
    let open!: () => void;
    holds.ready = new Promise<void>(r => { open = r; });
    apiRequest.mockResolvedValue(page([]));
    await boot();

    const syncing = notesStore.sync();
    await new Promise(r => setTimeout(r, 20));
    expect(pulls()).toEqual([]);

    open();
    await syncing;
    expect(pulls().length).toBeGreaterThan(0);
  });
});
