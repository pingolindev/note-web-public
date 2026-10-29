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
import {
  createJob, isComplete, jobIdFor, markObjectRevoked, markRotated, mergeJobs, mergeRemoval,
  withNoteList, withoutRecipient,
} from './rekeyQueue';

const base = () => createJob({
  notebookId: 'nb1', removedRecipient: 'mallory',
  noteIds: ['n1', 'n2', 'n3'], nowMs: 1_000,
});

describe('a re-key job', () => {
  it('captures every note in the notebook at the moment of removal', () => {
    expect(base().pendingNoteIds).toEqual(['n1', 'n2', 'n3']);
    expect(isComplete(base())).toBe(false);
  });

  it('is one job per notebook, whoever is being removed', () => {
    expect(jobIdFor('nb1')).toBe(jobIdFor('nb1'));
    expect(jobIdFor('nb1')).not.toBe(jobIdFor('nb2'));
  });

  it('is only complete when every note has actually rotated', () => {
    let job = withNoteList(markObjectRevoked(base()), []);
    for (const id of ['n1', 'n2']) job = markRotated(job, id);
    expect(isComplete(job)).toBe(false);
    job = markRotated(job, 'n3');
    expect(isComplete(job)).toBe(true);
  });

  it("is not complete while the notebook's own part (roster and object) is pending", () => {
    let job = withNoteList(base(), []);
    for (const id of ['n1', 'n2', 'n3']) job = markRotated(job, id);
    expect(job.objectPending).toBe(true);
    expect(isComplete(job)).toBe(false);
    expect(isComplete(markObjectRevoked(job))).toBe(true);
    // A job saved before the field existed reads as pending.
    const { objectPending: _, ...old } = job;
    expect(isComplete(old)).toBe(false);
  });

  /**
   * The property the whole module exists for. A job interrupted after two of
   * three notes must resume on the third — not restart, and above all not
   * report itself done.
   */
  it('resumes on exactly what is left after an interruption', () => {
    let job = base();
    job = markRotated(job, 'n1');
    // ...crash, reload, rehydrate from IndexedDB...
    const resumed: typeof job = JSON.parse(JSON.stringify(job));
    expect(resumed.pendingNoteIds).toEqual(['n2', 'n3']);
    expect(isComplete(resumed)).toBe(false);
  });

  /**
   * A note that FAILED to rotate must stay pending. Dropping it is how a job
   * finishes while leaving the removed member's key live on that note.
   */
  it('keeps a note pending when it was not rotated', () => {
    const job = base();
    // no markRotated call for n2 — the rotation threw
    expect(markRotated(job, 'n1').pendingNoteIds).toContain('n2');
  });

  it('is idempotent if the same note is reported twice', () => {
    let job = markRotated(base(), 'n1');
    job = markRotated(job, 'n1');
    expect(job.pendingNoteIds).toEqual(['n2', 'n3']);
  });
});

describe('a second removal while a job is outstanding', () => {
  /**
   * Two jobs for one notebook could interleave: the second captures its note
   * set mid-rotation and re-seals a note to a member the first is busy
   * removing. Merging keeps it one sequence.
   */
  it('folds into the same job rather than racing a second one', () => {
    const merged = mergeRemoval(markRotated(base(), 'n1'), {
      removedRecipient: 'trent', noteIds: ['n1', 'n2', 'n3'],
    });
    expect(merged.id).toBe(base().id);
    expect(merged.removedRecipients).toEqual(['mallory', 'trent']);
  });

  /**
   * n1 was already rotated away from mallory — but trent held its CURRENT key,
   * so it has to rotate again. Union, not "already done".
   */
  it('re-queues notes the outstanding job had already finished', () => {
    const merged = mergeRemoval(markRotated(base(), 'n1'), {
      removedRecipient: 'trent', noteIds: ['n1', 'n2', 'n3'],
    });
    expect(merged.pendingNoteIds).toContain('n1');
    expect(merged.pendingNoteIds).toHaveLength(3);
  });

  it('puts the notebook step back to pending for the new person', () => {
    const merged = mergeRemoval(markObjectRevoked(base()), { removedRecipient: 'trent', noteIds: [] });
    expect(merged.objectPending).toBe(true);
  });

  it('does not duplicate a member removed twice', () => {
    const merged = mergeRemoval(base(), { removedRecipient: 'mallory', noteIds: ['n1'] });
    expect(merged.removedRecipients).toEqual(['mallory']);
  });
});

describe("the notebook's full note list", () => {
  /**
   * The job is formed from memory, which after a reload holds no trash and
   * never a note that doesn't open here. Until the whole list is folded in, the
   * job is not done, whatever its notes say.
   */
  it('is not complete until the full list is folded in, however few notes it holds', () => {
    let job = markObjectRevoked(base());
    for (const id of ['n1', 'n2', 'n3']) job = markRotated(job, id);
    expect(job.noteListPending).toBe(true);
    expect(isComplete(job)).toBe(false);
    expect(isComplete(withNoteList(job, []))).toBe(true);
    // A job saved before the field existed reads as pending.
    const { noteListPending: _, ...old } = withNoteList(job, []);
    expect(isComplete(old)).toBe(false);
  });

  it('adds the notes it lacked, keeps the ones it has, and drops none', () => {
    const job = withNoteList(markRotated(base(), 'n2'), ['n2', 'n4', 'n1']);
    expect(job.pendingNoteIds).toEqual(['n1', 'n3', 'n2', 'n4']);
    expect(job.noteListPending).toBe(false);
  });

  it('is listed again for a new removal folded in, and pending in a merge if either is', () => {
    const listed = withNoteList(base(), []);
    expect(mergeRemoval(listed, { removedRecipient: 'trent', noteIds: [] }).noteListPending).toBe(true);
    expect(mergeJobs(listed, base()).noteListPending).toBe(true);
    expect(mergeJobs(base(), listed).noteListPending).toBe(true);
    expect(mergeJobs(listed, listed).noteListPending).toBe(false);
  });
});

describe('two jobs for one notebook, merged', () => {
  const before = { ...markObjectRevoked(createJob({ notebookId: 'nb1', removedRecipient: 'X@example.test', noteIds: ['n1', 'n2'], nowMs: 1_000 })) };
  const after = createJob({ notebookId: 'nb1', removedRecipient: 'y@example.test', noteIds: ['n2', 'n3'], nowMs: 2_000 });
  const asSets = (j: ReturnType<typeof mergeJobs>) => ({
    ...j, removedRecipients: [...j.removedRecipients].sort(), pendingNoteIds: [...j.pendingNoteIds].sort(),
  });

  it('keeps everyone either removes and every note either has left, whichever comes first', () => {
    const merged = asSets(mergeJobs(before, after));
    expect(merged.removedRecipients).toEqual(['x@example.test', 'y@example.test']);
    expect(merged.pendingNoteIds).toEqual(['n1', 'n2', 'n3']);
    expect(asSets(mergeJobs(after, before))).toEqual(merged);
  });

  it("keeps the notebook's own part pending if either's is, and the earlier start", () => {
    expect(mergeJobs(before, after).objectPending).toBe(true);
    expect(mergeJobs(after, before).objectPending).toBe(true);
    expect(mergeJobs(before, markObjectRevoked(after)).objectPending).toBe(false);
    const legacy = { ...markObjectRevoked(after) };
    delete (legacy as { objectPending?: boolean }).objectPending;
    expect(mergeJobs(before, legacy).objectPending).toBe(true);
    expect(mergeJobs(before, after).startedAt).toBe(1_000);
    expect(mergeJobs(after, before).startedAt).toBe(1_000);
  });

  it('names each person once, however an older record spelled them', () => {
    const spelled = { ...after, removedRecipients: ['Y@Example.TEST'] };
    expect(mergeJobs(after, spelled).removedRecipients).toEqual(['y@example.test']);
  });
});

describe('someone shared the notebook again', () => {
  const two = mergeRemoval(base(), { removedRecipient: 'trent', noteIds: ['n4'] });

  it('comes out of the job; the notes stay pending for whoever is left', () => {
    const left = withoutRecipient(two, 'MALLORY')!;
    expect(left.removedRecipients).toEqual(['trent']);
    expect(left.pendingNoteIds).toEqual(two.pendingNoteIds);
    expect(left.objectPending).toBe(two.objectPending);
  });

  it('leaves no job when nobody is left to remove', () => {
    expect(withoutRecipient(base(), 'mallory')).toBeNull();
  });

  it('leaves the job as it is when they were not in it', () => {
    const job = base();
    expect(withoutRecipient(job, 'someone-else')).toBe(job);
  });
});
