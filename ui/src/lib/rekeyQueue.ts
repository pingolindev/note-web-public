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
 * Resumable re-keying after someone is removed from a shared notebook.
 *
 * ## Why this cannot be best-effort
 *
 * Removing a member is two operations with very different shapes:
 *
 *  1. **Revoking their shares** is one server call, atomic, and instant. After
 *     it, they cannot fetch anything. This is the part that stops access.
 *  2. **Re-keying** is a client-side loop over every note in the notebook —
 *     rotate its content key, re-seal to the remaining members. Only a client
 *     can do it, because only a client holds keys. It is slow and it can fail
 *     halfway.
 *
 * If step 2 stops partway — tab closed, network dropped, rate limit — some
 * notes still hold the key the removed member had. They cannot fetch those
 * notes any more, but every future edit to an un-rotated note is written under
 * a key they already hold. "Removed" would then mean "removed from most of
 * it": *leaving revoked nothing*.
 *
 * So the intent is persisted the moment it is formed, and drained until every
 * note is done. A job survives a reload, a crash and being offline.
 *
 * ## What this module is
 *
 * The job arithmetic, kept pure so resumption can be tested without a database,
 * a network or a clock. Persistence lives in rekeyStore; the draining lives in
 * rekeyDrain.
 */

export interface RekeyJob {
  /** One job per notebook — see [mergeRemoval] for why not one per member. */
  id: string;
  notebookId: string;
  /**
   * Everyone this job is rotating AWAY from, by EMAIL.
   *
   * Email rather than user id because that is what identifies a share: a
   * share is unique per (item, recipient email), and the recipient's user id
   * is null for an invitee who has not registered. A resumed drain has to
   * find their remaining share rows to revoke them, and email is the only
   * key that always works.
   */
  removedRecipients: string[];
  /**
   * Notes still to rotate (or, where a note can't be re-keyed, still holding
   * the removed people's rows). Captured from memory when the job is formed and
   * completed from the notebook's full note list ([noteListPending]), again for
   * each removal folded in; otherwise it only shrinks, and only on success: a
   * note that fails stays here so the next drain retries it.
   */
  pendingNoteIds: string[];
  /**
   * The notebook's full note list still to be folded in: the trash and the
   * notes that don't open here included, which the memory a removal starts
   * from may not hold. Absent on a job an older build wrote, which reads as
   * pending: the step only adds notes, so that costs one listing.
   */
  noteListPending?: boolean;
  /**
   * The notebook's own part still to land: the removed people out of the
   * roster, and their share on the notebook object revoked. The removal does it
   * at once, but a revoke that fails is only logged, so the job carries it until
   * a drain confirms it (rekeyDrain). Absent on a job an older build wrote,
   * which reads as pending: the step is idempotent, so that costs one retry.
   */
  objectPending?: boolean;
  startedAt: number;
}

/** A job is only finished when every note of the notebook's full list has
 *  actually been done and the notebook's own part (roster and object) has landed. */
export function isComplete(job: RekeyJob): boolean {
  return job.pendingNoteIds.length === 0 && job.objectPending === false && job.noteListPending === false;
}

/** Fold in the notebook's full note list (see [RekeyJob.noteListPending]). */
export function withNoteList(job: RekeyJob, noteIds: readonly string[]): RekeyJob {
  return { ...job, pendingNoteIds: [...new Set([...job.pendingNoteIds, ...noteIds])], noteListPending: false };
}

/** Record that the roster and the notebook object no longer hold the job's people. */
export function markObjectRevoked(job: RekeyJob): RekeyJob {
  return { ...job, objectPending: false };
}

/** The job id for a notebook. One per notebook, never per member. */
export function jobIdFor(notebookId: string): string {
  return `rekey:${notebookId}`;
}

export function createJob(opts: {
  notebookId: string;
  removedRecipient: string;
  noteIds: readonly string[];
  nowMs: number;
}): RekeyJob {
  return {
    id: jobIdFor(opts.notebookId),
    notebookId: opts.notebookId,
    removedRecipients: [opts.removedRecipient.toLowerCase()],
    pendingNoteIds: [...new Set(opts.noteIds)],
    objectPending: true,
    noteListPending: true,
    startedAt: opts.nowMs,
  };
}

/**
 * Fold a new removal into an outstanding job for the same notebook.
 *
 * One job per notebook rather than one per member, because two overlapping jobs
 * would rotate the same notes twice — and worse, could interleave so that the
 * second job's captured note set was taken mid-rotation and re-sealed a note to
 * a member the first job was busy removing.
 *
 * The pending set is UNIONED, not replaced: notes the outstanding job has
 * already rotated do not need rotating again for the earlier removal, but they
 * DO for this one, since the newly removed member held their current key.
 */
export function mergeRemoval(
  existing: RekeyJob,
  opts: { removedRecipient: string; noteIds: readonly string[] },
): RekeyJob {
  return {
    ...existing,
    removedRecipients: [
      ...new Set([...existing.removedRecipients, opts.removedRecipient.toLowerCase()]),
    ],
    pendingNoteIds: [...new Set([...existing.pendingNoteIds, ...opts.noteIds])],
    // A new person to take out of the roster and off the object, and off every
    // note of the notebook: notes the job already finished are listed again.
    objectPending: true,
    noteListPending: true,
  };
}

/**
 * Two jobs for one notebook as one: a record sealed before a password reset and
 * the current one, or an older build's and the sealed store's. The same
 * whichever comes first: everyone either removes, every note either has left,
 * the notebook's own part and its note list pending if either's is, and the
 * earlier start.
 */
export function mergeJobs(a: RekeyJob, b: RekeyJob): RekeyJob {
  return {
    ...a,
    removedRecipients: [...new Set([...a.removedRecipients, ...b.removedRecipients].map(r => r.toLowerCase()))],
    pendingNoteIds: [...new Set([...a.pendingNoteIds, ...b.pendingNoteIds])],
    objectPending: a.objectPending !== false || b.objectPending !== false,
    noteListPending: a.noteListPending !== false || b.noteListPending !== false,
    startedAt: Math.min(a.startedAt, b.startedAt),
  };
}

/**
 * The job without `email`, whom the owner is sharing the notebook with again:
 * null when nobody is left to remove, and the job itself when they were not
 * in it. The notes stay pending for whoever is left.
 */
export function withoutRecipient(job: RekeyJob, email: string): RekeyJob | null {
  const lc = email.toLowerCase();
  const left = job.removedRecipients.filter(r => r.toLowerCase() !== lc);
  if (left.length === job.removedRecipients.length) return job;
  return left.length > 0 ? { ...job, removedRecipients: left } : null;
}

/**
 * Record that one note is done: rotated, or the server lists no row on it for
 * the job's people.
 *
 * Only ever call this on that answer. Dropping a note for any other reason — a
 * failure, or its absence from memory — is how a job "completes" while leaving
 * the removed member's key and rows live on it.
 */
export function markRotated(job: RekeyJob, noteId: string): RekeyJob {
  return { ...job, pendingNoteIds: job.pendingNoteIds.filter(id => id !== noteId) };
}
