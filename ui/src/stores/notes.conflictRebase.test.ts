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
 * A version conflict forks ONCE, and a lost row is re-created, not dropped.
 *
 * WHY THESE EXIST
 *   After a 409 the store forks a "(conflict copy)". Left at the stale version
 *   it just lost with, the ORIGINAL's next edit would carry that same version,
 *   409, and fork again: one conflict copy per keystroke, until a sync pull
 *   happened to bring the row back. After a database restore that pull never
 *   comes — every device's cursor is ahead of the server — so the loop would
 *   run until the user gave up. So the original is re-based on the server's
 *   row (GET by id) before returning.
 *
 *   A 404 on the PUT means the server lost the row. Returning false would make
 *   the caller remove the queued edit as handled, and the text would be gone.
 *   So the note is re-created under the same id, as the restore pipeline does.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

// Ciphertext IS the plaintext in this file: encrypt returns the JSON, decrypt
// returns the ciphertext. The store's crypto is not what is under test.
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap', nonce: 'wrapn' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
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
const applyLocalEdit = vi.fn();
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: (id: string) => inboxEntry(id),
    load: async () => true,
    sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {},
    applyLocalEdit: (...a: unknown[]) => applyLocalEdit(...a),
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

function serverRow(over: Record<string, unknown> = {}) {
  return {
    id: NOTE, user_id: ME, item_type: 1,
    encrypted_content: JSON.stringify({ title: 'Server title', body: 'server body' }),
    content_nonce: 'n', version: 7,
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-06T00:00:00Z',
    deleted: false, circle_id: null, content_size: 1,
    wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn',
    shared_by_me: false, shared_with_count: 0, content_key_generation: 1,
    ...over,
  };
}

let notesStore: typeof import('./notes').notesStore;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  cached.length = 0;
  inboxEntry.mockReturnValue(undefined);
  cached.push({
    id: NOTE, title: 'Local title', body: 'local body', noteType: 'text', color: null,
    isPinned: false, isArchived: false, labels: [], sortOrder: 0, editMode: 'rich',
    notebookId: null, hasAttachments: false, version: 3,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', deleted: false,
    wrappedContentKey: 'wrap', wrappedContentKeyNonce: 'wrapn',
  });
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
});

function route(handler: (c: Call) => unknown) {
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
    calls.push(c);
    return handler(c);
  });
}

const puts = () => calls.filter(c => c.method === 'PUT' && c.url === `/api/v1/items/${NOTE}`);
const creates = () => calls.filter(c => c.method === 'POST' && c.url === '/api/v1/items');

describe('a version conflict', () => {
  it('forks exactly one conflict copy across two edits, and the second edit lands on the server version', async () => {
    let serverVersion = 7;
    route(c => {
      if (c.method === 'PUT' && c.url === `/api/v1/items/${NOTE}`) {
        if (c.body.expected_version !== serverVersion) {
          return { success: false, status: 409, error_code: 'item_version_conflict', error: 'conflict' };
        }
        serverVersion += 1;
        return { success: true, data: serverRow({ version: serverVersion }) };
      }
      if (c.method === 'POST' && c.url === '/api/v1/items') {
        return { success: true, data: serverRow({ id: c.body.id, version: 1 }) };
      }
      if (c.method === 'GET' && c.url === `/api/v1/items/${NOTE}`) {
        return { success: true, data: serverRow({ version: serverVersion }) };
      }
      if (c.url.startsWith('/api/v1/sync/pull')) {
        // The pull cannot help: nothing comes back (a cursor ahead of the
        // server, as after a restore).
        return { success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } };
      }
      return { success: true, data: [] };
    });

    expect(await notesStore.updateNote(NOTE, { body: 'edit one' })).toBe(true);
    expect(puts()[0].body.expected_version).toBe(3);
    expect(creates()).toHaveLength(1);
    expect(JSON.parse(creates()[0].body.encrypted_content).title).toBe('Local title (conflict copy)');
    expect(JSON.parse(creates()[0].body.encrypted_content).body).toBe('edit one');

    // The original now carries the server's row, not the stale version.
    const rebased = notesStore.notes().find(n => n.id === NOTE)!;
    expect(rebased.version).toBe(7);
    expect(rebased.title).toBe('Server title');
    expect(rebased.body).toBe('server body');

    // A second edit: no second fork, and the PUT carries the server version.
    expect(await notesStore.updateNote(NOTE, { body: 'edit two' })).toBe(true);
    expect(creates()).toHaveLength(1);
    expect(puts()).toHaveLength(2);
    expect(puts()[1].body.expected_version).toBe(7);
    expect(notesStore.notes().find(n => n.id === NOTE)!.version).toBe(8);
    expect(notesStore.notes().find(n => n.id === NOTE)!.body).toBe('edit two');
  });

  /**
   * An edit that races a move OUT of a notebook: its conflict copy must not
   * be filed in the notebook the card still names, the old one, or it goes
   * to the people the move has just taken off. Filed where the server has
   * the note now; in none when the row cannot be read.
   */
  it('files the copy where the server has the note now, not in the notebook the stale card names', async () => {
    cached[0] = { ...(cached[0] as Record<string, unknown>), notebookId: 'nb-old' };
    vi.resetModules();
    ({ notesStore } = await import('./notes'));
    await notesStore.hydrateFromCache();
    let rowReadable = true;
    route(c => {
      if (c.method === 'PUT' && c.url === `/api/v1/items/${NOTE}`) return { success: false, status: 409, error: 'conflict' };
      if (c.method === 'POST' && c.url === '/api/v1/items') return { success: true, data: serverRow({ id: c.body.id, version: 1 }) };
      if (c.method === 'GET' && c.url === `/api/v1/items/${NOTE}`) {
        return rowReadable
          ? { success: true, data: serverRow({ encrypted_content: JSON.stringify({ title: 'Server title', body: 'server body', notebook_id: 'nb-new' }) }) }
          : { success: false, status: 503 };
      }
      if (c.url.startsWith('/api/v1/sync/pull')) return { success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } };
      return { success: true, data: [] };
    });
    expect(await notesStore.updateNote(NOTE, { body: 'typed on the stale card' })).toBe(true);
    expect(JSON.parse(creates()[0].body.encrypted_content).notebook_id).toBe('nb-new');

    rowReadable = false;
    calls.length = 0;
    expect(await notesStore.updateNote(NOTE, { body: 'and again, the row unread' })).toBe(true);
    expect(JSON.parse(creates()[0].body.encrypted_content).notebook_id ?? null).toBeNull();
  });

  it('a note deleted on the server (not moved): its copy is filed in the notebook the card names, as before', async () => {
    cached[0] = { ...(cached[0] as Record<string, unknown>), notebookId: 'nb-old' };
    vi.resetModules();
    ({ notesStore } = await import('./notes'));
    await notesStore.hydrateFromCache();
    route(c => {
      if (c.method === 'PUT' && c.url === `/api/v1/items/${NOTE}`) return { success: false, status: 409, error: 'conflict' };
      if (c.method === 'POST' && c.url === '/api/v1/items') return { success: true, data: serverRow({ id: c.body.id, version: 1 }) };
      if (c.method === 'GET' && c.url === `/api/v1/items/${NOTE}`) return { success: true, data: serverRow({ deleted: true }) };
      if (c.url.startsWith('/api/v1/sync/pull')) return { success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } };
      return { success: true, data: [] };
    });
    expect(await notesStore.updateNote(NOTE, { body: 'typed while it was deleted elsewhere' })).toBe(true);
    expect(JSON.parse(creates()[0].body.encrypted_content).notebook_id).toBe('nb-old');
  });

  it('on a note shared with us forks an owned copy and re-bases the inbox copy', async () => {
    const shared = { ...(cached[0] as object), version: 5 } as any;
    cached.length = 0;
    inboxEntry.mockReturnValue({ note: shared, contentKey: new Uint8Array(32).fill(2) });
    route(c => {
      if (c.method === 'PUT') return { success: false, status: 409, error: 'conflict' };
      if (c.method === 'POST') return { success: true, data: serverRow({ id: c.body.id, version: 1 }) };
      if (c.method === 'GET' && c.url === `/api/v1/items/${NOTE}`) {
        return { success: true, data: serverRow({ version: 9, user_id: 'owner' }) };
      }
      if (c.url.startsWith('/api/v1/sync/pull')) {
        return { success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } };
      }
      return { success: true, data: [] };
    });
    expect(await notesStore.updateNote(NOTE, { body: 'my edit' })).toBe(true);
    expect(creates()).toHaveLength(1);
    // The fork of a shared note never claims the owner's notebook.
    expect(creates()[0].body.notebook_id).toBeNull();
    expect(applyLocalEdit).toHaveBeenCalledTimes(1);
    expect(applyLocalEdit.mock.calls[0][1].version).toBe(9);
  });
});

describe('a 404 on save', () => {
  it('re-creates the note under the same id instead of dropping the edit', async () => {
    route(c => {
      if (c.method === 'PUT') return { success: false, status: 404, error_code: 'item_not_found', error: 'gone' };
      if (c.method === 'POST' && c.url === '/api/v1/items') {
        return { success: true, data: serverRow({ id: c.body.id, version: 1, created_at: '2026-09-06T01:00:00Z', updated_at: '2026-09-06T01:00:00Z' }) };
      }
      return { success: true, data: [] };
    });

    expect(await notesStore.updateNote(NOTE, { body: 'edit after loss' })).toBe(true);
    expect(creates()).toHaveLength(1);
    const post = creates()[0].body;
    expect(post.id).toBe(NOTE);
    expect(post.item_type).toBe(1);
    expect(post.wrapped_content_key).toBe('wrap');
    expect(JSON.parse(post.encrypted_content).body).toBe('edit after loss');
    expect(JSON.parse(post.encrypted_content).title).toBe('Local title');

    const revived = notesStore.notes().find(n => n.id === NOTE)!;
    expect(revived.version).toBe(1);
    expect(revived.body).toBe('edit after loss');
    expect(revived.createdAt).toBe('2026-09-06T01:00:00Z');
  });

  /**
   * ⚠️ A DRAG MUST NEVER CREATE A NOTE. Both the 409 and the 404 branches
   * can make a note out of a write, so each is guarded by isPositionOnly:
   *   - owned: PUT 404 -> POST to re-create -> if that 409s, fork a
   *     "(conflict copy)". The POST alone is already wrong, because it
   *     RESURRECTS a note deleted on another device just because this one
   *     moved a card.
   *   - shared: PUT 404 -> fork an owned copy outright.
   * A drag writes nothing but a sortOrder. There is no text at risk, so the
   * write is simply not applicable and sync settles the row.
   */
  it('a position-only write does NOT re-create the note it could not find', async () => {
    route(c => {
      if (c.method === 'PUT') return { success: false, status: 404, error_code: 'item_not_found', error: 'gone' };
      if (c.method === 'POST') return { success: true, data: serverRow({ id: c.body.id, version: 1 }) };
      return { success: true, data: [] };
    });
    expect(await notesStore.updateNote(NOTE, { sortOrder: 42 })).toBe(false);
    expect(creates()).toHaveLength(0);
  });

  it('a position-only write on a SHARED note does not fork an owned copy', async () => {
    const shared = { ...(cached[0] as object), version: 5 } as any;
    cached.length = 0;
    inboxEntry.mockReturnValue({ note: shared, contentKey: new Uint8Array(32).fill(2) });
    route(c => {
      if (c.method === 'PUT') return { success: false, status: 404, error: 'gone' };
      if (c.method === 'POST') return { success: true, data: serverRow({ id: c.body.id, version: 1 }) };
      if (c.url.startsWith('/api/v1/sync/pull')) {
        return { success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } };
      }
      return { success: true, data: [] };
    });
    expect(await notesStore.updateNote(NOTE, { sortOrder: 7 })).toBe(false);
    expect(creates()).toHaveLength(0);
  });

  it('an ordinary EDIT is still rescued — the guard is about position, not 404', async () => {
    route(c => {
      if (c.method === 'PUT') return { success: false, status: 404, error_code: 'item_not_found', error: 'gone' };
      if (c.method === 'POST' && c.url === '/api/v1/items') {
        return { success: true, data: serverRow({ id: c.body.id, version: 1 }) };
      }
      return { success: true, data: [] };
    });
    expect(await notesStore.updateNote(NOTE, { body: 'still mine' })).toBe(true);
    expect(creates()).toHaveLength(1);
  });

  it('keeps the editor dirty when the re-create is refused at the note cap', async () => {
    route(c => {
      if (c.method === 'PUT') return { success: false, status: 404, error: 'gone' };
      if (c.method === 'POST') return { success: false, status: 402, error_code: 'quota_notes_exceeded', error: 'cap' };
      return { success: true, data: [] };
    });
    expect(await notesStore.updateNote(NOTE, { body: 'x' })).toBe(false);
    expect(creates()).toHaveLength(1);
  });

  it('on a note shared with us keeps the text as an owned copy', async () => {
    const shared = { ...(cached[0] as object), version: 5 } as any;
    cached.length = 0;
    inboxEntry.mockReturnValue({ note: shared, contentKey: new Uint8Array(32).fill(2) });
    route(c => {
      if (c.method === 'PUT') return { success: false, status: 404, error: 'gone' };
      if (c.method === 'POST') return { success: true, data: serverRow({ id: c.body.id, version: 1 }) };
      if (c.url.startsWith('/api/v1/sync/pull')) {
        return { success: true, data: { items: [], cursor: null, cursor_id: null, has_more: false } };
      }
      return { success: true, data: [] };
    });
    expect(await notesStore.updateNote(NOTE, { body: 'my edit' })).toBe(true);
    expect(creates()).toHaveLength(1);
    expect(JSON.parse(creates()[0].body.encrypted_content).body).toBe('my edit');
  });
});
