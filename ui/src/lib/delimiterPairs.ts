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
 * The ONE delimiter-run pairing algorithm for the star/tilde/backtick
 * inline family — consumed by BOTH the preview decorator
 * (markdownDecorations) and the card renderer (markdown.ts), so the two
 * can never disagree about the same line. Ordered regex chains drift
 * apart and cannot assemble every fusion shape; a pairing parser can.
 *
 * CommonMark-flavored, simplified to our constructs:
 *  - runs tokenize on the input (callers pre-mask consumed spans with
 *    \x00 or placeholders; masked chars count as CONTENT between runs);
 *  - a closing run pairs against the nearest opener with content in
 *    between, k = min(open, close, 3): 3 = bold+italic, 2 = bold,
 *    1 = italic; tildes pair 2+2 as strike; runs shrink and pair
 *    repeatedly (`**a***b*` = bold(a) + italic(b));
 *  - a PARITY GUARD never leaves an opener with an odd nonzero
 *    remainder (a lone closer must not break a `****` empty pair);
 *  - unpaired leftovers expose their even prefix as EMPTY-PAIR halves
 *    (the toolbar's pending-format `****`/`**`/`~~~~`/``` `` ```),
 *    leaving at most one literal delimiter;
 *  - backticks never pair here (real code spans are consumed by the
 *    code rule before this runs) — their leftovers still yield halves.
 */

export interface DelimStyle {
  from: number;
  to: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
}

export interface DelimResult {
  /** Hidden marker spans of PAIRED constructs. */
  markers: Array<[number, number]>;
  /** Halves of empty pairs (each entry is one half). */
  pairHalves: Array<[number, number]>;
  /** Styled content spans (between a construct's markers). */
  styles: DelimStyle[];
}

export function pairDelimiterRuns(seg: string): DelimResult {
  const markers: Array<[number, number]> = [];
  const pairHalves: Array<[number, number]> = [];
  const styles: DelimStyle[] = [];
  type Run = { at: number; rem: number };
  for (const ch of ['*', '~', '`'] as const) {
    const runs: Array<{ at: number; len: number }> = [];
    let i = 0;
    while (i < seg.length) {
      if (seg[i] === ch) {
        let j = i;
        while (j < seg.length && seg[j] === ch) j++;
        runs.push({ at: i, len: j - i });
        i = j;
      } else i++;
    }
    const stack: Run[] = [];
    for (const run of runs) {
      let at = run.at;
      let cur = run.len;
      if (ch !== '`') {
        while (cur > 0 && stack.length) {
          const top = stack[stack.length - 1];
          const openEnd = top.at + top.rem;
          if (openEnd >= at) break; // adjacent, no content between
          let k: number;
          if (ch === '~') {
            if (top.rem < 2 || cur < 2) break;
            k = 2;
          } else {
            k = Math.min(top.rem, cur, 3);
            if ((top.rem - k) % 2 === 1) break;
          }
          markers.push([openEnd - k, openEnd]);
          markers.push([at, at + k]);
          styles.push({
            from: openEnd,
            to: at,
            bold: ch === '*' && k >= 2,
            italic: ch === '*' && (k === 1 || k === 3),
            strike: ch === '~',
          });
          top.rem -= k;
          at += k;
          cur -= k;
          if (top.rem === 0) stack.pop();
        }
      }
      if (cur > 0) stack.push({ at, rem: cur });
    }
    for (const l of stack) {
      const e = l.rem - (l.rem % 2);
      if (e >= 2) {
        const half = e / 2;
        pairHalves.push([l.at, l.at + half]);
        pairHalves.push([l.at + half, l.at + e]);
      }
    }
  }
  return { markers, pairHalves, styles };
}
