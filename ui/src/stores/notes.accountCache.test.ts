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
import type { NoteItem } from './notes';

/**
 * The note cache and its offline queue belong to ONE account.
 *
 * With one IndexedDB per browser, a tab left open under account A after B
 * signed in elsewhere could write A's plaintext into it, and B's tab would then
 * render it and replay A's queued edits AS B. So each account has its own
 * database, each queued edit records its account and runs only for it, and the
 * single database older builds kept is adopted whole only by the account the
 * browser recorded as its owner. Anybody else's is deleted unread: its queued
 * edits are plaintext, so nothing proves whose they are, and they are never
 * run as anyone.
 *
 * IndexedDB is an in-memory stand-in for the `idb` calls noteDb makes.
 */

const { ME, OTHER, fake } = vi.hoisted(() => {
  type Store = { keyPath?: string; data: Map<unknown, unknown> };
  type Db = { version: number; stores: Map<string, Store> };
  const dbs = new Map<string, Db>();
  const opened: string[] = [];
  let failNextWrite = false;

  function handle(db: Db) {
    const store = (name: string) => {
      const s = db.stores.get(name);
      if (!s) throw new Error(`no store ${name}`);
      return s;
    };
    const keys = (name: string) => [...store(name).data.keys()].sort();
    const api = (name: string) => ({
      put: async (value: Record<string, unknown>, key?: unknown) => {
        if (failNextWrite) { failNextWrite = false; throw new Error('quota'); }
        const s = store(name);
        s.data.set(s.keyPath ? value[s.keyPath] : key, structuredClone(value));
      },
      getKey: async (key: unknown) => (store(name).data.has(key) ? key : undefined),
      getAllKeys: async () => keys(name),
      getAll: async () => keys(name).map(k => structuredClone(store(name).data.get(k))),
    });
    return {
      objectStoreNames: { contains: (name: string) => db.stores.has(name) },
      createObjectStore: (name: string, opts?: { keyPath?: string }) => {
        db.stores.set(name, { keyPath: opts?.keyPath, data: new Map() });
      },
      getAll: (name: string) => api(name).getAll(),
      get: async (name: string, key: unknown) => structuredClone(store(name).data.get(key)),
      put: (name: string, value: Record<string, unknown>, key?: unknown) => api(name).put(value, key),
      delete: async (name: string, key: unknown) => { store(name).data.delete(key); },
      clear: async (name: string) => { store(name).data.clear(); },
      count: async (name: string) => store(name).data.size,
      transaction: (name: string) => ({ store: api(name), done: Promise.resolve() }),
      close: () => {},
    };
  }

  async function openDB(
    name: string,
    version: number | undefined,
    cbs: { upgrade?: (...a: unknown[]) => void } = {},
  ) {
    let db = dbs.get(name);
    if (version === undefined) {
      if (!db) {
        // idb's openDB with no version on a missing database: upgrade from 0.
        let aborted = false;
        const draft: Db = { version: 1, stores: new Map() };
        cbs.upgrade?.(handle(draft), 0, 1, { abort: () => { aborted = true; } });
        if (aborted) throw new DOMException('aborted', 'AbortError');
        dbs.set(name, draft);
        db = draft;
      }
    } else if (!db || db.version < version) {
      const next: Db = db ?? { version, stores: new Map() };
      cbs.upgrade?.(handle(next), db?.version ?? 0, version, { abort() {} });
      next.version = version;
      dbs.set(name, next);
      db = next;
    }
    opened.push(name);
    return handle(db);
  }

  return {
    ME: '0e0e0e0e-0000-4000-8000-00000000000e',
    OTHER: '0f0f0f0f-0000-4000-8000-00000000000f',
    fake: {
      dbs,
      opened,
      openDB,
      deleteDB: async (name: string) => { dbs.delete(name); },
      failNextWrite: () => { failNextWrite = true; },
      /** A database as a build left it: store → records (keyed by `id`, or by the given key). */
      seed(name: string, contents: Record<string, ReadonlyArray<[unknown, unknown] | object>>) {
        const stores = new Map<string, Store>();
        for (const s of ['notes', 'meta', 'pending', 'rekeys', 'drafts']) {
          stores.set(s, { keyPath: s === 'meta' ? undefined : 'id', data: new Map() });
        }
        for (const [s, rows] of Object.entries(contents)) {
          for (const row of rows) {
            if (Array.isArray(row)) stores.get(s)!.data.set(row[0], row[1]);
            else stores.get(s)!.data.set((row as { id: string }).id, row);
          }
        }
        dbs.set(name, { version: 3, stores });
      },
      records(name: string, store: string): unknown[] {
        const s = dbs.get(name)?.stores.get(store);
        return s ? [...s.data.values()] : [];
      },
    },
  };
});

vi.mock('idb', () => ({ openDB: fake.openDB, deleteDB: fake.deleteDB }));

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap', nonce: 'nonce' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: () => { throw new Error('not used here'); },
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
const incomingShare = vi.fn();
const applyLocalEdit = vi.fn();
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: (id: string) => incomingShare(id),
    load: async () => true,
    sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {},
    applyLocalEdit: (...a: unknown[]) => applyLocalEdit(...a),
  },
}));
/** The browser's recorded owner, as the auth store reads it back. */
let cachedOwner: string | null = ME;
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => cachedOwner,
}));

const LEGACY = 'pingolin-note-cache';
const dbOf = (account: string) => `${LEGACY}.${account}`;
const NOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function note(id: string, title: string, version = 1): NoteItem {
  return {
    id, title, body: `${title} body`, noteType: 'text', color: null, isPinned: false,
    isArchived: false, labels: [], sortOrder: 0, editMode: 'rich', notebookId: null,
    hasAttachments: false, version, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    deleted: false, wrappedContentKey: 'wrap', wrappedContentKeyNonce: 'nonce', foreignOwner: false,
  } as unknown as NoteItem;
}

const pendingCreate = (id: string, title: string) =>
  ({ id, note: note(id, title), op: 'create', queuedAt: '2026-09-20T00:00:00Z' });

let account: typeof import('../lib/account');
let noteDb: typeof import('../lib/noteDb');
let notes: typeof import('./notes');
let local: Storage;

beforeEach(async () => {
  fake.dbs.clear();
  fake.opened.length = 0;
  apiRequest.mockReset();
  incomingShare.mockReset();
  applyLocalEdit.mockReset();
  cachedOwner = ME;
  local = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.resetModules();
  account = await import('../lib/account');
  noteDb = await import('../lib/noteDb');
  notes = await import('./notes');
});

afterEach(() => vi.unstubAllGlobals());

describe('one database per account', () => {
  it('opens nothing before the account is confirmed', async () => {
    expect(await noteDb.loadNotes()).toEqual([]);
    await noteDb.putNote(note(NOTE, 'x'));
    expect(fake.opened).toEqual([]);
  });

  it("keeps each account's notes in its own database", async () => {
    account.setTabAccount(ME);
    await noteDb.putNote(note(NOTE, 'mine'));
    account.setTabAccount(OTHER);
    expect(await noteDb.loadNotes()).toEqual([]);
    account.setTabAccount(ME);
    expect((await noteDb.loadNotes()).map(n => n.title)).toEqual(['mine']);
    expect([...fake.dbs.keys()].sort()).toEqual([dbOf(ME), dbOf(OTHER)].sort());
  });

  it('records the account on every queued edit and lists only that account\'s', async () => {
    account.setTabAccount(ME);
    await noteDb.queuePending(pendingCreate(NOTE, 'queued') as never);
    // Entries that are not this account's, however they got here, never run.
    fake.dbs.get(dbOf(ME))!.stores.get('pending')!.data.set('x1', { ...pendingCreate('x1', 'theirs'), account: OTHER });
    fake.dbs.get(dbOf(ME))!.stores.get('pending')!.data.set('x2', pendingCreate('x2', 'nobody'));
    const listed = await noteDb.listPending();
    expect(listed.map(e => [e.id, e.account])).toEqual([[NOTE, ME]]);
  });

  /** The single-entry read (an edit of a note still waiting to be created asks it) follows the same rule. */
  it('reads one queued edit by its note, and never one that is not this account\'s', async () => {
    account.setTabAccount(ME);
    await noteDb.queuePending({ ...pendingCreate(NOTE, 'queued'), edits: { title: 'edited' } } as never);
    fake.dbs.get(dbOf(ME))!.stores.get('pending')!.data.set('x1', { ...pendingCreate('x1', 'theirs'), account: OTHER });
    fake.dbs.get(dbOf(ME))!.stores.get('pending')!.data.set('x2', pendingCreate('x2', 'nobody'));
    const mine = await noteDb.getPending(NOTE);
    expect([mine?.id, mine?.account, mine?.op, mine?.edits]).toEqual([NOTE, ME, 'create', { title: 'edited' }]);
    expect(await noteDb.getPending('x1')).toBeNull();
    expect(await noteDb.getPending('x2')).toBeNull();
    expect(await noteDb.getPending('never-queued')).toBeNull();
  });

  it('a stopped tab writes nothing, even with an account set again', async () => {
    account.reportAccountMismatch();
    account.setTabAccount(ME);
    await noteDb.queuePending(pendingCreate(NOTE, 'late') as never);
    expect(fake.opened).toEqual([]);
  });

  it("another account's sign-in deletes every other account's database", async () => {
    account.setTabAccount(ME);
    await noteDb.putNote(note(NOTE, 'mine'));
    account.setTabAccount(OTHER);
    await noteDb.putNote(note(NOTE, 'theirs'));
    await noteDb.keepOnlyAccountCache(OTHER);
    expect([...fake.dbs.keys()]).toEqual([dbOf(OTHER)]);
    expect(JSON.parse(local.getItem('pingolin_note_cache_accounts')!)).toEqual([OTHER]);
  });

  it("a wipe deletes every account's database and the older shared one", async () => {
    fake.seed(LEGACY, { notes: [note(NOTE, 'old')] });
    account.setTabAccount(ME);
    await noteDb.putNote(note(NOTE, 'mine'));
    account.setTabAccount(OTHER);
    await noteDb.putNote(note(NOTE, 'theirs'));
    await noteDb.clearLocalCache();
    expect(fake.dbs.size).toBe(0);
    expect(local.getItem('pingolin_note_cache_accounts')).toBeNull();
  });
});

describe("the older builds' single database", () => {
  it('the recorded owner adopts it whole, over nothing newer, then it is deleted', async () => {
    fake.seed(LEGACY, {
      notes: [note(NOTE, 'old copy', 1), note('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'only here')],
      meta: [['cursor', '2026-09-20T00:00:00Z']],
      pending: [pendingCreate('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'queued offline')],
      rekeys: [{ id: 'nb-1', notebookId: 'nb-1' }],
      drafts: [{ id: 'composer', title: 'draft' }],
    });
    fake.seed(dbOf(ME), { notes: [note(NOTE, 'newer copy', 5)] });

    await noteDb.adoptLegacyCache(ME, true);

    expect(fake.dbs.has(LEGACY)).toBe(false);
    account.setTabAccount(ME);
    const byId = Object.fromEntries((await noteDb.loadNotes()).map(n => [n.id, n.title]));
    expect(byId).toEqual({ [NOTE]: 'newer copy', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': 'only here' });
    expect(await noteDb.loadCursor()).toBe('2026-09-20T00:00:00Z');
    expect((await noteDb.listPending()).map(e => [e.note.title, e.account])).toEqual([['queued offline', ME]]);
    expect(await noteDb.listRekeyJobs()).toHaveLength(1);
    expect(await noteDb.getDraft('composer')).not.toBeNull();
  });

  it('a copy that fails deletes nothing: the next start tries again', async () => {
    fake.seed(LEGACY, { notes: [note(NOTE, 'old')] });
    fake.failNextWrite();
    await noteDb.adoptLegacyCache(ME, true);
    expect(fake.dbs.has(LEGACY)).toBe(true);
  });

  it('an unknown owner\'s is deleted unread, logging only counts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.seed(LEGACY, {
      notes: [note(NOTE, 'Secret title')],
      pending: [pendingCreate('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Secret queued')],
    });
    await noteDb.adoptLegacyCache(ME, false);
    expect(fake.dbs.has(LEGACY)).toBe(false);
    expect(fake.dbs.has(dbOf(ME))).toBe(false);
    const logged = warn.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('1 queued edit(s), 1 note(s)');
    expect(logged).not.toContain('Secret');
    expect(logged).not.toContain(NOTE);
    warn.mockRestore();
  });

  it('opening it to look never creates it', async () => {
    await noteDb.adoptLegacyCache(ME, true);
    expect(fake.dbs.size).toBe(0);
  });
});

describe('the queue runs only for its own account (the store)', () => {
  it("an unknown owner's queued edits: nothing is sent, and they and the notes are gone", async () => {
    fake.seed(LEGACY, {
      notes: [note(NOTE, 'theirs')],
      pending: [pendingCreate(NOTE, 'theirs')],
    });
    await noteDb.adoptLegacyCache(ME, false);
    account.setTabAccount(ME);
    await notes.notesStore.flushPending();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(fake.records(LEGACY, 'pending')).toEqual([]);
    expect(fake.records(LEGACY, 'notes')).toEqual([]);
    expect(fake.records(dbOf(ME), 'pending')).toEqual([]);
  });

  it("the recorded owner's queued edit is sent, as that owner's", async () => {
    fake.seed(LEGACY, { pending: [pendingCreate(NOTE, 'mine')] });
    await noteDb.adoptLegacyCache(ME, true);
    account.setTabAccount(ME);
    apiRequest.mockResolvedValue({
      success: true, data: { id: NOTE, version: 1, created_at: 'x', updated_at: 'x' },
    });
    await notes.notesStore.flushPending();
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/items', expect.objectContaining({ method: 'POST' }));
    expect(fake.records(dbOf(ME), 'pending')).toEqual([]);
  });

  it('another account\'s session: the create stays queued, and nothing else is sent', async () => {
    account.setTabAccount(ME);
    apiRequest.mockResolvedValue({ success: false, error: 'This tab belongs to another account', error_code: 'account_mismatch' });
    const out = await notes.notesStore.createNote({ title: 'kept' } as never);
    // Not "saved offline" either: nothing in this tab claims the note landed.
    expect(out).toEqual({ note: null, queued: false });
    expect(notes.notesStore.notes()).toEqual([]);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect((fake.records(dbOf(ME), 'pending') as { note: { title: string } }[]).map(e => e.note.title)).toEqual(['kept']);
  });

  it('another account\'s session: an edit stays queued and nothing is forked', async () => {
    account.setTabAccount(ME);
    await noteDb.putNote(note(NOTE, 'before', 3));
    await notes.notesStore.hydrateFromCache();
    apiRequest.mockResolvedValue({ success: false, error: 'This tab belongs to another account', error_code: 'account_mismatch' });
    expect(await notes.notesStore.updateNote(NOTE, { title: 'after' })).toBe(false);
    // One PUT, no conflict copy, no re-create, and the tab acts on nothing.
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(notes.notesStore.notes().map(n => n.title)).toEqual(['before']);
    expect((fake.records(dbOf(ME), 'pending') as { note: { title: string } }[]).map(e => e.note.title)).toEqual(['after']);
  });

  it("another account's session on a note shared with us: kept, and nothing is applied", async () => {
    account.setTabAccount(ME);
    incomingShare.mockReturnValue({ note: note(NOTE, 'shared', 2), contentKey: new Uint8Array(32).fill(1) });
    apiRequest.mockResolvedValue({ success: false, error: 'This tab belongs to another account', error_code: 'account_mismatch' });
    expect(await notes.notesStore.updateNote(NOTE, { title: 'after' })).toBe(false);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(applyLocalEdit).not.toHaveBeenCalled();
    expect((fake.records(dbOf(ME), 'pending') as { note: { title: string } }[]).map(e => e.note.title)).toEqual(['after']);
  });

  it("another account's session on the re-create after a 404: kept, and nothing is forked", async () => {
    account.setTabAccount(ME);
    await noteDb.putNote(note(NOTE, 'before', 3));
    await notes.notesStore.hydrateFromCache();
    apiRequest
      .mockResolvedValueOnce({ success: false, status: 404, error: 'Not found' })
      .mockResolvedValueOnce({ success: false, error: 'This tab belongs to another account', error_code: 'account_mismatch' });
    expect(await notes.notesStore.updateNote(NOTE, { title: 'after' })).toBe(false);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect((fake.records(dbOf(ME), 'pending') as { note: { title: string } }[]).map(e => e.note.title)).toEqual(['after']);
  });

  it("the browser's recorded owner is compared canonically before this tab writes the cache", async () => {
    account.setTabAccount(ME);
    apiRequest.mockResolvedValue({ success: false, error: 'offline' });
    cachedOwner = ME.toUpperCase();
    await notes.notesStore.createNote({ title: 'same owner, other spelling' } as never);
    cachedOwner = OTHER;
    await notes.notesStore.createNote({ title: 'another owner' } as never);
    expect((fake.records(dbOf(ME), 'pending') as { note: { title: string } }[]).map(e => e.note.title))
      .toEqual(['same owner, other spelling']);
  });

  it('a drain stops as soon as the tab is stopped', async () => {
    account.setTabAccount(ME);
    await noteDb.queuePending(pendingCreate(NOTE, 'one') as never);
    await noteDb.queuePending(pendingCreate('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'two') as never);
    apiRequest.mockImplementation(async () => {
      account.reportAccountMismatch();
      return { success: false, error: 'stopped', error_code: 'account_mismatch' };
    });
    await notes.notesStore.flushPending();
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});
