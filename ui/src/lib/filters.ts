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
 * The grid's filter state, and the two pure functions over it.
 *
 * `Filters` deliberately keeps `color` even though no control sets it:
 * `applyFilters` still honours the field, so a colour control needs nothing
 * else (see the note above FilterBar in NotesView).
 */
import type { NoteItem } from '../stores/notes';
import { remindersStore } from '../stores/reminders';
import { arrivedThroughShare } from './onlyMine';
import { carriesAll, labelFacets, type LabelFacet } from './labelFacets';

export interface Filters {
  color: string | null;
  /** The labels lit, in the order they were lit. A note has to carry ALL of
   *  them — see lib/labelFacets for the row they are picked from. */
  labels: string[];
  type: 'any' | 'text' | 'checklist';
  hasReminder: boolean;
  hasAttachment: boolean;
  /** Leave out the notes somebody else shared with us. Acts in the plain Notes
   *  grid only — see lib/onlyMine for where, and for what counts as "mine". */
  onlyMine: boolean;
}

export const emptyFilters: Filters = {
  color: null,
  labels: [],
  type: 'any',
  hasReminder: false,
  hasAttachment: false,
  onlyMine: false,
};

export function filtersActive(f: Filters): boolean {
  return f.color !== null || f.labels.length > 0 || f.type !== 'any' || f.hasReminder || f.hasAttachment || f.onlyMine;
}

export function applyFilters(notes: NoteItem[], f: Filters): NoteItem[] {
  let out = notes;
  if (f.color !== null) out = out.filter(n => n.color === f.color);
  if (f.labels.length > 0) out = out.filter(n => carriesAll(n, f.labels));
  if (f.type === 'checklist') out = out.filter(n => n.noteType === 'checklist');
  else if (f.type === 'text') out = out.filter(n => n.noteType !== 'checklist');
  if (f.hasReminder) {
    const byNote = remindersStore.byNoteId();
    out = out.filter(n => byNote.has(n.id));
  }
  if (f.hasAttachment) out = out.filter(n => n.hasAttachments);
  if (f.onlyMine) out = out.filter(n => !arrivedThroughShare(n));
  return out;
}

/**
 * The label chips of a place.
 *
 * Counted over what the grid would show there with NO label lit (the place's
 * notes, narrowed by every other chip), then by the labels that are lit: so a
 * chip's number is what tapping it leaves, another chip narrows the numbers as
 * it narrows the grid, and the row's order comes from before the labels
 * narrowed anything (lib/labelFacets).
 *
 * @param place  the notes of the view, the notebook or the search, before any chip
 */
export function labelChips(place: NoteItem[], f: Filters, allLabels: readonly string[]): LabelFacet[] {
  return labelFacets(applyFilters(place, { ...f, labels: [] }), allLabels, f.labels);
}

