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
import { toggleInlineMarker } from './inlineToggle';
import { renderMarkdown } from './markdown';
import { caretSnapAnchor } from './markdownDecorations';
import { previewBackspaceSpec, imeVisibleRemapSpec, misplacedInsertSpec, bulletFlipGuardSpec, newlineSplitGuardSpec } from './previewBackspace';
import { activeInlineStyles, pendingExitField, pendingExitEffect } from './inlineToggle';

/**
 * Property coverage for preview-mode editing. Mistakes here hide in positions
 * and sequences no hand-written case visits, so instead of enumerating flows
 * this sweeps EVERY legal caret position of a document zoo for every toggle,
 * types after each, backspaces from everywhere, and runs seeded random
 * interaction sequences — all against the invariants that define the mode:
 *
 *   I1  No toggle or backspace ever leaves a marker character visible.
 *   I2  The caret never lands strictly inside hidden syntax.
 *   I3  Typing after any toggle puts the typed character on screen.
 *   I4  A backspace on a non-empty document always changes it.
 *   I5  No operation explodes the document (bounded growth).
 *
 * Failures print the seed / document / position / op history, so any red
 * here is immediately reproducible.
 */

const MARKERS = ['**', '*', '~~', '`'] as const;

/** I1 is RENDERER-RELATIVE: preview may show a marker char only where the
 *  card renderer also shows one as literal text. `* *` really is a bullet
 *  whose content is a literal `*` (verified against renderMarkdown), so a
 *  blanket "no visible stars" invariant flags correct markdown. What preview
 *  must never do is SHOW a char the renderer treats as syntax. */
function markerCount(text: string): number {
  return (text.match(/[*~`]/g) ?? []).length;
}
/** A line-start ``` fence shows its raw syntax in preview while
 *  renderMarkdown hides fence markers entirely. Fuzz paths that BUILD a
 *  fence via repeated inline code toggles trip I1 on that block-level
 *  disagreement, so fence-bearing docs are exempt from I1 (I2/I5 still
 *  apply). Fence parity belongs to the block layer, not to inline editing. */
function hasFenceLine(doc: string): boolean {
  return /^ {0,3}```/m.test(doc);
}

function rendererMarkerBudget(doc: string): number {
  const html = renderMarkdown(doc);
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return markerCount(text);
}

function analyze(state: EditorState) {
  blockScanCache.doc = null; blockScanCache.scan = null;
  const fake = { state, visibleRanges: [{ from: 0, to: state.doc.length }] } as never;
  const atomic = atomicRangesOf(buildDecorations(fake, 'preview'));
  const ranges: Array<{ from: number; to: number }> = [];
  atomic.between(0, state.doc.length, (from, to) => { ranges.push({ from, to }); });
  let visible = '';
  for (let i = 0; i < state.doc.length; i++) {
    if (!ranges.some(r => i >= r.from && i < r.to)) visible += state.doc.sliceString(i, i + 1);
  }
  const legal = (pos: number) => !ranges.some(r => pos > r.from && pos < r.to);
  const visibleBetween = (a: number, b: number) => {
    let n = 0;
    for (let i = a; i < b; i++) if (!ranges.some(r => i >= r.from && i < r.to)) n++;
    return n;
  };
  return { atomic, ranges, visible, legal, visibleBetween };
}

function legalPositions(state: EditorState): number[] {
  const { legal } = analyze(state);
  const out: number[] = [];
  for (let p = 0; p <= state.doc.length; p++) if (legal(p)) out.push(p);
  return out;
}

const at = (doc: string, anchor: number, head = anchor) =>
  EditorState.create({ doc, selection: { anchor, head } });

/** Mirror of the runtime's caret-snap transactionFilter in NoteEditor: any
 *  edit can reparse the line and strand the caret inside an atomic range;
 *  the editor snaps it to the nearest edge, so the model must too. */
function snapCaret(state: EditorState): EditorState {
  // The runtime's own snap helper — the harness MUST share it: a hand-rolled
  // equivalent here could pass while the shipped code throws on every dispatch.
  const snapped = caretSnapAnchor(state.doc, state.selection.main.head);
  return snapped === null
    ? state
    : state.update({ selection: { anchor: snapped } }).state;
}

function applyToggle(state: EditorState, marker: string): EditorState {
  const spec = toggleInlineMarker(state, marker);
  return spec ? snapCaret(state.update(spec).state) : state;
}

function applyBackspace(state: EditorState): EditorState {
  const { atomic } = analyze(state);
  const spec = previewBackspaceSpec(state, atomic);
  if (spec) return snapCaret(state.update(spec).state);
  const head = state.selection.main.head;
  if (head === 0) return state;
  let from = head - 1;
  atomic.between(0, state.doc.length, (f, t) => { if (t === head) from = f; });
  // Mirror the runtime: a default delete whose range touches hidden text
  // is clamped to visible positions (imeVisibleRemapSpec).
  const clamped = imeVisibleRemapSpec(state, atomic, [{ fromA: from, toA: head, inserted: '' }]);
  return snapCaret(state.update(clamped ?? {
    changes: { from, to: head },
    selection: { anchor: from },
    userEvent: 'delete.backward',
  }).state);
}

function typeChar(state: EditorState, ch: string): EditorState {
  const head = state.selection.main.head;
  return snapCaret(state.update({
    changes: { from: head, insert: ch },
    selection: { anchor: head + 1 },
    userEvent: 'input.type',
  }).state);
}

const ZOO = [
  // Closer + trailing empty pair around a space
  'both***bold*** ****',
  'x **** y',
  '*ital*~~~~',
  '**bold** *ital* ~~~~',
  'x ****',
  '***bold*** ****',
  'both***bold*******',

  '', 'hi', 'hello world',
  '**hi**', '*hi*', '~~hi~~', '`hi`', '***hi***',
  '****', '**', '~~~~', '``', '******',
  '**a** *b*', '**a**~~b~~', 'x **a** y', '*a* `b` ~~c~~',
  '# hi', '> quoted', '- [ ] task', '- item',
  'plain\n**bold**', '# head\n*it*',
];

describe('toggle sweep: every marker at every legal position of the zoo', () => {
  for (const doc of ZOO) {
    it(`doc ${JSON.stringify(doc)}`, () => {
      for (const pos of legalPositions(EditorState.create({ doc }))) {
        for (const marker of MARKERS) {
          const ctx = `doc=${JSON.stringify(doc)} pos=${pos} marker=${marker}`;
          const s1 = applyToggle(at(doc, pos), marker);
          const a1 = analyze(s1);
          if (!hasFenceLine(s1.doc.toString())) expect(markerCount(a1.visible), `I1 after toggle: ${ctx} -> ${JSON.stringify(s1.doc.toString())} visible=${JSON.stringify(a1.visible)}`).toBeLessThanOrEqual(rendererMarkerBudget(s1.doc.toString()));
          expect(a1.legal(s1.selection.main.head), `I2 after toggle: ${ctx} -> ${JSON.stringify(s1.doc.toString())} caret=${s1.selection.main.head}`).toBe(true);
          expect(s1.doc.length, `I5 after toggle: ${ctx}`).toBeLessThanOrEqual(doc.length + 12);

          // Toggle twice from the same spot: still clean, still bounded.
          const s2 = applyToggle(s1, marker);
          const a2 = analyze(s2);
          if (!hasFenceLine(s2.doc.toString())) expect(markerCount(a2.visible), `I1 after double toggle: ${ctx} -> ${JSON.stringify(s2.doc.toString())}`).toBeLessThanOrEqual(rendererMarkerBudget(s2.doc.toString()));
          expect(s2.doc.length, `I5 after double toggle: ${ctx}`).toBeLessThanOrEqual(doc.length + 24);

          // Type after the toggle: the character must be visible.
          const s3 = typeChar(s1, 'z');
          const a3 = analyze(s3);
          expect(a3.visible.includes('z'), `I3: ${ctx} -> ${JSON.stringify(s3.doc.toString())} visible=${JSON.stringify(a3.visible)}`).toBe(true);
          if (!hasFenceLine(s3.doc.toString())) expect(markerCount(a3.visible), `I1 after toggle+type: ${ctx} -> ${JSON.stringify(s3.doc.toString())}`).toBeLessThanOrEqual(rendererMarkerBudget(s3.doc.toString()));
        }
      }
    });
  }
});

describe('backspace sweep: from every legal position of the zoo', () => {
  for (const doc of ZOO) {
    if (!doc) continue;
    it(`doc ${JSON.stringify(doc)}`, () => {
      for (const pos of legalPositions(EditorState.create({ doc }))) {
        if (pos === 0) continue;
        const ctx = `doc=${JSON.stringify(doc)} pos=${pos}`;
        const s0 = at(doc, pos);
        const s1 = applyBackspace(s0);
        const a1 = analyze(s1);
        // I4 exemption: with NOTHING visible before the caret (a leading
        // hidden opener, e.g. `*hi*` at pos 1), the correct behavior at the
        // top of the note is an explicit no-op — deleting the opener alone
        // would orphan its closing marker into raw text.
        const a0 = analyze(s0);
        const visibleBefore = a0.visibleBetween ? a0.visibleBetween(0, pos) : null;
        if (visibleBefore !== 0) {
          expect(s1.doc.toString() === doc, `I4: backspace changed nothing: ${ctx}`).toBe(false);
        }
        if (!hasFenceLine(s1.doc.toString())) expect(markerCount(a1.visible), `I1 after backspace: ${ctx} -> ${JSON.stringify(s1.doc.toString())} visible=${JSON.stringify(a1.visible)}`).toBeLessThanOrEqual(rendererMarkerBudget(s1.doc.toString()));
        expect(a1.legal(s1.selection.main.head), `I2 after backspace: ${ctx} -> ${JSON.stringify(s1.doc.toString())}`).toBe(true);
      }
    });
  }
});

describe('IME recomposition replaces touch only visible text', () => {
  // Gboard rewrites the word around the caret on backspace, and the word
  // IT sees includes hidden markers. For `word ~~gon~~` it sends a
  // composition replace [5,10) -> "go", which eats the opening ~~ and
  // orphans the closer as raw text.
  function remap(doc: string, fromA: number, toA: number, inserted: string) {
    const state = at(doc, toA);
    const { atomic } = analyze(state);
    const spec = imeVisibleRemapSpec(state, atomic, [{ fromA, toA, inserted }]);
    return spec ? state.update(spec).state : null;
  }
  it('a backspace that rewrites the word: markers survive', () => {
    const s1 = remap('word ~~gon~~', 5, 10, 'go');
    expect(s1).not.toBe(null);
    expect(s1!.doc.toString()).toBe('word ~~go~~');
    const a = analyze(s1!);
    expect(a.visible).toBe('word go');
    expect(a.legal(s1!.selection.main.head)).toBe(true);
  });
  it('identity rewrite keeps the doc intact', () => {
    const s1 = remap('word ~~gon~~', 5, 10, 'gon');
    expect(s1!.doc.toString()).toBe('word ~~gon~~');
  });
  it('autocorrect across both markers', () => {
    const s1 = remap('~~teh~~', 0, 7, 'the');
    expect(s1!.doc.toString()).toBe('~~the~~');
  });
  it('composition delete eating g~~ is clamped to the g', () => {
    const state = at('word ~~g~~', 8);
    const { atomic } = analyze(state);
    const spec = imeVisibleRemapSpec(state, atomic, [{ fromA: 7, toA: 10, inserted: '' }]);
    expect(spec).not.toBe(null);
    const s1 = state.update(spec!).state;
    expect(s1.doc.toString()).toBe('word ~~~~');
    expect(analyze(s1).visible).toBe('word ');
  });
  it('replace confined to visible text passes through untouched (null)', () => {
    // No hidden overlap -> the raw change is already correct.
    const st = at('hi **word**', 9);
    const { atomic } = analyze(st);
    expect(imeVisibleRemapSpec(st, atomic, [{ fromA: 5, toA: 9, inserted: 'word ' }])).toBe(null);
    expect(imeVisibleRemapSpec(st, atomic, [{ fromA: 5, toA: 9, inserted: 'ward' }])).toBe(null);
  });
  it('span across both markers: only the diff applies', () => {
    const s1 = remap('hi**word**', 0, 10, 'hi word');
    const a = analyze(s1!);
    expect(a.visible).toBe('hi word');
    expect(s1!.doc.toString()).toContain('**');
  });
  it('no hidden overlap -> null (zero-cost path)', () => {
    const state = at('plain text', 6);
    const { atomic } = analyze(state);
    expect(imeVisibleRemapSpec(state, atomic, [{ fromA: 2, toA: 6, inserted: 'ai' }])).toBe(null);
  });
});

describe('empty pair against a hidden closer dies with a VISIBLE char', () => {
  // Bold word, italic word, strike word; backspace the strike word; the
  // next press must not "delete something but the cursor doesn't move".
  // The pair sits against the italic run's closer, and rule (a) would
  // delete only invisible text. The walk keeps the run markers, takes
  // the pair, and always lands one visible deletion.
  it('*ital*~~~~ center press -> *ita*', () => {
    const st = at('*ital*~~~~', 8);
    const { atomic } = analyze(st);
    const spec = previewBackspaceSpec(st, atomic);
    expect(spec).not.toBe(null);
    const s1 = st.update(spec!).state;
    expect(s1.doc.toString()).toBe('*ita*');
    expect(analyze(s1).visible).toBe('ita');
  });
  it('fully hidden pure delete is blocked, not passed through', () => {
    const st = at('*ital*~~~~', 8);
    const { atomic } = analyze(st);
    // What the IME default would do at the pair center: delete one tilde.
    const spec = imeVisibleRemapSpec(st, atomic, [{ fromA: 7, toA: 8, inserted: '' }]);
    expect(spec).not.toBe(null);
    const s1 = st.update(spec!).state;
    expect(s1.doc.toString()).toBe('*ital*~~~~');
  });
});

describe('inserts snapped past hidden syntax come home to the caret', () => {
  // B inserts `****`, CM's caret sits at the center (4), but Chrome
  // snaps the DOM caret past the contenteditable=false cluster and the
  // first keystroke lands at 6 — after the closer. Bold would never apply
  // and the empty pair would lurk in front of the word.
  it('insert displaced across only-hidden territory remaps to the caret', () => {
    const st = at('hi****', 4);
    const { atomic } = analyze(st);
    const spec = misplacedInsertSpec(st, atomic, [{ fromA: 6, toA: 6, inserted: 'w' }]);
    expect(spec).not.toBe(null);
    const s1 = st.update(spec!).state;
    expect(s1.doc.toString()).toBe('hi**w**');
    expect(s1.selection.main.head).toBe(5);
  });
  it('insert with visible text between stays put (null)', () => {
    const st = at('hi**x**', 4);
    const { atomic } = analyze(st);
    expect(misplacedInsertSpec(st, atomic, [{ fromA: 7, toA: 7, inserted: 'w' }])).toBe(null);
  });
  it('insert at the caret is untouched (null)', () => {
    const st = at('hi****', 4);
    const { atomic } = analyze(st);
    expect(misplacedInsertSpec(st, atomic, [{ fromA: 4, toA: 4, inserted: 'w' }])).toBe(null);
  });
  it('selection slipped too: insert just past an empty pair teleports to its center', () => {
    // Chrome parks the DOM caret past the cluster AND CM adopts it as a
    // labeled 'select' — head === fromA === 6. The empty pair is
    // invisible, so typing "just past it" cannot be deliberate.
    const st = at('hi****', 6);
    const { atomic } = analyze(st);
    const spec = misplacedInsertSpec(st, atomic, [{ fromA: 6, toA: 6, inserted: 'w' }]);
    expect(spec).not.toBe(null);
    const s1 = st.update(spec!).state;
    expect(s1.doc.toString()).toBe('hi**w**');
    expect(s1.selection.main.head).toBe(5);
  });
  it('insert after a real content run stays put (null)', () => {
    const st = at('hi**x**', 7);
    const { atomic } = analyze(st);
    expect(misplacedInsertSpec(st, atomic, [{ fromA: 7, toA: 7, inserted: 'w' }])).toBe(null);
  });
});

describe('space-first inside a line-start italic pair does not become a bullet', () => {
  // I at line start, then space -> the line reads `* …`, every markdown
  // parser calls it a bullet, and the pair's closer orphans as a raw star.
  // The pair dissolves instead.
  it('dissolves the pair, keeps the space', () => {
    const st = at('**', 1);
    const { atomic } = analyze(st);
    const spec = bulletFlipGuardSpec(st, atomic, [{ fromA: 1, toA: 1, inserted: ' ' }]);
    expect(spec).not.toBe(null);
    const s1 = st.update(spec!).state;
    expect(s1.doc.toString()).toBe(' ');
    expect(s1.selection.main.head).toBe(1);
  });
  it('mid-line italic pair is untouched (null)', () => {
    const st = at('hi **', 4);
    const { atomic } = analyze(st);
    expect(bulletFlipGuardSpec(st, atomic, [{ fromA: 4, toA: 4, inserted: ' ' }])).toBe(null);
  });
  it('bold pair at line start is untouched (null — `** ` is no bullet)', () => {
    const st = at('****', 2);
    const { atomic } = analyze(st);
    expect(bulletFlipGuardSpec(st, atomic, [{ fromA: 2, toA: 2, inserted: ' ' }])).toBe(null);
  });
  it('letter-first insert is untouched (null)', () => {
    const st = at('**', 1);
    const { atomic } = analyze(st);
    expect(bulletFlipGuardSpec(st, atomic, [{ fromA: 1, toA: 1, inserted: 'x' }])).toBe(null);
  });
});

describe('Enter inside a run closes and reopens it', () => {
  function split(doc: string, pos: number) {
    const st = at(doc, pos);
    const spec = newlineSplitGuardSpec(st, [{ fromA: pos, toA: pos, inserted: '\n' }]);
    return spec ? st.update(spec).state.doc.toString() : null;
  }
  it('mid-strike: both halves stay valid runs', () => {
    expect(split('~~a b~~', 4)).toBe('~~a ~~\n~~b~~');
  });
  it('at content end: reopened side is an empty pair', () => {
    expect(split('**b**', 3)).toBe('**b**\n****');
  });
  it('bold-italic composed run', () => {
    expect(split('***xy***', 4)).toBe('***x***\n***y***');
  });
  it('outside any run: plain newline (null)', () => {
    expect(split('plain', 3)).toBe(null);
  });
  it('browser swallows the trailing space: replace-shape still guarded', () => {
    // Tap after 'a', Enter: the DOM edit collapses the trailing space and
    // CM diffs it as replace [3,4) -> newline. The space survives on the
    // new line.
    const st = at('~~a ~~', 3);
    const spec = newlineSplitGuardSpec(st, [{ fromA: 3, toA: 4, inserted: '\n' }]);
    expect(spec).not.toBe(null);
    expect(st.update(spec!).state.doc.toString()).toBe('~~a~~\n~~ ~~');
  });
  it('Enter at the center of an empty pair dissolves it', () => {
    const st = at('``', 1);
    const { atomic } = analyze(st);
    const spec = newlineSplitGuardSpec(st, [{ fromA: 1, toA: 1, inserted: '\n' }], atomic);
    expect(spec).not.toBe(null);
    expect(st.update(spec!).state.doc.toString()).toBe('\n');
  });
  it('nested empty pairs dissolve as a cascade', () => {
    // code pair opened at a strike pair's center; Enter at the code
    // center must dissolve BOTH layers, not strand ~~ on each line.
    const st = at('~~``~~', 3);
    const { atomic } = analyze(st);
    const spec = newlineSplitGuardSpec(st, [{ fromA: 3, toA: 3, inserted: '\n' }], atomic);
    expect(spec).not.toBe(null);
    const s1 = st.update(spec!).state;
    // the strike parses as a content run around the code pair, so the
    // split leaves an invisible empty strike pair per line — the
    // invariant is NO RAW MARKERS, and both shapes satisfy it
    expect(s1.doc.toString()).toBe('~~~~\n~~~~');
    expect(/[~\`]/.test(analyze(s1).visible)).toBe(false);
  });
  it('pair inside a content run: dissolve pair, close/reopen the run', () => {
    const st = at('*a``b*', 3);
    const { atomic } = analyze(st);
    const spec = newlineSplitGuardSpec(st, [{ fromA: 3, toA: 3, inserted: '\n' }], atomic);
    expect(spec).not.toBe(null);
    expect(st.update(spec!).state.doc.toString()).toBe('*a*\n*b*');
  });
  it('Enter at the center of an empty bold pair dissolves it', () => {
    const st = at('x****', 3);
    const { atomic } = analyze(st);
    const spec = newlineSplitGuardSpec(st, [{ fromA: 3, toA: 3, inserted: '\n' }], atomic);
    expect(st.update(spec!).state.doc.toString()).toBe('x\n');
  });
  it('Samsung commit-merged newline: `w` -> `w\\n` inside code', () => {
    // HoneyBoard re-commits the composed char WITH the newline in one
    // replace. Without normalization the code span would swallow a raw \n.
    const st = at(' ao`w`', 5);
    const { atomic } = analyze(st);
    const spec = newlineSplitGuardSpec(st, [{ fromA: 4, toA: 5, inserted: 'w\n' }], atomic);
    expect(spec).not.toBe(null);
    expect(st.update(spec!).state.doc.toString()).toBe(' ao`w`\n``');
  });
  it('the strike split around a trailing space leaves both lines clean', () => {
    const after = split('~~a ~~', 3);
    expect(after).toBe('~~a~~\n~~ ~~');
    const st = EditorState.create({ doc: after! });
    // both lines parse clean — no visible tildes
    const a = analyze(st);
    expect(/[~]/.test(a.visible)).toBe(false);
  });
});

describe('emphasis toggles are no-ops inside code spans', () => {
  // B inside `` `x` `` must not print literal stars into the code content.
  // Code is literal — nothing styles inside it.
  it('B inside code content: no-op', () => {
    const st = at('`hi`', 2);
    const spec = toggleInlineMarker(st, '**');
    expect(spec?.changes ?? null).toBeNull();
    expect(st.update(spec!).state.doc.toString()).toBe('`hi`');
  });
  it('S at the center of an empty code pair: no-op', () => {
    const st = at('``', 1);
    const spec = toggleInlineMarker(st, '~~');
    expect(st.update(spec!).state.doc.toString()).toBe('``');
  });
  it('code toggle inside code still works (exit/unwrap semantics)', () => {
    const st = at('`hi`', 4);
    const spec = toggleInlineMarker(st, '`');
    expect(spec).not.toBe(null);
  });
  it('B outside a code span still opens a pair', () => {
    const st = at('`hi` ', 5);
    const spec = toggleInlineMarker(st, '**');
    expect(st.update(spec!).state.doc.toString()).toBe('`hi` ****');
  });
});

describe('activeInlineStyles drives the toolbar pressed state', () => {
  const styles = (doc: string, pos: number) => activeInlineStyles(at(doc, pos));
  it('inside bold content', () => {
    expect(styles('**word**', 4)).toMatchObject({ bold: true, italic: false });
  });
  it('composed run reports both', () => {
    expect(styles('***both***', 5)).toMatchObject({ bold: true, italic: true });
  });
  it('empty pair center = pending format', () => {
    expect(styles('hi****', 4)).toMatchObject({ bold: true });
    expect(styles('hi``', 3)).toMatchObject({ code: true });
  });
  it('adjacent runs: bold word then pending combined pair (the no-pad flow)', () => {
    // word,B,word,I: the I press composes -> `***`+`***` lands right
    // after the bold closer; caret at the combined pair's center.
    // doc = word ** bold ** ****** -> 8 stars from position 10.
    expect(styles('word**bold********', 15)).toMatchObject({ bold: true, italic: true });
  });
  it('adjacent pending pair right after the closer lights both (the after-I instant)', () => {
    // one**two** + ****** — caret at the combined pair's center
    expect(styles('one**two********', 13)).toMatchObject({ bold: true, italic: true });
  });
  it('plain text: nothing active', () => {
    expect(styles('plain', 3)).toMatchObject({ bold: false, italic: false, strike: false, code: false });
  });
});

describe('pendingExitField: the un-bold press survives DOM caret parking', () => {
  const mk = (doc: string, anchor: number) =>
    EditorState.create({ doc, selection: { anchor }, extensions: [pendingExitField] });
  it('arms via effect, survives a nearby slip, clears on a far move', () => {
    let st = mk('**word**', 6);
    st = st.update({ selection: { anchor: 8 }, effects: pendingExitEffect.of(8) }).state;
    expect(st.field(pendingExitField)).toBe(8);
    // the browser re-parks the caret at 6 — armed state survives
    st = st.update({ selection: { anchor: 6 } }).state;
    expect(st.field(pendingExitField)).toBe(8);
    // a deliberate far move disarms
    st = st.update({ selection: { anchor: 1 } }).state;
    expect(st.field(pendingExitField)).toBe(null);
  });
  it('clears on any doc change', () => {
    let st = mk('**word**', 6);
    st = st.update({ effects: pendingExitEffect.of(8) }).state;
    st = st.update({ changes: { from: 8, insert: 'x' } }).state;
    expect(st.field(pendingExitField)).toBe(null);
  });
});

describe('caretSnapAnchor runs on a real Text doc (production path)', () => {
  it('snaps a caret inside a bullet widget and passes legal carets through', () => {
    const st = EditorState.create({ doc: '* *' });
    // pos 1 is strictly inside the bullet replace widget [0,2)
    expect(caretSnapAnchor(st.doc, 1)).not.toBe(null);
    expect(caretSnapAnchor(st.doc, 2)).toBe(null);
    // empty doc, boundary positions — must not throw
    expect(caretSnapAnchor(EditorState.create({ doc: '' }).doc, 0)).toBe(null);
  });
});

// Deterministic PRNG so failures replay exactly.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('random interaction sequences hold the invariants', () => {
  it('500 seeded sequences of 18 ops', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = mulberry32(seed);
      let state = EditorState.create({ doc: '' });
      const history: string[] = [];
      for (let step = 0; step < 18; step++) {
        const r = rnd();
        if (r < 0.35) {
          const m = MARKERS[Math.floor(rnd() * MARKERS.length)];
          history.push(`toggle(${m})`);
          state = applyToggle(state, m);
        } else if (r < 0.6) {
          const ch = 'abcdefgh  '[Math.floor(rnd() * 10)];
          history.push(`type(${JSON.stringify(ch)})`);
          state = typeChar(state, ch);
        } else if (r < 0.8) {
          history.push('backspace');
          state = applyBackspace(state);
        } else if (r < 0.85) {
          // Gboard word recomposition: replace the raw span back to the
          // nearest space/line-start (markers included, exactly what the
          // IME sees) with its VISIBLE text minus the last char.
          const head = state.selection.main.head;
          const line = state.doc.lineAt(head);
          let a = head;
          while (a > line.from && head - a < 8 && state.doc.sliceString(a - 1, a) !== ' ') a--;
          if (a < head) {
            const an = analyze(state);
            let vis = '';
            for (let i = a; i < head; i++) {
              if (!an.ranges.some(rr => i >= rr.from && i < rr.to)) vis += state.doc.sliceString(i, i + 1);
            }
            const inserted = vis.slice(0, -1);
            history.push(`imeRecompose(${a},${head},${JSON.stringify(inserted)})`);
            const spec = imeVisibleRemapSpec(state, an.atomic, [{ fromA: a, toA: head, inserted }]);
            state = snapCaret(state.update(spec ?? {
              changes: { from: a, to: head, insert: inserted },
              selection: { anchor: a + inserted.length },
              userEvent: 'input.type',
            }).state);
          } else {
            history.push('imeRecompose(noop)');
          }
        } else {
          // Caret hop to a random legal position (what a tap does).
          const ps = legalPositions(state);
          const p = ps[Math.floor(rnd() * ps.length)];
          history.push(`caret(${p})`);
          state = state.update({ selection: { anchor: p } }).state;
        }
        const a = analyze(state);
        const ctx = `seed=${seed} step=${step} history=[${history.join(', ')}] doc=${JSON.stringify(state.doc.toString())} visible=${JSON.stringify(a.visible)} head=${state.selection.main.head} ranges=${JSON.stringify(a.ranges)}`;
        if (!hasFenceLine(state.doc.toString())) expect(markerCount(a.visible), `I1: ${ctx}`).toBeLessThanOrEqual(rendererMarkerBudget(state.doc.toString()));
        expect(a.legal(state.selection.main.head), `I2: ${ctx}`).toBe(true);
        expect(state.doc.length, `I5: ${ctx}`).toBeLessThanOrEqual(200);
      }
    }
  });
});
