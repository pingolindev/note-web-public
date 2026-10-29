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
/** Each notebook's standing list of people; `gone`: deleted, and no longer among the notebooks. */
const { standing, gone } = vi.hoisted(() => ({ standing: new Map<string, { email: string }[]>(), gone: new Set<string>() }));

/**
 * Deleting a shared notebook takes its notes' people off them
 * (`notesStore.unshareNotebookChildren`); the dialog promises "anyone you
 * shared them with through this notebook loses access".
 *
 * WHY
 *   A key change is not sent when what it needs cannot be read, even asked
 *   again (lib/shareUtils, lib/askTwice). Here that would leave a note's
 *   people on it after the notebook was deleted. So a note's rows are asked
 *   for twice, and a key change that does not go through falls back to
 *   revoking the rows one by one, as the notebook object's own removal does.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
/** Per-account storage (lib/notesToTakeBack keeps what a deletion could not take off). */
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
const local = memoryStorage();
vi.stubGlobal('localStorage', local);
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  vaultKeyThatOpens: () => 'current',
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  opensBoundToItem: () => true,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0, previousIdentitiesAnswered: () => true }));
const rotateContentKey = vi.fn();
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: vi.fn(async () => ({ ok: true })),
  shareNotebookWithRecipientResult: vi.fn(async () => ({ ok: true })),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: (...a: unknown[]) => rotateContentKey(...a),
}));
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => false, learnNotebookItem: async () => false, notebookItemState: async () => 'none', getNotebookShares: (id: string) => standing.get(id) ?? [], notebooks: () => [...standing.keys()].filter(id => !gone.has(id)).map(id => ({ id, name: id, noteCount: 0 })), membersOf: () => [],
    loadFromSyncedItems: () => {}, gcEditorModes: () => {}, markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
    pruneAcceptances: async () => {}, rememberAcceptances: () => {}, notebookOpenedVia: () => 'vault',
  },
}));
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: () => undefined, load: async () => true, sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {}, applyLocalEdit: () => {},
  },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
const { cache } = vi.hoisted(() => ({ cache: new Map<string, Record<string, unknown>>() }));
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => [...cache.values()],
  loadCursor: async () => null,
  loadCursorId: async () => null,
  getNote: vi.fn(async () => null),
  putNote: vi.fn(async () => {}),
  putNotes: vi.fn(async () => {}),
  removeNote: vi.fn(async () => {}),
  queuePending: vi.fn(async () => {}),
  removePending: vi.fn(async () => {}),
  getPending: vi.fn(async () => null),
  listPending: vi.fn(async () => []),
  countPending: vi.fn(async () => 0),
  saveCursor: async () => {},
  saveCursorId: async () => {},
}));

const card = (id: string, notebookId: string | null) => ({
  id, title: id, body: '', noteType: 'text', color: null, isPinned: false, isArchived: false,
  labels: [], sortOrder: 0, editMode: 'rich', notebookId, hasAttachments: false,
  version: 2, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deleted: false,
  wrappedContentKey: 'w', wrappedContentKeyNonce: 'wn', openedVia: 'vault', foreignOwner: false,
});

/** The server: each note's share rows; reads of a note's rows that get no answer, by note; revokes. */
let rows: Record<string, { id: string; recipient_email: string; created_at?: string }[]>;
let unanswered: Record<string, number>;
let revokes: string[];
let revokeFails: Set<string>;
const ASKED = (id: string) => apiRequest.mock.calls.filter(c => c[0] === `/api/v1/items/${id}/shares`).length;

let notesStore: typeof import('./notes').notesStore;
let ASK_AGAIN_AFTER_MS: number;

beforeEach(async () => {
  vi.clearAllMocks();
  local.clear();
  cache.clear();
  standing.clear();
  gone.clear();
  cache.set('n1', card('n1', 'nb'));
  cache.set('n2', card('n2', 'nb'));
  cache.set('other', card('other', 'elsewhere'));
  rows = {
    n1: [{ id: 's1', recipient_email: 'ann@example.test' }, { id: 's2', recipient_email: 'ben@example.test' }],
    n2: [{ id: 's3', recipient_email: 'ann@example.test' }],
    other: [{ id: 's9', recipient_email: 'zoe@example.test' }],
  };
  unanswered = {};
  revokes = [];
  revokeFails = new Set();
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
    const of = /^\/api\/v1\/items\/([^/]+)\/shares$/.exec(url)?.[1];
    if (of) {
      if ((unanswered[of] ?? 0) > 0) { unanswered[of]--; return { success: false, error: 'Network error' }; }
      return { success: true, data: rows[of] ?? [] };
    }
    if (url.startsWith('/api/v1/sync/pull')) {
      return { success: true, data: { items: [], cursor: '2026-10-11T00:00:00Z', cursor_id: null, has_more: false } };
    }
    const share = /^\/api\/v1\/shares\/([^/?]+)$/.exec(url)?.[1];
    if (share && opts?.method === 'DELETE') {
      revokes.push(share);
      return revokeFails.has(share) ? { success: false, error: 'Network error' } : { success: true, data: null };
    }
    return { success: false, status: 404 };
  });
  rotateContentKey.mockResolvedValue({ rotated: true, remainingCount: 0, reWrapFailures: [], revokedShareLink: false });
  vi.resetModules();
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  ({ ASK_AGAIN_AFTER_MS } = await import('../lib/askTwice'));
  await notesStore.hydrateFromCache();
});
afterEach(() => { vi.useRealTimers(); });

async function deleteNotebook() {
  vi.useFakeTimers();
  const p = notesStore.unshareNotebookChildren('nb');
  await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 4);
  await p;
}

describe('deleting a shared notebook takes its notes\' people off them', () => {
  it('each note of it by one key change with all its rows; nothing revoked by hand; no other note touched', async () => {
    await deleteNotebook();
    expect(rotateContentKey.mock.calls.map(c => [c[0], c[1]])).toEqual([['n1', ['s1', 's2']], ['n2', ['s3']]]);
    expect(revokes).toEqual([]);
    expect(ASKED('other')).toBe(0);
  });

  it('while the notebook is still listed with its people, the deletion takes them all off: nobody stays through the notebook going away', async () => {
    standing.set('nb', [{ email: 'ann@example.test' }, { email: 'ben@example.test' }]);
    await deleteNotebook();
    expect(rotateContentKey.mock.calls.map(c => [c[0], c[1]])).toEqual([['n1', ['s1', 's2']], ['n2', ['s3']]]);
  });

  it('a key change that does not go through: the rows are revoked one by one, as the notebook object\'s are', async () => {
    rotateContentKey.mockResolvedValueOnce({ rotated: false, remainingCount: 0, reWrapFailures: [], revokedShareLink: false });
    await deleteNotebook();
    expect(revokes).toEqual(['s1', 's2']);
  });

  it('a note\'s rows not read once: asked again after a moment, and its people are taken off', async () => {
    unanswered.n1 = 1;
    await deleteNotebook();
    expect(ASKED('n1')).toBe(2);
    expect(rotateContentKey.mock.calls.map(c => c[0])).toEqual(['n1', 'n2']);
  });

  it('not read even asked again: that note waits, and the others go on', async () => {
    unanswered.n1 = 2;
    await deleteNotebook();
    expect(ASKED('n1')).toBe(2);
    expect(rotateContentKey.mock.calls.map(c => c[0])).toEqual(['n2']);
    expect(revokes).toEqual([]);
    const { notesToTakeBack } = await import('../lib/notesToTakeBack');
    expect(notesToTakeBack().map(e => e.noteId)).toEqual(['n1']);
  });

  /**
   * The dialog promises that anyone shared with through the notebook loses
   * access, so a note's people must not keep it for good. After a later sync
   * they are taken off: every row made before the deletion, none made well
   * after it (a share the owner makes afterwards is theirs).
   */
  it('and its people are taken off after a later sync: the rows made before the deletion, not one made since', async () => {
    unanswered.n1 = 2;
    await deleteNotebook();
    vi.useRealTimers();
    const { notesToTakeBack } = await import('../lib/notesToTakeBack');
    const deletedAt = Date.parse(notesToTakeBack()[0].before);
    rows.n1 = [
      { id: 's1', recipient_email: 'ann@example.test', created_at: '2026-10-01T00:00:00Z' },
      // A minute later by the server's clock: within the margin of two clocks, so it goes too.
      { id: 's2', recipient_email: 'ben@example.test', created_at: new Date(deletedAt + 60_000).toISOString() },
      { id: 'later', recipient_email: 'new@example.test', created_at: '2099-01-01T00:00:00Z' },
    ];
    rotateContentKey.mockClear();
    await notesStore.sync();
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
    expect(rotateContentKey.mock.calls.map(c => [c[0], c[1]])).toEqual([['n1', ['s1', 's2']]]);
    expect(notesToTakeBack()).toEqual([]);
  });

  /**
   * Moved since into a notebook Ann is in too, the note re-uses her row, and a
   * row keeps the time it was first made (the server's upsert): a take-back by
   * time alone would take her off a note she has through that notebook. She
   * stays; Ben, who is not in it, still goes.
   */
  it('someone who has the note now through the notebook it was moved into stays; the others still go', async () => {
    unanswered.n1 = 2;
    await deleteNotebook();
    vi.useRealTimers();
    standing.set('nb2', [{ email: 'Ann@Example.test' }]);
    notesStore.applyLocalPatch({ ...notesStore.notes().find(n => n.id === 'n1')!, notebookId: 'nb2' });
    rows.n1 = [
      { id: 's1', recipient_email: 'ann@example.test', created_at: '2026-10-01T00:00:00Z' },
      { id: 's2', recipient_email: 'ben@example.test', created_at: '2026-10-01T00:00:00Z' },
    ];
    rotateContentKey.mockClear();
    await notesStore.sync();
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
    expect(rotateContentKey.mock.calls.map(c => [c[0], c[1]])).toEqual([['n1', ['s2']]]);
    const { notesToTakeBack } = await import('../lib/notesToTakeBack');
    expect(notesToTakeBack()).toEqual([]);
  });

  /** The card still names the deleted notebook (no pull has said otherwise): nobody stays through it. */
  it('the card still names the deleted notebook, whose list is still here: nobody stays through it', async () => {
    unanswered.n1 = 2;
    await deleteNotebook();
    vi.useRealTimers();
    standing.set('nb', [{ email: 'ann@example.test' }]);
    gone.add('nb');
    rows.n1 = [{ id: 's1', recipient_email: 'ann@example.test', created_at: '2026-10-01T00:00:00Z' }];
    rotateContentKey.mockClear();
    await notesStore.sync();
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
    expect(rotateContentKey.mock.calls.map(c => [c[0], c[1]])).toEqual([['n1', ['s1']]]);
  });

  it('a later sync that still cannot read them keeps the note for the next go', async () => {
    unanswered.n1 = 4;
    await deleteNotebook();
    vi.useRealTimers();
    await notesStore.sync();
    for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, ASK_AGAIN_AFTER_MS + 50));
    const { notesToTakeBack } = await import('../lib/notesToTakeBack');
    expect(notesToTakeBack().map(e => e.noteId)).toEqual(['n1']);
  });

  it('another account answered: not asked again', async () => {
    apiRequest.mockImplementation(async (url: string) =>
      url === '/api/v1/items/n1/shares' ? { success: false, error: 'stop', error_code: 'account_mismatch' } : { success: true, data: [] });
    await deleteNotebook();
    expect(ASKED('n1')).toBe(1);
    expect(rotateContentKey).not.toHaveBeenCalled();
  });

  it('a note with no rows: nothing to do', async () => {
    rows.n1 = [];
    await deleteNotebook();
    expect(rotateContentKey.mock.calls.map(c => c[0])).toEqual(['n2']);
  });
});
