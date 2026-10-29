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
 * The accessible name of a note card's open button (NoteCard.tsx).
 *
 * A `role="button"` card names itself from its whole subtree — title,
 * preview, labels, badges, all of it — and a card with no text in it has no
 * name at all (axe `aria-command-name`). A name should say which note the
 * button opens, and say it briefly: the title, else the first line the card
 * shows, else that the note is untitled.
 */

/** The fields a card's name is made from. Structurally a `NoteItem`. */
export interface CardLabelSource {
  title: string;
  body: string;
  noteType: string;
  checklistItems?: { text: string; checked: boolean }[];
}

/** A name is read out whole, on every card, in a grid of dozens. */
export const MAX_LABEL_CHARS = 80;

/**
 * One line of note markdown as a reader would see it: without the heading,
 * quote, list and task markers that open it, a link or image reduced to its
 * text, and no emphasis or code marks. Single `*`/`_` only go when they wrap a
 * word, so `snake_case` and `5 * 3` survive.
 */
export function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first line a card shows for an untitled note, as plain text. */
function firstShownLine(note: CardLabelSource): string {
  if (note.noteType === 'checklist' && note.checklistItems) {
    // The card lists the unchecked items, so the first of those is what it
    // shows first; a fully ticked list shows only its "n completed" line.
    const items = note.checklistItems;
    const shown = items.find((i) => !i.checked && i.text.trim()) ?? items.find((i) => i.text.trim());
    return shown ? plainLine(shown.text) : '';
  }
  for (const line of (note.body ?? '').split('\n')) {
    const text = plainLine(line);
    if (text) return text;
  }
  return '';
}

export function openNoteLabel(note: CardLabelSource): string {
  const text = note.title?.trim() || firstShownLine(note);
  if (!text) return 'Open untitled note';
  const cut = text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS).trimEnd()}…` : text;
  return `Open note: ${cut}`;
}
