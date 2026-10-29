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
 * May a note be WRITTEN where the reader is standing?
 *
 * View-only is view-only: no composing or writing, and the option is hidden
 * in a shared notebook the reader may not add to.
 *
 * The server refuses a note added by someone who may not add: a composer
 * offered anyway would save the note OUTSIDE the notebook, reaching nobody,
 * while still showing it inside, with the composer reporting success; written
 * offline, it would sit waiting for a create that would never be taken
 * there. Not offering what cannot be done avoids all of it.
 *
 * Who may add is the server's rule, read here and not re-made: a note may
 * name a notebook its writer OWNS, or holds `contribute` on (lib/notebookItem
 * `notebookItemSharePermission`). "Can edit" and "Can view" both put `view`
 * on the notebook itself: an editor edits the notes that are there, and adds
 * none.
 */

/** The right on a shared NOTEBOOK's own share that lets its holder add and remove notes. */
export const MAY_ADD_NOTES = 'contribute';

/**
 * @param notebookId the notebook that is open; null outside any notebook.
 * @param isOwn whether that notebook is the reader's own.
 * @param sharedRight the right on the notebook's share, when it is one that
 *   was shared with the reader; undefined when this page holds no such share.
 */
export function mayWriteNotesHere(
  notebookId: string | null,
  isOwn: (notebookId: string) => boolean,
  sharedRight: (notebookId: string) => string | undefined,
): boolean {
  // Outside a notebook a new note is the reader's own, filed nowhere.
  if (notebookId === null) return true;
  if (isOwn(notebookId)) return true;
  // Somebody else's: only who may add. A notebook that is neither the
  // reader's own nor one this page holds a share of is not written into on a
  // guess: the server would refuse it, and that is the fault described above.
  return sharedRight(notebookId) === MAY_ADD_NOTES;
}
