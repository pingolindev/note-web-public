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
 * Notes whose people a notebook's deletion could not take off yet, and when.
 *
 * The delete dialog promises "anyone you shared them with through this
 * notebook loses access" (components/Sidebar), and a note whose rows could
 * not be read, even asked again, would otherwise keep them for good. Taken
 * off later (stores/notes `takeBackSoon`): every row made before that moment,
 * and none made well after it (a share the owner makes afterwards is theirs).
 *
 * Per account, in this browser.
 */
import { scopedGetItem, scopedSetItem } from './account';

export interface NoteToTakeBack {
  noteId: string;
  /** When the notebook was deleted (ISO): rows made up to then go. */
  before: string;
}

const KEY = 'pingolin_note_take_back';
/** Kept at most; the oldest goes first. */
export const TAKE_BACK_MAX = 500;

export function notesToTakeBack(): NoteToTakeBack[] {
  try {
    const raw = scopedGetItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((e): e is NoteToTakeBack => !!e && typeof e === 'object'
      && typeof e.noteId === 'string' && typeof e.before === 'string');
  } catch {
    return [];
  }
}

function save(list: NoteToTakeBack[]): void {
  try { scopedSetItem(KEY, JSON.stringify(list.slice(-TAKE_BACK_MAX))); } catch { /* not kept */ }
}

/** `noteId`'s people are to be taken off: those of its rows made before `before`. */
export function rememberTakeBack(noteId: string, before: string): void {
  const list = notesToTakeBack().filter(e => e.noteId !== noteId);
  save([...list, { noteId, before }]);
}

/** Taken off, or nothing is left to take. */
export function forgetTakeBack(noteId: string): void {
  const list = notesToTakeBack();
  const kept = list.filter(e => e.noteId !== noteId);
  if (kept.length !== list.length) save(kept);
}
