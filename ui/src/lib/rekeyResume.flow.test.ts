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
 * A removal survives a sign-out, end to end: the real notebooks store, the
 * real job store over an in-memory database per account, the real loader and
 * drain.
 *
 * WHY THESE EXIST
 *   Re-key jobs kept in the note cache, which every session end deletes
 *   whole, would be lost by a sign-out in the middle of a removal: the notes
 *   it had not reached would keep the removed person's share rows, and the
 *   first sync after signing back in would adopt a list that still named
 *   them.
 */

const { ACCOUNT_A, ACCOUNT_B } = vi.hoisted(() => ({
  ACCOUNT_A: '0e0e0e0e-0000-4000-8000-00000000000a',
  ACCOUNT_B: '0e0e0e0e-0000-4000-8000-00000000000b',
}));
const vaults: Record<string, Uint8Array> = {
  [ACCOUNT_A]: new Uint8Array(32).fill(1),
  [ACCOUNT_B]: new Uint8Array(32).fill(2),
};

const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
let currentVault: Uint8Array | null = null;
vi.mock('./crypto', () => ({
  isCryptoReady: () => true,
  getVaultKey: () => currentVault,
  getPreviousVaultKeys: () => [],
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(7),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
}));
vi.mock('./previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));
/** Jobs an older build left in the note cache's `rekeys` store. */
let oldStoreJobs: unknown[] = [];
const deleteRekeyJob = vi.fn(async (id: string) => { oldStoreJobs = oldStoreJobs.filter(j => (j as { id: string }).id !== id); });
vi.mock('./noteDb', () => ({
  listRekeyJobs: async () => oldStoreJobs,
  deleteRekeyJob: (id: string) => deleteRekeyJob(id),
  // Where an older build wrote them (only the old wiring ever does).
  saveRekeyJob: async (job: { id: string }) => { oldStoreJobs = [...oldStoreJobs.filter(j => (j as { id: string }).id !== job.id), job]; },
}));
const rotateContentKey = vi.fn();
vi.mock('./shareUtils', () => ({ rotateContentKey: (...a: unknown[]) => rotateContentKey(...a) }));
const revokeNotebookAccess = vi.fn();
vi.mock('./notebookRemoval', () => ({
  revokeNotebookAccess: (...a: unknown[]) => revokeNotebookAccess(...a),
  revokeNotebookObjectShare: vi.fn(async () => ({ revoked: true, rotated: false })),
}));
/** The notes in memory: a page after a sign-out starts with none (notes.ts `createSignal<NoteItem[]>([])`). */
let notesNow: { id: string; deleted: boolean; notebookId?: string }[] = [];
/** The notebook's whole note list once this session has a full pull (notes.ts notebookNoteIds): null before. */
let fullList: string[] = [];
let pullsOf: { hasPulled(full?: boolean): boolean } | null = null;
const requestFullPull = vi.fn();
vi.mock('../stores/notes', () => ({
  notesStore: {
    notes: () => notesNow,
    notebookNoteIds: () => (pullsOf?.hasPulled(true) ? [...fullList] : null),
    requestFullPull: () => requestFullPull(),
  },
}));

/** The browser's databases, one per account, which a session end leaves alone. */
const databases = new Map<string, Map<string, unknown>>();
let storeUnreadable = false;
/** Reads to hold up, in order: each opened backend's first listing waits on the next one. */
let slowReads: Promise<void>[] = [];
vi.mock('./rekeyStore', async (orig) => {
  const real = await orig<typeof import('./rekeyStore')>();
  return {
    ...real,
    indexedDbBackend: async (account: string) => {
      if (storeUnreadable) throw new Error('IndexedDB unavailable');
      const records = databases.get(account) ?? new Map<string, unknown>();
      databases.set(account, records);
      const slow = slowReads.shift();
      return {
        // What the read saw, handed over only once it is let go.
        all: async () => { const seen = [...records.values()]; if (slow) await slow; return seen; },
        get: async (k: string) => records.get(k),
        put: async (r: { k: string }) => { records.set(r.k, structuredClone(r)); },
        remove: async (k: string) => { records.delete(k); },
      };
    },
  };
});

const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
const NB = '11111111-1111-4111-8111-111111111111';
const X = 'removed@example.test';
const Y = 'stays@example.test';
const entry = (email: string) => ({ email, permission: 'edit' as const, publicKey: null, userId: null, signingPublicKey: null });
/** The server's blob: the removal's list write never landed, so it still names X. */
const serverBlob = { notebooks: [{ id: NB, name: 'Family' }], labelColors: {}, notebookShares: { [NB]: [entry(X), entry(Y)] } };
const metaRow = { id: META, item_type: 10, version: 5, deleted: false, encrypted_content: JSON.stringify(serverBlob), content_nonce: 'n', updated_at: 't' };

let notebooksStore: typeof import('../stores/notebooks').notebooksStore;
let live: typeof import('./rekeyDepsLive');
let drain: typeof import('./rekeyDrain');
let member: typeof import('./removeNotebookMember');
let setTabAccount: (id: string | null) => void;

async function boot() {
  vi.resetModules();
  ({ notebooksStore } = await import('../stores/notebooks'));
  pullsOf = notebooksStore;
  live = await import('./rekeyDepsLive');
  drain = await import('./rekeyDrain');
  member = await import('./removeNotebookMember');
  ({ setTabAccount } = await import('./account'));
}

/** Confirm an account, as checkAuth does (arming the gate). */
function signIn(account: string) {
  setTabAccount(null);
  currentVault = vaults[account];
  setTabAccount(account);
}

/** A removal of X from NB by A, stopped part-way: the job written down (through the live
 *  deps, wherever they keep it), the note not yet re-keyed. */
async function interruptedRemoval() {
  signIn(ACCOUNT_A);
  await live.loadHeldRemovals();
  await drain.beginRemoval(live.rekeyDeps, { notebookId: NB, removedRecipient: X, noteIds: ['n1'] });
}

/** A session end: the note cache is deleted whole (noteDb.clearLocalCache, here the old
 *  store's jobs), and the store resets. The job store is left, as in a browser. */
function signOut() {
  oldStoreJobs = [];
  notebooksStore.reset();
  setTabAccount(null);
}

/** The first sync's adopt, as notes.ts does it: after the holds gate. What the
 *  list held right after the adopt shows whether the holds were in place then. */
function firstSync() {
  let adopted = false;
  let atAdopt: string[] = [];
  const done = (async () => {
    await notebooksStore.whenHoldsReady();
    notebooksStore.loadFromSyncedItems([metaRow]);
    atAdopt = notebooksStore.getNotebookShares(NB).map(r => r.email);
    adopted = true;
  })();
  return { done, adopted: () => adopted, atAdopt: () => atAdopt };
}

const emails = () => notebooksStore.getNotebookShares(NB).map(r => r.email);

/** The sync's marks for a pull that read every page, in full (a first sync after a sign-in is one). */
function pulledInFull() {
  notebooksStore.markPulled();
  notebooksStore.markFullyPulled();
}

/** X's share rows on each note, as the server lists them: a rotation or a revoke takes theirs off. */
type Row = { id: string; recipient_email: string; permission: string };
let rows: Record<string, Row[]> = {};
/** Notes the server holds in the trash. */
let trashed = new Set<string>();

beforeEach(async () => {
  await new Promise(r => setTimeout(r, 20));
  vi.clearAllMocks();
  databases.clear();
  storeUnreadable = false;
  slowReads = [];
  oldStoreJobs = [];
  revokeNotebookAccess.mockResolvedValue({ rosterUpdated: true, objectRevoked: true, objectRotated: false, removedUserId: null });
  notesNow = [{ id: 'n1', deleted: false, notebookId: NB }];
  fullList = ['n1'];
  rows = { n1: [{ id: 's1', recipient_email: X, permission: 'edit' }] };
  trashed = new Set();
  // As the real one: a note that isn't in memory isn't rotated (shareUtils.ts `if (!note) return NOT_ROTATED;`),
  // and a rotation that lands takes the rows it was given off the note.
  rotateContentKey.mockImplementation(async (id: string, shareIds: string[]) => {
    if (!notesNow.some(n => n.id === id)) return { rotated: false };
    rows[id] = (rows[id] ?? []).filter(r => !shareIds.includes(r.id));
    return { rotated: true };
  });
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (opts?.method === 'PUT' && url === `/api/v1/items/${META}`) return { success: true, data: { version: 6 } };
    const shares = url.match(/^\/api\/v1\/items\/(n\d)\/shares$/);
    if (shares) return { success: true, data: rows[shares[1]] ?? [] };
    const note = url.match(/^\/api\/v1\/items\/(n\d)$/);
    if (note) return { success: true, data: { id: note[1], deleted: trashed.has(note[1]) } };
    const revoke = url.match(/^\/api\/v1\/shares\/([^?]+)\?reason=notebook_removal$/);
    if (revoke && opts?.method === 'DELETE') {
      for (const id of Object.keys(rows)) rows[id] = rows[id].filter(r => r.id !== revoke[1]);
      return { success: true, data: null };
    }
    // The notebook item, whose roster the retry reads first (the crypto mock opens anything).
    if (url === `/api/v1/items/${NB}`) {
      return { success: true, data: { id: NB, version: 3, deleted: false, content_nonce: 'n',
        encrypted_content: JSON.stringify({ title: 'Family', members: [
          { userId: 'x-id', email: X, sharingPublicKey: 'aa', signingPublicKey: null, permission: 'edit' }] }),
        wrapped_content_key: 'w', wrapped_content_key_nonce: 'wn' } };
    }
    return { success: false, status: 404 };
  });
  await boot();
});

describe('a removal interrupted by a sign-out', () => {
  it('is held again before the first sync adopts, and its drain finishes', async () => {
    await interruptedRemoval();
    signOut();
    signIn(ACCOUNT_A);

    const sync = firstSync();
    await new Promise(r => setTimeout(r, 20));
    expect(sync.adopted()).toBe(false); // the gate: nothing is adopted before the jobs are read

    await live.loadHeldRemovals();
    await sync.done;
    expect(sync.atAdopt()).toEqual([Y]);
    pulledInFull();

    await drain.resumeRekeyJobs(live.rekeyDeps);
    expect(databases.get(ACCOUNT_A)!.size).toBe(0); // done: re-keyed, object revoked, the list write landed
    expect(revokeNotebookAccess).toHaveBeenCalledWith(NB, X);
  });

  it("is not finished by a start whose notes aren't loaded yet: X still has a row on n1", async () => {
    await interruptedRemoval();
    signOut();
    signIn(ACCOUNT_A);
    notesNow = [];

    await live.loadHeldRemovals();
    await firstSync().done;
    await drain.resumeRekeyJobs(live.rekeyDeps);

    // The server still lists X on n1 and nothing rotated it: the job has to stay.
    expect(databases.get(ACCOUNT_A)!.size).toBe(1);
  });

  it('is drained by the start only once the first pull is in: nothing is rotated or dropped before', async () => {
    await interruptedRemoval();
    signOut();
    signIn(ACCOUNT_A);
    notesNow = [];

    await live.startRemovalJobs(true);
    await firstSync().done;
    await new Promise(r => setTimeout(r, 30));
    // Not even asked: a drain run now would find no note in memory and ask for a full pull.
    expect(requestFullPull).not.toHaveBeenCalled();
    expect(rotateContentKey).not.toHaveBeenCalled();
    expect(databases.get(ACCOUNT_A)!.size).toBe(1);

    // The pull lands: the notes are in memory, every page read.
    notesNow = [{ id: 'n1', deleted: false, notebookId: NB }];
    pulledInFull();

    await vi.waitFor(() => expect(databases.get(ACCOUNT_A)!.size).toBe(0));
    expect(rotateContentKey).toHaveBeenCalledWith('n1', ['s1'], 'notebook_removal');
    expect(rows.n1).toEqual([]);
  });

  it("at a reload's start, rotates from memory after the first pull, asking for no full pull", async () => {
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals();
    const { createJob, withNoteList } = await import('./rekeyQueue');
    // A job whose note list was folded in at an earlier start; n1 still to rotate.
    await live.rekeyDeps.saveJob(withNoteList(createJob({ notebookId: NB, removedRecipient: X, noteIds: ['n1'], nowMs: 1 }), []));
    notesNow = [];

    await live.startRemovalJobs(true);
    await firstSync().done;
    await new Promise(r => setTimeout(r, 30));
    // The first pull of a reload is a delta over the cache: the notes are in memory, no full pull.
    notesNow = [{ id: 'n1', deleted: false, notebookId: NB }];
    notebooksStore.markPulled();

    await vi.waitFor(() => expect(databases.get(ACCOUNT_A)!.size).toBe(0));
    expect(rotateContentKey).toHaveBeenCalledWith('n1', ['s1'], 'notebook_removal');
    expect(requestFullPull).not.toHaveBeenCalled();
  });

  it('is not drained for an account that is no longer the tab\'s when the pull comes', async () => {
    await interruptedRemoval();
    signOut();
    signIn(ACCOUNT_A);

    await live.startRemovalJobs(true);
    signIn(ACCOUNT_B);
    pulledInFull();
    await new Promise(r => setTimeout(r, 30));

    expect(rotateContentKey).not.toHaveBeenCalled();
    expect(revokeNotebookAccess).not.toHaveBeenCalled();
    expect(databases.get(ACCOUNT_A)!.size).toBe(1); // A's job, for A's next start
  });

  it('is neither seen nor resumed by another account signing in on the same browser', async () => {
    await interruptedRemoval();
    signOut();
    signIn(ACCOUNT_B);

    await live.loadHeldRemovals();
    const sync = firstSync();
    await sync.done;
    const result = await drain.resumeRekeyJobs(live.rekeyDeps);

    expect(result.jobs).toBe(0);
    expect(emails()).toEqual([X, Y]); // B holds no one: A's job is not B's
    expect(revokeNotebookAccess).not.toHaveBeenCalled();
    expect(databases.get(ACCOUNT_A)!.size).toBe(1); // A's job, untouched, for A's next sign-in
  });

  it('is held again when the keys arrive again in a retained document, before the next adopt', async () => {
    await interruptedRemoval();

    // A native re-login hands the page its keys again (App.tsx __pingolinKeysUpdated):
    // the gate closes at once, and the jobs are read again before anything is adopted.
    live.keysArrivedAgain();
    const sync = firstSync();
    await sync.done;

    expect(sync.atAdopt()).toEqual([Y]);
  });

  it('is read at the start, before the drains resume, and then finished', async () => {
    await interruptedRemoval();
    signOut();
    signIn(ACCOUNT_A);
    const sync = firstSync();

    await live.startRemovalJobs(true);
    await sync.done;
    expect(sync.atAdopt()).toEqual([Y]);
    pulledInFull();
    await vi.waitFor(() => expect(databases.get(ACCOUNT_A)!.size).toBe(0));
  });

  it('is read at a start with no session too (and not resumed)', async () => {
    await interruptedRemoval();
    signOut();
    signIn(ACCOUNT_A);
    const sync = firstSync();

    await live.startRemovalJobs(false);
    await sync.done;
    expect(sync.atAdopt()).toEqual([Y]);
    await new Promise(r => setTimeout(r, 20));
    expect(databases.get(ACCOUNT_A)!.size).toBe(1);
  });

  it("opens the gate, and says so, when the job store can't be read at all", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    storeUnreadable = true;
    signIn(ACCOUNT_A);

    await live.loadHeldRemovals();
    const sync = firstSync();
    await sync.done;

    expect(sync.adopted()).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('1 removal job store could not be read'))).toBe(true);
    warn.mockRestore();
  });
});

describe('the holds read', () => {
  it('takes the held people off a list already held here, before any adopt', async () => {
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals(); // no jobs yet: the gate opens
    notebooksStore.loadFromSyncedItems([metaRow]);
    expect(emails()).toEqual([X, Y]);
    // A job for X is written (by this tab or another), and the jobs are read again.
    await drain.beginRemoval(live.rekeyDeps, { notebookId: NB, removedRecipient: X, noteIds: ['n1'] });

    await live.loadHeldRemovals();

    expect(emails()).toEqual([Y]);
  });

  it('opens the gate when there is no vault key to read with (and nothing could be adopted)', async () => {
    setTabAccount(null);
    currentVault = null;
    setTabAccount(ACCOUNT_A);

    await live.loadHeldRemovals();

    const sync = firstSync();
    await sync.done;
    expect(sync.adopted()).toBe(true);
  });

  it("never lists one account's jobs for another, even before the other's are read", async () => {
    await interruptedRemoval();
    expect(await live.rekeyDeps.listJobs()).toHaveLength(1);

    setTabAccount(null);
    currentVault = null; // B confirmed, its keys not here yet
    setTabAccount(ACCOUNT_B);
    await live.loadHeldRemovals();

    expect(await live.rekeyDeps.listJobs()).toEqual([]);
  });
});

describe('the holds gate', () => {
  it('holds back a write and a restore until the jobs are read', async () => {
    await interruptedRemoval();
    signOut();
    signIn(ACCOUNT_A);
    const calls: string[] = [];
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      calls.push(`${opts?.method ?? 'GET'} ${url}`);
      return { success: false, status: 404 };
    });

    notebooksStore.markPulled();
    notebooksStore.setLabelColor('urgent', '#f00');
    const restore = notebooksStore.restoreStandingShares([NB], () => []);
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toEqual([]);

    await live.loadHeldRemovals();
    await restore;
    expect(calls.some(c => c === `GET /api/v1/items/${NB}/shares`)).toBe(true);
  });
});

describe('jobs an older build left in the note cache', () => {
  it('are moved into the sealed store at the first read, and held', async () => {
    const { createJob } = await import('./rekeyQueue');
    oldStoreJobs = [createJob({ notebookId: NB, removedRecipient: X, noteIds: ['n1'], nowMs: 1 })];
    signIn(ACCOUNT_A);

    await live.loadHeldRemovals();

    expect(deleteRekeyJob).toHaveBeenCalledWith(`rekey:${NB}`);
    expect(databases.get(ACCOUNT_A)!.size).toBe(1);
    notebooksStore.loadFromSyncedItems([metaRow]);
    expect(emails()).toEqual([Y]);
  });
});

describe("the jobs' database", () => {
  it('is not under the note cache that a session end deletes, and names no account', async () => {
    const { rekeyDbName } = await import('./rekeyStore');
    const name = await rekeyDbName(ACCOUNT_A);

    expect(name.startsWith('pingolin-note-rekeys.')).toBe(true);
    expect(name.startsWith('pingolin-note-cache')).toBe(false);
    expect(name).not.toContain(ACCOUNT_A);
    expect(await rekeyDbName(ACCOUNT_B)).not.toBe(name);
  });
});

describe('a removal from the Share panel', () => {
  it('is drained at once from the sealed store: roster, object, the notes, and the job goes', async () => {
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals();
    notebooksStore.loadFromSyncedItems([metaRow]);
    pulledInFull();

    await member.removeNotebookMember(NB, X);

    expect(revokeNotebookAccess).toHaveBeenCalledWith(NB, X);
    expect(rotateContentKey).toHaveBeenCalledWith('n1', ['s1'], 'notebook_removal');
    expect(databases.get(ACCOUNT_A)!.size).toBe(0);
    expect(emails()).toEqual([Y]);
  });
});

describe('a removal and the notes memory does not show', () => {
  it("takes X's rows off a note in the trash, without a rotation, and the job goes", async () => {
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals();
    notebooksStore.loadFromSyncedItems([metaRow]);
    pulledInFull();
    notesNow = [{ id: 'n1', deleted: false, notebookId: NB }, { id: 'n2', deleted: true, notebookId: NB }];
    fullList = ['n1', 'n2'];
    rows.n2 = [{ id: 's2', recipient_email: X, permission: 'edit' }];
    trashed.add('n2');

    await member.removeNotebookMember(NB, X);

    expect(rotateContentKey.mock.calls.map(c => c[0])).toEqual(['n1']);
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/shares/s2?reason=notebook_removal', { method: 'DELETE' });
    expect(rows).toEqual({ n1: [], n2: [] });
    expect(databases.get(ACCOUNT_A)!.size).toBe(0);
  });

  it('formed before the notes are loaded, it is completed and finished once a full pull lands', async () => {
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals();
    notebooksStore.loadFromSyncedItems([metaRow]);
    notesNow = [];

    await member.removeNotebookMember(NB, X);
    expect(rotateContentKey).not.toHaveBeenCalled();
    expect(databases.get(ACCOUNT_A)!.size).toBe(1);
    expect(requestFullPull).toHaveBeenCalled();

    notesNow = [{ id: 'n1', deleted: false, notebookId: NB }];
    pulledInFull();

    await vi.waitFor(() => expect(databases.get(ACCOUNT_A)!.size).toBe(0));
    expect(rotateContentKey).toHaveBeenCalledWith('n1', ['s1'], 'notebook_removal');
  });

  it('with no job store, still reads the roster from the server and re-keys the notes, once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    storeUnreadable = true;
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals();
    notebooksStore.loadFromSyncedItems([metaRow]);
    pulledInFull();

    await member.removeNotebookMember(NB, X);

    // The roster from the server first (the notebook item), then the removal from it.
    const read = apiRequest.mock.calls.findIndex(c => c[0] === `/api/v1/items/${NB}` && !c[1]?.method);
    expect(read).toBeGreaterThan(-1);
    expect(apiRequest.mock.invocationCallOrder[read]).toBeLessThan(revokeNotebookAccess.mock.invocationCallOrder[0]);
    expect(revokeNotebookAccess).toHaveBeenCalledWith(NB, X);
    expect(rotateContentKey).toHaveBeenCalledWith('n1', ['s1'], 'notebook_removal');
    expect(warn.mock.calls.some(c => String(c[0]).includes('could not persist the re-key job'))).toBe(true);
    warn.mockRestore();
  });

  it('with no job store and a roster the server will not give, takes no one out on the memory\'s word, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    storeUnreadable = true;
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals();
    notebooksStore.loadFromSyncedItems([metaRow]);
    pulledInFull();
    const answer = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) =>
      (url === `/api/v1/items/${NB}` && !opts?.method ? { success: false, status: 500 } : answer(url, opts)));

    await member.removeNotebookMember(NB, X);

    expect(revokeNotebookAccess).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(warn.mock.calls.some(c => String(c[0]).includes('is not finished, and with no job store nothing will finish it'))).toBe(true));
    expect(warn.mock.calls.some(c => String(c[0]).includes(`notebook ${NB} could not be read`))).toBe(true);
    warn.mockRestore();
  });
});

describe('removing X and sharing with X again while the removal is outstanding', () => {
  /** The server's roster and object rows for NB, as the removal and the share change them. */
  let roster: Set<string>;
  let objectRows: Set<string>;
  beforeEach(() => {
    roster = new Set([X, Y]);
    objectRows = new Set([X, Y]);
    revokeNotebookAccess.mockImplementation(async (_nb: string, email: string) => {
      roster.delete(email);
      objectRows.delete(email);
      return { rosterUpdated: true, objectRevoked: true, objectRotated: false, removedUserId: null };
    });
  });
  /** The share, as the panel runs it: the removal ended first, then the roster and
   *  object share (shareNotebookWithRecipient), then the standing list. */
  async function shareAgain() {
    await member.cancelNotebookRemoval(NB, X);
    roster.add(X);
    objectRows.add(X);
    notebooksStore.addNotebookShare(NB, entry(X));
  }
  const lastListWritten = () => {
    const puts = apiRequest.mock.calls.filter(c => c[1]?.method === 'PUT' && c[0] === `/api/v1/items/${META}`);
    return JSON.parse(puts[puts.length - 1][1].body.encrypted_content).notebookShares[NB].map((r: { email: string }) => r.email);
  };

  it('leaves X listed, on the roster and on the object after the next drain', async () => {
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals();
    notebooksStore.loadFromSyncedItems([metaRow]);
    // The removal: the note's re-key fails, so its job is still outstanding.
    rotateContentKey.mockResolvedValueOnce({ rotated: false });
    await member.removeNotebookMember(NB, X);
    expect(databases.get(ACCOUNT_A)!.size).toBe(1);
    expect(roster.has(X)).toBe(false);

    await shareAgain();
    const revokes = revokeNotebookAccess.mock.calls.length;
    const rotations = rotateContentKey.mock.calls.length;
    await drain.resumeRekeyJobs(live.rekeyDeps);

    expect(emails()).toEqual([Y, X]);
    await vi.waitFor(() => expect(lastListWritten()).toEqual([Y, X]));
    expect(roster.has(X)).toBe(true);
    expect(objectRows.has(X)).toBe(true);
    expect(revokeNotebookAccess.mock.calls.length).toBe(revokes);
    expect(rotateContentKey.mock.calls.length).toBe(rotations);
    expect(databases.get(ACCOUNT_A)!.size).toBe(0);
  });

  it("is seen by this tab's drain when another tab of the same browser shared with X again", async () => {
    await interruptedRemoval();
    notebooksStore.loadFromSyncedItems([metaRow]);
    // The other tab: its own opening of the same database, its own share.
    const { openRekeyStore, indexedDbBackend } = await import('./rekeyStore');
    const otherTab = await openRekeyStore(await indexedDbBackend(ACCOUNT_A), ACCOUNT_A, vaults[ACCOUNT_A], async () => []);
    await otherTab.remove(NB);

    await drain.resumeRekeyJobs(live.rekeyDeps); // this tab still lists the job it opened with

    expect(emails()).toEqual([X, Y]);
    expect(revokeNotebookAccess).not.toHaveBeenCalled();
    expect(rotateContentKey).not.toHaveBeenCalled();
  });

  it('is not undone by a read of the jobs that began before the share and finishes after it', async () => {
    await interruptedRemoval();
    notebooksStore.loadFromSyncedItems([metaRow]);
    let letGo!: () => void;
    slowReads = [new Promise<void>(r => { letGo = r; })];
    const late = live.loadHeldRemovals(); // it has seen X's job, and is held up
    live.keysArrivedAgain();              // a later read
    await notebooksStore.whenHoldsReady();
    expect(emails()).toEqual([Y]);

    await shareAgain();
    expect(emails()).toEqual([Y, X]);
    letGo();
    await late;

    expect(emails()).toEqual([Y, X]);
    expect(await live.rekeyDeps.listJobs()).toEqual([]);
  });
});

describe('two tabs of one account', () => {
  it("a removal here folds into the job another tab wrote since this tab opened its store", async () => {
    signIn(ACCOUNT_A);
    await live.loadHeldRemovals(); // this tab's store: no jobs yet
    const { openRekeyStore, indexedDbBackend } = await import('./rekeyStore');
    const { createJob } = await import('./rekeyQueue');
    const otherTab = await openRekeyStore(await indexedDbBackend(ACCOUNT_A), ACCOUNT_A, vaults[ACCOUNT_A], async () => []);
    await otherTab.save(createJob({ notebookId: NB, removedRecipient: X, noteIds: ['n1'], nowMs: 1 }));

    await drain.beginRemoval(live.rekeyDeps, { notebookId: NB, removedRecipient: Y, noteIds: ['n1'] });

    const reopened = await openRekeyStore(await indexedDbBackend(ACCOUNT_A), ACCOUNT_A, vaults[ACCOUNT_A], async () => []);
    expect(reopened.list().map(j => [...j.removedRecipients].sort())).toEqual([[X, Y]]);
  });
});
