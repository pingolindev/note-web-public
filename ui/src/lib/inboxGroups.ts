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
 * "Shared with me", grouped by who shared.
 *
 * The list is the notes the rest of the page is speaking of: `shown` is the
 * grid's own answer for this view, and a note that is not in it is not
 * listed. A list of every shared note there is, whatever the filter row and
 * the search box say, would light chips whose counts are worked out over
 * these very notes, print "Nothing shared with you yet" under a grey chip
 * above a full list, and change nothing that is listed.
 *
 * Pure, so that rule has a test.
 */
export interface SharerGroup<N> {
  sharer: string;
  notes: N[];
}

const UNKNOWN_SENDER = 'Unknown sender';

export function groupBySharer<N extends { id: string }>(
  shares: readonly { sharerEmail: string | null; note: N | null }[],
  shown: ReadonlySet<string>,
): SharerGroup<N>[] {
  const groups = new Map<string, SharerGroup<N>>();
  for (const s of shares) {
    if (!s.note || !shown.has(s.note.id)) continue;
    const key = s.sharerEmail ?? UNKNOWN_SENDER;
    if (!groups.has(key)) groups.set(key, { sharer: key, notes: [] });
    groups.get(key)!.notes.push(s.note);
  }
  // Stable alphabetical ordering by sharer email so the groups don't
  // flicker on re-renders.
  return Array.from(groups.values()).sort((a, b) => a.sharer.localeCompare(b.sharer));
}
