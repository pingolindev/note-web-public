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
 * A notebook is shared as ITSELF first, and its notes only when that went
 * through.
 *
 * The notebook's own share is the INVITATION: what the reader answers, and
 * what holds the notebook's notes back until they have. Notes that go out
 * without it are loose notes with nothing to answer, and "after a decline,
 * nothing shows up" has nothing to hang on. So the notes must not go out,
 * and the panel must not say "shared":
 *
 * - when the server could not be asked whether the notebook exists there, or
 * - when it could, and the notebook's own share then failed: the generation
 *   read, the share itself or the roster write.
 *
 * A stop says WHY. Turning every one into "Check your connection" would tell
 * a free account, whose share the server refuses with 402, to try again for
 * ever, with no upgrade prompt.
 *
 * Here, out of the panel, so that each of those has a test: the repository
 * has no DOM tests.
 */

import type { NotebookItemState } from '../stores/notebooks';
import type { NotebookShareOutcome, ShareFailure } from './shareUtils';
import { SIGNING_UNAVAILABLE_MESSAGE } from './crypto';
import { keyChangedMessage } from './recipientKeys';

/** The words for a request that did not get through: the ones the invitation
 *  panel and Settings already use. */
export const DID_NOT_GO_THROUGH = "That didn't go through. Check your connection and try again.";

/** The words for a step that did not go through where the connection is not
 * why: the new key could not be signed for someone who stays, even tried
 * again (lib/shareUtils `SIGN_ATTEMPTS`); the note does not open here; it
 * kept changing elsewhere, tried again each time
 * (`CHANGED_ELSEWHERE_ATTEMPTS`); or the server answered and refused it (a
 * 429, a 5xx, a 403). */
export const TRY_AGAIN_LATER = "That didn't go through. Try again later, or contact support if it keeps happening.";

/** What the Share panel says when a removal from a note did not go through:
 *  nothing was sent, and they stay listed. */
export function removalDidNotGoThrough(result: { couldNotSign?: boolean; notOpenHere?: boolean; changedElsewhere?: boolean; refused?: boolean }): string {
  return result.couldNotSign || result.notOpenHere || result.changedElsewhere || result.refused ? TRY_AGAIN_LATER : DID_NOT_GO_THROUGH;
}

/**
 * Why the notebook was not shared, and so none of its notes either: the
 * share's own reasons (`ShareFailure`). 'failed' is also a request that got no
 * answer: asking about the notebook, reading its key's generation, writing its
 * member list.
 */
export type NotebookStop = ShareFailure;

/** Go on to the notes, or stop: nothing of the notes was shared. */
export type NotebookFirst = { go: true } | { go: false; why: NotebookStop };

/**
 * What the Share panel shows for a stop: its upgrade prompt, or these words.
 * The words are the ones a single note's share uses for the same
 * reason (SharePanel `shareOneNote`).
 */
export function sayStop(why: NotebookStop, address: string): { upgrade: true } | { upgrade: false; error: string } {
  switch (why) {
    case 'upgrade': return { upgrade: true };
    case 'cannot-sign': return { upgrade: false, error: SIGNING_UNAVAILABLE_MESSAGE };
    case 'key-changed': return { upgrade: false, error: keyChangedMessage(address) };
    case 'failed': return { upgrade: false, error: DID_NOT_GO_THROUGH };
  }
}

/**
 * Why a share of the notebook as an object stops it, or null when the notes go
 * on: shared, or an address with no account (its notes go as invitations to
 * sign up, with nothing sealed).
 *
 * A notebook this page cannot open is not a reason to go on note by note —
 * every object a user encounters should be usable: it is repaired first
 * ([NotebookFirstSteps.repairNotebook]), and if it still cannot be opened the
 * share stops, as any share that did not go through does. Its notes never go
 * out with no invitation to answer.
 */
function stopFor(outcome: NotebookShareOutcome): NotebookStop | null {
  switch (outcome) {
    case 'shared':
    case 'no-account':
      return null;
    case 'cannot-open':
      return 'failed';
    case 'failed':
    case 'upgrade':
    case 'cannot-sign':
    case 'key-changed':
      return outcome;
  }
}

export interface NotebookFirstSteps {
  /** What the server has for the notebook (`notebooksStore.notebookItemState`). */
  askItem: () => Promise<NotebookItemState>;
  /**
   * Ends a removal of this person that is still being finished, and says
   * whether there was one (`cancelNotebookRemoval`): sharing with them again
   * comes first, or the removal's next step would undo the share.
   */
  endRemoval: () => Promise<boolean>;
  /** Shares the notebook as an object (`shareNotebookWithRecipientResult`). */
  shareNotebook: () => Promise<NotebookShareOutcome>;
  /** Starts that removal again (`removeNotebookMember`). Not waited for. */
  resumeRemoval: () => void;
  /**
   * Makes a notebook this page cannot open usable (lib/notebookRepairRun
   * `repairNotebookNow`): rebuilt in place, or given a key. True when it opens
   * now. False when it cannot be done now (no answer, or not yet known whether
   * a key recovered from before a reset opens it).
   */
  repairNotebook: () => Promise<boolean>;
}

export async function notebookBeforeItsNotes(steps: NotebookFirstSteps): Promise<NotebookFirst> {
  // Asked once more when there was no answer: a blip is not a failure. NO
  // ANSWER is not "no item": nothing is shared on it.
  let item = await steps.askItem();
  if (item === 'unknown') item = await steps.askItem();
  if (item === 'unknown') return { go: false, why: 'failed' };

  const wasBeingRemoved = await steps.endRemoval();

  // Only a notebook the server has an item for can be shared as an object.
  // One with none is shared note by note.
  let outcome = item === 'item' ? await steps.shareNotebook() : null;
  // One this page cannot open is repaired, then shared as itself; once.
  if (outcome === 'cannot-open' && await steps.repairNotebook()) outcome = await steps.shareNotebook();
  const why = outcome === null ? null : stopFor(outcome);
  if (why !== null) {
    // Ending their removal was this share's first step, and the share did not
    // happen. The removal goes on: ended and not replaced by a share, it would
    // stand half done, with them still holding whatever it had not come to
    // and no job left to finish it. (It also takes back whatever of the share
    // did happen: a share made whose member list could not be written.)
    if (wasBeingRemoved) steps.resumeRemoval();
    return { go: false, why };
  }
  return { go: true };
}
