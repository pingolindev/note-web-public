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
 * The real [RekeyDeps]: the account's sealed job store (rekeyStore) for the
 * jobs, the notes store for a notebook's whole note list (after a full pull),
 * the server's share lists for what is done, and the atomic rotate-shares
 * endpoint for the rotation.
 *
 * Kept apart from [rekeyDrain] so the drain logic stays testable without a
 * database, a network or the crypto — and so this file, which is only wiring,
 * is the only place that knows about any of them.
 */

import { apiRequest } from './apiClient';
import { listRekeyJobs, deleteRekeyJob } from './noteDb';
import { rotateContentKey } from './shareUtils';
import { revokeNotebookAccess, revokeNotebookObjectShare } from './notebookRemoval';
import { getTabAccount } from './account';
import { getPreviousVaultKeys, getVaultKey } from './crypto';
import { ensurePreviousIdentities } from './previousIdentities';
import { indexedDbBackend, migrateOldJobs, openRekeyStore, type OpenedRekeyStore } from './rekeyStore';
import { notesStore } from '../stores/notes';
import { notebooksStore } from '../stores/notebooks';
import { drainJob, resumeRekeyJobs, type RekeyDeps } from './rekeyDrain';
import { jobIdFor, type RekeyJob } from './rekeyQueue';

/** The signed-in account's opened job store, once [loadHeldRemovals] has read it. */
let opened: { account: string; store: OpenedRekeyStore } | null = null;

/** Only the account signed in now: another account's jobs are never listed or written. */
function jobStore(): OpenedRekeyStore | null {
  return opened && opened.account === getTabAccount() ? opened.store : null;
}

/**
 * Read the signed-in account's sealed re-key jobs and hold the people they
 * remove, then open the holds gate (notebooksStore). Run at every start, and
 * again whenever the account's keys arrive (a retained document's re-login).
 * The gate closes at the call, before anything is read, and only the read begun
 * last opens it: one that finishes after a later one began holds and opens
 * nothing, since what it read may be older than that one.
 *
 * With no account or no vault key there is nothing to read, and nothing can be
 * adopted either (the metadata row doesn't decrypt), so the gate opens; the
 * keys' arrival reads again. A store that can't be read at all opens the gate
 * too, and says so: the lists are then adopted without the holds.
 */
export async function loadHeldRemovals(): Promise<void> {
  const read = notebooksStore.beginHoldsRead();
  const account = getTabAccount();
  const vault = getVaultKey();
  if (!account || !vault) {
    read.open();
    return;
  }
  try {
    const store = await openRekeyStore(
      await indexedDbBackend(account), account, vault,
      async () => { await ensurePreviousIdentities('/api/v1').catch(() => 0); return getPreviousVaultKeys(); },
    );
    const moved = await migrateOldJobs(store, { list: () => listRekeyJobs(), remove: id => deleteRekeyJob(id) })
      .catch(() => 0);
    // A read begun since (the keys arrived again, another account was
    // confirmed) is the one that holds and opens.
    if (!read.latest() || getTabAccount() !== account) return;
    opened = { account, store };
    if (moved > 0) console.info(`[note] moved ${moved} removal job(s) out of the note cache into their sealed store`);
    if (store.unopened > 0) console.info(`[note] ${store.unopened} removal job(s) stay sealed: no key held here opens them`);
    read.loaded(store.list());
  } catch (e) {
    console.warn('[note] 1 removal job store could not be read: lists are adopted without its holds', e);
    read.open();
  }
}

interface ShareRow { id: string; recipient_email: string; permission: string }

/** The job's people's share rows on one note as the server lists them now, or
 *  null when the list can't be read. */
async function theirRowsOn(noteId: string, job: RekeyJob): Promise<ShareRow[] | null> {
  const list = await apiRequest<ShareRow[]>(`/api/v1/items/${noteId}/shares`);
  if (!list.success || !Array.isArray(list.data)) return null;
  const targets = new Set(job.removedRecipients.map(r => r.toLowerCase()));
  return list.data.filter(s => targets.has(s.recipient_email.toLowerCase()));
}

/**
 * Take the job's recipients off one note: rotate its content key without them,
 * or, where it can't be re-keyed here, revoke their rows.
 *
 * The share rows are looked up fresh rather than remembered in the job: ids
 * change if a share is re-created, and a drain can resume days later. What the
 * job remembers is WHO, which is stable.
 *
 * Done only on the server's word: its list of the note's rows with none of
 * theirs — they are off it already, rotated before or the note purged (the
 * rows go with it) — or a rotate-shares that landed, which deletes their rows
 * in the same transaction. Nothing else ends a note: not its absence from
 * memory, not a 404 on the item, which is read from a replica and just after
 * their rows were listed is lag, not "gone".
 *
 * A note the server holds in the trash can't be rotated (rotate-shares
 * updates only live rows), and one that doesn't open here can't be re-keyed
 * here at all: their rows are revoked without a re-key, as the notebook
 * object's own fallback does (notebookRemoval), and the note is done once the
 * list, read again, holds none of theirs. Restored later, such a note is under
 * a key they held, but they hold no row to be served it by.
 *
 * So is a note whose re-key cannot be done here even though it is in memory:
 * the new key cannot be signed for someone who stays, or its key does not
 * open here, still so once the removal has waited [REKEY_WAIT_MS]. Nothing is
 * sent for such a re-key; otherwise the removed people would keep their rows
 * on the note for as long as that went on — for good, where it never could.
 */
async function rotateAwayFrom(noteId: string, job: RekeyJob): Promise<boolean> {
  const theirs = await theirRowsOn(noteId, job);
  if (theirs === null) return false;
  if (theirs.length === 0) return true;

  const item = await apiRequest<{ deleted?: boolean }>(`/api/v1/items/${noteId}`);
  if (!item.success || !item.data) return false;
  const trashed = item.data.deleted === true;
  const opensHere = notesStore.notes().some(n => n?.id === noteId);
  if (!trashed && opensHere) {
    // Tagged `notebook_removal`: these rotations ARE the notebook removal.
    const r = await rotateContentKey(noteId, theirs.map(s => s.id), 'notebook_removal');
    if (r.rotated) return true;
    console.warn(`[note] content-key rotation failed for note ${noteId}`);
    const cannotHere = r.couldNotSign === true || r.notOpenHere === true;
    if (!cannotHere || Date.now() - job.startedAt < REKEY_WAIT_MS) return false;
    return revokeTheirRows(noteId, job, theirs);
  }
  if (!trashed && !notebooksStore.hasPulled(true)) {
    // Not in memory may only mean not pulled yet: after a full pull it means
    // the note doesn't open here. Until then it waits (drainAgainAfterFullPull).
    notesStore.requestFullPull();
    return false;
  }
  return revokeTheirRows(noteId, job, theirs);
}

/**
 * How long a removal waits for a re-key that cannot be done here before it
 * takes the rows off without one (`rotateAwayFrom`): long enough for a key
 * this device has not loaded yet, or a stale copy a pull replaces, to come
 * right by itself.
 */
export const REKEY_WAIT_MS = 10 * 60_000;

/** Their rows on a note revoked without a re-key: done once the list, read again, holds none of theirs. */
async function revokeTheirRows(noteId: string, job: RekeyJob, theirs: readonly ShareRow[]): Promise<boolean> {
  for (const s of theirs) {
    await apiRequest(`/api/v1/shares/${s.id}?reason=notebook_removal`, { method: 'DELETE' }).catch(() => null);
  }
  const left = await theirRowsOn(noteId, job);
  if (left?.length !== 0) console.warn(`[note] note ${noteId} could not be re-keyed, and its rows for the removed people are not all gone yet`);
  return left !== null && left.length === 0;
}

/**
 * The notebook's own part of a removal: the job's people out of the roster and
 * off the notebook object, retried by every drain until it lands. The roster is
 * read from the server first: after a reload it may not be in memory, and an
 * unknown roster reads as "nobody to take out".
 */
async function revokeTheirNotebookAccess(job: RekeyJob): Promise<boolean> {
  const item = await notebooksStore.refreshNotebookItem(job.notebookId);
  if (item === 'gone') return true;
  if (item === 'failed') {
    console.warn(`[note] notebook ${job.notebookId} could not be read: the removed people stay pending on its roster and object`);
    return false;
  }
  let all = true;
  for (const email of job.removedRecipients) {
    if (item === 'deleted') {
      const r = await revokeNotebookObjectShare(job.notebookId, email).catch(() => ({ revoked: false }));
      if (!r.revoked) all = false;
      continue;
    }
    const r = await revokeNotebookAccess(job.notebookId, email);
    if (!r.rosterUpdated || !r.objectRevoked) all = false;
  }
  return all;
}

export const rekeyDeps: RekeyDeps = {
  listJobs: async () => jobStore()?.list() ?? [],
  getJob: async (notebookId) => (await jobStore()?.get(notebookId)) ?? null,
  saveJob: async (job) => {
    const store = jobStore();
    if (!store) throw new Error('the removal jobs are not open for this account');
    await store.save(job);
  },
  // The job's id is `rekey:<notebook id>` (rekeyQueue.jobIdFor); the store keys by notebook.
  deleteJob: async (id) => { await jobStore()?.remove(id.replace(/^rekey:/, '')); },
  rotate: rotateAwayFrom,
  listNotebookNotes: async (notebookId) => notesStore.notebookNoteIds(notebookId),
  now: () => Date.now(),
  dropFromStandingList: job => notebooksStore.holdRemovals(job.notebookId, job.removedRecipients),
  revokeObject: revokeTheirNotebookAccess,
};

/** `base` with its jobs held in memory, for a removal whose job can't be
 *  written (removeNotebookMember): this document only, nothing resumes it. */
export function jobsInMemory(base: RekeyDeps): RekeyDeps {
  const jobs = new Map<string, RekeyJob>();
  return {
    ...base,
    listJobs: async () => [...jobs.values()],
    getJob: async (notebookId) => jobs.get(jobIdFor(notebookId)) ?? null,
    saveJob: async (job) => { jobs.set(job.id, job); },
    deleteJob: async (id) => { jobs.delete(id); },
  };
}

/**
 * Wait for this session's first pull (`full`: its first full one) while
 * `account` is the tab's. False once another account is, or none: the session
 * the waiter belonged to ended. A reset that wakes a waiter for the same
 * account parks it again, so a renewal never strands a drain.
 */
export async function pulledFor(account: string | null, full: boolean): Promise<boolean> {
  for (;;) {
    if (account === null || getTabAccount() !== account) return false;
    if (notebooksStore.hasPulled(full)) return true;
    await notebooksStore.nextPullEvent();
  }
}

/**
 * The drains' answers that need a full pull — a notebook's whole note list, a
 * note that isn't in memory — wait for one: if this session has none yet and
 * jobs are left, ask for it, and drain them again once it has landed.
 */
export async function drainAgainAfterFullPull(deps: RekeyDeps, account: string | null): Promise<void> {
  if (notebooksStore.hasPulled(true)) return;
  if ((await deps.listJobs()).length === 0) return;
  notesStore.requestFullPull();
  if (!(await pulledFor(account, true))) return;
  for (const job of await deps.listJobs()) await drainJob(deps, job).catch(() => null);
}

/**
 * The start's part, after checkAuth (App.tsx). Finish any removal that was
 * interrupted: re-keying a notebook is a loop over every note in it, and the
 * usual way it stops is the tab being closed or a sign-out — leaving the notes
 * it never reached encrypted under a key the removed member holds. The holds
 * come first: until the jobs are read, nothing is adopted from the server (the
 * gate), and the drains need the jobs open. Then the drains wait for this
 * session's first pull: they rotate notes from memory, which a page starts
 * without (a drain run first would read every note as deleted). They never
 * block the start, and a job stays in its store if one fails again.
 */
export async function startRemovalJobs(authenticated: boolean): Promise<void> {
  await loadHeldRemovals();
  if (!authenticated) return;
  const account = getTabAccount();
  void (async () => {
    if (!(await pulledFor(account, false))) return;
    const r = await resumeRekeyJobs(rekeyDeps);
    if (r.jobs > 0) console.info(`[note] resumed ${r.jobs} re-key job(s), ${r.completed} completed`);
    await drainAgainAfterFullPull(rekeyDeps, account);
  })().catch(e => console.warn('[note] could not resume re-key jobs', e));
}

/** A retained document's keys arrived again (App.tsx __pingolinKeysUpdated):
 *  close the gate at once (the read's first, synchronous step), then read this
 *  account's jobs again. */
export function keysArrivedAgain(): void {
  void loadHeldRemovals();
}
