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
import {
  emptyStateMessage, activeFilterName, filtersNarrowing, chipsEmptiedIt,
  applyEmptyStateAction, emptyStateActionLabel, emptyStateActions, quotedLabels,
} from './emptyStateMessage';
import type { Filters } from './filters';

// Declared here rather than imported from `lib/filters`: that module pulls in
// the notes and reminders stores at load time, and this suite is a pure-string
// test that should not need either. The shape is pinned by the `Filters` type
// import above, which is erased at runtime.
const emptyFilters: Filters = {
  color: null,
  labels: [],
  type: 'any',
  hasReminder: false,
  hasAttachment: false,
  onlyMine: false,
};

const input = (over: Partial<Parameters<typeof emptyStateMessage>[0]> = {}) => ({
  view: 'active' as const,
  searchQuery: '',
  filters: { ...emptyFilters } as Filters,
  notebookName: null,
  ...over,
});

describe('emptyStateMessage', () => {
  /** The motivating case: notes exist, a chip hides them, onboarding copy shown. */
  it('names the filter instead of claiming the account is empty', () => {
    const msg = emptyStateMessage(input({
      filters: { ...emptyFilters, type: 'checklist' },
    }));
    expect(msg).toBe('No notes match Only lists');
    expect(msg).not.toMatch(/Notes you add appear here/);
  });

  it('names the attachment filter', () => {
    expect(emptyStateMessage(input({
      filters: { ...emptyFilters, hasAttachment: true },
    }))).toBe('No notes match Has attachment');
  });

  it('quotes a label filter', () => {
    expect(emptyStateMessage(input({
      filters: { ...emptyFilters, labels: ['audit'] },
    }))).toBe('No notes match label “audit”');
  });

  it('keeps the onboarding line for a genuinely empty, unfiltered account', () => {
    expect(emptyStateMessage(input())).toBe('Notes you add appear here');
  });

  it('lets a search beat a filter', () => {
    expect(emptyStateMessage(input({
      searchQuery: 'zzz',
      filters: { ...emptyFilters, hasReminder: true },
    }))).toBe('No notes match your search');
  });

  it('names an empty notebook rather than the whole account', () => {
    expect(emptyStateMessage(input({ notebookName: 'Recipes' })))
      .toBe('“Recipes” has no notes yet');
  });

  it('keeps the per-view messages', () => {
    expect(emptyStateMessage(input({ view: 'trash' }))).toBe('No notes in trash');
    expect(emptyStateMessage(input({ view: 'reminders' }))).toMatch(/^No reminders yet/);
    expect(emptyStateMessage(input({ view: 'inbox' }))).toMatch(/^Nothing shared with you yet/);
    expect(emptyStateMessage(input({ view: 'archived' }))).toBe('Nothing archived yet');
  });

  /** A filtered trash view is still trash; the view name is the honest answer. */
  it('does not claim a filter is at fault in trash', () => {
    expect(emptyStateMessage(input({
      view: 'trash',
      filters: { ...emptyFilters, type: 'text' },
    }))).toBe('No notes in trash');
  });
});

describe('filtersNarrowing', () => {
  it('is false for the empty filter set and true for each chip', () => {
    expect(filtersNarrowing({ ...emptyFilters })).toBe(false);
    expect(filtersNarrowing({ ...emptyFilters, type: 'text' })).toBe(true);
    expect(filtersNarrowing({ ...emptyFilters, hasReminder: true })).toBe(true);
    expect(filtersNarrowing({ ...emptyFilters, hasAttachment: true })).toBe(true);
    expect(filtersNarrowing({ ...emptyFilters, labels: ['x'] })).toBe(true);
    expect(filtersNarrowing({ ...emptyFilters, color: '#fff475' })).toBe(true);
  });
});

describe('activeFilterName', () => {
  it('names one filter, not a list, when several are on', () => {
    const name = activeFilterName({ ...emptyFilters, type: 'checklist', hasReminder: true });
    expect(name).toBe('Only lists');
  });
  it('is null when nothing is on', () => {
    expect(activeFilterName({ ...emptyFilters })).toBeNull();
  });
});

/**
 * An account whose notes exist but cannot be opened here is not a new account.
 * Shown the onboarding line after an email password reset, people conclude
 * their notes are gone and throw away the recovery key that restores them.
 */
describe('never the onboarding line while notes are locked', () => {
  it('points at the locked-notes notice when own notes cannot be opened', () => {
    const msg = emptyStateMessage(input({ lockedNotes: 12 }));
    expect(msg).not.toBe('Notes you add appear here');
    expect(msg).toMatch(/locked/);
  });

  it('says the tab is locked when it holds no keys at all', () => {
    const msg = emptyStateMessage(input({ keysLocked: true }));
    expect(msg).not.toBe('Notes you add appear here');
    expect(msg).toMatch(/unlock/);
  });

  it('keeps the onboarding line for a genuinely empty account', () => {
    expect(emptyStateMessage(input({ lockedNotes: 0, keysLocked: false }))).toBe('Notes you add appear here');
  });

  it('still names a search or filter first — those are what hide notes there', () => {
    expect(emptyStateMessage(input({ lockedNotes: 3, searchQuery: 'x' }))).toBe('No notes match your search');
  });
});

/**
 * "Only mine" leaves out notes that are somebody else's, not notes that are
 * missing. Its empty grid has to say where those are instead of "No notes
 * match", which reads as the reader's own notes having gone.
 */
describe('an empty grid under "Only mine"', () => {
  it('says the reader has none of their own, and where shared ones are', () => {
    const msg = emptyStateMessage(input({ filters: { ...emptyFilters, onlyMine: true } }));
    expect(msg).toBe('No notes of your own yet. Notes shared with you are under Shared with me.');
    expect(msg).not.toMatch(/Notes you add appear here|No notes match/);
  });

  it('counts as a filter doing the hiding, so "Clear filters" is offered', () => {
    expect(filtersNarrowing({ ...emptyFilters, onlyMine: true })).toBe(true);
  });

  it('is named after the chip row\'s order when another chip is on too', () => {
    expect(emptyStateMessage(input({ filters: { ...emptyFilters, onlyMine: true, type: 'checklist' } })))
      .toBe('No notes match Only lists');
    expect(activeFilterName({ ...emptyFilters, onlyMine: true })).toBe('Only mine');
    expect(activeFilterName({ ...emptyFilters, onlyMine: true, labels: ['work'] })).toBe('Only mine');
  });

  it('a search still wins', () => {
    expect(emptyStateMessage(input({ searchQuery: 'x', filters: { ...emptyFilters, onlyMine: true } })))
      .toBe('No notes match your search');
  });
});

/**
 * Several labels can be lit, and a greyed one may be tapped: the grid is then
 * empty because no note carries those labels together. The message has to say
 * exactly that, with the labels, and the reader has to be handed the step back
 * (the label they lit last) and not only "clear everything".
 */
describe('an empty grid under several labels', () => {
  const both = { ...emptyFilters, labels: ['work', 'urgent'] };

  it('quotes labels back the way the chips read', () => {
    expect(quotedLabels(['a'])).toBe('“a”');
    expect(quotedLabels(['a', 'b'])).toBe('“a” and “b”');
    expect(quotedLabels(['a', 'b', 'c'])).toBe('“a”, “b” and “c”');
    expect(quotedLabels([])).toBe('');
  });

  it('says no note carries those labels together, and lists them in the order lit', () => {
    expect(emptyStateMessage(input({ filters: both, labelsNeverTogether: true })))
      .toBe('No note here has the labels “work” and “urgent” together.');
    expect(emptyStateMessage(input({ filters: { ...emptyFilters, labels: ['c', 'a', 'b'] }, labelsNeverTogether: true })))
      .toBe('No note here has the labels “c”, “a” and “b” together.');
  });

  /** One label is not a combination: the single-label sentence still fits. */
  it('keeps the single-label sentence for one label', () => {
    expect(emptyStateMessage(input({ filters: { ...emptyFilters, labels: ['audit'] }, labelsNeverTogether: true })))
      .toBe('No notes match label “audit”');
  });

  /**
   * A note here does carry both labels and another chip is hiding it: the
   * labels are not the reason, so they must not be blamed.
   */
  it('does not blame the labels when another chip is what hides the notes', () => {
    const msg = emptyStateMessage(input({ filters: { ...both, type: 'checklist' }, labelsNeverTogether: false }));
    expect(msg).toBe('No notes match Only lists');
  });

  it('is said before any other chip is named when the labels are the reason', () => {
    expect(emptyStateMessage(input({ filters: { ...both, type: 'checklist', onlyMine: true }, labelsNeverTogether: true })))
      .toBe('No note here has the labels “work” and “urgent” together.');
  });

  it('names the labels when nothing else is on and the flag was not worked out', () => {
    expect(emptyStateMessage(input({ filters: both }))).toBe('No notes match labels “work” and “urgent”');
    expect(activeFilterName(both)).toBe('labels “work” and “urgent”');
  });

  it('a search still wins', () => {
    expect(emptyStateMessage(input({ searchQuery: 'x', filters: both, labelsNeverTogether: true })))
      .toBe('No notes match your search');
  });
});

describe('the ways back from an empty grid', () => {
  it('with several labels: take the last one back, keep only it, or clear everything', () => {
    expect(emptyStateActions({ ...emptyFilters, labels: ['work', 'urgent'] })).toEqual([
      { kind: 'remove-last', label: 'urgent' },
      { kind: 'only-last', label: 'urgent' },
      { kind: 'clear' },
    ]);
  });

  /** With one label and nothing else on, taking it back IS clearing: one button, not two that do the same. */
  it('with one label alone: just clear', () => {
    expect(emptyStateActions({ ...emptyFilters, labels: ['work'] })).toEqual([{ kind: 'clear' }]);
  });

  it('with one label and another chip: take the label back, or clear everything', () => {
    expect(emptyStateActions({ ...emptyFilters, labels: ['work'], hasReminder: true })).toEqual([
      { kind: 'remove-last', label: 'work' },
      { kind: 'clear' },
    ]);
  });

  it('with no label: just clear', () => {
    expect(emptyStateActions({ ...emptyFilters, type: 'checklist' })).toEqual([{ kind: 'clear' }]);
  });

  it('says what each button does', () => {
    expect(emptyStateActionLabel({ kind: 'remove-last', label: 'urgent' })).toBe('Remove “urgent”');
    expect(emptyStateActionLabel({ kind: 'only-last', label: 'urgent' })).toBe('Show only “urgent”');
    expect(emptyStateActionLabel({ kind: 'clear' })).toBe('Clear filters');
  });

  it('each step changes the labels and nothing else, and clear resets the row', () => {
    const f = { ...emptyFilters, labels: ['a', 'b', 'c'], hasAttachment: true, onlyMine: true };
    expect(applyEmptyStateAction(f, { kind: 'remove-last', label: 'c' }, emptyFilters))
      .toEqual({ ...f, labels: ['a', 'b'] });
    expect(applyEmptyStateAction(f, { kind: 'only-last', label: 'c' }, emptyFilters))
      .toEqual({ ...f, labels: ['c'] });
    expect(applyEmptyStateAction(f, { kind: 'clear' }, emptyFilters)).toEqual(emptyFilters);
  });
});

const LOCKED_TAB = 'Your notes are locked in this browser — unlock them to see them here';
const LOCKED_OLDER = 'Your older notes are locked — see the notice above to restore them';
const NONE_OF_YOUR_OWN = 'No notes of your own yet. Notes shared with you are under Shared with me.';

/**
 * "Only mine" is remembered, so it is on at the first sign-in after a
 * password reset, when every note of the account is locked and the grid is
 * empty. "No notes of your own yet" there would be the onboarding line in
 * other words: the one an account whose notes exist and cannot be opened
 * must NEVER be shown (people conclude the notes are gone and throw away the
 * recovery key).
 */
describe('"Only mine" and an account whose notes are locked', () => {
  const onlyMine = { ...emptyFilters, onlyMine: true };

  it('a tab with no keys is told its notes are locked, whatever is known of the place', () => {
    for (const placeHasNotes of [undefined, false, true]) {
      expect(emptyStateMessage(input({ filters: onlyMine, keysLocked: true, placeHasNotes }))).toBe(LOCKED_TAB);
    }
  });

  it('an account with locked older notes is told so, whatever is known of the place', () => {
    for (const placeHasNotes of [undefined, false, true]) {
      expect(emptyStateMessage(input({ filters: onlyMine, lockedNotes: 12, placeHasNotes }))).toBe(LOCKED_OLDER);
    }
  });

  /** The reader has shared notes on screen-to-be and none of their own readable: still not "none of your own". */
  it('is not told "no notes of your own" while its own notes are locked and shared ones are hidden', () => {
    const msg = emptyStateMessage(input({ filters: onlyMine, lockedNotes: 3, placeHasNotes: true }));
    expect(msg).toBe(LOCKED_OLDER);
    expect(msg).not.toContain('of your own');
  });

  it('an account with nothing locked still gets the sentence that says where shared notes are', () => {
    expect(emptyStateMessage(input({ filters: onlyMine, placeHasNotes: true }))).toBe(NONE_OF_YOUR_OWN);
    expect(emptyStateMessage(input({ filters: onlyMine, lockedNotes: 0 }))).toBe(NONE_OF_YOUR_OWN);
  });

  /** No sentence of this module may hand a locked account the onboarding line, with any single chip on. */
  it('never the onboarding line, nor "none of your own", for a locked account under any one chip', () => {
    const chips: Partial<typeof emptyFilters>[] = [
      {}, { onlyMine: true }, { type: 'checklist' }, { type: 'text' }, { hasReminder: true }, { hasAttachment: true }, { labels: ['a'] }, { labels: ['a', 'b'] },
    ];
    for (const chip of chips) {
      for (const lock of [{ keysLocked: true }, { lockedNotes: 2 }]) {
        for (const placeHasNotes of [undefined, false, true]) {
          const msg = emptyStateMessage(input({ filters: { ...emptyFilters, ...chip }, placeHasNotes, ...lock }));
          expect(msg).not.toBe('Notes you add appear here');
          expect(msg).not.toBe(NONE_OF_YOUR_OWN);
        }
      }
    }
  });
});

/**
 * A chip is blamed only where it hides something, and wherever it does.
 * A grey label can be tapped in any view: under a trash of five notes
 * "No notes in trash" would read as if the trash had been emptied.
 */
describe('a chip is blamed where the place has notes, and only there', () => {
  const work = { ...emptyFilters, labels: ['work'] };

  it('chipsEmptiedIt: a chip is on AND the place is known to have notes', () => {
    expect(chipsEmptiedIt({ filters: work, placeHasNotes: true })).toBe(true);
    expect(chipsEmptiedIt({ filters: work, placeHasNotes: false })).toBe(false);
    expect(chipsEmptiedIt({ filters: work })).toBe(false);
    expect(chipsEmptiedIt({ filters: emptyFilters, placeHasNotes: true })).toBe(false);
  });

  it('in the trash, the reminders and "Shared with me", a chip that hides every note is named', () => {
    for (const view of ['trash', 'reminders', 'inbox'] as const) {
      expect(emptyStateMessage(input({ view, filters: work, placeHasNotes: true }))).toBe('No notes match label “work”');
    }
    expect(emptyStateMessage(input({ view: 'reminders', filters: { ...emptyFilters, type: 'checklist' }, placeHasNotes: true })))
      .toBe('No notes match Only lists');
  });

  it('where those places are empty, they say so as before, chip or no chip', () => {
    expect(emptyStateMessage(input({ view: 'trash', filters: work, placeHasNotes: false }))).toBe('No notes in trash');
    expect(emptyStateMessage(input({ view: 'reminders', filters: work, placeHasNotes: false }))).toContain('No reminders yet');
    expect(emptyStateMessage(input({ view: 'inbox', filters: work, placeHasNotes: false }))).toContain('Nothing shared with you yet');
    expect(emptyStateMessage(input({ view: 'trash', filters: emptyFilters, placeHasNotes: false }))).toBe('No notes in trash');
  });

  it('over a search that found notes, the chip that hides them is named; over one that found none, the search is', () => {
    expect(emptyStateMessage(input({ searchQuery: 'milk', filters: work, placeHasNotes: true }))).toBe('No notes match label “work”');
    expect(emptyStateMessage(input({ searchQuery: 'milk', filters: work, placeHasNotes: false }))).toBe('No notes match your search');
    expect(emptyStateMessage(input({ searchQuery: 'milk', filters: emptyFilters, placeHasNotes: true }))).toBe('No notes match your search');
  });

  it('the labels that never meet are named in those places too', () => {
    const both = { ...emptyFilters, labels: ['work', 'urgent'] };
    expect(emptyStateMessage(input({ view: 'trash', filters: both, labelsNeverTogether: true, placeHasNotes: true })))
      .toBe('No note here has the labels “work” and “urgent” together.');
  });

  /** The place is empty: the chip hides nothing, so the place is what the reader is told about. */
  it('an empty notebook, archive or account is not blamed on a chip', () => {
    const lists = { ...emptyFilters, type: 'checklist' as const };
    expect(emptyStateMessage(input({ filters: lists, notebookName: 'Recipes', placeHasNotes: false }))).toBe('“Recipes” has no notes yet');
    expect(emptyStateMessage(input({ view: 'archived', filters: lists, placeHasNotes: false }))).toBe('Nothing archived yet');
    expect(emptyStateMessage(input({ filters: { ...emptyFilters, onlyMine: true }, placeHasNotes: false }))).toBe('Notes you add appear here');
  });

  /** Not worked out: exactly what was said before the place was asked. */
  it('with the place not worked out, nothing changes from before', () => {
    expect(emptyStateMessage(input({ view: 'trash', filters: work }))).toBe('No notes in trash');
    expect(emptyStateMessage(input({ searchQuery: 'milk', filters: work }))).toBe('No notes match your search');
    expect(emptyStateMessage(input({ filters: work, notebookName: 'Recipes' }))).toBe('No notes match label “work”');
  });
});

