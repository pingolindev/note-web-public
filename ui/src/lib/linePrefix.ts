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
 * Toolbar transformations for line-level Markdown prefixes.
 *
 * A toolbar button represents the state of the caret's line, not an append
 * operation. Pressing Bullet on a bullet removes it; pressing Numbered on a
 * bullet replaces the bullet. Keeping the match and replacement as pure text
 * operations makes every marker form testable without constructing an
 * EditorView.
 */

export type LinePrefixKind = 'bullet' | 'ordered' | 'checklist' | 'quote';
export type ActiveLinePrefixKind = LinePrefixKind | 'heading';

export interface LinePrefixMatch {
  kind: ActiveLinePrefixKind;
  /** Offset after leading indentation, where the marker starts. */
  from: number;
  /** Offset after the marker and its following whitespace. */
  to: number;
  headingLevel: number;
}

export interface LinePrefixEdit {
  from: number;
  to: number;
  insert: string;
}

export interface ActiveLinePrefixStyles {
  bullet: boolean;
  ordered: boolean;
  checklist: boolean;
  quote: boolean;
  heading: boolean;
}

const PREFIXES: Record<LinePrefixKind, string> = {
  bullet: '- ',
  ordered: '1. ',
  checklist: '- [ ] ',
  quote: '> ',
};

const BLOCK_PREFIX =
  /^([ \t]*)(?:(#{1,6})[ \t]+|(>)[ \t]+|([-*+])[ \t]+(\[[ xX]\][ \t]+)?|(\d+)[.)][ \t]+)/;

/** The block prefix already present at the start of `lineText`. */
export function linePrefixAt(lineText: string): LinePrefixMatch | null {
  const match = lineText.match(BLOCK_PREFIX);
  if (!match) return null;
  // The editor reads a heading or a quote only at column 0: indented, it is text.
  if (match[1] && (match[2] || match[3])) return null;

  let kind: ActiveLinePrefixKind;
  let headingLevel = 0;
  if (match[2]) {
    kind = 'heading';
    headingLevel = match[2].length;
  } else if (match[3]) {
    kind = 'quote';
  } else if (match[4]) {
    kind = match[5] ? 'checklist' : 'bullet';
  } else {
    kind = 'ordered';
  }

  return {
    kind,
    from: match[1].length,
    to: match[0].length,
    headingLevel,
  };
}

/**
 * Where a new marker goes. `buildDecorations` reads a list under four spaces of
 * indentation and a quote only at column 0, and a marker it cannot read would
 * stay in the note as raw text with its button lit.
 */
function markerColumn(lineText: string, kind: LinePrefixKind): number {
  if (kind === 'quote') return 0;
  return lineText.match(/^ {0,3}(?=[^ \t]|$)/)?.[0].length ?? 0;
}

/**
 * Insert, replace, or remove a line prefix.
 *
 * Clicking the same kind removes it. Any other Markdown block prefix —
 * including a heading — is replaced, so the toolbar's block styles remain
 * mutually exclusive. A list keeps the indentation it can be read at, and the
 * line's content is kept.
 */
export function toggleLinePrefix(lineText: string, kind: LinePrefixKind): LinePrefixEdit {
  const existing = linePrefixAt(lineText);
  if (!existing) {
    const from = markerColumn(lineText, kind);
    return { from, to: from, insert: PREFIXES[kind] };
  }
  if (existing.kind === kind) return { from: existing.from, to: existing.to, insert: '' };
  return { from: kind === 'quote' ? 0 : existing.from, to: existing.to, insert: PREFIXES[kind] };
}

/** Step the line's heading 1→2→…→6→none, replacing any other block style. */
export function cycleHeadingEdit(lineText: string): LinePrefixEdit {
  const existing = linePrefixAt(lineText);
  const level = existing?.kind === 'heading' ? existing.headingLevel : 0;
  const next = level >= 6 ? 0 : level + 1;
  return { from: 0, to: existing?.to ?? 0, insert: next === 0 ? '' : `${'#'.repeat(next)} ` };
}

/**
 * Map a caret or selection endpoint on the edited line through a prefix edit.
 *
 * Content endpoints move by the prefix-length delta. An endpoint at or before
 * the end of the marker lands just behind the new marker, so what is typed next
 * is the line's content: not inside hidden syntax, and not in front of the
 * marker, where it would stop being one.
 */
export function mapLinePrefixOffset(edit: LinePrefixEdit, offset: number): number {
  if (offset <= edit.to) return edit.from + edit.insert.length;
  return offset + edit.insert.length - (edit.to - edit.from);
}

/**
 * The same for a document position, the edited line starting at `lineFrom`. A
 * selection's other end can be on any line: before this line it stays, and
 * after it, it moves by the delta like any other content.
 */
export function mapLinePrefixPosition(edit: LinePrefixEdit, lineFrom: number, position: number): number {
  return position < lineFrom ? position : lineFrom + mapLinePrefixOffset(edit, position - lineFrom);
}

/** Which line-level toolbar state should be highlighted at the caret. */
export function activeLinePrefixStyles(lineText: string): ActiveLinePrefixStyles {
  const kind = linePrefixAt(lineText)?.kind;
  return {
    bullet: kind === 'bullet',
    ordered: kind === 'ordered',
    checklist: kind === 'checklist',
    quote: kind === 'quote',
    heading: kind === 'heading',
  };
}
