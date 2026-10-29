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
 * CodeMirror 6 markdown editor with Obsidian-style live preview.
 *
 * Markdown syntax is hidden by default — decorations render bold, italic,
 * headers, lists, checkboxes, code blocks inline. When the cursor moves
 * to a line, the raw markdown is revealed for that line only.
 *
 * Toggle "Show markdown" to see raw syntax everywhere.
 */

import { Component, onMount, onCleanup, createEffect } from 'solid-js';
import { EditorState, StateEffect, StateField, RangeSet, RangeSetBuilder, Compartment, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType, keymap, gutter, GutterMarker } from '@codemirror/view';
import { markdown, markdownLanguage, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { LanguageDescription } from '@codemirror/language';

// Hand-picked code-fence languages, instead of @codemirror/language-data
// — that package's `languages` array eagerly imports LanguageDescription
// metadata for ~80 languages (and pulls a sizable transitive footprint
// into the NoteEditor chunk) even though the parsers themselves are
// lazy. Most of those (Brainfuck, COBOL, ECL, Crystal, etc.) are pure
// dead weight for a notes app.
//
// The set below covers the common "tech notes" cases. Each entry's
// `load` is a dynamic import, so an unused language never reaches the
// browser — Vite emits one chunk per parser, lazy-loaded on first
// render of a matching code fence.
const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx'], extensions: ['js', 'jsx'], load: () => import('@codemirror/lang-javascript').then(m => m.javascript()) }),
  LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], extensions: ['ts', 'tsx'], load: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true, jsx: true })) }),
  LanguageDescription.of({ name: 'python', alias: ['py'], extensions: ['py'], load: () => import('@codemirror/lang-python').then(m => m.python()) }),
  LanguageDescription.of({ name: 'rust', alias: ['rs'], extensions: ['rs'], load: () => import('@codemirror/lang-rust').then(m => m.rust()) }),
  LanguageDescription.of({ name: 'go', extensions: ['go'], load: () => import('@codemirror/lang-go').then(m => m.go()) }),
  LanguageDescription.of({ name: 'java', extensions: ['java'], load: () => import('@codemirror/lang-java').then(m => m.java()) }),
  LanguageDescription.of({ name: 'cpp', alias: ['c++', 'c', 'cxx', 'h'], extensions: ['cpp', 'cxx', 'cc', 'c', 'h', 'hpp'], load: () => import('@codemirror/lang-cpp').then(m => m.cpp()) }),
  LanguageDescription.of({ name: 'php', extensions: ['php'], load: () => import('@codemirror/lang-php').then(m => m.php()) }),
  LanguageDescription.of({ name: 'sql', extensions: ['sql'], load: () => import('@codemirror/lang-sql').then(m => m.sql()) }),
  LanguageDescription.of({ name: 'json', extensions: ['json'], load: () => import('@codemirror/lang-json').then(m => m.json()) }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], extensions: ['yaml', 'yml'], load: () => import('@codemirror/lang-yaml').then(m => m.yaml()) }),
  LanguageDescription.of({ name: 'xml', extensions: ['xml'], load: () => import('@codemirror/lang-xml').then(m => m.xml()) }),
  LanguageDescription.of({ name: 'html', extensions: ['html', 'htm'], load: () => import('@codemirror/lang-html').then(m => m.html()) }),
  LanguageDescription.of({ name: 'css', extensions: ['css'], load: () => import('@codemirror/lang-css').then(m => m.css()) }),
];
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, undo, redo } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, codeFolding, foldKeymap, foldable, foldedRanges, foldEffect, unfoldEffect } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { sanitizeHtml } from '../lib/sanitizeHtml';
import { settingsStore, EditorMode } from '../stores/settings';
import { markdownEscaper } from '../lib/markdownEscaper';
import { notebooksStore } from '../stores/notebooks';
import { resolveMode } from '../lib/editorModeOverrides';
// y-codemirror.next pulls in yjs + y-protocols (~150 kB). Lazy
// load it only when this editor is bound to a Y.Text (i.e. only
// inside NoteModal's collab session). The notes-grid composer
// never collaborates, so the cost should never reach those users.
type YCollab = typeof import('y-codemirror.next').yCollab;

// Syntax highlight theme for code blocks
const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c678dd' },
  { tag: tags.string, color: '#98c379' },
  { tag: tags.number, color: '#d19a66' },
  { tag: tags.bool, color: '#d19a66' },
  { tag: tags.null, color: '#d19a66' },
  { tag: tags.comment, color: '#7f848e', fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#61afef' },
  { tag: tags.typeName, color: '#e5c07b' },
  { tag: tags.className, color: '#e5c07b' },
  { tag: tags.definition(tags.variableName), color: '#e06c75' },
  { tag: tags.propertyName, color: '#e06c75' },
  { tag: tags.operator, color: '#56b6c2' },
  { tag: tags.punctuation, color: '#abb2bf' },
  { tag: tags.bracket, color: '#abb2bf' },
  { tag: tags.meta, color: '#abb2bf' },
  { tag: tags.tagName, color: '#e06c75' },
  { tag: tags.attributeName, color: '#d19a66' },
  { tag: tags.attributeValue, color: '#98c379' },
  { tag: tags.regexp, color: '#98c379' },
  // No colour for escapes: with "Interpret markdown" off every typed block
  // marker is stored as `\#`, and tinting the `#` cyan would make a literal
  // character look like syntax in the one mode that promises it is text.
  { tag: tags.self, color: '#e06c75' },
]);

export interface EditorHandle {
  wrapSelection: (before: string, after: string) => void;
  insertLinePrefix: (prefix: string) => void;
  insertBlock: (before: string, after: string) => void;
  /** Step the caret line's heading level 1→2→…→6→none→1. */
  cycleHeading: () => void;
  /** Put a `---` thematic break on its own line below the caret. */
  insertDivider: () => void;
  /** Wrap the selection as a link, leaving the URL selected to type over. */
  insertLink: () => void;
  undo: () => void;
  redo: () => void;
  /** Replace the whole document (draft restore after a crash). Dispatches a
   *  normal change, so onChange fires and — on a collab note — the edit
   *  propagates through the Yjs binding like any keystroke. */
  setContent: (text: string) => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** The note being edited, when there is one. Only a saved note can carry a
   *  mode pin — the composer's note has no id until it is first saved, so it
   *  always follows the global. */
  noteId?: string;
  placeholder?: string;
  onReady?: (handle: EditorHandle) => void;
  /** Fired when the caret's active inline styles change — drives the
   *  toolbar's pressed-state highlighting. */
  onStylesChange?: (styles: ActiveInlineStyles) => void;
  /** When provided, bind editor text to this Y.Text via y-codemirror.next. */
  yText?: import('yjs').Text;
  /** y-protocols/awareness instance for presence. Optional. */
  awareness?: any;
}



// Decoration logic lives in lib/markdownDecorations.ts so it can be unit
// tested — see the note at the top of that file.
import {
  MathWidget, movedLine, blockScanCache, buildDecorations, atomicRangesOf, visibleCharsBetween, caretSnapAnchor,
} from '../lib/markdownDecorations';
import { toggleInlineMarker, activeInlineStyles, pendingExitField, pendingExitEffect, type ActiveInlineStyles } from '../lib/inlineToggle';
import { typedMarkerField } from '../lib/typedMarker';
import { closingFenceDedupSpec } from '../lib/fenceDedup';
import { previewBackspaceSpec, imeVisibleRemapSpec, misplacedInsertSpec, bulletFlipGuardSpec, newlineSplitGuardSpec, onlyHiddenBetween } from '../lib/previewBackspace';

// --- Table helpers ---
// A pipe-table row is a line that starts and ends with `|` once trimmed.
// We don't try to validate the separator row — Tab/Enter just navigate
// between `|` boundaries on whatever the user typed.
function isTableRow(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

/** Index positions of `|` characters in a row. */
function pipePositions(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '|') out.push(i);
  return out;
}

/** Build a blank row that matches `templateRow`'s column count, with a
 *  single space inside each cell so the cursor has somewhere to land. */
function blankRowFor(templateRow: string): string {
  const pipes = pipePositions(templateRow);
  const cells = pipes.length - 1;
  if (cells <= 0) return '|  |';
  return '|' + ' '.repeat(2).repeat(0) + Array(cells).fill('  ').join('|') + '|';
}

// --- Commands ---

/** Toggle the `[ ]`/`[x]` on the current line. If the line isn't already
 *  a checklist item, prepend `- [ ] `. Bound to Mod-Enter. */
function toggleCheckbox(view: EditorView): boolean {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  const text = line.text;
  const checked = text.match(/^(\s*)- \[x\] /);
  if (checked) {
    view.dispatch({
      changes: { from: line.from + checked[1].length, to: line.from + checked[0].length, insert: '- [ ] ' },
    });
    return true;
  }
  const unchecked = text.match(/^(\s*)- \[ \] /);
  if (unchecked) {
    view.dispatch({
      changes: { from: line.from + unchecked[1].length, to: line.from + unchecked[0].length, insert: '- [x] ' },
    });
    return true;
  }
  // Not a checklist item yet — promote it.
  const indent = text.match(/^\s*/)?.[0] ?? '';
  view.dispatch({
    changes: { from: line.from + indent.length, to: line.from + indent.length, insert: '- [ ] ' },
    selection: { anchor: head + 6 },
  });
  return true;
}

/** Tab in a table row jumps to the start of the next cell. At the last
 *  cell of the last row, inserts a new row and parks the cursor in its
 *  first cell. Returns false outside table context so Tab falls through
 *  to `indentMore`. */
function tableTabNext(view: EditorView): boolean {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  if (!isTableRow(line.text)) return false;
  const pipes = pipePositions(line.text);
  const offset = head - line.from;
  const next = pipes.find(p => p > offset);
  if (next !== undefined && next !== pipes[pipes.length - 1]) {
    // Land just inside the next cell (after `| `). If no space follows,
    // land right after the pipe.
    const after = line.text[next + 1] === ' ' ? next + 2 : next + 1;
    view.dispatch({ selection: { anchor: line.from + after } });
    return true;
  }
  // At/past the last pipe — move to next row's first cell, creating a
  // new row if there isn't one.
  if (line.number < view.state.doc.lines) {
    const nextLine = view.state.doc.line(line.number + 1);
    if (isTableRow(nextLine.text)) {
      const nextPipes = pipePositions(nextLine.text);
      const after = nextLine.text[nextPipes[0] + 1] === ' ' ? nextPipes[0] + 2 : nextPipes[0] + 1;
      view.dispatch({ selection: { anchor: nextLine.from + after } });
      return true;
    }
  }
  const blank = blankRowFor(line.text);
  view.dispatch({
    changes: { from: line.to, insert: '\n' + blank },
    selection: { anchor: line.to + 1 + (blank.indexOf('|') + (blank[1] === ' ' ? 2 : 1)) },
  });
  return true;
}

/** Shift-Tab in a table row jumps to the start of the previous cell. */
function tableTabPrev(view: EditorView): boolean {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  if (!isTableRow(line.text)) return false;
  const pipes = pipePositions(line.text);
  const offset = head - line.from;
  // Find the pipe that immediately precedes the cursor's cell — we want
  // the one *before* that.
  let curIdx = -1;
  for (let i = 0; i < pipes.length; i++) {
    if (pipes[i] >= offset) break;
    curIdx = i;
  }
  if (curIdx <= 0) return true; // already in first cell — swallow Tab
  const target = pipes[curIdx - 1];
  const after = line.text[target + 1] === ' ' ? target + 2 : target + 1;
  view.dispatch({ selection: { anchor: line.from + after } });
  return true;
}

/**
 * Enter inside a list.
 *
 * `nonTightLists: false` is what makes pressing Enter twice end a list.
 * CodeMirror's DEFAULT behaviour on an empty item of a TIGHT two-item list
 * is documented as "insert a blank line above that item, starting a
 * non-tight list" — spec-aware, and not remotely what anyone pressing
 * Enter twice means. It produces `"- item\n\n- "`: a blank line and an
 * orphan marker the user then has to delete by hand. Every other markdown
 * editor, Obsidian included, deletes the marker and ends the list, which is
 * what this flag selects.
 */
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

// Editor mode state: regular | markdown | preview
const editorModeEffect = StateEffect.define<EditorMode>();
const editorModeField = StateField.define<EditorMode>({
  create: () => settingsStore.settings().editorMode,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(editorModeEffect)) return e.value;
    }
    return value;
  },
});

/** Build the block-replace decorations for `$$…$$` math blocks.
 *  Block decorations CANNOT be provided through a ViewPlugin facet
 *  (CodeMirror throws "Block decorations may not be specified via
 *  plugins" during layout), so they live in their own StateField
 *  whose `provide` wires the decoration set directly into the
 *  EditorView.decorations facet.
 *
 *  In markdown mode this returns Decoration.none (raw source).
 *  In hybrid mode, the math block containing the cursor is left
 *  un-replaced so the user can edit the LaTeX source; other math
 *  blocks render as KaTeX widgets. In preview mode, every math
 *  block renders via widget regardless of cursor position. */
function buildMathBlockDecorations(state: EditorState): DecorationSet {
  const mode = state.field(editorModeField);
  if (mode === 'markdown') return Decoration.none;
  const doc = state.doc;
  const cursor = state.selection.main.head;
  const cursorLine = doc.lineAt(cursor).number;
  const revealCursorLine = mode === 'hybrid';

  const builder = new RangeSetBuilder<Decoration>();
  let inMathBlock = false;
  let blockStart = 0;
  let mathContent: string[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (inMathBlock) {
      if (/^\$\$\s*$/.test(text)) {
        // Close fence — flush the block. Off-cursor blocks get
        // a block-replace widget covering `$$\nLaTeX\n$$\n` (the
        // trailing newline is included so the widget consumes the
        // whole block + its closer; spans the line BREAK after the
        // closer when not the final line, otherwise stops at closer
        // line end).
        const cursorInThisBlock = revealCursorLine
          && cursorLine >= blockStart && cursorLine <= i;
        if (!cursorInThisBlock) {
          const openerLine = doc.line(blockStart);
          const to = i < doc.lines ? doc.line(i + 1).from : doc.line(i).to;
          builder.add(openerLine.from, to, Decoration.replace({
            widget: new MathWidget(mathContent.join('\n'), true),
            block: true,
          }));
        }
        inMathBlock = false;
        mathContent = [];
      } else {
        mathContent.push(text);
      }
      continue;
    }
    if (/^\$\$\s*$/.test(text)) {
      blockStart = i;
      inMathBlock = true;
      mathContent = [];
    }
  }
  return builder.finish();
}

const mathBlockDecorationsField = StateField.define<DecorationSet>({
  create: state => buildMathBlockDecorations(state),
  update(value, tr) {
    const modeChanged =
      tr.startState.field(editorModeField) !== tr.state.field(editorModeField);
    // Recompute on doc change, a cursor move that CHANGES LINE (crossing into
    // or out of a math block reveals/hides the widget), or a mode flip.
    //
    // Not on bare `tr.selection`: that is set by every arrow key, including
    // moves within one line, and buildMathBlockDecorations walks the whole
    // document — about 2.45ms per keypress on a 20,000-line note, on a
    // desktop. Being a StateField it runs inside `state.update()`, ahead of
    // everything else in the frame.
    //
    // Line granularity is what the output actually depends on: the widget is
    // revealed by the cursor being *in* a math block, and a block is a run of
    // whole lines. Unlike the inline decorations this cannot be viewport-scoped
    // — block decorations must come from a StateField, which has no view.
    const movedToAnotherLine = tr.selection
      ? tr.startState.doc.lineAt(tr.startState.selection.main.head).number
        !== tr.state.doc.lineAt(tr.state.selection.main.head).number
      : false;
    if (tr.docChanged || movedToAnotherLine || modeChanged) {
      return buildMathBlockDecorations(tr.state);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

// --- Custom fold gutter ---
//
// CodeMirror's `foldGutter()` paired with lang-markdown puts a fold
// caret next to every list item: lang-markdown's `foldNodeProp` adds
// a generic "fold any Block that isn't a heading or list container"
// rule, and ListItem nodes pass that filter. Overriding the node prop
// from outside the parser does not reliably win, so we render our
// own gutter that ignores list-item lines entirely. Headings and
// code-block fences still get a marker.

class ChevronMarker extends GutterMarker {
  constructor(private isOpen: boolean) { super(); }
  eq(other: GutterMarker) {
    return other instanceof ChevronMarker && other.isOpen === this.isOpen;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = `cm-md-foldmarker ${this.isOpen ? 'open' : 'closed'}`;
    span.setAttribute('aria-label', this.isOpen ? 'Fold' : 'Unfold');
    span.innerHTML =
      '<svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,1.5 6.5,4.5 3,7.5"/></svg>';
    return span;
  }
}

/** Lines we never want a fold caret on, regardless of what the
 *  markdown parser thinks. The parser's grammar surfaces a foldable
 *  ListItem for each `-`/`*`/`+`/`N.` line and would otherwise paint a
 *  caret next to every bullet. */
const LIST_LINE = /^\s*([-*+]|\d+\.)\s/;

function listAwareFoldGutter() {
  const canFold = new ChevronMarker(true);
  const canUnfold = new ChevronMarker(false);

  const markersPlugin = ViewPlugin.fromClass(
    class {
      markers: RangeSet<GutterMarker>;
      constructor(view: EditorView) {
        this.markers = this.build(view);
      }
      update(update: ViewUpdate) {
        // NOT on selectionSet. Nothing build() reads depends on where the
        // cursor is — it looks at the doc, the viewport and the fold state —
        // and rebuilding on selection would re-run foldable() over every visible
        // line on every arrow-key press, and foldable() walks the syntax tree:
        // work proportional to the screenful, on a keypress that changed nothing
        // it depends on.
        //
        // Folding is picked up explicitly rather than via selection, because a
        // fold can be applied by a command that changes neither the document
        // nor the viewport.
        const foldChanged = update.transactions.some(tr =>
          tr.effects.some(e => e.is(foldEffect) || e.is(unfoldEffect)),
        );
        if (update.docChanged || update.viewportChanged || foldChanged) {
          this.markers = this.build(update.view);
        }
      }
      build(view: EditorView): RangeSet<GutterMarker> {
        const builder = new RangeSetBuilder<GutterMarker>();
        const folded = foldedRanges(view.state);
        for (const block of view.viewportLineBlocks) {
          const line = view.state.doc.lineAt(block.from);
          if (LIST_LINE.test(line.text)) continue;
          let isFolded = false;
          folded.between(block.from, block.from, () => { isFolded = true; });
          if (isFolded) {
            builder.add(block.from, block.from, canUnfold);
          } else if (foldable(view.state, block.from, block.to)) {
            builder.add(block.from, block.from, canFold);
          }
        }
        return builder.finish();
      }
    },
  );

  return [
    markersPlugin,
    gutter({
      class: 'cm-foldGutter',
      markers: (view) =>
        view.plugin(markersPlugin)?.markers ?? RangeSet.empty,
      initialSpacer: () => canFold,
      domEventHandlers: {
        click(view, line) {
          // Toggle fold on the clicked line. Mirrors the stock
          // foldGutter's click handler.
          const folded = (() => {
            let found: { from: number; to: number } | null = null;
            foldedRanges(view.state).between(line.from, line.from, (from, to) => {
              found = { from, to };
            });
            return found;
          })();
          if (folded) {
            view.dispatch({ effects: unfoldEffect.of(folded) });
            return true;
          }
          const range = foldable(view.state, line.from, line.to);
          if (range) {
            view.dispatch({ effects: foldEffect.of(range) });
            return true;
          }
          return false;
        },
      },
    }),
  ];
}

// On Android Chrome >=126 CodeMirror drives the IME through the
// EditContext API — and feeds it the RAW DOCUMENT text
// (state.doc.sliceString in EditContextManager), markers included. The
// keyboard's prediction engine literally reads `**bold** ~~gone~~`, word
// recomposition thinks hidden syntax is part of the word, and deletes
// target characters the user cannot see. No hook filters that text, so
// EditContext is disabled: the classic contenteditable path derives IME
// text from the DOM, where replace decorations leave ONLY visible text.
// (With EditContext, IME selection offsets match literal marker counts —
// italic *x| reports 2, bold **x| reports 3; the DOM contains neither.)
(EditorView as unknown as { EDIT_CONTEXT: boolean }).EDIT_CONTEXT = false;

/** No-op effect whose only job is to force a real view update — an empty
 *  dispatch may not deliver one, and the coverage check below can only
 *  run inside an update. */
const decoPingEffect = StateEffect.define<null>();

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations!: DecorationSet;
    atomic!: DecorationSet;
    builtFrom = 0;
    builtTo = 0;
    builtMode: EditorMode | null = null;
    constructor(view: EditorView) {
      this.rebuild(view);
    }
    rebuild(view: EditorView) {
      this.builtMode = view.state.field(editorModeField);
      this.decorations = buildDecorations(view, view.state.field(editorModeField));
      this.atomic = atomicRangesOf(this.decorations);
      const vr = view.visibleRanges;
      this.builtFrom = vr.length ? vr[0].from : 0;
      this.builtTo = vr.length ? vr[vr.length - 1].to : 0;
      // A build during a relayout (mode switch + keyboard) can see a
      // COLLAPSED or PARTIAL viewport (e.g. only line 2 in range,
      // leaving line 1 permanently raw); the coverage check above only
      // runs inside a LATER update, and with no interaction none may
      // come. When the built span covers less than the current
      // viewport, schedule ONE ping dispatch — a guaranteed real update
      // in which the coverage check re-runs against the settled layout.
      const vp = view.viewport;
      if (this.builtTo - this.builtFrom < vp.to - vp.from || !vr.length) {
        setTimeout(() => {
          try { view.dispatch({ effects: decoPingEffect.of(null) }); } catch { /* view gone */ }
        }, 80);
      }
    }
    update(update: ViewUpdate) {
      const modeChanged =
        update.state.field(editorModeField) !== update.startState.field(editorModeField);
      // COVERAGE: a rebuild that ran while a relayout (mode switch, the
      // keyboard) had part of the doc outside visibleRanges leaves those
      // lines permanently undecorated if nothing else changes — the
      // viewport can re-expand without another viewportChanged-flagged
      // update reaching us, leaving a line raw until any caret move.
      // Rebuild whenever the viewport exceeds what the last build covered.
      const uncovered = update.view.visibleRanges.some(
        r => r.from < this.builtFrom || r.to > this.builtTo);
      // BACKSTOP: whatever race made us miss a transition (for example a
      // hybrid-shaped set left under a preview field, healed only by a caret
      // move), a set built under a different mode than the current field is
      // stale by definition.
      const modeStale = this.builtMode !== update.state.field(editorModeField);
      if (update.docChanged || update.viewportChanged || modeChanged || uncovered || modeStale) {
        this.rebuild(update.view);
        return;
      }
      // A selection change only matters when it lands on a DIFFERENT line:
      // hybrid mode reveals raw syntax on the cursor's line, and nothing else
      // here depends on where within that line the cursor sits. Rebuilding on
      // every move along a line — every left/right arrow, every character
      // typed — would redo the whole decoration set for no visible change.
      if (update.selectionSet && movedLine(update)) {
        this.rebuild(update.view);
      }
    }

    /**
     * Drop the cached scan when the editor goes away.
     *
     * The cache holds a reference to the document's `Text`, which IS the note's
     * plaintext. Keeping it after the editor closes would leave one note's
     * decrypted content reachable for no reason — the cache exists to make
     * cursor movement cheap while editing, not to outlive the editor.
     */
    destroy() {
      blockScanCache.doc = null;
      blockScanCache.scan = null;
    }
  },
  {
    decorations: v => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  }
);

const NoteEditor: Component<Props> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  /** The mode this editor is actually in: the note's pin if it has one, the
   *  global default otherwise. Reactive in both — flipping the global moves
   *  every un-pinned note, and pinning moves just this one. */
  const effectiveMode = (): EditorMode =>
    resolveMode(notebooksStore.editorModes(), props.noteId, settingsStore.settings().editorMode);
  // Compartment that holds the yCollab extension. Empty until the
  // lazy import resolves; reconfigured to the real extension once
  // y-codemirror.next is available.
  const collabCompartment = new Compartment();

  // An ACTIVE IME composition wedges everything a toolbar action does:
  // CodeMirror defers decoration changes around the composition, and Gboard
  // can hold an EMPTY composition open (type + backspace), so a toggle
  // dispatched into it renders its markers raw — and stays raw while the
  // composition lives. Blur/refocus commits the composition (standard Android
  // IME behavior) before the action dispatches.
  const settleComposition = () => {
    if (view && view.composing) {
      view.contentDOM.blur();
      view.focus();
    }
  };

  /**
   * Wrap (or toggle) the selection in a pair of markers.
   *
   * Shared by the `props.onReady` handle and the KEYMAP: the modal's toolbar
   * advertises `title="Bold (Ctrl+B)"` and `title="Italic (Ctrl+I)"`, and the
   * keymap below binds them. Binding the shortcut to the same function the
   * button calls is the only way the two cannot drift — a separate keymap
   * implementation would be another subsystem with its own idea of what a
   * toggle is, which is precisely the class of inconsistency inlineToggle.ts
   * and the pairing parser exist to end.
   */
  const wrapSelection = (before: string, after: string) => {
    if (!view) return;
    settleComposition();
    // Symmetric markers (B/I/S/code) TOGGLE: a second press closes or
    // unwraps instead of stacking a fresh pair — see inlineToggle.ts
    // for the decision table and its scenario tests.
    if (before === after) {
      const spec = toggleInlineMarker(view.state, before);
      if (spec) {
        view.dispatch(spec);
        // Any toggle can leave the caret against a hidden closer
        // (the exit's past-closer position, or a pair-removal's
        // anchor right after a run) — positions the DOM cannot
        // hold: the browser re-parks the caret inside the cluster
        // and the next word re-enters the style. When the
        // post-dispatch anchor touches hidden syntax, ARM the
        // pending exit so typing lands where the toggle put it.
        const head = view.state.selection.main.head;
        const line = view.state.doc.lineAt(head);
        const fakeA = {
          state: view.state,
          visibleRanges: [{ from: line.from, to: line.to }],
        } as never;
        const atomicA = atomicRangesOf(buildDecorations(fakeA, 'preview'));
        let touches = false;
        atomicA.between(Math.max(0, head - 4), head, (_f, t) => {
          if (t === head) { touches = true; return false; }
        });
        if (touches) view.dispatch({ effects: pendingExitEffect.of(head) });
        view.focus();
        return;
      }
    }
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: before + selected + after },
      selection: { anchor: from + before.length, head: from + before.length + selected.length },
    });
    view.focus();
  };

  onMount(() => {
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        // `addKeymap: false` — OUR Enter must be the only Enter.
        //
        // `markdown()` otherwise pushes `Prec.high(keymap.of(markdownKeymap))`,
        // and that keymap binds Enter to the DEFAULT
        // `insertNewlineContinueMarkup`. High precedence beats the plain
        // `keymap.of([...])` below, so inside any list or quote the app's own
        // Enter handler would never run: not the table-row insert, not the
        // preview prefix guard, and not the `nonTightLists: false` command
        // that ends a list.
        // The markdown Backspace is re-added by hand further down.
        markdown({ base: markdownLanguage, codeLanguages, addKeymap: false }),
        // Preview Backspace runs as a TRANSACTION FILTER, not a keymap:
        // Android IMEs delete via beforeinput/deleteContentBackward, which
        // never reaches keymap bindings — a keymap-only version would work with
        // synthetic key events and do nothing under Gboard. The filter sees
        // every deletion regardless of origin and recomputes the intended
        // edit from the start state (see lib/previewBackspace.ts).
        EditorState.transactionFilter.of((tr) => {
          if (!tr.docChanged) return tr;
          if (tr.startState.field(editorModeField) !== 'preview') return tr;
          if (!tr.startState.selection.main.empty) return tr;
          // Not only `delete.backward`: Gboard's deletes — especially around
          // an active composition — reach CodeMirror as DOM-diff edits that
          // classify as generic input, not as the delete command. Gate on the
          // SHAPE instead: exactly one removed range, nothing inserted,
          // ending at the caret. Plain visible-text deletes fall through the
          // ladder unchanged, so the broad gate is safe.
          let imeReplace: Array<{ fromA: number; toA: number; inserted: string }> | null = null;
          if (!tr.isUserEvent('delete.backward')) {
            let ranges = 0, pureDelete = true, endsAtCaret = false;
            const head = tr.startState.selection.main.head;
            const collected: Array<{ fromA: number; toA: number; inserted: string }> = [];
            tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
              ranges += 1;
              if (inserted.length > 0 || toA <= fromA) pureDelete = false;
              if (toA === head) endsAtCaret = true;
              collected.push({ fromA, toA, inserted: inserted.toString() });
            });
            if (ranges !== 1 || !pureDelete || !endsAtCaret) {
              // Not a bare backspace. Gboard's word RECOMPOSITION arrives
              // as a replace (`~~gon` -> `go`) that swallows hidden
              // markers — remap it to visible text only. Only for typed /
              // composition input; toolbar toggles, undo, paste keep
              // their deliberate marker edits. EXCEPTION: a single
              // newline-shaped change (Enter comes via the keymap command
              // path as userEvent 'input') flows on to the run-split
              // guard below.
              const newlineShaped = ranges === 1 && collected[0].inserted === '\n';
              if (!newlineShaped && !tr.isUserEvent('input.type')) return tr;
              imeReplace = collected;
            }
          }
          // Cover every changed line, not just the caret's — a composition
          // replace can straddle.
          const head0 = tr.startState.selection.main.head;
          const spanFrom = imeReplace
            ? Math.min(head0, ...imeReplace.map(c => c.fromA)) : head0;
          const spanTo = imeReplace
            ? Math.max(head0, ...imeReplace.map(c => c.toA)) : head0;
          const line = tr.startState.doc.lineAt(spanFrom);
          const lineEnd = tr.startState.doc.lineAt(spanTo);
          const fake = {
            state: tr.startState,
            visibleRanges: [{ from: line.from, to: lineEnd.to }],
          } as never;
          const atomic = atomicRangesOf(buildDecorations(fake, 'preview'));
          // Enter arrives via the keymap COMMAND path (userEvent 'input'),
          // not as IME text — run the split guard for any single
          // newline-shaped change, whatever its label.
          {
            const nl: Array<{ fromA: number; toA: number; inserted: string }> = [];
            let nlOnly = true;
            tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
              nl.push({ fromA, toA, inserted: inserted.toString() });
              if (inserted.toString() !== '\n') nlOnly = false;
            });
            if (nlOnly && nl.length === 1) {
              const split = newlineSplitGuardSpec(tr.startState, nl, atomic);
              if (split) return split;
            }
          }
          if (imeReplace) {
            // Armed pending exit: a typed insert at or inside the exited
            // run's closer belongs PAST it.
            const exitAt = tr.startState.field(pendingExitField, false) ?? null;
            if (exitAt !== null && imeReplace.length === 1) {
              const c0 = imeReplace[0];
              if (c0.fromA === c0.toA && c0.inserted && !c0.inserted.includes('\n')
                  && c0.fromA <= exitAt && exitAt - c0.fromA <= 4
                  && onlyHiddenBetween(atomic, c0.fromA, exitAt)) {
                return {
                  changes: { from: exitAt, to: exitAt, insert: c0.inserted },
                  selection: { anchor: exitAt + c0.inserted.length },
                  userEvent: 'input.type',
                };
              }
            }
            const flip = bulletFlipGuardSpec(tr.startState, atomic, imeReplace);
            if (flip) return flip;
            const displaced = misplacedInsertSpec(
              tr.startState, atomic, imeReplace, tr.startState.field(typedMarkerField, false) ?? null);
            if (displaced) return displaced;
            const remapped = imeVisibleRemapSpec(tr.startState, atomic, imeReplace);
            return remapped ?? tr;
          }
          const spec = previewBackspaceSpec(tr.startState, atomic);
          if (spec) return spec;
          // The ladder has no opinion: only a plain visible-char delete is
          // expected here. A composition delete can still arrive with a
          // RANGE that swallows markers (`g~~` in one press, classified
          // delete.backward.compose) — clamp it to visible text.
          const collected2: Array<{ fromA: number; toA: number; inserted: string }> = [];
          tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
            collected2.push({ fromA, toA, inserted: inserted.toString() });
          });
          const clamped = imeVisibleRemapSpec(tr.startState, atomic, collected2);
          return clamped ?? tr;
        }),
        // Caret-legality invariant: an edit can REPARSE the line (deleting
        // `h` from `*h****** *` leaves `* *`, which is suddenly a bullet
        // item) and strand the caret strictly inside a hidden range or a
        // widget the new parse created. CM's atomicRanges only guard cursor
        // MOTION, not transaction-set selections, and a caret inside hidden
        // syntax is exactly the "cursor disappeared, typing goes somewhere
        // invisible" report. Snap to the nearest edge after every change.
        EditorState.transactionFilter.of((tr) => {
          if (!tr.docChanged) return tr;
          if (tr.startState.field(editorModeField) !== 'preview') return tr;
          const sel = tr.newSelection.main;
          if (!sel.empty) return tr;
          const snapped = caretSnapAnchor(tr.newDoc, sel.head);
          if (snapped === null) return tr;
          return [tr, { selection: { anchor: snapped }, sequential: true }];
        }),
        syntaxHighlighting(codeHighlightStyle),
        history(),
        closeBrackets(),
        codeFolding(),
        // Custom fold gutter. The stock `foldGutter()` would put a
        // caret next to every list item because lang-markdown marks
        // ListItem as foldable. Overriding the `foldNodeProp` from
        // outside didn't reliably win against the parser's baked-in
        // rule, so we render our own markers and skip lines that
        // start with a list-marker glyph (-, *, +, or N.).
        listAwareFoldGutter(),
        // Paste handler: when clipboard text is a URL and the user has a
        // selection, wrap the selection in markdown link syntax.
        EditorView.domEventHandlers({
          paste(e, view) {
            const clip = e.clipboardData?.getData('text/plain') ?? '';
            const trimmed = clip.trim();
            if (!trimmed) return false;
            if (!/^https?:\/\/\S+$/i.test(trimmed)) return false;
            const { from, to } = view.state.selection.main;
            if (from === to) return false; // no selection — paste as-is
            const selected = view.state.sliceDoc(from, to);
            e.preventDefault();
            view.dispatch({
              changes: { from, to, insert: `[${selected}](${trimmed})` },
              selection: { anchor: from + 1, head: from + 1 + selected.length },
            });
            return true;
          },
        }),
        // Auto-close code blocks: when user types ``` and presses Enter,
        // insert closing ``` and place cursor between them
        keymap.of([
          { key: 'Mod-Enter', run: toggleCheckbox },
          // Bold and italic: the modal's toolbar advertises "Bold (Ctrl+B)" and
          // "Italic (Ctrl+I)" in its tooltips, and these bindings provide them. They
          // run the SAME `wrapSelection` the buttons call, so the toggle
          // semantics (press-on/press-off, I composing over bold, the pending
          // pair and its exit) are one implementation, not two.
          //
          // Returning true is what stops the browser's own Ctrl+B/Ctrl+I,
          // which in a contenteditable would otherwise insert <b>/<i> tags
          // into CodeMirror's DOM behind its back.
          { key: 'Mod-b', run: () => { wrapSelection('**', '**'); return true; } },
          { key: 'Mod-i', run: () => { wrapSelection('*', '*'); return true; } },
          { key: 'Tab', run: (v) => tableTabNext(v) || indentMore(v) },
          { key: 'Shift-Tab', run: (v) => tableTabPrev(v) || indentLess(v) },
          {
            key: 'Enter',
            run(view) {
              const mode = view.state.field(editorModeField);
              const { head } = view.state.selection.main;
              const line = view.state.doc.lineAt(head);
              const offset = head - line.from;

              // Table row Enter: append a new row with the same column
              // count and park the cursor in the first cell.
              if (head === line.to && isTableRow(line.text)) {
                const blank = blankRowFor(line.text);
                const insertAt = line.to;
                view.dispatch({
                  changes: { from: insertAt, insert: '\n' + blank },
                  selection: { anchor: insertAt + 1 + (blank[1] === ' ' ? 2 : 1) },
                });
                return true;
              }

              // In Preview mode: prevent splitting hidden markdown prefixes.
              // If the cursor appears to be at the "start" of visible text but
              // is actually inside a hidden prefix, insert the newline before
              // the prefix instead of through the middle of it.
              //
              // ONLY WHEN THERE IS VISIBLE TEXT TO PROTECT. On an EMPTY item
              // (`- `, `- [ ] `, `> `) the prefix IS the whole line, so the
              // caret at its end is at end-of-line, not in front of hidden
              // content — acting here would push a blank line above the marker
              // instead of letting the list end (see `nonTightLists: false`
              // below).
              if (mode === 'preview') {
                const prefixMatch = line.text.match(/^( {0,3}(?:#{1,6} |[-*+] (?:\[[ xX]\] )?|\d+\. |> ))/);
                const hasContent = prefixMatch && line.text.length > prefixMatch[1].length;
                if (prefixMatch && hasContent && offset > 0 && offset <= prefixMatch[1].length) {
                  // Cursor is inside the hidden prefix — insert newline before the line
                  view.dispatch({
                    changes: { from: line.from, insert: '\n' },
                    selection: { anchor: line.from },
                  });
                  return true;
                }
              }

              // Auto-close code blocks — only from an OPENING
              // fence. Enter on the CLOSING fence of a block must
              // not open a new one: a hand-closed block would grow
              // a stray ``` below it, an empty block every time. A
              // fence line opens a block when an even number of
              // fence lines precede it.
              const opensBlock = (() => {
                let open = false;
                for (let i = 1; i < line.number; i++) {
                  if (/^```/.test(view.state.doc.line(i).text)) open = !open;
                }
                return !open;
              })();
              if (/^```\S*$/.test(line.text) && head === line.to && opensBlock) {
                // Check if there's already a closing fence below
                let hasClose = false;
                for (let i = line.number + 1; i <= view.state.doc.lines; i++) {
                  const below = view.state.doc.line(i);
                  if (/^```\s*$/.test(below.text)) { hasClose = true; break; }
                  if (below.text.trim() !== '' && i > line.number + 1) break;
                }
                if (!hasClose) {
                  view.dispatch({
                    changes: { from: line.to, insert: '\n\n```' },
                    selection: { anchor: line.to + 1 },
                  });
                  return true;
                }
              }
              // Markdown list continuation: continue bullets / numbered /
              // task items on Enter, ending the list on an empty item.
              // Returns false (default newline) when not in a list.
              return continueMarkup(view);
            },
          },
          {
            // Arrow down at end of document when last line is a code fence:
            // add new line below so user can escape the code block
            key: 'ArrowDown',
            run(view) {
              const { head } = view.state.selection.main;
              const doc = view.state.doc;
              const line = doc.lineAt(head);
              const lastLine = doc.line(doc.lines);

              // Only act if the very last line of the document is a closing ```
              if (!/^```\s*$/.test(lastLine.text)) return false;

              // Trigger if cursor is on the closing fence or the line just above it
              if (line.number === lastLine.number ||
                  (line.number === lastLine.number - 1 && head === line.to)) {
                view.dispatch({
                  changes: { from: doc.length, insert: '\n' },
                  selection: { anchor: doc.length + 1 },
                });
                return true;
              }
              return false;
            },
          },
          {
            // In Preview mode: prevent Backspace from deleting into hidden prefix
            key: 'Backspace',
            run(view) {
              const mode = view.state.field(editorModeField);
              if (mode !== 'preview') return false;

              const { head } = view.state.selection.main;
              const line = view.state.doc.lineAt(head);
              const offset = head - line.from;
              const prefixMatch = line.text.match(/^(#{1,4} |[-*] (\[[ x]\] )?|\d+\. |> )/);

              if (prefixMatch && offset <= prefixMatch[1].length && offset > 0) {
                // Cursor is at or inside hidden prefix — don't delete
                // Instead, remove the entire prefix (user thinks they're at start of line)
                if (offset === prefixMatch[1].length) {
                  // At the boundary: remove the prefix entirely
                  view.dispatch({
                    changes: { from: line.from, to: line.from + prefixMatch[1].length, insert: '' },
                  });
                  return true;
                }
                return true; // Swallow backspace inside prefix
              }
              return false;
            },
          },
          // Markdown's own Backspace, re-added by hand because `addKeymap:
          // false` above leaves out the package's high-precedence keymap (which
          // also binds Enter). The preview-mode handler right above
          // returns false in the other two modes, so this runs next.
          { key: 'Backspace', run: deleteMarkupBackward },
          ...closeBracketsKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Seeded with the note's EFFECTIVE mode. The field's own `create`
        // reads the global, which is right for a fresh editor with no note
        // but would flash the wrong mode for one opened on a pinned note.
        editorModeField.init(() => effectiveMode()),
        pendingExitField,
        // Whether the last change was a hand-typed `*`/`_`/`~`/backtick —
        // read by the misplaced-insert guard above so a typed `**` is not
        // mistaken for a toolbar-made pending pair.
        typedMarkerField,
        // Only Preview escapes, and only when the user asked it to. Reading
        // the settings store through a closure rather than baking the value
        // in means flipping the checkbox takes effect immediately, with no
        // editor reconfiguration.
        markdownEscaper(() =>
          effectiveMode() === 'preview'
          && !settingsStore.settings().interpretMarkdown),
        // A hand-typed closing fence swallows the auto-inserted one under it
        // (every mode — the Enter handler above auto-closes in every mode).
        EditorState.transactionFilter.of((tr) => closingFenceDedupSpec(tr) ?? tr),
        // Block-replace math widgets live in their own state field —
        // CodeMirror forbids block decorations from plugin facets.
        mathBlockDecorationsField,
        livePreviewPlugin,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            props.onChange(update.state.doc.toString());
          }
          if (props.onStylesChange && (update.selectionSet || update.docChanged)) {
            const exitAt = update.state.field(pendingExitField, false) ?? null;
            props.onStylesChange(exitAt !== null
              ? activeInlineStyles(
                  update.state.selection.main.empty && Math.abs(update.state.selection.main.head - exitAt) <= 4
                    ? EditorState.create({ doc: update.state.doc, selection: { anchor: exitAt } })
                    : update.state)
              : activeInlineStyles(update.state));
          }
        }),
        EditorView.lineWrapping,
        // CodeMirror paints its own caret (.cm-cursor): the NATIVE caret
        // between two zero-width hidden-marker spans renders at nothing on
        // Android WebView, so the cursor seems to disappear when a marker is
        // typed. CM's cursor comes from coordsAtPos, which resolves marker
        // boundaries correctly. (Obsidian mobile ships this same setup.)
        drawSelection(),
        EditorView.contentAttributes.of({ spellcheck: 'true' }),
        EditorView.theme({
          '&': { flex: '1', fontSize: '16px', fontFamily: 'inherit' },
          '.cm-content': { padding: '8px 0', minHeight: '120px', caretColor: 'var(--accent-color)' },
          '.cm-cursor': { borderLeftColor: 'var(--accent-color)' },
          '.cm-line': { padding: '1px 0' },
          '.cm-focused': { outline: 'none' },
          '.cm-scroller': { overflow: 'auto' },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
            background: 'color-mix(in srgb, var(--accent-color) 20%, transparent)',
          },
        }),
        EditorState.tabSize.of(2),
        // Collaborative binding — empty initially. If a Y.Text is
        // provided, we lazy-load y-codemirror.next below and swap in
        // its extension via the compartment, so the ~150 kB Yjs +
        // y-protocols + y-codemirror payload only loads inside
        // NoteModal's collab session.
        collabCompartment.of([]),
      ],
    });

    view = new EditorView({ state, parent: containerRef });

    // Effect, not a one-shot: the collab session opens AFTER first render
    // (NoteModal assigns it in a post-render effect), so props.yText is
    // null when the view mounts and arrives later — a mount-time `if`
    // would bind the editor to nothing forever, so local edits would never
    // enter the Yjs doc even while presence works. Re-runs on every
    // yText change (session open, rotation reopen) and swaps the
    // compartment accordingly.
    let boundYText: import('yjs').Text | null = null;
    createEffect(() => {
      const yText = props.yText ?? null;
      const awareness = props.awareness ?? null;
      if (yText === boundYText) return;
      boundYText = yText;
      if (!yText) {
        view?.dispatch({ effects: collabCompartment.reconfigure([]) });
        return;
      }
      import('y-codemirror.next').then(({ yCollab }: { yCollab: YCollab }) => {
        // Re-check: unmounted, or rebound again while the chunk loaded.
        if (!view || boundYText !== yText) return;
        view.dispatch({
          effects: collabCompartment.reconfigure(yCollab(yText, awareness)),
        });
      });
    });

    // Expose handle for toolbar interaction
    if (props.onReady) {
      props.onReady({
        // The same function `Mod-b` / `Mod-i` run, hoisted above onMount so
        // the button and the shortcut cannot diverge.
        wrapSelection,
        insertLinePrefix(prefix: string) {
          if (!view) return;
          const { head } = view.state.selection.main;
          const line = view.state.doc.lineAt(head);
          view.dispatch({
            changes: { from: line.from, to: line.from, insert: prefix },
            selection: { anchor: line.from + prefix.length },
          });
          view.focus();
        },
        insertBlock(before: string, after: string) {
          if (!view) return;
          settleComposition();
          const { from, to } = view.state.selection.main;
          const selected = view.state.sliceDoc(from, to);
          view.dispatch({
            changes: { from, to, insert: before + selected + after },
            selection: { anchor: from + before.length },
          });
          view.focus();
        },
        /**
         * Six levels from one button. A plain `insertLinePrefix('# ')` makes
         * only an H1 and stacks a second `# ` on the next press, leaving H2–H6
         * with no route through the UI — you would have to know the markdown,
         * which is exactly what the button exists to avoid.
         */
        cycleHeading() {
          if (!view) return;
          const { head } = view.state.selection.main;
          const line = view.state.doc.lineAt(head);
          const m = line.text.match(/^(#{1,6}) /);
          const level = m ? m[1].length : 0;
          const next = level >= 6 ? 0 : level + 1;
          const prefix = next === 0 ? '' : '#'.repeat(next) + ' ';
          const oldLen = m ? m[0].length : 0;
          view.dispatch({
            changes: { from: line.from, to: line.from + oldLen, insert: prefix },
            selection: { anchor: Math.max(line.from + prefix.length, head + prefix.length - oldLen) },
          });
          view.focus();
        },
        /**
         * A thematic break has to be alone on its line, so this never
         * decorates the caret's line — it opens a new one below and leaves the
         * caret past the rule, ready to keep typing.
         */
        insertDivider() {
          if (!view) return;
          const { head } = view.state.selection.main;
          const line = view.state.doc.lineAt(head);
          const onBlankLine = line.text.trim() === '';
          const insert = onBlankLine ? '---\n' : '\n---\n';
          const at = onBlankLine ? line.from : line.to;
          view.dispatch({
            changes: { from: at, to: onBlankLine ? line.to : at, insert },
            selection: { anchor: at + insert.length },
          });
          view.focus();
        },
        /**
         * Leaves the URL SELECTED rather than parking the caret next to it, so
         * the next keystroke replaces the placeholder instead of appending to
         * it. With a selection the selected text becomes the label.
         */
        insertLink() {
          if (!view) return;
          const { from, to } = view.state.selection.main;
          const selected = view.state.sliceDoc(from, to);
          const label = selected || 'link';
          const url = 'https://';
          const text = `[${label}](${url})`;
          // Preview hides everything but the label, so selecting the URL
          // there means typing into invisible text; select the label
          // instead and leave the URL for the raw modes.
          const preview = view.state.field(editorModeField) === 'preview';
          const selFrom = preview ? from + 1 : from + label.length + 3;
          const selLen = preview ? label.length : url.length;
          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: selFrom, head: selFrom + selLen },
          });
          view.focus();
        },
        undo() {
          if (!view) return;
          undo(view);
          view.focus();
        },
        redo() {
          if (!view) return;
          redo(view);
          view.focus();
        },
        setContent(text: string) {
          if (!view) return;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
          });
        },
      });
    }
  });

  onCleanup(() => view?.destroy());

  // Dispatching into CodeMirror from a reactive effect can land while an
  // update is in progress — CM THROWS, the throw kills the Solid effect,
  // and every later change silently stops syncing (the mode label keeps
  // cycling while the editor stays frozen in its old mode). All
  // effect-driven dispatches go through a microtask with verify-and-retry.
  const safeDispatch = (spec: () => Parameters<EditorView['dispatch']>[0], verify: () => boolean, attempt = 0) => {
    if (!view || attempt > 4) return;
    try {
      if (!verify()) view.dispatch(spec());
    } catch {
      setTimeout(() => safeDispatch(spec, verify, attempt + 1), 0);
      return;
    }
    if (!verify()) setTimeout(() => safeDispatch(spec, verify, attempt + 1), 0);
  };

  // Sync external value changes (e.g., initial load)
  createEffect(() => {
    const v = props.value;
    queueMicrotask(() => safeDispatch(
      () => ({ changes: { from: 0, to: view!.state.doc.length, insert: v } }),
      () => !view || view.state.doc.toString() === v,
    ));
  });

  // Sync editor mode setting
  createEffect(() => {
    const mode = effectiveMode();
    queueMicrotask(() => safeDispatch(
      () => ({ effects: editorModeEffect.of(mode) }),
      () => !view || view.state.field(editorModeField) === mode,
    ));
  });

  // The mode is mirrored onto the WRAPPER (never into CodeMirror's own DOM) so
  // stylesheets can react to it. Preview and Hybrid drop the monospace body
  // face there: a mode whose job is to look like the finished note should not
  // render it as source, and on a 390px phone monospace wraps every line at
  // ~30 characters.
  return (
    <div
      ref={containerRef}
      class="note-editor-cm"
      classList={{
        'mode-preview': effectiveMode() === 'preview',
        'mode-hybrid': effectiveMode() === 'hybrid',
        'mode-markdown': effectiveMode() === 'markdown',
      }}
    />
  );
};

export default NoteEditor;
