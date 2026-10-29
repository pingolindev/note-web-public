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
 * The label chips of the filter row: which are lit, how many notes each would
 * leave, and in what order they stand.
 *
 * WHY IT EXISTS
 * A note carries many labels and sits in one notebook, so "the notes with BOTH
 * of these" is what labels are for: every other chip narrows together with a
 * label, and so does a second label. Several can be lit, and the grid keeps
 * the notes that carry all of them.
 *
 * WHAT A CHIP SAYS
 * Its number is how many notes would be on screen with that label lit as
 * well: counted over what the grid would show without any label (the view,
 * the notebook, the other chips), then narrowed by the labels already lit. So
 * a lit chip's number is the size of the grid, an unlit one's is what tapping
 * it leaves, and 0 means tapping it empties the grid — it is greyed, and it
 * may still be tapped (the empty grid then says which labels no note carries
 * together, and offers the way back).
 *
 * THE ORDER
 * By how many notes carry the label with NO label lit, most first, then by
 * name; and a label that would leave nothing goes to the end of the row, in
 * that same order. So the labels that can still narrow stand together at the
 * start of a row that scrolls.
 *
 * It is the count at rest that orders the row, not the number shown. Ordered
 * by the number shown, every tap would reshuffle it: a lit chip would jump to
 * the front, and lighting a second label would swap the first two, so a tap
 * on "the first chip" to put a label out would hit a different one. Ordered
 * by the count at rest, a chip moves for one reason only: it went grey, or
 * stopped being grey. A lit chip keeps its place in the ORDER. Its place on
 * the screen still shifts when chips before it go grey and leave: the row
 * scrolls to take that back where it can scroll (components/FilterBar
 * `follow`), and where it cannot, it shows.
 *
 * It also avoids a dead end of an alphabetical row: a label whose notes are
 * all archived would be an ordinary chip in Notes that opens nothing.
 *
 * Pure, so the row's arithmetic is testable without the stores.
 */

export interface LabelFacet {
  label: string;
  /** Notes left on screen with this label lit too. */
  count: number;
  selected: boolean;
}

/** Whether a note carries every one of `labels`. None asked is every note. */
export function carriesAll(note: { labels: readonly string[] }, labels: readonly string[]): boolean {
  return labels.every(l => note.labels.includes(l));
}

/** The order `[...set].sort()` gives: by code unit, as the sidebar's list is. */
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param base      the notes the grid would show with NO label lit. It has to be
 *                  those and not the grid's own notes: the grid is already
 *                  narrowed by the lit labels, and the order comes from the
 *                  counts before that narrowing.
 * @param all       every label there is to offer
 * @param selected  the labels lit, in the order they were lit
 */
export function labelFacets(
  base: readonly { labels: readonly string[] }[],
  all: readonly string[],
  selected: readonly string[],
): LabelFacet[] {
  /** Notes carrying the label with no label lit: what orders the row. */
  const atRest = new Map<string, number>();
  /** Notes carrying it together with every lit label: what the chip shows. */
  const left = new Map<string, number>();
  for (const note of base) {
    const narrowed = carriesAll(note, selected);
    for (const label of new Set(note.labels)) {
      atRest.set(label, (atRest.get(label) ?? 0) + 1);
      if (narrowed) left.set(label, (left.get(label) ?? 0) + 1);
    }
  }
  const chips = all.map(label => ({ label, count: left.get(label) ?? 0, selected: selected.includes(label) }));
  return chips.sort((a, b) =>
    Number(greyed(a)) - Number(greyed(b))
    || (atRest.get(b.label) ?? 0) - (atRest.get(a.label) ?? 0)
    || byName(a.label, b.label));
}

/** A chip that would leave no notes. A lit chip is never one: it is what is narrowing. */
export function greyed(chip: LabelFacet): boolean {
  return !chip.selected && chip.count === 0;
}

/** Tap a chip: lit goes out, unlit is lit LAST, so the newest is the one "undo" takes back. */
export function toggleLabel(selected: readonly string[], label: string): string[] {
  return selected.includes(label) ? selected.filter(l => l !== label) : [...selected, label];
}

/**
 * A label that was lit when its rename began stays lit under its new name, once.
 *
 * Call it only for a label that WAS lit, and after the notes are rewritten.
 * By then the old name is usually gone from `selected` already: no note
 * carries it any more, and the view drops a lit label that no note carries.
 * So its place is kept if it is still there, and the new name goes last if it
 * is not — asking "is the old name lit?" at that point loses the selection.
 */
export function renameSelected(selected: readonly string[], from: string, to: string): string[] {
  const next = selected.includes(from) ? selected.map(l => (l === from ? to : l)) : [...selected, to];
  return next.filter((l, i) => next.indexOf(l) === i);
}
