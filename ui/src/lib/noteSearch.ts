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
 * Whether a note matches what was typed in the search box: its title, its
 * body or one of its labels contains it, whatever the case.
 *
 * One rule for both places that search. "Shared with me" lists the INBOX's
 * own copies of the notes, and those are not always in the notes store: a
 * shared item the store could not open at a sync is skipped there until it is
 * pulled again. Filtering the store's results by "is it in the inbox" would
 * make such a note vanish from "Shared with me" the moment anything was
 * typed, so that view matches its own notes with this.
 */
export function matchesSearch(
  note: { title: string; body: string; labels: readonly string[] },
  query: string,
): boolean {
  const q = query.toLowerCase();
  return note.title.toLowerCase().includes(q)
    || note.body.toLowerCase().includes(q)
    || note.labels.some(l => l.toLowerCase().includes(q));
}
