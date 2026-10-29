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
 * The CodeMirror wiring for `blockEscapeOffset` — escape markdown the user
 * TYPES, when Preview has "Interpret markdown" off.
 *
 * Its own module, apart from NoteEditor, so the wiring can be tested: the
 * wiring, not the rule, is where this can break — a filter that throws on
 * the second keystroke of every heading swallows the character and every one
 * after it. `@codemirror/state` is DOM-free, so a transaction-level test runs
 * in the plain node env.
 *
 * POSITIONAL, NOT BLANKET. It only fires when a keystroke actually completes
 * a marker — the line has to match a block pattern AFTER the change and not
 * before it. Escaping every `#` on sight would turn "C# is a language" into
 * "C\# is a language", which is both wrong and ugly in the other two modes.
 *
 * TYPING ONLY. `input.type` excludes paste, so pasting a markdown document
 * into a note still gives you the document rather than a wall of backslashes.
 */
import { EditorState, Extension } from '@codemirror/state';
import { blockEscapeOffset } from './blockEscape';
import { buildDecorations, atomicRangesOf } from './markdownDecorations';
import { typedMarkerField } from './typedMarker';
import type { EditorView } from '@codemirror/view';

export function markdownEscaper(shouldEscape: () => boolean): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent('input.type') || !shouldEscape()) return tr;

    const inserts: { from: number; insert: string }[] = [];
    tr.changes.iterChanges((fromA, _toA, _fromB, toB, inserted) => {
      // A newline inside the insert means content TRANSFER, not a keystroke
      // completing a marker: IME clipboard chips and dictation commit whole
      // passages as input.type, and only the insert's FINAL line is examined
      // below (lineAt(toB)), so escaping it would mangle exactly one line of
      // every such paste. A real keystroke never contains a newline (Enter is
      // a bare "\n" and creates no marker on the new line either way).
      if (inserted.toString().includes('\n')) return;
      // `toB` indexes the NEW document, `fromA` the OLD one. Keeping the two
      // coordinate spaces apart is the whole subtlety here: `mapPos` maps a
      // position FORWARD, old to new, so handing it `toB` asks it to map a
      // position it has no room for and it throws `Position N is out of range
      // for changeset of length N-1`. The throw comes back out through
      // `EditorState.update`, so the keystroke never applies at all.
      const line = tr.newDoc.lineAt(toB);
      const off = blockEscapeOffset(line.text);
      if (off < 0) return;
      // Did this keystroke CREATE the marker? The line as it was before the
      // change is simply the old line at the change's old-side start; if it
      // already matched, leave it alone — the user is typing into an existing
      // heading, not making a new one.
      if (blockEscapeOffset(tr.startState.doc.lineAt(fromA).text) >= 0) return;
      // TOOLBAR SYNTAX IS NOT USER TYPING. An italic pair opened by the B/I
      // buttons sits at line start as `**`; the user types a space inside
      // it and the line now LOOKS like `* ` — a bullet — but the star came
      // from the toolbar, not the keyboard. In the pre-change state such
      // syntax is hidden (atomic); a hand-typed literal star is visible.
      // Only escape when the marker's first char was NOT already hidden
      // syntax before this keystroke.
      const oldLine = tr.startState.doc.lineAt(fromA);
      const markerPos = tr.changes.invertedDesc.mapPos(line.from + off, -1);
      // …unless the hidden syntax is a pair the user TYPED a moment ago: two
      // backticks from the keyboard are an empty code pair, hidden and atomic
      // exactly like the toolbar's, so a hand-typed fence would slip through
      // this exemption while its closing fence three lines later did not — an
      // open fence with an escaped closer. `typedMarkerField` knows which it
      // was.
      const typedAt = tr.startState.field(typedMarkerField, false) ?? null;
      const typedPair = typedAt !== null && typedAt === fromA;
      if (!typedPair && markerPos !== null && markerPos >= oldLine.from && markerPos < oldLine.to) {
        const fake = {
          state: tr.startState,
          visibleRanges: [{ from: oldLine.from, to: oldLine.to }],
        } as unknown as EditorView;
        const atomic = atomicRangesOf(buildDecorations(fake, 'preview'));
        let hidden = false;
        atomic.between(oldLine.from, oldLine.to, (a, b) => {
          if (markerPos >= a && markerPos < b) { hidden = true; return false; }
        });
        if (hidden) return;
      }
      inserts.push({ from: line.from + off, insert: '\\' });
    });
    if (!inserts.length) return tr;

    // A second change spec on the SAME transaction, so undo takes the escape
    // back with the character rather than leaving a lone backslash behind.
    // `sequential` puts the offsets above in the post-change document, which
    // is where they were measured. Returning [tr, spec] is the sanctioned
    // shape: a filter is typed
    // `(tr) => TransactionSpec | readonly TransactionSpec[]`, and a
    // Transaction is itself a valid spec.
    return [tr, { changes: inserts, sequential: true, userEvent: 'input.type' }];
  });
}
