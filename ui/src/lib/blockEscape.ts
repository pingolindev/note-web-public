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
 * Where a backslash goes to stop a typed block marker becoming markup.
 *
 * Its own module, with no imports, so it can be tested without dragging in
 * the editor's DOM-dependent world (DOMPurify, KaTeX, CodeMirror). The
 * positional rule below IS the correctness argument for the whole feature,
 * so it needs to be cheap to test.
 */
/**
 * Block markers, and where a backslash goes to neutralise each one.
 *
 * The document stays markdown whatever the setting says — all three clients
 * read one encrypted body — so "don't interpret what I type" has to mean
 * "escape it", not "render it differently". CommonMark's backslash is the
 * mechanism, and it renders as the bare character in every markdown reader,
 * so a note written this way still says what its author meant when opened
 * anywhere else.
 *
 * INLINE MARKS ARE DELIBERATELY ABSENT. `*emphasis*` becoming italic is
 * behaviour people who don't write markdown still tend to want, and escaping
 * every `*` would litter notes with backslashes for a `2 * 3`.
 */
const BLOCK_ESCAPES: { re: RegExp; at: (m: RegExpMatchArray) => number }[] = [
  // `# ` … `###### ` — escape the first hash.
  { re: /^(#{1,6}) /, at: () => 0 },
  // `- `, `* `, `+ ` — escape the marker.
  { re: /^( {0,3})([-*+]) /, at: (m) => m[1].length },
  // `1. ` / `1) ` — CommonMark escapes the DELIMITER, not the digits.
  { re: /^( {0,3})(\d{1,9})([.)]) /, at: (m) => m[1].length + m[2].length },
  // `> ` — escape the angle bracket.
  { re: /^( {0,3})> /, at: (m) => m[1].length },
  // A thematic break: three or more of - _ * alone on the line.
  { re: /^( {0,3})(-{3,}|_{3,}|\*{3,})[ \t]*$/, at: (m) => m[1].length },
  // A fence.
  { re: /^( {0,3})(```|~~~)/, at: (m) => m[1].length },
];

/** The offset within `line` that needs a backslash, or -1 if nothing does.
 *  Exported for test: the positional rule is the whole correctness argument. */
export function blockEscapeOffset(line: string): number {
  for (const { re, at } of BLOCK_ESCAPES) {
    const m = line.match(re);
    if (m) return at(m);
  }
  return -1;
}

/**
 * The inverse question: does this line START with a block marker that a
 * backslash has neutralised (`\# `, `\- `, `1\. `, `\> `, `\---`, `\```),
 * and where is that backslash?
 *
 * Preview hides every other marker it understands, this one included: left
 * visible, "Interpret markdown off" would put a `\#` on the screen, on every
 * card, for every heading the user typed. The offsets mirror
 * `blockEscapeOffset` exactly — same patterns, one backslash inserted at the
 * position that function names — so the two functions describe the same
 * documents from both sides.
 */
const ESCAPED_BLOCK: RegExp[] = [
  /^( {0,3})\\#{1,6} /,
  /^( {0,3})\\[-*+] /,
  /^( {0,3})\\> /,
  /^( {0,3})\\(-{3,}|_{3,}|\*{3,})[ \t]*$/,
  /^( {0,3})\\(```|~~~)/,
];
const ESCAPED_ORDERED = /^( {0,3})(\d{1,9})\\[.)] /;

/** Offset of the escaping backslash, or -1 when the line does not start with
 *  an escaped block marker. */
export function escapedBlockMarkerOffset(line: string): number {
  for (const re of ESCAPED_BLOCK) {
    const m = line.match(re);
    if (m) return m[1].length;
  }
  const o = line.match(ESCAPED_ORDERED);
  if (o) return o[1].length + o[2].length;
  return -1;
}

