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
 * A hand-typed `**` must stay an opener: the next character belongs AFTER it,
 * not inside it. The toolbar's empty pair keeps the opposite rule.
 *
 * Without that distinction, typing `Some **bold** and more` produces
 * `Some *bold** and more*` in every mode, and a typed fence loses its third
 * backtick — `misplacedInsertSpec`'s second case would teleport the first
 * letter after a typed `**` into the pair's centre, because from the
 * document alone a typed pair and a toolbar pair look identical.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { typedMarkerField, typedDelimiterEnd } from './typedMarker';
import { misplacedInsertSpec } from './previewBackspace';
import { buildDecorations, atomicRangesOf, blockScanCache } from './markdownDecorations';

function stateWith(doc: string, anchor = doc.length) {
  return EditorState.create({ doc, selection: { anchor }, extensions: [typedMarkerField] });
}

function typeChar(state: EditorState, ch: string): EditorState {
  const head = state.selection.main.head;
  return state.update({
    changes: { from: head, to: head, insert: ch },
    selection: { anchor: head + ch.length },
    userEvent: 'input.type',
  }).state;
}

function atomicFor(state: EditorState) {
  blockScanCache.doc = null;
  blockScanCache.scan = null;
  const view = { state, visibleRanges: [{ from: 0, to: state.doc.length }] } as never;
  return atomicRangesOf(buildDecorations(view, 'preview' as never));
}

describe('typedMarkerField', () => {
  it('arms on a typed delimiter and remembers where it ended', () => {
    let st = stateWith('Some ');
    st = typeChar(st, '*');
    expect(st.field(typedMarkerField)).toBe(6);
    st = typeChar(st, '*');
    expect(st.field(typedMarkerField)).toBe(7);
  });

  it('disarms on prose, on a toolbar-shaped change, and on a paste', () => {
    let st = typeChar(stateWith('Some '), '*');
    expect(st.field(typedMarkerField)).toBe(6);
    st = typeChar(st, 'b');
    expect(st.field(typedMarkerField)).toBe(null);

    // The toolbar inserts a whole pair in one change with no input.type label.
    const toggled = stateWith('Some ').update({
      changes: { from: 5, to: 5, insert: '****' }, selection: { anchor: 7 },
    }).state;
    expect(toggled.field(typedMarkerField)).toBe(null);

    const pasted = stateWith('Some ').update({
      changes: { from: 5, to: 5, insert: '*' }, selection: { anchor: 6 }, userEvent: 'input.paste',
    }).state;
    expect(pasted.field(typedMarkerField)).toBe(null);
  });

  it('typedDelimiterEnd names every delimiter family and nothing else', () => {
    for (const ch of ['*', '_', '~', '`']) {
      const tr = stateWith('x').update({
        changes: { from: 1, to: 1, insert: ch }, userEvent: 'input.type',
      });
      expect(typedDelimiterEnd(tr)).toBe(2);
    }
    const prose = stateWith('x').update({ changes: { from: 1, to: 1, insert: 'a' }, userEvent: 'input.type' });
    expect(typedDelimiterEnd(prose)).toBe(null);
    const two = stateWith('x').update({ changes: { from: 1, to: 1, insert: '**' }, userEvent: 'input.type' });
    expect(typedDelimiterEnd(two)).toBe(null);
  });
});

describe('misplacedInsertSpec after typed markers', () => {
  it('leaves the letter after a hand-typed ** where it was typed', () => {
    // `Some **` with the caret at the end, exactly what the keyboard produced.
    const st = stateWith('Some **', 7);
    const atomic = atomicFor(st);
    const change = [{ fromA: 7, toA: 7, inserted: 'b' }];
    // Without the typed-marker signal the toolbar rule fires: `b` goes to 6.
    const relocated = misplacedInsertSpec(st, atomic, change, null);
    expect(relocated).not.toBe(null);
    expect((relocated as { changes: { from: number } }).changes.from).toBe(6);
    // With it — the user just typed the second star — the insert stays put.
    expect(misplacedInsertSpec(st, atomic, change, 7)).toBe(null);
  });

  it('still relocates into a pair the toolbar made', () => {
    // Same document, but the last change was not a typed delimiter.
    const st = stateWith('Some **', 7);
    const atomic = atomicFor(st);
    const spec = misplacedInsertSpec(st, atomic, [{ fromA: 7, toA: 7, inserted: 'b' }], null);
    expect(spec).not.toBe(null);
  });

  it('a typed marker somewhere else does not shield an unrelated pair', () => {
    const st = stateWith('Some **', 7);
    const atomic = atomicFor(st);
    expect(misplacedInsertSpec(st, atomic, [{ fromA: 7, toA: 7, inserted: 'b' }], 3)).not.toBe(null);
  });

  it('the whole sequence types through: ** bold ** stays **bold**', () => {
    // Drive the field and the guard together, the way the editor's filter does.
    let st = stateWith('Some ');
    const type = (ch: string) => {
      const head = st.selection.main.head;
      const atomic = atomicFor(st);
      const typedAt = st.field(typedMarkerField);
      const spec = misplacedInsertSpec(st, atomic, [{ fromA: head, toA: head, inserted: ch }], typedAt);
      const tr = spec
        ? st.update({ ...spec, userEvent: 'input.type' })
        : st.update({ changes: { from: head, to: head, insert: ch }, selection: { anchor: head + 1 }, userEvent: 'input.type' });
      st = tr.state;
    };
    for (const ch of '**bold** and more') type(ch);
    expect(st.doc.toString()).toBe('Some **bold** and more');
  });
});
