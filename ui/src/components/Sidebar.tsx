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

import { Component, createMemo, createSignal, For, Show } from 'solid-js';
import { notebooksStore, Notebook } from '../stores/notebooks';
import { notesStore } from '../stores/notes';
import { remindersStore } from '../stores/reminders';
import { sharesInboxStore } from '../stores/sharesInbox';
import { shareHealthStore } from '../stores/shareHealth';

/** The badge's words for `count` people not receiving a notebook's notes. */
function notReceivingTitle(count: number): string {
  return count === 1
    ? "1 person can't read everything in this notebook — open Share to see why"
    : `${count} people can't read everything in this notebook — open Share to see why`;
}
import SharedNotebooks from './SharedNotebooks';
import { confirmAction } from './ConfirmDialog';

interface Props {
  selectedNotebook: string | null;
  /** The labels lit in the filter row. */
  selectedLabels: string[];
  showReminders: boolean;
  showInbox: boolean;
  onSelect: (id: string | null) => void;
  /** Go to ONE label (null: none). The list here is a set of destinations; the
   *  filter row is where a second label narrows the first. */
  onSelectLabel: (label: string | null) => void;
  /** A lit label got a new name. */
  onLabelRenamed: (from: string, to: string) => void;
  onSelectReminders: () => void;
  onSelectInbox: () => void;
  onShareNotebook: (id: string) => void;
}

const Sidebar: Component<Props> = (props) => {
  const [creating, setCreating] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editName, setEditName] = createSignal('');

  // Label management state
  const [renamingLabel, setRenamingLabel] = createSignal<string | null>(null);
  const [labelRenameInput, setLabelRenameInput] = createSignal('');

  const labelCounts = createMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notesStore.notes()) {
      // Not a note held for an invitation the reader has not accepted: its
      // labels are not offered either (notesStore.allLabels), so counting it
      // would give a label one more note than any list would ever show.
      if (n.deleted || notesStore.heldForInvitation(n)) continue;
      for (const l of n.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return counts;
  });

  const startLabelRename = (label: string) => {
    setRenamingLabel(label);
    setLabelRenameInput(label);
  };

  const commitLabelRename = async () => {
    const oldName = renamingLabel();
    const newLabel = labelRenameInput().trim();
    setRenamingLabel(null);
    if (!oldName || !newLabel || oldName === newLabel) return;
    // Asked BEFORE the rewrite: once the last note has lost the old name the
    // view drops it from the lit labels, and there is nothing left to carry.
    const wasLit = props.selectedLabels.includes(oldName);
    // Rewrite every note that has the old label.
    for (const n of notesStore.notes().filter(n => n.labels.includes(oldName))) {
      const updated = n.labels.map(l => (l === oldName ? newLabel : l));
      // Dedupe if the new name was already on the note.
      const deduped = Array.from(new Set(updated));
      await notesStore.updateNote(n.id, { labels: deduped });
    }
    if (wasLit) props.onLabelRenamed(oldName, newLabel);
  };

  const deleteLabel = async (label: string) => {
    if (!(await confirmAction({
      message: `Remove "${label}" from all notes?`,
      detail: "Notes won't be deleted — only the label comes off them. Adding it back is a matter of retyping it on each note.",
      confirmLabel: 'Remove label',
      destructive: true,
    }))) return;
    for (const n of notesStore.notes().filter(n => n.labels.includes(label))) {
      await notesStore.updateNote(n.id, { labels: n.labels.filter(l => l !== label) });
    }
    // A lit label that no note carries any more is dropped by the view itself.
  };

  const handleCreate = () => {
    const name = newName().trim();
    if (name) {
      notebooksStore.create(name);
      setNewName('');
      setCreating(false);
    }
  };

  const startRename = (nb: Notebook) => {
    setEditingId(nb.id);
    setEditName(nb.name);
  };

  const handleRename = () => {
    if (editingId() && editName().trim()) {
      notebooksStore.rename(editingId()!, editName().trim());
    }
    setEditingId(null);
  };

  const handleDelete = async (nb: Notebook) => {
    if (await confirmAction({
      message: `Delete notebook "${nb.name}"?`,
      detail: 'Notes inside will become uncategorized. They are not deleted, and anyone you shared them with through this notebook loses access.',
      confirmLabel: 'Delete notebook',
      destructive: true,
    })) {
      // Forward secrecy: revoke + rotate any shared child notes BEFORE the
      // notebook and its share metadata go away, else former recipients keep
      // their per-note shares and content keys and read every future edit.
      await notesStore.unshareNotebookChildren(nb.id);
      notebooksStore.remove(nb.id);
      if (props.selectedNotebook === nb.id) props.onSelect(null);
    }
  };

  return (
    /* A <nav>, and named. It is a landmark — notebooks, labels, Reminders and
       Shared with me are the app's destinations — so a screen reader's
       landmark list has something to jump to and the hamburger's
       aria-controls has a target. The id is the target of that aria-controls
       (NotesView's header button). */
    <nav class="sidebar" id="note-sidebar" aria-label="Notebooks and labels">
      <div class="sidebar-section">
        <button
          class={props.selectedNotebook === null && !props.showReminders ? 'sidebar-item active' : 'sidebar-item'}
          onClick={() => props.onSelect(null)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          All notes
        </button>
        <button
          class={props.showReminders ? 'sidebar-item active' : 'sidebar-item'}
          onClick={props.onSelectReminders}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 2.6.8 5.1 2.3 7.3.4.6-.1 1.4-.9 1.4H3.6c-.8 0-1.3-.8-.9-1.4C4.2 14.1 5 11.6 5 9a7 7 0 0 1 7-7z"/><path d="M9 21a3 3 0 0 0 6 0"/></svg>
          <span class="sidebar-item-name">Reminders</span>
          <Show when={remindersStore.upcoming().length > 0}>
            <span class="sidebar-item-count">{remindersStore.upcoming().length}</span>
          </Show>
        </button>
        <button
          class={props.showInbox ? 'sidebar-item active' : 'sidebar-item'}
          onClick={props.onSelectInbox}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
          <span class="sidebar-item-name">Shared with me</span>
          <Show when={sharesInboxStore.unreadCount() > 0} fallback={
            <Show when={sharesInboxStore.sharedNotes().length > 0}>
              <span class="sidebar-item-count">{sharesInboxStore.sharedNotes().length}</span>
            </Show>
          }>
            <span class="sidebar-item-count sidebar-item-unread" title="New shares">
              {sharesInboxStore.unreadCount()}
            </span>
          </Show>
        </button>
      </div>

      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span>Notebooks</span>
          <button class="sidebar-add-btn" onClick={() => setCreating(true)} title="New notebook">+</button>
        </div>

        <For each={notebooksStore.notebooks()}>
          {(nb) => (
            <Show when={editingId() !== nb.id} fallback={
              <div class="sidebar-rename">
                <input
                  type="text"
                  value={editName()}
                  onInput={(e) => setEditName(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditingId(null); }}
                  onBlur={handleRename}
                  autofocus
                />
              </div>
            }>
              <div
                class={props.selectedNotebook === nb.id ? 'sidebar-item active' : 'sidebar-item'}
                onClick={() => props.onSelect(nb.id)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                {/* A truncated name is still readable on hover through the
                    tooltip, which matters because the row's own actions are
                    what the pointer is there for. */}
                <span class="sidebar-item-name" title={nb.name}>{nb.name}</span>
                <div class="sidebar-item-right">
                  {/* Shared-BY-ME state, not an action. The share button below
                      is in `sidebar-item-actions`, which only appears on hover,
                      so without this nothing on a resting row says whether this
                      notebook is already shared — and sharing a notebook grants
                      standing access to every note in it, including ones added
                      later, which is not a thing to have to hover to discover.
                      Read from the notebook's own recipient list, the same one
                      that auto-shares later notes. */}
                  <Show when={notebooksStore.getNotebookShares(nb.id).length > 0}>
                    <span
                      class="sidebar-item-shared"
                      role="img"
                      title={`Shared with ${notebooksStore.getNotebookShares(nb.id).length} ` +
                        `${notebooksStore.getNotebookShares(nb.id).length === 1 ? 'person' : 'people'}`}
                      aria-label="Shared notebook"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                      </svg>
                    </span>
                  </Show>
                  {/* Somebody on this notebook's standing list is not
                      receiving new notes — their key changed, or sharing to
                      them failed. Opens the Share panel, which says who and
                      why. */}
                  <Show when={shareHealthStore.notReceiving(nb.id).length > 0}>
                    <button
                      type="button"
                      class="sidebar-item-not-receiving"
                      title={notReceivingTitle(shareHealthStore.notReceiving(nb.id).length)}
                      aria-label={notReceivingTitle(shareHealthStore.notReceiving(nb.id).length)}
                      onClick={(e) => { e.stopPropagation(); props.onShareNotebook(nb.id); }}
                    >
                      ⚠
                    </button>
                  </Show>
                  <span class="sidebar-item-count">{nb.noteCount}</span>
                  <div class="sidebar-item-actions" onClick={(e) => e.stopPropagation()}>
                    <button class="sidebar-action" onClick={() => props.onShareNotebook(nb.id)} title="Share notebook">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                    </button>
                    <button class="sidebar-action" onClick={() => startRename(nb)} title="Rename">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="sidebar-action" onClick={() => handleDelete(nb)} title="Delete">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          )}
        </For>

        <Show when={creating()}>
          <div class="sidebar-rename">
            <input
              type="text"
              placeholder="Notebook name"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
              onBlur={() => { if (!newName().trim()) setCreating(false); }}
              autofocus
            />
            {/* Enter and Escape are the whole interface on a desktop keyboard,
                and neither exists on a touch one — without these buttons a phone
                would offer a text field with no way to commit or back out. CSS
                shows this row only under 600px; the buttons use onPointerDown so
                they beat the input's own onBlur, which would otherwise cancel the
                create before the click landed. */}
            <div class="notebook-create-actions">
              <button
                class="btn btn-sm btn-secondary"
                onPointerDown={(e) => { e.preventDefault(); setCreating(false); setNewName(''); }}
              >Cancel</button>
              <button
                class="btn btn-sm"
                onPointerDown={(e) => { e.preventDefault(); handleCreate(); }}
              >Save</button>
            </div>
          </div>
        </Show>
      </div>

      {/* Notebooks other people shared with us, below the user's own. An
          invitation rather than an automatic entry — see SharedNotebooks. */}
      <SharedNotebooks
        selectedNotebook={props.selectedNotebook}
        onSelect={props.onSelect}
      />

      <Show when={notesStore.allLabels().length > 0}>
        <div class="sidebar-section">
          <div class="sidebar-section-header">
            <span>Labels</span>
          </div>
          <For each={notesStore.allLabels()}>
            {(label) => (
              <Show when={renamingLabel() !== label} fallback={
                <div class="sidebar-rename">
                  <input
                    type="text"
                    value={labelRenameInput()}
                    onInput={(e) => setLabelRenameInput(e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitLabelRename(); if (e.key === 'Escape') setRenamingLabel(null); }}
                    onBlur={commitLabelRename}
                    autofocus
                  />
                </div>
              }>
                <div
                  class={props.selectedLabels.includes(label)
                    ? 'sidebar-item sidebar-item-label active'
                    : 'sidebar-item sidebar-item-label'}
                  onClick={() => props.onSelectLabel(
                    props.selectedLabels.length === 1 && props.selectedLabels[0] === label ? null : label,
                  )}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                    <line x1="7" y1="7" x2="7.01" y2="7"/>
                  </svg>
                  <span class="sidebar-item-name">{label}</span>
                  <div class="sidebar-item-right">
                    <span class="sidebar-item-count">{labelCounts().get(label) ?? 0}</span>
                    <div class="sidebar-item-actions" onClick={(e) => e.stopPropagation()}>
                      <button class="sidebar-action" onClick={() => startLabelRename(label)} title="Rename">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      </button>
                      <button class="sidebar-action" onClick={() => deleteLabel(label)} title="Remove from all notes">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                      </button>
                    </div>
                  </div>
                </div>
              </Show>
            )}
          </For>
        </div>
      </Show>
    </nav>
  );
};

export default Sidebar;
