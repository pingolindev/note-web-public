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

import { Component, For } from 'solid-js';

const COLORS = [
  { name: 'None', value: null, bg: 'transparent', border: true },
  { name: 'Red', value: '#f28b82', bg: '#f28b82' },
  { name: 'Orange', value: '#fbbc04', bg: '#fbbc04' },
  { name: 'Yellow', value: '#fff475', bg: '#fff475' },
  { name: 'Green', value: '#ccff90', bg: '#ccff90' },
  { name: 'Teal', value: '#a7ffeb', bg: '#a7ffeb' },
  { name: 'Blue', value: '#cbf0f8', bg: '#cbf0f8' },
  { name: 'Purple', value: '#d7aefb', bg: '#d7aefb' },
  { name: 'Pink', value: '#fdcfe8', bg: '#fdcfe8' },
  { name: 'Brown', value: '#e6c9a8', bg: '#e6c9a8' },
  { name: 'Gray', value: '#e8eaed', bg: '#e8eaed' },
  { name: 'Dark', value: '#aecbfa', bg: '#aecbfa' },
];

interface Props {
  selected: string | null;
  onChange: (color: string | null) => void;
}

const ColorPicker: Component<Props> = (props) => {
  return (
    <div class="color-picker">
      <For each={COLORS}>
        {(c) => (
          <button
            class={props.selected === c.value ? 'color-dot selected' : 'color-dot'}
            style={{
              background: c.bg,
              ...(c.border ? { border: '2px dashed var(--border-color)' } : {}),
            }}
            title={c.name}
            onClick={() => props.onChange(c.value)}
          >
            {props.selected === c.value && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.value ? '#333' : 'var(--text-primary)'} stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
            )}
          </button>
        )}
      </For>
    </div>
  );
};

export default ColorPicker;
