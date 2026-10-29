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
import { noteColorValue } from './noteColor';

describe('noteColorValue — only a colour reaches the stylesheet', () => {
  it('accepts the palette ColorPicker offers', () => {
    for (const c of ['#f28b82', '#fbbc04', '#fff475', '#ccff90', '#a7ffeb', '#cbf0f8']) {
      expect(noteColorValue(c)).toBe(c);
    }
  });

  it('accepts the other hex lengths', () => {
    expect(noteColorValue('#abc')).toBe('#abc');
    expect(noteColorValue('#abcd')).toBe('#abcd');
    expect(noteColorValue('#aabbccdd')).toBe('#aabbccdd');
  });

  it('rejects the string that blanked a card', () => {
    // With style="--note-color: null" the color-mix goes invalid and the
    // card paints rgba(0, 0, 0, 0).
    expect(noteColorValue('null')).toBeNull();
    expect(noteColorValue('undefined')).toBeNull();
  });

  it('rejects nulls, non-strings and anything that is not hex', () => {
    expect(noteColorValue(null)).toBeNull();
    expect(noteColorValue(undefined)).toBeNull();
    expect(noteColorValue(0)).toBeNull();
    expect(noteColorValue({})).toBeNull();
    expect(noteColorValue('')).toBeNull();
    expect(noteColorValue('red')).toBeNull();
    expect(noteColorValue('transparent')).toBeNull();
    expect(noteColorValue('var(--x)')).toBeNull();
    // A token stream is not a value: this would otherwise ride into the sheet.
    expect(noteColorValue('#fff; background: url(x)')).toBeNull();
  });

  it('trims, because a stored value may carry whitespace', () => {
    expect(noteColorValue('  #f28b82 ')).toBe('#f28b82');
  });
});

describe('the card keeps its ground whatever the colour is', () => {
  const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
  const rule = CSS.slice(CSS.indexOf('.note-card[style*="--note-color"]'));
  const block = rule.slice(0, rule.indexOf('}') + 1);

  it('paints the wash over an opaque background-color, not as the background', () => {
    // A single `background: color-mix(…)` is one invalid token away from a
    // transparent card.
    expect(block).toMatch(/background-color:\s*var\(--card-bg\)/);
    expect(block).toMatch(/background-image:\s*linear-gradient/);
    expect(block).not.toMatch(/^\s*background:\s/m);
  });
});
