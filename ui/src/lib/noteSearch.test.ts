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
import { matchesSearch } from './noteSearch';

/**
 * One rule for the notes store's search and for a search typed in "Shared
 * with me" (that view matches its OWN copies of the notes).
 */
const note = { title: 'Shopping List', body: 'milk, Eggs', labels: ['Home', 'weekly'] };

describe('what a search matches', () => {
  it('the title, the body or a label, whatever the case', () => {
    expect(matchesSearch(note, 'shopping')).toBe(true);
    expect(matchesSearch(note, 'EGGS')).toBe(true);
    expect(matchesSearch(note, 'home')).toBe(true);
    expect(matchesSearch(note, 'week')).toBe(true);
  });

  it('nothing else', () => {
    expect(matchesSearch(note, 'bread')).toBe(false);
    expect(matchesSearch({ title: '', body: '', labels: [] }, 'x')).toBe(false);
  });

  /** As typed, spaces included: the same text the store's search is given. */
  it('takes the text as it was typed', () => {
    expect(matchesSearch(note, 'shopping list')).toBe(true);
    expect(matchesSearch(note, 'shopping  list')).toBe(false);
    expect(matchesSearch(note, 'list ')).toBe(false);
  });
});
