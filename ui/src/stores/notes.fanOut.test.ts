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
 * A note added to a shared notebook is sealed to the key each recipient holds
 * NOW, and a recipient it cannot reach is recorded, not just logged.
 *
 * WHY
 *   The standing share list caches each recipient's key from when they were
 *   invited. After the recipient's password reset that is a key they no longer
 *   hold: sealed to it, every new note "shares" fine and none can be opened —
 *   and a send-side pin check that compared the cached key with a pin taken
 *   from the same cache could never notice, so the sharer's screen would show
 *   nothing.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  // A wrap made under somebody else's vault does not open here; the key of a
  // row already on the server ('row-wrap') is told apart from a new one.
  unwrapContentKeyWithVault: (wrapped: string) => (
    wrapped === 'someone-elses-wrap' ? null : new Uint8Array(32).fill(wrapped === 'row-wrap' ? 9 : 1)
  ),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  // Content sealed for ANOTHER item opens with the note's key and is not bound to this id.
  opensBoundToItem: (d: { ciphertext: string }) => !d.ciphertext.includes('"sealed-for-another-item"'),
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => {
    if (d.ciphertext.includes('"sealed-under-another-vault"')) throw new Error('this vault does not open it');
    return d.ciphertext;
  },
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));

const shareNoteWithRecipientResult = vi.fn();
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: (...a: unknown[]) => shareNoteWithRecipientResult(...a),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));

const NEW_KEYS = { userId: 'ben-id', sharingPub: 'cc'.repeat(32), signingPub: 'dd'.repeat(32) };
const lookupDirectoryKeys = vi.fn();
vi.mock('../lib/recipientKeys', async () => {
  const real = await vi.importActual<typeof import('../lib/recipientKeys')>('../lib/recipientKeys');
  return { ...real, lookupDirectoryKeys: (...a: unknown[]) => lookupDirectoryKeys(...a) };
});

const STANDING = [{
  email: 'ben@example.test', permission: 'edit' as const,
  // What the standing list cached at invite time — before Ben's reset.
  publicKey: 'aa'.repeat(32), userId: 'ben-id', signingPublicKey: 'bb'.repeat(32),
}];
/** A notebook we are a MEMBER of: its roster, written by the owner inside the
 *  notebook's ciphertext. */
const ROSTER = [{
  userId: 'cara-id', email: 'cara@example.test', permission: 'edit' as const,
  sharingPublicKey: 'ee'.repeat(32), signingPublicKey: 'ff'.repeat(32),
}];
/** How each notebook was opened here (notebooks.ts notebookOpenedVia): 'member-nb'
 *  through an accepted share, 'own-nb' through our vault, 'unknown-nb' neither. */
const OPENED_VIA: Record<string, 'vault' | 'share' | null> = {
  'member-nb': 'share', 'own-nb': 'vault', 'unknown-nb': null, nb: 'vault',
};
/** What the server has for this notebook: what the store asks before it names one (default: an item). */
const notebookItemState = vi.fn(async (_id: string | null | undefined): Promise<'item' | 'none' | 'unknown'> => 'item');
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => true,
    notebookItemState: (id: string | null | undefined) => notebookItemState(id),
    learnNotebookItem: async (id: string | null | undefined) => (await notebookItemState(id)) === 'item',
    getNotebookShares: (id: string) => (id === 'nb' ? STANDING : []),
    notebooks: () => [{ id: 'nb', name: 'Wedding', noteCount: 0 }],
    membersOf: (id: string) => (id === 'member-nb' || id === 'own-nb' || id === 'unknown-nb' ? ROSTER : []),
    notebookOpenedVia: (id: string) => OPENED_VIA[id] ?? null,
    loadFromSyncedItems: () => {},
    gcEditorModes: () => {},
    markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
    pruneAcceptances: async () => {}, rememberAcceptances: () => {},
  },
}));
const inboxRowFor = vi.fn();
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: (id: string) => inboxRowFor(id),
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
let shareHealthStore: typeof import('./shareHealth').shareHealthStore;

/** The directory's answer for anyone looked up: a key the server chose. */
const LOOKED_UP = { sharing_public_key: '55'.repeat(32), signing_public_key: '66'.repeat(32) };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  inboxRowFor.mockReturnValue(undefined);
  notebookItemState.mockImplementation(async () => 'item');
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: { id?: string; emails?: string[] } }) => {
    if (url === '/api/v1/items' && opts?.method === 'POST') {
      return {
        success: true,
        data: { id: opts.body?.id, version: 1, created_at: 't', updated_at: 't' },
      };
    }
    if (url === '/api/v1/users/public-keys') {
      return {
        success: true,
        data: { users: (opts?.body?.emails ?? []).map(email => ({ email, user_id: 'looked-up-id', ...LOOKED_UP })) },
      };
    }
    return { success: false, status: 404 };
  });
  ({ notesStore } = await import('./notes'));
  ({ shareHealthStore } = await import('./shareHealth'));
});

/**
 * The note's create names its notebook to the server only when the notebook
 * has an item there. Known from this session's sync pages alone, an untouched
 * notebook would be "not an item" after a reload: the note would go up
 * without its notebook, and the server could not keep it from a reader who
 * had declined that notebook.
 */
describe('the notebook a new note names to the server', () => {
  const created = () => apiRequest.mock.calls
    .filter(c => c[0] === '/api/v1/items' && c[1]?.method === 'POST')
    .map(c => (c[1] as { body: { notebook_id: string | null } }).body.notebook_id);
  // The fan-out that follows a create is not this block's subject: it reaches whoever it reaches.
  beforeEach(() => { lookupDirectoryKeys.mockResolvedValue(new Map()); });

  it('is its notebook, when the server has an item for it: the store ASKS, it does not go by what it happens to know', async () => {
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });
    await notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });
    expect(notebookItemState).toHaveBeenCalledWith('nb');
    expect(created()).toEqual(['nb']);
  });

  /** Never a guess: naming a notebook that has no item fails the whole save. */
  it('is none, when the server has no item for it', async () => {
    notebookItemState.mockImplementation(async () => 'none');
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });
    await notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });
    expect(created()).toEqual([null]);
  });

  it('is none for a note in no notebook', async () => {
    notebookItemState.mockImplementation(async (id) => (id ? 'item' : 'none'));
    await notesStore.createNote({ title: 'Loose' });
    expect(created()).toEqual([null]);
  });

  /** The answer is waited for: the create does not leave before it. */
  it('waits for the answer before the note is sent', async () => {
    let answer: (v: 'item' | 'none' | 'unknown') => void = () => {};
    notebookItemState.mockImplementation(() => new Promise<'item' | 'none' | 'unknown'>((resolve) => { answer = resolve; }));
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });
    const creating = notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });
    await new Promise(r => setTimeout(r, 20));
    expect(created()).toEqual([]);
    answer('item');
    await creating;
    expect(created()).toEqual(['nb']);
  });
});

/**
 * The server could not be asked whether the notebook exists as an item (a
 * 503, a 429, a timeout). Sent anyway, the note would go up WITHOUT its
 * notebook and still be passed on to the notebook's people: a reader who had
 * DECLINED the notebook would get it live, with a push, because the server
 * keeps a declined notebook's notes away by the notebook on the note's row.
 * It waits instead, like any create the server could not take.
 */
describe('a new note whose shared notebook the server could not be asked about', () => {
  const posts = () => apiRequest.mock.calls.filter(c => c[0] === '/api/v1/items' && c[1]?.method === 'POST');
  let noteDb: typeof import('../lib/noteDb');
  beforeEach(async () => {
    noteDb = await import('../lib/noteDb');
    lookupDirectoryKeys.mockResolvedValue(new Map());
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });
  });

  it('is not sent, and not passed on to anyone: it waits in the queue, shown as waiting', async () => {
    notebookItemState.mockImplementation(async () => 'unknown');
    const r = await notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });
    expect(posts()).toEqual([]);
    expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
    expect(r).toEqual({ note: null, queued: true });
    expect(noteDb.queuePending).toHaveBeenCalledTimes(1);
    expect(noteDb.removePending).not.toHaveBeenCalled();
    const shown = notesStore.notes().find(n => n.title === 'Seating plan');
    expect(shown?.pendingSync).toBe(true);
    expect(shown?.notebookId).toBe('nb');
  });

  it('is asked about once more before it waits: a blip is not worth a queued note', async () => {
    notebookItemState.mockImplementationOnce(async () => 'unknown').mockImplementation(async () => 'item');
    const r = await notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });
    expect(notebookItemState).toHaveBeenCalledTimes(2);
    expect(posts().map(c => (c[1] as { body: { notebook_id: string | null } }).body.notebook_id)).toEqual(['nb']);
    expect(r.note).not.toBeNull();
    expect(shareNoteWithRecipientResult).toHaveBeenCalledTimes(1);
  });

  it('and no more than twice', async () => {
    notebookItemState.mockImplementation(async () => 'unknown');
    await notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });
    expect(notebookItemState).toHaveBeenCalledTimes(2);
  });

  /** A notebook that goes to nobody has nobody to leak to: the note is saved at once. */
  it('a notebook shared with nobody does not wait: saved without its notebook on the row', async () => {
    notebookItemState.mockImplementation(async () => 'unknown');
    const r = await notesStore.createNote({ title: 'Private', notebookId: 'solo-nb' });
    expect(posts().map(c => (c[1] as { body: { notebook_id: string | null } }).body.notebook_id)).toEqual([null]);
    expect(r.note).not.toBeNull();
    expect(noteDb.removePending).toHaveBeenCalledTimes(1);
  });

  it('a roster counts as people too (a notebook we are a member of)', async () => {
    notebookItemState.mockImplementation(async () => 'unknown');
    const r = await notesStore.createNote({ title: 'Guest list', notebookId: 'member-nb' });
    expect(posts()).toEqual([]);
    expect(r.queued).toBe(true);
  });
});

/**
 * The server will not have a note IN a notebook its writer may read and not
 * add to (a 403), and a create names its notebook, after a reload too. That
 * refusal must not be silent online, and a note written offline must not be
 * shown as saved and then DROPPED at its replay: the note is saved as the
 * writer's own, without the notebook on its row.
 */
describe('a new note the server will not place in its notebook', () => {
  const bodies = () => apiRequest.mock.calls
    .filter(c => c[0] === '/api/v1/items' && c[1]?.method === 'POST')
    .map(c => (c[1] as { body: { notebook_id: string | null } }).body.notebook_id);
  let noteDb: typeof import('../lib/noteDb');
  /** The server: a note that names a notebook is refused, one that names none is taken. */
  const refusesPlacement = (unfiled: unknown = null) => apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: { id?: string; notebook_id?: string | null } }) => {
    if (url === '/api/v1/items' && opts?.method === 'POST') {
      if (opts.body?.notebook_id) return { success: false, status: 403, error: 'You do not have permission to add notes to that notebook' };
      return unfiled ?? { success: true, data: { id: opts.body?.id, version: 1, created_at: 't', updated_at: 't' } };
    }
    return { success: false, status: 404 };
  });
  beforeEach(async () => {
    noteDb = await import('../lib/noteDb');
    lookupDirectoryKeys.mockResolvedValue(new Map());
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });
  });

  it('is saved as the writer\'s own, without the notebook on its row', async () => {
    refusesPlacement();
    const r = await notesStore.createNote({ title: 'Guest list', notebookId: 'member-nb' });
    expect(bodies()).toEqual(['member-nb', null]);
    expect(r.note?.title).toBe('Guest list');
    expect(r.queued).toBe(false);
    expect(noteDb.removePending).toHaveBeenCalledTimes(1);
  });

  /** What the server refused to place must not reach the notebook's people by another door. */
  it('and is passed on to nobody', async () => {
    refusesPlacement();
    await notesStore.createNote({ title: 'Guest list', notebookId: 'member-nb' });
    expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
  });

  it('a note the server does place is passed on as always (the control)', async () => {
    await notesStore.createNote({ title: 'Guest list', notebookId: 'member-nb' });
    expect(bodies()).toEqual(['member-nb']);
    expect(shareNoteWithRecipientResult).toHaveBeenCalledTimes(1);
  });

  it('a refusal that is not about the notebook is not retried', async () => {
    apiRequest.mockImplementation(async () => ({ success: false, status: 403 }));
    notebookItemState.mockImplementation(async () => 'none');
    const r = await notesStore.createNote({ title: 'Loose' });
    expect(bodies()).toEqual([null]);
    expect(r).toEqual({ note: null, queued: false });
  });

  it('refused without its notebook too, it is a refusal: the composer keeps the text', async () => {
    refusesPlacement({ success: false, status: 403 });
    const r = await notesStore.createNote({ title: 'Guest list', notebookId: 'member-nb' });
    expect(bodies()).toEqual(['member-nb', null]);
    expect(r).toEqual({ note: null, queued: false });
    expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
  });

  /**
   * "Never drop a queue entry whose card is still on screen." A REPLAY of a
   * queued create that the server refuses for good keeps its entry: without
   * it the card would say "waiting" for ever with nothing left to send it.
   */
  it('a replay that is refused for good keeps its queue entry', async () => {
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) =>
      (url === '/api/v1/items' && opts?.method === 'POST' ? { success: false, status: 402, error_code: 'quota_notes_exceeded' } : { success: false, status: 404 }));
    const r = await notesStore.createNote({ title: 'Written offline' }, 'aaaaaaaa-1111-4111-8111-11111111111a');
    expect(r).toEqual({ note: null, queued: false });
    expect(noteDb.removePending).not.toHaveBeenCalled();
  });

  it('a first attempt that is refused for good leaves nothing queued: the composer has the text', async () => {
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) =>
      (url === '/api/v1/items' && opts?.method === 'POST' ? { success: false, status: 402, error_code: 'quota_notes_exceeded' } : { success: false, status: 404 }));
    await notesStore.createNote({ title: 'Over the limit' });
    expect(noteDb.removePending).toHaveBeenCalledTimes(1);
  });
});

/**
 * A create whose answer was lost AFTER the server took the note is queued,
 * and its replay is answered "an item with this id already exists". Kept
 * like a refusal, that entry would be sent again at every drain for good and
 * the count of unsent changes would never reach 0.
 */
describe('a replayed create whose note is already on the server', () => {
  const ID = 'aaaaaaaa-1111-4111-8111-11111111111a';
  let noteDb: typeof import('../lib/noteDb');
  /** The server's row for the note: what the first attempt left there. */
  const serverRow = (over: Record<string, unknown> = {}) => ({
    id: ID, user_id: ME, item_type: 1, version: 1, deleted: false,
    encrypted_content: JSON.stringify({ title: 'Written offline', body: '', note_type: 'text', labels: [] }),
    content_nonce: 'n', wrapped_content_key: 'w', wrapped_content_key_nonce: 'wn',
    created_at: '2026-10-07T09:00:00.000000Z', updated_at: '2026-10-07T09:00:00.000000Z', ...over,
  });
  /** The create is answered `post`; a read of the note's own row is answered `row`. */
  const server = (post: unknown, row: unknown) => apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === '/api/v1/items' && opts?.method === 'POST') return post;
    if (url === `/api/v1/items/${ID}` && !opts?.method) return row;
    return { success: false, status: 404 };
  });
  const posts = () => apiRequest.mock.calls.filter(c => c[0] === '/api/v1/items' && c[1]?.method === 'POST').length;
  const rowReads = () => apiRequest.mock.calls.filter(c => c[0] === `/api/v1/items/${ID}`).length;
  const ALREADY_THERE = { success: false, status: 409, error_code: 'item_already_exists' };
  /** The note is written while the server cannot be reached: queued, and on screen as waiting. */
  const writtenOffline = async () => {
    server({ success: false, status: 503 }, { success: false, status: 503 });
    const r = await notesStore.createNote({ title: 'Written offline' }, undefined);
    expect(r.queued).toBe(true);
    const queued = vi.mocked(noteDb.queuePending).mock.calls[0][0] as { id: string; note: Parameters<typeof notesStore.createNote>[0] };
    vi.mocked(noteDb.removePending).mockClear();
    return queued;
  };
  beforeEach(async () => {
    noteDb = await import('../lib/noteDb');
    notebookItemState.mockImplementation(async () => 'none');
  });

  it('has landed: its queue entry goes, and it is not sent again', async () => {
    server(ALREADY_THERE, { success: true, data: serverRow() });
    const r = await notesStore.createNote({ title: 'Written offline' }, ID);
    expect(r).toEqual({ note: null, queued: false });
    expect(posts()).toBe(1);
    expect(noteDb.removePending).toHaveBeenCalledTimes(1);
    expect(noteDb.removePending).toHaveBeenCalledWith(ID);
  });

  it("the waiting row takes the server's: its version, and it no longer says it is waiting", async () => {
    const queued = await writtenOffline();
    const waiting = notesStore.notes().find(n => n.id === queued.id);
    expect(waiting?.pendingSync).toBe(true);
    expect(waiting?.version).toBe(0);

    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/v1/items' && opts?.method === 'POST') return ALREADY_THERE;
      if (url === `/api/v1/items/${queued.id}` && !opts?.method) return { success: true, data: serverRow({ id: queued.id, version: 1 }) };
      return { success: false, status: 404 };
    });
    await notesStore.createNote(queued.note, queued.id);
    const landed = notesStore.notes().find(n => n.id === queued.id);
    expect(landed?.title).toBe('Written offline');
    expect(landed?.version).toBe(1);
    expect(landed?.pendingSync).toBeFalsy();
    expect(noteDb.removePending).toHaveBeenCalledWith(queued.id);
  });

  it('when its row cannot be fetched just now, the entry waits for the next drain', async () => {
    server(ALREADY_THERE, { success: false, status: 503 });
    const r = await notesStore.createNote({ title: 'Written offline' }, ID);
    expect(r).toEqual({ note: null, queued: false });
    expect(rowReads()).toBe(1);
    expect(noteDb.removePending).not.toHaveBeenCalled();
  });

  /**
   * The 409 and the row are both the server's word. If any row served for the
   * id ended the create, the entry would go, and a note that may exist nowhere
   * but here would be shown as synced. Only this account's own note is a
   * landing.
   */
  describe('only a row that is this account\'s own note is a landing', () => {
    const SOMEONE = '5e5e5e5e-0000-4000-8000-00000000005e';
    const notALanding: [string, Record<string, unknown>][] = [
      ['a row the server names somebody else\'s', { user_id: SOMEONE }],
      ['a row that names no owner this page can read', { user_id: 'not-a-uuid' }],
      ['a row that is not a note', { item_type: 2 }],
      ['a row our vault does not open, whoever the server says owns it', {
        wrapped_content_key: 'someone-elses-wrap',
        encrypted_content: JSON.stringify({ title: 'Theirs', 'sealed-under-another-vault': true }),
      }],
      ['a row in the trash that our vault does not open', {
        deleted: true, wrapped_content_key: 'someone-elses-wrap',
        encrypted_content: JSON.stringify({ title: 'Theirs', 'sealed-under-another-vault': true }),
      }],
      // Any own note opens with our vault, so a row of ANOTHER own
      // note would pass every check above and take this card's place.
      ['a row with another note\'s id, though it is our own and opens', { id: 'bbbbbbbb-2222-4222-8222-22222222222b' }],
      ['a row that carries no id', { id: undefined }],
      ['a row whose content was sealed for another item', {
        encrypted_content: JSON.stringify({ title: 'Another note of mine', 'sealed-for-another-item': true }),
      }],
      ['a row with no key of its own: this build seals every note under one', {
        wrapped_content_key: null, wrapped_content_key_nonce: null,
      }],
    ];
    for (const [what, over] of notALanding) {
      it(`${what}: the entry stays, and the card goes on saying it is waiting`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const queued = await writtenOffline();
        apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
          if (url === '/api/v1/items' && opts?.method === 'POST') return ALREADY_THERE;
          if (url === `/api/v1/items/${queued.id}` && !opts?.method) return { success: true, data: serverRow({ id: queued.id, ...over }) };
          return { success: false, status: 404 };
        });
        expect(await notesStore.createNote(queued.note, queued.id)).toEqual({ note: null, queued: false });
        expect(noteDb.removePending).not.toHaveBeenCalled();
        const row = notesStore.notes().find(n => n.id === queued.id);
        // What the user wrote, still here and still waiting: nothing of the server's row was taken.
        expect(row?.title).toBe('Written offline');
        expect(row?.pendingSync).toBe(true);
        expect(row?.version).toBe(0);
        warn.mockRestore();
      });
    }

    it('the control: the same row as this account\'s own is one', async () => {
      const queued = await writtenOffline();
      apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
        if (url === '/api/v1/items' && opts?.method === 'POST') return ALREADY_THERE;
        if (url === `/api/v1/items/${queued.id}` && !opts?.method) return { success: true, data: serverRow({ id: queued.id, user_id: ME.toUpperCase() }) };
        return { success: false, status: 404 };
      });
      await notesStore.createNote(queued.note, queued.id);
      expect(noteDb.removePending).toHaveBeenCalledWith(queued.id);
      expect(notesStore.notes().find(n => n.id === queued.id)?.pendingSync).toBeFalsy();
    });

    it('our own note, put in the trash since it landed: it leaves the list, and its entry goes', async () => {
      const queued = await writtenOffline();
      apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
        if (url === '/api/v1/items' && opts?.method === 'POST') return ALREADY_THERE;
        if (url === `/api/v1/items/${queued.id}` && !opts?.method) return { success: true, data: serverRow({ id: queued.id, deleted: true }) };
        return { success: false, status: 404 };
      });
      await notesStore.createNote(queued.note, queued.id);
      expect(noteDb.removePending).toHaveBeenCalledWith(queued.id);
      expect(notesStore.notes().some(n => n.id === queued.id)).toBe(false);
      expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
    });
  });

  /**
   * The landed note has still to reach its notebook's people: the first
   * attempt never passed it on (its answer was lost, or the page died right
   * after it). Returning without that would leave a note in a shared notebook
   * that looks synced and that nobody else ever receives.
   */
  describe('and it is in a shared notebook', () => {
    /** The keys the shares were sealed with, copied when asked for (the store wipes its own). */
    let sealedWith: number[][];
    /** The landed row: in notebook `nb` (whose standing list is Ben) by its content, and by its row as given. */
    const landedIn = (rowNotebook: string | null, over: Record<string, unknown> = {}) => server(ALREADY_THERE, {
      success: true,
      data: serverRow({
        encrypted_content: JSON.stringify({ title: 'Written offline', body: '', note_type: 'text', labels: [], notebook_id: 'nb' }),
        wrapped_content_key: 'row-wrap', notebook_id: rowNotebook, ...over,
      }),
    });
    beforeEach(() => {
      sealedWith = [];
      lookupDirectoryKeys.mockResolvedValue(new Map([['ben@example.test', NEW_KEYS]]));
      shareNoteWithRecipientResult.mockImplementation(async (_id: string, key: Uint8Array) => {
        sealedWith.push([...key]);
        return { ok: true };
      });
      notebookItemState.mockImplementation(async () => 'item');
    });
    const sharedTo = () => shareNoteWithRecipientResult.mock.calls.map(c => [c[0], (c[2] as { email: string }).email]);

    it('is passed on to the notebook\'s people, sealed with the key of the row that is ON the server', async () => {
      landedIn('nb');
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(sharedTo()).toEqual([[ID, 'ben@example.test']]);
      // The row's key (9s), not the one this replay made for a create that did not happen (1s).
      expect(sealedWith).toEqual([Array(32).fill(9)]);
      expect(noteDb.removePending).toHaveBeenCalledWith(ID);
    });

    it('and that key is wiped afterwards', async () => {
      landedIn('nb');
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      const key = shareNoteWithRecipientResult.mock.calls[0][1] as Uint8Array;
      expect([...key]).toEqual(Array(32).fill(0));
    });

    it('the row\'s notebook is the same one however it is capitalised', async () => {
      landedIn('NB');
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(sharedTo()).toEqual([[ID, 'ben@example.test']]);
    });

    it('somebody it could not reach is recorded, so the owner can see it', async () => {
      landedIn('nb');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      shareNoteWithRecipientResult.mockResolvedValue({ ok: false, reason: 'key-changed' });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(shareHealthStore.notReceiving('nb')).toEqual([{ email: 'ben@example.test', reason: 'key-changed' }]);
      // The note has landed all the same: its entry goes.
      expect(noteDb.removePending).toHaveBeenCalledWith(ID);
      warn.mockRestore();
    });

    /**
     * The create's own rule (`placementRefused`): what the server did not place
     * in the notebook is passed on to nobody. A row that names no notebook,
     * while the notebook has an item for it to name, was refused there.
     */
    /** What the server answers a write that names the notebook: `placing` (default: refused). */
    const placings = () => apiRequest.mock.calls.filter(c => c[0] === `/api/v1/items/${ID}` && c[1]?.method === 'PUT');
    const landedWithNoNotebookOnItsRow = (placing: unknown) => apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/v1/items' && opts?.method === 'POST') return ALREADY_THERE;
      if (url === `/api/v1/items/${ID}` && !opts?.method) {
        return {
          success: true,
          data: serverRow({
            encrypted_content: JSON.stringify({ title: 'Written offline', body: '', note_type: 'text', labels: [], notebook_id: 'nb' }),
            wrapped_content_key: 'row-wrap', notebook_id: null, version: 4, content_key_generation: 3,
          }),
        };
      }
      if (url === `/api/v1/items/${ID}` && opts?.method === 'PUT') return placing;
      return { success: false, status: 404 };
    });

    /**
     * The create's own rule (`placementRefused`): what the server did not place
     * in the notebook is passed on to nobody. A row that names no notebook,
     * while the notebook has an item for it to name, was EITHER refused there
     * or sent up before the notebook had an item. The row cannot say which, so
     * the server is asked: the note is placed now.
     */
    /**
     * What the server REALLY answers a write it may not place: 200, with the
     * notebook left as it was — a request that is not allowed leaves the
     * column as it is, and nothing is refused. So a 200 alone does not mean
     * "placed", and a faked 403 would test an answer that write never gets.
     */
    it('a row that names no notebook is PLACED first: not taken, the note is passed on to nobody', async () => {
      landedWithNoNotebookOnItsRow({ success: true, data: { id: ID, version: 5, updated_at: '2026-10-07T10:00:00Z', notebook_id: null } });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(placings()).toHaveLength(1);
      expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
      expect(noteDb.removePending).toHaveBeenCalledWith(ID);
    });

    it('nor when the answer does not say where the row is, or names another notebook', async () => {
      landedWithNoNotebookOnItsRow({ success: true, data: { id: ID, version: 5, updated_at: '2026-10-07T10:00:00Z' } });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      landedWithNoNotebookOnItsRow({ success: true, data: { id: ID, version: 5, updated_at: '2026-10-07T10:00:00Z', notebook_id: 'own-nb' } });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
    });

    it('nor is it asked at all when this very replay was just refused the notebook', async () => {
      // The replay's own create is refused the notebook (403), sent again without it, and found to have landed.
      const posts: unknown[] = [];
      apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: { notebook_id?: string | null } }) => {
        if (url === '/api/v1/items' && opts?.method === 'POST') {
          posts.push(opts.body?.notebook_id ?? null);
          return opts.body?.notebook_id ? { success: false, status: 403, error_code: 'share_permission_denied' } : ALREADY_THERE;
        }
        if (url === `/api/v1/items/${ID}` && !opts?.method) {
          return {
            success: true,
            data: serverRow({
              encrypted_content: JSON.stringify({ title: 'Written offline', body: '', note_type: 'text', labels: [], notebook_id: 'nb' }),
              wrapped_content_key: 'row-wrap', notebook_id: null, version: 1,
            }),
          };
        }
        // The server would answer 200 and place nothing: it must not even be asked.
        if (url === `/api/v1/items/${ID}` && opts?.method === 'PUT') return { success: true, data: { id: ID, version: 2, updated_at: 't', notebook_id: 'nb' } };
        return { success: false, status: 404 };
      });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(posts).toEqual(['nb', null]);
      expect(placings()).toHaveLength(0);
      expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
    });

    it('taken, it is passed on: the notebook had no item when the note first went up, and has one now', async () => {
      landedWithNoNotebookOnItsRow({ success: true, data: { id: ID, version: 5, updated_at: '2026-10-07T10:00:00Z', notebook_id: 'nb' } });
      const queued = await (async () => {
        // On screen as waiting, so that what the write changes can be seen on the card.
        server({ success: false, status: 503 }, { success: false, status: 503 });
        notebookItemState.mockImplementation(async () => 'none');
        await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, undefined);
        notebookItemState.mockImplementation(async () => 'item');
        return vi.mocked(noteDb.queuePending).mock.calls[0][0] as { id: string };
      })();
      apiRequest.mockClear();
      const row = (over: Record<string, unknown>) => serverRow({
        id: queued.id,
        encrypted_content: JSON.stringify({ title: 'Written offline', body: '', note_type: 'text', labels: [], notebook_id: 'nb' }),
        wrapped_content_key: 'row-wrap', notebook_id: null, version: 4, content_key_generation: 3, ...over,
      });
      apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
        if (url === '/api/v1/items' && opts?.method === 'POST') return ALREADY_THERE;
        if (url === `/api/v1/items/${queued.id}` && !opts?.method) return { success: true, data: row({}) };
        if (url === `/api/v1/items/${queued.id}` && opts?.method === 'PUT') return { success: true, data: { id: queued.id, version: 5, updated_at: '2026-10-07T10:00:00Z', notebook_id: 'nb' } };
        return { success: false, status: 404 };
      });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, queued.id);
      // One write, naming the notebook and changing nothing else: the row's own bytes, at its version.
      const put = apiRequest.mock.calls.filter(c => c[0] === `/api/v1/items/${queued.id}` && c[1]?.method === 'PUT');
      expect(put.map(c => c[1].body)).toEqual([{
        encrypted_content: row({}).encrypted_content, content_nonce: 'n', expected_version: 4, notebook_id: 'nb',
      }]);
      // Placed BEFORE it is passed on: the row is what keeps it from a reader who declined the notebook.
      const order = apiRequest.mock.invocationCallOrder[apiRequest.mock.calls.indexOf(put[0])];
      expect(order).toBeLessThan(shareNoteWithRecipientResult.mock.invocationCallOrder[0]);
      expect(sharedTo()).toEqual([[queued.id, 'ben@example.test']]);
      // The card is at the version the write left the row at.
      expect(notesStore.notes().find(n => n.id === queued.id)?.version).toBe(5);
    });

    it('a row that names the notebook already is not written again', async () => {
      landedIn('nb');
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(placings()).toHaveLength(0);
    });

    it('nor is one in a notebook that has no item to name, or a note in no notebook', async () => {
      notebookItemState.mockImplementation(async () => 'none');
      landedIn(null);
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(placings()).toHaveLength(0);
      server(ALREADY_THERE, { success: true, data: serverRow({ wrapped_content_key: 'row-wrap' }) });
      notebookItemState.mockImplementation(async () => 'item');
      await notesStore.createNote({ title: 'Written offline' }, ID);
      expect(placings()).toHaveLength(0);
    });

    /** With no card in memory the share is still signed for the row's generation. */
    it('is sealed for the generation of the row\'s key, card or no card', async () => {
      landedIn('nb', { content_key_generation: 3 });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(shareNoteWithRecipientResult.mock.calls[0][3]).toEqual({ contentKeyGeneration: 3 });
    });

    it('nor is one whose row names another notebook', async () => {
      landedIn('another-notebook');
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
    });

    it('a notebook with no item on the server is named on no row: its note is passed on, as a new one is', async () => {
      notebookItemState.mockImplementation(async () => 'none');
      landedIn(null);
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(sharedTo()).toEqual([[ID, 'ben@example.test']]);
    });

    /** It is not a landing at all: nothing is taken, and nothing passed on. */
    it('a row with no key of its own is not the note this browser sent: nothing is passed on, and its entry stays', async () => {
      landedIn('nb', { wrapped_content_key: null, wrapped_content_key_nonce: null });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
      expect(noteDb.removePending).not.toHaveBeenCalled();
    });

    it('the id of the row is the same one however it is capitalised', async () => {
      landedIn('nb', { id: ID.toUpperCase() });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(sharedTo()).toEqual([[ID, 'ben@example.test']]);
      expect(noteDb.removePending).toHaveBeenCalledWith(ID);
    });

    it('nothing is passed on when the row could not be fetched: the next drain asks again', async () => {
      server(ALREADY_THERE, { success: false, status: 503 });
      await notesStore.createNote({ title: 'Written offline', notebookId: 'nb' }, ID);
      expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
      expect(noteDb.removePending).not.toHaveBeenCalled();
    });

    it('a landed note in no notebook goes to nobody', async () => {
      server(ALREADY_THERE, { success: true, data: serverRow({ wrapped_content_key: 'row-wrap' }) });
      await notesStore.createNote({ title: 'Written offline' }, ID);
      expect(shareNoteWithRecipientResult).not.toHaveBeenCalled();
    });
  });

  it('a first attempt answered that way is a refusal like any other: nothing is fetched', async () => {
    server(ALREADY_THERE, { success: true, data: serverRow() });
    const r = await notesStore.createNote({ title: 'A new note' });
    expect(r).toEqual({ note: null, queued: false });
    expect(apiRequest.mock.calls.filter(c => String(c[0]).startsWith('/api/v1/items/')).length).toBe(0);
    // Nothing stays queued: the composer has the text.
    expect(noteDb.removePending).toHaveBeenCalledTimes(1);
  });

  it('a conflict that does not say the note is there is not taken for one', async () => {
    server({ success: false, status: 409 }, { success: true, data: serverRow() });
    await notesStore.createNote({ title: 'Written offline' }, ID);
    expect(rowReads()).toBe(0);
    expect(noteDb.removePending).not.toHaveBeenCalled();
  });

  /**
   * The other refusals keep their entry, as before: the note is NOT on the
   * server, so "not synced" on its card and a warning at sign-out are true.
   */
  it('a replay the server refuses for another reason still keeps its entry', async () => {
    for (const refusal of [{ success: false, status: 413 }, { success: false, status: 400 }, { success: false, status: 403, error_code: 'item_not_owned' }]) {
      vi.mocked(noteDb.removePending).mockClear();
      server(refusal, { success: true, data: serverRow() });
      await notesStore.createNote({ title: 'Written offline' }, ID);
      expect(noteDb.removePending).not.toHaveBeenCalled();
      expect(rowReads()).toBe(0);
    }
  });
});

describe('a new note in a shared notebook', () => {
  it("is sealed to the directory's CURRENT key, not the one cached at invite", async () => {
    lookupDirectoryKeys.mockResolvedValue(new Map([['ben@example.test', NEW_KEYS]]));
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });

    await notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });

    const recipient = shareNoteWithRecipientResult.mock.calls[0][2] as { publicKey: string; signingPublicKey: string };
    expect(recipient.publicKey).toBe(NEW_KEYS.sharingPub);
    expect(recipient.signingPublicKey).toBe(NEW_KEYS.signingPub);
  });

  it('records a recipient it could not reach, so the owner can see it', async () => {
    lookupDirectoryKeys.mockResolvedValue(new Map([['ben@example.test', NEW_KEYS]]));
    shareNoteWithRecipientResult.mockResolvedValue({ ok: false, reason: 'key-changed' });

    await notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });

    expect(shareHealthStore.notReceiving('nb')).toEqual([{ email: 'ben@example.test', reason: 'key-changed' }]);
  });

  it('falls back to the cached key when the directory cannot be asked', async () => {
    lookupDirectoryKeys.mockResolvedValue(null);
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });

    await notesStore.createNote({ title: 'Seating plan', notebookId: 'nb' });

    const recipient = shareNoteWithRecipientResult.mock.calls[0][2] as { publicKey: string };
    expect(recipient.publicKey).toBe('aa'.repeat(32));
  });
});

describe('a new note in a notebook we are a MEMBER of', () => {
  it('is sealed to the key in the owner-written roster, never swapped for a directory answer', async () => {
    // The directory claims a different key for the same member — exactly what a
    // server substituting keys would say. The roster is the owner's word.
    lookupDirectoryKeys.mockResolvedValue(new Map([['cara@example.test',
      { userId: 'cara-id', sharingPub: '99'.repeat(32), signingPub: '88'.repeat(32) }]]));
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });

    await notesStore.createNote({ title: 'Guest list', notebookId: 'member-nb' });

    const recipient = shareNoteWithRecipientResult.mock.calls
      .map(c => c[2] as { email: string; publicKey: string })
      .find(r => r.email === 'cara@example.test');
    expect(recipient?.publicKey).toBe('ee'.repeat(32));
  });
});

describe('the owner of a notebook, from the inbox', () => {
  /** An inbox row naming `notebookId`, from someone the server names as its owner. */
  const rowNaming = (notebookId: string, sharerEmail: string) => (id: string) =>
    (id === notebookId ? { itemId: notebookId, sharerEmail, contentKey: null } : undefined);
  const recipients = () => shareNoteWithRecipientResult.mock.calls.map(c => (c[2] as { email: string }).email);
  const lookedUp = () => apiRequest.mock.calls
    .filter(c => c[0] === '/api/v1/users/public-keys')
    .flatMap(c => (c[1] as { body: { emails: string[] } }).body.emails);

  it('is never taken for our own notebook with its metadata rolled back, whatever the inbox serves', async () => {
    // 'own-nb' was opened with our vault and has a roster, but no standing list:
    // the metadata item was withheld or rolled back. The inbox names it with
    // an "owner" the server chose.
    inboxRowFor.mockImplementation(rowNaming('own-nb', 'mallory@example.test'));
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });

    await notesStore.createNote({ title: 'Plans', notebookId: 'own-nb' });

    expect(recipients()).toEqual(['cara@example.test']);
    expect(lookedUp()).not.toContain('mallory@example.test');
  });

  it('is never taken for a notebook with a roster that was not opened through a share', async () => {
    inboxRowFor.mockImplementation(rowNaming('unknown-nb', 'mallory@example.test'));
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });

    await notesStore.createNote({ title: 'Plans', notebookId: 'unknown-nb' });

    expect(recipients()).toEqual(['cara@example.test']);
    expect(lookedUp()).not.toContain('mallory@example.test');
  });

  it('is taken, and looked up, for a notebook opened through an accepted share', async () => {
    inboxRowFor.mockImplementation(rowNaming('member-nb', 'olivia@example.test'));
    shareNoteWithRecipientResult.mockResolvedValue({ ok: true });

    await notesStore.createNote({ title: 'Guest list', notebookId: 'member-nb' });

    expect(recipients()).toEqual(['cara@example.test', 'olivia@example.test']);
    expect(lookedUp()).toEqual(['olivia@example.test']);
  });
});
