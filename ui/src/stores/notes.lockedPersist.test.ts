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

// The signed-in account, as /auth/me names it: a canonical id (ids are
// compared canonically, so a made-up 'me' matches nothing).
const { ME } = vi.hoisted(() => ({ ME: '0e0e0e0e-0000-4000-8000-00000000000e' }));

/**
 * The "notes from before your password reset are locked" banner survives a
 * reload, and recovering the old identity brings the notes back.
 *
 * WHY
 *   The incremental pull never returns a note that has not changed. On a
 *   browser that first opened the account after its reset, the locked notes
 *   fail exactly once — on the first full pull — so an in-memory count would
 *   forget them at the next reload and the banner would disappear after one
 *   visit. And after the recovery key restores the old identity, those notes
 *   would stay missing until a full re-sync unless something pulls them again.
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
let identities = 0;
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => identities }));
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: vi.fn(async () => ({ ok: true })),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => false, learnNotebookItem: async () => false, notebookItemState: async () => 'none', getNotebookShares: () => [], notebooks: () => [], membersOf: () => [],
    loadFromSyncedItems: () => {}, gcEditorModes: () => {}, markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
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
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => [],
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

const row = (id: string, wrap: string) => ({
  id, user_id: ME, item_type: 1,
  encrypted_content: JSON.stringify({ title: id }), content_nonce: 'n', version: 1,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  deleted: false, circle_id: null, content_size: 1,
  wrapped_content_key: wrap, wrapped_content_key_nonce: 'w-n',
});

let local: Storage;
let notesStore: typeof import('./notes').notesStore;

async function boot() {
  vi.resetModules();
  // Per-account data is kept under the tab's confirmed account.
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
}

beforeEach(async () => {
  local = memoryStorage();
  vi.stubGlobal('localStorage', local);
  openable.clear();
  identities = 0;
  cursor = null;
  apiRequest.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('locked own notes', () => {
  it('stay counted across a reload, though the incremental pull never returns them', async () => {
    apiRequest.mockResolvedValue({ success: true, data: { items: [row('old-1', 'era-1'), row('old-2', 'era-1')], cursor: '2026-09-23T00:00:00Z', cursor_id: 'old-2', has_more: false } });
    await boot();
    await notesStore.sync();
    expect(notesStore.lockedOwnIds().size).toBe(2);

    // Reload: a cursor now, and the pull has nothing new.
    apiRequest.mockResolvedValue({ success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } });
    await boot();
    await notesStore.sync();
    expect([...notesStore.lockedOwnIds()].sort()).toEqual(['old-1', 'old-2']);
  });

  it('come back after the recovery key restores their identity: one full re-pull', async () => {
    apiRequest.mockResolvedValue({ success: true, data: { items: [row('old-1', 'era-1')], cursor: '2026-09-23T00:00:00Z', cursor_id: 'old-1', has_more: false } });
    await boot();
    await notesStore.sync();
    expect(notesStore.lockedOwnIds().size).toBe(1);

    // The portal recovered the old identity; its vault key now opens the note.
    identities = 1;
    openable.add('era-1');
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ success: true, data: { items: [row('old-1', 'era-1')], cursor: '2026-09-23T00:00:00Z', cursor_id: 'old-1', has_more: false } });
    await boot();
    await notesStore.sync();

    const firstPull = apiRequest.mock.calls.find(c => String(c[0]).startsWith('/api/v1/sync/pull'))![0] as string;
    expect(firstPull).toContain(`since=${encodeURIComponent('1970-01-01T00:00:00Z')}`);
    expect(notesStore.lockedOwnIds().size).toBe(0);
    expect(notesStore.notes().map(n => n.title)).toEqual(['old-1']);
    expect(local.getItem(`pingolin_note_prev_identities_seen.${ME}`)).toBe('1');

    // And only once: the next load is incremental again.
    apiRequest.mockClear();
    await boot();
    await notesStore.sync();
    const nextPull = apiRequest.mock.calls.find(c => String(c[0]).startsWith('/api/v1/sync/pull'))![0] as string;
    expect(nextPull).not.toContain(encodeURIComponent('1970-01-01T00:00:00Z'));
  });
});

describe('the persisted locked set belongs to one account', () => {
  it('ignores a set saved for a different account (no carry-over after an account switch)', async () => {
    local.setItem(`pingolin_note_locked_own.${ME}`, JSON.stringify({ owner: '0f0f0f0f-0000-4000-8000-00000000000f', ids: ['theirs-1', 'theirs-2'] }));
    apiRequest.mockResolvedValue({ success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } });
    await boot();
    await notesStore.sync();
    expect(notesStore.lockedOwnIds().size).toBe(0);
  });

  it('keeps a set tagged with another spelling of this account (ids compare canonically)', async () => {
    local.setItem(`pingolin_note_locked_own.${ME}`, JSON.stringify({ owner: ME.toUpperCase(), ids: ['mine-1'] }));
    apiRequest.mockResolvedValue({ success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } });
    await boot();
    await notesStore.sync();
    expect([...notesStore.lockedOwnIds()]).toEqual(['mine-1']);
  });
});
