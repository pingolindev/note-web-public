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
import { planDrop, compareNoteOrder, isPositionOnly, canWriteNote, type DropPlan } from './dropOrder';

/**
 * A drop has to LAND where the preview drew it.
 *
 * Checking the number `planDrop` returns would not catch the failure this
 * file exists for: a real, well-formed sortOrder that simply means nothing in
 * the dragged card's own section makes the card snap back to slot 0 (or fly
 * to the end of the grid) the instant the grid re-sorts. So every case here
 * APPLIES the plan and re-sorts with `compareNoteOrder`, the same comparator
 * `sortedActiveNotes` uses, and asserts the resulting position.
 *
 * The expected position is derived, not typed in: the grid renders pinned
 * notes then the rest, each in preview order, so `drawnOrder()` below is what
 * the user was looking at when they let go.
 */

interface N { id: string; isPinned: boolean; sortOrder: number; updatedAt: string }

const note = (id: string, sortOrder: number, isPinned = false, updatedAt = '2026-01-01T00:00:00Z'): N =>
  ({ id, isPinned, sortOrder, updatedAt });

/** What the two grids drew, given a preview: pinned section, then the others. */
const drawnOrder = (preview: N[]): string[] => [
  ...preview.filter(n => n.isPinned).map(n => n.id),
  ...preview.filter(n => !n.isPinned).map(n => n.id),
];

/** Apply a plan to the list, then sort the way the grid sorts. */
const settle = (list: N[], plan: DropPlan): string[] => {
  const applied = list.map(n => {
    if (plan.kind === 'single' && plan.id === n.id) return { ...n, sortOrder: plan.sortOrder };
    if (plan.kind === 'renumber') {
      const u = plan.updates.find(x => x.id === n.id);
      if (u) return { ...n, sortOrder: u.sortOrder };
    }
    return n;
  });
  return [...applied].sort(compareNoteOrder).map(n => n.id);
};

/** Move `id` to `to` in a copy — what NotesView's dragMove does to the preview. */
const move = (list: N[], id: string, to: number): N[] => {
  const out = [...list];
  const [moved] = out.splice(out.findIndex(n => n.id === id), 1);
  out.splice(to, 0, moved);
  return out;
};

/**
 * A realistic shape: 5 pinned notes carrying a previous renumber's
 * sortOrders, then unpinned notes on the negative-descending scheme
 * `createNote` assigns. The two ranges OVERLAP in the worst possible way —
 * every unpinned sortOrder is below every pinned one — which is what turns a
 * cross-section midpoint into a jump to slot 0.
 */
const LIST: N[] = [
  note('p0', 0, true), note('p1', 1024, true), note('p2', 2048, true),
  note('p3', 3072, true), note('p4', 4096, true),
  note('u0', -34), note('u1', -33), note('u2', -32), note('u3', -31), note('u4', -30),
];

describe('planDrop — a drop lands where the preview drew it', () => {
  it('within the unpinned section: the card stays where it was dropped', () => {
    const preview = move(LIST, 'u0', 8); // u0 down between u3 and u4
    const plan = planDrop(preview, 'u0');
    expect(plan.kind).toBe('single');
    expect(settle(LIST, plan)).toEqual(drawnOrder(preview));
  });

  it('within the pinned section: the card stays where it was dropped', () => {
    const preview = move(LIST, 'p0', 3); // p0 down between p3 and p4
    const plan = planDrop(preview, 'p0');
    expect(plan.kind).toBe('single');
    expect(settle(LIST, plan)).toEqual(drawnOrder(preview));
  });

  it('pinned card dragged into the OTHER notes lands at the end of the pinned grid', () => {
    // The midpoint of two unpinned neighbours is below every pinned
    // sortOrder, so a midpoint would return the card to slot 0 and the
    // drag would read as having done nothing.
    const preview = move(LIST, 'p0', 7); // spliced between u1 and u2
    const plan = planDrop(preview, 'p0');
    const settled = settle(LIST, plan);
    expect(settled).toEqual(drawnOrder(preview));
    expect(settled.slice(0, 5)).toEqual(['p1', 'p2', 'p3', 'p4', 'p0']);
  });

  it('unpinned card dragged into the PINNED block lands at the top of the others', () => {
    // The midpoint of two pinned neighbours is above every unpinned
    // sortOrder, so a midpoint would send the card to the end of a
    // 76-card grid.
    const preview = move(LIST, 'u2', 1); // spliced between p0 and p1
    const plan = planDrop(preview, 'u2');
    const settled = settle(LIST, plan);
    expect(settled).toEqual(drawnOrder(preview));
    expect(settled[5]).toBe('u2');
  });

  it('never rewrites the section the card did not come from', () => {
    const preview = move(LIST, 'p0', 7);
    const plan = planDrop(preview, 'p0');
    const touched = plan.kind === 'renumber' ? plan.updates.map(u => u.id)
      : plan.kind === 'single' ? [plan.id] : [];
    expect(touched.every(id => id.startsWith('p'))).toBe(true);
  });
});

describe('planDrop — the single-write fast path and its fallback', () => {
  it('takes the midpoint of the new neighbours', () => {
    const preview = move(LIST, 'u0', 8);
    expect(planDrop(preview, 'u0')).toEqual({ kind: 'single', id: 'u0', sortOrder: -30.5 });
  });

  it('a first slot goes one below the note it displaced, a last slot one above', () => {
    expect(planDrop(move(LIST, 'u4', 5), 'u4')).toEqual({ kind: 'single', id: 'u4', sortOrder: -35 });
    expect(planDrop(move(LIST, 'u0', 9), 'u0')).toEqual({ kind: 'single', id: 'u0', sortOrder: -29 });
  });

  it('renumbers only its own section when the neighbours are equal', () => {
    const flat: N[] = [
      note('p0', 0, true), note('p1', 0, true), note('p2', 0, true),
      note('u0', 0), note('u1', 0), note('u2', 0),
    ];
    const preview = move(flat, 'u0', 4); // between u1 and u2, both at 0
    const plan = planDrop(preview, 'u0');
    expect(plan.kind).toBe('renumber');
    if (plan.kind !== 'renumber') throw new Error('unreachable');
    // u1 is already 0 at index 0 of its section, so it is not rewritten.
    expect(plan.updates).toEqual([{ id: 'u0', sortOrder: 1024 }, { id: 'u2', sortOrder: 2048 }]);
    expect(settle(flat, plan)).toEqual(drawnOrder(preview));
  });

  it('writes nothing for a note alone in its section, or one that is not in the list', () => {
    const solo: N[] = [note('p0', 0, true), note('u0', -1), note('u1', -2)];
    expect(planDrop(move(solo, 'p0', 2), 'p0')).toEqual({ kind: 'none' });
    expect(planDrop(solo, 'nope')).toEqual({ kind: 'none' });
  });
});

describe('compareNoteOrder', () => {
  it('ranks pinned first, then sortOrder, then newest', () => {
    expect(compareNoteOrder(note('a', 9999, true), note('b', -9999, false))).toBeLessThan(0);
    expect(compareNoteOrder(note('a', 1), note('b', 2))).toBeLessThan(0);
    expect(compareNoteOrder(
      note('a', 0, false, '2026-01-01T00:00:00Z'),
      note('b', 0, false, '2026-02-01T00:00:00Z'),
    )).toBeGreaterThan(0);
  });
});

describe('isPositionOnly — what may NOT fork a conflict copy', () => {
  it('a drag writes only sortOrder', () => {
    expect(isPositionOnly({ sortOrder: -33.5 })).toBe(true);
  });

  it('anything the user typed forks as before', () => {
    expect(isPositionOnly({ title: 'hi' })).toBe(false);
    expect(isPositionOnly({ body: 'text' })).toBe(false);
    expect(isPositionOnly({ checklistItems: [] })).toBe(false);
    // A position alongside content is content: the text still needs rescuing.
    expect(isPositionOnly({ sortOrder: 1, body: 'text' })).toBe(false);
  });

  it('an empty update is not position-only — it has nothing to re-apply', () => {
    expect(isPositionOnly({})).toBe(false);
  });

  it('flags every other field as content, including ones added later', () => {
    // The set is an allowlist on purpose: a new field defaults to "content",
    // which forks. Forking something harmless is a nuisance; NOT forking a real
    // edit loses the user's text.
    for (const k of ['isPinned', 'isArchived', 'color', 'labels', 'notebookId', 'editMode', 'somethingNew']) {
      expect(isPositionOnly({ [k]: 1 }), k).toBe(false);
    }
  });
});

describe('the renumber leaves rows this account cannot write', () => {
  const flat: N[] = [
    note('mine0', 0), note('theirs', 0), note('mine1', 0), note('mine2', 0),
  ];
  const canWrite = (n: { id: string }) => n.id !== 'theirs';

  it('skips them, and keeps the slot so the others hold their order', () => {
    const preview = move(flat, 'mine2', 1); // between mine0 and theirs, both 0
    const plan = planDrop(preview, 'mine2', canWrite);
    expect(plan.kind).toBe('renumber');
    if (plan.kind !== 'renumber') throw new Error('unreachable');
    expect(plan.updates.map(u => u.id)).not.toContain('theirs');
    // mine2 took slot 1, so it is renumbered to 1024 and the slot 'theirs'
    // occupies (2048) is simply not written.
    expect(plan.updates).toEqual([{ id: 'mine2', sortOrder: 1024 }, { id: 'mine1', sortOrder: 3072 }]);
  });

  it('writes everything when every row is writable — the default', () => {
    const preview = move(flat, 'mine2', 1);
    const all = planDrop(preview, 'mine2');
    if (all.kind !== 'renumber') throw new Error('expected a renumber');
    expect(all.updates.map(u => u.id)).toContain('theirs');
  });
});

describe('canWriteNote', () => {
  it('an owned note has no inbox entry and is writable', () => {
    expect(canWriteNote(undefined)).toBe(true);
  });
  it('a share with edit permission is writable, a view share is not', () => {
    expect(canWriteNote({ permission: 'edit' })).toBe(true);
    expect(canWriteNote({ permission: 'view' })).toBe(false);
  });
});
