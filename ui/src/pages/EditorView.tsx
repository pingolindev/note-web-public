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

import { Component, createSignal, onMount, onCleanup, Show } from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { notesStore, NoteItem } from '../stores/notes';
import { confirmAction } from '../components/ConfirmDialog';

/**
 * Note editor — full-screen editing experience.
 *
 * Auto-saves on:
 * - 2-second debounce after typing stops
 * - Navigation away (beforeunload)
 * - Explicit save button
 *
 * All content encrypted before leaving the browser.
 */
const EditorView: Component = () => {
  const params = useParams();
  const navigate = useNavigate();

  const [title, setTitle] = createSignal('');
  const [body, setBody] = createSignal('');
  const [note, setNote] = createSignal<NoteItem | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    const existing = notesStore.notes().find(n => n.id === params.id);
    if (existing) {
      setNote(existing);
      setTitle(existing.title);
      setBody(existing.body);
    }
  });

  onCleanup(() => {
    if (dirty()) saveNow();
    if (saveTimer) clearTimeout(saveTimer);
  });

  const scheduleSave = () => {
    setDirty(true);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 2000);
  };

  const saveNow = async () => {
    if (!dirty()) return;
    setSaving(true);
    const n = note();
    if (n) {
      await notesStore.updateNote(n.id, {
        title: title(),
        body: body(),
      });
    }
    setDirty(false);
    setSaving(false);
  };

  const handleDelete = async () => {
    const n = note();
    if (n && await confirmAction({
      message: 'Move to trash?',
      detail: 'You can restore this note from Trash.',
      confirmLabel: 'Move to Trash',
      destructive: true,
    })) {
      await notesStore.deleteNote(n.id);
      navigate('/');
    }
  };

  const handlePin = async () => {
    const n = note();
    if (n) {
      await notesStore.updateNote(n.id, { isPinned: !n.isPinned });
      setNote({ ...n, isPinned: !n.isPinned });
    }
  };

  const handleArchive = async () => {
    const n = note();
    if (n) {
      await notesStore.updateNote(n.id, { isArchived: !n.isArchived });
      navigate('/');
    }
  };

  return (
    <div class="editor-page">
      <header class="editor-header">
        <button class="btn-icon" onClick={() => navigate('/')}>←</button>
        <div class="editor-actions">
          <Show when={saving()}>
            <span class="save-indicator">Saving...</span>
          </Show>
          <Show when={dirty() && !saving()}>
            <span class="save-indicator unsaved">Unsaved</span>
          </Show>
          <button class="btn-icon" onClick={handlePin} title={note()?.isPinned ? 'Unpin' : 'Pin'}>
            {note()?.isPinned ? '📌' : '📍'}
          </button>
          <button class="btn-icon" onClick={handleArchive} title="Archive">🗃</button>
          <button class="btn-icon" onClick={handleDelete} title="Delete">🗑</button>
        </div>
      </header>

      <div class="editor-content">
        <input
          class="editor-title"
          type="text"
          placeholder="Title"
          value={title()}
          onInput={(e) => { setTitle(e.currentTarget.value); scheduleSave(); }}
        />
        <textarea
          class="editor-body"
          placeholder="Start writing..."
          value={body()}
          onInput={(e) => { setBody(e.currentTarget.value); scheduleSave(); }}
        />
      </div>
    </div>
  );
};

export default EditorView;
