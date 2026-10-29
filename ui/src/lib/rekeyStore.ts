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
 * Where the re-key jobs live: one sealed store per account, OUTSIDE the note
 * cache.
 *
 * The note cache (noteDb) is deleted whole at every session end — sign-out, a
 * no-session start, a denied re-check, another account signing in — so jobs
 * kept there would be lost by a sign-out in the middle of a removal: the notes
 * it had not reached would keep the removed person's share rows, and they
 * would keep reading them. This store is left by that wipe. Its records are
 * sealed (rekeySeal), its database name is a hash of the account, and it goes
 * only when a job completes or the account is erased (forgetAccount.ts). Only
 * the signed-in account's jobs are ever opened, and so only they resume.
 *
 * The storage is injected (RecordBackend) so the rules are testable without a
 * browser; indexedDbBackend is the thin real one.
 */

import { deleteDB, openDB } from 'idb';
import { openRekeyRecord, recordKeyFor, rekeyKeysFrom, sealRekeyJob, type RekeyKeys, type SealedRekeyRecord } from './rekeySeal';
import { mergeJobs, type RekeyJob } from './rekeyQueue';

export interface RecordBackend {
  all(): Promise<SealedRekeyRecord[]>;
  get(recordKey: string): Promise<SealedRekeyRecord | undefined>;
  put(record: SealedRekeyRecord): Promise<void>;
  remove(recordKey: string): Promise<void>;
}

/** An account's jobs, opened. */
export interface OpenedRekeyStore {
  /** The jobs that opened, by notebook. */
  list(): RekeyJob[];
  /** A notebook's job as stored now, read again (another tab may have changed
   *  it), or null when there is none. */
  get(notebookId: string): Promise<RekeyJob | null>;
  save(job: RekeyJob): Promise<void>;
  remove(notebookId: string): Promise<void>;
  /** Records no key held here opens (a password reset with no recovered
   *  identity): kept sealed, untouched, until one does or the account is erased. */
  unopened: number;
}

/**
 * Open `accountId`'s store with the vault key it holds now. A record that
 * doesn't open with it is tried under each recovered pre-reset vault key
 * (`previousVaultKeys`, asked only then); one that opens is sealed again under
 * the current key, so it opens directly next time. One that opens under none
 * is kept as it is.
 */
export async function openRekeyStore(
  backend: RecordBackend,
  accountId: string,
  vaultKey: Uint8Array,
  previousVaultKeys: () => Promise<Uint8Array[]>,
): Promise<OpenedRekeyStore> {
  const keys = await rekeyKeysFrom(vaultKey);
  const jobs = new Map<string, RekeyJob>();
  let unopened = 0;
  let previous: RekeyKeys[] | null = null;

  // Every record the key held now opens first, so a pre-reset record below
  // always finds the current job for its notebook, whatever the order.
  const rest: SealedRekeyRecord[] = [];
  for (const record of await backend.all()) {
    const job = await openRekeyRecord(keys, accountId, record);
    if (job) jobs.set(job.notebookId, job);
    else rest.push(record);
  }
  for (const record of rest) {
    previous ??= await Promise.all((await previousVaultKeys().catch(() => [])).map(rekeyKeysFrom));
    let job: RekeyJob | null = null;
    for (const old of previous) {
      job = await openRekeyRecord(old, accountId, record);
      if (job) break;
    }
    if (!job) { unopened++; continue; }
    // Sealed again under the key held now, where the notebook's current job
    // lives: merged with it, never put over it. Then the old record goes.
    const here = jobs.get(job.notebookId);
    const merged = here ? mergeJobs(here, job) : job;
    await backend.put(await sealRekeyJob(keys, accountId, merged));
    await backend.remove(record.k);
    jobs.set(merged.notebookId, merged);
  }

  return {
    list: () => [...jobs.values()],
    async get(notebookId) {
      const record = await backend.get(await recordKeyFor(keys, notebookId));
      const job = record ? await openRekeyRecord(keys, accountId, record) : null;
      if (job?.notebookId !== notebookId) {
        jobs.delete(notebookId);
        return null;
      }
      jobs.set(notebookId, job);
      return job;
    },
    async save(job) {
      await backend.put(await sealRekeyJob(keys, accountId, job));
      jobs.set(job.notebookId, job);
    },
    async remove(notebookId) {
      await backend.remove(await recordKeyFor(keys, notebookId));
      jobs.delete(notebookId);
    },
    unopened,
  };
}

/**
 * Move jobs out of the note cache's old `rekeys` store (which a session end
 * deletes) into the sealed store, merging with a job already there for the same
 * notebook. Each old job goes from the old store only once it is sealed here.
 */
export async function migrateOldJobs(
  store: OpenedRekeyStore,
  old: { list(): Promise<RekeyJob[]>; remove(id: string): Promise<void> },
): Promise<number> {
  let moved = 0;
  for (const job of await old.list()) {
    const here = store.list().find(j => j.notebookId === job.notebookId);
    await store.save(here ? mergeJobs(here, job) : job);
    await old.remove(job.id);
    moved++;
  }
  return moved;
}

const DB_PREFIX = 'pingolin-note-rekeys';
const RECORDS = 'records';

/** The database's name: a hash of the account, so it names nobody after a sign-out.
 *  Not under the note cache's prefix, which clearLocalCache deletes whole. */
export async function rekeyDbName(accountId: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${DB_PREFIX}:${accountId}`));
  return `${DB_PREFIX}.${[...new Uint8Array(h)].slice(0, 16).map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

/** The real backend: IndexedDB, one database per account, never touched by clearLocalCache. */
export async function indexedDbBackend(accountId: string): Promise<RecordBackend> {
  const db = await openDB(await rekeyDbName(accountId), 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(RECORDS)) d.createObjectStore(RECORDS, { keyPath: 'k' });
    },
  });
  return {
    all: () => db.getAll(RECORDS) as Promise<SealedRekeyRecord[]>,
    get: (recordKey) => db.get(RECORDS, recordKey) as Promise<SealedRekeyRecord | undefined>,
    put: async (record) => { await db.put(RECORDS, record); },
    remove: async (recordKey) => { await db.delete(RECORDS, recordKey); },
  };
}

/** An erasure: the account's job store goes with the rest of its data. */
export async function deleteRekeyDb(accountId: string): Promise<void> {
  await deleteDB(await rekeyDbName(accountId));
}
