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
 * The WIRING, not the rule.
 *
 * `blockEscape.test.ts` proves the rule picks the right offset. It cannot
 * prove a keystroke ever reaches it, and the wiring is where this feature
 * can fail with every unit test still passing: a filter that throws a
 * RangeError on the second character of every heading sends the throw back
 * out through `EditorState.update`, and the character is dropped along with
 * every one after it — typing `# H` leaves `#` in the document.
 *
 * So these drive real transactions one character at a time, the way
 * CodeMirror's input handler does, and read the document back.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdownEscaper } from './markdownEscaper';

/** Type `text` a character at a time, each as its own `input.type`
 *  transaction replacing the selection — what contentEditable input
 *  produces. Returns the final document. */
function type(text: string, escape = true, start = ''): string {
  let state = EditorState.create({
    doc: start,
    selection: { anchor: start.length },
    extensions: [markdownEscaper(() => escape)],
  });
  for (const ch of text) {
    const { from, to } = state.selection.main;
    state = state.update({
      changes: { from, to, insert: ch },
      selection: { anchor: from + ch.length },
      userEvent: 'input.type',
    }).state;
  }
  return state.doc.toString();
}

describe('markdownEscaper', () => {
  describe('escapes a marker the keystroke created', () => {
    it('a heading, keeping everything typed after it', () => {
      expect(type('# H')).toBe('\\# H');
      expect(type('### Heading')).toBe('\\### Heading');
    });

    it('a bullet', () => {
      expect(type('- x')).toBe('\\- x');
      expect(type('* x')).toBe('\\* x');
    });

    it('a quote', () => {
      expect(type('> q')).toBe('\\> q');
    });

    it('an ordered item, at the delimiter', () => {
      expect(type('1. a')).toBe('1\\. a');
    });

    it('a thematic break', () => {
      expect(type('---')).toBe('\\---');
    });

    it('on a second line, leaving the first alone', () => {
      expect(type('# H', true, 'intro\n')).toBe('intro\n\\# H');
    });
  });

  describe('leaves alone what would not form a block', () => {
    it('a hash mid-line', () => {
      expect(type('C# is a language')).toBe('C# is a language');
    });

    it('arithmetic and prose punctuation', () => {
      expect(type('2 * 3 = 6')).toBe('2 * 3 = 6');
      expect(type('a > b')).toBe('a > b');
      expect(type('#hashtag')).toBe('#hashtag');
    });

    it('a second word typed into an already-escaped heading', () => {
      // The line no longer matches once escaped, so nothing can fire twice —
      // but assert it, because a doubled backslash is the obvious way for a
      // "fires only on creation" rule to go wrong.
      expect(type('# Hello there')).toBe('\\# Hello there');
    });

    it('typing into a heading that was ALREADY in the document', () => {
      // The marker predates the keystroke, so it is the user's own markdown
      // and not something this setting gets to rewrite.
      expect(type('x', true, '# H')).toBe('# Hx');
    });
  });

  it('does nothing at all when interpretation is on', () => {
    expect(type('# H', false)).toBe('# H');
    expect(type('- x', false)).toBe('- x');
    expect(type('---', false)).toBe('---');
  });

  it('leaves pasted markdown as markdown', () => {
    // `input.paste`, not `input.type` — pasting a document must give you the
    // document, not a wall of backslashes.
    const state = EditorState.create({ extensions: [markdownEscaper(() => true)] })
      .update({ changes: { from: 0, insert: '# H\n- a\n' }, userEvent: 'input.paste' }).state;
    expect(state.doc.toString()).toBe('# H\n- a\n');
  });

  it('puts the escape and the character in ONE transaction, so undo takes both', () => {
    // The escape must not survive an undo of the keystroke that caused it.
    let state = EditorState.create({
      doc: '#',
      selection: { anchor: 1 },
      extensions: [markdownEscaper(() => true)],
    });
    const tr = state.update({
      changes: { from: 1, insert: ' ' },
      selection: { anchor: 2 },
      userEvent: 'input.type',
    });
    expect(tr.state.doc.toString()).toBe('\\# ');
    // One transaction, so its inverse restores the pre-keystroke document
    // whole — history has nothing else to roll back.
    expect(tr.changes.invert(state.doc).apply(tr.state.doc).toString()).toBe('#');
  });

  it('leaves the caret after the character the user typed', () => {
    const state = EditorState.create({
      doc: '#',
      selection: { anchor: 1 },
      extensions: [markdownEscaper(() => true)],
    }).update({
      changes: { from: 1, insert: ' ' },
      selection: { anchor: 2 },
      userEvent: 'input.type',
    }).state;
    // `\# ` — the caret belongs at the end, not stranded before the backslash.
    expect(state.selection.main.head).toBe(3);
  });
});


describe('markdownEscaper vs toolbar syntax', () => {
  // An italic pair opened by the toolbar at line start, then a space typed
  // inside it: the line looks like a bullet, but the star came from the
  // toolbar, so the escaper must not inject a visible backslash (it would
  // break the pair).
  it('space typed inside a toolbar pair at line start does not escape', () => {
    let state = EditorState.create({
      doc: '**',
      selection: { anchor: 1 },
      extensions: [markdownEscaper(() => true)],
    });
    state = state.update({
      changes: { from: 1, insert: ' ' },
      selection: { anchor: 2 },
      userEvent: 'input.type',
    }).state;
    expect(state.doc.toString()).toBe('* *');
  });
  it('hand-typed literal star + space still escapes', () => {
    let state = EditorState.create({
      doc: '*',
      selection: { anchor: 1 },
      extensions: [markdownEscaper(() => true)],
    });
    state = state.update({
      changes: { from: 1, insert: ' ' },
      selection: { anchor: 2 },
      userEvent: 'input.type',
    }).state;
    expect(state.doc.toString()).toBe('\\* ');
  });
});

describe('markdownEscaper vs multi-line inserts', () => {
  // IME clipboard chips and dictation commit whole passages as input.type.
  // Only the insert's final line would be examined, and escaped, mangling
  // one line of every keyboard-side paste (`- [X] CapitalX task` becoming
  // `\- [X] CapitalX task`).
  it('an input.type insert containing a newline is never escaped', () => {
    let state = EditorState.create({
      doc: '',
      extensions: [markdownEscaper(() => true)],
    });
    state = state.update({
      changes: { from: 0, insert: 'plain text\n- [X] CapitalX task' },
      selection: { anchor: 30 },
      userEvent: 'input.type',
    }).state;
    expect(state.doc.toString()).toBe('plain text\n- [X] CapitalX task');
  });
  it('a bare Enter still escapes nothing and breaks nothing', () => {
    let state = EditorState.create({
      doc: '- [X] done',
      selection: { anchor: 10 },
      extensions: [markdownEscaper(() => true)],
    });
    state = state.update({
      changes: { from: 10, insert: '\n' },
      selection: { anchor: 11 },
      userEvent: 'input.type',
    }).state;
    expect(state.doc.toString()).toBe('- [X] done\n');
  });
});

/**
 * A fence typed by hand must be escaped like every other typed block marker.
 * The toolbar-syntax exemption (a marker whose first character was already
 * hidden syntax) also matches a hand-typed `` `` `` — an empty code pair,
 * hidden and atomic exactly like the toolbar's — so the opening fence could
 * slip through unescaped while the closing one, typed on a fresh line, was
 * escaped: an open code block with a backslashed closer.
 */
describe('a typed fence, with the typed-marker field present', () => {
  it('is escaped at its first backtick', async () => {
    const { typedMarkerField } = await import('./typedMarker');
    let state = EditorState.create({
      doc: '',
      extensions: [typedMarkerField, markdownEscaper(() => true)],
    });
    for (const ch of '```') {
      const { from, to } = state.selection.main;
      state = state.update({
        changes: { from, to, insert: ch },
        selection: { anchor: from + ch.length },
        userEvent: 'input.type',
      }).state;
    }
    expect(state.doc.toString()).toBe('\\```');
  });
});
