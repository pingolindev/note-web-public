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
  /** A notebook's list as the SERVER holds it, where a test makes it differ (another device). */
  onServer: {} as Record<string, { email: string; permission: 'edit' | 'view'; publicKey: string | null }[]>,
  /** The notes the page finds in its cache when it loads. */
  rows: [] as unknown[],
}));

/**
 * Someone invited to a notebook before they had an account: the invitation
 * is queued for them until they have one.
 *
 * The standing list keeps them with no key. A fan-out that filled in whatever
 * the directory publishes for the address NOW would, once they had signed up,
 * seal the next note in the notebook straight to them: a note with no
 * invitation, from a notebook never shared with them.
 *
 * The rule is in lib/finishInvitations; these are the store's three moments:
 * a new note, a note moved in, and the end of a sync.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
/** Per-account storage: lib/unsentShares keeps there what a note could not deliver. */
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
async function load() {
  vi.resetModules();
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
/**
 * How often the directory was asked about this address ALONE, as a waiting
 * invitation is. (The first sync of a page also asks about everybody on every
 * standing list at once, for the key-change badge: shareHealthStore.refresh.)
 */
const askedAbout = (email: string) => lookupDirectoryKeys.mock.calls.filter(c => c[0].length === 1 && c[0][0] === email).length;

beforeEach(async () => {
  vi.clearAllMocks();
  // A one-time answer a test queued and did not use (the sync test's 'offline') would answer the next
  // test's first lookup: back to the directory, with nothing queued.
  lookupDirectoryKeys.mockReset();
  local.clear();
  shared.length = 0;
  rows.length = 0;
  directory.clear();
  for (const id of Object.keys(standing)) delete standing[id];
  for (const id of Object.keys(onServer)) delete onServer[id];
  standing.nb = [BEN, ZOE];
  rows.push(note(OLD, 'nb'));
  notebookItemState.mockImplementation(async (id) => (id ? 'item' : 'none'));
  shareNotebookWithRecipientResult.mockImplementation(async (id, r, grant) => {
    shared.push(`notebook ${id} → ${r.email} ${grant} ${r.publicKey ? 'sealed' : 'no key'}`);
    return 'shared';
  });
  shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
    shared.push(`note ${id} → ${r.email} ${r.publicKey ? 'sealed' : 'no key'}`);
    return { ok: true };
  });
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: { id?: string; notebook_id?: string | null } }) => {
    if (url === '/api/v1/items' && opts?.method === 'POST') {
      return { success: true, data: { id: opts.body?.id, version: 1, created_at: 't', updated_at: 't' } };
    }
    if (String(url).startsWith('/api/v1/items/') && opts?.method === 'PUT') {
      // As the server answers an update: the item, its notebook column included.
      return { success: true, data: { version: 2, updated_at: 't2', notebook_id: opts.body?.notebook_id ?? null } };
    }
    if (String(url).startsWith('/api/v1/sync/pull')) {
      return { success: true, data: { items: [], cursor: '2026-10-07T00:00:00Z', cursor_id: null, has_more: false } };
    }
    return { success: false, status: 404 };
  });
  await load();
});

describe('a new note in a notebook where someone was invited before they had an account', () => {
  it('while they still have none: it gets the keyless row it always got, and nothing is sealed for them', async () => {
    const r = await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    const id = r.note!.id;
    expect(shared).toEqual([`note ${id} → ben@example.test sealed`, `note ${id} → zoe@example.test no key`]);
    expect(shareNotebookWithRecipientResult).not.toHaveBeenCalled();
  });

  it('once they have one, their invitation is finished FIRST: the notebook, its notes, and only then this note', async () => {
    hasAnAccountNow('zoe@example.test');
    const r = await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    const id = r.note!.id;
    expect(shared[0]).toBe('notebook nb → zoe@example.test edit sealed');
    // Every note of the notebook, the new one among them, and then the fan-out's own pass.
    expect(shared.slice(1).sort()).toEqual([
      `note ${OLD} → zoe@example.test sealed`,
      `note ${id} → zoe@example.test sealed`,
      `note ${id} → ben@example.test sealed`,
      `note ${id} → zoe@example.test sealed`,
    ].sort());
    // And the standing entry has its keys now.
    expect(finishNotebookShare).toHaveBeenCalledWith('nb', expect.objectContaining({ email: 'zoe@example.test', publicKey: 'cc'.repeat(32), userId: 'zoe@example.test-id' }));
    // Never by the Share panel's own write, which lifts a removal.
    expect(addNotebookShare).not.toHaveBeenCalled();
    expect(standing.nb.find(e => e.email === 'zoe@example.test')?.publicKey).toBe('cc'.repeat(32));
  });

  it('removed by the owner while its notes are going out: not one more note is sealed to them', async () => {
    rows.push(note(OLD2, 'nb'));
    await load();
    hasAnAccountNow('zoe@example.test');
    // The owner takes Zoe off as soon as her first note has gone.
    shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
      shared.push(`note ${id} → ${r.email} ${r.publicKey ? 'sealed' : 'no key'}`);
      if (r.email === 'zoe@example.test') standing.nb = standing.nb.filter(e => e.email !== 'zoe@example.test');
      return { ok: true };
    });
    await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    const toZoe = shared.filter(line => line.startsWith('note ') && line.includes('zoe@example.test'));
    expect(toZoe).toHaveLength(1);
  });

  it('removed on another device: the list the server holds is read again, and nothing is sealed for them', async () => {
    onServer.nb = [BEN];
    hasAnAccountNow('zoe@example.test');
    await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    expect(shareNotebookWithRecipientResult).not.toHaveBeenCalled();
    expect(shared.filter(line => line.includes('zoe@example.test') && line.endsWith('sealed'))).toEqual([]);
  });

  it('removed on another device while it was being finished: the write merges it in, and it is taken back', async () => {
    hasAnAccountNow('zoe@example.test');
    whenWritten.mockImplementationOnce(async () => {
      standing.nb = standing.nb.filter(e => e.email !== 'zoe@example.test');
    });
    await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    expect(whenWritten).toHaveBeenCalled();
    expect(removeNotebookMember).toHaveBeenCalledWith('nb', 'zoe@example.test');
  });

  /**
   * A note that did not go does not hold her invitation back (otherwise a
   * notebook of more notes than the server takes in a minute would never be
   * finished). Her entry is given its keys, and the note that did not go is
   * sent again: with the next note added to the notebook.
   */
  it('a note of the notebook that did not go: her entry is given its keys anyway, and that note is sent again with the next one', async () => {
    hasAnAccountNow('zoe@example.test');
    let oldGoes = false;
    shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
      const fails = id === OLD && r.email === 'zoe@example.test' && !oldGoes;
      shared.push(`note ${id} → ${r.email} ${r.publicKey ? 'sealed' : 'no key'}${fails ? ' (did not go)' : ''}`);
      return fails ? { ok: false, reason: 'failed' } : { ok: true };
    });
    let clock = Date.parse('2026-10-11T10:00:00Z');
    const clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const first = await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    await settle();
    expect(shareNotebookWithRecipientResult).toHaveBeenCalledWith('nb', expect.objectContaining({ email: 'zoe@example.test' }), 'edit');
    expect(finishNotebookShare).toHaveBeenCalled();
    expect(standing.nb.find(e => e.email === 'zoe@example.test')?.publicKey).not.toBeNull();
    expect(removeNotebookMember).not.toHaveBeenCalled();
    // The new note reaches her sealed: her entry has its keys.
    expect(shared).toContain(`note ${first.note!.id} → zoe@example.test sealed`);
    const { unsentShares } = await import('../lib/unsentShares');
    expect(unsentShares().map(e => [e.noteId, e.notebookId, e.email.toLowerCase()])).toEqual([[OLD, 'nb', 'zoe@example.test']]);
    // Not with a note added within the minute (the server's limit is per minute)...
    oldGoes = true;
    shared.length = 0;
    await notesStore.createNote({ title: 'Soon after', notebookId: 'nb' });
    await settle();
    expect(shared).not.toContain(`note ${OLD} → zoe@example.test sealed`);
    // ...and with the next note after it.
    clock += 61_000;
    shared.length = 0;
    await notesStore.createNote({ title: 'Another', notebookId: 'nb' });
    await settle();
    expect(shared).toContain(`note ${OLD} → zoe@example.test sealed`);
    expect(unsentShares()).toEqual([]);
    clockSpy.mockRestore();
  });

  /** With the store's own steps: the owner adds Zoe back in the Share panel meanwhile. */
  for (const [what, addsBack, takenBack] of [
    ['the owner\'s share in flight, which adds her back, is waited for: nothing is taken back', true, false],
    ['the owner\'s share in flight that does not add her back: once it ended, the finish is taken back', false, true],
  ] as const) {
    it(`removed while her notes went out, and ${what}`, async () => {
      const { beginOwnerShare } = await import('../lib/ownerShareInFlight');
      hasAnAccountNow('zoe@example.test');
      let begun = false;
      shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
        shared.push(`note ${id} → ${r.email} ${r.publicKey ? 'sealed' : 'no key'}`);
        if (r.email === 'zoe@example.test' && !begun) {
          begun = true;
          standing.nb = standing.nb.filter(e => e.email !== 'zoe@example.test');
          const end = beginOwnerShare('nb', 'zoe@example.test');
          setTimeout(() => {
            if (addsBack) standing.nb = [...standing.nb, { ...ZOE, publicKey: 'ee'.repeat(32), userId: 'by-hand' }];
            end();
          }, 0);
        }
        return { ok: true };
      });
      await notesStore.createNote({ title: 'New', notebookId: 'nb' });
      expect(removeNotebookMember.mock.calls.length > 0).toBe(takenBack);
    });
  }

  /** The fault: the directory's key filled in, and the note sealed, with no invitation. */
  for (const [what, outcome] of [
    ['was refused (the plan no longer includes sharing)', 'upgrade'],
    ['did not go through', 'failed'],
    ['cannot be opened here', 'cannot-open'],
  ] as const) {
    it(`when the notebook's own share ${what}, the note is NOT sealed to them, account or not`, async () => {
      hasAnAccountNow('zoe@example.test');
      shareNotebookWithRecipientResult.mockImplementation(async () => outcome);
      const r = await notesStore.createNote({ title: 'New', notebookId: 'nb' });
      const id = r.note!.id;
      expect(shared).toEqual([`note ${id} → ben@example.test sealed`, `note ${id} → zoe@example.test no key`]);
      expect(addNotebookShare).not.toHaveBeenCalled();
      expect(standing.nb.find(e => e.email === 'zoe@example.test')?.publicKey).toBeNull();
    });
  }

  it('nor when the server has no item for the notebook, or could not say: the notebook itself is what must be shared', async () => {
    hasAnAccountNow('zoe@example.test');
    for (const state of ['none', 'unknown'] as const) {
      shared.length = 0;
      await load();
      // The note's own create asks first (and, with no answer, would wait): the
      // server answers that one, and then no longer has an item, or cannot say.
      const sent = () => apiRequest.mock.calls.some(c => c[0] === '/api/v1/items' && c[1]?.method === 'POST');
      apiRequest.mockClear();
      notebookItemState.mockImplementation(async (id) => (!id ? 'none' : sent() ? state : 'item'));
      const r = await notesStore.createNote({ title: 'New', notebookId: 'nb' });
      expect(shareNotebookWithRecipientResult).not.toHaveBeenCalled();
      expect(shared).toEqual([`note ${r.note!.id} → ben@example.test sealed`, `note ${r.note!.id} → zoe@example.test no key`]);
    }
  });

  it('the fan-out never asks the directory for the key of someone saved without one', async () => {
    hasAnAccountNow('zoe@example.test');
    shareNotebookWithRecipientResult.mockImplementation(async () => 'failed');
    await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    // Two lookups: the invitation's (Zoe alone), and the fan-out's (Ben alone).
    expect(lookupDirectoryKeys.mock.calls.map(c => c[0])).toEqual([['zoe@example.test'], ['ben@example.test']]);
  });

  it('a notebook where nobody is waiting costs no extra lookup', async () => {
    standing.nb = [BEN];
    await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    expect(lookupDirectoryKeys.mock.calls.map(c => c[0])).toEqual([['ben@example.test']]);
  });

  it('a note of ours that is still waiting to be created, in the trash, or without a key of its own is not sent with the invitation', async () => {
    rows.push(note('bbbbbbbb-2222-4222-8222-22222222222b', 'nb', { pendingSync: true, version: 0 }));
    rows.push(note('cccccccc-3333-4333-8333-33333333333c', 'nb', { deleted: true }));
    rows.push(note('dddddddd-4444-4444-8444-44444444444d', 'nb', { wrappedContentKey: null, wrappedContentKeyNonce: null }));
    rows.push(note('eeeeeeee-5555-4555-8555-55555555555e', 'another-notebook'));
    await load();
    hasAnAccountNow('zoe@example.test');
    const r = await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    const toZoe = shared.filter(s => s.startsWith('note ') && s.includes('zoe')).map(s => s.split(' ')[1]);
    expect([...new Set(toZoe)].sort()).toEqual([OLD, r.note!.id].sort());
  });
});

describe('a note moved into such a notebook', () => {
  it('finishes the invitation before the note is sealed to anyone on its list', async () => {
    rows.push(note('ffffffff-6666-4666-8666-66666666666f', null));
    await load();
    hasAnAccountNow('zoe@example.test');
    expect(await notesStore.updateNote('ffffffff-6666-4666-8666-66666666666f', { notebookId: 'nb' })).toBe(true);
    expect(shared[0]).toBe('notebook nb → zoe@example.test edit sealed');
    expect(shared).toContain('note ffffffff-6666-4666-8666-66666666666f → zoe@example.test sealed');
    expect(shared).toContain('note ffffffff-6666-4666-8666-66666666666f → ben@example.test sealed');
  });

  it('and seals it to nobody new when the invitation could not be finished', async () => {
    rows.push(note('ffffffff-6666-4666-8666-66666666666f', null));
    await load();
    hasAnAccountNow('zoe@example.test');
    shareNotebookWithRecipientResult.mockImplementation(async () => 'failed');
    await notesStore.updateNote('ffffffff-6666-4666-8666-66666666666f', { notebookId: 'nb' });
    expect(shared.filter(s => s.includes('zoe'))).toEqual(['note ffffffff-6666-4666-8666-66666666666f → zoe@example.test no key']);
  });
});

describe('after a sync', () => {
  it('an invitation whose reader has signed up is finished, without the owner doing anything', async () => {
    hasAnAccountNow('zoe@example.test');
    await notesStore.sync();
    await settle();
    expect(shared).toEqual(['notebook nb → zoe@example.test edit sealed', `note ${OLD} → zoe@example.test sealed`]);
    expect(standing.nb.find(e => e.email === 'zoe@example.test')?.publicKey).toBe('cc'.repeat(32));
  });

  it('the directory is asked at most once in ten minutes, however often the page syncs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
      await notesStore.sync();
      await settle();
      await notesStore.sync();
      await settle();
      expect(askedAbout('zoe@example.test')).toBe(1);
      vi.setSystemTime(new Date('2026-10-07T10:09:59Z'));
      await notesStore.sync();
      await settle();
      expect(askedAbout('zoe@example.test')).toBe(1);
      vi.setSystemTime(new Date('2026-10-07T10:10:00Z'));
      hasAnAccountNow('zoe@example.test');
      await notesStore.sync();
      await settle();
      expect(askedAbout('zoe@example.test')).toBe(2);
      expect(shared[0]).toBe('notebook nb → zoe@example.test edit sealed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('nobody is asked anything when no invitation is waiting, and the next sync looks again', async () => {
    standing.nb = [BEN];
    await notesStore.sync();
    await settle();
    expect(askedAbout('zoe@example.test')).toBe(0);
    expect(shareNotebookWithRecipientResult).not.toHaveBeenCalled();
    // Someone is invited meanwhile: not ten minutes later, at the very next sync.
    standing.nb = [BEN, ZOE];
    await notesStore.sync();
    await settle();
    expect(askedAbout('zoe@example.test')).toBe(1);
  });

  it('the sync does not wait for it, and is not failed by it', async () => {
    hasAnAccountNow('zoe@example.test');
    let letGo: () => void = () => {};
    shareNotebookWithRecipientResult.mockImplementation(() => new Promise<string>((resolve) => { letGo = () => resolve('shared'); }));
    await notesStore.sync();
    expect(notesStore.syncing()).toBe(false);
    lookupDirectoryKeys.mockRejectedValueOnce(new Error('offline'));
    letGo();
    await settle();
  });
});

/**
 * A notebook of more notes than the server takes from an owner in a minute
 * (30 share invitations per rolling minute, then 429). If each finish shared
 * every note again it would meet the limit, the invitation would never be
 * finished, and new notes would reach her with no key.
 */
describe('an invitation to a notebook of more notes than the server takes from an owner in a minute', () => {
  it('is finished at the first try, a note added after it is sealed to her, and every note reaches her in the end', async () => {
    rows.length = 0;
    const ids = Array.from({ length: 35 }, (_, i) => `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, '0')}`);
    for (const id of ids) rows.push(note(id, 'nb'));
    await load();
    let clock = Date.parse('2026-10-11T10:00:00Z');
    const clockSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const sentAt: number[] = [];
    let refused = 0;
    const limited = () => {
      const inWindow = sentAt.filter(t => clock - t < 60_000).length;
      sentAt.push(clock);
      if (inWindow >= 30) refused++;
      return inWindow >= 30;
    };
    const reachedHer = new Set<string>();
    shareNotebookWithRecipientResult.mockImplementation(async (id, r, grant) => {
      if (limited()) return 'failed';
      shared.push(`notebook ${id} → ${r.email} ${grant} ${r.publicKey ? 'sealed' : 'no key'}`);
      return 'shared';
    });
    shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
      if (limited()) return { ok: false, reason: 'failed' };
      shared.push(`note ${id} → ${r.email} ${r.publicKey ? 'sealed' : 'no key'}`);
      if (r.email === 'zoe@example.test' && r.publicKey) reachedHer.add(id);
      return { ok: true };
    });
    hasAnAccountNow('zoe@example.test');
    clock += 11 * 60_000;
    const first = await notesStore.createNote({ title: 'New 0', notebookId: 'nb' });
    await settle();
    const zoe = () => standing.nb.find(e => e.email === 'zoe@example.test');
    expect(zoe()?.publicKey ?? null).not.toBeNull();
    expect(shareNotebookWithRecipientResult).toHaveBeenCalledTimes(1);
    expect(shared.filter(l => l.includes('zoe@example.test no key'))).toEqual([]);
    expect(reachedHer.has(first.note!.id)).toBe(true);
    // Later notes, two minutes apart: what did not go reaches her a few at a time.
    for (let i = 1; i <= 3; i++) {
      clock += 2 * 60_000;
      await notesStore.createNote({ title: `New ${i}`, notebookId: 'nb' });
      await settle();
    }
    expect(ids.filter(id => !reachedHer.has(id))).toEqual([]);
    expect(shared.filter(l => l.includes('zoe@example.test no key'))).toEqual([]);
    expect(shareNotebookWithRecipientResult).toHaveBeenCalledTimes(1);
    // Paced: the finish shared a few, what it left waited out the minute, and not one share was refused.
    expect(refused).toBe(0);
    clockSpy.mockRestore();
  });

  it('after a note that did not go, none of the rest is tried now: they are sent later', async () => {
    rows.length = 0;
    const ids = Array.from({ length: 12 }, (_, i) => `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, '0')}`);
    for (const id of ids) rows.push(note(id, 'nb'));
    await load();
    const tried: string[] = [];
    // Her fifth share is refused, and only that one.
    shareNoteWithRecipientResult.mockImplementation(async (id: string, _key: Uint8Array, r: Recipient) => {
      if (r.email !== 'zoe@example.test') return { ok: true };
      tried.push(id);
      return tried.length === 5 ? { ok: false, reason: 'failed' } : { ok: true };
    });
    hasAnAccountNow('zoe@example.test');
    await notesStore.createNote({ title: 'New', notebookId: 'nb' });
    await settle();
    // No note of the notebook was tried after the one that did not go, and she is finished.
    expect(tried.slice(5).filter(id => ids.includes(id))).toEqual([]);
    expect(standing.nb.find(e => e.email === 'zoe@example.test')?.publicKey).not.toBeNull();
    // What did not go, the refused one and every one not tried, waits to be sent later.
    const went = tried.slice(0, 4);
    const { unsentShares } = await import('../lib/unsentShares');
    expect(unsentShares().map(e => e.noteId).sort()).toEqual(ids.filter(id => !went.includes(id)).sort());
    expect(unsentShares().every(e => typeof e.notBefore === 'number')).toBe(true);
  });
});
