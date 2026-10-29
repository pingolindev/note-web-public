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
import { resolvePresenceColor } from './collab';

/**
 * The colour published in awareness drives a remote peer's caret, their
 * selection highlight, and their collaborator avatar (which fills with it).
 *
 * The case this guards: `NoteModal` passes `color: ''` to mean "derive one
 * from my userId". A resolver using `??`, which falls back on null/undefined
 * but NOT on an empty string, would publish `''` as the colour;
 * y-codemirror.next would write `style="background-color: ; border-color: "`
 * on the caret, the browser would drop the invalid declaration, and
 * everything that inherits from it would come out transparent — a clear
 * avatar bubble that blends into the note.
 */
describe('resolvePresenceColor', () => {
  const uid = 'b1b2c3d4-0000-4000-8000-000000000010';

  it("derives from userId when the caller passes '' (the NoteModal case)", () => {
    const c = resolvePresenceColor({ name: 'Alice', color: '', userId: uid });
    expect(c).not.toBe('');
    expect(c).toMatch(/^hsl\(/);
  });

  it('treats whitespace as absent too', () => {
    expect(resolvePresenceColor({ name: 'A', color: '   ', userId: uid })).toMatch(/^hsl\(/);
  });

  it('keeps an explicit colour when one is supplied', () => {
    expect(resolvePresenceColor({ name: 'A', color: '#ff0000', userId: uid })).toBe('#ff0000');
  });

  it('is stable per user — the same id always gets the same colour', () => {
    expect(resolvePresenceColor({ name: 'A', color: '', userId: uid }))
      .toBe(resolvePresenceColor({ name: 'Different Name', color: '', userId: uid }));
  });

  it('gives different users different colours', () => {
    const a = resolvePresenceColor({ name: 'A', color: '', userId: uid });
    const b = resolvePresenceColor({ name: 'B', color: '', userId: 'ffffffff-0000-4000-8000-000000000099' });
    expect(a).not.toBe(b);
  });

  it('never returns empty, even with nothing to go on', () => {
    expect(resolvePresenceColor()).toBeTruthy();
    expect(resolvePresenceColor({ name: 'A', color: '' })).toBeTruthy();
    expect(resolvePresenceColor({ name: 'A', color: '', userId: '' })).toBeTruthy();
  });
});
