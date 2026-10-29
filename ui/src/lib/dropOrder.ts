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
 * Where a dropped card's `sortOrder` goes.
 *
 * ## The trap
 *
 * The drag model is ONE flat list — `activeNotes()`, which the pointer handler
 * splices the dragged note into by its index in that list. The GRID is two
 * grids: `.section-label` "Pinned" over one `.notes-grid`, then "Other notes"
 * over another, because `sortedActiveNotes` sorts on `isPinned` BEFORE it looks
 * at `sortOrder`. So a card dragged across that boundary is spliced between two
 * notes of the other section, and computing its new sortOrder from THOSE
 * neighbours produces a number that means nothing in its own section.
 *
 * For example, with 5 pinned notes and 76 others (sortOrders 1024…4096 pinned,
 * −34…−27 unpinned):
 *
 *   - pinned card dragged down into the others → midpoint of two unpinned
 *     neighbours = −31; among the pinned notes that is the smallest number
 *     there is, so the card snaps back to slot 0. The drag looks like it
 *     did nothing.
 *   - unpinned card dragged up into the pinned block → midpoint of two pinned
 *     neighbours = 496.5; among the unpinned notes that is the largest, so the
 *     card flies to the END of a 76-card grid.
 *
 * Both would write a real, durable sortOrder, so the strange movement would
 * survive a reload. A drag WITHIN one section is unaffected, which makes the
 * cross-section case easy to miss.
 *
 * ## The rule
 *
 * The dragged note's own section is the list. Neighbours come from it, the
 * renumber fallback renumbers it, and nothing in the other section is touched.
 * That is also exactly what the preview DREW: the grid filters by `isPinned`,
 * so a pinned card dragged among the others is rendered at the end of the
 * pinned grid, and this lands it there. What you saw is what you get.
 */

/** The fields a drop needs. `NoteItem` satisfies this. */
export interface DropCandidate {
  id: string;
  isPinned: boolean;
  sortOrder?: number | null;
}

/** The fields the grid's own order depends on. `NoteItem` satisfies this. */
export interface OrderableNote {
  isPinned: boolean;
  sortOrder?: number | null;
  updatedAt: string;
}

/**
 * The grid's order, in one place.
 *
 * `sortedActiveNotes` in stores/notes.ts sorts with this, and dropOrder.test.ts
 * checks a plan by applying it and sorting with this — so the test measures
 * where a dropped card actually LANDS, not merely which number was written.
 * The two must not drift: `isPinned` outranking `sortOrder` is the whole reason
 * `planDrop` works per section.
 */
export function compareNoteOrder(a: OrderableNote, b: OrderableNote): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  return (a.sortOrder || 0) - (b.sortOrder || 0) || b.updatedAt.localeCompare(a.updatedAt);
}

export type DropPlan =
  /** Nothing to write — the note is alone in its section, or it is not here. */
  | { kind: 'none' }
  /** The single durable write: one note takes a sortOrder between its new neighbours. */
  | { kind: 'single'; id: string; sortOrder: number }
  /** Midpoint exhausted — renumber this section sparsely. May be empty. */
  | { kind: 'renumber'; updates: { id: string; sortOrder: number }[] };

/** Sparse renumber step. Gaps of 1024 keep the next few hundred drags into any
 *  one gap on the single-write path. */
const RENUMBER_STEP = 1024;

/**
 * Plan the write for dropping `draggedId` where `preview` now has it.
 *
 * `preview` is the whole active list in its previewed order (both sections,
 * interleaved as the pointer left them); the plan is computed against the
 * dragged note's own section.
 */
export function planDrop(
  preview: DropCandidate[],
  draggedId: string,
  /** Rows this account may write. The renumber fallback rewrites a whole
   *  section, and a section can contain notes shared TO you with `view`
   *  permission — somebody else's rows, which the server refuses with 403.
   *  Those writes must not go out: the local list would take the new numbers,
   *  the server would keep its own, and the next sync would yank those cards
   *  back. Default: everything is writable, which is what the unit tests and
   *  an account with no incoming shares see. */
  canWrite: (n: DropCandidate) => boolean = () => true,
): DropPlan {
  const dragged = preview.find(n => n.id === draggedId);
  if (!dragged) return { kind: 'none' };

  // THE SECTION IS THE LIST — see the header. `isPinned` outranks `sortOrder`
  // in the sort, so a sortOrder only ever competes with its own section.
  const section = preview.filter(n => n.isPinned === dragged.isPinned);
  const i = section.findIndex(n => n.id === draggedId);
  if (i < 0) return { kind: 'none' };

  const prev = i > 0 ? section[i - 1].sortOrder ?? 0 : null;
  const next = i < section.length - 1 ? section[i + 1].sortOrder ?? 0 : null;
  // Only note in its section: there is no order to express.
  if (prev === null && next === null) return { kind: 'none' };

  let sortOrder: number;
  if (prev === null) sortOrder = next! - 1;
  else if (next === null) sortOrder = prev + 1;
  else sortOrder = (prev + next) / 2;

  // Exhausted when the midpoint cannot separate the neighbours any more —
  // equal neighbours, or floats too close to have a value between them.
  const exhausted =
    (prev !== null && sortOrder <= prev) || (next !== null && sortOrder >= next);
  if (!exhausted) return { kind: 'single', id: draggedId, sortOrder };

  const updates: { id: string; sortOrder: number }[] = [];
  for (let j = 0; j < section.length; j++) {
    const target = j * RENUMBER_STEP;
    // Leave somebody else's row alone. Its slot in the sequence is still
    // consumed, so the notes around it keep their relative order.
    if (!canWrite(section[j])) continue;
    if (section[j].sortOrder !== target) updates.push({ id: section[j].id, sortOrder: target });
  }
  return { kind: 'renumber', updates };
}

/**
 * Does this update carry anything the user typed?
 *
 * A conflict copy exists to protect TEXT: two people edited the same note and
 * neither edit may be dropped, so both survive and a human decides. A drag
 * carries no text. It sets `sortOrder` — where the card sits — and forking a
 * whole second note over a position is not a rescue, it is damage: the user
 * moves a card and the grid gains "… (conflict copy)".
 *
 * Without this, one drag write that gets a 409 forks a whole second note
 * titled after the dragged card. A drop can 409 easily — the renumber path
 * writes a whole section in parallel, and any drag that follows before those
 * responses land is holding stale versions.
 *
 * So: content keys fork, position-only updates re-base and retry.
 */
const POSITION_ONLY_KEYS: ReadonlySet<string> = new Set(['sortOrder']);
export function isPositionOnly(content: Record<string, unknown>): boolean {
  const keys = Object.keys(content);
  return keys.length > 0 && keys.every(k => POSITION_ONLY_KEYS.has(k));
}

/**
 * May this account write the note at all?
 *
 * A note shared TO you with `view` permission is somebody else's row: the
 * server refuses every write to it with 403 SHARE_PERMISSION_DENIED, and
 * correctly so.
 *
 * That matters for a drag because `sortOrder` lives INSIDE the owner's
 * encrypted blob. There is nowhere else to put it, so a recipient reordering
 * a view-only note would preview the move, fail the write, and watch the
 * card slide back on the next sync. Offering the gesture at all would be the
 * lie; this is what withdraws it.
 *
 * ⚠️ NOT a general "read-only" rule: it governs reordering only, and the
 * editor's save path is not gated by it. `share` is the inbox entry for the
 * note, or undefined when the account owns it.
 */
export function canWriteNote(share: { permission: 'edit' | 'view' } | undefined): boolean {
  return !share || share.permission === 'edit';
}

// ─── The swap gate ───────────────────────────────────────────────────────────

/**
 * Whether a hover is allowed to reorder the preview.
 *
 * ## The oscillation this damps
 *
 * A swap puts the target card into the slot the dragged card just left — which
 * is usually right under the cursor — so on the next pointermove that card
 * claims the drop and the two trade back. The targets ALTERNATE, so a latch on
 * "the same target twice running" cannot see it: over one 30-step drag at
 * 1280px the targets run A, B, A, B … and the preview flips between two orders
 * 18 times — cards that hesitate and go back.
 *
 * ## ⚠️ And the freeze that damping it can cause
 *
 * Refusing any target index in the last three VACATED slots is not enough on
 * its own: if a refusal returns without touching that list, and the list only
 * advances on a SUCCESSFUL swap, a cursor sitting in a refused region can
 * never change anything, and the list can never age out. The drag goes dead
 * for the rest of the gesture.
 *
 * ## The rule
 *
 * The oscillation is driven by the LAYOUT moving under a still cursor, not by
 * where the cursor is. So the undo is refused only while the pointer is still
 * essentially where it was when that slot was vacated. Hold still and the flip
 * cannot start; move deliberately and you are obeyed. This cannot deadlock:
 * any continued movement releases every block within `UNDO_ZONE_PX`.
 */
export interface Pointer {
  x: number;
  y: number;
}

interface VacatedSlot {
  index: number;
  /** Where the pointer was when the dragged card left this slot. */
  at: Pointer;
}

export interface SwapGate {
  /**
   * The target whose swap already fired, and where the pointer was when it
   * did. Released by `releaseLatch` when the pointer reaches a different card,
   * OR — see considerSwap — once the pointer has simply travelled far enough.
   *
   * ⚠️ THE SECOND RELEASE IS NOT OPTIONAL. NotesView calls `releaseLatch` only
   * when the pointer reaches a DIFFERENT card, because treating a gutter or
   * the dragged card's own hole as "leaving" is half the jitter. With only TWO
   * cards in play there is no different card to reach, so without it the
   * latch would never clear and a pair could be swapped exactly once per drag:
   * a note could not be moved back and forth past one other note.
   */
  latch: { targetId: string; at: Pointer } | null;
  vacated: VacatedSlot[];
}

/**
 * How far the pointer must travel before a return to a just-vacated slot is
 * treated as intent rather than as the echo of the layout moving. A card is
 * ~144px wide and the gutters ~6px, so this is well inside "the user meant it"
 * while being far more than the jitter, which happens at a standstill.
 */
export const UNDO_ZONE_PX = 24;

/** Slots remembered at once. The pointer test does the real work; this only
 *  bounds the state for a drag that swaps many times without moving far. */
const VACATED_MEMORY = 3;

export function createSwapGate(): SwapGate {
  return { latch: null, vacated: [] };
}

export function resetSwapGate(gate: SwapGate): void {
  gate.latch = null;
  gate.vacated = [];
}

/** The pointer left a card, so hovering it again may fire a fresh swap. */
export function releaseLatch(gate: SwapGate, cardId: string): void {
  if (gate.latch?.targetId === cardId) gate.latch = null;
}

function distance(a: Pointer, b: Pointer): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export type SwapRefusal = 'same-slot' | 'latched' | 'undo-without-intent';

export interface SwapRequest {
  sourceIndex: number;
  targetIndex: number;
  targetId: string;
  pointer: Pointer;
}

export type SwapDecision =
  | { swap: true }
  | { swap: false; because: SwapRefusal };

/**
 * Decide, and age the gate's own state.
 *
 * ⚠️ This MUTATES `gate` on every call, refusals included — that is the whole
 * point. A block that can only be cleared by the thing it is blocking is a
 * deadlock: the freeze described above.
 */
export function considerSwap(gate: SwapGate, req: SwapRequest): SwapDecision {
  // Prune BOTH blocks first, on the same rule, so neither can survive a call it
  // did not decide. The latch and the vacated list answer the same question —
  // did the LAYOUT move under a still cursor, or did the user move? — so they
  // are released by the same evidence.
  gate.vacated = gate.vacated.filter(v => distance(v.at, req.pointer) < UNDO_ZONE_PX);
  if (gate.latch && distance(gate.latch.at, req.pointer) >= UNDO_ZONE_PX) gate.latch = null;

  if (req.sourceIndex === req.targetIndex) return { swap: false, because: 'same-slot' };
  if (req.targetId === gate.latch?.targetId) return { swap: false, because: 'latched' };
  if (gate.vacated.some(v => v.index === req.targetIndex)) {
    return { swap: false, because: 'undo-without-intent' };
  }

  gate.vacated = [{ index: req.sourceIndex, at: req.pointer }, ...gate.vacated]
    .slice(0, VACATED_MEMORY);
  gate.latch = { targetId: req.targetId, at: req.pointer };
  return { swap: true };
}
