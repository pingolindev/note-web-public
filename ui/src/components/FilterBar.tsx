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

import { For, Show, createMemo } from 'solid-js';
import type { Filters } from '../lib/filters';
import { emptyFilters, filtersActive } from '../lib/filters';
import { greyed, toggleLabel, type LabelFacet } from '../lib/labelFacets';

/**
 * The one filter row above the notes grid, matching Android's.
 *
 * Android renders a single horizontally-scrolling row: All, four built-in
 * filters, then the user's own labels. (Android also carries a "Shared with
 * me" chip; web reaches shared notes through a dedicated Inbox view instead,
 * so a chip here would be a second, redundant route to the same place.) One
 * row with one set of rules keeps every filter reachable from the grid,
 * whether or not a search is running or any labels exist. The filter helpers
 * live in `lib/filters.ts`.
 *
 * "Only mine" is the fifth built-in and the opposite of that chip: it takes
 * other people's notes OUT of the grid, which no other route does. It is
 * offered only where it acts — see lib/onlyMine.
 *
 * The built-ins are ICONS when off and icon + label when on, for the same
 * reasons as Android: as text they crowd the user's own labels out of the row,
 * and "only" cannot be drawn — a checklist glyph reads as easily as "include
 * lists" as "lists exclusively" — so an ACTIVE filter always spells itself out,
 * which is also when the row has spare width because filtering shortens it.
 * Glyph-versus-word additionally separates the app's filters from the user's
 * labels, which would otherwise be identical-looking buttons.
 *
 * THE LABELS: several can be lit, and the grid keeps the notes that carry all
 * of them. Each chip shows how many notes it would leave, the row runs from
 * the label on most notes to the one on fewest, and a label that would leave
 * none is greyed at the end — still tappable: the empty grid then names the
 * labels no note carries together and offers the step back. The arithmetic,
 * and why a lit chip stays where it is, is lib/labelFacets.
 */

const ICON_SIZE = 16;

function IconNote() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconChecklist() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 4.5 7.5 7.5 4.5" />
      <polyline points="3 12 4.5 13.5 7.5 10.5" />
      <polyline points="3 18 4.5 19.5 7.5 16.5" />
      <line x1="11" y1="6" x2="21" y2="6" />
      <line x1="11" y1="12" x2="21" y2="12" />
      <line x1="11" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function IconAlarm() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="13" r="8" />
      <polyline points="12 9 12 13 15 15" />
      <line x1="5" y1="3" x2="8" y2="5.5" />
      <line x1="19" y1="3" x2="16" y2="5.5" />
    </svg>
  );
}

function IconAttach() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

/** One person: the reader. The outbound-share marker is three joined nodes and
 *  the inbound one an arrow into a tray, so a lone figure cannot be read as
 *  either. */
function IconMine() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </svg>
  );
}

/** Room kept clear at the row's right edge: the phone row fades out over its last 24px. */
const EDGE = 32;

/**
 * The row re-orders around the chip just tapped: labels that went grey leave
 * for the end, and a grey chip that was tapped comes back to its place
 * (lib/labelFacets). Two things would be lost with that.
 *
 * Its focus. A button taken out of the row and put back elsewhere loses focus
 * (`document.activeElement` is the body after the move), so someone who
 * pressed Enter on a label would have their next Tab start from the top of
 * the page. It is handed back.
 *
 * Its place under the finger. The row is scrolled by exactly as far as the
 * chip moved, so it stays where it was tapped and a second tap lands on the
 * same label. Where the row cannot scroll that far, at its start or where
 * everything fits, the chip is at least kept on screen. Sideways only: the
 * page itself does not move.
 */
function follow(chip: HTMLElement, hadFocus: boolean, leftBefore: number) {
  const settle = () => {
    if (!chip.isConnected) return;
    if (hadFocus && document.activeElement !== chip) chip.focus({ preventScroll: true });
    const row = chip.parentElement;
    if (!row) return;
    row.scrollLeft += chip.getBoundingClientRect().left - leftBefore;
    const r = row.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    if (c.left < r.left) row.scrollLeft -= r.left - c.left;
    else if (c.right > r.right - EDGE) row.scrollLeft += c.right - (r.right - EDGE);
  };
  // At once where the row has been re-ordered already (nothing is painted in
  // between), and again once it is drawn in case the re-ordering was put off.
  settle();
  requestAnimationFrame(settle);
}

interface FilterBarProps {
  filters: Filters;
  onChange: (f: Filters) => void;
  /** The label chips, already counted and ordered (lib/labelFacets). */
  labels: LabelFacet[];
  /** Offer "Only mine": true in the plain Notes grid, the one place it acts. */
  showOnlyMine?: boolean;
}

export function FilterBar(props: FilterBarProps) {
  const anyActive = () => filtersActive(props.filters);
  // The row is keyed by the label's NAME, not by its chip: the chips are made
  // anew on every count, and keyed by them each tap would throw every button
  // away and build new ones. By name a chip only moves, so the one that was
  // tapped is still there to be followed (`follow`, above).
  const names = createMemo(() => props.labels.map(c => c.label));
  const chipOf = createMemo(() => new Map(props.labels.map(c => [c.label, c])));

  // The row is ALWAYS mounted. The four built-in filters (notes / lists /
  // reminder / attachment) and "All" belong to the app, not to the user's
  // labels, so gating the row on `labels.length > 0` would hide working
  // features behind an unrelated action: a label would have to be invented
  // before one could filter by attachment. Labels merely extend the row.

  const setType = (t: 'text' | 'checklist') => {
    // Tapping the active one clears it; tapping the other switches, so the two
    // stay mutually exclusive through the single `type` field.
    props.onChange({ ...props.filters, type: props.filters.type === t ? 'any' : t });
  };

  return (
    <div class="filter-bar" role="group" aria-label="Filter notes">
      <button
        class={!anyActive() ? 'filter-chip active' : 'filter-chip'}
        onClick={() => {
          // Reset EVERYTHING, including the shared toggle. Clearing only some
          // of it would leave a filter on with no obvious way back.
          props.onChange({ ...emptyFilters });
        }}
      >All</button>

      <button
        class={props.filters.type === 'text' ? 'filter-chip icon active' : 'filter-chip icon'}
        onClick={() => setType('text')}
        title="Only notes"
        aria-label="Only notes"
        aria-pressed={props.filters.type === 'text'}
      >
        <IconNote />
        <Show when={props.filters.type === 'text'}><span>Only notes</span></Show>
      </button>

      <button
        class={props.filters.type === 'checklist' ? 'filter-chip icon active' : 'filter-chip icon'}
        onClick={() => setType('checklist')}
        title="Only lists"
        aria-label="Only lists"
        aria-pressed={props.filters.type === 'checklist'}
      >
        <IconChecklist />
        <Show when={props.filters.type === 'checklist'}><span>Only lists</span></Show>
      </button>

      <button
        class={props.filters.hasReminder ? 'filter-chip icon active' : 'filter-chip icon'}
        onClick={() => props.onChange({ ...props.filters, hasReminder: !props.filters.hasReminder })}
        title="Has reminder"
        aria-label="Has reminder"
        aria-pressed={props.filters.hasReminder}
      >
        <IconAlarm />
        <Show when={props.filters.hasReminder}><span>Has reminder</span></Show>
      </button>

      <button
        class={props.filters.hasAttachment ? 'filter-chip icon active' : 'filter-chip icon'}
        onClick={() => props.onChange({ ...props.filters, hasAttachment: !props.filters.hasAttachment })}
        title="Has attachment"
        aria-label="Has attachment"
        aria-pressed={props.filters.hasAttachment}
      >
        <IconAttach />
        <Show when={props.filters.hasAttachment}><span>Has attachment</span></Show>
      </button>

      <Show when={props.showOnlyMine}>
        <button
          class={props.filters.onlyMine ? 'filter-chip icon active' : 'filter-chip icon'}
          onClick={() => props.onChange({ ...props.filters, onlyMine: !props.filters.onlyMine })}
          title="Only mine"
          aria-label="Only mine"
          aria-pressed={props.filters.onlyMine}
        >
          <IconMine />
          <Show when={props.filters.onlyMine}><span>Only mine</span></Show>
        </button>
      </Show>

      <For each={names()}>
        {(label) => {
          const chip = () => chipOf().get(label) ?? { label, count: 0, selected: false };
          return (
            <button
              class={chip().selected ? 'filter-chip active' : greyed(chip()) ? 'filter-chip dim' : 'filter-chip'}
              onClick={(e) => {
                const tapped = e.currentTarget;
                const hadFocus = document.activeElement === tapped;
                const leftBefore = tapped.getBoundingClientRect().left;
                props.onChange({ ...props.filters, labels: toggleLabel(props.filters.labels, label) });
                follow(tapped, hadFocus, leftBefore);
              }}
              aria-pressed={chip().selected}
              aria-label={`${label}, ${chip().count} ${chip().count === 1 ? 'note' : 'notes'}`}
            >
              <span>{label}</span>
              <span class="filter-chip-count">{chip().count}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
}
