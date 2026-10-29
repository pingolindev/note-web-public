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

import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, TransactionSpec } from '@codemirror/state';
import { pairDelimiterRuns } from './delimiterPairs';

/**
 * Toggle semantics for the symmetric inline markers the toolbar offers —
 * bold `**`, italic `*`, strikethrough `~~`, inline code `` ` ``. Not a
 * blind wrap: pressing B inside bold text turns bold off rather than
 * stacking a fresh `****`.
 *
 * Decision table for an EMPTY selection, in order:
 *   1. caret between the halves of an EMPTY pair        -> remove the pair
 *   2. caret at the END of a run's content              -> step past the
 *      closing marker (typed text continues unstyled; the run keeps its
 *      style — the "type bold, press B, keep typing" flow)
 *   3. caret anywhere else INSIDE a run                 -> unwrap the run
 *   4. otherwise                                        -> open an empty
 *      pair with the caret in the middle
 *
 * For a NON-EMPTY selection: unwrap when the selection is a run's exact
 * content (or includes its markers); wrap otherwise.
 *
 * Pure state -> spec so every branch is unit-testable; the view layer just
 * dispatches. Scanning is line-local, mirroring the decoration rules —
 * including italic's negative lookarounds so `*` never claims `**`'s
 * markers, and the shared empty-pair patterns.
 */

export const EMPTY_PAIR: Record<string, RegExp> = {
  '***': /(?<!\*)\*{6}(?!\*)/g,
  '**': /(?<!\*)\*\*\*\*(?!\*)/g,
  '*': /(?<!\*)\*\*(?!\*)/g,
  '~~': /(?<!~)~~~~(?!~)/g,
  '`': /(?<!`)``(?!`)/g,
};

export const CONTENT_RUN: Record<string, RegExp> = {
  '***': /\*\*\*(.+?)\*\*\*/g,
  '**': /(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)/g,
  '*': /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
  '~~': /(?<!~)~~(?!~)(.+?)(?<!~)~~(?!~)/g,
  '`': /(?<!`)`(?!`)([^`]+)`(?!`)/g,
};

/** Bold and italic COMPOSE: `***text***` is both. Pressing I while bold
 *  (or B while italic) flips one flag of a two-flag state instead of
 *  fighting the other marker — the flag set maps to the pair to use. */
const EMPHASIS_FOR = (bold: boolean, italic: boolean) =>
  bold && italic ? '***' : bold ? '**' : italic ? '*' : null;

function emphasisFlags(pair: string): { bold: boolean; italic: boolean } {
  return { bold: pair.includes('**'), italic: pair === '*' || pair === '***' };
}


/** Would inserting `pair+pair` at `offset` in `lineText` survive as an EMPTY
 *  pair — or be re-parsed as the opening of a larger run? `**` inserted at
 *  the start of `x **a** y` fuses with the later bold into `**x **…`, so the
 *  user pressed I and got bold — and the caret we return would sit inside a
 *  hidden marker. When any content-run's markers would overlap the inserted
 *  pair, the insertion is UNSTABLE and the press must not fire. */
function pairInsertUnstable(lineText: string, offset: number, pair: string): boolean {
  const inserted = lineText.slice(0, offset) + pair + pair + lineText.slice(offset);
  // Judge with the SAME pairing parser everything else uses — a regex
  // simulation false-flags parser-legal inserts (a combined `***` pair
  // after a bold closer reads as a fusion to the lookarounds).
  let masked = inserted;
  for (const m of inserted.matchAll(/`([^`]+)`/g)) {
    const a = m.index!;
    const b = a + m[0].length;
    masked = masked.slice(0, a) + '\x00'.repeat(b - a) + masked.slice(b);
  }
  const res = pairDelimiterRuns(masked);
  for (let i = 0; i + 1 < res.pairHalves.length; i += 2) {
    if (res.pairHalves[i][0] === offset && res.pairHalves[i + 1][1] === offset + 2 * pair.length) {
      return false;
    }
  }
  return true;
}


/** Marker spans of every CONTENT run on the line. The empty-pair regexes
 *  operate on raw text and happily match the closing `**` of `**e**`
 *  (content side is no star, outside is no star) — but those two stars are
 *  a run's MARKER, and treating them as an empty pair restyles or deletes
 *  half a run. Any empty-pair candidate overlapping one of these spans is
 *  a misread and must be skipped. */
function contentRunMarkerSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const [pair, re] of Object.entries(CONTENT_RUN)) {
    const n2 = pair.length;
    for (const m of text.matchAll(re)) {
      const a = m.index!;
      const b = a + m[0].length;
      spans.push([a, a + n2], [b - n2, b]);
    }
  }
  return spans;
}

/**
 * PENDING EXIT: pressing a toggle at a run's content end moves only the
 * LOGICAL caret past the hidden closer — a position the DOM cannot hold
 * (the browser re-parks the caret inside the replace-widget cluster and
 * CM adopts it), so the next typed word would re-enter the run and the
 * "un-bold" click would read as doing nothing. The exit ARMS this field; the
 * next typed insert landing at or inside the closer is remapped past it.
 * Disarmed by any doc change or by moving the caret away.
 */
export const pendingExitEffect = StateEffect.define<number | null>();

export const pendingExitField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(pendingExitEffect)) return e.value;
    }
    if (tr.docChanged) return null;
    if (value !== null && tr.selection) {
      const head = tr.newSelection.main.head;
      if (Math.abs(head - value) > 4) return null;
    }
    return value === null ? null : tr.changes.mapPos(value, 1);
  },
});

export interface ActiveInlineStyles {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
}

/** Which inline styles are ACTIVE at the caret — a content run whose
 *  content the caret sits in (boundaries included, matching where the
 *  toggles restyle/extend), or the center of an empty pair (pending
 *  format: the button was pressed and typing will apply it). Drives the
 *  toolbar's pressed-state highlighting. */
export function activeInlineStyles(state: EditorState): ActiveInlineStyles {
  const out = { bold: false, italic: false, strike: false, code: false };
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const head = sel.head - line.from;
  // Mask code spans first (their content is literal), then ask the SAME
  // pairing parser the decorator and renderer use — the lookaround
  // tables reject adjacency (`**two**` right against a pending pair) and
  // would show no active style at exactly the moment the user presses
  // the button.
  let text = line.text;
  for (const m of line.text.matchAll(/`([^`]+)`/g)) {
    const a = m.index!;
    const b = a + m[0].length;
    if (head > a && head < b) out.code = true;
    text = text.slice(0, a) + '\x00'.repeat(b - a) + text.slice(b);
  }
  const res = pairDelimiterRuns(text);
  for (const st of res.styles) {
    if (head >= st.from && head <= st.to) {
      if (st.bold) out.bold = true;
      if (st.italic) out.italic = true;
      if (st.strike) out.strike = true;
    }
  }
  for (let i = 0; i + 1 < res.pairHalves.length; i += 2) {
    const [a] = res.pairHalves[i];
    const [b, b2] = res.pairHalves[i + 1];
    if (head !== b || a === undefined) continue;
    const ch = text[a];
    const half = b2 - b;
    if (ch === '*') {
      if (half >= 2) out.bold = true;
      if (half === 1 || half === 3) out.italic = true;
    } else if (ch === '~') out.strike = true;
    else if (ch === '`') out.code = true;
  }
  return out;
}

interface EmphasisConstruct {
  ch: '*' | '~';
  k: number;                       // 1 italic, 2 bold, 3 both; ~ always 2
  openFrom: number; openTo: number;
  closeFrom: number; closeTo: number;
}
interface EmptyPairInfo {
  ch: '*' | '~' | '`';
  from: number; to: number;        // whole pair
  center: number;
  half: number;                    // 1/2/3 per family
}

/** The line's emphasis structure, from the SAME pairing parser the
 * decorator and renderer use — the lookaround tables cannot see runs in
 * adjacency contexts (seven fused stars hide an empty pair from B-off).
 * Code spans are masked first; positions are line-local. */
function lineEmphasis(text: string): { runs: EmphasisConstruct[]; pairs: EmptyPairInfo[] } {
  let masked = text;
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const a = m.index!;
    const b = a + m[0].length;
    masked = masked.slice(0, a) + '\x00'.repeat(b - a) + masked.slice(b);
  }
  const res = pairDelimiterRuns(masked);
  const runs: EmphasisConstruct[] = [];
  for (let j = 0; j * 2 + 1 < res.markers.length; j++) {
    const [oa, ob] = res.markers[j * 2];
    const [ca, cb] = res.markers[j * 2 + 1];
    const st = res.styles[j];
    if (!st) continue;
    runs.push({
      ch: st.strike ? '~' : '*',
      k: st.strike ? 2 : (st.bold && st.italic ? 3 : st.bold ? 2 : 1),
      openFrom: oa, openTo: ob, closeFrom: ca, closeTo: cb,
    });
  }
  const pairs: EmptyPairInfo[] = [];
  for (let i = 0; i + 1 < res.pairHalves.length; i += 2) {
    const [a, b] = res.pairHalves[i];
    const [, d] = res.pairHalves[i + 1];
    const ch = masked[a] as '*' | '~' | '`';
    pairs.push({ ch, from: a, to: d, center: b, half: b - a });
  }
  return { runs, pairs };
}

const PAIR_FOR = (ch: '*' | '~', k: number) =>
  ch === '~' ? '~~' : k === 3 ? '***' : k === 2 ? '**' : '*';

export function toggleInlineMarker(state: EditorState, marker: string): TransactionSpec | null {
  const emptyRe = EMPTY_PAIR[marker];
  const runRe = CONTENT_RUN[marker];
  if (!emptyRe || !runRe) return null;
  const n = marker.length;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const text = line.text;

  // Formatting inside an inline-code span is a NO-OP for every marker but
  // the code toggle itself: code content is literal, so B inside `` `x` ``
  // would just print four stars into the code.
  if (marker !== '`') {
    const head0 = sel.head - line.from;
    for (const m of text.matchAll(CONTENT_RUN['`'])) {
      const cf = m.index! + 1;
      const ct = m.index! + m[0].length - 1;
      if (head0 >= cf && head0 <= ct && (!sel.empty
        ? sel.anchor - line.from >= cf && sel.anchor - line.from <= ct
        : true)) {
        return { selection: { anchor: sel.head } };
      }
    }
    for (const m of text.matchAll(EMPTY_PAIR['`'])) {
      if (head0 === m.index! + 1 && sel.empty) {
        return { selection: { anchor: sel.head } };
      }
    }
  }

  if (sel.empty) {
    const head = sel.head;
    const local = head - line.from;

    if (marker !== '`') {
      // EMPHASIS/STRIKE structure comes from the pairing parser — the
      // lookaround tables miss runs in adjacency (seven fused stars hide
      // an empty pair from the un-bold press entirely).
      const { runs, pairs } = lineEmphasis(text);
      const family: '*' | '~' = marker === '~~' ? '~' : '*';
      const flag: 'bold' | 'italic' = marker === '**' ? 'bold' : 'italic';

      for (const p of pairs) {
        if (local !== p.center && local !== p.from && local !== p.to) continue;
        if (p.ch === '`') continue; // the code no-op guard already ran
        if (p.ch !== family) {
          // CROSS-FAMILY at a pending pair: carry its flags and add the
          // pressed one — S at a `****` center becomes `**~~|~~**`, so
          // B/I/S behave as independent sticky toggles.
          const w = {
            bold: p.ch === '*' && p.half >= 2,
            italic: p.ch === '*' && (p.half === 1 || p.half === 3),
            strike: p.ch === '~',
          };
          if (marker === '**') w.bold = !w.bold;
          else if (marker === '*') w.italic = !w.italic;
          else if (marker === '~~') w.strike = !w.strike;
          const emph2 = EMPHASIS_FOR(w.bold, w.italic) ?? '';
          const stk2 = w.strike ? '~~' : '';
          const open2 = emph2 + stk2;
          return {
            changes: { from: line.from + p.from, to: line.from + p.to, insert: open2 + stk2 + emph2 },
            selection: { anchor: line.from + p.from + open2.length },
            userEvent: 'input',
          };
        }
        if (family === '~') {
          // strike pair, strike press: remove ("never mind")
          return {
            changes: { from: line.from + p.from, to: line.from + p.to },
            selection: { anchor: line.from + p.from },
            userEvent: 'delete',
          };
        }
        const cur = { bold: p.half >= 2, italic: p.half === 1 || p.half === 3 };
        cur[flag] = !cur[flag];
        const target = EMPHASIS_FOR(cur.bold, cur.italic);
        if (target === null) {
          return {
            changes: { from: line.from + p.from, to: line.from + p.to },
            selection: { anchor: line.from + p.from },
            userEvent: 'delete',
          };
        }
        return {
          changes: { from: line.from + p.from, to: line.from + p.to, insert: target + target },
          selection: { anchor: line.from + p.from + target.length },
          userEvent: 'input',
        };
      }

      for (const r of runs) {
        if (r.ch !== family) continue;
        const cf = r.openTo;
        const ct = r.closeFrom;
        const same = family === '~'
          ? marker === '~~'
          : (marker === '**' && r.k === 2) || (marker === '*' && r.k === 1);
        if (local === r.closeTo) {
          // just past the closing marker: own style is already off — the
          // press is a no-op; a DIFFERENT marker falls through to open a
          // fresh pair after.
          if (same) return { selection: { anchor: head } };
          continue;
        }
        if (local < r.openFrom || local > ct) continue;
        if (local === ct) {
          if (same) {
            // exit the run, keep its style for what came before
            return { selection: { anchor: line.from + r.closeTo } };
          }
          // cross-family/different-k: rule 4 opens the full carried
          // construct past the closer
          continue;
        }
        // at the run's outer start, or inside its content: restyle/unwrap
        {
          if (family === '~' && !same) continue;
          const cur = family === '~'
            ? { bold: false, italic: false }
            : { bold: r.k >= 2, italic: r.k === 1 || r.k === 3 };
          let open = '';
          if (family === '*') {
            cur[flag] = !cur[flag];
            open = EMPHASIS_FOR(cur.bold, cur.italic) ?? '';
          }
          const openLen = cf - r.openFrom;
          const anchor = local <= cf
            ? line.from + r.openFrom + (local === r.openFrom ? 0 : open.length)
            : head - openLen + open.length;
          return {
            changes: [
              { from: line.from + r.openFrom, to: line.from + cf, insert: open },
              { from: line.from + ct, to: line.from + r.closeTo, insert: open },
            ],
            selection: { anchor },
            userEvent: open ? 'input' : 'delete',
          };
        }
      }
    } else {
      // CODE keeps the regex path: `-runs never pair in the parser, and
      // real code spans are structure the regex rules already handle.
      for (const m of text.matchAll(emptyRe)) {
        const start = line.from + m.index!;
        if (head === start + n || head === start || head === start + 2 * n) {
          return {
            changes: { from: start, to: start + 2 * n },
            selection: { anchor: start },
            userEvent: 'delete',
          };
        }
      }
      for (const m of text.matchAll(runRe)) {
        const start = line.from + m.index!;
        const contentFrom = start + n;
        const contentTo = start + m[0].length - n;
        if (head === start + m[0].length) {
          return { selection: { anchor: head } };
        }
        if (head === start) {
          return {
            changes: [
              { from: start, to: contentFrom },
              { from: contentTo, to: contentTo + n },
            ],
            selection: { anchor: start },
            userEvent: 'delete',
          };
        }
        if (head < contentFrom || head > contentTo) continue;
        if (head === contentTo) {
          return { selection: { anchor: contentTo + n } };
        }
        return {
          changes: [
            { from: start, to: contentFrom },
            { from: contentTo, to: contentTo + n },
          ],
          selection: { anchor: head - n },
          userEvent: 'delete',
        };
      }
    }

    // 4. Open at this position, CARRYING every active style: B/I/S are
    //    independent sticky toggles. Pressing S at the end of a
    //    bold-italic run steps past its closer and opens `***~~|~~***` —
    //    the strike is added, and the emphasis continues.
    if (marker === '`') {
      // code carries nothing and nothing carries into code
      if (pairInsertUnstable(text, head - line.from, marker)) {
        return { selection: { anchor: head } };
      }
      return {
        changes: { from: head, insert: marker + marker },
        selection: { anchor: head + n },
        userEvent: 'input',
      };
    }
    const act = activeInlineStyles(state);
    const want = { bold: act.bold, italic: act.italic, strike: act.strike };
    if (marker === '**') want.bold = !want.bold;
    else if (marker === '*') want.italic = !want.italic;
    else if (marker === '~~') want.strike = !want.strike;
    let at = head;
    {
      const { runs } = lineEmphasis(text);
      let moved = true;
      while (moved) {
        moved = false;
        for (const r of runs) {
          if (line.from + r.closeFrom === at) { at = line.from + r.closeTo; moved = true; }
        }
      }
    }
    const emph = EMPHASIS_FOR(want.bold, want.italic) ?? '';
    const stk = want.strike ? '~~' : '';
    if (!emph && !stk) {
      return { selection: { anchor: head } };
    }
    const open = emph + stk;
    if (!stk && emph && pairInsertUnstable(text, at - line.from, emph)) {
      return { selection: { anchor: head } };
    }
    return {
      changes: { from: at, insert: open + stk + emph },
      selection: { anchor: at + open.length },
      userEvent: 'input',
    };
  }

  // Non-empty selection.
  const { from, to } = sel;
  const selected = state.sliceDoc(from, to);
  // Selection includes the markers themselves.
  if (
    selected.length >= 2 * n &&
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    (n > 1 || (selected[n] !== marker[0] && selected[selected.length - n - 1] !== marker[0]))
  ) {
    return {
      changes: [
        { from, to: from + n },
        { from: to - n, to },
      ],
      selection: { anchor: from, head: to - 2 * n },
      userEvent: 'delete',
    };
  }
  // Selection is exactly a run's content.
  if (state.sliceDoc(from - n, from) === marker && state.sliceDoc(to, to + n) === marker) {
    return {
      changes: [
        { from: from - n, to: from },
        { from: to, to: to + n },
      ],
      selection: { anchor: from - n, head: to - n },
      userEvent: 'delete',
    };
  }
  // Wrap.
  return {
    changes: [
      { from, insert: marker },
      { from: to, insert: marker },
    ],
    selection: { anchor: from + n, head: to + n },
    userEvent: 'input',
  };
}
