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
import {
  createSwapGate, considerSwap, releaseLatch, resetSwapGate, UNDO_ZONE_PX,
  type SwapGate, type Pointer,
} from './dropOrder';

/**
 * Two properties that pull against each other, which is why both are pinned
 * here:
 *
 *   1. A still cursor must not make the preview flip between two orders.
 *      (The "cards hesitate and go back" jitter.)
 *   2. A MOVING cursor must never stop being obeyed.
 *      (Damping 1 the naive way freezes the drag — dead for the rest of the
 *      gesture.)
 *
 * A rule for either one alone is easy and wrong.
 */
const P = (x: number, y: number): Pointer => ({ x, y });

/** The oscillation, exactly: a swap displaces the target INTO the slot the
 *  dragged card left, so the next hover is that card, at the same index. */
function flipFlop(gate: SwapGate, pointer: Pointer, rounds: number) {
  const seen: boolean[] = [];
  let src = 0;
  for (let i = 0; i < rounds; i++) {
    const targetIndex = i % 2 === 0 ? 2 : 0;
    const targetId = i % 2 === 0 ? 'b' : 'a';
    const d = considerSwap(gate, { sourceIndex: src, targetIndex, targetId, pointer });
    seen.push(d.swap);
    if (d.swap) src = targetIndex;
    releaseLatch(gate, targetId);   // the pointer is over a different card now
  }
  return seen;
}

describe('a still cursor cannot start a flip-flop', () => {
  it('refuses the undo while the pointer has not moved', () => {
    const gate = createSwapGate();
    const swaps = flipFlop(gate, P(500, 400), 12);
    // The first one is a real reorder; nothing after it is, because the
    // pointer never moved.
    expect(swaps[0]).toBe(true);
    expect(swaps.slice(1).filter(Boolean)).toHaveLength(0);
  });

  it('names why it refused, so this is not confused with "no target"', () => {
    const gate = createSwapGate();
    const at = P(500, 400);
    considerSwap(gate, { sourceIndex: 0, targetIndex: 2, targetId: 'b', pointer: at });
    releaseLatch(gate, 'b');
    const d = considerSwap(gate, { sourceIndex: 2, targetIndex: 0, targetId: 'a', pointer: at });
    expect(d).toEqual({ swap: false, because: 'undo-without-intent' });
  });

  it('refuses the same target twice running while the pointer holds still', () => {
    const gate = createSwapGate();
    considerSwap(gate, { sourceIndex: 0, targetIndex: 3, targetId: 'c', pointer: P(100, 100) });
    const d = considerSwap(gate, { sourceIndex: 3, targetIndex: 5, targetId: 'c', pointer: P(108, 104) });
    expect(d).toEqual({ swap: false, because: 'latched' });
  });

  /**
   * ⚠️ The same target twice running is obeyed once the pointer has really
   * moved. Refusing it whether or not the pointer moved would make a pair of
   * notes un-swappable more than once per drag: with only two cards in play,
   * NotesView never reaches a different card, so it never calls releaseLatch,
   * and the latch would have no other way out. A pointer that has travelled a
   * long way and come back to the same card is expressing intent, not echoing
   * a layout change.
   */
  it('obeys the same target again once the pointer has really moved', () => {
    const gate = createSwapGate();
    considerSwap(gate, { sourceIndex: 0, targetIndex: 3, targetId: 'c', pointer: P(100, 100) });
    const d = considerSwap(gate, { sourceIndex: 3, targetIndex: 5, targetId: 'c', pointer: P(400, 400) });
    expect(d).toEqual({ swap: true });
  });

  it('a hover on the slot the card already occupies is not a swap', () => {
    const gate = createSwapGate();
    expect(considerSwap(gate, { sourceIndex: 4, targetIndex: 4, targetId: 'x', pointer: P(0, 0) }))
      .toEqual({ swap: false, because: 'same-slot' });
  });
});

describe('a moving cursor is always obeyed eventually', () => {
  it('releases the block once the pointer leaves the zone', () => {
    const gate = createSwapGate();
    const start = P(500, 400);
    considerSwap(gate, { sourceIndex: 0, targetIndex: 2, targetId: 'b', pointer: start });
    releaseLatch(gate, 'b');

    // Just inside: still the echo of the layout moving.
    const near = P(start.x + UNDO_ZONE_PX - 2, start.y);
    expect(considerSwap(gate, { sourceIndex: 2, targetIndex: 0, targetId: 'a', pointer: near }).swap)
      .toBe(false);

    // Past it: the user means it.
    const far = P(start.x + UNDO_ZONE_PX + 2, start.y);
    expect(considerSwap(gate, { sourceIndex: 2, targetIndex: 0, targetId: 'a', pointer: far }).swap)
      .toBe(true);
  });

  it('measures the zone as a distance, not per-axis', () => {
    const gate = createSwapGate();
    const start = P(500, 400);
    considerSwap(gate, { sourceIndex: 0, targetIndex: 2, targetId: 'b', pointer: start });
    releaseLatch(gate, 'b');
    // 18px on each axis: under the zone on either axis alone, over it as a
    // diagonal (25.5px). Diagonal drags are the common case, so an axis test
    // would leave them blocked.
    const diag = P(start.x + 18, start.y + 18);
    expect(considerSwap(gate, { sourceIndex: 2, targetIndex: 0, targetId: 'a', pointer: diag }).swap)
      .toBe(true);
  });

  /**
   * ⚠️ THE FREEZE THIS FILE EXISTS FOR. A rule that refuses any target in the
   * last three vacated slots and returns WITHOUT touching that list lets the
   * list advance only on a success that the list itself prevents. Here the
   * pointer sweeps a long way across the grid; every hover must remain
   * answerable.
   */
  it('never goes dead on a pointer that keeps moving', () => {
    // A gesture where the card is roughly where it should go and the hand
    // is fine-tuning: the pointer keeps travelling but revisits the SAME FEW
    // SLOTS. A rule that refuses a target in the vacated list without
    // advancing that list would see those slots fill it, refuse every hover,
    // and answer nothing in the second half of this loop.
    const gate = createSwapGate();
    const NEIGHBOURHOOD = [3, 4, 5];
    let src = 4;
    let swaps = 0, firstHalf = 0, secondHalf = 0;
    for (let step = 0; step < 300; step++) {
      // 3px a frame — a real hand's pace, well under the zone per step, so
      // nothing here is rescued by one big jump.
      const pointer = P(300 + step * 3, 400);
      const targetIndex = NEIGHBOURHOOD[step % NEIGHBOURHOOD.length];
      const d = considerSwap(gate, { sourceIndex: src, targetIndex, targetId: `n${targetIndex}`, pointer });
      if (d.swap) { src = targetIndex; swaps++; step < 150 ? firstHalf++ : secondHalf++; }
      releaseLatch(gate, `n${targetIndex}`);
    }
    expect(swaps).toBeGreaterThan(20);
    // The failure to guard against is a drag that stops PARTWAY. Both halves
    // of the gesture must be answered, or the count above could be earned
    // entirely before the drag went dead.
    expect(firstHalf).toBeGreaterThan(5);
    expect(secondHalf).toBeGreaterThan(5);
  });

  it('cannot hold a block across a pointer jump of any size', () => {
    const gate = createSwapGate();
    considerSwap(gate, { sourceIndex: 0, targetIndex: 1, targetId: 'a', pointer: P(0, 0) });
    releaseLatch(gate, 'a');
    const d = considerSwap(gate, { sourceIndex: 1, targetIndex: 0, targetId: 'b', pointer: P(900, 700) });
    expect(d.swap).toBe(true);
  });

  it('prunes on a REFUSAL too — a block must not outlive the call that saw it', () => {
    const gate = createSwapGate();
    const start = P(500, 400);
    considerSwap(gate, { sourceIndex: 0, targetIndex: 2, targetId: 'b', pointer: start });
    releaseLatch(gate, 'b');
    expect(gate.vacated).toHaveLength(1);
    // A refused call, far away: the refusal is for a different reason, and the
    // stale block is gone by the time it returns.
    considerSwap(gate, { sourceIndex: 2, targetIndex: 2, targetId: 'q', pointer: P(900, 700) });
    expect(gate.vacated).toHaveLength(0);
  });
});

/**
 * ⚠️ THE GATE AS NOTESVIEW ACTUALLY DRIVES IT. `releaseLatch` is called only
 * when the pointer reaches a DIFFERENT card — moving onto a gutter, the hole
 * the dragged card left, or the clone is deliberately not "leaving the target"
 * (that is half the jitter). So with only TWO cards in play there is no third
 * card to hover, and without the release by distance the pair could be
 * swapped exactly once per drag: a note could not be moved back and forth
 * past one other note.
 */
function hoverSequence(gate: SwapGate, steps: Array<{ id: string; index: number; at: Pointer }>) {
  let lastHovered: string | null = null;
  let source = 0;
  const swaps: boolean[] = [];
  for (const s of steps) {
    if (s.id !== lastHovered) {
      if (lastHovered) releaseLatch(gate, lastHovered);
      lastHovered = s.id;
    }
    const d = considerSwap(gate, {
      sourceIndex: source, targetIndex: s.index, targetId: s.id, pointer: s.at,
    });
    swaps.push(d.swap);
    if (d.swap) source = s.index;
  }
  return swaps;
}

describe('two cards, swapped back and forth', () => {
  it('lets the same pair trade places more than once in one drag', () => {
    const gate = createSwapGate();
    // A is dragged. Hover B, they swap. The pointer then travels to where B
    // now sits — a real move, hundreds of px — and hovers it again.
    const swaps = hoverSequence(gate, [
      { id: 'b', index: 1, at: P(100, 100) },
      { id: 'b', index: 0, at: P(100, 260) },
      { id: 'b', index: 1, at: P(100, 100) },
    ]);
    expect(swaps).toEqual([true, true, true]);
  });

  it('but a STILL pointer still cannot make them trade', () => {
    // The same sequence without moving: this is the oscillation the latch is
    // for, and it must stay refused.
    const gate = createSwapGate();
    const swaps = hoverSequence(gate, [
      { id: 'b', index: 1, at: P(100, 100) },
      { id: 'b', index: 0, at: P(100, 104) },
      { id: 'b', index: 1, at: P(100, 100) },
    ]);
    expect(swaps[0]).toBe(true);
    expect(swaps.slice(1).filter(Boolean)).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('a fresh drag starts with nothing remembered', () => {
    const gate = createSwapGate();
    considerSwap(gate, { sourceIndex: 0, targetIndex: 2, targetId: 'b', pointer: P(1, 1) });
    expect(gate.vacated.length + (gate.latch ? 1 : 0)).toBeGreaterThan(0);
    resetSwapGate(gate);
    expect(gate).toEqual({ latch: null, vacated: [] });
  });

  it('releaseLatch only clears the card named', () => {
    const gate = createSwapGate();
    considerSwap(gate, { sourceIndex: 0, targetIndex: 2, targetId: 'b', pointer: P(1, 1) });
    releaseLatch(gate, 'someone-else');
    expect(gate.latch?.targetId).toBe('b');
    releaseLatch(gate, 'b');
    expect(gate.latch).toBeNull();
  });
});
