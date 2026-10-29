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
 * SelectionBar — sticks to the top of the notes area while one or more notes
 * are selected. Exposes bulk actions: pin/unpin, archive, delete, color,
 * label — or restore/delete-forever when the selection lives in Trash.
 */
import { Component, For, Show, createSignal } from 'solid-js';
import { notesStore } from '../stores/notes';
import { notebooksStore } from '../stores/notebooks';
import { selectionStore } from '../stores/selection';
import type { ViewMode } from './NoteCard';
import { confirmAction } from './ConfirmDialog';

const COLORS = [
  { name: 'None', value: null as string | null },
  { name: 'Red', value: '#f28b82' },
  { name: 'Orange', value: '#fbbc04' },
  { name: 'Yellow', value: '#fff475' },
  { name: 'Green', value: '#ccff90' },
  { name: 'Teal', value: '#a7ffeb' },
  { name: 'Blue', value: '#cbf0f8' },
  { name: 'Purple', value: '#d7aefb' },
  { name: 'Pink', value: '#fdcfe8' },
  { name: 'Brown', value: '#e6c9a8' },
  { name: 'Gray', value: '#e8eaed' },
];

interface Props {
  viewMode: ViewMode;
}

const SelectionBar: Component<Props> = (props) => {
  const [showColor, setShowColor] = createSignal(false);
  const [showLabel, setShowLabel] = createSignal(false);
  const [showNotebook, setShowNotebook] = createSignal(false);
  const [labelInput, setLabelInput] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const ids = () => [...selectionStore.selectedIds()];
  const selectedNotes = () => notesStore.notes().filter(n => selectionStore.isSelected(n.id));

  const allPinned = () => selectedNotes().length > 0 && selectedNotes().every(n => n.isPinned);
  const allArchived = () => selectedNotes().length > 0 && selectedNotes().every(n => n.isArchived);

  // Re-entrancy guard only — the buttons themselves stay enabled and
  // unchanged while an op runs. Flipping them to disabled (0.4 opacity)
  // would read as "everything changed color" for the whole — sequential —
  // round-trip.
  const run = async (fn: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  // All bulk ops fan the per-note requests out in parallel: each note is an
  // independent row, and awaiting them one at a time would make "pin 5 notes"
  // cost five sequential round-trips on phone latency.
  const bulkPin = () => run(async () => {
    const target = !allPinned();
    await Promise.all(ids().map(id => notesStore.updateNote(id, { isPinned: target })));
    selectionStore.clear();
  });

  const bulkArchive = () => run(async () => {
    const target = !allArchived();
    await Promise.all(ids().map(id => notesStore.updateNote(id, { isArchived: target })));
    selectionStore.clear();
  });

  const bulkDelete = () => run(async () => {
    if (!(await confirmAction({
      message: `Move ${ids().length} ${ids().length === 1 ? 'note' : 'notes'} to Trash?`,
      // The one thing a native confirm could never say, and the difference
      // between this dialog and the one below it.
      detail: 'You can restore them from Trash.',
      confirmLabel: 'Move to Trash',
      destructive: true,
    }))) return;
    await Promise.all(ids().map(id => notesStore.deleteNote(id)));
    selectionStore.clear();
  });

  const bulkRestore = () => run(async () => {
    await Promise.all(ids().map(id => notesStore.restoreNote(id)));
    selectionStore.clear();
  });

  const bulkPurge = () => run(async () => {
    if (!(await confirmAction({
      message: `Delete ${ids().length} ${ids().length === 1 ? 'note' : 'notes'} forever?`,
      detail: 'This cannot be undone. The notes are gone from every device.',
      confirmLabel: 'Delete forever',
      destructive: true,
    }))) return;
    for (const id of ids()) notesStore.permanentlyDelete(id);
    selectionStore.clear();
  });

  const bulkColor = (color: string | null) => run(async () => {
    await Promise.all(ids().map(id => notesStore.updateNote(id, { color })));
    setShowColor(false);
  });

  const bulkMoveToNotebook = (notebookId: string | null) => run(async () => {
    await Promise.all(ids().map(id => notesStore.updateNote(id, { notebookId })));
    setShowNotebook(false);
    selectionStore.clear();
  });

  const bulkAddLabel = () => run(async () => {
    const label = labelInput().trim();
    if (!label) return;
    await Promise.all(ids().map(id => {
      const note = notesStore.notes().find(n => n.id === id);
      if (!note || note.labels.includes(label)) return Promise.resolve(true);
      return notesStore.updateNote(id, { labels: [...note.labels, label] });
    }));
    setLabelInput('');
    setShowLabel(false);
  });

  return (
    <div class="selection-bar">
      <button class="selection-bar-close" onClick={() => selectionStore.clear()} title="Clear selection">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <span class="selection-bar-count">
        {selectionStore.count()}<span class="selection-bar-count-word"> selected</span>
      </span>
      <div class="selection-bar-spacer" />

      <Show when={props.viewMode !== 'trash'}>
      <button class="selection-bar-btn" onClick={bulkPin} title={allPinned() ? 'Unpin all' : 'Pin all'}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill={allPinned() ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
        </svg>
      </button>

      <div class="selection-bar-menu-wrap">
        <button class="selection-bar-btn" onClick={() => setShowColor(v => !v)} title="Change color">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.52-4.48-10-10-10z"/>
          </svg>
        </button>
        <Show when={showColor()}>
          <div class="selection-bar-popover" onClick={(e) => e.stopPropagation()}>
            <For each={COLORS}>
              {(c) => (
                <button
                  class="selection-bar-color"
                  title={c.name}
                  style={c.value ? `background:${c.value}` : ''}
                  onClick={() => bulkColor(c.value)}
                >
                  <Show when={!c.value}>
                    <span class="selection-bar-color-none">∅</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div class="selection-bar-menu-wrap">
        <button class="selection-bar-btn" onClick={() => setShowLabel(v => !v)} title="Add label">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
            <line x1="7" y1="7" x2="7.01" y2="7"/>
          </svg>
        </button>
        <Show when={showLabel()}>
          <div class="selection-bar-popover selection-bar-popover-wide" onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              class="selection-bar-label-input"
              placeholder="Add label..."
              value={labelInput()}
              onInput={(e) => setLabelInput(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); bulkAddLabel(); } }}
              autofocus
            />
            <button class="btn btn-sm" onClick={bulkAddLabel} disabled={!labelInput().trim()}>
              Add
            </button>
          </div>
        </Show>
      </div>

      <div class="selection-bar-menu-wrap">
        <button class="selection-bar-btn" onClick={() => setShowNotebook(v => !v)} title="Move to notebook">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
          </svg>
        </button>
        <Show when={showNotebook()}>
          <div class="selection-bar-popover selection-bar-popover-list" onClick={(e) => e.stopPropagation()}>
            <button class="selection-bar-notebook-item" onClick={() => bulkMoveToNotebook(null)}>
              No notebook
            </button>
            <For each={notebooksStore.notebooks()}>
              {(nb) => (
                <button
                  class="selection-bar-notebook-item"
                  onClick={() => bulkMoveToNotebook(nb.id)}
                  disabled={busy()}
                >
                  {nb.name}
                </button>
              )}
            </For>
            <Show when={notebooksStore.notebooks().length === 0}>
              <span class="selection-bar-hint">No notebooks yet</span>
            </Show>
          </div>
        </Show>
      </div>

      <button class="selection-bar-btn" onClick={bulkArchive} title={allArchived() ? 'Unarchive' : 'Archive'}>
        <Show when={allArchived()} fallback={
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
        }>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </Show>
      </button>

      <button class="selection-bar-btn" onClick={bulkDelete} title="Delete">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
      </Show>

      {/* Trash: restore / delete forever are the only meaningful bulk ops —
          pin/color/label/notebook on a trashed note would be write-throughs
          to notes on their way out. */}
      <Show when={props.viewMode === 'trash'}>
        <button class="selection-bar-btn" onClick={bulkRestore} title="Restore">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </button>
        <button class="selection-bar-btn selection-bar-btn-danger" onClick={bulkPurge} title="Delete forever">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </Show>
    </div>
  );
};

export default SelectionBar;
