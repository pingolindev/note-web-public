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
 * Notes after a password reset, rescued from a copy this browser kept.
 *
 * On the browser an account used before its reset, a note made there shortly
 * before can still be shown from that browser's own copy, readable, while
 * saving it fails (its key opens with nothing here any more) and it is not
 * counted with the locked notes.
 *
 * So a note is re-saved under this identity's key FROM THAT COPY, in place
 * (`notesStore.rescueFromCopies`, the rotation in shareUtils
 * `rescueNoteFromCopy`): the same note, its people given the new key. Then it
 * works everywhere again. Only when:
 *
 *   - the server's row is the account's own and no key here opens it, and this
 *     session has had an answer about the keys a recovery key brings back
 *     (else it may yet open with one, and is read as it is);
 *   - the copy is of the server's LATEST version. An older copy would be saved
 *     over what was written since, which a recovery key still opens: such a
 *     note stays locked, and is counted so. The server's version check on the
 *     rotation holds the same line against a change made meanwhile.
 *
 * The copy is the edit waiting to be sent, when there is one (the queue is
 * written before the card, so it is the newest word on the note), else the
 * card. It is saved where the note's SHARING has it (lib/notebookMove
 * `serverNotebook`): the rotation gives the new key to the people who have the
 * note now, and nothing else, so a move waiting to be made is not claimed by
 * it. Such a move is left to the normal save, queued with the rescued card
 * (its new key and generation), which takes the note from one notebook's
 * people to the other's. Any other edit that was waiting went up with the
 * rescue, and leaves the queue.
 *
 * Its attachments stay sealed under the previous key. That key goes with the
 * previous wrap, which the rescue replaces: a note with attachments has that
 * wrap kept in the list first (`rescuedNotes`), and a recovery key used later
 * brings them over to the new one (notebookRepairRun).
 *
 * The rules here are pure, and have their own tests.
 */
import type { NoteItem, RowNoKeyOpens } from '../stores/notes';
import { sameNotebook, serverNotebook } from './notebookMove';

/**
 * A card that is POSITIVELY the account's own: stamped so at sync
 * (`foreignOwner === false`), or made in this browser under its own vault
 * (`openedVia: 'vault'` and no stamp yet: ownership follows the key that opened
 * the note). A card with neither is of unknown provenance, from a cache
 * older than both: it could be somebody else's note, whose wrap is theirs and
 * never opened here.
 */
export function positivelyOwn(n: NoteItem): boolean {
  return n.foreignOwner === false || (n.foreignOwner === undefined && n.openedVia === 'vault');
}

/** What became of one note: re-saved; an older copy than the server's (locked);
 *  someone else holds it (locked, left to the owner); to be tried again at the
 *  next load; or nothing to do. */
export type RescueOutcome = 'rescued' | 'stale' | 'held' | 'later' | 'leave';

export interface RescueFacts {
  /** This browser's copy (the card), or null. */
  card: NoteItem | null;
  /** What the server holds, as this session's pull saw it. */
  row: RowNoKeyOpens;
  /** What is waiting in the queue to be sent, or null. */
  pending: { op: 'update' | 'create'; note: NoteItem } | null;
  /** The note reached this account through a share. */
  incomingShare: boolean;
  /** A key here opens the row's wrap now (a recovery key used since). */
  rowKeyOpens: boolean;
}

export type RescuePlan =
  | { do: 'leave' }
  | { do: 'locked' }
  | { do: 'held' }
  | {
    do: 'rescue';
    /** What is written: its content (lib/noteDocument). */
    copy: NoteItem;
    /** Where it is written: the notebook the note's sharing has it in. */
    notebookId: string | null;
    /** The copy is in another notebook: that move is queued for the normal save. */
    owesMove: boolean;
  };

export function rescuePlan(f: RescueFacts): RescuePlan {
  // Nothing to save from, or not POSITIVELY the account's own: the server's
  // word that a row is ours is not enough.
  if (!f.card || f.card.deleted || !positivelyOwn(f.card) || f.incomingShare) return { do: 'leave' };
  // It opens now: read as it is, nothing re-saved.
  if (f.rowKeyOpens) return { do: 'leave' };
  // The copy is of THIS key: the card's own wrap is the row's (which opens
  // nothing here). A card under another wrap, one that opens say, is not
  // rescued because the server now serves a wrap nothing opens.
  if (f.card.wrappedContentKey !== f.row.wrappedKey || f.card.wrappedContentKeyNonce !== f.row.wrappedKeyNonce) return { do: 'leave' };
  // A create still waiting, or a card that says it waits for one: their own road.
  if (f.pending?.op === 'create' || f.card.pendingSync === true) return { do: 'leave' };
  const copy = f.pending?.op === 'update' ? f.pending.note : f.card;
  if (copy.version !== f.row.version) return { do: 'locked' };
  // Shared with someone, as far as this page knows: left as it is. They read it
  // under its old key, and a new one would reach them signed by this
  // identity's new key, which they have not approved (that is the owner's to
  // decide); and who they are is the server's word.
  if (f.card.isShared === true || (f.card.sharedWithCount ?? 0) > 0) return { do: 'held' };
  const notebookId = serverNotebook(f.card);
  return { do: 'rescue', copy, notebookId, owesMove: !sameNotebook(copy.notebookId ?? null, notebookId) };
}
