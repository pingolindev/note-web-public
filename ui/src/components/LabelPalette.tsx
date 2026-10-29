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

import { Component, For, Show } from 'solid-js';
import { notesStore } from '../stores/notes';

interface Props {
  /** Labels already on the note — these are not offered again. */
  selected: string[];
  onPick: (label: string) => void;
}

/**
 * The labels this account already uses, as one-tap chips.
 *
 * Both label inputs can only SUGGEST, and only once something is typed:
 * `suggestions()` in LabelEditor returns `[]` for an empty query, and the
 * composer has no suggestion path at all. Without the palette, using a label
 * already made means remembering it exactly and typing it again — and
 * mistyping one silently creates a second, near-identical label instead of
 * reusing the first, which is the failure mode that makes label lists rot.
 *
 * Shown collapsed to a sensible number: a long-standing account has more
 * labels than belong in a dialog, and the typeahead is still there for the
 * tail. Ordered by how many notes carry each, so the ones actually in use come
 * first rather than whichever happens to sort early.
 */
const LabelPalette: Component<Props> = (props) => {
  const MAX = 12;

  const available = () => {
    const counts = new Map<string, number>();
    for (const n of notesStore.notes()) {
      if (!n || n.deleted || n.isArchived) continue;
      for (const l of n.labels ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return notesStore.allLabels()
      .filter(l => !props.selected.includes(l))
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, MAX);
  };

  return (
    <Show when={available().length > 0}>
      <div class="label-palette">
        {/* NOT "Your labels": that reads as "your labels, i.e. the ones on this
            note", which is the opposite of what these are. The applied ones sit
            directly above in the same dialog, so any possessive phrasing is
            ambiguous exactly where it matters. A VERB fixes it: a heading that
            says what clicking does cannot be misread as a description of the
            note's current state. */}
        <span class="label-palette-title">Add an existing label</span>
        <div class="label-palette-chips">
          <For each={available()}>
            {(l) => (
              <button
                type="button"
                class="label-palette-chip"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => props.onPick(l)}
                title={`Add "${l}"`}
              >
                {/* The wording is half of it; the SHAPE is the other half. An
                    applied label is a filled chip with a "×" to remove it, so a
                    "+" on an outlined one says add-me even to someone who never
                    reads the heading. `aria-hidden` keeps the accessible name
                    the label itself, not "+ label". */}
                <span class="label-palette-plus" aria-hidden="true">+</span>
                {l}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

export default LabelPalette;
