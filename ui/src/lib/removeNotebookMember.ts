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
 * Taking someone out of a notebook the owner shared, step by step, in the one
 * order in which a stop anywhere leaves fewer recipients, never more.
 *
 * Kept out of the Share panel so the order can be tested: every step here is
 * a separate write, and the last one is a loop that can stop halfway.
 */

import { notebooksStore } from '../stores/notebooks';
import { notesStore } from '../stores/notes';
import { getTabAccount } from './account';
import { beginRemoval, drainJob, forgetRemoval, type RekeyDeps } from './rekeyDrain';
import { drainAgainAfterFullPull, jobsInMemory, rekeyDeps } from './rekeyDepsLive';

export async function removeNotebookMember(notebookId: string, email: string): Promise<void> {
  const account = getTabAccount();
  // Off the owner's standing list FIRST: it seals every NEW note in the
  // notebook to its people. Taken off last, after the re-keying below, a
  // removal that stopped in that loop would leave them on it for good, and
  // every later note would go to them. The store holds the removal until the
  // server has it, and the job repeats it on every drain until then.
  void notebooksStore.removeNotebookShare(notebookId, email);

  // Then write the intent down, before any of the re-keying. Re-keying is a
  // loop over every note and it can stop halfway — tab closed, network
  // dropped, rate limit. If the job is not on disk before any of it starts,
  // nothing finishes it, and "removed" quietly means "removed from most of it".
  // Its notes start as the notebook's in memory, the trash included; the drain
  // completes them from the whole account (rekeyDrain), since memory after a
  // reload holds no trash and never a note that doesn't open here.
  const opts = {
    notebookId,
    removedRecipient: email,
    noteIds: notesStore.notes().filter(n => n?.notebookId === notebookId).map(n => n.id),
  };
  let deps: RekeyDeps = rekeyDeps;
  let job = await beginRemoval(deps, opts).catch(e => {
    console.warn('[note] could not persist the re-key job', e);
    return null;
  });
  if (!job) {
    // Nowhere to keep it, so nothing will resume it: the same steps, in this
    // document only, over a job held in memory. That reads the roster from the
    // server before taking anyone out of it (an empty memory is not "nobody to
    // take out"), and re-keys or revokes the notes too.
    deps = jobsInMemory(rekeyDeps);
    job = await beginRemoval(deps, opts);
  }

  // Then, from the stored job, the roster and the object (the instant parts:
  // so no OTHER member seals a new note to them, and they stop receiving the
  // notebook), then the slow part, progress recorded per note so an
  // interruption resumes on exactly what is left. Each note goes through the
  // atomic rotate-shares call (delete + rewrap + ciphertext rotation in one
  // transaction), so concurrent revokes from two devices cannot leave
  // straggling stale wraps.
  await drainJob(deps, job);

  // What waits for a full pull (the notebook's whole note list, a note not in
  // memory) is finished once one lands, without holding the panel.
  const kept = deps;
  void drainAgainAfterFullPull(kept, account)
    .then(async () => {
      if (kept !== rekeyDeps && (await kept.listJobs()).length > 0) {
        console.warn(`[note] removing ${email} from notebook ${notebookId} is not finished, and with no job store nothing will finish it`);
      }
    })
    .catch(e => console.warn('[note] could not finish the removal', e));
}

/**
 * Sharing a notebook with someone again (a re-add, or a change of their right)
 * ends their removal where it stands: they come out of its job, which goes
 * when nobody is left, so no drain takes them off the list, the roster, the
 * object or the notes again. Called before the share's first write: a step
 * of that job in flight finishes first, and none after it acts on them.
 *
 * Answers whether a removal of them was under way and has been ended here. A
 * share that then FAILS starts it again (lib/notebookFirst): ended and not
 * replaced by a share, it would leave them holding whatever the removal had
 * not come to, with nothing left to finish it. False too when the job could
 * not be changed: they are still in it, and it goes on by itself.
 */
export async function cancelNotebookRemoval(notebookId: string, email: string): Promise<boolean> {
  return forgetRemoval(rekeyDeps, notebookId, email)
    .catch(e => {
      console.warn('[note] could not take them out of the removal job', e);
      return false;
    });
}
