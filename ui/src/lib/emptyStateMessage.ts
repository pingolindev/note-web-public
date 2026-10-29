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
 * What an empty grid should say.
 *
 * "Notes you add appear here" is the new-account onboarding line. Printed
 * whenever the grid has nothing to draw — including when the account is full
 * of notes and an active filter simply matches none of them — it would send
 * somebody who has just pressed "Only lists" looking for missing notes
 * instead of at the chip they pressed.
 *
 * The rule: name the NARROWEST thing that is hiding the notes. A search query
 * beats a filter, a filter beats a notebook, and only a genuinely unfiltered,
 * unsearched, all-notes view of an account with nothing LOCKED gets the
 * onboarding sentence.
 *
 * Two refinements:
 * - A chip is blamed only where it hides something. Where the place itself is
 *   empty (`placeHasNotes: false`) no chip is named, and where the place has
 *   notes and a chip hides them all, the chip is named even in the trash, the
 *   reminders, "Shared with me" and over a search: "No notes in trash" under a
 *   trash of five notes reads as if it had been emptied.
 * - "No notes of your own yet" is the onboarding sentence in other words, so
 *   it obeys the same NEVER as that one: not for an account whose notes exist
 *   and cannot be opened here ("Only mine" is remembered, so it is on at the
 *   first sign-in after a password reset).
 *
 * Pure, so the wording is testable — the wording is the point.
 */

import type { Filters } from './filters';

export type NotesViewName = 'active' | 'archived' | 'trash' | 'reminders' | 'inbox';

export interface EmptyStateInput {
  view: NotesViewName;
  /** Trimmed search text, empty when not searching. */
  searchQuery: string;
  filters: Filters;
  /** Name of the selected notebook, null when browsing everything. */
  notebookName: string | null;
  /** How many of the account's own notes this browser cannot open (a
   *  password reset locks all of them). Absent = none. */
  lockedNotes?: number;
  /** This tab holds no E2EE keys at all — nothing can be shown until the user
   *  unlocks. Absent = keys are loaded. */
  keysLocked?: boolean;
  /** Two or more labels are lit and no note this view could show carries them
   *  all: the labels themselves emptied the grid, whatever else is on. */
  labelsNeverTogether?: boolean;
  /** Whether the place the grid shows from (the view, the notebook, a search's
   *  results) holds any note BEFORE a chip narrows it. False: the chips hide
   *  nothing, so none is blamed. Absent: not worked out, and a chip that is on
   *  is blamed as it was before anyone asked the place. */
  placeHasNotes?: boolean;
}

/**
 * True when the chips are what emptied the grid: one is on, and the place has
 * notes for it to hide. The view asks this too, so the funnel and the ways
 * back are offered exactly where the message blames a chip.
 */
export function chipsEmptiedIt(input: Pick<EmptyStateInput, 'filters' | 'placeHasNotes'>): boolean {
  return input.placeHasNotes === true && filtersNarrowing(input.filters);
}

/**
 * The line for an account whose notes exist and cannot be opened here.
 *
 * NEVER the onboarding line for such an account. Read as "you have no notes",
 * it leads a reset account's owner to conclude everything is gone and throw
 * away the recovery key that would restore it. The notice above the grid
 * carries the explanation and the way back; this line only points at it.
 */
function lockedLine(input: EmptyStateInput): string | null {
  if (input.keysLocked) return 'Your notes are locked in this browser — unlock them to see them here';
  if ((input.lockedNotes ?? 0) > 0) return 'Your older notes are locked — see the notice above to restore them';
  return null;
}

/** True when a filter chip (not a search, not a notebook) is doing the hiding. */
export function filtersNarrowing(f: Filters): boolean {
  return f.color !== null || f.labels.length > 0 || f.type !== 'any' || f.hasReminder || f.hasAttachment || f.onlyMine;
}

/** “a”, “a” and “b”, “a”, “b” and “c”: labels quoted back the way the chips read. */
export function quotedLabels(labels: readonly string[]): string {
  const q = labels.map(l => `“${l}”`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

/**
 * A human name for whichever filter is on, so the message can quote it back.
 * Order matches the chip row, and the first active one wins: with two chips on,
 * naming one of them is honest, and listing both reads like an error dump.
 */
export function activeFilterName(f: Filters): string | null {
  if (f.type === 'checklist') return 'Only lists';
  if (f.type === 'text') return 'Only notes';
  if (f.hasReminder) return 'Has reminder';
  if (f.hasAttachment) return 'Has attachment';
  if (f.onlyMine) return 'Only mine';
  if (f.labels.length === 1) return `label ${quotedLabels(f.labels)}`;
  if (f.labels.length > 1) return `labels ${quotedLabels(f.labels)}`;
  if (f.color !== null) return 'that colour';
  return null;
}

export function emptyStateMessage(input: EmptyStateInput): string {
  const { view, searchQuery, filters, notebookName } = input;
  /** Known: the place has notes and the chips hide every one of them. */
  const chips = chipsEmptiedIt(input);

  // Search wins: the user typed something, and that is the thing to tell them
  // about even inside a filtered view. Unless the search DID find notes and a
  // chip is what hides them.
  if (searchQuery && !chips) return 'No notes match your search';

  if (!chips) {
    if (view === 'trash') return 'No notes in trash';
    if (view === 'reminders') return 'No reminders yet. Open a note and tap the bell to set one.';
    if (view === 'inbox') {
      return "Nothing shared with you yet. When someone shares a note or notebook with you, it'll show up here.";
    }
  }

  // A chip is named unless the place is known to be empty without it.
  if (filtersNarrowing(filters) && input.placeHasNotes !== false) {
    // Several labels lit that no note carries together: that is the reason, and
    // it is the one the reader can act on (the last label they lit), so it is
    // said before any other chip is named.
    if (input.labelsNeverTogether && filters.labels.length > 1) {
      return `No note here has the labels ${quotedLabels(filters.labels)} together.`;
    }

    // "Only mine" on its own hides nothing that is missing: what it left out is
    // somebody else's, and "No notes match Only mine" would send the reader
    // looking for notes of theirs that were never there. Say where those are.
    // But never to an account whose own notes are locked: to it this sentence
    // says "you have none", which is the one thing it must not be told.
    if (filters.onlyMine && !filtersNarrowing({ ...filters, onlyMine: false })) {
      return lockedLine(input)
        ?? 'No notes of your own yet. Notes shared with you are under Shared with me.';
    }

    const name = activeFilterName(filters);
    return name
      ? `No notes match ${name}`
      : 'No notes match these filters';
  }

  if (notebookName) return `“${notebookName}” has no notes yet`;

  if (view === 'archived') return 'Nothing archived yet';

  return lockedLine(input) ?? 'Notes you add appear here';
}

/** A way out of an empty grid that a filter emptied. */
export type EmptyStateAction =
  /** Take the label lit last back out. */
  | { kind: 'remove-last'; label: string }
  /** Keep only the label lit last: what tapping it would have done as a switch. */
  | { kind: 'only-last'; label: string }
  | { kind: 'clear' };

/**
 * What to offer under the message, nearest step back first.
 *
 * "Clear filters" alone is not enough with several labels lit: the reader who
 * lit one too many wants that one back, not the whole row reset. A step is
 * offered only where it differs from clearing everything.
 */
export function emptyStateActions(f: Filters): EmptyStateAction[] {
  const last = f.labels[f.labels.length - 1];
  if (last === undefined) return [{ kind: 'clear' }];
  const others = filtersNarrowing({ ...f, labels: [] });
  if (f.labels.length > 1) return [{ kind: 'remove-last', label: last }, { kind: 'only-last', label: last }, { kind: 'clear' }];
  return others ? [{ kind: 'remove-last', label: last }, { kind: 'clear' }] : [{ kind: 'clear' }];
}

/** What the button for a step says. */
export function emptyStateActionLabel(action: EmptyStateAction): string {
  if (action.kind === 'remove-last') return `Remove ${quotedLabels([action.label])}`;
  if (action.kind === 'only-last') return `Show only ${quotedLabels([action.label])}`;
  return 'Clear filters';
}

/** The filters after a step. `cleared` is the row's resting state (lib/filters emptyFilters). */
export function applyEmptyStateAction(f: Filters, action: EmptyStateAction, cleared: Filters): Filters {
  if (action.kind === 'remove-last') return { ...f, labels: f.labels.filter(l => l !== action.label) };
  if (action.kind === 'only-last') return { ...f, labels: [action.label] };
  return { ...cleared };
}
