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
 * What a note is saved as: the document a save encrypts under the note's key.
 *
 * One builder for every write of a whole note (the owner's save in
 * `notesStore.updateNote`, the shared-note save beside it, and the rescue of a
 * copy after a password reset, lib/noteRescue), so that none of them can write
 * a note differently from another. Another client's fields (`extras`) go first,
 * so this client's always win on a clash and a stale extra can never shadow a
 * value just computed.
 */
import type { NoteItem } from '../stores/notes';

export function noteDocument(existing: NoteItem, content: Partial<NoteItem> = {}) {
  return {
    ...(existing.extras ?? {}),
    title: content.title ?? existing.title,
    body: content.body ?? existing.body,
    note_type: content.noteType ?? existing.noteType,
    color: content.color !== undefined ? content.color : existing.color,
    is_pinned: content.isPinned ?? existing.isPinned,
    is_archived: content.isArchived ?? existing.isArchived,
    labels: content.labels ?? existing.labels,
    checklist_items: content.checklistItems ?? existing.checklistItems ?? null,
    sort_order: content.sortOrder ?? existing.sortOrder ?? 0,
    edit_mode: content.editMode ?? existing.editMode ?? 'rich',
    // `?? existing.ownerNotebookId` is load-bearing on a SHARED note:
    // notebookId is blanked on receive, and without this a recipient's save
    // would write null and remove the note from the OWNER's notebook.
    notebook_id: (content.notebookId !== undefined
      ? content.notebookId
      : (existing.notebookId ?? existing.ownerNotebookId ?? null)) as string | null,
    has_attachments: content.hasAttachments ?? existing.hasAttachments ?? false,
  };
}
