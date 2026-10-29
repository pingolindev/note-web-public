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
 * The drag clone is a `.note-card` with a `data-note-id`, and FLIP must not
 * touch it.
 *
 * `activateDrag` in NotesView.tsx lifts the card with `cloneNode(true)` — which
 * copies the class list AND the `data-note-id` attribute — then parents the
 * copy to `document.body` and rewrites its `left`/`top` on every pointermove.
 * So the floating card the user is holding satisfies `.note-card[data-note-id]`
 * exactly as a grid card does. With that selector alone, lib/flip.ts would let
 * the clone's rect overwrite the real card's snapshot (same id, later in the
 * document) and give the clone itself a 600ms transform on every reorder,
 * pulling it away from the cursor.
 *
 * Nothing in either language binds the class the clone is tagged with to the
 * selector that excludes it. This is that binding — a source scan, like
 * chromeCollapse.test.ts, because the failure mode is a future rename in one
 * file and no complaint from the other.
 */
const SRC = join(__dirname, '..');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const NOTES_VIEW = stripComments(readFileSync(join(SRC, 'pages', 'NotesView.tsx'), 'utf8'));
const FLIP = stripComments(readFileSync(join(SRC, 'lib', 'flip.ts'), 'utf8'));

describe('the drag clone is excluded from FLIP', () => {
  it('NotesView still clones the card and tags the copy with a class', () => {
    expect(NOTES_VIEW).toMatch(/cloneNode\(true\)/);
    expect(NOTES_VIEW).toMatch(/classList\.add\(\s*['"]note-card-drag-clone['"]\s*\)/);
  });

  it('NotesView does not strip data-note-id from the clone, so the exclusion is load-bearing', () => {
    // If a future change removes the attribute on the clone instead, this test
    // should be deleted along with the :not() — not left asserting a rule that
    // guards nothing.
    expect(NOTES_VIEW).not.toMatch(/clone\.removeAttribute\(\s*['"]data-note-id['"]\s*\)/);
  });

  it('every card query in flip.ts excludes the clone class', () => {
    const queries = [...FLIP.matchAll(/querySelectorAll<HTMLElement>\(\s*([A-Z_]+|'[^']*')\s*\)/g)]
      .map(m => m[1]);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      // Either the shared constant, or an inline selector that excludes the clone.
      const selector = q.startsWith("'")
        ? q
        : (FLIP.match(new RegExp(`const ${q} = ('[^']*')`))?.[1] ?? '');
      expect(selector, `flip.ts card query ${q}`).toContain(':not(.note-card-drag-clone)');
    }
  });
});
