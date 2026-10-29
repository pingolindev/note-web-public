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
import { parsePingolinBackup } from './parsers/pingolinBackup';
import { validateBackup, BACKUP_FORMAT, BACKUP_FORMAT_VERSION, type NoteBackup } from '../backupFormat';
import type { ImportedNote } from './types';

/**
 * The round trip is the whole feature. Without the id, a re-import would
 * mint a fresh one and double the account; without `checklistItems`, a
 * checklist note would come back empty; without `notebookId`, everything
 * would come back unfiled. These tests are about a note surviving the trip
 * whole, and about a restore refusing files it cannot honour rather than
 * half-reading them.
 */

const NOTEBOOK_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_ID = '22222222-2222-4222-8222-222222222222';

function backupOf(overrides: Partial<NoteBackup> = {}): NoteBackup {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    client: 'web',
    generatedAt: '2026-08-12T00:00:00.000Z',
    isComplete: true,
    counts: { notes: 0, notebooks: 0, reminders: 0, notesWithAttachments: 0 },
    notebooks: [{ id: NOTEBOOK_ID, name: 'Work' }],
    labelColors: { urgent: '#ff0000' },
    editorModes: { [NOTE_ID]: 'markdown' },
    notebookShares: {},
    notes: [],
    reminders: [],
    attachments: [],
    ...overrides,
  };
}

const fullNote = {
  id: NOTE_ID,
  title: 'Shopping',
  body: 'body text',
  noteType: 'checklist',
  color: '#00ff00',
  isPinned: true,
  isArchived: false,
  labels: ['urgent', 'home'],
  checklistItems: [{ text: 'milk', checked: true }, { text: 'eggs', checked: false }],
  sortOrder: 7,
  editMode: 'markdown' as const,
  notebookId: NOTEBOOK_ID,
  hasAttachments: false,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-02-02T11:00:00.000Z',
  extras: { fromANewerClient: 'keep me' },
};

const asFile = (b: unknown) => new Blob([JSON.stringify(b)], { type: 'application/json' });

async function parseNotes(b: unknown): Promise<{ notes: ImportedNote[]; error: string | null }> {
  const notes: ImportedNote[] = [];
  let error: string | null = null;
  for await (const ev of parsePingolinBackup(asFile(b))) {
    if (ev.kind === 'note') notes.push(ev.note);
    if (ev.kind === 'error') error = ev.message;
  }
  return { notes, error };
}

describe('restoring a Pingolin backup', () => {
  it('carries a note across whole, every field of it', async () => {
    const { notes, error } = await parseNotes(backupOf({ notes: [fullNote] }));
    expect(error).toBeNull();
    expect(notes).toHaveLength(1);
    const n = notes[0];

    // The id is what makes a repeat restore converge instead of duplicating.
    expect(n.id).toBe(NOTE_ID);
    expect(n.title).toBe('Shopping');
    expect(n.body).toBe('body text');
    expect(n.noteType).toBe('checklist');
    // A checklist note keeps its content: the items are here.
    expect(n.checklistItems).toEqual([
      { text: 'milk', checked: true },
      { text: 'eggs', checked: false },
    ]);
    expect(n.color).toBe('#00ff00');
    expect(n.labels).toEqual(['urgent', 'home']);
    expect(n.isPinned).toBe(true);
    expect(n.sortOrder).toBe(7);
    expect(n.editMode).toBe('markdown');
    expect(n.notebookId).toBe(NOTEBOOK_ID);
    expect(n.extras).toEqual({ fromANewerClient: 'keep me' });
    expect(n.createdAt).toBe(Date.parse('2026-01-01T10:00:00.000Z'));
  });

  it('drops a notebook reference the file does not define, rather than filing a note nowhere', async () => {
    const orphan = { ...fullNote, notebookId: '33333333-3333-4333-8333-333333333333' };
    const { notes } = await parseNotes(backupOf({ notes: [orphan] }));
    // Better unfiled and visible than filed into a notebook that will never exist.
    expect(notes[0].notebookId).toBeUndefined();
  });

  it('ignores a malformed id instead of sending one the server would reject', async () => {
    // A bad id would 400 the create and LOSE the note; dropping it only costs
    // idempotence for that row.
    const { notes } = await parseNotes(backupOf({ notes: [{ ...fullNote, id: 'not-a-uuid' }] }));
    expect(notes[0].id).toBeUndefined();
    expect(notes[0].title).toBe('Shopping');
  });

  it('survives a hand-edited file with missing and wrong-typed fields', async () => {
    const junk = {
      id: NOTE_ID,
      title: 42,
      labels: ['ok', 7, null],
      checklistItems: [{ text: 'fine', checked: 'yes' }, { checked: true }],
      noteType: 'nonsense',
      editMode: 'sideways',
    };
    const { notes, error } = await parseNotes(backupOf({ notes: [junk as any] }));
    expect(error).toBeNull();
    const n = notes[0];
    expect(n.title).toBe('');
    expect(n.body).toBe('');
    expect(n.labels).toEqual(['ok']);
    expect(n.checklistItems).toEqual([{ text: 'fine', checked: true }]);
    expect(n.noteType).toBe('text');       // unknown type falls back
    expect(n.editMode).toBeUndefined();     // unknown mode is omitted, not guessed
  });

  it('emits nothing but a clean finish for an empty backup', async () => {
    const { notes, error } = await parseNotes(backupOf({ notes: [] }));
    expect(error).toBeNull();
    expect(notes).toEqual([]);
  });

  it('refuses a file that is not a Pingolin backup', async () => {
    // Standard Notes' own export, fed to the wrong reader.
    const { error } = await parseNotes({ items: [{ content_type: 'Note' }] });
    expect(error).toMatch(/not a Pingolin Note backup/i);
  });

  it('refuses a backup from a FUTURE format rather than half-reading it', async () => {
    const { error, notes } = await parseNotes(
      backupOf({ formatVersion: BACKUP_FORMAT_VERSION + 1, notes: [fullNote] }),
    );
    // Half-restoring a format you do not understand produces an account that
    // looks whole and is not.
    expect(error).toMatch(/newer version/i);
    expect(notes).toEqual([]);
  });

  it('reports unreadable JSON instead of throwing', async () => {
    const notes: ImportedNote[] = [];
    let error: string | null = null;
    for await (const ev of parsePingolinBackup(new Blob(['{ not json'], { type: 'application/json' }))) {
      if (ev.kind === 'note') notes.push(ev.note);
      if (ev.kind === 'error') error = ev.message;
    }
    expect(error).toMatch(/couldn't read that file/i);
    expect(notes).toEqual([]);
  });
});

describe('backup envelope validation', () => {
  it('accepts an older format version', () => {
    const r = validateBackup(backupOf({ formatVersion: 1 }));
    expect(r.ok).toBe(true);
  });

  it('defaults the optional sections so a minimal file still restores', () => {
    const minimal = { format: BACKUP_FORMAT, formatVersion: 2, notes: [] };
    const r = validateBackup(minimal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backup.notebooks).toEqual([]);
    expect(r.backup.reminders).toEqual([]);
    expect(r.backup.labelColors).toEqual({});
  });

  it('rejects a backup with no notes array at all', () => {
    const r = validateBackup({ format: BACKUP_FORMAT, formatVersion: 2 });
    expect(r.ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup('a string').ok).toBe(false);
  });
});
