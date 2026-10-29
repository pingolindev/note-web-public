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
 * Split an incoming `notebook_id` into what this client may USE and what it
 * must merely PRESERVE.
 *
 * Notebook membership travels inside the encrypted note payload, but notebooks
 * themselves live in each user's own metadata item under a locally generated
 * `crypto.randomUUID()`. So a shared note arrives carrying the SENDER's
 * notebook id — an id that can never match one of ours, and which we should
 * not hold as though it were ours: it is a stable correlator that groups
 * several shared notes as coming from one collection of theirs.
 *
 * It cannot simply be dropped, though. A recipient's edit re-encrypts the
 * WHOLE content blob and PUTs it, so a null here would delete the owner's
 * notebook assignment the moment the recipient touches the note. It is kept in
 * `ownerNotebookId` so the write path can put it back byte-for-byte.
 *
 * That field is write-path bookkeeping, and also what makes an accepted shared
 * notebook show its contents: see [noteIsInNotebook]. The two ids stay
 * separate because they mean different things — `notebookId` is "this is in
 * a notebook of MINE", `ownerNotebookId` is "the sender had it in one of
 * theirs" — and only the second may be matched against a notebook from
 * someone else's account.
 */
export function receiveNotebookId(
  parsedNotebookId: unknown,
  isIncomingShare: boolean,
): { notebookId: string | null; ownerNotebookId?: string | null } {
  const raw = typeof parsedNotebookId === 'string' && parsedNotebookId ? parsedNotebookId : null;
  return isIncomingShare
    ? { notebookId: null, ownerNotebookId: raw }
    : { notebookId: raw };
}

/**
 * Is this note in the given notebook, whether it is ours or one shared with us?
 *
 * An owner's note carries `notebookId`. The same note received by a RECIPIENT
 * carries `ownerNotebookId` instead, because the id names a notebook in the
 * sender's account. Matching only the first would make an accepted shared
 * notebook open empty.
 *
 * The disjunction is unambiguous: notebook ids are uuids, so a recipient's own
 * notebook can never collide with the sender's, and a note only ever populates
 * one of the two fields.
 */
export function noteIsInNotebook(
  note: { notebookId?: string | null; ownerNotebookId?: string | null },
  notebookId: string,
): boolean {
  return note.notebookId === notebookId || note.ownerNotebookId === notebookId;
}
