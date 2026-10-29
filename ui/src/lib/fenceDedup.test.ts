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

/**
 * Typing your own closing fence must not leave the auto-inserted one behind.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { closingFenceDedupSpec } from './fenceDedup';

function stateWith(doc: string, anchor: number) {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [EditorState.transactionFilter.of((tr) => closingFenceDedupSpec(tr) ?? tr)],
  });
}

function type(state: EditorState, ch: string): EditorState {
  const head = state.selection.main.head;
  return state.update({
    changes: { from: head, to: head, insert: ch },
    selection: { anchor: head + 1 },
    userEvent: 'input.type',
  }).state;
}

describe('closingFenceDedupSpec', () => {
  it('a typed closing fence consumes the auto-inserted one below it', () => {
    // After Enter on ``` the editor produced "```\ncode\n\n```" with the caret
    // on the blank line; the user then types ``` there.
    let st = stateWith('```\ncode\n\n```', 9);
    for (const ch of '```') st = type(st, ch);
    expect(st.doc.toString()).toBe('```\ncode\n```');
  });

  it('leaves two fences alone when nothing above opened a block', () => {
    let st = stateWith('\n```', 0);
    for (const ch of '```') st = type(st, ch);
    expect(st.doc.toString()).toBe('```\n```');
  });

  it('does nothing when the next line is not a bare fence', () => {
    let st = stateWith('```\ncode\n\n```js', 9);
    for (const ch of '```') st = type(st, ch);
    expect(st.doc.toString()).toBe('```\ncode\n```\n```js');
  });

  it('ignores pastes and multi-character inserts', () => {
    const st = EditorState.create({
      doc: '```\ncode\n\n```', selection: { anchor: 9 },
      extensions: [EditorState.transactionFilter.of((tr) => closingFenceDedupSpec(tr) ?? tr)],
    });
    const pasted = st.update({ changes: { from: 9, to: 9, insert: '```' }, userEvent: 'input.paste' }).state;
    expect(pasted.doc.toString()).toBe('```\ncode\n```\n```');
  });
});
