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
 * A removal tried again after a 409 is applied at the version the server has
 * NOW, a version this page had not read: someone changed the note in between.
 * Patching the card with that version and its OWN words, the words from
 * before the change, would let the next save from this page be accepted over
 * it, with no conflict copy. So the note is taken as the server has it.
 */

const { ME } = vi.hoisted(() => ({ ME: '0e0e0e0e-0000-4000-8000-00000000000e' }));

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

// Ciphertext IS the plaintext: encrypt returns the JSON, decrypt returns it back.
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap', nonce: 'wrapn' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
  wrapContentKeyForRecipient: () => 'sealed',
  getSharingPublicKeyHex: () => 'my-pub',
  allowSealToRecipient: () => true,
  vaultKeyThatOpens: () => new Uint8Array(32).fill(1),
}));
vi.mock('../lib/keyOps', () => ({ canSign: () => true, signShareWrap: async () => 'sig' }));
vi.mock('../lib/attachmentUpload', () => ({
  listAttachmentsForRekey: async () => [],
  rekeyNoteAttachments: async () => ({ rekeyed: 0, failed: 0 }),
}));
vi.mock('../lib/retainedKeys', () => ({ retain: () => {} }));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));
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
const cached: unknown[] = [];
vi.mock('../lib/noteDb', () => ({
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
}));

const NOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];

let notesStore: typeof import('./notes').notesStore;
let rotateContentKey: typeof import('../lib/shareUtils').rotateContentKey;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  cached.length = 0;
  // This page's copy: version 3, the words as they were before Bob's edit.
  cached.push({
    id: NOTE, title: 'Shopping', body: 'milk', noteType: 'text', color: null,
    isPinned: false, isArchived: false, labels: [], sortOrder: 0, editMode: 'rich',
    notebookId: null, hasAttachments: false, version: 3, contentKeyGeneration: 1,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', deleted: false,
    wrappedContentKey: 'wrap', wrappedContentKeyNonce: 'wrapn', foreignOwner: false,
  });
  ({ notesStore } = await import('./notes'));
  ({ rotateContentKey } = await import('../lib/shareUtils'));
  await notesStore.hydrateFromCache();
});


/**
 * The server: Bob (an editor) changed the words since this page read the note
 * (its version 4; this page has 3). A rotation re-encrypts what it read from
 * the server, so Bob's words survive there. With `readsFailAfterTheRotation`,
 * the note cannot be read from the rotation until the next save.
 */
function server({ readsFailAfterTheRotation = false } = {}) {
  const s = { version: 4, doc: { title: 'Shopping', body: 'milk, eggs (Bob)' } as Record<string, unknown>, failReads: false };
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
    calls.push(c);
    if (c.method === 'GET' && url === `/api/v1/items/${NOTE}`) {
      if (s.failReads) return { success: false, error: 'Network error' };
      return { success: true, data: {
        id: NOTE, user_id: ME, item_type: 1, encrypted_content: JSON.stringify(s.doc), content_nonce: 'n',
        version: s.version, content_key_generation: 1, wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn',
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-06T00:00:00Z', deleted: false,
      } };
    }
    if (url === `/api/v1/items/${NOTE}/shares`) {
      return { success: true, data: [
        { id: 's-carol', recipient_email: 'carol@example.test', permission: 'view', has_wrap: true },
        { id: 's-bob', recipient_email: 'bob@example.test', permission: 'edit', has_wrap: true },
      ] };
    }
    if (url === '/api/v1/users/public-keys') {
      return { success: true, data: { users: [{ email: 'bob@example.test', user_id: 'u-bob', sharing_public_key: 'pk', signing_public_key: 'sk' }] } };
    }
    if (url === `/api/v1/items/${NOTE}/rotate-shares`) {
      if (c.body.expected_version !== s.version) return { success: false, status: 409, error: 'conflict' };
      s.doc = JSON.parse(c.body.encrypted_content);
      s.version += 1;
      if (readsFailAfterTheRotation) s.failReads = true;
      return { success: true, data: { version: s.version, content_key_generation: 2 } };
    }
    if (c.method === 'PUT' && url === `/api/v1/items/${NOTE}`) {
      s.failReads = false;
      if (c.body.expected_version !== s.version) return { success: false, status: 409, error_code: 'item_version_conflict', error: 'conflict' };
      s.doc = JSON.parse(c.body.encrypted_content);
      s.version += 1;
      return { success: true, data: { version: s.version, updated_at: '2026-09-07T00:00:00Z' } };
    }
    if (c.method === 'POST' && url === '/api/v1/items') {
      return { success: true, data: { id: c.body.id, version: 1, updated_at: '2026-09-07T00:00:00Z', created_at: '2026-09-07T00:00:00Z' } };
    }
    if (url.startsWith('/api/v1/sync/pull')) return { success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } };
    return { success: true, data: [] };
  });
  return s;
}

const card = () => notesStore.notes().find(n => n.id === NOTE)! as unknown as { version: number; body: string; title: string };
const conflictCopies = () => calls.filter(c => c.method === 'POST' && c.url === '/api/v1/items');
const rotations = () => calls.filter(c => c.url === `/api/v1/items/${NOTE}/rotate-shares`);

describe('a removal tried again after a 409', () => {
  it('takes the note as the server has it: the change that caused the 409 is kept, and the next save goes on from it', async () => {
    const s = server();
    // The owner removes Carol in the Share panel (SharePanel.handleRemoveShare).
    const r = await rotateContentKey(NOTE, ['s-carol']);
    expect(r.rotated).toBe(true);
    expect(rotations().map(c => c.body.expected_version)).toEqual([3, 4]);
    // Bob's words, at the server's version, not this page's words at it.
    expect({ version: card().version, body: card().body }).toEqual({ version: 5, body: 'milk, eggs (Bob)' });

    await notesStore.updateNote(NOTE, { title: 'Shopping list' });
    expect(s.doc).toMatchObject({ title: 'Shopping list', body: 'milk, eggs (Bob)' });
    expect(conflictCopies()).toEqual([]);
  });

  it('the server\'s copy not read just then: the card keeps its own version, so its next save meets the 409 and Bob\'s words are kept', async () => {
    const s = server({ readsFailAfterTheRotation: true });
    const r = await rotateContentKey(NOTE, ['s-carol']);
    expect(r.rotated).toBe(true);
    // Never the new version with the old words.
    expect({ version: card().version, body: card().body }).toEqual({ version: 3, body: 'milk' });

    await notesStore.updateNote(NOTE, { title: 'Shopping list' });
    const saves = calls.filter(c => c.method === 'PUT' && c.url === `/api/v1/items/${NOTE}`);
    expect(saves[0]?.body.expected_version).toBe(3);
    expect(s.doc.body === 'milk, eggs (Bob)' || conflictCopies().length > 0).toBe(true);
  });

  it('applied at the version this page has (no retry): the card takes the new version and key as before, and nothing more is read', async () => {
    const s = server();
    s.version = 3;
    s.doc = { title: 'Shopping', body: 'milk' };
    const r = await rotateContentKey(NOTE, ['s-carol']);
    expect(r.rotated).toBe(true);
    expect(rotations().map(c => c.body.expected_version)).toEqual([3]);
    // The rotation's own read of what it re-encrypts, and no other.
    expect(calls.filter(c => c.method === 'GET' && c.url === `/api/v1/items/${NOTE}`)).toHaveLength(rotations().length);
    expect({ version: card().version, body: card().body }).toEqual({ version: 4, body: 'milk' });
  });
});
