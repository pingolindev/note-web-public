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

import { describe, it, expect } from 'vitest';
import { dropTrailingEmptyItems, itemsToMarkdown, markdownToItems } from './checklistItems';

const item = (text: string, checked = false) => ({ text, checked });

/**
 * The contract for empty checklist rows.
 *
 * Tapping the add row in the note modal appends `{ text: '', checked: false }`;
 * written out verbatim, the note would come back with a blank checkbox on its
 * card.
 *
 * Both directions are pinned here on purpose. Dropping trailing blanks is the
 * rule; NOT dropping a blank the user left in the middle of a list is the part
 * that has to keep being true, because quietly deleting rows out of somebody's
 * list is worse than a stray blank row.
 */
describe('dropTrailingEmptyItems', () => {
  it('drops the empty row the add button appends', () => {
    expect(dropTrailingEmptyItems([item('milk'), item('eggs'), item('')]))
      .toEqual([item('milk'), item('eggs')]);
  });

  it('drops a whole run of trailing empties', () => {
    expect(dropTrailingEmptyItems([item('milk'), item(''), item(''), item('')]))
      .toEqual([item('milk')]);
  });

  it('treats a whitespace-only row as empty', () => {
    expect(dropTrailingEmptyItems([item('milk'), item('   ')]))
      .toEqual([item('milk')]);
  });

  it('KEEPS a blank row in the middle of the list', () => {
    // The existing contract on the edit path: an empty item serialises to
    // `- [ ] ` and markdownToItems reads it straight back, so a blank
    // round-trips. A user separating two sections with one keeps it.
    const items = [item('produce'), item(''), item('dairy')];
    expect(dropTrailingEmptyItems(items)).toEqual(items);
  });

  it('keeps a ticked row that has no text', () => {
    // Empty text, but the tick is state somebody set deliberately — and it is
    // what the composer's own filter keeps too.
    const items = [item('milk'), item('', true)];
    expect(dropTrailingEmptyItems(items)).toEqual(items);
  });

  it('keeps a blank in the middle even when the list also ends in blanks', () => {
    expect(dropTrailingEmptyItems([item('a'), item(''), item('b'), item(''), item('')]))
      .toEqual([item('a'), item(''), item('b')]);
  });

  it('returns the same array when there is nothing to drop', () => {
    // Identity, so a save does not churn a fresh array through the store on
    // every keystroke.
    const items = [item('milk')];
    expect(dropTrailingEmptyItems(items)).toBe(items);
  });

  it('handles an all-empty list and an empty list', () => {
    expect(dropTrailingEmptyItems([item(''), item('')])).toEqual([]);
    expect(dropTrailingEmptyItems([])).toEqual([]);
  });
});

describe('the round trip through storage the trim has to survive', () => {
  it('a trailing empty item would otherwise come back through storage', () => {
    // Without the trim, the empty row is written as a markdown line and
    // parsed straight back as an item: it is stored data, not a glitch.
    const withBlank = [item('milk'), item('')];
    expect(itemsToMarkdown(withBlank)).toBe('- [ ] milk\n- [ ] ');
    expect(markdownToItems(itemsToMarkdown(withBlank))).toEqual(withBlank);
  });

  it('after the trim there is no blank line to parse back', () => {
    const saved = dropTrailingEmptyItems([item('milk'), item('')]);
    expect(itemsToMarkdown(saved)).toBe('- [ ] milk');
    expect(markdownToItems(itemsToMarkdown(saved))).toEqual([item('milk')]);
  });

  it('a middle blank still round-trips', () => {
    const items = [item('produce'), item(''), item('dairy')];
    const saved = dropTrailingEmptyItems(items);
    expect(markdownToItems(itemsToMarkdown(saved))).toEqual(items);
  });

  it('checked state and text survive the round trip', () => {
    const items = [item('milk', true), item('eggs')];
    expect(itemsToMarkdown(items)).toBe('- [x] milk\n- [ ] eggs');
    expect(markdownToItems(itemsToMarkdown(items))).toEqual(items);
  });
});
