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
 * "Only mine": the filter that leaves other people's notes out of the grid.
 *
 * WHY IT EXISTS
 * The Notes grid is every live note in the store, whoever owns it, so a note
 * somebody shared sits between the reader's own. A recipient has no private
 * way to tidy it away: pin, archive, colour and labels are part of the one
 * content every recipient shares, so archiving changes it for its owner, and a
 * view-only recipient cannot do even that. "Shared with me" shows what is
 * theirs; this shows what is ours.
 *
 * WHAT COUNTS AS "MINE"
 * The key that opened the note, never a row the server lists: a note our own
 * vault opened is ours whatever an inbox row says, so nothing a server serves
 * can put one of our own notes behind this filter. A note we share with
 * others is still ours. One whose origin is not known yet (a cache from
 * before the stamp, a wrap that does not open) is never hidden either: hiding
 * a note that turns out to be the reader's is the worse mistake.
 *
 * WHERE IT APPLIES
 * The plain Notes grid only. Inside a notebook it would open an accepted
 * shared notebook empty; "Shared with me" is other people's notes by
 * definition; a reminder is the reader's own act on a note; and a search is
 * asked across everything the reader can open. Out of its place the choice is
 * kept, not cleared, for when the reader comes back.
 *
 * Pure, and free of the stores, so all of it is testable as it stands.
 */

/** The part of a note that says how it reached this browser. */
export interface NoteOrigin {
  openedVia?: 'vault' | 'share';
}

/**
 * A note somebody else shared with us: a share's key opened it.
 *
 * The same answer as `openedWith(n) === 'share'` (stores/notes), which never
 * says 'share' without `openedVia`, and needs no unwrap to give it.
 */
export function arrivedThroughShare(note: NoteOrigin): boolean {
  return note.openedVia === 'share';
}

/** Where the grid is showing from. */
export interface GridPlace {
  view: string;
  /** The selected notebook, null when browsing everything. */
  notebook: string | null;
  /** A search's results are on screen. */
  searching: boolean;
}

/** Whether "Only mine" acts here, and so whether its chip is offered. */
export function onlyMineApplies(place: GridPlace): boolean {
  return place.view === 'active' && place.notebook === null && !place.searching;
}

/** The filters as they act in a place: "Only mine" off where it does not apply. */
export function inScope<F extends { onlyMine: boolean }>(filters: F, applies: boolean): F {
  return filters.onlyMine && !applies ? { ...filters, onlyMine: false } : filters;
}

/**
 * The filters to store after a change made in a place.
 *
 * Where "Only mine" does not apply its chip is not on screen, so nothing done
 * there is an answer about it: "All" inside a notebook clears what is in that
 * row, and the reader's choice for the plain grid stays as they left it.
 */
export function keepOutOfScope<F extends { onlyMine: boolean }>(next: F, current: F, applies: boolean): F {
  return applies || next.onlyMine === current.onlyMine ? next : { ...next, onlyMine: current.onlyMine };
}

/**
 * Remembered on this device, for this ACCOUNT (lib/account's per-account
 * stores), and swept with them at sign-out.
 *
 * Not one key for the whole browser, like the folded filter row: this one
 * decides which notes are on screen, so the next person to sign in on a
 * shared computer would inherit it, and with the filter row folded nothing
 * would show that their shared notes were being left out.
 */
export const ONLY_MINE_STORE = 'pingolin_note_only_mine';

/** @param read  the account's stored value, or null (lib/account `scopedGetItem`) */
export function storedOnlyMine(read: () => string | null): boolean {
  try {
    return read() === '1';
  } catch {
    return false;
  }
}

/** @param write  stores the account's value (lib/account `scopedSetItem`); it may throw */
export function rememberOnlyMine(write: (value: string) => void, on: boolean): void {
  // A full or forbidden storage must not stop the chip itself from working:
  // this is called in the middle of every change to the filter row.
  try {
    write(on ? '1' : '0');
  } catch { /* not remembered; the choice still holds for this page */ }
}
