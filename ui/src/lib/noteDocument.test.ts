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
import { noteDocument } from './noteDocument';
import type { NoteItem } from '../stores/notes';

/**
 * What a note is saved as: the one builder the save and the rescue after a
 * password reset both write with (lib/noteDocument).
 */

const card = (over: Partial<NoteItem> = {}): NoteItem => ({
  id: 'n1', title: 'T', body: 'B', noteType: 'text', color: '#fff', isPinned: true, isArchived: false,
  labels: ['l'], sortOrder: 4, editMode: 'markdown', notebookId: 'nb', hasAttachments: true,
  version: 2, createdAt: '', updatedAt: '', deleted: false, ...over,
} as NoteItem);

describe('noteDocument', () => {
  it('writes the card as it is, with another client\'s fields kept', () => {
    expect(noteDocument(card({ extras: { from_ios: { a: 1 } } }))).toEqual({
      from_ios: { a: 1 }, title: 'T', body: 'B', note_type: 'text', color: '#fff', is_pinned: true, is_archived: false,
      labels: ['l'], checklist_items: null, sort_order: 4, edit_mode: 'markdown', notebook_id: 'nb', has_attachments: true,
    });
  });

  it('our fields win over a stale copy of one of them among another client\'s', () => {
    const doc = noteDocument(card({ extras: { title: 'stale', body: 'stale', notebook_id: 'stale' } }), { title: 'new' });
    expect(doc).toMatchObject({ title: 'new', body: 'B', notebook_id: 'nb' });
  });

  it('a change goes over the card; a colour or a notebook can be set to none', () => {
    expect(noteDocument(card(), { body: 'B2', color: null, notebookId: null })).toMatchObject({ body: 'B2', color: null, notebook_id: null });
  });

  it('a shared note keeps its owner\'s notebook: the recipient\'s card has none', () => {
    expect(noteDocument(card({ notebookId: null, ownerNotebookId: 'owners-nb' }))).toMatchObject({ notebook_id: 'owners-nb' });
  });

  it('what a card leaves out is written as the defaults', () => {
    const bare = card({ checklistItems: undefined, sortOrder: undefined, editMode: undefined, hasAttachments: undefined, notebookId: undefined });
    expect(noteDocument(bare)).toMatchObject({ checklist_items: null, sort_order: 0, edit_mode: 'rich', has_attachments: false, notebook_id: null });
  });
});
