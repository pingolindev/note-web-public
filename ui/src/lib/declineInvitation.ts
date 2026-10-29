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
 * Declining a notebook invitation, step by step.
 *
 * After a decline, nothing of that share shows up. The decline is ONE
 * request: the server dismisses the notebook's share and every note in it
 * together, all of them or none, and from then on writes any note added to
 * that notebook already dismissed.
 *
 * What the shape guards against:
 *
 * - `apiRequest` answers a failure, it does not throw, so every answer is
 *   CHECKED: on a bad connection an unchecked decline would go on as if it
 *   had worked — this device would forget the notebook while the server
 *   still offered it.
 * - One request for the whole notebook rather than one dismissal per note: a
 *   connection that dropped part-way would leave some notes dismissed for
 *   good and the invitation still on offer, for a notebook that could never
 *   be whole again. With one request the panel always offers both answers.
 * - A decline covers notes added later too: one that lasted only for the
 *   rows it dismissed would let a note the owner added afterwards arrive on
 *   its own, with no invitation.
 *
 * The order, and why:
 *
 * 1. Mark it declined. From this moment its notes are off this page, whatever
 *    a sync that lands half-way through sees.
 * 2. Ask the server, once. The shares named are the ones this page knows to
 *    be the notebook's from their decrypted content; the server adds every
 *    note whose row says it is in the notebook.
 * 3. An answer that is not a yes is not yet a no: a yes can be lost on its way
 *    back. So the server is asked once more (the request does the same thing
 *    however often it is made), and if that is not a yes either, the inbox is
 *    read again and the SERVER'S LIST decides.
 *    - Read to its end, and the notebook is no longer on offer: the server
 *      did take the decline. It is finished as one that went through.
 *    - Still on offer, or the inbox could not be read to its end: the decline
 *      did not happen as far as anyone can tell. The mark is taken back, so
 *      the invitation stands exactly as it did before (a mark left behind
 *      outranks an acceptance, and one made on another device would then
 *      open an empty notebook here), and the failure is reported. Nothing is
 *      forgotten on the strength of a "no" the server did not take.
 * 4. Only then forget the acceptance, take the notes' copies off this device,
 *    read the inbox again, and sync. By then the decline is done: a failure
 *    in any of these is logged and does not fail it.
 * 5. And what that reading shows of the notebook that the page had NOT loaded
 *    when the reader pressed Decline is declined with it. The first request
 *    names the notes this page knew, and the server adds every note whose row
 *    says it is in the notebook. A note that neither covers (filed into the
 *    notebook by an older page, without the notebook on its row, in the
 *    moments before the press) would stay live, and being OLDER than the
 *    decline it would never be kept away afterwards.
 *
 * Pure of the stores and the network, which are handed in, so each step and
 * each failure has a test.
 */
export interface DeclineSteps {
  /** The reader said no here: keep this notebook's notes off this page. */
  markDeclined(notebookId: string, notebookShareIds: readonly string[]): void;
  /** Take that mark back: the server did not take the decline. */
  unmarkDeclined(notebookId: string): void;
  /**
   * Decline the notebook on the server, whole: its own shares, every note in
   * it and the shares named. False when the server did not answer yes. May
   * also throw.
   */
  decline(notebookId: string, shareIds: readonly string[]): Promise<boolean>;
  /** Forget any acceptance of the notebook, on the shared list and on this device. */
  forgetAcceptance(notebookId: string): Promise<void>;
  /**
   * Take the declined notes' copies off this device, now. A completed sync
   * would too, but only on an inbox it read to its end, and a reload before
   * that would bring them back on screen.
   */
  forgetNotes(noteIds: readonly string[]): void;
  /**
   * Read the inbox again. True ONLY when it was read to its end and applied:
   * only then does `isOffered` describe the server.
   */
  reloadInbox(): Promise<boolean>;
  /** Does the inbox, as last applied, still hold a share of this notebook? */
  isOffered(notebookId: string): boolean;
  /** The shares of this notebook's NOTES that the inbox, as last applied, holds. */
  notesNow(notebookId: string): readonly { shareId: string; noteId: string }[];
  /** Start a sync: a completed one takes the declined notes' copies out. Not awaited. */
  syncNotes(): void;
}

export class DeclineNotDone extends Error {
  constructor(readonly notebookId: string) {
    super(`the server did not take the decline of notebook ${notebookId}`);
    this.name = 'DeclineNotDone';
  }
}

/**
 * @param goneIsDone  asked only when neither request was answered yes and the
 *   inbox, read again to its end, no longer offers the notebook: is what was
 *   asked for done, then? For a decline it is (the default): that is what a
 *   decline does. A caller whose request does MORE than decline says here
 *   whether the rest happened too (`blockFromInvitation`).
 */
export async function declineNotebook(
  invite: { notebookId: string; shareIds: readonly string[] },
  notes: readonly { shareId: string; noteId: string }[],
  steps: DeclineSteps,
  goneIsDone: () => Promise<boolean> = async () => true,
): Promise<void> {
  // Each step after the answer is tried on its own, so one that fails does not
  // skip the rest, and none of them can turn a decline that went through into
  // "That didn't go through".
  const attempt = async (what: string, step: () => unknown) => {
    try {
      await step();
    } catch (e) {
      console.warn(`[note] around a decline, ${what} failed`, e);
    }
  };

  steps.markDeclined(invite.notebookId, invite.shareIds);
  const named = new Set([...notes.map(n => n.shareId), ...invite.shareIds]);
  /** One request for these shares: false when the server did not answer yes, or the request threw. */
  const askFor = async (shareIds: readonly string[]): Promise<boolean> => {
    try {
      return await steps.decline(invite.notebookId, shareIds);
    } catch {
      return false;
    }
  };
  const ask = () => askFor([...named]);
  // Asked a second time before anything else is concluded: the request does
  // the same thing however often it is made, and a yes that was lost on its
  // way back is a yes the second time.
  const done = await ask() || await ask();
  let inboxJustRead = false;
  if (!done) {
    let listRead = false;
    await attempt('reading the inbox again', async () => { listRead = (await steps.reloadInbox()) === true; });
    let gone = listRead && !steps.isOffered(invite.notebookId);
    // No longer offered: the decline went through and its answer was lost on
    // the way back, or the notebook left the list for a reason of its own.
    if (gone) {
      try {
        gone = await goneIsDone();
      } catch {
        gone = false;
      }
    }
    if (!gone) {
      steps.unmarkDeclined(invite.notebookId);
      throw new DeclineNotDone(invite.notebookId);
    }
    inboxJustRead = true;
  }
  // The server took it: the decline is DONE, whatever becomes of the rest.
  // Clear any stale acceptance so a re-invitation asks again rather than
  // arriving already accepted.
  await attempt('forgetting the acceptance', () => steps.forgetAcceptance(invite.notebookId));
  await attempt('taking the copies off this device', () => steps.forgetNotes(notes.map(n => n.noteId)));
  if (!inboxJustRead) await attempt('reading the inbox again', () => steps.reloadInbox());
  // Step 5: what the page had not loaded when the reader pressed Decline.
  await attempt('declining what had not loaded yet', async () => {
    const late = steps.notesNow(invite.notebookId).filter(n => !named.has(n.shareId));
    if (late.length === 0) return;
    const theirShares = late.map(n => n.shareId);
    // Asked twice, like the decline itself, and said when neither went through:
    // a single failed attempt would leave these notes live and older than the
    // decline, with no word of it anywhere.
    if (await askFor(theirShares) || await askFor(theirShares)) {
      steps.forgetNotes(late.map(n => n.noteId));
    } else {
      console.warn(`[note] around a decline, ${late.length} note(s) of notebook ${invite.notebookId} that had not loaded yet could not be declined with it`);
    }
  });
  await attempt('starting a sync', () => steps.syncNotes());
}

/** What blocking from an invitation needs beside a decline's steps. */
export interface BlockSteps extends DeclineSteps {
  /**
   * Block the sender AND decline the notebook, in one request the server
   * carries out whole (`sharesInboxStore.blockSender` with `declining`). False
   * when the server did not answer yes. May also throw.
   */
  block(email: string, declining: { notebookId: string; shareIds: readonly string[] }): Promise<boolean>;
  /**
   * Block the sender and nothing else (`sharesInboxStore.blockSender` with no
   * `declining`): the same block, made once more when it is not known to have
   * been made. The server takes it any number of times. False when it did not
   * answer yes. May also throw.
   */
  blockOnly(email: string): Promise<boolean>;
  /** The ids of the notes this sender has shared with the reader, as the inbox holds them NOW. */
  theirNotes(): readonly string[];
}

/**
 * "Block" pressed on an invitation: the sender is blocked AND the notebook is
 * declined.
 *
 * A block alone dismisses what its sender shared, with no decline, so the
 * notebook would not be a declined one: after an UNBLOCK, a note its owner
 * added to it would arrive live, as a loose note with no invitation left to
 * answer. And a note in the notebook that somebody ELSE had shared is not the
 * blocked sender's, so it would stay.
 *
 * So this is the decline above, step for step and with every one of its
 * failures, where the one request the server carries out whole is the block
 * that declines. One request and not two: a decline that went through beside
 * a block that did not would leave no invitation on screen to say so.
 *
 * ## When the answer is lost
 *
 * A decline whose two requests got no yes is still done when the inbox, read
 * again, no longer offers the notebook: that is all a decline does. For a
 * block it proves the decline half only. The notebook can leave the list for
 * a reason of its own (its owner took the reader out, or another device
 * declined it) while this request never arrived: the invitation would go
 * from the screen and the reader would take the sender for blocked, who is
 * not. So the block is then made once more, by itself; the server takes a
 * block any number of times. Only its yes makes this done.
 *
 * Throws `DeclineNotDone` when the block is not known to have been made:
 * nothing is forgotten here, and when the invitation still stands it stands as
 * it did.
 */
export async function blockFromInvitation(
  invite: { notebookId: string; shareIds: readonly string[] },
  notes: readonly { shareId: string; noteId: string }[],
  email: string,
  steps: BlockSteps,
): Promise<void> {
  // The sender's notes' copies on this device, listed BEFORE the block takes
  // them off the inbox: afterwards nothing here says which they were.
  const theirs = [...steps.theirNotes()];
  await declineNotebook(invite, notes, {
    ...steps,
    decline: (notebookId, shareIds) => steps.block(email, { notebookId, shareIds }),
  }, () => steps.blockOnly(email));
  // Done from here on: this only tidies the device.
  try {
    steps.forgetNotes(theirs);
  } catch (e) {
    console.warn('[note] after a block, taking their notes off this device failed', e);
  }
}
