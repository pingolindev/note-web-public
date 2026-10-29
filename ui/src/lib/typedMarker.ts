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
 * Remembers when the last document change was a HAND-TYPED delimiter
 * character (`*`, `_`, `~`, `` ` ``), and where it ended.
 *
 * Why: in Preview and Hybrid an empty pair such as `**` is hidden, and
 * `misplacedInsertSpec`'s second case teleports the next typed character into
 * the pair's centre — the right thing when the toolbar's B just created the
 * pair (the browser has parked the DOM caret past the invisible cluster and
 * the word must still land inside). It is the WRONG thing when the user has
 * typed the two stars themselves: `**bold**` would come out as `*bold** …*`,
 * and a typed fence ``` would lose its third backtick to the pair. The two
 * situations are the same document and the same caret; the only difference is
 * HOW the pair came to exist, which is what this field records.
 * `@codemirror/state` only, so it tests without a DOM.
 */
import { StateField, Transaction } from '@codemirror/state';

const DELIMITERS = new Set(['*', '_', '~', '`']);

/** Position just past the delimiter the user typed last, or null when the
 *  last change was anything else (a toggle, a paste, prose, a deletion). */
export const typedMarkerField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    if (!tr.docChanged) return value;
    return typedDelimiterEnd(tr);
  },
});

/** If `tr` is one typed delimiter character and nothing else, the position
 *  right after it in the new document; otherwise null. */
export function typedDelimiterEnd(tr: Transaction): number | null {
  if (!tr.isUserEvent('input.type')) return null;
  let count = 0;
  let end: number | null = null;
  tr.changes.iterChanges((fromA, toA, _fromB, toB, inserted) => {
    count++;
    const s = inserted.toString();
    if (fromA === toA && s.length === 1 && DELIMITERS.has(s)) end = toB;
    else end = null;
  });
  return count === 1 ? end : null;
}
