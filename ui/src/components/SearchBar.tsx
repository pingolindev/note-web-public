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

import { Component, Show, createSignal } from 'solid-js';

interface Props {
  onSearch: (query: string) => void;
}

/**
 * The header search field.
 *
 * The clear button fills the 40px of `padding-right` that `index.css`
 * reserves for it, so the × never sits on top of the last characters typed,
 * and a search you have finished with takes one tap to undo instead of a
 * select-all and a delete.
 *
 * It is OUR button rather than `type="search"`'s native one: the native × is
 * absent in Firefox, unstyleable in Safari, and — the reason that matters —
 * fires no event this component can hear, so clearing it would leave the last
 * debounced query still applied to the grid.
 */
const SearchBar: Component<Props> = (props) => {
  const [query, setQuery] = createSignal('');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inputRef: HTMLInputElement | undefined;

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => props.onSearch(value), 200);
  };

  const clear = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    setQuery('');
    // Immediately, not through the debounce: the grid coming back is the
    // whole point of the press, and 200ms of stale results after it reads as
    // the button having missed.
    props.onSearch('');
    inputRef?.focus();
  };

  return (
    <div class="search-wrap">
      <input
        ref={inputRef}
        class="search-bar"
        type="search"
        placeholder="Search notes..."
        value={query()}
        onInput={(e) => handleInput(e.currentTarget.value)}
        // Escape clears, as it does in every other search field. Only when
        // there is something to clear, so an empty field lets Escape through
        // to NotesView's own handler.
        onKeyDown={(e) => { if (e.key === 'Escape' && query()) { e.stopPropagation(); clear(); } }}
      />
      <Show when={query()}>
        <button
          class="search-clear"
          type="button"
          aria-label="Clear search"
          title="Clear search"
          onClick={clear}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </Show>
    </div>
  );
};

export default SearchBar;
