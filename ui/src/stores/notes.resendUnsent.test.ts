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

const { ME, standing, onServer, rows } = vi.hoisted(() => ({
  ME: '0e0e0e0e-0000-4000-8000-00000000000e',
  /** Each notebook's standing list, as the owner's metadata holds it. */
  standing: {} as Record<string, { email: string; permission: 'edit' | 'view'; publicKey: string | null; userId?: string | null; signingPublicKey?: string | null }[]>,
  onServer: {} as Record<string, { email: string; permission: 'edit' | 'view'; publicKey: string | null }[]>,
  rows: [] as unknown[],
}));

/**
 * A new note that failed to reach somebody who already had the notebook is
 * sent again, as the Share panel promises ("It is retried with the next note
 * you add"): with the next note (lib/unsentShares, `resendUnsent`), and after
 * a sync at most every ten minutes; never once the note has left the
 * notebook, the person has, or the failure will not pass.
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
const local = memoryStorage();
vi.stubGlobal('localStorage', local);

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap', nonce: 'wrapn' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  opensBoundToItem: () => true,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));

/** Everything shared, in order: `notebook <id> → <email> key|no key` and `note <id> → …`. */
const shared: string[] = [];
type Recipient = { email: string; publicKey: string | null; permission: string };
const shareNoteWithRecipientResult = vi.fn(async (id: string, _key: Uint8Array, r: Recipient) => {
  shared.push(`note ${id} → ${r.email} ${r.publicKey ? 'sealed' : 'no key'}`);
  return { ok: true };
});
const shareNotebookWithRecipientResult = vi.fn(async (id: string, r: Recipient, grant: string): Promise<string> => {
  shared.push(`notebook ${id} → ${r.email} ${grant} ${r.publicKey ? 'sealed' : 'no key'}`);
  return 'shared';
});
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: (...a: unknown[]) => shareNoteWithRecipientResult(...(a as [string, Uint8Array, Recipient])),
  shareNotebookWithRecipientResult: (...a: unknown[]) => shareNotebookWithRecipientResult(...(a as [string, Recipient, string])),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));

/** Who has an account, by lower-cased address. */
const directory = new Map<string, { userId: string; sharingPub: string; signingPub: string }>();
const lookupDirectoryKeys = vi.fn(async (emails: string[]) => {
  const out = new Map<string, { userId: string; sharingPub: string; signingPub: string }>();
  for (const e of emails) {
    const found = directory.get(e.toLowerCase());
    if (found) out.set(e.toLowerCase(), found);
  }
  return out as Map<string, { userId: string; sharingPub: string; signingPub: string }> | null;
});
vi.mock('../lib/recipientKeys', async () => {
  const real = await vi.importActual<typeof import('../lib/recipientKeys')>('../lib/recipientKeys');
  return { ...real, lookupDirectoryKeys: (...a: unknown[]) => lookupDirectoryKeys(...(a as [string[]])) };
});

const notebookItemState = vi.fn(async (id: string | null | undefined): Promise<'item' | 'none' | 'unknown'> => (id ? 'item' : 'none'));
const addNotebookShare = vi.fn((id: string, r: (typeof standing)[string][number]) => {
  standing[id] = [...(standing[id] ?? []).filter(e => e.email.toLowerCase() !== r.email.toLowerCase()), r];
});
/** As the store's: only an entry that is still there, without a key, is given its keys. It adds nobody. */
/** The standing list's write, landed: a test's merge changes the list here. */
const whenWritten = vi.fn(async () => {});
/** What a take-back runs: the removal, again (lib/removeNotebookMember). */
const removeNotebookMember = vi.fn(async (_notebookId: string, _email: string) => {});
vi.mock('../lib/removeNotebookMember', () => ({
  removeNotebookMember: (...a: unknown[]) => removeNotebookMember(...(a as [string, string])),
}));
const finishNotebookShare = vi.fn((id: string, r: (typeof standing)[string][number]) => {
  const waits = (e: (typeof standing)[string][number]) => e.email.toLowerCase() === r.email.toLowerCase() && !e.publicKey;
  if (!(standing[id] ?? []).some(waits)) return false;
  standing[id] = (standing[id] ?? []).map(e => (waits(e) ? r : e));
  return true;
});
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => true,
    notebookItemState: (id: string | null | undefined) => notebookItemState(id),
    learnNotebookItem: async (id: string | null | undefined) => (await notebookItemState(id)) === 'item',
    getNotebookShares: (id: string) => standing[id] ?? [],
    addNotebookShare: (...a: unknown[]) => addNotebookShare(...(a as [string, (typeof standing)[string][number]])),
    finishNotebookShare: (...a: unknown[]) => finishNotebookShare(...(a as [string, (typeof standing)[string][number]])),
    serverStandingOf: async (id: string) => onServer[id] ?? standing[id] ?? [],
    whenWritten: () => whenWritten(),
    notebooks: () => Object.keys(standing).map(id => ({ id, name: id, noteCount: 0 })),
    membersOf: () => [],
    notebookOpenedVia: () => 'vault',
    loadFromSyncedItems: () => {}, gcEditorModes: () => {},
    markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
    pruneAcceptances: async () => {}, rememberAcceptances: () => {},
  },
}));
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: () => undefined,
    load: async () => true,
    sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {}, applyLocalEdit: () => {},
  },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => rows,
  loadCursor: async () => '2026-10-01T00:00:00Z',
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

const ZOE = { email: 'zoe@example.test', permission: 'edit' as const, publicKey: null, userId: null, signingPublicKey: null };
const BEN = { email: 'ben@example.test', permission: 'edit' as const, publicKey: 'aa'.repeat(32), userId: 'ben-id', signingPublicKey: 'bb'.repeat(32) };
const hasAnAccountNow = (email: string) => directory.set(email, { userId: `${email}-id`, sharingPub: 'cc'.repeat(32), signingPub: 'dd'.repeat(32) });
const OLD = 'aaaaaaaa-1111-4111-8111-11111111111a';
const OLD2 = 'aaaaaaaa-1111-4111-8111-11111111111b';
const note = (id: string, notebookId: string | null, over: Record<string, unknown> = {}) => ({
  id, title: 'A note', body: '', noteType: 'text', color: null, isPinned: false, isArchived: false, labels: [],
  sortOrder: 0, editMode: 'rich', notebookId, hasAttachments: false, version: 1,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deleted: false,
  wrappedContentKey: 'wrap', wrappedContentKeyNonce: 'wrapn', openedVia: 'vault', ...over,
});

let notesStore: typeof import('./notes').notesStore;
let unsent: typeof import('../lib/unsentShares');
async function load() {
  vi.resetModules();
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  unsent = await import('../lib/unsentShares');
  await notesStore.hydrateFromCache();
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
/** The notes that went to `email`, in order (each attempt, whatever came of it). */
const sentTo = (email: string) => shareNoteWithRecipientResult.mock.calls.filter(c => (c[2] as Recipient).email === email).map(c => c[0]);
/** Makes the share of `noteId` to `email` fail, as `reason`, until `ok()` is called. */
function failing(noteId: () => string | undefined, email: string, reason: string) {
  let down = true;
  shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
    shared.push(`note ${id} → ${r.email} ${r.publicKey ? 'sealed' : 'no key'}`);
    return down && id === noteId() && r.email === email ? { ok: false, reason } : { ok: true };
  });
  return { ok: () => { down = false; } };
}

beforeEach(async () => {
  vi.clearAllMocks();
  local.clear();
  shared.length = 0;
  rows.length = 0;
  for (const id of Object.keys(standing)) delete standing[id];
  standing.nb = [BEN];
  notebookItemState.mockImplementation(async (id) => (id ? 'item' : 'none'));
  // Every share goes, unless a test says otherwise (clearAllMocks keeps an implementation).
  shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
    shared.push(`note ${id} → ${r.email} ${r.publicKey ? 'sealed' : 'no key'}`);
    return { ok: true };
  });
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: { id?: string; notebook_id?: string | null } }) => {
    if (url === '/api/v1/items' && opts?.method === 'POST') {
      return { success: true, data: { id: opts.body?.id, version: 1, created_at: 't', updated_at: 't' } };
    }
    if (String(url).startsWith('/api/v1/items/') && opts?.method === 'PUT') {
      return { success: true, data: { version: 2, updated_at: 't2', notebook_id: opts.body?.notebook_id ?? null } };
    }
    if (String(url).startsWith('/api/v1/sync/pull')) {
      return { success: true, data: { items: [], cursor: '2026-10-07T00:00:00Z', cursor_id: null, has_more: false } };
    }
    return { success: false, status: 404 };
  });
  await load();
});

describe('a note that did not reach someone in its notebook', () => {
  it('is sent again with the next note added to the notebook, and then forgotten', async () => {
    let first: string | undefined;
    const ben = failing(() => first, BEN.email, 'failed');
    first = undefined;
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    first = a.note!.id;
    // The fan-out ran before `first` was known: run the failure for A now, as its create's share would have.
    expect(sentTo(BEN.email)).toEqual([first]);
    shareNoteWithRecipientResult.mockClear();
    unsent.rememberUnsent(first, 'nb', BEN.email, 'failed');
    ben.ok();
    const b = await notesStore.createNote({ title: 'B', notebookId: 'nb' });
    expect(sentTo(BEN.email)).toEqual([b.note!.id, first]);
    expect(unsent.unsentShares()).toEqual([]);
  });

  it('a failed share of a new note is kept, and a failure that will not pass is not', async () => {
    shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
      shared.push(`note ${id} → ${r.email}`);
      return { ok: false, reason: 'failed' };
    });
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    expect(unsent.unsentShares().map(e => [e.noteId, e.notebookId, e.email])).toEqual([[a.note!.id, 'nb', BEN.email]]);

    shareNoteWithRecipientResult.mockImplementation(async () => ({ ok: false, reason: 'key-changed' }));
    const b = await notesStore.createNote({ title: 'B', notebookId: 'nb' });
    // A was tried again with B, and is forgotten now: its key-change is the Share panel's to show.
    expect(unsent.unsentShares().map(e => e.noteId)).not.toContain(b.note!.id);
    expect(unsent.unsentShares()).toEqual([]);
  });

  it('is not sent again once the person has left the notebook, nor once the note has', async () => {
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    const moved = await notesStore.createNote({ title: 'Moved', notebookId: 'nb' });
    unsent.rememberUnsent(a.note!.id, 'nb', 'gone@example.test', 'failed');
    unsent.rememberUnsent(moved.note!.id, 'nb', BEN.email, 'failed');
    notesStore.applyLocalPatch({ ...moved.note!, notebookId: 'elsewhere' });
    shareNoteWithRecipientResult.mockClear();
    const c = await notesStore.createNote({ title: 'C', notebookId: 'nb' });
    expect(sentTo(BEN.email)).toEqual([c.note!.id]);
    expect(sentTo('gone@example.test')).toEqual([]);
    expect(unsent.unsentShares()).toEqual([]);
  });

  /**
   * A note in the trash: nothing at all is done for it, not even a look at its
   * people's keys, and it is forgotten. This pins the early guard itself: the
   * re-check before the seal would also catch the note, but only later.
   */
  it('a note in the trash has no key looked up for it, is sealed to nobody, and is forgotten', async () => {
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    notesStore.applyLocalPatch({ ...notesStore.notes().find(n => n.id === a.note!.id)!, deleted: true });
    unsent.rememberUnsent(a.note!.id, 'nb', BEN.email, 'failed');
    lookupDirectoryKeys.mockClear();
    shareNoteWithRecipientResult.mockClear();
    await notesStore.sync();
    await settle();
    // One lookup: the sync's own check of everyone's keys (shareHealth). None for the note in the trash.
    expect(lookupDirectoryKeys).toHaveBeenCalledTimes(1);
    expect(sentTo(BEN.email)).toEqual([]);
    expect(unsent.unsentShares()).toEqual([]);
  });

  /**
   * A note opened through a share (someone else's): this account does not
   * pass it on, whatever its key does here.
   */
  it('a note opened through a share is never sent on, and is forgotten', async () => {
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    notesStore.applyLocalPatch({ ...notesStore.notes().find(n => n.id === a.note!.id)!, openedVia: 'share' });
    unsent.rememberUnsent(a.note!.id, 'nb', BEN.email, 'failed');
    shareNoteWithRecipientResult.mockClear();
    await notesStore.sync();
    await settle();
    expect(sentTo(BEN.email)).toEqual([]);
    expect(unsent.unsentShares()).toEqual([]);
  });

  it('a note moved into a notebook that did not reach someone there is kept too', async () => {
    standing.nb = [];
    standing.dest = [BEN];
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    shareNoteWithRecipientResult.mockImplementation(async () => ({ ok: false, reason: 'failed' }));
    await notesStore.updateNote(a.note!.id, { notebookId: 'dest' });
    await settle();
    expect(unsent.unsentShares().map(e => [e.noteId, e.notebookId, e.email])).toEqual([[a.note!.id, 'dest', BEN.email]]);
  });

  it('is sent again after a sync too, at most once in ten minutes, with no new note', async () => {
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    unsent.rememberUnsent(a.note!.id, 'nb', BEN.email, 'failed');
    shareNoteWithRecipientResult.mockClear();
    await notesStore.sync();
    await settle();
    expect(sentTo(BEN.email)).toEqual([a.note!.id]);
    expect(unsent.unsentShares()).toEqual([]);

    unsent.rememberUnsent(a.note!.id, 'nb', BEN.email, 'failed');
    shareNoteWithRecipientResult.mockClear();
    await notesStore.sync();
    await settle();
    expect(sentTo(BEN.email)).toEqual([]);
  });
});

const KAT = { email: 'kat@example.test', permission: 'edit' as const, publicKey: 'ee'.repeat(32), userId: 'kat-id', signingPublicKey: 'ff'.repeat(32) };

describe('a removal made while a re-send goes', () => {
  it('someone removed from the notebook while a resend is under way is sent no more notes', async () => {
    standing.nb = [BEN, KAT];
    const a1 = await notesStore.createNote({ title: 'A1', notebookId: 'nb' });
    const a2 = await notesStore.createNote({ title: 'A2', notebookId: 'nb' });
    unsent.rememberUnsent(a1.note!.id, 'nb', KAT.email, 'failed');
    unsent.rememberUnsent(a2.note!.id, 'nb', KAT.email, 'failed');
    shareNoteWithRecipientResult.mockClear();
    // The resend's first share is slow: the owner removes Kat meanwhile (removeNotebookMember
    // takes her off the standing list FIRST).
    let letGo!: () => void;
    const gate = new Promise<void>(r => { letGo = r; });
    shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
      if (id === a1.note!.id && r.email === KAT.email) await gate;
      shared.push(`note ${id} → ${r.email}`);
      return { ok: true };
    });
    await notesStore.sync();
    await vi.waitFor(() => expect(sentTo(KAT.email)).toEqual([a1.note!.id]));
    standing.nb = [BEN];
    letGo();
    await settle();
    // A2 must not be sealed to someone who is no longer in the notebook.
    expect(sentTo(KAT.email)).toEqual([a1.note!.id]);
  });
});

describe('a note that did not reach Ben, moved to another notebook Ben is in too', () => {
  it('reaches Ben at last', async () => {
    standing.nb = [BEN];
    standing.nb2 = [BEN, KAT];
    shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
      shared.push(`note ${id} → ${r.email}`);
      return r.email === BEN.email && shared.filter(l => l.includes(BEN.email)).length === 1 ? { ok: false, reason: 'failed' } : { ok: true };
    });
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    expect(unsent.unsentShares().map(e => [e.noteId, e.email])).toEqual([[a.note!.id, BEN.email]]);
    await notesStore.updateNote(a.note!.id, { notebookId: 'nb2' });
    await notesStore.sync();
    await settle();
    const toBen = shareNoteWithRecipientResult.mock.calls.filter(c => c[0] === a.note!.id && (c[2] as Recipient).email === BEN.email);
    expect(toBen.length).toBeGreaterThan(1);
    expect(unsent.unsentShares()).toEqual([]);
  });

  it('not reaching him there either: kept as owed in the notebook it is in now, and sent with the next note added there', async () => {
    standing.nb = [BEN];
    standing.nb2 = [BEN, KAT];
    let benFails = 2;
    shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
      shared.push(`note ${id} → ${r.email}`);
      if (r.email === BEN.email && benFails > 0) { benFails--; return { ok: false, reason: 'failed' }; }
      return { ok: true };
    });
    const a = await notesStore.createNote({ title: 'A', notebookId: 'nb' });
    await notesStore.updateNote(a.note!.id, { notebookId: 'nb2' });
    await notesStore.sync();
    await settle();
    expect(unsent.unsentShares().map(e => [e.noteId, e.notebookId, e.email])).toEqual([[a.note!.id, 'nb2', BEN.email]]);
    shareNoteWithRecipientResult.mockClear();
    await notesStore.createNote({ title: 'B', notebookId: 'nb2' });
    await settle();
    expect(shareNoteWithRecipientResult.mock.calls.some(c => c[0] === a.note!.id && (c[2] as Recipient).email === BEN.email)).toBe(true);
    expect(unsent.unsentShares()).toEqual([]);
  });
});
