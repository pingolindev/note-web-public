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
 * The checklist note's save transform — the pure part, kept out of the Solid
 * component so it can be tested directly.
 *
 * ── THE TWO WRITE PATHS ─────────────────────────────────────────────────────
 *
 *   CREATE (NoteComposer.save) drops empty rows from any position:
 *       const kept = items().filter(it => it.text.trim().length > 0 || it.checked);
 *
 *   EDIT (NoteModal.saveNow) drops only TRAILING empty rows, through
 *   `dropTrailingEmptyItems`. Without it, `itemsToMarkdown` would serialise an
 *   empty item as the line `- [ ] `, which `markdownToItems` reads straight
 *   back as an empty item — so tapping the add row in the modal and closing
 *   would leave a blank checkbox drawn on the note's card.
 *
 * ── WHY ONLY TRAILING, AND ONLY ON EDIT ─────────────────────────────────────
 *
 *   * Trailing, not all: a blank row a user left BETWEEN two sections is
 *     content, and deleting rows out of the middle of somebody's list while
 *     they type is destructive in a way a stray blank row is not.
 *     `dropTrailingEmptyItems` is the whole rule.
 *
 *   * The create path keeps its own broader filter: the only blank it ever
 *     sees is the single placeholder row the composer opens with.
 *
 * A row that is TICKED but has no text survives either way. It is empty text,
 * but the tick is a state somebody set on purpose.
 *
 * ── WHAT "TRAILING" MEANS HERE ──────────────────────────────────────────────
 *
 * The END OF THE ARRAY, which is where `addRow` puts its new row:
 * `[...props.items, { text: '', checked: false }]`.
 *
 * It is worth being precise, because `toggleChecked` REORDERS — a newly
 * checked item moves to the top of the checked group, a newly unchecked one to
 * the end of the unchecked group — so a settled list is shaped
 * `[unchecked…, checked…]`. On a list that has any completed items, a blank
 * sitting above the "N Completed items" header is therefore NOT last in the
 * array, and this rule leaves it alone even though it looks trailing on
 * screen.
 *
 * That is deliberate, not an oversight. Reaching further would mean deleting a
 * row the user can see and did not just create, which is the destructive case
 * this rule exists to avoid. The row `addRow` appends is always last, so that
 * case is covered exactly; a blank row already saved in the middle stays until
 * the user removes it.
 *
 * The live signal is never trimmed — only what is written. The row the user
 * just added stays on screen and under the cursor; it simply does not reach
 * storage until it has something in it.
 */

export interface ChecklistItem {
  text: string;
  checked: boolean;
}

/** An item with nothing in it and nothing set on it. */
function isEmptyItem(item: ChecklistItem): boolean {
  return !item.text.trim() && !item.checked;
}

/**
 * Drop empty items from the END of the list, and only from the end.
 *
 * Called at the SAVE boundary, never on the editing signal.
 */
export function dropTrailingEmptyItems(items: ChecklistItem[]): ChecklistItem[] {
  let end = items.length;
  while (end > 0 && isEmptyItem(items[end - 1])) end--;
  // Identity when there is nothing to drop, so a save does not churn a new
  // array through the store on every keystroke.
  return end === items.length ? items : items.slice(0, end);
}

/** Serialize items to a markdown `body` string for search/export parity. */
export function itemsToMarkdown(items: ChecklistItem[]): string {
  return items
    .map(it => `- [${it.checked ? 'x' : ' '}] ${it.text}`)
    .join('\n');
}

/** Parse markdown lines that look like `- [ ] x` / `- [x] x` into items. */
export function markdownToItems(body: string): ChecklistItem[] {
  if (!body) return [];
  const out: ChecklistItem[] = [];
  for (const line of body.split('\n')) {
    const m = /^[-*] \[([ xX])]\s?(.*)$/.exec(line);
    if (m) out.push({ checked: m[1] !== ' ', text: m[2] });
  }
  return out;
}
