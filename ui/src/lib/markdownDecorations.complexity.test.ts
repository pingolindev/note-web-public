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
import { buildDecorations, blockScanCache } from './markdownDecorations';

/**
 * Does the editor's work grow with the size of the DOCUMENT?
 *
 * ## Why this test exists
 *
 * Rebuilding everything in response to an event that changed almost nothing
 * is an easy mistake to make and an easy one to miss: a suite that asserts
 * that decorations are CORRECT never notices whether producing them is
 * CHEAP. Those are orthogonal — a plugin that re-scans the whole note
 * produces perfectly correct decorations, and a p99 measured in seconds.
 *
 * ## Why it counts operations instead of timing them
 *
 * Timing the work at N and 10N and asserting the ratio FLAKES on a busy
 * machine. Idle, the ratio's coefficient of variation is ~3%; under heavy
 * background load it is ~21%, with observed ratios from 10.96 to 27.53. The
 * cause is structural: the 10N sample runs long enough to be preempted
 * mid-measurement while the N sample fits inside one scheduling quantum, so
 * dividing one by the other AMPLIFIES the interference. A gate like that gets
 * muted within a week, which is worse than no gate at all.
 *
 * Counting calls is exact: integers, identical on every run, on any machine,
 * with no warm-up, no device, and no baseline to re-bless as features land.
 */

/** Roughly what CodeMirror renders on a phone screen, at any document size. */
const VIEWPORT_LINES = 40;

type Mode = 'hybrid' | 'preview' | 'markdown';

/**
 * Lines read by a decoration build.
 *
 * `warm` distinguishes the two cases production actually has, which have
 * different budgets and must not be conflated:
 *
 *  - **warm** — the document did NOT change (a cursor move, a scroll). The
 *    block scan is served from cache, so the only work left is decorating the
 *    visible lines. This MUST be flat.
 *  - **cold** — the document changed (a keystroke). `scanBlocks` legitimately
 *    re-reads the whole document, because whether a visible line sits inside a
 *    fence is only knowable from line 1. Linear is the accepted cost here;
 *    anything worse fails.
 */
function lineReads(doc: string, mode: Mode = 'hybrid', warm = false): number {
  blockScanCache.doc = null;
  blockScanCache.scan = null;

  const state = EditorState.create({ doc, selection: { anchor: 0 } });
  const lastVisible = state.doc.line(Math.min(VIEWPORT_LINES, state.doc.lines));
  const visibleRanges = [{ from: 0, to: lastVisible.to }];

  let reads = 0;
  const countingDoc = new Proxy(state.doc as unknown as Record<string, unknown>, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'line' || prop === 'lineAt') {
        return (...args: unknown[]) => {
          reads++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  const countingState = new Proxy(state as unknown as Record<string, unknown>, {
    get: (target, prop) => (prop === 'doc' ? countingDoc : Reflect.get(target, prop)),
  });
  const view = { state: countingState, visibleRanges } as never;

  // Populate the cache exactly as the previous build would have, then count
  // only the second pass. The cache is keyed on document identity, so this has
  // to be the SAME state object — a fresh one would miss and measure a cold
  // build while claiming to measure a warm one.
  if (warm) {
    buildDecorations(view, mode as never);
    reads = 0;
  }

  buildDecorations(view, mode as never);
  return reads;
}

const prose = (n: number) =>
  Array.from({ length: n }, (_, i) => `Line ${i} with **bold** and *italic* text.`).join('\n');

/** Consecutive callout OPENERS — each one starts a block scan of its own. */
const callouts = (n: number) =>
  Array.from({ length: n }, (_, i) => `> [!note] Callout ${i}`).join('\n');

/** Work per doubling. ~1 = flat, ~2 = linear, ~4 = quadratic. */
const growth = (build: (n: number) => string, n: number, mode: Mode, warm: boolean) =>
  lineReads(build(n * 2), mode, warm) / lineReads(build(n), mode, warm);

describe('redecorating an unchanged document is flat', () => {
  /**
   * A cursor move or a scroll decorates one screenful. CodeMirror renders ~36
   * lines whatever the note's length — and decorations from a ViewPlugin are
   * collected only AFTER the viewport is computed, so work spent off-screen
   * cannot affect anything drawn.
   */
  it('reads a bounded number of lines however long the note is', () => {
    expect(growth(prose, 400, 'hybrid', true)).toBeLessThan(1.5);
  });

  it('is flat on consecutive callouts too', () => {
    expect(growth(callouts, 400, 'hybrid', true)).toBeLessThan(1.5);
  });

  it('is flat in preview mode', () => {
    expect(growth(prose, 400, 'preview', true)).toBeLessThan(1.5);
  });
});

describe('rebuilding after an edit stays linear', () => {
  /**
   * Typing re-runs the whole-document block scan, which is the accepted cost of
   * knowing whether a visible line is inside a fence. Linear is fine; the
   * assertion is that it never becomes worse.
   *
   * Guards the callout scan specifically: if its outer loop did not skip the
   * lines its inner loop had consumed, a note of consecutive callouts would be
   * O(n²) (334ms for ONE keystroke over 2,400 lines).
   */
  it('does not go quadratic on consecutive callouts', () => {
    expect(growth(callouts, 400, 'hybrid', false)).toBeLessThan(2.5);
  });

  it('stays linear on ordinary prose', () => {
    expect(growth(prose, 400, 'hybrid', false)).toBeLessThan(2.5);
  });
});

describe('the counter itself', () => {
  /**
   * If the count were noisy a failure would mean nothing, and this gate is
   * tight precisely because it cannot drift.
   */
  it('counts deterministically', () => {
    const runs = [lineReads(prose(300)), lineReads(prose(300)), lineReads(prose(300))];
    expect(new Set(runs).size).toBe(1);
  });
});
