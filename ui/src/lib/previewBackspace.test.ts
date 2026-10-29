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
import { EditorState } from '@codemirror/state';
import { buildDecorations, atomicRangesOf, blockScanCache, visibleCharsBetween } from './markdownDecorations';
import { previewBackspaceSpec } from './previewBackspace';

/** Apply ONE backspace the way the editor does: the preview spec when the
 *  ladder matches, a plain one-char delete otherwise (with the atomic skip
 *  CM would apply — the only atomics left un-handled are line-start markers,
 *  which delete whole). Returns the new state. */
function backspaceOnce(state: EditorState): EditorState {
  blockScanCache.doc = null; blockScanCache.scan = null;
  const line = state.doc.lineAt(state.selection.main.head);
  const fake = { state, visibleRanges: [{ from: line.from, to: line.to }] } as never;
  const atomic = atomicRangesOf(buildDecorations(fake, 'preview'));
  const spec = previewBackspaceSpec(state, atomic);
  if (spec) return state.update(spec).state;
  const head = state.selection.main.head;
  if (head === 0) return state;
  // default: delete one char, or a whole atomic range ending at the caret
  let from = head - 1;
  atomic.between(line.from, line.to, (f, t) => { if (t === head) from = f; });
  return state.update({
    changes: { from, to: head },
    selection: { anchor: from },
    userEvent: 'delete.backward',
  }).state;
}

/** What the user SEES: the doc minus atomic-hidden spans. */
function visibleText(state: EditorState): string {
  blockScanCache.doc = null; blockScanCache.scan = null;
  const line = state.doc.lineAt(0);
  const fake = { state, visibleRanges: [{ from: 0, to: state.doc.length }] } as never;
  const atomic = atomicRangesOf(buildDecorations(fake, 'preview'));
  let out = '';
  for (let i = 0; i < state.doc.length; i++) {
    let hidden = false;
    atomic.between(i, i + 1, (f, t) => { if (i >= f && i < t) hidden = true; });
    if (!hidden) out += state.doc.sliceString(i, i + 1);
  }
  return out;
}

describe('the bold-italic-bold journey deletes with no invisible steps and no raw markers', () => {
  it('walks the exact reported flow backwards cleanly', () => {
    // B type one, I type two, B type three — the toolbar's actual output:
    const doc = '**one** *two* **three**';
    let state = EditorState.create({ doc, selection: { anchor: doc.length - 2 } }); // caret before bold's closing **
    expect(visibleText(state)).toBe('one two three');

    const seen: string[] = [];
    for (let i = 0; i < 20 && state.doc.length > 0; i++) {
      const before = visibleText(state);
      state = backspaceOnce(state);
      const after = visibleText(state);
      seen.push(after);
      // EVERY press changes what the user sees — no swallowed keystrokes.
      expect(after).not.toBe(before);
      // And no press ever exposes a raw marker character.
      expect(after).not.toMatch(/[*~`]/);
      if (state.doc.length === 0) break;
    }
    expect(seen).toEqual([
      'one two thre',
      'one two thr',
      'one two th',
      'one two t',
      'one two ',      // last char of "three" gone; bold's empty pair hides
      'one two',       // the pair dies WITH the separating space — one press
      'one tw',
      'one t',
      'one ',          // italic emptied to a hidden pair
      'one',           // pair + space, one press
      'on',
      'o',
      '',              // last char takes the line's remaining markup
    ]);
    expect(state.doc.toString()).toBe('');
  });

  it('deleting at a closing marker eats the visible char, never the marker', () => {
    const doc = '*two*';
    let state = EditorState.create({ doc, selection: { anchor: 5 } }); // after closing *
    state = backspaceOnce(state);
    expect(state.doc.toString()).toBe('*tw*');
    expect(visibleText(state)).toBe('tw');
  });

  it('heading markers still die by marker (line-start exemption)', () => {
    const doc = '# hi';
    // caret right after the hidden "# " with content following
    let state = EditorState.create({ doc, selection: { anchor: 2 } });
    state = backspaceOnce(state);
    expect(state.doc.toString()).toBe('hi');
  });
});
