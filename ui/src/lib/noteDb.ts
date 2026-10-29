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

/**
 * IndexedDB-backed cache for decrypted notes + sync cursor.
 *
 * The vault key is per-user-session material (in sessionStorage); it is
 * NEVER written to IndexedDB. Only decrypted note content is stored so
 * the grid can render instantly on reload without waiting for the network.
 *
 * Offline edits are buffered in the `pending` store: each entry is a note
 * id plus the local NoteItem snapshot. Once the network returns, the sync
 * flow replays them.
 *
 * AT-REST TRADEOFF (deliberate). Records here are stored as decrypted
 * plaintext, NOT wrapped with a session key. This is a considered choice, not
 * an oversight:
 *
 *   - The cache's entire job is to render the grid BEFORE the vault key is
 *     available. NotesView hydrates gated only on isAuthenticated(), and the key
 *     is restored asynchronously AFTER isLoggedIn() flips (see stores/auth.ts
 *     checkAuth). There are also fully-handled "authenticated but no key" states
 *     — the portal can't federate a wrapping key (see stores/auth.ts) — in which
 *     isCryptoReady() stays false for the whole session yet the user must still
 *     see their notes. Wrapping records with a vault-key-derived key would make
 *     the cache unreadable in exactly those states, breaking offline read (the
 *     one thing this file exists to provide). Encrypting only helps against
 *     at-rest disclosure and does nothing against XSS (an attacker running in the
 *     page reads the key material too), so the cost/benefit does not justify the
 *     offline-correctness risk.
 *
 *   - What actually protects the plaintext is COMPREHENSIVE WIPE-ON-SESSION-END,
 *     not encryption: stores/auth.ts wipes this DB (via
 *     clearLocalCache) BEFORE any account can hydrate it — on logout, on a
 *     definitive no-session (portal logout / cookie expiry), and on an
 *     owner-mismatch account switch — so account B never renders account A's
 *     plaintext. INVARIANT: every store that holds decrypted-at-rest material
 *     MUST be cleared by clearLocalCache() below; if you add one, wipe it there.
 *
 * ONE DATABASE PER ACCOUNT: `pingolin-note-cache.<canonical account id>`,
 * opened only for the account /auth/me confirmed for this tab. A tab left
 * open under account A after B signs in elsewhere reads and writes only A's,
 * so B never renders A's plaintext and B's queue never replays A's edits;
 * each queued edit also records its account and runs only for it.
 */
import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import type { NoteItem } from '../stores/notes';
import type { RekeyJob } from './rekeyQueue';
import { getTabAccount, isStopped, tryCanonicalAccountId } from './account';

/** The single database older builds kept for whoever was signed in. Adopted or
 *  deleted at the first sign-in after the upgrade (adoptLegacyCache). */
const LEGACY_DB_NAME = 'pingolin-note-cache';
const DB_VERSION = 3;
const STORE_NOTES = 'notes';
const STORE_META = 'meta';
const STORE_PENDING = 'pending';
/**
 * Outstanding re-key jobs after a member was removed from a shared notebook.
 *
 * Durable on purpose: re-keying is a client-side loop over every note, and if
 * it stops halfway the removed member's key stays live on the notes it did not
 * reach. Every future edit to those is then written under a key they hold. The
 * intent has to outlive a reload, a crash and being offline, or "removed" means
 * "removed from most of it".
 */
const STORE_REKEYS = 'rekeys';
/**
 * Keystroke-interval editor drafts. The autosave debounce RESETS on every
 * keystroke, so continuous typing defers the save indefinitely — a crash
 * mid-typing (with the screen on, so no visibilitychange fires either) would
 * lose everything since the last pause. The editor stashes the live draft
 * here on a fixed interval while dirty and removes it on a successful save;
 * a surviving entry at next open means the process died with unsaved text.
 */
const STORE_DRAFTS = 'drafts';

const ALL_STORES = [STORE_NOTES, STORE_META, STORE_PENDING, STORE_REKEYS, STORE_DRAFTS] as const;

/** The name of one account's database. */
export function cacheDbName(account: string): string {
  return `${LEGACY_DB_NAME}.${account}`;
}

/**
 * The accounts that may have a database in this browser, so a wipe or another
 * account's sign-in can find and delete them. An id is added before its
 * database is opened and removed once that database is deleted.
 */
const CACHE_ACCOUNTS_KEY = 'pingolin_note_cache_accounts';

function registeredAccounts(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_ACCOUNTS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(tryCanonicalAccountId).filter((id): id is string => id !== null);
  } catch {
    return [];
  }
}

function setRegistered(ids: string[]): void {
  try {
    if (ids.length === 0) localStorage.removeItem(CACHE_ACCOUNTS_KEY);
    else localStorage.setItem(CACHE_ACCOUNTS_KEY, JSON.stringify(ids));
  } catch { /* unavailable: indexedDB.databases() still lists them where supported */ }
}

function register(account: string): void {
  const ids = registeredAccounts();
  if (!ids.includes(account)) setRegistered([...ids, account]);
}

function unregister(account: string): void {
  setRegistered(registeredAccounts().filter(id => id !== account));
}

/** Every account with a database here: the registry, plus what the browser
 *  lists where it can. */
async function cacheAccounts(): Promise<string[]> {
  const ids = new Set(registeredAccounts());
  try {
    const listed = await globalThis.indexedDB?.databases?.();
    for (const d of listed ?? []) {
      if (!d.name?.startsWith(`${LEGACY_DB_NAME}.`)) continue;
      const id = tryCanonicalAccountId(d.name.slice(LEGACY_DB_NAME.length + 1));
      if (id) ids.add(id);
    }
  } catch { /* not listable in this browser: the registry is the list */ }
  return [...ids];
}

function upgradeStores(upgraded: IDBPDatabase): void {
  if (!upgraded.objectStoreNames.contains(STORE_NOTES)) {
    upgraded.createObjectStore(STORE_NOTES, { keyPath: 'id' });
  }
  if (!upgraded.objectStoreNames.contains(STORE_META)) {
    upgraded.createObjectStore(STORE_META);
  }
  if (!upgraded.objectStoreNames.contains(STORE_REKEYS)) {
    upgraded.createObjectStore(STORE_REKEYS, { keyPath: 'id' });
  }
  if (!upgraded.objectStoreNames.contains(STORE_PENDING)) {
    upgraded.createObjectStore(STORE_PENDING, { keyPath: 'id' });
  }
  if (!upgraded.objectStoreNames.contains(STORE_DRAFTS)) {
    upgraded.createObjectStore(STORE_DRAFTS, { keyPath: 'id' });
  }
}

function openAccountDb(account: string): Promise<IDBPDatabase> {
  register(account);
  return openDB(cacheDbName(account), DB_VERSION, {
    upgrade: upgradeStores,
    // Another tab is deleting this database (a wipe, or another account
    // signed in): let it. The next call here opens it again if still needed.
    blocking(_current, _blocked, event) {
      (event.target as IDBDatabase).close();
      if (dbName === cacheDbName(account)) resetDb();
    },
    terminated() {
      if (dbName === cacheDbName(account)) resetDb();
    },
  });
}

let dbPromise: Promise<IDBPDatabase> | null = null;
let dbName: string | null = null;

function resetDb(): void {
  const open = dbPromise;
  dbPromise = null;
  dbName = null;
  void open?.then(d => d.close()).catch(() => {});
}

/** The tab's account's database. Refused before an account is confirmed and
 *  after a mismatch stopped the tab; every caller treats that as a miss. */
function db(): Promise<IDBPDatabase> {
  const account = getTabAccount();
  if (!account || isStopped()) return Promise.reject(new Error('No account for the note cache'));
  if (!dbPromise || dbName !== cacheDbName(account)) {
    resetDb();
    dbName = cacheDbName(account);
    dbPromise = openAccountDb(account);
  }
  return dbPromise;
}

/**
 * Delete a database. A tab holding it open is told to close (`blocking`
 * above) and the delete completes then, so this waits for the delete only
 * while nothing blocks it; `onDeleted` runs whenever it completes.
 */
function deleteCacheDb(name: string, onDeleted?: () => void): Promise<void> {
  return new Promise(resolve => {
    try {
      deleteDB(name, { blocked: () => resolve() }).then(
        () => { onDeleted?.(); resolve(); },
        () => resolve(),
      );
    } catch {
      resolve(); // no IndexedDB here at all
    }
  });
}

/** Open a database only if it exists; never creates one. */
async function openExisting(name: string): Promise<IDBPDatabase | null> {
  try {
    return await openDB(name, undefined, {
      upgrade(_db, oldVersion, _newVersion, tx) {
        // Reached only when there is no such database: abort, so none is made.
        if (oldVersion === 0) tx.abort();
      },
    });
  } catch {
    return null;
  }
}

async function countIn(legacy: IDBPDatabase, store: string): Promise<number> {
  try {
    return legacy.objectStoreNames.contains(store) ? await legacy.count(store) : 0;
  } catch {
    return 0;
  }
}

/** Copy the older database's records into `account`'s, over nothing it
 *  already holds; its queued edits are recorded as that account's. */
async function copyLegacyInto(legacy: IDBPDatabase, account: string): Promise<void> {
  const target = await openAccountDb(account);
  try {
    for (const store of ALL_STORES) {
      if (!legacy.objectStoreNames.contains(store)) continue;
      const read = legacy.transaction(store);
      const [keys, values] = await Promise.all([read.store.getAllKeys(), read.store.getAll()]);
      await read.done;
      const write = target.transaction(store, 'readwrite');
      for (let i = 0; i < keys.length; i++) {
        if ((await write.store.getKey(keys[i])) !== undefined) continue;
        if (store === STORE_META) await write.store.put(values[i], keys[i]);
        else if (store === STORE_PENDING) await write.store.put({ ...values[i], account });
        else await write.store.put(values[i]);
      }
      await write.done;
    }
  } finally {
    target.close();
  }
}

/**
 * The database older builds kept, one per browser for whoever was signed in.
 * Called once the account is confirmed, before anything reads the cache.
 *
 * `ownerKnown` (the browser's recorded owner is this account): it is adopted
 * whole, queued edits included, then deleted. A failed copy deletes nothing,
 * and the next start tries again.
 *
 * Anyone else: nobody can say whose it is. Its queued edits are plaintext, so
 * nothing proves an owner, and they are never run as anyone. It is deleted
 * unread (the next sync refetches the notes), and only counts are logged.
 */
export async function adoptLegacyCache(account: string, ownerKnown: boolean): Promise<void> {
  const legacy = await openExisting(LEGACY_DB_NAME);
  if (!legacy) return;
  if (ownerKnown) {
    try {
      await copyLegacyInto(legacy, account);
    } catch (e) {
      legacy.close();
      console.warn('[note/cache] could not adopt the older cache; kept for the next start', e);
      return;
    }
  } else {
    const [pending, notes] = await Promise.all([countIn(legacy, STORE_PENDING), countIn(legacy, STORE_NOTES)]);
    console.warn(`[note/cache] deleted an older cache of unknown owner unread: ${pending} queued edit(s), ${notes} note(s)`);
  }
  legacy.close();
  await deleteCacheDb(LEGACY_DB_NAME);
}

/** An erased account (lib/forgetAccount.ts): delete its database, and only its. */
export async function forgetAccountCache(account: string): Promise<void> {
  if (dbName === cacheDbName(account)) resetDb();
  await deleteCacheDb(cacheDbName(account), () => unregister(account));
}

/** The older builds' one database: an erased account's only when the browser
 *  recorded it as the owner (the caller's check). */
export async function forgetLegacyCache(): Promise<void> {
  await deleteCacheDb(LEGACY_DB_NAME);
}

/** A different account signed in: delete every other account's database. */
export async function keepOnlyAccountCache(account: string): Promise<void> {
  await Promise.all(
    (await cacheAccounts())
      .filter(id => id !== account)
      .map(id => deleteCacheDb(cacheDbName(id), () => unregister(id))),
  );
}

export async function loadNotes(): Promise<NoteItem[]> {
  try {
    const instance = await db();
    // Filter null/undefined and records missing an id — an IDB write cut
    // short by a failed decryption mid-save can leave those behind.
    const all = (await instance.getAll(STORE_NOTES)) as (NoteItem | null)[];
    return all.filter((n): n is NoteItem => n != null && typeof n.id === 'string');
  } catch {
    return [];
  }
}

/**
 * One card as the cache holds it NOW: `null` when it holds none, `undefined`
 * when the cache could not be read (which says nothing either way).
 *
 * The cache is shared by this account's tabs; a tab's own list of cards is
 * not. What another tab sent, or deleted, since this page drew a card is read
 * here.
 */
export async function getNote(id: string): Promise<NoteItem | null | undefined> {
  try {
    const instance = await db();
    const note = (await instance.get(STORE_NOTES, id)) as NoteItem | null | undefined;
    return note != null && typeof note.id === 'string' ? note : null;
  } catch {
    return undefined;
  }
}

export async function putNote(note: NoteItem): Promise<void> {
  try {
    const instance = await db();
    // Stored as decrypted plaintext by design — see the AT-REST TRADEOFF note at
    // the top of this file. Protected by wipe-on-session-end, not encryption.
    await instance.put(STORE_NOTES, note);
  } catch { /* ignore cache failures */ }
}

export async function putNotes(notes: NoteItem[]): Promise<void> {
  if (notes.length === 0) return;
  try {
    const instance = await db();
    const tx = instance.transaction(STORE_NOTES, 'readwrite');
    await Promise.all(notes.map(n => tx.store.put(n)));
    await tx.done;
  } catch { /* ignore */ }
}

export async function removeNote(id: string): Promise<void> {
  try {
    const instance = await db();
    await instance.delete(STORE_NOTES, id);
  } catch { /* ignore */ }
}

export async function clearNotes(): Promise<void> {
  try {
    const instance = await db();
    await instance.clear(STORE_NOTES);
  } catch { /* ignore */ }
}

/**
 * Wipe all locally-cached user data (decrypted notes, sync cursor, buffered
 * offline edits). Called on logout so decrypted plaintext does not survive a
 * same-device account switch, and so a re-login re-pulls from a clean cursor.
 *
 * This is the primary at-rest protection for the plaintext cache (see the
 * AT-REST TRADEOFF note at the top of this file). stores/auth.ts calls it BEFORE
 * any hydration on every session end — logout, definitive no-session, and
 * owner-mismatch — so it MUST clear EVERY store that holds decrypted material.
 * If you add a new store above, add it to the wipe below.
 */
export async function clearLocalCache(): Promise<void> {
  // Every account's database, and the older shared one, deleted whole: the
  // INVARIANT at the top of this file holds for any store added later. A
  // re-key job left behind would try to rotate the previous account's notes
  // under the next one's keys; drafts are plaintext by definition.
  resetDb();
  await Promise.all([
    deleteCacheDb(LEGACY_DB_NAME),
    ...(await cacheAccounts()).map(id => deleteCacheDb(cacheDbName(id), () => unregister(id))),
  ]);
  // NOT the offline shell's asset caches. They hold only public content-hashed
  // assets — never a note, never an API response — and the worker fills them
  // exactly once per build, at install. Deleting them here would run on the
  // no-session boot and race that first install: the cache would vanish under
  // the worker, its puts would go nowhere, and it would activate with nothing,
  // leaving offline dead in that browser until the next deploy. See
  // offlineShell.ts, "WHY THE APP NEVER DELETES".
}

export async function loadCursor(): Promise<string | null> {
  try {
    const instance = await db();
    return ((await instance.get(STORE_META, 'cursor')) as string | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveCursor(cursor: string | null): Promise<void> {
  try {
    const instance = await db();
    if (cursor === null) await instance.delete(STORE_META, 'cursor');
    else await instance.put(STORE_META, cursor, 'cursor');
  } catch { /* ignore */ }
}

/** Tie-breaker paired with the cursor: the id of the last item from the
 *  previous sync page. Echoed back as `since_id` so the compound
 *  (updated_at, id) keyset cursor resumes exactly after that row. Null
 *  until the first page with items lands. */
export async function loadCursorId(): Promise<string | null> {
  try {
    const instance = await db();
    return ((await instance.get(STORE_META, 'cursor_id')) as string | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveCursorId(cursorId: string | null): Promise<void> {
  try {
    const instance = await db();
    if (cursorId === null) await instance.delete(STORE_META, 'cursor_id');
    else await instance.put(STORE_META, cursorId, 'cursor_id');
  } catch { /* ignore */ }
}

// ---- Offline edit queue ----

export interface PendingEdit {
  id: string;               // note id
  note: NoteItem;           // last-known local state to push
  op: 'update' | 'create';
  queuedAt: string;         // ISO timestamp
  /** The account it was queued for (canonical). Set by queuePending, never by
   *  callers; an entry runs only for this account. */
  account?: string;
  /**
   * On a CREATE only: what was changed on the note's card while its create was
   * still waiting. Applied as an update once the create is on the server
   * (lib/pendingNotes, "An edit never replaces a waiting create").
   */
  edits?: Partial<NoteItem>;
  /**
   * On a CREATE only: made again from a card that said it was waiting and had
   * no create behind it (lib/pendingNotes `createFromCard`). If the server
   * turns out to have the note, its row is taken as it is.
   */
  remade?: boolean;
  /**
   * On an UPDATE only: the note's words are on the server already, and only a
   * move's sharing is owed: the people of the notebook its sharing had it in
   * (`note.movedFrom`) taken off, the people of the one it is in given it, and
   * the note re-keyed. Its replay sends no words: sent again they would meet a
   * version conflict (another tab, another device), which would make a copy of
   * words nobody wrote here and drop the move.
   */
  sharingOnly?: boolean;
}

export async function queuePending(edit: PendingEdit): Promise<void> {
  try {
    const account = getTabAccount();
    const instance = await db();
    await instance.put(STORE_PENDING, { ...edit, account });
  } catch { /* ignore */ }
}

/**
 * Persist a re-key job, or update one in place. Keyed by notebook, so a second
 * removal merges into the outstanding job rather than racing a second one.
 */
export async function saveRekeyJob(job: RekeyJob): Promise<void> {
  try {
    const instance = await db();
    await instance.put(STORE_REKEYS, job);
  } catch { /* ignore */ }
}

export async function listRekeyJobs(): Promise<RekeyJob[]> {
  try {
    const instance = await db();
    return (await instance.getAll(STORE_REKEYS)) as RekeyJob[];
  } catch {
    return [];
  }
}

/** Only ever call this for a job whose every note actually rotated. */
export async function deleteRekeyJob(id: string): Promise<void> {
  try {
    const instance = await db();
    await instance.delete(STORE_REKEYS, id);
  } catch { /* ignore */ }
}

/** The tab's account's queued edit for one note, or null. */
export async function getPending(id: string): Promise<PendingEdit | null> {
  try {
    const account = getTabAccount();
    const instance = await db();
    const entry = (await instance.get(STORE_PENDING, id)) as PendingEdit | undefined;
    return entry && entry.account === account ? entry : null;
  } catch {
    return null;
  }
}

/** The tab's account's queued edits: only entries recorded for it. */
export async function listPending(): Promise<PendingEdit[]> {
  try {
    const account = getTabAccount();
    const instance = await db();
    const all = (await instance.getAll(STORE_PENDING)) as PendingEdit[];
    return all.filter(e => e.account === account);
  } catch {
    return [];
  }
}

/**
 * How many edits the tab's account still has queued. THROWS when the queue
 * cannot be read.
 *
 * `listPending` answers an unreadable queue with an empty list, which is right
 * for a drain (there is nothing it can send) and wrong for the one caller that
 * asks "is anything left?" before the device's copy is wiped: the Android
 * shell asks exactly that before a sign-out, and "0" means nothing is lost. A
 * queue that could not be read, reported as 0, would let whatever was in it go
 * with the wipe, unwarned. Not knowing is not zero: the shell takes a failure
 * here as its cue to warn.
 */
export async function countPending(): Promise<number> {
  const account = getTabAccount();
  const instance = await db();
  const all = (await instance.getAll(STORE_PENDING)) as PendingEdit[];
  return all.filter(e => e.account === account).length;
}

export async function removePending(id: string): Promise<void> {
  try {
    const instance = await db();
    await instance.delete(STORE_PENDING, id);
  } catch { /* ignore */ }
}

/**
 * A live editor draft, stashed on an interval while the editor is dirty.
 * `baseVersion` is the note version the draft was typed against: restore only
 * on an exact match, so a draft never clobbers an edit that arrived from
 * another device between the crash and the reopen (the crashed text is still
 * superseded work in that case). The composer uses a fixed sentinel id.
 */
export interface NoteDraft {
  id: string;
  title: string;
  body: string;
  checklistItems?: { text: string; checked: boolean }[];
  labels: string[];
  color: string | null;
  notebookId: string | null;
  baseVersion: number | null;
  stashedAt: number;
}

export async function putDraft(draft: NoteDraft): Promise<void> {
  try {
    const instance = await db();
    await instance.put(STORE_DRAFTS, draft);
  } catch { /* stash is best-effort; the debounced save is still coming */ }
}

export async function getDraft(id: string): Promise<NoteDraft | null> {
  try {
    const instance = await db();
    return ((await instance.get(STORE_DRAFTS, id)) as NoteDraft | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function removeDraft(id: string): Promise<void> {
  try {
    const instance = await db();
    await instance.delete(STORE_DRAFTS, id);
  } catch { /* a stale draft is dropped at next open by the version guard */ }
}
