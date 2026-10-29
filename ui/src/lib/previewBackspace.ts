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

import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { visibleCharsBetween, hiddenPairDeco } from './markdownDecorations';
import { CONTENT_RUN } from './inlineToggle';

/**
 * Preview-mode Backspace: hidden markdown is NON-INTERACTABLE. A keystroke
 * always affects something the user can SEE; markers die only when their
 * content dies, and never one half at a time.
 *
 * The ladder (first match wins), for an empty selection at `head`:
 *
 *  a. Caret between the halves of an EMPTY pair -> delete the pair AND the
 *     visible character before it (one press, one visible effect — the pair
 *     alone vanishing looks like a swallowed keystroke). "Empty pair" is
 *     decided by construct identity (hiddenPairDeco), NOT adjacency: the
 *     closing marker of `**a**` touching the opening `~~` of `~~b~~` is two
 *     ranges meeting at the caret too, and treating THAT as a pair would
 *     delete 'a' and both bold markers in one press.
 *  b. Caret at the END of an inline hidden range -> deletion is transparent:
 *     walk left across contiguous hidden ranges and delete the first VISIBLE
 *     character. Deleting the closing `*` of `*two*` would orphan the opener,
 *     which would then render RAW, a stray `*` on screen.
 *     - LINE-PREFIX markers (heading `# `, quote `> `, list bullets) keep
 *       the one-press marker-delete: dropping a heading that way is the
 *       expected behaviour, and a prefix has no partner to orphan.
 *     - A LEADING inline opener (`*hi*` with the caret after the `*`) has
 *       no visible character before it: the press joins to the previous
 *       line, or does nothing at the top of the note — it must NOT delete
 *       the opener alone (that orphans the closer).
 *  c. Line with NO visible characters -> clear it and join up.
 *  d. Line down to its LAST visible character with nothing visible after
 *     the caret -> the character takes all of the line's markup with it.
 *
 * Pure state -> spec so the whole journey is unit-testable. CRITICALLY this
 * is applied via a TRANSACTION FILTER, not only a keymap: Android IMEs
 * delete through beforeinput/deleteContentBackward, which never reaches a
 * keymap binding — a keymap-only version works under synthetic key events
 * and does nothing under Gboard.
 */

/**
 * IME replaces are remapped to VISIBLE text only. Gboard recomposes the
 * word around the caret on backspace, and the word IT sees includes any
 * hidden markers — they are real characters to the IME. Its "delete one
 * char" arrives as a REPLACE of `~~gon` with `go`: not a pure delete, so
 * the backspace ladder's shape gate passes it through, the opening
 * marker dies inside the rewrite, and the orphaned closer renders raw.
 * This guard rebuilds such a change to delete/insert only at the visible
 * positions, leaving every hidden range intact.
 *
 * Returns null when no change range overlaps a hidden range (the common
 * case — zero cost for normal typing).
 */
export function imeVisibleRemapSpec(
  state: EditorState,
  atomic: DecorationSet,
  changes: Array<{ fromA: number; toA: number; inserted: string }>,
): TransactionSpec | null {
  const hidden: Array<{ from: number; to: number }> = [];
  const lo = Math.max(0, Math.min(...changes.map(c => c.fromA)) - 1);
  const hi = Math.min(state.doc.length, Math.max(...changes.map(c => c.toA)) + 1);
  atomic.between(lo, hi, (from, to) => { hidden.push({ from, to }); });
  const isHidden = (pos: number) => hidden.some(r => pos >= r.from && pos < r.to);

  let touches = false;
  for (const c of changes) {
    for (let i = c.fromA; i < c.toA; i++) if (isHidden(i)) { touches = true; break; }
    if (touches) break;
  }
  if (!touches) return null;

  const out: Array<{ from: number; to: number; insert?: string }> = [];
  let caret: number | null = null;
  for (const c of changes) {
    // Doc positions of the VISIBLE characters inside the removed span.
    const vis: number[] = [];
    for (let i = c.fromA; i < c.toA; i++) if (!isHidden(i)) vis.push(i);
    const visStr = vis.map(i => state.doc.sliceString(i, i + 1)).join('');
    // Diff the IME's replacement against the visible text it covered and
    // apply only the differing MIDDLE at its true position. Flattening
    // the whole insertion to the front would put an autocorrected word
    // BEFORE the run's opening marker; a trailing committed space must
    // land after the last char, a corrected letter in place.
    let p = 0;
    while (p < visStr.length && p < c.inserted.length && visStr[p] === c.inserted[p]) p++;
    let sV = visStr.length;
    let sI = c.inserted.length;
    while (sV > p && sI > p && visStr[sV - 1] === c.inserted[sI - 1]) { sV--; sI--; }
    // Delete visible positions [p, sV) — as maximal contiguous doc runs.
    for (let k = p; k < sV; ) {
      let e = k;
      while (e + 1 < sV && vis[e + 1] === vis[e] + 1) e++;
      out.push({ from: vis[k], to: vis[e] + 1 });
      k = e + 1;
    }
    const midInsert = c.inserted.slice(p, sI);
    // Insertion point: where visible char p sits (or just after the last
    // visible char when appending; span start if nothing visible).
    const at = p < vis.length ? vis[p]
      : vis.length ? vis[vis.length - 1] + 1
      : c.fromA;
    if (midInsert) out.push({ from: at, to: at, insert: midInsert });
    caret = at + midInsert.length;
    if (!midInsert && sV > p) caret = at;
    if (!midInsert && sV === p) caret = null;
  }
  if (!out.length) {
    // Nothing visible needs to change: the span was entirely hidden, or
    // the IME re-committed the identical visible text. Letting the raw
    // change through would still delete syntax invisibly — block it with
    // an explicit no-op.
    return { selection: { anchor: state.selection.main.head } };
  }
  return {
    changes: out,
    selection: caret === null ? undefined : { anchor: caret },
    userEvent: 'input.type',
  };
}

/** True when every position between a and b lies inside an atomic/hidden
 *  range — the two positions render at the SAME visual spot. */
export function onlyHiddenBetween(atomic: DecorationSet, a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi) return true;
  const covered: Array<{ from: number; to: number }> = [];
  atomic.between(lo, hi, (from, to) => { covered.push({ from, to }); });
  for (let i = lo; i < hi; i++) {
    if (!covered.some(r => i >= r.from && i < r.to)) return false;
  }
  return true;
}

/**
 * Enter INSIDE an inline run splits it across lines — and inline runs
 * are line-local, so `~~a ~~` becomes `~~a` + `~~`: raw tildes on both
 * lines. The newline closes every enclosing run before the break and
 * reopens it after, the way markdown editors handle a split: both
 * halves stay styled, nothing orphans.
 */
export function newlineSplitGuardSpec(
  state: EditorState,
  changes: Array<{ fromA: number; toA: number; inserted: string }>,
  atomic?: DecorationSet,
): TransactionSpec | null {
  if (changes.length !== 1) return null;
  let c = changes[0];
  // Samsung's IME merges the composition COMMIT with the line break: the
  // change arrives as replace `w` -> `w\n` — re-committing the composed
  // text plus the newline. Normalize to a pure newline at the commit's
  // end so the split logic sees the real break position.
  if (c.inserted.length > 1 && c.inserted.endsWith('\n')
      && !c.inserted.slice(0, -1).includes('\n')
      && state.doc.sliceString(c.fromA, c.toA) === c.inserted.slice(0, -1)) {
    c = { fromA: c.toA, toA: c.toA, inserted: '\n' };
  }
  if (c.inserted !== '\n') return null;
  // The browser can also COLLAPSE a trailing space into the break —
  // replace-space-with-newline; the rewrite drops the removal so the
  // space survives on the new line.
  if (c.toA > c.fromA) {
    const removed = state.doc.sliceString(c.fromA, c.toA);
    if (!/^[ \t]+$/.test(removed)) return null;
  }
  // Enter at the CENTER of an empty pair would strand one half on each
  // line — two lone raw markers. The pair has no content to preserve:
  // dissolve it and break the line.
  if (atomic) {
    const rs: Array<{ from: number; to: number; pair: boolean }> = [];
    atomic.between(Math.max(0, c.fromA - 12), c.fromA + 12, (from, to, value) => {
      rs.push({ from, to, pair: value === hiddenPairDeco });
    });
    const prevR = rs.find(r => r.pair && r.to === c.fromA);
    const nextR = rs.find(r => r.pair && r.from === c.fromA);
    if (prevR && nextR) {
      // CASCADE outward: the caret can sit inside NESTED empty pairs
      // (code pair opened at a strike pair's center) — dissolving only
      // the inner layer leaves the outer halves straddling the newline
      // as raw markers. Expand while pair halves flank both sides.
      let df = prevR.from;
      let dt = nextR.to;
      for (;;) {
        const l = rs.find(r => r.pair && r.to === df);
        const r2 = rs.find(r => r.pair && r.from === dt);
        if (l && r2) { df = l.from; dt = r2.to; continue; }
        break;
      }
      // Any CONTENT run still enclosing the dissolved region must be
      // closed and reopened across the break (`*a\`\`b*` -> `*a*\n*b*`).
      const line0 = state.doc.lineAt(c.fromA);
      const dfL = df - line0.from;
      const dtL = dt - line0.from;
      const wrap: Array<{ marker: string; from: number }> = [];
      for (const [marker, re] of Object.entries(CONTENT_RUN)) {
        for (const m of line0.text.matchAll(re)) {
          const a = m.index!;
          const b = a + m[0].length;
          if (a <= dfL - marker.length && b >= dtL + marker.length &&
              dfL >= a + marker.length && dtL <= b - marker.length) {
            wrap.push({ marker, from: a });
          }
        }
      }
      wrap.sort((x, y) => x.from - y.from);
      const op2 = wrap.map(w => w.marker).join('');
      const cl2 = wrap.map(w => w.marker).reverse().join('');
      return {
        changes: { from: df, to: dt, insert: cl2 + '\n' + op2 },
        selection: { anchor: df + cl2.length + 1 + op2.length },
        userEvent: 'input',
      };
    }
  }
  const line = state.doc.lineAt(c.fromA);
  const local = c.fromA - line.from;
  const wrappers: Array<{ marker: string; from: number }> = [];
  for (const [marker, re] of Object.entries(CONTENT_RUN)) {
    for (const m of line.text.matchAll(re)) {
      const start = m.index!;
      const contentFrom = start + marker.length;
      const contentTo = start + m[0].length - marker.length;
      if (local >= contentFrom && local <= contentTo) {
        wrappers.push({ marker, from: start });
      }
    }
  }
  if (!wrappers.length) return null;
  wrappers.sort((a, b) => a.from - b.from);
  const openers = wrappers.map(w => w.marker).join('');
  const closers = wrappers.map(w => w.marker).reverse().join('');
  const insert = closers + '\n' + openers;
  return {
    changes: { from: c.fromA, to: c.fromA, insert },
    selection: { anchor: c.fromA + insert.length },
    userEvent: 'input',
  };
}

/**
 * A SPACE typed as the first content of a line-start italic pair turns
 * the line into `* …` — a BULLET to every markdown parser — orphaning
 * the pair's closer as a raw star. The user pressed I and hit space;
 * they did not ask for a list. Dissolve the pair and keep the typed
 * text: honest output (a plain space), no bullet, no orphan. Only the
 * single-star pair can flip this way (`** ` matches no bullet pattern),
 * and only when the opener sits at most 3 spaces from line start.
 */
export function bulletFlipGuardSpec(
  state: EditorState,
  atomic: DecorationSet,
  changes: Array<{ fromA: number; toA: number; inserted: string }>,
): TransactionSpec | null {
  if (changes.length !== 1) return null;
  const c = changes[0];
  if (c.fromA !== c.toA || !c.inserted || c.inserted[0] !== ' ') return null;
  const ranges: Array<{ from: number; to: number; pair: boolean }> = [];
  atomic.between(Math.max(0, c.fromA - 4), c.fromA + 4, (from, to, value) => {
    ranges.push({ from, to, pair: value === hiddenPairDeco });
  });
  const opener = ranges.find(r => r.pair && r.to === c.fromA);
  const closer = ranges.find(r => r.pair && r.from === c.fromA);
  if (!opener || !closer) return null;
  if (state.doc.sliceString(opener.from, opener.to) !== '*') return null;
  const line = state.doc.lineAt(c.fromA);
  const before = state.doc.sliceString(line.from, opener.from);
  if (opener.from - line.from > 3 || !/^ *$/.test(before)) return null;
  return {
    changes: { from: opener.from, to: closer.to, insert: c.inserted },
    selection: { anchor: opener.from + c.inserted.length },
    userEvent: 'input.type',
  };
}

/**
 * A typed insert that landed on the WRONG SIDE of hidden syntax. Chrome
 * snaps the DOM caret past a cluster of contenteditable=false replace
 * ranges, so the first keystroke after opening an empty pair arrives at
 * the position AFTER the closing markers while CodeMirror's logical
 * caret sits at the pair's center — bold never applies and the empty
 * pair lurks invisibly in front of the word. When a pure insert arrives
 * at a position separated from the logical caret by NOTHING BUT hidden
 * ranges, it belongs at the caret.
 */
export function misplacedInsertSpec(
  state: EditorState,
  atomic: DecorationSet,
  changes: Array<{ fromA: number; toA: number; inserted: string }>,
  /** Where the user's last hand-typed delimiter ended (`typedMarkerField`),
   *  or null. An insert arriving exactly there follows typed markers — the
   *  user is writing `**bold**` by hand — and case 2 must leave it alone. */
  typedMarkerAt: number | null = null,
): TransactionSpec | null {
  if (changes.length !== 1) return null;
  const c = changes[0];
  if (c.fromA !== c.toA || !c.inserted) return null;
  if (!state.selection.main.empty) return null;
  const head = state.selection.main.head;
  // Case 1: the INSERT slipped while the logical caret stayed put —
  // separated by nothing but hidden ranges, it belongs at the caret.
  if (c.fromA !== head && onlyHiddenBetween(atomic, head, c.fromA)) {
    return {
      changes: { from: head, to: head, insert: c.inserted },
      selection: { anchor: head + c.inserted.length },
      userEvent: 'input.type',
    };
  }
  // Case 2: the SELECTION slipped too (Chrome parks the DOM caret past
  // the replace cluster and CM adopts it as a plain 'select' — the same
  // label arrow keys use, so it cannot be blocked upstream). If the
  // insert lands DIRECTLY AFTER an empty pair, it goes into the pair's
  // center: the pair is invisible, so it cannot be a deliberate typing
  // target, and the user just pressed the toolbar button that created
  // it.
  const ranges: Array<{ from: number; to: number; pair: boolean }> = [];
  atomic.between(Math.max(0, c.fromA - 8), c.fromA, (from, to, value) => {
    ranges.push({ from, to, pair: value === hiddenPairDeco });
  });
  // Never teleport a NEWLINE into a pair — Enter after an invisible
  // empty pair is a line break, not pending-format content.
  if (c.inserted.includes('\n')) return null;
  // Nor a character that follows delimiters the user TYPED: `**` from the
  // keyboard is an opener in progress, not a pending format. Relocating the
  // `b` of `**bold**` into it would produce `*bold** …*` (and a typed fence
  // would lose its third backtick) in every editor mode.
  if (typedMarkerAt !== null && typedMarkerAt === c.fromA) return null;
  const closerHalf = ranges.find(r => r.to === c.fromA && r.pair);
  if (closerHalf) {
    const openerHalf = ranges.find(r => r.to === closerHalf.from && r.pair);
    if (openerHalf) {
      const center = closerHalf.from;
      return {
        changes: { from: center, to: center, insert: c.inserted },
        selection: { anchor: center + c.inserted.length },
        userEvent: 'input.type',
      };
    }
  }
  return null;
}

// One-press marker-delete stays only for line-scoped prefixes.
const PREFIX_RE = /^(?:#{1,6} |> | {0,3}[-*+] \[[ xX]\] | {0,3}[-*+] |\d+\. )/;

export function previewBackspaceSpec(
  state: EditorState,
  atomic: DecorationSet,
): TransactionSpec | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const head = sel.head;
  const line = state.doc.lineAt(head);
  if (line.length === 0) return null;

  // Collect the atomic ranges touching this line once.
  const ranges: Array<{ from: number; to: number; pair: boolean }> = [];
  atomic.between(line.from, line.to, (from, to, value) => {
    ranges.push({ from, to, pair: value === hiddenPairDeco });
  });
  const covered = (pos: number) => ranges.some(r => pos >= r.from && pos < r.to);

  // a. Empty pair around the caret — construct-verified.
  const prev = ranges.find(r => r.to === head);
  const next = ranges.find(r => r.from === head);
  if (prev && next && prev.pair && next.pair) {
    // The pair dies together with ONE visible character, so the press has
    // a visible effect. The char directly before the pair can itself be
    // hidden (an empty pair right after `*ital*` sits against the run's
    // closer) — walk left across the hidden chain: fellow EMPTY-PAIR
    // halves join the deletion, run markers are kept (transparency), and
    // the first visible char found is taken. Without the walk this press
    // would delete only invisible text: something deletes, but the
    // cursor does not move.
    const dels: Array<{ from: number; to: number }> = [
      { from: prev.from, to: next.to },
    ];
    let v = prev.from;
    for (;;) {
      const r = ranges.find(x => x.to === v);
      if (!r) break;
      if (r.pair) dels.push({ from: r.from, to: r.to });
      v = r.from;
    }
    if (v > line.from && !covered(v - 1)) {
      dels.push({ from: v - 1, to: v });
    } else if (v === line.from && line.number > 1) {
      dels.push({ from: line.from - 1, to: line.from });
    }
    const anchor = Math.min(...dels.map(d => d.from));
    return {
      changes: dels,
      selection: { anchor },
      userEvent: 'delete.backward',
    };
  }

  // a2. Caret directly BEFORE an empty pair, deleting a visible char: the
  //     pair dies with the character (rule (a) with the caret on the other
  //     side). Leaving it merges its markers with whatever precedes the
  //     deleted char — `***bold*** |****` minus the space is seven
  //     contiguous stars.
  if (!prev && next && next.pair && head > line.from && !covered(head - 1)) {
    let e = next.to;
    for (;;) {
      const r = ranges.find(x => x.from === e && x.pair);
      if (!r) break;
      e = r.to;
    }
    return {
      changes: { from: head - 1, to: e },
      selection: { anchor: head - 1 },
      userEvent: 'delete.backward',
    };
  }

  const visible = visibleCharsBetween(atomic, line.from, line.to);

  if (prev) {
    const isPrefix = prev.from === line.from &&
      (PREFIX_RE.exec(line.text)?.[0].length ?? -1) === prev.to - prev.from;
    if (isPrefix) {
      // One-press marker delete, stated EXPLICITLY rather than falling
      // through to null and the default atomic delete: the caller treats
      // null as "expect a plain visible-char delete" and remaps any
      // marker-touching transaction, which would turn the heading delete
      // into a no-op.
      return {
        changes: { from: prev.from, to: prev.to },
        selection: { anchor: prev.from },
        userEvent: 'delete.backward',
      };
    }
    {
      // b. Transparent delete: walk left across chained hidden ranges to
      //    the nearest visible character.
      let v = prev.from;
      let chainAllPairs = prev.pair;
      for (;;) {
        const r = ranges.find(x => x.to === v);
        if (!r) break;
        if (!r.pair) chainAllPairs = false;
        v = r.from;
      }
      // A chain made ONLY of empty-pair halves dies with the character:
      // an empty pair has no content, and leaving it while deleting the
      // char before it fuses its markers with a preceding run's closer
      // into an unparseable delimiter run (`***bold*** ****` minus the
      // space = seven contiguous stars).
      if (chainAllPairs && v > line.from && !covered(v - 1)) {
        return {
          changes: { from: v - 1, to: head },
          selection: { anchor: v - 1 },
          userEvent: 'delete.backward',
        };
      }
      if (v > line.from && !covered(v - 1)) {
        // If this visible char is the run's ONLY content — a hidden range
        // ends right before it and the run's closing chain starts right
        // after — the markers die with it ("markers die when their content
        // dies"). Left behind, they become `**` orphans that FUSE with later
        // markers into a surprise bold run swallowing the caret. Marker
        // text must match (a `\`x\`` span inside `*…*` must not collapse
        // the italic when only x dies).
        const rv = ranges.find(r => r.from === v);
        const o = ranges.find(r => r.to === v - 1);
        if (o && rv &&
            state.sliceDoc(o.from, o.to) === state.sliceDoc(rv.from, rv.to)) {
          let of_ = o.from;
          for (;;) {
            const r2 = ranges.find(x => x.to === of_);
            if (!r2) break;
            of_ = r2.from;
          }
          return {
            changes: { from: of_, to: head },
            selection: { anchor: of_ },
            userEvent: 'delete.backward',
          };
        }
        return {
          changes: { from: v - 1, to: v },
          selection: { anchor: v - 1 },
          userEvent: 'delete.backward',
        };
      }
      // Leading inline marker with nothing visible before it. A marker-only
      // line still falls through to rule (c); otherwise join lines, or
      // no-op at the very top (deleting the opener alone would orphan the
      // closing marker into raw text).
      if (visible > 0) {
        if (line.number > 1) {
          return {
            changes: { from: line.from - 1, to: line.from },
            selection: { anchor: line.from - 1 },
            userEvent: 'delete.backward',
          };
        }
        return { selection: { anchor: head } };
      }
    }
  }

  // c. Marker-only line: clear it, joining to the previous line.
  if (visible === 0) {
    const from = line.number > 1 ? line.from - 1 : line.from;
    return {
      changes: { from, to: line.to },
      selection: { anchor: from },
      userEvent: 'delete.backward',
    };
  }

  // d. Last visible character takes the markup with it.
  const visibleAfter = visibleCharsBetween(atomic, head, line.to);
  if (visible === 1 && visibleAfter === 0) {
    return {
      changes: { from: line.from, to: line.to },
      selection: { anchor: line.from },
      userEvent: 'delete.backward',
    };
  }

  return null;
}
