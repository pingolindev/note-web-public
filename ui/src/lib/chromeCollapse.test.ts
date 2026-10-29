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
 * The phone chrome collapse, and the two halves that have to agree.
 *
 * `.note-modal.bottom-hidden` in index.css sets its sections to
 * `display: none`. `NoteModal.tsx` carries the SAME sections as a selector
 * string (BOTTOM_HIDDEN_SECTIONS) and declines to collapse when focus is
 * inside one of them — because focusing a text field there raises the
 * keyboard, and collapsing on THAT deletes the field being typed into and
 * takes focus with it, so on a phone nothing could be typed into it.
 *
 * Nothing in either language binds those two lists. If the CSS rule gains a
 * section and the allowlist does not follow, that failure returns — and it
 * is invisible on a desktop, where none of this CSS applies.
 * This is the binding: a source scan, for the same reason
 * confirmDialogUsage.test.ts is one — the failure mode is a future edit to
 * one side, and nothing else looks.
 */
const SRC = join(__dirname, '..');

/**
 * Strip comments before scanning, in BOTH languages.
 *
 * The selector match reaches back from `{` to the previous `}`, which sweeps up
 * any comment sitting above the rule — and a comment that names a file
 * (`chromeCollapse.test.ts`, `NoteModal.tsx`) hands the class-name regex
 * `.test`, `.ts` and `.tsx`, so merely documenting the rule this test guards
 * would turn it red. `confirmDialogUsage.test.ts` strips comments for the same
 * reason; a source scanner has to read code, not prose.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const MODAL = stripComments(readFileSync(join(SRC, 'components', 'NoteModal.tsx'), 'utf8'));
const CSS = stripComments(readFileSync(join(SRC, 'index.css'), 'utf8'));

/** Class names in a selector list, minus the two that scope the rule. */
function classesIn(selector: string): Set<string> {
  return new Set(
    [...selector.matchAll(/\.([a-zA-Z][\w-]*)/g)]
      .map(m => m[1])
      .filter(c => c !== 'note-modal' && c !== 'bottom-hidden')
  );
}

describe('phone chrome collapse', () => {
  it('the JS allowlist names exactly the sections the CSS hides', () => {
    const rule = CSS.match(/([^{}]*\.note-modal\.bottom-hidden[^{}]*)\{\s*display:\s*none;?\s*\}/);
    expect(
      rule,
      'no `.note-modal.bottom-hidden … { display: none }` rule found in index.css — '
      + 'if it was restructured, update this parser AND check the allowlist in NoteModal.tsx',
    ).not.toBeNull();

    const literal = MODAL.match(/BOTTOM_HIDDEN_SECTIONS[^=]*=\s*'([^']*)'/);
    expect(literal, 'BOTTOM_HIDDEN_SECTIONS not found in NoteModal.tsx').not.toBeNull();

    const fromCss = classesIn(rule![1]);
    const fromJs = classesIn(literal![1]);
    expect(fromCss.size, 'the CSS rule hides nothing?').toBeGreaterThan(0);
    expect(
      [...fromJs].sort(),
      'the keyboard collapse declines for a different set of sections than the CSS hides — '
      + 'a section in the CSS but not here loses focus mid-edit when the keyboard opens',
    ).toEqual([...fromCss].sort());
  });

  it('the watcher uses the constant rather than its own copy of the list', () => {
    // The whole point of naming it is that there is one list. An inlined
    // string here would pass the test above while drifting from it.
    expect(MODAL).toMatch(/closest\(BOTTOM_HIDDEN_SECTIONS\)/);
  });

  it('the collapse is two-way, and a deliberate one survives', () => {
    // Without that branch (`if (!up) return;`), nothing but the expand caret
    // would ever set it false again, so one viewport shrink would strip
    // every action off the note for the rest of its life. The keyboard going
    // away restores what the keyboard took; a collapse the person asked for
    // is the exception.
    expect(MODAL, 'the keyboard-down branch no longer re-expands').
      toMatch(/if \(!userCollapsed\(\)\) setBottomHidden\(false\)/);
    // ...and the note does NOT open collapsed. Card hover actions do not exist
    // on touch, so a collapsed open note has no reachable actions at all.
    expect(MODAL).toMatch(/const \[bottomHidden, setBottomHidden\] = createSignal\(false\)/);
  });
});
