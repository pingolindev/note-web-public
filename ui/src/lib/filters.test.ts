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

import { describe, it, expect, vi } from 'vitest';

// lib/filters reads the reminders store for the "Has reminder" chip; nothing
// here needs it, and loading the real one needs a browser.
vi.mock('../stores/reminders', () => ({
  remindersStore: { byNoteId: () => new Map([['n-reminder', {}]]) },
}));

import { applyFilters, emptyFilters, filtersActive, labelChips } from './filters';
import type { NoteItem } from '../stores/notes';

const note = (id: string, over: Partial<NoteItem> = {}): NoteItem => ({
  id, title: id, body: '', noteType: 'text', color: null, isPinned: false, isArchived: false, labels: [],
  sortOrder: 0, editMode: 'rich', notebookId: null, hasAttachments: false, version: 1,
  createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z', deleted: false, ...over,
});

const MINE = note('mine', { openedVia: 'vault' });
const MINE_SHARED_OUT = note('mine-shared-out', { openedVia: 'vault', isShared: true, sharedWithCount: 2 });
const THEIRS = note('theirs', { openedVia: 'share', foreignOwner: true, ownerNotebookId: 'their-nb' });
const UNKNOWN = note('unknown');
const ALL = [MINE, MINE_SHARED_OUT, THEIRS, UNKNOWN];

describe('"Only mine"', () => {
  it('is off in the row\'s resting state', () => {
    expect(emptyFilters.onlyMine).toBe(false);
    expect(filtersActive(emptyFilters)).toBe(false);
    expect(applyFilters(ALL, emptyFilters)).toEqual(ALL);
  });

  it('counts as an active filter, so All is no longer the lit chip', () => {
    expect(filtersActive({ ...emptyFilters, onlyMine: true })).toBe(true);
  });

  it('leaves out the notes somebody else shared with us', () => {
    const ids = applyFilters(ALL, { ...emptyFilters, onlyMine: true }).map(n => n.id);
    expect(ids).not.toContain('theirs');
  });

  /** A note we share with others is still ours. */
  it('keeps our own notes, the ones we share with others included', () => {
    const ids = applyFilters(ALL, { ...emptyFilters, onlyMine: true }).map(n => n.id);
    expect(ids).toEqual(['mine', 'mine-shared-out', 'unknown']);
  });

  it('never hides a note whose origin is not known', () => {
    expect(applyFilters([UNKNOWN], { ...emptyFilters, onlyMine: true })).toEqual([UNKNOWN]);
  });

  it('combines with the other chips', () => {
    const lists = [note('my-list', { openedVia: 'vault', noteType: 'checklist' }), note('their-list', { openedVia: 'share', noteType: 'checklist' }), MINE];
    expect(applyFilters(lists, { ...emptyFilters, onlyMine: true, type: 'checklist' }).map(n => n.id)).toEqual(['my-list']);
  });
});

describe('several labels', () => {
  const N = [
    note('ab', { labels: ['a', 'b'] }),
    note('a', { labels: ['a'] }),
    note('b', { labels: ['b'] }),
    note('abc', { labels: ['c', 'b', 'a'] }),
    note('none'),
  ];

  it('no label lit narrows nothing', () => {
    expect(applyFilters(N, emptyFilters)).toEqual(N);
    expect(emptyFilters.labels).toEqual([]);
  });

  it('one label keeps the notes that carry it', () => {
    expect(applyFilters(N, { ...emptyFilters, labels: ['a'] }).map(n => n.id)).toEqual(['ab', 'a', 'abc']);
  });

  /** ALL of them, not any of them: every chip in this row narrows. */
  it('two labels keep only the notes that carry both', () => {
    expect(applyFilters(N, { ...emptyFilters, labels: ['a', 'b'] }).map(n => n.id)).toEqual(['ab', 'abc']);
    expect(applyFilters(N, { ...emptyFilters, labels: ['b', 'a'] }).map(n => n.id)).toEqual(['ab', 'abc']);
  });

  it('labels no note carries together leave nothing', () => {
    expect(applyFilters(N, { ...emptyFilters, labels: ['a', 'zzz'] })).toEqual([]);
  });

  it('a lit label counts as an active filter', () => {
    expect(filtersActive({ ...emptyFilters, labels: ['a'] })).toBe(true);
  });

  it('combines with the other chips', () => {
    const lists = [note('list-ab', { labels: ['a', 'b'], noteType: 'checklist' }), note('text-ab', { labels: ['a', 'b'] })];
    expect(applyFilters(lists, { ...emptyFilters, labels: ['a', 'b'], type: 'checklist' }).map(n => n.id)).toEqual(['list-ab']);
  });
});

/**
 * The label chips of a place.
 */
describe('the label chips of a place', () => {
  const PLACE = [
    note('list-work', { labels: ['work'], noteType: 'checklist' }),
    note('text-work', { labels: ['work'] }),
    note('text-work-home', { labels: ['work', 'home'] }),
    note('text-home', { labels: ['home'] }),
    note('list-shop', { labels: ['shop'], noteType: 'checklist' }),
  ];
  const ALL = ['home', 'shop', 'work', 'archived-only'];
  const chips = (f: Partial<typeof emptyFilters>) =>
    labelChips(PLACE, { ...emptyFilters, ...f }, ALL).map(c => `${c.label}:${c.count}${c.selected ? '*' : ''}`);

  it('with no chip on, each label says how many notes of the place carry it', () => {
    expect(chips({})).toEqual(['work:3', 'home:2', 'shop:1', 'archived-only:0']);
  });

  /** Another chip narrows the numbers exactly as it narrows the grid. */
  it('another chip narrows the numbers as it narrows the grid', () => {
    expect(chips({ type: 'checklist' })).toEqual(['shop:1', 'work:1', 'archived-only:0', 'home:0']);
    const f = { ...emptyFilters, type: 'checklist' as const, labels: ['work'] };
    expect(labelChips(PLACE, f, ALL).find(c => c.label === 'work')!.count).toBe(applyFilters(PLACE, f).length);
  });

  it('a lit label narrows the others\' numbers and its own is the size of the grid', () => {
    expect(chips({ labels: ['work'] })).toEqual(['work:3*', 'home:1', 'shop:0', 'archived-only:0']);
    expect(applyFilters(PLACE, { ...emptyFilters, labels: ['work'] })).toHaveLength(3);
  });

  /**
   * The order comes from before the lit labels narrowed anything: "home"
   * (2 notes at rest) stays in front of "shop" (1) when both go grey.
   * Counted over the grid's own notes instead, the two would fall back to
   * their names' order.
   */
  it('keeps the order the labels had at rest, among the grey ones too', () => {
    expect(chips({ labels: ['shop'] })).toEqual(['shop:1*', 'work:0', 'home:0', 'archived-only:0']);
    expect(chips({ labels: ['shop', 'work'] })).toEqual(['work:0*', 'shop:0*', 'home:0', 'archived-only:0']);
  });

  it('every chip\'s number is what lighting it would leave, for every chip and filter here', () => {
    for (const type of ['any', 'checklist', 'text'] as const) {
      for (const lit of [[], ['work'], ['home'], ['work', 'home'], ['shop']]) {
        const f = { ...emptyFilters, type, labels: lit };
        for (const c of labelChips(PLACE, f, ALL)) {
          const withIt = c.selected ? f : { ...f, labels: [...lit, c.label] };
          expect(c.count).toBe(applyFilters(PLACE, withIt).length);
        }
      }
    }
  });
});

