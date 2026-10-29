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

import type { ImportProgress, ImportedNote } from '../types';
import { validateBackup, type BackupNote, type NoteBackup } from '../../backupFormat';
import { isEncryptedContainer } from '../../backupContainer';

/**
 * Restores a Pingolin Note backup — the file this app's own export writes.
 *
 * The other parsers in this directory read foreign formats and are lossy by
 * nature: Keep has no notebooks, Evernote has no pin. This one is the round
 * trip, so it is the only parser that carries ids, sort order, editor mode and
 * notebook membership. That difference is the whole point — without the id, a
 * restore cannot tell a note it already restored from a new one, and running it
 * twice doubles the account.
 *
 * Notebooks, label colours, editor-mode pins and reminders are NOT emitted as
 * notes; they live in the user metadata blob and the reminders table, and the
 * restore flow applies them separately (see `restoreBackupMetadata`).
 */
export async function* parsePingolinBackup(file: Blob): AsyncGenerator<ImportProgress> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    yield { kind: 'error', message: `Couldn't read that file: ${(e as Error).message}` };
    return;
  }

  // A SEALED backup cannot be opened here: this generator has no passphrase and
  // no way to ask for one. The restore flow reads and unseals the file first and
  // calls `parseBackupNotes` with the result, so reaching this branch means the
  // file arrived through the plain file picker.
  if (isEncryptedContainer(parsed)) {
    yield { kind: 'error', message: 'That backup is encrypted. Use Restore a backup, which will ask for its passphrase.' };
    return;
  }

  const result = validateBackup(parsed);
  if (!result.ok) {
    yield { kind: 'error', message: result.error };
    return;
  }
  yield* parseBackupNotes(result.backup);
}

/**
 * Emit the notes of an ALREADY-VALIDATED backup.
 *
 * A separate generator so the restore flow, which has to unseal the file
 * before it can validate it, does not have to parse the same file twice.
 */
export async function* parseBackupNotes(backup: NoteBackup): AsyncGenerator<ImportProgress> {
  // A note may only be filed into a notebook the SAME file defines. A dangling
  // id would file it somewhere the user has no way to open.
  const knownNotebooks = new Set(
    backup.notebooks.filter(nb => nb && typeof nb.id === 'string').map(nb => nb.id),
  );

  let count = 0;
  for (const n of backup.notes) {
    count++;
    yield { kind: 'parsing', current: count, total: backup.notes.length, currentTitle: n.title ?? '' };
    yield { kind: 'note', note: toImportedNote(n, knownNotebooks) };
  }

  yield { kind: 'done', total: count };
}

/**
 * A backup note is already in this app's own shape, so this is a copy rather
 * than a translation — but it still has to be defensive: the file is whatever
 * the user handed us, and a hand-edited or truncated backup must not throw
 * halfway through a restore.
 */
function toImportedNote(n: BackupNote, knownNotebooks: Set<string>): ImportedNote {
  const noteType: 'text' | 'checklist' = n.noteType === 'checklist' ? 'checklist' : 'text';
  return {
    title: typeof n.title === 'string' ? n.title : '',
    body: typeof n.body === 'string' ? n.body : '',
    noteType,
    checklistItems: Array.isArray(n.checklistItems)
      ? n.checklistItems
          .filter(i => i && typeof i.text === 'string')
          .map(i => ({ text: i.text, checked: !!i.checked }))
      : null,
    labels: Array.isArray(n.labels) ? n.labels.filter(l => typeof l === 'string') : [],
    color: typeof n.color === 'string' ? n.color : null,
    isPinned: !!n.isPinned,
    isArchived: !!n.isArchived,
    createdAt: parseIsoMs(n.createdAt),
    updatedAt: parseIsoMs(n.updatedAt),
    // A malformed id is worse than none: it would 400 the create and lose the
    // note, where dropping it just costs idempotence for that one row.
    ...(isUuid(n.id) ? { id: n.id } : {}),
    ...(typeof n.sortOrder === 'number' ? { sortOrder: n.sortOrder } : {}),
    ...(n.editMode === 'rich' || n.editMode === 'markdown' ? { editMode: n.editMode } : {}),
    // Only restore a notebook reference the backup also defines; a dangling
    // notebook id would file the note somewhere the user cannot see.
    ...(typeof n.notebookId === 'string' && knownNotebooks.has(n.notebookId)
      ? { notebookId: n.notebookId }
      : {}),
    ...(n.extras && typeof n.extras === 'object' ? { extras: n.extras } : {}),
    // `hasAttachments` is READ FROM the backup and deliberately NOT restored.
    // A backup names attachments but does not carry their bytes, so the
    // restored note genuinely has none — and there is no attachment row for it
    // to point at either. Setting the flag would render the attachment strip
    // for files that do not exist, which is worse than showing nothing: it
    // reads as data loss inside the app rather than an honest gap the restore
    // already warned about (see backupWarnings). Do not "fix" this by wiring
    // the flag through.
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function parseIsoMs(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
