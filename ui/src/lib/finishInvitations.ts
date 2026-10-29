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
 * An invitation made before its reader had an account, finished when they
 * have one.
 *
 * ## What "unfinished" is
 *
 * Sharing a notebook with an address that has no account can seal nothing:
 * there is no key to seal to. The page keeps the address on the notebook's
 * standing list WITHOUT a key, and the server keeps a keyless row for it on
 * each note, which it hands to the account that later signs up with that
 * address (at the reader's first read of the shares inbox). The notebook
 * ITSELF is not shared at all: nothing could be sealed, so there is no
 * invitation yet.
 *
 * ## Why it has to be finished
 *
 * The standing list is what a new note is sealed to, and the fan-out asks the
 * directory for the key each person holds now. So once the address has an
 * account, the next note added to the notebook would be sealed straight to
 * it: a note, readable, with no invitation. The notebook would never have
 * been shared with them, so there would be nothing to accept, to decline or
 * to hold the note back by, which is the one thing the notebook's own share
 * is for (lib/notebookFirst).
 *
 * ## The rule
 *
 * - A standing entry saved without a key is never given one by the fan-out
 *   (`isUnfinished`; stores/notes `withCurrentDirectoryKeys`). Until its
 *   invitation is finished, a new note gets a keyless row.
 * - The invitation is FINISHED by the owner's page as soon as it sees that the
 *   address has an account: the notebook first, then the notes in it, then the
 *   standing entry gets its keys. It is what "Waiting — finish sharing" in the
 *   Share panel does, without anyone having to press it: invitations to an
 *   address with no account yet are queued for it.
 * - Only when the notebook itself was shared. Anything short of that (the
 *   server has no item for it, the share was refused or did not go through)
 *   leaves the invitation waiting, with nothing sealed, to be tried again.
 *
 * ## The owner's word comes first
 *
 * Finishing is the page's work, done on its own time, and it takes a while:
 * a question to the directory, the notebook, each note. The owner can REMOVE
 * that person in the middle of it. Were the list of who is waiting read once,
 * at the start, and the person written to the standing list with their keys
 * at the end — by the same write the Share panel uses for "add them back" —
 * that write would lift the removal being carried through, and the person
 * who had just been removed would hold the notebook, key and all.
 *
 * - Before each step the list is read AGAIN: someone no longer on it as
 *   waiting is not finished (`stillWaiting`).
 * - When they are GONE from the list while a step was on its way, what that
 *   step did is taken back by running their removal again (`takeBack`). Only
 *   when they are gone: someone whose entry has its keys by now was finished
 *   by the owner in the Share panel meanwhile, and nothing is taken from them.
 * - The last write only fills in an entry that is still there and still
 *   waiting; it adds nobody and it never lifts a removal (`saveStanding`).
 *
 * Here, apart from the store, so that each of those has a test.
 */

import type { NotebookShareRecipient } from '../stores/notebooks';
import type { NotebookPermission } from './notebookItem';
import type { DirectoryKeys } from './recipientKeys';

/** Saved before its person had an account: nothing could be sealed for them. */
export function isUnfinished(entry: { publicKey?: string | null }): boolean {
  return !entry.publicKey;
}

/**
 * How long an invitation that could not be finished is left alone. A new note
 * and every sync ask; one that fails for a lasting reason (the owner's plan no
 * longer includes sharing) would otherwise be tried, and refused, at each.
 */
export const FINISH_RETRY_MS = 10 * 60_000;

export interface FinishSteps {
  /** The notebook's standing list (`notebooksStore.getNotebookShares`). */
  standing: (notebookId: string) => readonly NotebookShareRecipient[];
  /** The directory's keys for these addresses; null when it could not be asked. */
  lookup: (emails: string[]) => Promise<ReadonlyMap<string, DirectoryKeys> | null>;
  /**
   * Shares the NOTEBOOK ITSELF with them, and says whether that happened: the
   * invitation exists, and its member list is written. False for anything
   * else, whatever the reason.
   */
  shareNotebook: (notebookId: string, recipient: NotebookShareRecipient, grant: NotebookPermission) => Promise<boolean>;
  /**
   * The notebook's standing list as the SERVER holds it now, read again; null
   * when it could not be read. This device's list is not the only one: another
   * device of the owner's may have removed them, or finished their
   * invitation, since it was read.
   */
  serverStanding: (notebookId: string) => Promise<readonly NotebookShareRecipient[] | null>;
  /**
   * Seal the notebook's notes to them (each an upsert), one by one, for as long as `stillWaiting`
   * says they are waiting: removed while the notes are going out, they are not
   * sealed the rest (otherwise every remaining note would go to someone the
   * owner had just removed, taken back only after the loop). A few at most, and
   * none after one that did not go: the server takes a set number of shares a
   * minute from an owner. Answers the notes that did not go: the one that
   * failed and every one not tried (none: every note went).
   */
  shareNotes: (notebookId: string, recipient: NotebookShareRecipient, stillWaiting: () => boolean) => Promise<string[]>;
  /**
   * The notes that did not go to someone whose entry now has its keys: sent
   * again later, a few at a time (lib/unsentShares).
   */
  sendLater: (notebookId: string, email: string, noteIds: readonly string[]) => void;
  /**
   * Gives the entry its keys on the standing list
   * (`notebooksStore.finishNotebookShare`), and says whether it did: only an
   * entry that is still there and still waiting is filled in. It adds nobody,
   * and it never lifts a removal.
   */
  saveStanding: (notebookId: string, recipient: NotebookShareRecipient) => boolean;
  /**
   * When every share of `email` the owner is making in the notebook right now
   * has ended (at once when there is none). One made in the Share panel writes
   * their entry LAST, so until then they read as gone
   * (lib/ownerShareInFlight).
   */
  ownerShareSettled: (notebookId: string, email: string) => Promise<void>;
  /**
   * Waits for the standing list's writes to land. A write that meets another
   * device's change merges with it, and what the merge kept is in `standing`
   * after: a removal made there drops them.
   */
  written: () => Promise<void>;
  /**
   * They were removed while their invitation was being finished: take back
   * what the finish had done by then (the notebook, any note), as a removal
   * does. Never throws.
   */
  takeBack: (notebookId: string, email: string) => Promise<void>;
  now: () => number;
}

/** When each invitation was last tried, by notebook and address: one page's memory. */
export type Tried = Map<string, number>;

const key = (notebookId: string, email: string) => `${notebookId}\n${email.toLowerCase()}`;

/**
 * Where `email` stands on the notebook's standing list NOW: still `waiting`
 * (an entry without a key), `finished` (an entry that has its keys: the owner
 * finished the invitation in the Share panel), or `gone` (no entry: removed).
 */
export function standingOf(
  standing: readonly { email: string; publicKey?: string | null }[],
  email: string,
): 'waiting' | 'finished' | 'gone' {
  const wanted = email.toLowerCase();
  const entry = standing.find(e => e.email.toLowerCase() === wanted);
  if (!entry) return 'gone';
  return isUnfinished(entry) ? 'waiting' : 'finished';
}

/** Is `email` on the notebook's standing list NOW, as someone whose invitation is waiting? */
export function stillWaiting(standing: readonly { email: string; publicKey?: string | null }[], email: string): boolean {
  return standingOf(standing, email) === 'waiting';
}

/**
 * Finish the invitations of `notebookId` whose people have an account now.
 *
 * @returns the addresses whose invitation was finished.
 */
export async function finishWaitingIn(notebookId: string, steps: FinishSteps, tried: Tried): Promise<string[]> {
  const due = steps.standing(notebookId).filter((entry) => {
    if (!isUnfinished(entry)) return false;
    const last = tried.get(key(notebookId, entry.email));
    return last === undefined || steps.now() - last >= FINISH_RETRY_MS;
  });
  if (due.length === 0) return [];
  let directory: ReadonlyMap<string, DirectoryKeys> | null;
  try {
    directory = await steps.lookup(due.map(entry => entry.email));
  } catch {
    directory = null;
  }
  // No answer is not "no account": nothing is concluded, and it is asked again.
  if (!directory) return [];

  const finished: string[] = [];
  for (const entry of due) {
    const keys = directory.get(entry.email.toLowerCase());
    // Still no account: it goes on waiting, and is asked about again next time.
    if (!keys) continue;
    tried.set(key(notebookId, entry.email), steps.now());
    const recipient: NotebookShareRecipient = {
      ...entry,
      publicKey: keys.sharingPub,
      userId: keys.userId,
      signingPublicKey: keys.signingPub,
    };
    // What the owner chose survives as the right on the notes ('edit' or
    // 'view'): the same reading as the panel's own "finish sharing".
    const grant: NotebookPermission = entry.permission === 'edit' ? 'edit' : 'view';
    // The list as it is NOW, before anything is sealed: the directory took
    // its time, and the owner may have removed them since (or finished the
    // invitation by hand in the Share panel).
    const now = () => standingOf(steps.standing(notebookId), entry.email);
    const waiting = () => now() === 'waiting';
    /**
     * They are no longer waiting. Removed: what this finish did for them is
     * taken back. Finished by the owner meanwhile: it is the owner's, and it
     * stands (taking it back would remove someone the owner has just let in).
     * A share the owner is making right now (a re-add) reads as removed until
     * its last step writes their entry: it is waited for, and the list read
     * again — a take-back then would revoke the re-add's invitation and leave
     * its notes.
     */
    const noLongerWaiting = async (): Promise<void> => {
      await steps.ownerShareSettled(notebookId, entry.email);
      if (now() === 'gone') await steps.takeBack(notebookId, entry.email);
      tried.delete(key(notebookId, entry.email));
    };
    if (!waiting()) {
      tried.delete(key(notebookId, entry.email));
      continue;
    }
    // The server's list, read again: removed on another device, or finished
    // there, nothing is done here (this list takes the server's at the next
    // sync). Not read: tried again later.
    let onServer: readonly NotebookShareRecipient[] | null;
    try {
      onServer = await steps.serverStanding(notebookId);
    } catch {
      onServer = null;
    }
    if (onServer === null) continue;
    if (!stillWaiting(onServer, entry.email)) {
      tried.delete(key(notebookId, entry.email));
      continue;
    }
    let invited = false;
    try {
      invited = await steps.shareNotebook(notebookId, recipient, grant);
    } catch {
      invited = false;
    }
    // Removed while the notebook was on its way to them: it is taken back,
    // whether or not this share says it went through (a share that failed
    // half-way may have sealed the notebook and not written its member list).
    if (!waiting()) {
      await noLongerWaiting();
      continue;
    }
    // No invitation, so no notes: sealing them now is the fault this is here for.
    if (!invited) continue;
    let unsent: string[] | null = null;
    try {
      unsent = await steps.shareNotes(notebookId, recipient, waiting);
    } catch (e) {
      console.warn('[note] not all of the notes of an invitation could be shared; it is finished later', e);
    }
    // Removed while the notes were going out, or finished by the owner
    // meanwhile.
    if (!waiting()) {
      await noLongerWaiting();
      continue;
    }
    // The notes step stopped with an error: what went is not known, and the
    // finish is made again after the pause.
    if (unsent === null) continue;
    // A note that did not go does not hold the invitation back. Held back, a
    // finish would share every note again each time: a notebook of more notes
    // than the server takes from an owner in a minute would meet that limit at
    // every try, for good, and new notes would reach the person with no key.
    // The entry is given its keys, and what did not go is sent again later, a
    // few at a time (`sendLater`, after the entry is written: the re-send sends
    // only to people whose entry has their keys).
    // The entry could not be given its keys although it is there, waiting:
    // they are held off the notebook (a removal still being carried through).
    // What was sealed for them is taken back, unless the owner is sharing with
    // them again right now (which ends that removal) and that left them on the
    // list with their keys.
    if (!steps.saveStanding(notebookId, recipient)) {
      await steps.ownerShareSettled(notebookId, entry.email);
      if (now() !== 'finished') await steps.takeBack(notebookId, entry.email);
      tried.delete(key(notebookId, entry.email));
      continue;
    }
    // Their entry is written. Meeting another device's removal, the merge
    // drops it, and the notebook, the roster entry and the notes this finish
    // gave them would stand with nothing to take them back: taken back here,
    // as for a removal during the finish.
    await steps.written();
    const afterWrite = now();
    if (afterWrite === 'gone') {
      await noLongerWaiting();
      continue;
    }
    // The server's own change to the waiting entry won the merge: they are
    // still invited, and the finish is made again after the pause.
    if (afterWrite === 'waiting') continue;
    tried.delete(key(notebookId, entry.email));
    if (unsent.length > 0) steps.sendLater(notebookId, entry.email, unsent);
    finished.push(entry.email);
  }
  return finished;
}

/** Does any of these notebooks have an invitation that is waiting? Nothing is asked of anyone. */
export function anyWaiting(notebookIds: readonly string[], standing: FinishSteps['standing']): string[] {
  return notebookIds.filter(id => standing(id).some(isUnfinished));
}
