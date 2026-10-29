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
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Several labels in the filter row: the wiring nothing else binds.
 *
 * The arithmetic is pure and tested where it lives (lib/labelFacets,
 * lib/filters, lib/emptyStateMessage). What makes a chip's number TRUE on
 * screen is which notes the view hands that arithmetic, and every wrong
 * choice still renders a plausible row: hand it every note and a chip
 * promises notes another chip is hiding; hand it the unscoped filters and a
 * notebook's shared notes are left out of the numbers; ask "do these labels
 * ever meet?" of the narrowed grid and the answer is always "never".
 * (Counting over the notes the lit labels have already narrowed gives the
 * same numbers, but breaks the row's ORDER; lib/labelFacets.test.ts has that
 * case.) Source-reading, as pages/NotesView.onlyMine.test.ts.
 */
const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');
const view = read('pages', 'NotesView.tsx');
const bar = read('components', 'FilterBar.tsx');
const side = read('components', 'Sidebar.tsx');
const css = read('index.css');
/** One line of whitespace, so a reformatted block still reads the same. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('what the label chips are counted over', () => {
  it('the grid is the place\'s notes narrowed by every chip', () => {
    expect(view).toContain('const displayedNotes = () => applyFilters(scopedNotes(), filtersHere());');
  });

  /** What is counted over what is lib/filters `labelChips`, tested there; here, what the view hands it. */
  it('the chips are made from this place\'s notes and the filters in scope here', () => {
    expect(view).toContain('const labelChips = createMemo(() => labelChipsOf(scopedNotes(), filtersHere(), notesStore.allLabels()));');
    expect(read('lib', 'filters.ts')).toContain('return labelFacets(applyFilters(place, { ...f, labels: [] }), allLabels, f.labels);');
  });

  it('the row is handed those chips', () => {
    expect(view).toContain('labels={labelChips()}');
    expect(view).not.toContain('labels={notesStore.allLabels()}');
  });

  /** The place: the view, the invitation hold and the notebook, and no chip. */
  it('the place\'s notes are taken before any chip narrows them', () => {
    const start = view.indexOf('const scopedNotes = () => {');
    const end = view.indexOf('const displayedNotes = ');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = view.slice(start, end);
    expect(body).toContain('notes = notes.filter(n => !notesStore.heldForInvitation(n));');
    expect(body).toContain('if (nb) notes = notes.filter(n => noteIsInNotebook(n, nb));');
    expect(body).not.toContain('applyFilters(');
  });
});

describe('an empty grid under several labels', () => {
  /** Asked of the place, not of the grid: the grid is empty, so of it the answer is always "never". */
  it('asks whether any note of the place carries all the lit labels', () => {
    expect(flat(view)).toContain(flat(`labelsNeverTogether: filtersHere().labels.length > 1
      && !scopedNotes().some(n => carriesAll(n, filtersHere().labels)),`));
  });

  it('offers the ways back the message module lists, through the same door as every other filter change', () => {
    expect(view).toContain('<For each={emptyStateActions(filtersHere()).map(a => a.kind)}>');
    expect(view).toContain('onClick={() => { const a = action(); if (a) changeFilters(applyEmptyStateAction(filtersHere(), a, emptyFilters)); }}');
    expect(view).toContain(">{action() ? emptyStateActionLabel(action()!) : ''}</button>");
  });

  /**
   * The list is made anew on every change. Keyed by its items (objects),
   * each press would rebuild every button and the keyboard's focus would
   * fall to the page; keyed by position, the focused button would stay and
   * change meaning ("Show only" becoming "Clear filters" under a second
   * Enter). One button per KIND of step: a string, the same from one list to
   * the next.
   */
  it('keeps one ways-back button per kind of step', () => {
    expect(view).toContain('<For each={emptyStateActions(filtersHere()).map(a => a.kind)}>');
    expect(view).toContain('const action = () => emptyStateActions(filtersHere()).find(a => a.kind === kind);');
    expect(view).not.toContain('<For each={emptyStateActions(filtersHere())}>');
    expect(view).not.toContain('<Index each={emptyStateActions(');
  });

  /**
   * The funnel and the ways back appear exactly where the sentence blames a
   * chip (the same question, of the same module), over a search too, and
   * never under "your notes are locked".
   */
  it('offers them wherever a chip emptied the grid, and only there', () => {
    expect(view).toContain('const narrowedByFilter = () => chipsEmptiedIt({ filters: filtersHere(), placeHasNotes: scopedNotes().length > 0 });');
    expect(view).toContain('<Show when={narrowedByFilter()}>\n              <div class="empty-state-actions">');
    expect(view).not.toContain('narrowedByFilter() && !searchQuery()');
    expect(view).toContain('    placeHasNotes: scopedNotes().length > 0,\n  });');
    // The funnel is asked before the icons of the places.
    const funnel = view.indexOf('<Match when={narrowedByFilter()}>');
    expect(funnel).toBeGreaterThan(-1);
    expect(funnel).toBeLessThan(view.indexOf("<Match when={view() === 'reminders'}>"));
    expect(funnel).toBeLessThan(view.indexOf('<Match when={searchQuery()}>'));
  });
});

describe('the lit labels as the view keeps them', () => {
  /** One label gone must not put the others out. */
  it('a lit label no note carries any more goes out, and only that one', () => {
    expect(flat(view)).toContain(flat(`createEffect(() => {
      const all = notesStore.allLabels();
      if (filters().labels.some(l => !all.includes(l))) {
        setFilters(f => ({ ...f, labels: f.labels.filter(l => all.includes(l)) }));
      }
    });`));
  });

  it('leaving for a notebook, the reminders or the inbox puts the labels out', () => {
    expect(view).toContain("onSelect={(id) => { setSelectedNotebook(id); setFilters(f => ({ ...f, labels: [] }));");
    expect(view).toContain("onSelectReminders={() => { setView('reminders'); setSelectedNotebook(null); setFilters(f => ({ ...f, labels: [] }));");
    expect(view).toContain("setView('inbox'); setSelectedNotebook(null); setFilters(f => ({ ...f, labels: [] }));");
  });

  /** The sidebar's list is a set of destinations: one label, alone. */
  it('the sidebar goes to ONE label, shows every lit one, and reports a rename', () => {
    expect(view).toContain('selectedLabels={filters().labels}');
    expect(view).toContain('onSelectLabel={(l) => { setFilters(f => ({ ...f, labels: l === null ? [] : [l] }));');
    expect(view).toContain('onLabelRenamed={(from, to) => setFilters(f => ({ ...f, labels: renameSelected(f.labels, from, to) }))}');
  });

  it('no single-label field is left in the view', () => {
    expect(view).not.toMatch(/filters\(\)\.label\b/);
    expect(view).not.toMatch(/\blabel: (null|l)\b/);
  });
});

describe('the sidebar\'s label list', () => {
  it('lights every lit label', () => {
    expect(side).toContain("class={props.selectedLabels.includes(label)");
  });

  /** Tapping the only lit label puts it out; tapping one of several goes to it alone. */
  it('puts a label out only when it is the one label lit', () => {
    expect(flat(side)).toContain(flat(`onClick={() => props.onSelectLabel(
      props.selectedLabels.length === 1 && props.selectedLabels[0] === label ? null : label,
    )}`));
  });

  /**
   * Whether the label was lit is asked BEFORE the notes are rewritten: after
   * the last one, the view has already put the old name out.
   */
  it('remembers that a label was lit before renaming it, and reports the rename after', () => {
    const lit = side.indexOf('const wasLit = props.selectedLabels.includes(oldName);');
    const rewrite = side.indexOf('await notesStore.updateNote(n.id, { labels: deduped });');
    const report = side.indexOf('if (wasLit) props.onLabelRenamed(oldName, newLabel);');
    expect(lit).toBeGreaterThan(-1);
    expect(rewrite).toBeGreaterThan(lit);
    expect(report).toBeGreaterThan(rewrite);
  });
});

describe('the label chips in the row', () => {
  it('a tap lights or puts out that label and leaves the others as they are', () => {
    expect(bar).toContain('props.onChange({ ...props.filters, labels: toggleLabel(props.filters.labels, label) });');
  });

  /** Lit wins over greyed: a lit chip is never drawn as one that does nothing. */
  it('is lit when selected, greyed when it would leave no notes, plain otherwise', () => {
    expect(bar).toContain("class={chip().selected ? 'filter-chip active' : greyed(chip()) ? 'filter-chip dim' : 'filter-chip'}");
  });

  it('a greyed chip is still a button that can be tapped', () => {
    const start = bar.indexOf('<For each={names()}>');
    const chip = bar.slice(start, bar.indexOf('</For>', start));
    expect(chip).not.toContain('disabled');
    expect(css).not.toMatch(/\.filter-chip\.dim\s*\{[^}]*pointer-events/);
  });

  it('shows the count to the right of the name, and says both to a screen reader', () => {
    expect(flat(bar)).toContain(flat(`<span>{label}</span>
              <span class="filter-chip-count">{chip().count}</span>`));
    expect(bar).toContain("aria-label={`${label}, ${chip().count} ${chip().count === 1 ? 'note' : 'notes'}`}");
    expect(bar).toContain('aria-pressed={chip().selected}');
  });

  /**
   * Keyed by name. Keyed by the chip objects, which are made anew on every
   * count, each tap would rebuild every button and drop the keyboard's focus.
   */
  it('keeps one button per label as the row is re-ordered', () => {
    expect(bar).toContain('const names = createMemo(() => props.labels.map(c => c.label));');
    expect(bar).toContain('<For each={names()}>');
    expect(bar).not.toContain('<For each={props.labels}>');
  });

  it('follows the chip that was tapped when it moves along the row', () => {
    expect(bar).toContain('follow(tapped, hadFocus, leftBefore);');
    expect(bar).toContain('row.scrollLeft');
    // Sideways only: scrollIntoView may move the page as well.
    expect(bar).not.toContain('scrollIntoView');
  });

  /**
   * A button moved within its row stops being the focused element. Whether it
   * WAS focused is asked before the change, and it is focused again after,
   * without scrolling the page to it.
   */
  it('hands the keyboard focus back to a chip that moved', () => {
    const asked = bar.indexOf('const hadFocus = document.activeElement === tapped;');
    const changed = bar.indexOf('props.onChange({ ...props.filters, labels: toggleLabel(props.filters.labels, label) });');
    expect(asked).toBeGreaterThan(-1);
    expect(changed).toBeGreaterThan(asked);
    expect(bar).toContain('if (hadFocus && document.activeElement !== chip) chip.focus({ preventScroll: true });');
  });

  /**
   * Where the chip stood is measured BEFORE the change, and the row is
   * scrolled by exactly as far as the chip moved, so it stays under the
   * finger and a second tap lands on the same label.
   */
  it('holds the tapped chip where it was tapped', () => {
    const measured = bar.indexOf('const leftBefore = tapped.getBoundingClientRect().left;');
    const changed = bar.indexOf('props.onChange({ ...props.filters, labels: toggleLabel(props.filters.labels, label) });');
    expect(measured).toBeGreaterThan(-1);
    expect(changed).toBeGreaterThan(measured);
    expect(bar).toContain('row.scrollLeft += chip.getBoundingClientRect().left - leftBefore;');
    // Done at once, and again when drawn: no frame is painted with the chip elsewhere.
    expect(bar).toContain('settle();\n  requestAnimationFrame(settle);');
  });

  it('has a style for the greyed chip and for the count', () => {
    expect(css).toMatch(/\.filter-chip\.dim\s*\{/);
    expect(css).toMatch(/\.filter-chip-count\s*\{/);
  });

  /** A dimmed count would fall to 3.2:1 contrast against its chip; it keeps the
   * chip's own colour.
   */
  it('does not dim the count below the chip\'s own text', () => {
    const rule = /\.filter-chip-count\s*\{([^}]*)\}/.exec(css)?.[1] ?? 'opacity';
    expect(rule).not.toMatch(/opacity|color\s*:/);
  });
});

/**
 * "Shared with me" lists what the chips and the search leave, as the
 * counts and the empty state speak of: the list is built from the grid's
 * own answer.
 */
describe('"Shared with me" lists what the filter row and the search leave', () => {
  it('builds the groups from the notes the grid would show', () => {
    expect(view).toContain("return groupBySharer(sharesInboxStore.sharedNotes(), new Set(displayedNotes().map(n => n.id)));");
  });

  /**
   * Matched against the inbox's OWN copies. The notes store skips a shared
   * item it could not open, so narrowing ITS results to the inbox would make
   * such a note vanish from this list the moment anything was typed.
   */
  it('a search made there is a search of the inbox\'s own notes', () => {
    expect(flat(view)).toContain(flat(`if (searchResults() !== null && view() === 'inbox') {`));
    expect(flat(view)).toContain(flat(`notes = sharesInboxStore.sharedNotes()
        .map((s) => s.note)
        .filter((n): n is NoteItem => n !== null && matchesSearch(n, typed));`));
    expect(view).toContain('const typed = searchQuery();');
    expect(read('stores', 'notes.ts')).toContain('return notes().filter(n => !n.deleted && matchesSearch(n, query));');
  });

  it('no list of shared notes is built past the filters', () => {
    const start = view.indexOf('const inboxGroups = () => {');
    const body = view.slice(start, view.indexOf('};', start));
    expect(body).not.toContain('for (const s of shares)');
    expect(body).toContain('displayedNotes()');
  });
});

/** With the row folded away, a chip that is on is marked on the control that folds it. */
describe('a folded filter row with a chip on', () => {
  it('is marked, in the title and to a screen reader too', () => {
    expect(view).toContain('const filtersHiddenButOn = () => filtersCollapsed() && filtersActive(filtersHere());');
    expect(view).toContain("classList={{ collapsed: filtersCollapsed(), 'has-active': filtersHiddenButOn() }}");
    expect(view).toContain("aria-label={filtersCollapsed() ? (filtersHiddenButOn() ? 'Show filters (some are on)' : 'Show filters') : 'Hide filters'}");
    expect(css).toMatch(/\.filter-collapse-caret\.has-active::after\s*\{/);
  });
});

