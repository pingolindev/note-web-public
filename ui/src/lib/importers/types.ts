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
 * Shared types for the web editor's importer.
 *
 * Mirrors the Note Android app's `ImportedNote` model exactly — same
 * field names, same enum string values — so the two clients render the
 * same imported content. Don't drift.
 */

export interface ImportedChecklistItem {
  text: string;
  checked: boolean;
}

export interface ImportedNote {
  title: string;
  body: string;
  /** "text" or "checklist". */
  noteType: 'text' | 'checklist';
  checklistItems: ImportedChecklistItem[] | null;
  labels: string[];
  color: string | null;
  isPinned: boolean;
  isArchived: boolean;
  /** epoch millis from the source, or null if unknown. */
  createdAt: number | null;
  updatedAt: number | null;

  // ---- Restore-only fields ------------------------------------------------
  // Set ONLY by the Pingolin backup parser. Keep, Evernote and Standard Notes
  // have no equivalent of any of these, so foreign parsers leave them undefined
  // and the pipeline falls back to its default behaviour. They live here rather
  // than in a parallel type so one pipeline serves both jobs.

  /** The note's original id. Preserving it is what makes restoring the same
   * backup twice converge instead of duplicating: the server answers 409
   * for an id it already has, so the second run is a no-op. A foreign
   * import has no id and gets a fresh one. */
  id?: string;
  sortOrder?: number;
  editMode?: 'rich' | 'markdown';
  notebookId?: string | null;
  /** Content-JSON keys a newer client wrote. Carried verbatim so a restore
   *  from a newer build is not a downgrade. */
  extras?: Record<string, unknown>;
}

export type ImportSource =
  | 'GOOGLE_KEEP'
  | 'EVERNOTE'
  | 'STANDARD_NOTES'
  | 'PLAIN_TEXT'
  /** A Pingolin backup being restored, not a foreign file being imported. */
  | 'PINGOLIN_BACKUP';

export type ImportProgress =
  | { kind: 'parsing'; current: number; total: number | null; currentTitle: string | null }
  | { kind: 'note'; note: ImportedNote }
  | { kind: 'done'; total: number }
  | { kind: 'error'; message: string };

export type ImportState =
  | { kind: 'idle' }
  | { kind: 'importing'; current: number; currentTitle: string | null }
  | {
      kind: 'complete';
      /** Notes created. */
      count: number;
      /** A restore's notes that were already this account's (their id's 409 was ours). */
      present?: number;
      /** A restore's notes that could not be restored. */
      failed?: number;
      /** A restore: each backup note id that is here now → the id it is here under
       *  (its own, or the one derived for it when another account holds its own). */
      finalIds?: ReadonlyMap<string, string>;
      /** A restore: the backup note ids this restore created (not the ones already here). */
      createdIds?: ReadonlySet<string>;
    }
  | { kind: 'error'; message: string };
