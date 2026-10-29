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
import { buildDecorations, atomicRangesOf, blockScanCache } from './markdownDecorations';

/**
 * The atomic subset is what keeps the caret OUT of hidden syntax: a hidden
 * marker run is not drawn, so a caret inside it is invisible and backspace
 * eats characters the user cannot see. These tests pin the filter: hidden
 * markers and replace widgets are atomic; styled VISIBLE text is not.
 */

function decorationsFor(doc: string, mode: 'preview' | 'hybrid') {
  blockScanCache.doc = null;
  blockScanCache.scan = null;
  const state = EditorState.create({ doc, selection: { anchor: doc.length } });
  const view = {
    state,
    visibleRanges: [{ from: 0, to: state.doc.length }],
  } as never;
  return buildDecorations(view, mode as never);
}

function ranges(set: ReturnType<typeof atomicRangesOf>): [number, number][] {
  const out: [number, number][] = [];
  const iter = set.iter();
  while (iter.value) {
    out.push([iter.from, iter.to]);
    iter.next();
  }
  return out;
}

describe('atomicRangesOf', () => {
  it('covers the hidden heading marker in preview mode', () => {
    const atomic = ranges(atomicRangesOf(decorationsFor('## Title', 'preview')));
    // The `## ` marker (0..3) must be atomic so one backspace removes it
    // and the caret can never land inside it.
    expect(atomic).toContainEqual([0, 3]);
  });

  it('covers emphasis markers but NOT the styled text between them', () => {
    const atomic = ranges(atomicRangesOf(decorationsFor('**bold**', 'preview')));
    expect(atomic).toContainEqual([0, 2]);   // opening **
    expect(atomic).toContainEqual([6, 8]);   // closing **
    // The visible word itself stays freely editable.
    expect(atomic).not.toContainEqual([2, 6]);
  });

  it('covers the checkbox replace widget', () => {
    const atomic = ranges(atomicRangesOf(decorationsFor('- [ ] task', 'preview')));
    expect(atomic.some(([from, to]) => from === 0 && to >= 5)).toBe(true);
  });

  it('leaves the caret line free in hybrid mode', () => {
    // Selection sits at the end of the heading line; hybrid reveals it, so
    // nothing on that line is hidden — and nothing there is atomic.
    const atomic = ranges(atomicRangesOf(decorationsFor('## Title', 'hybrid')));
    expect(atomic).toEqual([]);
  });
});

describe('visibleCharsBetween', () => {
  it('counts only unhidden characters on a heading line', async () => {
    const { visibleCharsBetween } = await import('./markdownDecorations');
    const decos = decorationsFor('## Hi', 'preview');
    const atomic = atomicRangesOf(decos);
    expect(visibleCharsBetween(atomic, 0, 5)).toBe(2);   // "Hi"
    expect(visibleCharsBetween(atomic, 3, 5)).toBe(2);   // after the marker
    expect(visibleCharsBetween(atomic, 0, 3)).toBe(0);   // the marker alone
  });

  it('reports zero for a marker-only line', async () => {
    const { visibleCharsBetween } = await import('./markdownDecorations');
    const atomic = atomicRangesOf(decorationsFor('- [ ] x', 'preview'));
    // "- [ ] " replaced by the checkbox widget; only "x" is visible.
    expect(visibleCharsBetween(atomic, 0, 7)).toBe(1);
  });
});

describe('every toolbar insertion is invisible in preview', () => {
  // What each toolbar button leaves in the document around an EMPTY
  // selection, and how many characters may stay visible. Locked as a
  // matrix so a new button (or a broken rule) fails here instead of
  // being discovered tap by tap on a phone.
  const cases: Array<[string, string, number]> = [
    ['bold',          'a ****',      2],  // "a " — all four asterisks hidden
    ['italic',        'a **',        2],
    ['strikethrough', 'a ~~~~',      2],
    ['inline code',   'a ``',        2],
    ['heading',       '# ',          0],
    ['bullet',        '- ',          0],  // replaced by the bullet widget
    ['checklist',     '- [ ] ',      0],  // replaced by the checkbox widget
    ['quote',         '> ',          0],
    ['link',          '[link](https://)', 4],  // the label stays visible
    ['numbered',      '1. ',         3],  // marker VISIBLE by choice (Obsidian too)
  ];

  it.each(cases)('%s: %j leaves %i visible char(s)', async (_name, doc, expected) => {
    const { visibleCharsBetween } = await import('./markdownDecorations');
    const atomic = atomicRangesOf(decorationsFor(doc, 'preview'));
    expect(visibleCharsBetween(atomic, 0, doc.length)).toBe(expected);
  });

  it('empty pairs leave the midpoint as a caret slot (two ranges, not one)', async () => {
    const atomic = ranges(atomicRangesOf(decorationsFor('****', 'preview')));
    expect(atomic).toEqual([[0, 2], [2, 4]]);
  });

  it('real bold is untouched by the empty-pair rules', async () => {
    const atomic = ranges(atomicRangesOf(decorationsFor('**bold**', 'preview')));
    expect(atomic).toEqual([[0, 2], [6, 8]]);
  });
});

describe('the combined empty pair', () => {
  it('****** hides fully with the caret slot at its center', async () => {
    const atomic = ranges(atomicRangesOf(decorationsFor('******', 'preview')));
    expect(atomic).toEqual([[0, 3], [3, 6]]);
  });
  it('***both*** stays a decorated run, markers hidden, content visible', async () => {
    const { visibleCharsBetween } = await import('./markdownDecorations');
    const atomic = atomicRangesOf(decorationsFor('***both***', 'preview'));
    expect(visibleCharsBetween(atomic, 0, 10)).toBe(4);
  });
});

/**
 * An escaped block marker (`\# `, `\- `, `1\. `, `\> `) is prose whose
 * backslash is syntax: hidden, and therefore atomic, like every other marker.
 */
describe('escaped block markers hide their backslash', () => {
  it('in preview the backslash is the only atomic range and the text stays', () => {
    for (const [doc, at] of [['\\# Heading one', 0], ['\\- first item', 0], ['1\\. numbered', 1], ['\\> a quote', 0]] as const) {
      const set = decorationsFor(doc, 'preview');
      expect(ranges(atomicRangesOf(set))).toEqual([[at, at + 1]]);
    }
  });

  it('the line is not decorated as the block it would have been', () => {
    // A hidden heading marker would be a 2-char atomic range at 0; the escaped
    // form must not produce it.
    const set = decorationsFor('\\# Heading one', 'preview');
    expect(ranges(atomicRangesOf(set))).not.toContainEqual([0, 2]);
  });

  it('hybrid reveals it on the caret line like any other syntax', () => {
    const set = decorationsFor('\\# Heading one', 'hybrid');
    expect(ranges(atomicRangesOf(set))).toEqual([]);
  });

  it('a backslash that neutralises nothing is not hidden', () => {
    const set = decorationsFor('C\\# is a language', 'preview');
    expect(ranges(atomicRangesOf(set))).toEqual([]);
  });
});

describe('escaped marker-only lines', () => {
  it('a fence or break line hides only its backslash and nothing else', () => {
    for (const doc of ['\\```', '\\```js', '\\***', '\\---']) {
      const set = decorationsFor(doc, 'preview');
      expect(ranges(atomicRangesOf(set))).toEqual([[0, 1]]);
    }
  });

  it('text after an escaped bullet still gets inline decorations', () => {
    // `\- **bold** x`: the backslash is hidden, and the bold markers are hidden too.
    const set = decorationsFor('\\- **bold** x', 'preview');
    const r = ranges(atomicRangesOf(set));
    expect(r[0]).toEqual([0, 1]);
    expect(r.length).toBeGreaterThan(1);
  });
});
