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
import { parseNewNoteLink } from './newNoteLink';

describe('parseNewNoteLink', () => {
  it('opens an empty text note when there is nothing to parse', () => {
    for (const f of [null, undefined, '', '#']) {
      expect(parseNewNoteLink(f)).toEqual({ mode: 'text', title: '', body: '' });
    }
  });

  it('reads the checklist type', () => {
    expect(parseNewNoteLink('#type=checklist').mode).toBe('checklist');
  });

  /** An unrecognised type must not produce a third state. */
  it('treats any other type as text', () => {
    expect(parseNewNoteLink('#type=kanban').mode).toBe('text');
    expect(parseNewNoteLink('#type=').mode).toBe('text');
  });

  it('decodes a shared title and body', () => {
    const r = parseNewNoteLink('#title=Trip%20list&body=Milk%0Aand%20eggs');
    expect(r.title).toBe('Trip list');
    expect(r.body).toBe('Milk\nand eggs');
  });

  /**
   * Share-into-app text is arbitrary: ampersands, plus signs, emoji and
   * newlines all arrive routinely, and each is a way to lose or corrupt the
   * user's text if the encoding is wrong on either side.
   */
  it('survives characters that break naive encoding', () => {
    const body = 'a&b=c+d %20 ünïcode 😀\nsecond line';
    const f = `#body=${encodeURIComponent(body)}`;
    expect(parseNewNoteLink(f).body).toBe(body);
  });

  it('ignores a leading hash or its absence', () => {
    expect(parseNewNoteLink('title=x').title).toBe('x');
    expect(parseNewNoteLink('#title=x').title).toBe('x');
  });

  /**
   * A malformed fragment must open a composer, not a blank screen.
   *
   * URLSearchParams does NOT throw on a truncated percent escape — it
   * substitutes U+FFFD — so the user gets a best-effort title rather than
   * nothing. Asserted as "does not throw, still usable" rather than pinning the
   * exact salvaged bytes, which are the platform's business, not ours.
   */
  it('degrades to a usable note rather than throwing', () => {
    expect(parseNewNoteLink('%%%%').mode).toBe('text');
    const r = parseNewNoteLink('#title=%E0%A4%A');
    expect(r.mode).toBe('text');
    expect(typeof r.title).toBe('string');
  });
});
