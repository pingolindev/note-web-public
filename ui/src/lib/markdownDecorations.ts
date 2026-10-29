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
 * Markdown decoration logic for the note editor.
 *
 * Kept apart from NoteEditor.tsx so it can be TESTED. These functions are
 * pure — `buildDecorations` reads only `view.state.doc` and
 * `view.state.selection.main.head` — but NoteEditor.tsx imports
 * `stores/settings`, which calls `applyTheme()` at module load and touches
 * `document`. The vitest environment is `node`, so importing the component
 * would throw before a single assertion ran.
 *
 * See markdownDecorations.complexity.test.ts, which asserts the SHAPE of the
 * work (operations per line) rather than its duration.
 */
import { EditorState, RangeSetBuilder, Text } from '@codemirror/state';
import { pairDelimiterRuns } from './delimiterPairs';
import { escapedBlockMarkerOffset } from './blockEscape';
import { EditorView, Decoration, DecorationSet, WidgetType, ViewUpdate } from '@codemirror/view';
// Type-only: erased at compile time, so this does NOT pull in the module's
// applyTheme() side effect. Keep it `import type`.
import type { EditorMode } from '../stores/settings';
import katex from 'katex';
import { sanitizeHtml } from './sanitizeHtml';

// Obsidian-style callouts: `> [!type] title` opens a block; subsequent
// `> ...` lines belong to it. Known types get themed colors; unknown
// types fall back to the generic `note` styling.
// --- Decoration classes ---
const boldDeco = Decoration.mark({ class: 'cm-md-bold' });
const italicDeco = Decoration.mark({ class: 'cm-md-italic' });
const strikeDeco = Decoration.mark({ class: 'cm-md-strike' });
const codeDeco = Decoration.mark({ class: 'cm-md-code' });
const linkDeco = Decoration.mark({ class: 'cm-md-link' });
// Hidden syntax is a REPLACE decoration, not a CSS-shrunk mark. A
// width:0/overflow:hidden mark keeps the marker text in the DOM, and that
// text is real to everything outside CodeMirror: Gboard's word
// recomposition reads `~~gon` as the word and rewrites it without the
// tildes; composition anchors INSIDE the zero-width span so typed text
// renders hidden; and the drawn cursor measures glyph offsets the
// clipping never paints (width:0 clips paint, not client rects). A
// replaced range simply isn't in the DOM: the IME cannot see, eat, or
// anchor inside syntax it never receives, and CM's widget buffers give
// the caret real positions at the edges.
const hiddenDeco = Decoration.replace({});
// Halves of an EMPTY pair (`****`, `**`, `~~~~`, ` `` `, `******`). The
// separate instance carries construct identity so previewBackspace can
// tell a real empty pair from the closing marker of one run touching the
// opening marker of the NEXT run — text alone cannot distinguish those
// (`a**b` vs `*a**b*` positions 2-4).
export const hiddenPairDeco = Decoration.replace({});
// Six heading levels, not three. The mobile clients accept `#{1,6}`, so any
// level this pattern misses falls through to the plain-paragraph branch: the
// hashes stay on screen, the line gets no styling, and the same note is a
// heading on a phone and literal hashes in the browser.
const headingDecos = [
  Decoration.line({ class: 'cm-md-h1' }),
  Decoration.line({ class: 'cm-md-h2' }),
  Decoration.line({ class: 'cm-md-h3' }),
  Decoration.line({ class: 'cm-md-h4' }),
  Decoration.line({ class: 'cm-md-h5' }),
  Decoration.line({ class: 'cm-md-h6' }),
];
const hrDeco = Decoration.line({ class: 'cm-md-hr' });
const blockquoteDeco = Decoration.line({ class: 'cm-md-blockquote' });
const listDeco = Decoration.line({ class: 'cm-md-list' });
const codeBlockDeco = Decoration.line({ class: 'cm-md-codeblock' });

const CALLOUT_TYPES = new Set([
  'note', 'info', 'tip', 'success', 'question', 'warning',
  'failure', 'danger', 'bug', 'example', 'quote', 'abstract', 'todo',
]);

class CalloutLabelWidget extends WidgetType {
  constructor(private type: string) { super(); }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-md-callout-label';
    span.textContent = this.type.charAt(0).toUpperCase() + this.type.slice(1);
    return span;
  }
  eq(other: CalloutLabelWidget) { return this.type === other.type; }
}

export class MathWidget extends WidgetType {
  constructor(private latex: string, private isBlock: boolean) { super(); }
  toDOM() {
    const el = document.createElement(this.isBlock ? 'div' : 'span');
    el.className = this.isBlock ? 'cm-md-math-block' : 'cm-md-math-inline';
    try {
      // Defense-in-depth: KaTeX renders `output: 'html'` (spans with
      // class/style/aria only — no MathML), all of which survive the HTML
      // profile, so routing it through the shared sanitizer keeps the math
      // rendering intact while keeping every innerHTML sink sanitized.
      el.innerHTML = sanitizeHtml(katex.renderToString(this.latex, {
        throwOnError: false,
        displayMode: this.isBlock,
        output: 'html',
      }));
    } catch {
      el.textContent = this.latex;
    }
    return el;
  }
  eq(other: MathWidget) {
    return this.latex === other.latex && this.isBlock === other.isBlock;
  }
}

// Copy button widget for code blocks
class CopyButtonWidget extends WidgetType {
  constructor(private codeContent: string) { super(); }
  toDOM() {
    const btn = document.createElement('button');
    btn.className = 'cm-copy-btn';
    btn.textContent = 'Copy';
    btn.title = 'Copy code';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(this.codeContent);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
    return btn;
  }
  eq(other: CopyButtonWidget) { return this.codeContent === other.codeContent; }
}

// Checkbox widget with click-to-toggle
class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean, private view: EditorView) { super(); }
  toDOM() {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.checked;
    cb.className = 'cm-md-checkbox';
    cb.addEventListener('click', (e) => {
      e.preventDefault();
      // Toggle [ ] <-> [x] in the document. Inline checkboxes in text
      // notes are WYSIWYG — they don't reorder. Dedicated checklist
      // notes use a separate editor for Keep-style behavior.
      // Position is resolved AT CLICK TIME from the DOM node, not captured
      // at build time: a captured lineFrom would force eq() to compare
      // positions, and any edit ABOVE a checkbox shifts them — so every
      // keystroke would destroy and recreate every checkbox <input> below
      // the caret, and typing near a checklist would feel sluggish.
      const pos = this.view.posAtDOM(cb);
      const line = this.view.state.doc.lineAt(pos);
      const text = line.text;
      // Marker-agnostic: the item may be "-", "*" or "+", indented by up to
      // three spaces, and already checked with a capital X. A literal
      // `replace('- [x] ', …)` would silently do nothing for every one of those,
      // so the box would redraw unchanged and the click would look broken.
      const newText = this.checked
        ? text.replace(/^( {0,3}[-*+] )\[[xX]\] /, '$1[ ] ')
        : text.replace(/^( {0,3}[-*+] )\[ \] /, '$1[x] ');
      this.view.dispatch({ changes: { from: line.from, to: line.to, insert: newText } });
    });
    return cb;
  }
  eq(other: CheckboxWidget) { return this.checked === other.checked; }
}

/**
 * The block structure of a document: fenced code, math blocks, and callouts.
 *
 * Depends ONLY on the text — never on where the cursor is — which is what makes
 * it cacheable across cursor movement.
 */
export interface BlockScan {
  codeBlockLines: Set<number>;
  codeBlockRanges: { start: number; end: number }[];
  mathBlockLines: Set<number>;
  mathBlockRanges: { start: number; end: number; latex: string }[];
  calloutLines: Map<number, string>;
}

/**
 * Did this update move the cursor to a different line?
 *
 * The decoration build depends on the selection only through the cursor's LINE
 * (hybrid mode reveals that line's raw syntax), so a move within one line
 * produces an identical decoration set — and rebuilding it walks the document.
 */
export function movedLine(update: ViewUpdate): boolean {
  const before = update.startState.selection.main.head;
  const after = update.state.selection.main.head;
  if (before === after) return false;
  return update.startState.doc.lineAt(before).number !== update.state.doc.lineAt(after).number;
}

/**
 * Walk the document once for its block structure.
 *
 * Two full-document passes, kept in their own function so they can be
 * cached: the decoration build re-runs on every `selectionSet` (hybrid mode
 * reveals raw syntax on the cursor's line, so it genuinely depends on the
 * selection), and re-scanning the whole document for every arrow key would
 * make the cursor lag on a long note — three full walks per keypress.
 */
export function scanBlocks(doc: EditorState['doc']): BlockScan {
  const codeBlockLines = new Set<number>();
  const codeBlockRanges: { start: number; end: number }[] = [];
  const mathBlockLines = new Set<number>();
  const mathBlockRanges: { start: number; end: number; latex: string }[] = [];
  const calloutLines = new Map<number, string>(); // line number -> type
  let inCodeBlock = false;
  let inMathBlock = false;
  let blockStart = 0;
  let mathContent: string[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    if (inCodeBlock) {
      codeBlockLines.add(i);
      if (/^```/.test(text)) {
        codeBlockRanges.push({ start: blockStart, end: i });
        inCodeBlock = false;
      }
      continue;
    }
    if (inMathBlock) {
      if (/^\$\$\s*$/.test(text)) {
        mathBlockLines.add(i);
        mathBlockRanges.push({ start: blockStart, end: i, latex: mathContent.join('\n') });
        inMathBlock = false;
        mathContent = [];
      } else {
        mathBlockLines.add(i);
        mathContent.push(text);
      }
      continue;
    }
    if (/^```/.test(text)) {
      codeBlockLines.add(i);
      blockStart = i;
      inCodeBlock = true;
      continue;
    }
    if (/^\$\$\s*$/.test(text)) {
      mathBlockLines.add(i);
      blockStart = i;
      inMathBlock = true;
      mathContent = [];
      continue;
    }
  }

  // Callout scan: a line `> [!type]` opens a block; following `> ...`
  // lines belong to it. Stops on a non-blockquote line.
  for (let i = 1; i <= doc.lines; i++) {
    const m = doc.line(i).text.match(/^> \[!(\w+)\]/);
    if (!m) continue;
    const rawType = m[1].toLowerCase();
    const type = CALLOUT_TYPES.has(rawType) ? rawType : 'note';
    calloutLines.set(i, type);
    let j = i + 1;
    for (; j <= doc.lines; j++) {
      if (!/^> /.test(doc.line(j).text) && doc.line(j).text !== '>') break;
      calloutLines.set(j, type);
    }
    // Resume AFTER the block this iteration just claimed. Without it the outer
    // loop re-walks every line the inner loop consumed, so a note made of
    // consecutive callouts costs O(n²): measured at 334ms for a single
    // keystroke over 2,400 callout lines, on a machine far faster than a phone.
    // Every line in [i+1, j) is already classified; there is nothing to revisit.
    i = j - 1;
  }

  return { codeBlockLines, codeBlockRanges, mathBlockLines, mathBlockRanges, calloutLines };
}

/**
 * Last scan, keyed on document identity.
 *
 * `Text` is immutable, so the same object means the same text and therefore the
 * same block structure. One entry is enough: a rebuild is always for the
 * document currently in the view.
 */
export const blockScanCache: { doc: EditorState['doc'] | null; scan: BlockScan | null } = {
  doc: null,
  scan: null,
};

/**
 * The subset of [buildDecorations]'s output the CURSOR must treat as a unit:
 * the hidden marker runs (a caret inside one is invisible, and backspace
 * erases characters the user cannot see, one at a time) and the replace
 * widgets (checkbox, bullet, callout label, math). Registered as
 * EditorView.atomicRanges so motion skips OVER them and a single backspace
 * at the boundary removes the whole hidden marker — otherwise, in preview, a
 * tap on H leaves the caret in the hidden `# `, and deleting back through it
 * takes invisible extra keystrokes. Styling marks (bold/italic/strike/code/
 * link) wrap VISIBLE text and stay freely editable.
 */
/**
 * How many characters in [from, to) are NOT covered by the atomic (hidden /
 * replaced) ranges — i.e. the characters the user can actually SEE. The
 * preview-mode Backspace uses this to treat hidden markdown as
 * non-interactable: syntax must never outlive its visible content.
 */
export function visibleCharsBetween(atomic: DecorationSet, from: number, to: number): number {
  let covered = 0;
  atomic.between(from, to, (f, t) => {
    covered += Math.min(t, to) - Math.max(f, from);
  });
  return Math.max(0, to - from - covered);
}

export function atomicRangesOf(decorations: DecorationSet): DecorationSet {
  return decorations.update({
    filter: (_from, _to, value) =>
      value === hiddenDeco || value === hiddenPairDeco ||
      (value.spec != null && 'widget' in value.spec),
  });
}

/** Where a caret at `head` must sit after an edit: null if legal, else the
 * nearest edge of the atomic range it landed inside. Runs on a REAL
 * EditorState built from the (possibly partial-view) doc — buildDecorations
 * reads `state.selection.main.head`, and a hand-rolled `{ state: { doc } }`
 * fake would throw `Cannot read properties of undefined (reading 'main')` on
 * every preview dispatch. Keep this the ONLY way the snap path builds its
 * view. */
export function caretSnapAnchor(doc: Text, head: number): number | null {
  const line = doc.lineAt(head);
  const state = EditorState.create({
    doc,
    selection: { anchor: Math.min(head, doc.length) },
  });
  const fake = {
    state,
    visibleRanges: [{ from: line.from, to: line.to }],
  } as unknown as EditorView;
  const atomic = atomicRangesOf(buildDecorations(fake, 'preview'));
  let snapped: number | null = null;
  atomic.between(line.from, line.to, (from, to) => {
    if (head > from && head < to) {
      snapped = head - from <= to - head ? from : to;
      return false;
    }
  });
  return snapped;
}

export function buildDecorations(view: EditorView, mode: EditorMode): DecorationSet {
  // Markdown mode: show all raw syntax, no decorations
  if (mode === 'markdown') return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const cursor = view.state.selection.main.head;
  const cursorLine = doc.lineAt(cursor).number;
  // In preview mode, never reveal raw syntax (even on cursor line)
  // In hybrid mode, reveal raw syntax on the cursor line
  const revealCursorLine = mode === 'hybrid';

  // First pass: find code block, math block, and callout ranges.
  // Code blocks and math blocks are mutually exclusive (the first fence
  // opens a block of that kind; until it closes, the other syntax is
  // treated as content). Callouts are blockquotes whose first line is
  // `> [!type]` — they extend across consecutive blockquote lines.
  // Block structure, from cache when the document has not changed. The
  // decoration build re-runs on every cursor move because hybrid mode reveals
  // syntax on the cursor's line — but the block scan does not depend on the
  // cursor, and re-walking the whole document per keypress makes cursor
  // movement lag on a long note.
  let scan = blockScanCache.doc === doc ? blockScanCache.scan : null;
  if (!scan) {
    scan = scanBlocks(doc);
    blockScanCache.doc = doc;
    blockScanCache.scan = scan;
  }
  const { codeBlockLines, codeBlockRanges, mathBlockLines, mathBlockRanges, calloutLines } = scan;

  // Is the cursor inside a code block? If so, reveal that block's fences
  const cursorInCodeBlock = revealCursorLine ? codeBlockRanges.find(
    r => cursorLine >= r.start && cursorLine <= r.end
  ) : undefined;
  const revealedFenceLines = cursorInCodeBlock
    ? new Set([cursorInCodeBlock.start, cursorInCodeBlock.end])
    : new Set<number>();

  // Math block ranges are scanned above so we can SKIP interior
  // math-block lines (see the `if (isInMathBlock) continue;` branch
  // below). The actual block-replace widget is provided by the
  // mathBlockDecorationsField StateField — block decorations cannot
  // be emitted via the ViewPlugin facet we use for inline/line
  // decorations (CM throws "Block decorations may not be specified
  // via plugins" when it tries to lay them out).

  // Only the lines that can actually be SEEN.
  //
  // CodeMirror renders roughly one screenful whatever the note's length, and
  // decorations from a ViewPlugin are collected only AFTER the viewport is
  // computed — so work spent on off-screen lines cannot affect anything that
  // is drawn. Walking the whole document would produce the same decorations and
  // throw away CodeMirror's viewport virtualisation. Measured: 33ms per rebuild
  // at 20,000 lines versus 0.078ms for one screenful.
  //
  // `scanBlocks` above stays whole-document on purpose: whether a visible line
  // sits inside a fence, a math block or a callout is only knowable by reading
  // from line 1, and it is cached on document identity so it re-runs only when
  // the text actually changes.
  let lastLine = 0;
  for (const { from, to } of view.visibleRanges) {
    const end = doc.lineAt(to).number;
    for (let i = doc.lineAt(from).number; i <= end; i++) {
      // Two visible ranges can share a line when a replace decoration splits
      // one, and emitting a line twice makes RangeSetBuilder throw on the
      // descending offset — which CodeMirror swallows, silently dropping the
      // plugin to Decoration.none. Guarded here, above every `continue` in the
      // body, so a skipped line still counts as visited.
      if (i <= lastLine) continue;
      lastLine = i;
    const line = doc.line(i);
    const text = line.text;
    const isInCodeBlock = codeBlockLines.has(i);
    const isInMathBlock = mathBlockLines.has(i);
    const calloutType = calloutLines.get(i);

    // Math block: a separate StateField emits the block-replace
    // widget for the entire `$$…$$` range (CodeMirror disallows
    // block decorations from plugin facets — see
    // mathBlockDecorationsField below). Here we only need to SKIP
    // interior math-block lines so the inline/line passes don't
    // emit decorations that collide with the block widget.
    if (isInMathBlock) {
      // Off-cursor: the block field replaces the whole range, so we
      // skip everything. On-cursor (raw-source reveal): same skip —
      // the LaTeX source isn't markdown and shouldn't get
      // header/bullet/inline-mark treatment.
      continue;
    }

    // In regular mode: skip cursor line to show raw markdown
    // In preview mode: never skip — always render decorations
    if (revealCursorLine && i === cursorLine) {
      if (isInCodeBlock && !/^```/.test(text)) {
        builder.add(line.from, line.from, codeBlockDeco);
      }
      continue;
    }

    // Code block fences
    if (/^```/.test(text)) {
      // Find the matching code block range for this fence
      const range = codeBlockRanges.find(r => r.start === i);

      if (revealedFenceLines.has(i)) {
        builder.add(line.from, line.from, codeBlockDeco);
      } else {
        builder.add(line.from, line.from, Decoration.line({ class: 'cm-md-codefence' }));
      }

      // Add copy button on opening fence lines
      if (range) {
        // Extract code content between fences
        const contentLines: string[] = [];
        for (let j = range.start + 1; j < range.end; j++) {
          contentLines.push(doc.line(j).text);
        }
        const codeContent = contentLines.join('\n');
        if (codeContent.trim()) {
          builder.add(line.to, line.to, Decoration.widget({
            widget: new CopyButtonWidget(codeContent),
            side: 1,
          }));
        }
      }
      continue;
    }
    if (isInCodeBlock) {
      builder.add(line.from, line.from, codeBlockDeco);
      continue;
    }

    // A block marker the escaper neutralised — `\# `, `\- `, `1\. `, `\> `,
    // `\---`, `\```. The line is prose, and the backslash is syntax: hide it
    // the way every other marker is hidden. Left visible, "Interpret markdown
    // off" would show the user a `\#` for every heading they typed, in Preview
    // and on every card. Only in this decorator's hidden tier; Markdown mode
    // still shows the source, as it does for every marker.
    const escapedOff = escapedBlockMarkerOffset(text);
    if (escapedOff >= 0) {
      builder.add(line.from + escapedOff, line.from + escapedOff + 1, hiddenDeco);
      // The neutralised marker is literal text — including a fence's
      // backticks and a break's stars, which the inline pass would otherwise
      // read as code/emphasis runs and hide (an escaped ``` would show as one
      // backtick). Decorate only what follows the marker, and nothing on a
      // marker-only line.
      const after = text.slice(escapedOff + 1);
      const markerLen = (after.match(/^(?:#{1,6} |[-*+] |[.)] |> |-{3,}|_{3,}|\*{3,}|```|~~~)/) ?? [''])[0].length;
      if (markerLen < after.length && !/^(?:-{3,}|_{3,}|\*{3,}|```|~~~)/.test(after)) {
        applyInlineDecorations(
          builder, line.from + escapedOff + 1 + markerLen, after.slice(markerLen));
      }
      continue;
    }

    // Headers — all six levels. The marker length must come from the match;
    // it is not a fixed width.
    const headingMatch = text.match(/^(#{1,6}) /);
    if (headingMatch) {
      builder.add(line.from, line.from, headingDecos[headingMatch[1].length - 1]);
      builder.add(line.from, line.from + headingMatch[0].length, hiddenDeco);
      // The heading's CONTENT still hides inline syntax — without
      // this, toggling bold inside a heading would print a raw
      // `****` in preview.
      applyInlineDecorations(
        builder, line.from + headingMatch[0].length, text.slice(headingMatch[0].length));
      continue;
    }

    // Horizontal rule
    if (/^---\s*$/.test(text)) {
      builder.add(line.from, line.from, hrDeco);
      continue;
    }

    // Callout (Obsidian `> [!type]` block). Applied before the generic
    // blockquote branch so a callout line gets the themed class instead
    // of the plain blockquote stripe.
    if (calloutType) {
      const openerMatch = text.match(/^(> \[!\w+\])(\s?)(.*)$/);
      const isOpener = openerMatch !== null;
      builder.add(line.from, line.from, Decoration.line({
        class: `cm-md-callout cm-md-callout-${calloutType}${isOpener ? ' cm-md-callout-opener' : ''}`,
      }));
      if (openerMatch) {
        // Hide the `> [!type]` marker so the title (if any) reads
        // cleanly. If there's no title, we leave the marker hidden but
        // emit a widget so the line still has a visible label.
        const markerEnd = line.from + openerMatch[1].length + openerMatch[2].length;
        builder.add(line.from, markerEnd, Decoration.replace({
          widget: new CalloutLabelWidget(calloutType),
        }));
      } else {
        // Hide the leading `> ` on continuation lines.
        builder.add(line.from, line.from + 2, hiddenDeco);
      }
      continue;
    }

    // Blockquote
    if (/^> /.test(text)) {
      builder.add(line.from, line.from, blockquoteDeco);
      builder.add(line.from, line.from + 2, hiddenDeco);
      applyInlineDecorations(builder, line.from + 2, text.slice(2));
      continue;
    }

    // Checklist
    // The same shapes the mobile clients accept: any of "-*+", up to three
    // spaces of indent, and "[x]" or "[X]". The marker length must come from
    // the match; it is not a fixed 6 characters.
    const checkMatch = text.match(/^ {0,3}[-*+] \[([ xX])\] /);
    if (checkMatch) {
      const checked = checkMatch[1] !== ' ';
      if (checked) {
        builder.add(line.from, line.from, Decoration.line({ class: 'cm-md-checked-line' }));
      }
      builder.add(line.from, line.from + checkMatch[0].length, Decoration.replace({
        widget: new CheckboxWidget(checked, view),
      }));
      applyInlineDecorations(
        builder, line.from + checkMatch[0].length, text.slice(checkMatch[0].length));
      continue;
    }

    // Bullet list
    const bulletMatch = text.match(/^ {0,3}[-*+] /);
    if (bulletMatch) {
      builder.add(line.from, line.from, listDeco);
      builder.add(line.from, line.from + bulletMatch[0].length, Decoration.replace({
        widget: new BulletWidget(),
      }));
      applyInlineDecorations(
        builder, line.from + bulletMatch[0].length, text.slice(bulletMatch[0].length));
      continue;
    }

    // Ordered list
    const olMatch = text.match(/^ {0,3}(\d+)\. /);
    if (olMatch) {
      builder.add(line.from, line.from, listDeco);
    }

    // Inline formatting (bold, italic, strikethrough, code)
    applyInlineDecorations(builder, line.from, text);
    }
  }

  return builder.finish();
}

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement('span');
    span.textContent = '•  ';
    span.className = 'cm-md-bullet';
    return span;
  }
  // Stateless: without eq() CodeMirror treats every rebuild's widget as new
  // and recreates the DOM on every keystroke.
  eq() { return true; }
}

function applyInlineDecorations(builder: RangeSetBuilder<Decoration>, lineStart: number, text: string) {
  // Collect every range first, then commit in sorted order. Each regex
  // runs against the whole line independently, so the natural commit
  // order (bold first, then italic, …) can hand `RangeSetBuilder.add`
  // out-of-order `from` positions: e.g. on `**bold** *italic* ***both***`
  // the bold regex finds matches at positions 6 AND 24, then the
  // italic regex tries to add a range at position 15 — RangeSetBuilder
  // throws because 15 < 24, and CodeMirror's plugin catches the throw
  // and silently falls back to `Decoration.none` for that view, taking
  // the entire live preview down with it (H1 line classes vanish, `**`
  // markers stay visible, no katex, etc.).
  //
  // Also: handle `***both***` BEFORE plain bold/italic. The single-pass
  // bold regex matches `***both**` greedy-asymmetrically and leaves an
  // orphan `*` which neither regex covers; capturing the triple-marker
  // case up front avoids that mismatch.
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  function push(from: number, to: number, deco: Decoration) {
    ranges.push({ from, to, deco });
  }
  // Ranges already consumed by an earlier marker — used so the bold
  // regex doesn't double-claim the inner `*…*` of `***both***`, and so
  // inline code's content is treated as a "no-decorate" region.
  const consumed: Array<[number, number]> = [];
  function isConsumed(from: number, to: number): boolean {
    for (const [a, b] of consumed) {
      if (from < b && to > a) return true;
    }
    return false;
  }
  // The emphasis family scans a MASKED copy of the line where every
  // consumed span is overwritten with \x00 (index-preserving). Scanning the
  // raw text instead fails two ways: a match that merely OVERLAPS a
  // consumed span still advances the regex's lastIndex past delimiters a
  // later legitimate pair needed (in `\`*c\`*~~~~*` the italic candidate
  // [1,5) is rejected for touching the code span, but its scan would
  // swallow the star at 4, orphaning the real [4,10) run); and consumed
  // delimiter chars remain visible to lookarounds. The renderer gets both
  // for free by stashing code/links behind placeholders — this is the same
  // trick.
  let maskedCache: string | null = null;
  function consume(a: number, b: number) {
    consumed.push([a, b]);
    maskedCache = null;
  }
  function maskedText(): string {
    if (maskedCache === null) {
      const arr = text.split('');
      for (const [a, b] of consumed) {
        for (let i = Math.max(0, a - lineStart); i < Math.min(arr.length, b - lineStart); i++) {
          arr[i] = '\x00';
        }
      }
      maskedCache = arr.join('');
    }
    return maskedCache;
  }

  // Inline code first — content inside backticks is literal, so the
  // other markers (bold/italic/strike/math) must not match within it.
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const start = lineStart + m.index!;
    push(start, start + 1, hiddenDeco);
    push(start + 1, start + 1 + m[1].length, codeDeco);
    push(start + 1 + m[1].length, start + m[0].length, hiddenDeco);
    consume(start, start + m[0].length);
  }

  // Links and images. `renderMarkdown` — the renderer that draws the note
  // CARDS — turns `[text](url)` into an anchor, and both phone clients
  // render it too, so the editor decorates it as well instead of showing
  // the whole thing raw. The label is decorated and the brackets and
  // target hidden; an image keeps its alt text and nothing else, which is
  // the call the Android app's Markwon makes (fetching the file would leak
  // the reader's IP to an arbitrary host — wrong for a server-blind app).
  //
  // Runs BEFORE the emphasis rules so a URL containing `_` or `*` is never
  // re-parsed as markup.
  for (const m of text.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\s]*)\)/g)) {
    const start = lineStart + m.index!;
    if (isConsumed(start, start + m[0].length)) continue;
    const labelStart = start + m[1].length + 1;          // past "[" or "!["
    const labelEnd = labelStart + m[2].length;
    push(start, labelStart, hiddenDeco);
    if (!m[1] && m[2].length) push(labelStart, labelEnd, linkDeco);
    push(labelEnd, start + m[0].length, hiddenDeco);
    consume(start, start + m[0].length);
  }

  // STAR / TILDE / stray-BACKTICK family — the shared delimiter-run
  // pairing parser (lib/delimiterPairs.ts, ONE algorithm for decorator
  // and renderer). Runs on the MASKED line so consumed spans (code,
  // links, math) count as content a run may wrap.
  {
    const res = pairDelimiterRuns(maskedText());
    for (const [a, b] of res.markers) {
      push(lineStart + a, lineStart + b, hiddenDeco);
      consume(lineStart + a, lineStart + b);
    }
    for (const [a, b] of res.pairHalves) {
      push(lineStart + a, lineStart + b, hiddenPairDeco);
    }
    // pairHalves consume as whole pairs (both halves pushed above).
    for (let i = 0; i + 1 < res.pairHalves.length; i += 2) {
      consume(lineStart + res.pairHalves[i][0], lineStart + res.pairHalves[i + 1][1]);
    }
    for (const st of res.styles) {
      if (st.bold) push(lineStart + st.from, lineStart + st.to, boldDeco);
      if (st.italic) push(lineStart + st.from, lineStart + st.to, italicDeco);
      if (st.strike) push(lineStart + st.from, lineStart + st.to, strikeDeco);
    }
  }

  // `__text__` is BOLD, and `_text_` is italic.
  //
  // NOT underline, however tempting the shorthand. CommonMark, Obsidian and
  // android's Markwon all read `__x__` as strong emphasis, so rendering it as
  // underline here would make a note change meaning the moment it is opened
  // anywhere else.
  for (const m of maskedText().matchAll(/__(.+?)__/g)) {
    const start = lineStart + m.index!;
    const end = start + m[0].length;
    if (isConsumed(start, start + 2) || isConsumed(end - 2, end)) continue;
    push(start, start + 2, hiddenDeco);
    push(start + 2, start + 2 + m[1].length, boldDeco);
    push(start + 2 + m[1].length, start + m[0].length, hiddenDeco);
    consume(start, start + 2);
    consume(start + 2 + m[1].length, start + m[0].length);
  }

  // Italic _text_ — the underscore twin of `*text*`. It must stay in step with
  // `renderMarkdown`, which also decorates it; drop it here and the note card
  // shows italics the editor prints as underscores. Lookarounds keep it off
  // snake_case identifiers and off the `__` pair above.
  for (const m of maskedText().matchAll(/(?<![\w_])_(?!_)(.+?)(?<!_)_(?![\w_])/g)) {
    const start = lineStart + m.index!;
    const end = start + m[0].length;
    if (isConsumed(start, start + 1) || isConsumed(end - 1, end)) continue;
    push(start, start + 1, hiddenDeco);
    push(start + 1, start + 1 + m[1].length, italicDeco);
    push(start + 1 + m[1].length, start + m[0].length, hiddenDeco);
    consume(start, start + 1);
    consume(start + 1 + m[1].length, start + m[0].length);
  }

  // Inline math $x$ — replaced with a KaTeX render. Content must start
  // and end with non-whitespace (so `$5 and $7` doesn't get mistaken
  // for math), and negative lookarounds skip `$$…$$` block delimiters
  // and `$10` price prose.
  for (const m of maskedText().matchAll(/(?<![\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g)) {
    const start = lineStart + m.index!;
    if (isConsumed(start, start + m[0].length)) continue;
    push(start, start + m[0].length, Decoration.replace({
      widget: new MathWidget(m[1], false),
    }));
    consume(start, start + m[0].length);
  }

  // Sort by `from` then commit. Stable sort keeps multi-deco ranges at
  // the same position (e.g. the bold+italic pair for ***text***) in
  // their push order, which CodeMirror layers correctly.
  // RangeSetBuilder orders by (from, startSide). Marks and REPLACE
  // decorations at the same `from` carry different startSides, so the
  // tie-break must use the decoration's own side, not `to` — a strike
  // mark and an empty-pair replace both starting at the same position
  // otherwise land in builder-illegal order.
  ranges.sort((a, b) =>
    a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to);
  for (const r of ranges) {
    builder.add(r.from, r.to, r.deco);
  }
}
