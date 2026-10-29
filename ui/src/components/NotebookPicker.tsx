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

import { Component, For, Show, createEffect, createSignal } from 'solid-js';
import { notebooksStore } from '../stores/notebooks';

/**
 * "Notebook" picker for the composer and the open note.
 *
 * With no notebooks yet it offers "Create your first notebook" instead of
 * disappearing: the only other "New notebook" control in the app is a 17x16
 * `+` inside the sidebar section header, in a drawer that is closed by
 * default. Hiding the picker on a fresh account would mean the first
 * notebook could not be made from the place you notice wanting one, and
 * nothing on screen would say notebooks exist. An empty list is not a reason
 * to hide the control; it is the reason to offer the one thing that fixes
 * it.
 *
 * Shared rather than copied so the two call sites cannot drift apart (one
 * binding its value through a ref effect, the other through the `value`
 * prop): a picker that behaves differently in the composer than in the note
 * it becomes is exactly the drift to avoid.
 */
interface Props {
  /** Selected notebook id, or null for "No notebook". */
  value: string | null;
  onChange: (id: string | null) => void;
}

const NotebookPicker: Component<Props> = (props) => {
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal('');

  const commit = () => {
    const trimmed = name().trim();
    setCreating(false);
    setName('');
    if (!trimmed) return;
    // create() is synchronous and returns the row (the server write is
    // fire-and-forget inside the store), so the new notebook can be selected
    // in the same tick — the note lands in the notebook that was just made
    // rather than in "No notebook" until the next sync.
    props.onChange(notebooksStore.create(trimmed).id);
  };

  return (
    <div class="notebook-select-group">
      <label class="notebook-select-label">Notebook</label>
      <Show
        when={notebooksStore.notebooks().length > 0}
        fallback={
          <Show
            when={creating()}
            fallback={
              <button
                class="btn btn-sm btn-secondary"
                onClick={() => setCreating(true)}
              >
                Create your first notebook
              </button>
            }
          >
            <input
              class="notebook-select"
              type="text"
              placeholder="Notebook name"
              autofocus
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              /* Enter commits, Escape abandons, and blur commits too — the
                 same three the sidebar's rename field answers to, so the
                 gesture is the one the app already taught. */
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { setCreating(false); setName(''); }
              }}
              onBlur={commit}
            />
          </Show>
        }
      >
        <select
          class="notebook-select"
          ref={(el) => {
            // Bound through an effect rather than the `value` prop: Solid sets
            // `value` before <For> has appended the <option>s, and a select
            // whose value names an option that does not exist yet silently
            // falls back to the first one.
            createEffect(() => { el.value = props.value || ''; });
          }}
          onChange={(e) => props.onChange(e.currentTarget.value || null)}
        >
          <option value="">No notebook</option>
          <For each={notebooksStore.notebooks()}>
            {(nb) => <option value={nb.id}>{nb.name}</option>}
          </For>
        </select>
      </Show>
    </div>
  );
};

export default NotebookPicker;
