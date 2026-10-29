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
 * The Pingolin Note backup format — one shape, shared by every client.
 *
 * WHY THIS EXISTS
 *   A client-specific export would carry its own subset of a note under its
 *   own field names (`content` vs `body`, snake_case vs camelCase), and none
 *   would carry enough to rebuild a note, so the same account would produce
 *   different, equally lossy answers depending on which device the user
 *   reached for.
 *
 *   So: one envelope, defined here, with a version on it. A restore reads this
 *   and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY
 *   - Attachment BYTES. They live in object storage, up to 100MB a user, and
 *     embedding them turns a text file into something a browser cannot build.
 *     The manifest below names them instead, so a restore can say what it could
 *     not bring back rather than silently dropping it.
 *   - Cached key material for notebook share recipients (their public keys and
 *     user ids). A restore must look those up fresh — reusing a cached key
 *     wraps a note for whoever held that key, which after a rotation is the
 *     wrong party. Emails and permissions survive; the crypto does not.
 *   - Anything belonging to other people: notes shared WITH this user, and the
 *     share grants other users hold.
 */

export const BACKUP_FORMAT = 'pingolin-note-backup';
/** Bump only for a breaking change; readers must reject a version they predate. */
export const BACKUP_FORMAT_VERSION = 2;

export interface BackupChecklistItem {
  text: string;
  checked: boolean;
}

/**
 * A note, whole. Field names match `NoteItem` in stores/notes.ts so the mapping
 * is a rename-free copy in both directions — casual renaming between formats
 * is how they diverge.
 */
export interface BackupNote {
  /** Preserved so a re-import is idempotent: the server answers 409 for an
   * item id it already has, so restoring the same file twice converges
   * instead of duplicating. */
  id: string;
  title: string;
  body: string;
  noteType: string;
  color: string | null;
  isPinned: boolean;
  isArchived: boolean;
  labels: string[];
  checklistItems?: BackupChecklistItem[];
  sortOrder: number;
  editMode: 'rich' | 'markdown';
  notebookId: string | null;
  hasAttachments: boolean;
  createdAt: string;
  updatedAt: string;
  /** Fields a newer client wrote that this one does not model. Carried verbatim
   *  for the same reason the note content JSON carries them: dropping them here
   *  would make a backup a downgrade. */
  extras?: Record<string, unknown>;
}

export interface BackupNotebook {
  id: string;
  name: string;
}

export interface BackupReminder {
  id: string;
  itemId: string;
  triggerAt: string;
  repeatRule: string | null;
}

export interface BackupShareRecipient {
  email: string;
  permission: 'edit' | 'view';
}

/** Named, not carried. See the header. */
export interface BackupAttachmentRef {
  noteId: string;
  /** Null when the client could not read the attachment list for that note. */
  filenames: string[] | null;
}

export interface NoteBackup {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** Which client wrote it — useful when a restore hits a client-specific gap. */
  client: string;
  generatedAt: string;
  /** False when the writer knew it was leaving something out. A restore shows
   *  this to the user before it starts. */
  isComplete: boolean;
  /** Human-readable reasons `isComplete` is false. */
  incompleteReasons?: string[];
  /**
   * Ids of the account's own notes this client could not decrypt, so they are
   * NOT in `notes`.
   *
   * The ids and not just a count, because a count cannot be chased. Some wraps
   * can open under neither the current vault key nor any recovered previous
   * one — with `/auth/previous-identities` returning an empty list, no key for
   * them exists anywhere. Only the ids make that diagnosable; "6 note(s)"
   * leaves nobody able to say which.
   *
   * These are ciphertext the account can no longer open, which under E2EE is not
   * something the server can repair. Listing them is the honest alternative to
   * omitting them silently.
   */
  undecryptableNoteIds?: string[];
  counts: {
    notes: number;
    notebooks: number;
    reminders: number;
    notesWithAttachments: number;
  };
  notebooks: BackupNotebook[];
  /** label → colour hex, from the user metadata blob. */
  labelColors: Record<string, string>;
  /** noteId → pinned editor mode. Lives in metadata, not in note bodies, so it
   *  is not covered by the notes array. */
  editorModes: Record<string, string>;
  /** notebookId → recipients, minus their cached keys. */
  notebookShares: Record<string, BackupShareRecipient[]>;
  notes: BackupNote[];
  reminders: BackupReminder[];
  attachments: BackupAttachmentRef[];
}

/**
 * Is this parsed JSON a backup this build can read?
 *
 * Deliberately strict about the envelope and forgiving about the contents: a
 * missing optional section restores as empty, but a file from a FUTURE format
 * version is refused outright rather than half-read. Half-restoring a format you
 * do not understand is how you get a partial account that looks whole.
 */
export function validateBackup(parsed: unknown): { ok: true; backup: NoteBackup } | { ok: false; error: string } {
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'That file is not a Pingolin backup — it is not JSON we recognise.' };
  }
  const b = parsed as Record<string, unknown>;
  if (b.format !== BACKUP_FORMAT) {
    return { ok: false, error: 'That file is not a Pingolin Note backup. Use Import for notes from other apps.' };
  }
  const version = typeof b.formatVersion === 'number' ? b.formatVersion : 0;
  if (version > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      error: `That backup was written by a newer version of Pingolin (format ${version}). Update the app, then restore it.`,
    };
  }
  if (!Array.isArray(b.notes)) {
    return { ok: false, error: 'That backup is missing its notes.' };
  }
  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      formatVersion: version,
      client: typeof b.client === 'string' ? b.client : 'unknown',
      generatedAt: typeof b.generatedAt === 'string' ? b.generatedAt : '',
      isComplete: b.isComplete !== false,
      incompleteReasons: Array.isArray(b.incompleteReasons) ? b.incompleteReasons as string[] : undefined,
      undecryptableNoteIds: Array.isArray(b.undecryptableNoteIds)
        ? (b.undecryptableNoteIds as string[]).filter(x => typeof x === 'string')
        : undefined,
      counts: (b.counts as NoteBackup['counts']) ?? {
        notes: (b.notes as unknown[]).length, notebooks: 0, reminders: 0, notesWithAttachments: 0,
      },
      notebooks: Array.isArray(b.notebooks) ? b.notebooks as BackupNotebook[] : [],
      labelColors: (b.labelColors as Record<string, string>) ?? {},
      editorModes: (b.editorModes as Record<string, string>) ?? {},
      notebookShares: (b.notebookShares as Record<string, BackupShareRecipient[]>) ?? {},
      notes: b.notes as BackupNote[],
      reminders: Array.isArray(b.reminders) ? b.reminders as BackupReminder[] : [],
      attachments: Array.isArray(b.attachments) ? b.attachments as BackupAttachmentRef[] : [],
    },
  };
}
