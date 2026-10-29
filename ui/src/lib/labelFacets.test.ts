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
import { carriesAll, greyed, labelFacets, renameSelected, toggleLabel } from './labelFacets';

/**
 * The label chips of the filter row: several can be lit, each shows how many
 * notes it would leave, the row runs from the label on most notes to the one
 * on fewest, and a label that would leave none is greyed at the end.
 *
 * The numbers are the feature. A chip that says 3 and leaves 2, or a greyed
 * chip that would have left something, is worse than no number at all.
 */
const n = (...labels: string[]) => ({ labels });
const NOTES = [n('work', 'urgent'), n('work'), n('work', 'home'), n('home'), n('recipes'), n()];
const ALL = ['archived-only', 'home', 'recipes', 'urgent', 'work'];
const row = (selected: string[], base = NOTES, all = ALL) =>
  labelFacets(base, all, selected).map(c => `${c.label}:${c.count}${c.selected ? '*' : ''}`);

describe('carrying every lit label', () => {
  it('none asked is every note', () => {
    expect(carriesAll(n('a'), [])).toBe(true);
    expect(carriesAll(n(), [])).toBe(true);
  });

  it('is all of them, not any of them', () => {
    expect(carriesAll(n('a', 'b'), ['a', 'b'])).toBe(true);
    expect(carriesAll(n('a'), ['a', 'b'])).toBe(false);
    expect(carriesAll(n(), ['a'])).toBe(false);
  });
});

describe('the row with no label lit', () => {
  it('counts the notes each label is on, most first', () => {
    expect(row([])).toEqual(['work:3', 'home:2', 'recipes:1', 'urgent:1', 'archived-only:0']);
  });

  /** A label with nothing in this view goes last, at 0: among the ordinary chips it would be a dead end. */
  it('puts a label with no notes here last, at 0', () => {
    const chips = labelFacets(NOTES, ALL, []);
    expect(chips[chips.length - 1]).toEqual({ label: 'archived-only', count: 0, selected: false });
  });

  it('breaks a tie by name, as the row was ordered before', () => {
    expect(row([], [n('b'), n('a'), n('c')], ['c', 'a', 'b'])).toEqual(['a:1', 'b:1', 'c:1']);
  });

  it('counts a label once on a note that carries it twice', () => {
    expect(row([], [n('a', 'a')], ['a'])).toEqual(['a:1']);
  });
});

describe('the row with labels lit', () => {
  /**
   * "work" lit: 3 notes on screen. "urgent" and "home" are each on one of
   * them; "recipes" is on none, so it is greyed and falls to the end.
   */
  it('says what tapping each chip would leave', () => {
    expect(row(['work'])).toEqual(['work:3*', 'home:1', 'urgent:1', 'recipes:0', 'archived-only:0']);
  });

  it('a lit chip shows the size of the grid', () => {
    const chips = labelFacets(NOTES, ALL, ['work', 'urgent']);
    expect(chips.filter(c => c.selected).map(c => c.count)).toEqual([1, 1]);
  });

  it('as more are lit, more of the others go to 0 and to the end', () => {
    expect(row(['work', 'urgent'])).toEqual(['work:1*', 'urgent:1*', 'home:0', 'recipes:0', 'archived-only:0']);
  });

  /** A greyed chip was tapped: nothing matches and every count is 0. The lit ones are not grey. */
  it('with labels no note carries together, everything is 0 and only the unlit chips are grey', () => {
    expect(row(['work', 'recipes'])).toEqual(['work:0*', 'recipes:0*', 'home:0', 'urgent:0', 'archived-only:0']);
    const chips = labelFacets(NOTES, ALL, ['work', 'recipes']);
    expect(chips.filter(greyed).map(c => c.label)).toEqual(['home', 'urgent', 'archived-only']);
  });

  it('never lists a label that is not on offer, lit or not', () => {
    expect(row(['gone'], NOTES, ['work'])).toEqual(['work:0']);
  });
});

/**
 * The order must not shuffle under the reader's finger. Ordered by the
 * number shown at first, a lit chip would jump to the front, and lighting a
 * second label would swap the first two, so "tap the first chip again to put
 * it out" would put out a different label.
 */
describe('the order holds still while labels are lit', () => {
  const labelsOf = (selected: string[], base = NOTES, all = ALL) => labelFacets(base, all, selected);

  /** The two cases that matter, from this file's own fixture. */
  it('a lit chip stays in the place it had', () => {
    expect(row([])[0]).toBe('work:3');
    expect(row(['work'])[0]).toBe('work:3*');
    expect(row(['work', 'urgent'])[0]).toBe('work:1*');
    expect(row(['urgent'])).toEqual(['work:1', 'urgent:1*', 'home:0', 'recipes:0', 'archived-only:0']);
  });

  it('a lit chip does not move in front of an unlit one that is on as many notes', () => {
    const base = [n('a', 'b'), n('a', 'b')];
    expect(row(['b'], base, ['a', 'b'])).toEqual(['a:2', 'b:2*']);
  });

  it('a lit chip is never grey, whatever its number', () => {
    for (const c of labelsOf(['work', 'recipes'])) expect(greyed(c)).toBe(!c.selected);
    expect(greyed({ label: 'x', count: 0, selected: true })).toBe(false);
    expect(greyed({ label: 'x', count: 0, selected: false })).toBe(true);
    expect(greyed({ label: 'x', count: 2, selected: false })).toBe(false);
  });

  /**
   * Every selection of every label of two fixtures: the chips that are not
   * grey stand in the order they have with nothing lit, so do the grey ones,
   * and no grey chip stands before one that is not. So the only thing that
   * moves a chip is going grey, or coming back.
   */
  it('for every selection, a chip moves only by going grey or coming back', () => {
    const fixtures: [ { labels: string[] }[], string[] ][] = [
      [NOTES, ALL],
      [[n('a', 'b', 'c'), n('a', 'b'), n('a'), n('c', 'd'), n('d'), n('e'), n('b', 'e')], ['a', 'b', 'c', 'd', 'e', 'f']],
    ];
    let checked = 0;
    for (const [base, all] of fixtures) {
      const atRest = labelFacets(base, all, []).map(c => c.label);
      for (let mask = 0; mask < 1 << all.length; mask++) {
        const selected = all.filter((_, i) => mask & (1 << i));
        const chips = labelFacets(base, all, selected);
        const firstGrey = chips.findIndex(greyed);
        const live = firstGrey === -1 ? chips : chips.slice(0, firstGrey);
        const grey = firstGrey === -1 ? [] : chips.slice(firstGrey);
        expect(live.some(greyed)).toBe(false);
        expect(grey.every(greyed)).toBe(true);
        const inRestOrder = (part: typeof chips) => part.map(c => c.label).join() === atRest.filter(l => part.some(c => c.label === l)).join();
        expect(inRestOrder(live)).toBe(true);
        expect(inRestOrder(grey)).toBe(true);
        expect(chips.map(c => c.label).sort()).toEqual([...all].sort());
        checked++;
      }
    }
    expect(checked).toBe(32 + 64);
  });

  /**
   * Why the caller must hand in the notes BEFORE the lit labels narrow them.
   * The numbers come out the same either way (the narrowing is applied here
   * again); the order does not, because it comes from the counts at rest.
   */
  it('needs the notes before the lit labels narrowed them, or the grey chips lose their order', () => {
    const narrowedAlready = NOTES.filter(note => carriesAll(note, ['work']));
    const right = row(['work']);
    const wrong = row(['work'], narrowedAlready);
    expect(right).toEqual(['work:3*', 'home:1', 'urgent:1', 'recipes:0', 'archived-only:0']);
    expect(wrong).toEqual(['work:3*', 'home:1', 'urgent:1', 'archived-only:0', 'recipes:0']);
    expect([...wrong].sort()).toEqual([...right].sort());
  });
});

describe('the base the numbers are counted over', () => {
  /** The caller hands in what the grid would show with no label lit: another chip narrows the counts too. */
  it('follows whatever notes it is given', () => {
    const listsOnly = [n('work', 'urgent')];
    expect(row([], listsOnly)).toEqual(['urgent:1', 'work:1', 'archived-only:0', 'home:0', 'recipes:0']);
  });

  it('with no notes at all every label is 0, by name', () => {
    expect(row([], [])).toEqual(['archived-only:0', 'home:0', 'recipes:0', 'urgent:0', 'work:0']);
  });
});

describe('tapping a chip', () => {
  it('lights an unlit label LAST, so the newest is the one "undo" takes back', () => {
    expect(toggleLabel(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleLabel([], 'a')).toEqual(['a']);
  });

  it('puts a lit label out and keeps the order of the rest', () => {
    expect(toggleLabel(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('hands back a new list, never the one it was given', () => {
    const before = ['a'];
    expect(toggleLabel(before, 'b')).not.toBe(before);
    expect(before).toEqual(['a']);
  });
});

describe('a label renamed while lit', () => {
  it('stays lit under its new name, in its place', () => {
    expect(renameSelected(['a', 'b', 'c'], 'b', 'x')).toEqual(['a', 'x', 'c']);
  });

  it('is not lit twice when the new name was lit already', () => {
    expect(renameSelected(['a', 'b'], 'b', 'a')).toEqual(['a']);
  });

  /**
   * The order it really happens in: the notes are rewritten first, the view
   * sees that no note carries the old name and puts it out, and only then is
   * the rename reported. The new name must still end up lit.
   */
  it('is lit under the new name even when the old one was dropped already', () => {
    expect(renameSelected(['a'], 'b', 'x')).toEqual(['a', 'x']);
    expect(renameSelected([], 'b', 'x')).toEqual(['x']);
  });

  it('is not lit twice when the old name was dropped and the new one was lit already', () => {
    expect(renameSelected(['a', 'x'], 'b', 'x')).toEqual(['a', 'x']);
  });
});
