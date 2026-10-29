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
 * Driving a [RekeyJob] to completion.
 *
 * [rekeyQueue] holds the job arithmetic — what is left, what merges, what
 * counts as done. This module is the part that actually runs: it persists the
 * intent BEFORE anything is mutated, rotates one note at a time, and records
 * each success as it lands so an interruption resumes on exactly what is left.
 *
 * Every dependency is injected. That is not ceremony: the alternative is a
 * module that can only be exercised against IndexedDB, a network and the real
 * crypto, which in practice means the resumption behaviour — the entire reason
 * it exists — never gets tested at all.
 */

import {
  createJob, isComplete, markObjectRevoked, markRotated, mergeRemoval, withNoteList, withoutRecipient,
  type RekeyJob,
} from './rekeyQueue';

export interface RekeyDeps {
  listJobs(): Promise<RekeyJob[]>;
  /** A notebook's job as stored now, read again, or null when there is none. */
  getJob(notebookId: string): Promise<RekeyJob | null>;
  saveJob(job: RekeyJob): Promise<void>;
  deleteJob(id: string): Promise<void>;
  /**
   * Rotate one note's content key, revoking the job's recipients and
   * re-sealing to whoever remains. True only on the server's word that they are
   * off it: a rotation that landed, or a list of its rows with none of theirs.
   *
   * Takes the job, not just the note: a drain resumed on a later page load has
   * no memory of who was removed, and the job is where that is recorded.
   */
  rotate(noteId: string, job: RekeyJob): Promise<boolean>;
  /**
   * Every note of the notebook, the trash and the notes that don't open here
   * included, or null while that list can't be complete yet. Never "the
   * notes in memory now": an empty or partial memory is not an answer about
   * the notebook.
   */
  listNotebookNotes(notebookId: string): Promise<readonly string[] | null>;
  now(): number;
  /**
   * Take the job's removed people off the notebook's standing share list — the
   * list that seals every NEW note in it — and keep them off until the server
   * has it. True once a write without them has landed.
   */
  dropFromStandingList(job: RekeyJob): Promise<boolean>;
  /**
   * Take the job's removed people out of the notebook's roster and revoke their
   * share on the notebook object. True once both have landed, or there is
   * nothing left to do (a notebook that is gone has no rows).
   */
  revokeObject(job: RekeyJob): Promise<boolean>;
}

/**
 * One notebook's job changes one step at a time: each step of a drain, a
 * removal folded in, a re-add taking someone out. A step reads the job as
 * stored when it starts and acts on that, so once a re-add has taken someone
 * out, the step in flight has finished and no later one acts on them. Per job
 * store (the deps) and notebook, in this document.
 */
const turns = new WeakMap<RekeyDeps, Map<string, Promise<void>>>();

function inTurn<T>(deps: RekeyDeps, notebookId: string, step: () => Promise<T>): Promise<T> {
  let byNotebook = turns.get(deps);
  if (!byNotebook) turns.set(deps, (byNotebook = new Map()));
  const queue = byNotebook;
  const run = (queue.get(notebookId) ?? Promise.resolve()).then(step);
  const settled = run.then(() => {}, () => {});
  queue.set(notebookId, settled);
  void settled.then(() => { if (queue.get(notebookId) === settled) queue.delete(notebookId); });
  return run;
}

/**
 * Record a step taken for `actedOn` on the job as stored now: only while it is
 * still there (never written back once gone) and only if the step covered
 * everyone it now removes (someone folded in since still needs it).
 */
async function recordStep(deps: RekeyDeps, actedOn: RekeyJob, progress: (job: RekeyJob) => RekeyJob) {
  const now = await deps.getJob(actedOn.notebookId);
  if (!now) return;
  const covered = new Set(actedOn.removedRecipients);
  if (now.removedRecipients.every(r => covered.has(r))) await deps.saveJob(progress(now));
}

/**
 * Record the intent to remove someone, before any of it is carried out.
 *
 * Persisting first is the whole design. A removal that revokes access and then
 * dies mid-rotation leaves notes holding a key the removed member has; if the
 * intent was never written down, nothing will ever finish the job and
 * "removed" quietly means "removed from most of it".
 *
 * Merges into an outstanding job for the same notebook rather than starting a
 * second one — see [mergeRemoval] for why two concurrent jobs are worse than
 * one longer one.
 */
export async function beginRemoval(
  deps: RekeyDeps,
  opts: { notebookId: string; removedRecipient: string; noteIds: readonly string[] },
): Promise<RekeyJob> {
  return inTurn(deps, opts.notebookId, async () => {
    const existing = await deps.getJob(opts.notebookId);
    const job = existing
      ? mergeRemoval(existing, { removedRecipient: opts.removedRecipient, noteIds: opts.noteIds })
      : createJob({ ...opts, nowMs: deps.now() });
    await deps.saveJob(job);
    return job;
  });
}

/**
 * The owner is sharing the notebook with `email` again (a re-add, or a change
 * of their right): take them out of its job, and delete the job when nobody is
 * left. Kept in it, the next drain would take them off the list, the roster,
 * the object and the notes again. In turn: a step in flight finishes first,
 * and none after it acts on them.
 *
 * Answers whether they WERE being removed: the caller that goes on to share
 * and fails must start the removal again, or it stands half done with no job
 * left to finish it.
 */
export async function forgetRemoval(deps: RekeyDeps, notebookId: string, email: string): Promise<boolean> {
  return inTurn(deps, notebookId, async () => {
    const stored = await deps.getJob(notebookId);
    if (!stored) return false;
    const left = withoutRecipient(stored, email);
    if (left === stored) return false;
    if (left) await deps.saveJob(left);
    else await deps.deleteJob(stored.id);
    return true;
  });
}

/**
 * Rotate what is left of one notebook's job.
 *
 * Every step acts on the job as STORED when it starts, not on `job` (which
 * names the notebook): a re-add may have taken someone out of it since, or
 * deleted it, and then nothing more is done for them. A removal folded in
 * meanwhile is acted on by the steps after it.
 *
 * Saves after every note rather than at the end: the point of the job is to
 * survive being stopped, and a batch that only records progress on completion
 * would redo everything after any interruption — including re-rotating notes
 * that already succeeded, which costs a key rotation each time.
 *
 * A note that fails to rotate stays pending. Dropping it is how a job
 * "completes" while leaving the removed member's key live on it.
 *
 * Returns the job as it was left, or null when there is none any more.
 */
export async function drainJob(deps: RekeyDeps, job: RekeyJob): Promise<RekeyJob | null> {
  const id = job.notebookId;
  /** Everyone whose list write has landed in this drain. */
  const listed = new Set<string>();

  // Off the standing list before any note, on every drain, a resumed one
  // included. A removal takes them off first, but that write can be lost to a
  // closed tab, and the list seals every NEW note in the notebook: re-keying the
  // old ones protects nothing while the new ones still go to them.
  await inTurn(deps, id, async () => {
    const stored = await deps.getJob(id);
    if (!stored) return;
    let landed = false;
    try {
      landed = await deps.dropFromStandingList(stored);
    } catch {
      landed = false;
    }
    if (landed) for (const r of stored.removedRecipients) listed.add(r);
  });

  // The notebook's full note list, folded in once. The job was formed from
  // memory, which leaves out the trash after a reload and every note that
  // doesn't open here; until the list is complete the job is kept. Nothing is
  // ever dropped here: a note leaves only on the server's word (rotate).
  await inTurn(deps, id, async () => {
    const stored = await deps.getJob(id);
    if (!stored || stored.noteListPending === false) return;
    const list = await deps.listNotebookNotes(stored.notebookId).catch(() => null);
    if (list) await recordStep(deps, stored, j => withNoteList(j, list));
  });

  // Then the notebook's own part, until it lands. A revoke that fails at
  // removal time is only logged, and a member left in the roster or on the
  // object keeps being sealed to and keeps reading the notebook.
  await inTurn(deps, id, async () => {
    const stored = await deps.getJob(id);
    if (!stored || stored.objectPending === false) return;
    let revoked = false;
    try {
      revoked = await deps.revokeObject(stored);
    } catch {
      revoked = false;
    }
    if (revoked) await recordStep(deps, stored, markObjectRevoked);
  });

  for (const noteId of (await deps.getJob(id))?.pendingNoteIds ?? []) {
    const gone = await inTurn(deps, id, async () => {
      const stored = await deps.getJob(id);
      if (!stored) return true;
      if (!stored.pendingNoteIds.includes(noteId)) return false;
      let ok = false;
      try {
        ok = await deps.rotate(noteId, stored);
      } catch {
        ok = false;
      }
      if (ok) await recordStep(deps, stored, j => markRotated(j, noteId));
      return false;
    });
    if (gone) break;
  }

  // Kept, every note rotated or not, until the list write has landed for
  // everyone it removes (and the notebook's own part, which isComplete checks):
  // the job is the only record that repeats them on the next start.
  return inTurn(deps, id, async () => {
    const stored = await deps.getJob(id);
    if (!stored) return null;
    if (isComplete(stored) && stored.removedRecipients.every(r => listed.has(r))) await deps.deleteJob(stored.id);
    return stored;
  });
}

/**
 * Resume every outstanding job.
 *
 * Called on startup, which is the moment that matters: the interruption this
 * recovers from is usually the tab being closed mid-removal. Each drain first
 * takes the job's people off the standing list again (see [drainJob]). Failures are
 * swallowed per job so one stuck notebook cannot block the others — the job
 * stays on disk and the next start tries again.
 */
export async function resumeRekeyJobs(deps: RekeyDeps): Promise<{
  jobs: number;
  completed: number;
}> {
  let jobs: RekeyJob[];
  try {
    jobs = await deps.listJobs();
  } catch {
    return { jobs: 0, completed: 0 };
  }
  let completed = 0;
  for (const job of jobs) {
    try {
      const left = await drainJob(deps, job);
      if (!left || isComplete(left)) completed++;
    } catch { /* stays on disk; retried next start */ }
  }
  return { jobs: jobs.length, completed };
}
