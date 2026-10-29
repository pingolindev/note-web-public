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
import { toggleInlineMarker } from './inlineToggle';

/**
 * The typical flows people actually do with the B/I/S/code buttons, as
 * state transitions. `|` marks the caret, `[...]` a selection.
 */
function apply(doc: string, marker: string) {
  const caret = doc.indexOf('|');
  const selStart = doc.indexOf('[');
  let state;
  if (caret >= 0) {
    const clean = doc.replace('|', '');
    state = EditorState.create({ doc: clean, selection: { anchor: caret } });
  } else {
    const clean = doc.replace('[', '').replace(']', '');
    const from = selStart;
    const to = doc.indexOf(']') - 1;
    state = EditorState.create({ doc: clean, selection: { anchor: from, head: to } });
  }
  const spec = toggleInlineMarker(state, marker);
  if (!spec) return null;
  const tr = state.update(spec);
  const out = tr.state;
  const sel = out.selection.main;
  const text = out.doc.toString();
  return sel.empty
    ? text.slice(0, sel.head) + '|' + text.slice(sel.head)
    : text.slice(0, sel.from) + '[' + text.slice(sel.from, sel.to) + ']' + text.slice(sel.to);
}

describe('toggleInlineMarker — the flows people actually do', () => {
  // ---- press, type, press again ----
  it('B on empty caret opens a pair with the caret inside', () => {
    expect(apply('a |b', '**')).toBe('a **|**b');
  });
  it('B again before typing removes the pair — never stacks ****', () => {
    expect(apply('a **|**b', '**')).toBe('a |b');
  });
  it('B at the end of typed bold steps OUT, keeping the text bold', () => {
    expect(apply('**hi|** x', '**')).toBe('**hi**| x');
  });
  it('B in the middle of a bold run unwraps the run', () => {
    expect(apply('a **h|i** b', '**')).toBe('a h|i b');
  });

  // ---- selections ----
  it('wrapping a plain selection', () => {
    expect(apply('a [hi] b', '**')).toBe('a **[hi]** b');
  });
  it('unwrapping when the selection is exactly the bold content', () => {
    expect(apply('a **[hi]** b', '**')).toBe('a [hi] b');
  });
  it('unwrapping when the selection includes the markers', () => {
    expect(apply('a [**hi**] b', '**')).toBe('a [hi] b');
  });

  // ---- the same semantics for every symmetric marker ----
  it.each([
    ['*', 'a *|*b', 'a |b'],
    ['~~', 'a ~~|~~b', 'a |b'],
    ['`', 'a `|`b', 'a |b'],
  ])('%s: second press before typing removes the empty pair', (m, doc, want) => {
    expect(apply(doc, m)).toBe(want);
  });
  it.each([
    ['*', '*hi|* x', '*hi*| x'],
    ['~~', '~~hi|~~ x', '~~hi~~| x'],
    ['`', '`hi|` x', '`hi`| x'],
  ])('%s: press at content end exits past the closing marker', (m, doc, want) => {
    expect(apply(doc, m)).toBe(want);
  });

  // ---- italic/bold disambiguation ----
  it('italic mid-bold composes: the whole run becomes bold+italic', () => {
    // Inserting a pair mid-run produces marker soup, so I
    // inside **bold** restyles the run to ***both***.
    expect(apply('**h|i**', '*')).toBe('***h|i***');
  });
  it('bold inside an italic context still toggles bold only', () => {
    expect(apply('a **hi|** b', '**')).toBe('a **hi**| b');
  });

  // ---- markers next to OTHER markers (I after bold must not show **) ----
  it('S at the end of typed bold carries the bold (independent sticky toggles)', () => {
    // Strike does not compose with emphasis (single-pass decorator), so it
    // keeps the exit-then-open semantics.
    expect(apply('**hi|**', '~~')).toBe('**hi****~~|~~**');
  });
  it('S at the end of typed bold carries the bold — second variant', () => {
    expect(apply('**hi|**', '~~')).toBe('**hi****~~|~~**');
  });
  it('B right after an italic run opens adjacent (the pairing parser reads it)', () => {
    expect(apply('*hi*|', '**')).toBe('*hi***|**');
  });
  it('no space when the neighbors are ordinary text', () => {
    expect(apply('hi|', '*')).toBe('hi*|*');
  });

  // ---- full journey: on, typed, off, typed ----
  it('B → type → B → typing continues unstyled', () => {
    let doc = apply('|', '**')!;           // '**|**'
    expect(doc).toBe('**|**');
    // simulate typing "hi" at the caret
    const caret = doc.indexOf('|');
    doc = doc.replace('|', 'hi');
    doc = doc.slice(0, caret + 2) + '|' + doc.slice(caret + 2);   // '**hi|**'
    expect(apply(doc, '**')).toBe('**hi**|');
  });
});

describe('bold and italic COMPOSE (the two-flag emphasis state)', () => {
  it('B then I opens the combined pair', () => {
    expect(apply('a **|**', '*')).toBe('a ***|***');
  });
  it('I then B opens the combined pair', () => {
    expect(apply('a *|*', '**')).toBe('a ***|***');
  });
  it('I again on the combined empty pair drops back to bold', () => {
    expect(apply('a ***|***', '*')).toBe('a **|**');
  });
  it('B on the combined empty pair drops back to italic', () => {
    expect(apply('a ***|***', '**')).toBe('a *|*');
  });
  it('I mid-bold restyles the whole run to bold+italic', () => {
    expect(apply('a **h|i** b', '*')).toBe('a ***h|i*** b');
  });
  it('B mid-combined strips the bold layer from the run', () => {
    expect(apply('a ***h|i*** b', '**')).toBe('a *h|i* b');
  });
  it('I at bold content end continues with bold+italic', () => {
    expect(apply('**hi|**', '*')).toBe('**hi*****|***');
  });
  it('I at combined content end drops italic — continues bold-only', () => {
    expect(apply('a ***hi|*** b', '*')).toBe('a ***hi*****|** b');
  });
});

describe('pressing the button just past a closed run is a no-op', () => {
  // Gboard's suggestion commit parks the caret AFTER the hidden closing
  // markers; opening a padded new pair there would make the cursor
  // visibly jump forward.
  it.each([
    ['**', '**hi**| x'],
    ['*', '*hi*| x'],
    ['~~', '~~hi~~| x'],
    ['`', '`hi`| x'],
  ])('%s just past its run changes nothing', (m, doc) => {
    expect(apply(doc, m)).toBe(doc);
  });
  it('makes a double-fired exit harmless', () => {
    const once = apply('**hi|** x', '**')!;   // exit -> just past closing
    expect(once).toBe('**hi**| x');
    expect(apply(once, '**')).toBe(once);      // second fire: no-op
  });
  it('a DIFFERENT marker just past the run still opens (italic after bold)', () => {
    expect(apply('**hi**|', '*')).toBe('**hi***|*');
  });
});


describe('toggles see structure through adjacency fusions', () => {
  // one,B,two,I,tri then I-off leaves `one**two*****tri***` + `****`
  // fused into seven stars — the lookaround tables see nothing there, so
  // B-off would silently no-op and the next word would stay bold.
  it('B at the fused pending pair removes it', () => {
    const state = EditorState.create({ doc: 'one**two*****tri*******', selection: { anchor: 21 } });
    const spec = toggleInlineMarker(state, '**');
    expect(spec).not.toBe(null);
    const s1 = state.update(spec!).state;
    expect(s1.doc.toString()).toBe('one**two*****tri***');
    expect(s1.selection.main.head).toBe(19);
  });
  it('I at the fused pending pair downgrades it to italic-only', () => {
    const state = EditorState.create({ doc: 'one**two*****tri*******', selection: { anchor: 21 } });
    const spec = toggleInlineMarker(state, '*');
    const s1 = state.update(spec!).state;
    // bold flag stays, italic flips on -> combined *** pair
    expect(s1.doc.toString()).toBe('one**two*****tri***' + '******');
  });
});
