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
 * FLIP (First / Last / Invert / Play) for the notes grid.
 *
 * Reordering re-flows the whole grid, so cards jump to new positions
 * instantly and CSS `transition: transform` cannot follow those jumps.
 * FLIP compensates by snapshotting each card before the reorder, letting
 * the reorder happen, then applying a transform that pins the card
 * to its pre-reorder spot and animating that transform away via the
 * Web Animations API.
 *
 * The layout underneath is CSS grid — `repeat(auto-fill, 280px)` on
 * desktop, two fixed columns on a phone (`.notes-grid` in index.css).
 * Nothing here depends on the flow model, because the measurements
 * below are `offsetLeft`/`offsetTop` and `getBoundingClientRect`, which
 * mean the same thing under any layout. Do not read the flow model out of
 * this comment — read it out of the stylesheet.
 *
 * Why we track layout positions separately from visual rects. A
 * single reorder cascades: move one card and
 * several others shift to fill the gap. If we restart every card's
 * animation on every reorder (as naive FLIP does), rapid drags end
 * up continuously re-canceling an unrelated card's in-flight
 * animation the moment it starts, so cards crawl toward targets
 * they never quite reach.
 *
 * Instead we capture both:
 *   - the card's layout position (offsetLeft / offsetTop — these
 *     ignore any in-flight transform), and
 *   - its visual rect (getBoundingClientRect — which *does* include
 *     the running animation's transform).
 *
 * On playSlide we only disturb a card whose *layout* actually moved
 * since the last capture. Cards that happen to be mid-animation but
 * weren't repositioned this frame keep sliding toward the target
 * they were already heading for. For cards that did move, we cancel
 * their in-flight animation and start a fresh one from their last
 * known *visual* position — so even back-to-back reorders read as
 * one continuous motion rather than snap/restart/snap/restart.
 */

const FLIP_ANIM_KEY = '__flipSlide';

/**
 * The cards this animates — and the one it must never touch.
 *
 * `activateDrag` in NotesView.tsx picks the card up with `cloneNode(true)`, so
 * the floating clone carries the `note-card` class AND the same `data-note-id`
 * as the card it came from: a bare `.note-card[data-note-id]` matches it, and
 * `captureCardRects` would store the CLONE's rect under the dragged note's id
 * (same key, and the clone is last in the document).
 *
 * That poisoned entry is harmless on its own — the real card carries
 * `.dragging` and is skipped, so nothing reads it. What is NOT harmless is the
 * clone's own turn through `playSlide`. Its `left`/`top` are rewritten on every
 * pointermove, BEFORE the capture, so one move per frame is self-consistent and
 * nothing happens. Two moves in one task — which is what any 125Hz+ mouse
 * delivers — leave the first capture's rAF looking at a clone that has since
 * moved, `playSlide` reads that as a layout change, and the card the user is
 * holding gets a 600ms transform dragging it off their cursor.
 *
 * A drag driven one move per frame looks healthy either way, so only several
 * moves per task expose it.
 */
const CARDS = '.note-card[data-note-id]:not(.note-card-drag-clone)';

/**
 * On a card for exactly as long as its FLIP is in flight.
 *
 * A card sliding out of the way crosses the cursor on its way to its new slot,
 * and as a drop target mid-drag it would take the movement over for a note
 * the user was not aiming at, just by passing under the pointer. The LAYOUT
 * moved, the pointer did not, and only the pointer expresses intent.
 *
 * index.css turns this into `pointer-events: none` while a drag is in
 * progress, and NotesView's nearest-card fallback skips it as well — CSS
 * cannot hide an element from `querySelectorAll`, only from hit testing, and
 * that fallback searches the document directly.
 *
 * It is also meaningless to aim at a card in flight: with `fill: 'none'` the
 * card's real layout slot is already its DESTINATION, so where it appears
 * mid-animation is not where a drop would put it.
 */
const SETTLING = 'note-card-settling';

/** Drop the marker once nothing is animating this card any more. A cancel
 *  fires asynchronously, so a card whose FLIP was replaced in the same frame
 *  would otherwise have the class stripped by the OLD animation's event after
 *  the new one re-added it. */
function clearWhenSettled(c: HTMLElement): void {
  if (typeof c.getAnimations !== 'function') { c.classList.remove(SETTLING); return; }
  const stillMoving = c.getAnimations().some(
    a => (a as unknown as Record<string, unknown>)[FLIP_ANIM_KEY] && a.playState === 'running',
  );
  if (!stillMoving) c.classList.remove(SETTLING);
}

interface CardSnapshot {
  /** Layout position (unaffected by any in-flight transform). */
  layoutLeft: number;
  layoutTop: number;
  /** Current visual rect (includes any in-flight transform). */
  rect: DOMRect;
}

export function captureCardRects(): Map<string, CardSnapshot> {
  const out = new Map<string, CardSnapshot>();
  const cards = document.querySelectorAll<HTMLElement>(CARDS);
  cards.forEach((c) => {
    const id = c.dataset.noteId;
    if (!id) return;
    // Skip the dragged card at capture time — the .dragging class
    // disappears on drop, so checking only at playback would miss
    // it and we'd ghost-animate the dropped card.
    if (c.classList.contains('dragging')) return;
    out.set(id, {
      layoutLeft: c.offsetLeft,
      layoutTop: c.offsetTop,
      rect: c.getBoundingClientRect(),
    });
  });
  return out;
}

/**
 * How long a displaced card takes to reach its new slot.
 *
 * Measured against Google Keep in a side-by-side screen recording (30fps):
 * Keep moves a displaced card ~82px in about 6 frames, ≈200ms. At 600ms, and
 * with the easing below being Material's EMPHASIZED decelerate, half the time
 * goes on the last 18% of the distance: the card is still visibly creeping
 * long after the eye has finished with it, and since one drag sets several
 * cards going at once, they are all still going when the next swap starts —
 * the grid seems to swirl.
 *
 * 250 rather than Keep's 200 because Note's cards travel further — a column
 * step here is ~148px against Keep's ~82px — and because the drop landing is
 * 180ms, so this stays the slower, secondary motion it should be.
 *
 * ⚠️ This is also a RESPONSIVENESS number, not only an aesthetic one: a
 * card in flight is not a drop target (`note-card-settling`), so the animation
 * length caps how fast the grid can accept the next reorder.
 */
const SLIDE_MS = 250;

export function playSlide(oldSnapshots: Map<string, CardSnapshot>, duration = SLIDE_MS): void {
  // SELF-HEAL. The marker is normally dropped by the animation's own finish or
  // cancel event, but an animation that is PAUSED — a backgrounded tab, say —
  // fires neither, and a card left marked is one the drag can never target
  // again. Reconciling here costs one small query per reorder and cannot clear
  // a card that is genuinely still moving (clearWhenSettled tests for a
  // RUNNING animation).
  document.querySelectorAll<HTMLElement>(`.${SETTLING}`).forEach(clearWhenSettled);

  const cards = document.querySelectorAll<HTMLElement>(CARDS);
  cards.forEach((c) => {
    const id = c.dataset.noteId;
    if (!id) return;
    if (c.classList.contains('dragging')) return;
    const old = oldSnapshots.get(id);
    if (!old) return;

    // Check layout (not visual) to decide whether this card needs a
    // new animation. If its layout position is the same, any
    // running FLIP is already heading to the right place — let it
    // keep going. Restarting it here would just cancel and re-launch
    // with a freshly-curved ease, which gives a "crawl / stuck
    // halfway" feel during rapid drags.
    const newLayoutLeft = c.offsetLeft;
    const newLayoutTop = c.offsetTop;
    if (old.layoutLeft === newLayoutLeft && old.layoutTop === newLayoutTop) {
      return;
    }

    // Layout moved. Cancel any prior FLIP so the measurement below
    // reflects the true post-reorder visual position (cancel drops
    // fill:'none' transforms immediately). Because cancel, measure,
    // and new transform all happen inside the same rAF callback the
    // browser paints only the final state, no intermediate flash.
    if (typeof c.getAnimations === 'function') {
      for (const anim of c.getAnimations()) {
        if ((anim as unknown as Record<string, unknown>)[FLIP_ANIM_KEY]) {
          anim.cancel();
        }
      }
    }
    const newRect = c.getBoundingClientRect();
    const dx = old.rect.left - newRect.left;
    const dy = old.rect.top - newRect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

    if (typeof c.animate !== 'function') return;
    const anim = c.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'translate(0, 0)' },
      ],
      {
        duration,
        // Material's "emphasized decelerate" — soft landing, matches
        // the Keep reposition feel. Strict ease-in-out reads as too
        // mechanical for a cascade where multiple cards move in
        // different directions at once.
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        fill: 'none',
      },
    );
    (anim as unknown as Record<string, unknown>)[FLIP_ANIM_KEY] = true;
    c.classList.add(SETTLING);
    anim.onfinish = () => clearWhenSettled(c);
    anim.oncancel = () => clearWhenSettled(c);
  });
}
