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
import { readFileSync } from 'fs';
import { join } from 'path';
import { MAY_ADD_NOTES, mayWriteNotesHere } from './notebookRights';
import { notebookItemSharePermission } from './notebookItem';

/**
 * View-only is view-only: no composing or writing, and no composer in a
 * shared notebook the reader may not add to. A note a reader wrote there
 * would be saved outside the notebook, reach nobody, and be shown inside it
 * as if it had.
 */
const OWN = new Set(['mine']);
const SHARED: Record<string, string> = { 'theirs-view': 'view', 'theirs-contribute': 'contribute', 'theirs-odd': 'edit' };
const may = (id: string | null) => mayWriteNotesHere(id, (n) => OWN.has(n), (n) => SHARED[n]);

describe('where a note may be written', () => {
  it('outside any notebook, and in a notebook of one\'s own', () => {
    expect(may(null)).toBe(true);
    expect(may('mine')).toBe(true);
  });

  it('in a shared notebook only by someone who may add notes to it', () => {
    expect(may('theirs-contribute')).toBe(true);
    expect(may('theirs-view')).toBe(false);
  });

  it('not on any other right, whatever it is called: the server knows one that adds', () => {
    expect(may('theirs-odd')).toBe(false);
  });

  it('not in a notebook this page knows nothing of', () => {
    expect(may('never-heard-of-it')).toBe(false);
  });

  it('one\'s own notebook is one\'s own even when a share of it is on the page', () => {
    expect(mayWriteNotesHere('mine', () => true, () => 'view')).toBe(true);
  });

  /** The rule is the server's: read from the same place the owner's page writes it. */
  it('the right that adds is the one the owner\'s page gives "Can add & remove notes", and no other grant', () => {
    expect(notebookItemSharePermission('contribute')).toBe(MAY_ADD_NOTES);
    expect(notebookItemSharePermission('edit')).not.toBe(MAY_ADD_NOTES);
    expect(notebookItemSharePermission('view')).not.toBe(MAY_ADD_NOTES);
  });
});

describe('the notes page', () => {
  const page = readFileSync(join(__dirname, '..', 'pages', 'NotesView.tsx'), 'utf8');

  it('offers the composer only where a note may be written', () => {
    // The composer's OWN condition (the same words also stand before the phone's compose row).
    expect(page).toContain('<Show when={view() === \'active\' && !selectionStore.isSelectionMode() && mayWriteHere()}>\n          <NoteComposer');
    // And nowhere without that question.
    expect(page.match(/<NoteComposer\b/g)).toHaveLength(1);
  });

  /** A button that opens a composer that is not there does nothing: none is offered either. */
  it('and with it every button that opens it: the phone\'s row and the floating ones', () => {
    const openers = page.match(/composerApi\(\)\?\.expand(Text|List)\(\)/g) ?? [];
    expect(openers).toHaveLength(4);
    const row = page.slice(page.indexOf('<div class="notebook-actions">') - 200, page.indexOf('<div class="notebook-actions">'));
    expect(row).toContain("<Show when={view() === 'active' && !selectionStore.isSelectionMode() && mayWriteHere()}>");
    const floating = page.slice(page.indexOf('<div class="notes-fab-stack">') - 600, page.indexOf('<div class="notes-fab-stack">'));
    expect(floating).toContain('&& mayWriteHere()');
  });

  it('asks it of the notebook that is open, with the reader\'s own notebooks and the right on the shared one', () => {
    expect(page).toContain('const mayWriteHere = () => mayWriteNotesHere(');
    expect(page).toContain('selectedNotebook(),');
    expect(page).toContain('(id) => notebooksStore.getById(id) !== undefined,');
    expect(page).toContain('(id) => sharesInboxStore.sharedNotebooks().find(s => s.itemId === id)?.sharePermission,');
  });
});
