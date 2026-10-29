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
 * Notes that did not reach someone in a notebook, to be sent again.
 *
 * A new note that failed to reach somebody who already had the notebook is
 * retried automatically. The Share panel says of such a person "the last
 * attempt failed. It is retried with the next note you add" (SharePanel,
 * NOT_RECEIVING_WHY); that is done here (stores/notes `resendUnsent`), and
 * after a sync too, at most every ten minutes.
 *
 * Per account, in this browser: what a note passed on from here could not
 * deliver. Only a failure that may pass is kept ('failed', 'cannot-sign'): a
 * changed key waits for the owner's "Update their access", which re-seals
 * every note, and a plan without sharing for an upgrade.
 */
import { scopedGetItem, scopedSetItem } from './account';
import type { ShareFailure } from './shareUtils';

export interface UnsentShare {
  noteId: string;
  notebookId: string;
  email: string;
  /** When it first did not go (ms). */
  since: number;
  /**
   * Not sent again before then (ms): what a finished invitation could not send
   * at once waits out the server's minute. Absent: with the next note.
   */
  notBefore?: number;
}

const KEY = 'pingolin_note_unsent_shares';
/** Kept at most; the oldest goes first. */
export const UNSENT_MAX = 500;
/** The failures that may pass, and so are tried again. */
export const RETRYABLE: ReadonlySet<ShareFailure> = new Set<ShareFailure>(['failed', 'cannot-sign']);

const sameShare = (e: UnsentShare, noteId: string, email: string) =>
  e.noteId === noteId && e.email.toLowerCase() === email.toLowerCase();

/** What is waiting to be sent again, oldest first; none when it cannot be read. */
export function unsentShares(): UnsentShare[] {
  try {
    const raw = scopedGetItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((e): e is UnsentShare => !!e && typeof e === 'object'
      && typeof e.noteId === 'string' && typeof e.notebookId === 'string'
      && typeof e.email === 'string' && typeof e.since === 'number'
      && (e.notBefore === undefined || typeof e.notBefore === 'number'));
  } catch {
    return [];
  }
}

function save(list: UnsentShare[]): void {
  try { scopedSetItem(KEY, JSON.stringify(list.slice(-UNSENT_MAX))); } catch { /* not kept */ }
}

/** `noteId` did not reach `email` in `notebookId`: kept when the failure may pass; `notBefore`: not tried again until then. */
export function rememberUnsent(noteId: string, notebookId: string, email: string, reason: ShareFailure, now = Date.now(), notBefore?: number): void {
  if (!RETRYABLE.has(reason)) return;
  const list = unsentShares();
  const before = list.find(e => sameShare(e, noteId, email));
  save([...list.filter(e => !sameShare(e, noteId, email)), {
    noteId, notebookId, email, since: before?.since ?? now,
    ...(notBefore !== undefined ? { notBefore } : {}),
  }]);
}

/** It reached them, or is not to any more. */
export function forgetUnsent(noteId: string, email: string): void {
  const list = unsentShares();
  const kept = list.filter(e => !sameShare(e, noteId, email));
  if (kept.length !== list.length) save(kept);
}
