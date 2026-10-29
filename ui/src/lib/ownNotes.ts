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
 * Which notes and notebooks this browser opened as the account's OWN.
 *
 * The shares inbox asks before it accepts a share: one that names an own note
 * or an own notebook is refused before anything is unwrapped. Without the
 * question a server could serve a "share" of the user's own note with a key it
 * chose, and the page would then seal that note's next save and its live
 * edits under the server's key.
 *
 * notes.ts answers for notes (registerOwnNoteCheck), notebooks.ts for notebooks
 * (registerOwnNotebookCheck). This module imports nothing, so no store has to
 * import another.
 */
let check: (itemId: string) => boolean = () => false;
let notebookCheck: (itemId: string) => boolean = () => false;

/** notes.ts: how to tell an own note by its id. */
export function registerOwnNoteCheck(fn: (itemId: string) => boolean): void {
  check = fn;
}

/** Is `itemId` a note this browser opened with the account's own vault? */
export function isOwnNote(itemId: string): boolean {
  return check(itemId);
}

/** notebooks.ts: how to tell an own notebook by its id. */
export function registerOwnNotebookCheck(fn: (itemId: string) => boolean): void {
  notebookCheck = fn;
}

/** Is `itemId` a notebook this browser opened with the account's own vault? */
export function isOwnNotebook(itemId: string): boolean {
  return notebookCheck(itemId);
}
