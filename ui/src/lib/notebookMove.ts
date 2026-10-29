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
 * A move is carried through, whenever it is sent.
 *
 * Moving a note out of a shared notebook takes it from that notebook's people
 * and gives the note a new key; moving it into one gives it to that notebook's
 * people. Deciding both by comparing the notebook in the change with the
 * notebook on the CARD at the moment the change is sent is right for a move
 * that is sent at once, and for no other:
 *
 *   - a move made while the server could not be reached is put on the card
 *     ("shown as it will be") and replayed from the queue later. By then the
 *     card and the change name the same notebook: no move would be seen,
 *     nobody would be taken off the note, and the people it was moved away
 *     from would keep the note's key and read every later edit. A note moved
 *     INTO a shared notebook would reach nobody;
 *   - a move folded into a note's create that had landed or was on its way:
 *     the same, and the create would have passed the note on to the notebook
 *     it was SENT in.
 *
 * So a card remembers where the SERVER has the note for as long as a move made
 * here has not been carried through: `movedFrom`. It is set by whatever puts a
 * move on the card before the move has been sent and its sharing done; a save
 * reads the move from it, and takes it off the card only when the sharing is
 * done. It is kept with the card, so it is still there after a reload.
 *
 * The rules are here, apart from the store, so that each has a test.
 */

/** What these rules read of a card. */
export interface Movable {
  notebookId?: string | null;
  /**
   * The notebook the SERVER has this note in (`null`: none), while a move made
   * here has not been carried through. Absent: nothing is owed, and the server
   * has the note where the card says.
   */
  movedFrom?: string | null;
  /**
   * Who had the note through `movedFrom`, by address, as the first try at the
   * move found them: the people it still owes taking off. Kept with the move,
   * and dropped with it. A later try takes them off even when that notebook's
   * own list is gone by then, the notebook deleted.
   */
  movedFromPeople?: string[];
}

/** One notebook or the other (`null`: no notebook). Ids are compared whatever their case. */
export function sameNotebook(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return x.toLowerCase() === y.toLowerCase();
}

/** Where the server has the note, as far as this device knows. */
export function serverNotebook(card: Movable): string | null {
  return card.movedFrom !== undefined ? card.movedFrom : (card.notebookId ?? null);
}

/**
 * The card with `change` on it. When the change moves the note away from where
 * the server has it, the card remembers that place; when it moves the note
 * BACK there, nothing is owed any more. A `movedFrom` inside the change itself
 * is never taken: the queue keeps whole cards, and theirs may be out of date.
 */
export function withChange<N extends Movable>(card: N, change: Partial<N>): N {
  const from = serverNotebook(card);
  const next: N = { ...card, ...change };
  // The record of the move is the card's, never the change's (see above).
  if (card.movedFromPeople !== undefined) next.movedFromPeople = card.movedFromPeople;
  else delete next.movedFromPeople;
  if (sameNotebook(next.notebookId, from)) {
    delete next.movedFrom;
    delete next.movedFromPeople;
  } else next.movedFrom = from;
  return next;
}

/** The card once its move has been carried through. */
export function settled<N extends Movable>(card: N): N {
  if (card.movedFrom === undefined && card.movedFromPeople === undefined) return card;
  const next: N = { ...card };
  delete next.movedFrom;
  delete next.movedFromPeople;
  return next;
}

/** Someone a notebook is shared with, as far as a move reads them. */
export interface Addressed {
  email: string;
}

/**
 * Who loses the note and who is given it by a move from one notebook's people
 * (`before`) to another's (`after`).
 *
 * Whoever is in both keeps what they have. That assumes they HAVE it: true of
 * a note that sat in the first notebook and was passed on there. It is not
 * known of a move that was owed from before (`passedOn: false`): the note's
 * create may never have got as far as passing it on, or was told not to
 * because the note was already leaving. Then everyone in the new notebook is
 * given it. A share made twice is the same share.
 */
export function moveOfPeople<R extends Addressed>(
  before: readonly R[],
  after: readonly R[],
  passedOn: boolean,
): { remove: R[]; add: R[] } {
  const stay = new Set(after.map(r => r.email.toLowerCase()));
  const had = new Set(before.map(r => r.email.toLowerCase()));
  return {
    remove: before.filter(r => !stay.has(r.email.toLowerCase())),
    add: passedOn ? after.filter(r => !had.has(r.email.toLowerCase())) : [...after],
  };
}
