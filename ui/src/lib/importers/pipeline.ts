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

import { apiRequest } from '../apiClient';
import {
  encryptWithContentKey,
  generateContentKey,
  isCryptoReady,
  wrapContentKeyWithVault,
} from '../crypto';
import { notesStore } from '../../stores/notes';
import { getTabAccount, isAccountStop, tryCanonicalAccountId } from '../account';
import { derivedRestoreId } from '../restoreIds';
import { sendWrite, writesForRun, type Writes } from './rateLimit';
import type { ImportProgress, ImportState, ImportedNote } from './types';

/** What became of one note. 'stopped': the tab is another account's now, and
 *  nothing more is sent (isAccountStop). */
export type UploadOutcome = { kind: 'created' | 'present'; id: string } | { kind: 'failed' } | { kind: 'stopped' };

export interface IngestOptions {
  /** A restore's key for derived ids (restoreIds): a note whose own id another
   *  account holds is filed under the id derived from it. Without it, such a
   *  note is simply not restored. */
  reIdKey?: CryptoKey | null;
  /** The run's writes (rateLimit): its budget under the server's per-user write
   *  limit, shared with the steps after the notes. A fresh one by default. */
  writes?: Writes;
}

/**
 * Consume an `ImportProgress` stream (from any file parser or remote
 * importer), encrypt each note under a fresh per-note content key,
 * post it to `/api/v1/items`, and surface state transitions via the
 * `onState` callback.
 *
 * Mirrors the Android app's import repository (`ingestProgress()`) —
 * same batching shape, same encryption choices.
 */
export async function ingestProgress(
  progress: AsyncIterable<ImportProgress>,
  onState: (s: ImportState) => void,
  opts: IngestOptions = {},
): Promise<void> {
  if (!isCryptoReady()) {
    onState({ kind: 'error', message: 'Crypto not ready — please sign in again.' });
    return;
  }

  onState({ kind: 'idle' });

  const writes = opts.writes ?? writesForRun();
  let imported = 0;
  let present = 0;
  let failed = 0;
  const finalIds = new Map<string, string>();
  const createdIds = new Set<string>();
  for await (const ev of progress) {
    switch (ev.kind) {
      case 'parsing':
        onState({ kind: 'importing', current: ev.current, currentTitle: ev.currentTitle });
        break;
      case 'note': {
        const out = await uploadNote(ev.note, opts.reIdKey ?? null, writes);
        // The tab is another account's now: it is wiping and reloading, and no
        // later note of this run may go out on that account's session.
        if (out.kind === 'stopped') return;
        if (out.kind === 'created') imported++;
        else if (out.kind === 'present') present++;
        else failed++;
        if (out.kind !== 'failed' && ev.note.id) finalIds.set(ev.note.id, out.id);
        if (out.kind === 'created' && ev.note.id) createdIds.add(ev.note.id);
        break;
      }
      case 'done':
        break;
      case 'error':
        onState({ kind: 'error', message: ev.message });
        return;
    }
  }

  // Pull in the freshly-imported items locally so the UI doesn't have
  // to wait for the next sync tick to show them.
  await notesStore.sync();
  onState({ kind: 'complete', count: imported, present, failed, finalIds, createdIds });
}

/**
 * Create one note, and say what became of it.
 *
 * A restore reuses the backup's id, which is what makes restoring the same file
 * twice converge: the second pass's 409s change nothing. But ids are global,
 * and counting a 409 as "already here" when the id is ANOTHER account's would
 * let a squatted id silently drop the user's note. So:
 *  - a 409 counts as present only when the server's row for that id is this
 *    account's own, live note (the GET below; the server's word is not enough:
 *    a server may answer every taken id with 409);
 *  - an id another account holds (403 item_not_owned, or a 409 whose row is
 *    another's or not ours to read) is re-filed under the id derived from it
 *    (restoreIds), whose own 409 goes through the same rule;
 *  - anything else, a 403 on the derived id included, is not restored. Each
 *    note is tried once per restore; only the write limit's own 429 is sent
 *    again (rateLimit), since that answer created nothing.
 */
async function uploadNote(note: ImportedNote, reIdKey: CryptoKey | null, writes: Writes): Promise<UploadOutcome> {
  const first = await createItem(note, note.id ?? crypto.randomUUID(), writes);
  if (first.kind !== 'taken') return first;
  const whose = first.notOurs ? 'other' : await ownerOf(first.id);
  if (whose === 'ours') return { kind: 'present', id: first.id };
  if (whose !== 'other' || !reIdKey) return { kind: 'failed' };

  const derived = await derivedRestoreId(reIdKey, 'note', first.id);
  const second = await createItem(note, derived, writes);
  if (second.kind !== 'taken') return second;
  return !second.notOurs && (await ownerOf(derived)) === 'ours' ? { kind: 'present', id: derived } : { kind: 'failed' };
}

/** One create of `note` under `id`. 'taken' only for a note with an id of its
 *  own (a restore): a foreign import's fresh id colliding is just a failure. */
async function createItem(
  note: ImportedNote,
  itemId: string,
  writes: Writes,
): Promise<{ kind: 'created'; id: string } | { kind: 'failed' } | { kind: 'stopped' } | { kind: 'taken'; id: string; notOurs: boolean }> {
  const content: Record<string, unknown> = {
    // A newer client's unknown keys go down FIRST so the fields below always
    // win. Restoring extras over the top would let a stale duplicate key in the
    // bag overwrite the real value.
    ...(note.extras ?? {}),
    title: note.title,
    body: note.body,
    note_type: note.noteType,
    color: note.color,
    is_pinned: note.isPinned,
    is_archived: note.isArchived,
    labels: note.labels,
    checklist_items: note.checklistItems,
  };
  // Restore-only fields. Absent on a foreign import, where the source has no
  // equivalent, and omitted rather than defaulted so the note keeps whatever
  // the app would normally give a new note.
  if (note.sortOrder !== undefined) content.sort_order = note.sortOrder;
  if (note.editMode !== undefined) content.edit_mode = note.editMode;
  if (note.notebookId != null) content.notebook_id = note.notebookId;

  // Client-generate the item id (as createNote and the Android app do) so the
  // content AAD can bind to it; the server accepts a client-supplied id. A
  // restore passes the backup's id, or the one derived from it; the content is
  // sealed to whichever is used.
  const contentKey = generateContentKey();
  const encrypted = encryptWithContentKey(JSON.stringify(content), contentKey, itemId);
  const wrapped = wrapContentKeyWithVault(contentKey);

  // Built once: a resend after the write limit's 429 is this same request.
  const body = {
    id: itemId,
    item_type: 1,
    encrypted_content: encrypted.ciphertext,
    content_nonce: encrypted.nonce,
    wrapped_content_key: wrapped.wrappedKey,
    wrapped_content_key_nonce: wrapped.nonce,
    ...(note.notebookId != null ? { notebook_id: note.notebookId } : {}),
  };
  const resp = await sendWrite(writes, () => apiRequest<{ id: string }>('/api/v1/items', { method: 'POST', body }));
  if (resp.success) return { kind: 'created', id: itemId };
  if (isAccountStop(resp)) return { kind: 'stopped' };
  if (!note.id) return { kind: 'failed' };
  if (resp.status === 403 && resp.error_code === 'item_not_owned') return { kind: 'taken', id: itemId, notOurs: true };
  if (isAlreadyPresent(resp)) return { kind: 'taken', id: itemId, notOurs: false };
  return { kind: 'failed' };
}

/**
 * Whose item `id` is, by the server's own row. The read is owner-or-recipient
 * and returns trashed rows too, so the owner compare is what makes it "ours".
 * A 404 is an id we can't read: someone else's (an old server's 409).
 */
async function ownerOf(id: string): Promise<'ours' | 'trashed' | 'other' | 'unknown'> {
  const me = getTabAccount();
  if (!me) return 'unknown';
  const r = await apiRequest<{ user_id?: string; deleted?: boolean }>(`/api/v1/items/${id}`).catch(() => null);
  if (!r) return 'unknown';
  if (!r.success) return r.status === 404 ? 'other' : 'unknown';
  if (tryCanonicalAccountId(r.data?.user_id) !== me) return 'other';
  return r.data?.deleted ? 'trashed' : 'ours';
}

/** Did the create fail because the id already exists? */
function isAlreadyPresent(resp: { status?: number; error?: string }): boolean {
  if (resp.status === 409) return true;
  // Fall back to the message when the client didn't surface a status: the route
  // returns a plain 409 deliberately (a 500 would confirm the id exists to
  // another tenant), so there is no error code to match on.
  return typeof resp.error === 'string' && /already exists|conflict/i.test(resp.error);
}
