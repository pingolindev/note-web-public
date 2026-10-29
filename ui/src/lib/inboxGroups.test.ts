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
import { groupBySharer } from './inboxGroups';

/**
 * "Shared with me" lists the notes the filter row and the search leave, and
 * no others. Listing every shared note whatever the chips say, while their
 * counts and the empty state speak of the filtered ones, a lit chip would
 * change nothing, and a grey one would print "Nothing shared with you yet"
 * under a full list.
 */
const share = (id: string | null, sharerEmail: string | null) => ({ sharerEmail, note: id === null ? null : { id } });
const SHARES = [share('n1', 'bo@example.test'), share('n2', 'al@example.test'), share('n3', 'bo@example.test'), share(null, 'al@example.test'), share('n4', null)];
const all = new Set(['n1', 'n2', 'n3', 'n4']);

describe('"Shared with me", by who shared', () => {
  it('lists every shown note under its sharer, sharers in order', () => {
    expect(groupBySharer(SHARES, all)).toEqual([
      { sharer: 'al@example.test', notes: [{ id: 'n2' }] },
      { sharer: 'bo@example.test', notes: [{ id: 'n1' }, { id: 'n3' }] },
      { sharer: 'Unknown sender', notes: [{ id: 'n4' }] },
    ]);
  });

  it('leaves out a note the filter row or the search left out', () => {
    expect(groupBySharer(SHARES, new Set(['n3']))).toEqual([{ sharer: 'bo@example.test', notes: [{ id: 'n3' }] }]);
  });

  it('has no heading for a sharer none of whose notes are shown', () => {
    expect(groupBySharer(SHARES, new Set(['n1'])).map(g => g.sharer)).toEqual(['bo@example.test']);
  });

  it('lists nothing when nothing is shown', () => {
    expect(groupBySharer(SHARES, new Set())).toEqual([]);
  });

  it('skips a share this page could not open', () => {
    expect(groupBySharer([share(null, 'al@example.test')], all)).toEqual([]);
  });

  it('hands back the very notes it was given', () => {
    const note = { id: 'n1', title: 'kept' };
    expect(groupBySharer([{ sharerEmail: 'a', note }], all)[0].notes[0]).toBe(note);
  });
});
