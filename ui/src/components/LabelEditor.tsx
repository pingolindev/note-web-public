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

import { Component, createSignal, For, Show } from 'solid-js';
import { notesStore } from '../stores/notes';
import LabelPalette from './LabelPalette';

interface Props {
  labels: string[];
  onChange: (labels: string[]) => void;
}

const LabelEditor: Component<Props> = (props) => {
  const [inputValue, setInputValue] = createSignal('');
  const [showSuggestions, setShowSuggestions] = createSignal(false);

  const suggestions = () => {
    const q = inputValue().toLowerCase();
    if (!q) return [];
    return notesStore.allLabels()
      .filter(l => l.toLowerCase().includes(q) && !props.labels.includes(l))
      .slice(0, 5);
  };

  const addLabel = (label: string) => {
    const trimmed = label.trim();
    if (trimmed && !props.labels.includes(trimmed)) {
      props.onChange([...props.labels, trimmed]);
    }
    setInputValue('');
    setShowSuggestions(false);
  };

  const removeLabel = (label: string) => {
    props.onChange(props.labels.filter(l => l !== label));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && inputValue().trim()) {
      e.preventDefault();
      addLabel(inputValue());
    }
  };

  return (
    <div class="label-editor">
      <div class="label-chips">
        <For each={props.labels}>
          {(label) => (
            <span class="label-chip editable">
              {label}
              <button class="label-remove" onClick={() => removeLabel(label)}>&times;</button>
            </span>
          )}
        </For>
        <input
          class="label-input"
          type="text"
          placeholder="Add label..."
          value={inputValue()}
          onInput={(e) => { setInputValue(e.currentTarget.value); setShowSuggestions(true); }}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          onFocus={() => setShowSuggestions(true)}
        />
      </div>
      <Show when={showSuggestions() && suggestions().length > 0}>
        <div class="label-suggestions">
          <For each={suggestions()}>
            {(s) => (
              <button class="label-suggestion" onMouseDown={() => addLabel(s)}>{s}</button>
            )}
          </For>
        </div>
      </Show>
      {/* The typeahead above only fires once something is typed. This is the
          list you can read without knowing what you are looking for. */}
      <LabelPalette selected={props.labels} onPick={addLabel} />
    </div>
  );
};

export default LabelEditor;
