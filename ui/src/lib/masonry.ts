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
 * Keep-style stacking for the notes grid: cards pack tightly under one
 * another instead of aligning to rows.
 *
 * ## Why this exists rather than `columns:` or `grid-template-rows: masonry`
 *
 * CSS multi-column stacks beautifully and gets the READING ORDER wrong:
 * multicol fills column 1 top-to-bottom, then column 2, so in a date-sorted
 * list the second-newest note sits BELOW the newest and the top-right card
 * can be the 19th. Plain `display: grid` fixes the order and flattens the
 * stacking — the whole point of a Keep-like grid. This restores the stacking
 * without giving the order back.
 *
 * `grid-template-rows: masonry` would be the real answer and is not shippable:
 * Firefox-only, behind a flag.
 *
 * ## How it works
 *
 * The grid gets a small `grid-auto-rows` unit and each card spans however many
 * of those units its content needs. Auto-placement then fills columns
 * left-to-right in DOM order, and each card starts at the first free row in its
 * column — which is stacking. Order is row-major because placement follows the
 * DOM, which is the property multicol cannot give.
 *
 * The span has to be computed from a measured height, so this is JS. It is
 * cheap: one `getBoundingClientRect` per card, batched in a single read pass
 * before any write, so it cannot thrash layout.
 *
 * ## Gaps
 *
 * `row-gap` is 0 and the gutter is baked into each span instead. A real
 * `row-gap` would apply between EVERY one of the N auto-rows a card spans, not
 * between cards — an 80-row card would carry 79 gutters inside itself.
 */

/** Auto-row height. Smaller packs tighter; every card rounds up to a multiple. */
const ROW = 4;

/** Cards whose height we have already written, so a no-op pass writes nothing. */
const lastSpan = new WeakMap<HTMLElement, number>();

function spanFor(height: number, gap: number): number {
  return Math.max(1, Math.ceil((height + gap) / ROW));
}

/**
 * Recompute spans for one grid.
 *
 * Reads every card first, then writes — never interleaved, or each write
 * invalidates layout for the next read and the pass becomes O(n) reflows.
 */
export function layoutGrid(grid: HTMLElement): void {
  const cards = grid.querySelectorAll<HTMLElement>('.note-card');
  if (!cards.length) return;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;

  // READ pass.
  const spans: number[] = [];
  for (const card of cards) {
    // `height` is the card's own content height: the grid never stretches it,
    // because `.notes-grid` sets `align-items: start`. If that ever changes,
    // this measurement starts reporting the TRACK height and every card locks
    // to whatever it was on the first pass.
    spans.push(spanFor(card.getBoundingClientRect().height, gap));
  }

  // WRITE pass.
  cards.forEach((card, i) => {
    if (lastSpan.get(card) === spans[i]) return;
    lastSpan.set(card, spans[i]);
    card.style.setProperty('--card-span', String(spans[i]));
  });
}

/**
 * Keep every `.notes-grid` in `root` stacked, and follow content changes.
 *
 * Returns a teardown. Safe to call when nothing matches.
 *
 * Card heights move for reasons no single event covers — notes arriving, a
 * filter changing, fonts loading, an attachment thumbnail decoding, the window
 * resizing, a preview re-rendering. A ResizeObserver on the cards catches all
 * of them without us enumerating them, which is the point of using one.
 */
export function attachMasonry(root: ParentNode = document): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};

  let frame = 0;
  const pending = new Set<HTMLElement>();
  const flush = () => {
    frame = 0;
    for (const g of pending) layoutGrid(g);
    pending.clear();
  };
  const schedule = (grid: HTMLElement) => {
    pending.add(grid);
    // Coalesce: a filter change resizes every card at once and would otherwise
    // run one full pass per card.
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const grid = (e.target as HTMLElement).closest<HTMLElement>('.notes-grid');
      if (grid) schedule(grid);
    }
  });

  const observed = new WeakSet<Element>();
  const sync = () => {
    for (const grid of root.querySelectorAll<HTMLElement>('.notes-grid')) {
      let unmeasured = false;
      for (const card of grid.querySelectorAll<HTMLElement>('.note-card')) {
        if (observed.has(card)) continue;
        observed.add(card);
        ro.observe(card);
        unmeasured = true;
      }
      // NEW CARDS ARE MEASURED NOW, NOT NEXT FRAME.
      //
      // A card that has never been through a pass is holding the `--card-span`
      // fallback, and the fallback is a DIFFERENT LAYOUT: 60 rows for
      // everything, the row-aligned grid this file exists to replace.
      // Coalescing that first pass into a rAF therefore does not save work, it
      // paints the wrong layout for one frame and then re-packs: most cards
      // move a moment after they appear, many into a different column, and
      // the cards visibly fly around on load.
      //
      // This runs from the MutationObserver's callback, which is a microtask:
      // it is still inside the task that inserted the cards, so the spans are
      // in place before the frame is painted and there is nothing to re-pack.
      // Reads are still batched ahead of writes inside layoutGrid, so it costs
      // one forced layout, not one per card.
      //
      // Everything else — a card growing a thumbnail, a font landing, a window
      // resize — is a CORRECTION to a layout already on screen, so it keeps the
      // coalesced rAF path.
      if (unmeasured) layoutGrid(grid);
      else schedule(grid);
    }
  };

  // Cards are added and removed by the framework, not by us, so watch the tree
  // rather than asking every caller to remember to re-run this.
  const mo = new MutationObserver(sync);
  mo.observe(root === document ? document.body : (root as Element), {
    childList: true,
    subtree: true,
  });
  sync();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    mo.disconnect();
    ro.disconnect();
  };
}
