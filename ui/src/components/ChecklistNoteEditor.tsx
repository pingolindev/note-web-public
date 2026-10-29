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
 * ChecklistNoteEditor — Google Keep-style interactive checklist.
 *
 * Used for notes with noteType === 'checklist'. Items are rendered as
 * interactive rows (checkbox, text input, drag handle, delete). Checked
 * items move under a collapsible "N Completed items" header. Unchecked
 * items are drag-reorderable.
 *
 * Source of truth: `items` — parent passes via props, receives updates via
 * onChange. The caller is responsible for serializing to NoteItem.
 */
import { Component, For, Show, createSignal, createMemo, onMount, onCleanup } from 'solid-js';
import type { ChecklistItem } from '../lib/checklistItems';

// The item shape and the save transforms live in `lib/checklistItems` — a
// plain module, so the transforms are unit-testable without mounting Solid.
// Re-exported here because every existing importer reaches for them through
// this component.
export type { ChecklistItem };

export interface ChecklistHandle {
  undo: () => void;
  redo: () => void;
}

interface Props {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => void;
  placeholder?: string;
  onReady?: (handle: ChecklistHandle) => void;
}

let nextRowId = 1;

const ChecklistNoteEditor: Component<Props> = (props) => {
  // Assign a stable client-side id to each item so drag/focus survive reorders.
  // We key by index into a parallel ids array rather than mutating items.
  const [rowIds, setRowIds] = createSignal<number[]>(
    props.items.map(() => nextRowId++)
  );
  // Keep rowIds in sync with items length on prop changes
  const ensureIds = (n: number) => {
    const current = rowIds();
    if (current.length === n) return current;
    if (current.length < n) {
      const extra = Array.from({ length: n - current.length }, () => nextRowId++);
      const next = [...current, ...extra];
      setRowIds(next);
      return next;
    }
    const next = current.slice(0, n);
    setRowIds(next);
    return next;
  };

  const [completedOpen, setCompletedOpen] = createSignal(false);
  // Pointer-drag state. `draggingId` drives the lifted-row styling reactively;
  // the live geometry lives in a plain ref so pointermove doesn't churn signals.
  const [draggingId, setDraggingId] = createSignal<number | null>(null);

  const uncheckedIndices = createMemo(() =>
    props.items.map((it, i) => ({ it, i })).filter(x => !x.it.checked).map(x => x.i)
  );
  const checkedIndices = createMemo(() =>
    props.items.map((it, i) => ({ it, i })).filter(x => x.it.checked).map(x => x.i)
  );

  // ---- Undo / redo (snapshot history with time-based coalescing) ----
  const [undoStack, setUndoStack] = createSignal<ChecklistItem[][]>([]);
  const [redoStack, setRedoStack] = createSignal<ChecklistItem[][]>([]);
  let lastEditAt = 0;
  const snapshot = () => props.items.map((it) => ({ ...it }));

  const record = () => {
    const now = Date.now();
    const coalesce = undoStack().length > 0 && now - lastEditAt < 400;
    lastEditAt = now;
    if (!coalesce) {
      setUndoStack([...undoStack(), snapshot()]);
      setRedoStack([]);
    }
  };

  const update = (next: ChecklistItem[], newIds?: number[]) => {
    record();
    if (newIds) setRowIds(newIds);
    else ensureIds(next.length);
    props.onChange(next);
  };

  const undoAction = () => {
    const stack = undoStack();
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    setUndoStack(stack.slice(0, -1));
    setRedoStack([...redoStack(), snapshot()]);
    lastEditAt = 0;
    ensureIds(prev.length);
    props.onChange(prev.map((it) => ({ ...it })));
  };

  const redoAction = () => {
    const stack = redoStack();
    if (stack.length === 0) return;
    const next = stack[stack.length - 1];
    setRedoStack(stack.slice(0, -1));
    setUndoStack([...undoStack(), snapshot()]);
    lastEditAt = 0;
    ensureIds(next.length);
    props.onChange(next.map((it) => ({ ...it })));
  };

  onMount(() => props.onReady?.({ undo: undoAction, redo: redoAction }));

  const addRow = () => {
    const next = [...props.items, { text: '', checked: false }];
    const ids = [...rowIds(), nextRowId++];
    update(next, ids);
    // Focus the new row on next tick
    queueMicrotask(() => focusRowByIndex(next.length - 1));
  };

  const setText = (index: number, text: string) => {
    const next = props.items.map((it, i) => (i === index ? { ...it, text } : it));
    update(next);
  };

  const toggleChecked = (index: number) => {
    const item = props.items[index];
    if (!item) return;
    const target = { ...item, checked: !item.checked };
    // Keep-style movement: when newly checked, move to TOP of checked group
    // (i.e., first position after last unchecked). When newly unchecked, move
    // to end of unchecked group.
    const ids = rowIds();
    const withoutIdx = props.items.filter((_, i) => i !== index);
    const idsWithout = ids.filter((_, i) => i !== index);
    if (target.checked) {
      const firstCheckedAt = withoutIdx.findIndex(it => it.checked);
      const insertAt = firstCheckedAt < 0 ? withoutIdx.length : firstCheckedAt;
      const nextItems = [...withoutIdx.slice(0, insertAt), target, ...withoutIdx.slice(insertAt)];
      const nextIds = [...idsWithout.slice(0, insertAt), ids[index], ...idsWithout.slice(insertAt)];
      update(nextItems, nextIds);
      // Expand the completed section so the user sees where it went
      if (!completedOpen()) setCompletedOpen(true);
    } else {
      // insert at end of unchecked run
      const firstCheckedAt = withoutIdx.findIndex(it => it.checked);
      const insertAt = firstCheckedAt < 0 ? withoutIdx.length : firstCheckedAt;
      const nextItems = [...withoutIdx.slice(0, insertAt), target, ...withoutIdx.slice(insertAt)];
      const nextIds = [...idsWithout.slice(0, insertAt), ids[index], ...idsWithout.slice(insertAt)];
      update(nextItems, nextIds);
    }
  };

  const removeRow = (index: number) => {
    const next = props.items.filter((_, i) => i !== index);
    const ids = rowIds().filter((_, i) => i !== index);
    update(next, ids);
  };

  const uncheckAll = () => {
    if (props.items.every(it => !it.checked)) return;
    const unchecked = props.items.map(it => ({ ...it, checked: false }));
    update(unchecked);
  };

  const deleteChecked = () => {
    const next = props.items.filter(it => !it.checked);
    const ids = rowIds().filter((_, i) => !props.items[i].checked);
    update(next, ids);
  };

  const handleKeyDown = (e: KeyboardEvent, index: number) => {
    // ---- Undo / redo reach the APP's stack, never the textarea's ----------
    //
    // Each row is a <textarea>, so the browser keeps its own edit history for
    // it — and the browser's undo fires an `input` event carrying
    // `inputType: "historyUndo"`, which lands in the onInput above and runs
    // setText -> update() -> record(). record()'s snapshot() reads
    // `props.items`, which at that instant is still the PRE-undo list, so the
    // browser's undo would push the state it had just undone onto our stack
    // and clear the redo stack with it: type "Bravo EXTRA", Ctrl+Z leaves
    // ["Alpha","Bravo"], then the toolbar's Undo hands back
    // ["Alpha","Bravo EXTRA"] — the Undo button would REDO what Ctrl+Z had
    // just undone, and the real redo would be gone.
    //
    // Without a handler here, the browser's history would be the only one the
    // keyboard could reach, and it only ever knows about ONE row.
    // preventDefault is what keeps the two histories from both running;
    // undoAction/redoAction restore whole snapshots, which is also the only
    // way an undo can cross rows, reverse a reorder, or bring a deleted row
    // back.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redoAction(); else undoAction();
      return;
    }
    // Ctrl+Y is Windows' other redo, and the same argument applies to it.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redoAction();
      return;
    }

    const item = props.items[index];
    if (!item) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      // Insert a new unchecked row directly after this one
      const next = [
        ...props.items.slice(0, index + 1),
        { text: '', checked: false },
        ...props.items.slice(index + 1),
      ];
      const ids = rowIds();
      const nextIds = [
        ...ids.slice(0, index + 1),
        nextRowId++,
        ...ids.slice(index + 1),
      ];
      update(next, nextIds);
      queueMicrotask(() => focusRowByIndex(index + 1));
    } else if (e.key === 'Backspace' && item.text === '' && props.items.length > 1) {
      e.preventDefault();
      const focusTarget = Math.max(0, index - 1);
      removeRow(index);
      queueMicrotask(() => focusRowByIndex(focusTarget));
    }
  };

  // ---- Pointer-based drag reorder (unchecked section only) ----
  // Native HTML5 DnD snaps rows with a browser ghost image and is invisible
  // on touch. This is a transform-based drag instead: the grabbed row lifts and
  // tracks the pointer 1:1 while its neighbours slide out of the way, then it
  // settles into the gap — matching the Android ItemTouchHelper feel.
  interface DragState {
    pointerId: number;
    startPos: number;      // grabbed row's position among unchecked (DOM order)
    rows: HTMLElement[];   // unchecked row elements, DOM order, at grab time
    rects: DOMRect[];      // their rects at grab time (handles variable heights)
    dragHeight: number;
    startClientY: number;
    rowEl: HTMLElement;
    target: number;        // current insertion position among unchecked
    settling: boolean;
  }
  let drag: DragState | null = null;

  const SETTLE_MS = 160;
  const SLIDE_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

  // If the component unmounts mid-drag (modal closed, note removed by a
  // remote sync), the window-level listeners and the page-wide
  // userSelect='none' would otherwise outlive it.
  onCleanup(() => {
    if (!drag) return;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    document.body.style.userSelect = '';
    drag = null;
  });

  const onHandlePointerDown = (e: PointerEvent, absoluteIndex: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (props.items[absoluteIndex]?.checked) return;
    const rowEl = (e.currentTarget as HTMLElement).closest('.checklist-row') as HTMLElement | null;
    if (!rowEl || !editorRef) return;
    const rows = Array.from(
      editorRef.querySelectorAll<HTMLElement>('.checklist-row:not(.checked)')
    );
    const startPos = rows.indexOf(rowEl);
    if (startPos < 0) return;
    e.preventDefault();
    const rects = rows.map((r) => r.getBoundingClientRect());
    drag = {
      pointerId: e.pointerId,
      startPos,
      rows,
      rects,
      dragHeight: rects[startPos].height,
      startClientY: e.clientY,
      rowEl,
      target: startPos,
      settling: false,
    };
    setDraggingId(rowIds()[absoluteIndex] ?? null);
    rowEl.style.transition = 'none';
    rowEl.style.zIndex = '20';
    rowEl.style.position = 'relative';
    rows.forEach((r, i) => {
      if (i !== startPos) r.style.transition = `transform ${SETTLE_MS}ms ${SLIDE_EASE}`;
    });
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onDragMove, { passive: false });
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  };

  // Slide every neighbour by exactly one grabbed-row height to open the gap at
  // `target`. The gap is always dragHeight regardless of neighbours' own
  // heights, so this is correct even with multi-line items.
  const applyDisplacement = () => {
    if (!drag) return;
    const { rows, startPos, target, dragHeight } = drag;
    rows.forEach((r, i) => {
      if (i === startPos) return;
      let shift = 0;
      if (i > startPos && i <= target) shift = -dragHeight;
      else if (i < startPos && i >= target) shift = dragHeight;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };

  const onDragMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId || drag.settling) return;
    e.preventDefault();
    const delta = e.clientY - drag.startClientY;
    drag.rowEl.style.transform = `translateY(${delta}px)`;
    const start = drag.rects[drag.startPos];
    const draggedCenter = start.top + start.height / 2 + delta;
    let target = 0;
    for (let i = 0; i < drag.rects.length; i++) {
      if (i === drag.startPos) continue;
      const c = drag.rects[i].top + drag.rects[i].height / 2;
      if (draggedCenter > c) target++;
    }
    if (target !== drag.target) {
      drag.target = target;
      applyDisplacement();
    }
  };

  const onDragEnd = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    document.body.style.userSelect = '';
    const d = drag;
    d.settling = true;

    // Where the grabbed row should come to rest = the gap left by the displaced
    // neighbours. Land it exactly on the target slot's coordinate so the
    // subsequent content swap is invisible.
    const { rects, startPos, target, dragHeight } = d;
    const restOffset =
      target === startPos
        ? 0
        : target > startPos
          ? rects[target].top + rects[target].height - dragHeight - rects[startPos].top
          : rects[target].top - rects[startPos].top;

    const finishCommit = () => {
      // Clear all visual transforms, then commit the reorder in one update.
      // Index-keyed <For> keeps the DOM nodes, so clearing + reordering data in
      // the same tick swaps content with no flash (the grabbed row already
      // settled onto the target slot's coordinate).
      d.rows.forEach((r) => {
        r.style.transition = '';
        r.style.transform = '';
      });
      d.rowEl.style.zIndex = '';
      d.rowEl.style.position = '';
      d.rowEl.style.transition = '';
      setDraggingId(null);
      drag = null;
      commitReorder(d.startPos, d.target);
    };

    d.rowEl.style.transition = `transform ${SETTLE_MS}ms ${SLIDE_EASE}`;
    void d.rowEl.offsetHeight; // commit the transition change so the next set animates
    d.rowEl.style.transform = restOffset ? `translateY(${restOffset}px)` : '';
    finishAfter(d.rowEl, finishCommit);
  };

  // Run `fn` once on transitionend (or a safety timeout) for the settle anim.
  const finishAfter = (el: HTMLElement, fn: () => void) => {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', once);
      fn();
    };
    el.addEventListener('transitionend', once);
    setTimeout(once, SETTLE_MS + 60);
  };

  // Reorder the unchecked items from display position `fromPos` to `toPos`,
  // leaving checked items in their slots.
  const commitReorder = (fromPos: number, toPos: number) => {
    if (fromPos === toPos) return;
    const uIdx = uncheckedIndices();          // absolute indices, display order
    const order = [...uIdx];
    const [movedAbs] = order.splice(fromPos, 1);
    order.splice(toPos, 0, movedAbs);
    const items = props.items;
    const ids = rowIds();
    const uItems = order.map((a) => items[a]);
    const uIds = order.map((a) => ids[a]);
    const nextItems: ChecklistItem[] = [];
    const nextIds: number[] = [];
    let k = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].checked) {
        nextItems.push(items[i]);
        nextIds.push(ids[i]);
      } else {
        nextItems.push(uItems[k]);
        nextIds.push(uIds[k]);
        k++;
      }
    }
    update(nextItems, nextIds);
  };

  let editorRef: HTMLDivElement | undefined;
  const focusRowByIndex = (index: number) => {
    if (!editorRef) return;
    const input = editorRef.querySelector<HTMLTextAreaElement>(
      `[data-row-index="${index}"] textarea`
    );
    input?.focus();
    // Place cursor at end
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  };

  return (
    <div class="checklist-editor" ref={editorRef}>
      {/* Unchecked items */}
      <For each={uncheckedIndices()}>
        {(absoluteIndex) => {
          const item = () => props.items[absoluteIndex];
          const isDragging = () => draggingId() !== null && draggingId() === rowIds()[absoluteIndex];
          return (
            <div
              class={`checklist-row${isDragging() ? ' dragging' : ''}`}
              data-row-index={absoluteIndex}
            >
              <span
                class="checklist-drag"
                title="Drag to reorder"
                onPointerDown={(e) => onHandlePointerDown(e, absoluteIndex)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="9" cy="5" r="1.8"/><circle cx="15" cy="5" r="1.8"/>
                  <circle cx="9" cy="12" r="1.8"/><circle cx="15" cy="12" r="1.8"/>
                  <circle cx="9" cy="19" r="1.8"/><circle cx="15" cy="19" r="1.8"/>
                </svg>
              </span>
              {/* The <label> IS the touch target. An <input type=checkbox>
                  with `appearance: auto` DISCARDS padding and border — a 44px
                  box with `padding: 12px` computes to `padding: 0` and the
                  engine simply paints the tick across the whole 44 — and an
                  outline is not hit-tested. The one thing it honours is a
                  non-square box, which is why CSS could only reach 24 wide by
                  44 tall. A label takes the 44x44 and forwards the activation
                  to the control, which is what a label is for; the input keeps
                  its own size so the tick stays tick-sized. */}
              <label class="checklist-checkbox-hit">
                <input
                  type="checkbox"
                  class="checklist-checkbox"
                  checked={item().checked}
                  onChange={() => toggleChecked(absoluteIndex)}
                />
              </label>
              <textarea
                class="checklist-input"
                rows={1}
                value={item().text}
                placeholder="List item"
                onInput={(e) => {
                  setText(absoluteIndex, e.currentTarget.value);
                  // Auto-size
                  e.currentTarget.style.height = 'auto';
                  e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                }}
                onKeyDown={(e) => handleKeyDown(e, absoluteIndex)}
              />
              <button
                class="checklist-delete"
                onClick={() => removeRow(absoluteIndex)}
                title="Delete item"
                tabIndex={-1}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          );
        }}
      </For>

      {/* Add new item */}
      <div class="checklist-add-row" onClick={addRow}>
        <span class="checklist-add-icon" aria-hidden="true">+</span>
        <span class="checklist-add-label">{props.placeholder ?? 'List item'}</span>
      </div>

      {/* Completed section */}
      <Show when={checkedIndices().length > 0}>
        <div class="checklist-completed">
          <button
            class="checklist-completed-header"
            onClick={() => setCompletedOpen(v => !v)}
          >
            <span class={`checklist-chevron ${completedOpen() ? 'open' : ''}`} aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </span>
            <span>{checkedIndices().length} Completed {checkedIndices().length === 1 ? 'item' : 'items'}</span>
          </button>

          <Show when={completedOpen()}>
            <div class="checklist-completed-actions">
              <button class="checklist-linkbtn" onClick={uncheckAll}>Uncheck all items</button>
              <span class="checklist-sep">·</span>
              <button class="checklist-linkbtn" onClick={deleteChecked}>Delete checked items</button>
            </div>
            <For each={checkedIndices()}>
              {(absoluteIndex) => {
                const item = () => props.items[absoluteIndex];
                return (
                  <div class="checklist-row checked" data-row-index={absoluteIndex}>
                    <span class="checklist-drag checklist-drag-disabled" aria-hidden="true"></span>
                    {/* Same 44x44 label wrapper as the unchecked rows above;
                        a done item is just as tappable as a live one. */}
                    <label class="checklist-checkbox-hit">
                      <input
                        type="checkbox"
                        class="checklist-checkbox"
                        checked={item().checked}
                        onChange={() => toggleChecked(absoluteIndex)}
                      />
                    </label>
                    <textarea
                      class="checklist-input checklist-input-checked"
                      rows={1}
                      value={item().text}
                      onInput={(e) => {
                        setText(absoluteIndex, e.currentTarget.value);
                        e.currentTarget.style.height = 'auto';
                        e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                      }}
                      onKeyDown={(e) => handleKeyDown(e, absoluteIndex)}
                    />
                    <button
                      class="checklist-delete"
                      onClick={() => removeRow(absoluteIndex)}
                      title="Delete item"
                      tabIndex={-1}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default ChecklistNoteEditor;
