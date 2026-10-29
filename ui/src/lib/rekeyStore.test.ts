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

import { describe, it, expect } from 'vitest';
import { migrateOldJobs, openRekeyStore, type RecordBackend } from './rekeyStore';
import { rekeyKeysFrom, sealRekeyJob, type SealedRekeyRecord } from './rekeySeal';
import { createJob, markObjectRevoked, type RekeyJob } from './rekeyQueue';

/**
 * An account's sealed job store: opened with the vault key it holds now,
 * then with its recovered pre-reset keys; a record none opens is kept, untouched.
 */

const A = '0e0e0e0e-0000-4000-8000-00000000000a';
const NB = '11111111-1111-4111-8111-111111111111';
const NB2 = '22222222-2222-4222-8222-222222222222';
const vaultNow = new Uint8Array(32).fill(1);
const vaultBeforeReset = new Uint8Array(32).fill(9);
const lost = new Uint8Array(32).fill(7);

function memory(): RecordBackend & { records: Map<string, SealedRekeyRecord> } {
  const records = new Map<string, SealedRekeyRecord>();
  return {
    records,
    all: async () => [...records.values()],
    get: async (k) => records.get(k),
    put: async (r) => { records.set(r.k, structuredClone(r)); },
    remove: async (k) => { records.delete(k); },
  };
}

const job = (nb: string, who = 'x@example.test', notes = ['n1']) => createJob({ notebookId: nb, removedRecipient: who, noteIds: notes, nowMs: 1 });

describe("an account's job store", () => {
  it('saves, lists and removes by notebook', async () => {
    const backend = memory();
    const store = await openRekeyStore(backend, A, vaultNow, async () => []);

    await store.save(job(NB));
    await store.save(job(NB2));
    expect(store.list().map(j => j.notebookId).sort()).toEqual([NB, NB2]);
    expect(backend.records.size).toBe(2);

    await store.remove(NB);
    expect(store.list().map(j => j.notebookId)).toEqual([NB2]);
    expect(backend.records.size).toBe(1);

    // A later opening reads what was saved.
    const again = await openRekeyStore(backend, A, vaultNow, async () => []);
    expect(again.list()).toEqual([job(NB2)]);
  });

  it('opens a record sealed before a password reset with the recovered key, and seals it again under the key held now', async () => {
    const backend = memory();
    const old = await sealRekeyJob(await rekeyKeysFrom(vaultBeforeReset), A, job(NB));
    await backend.put(old);
    let asked = 0;

    const store = await openRekeyStore(backend, A, vaultNow, async () => { asked++; return [vaultBeforeReset]; });

    expect(asked).toBe(1);
    expect(store.list()).toEqual([job(NB)]);
    expect(backend.records.has(old.k)).toBe(false);
    // It now opens directly.
    const direct = await openRekeyStore(backend, A, vaultNow, async () => { throw new Error('not asked'); });
    expect(direct.list()).toEqual([job(NB)]);
  });

  it('keeps a record no key here opens, untouched, and counts it', async () => {
    const backend = memory();
    const sealed = await sealRekeyJob(await rekeyKeysFrom(lost), A, job(NB));
    await backend.put(sealed);

    const store = await openRekeyStore(backend, A, vaultNow, async () => [vaultBeforeReset]);

    expect(store.list()).toEqual([]);
    expect(store.unopened).toBe(1);
    expect(backend.records.get(sealed.k)).toEqual(sealed);
  });

  it('opens nothing of another account in the same storage', async () => {
    const backend = memory();
    await backend.put(await sealRekeyJob(await rekeyKeysFrom(vaultNow), A, job(NB)));

    const other = await openRekeyStore(backend, '0e0e0e0e-0000-4000-8000-00000000000b', vaultNow, async () => []);

    expect(other.list()).toEqual([]);
    expect(other.unopened).toBe(1);
  });
});

describe('a record sealed before a password reset, for a notebook with a current job', () => {
  // Before the reset: X's removal. After it, while the record from before could
  // not be opened yet: Y's, for the same notebook. Both map to the one current
  // record key.
  async function bothRecords(oldFirst: boolean) {
    const backend = memory();
    const old = await sealRekeyJob(await rekeyKeysFrom(vaultBeforeReset), A,
      markObjectRevoked(createJob({ notebookId: NB, removedRecipient: 'x@example.test', noteIds: ['n1'], nowMs: 1 })));
    const current = await sealRekeyJob(await rekeyKeysFrom(vaultNow), A,
      createJob({ notebookId: NB, removedRecipient: 'y@example.test', noteIds: ['n2'], nowMs: 2 }));
    for (const r of oldFirst ? [old, current] : [current, old]) await backend.put(r);
    return backend;
  }
  const shape = (j: RekeyJob) => ({
    who: [...j.removedRecipients].sort(), notes: [...j.pendingNoteIds].sort(), objectPending: j.objectPending, startedAt: j.startedAt,
  });
  const both = { who: ['x@example.test', 'y@example.test'], notes: ['n1', 'n2'], objectPending: true, startedAt: 1 };

  for (const oldFirst of [true, false]) {
    it(`keeps both removals, in memory and on disk (${oldFirst ? 'the old record listed first' : 'the current one listed first'})`, async () => {
      const backend = await bothRecords(oldFirst);

      const store = await openRekeyStore(backend, A, vaultNow, async () => [vaultBeforeReset]);

      expect(store.list().map(shape)).toEqual([both]);
      expect(backend.records.size).toBe(1);
      const again = await openRekeyStore(backend, A, vaultNow, async () => { throw new Error('not asked'); });
      expect(again.list().map(shape)).toEqual([both]);
    });
  }
});

describe("a notebook's job, read again", () => {
  it('is what the store holds now, whoever wrote it (another tab, say)', async () => {
    const backend = memory();
    const here = await openRekeyStore(backend, A, vaultNow, async () => []);
    const otherTab = await openRekeyStore(backend, A, vaultNow, async () => []);
    await here.save(job(NB, 'x@example.test'));

    await otherTab.save(job(NB, 'y@example.test'));
    expect((await here.get(NB))?.removedRecipients).toEqual(['y@example.test']);
    expect(here.list().map(j => j.removedRecipients)).toEqual([['y@example.test']]);

    await otherTab.remove(NB);
    expect(await here.get(NB)).toBeNull();
    expect(here.list()).toEqual([]);
  });

  it('is null for a notebook with none', async () => {
    const store = await openRekeyStore(memory(), A, vaultNow, async () => []);
    expect(await store.get(NB2)).toBeNull();
  });
});

describe('the jobs left in the note cache by an older build', () => {
  it('move into the sealed store, merged with a job already there, and leave the old store', async () => {
    const store = await openRekeyStore(memory(), A, vaultNow, async () => []);
    await store.save(job(NB, 'x@example.test', ['n1']));
    const old = new Map<string, RekeyJob>([
      ['rekey:' + NB, job(NB, 'z@example.test', ['n2'])],
      ['rekey:' + NB2, job(NB2)],
    ]);

    const moved = await migrateOldJobs(store, { list: async () => [...old.values()], remove: async id => { old.delete(id); } });

    expect(moved).toBe(2);
    expect(old.size).toBe(0);
    const merged = store.list().find(j => j.notebookId === NB)!;
    expect(merged.removedRecipients.sort()).toEqual(['x@example.test', 'z@example.test']);
    expect(merged.pendingNoteIds.sort()).toEqual(['n1', 'n2']);
    expect(store.list().some(j => j.notebookId === NB2)).toBe(true);
  });
});
