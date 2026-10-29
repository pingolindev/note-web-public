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
 * Selection store — tracks multi-selected notes for bulk actions.
 */
import { createSignal, createMemo } from 'solid-js';

const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());

export const selectionStore = {
  selectedIds,

  isSelected: (id: string) => selectedIds().has(id),

  count: createMemo(() => selectedIds().size),

  isSelectionMode: createMemo(() => selectedIds().size > 0),

  toggle(id: string) {
    const next = new Set(selectedIds());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  },

  selectOnly(id: string) {
    setSelectedIds(new Set([id]));
  },

  clear() {
    setSelectedIds(new Set<string>());
  },

  setAll(ids: string[]) {
    setSelectedIds(new Set(ids));
  },
};
