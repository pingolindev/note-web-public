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
 * When the user types the closing fence themselves, swallow the one the
 * editor already inserted for them.
 *
 * Enter after ``` auto-closes the block: the editor inserts a blank line and
 * a closing ``` below it. People who know markdown then type their own
 * closing fence anyway, and the document would keep both — an empty code
 * block trailing every fenced one.
 *
 * The rule: a typed backtick that turns the caret's line into exactly ```
 * while the NEXT line is exactly ``` — the auto-inserted closer, still
 * pristine — removes that next line in the same transaction, so undo takes
 * the whole step back. Pure function over `@codemirror/state`, no DOM.
 */
import { Transaction, TransactionSpec } from '@codemirror/state';

export function closingFenceDedupSpec(tr: Transaction): TransactionSpec | null {
  if (!tr.docChanged || !tr.isUserEvent('input.type')) return null;
  let single: { fromA: number; toA: number; toB: number; inserted: string } | null = null;
  let count = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, toB, inserted) => {
    count++;
    single = { fromA, toA, toB, inserted: inserted.toString() };
  });
  if (count !== 1 || !single) return null;
  const c = single as { fromA: number; toA: number; toB: number; inserted: string };
  if (c.fromA !== c.toA || c.inserted !== '`') return null;
  const doc = tr.newDoc;
  const line = doc.lineAt(c.toB);
  if (line.text !== '```') return null;
  if (line.number >= doc.lines) return null;
  const next = doc.line(line.number + 1);
  if (next.text !== '```') return null;
  // Only inside a block this line closes: some earlier line opened a fence
  // that is still open at this point.
  let open = false;
  for (let n = 1; n < line.number; n++) {
    if (/^```/.test(doc.line(n).text)) open = !open;
  }
  if (!open) return null;
  return [
    tr,
    {
      changes: { from: line.to, to: next.to, insert: '' },
      sequential: true,
      userEvent: 'input.type',
    },
  ] as unknown as TransactionSpec;
}
