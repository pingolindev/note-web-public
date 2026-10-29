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

import { describe, it, expect, vi } from 'vitest';
import { beginRemoval, drainJob, forgetRemoval, resumeRekeyJobs, type RekeyDeps } from './rekeyDrain';
import { createJob, jobIdFor, mergeRemoval, type RekeyJob } from './rekeyQueue';

/**
 * An in-memory stand-in for IndexedDB plus the rotation, so the property this
 * module exists for — that an interrupted removal resumes on exactly what is
 * left — can actually be exercised.
 */
function harness(opts: {
  rotate?: (noteId: string) => Promise<boolean>;
  /** The notebook's full note list: by default complete and adding nothing. */
  notes?: (notebookId: string) => Promise<readonly string[] | null>;
  /** The standing-list write: true when it landed. */
  drop?: (job: RekeyJob) => Promise<boolean>;
  /** The roster and object revoke: true when it landed. */
  object?: (job: RekeyJob) => Promise<boolean>;
} = {}) {
  const store = new Map<string, RekeyJob>();
  const rotated: string[] = [];
  /** Every drop and rotation, in order. */
  const events: string[] = [];
  const deps: RekeyDeps = {
    listJobs: async () => [...store.values()],
    getJob: async notebookId => structuredClone(store.get(jobIdFor(notebookId))) ?? null,
    saveJob: async job => { store.set(job.id, structuredClone(job)); },
    deleteJob: async id => { store.delete(id); },
    rotate: async noteId => {
      events.push(`rotate ${noteId}`);
      const ok = opts.rotate ? await opts.rotate(noteId) : true;
      if (ok) rotated.push(noteId);
      return ok;
    },
    listNotebookNotes: async notebookId => (opts.notes ? opts.notes(notebookId) : []),
    now: () => 1_000,
    dropFromStandingList: async job => {
      events.push(`drop ${job.notebookId} ${job.removedRecipients.join(',')}`);
      return opts.drop ? opts.drop(job) : true;
    },
    revokeObject: async job => {
      events.push(`object ${job.notebookId} ${job.removedRecipients.join(',')}`);
      return opts.object ? opts.object(job) : true;
    },
  };
  return { deps, store, rotated, events };
}

const NB = 'nb1';

describe('recording a removal', () => {
  /**
   * The ordering the whole design rests on: if the intent is not on disk
   * before anything is carried out, a removal that dies mid-rotation leaves
   * notes holding the removed member's key and nothing to finish the job.
   */
  it('persists the job before any rotation happens', async () => {
    const { deps, store } = harness();
    await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });

    expect(store.get(jobIdFor(NB))?.pendingNoteIds).toEqual(['n1', 'n2']);
  });

  it('folds a second removal into the outstanding job', async () => {
    const { deps, store } = harness();
    await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });
    await beginRemoval(deps, { notebookId: NB, removedRecipient: 'trent', noteIds: ['n1', 'n2'] });

    const job = store.get(jobIdFor(NB))!;
    expect(job.removedRecipients).toEqual(['mallory', 'trent']);
    expect(job.pendingNoteIds).toEqual(['n1', 'n2']);
    expect(store.size).toBe(1);
  });
});

describe('draining a job', () => {
  it('rotates every pending note and clears the job', async () => {
    const { deps, store, rotated } = harness();
    const job = await beginRemoval(deps,
      { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2', 'n3'] });

    await drainJob(deps, job);

    expect(rotated).toEqual(['n1', 'n2', 'n3']);
    expect(store.size).toBe(0);
  });

  /**
   * Progress is saved per note, not per batch. Recording only on completion
   * would redo every note after any interruption — each redo costing another
   * key rotation.
   */
  it('records progress after each note, not at the end', async () => {
    const seen: number[] = [];
    const { deps, store } = harness({
      rotate: async () => {
        seen.push(store.get(jobIdFor(NB))?.pendingNoteIds.length ?? -1);
        return true;
      },
    });
    const job = await beginRemoval(deps,
      { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2', 'n3'] });

    await drainJob(deps, job);

    expect(seen).toEqual([3, 2, 1]);
  });

  /** A note that fails must stay pending, or the job "completes" while the
   *  removed member's key is still live on it. */
  it('leaves a failed note pending and keeps the job', async () => {
    const { deps, store } = harness({ rotate: async id => id !== 'n2' });
    const job = await beginRemoval(deps,
      { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2', 'n3'] });

    const after = await drainJob(deps, job);

    expect(after!.pendingNoteIds).toEqual(['n2']);
    expect(store.get(jobIdFor(NB))?.pendingNoteIds).toEqual(['n2']);
  });

  it('treats a throwing rotation as a failure rather than losing the job', async () => {
    const { deps, store } = harness({
      rotate: async id => { if (id === 'n2') throw new Error('network'); return true; },
    });
    const job = await beginRemoval(deps,
      { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2', 'n3'] });

    await drainJob(deps, job);

    expect(store.get(jobIdFor(NB))?.pendingNoteIds).toEqual(['n2']);
  });

  /**
   * A drain must not drop every note the notes in memory don't hold, as
   * deleted: at a start memory holds none yet, so a job would "complete" with
   * nothing rotated and the removed person would keep every note. A note
   * leaves only on the rotation's answer, which asks the server.
   */
  it('drops no note: one the rotation does not confirm stays, whatever memory holds', async () => {
    const { deps, store, rotated } = harness({ rotate: async id => id !== 'n2' });
    const job = await beginRemoval(deps,
      { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2', 'n3'] });

    await drainJob(deps, job);

    expect(rotated).toEqual(['n1', 'n3']);
    expect(store.get(jobIdFor(NB))?.pendingNoteIds).toEqual(['n2']);
  });
});

describe("the notebook's full note list", () => {
  it('is folded in before the notes, and its notes are rotated in the same drain', async () => {
    const asked: string[] = [];
    const { deps, store, rotated } = harness({ notes: async nb => { asked.push(nb); return ['n1', 'n4', 'n5']; } });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    await drainJob(deps, job);

    expect(asked).toEqual([NB]);
    expect(rotated).toEqual(['n1', 'n4', 'n5']);
    expect(store.size).toBe(0);
  });

  it('keeps the job, every note done, while the list cannot be complete yet, and is asked again', async () => {
    let complete = false;
    const { deps, store, rotated } = harness({ notes: async () => (complete ? ['n1', 'n2'] : null) });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    await drainJob(deps, job);
    expect(rotated).toEqual(['n1']);
    expect(store.get(jobIdFor(NB))).toMatchObject({ pendingNoteIds: [], noteListPending: true });

    complete = true;
    await drainJob(deps, job);
    expect(rotated).toEqual(['n1', 'n1', 'n2']);
    expect(store.size).toBe(0);
  });

  it('keeps the job when the listing throws, and still rotates what it has', async () => {
    const { deps, store, rotated } = harness({ notes: async () => { throw new Error('offline'); } });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    await drainJob(deps, job);

    expect(rotated).toEqual(['n1']);
    expect(store.get(jobIdFor(NB))?.noteListPending).toBe(true);
  });

  it('is folded into a job written before the field existed', async () => {
    const { deps, store, rotated } = harness({ notes: async () => ['n1', 'n2'] });
    const { noteListPending: _, ...old } = createJob({ notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'], nowMs: 1 });
    await deps.saveJob(old);

    await resumeRekeyJobs(deps);

    expect(rotated).toEqual(['n1', 'n2']);
    expect(store.size).toBe(0);
  });

  it('is not asked again once folded in', async () => {
    const asked: string[] = [];
    const { deps } = harness({ rotate: async () => false, notes: async nb => { asked.push(nb); return []; } });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    await drainJob(deps, job);
    await drainJob(deps, job);

    expect(asked).toEqual([NB]);
  });
});

describe('the standing share list', () => {
  /**
   * The list seals every NEW note in the notebook to its people. A removal
   * takes them off it first, but that write can be lost with the tab, and the
   * resume is then the only thing that repeats it — before any note, since
   * re-keying the old notes protects nothing while the new ones go to them.
   */
  it('takes the removed people off it before rotating anything', async () => {
    const { deps, events } = harness();
    const job = await beginRemoval(deps,
      { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });

    await drainJob(deps, job);

    expect(events).toEqual([`drop ${NB} mallory`, `object ${NB} mallory`, 'rotate n1', 'rotate n2']);
  });

  it('is repeated by a resume even when no note can be rotated', async () => {
    const { deps, events, store } = harness({ rotate: async () => false });
    await deps.saveJob(createJob({ notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'], nowMs: 1 }));

    await resumeRekeyJobs(deps);

    expect(events[0]).toBe(`drop ${NB} mallory`);
    expect(store.has(jobIdFor(NB))).toBe(true);
  });

  /** The job is the only record that repeats the list write on the next start,
   *  so it stays until that write has landed, however far the re-keying got. */
  it('keeps a job whose list write has not landed, with every note rotated', async () => {
    let landed = false;
    const { deps, store } = harness({ drop: async () => landed });
    const job = await beginRemoval(deps,
      { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });

    const after = await drainJob(deps, job);

    expect(after!.pendingNoteIds).toEqual([]);
    expect(store.get(jobIdFor(NB))?.pendingNoteIds).toEqual([]);

    landed = true;
    await resumeRekeyJobs(deps);
    expect(store.size).toBe(0);
  });

  it('neither stops the re-keying nor lets the job go when the list write throws', async () => {
    const { deps, store, rotated } = harness({ drop: async () => { throw new Error('quota'); } });
    const job = await beginRemoval(deps,
      { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });

    await drainJob(deps, job);

    expect(rotated).toEqual(['n1', 'n2']);
    expect(store.has(jobIdFor(NB))).toBe(true);
  });
});

describe("the notebook's own part (roster and object)", () => {
  /**
   * The removal revokes them at once, but a revoke that fails is only logged:
   * without the job carrying it, a member left on the object keeps reading the
   * notebook, and one left in the roster keeps being sealed to.
   */
  it('is retried by every drain until it lands, and the job stays until then', async () => {
    let lands = false;
    const { deps, store, events } = harness({ object: async () => lands });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    await drainJob(deps, job);
    expect(store.get(jobIdFor(NB))?.objectPending).toBe(true);
    expect(store.get(jobIdFor(NB))?.pendingNoteIds).toEqual([]);

    lands = true;
    await resumeRekeyJobs(deps);
    expect(store.size).toBe(0);
    expect(events.filter(e => e.startsWith('object'))).toHaveLength(2);
  });

  it('comes before the notes, after the list', async () => {
    const { deps, events } = harness();
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    await drainJob(deps, job);

    expect(events).toEqual([`drop ${NB} mallory`, `object ${NB} mallory`, 'rotate n1']);
  });

  it('is not asked again once it has landed', async () => {
    let lands = true;
    const { deps, events } = harness({ object: async () => lands, rotate: async id => id !== 'n2' });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });
    await drainJob(deps, job);

    lands = false;
    await resumeRekeyJobs(deps);

    expect(events.filter(e => e.startsWith('object'))).toHaveLength(1);
  });

  it('is run once for a job written before it existed', async () => {
    const { deps, store, events } = harness();
    const old = createJob({ notebookId: NB, removedRecipient: 'mallory', noteIds: [], nowMs: 1 });
    delete (old as { objectPending?: boolean }).objectPending;
    await deps.saveJob(old);

    await resumeRekeyJobs(deps);

    expect(events.filter(e => e.startsWith('object'))).toHaveLength(1);
    expect(store.size).toBe(0);
  });

  it('keeps the job when it throws, and still re-keys', async () => {
    const { deps, store, rotated } = harness({ object: async () => { throw new Error('network'); } });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    await drainJob(deps, job);

    expect(rotated).toEqual(['n1']);
    expect(store.get(jobIdFor(NB))?.objectPending).toBe(true);
  });
});

describe('resuming after an interruption', () => {
  /**
   * The scenario the module exists for: the tab was closed after one note of
   * three. The next start must finish the remaining two and re-rotate neither
   * the one already done nor anything else.
   */
  it('finishes exactly what was left', async () => {
    const { deps, store, rotated } = harness();
    // A job as it would have been left on disk mid-drain.
    const interrupted = createJob({
      notebookId: NB, removedRecipient: 'mallory',
      noteIds: ['n2', 'n3'], nowMs: 1_000,
    });
    await deps.saveJob(interrupted);

    const result = await resumeRekeyJobs(deps);

    expect(rotated).toEqual(['n2', 'n3']);
    expect(result).toEqual({ jobs: 1, completed: 1 });
    expect(store.size).toBe(0);
  });

  it('does nothing when there is nothing outstanding', async () => {
    const { deps, rotated } = harness();
    expect(await resumeRekeyJobs(deps)).toEqual({ jobs: 0, completed: 0 });
    expect(rotated).toEqual([]);
  });

  /** One stuck notebook must not block the others. */
  it('keeps going when a job cannot be drained', async () => {
    const { deps, store, rotated } = harness({
      rotate: async id => id !== 'stuck',
    });
    await deps.saveJob(createJob({
      notebookId: 'nbA', removedRecipient: 'm', noteIds: ['stuck'], nowMs: 1,
    }));
    await deps.saveJob(createJob({
      notebookId: 'nbB', removedRecipient: 'm', noteIds: ['n1'], nowMs: 1,
    }));

    const result = await resumeRekeyJobs(deps);

    expect(rotated).toEqual(['n1']);
    expect(result.completed).toBe(1);
    // The stuck one stays on disk for the next start.
    expect([...store.keys()]).toEqual([jobIdFor('nbA')]);
  });

  it('survives storage that cannot be read', async () => {
    const { deps } = harness();
    const broken = { ...deps, listJobs: vi.fn().mockRejectedValue(new Error('no idb')) };
    expect(await resumeRekeyJobs(broken)).toEqual({ jobs: 0, completed: 0 });
  });
});

/** A step that waits until the test lets it go. */
function deferred() {
  let release!: () => void;
  const until = new Promise<void>(r => { release = r; });
  return { until, release };
}

describe('someone shared the notebook again while their removal is outstanding', () => {
  it('takes them out of the job, which goes when nobody is left, and the drain then acts on no one', async () => {
    const { deps, store, events } = harness();
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    // It says they WERE being removed: a share that then fails starts the removal again.
    expect(await forgetRemoval(deps, NB, 'Mallory')).toBe(true);
    expect(store.size).toBe(0);
    // And not a second time: there is no removal of them any more.
    expect(await forgetRemoval(deps, NB, 'Mallory')).toBe(false);

    expect(await drainJob(deps, job)).toBeNull();
    expect(events).toEqual([]);
    expect(store.size).toBe(0);
  });

  it('keeps the job for anyone else it removes, and the drain acts on them only', async () => {
    const { deps, store, events } = harness();
    await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'trent', noteIds: ['n1'] });

    // Someone the job does not remove was not being removed, and the job is as it was.
    expect(await forgetRemoval(deps, NB, 'someone-else')).toBe(false);
    expect(store.get(jobIdFor(NB))?.removedRecipients).toEqual(['mallory', 'trent']);
    expect(await forgetRemoval(deps, NB, 'mallory')).toBe(true);
    expect(store.get(jobIdFor(NB))?.removedRecipients).toEqual(['trent']);

    await drainJob(deps, job); // the job as it was before the re-add names mallory too
    expect(events).toEqual([`drop ${NB} trent`, `object ${NB} trent`, 'rotate n1']);
    expect(store.size).toBe(0);
  });

  it('waits for the step in flight; no later step acts on them, and the job is not written back', async () => {
    const gate = deferred();
    const { deps, store, events } = harness({
      rotate: async id => { if (id === 'n1') await gate.until; return true; },
    });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });
    const drained = drainJob(deps, job);
    await vi.waitFor(() => expect(events).toContain('rotate n1'));

    let forgotten = false;
    const readd = forgetRemoval(deps, NB, 'mallory').then(() => { forgotten = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(forgotten).toBe(false); // the rotation of n1 is still in flight
    gate.release();
    await readd;
    await drained;

    expect(events).toEqual([`drop ${NB} mallory`, `object ${NB} mallory`, 'rotate n1']);
    expect(store.size).toBe(0);
  });

  it('acts on the job as stored at each step, not the one it was handed', async () => {
    const { deps, events } = harness();
    await deps.saveJob(createJob({ notebookId: NB, removedRecipient: 'trent', noteIds: ['n1'], nowMs: 1 }));
    const stale = createJob({ notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'], nowMs: 1 });

    await drainJob(deps, stale);

    expect(events).toEqual([`drop ${NB} trent`, `object ${NB} trent`, 'rotate n1']);
  });
});

describe('the job changing under a step', () => {
  it('a removal folded in during a rotation waits its turn; the later steps act on it, and its own drain does the rest', async () => {
    const gate = deferred();
    const { deps, store, events } = harness({
      rotate: async id => { if (id === 'n1') await gate.until; return true; },
    });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });
    const drained = drainJob(deps, job);
    await vi.waitFor(() => expect(events).toContain('rotate n1'));

    // Trent's removal waits its turn, then folds in: n1's new key went to him.
    const folded = beginRemoval(deps, { notebookId: NB, removedRecipient: 'trent', noteIds: ['n1', 'n2'] });
    gate.release();
    await folded;
    await drained;

    const left = store.get(jobIdFor(NB))!;
    expect(left.removedRecipients).toEqual(['mallory', 'trent']);
    expect(left.pendingNoteIds).toEqual(['n1']); // n1 again for trent; n2 was rotated with him removed
    expect(events.slice(3)).toEqual(['rotate n2']);
    expect(left.objectPending).toBe(true); // his roster and object part: his removal's drain

    await drainJob(deps, left);
    expect(events.slice(4)).toEqual([`drop ${NB} mallory,trent`, `object ${NB} mallory,trent`, 'rotate n1']);
    expect(store.size).toBe(0);
  });

  it('the job stays until the list write has landed for everyone it removes', async () => {
    const { deps, store } = harness({
      drop: async job => {
        // Another tab folds trent in, and finishes his roster and object part,
        // while this drain's list write (for mallory) is in flight.
        const now = store.get(jobIdFor(NB))!;
        store.set(now.id, { ...now, removedRecipients: [...now.removedRecipients, 'trent'], objectPending: false });
        return job.removedRecipients.length > 0;
      },
    });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    const after = await drainJob(deps, job);

    expect(after?.pendingNoteIds).toEqual([]);
    expect(after?.objectPending).toBe(false);
    expect(store.has(jobIdFor(NB))).toBe(true); // trent's list write is this drain's to confirm only next time
  });

  it('a step does not mark done what someone added meanwhile (another tab) still needs', async () => {
    const { deps, store } = harness({
      rotate: async id => {
        // Another tab folds trent in while n1 rotates for mallory alone.
        const now = store.get(jobIdFor(NB))!;
        if (id === 'n1') store.set(now.id, mergeRemoval(now, { removedRecipient: 'trent', noteIds: [] }));
        return true;
      },
    });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1'] });

    await drainJob(deps, job);

    expect(store.get(jobIdFor(NB))?.pendingNoteIds).toEqual(['n1']);
  });

  it('a step never writes back someone taken out meanwhile (a re-add in another tab)', async () => {
    const { deps, store } = harness({
      rotate: async id => {
        // Another tab shares the notebook with mallory again while n1 rotates.
        const now = store.get(jobIdFor(NB))!;
        if (id === 'n1') store.set(now.id, { ...now, removedRecipients: ['trent'] });
        return id === 'n1';
      },
    });
    await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'trent', noteIds: [] });

    await drainJob(deps, job);

    expect(store.get(jobIdFor(NB))?.removedRecipients).toEqual(['trent']);
    expect(store.get(jobIdFor(NB))?.pendingNoteIds).toEqual(['n2']);
  });

  it('a step writes nothing back once the job is gone (a re-add in another tab)', async () => {
    const { deps, store } = harness({
      rotate: async id => { if (id === 'n1') store.delete(jobIdFor(NB)); return true; },
    });
    const job = await beginRemoval(deps, { notebookId: NB, removedRecipient: 'mallory', noteIds: ['n1', 'n2'] });

    expect(await drainJob(deps, job)).toBeNull();
    expect(store.size).toBe(0);
  });
});
