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
 * A notebook as a real server item (`item_type = 2`).
 *
 * ## Why this exists
 *
 * Notebooks can be stored two different ways depending on which client made
 * them. Android writes `item_type = 2` rows and mirrors them into the
 * metadata blob (the Note Android app's `NotebookRepository` carries the other
 * half of this bridge). A notebook kept ONLY inside the `item_type = 10`
 * metadata blob, with no type-2 row, is an entry in a JSON document rather
 * than an object with an identity.
 *
 * Such a notebook is invisible to a plain `observeNotebooks()` query on
 * Android, which is why that repository unions two lists. It also cannot be
 * shared: there is no id for a share row to reference, and the server
 * requires a note's `notebook_id` to name an existing item, which a
 * metadata-only notebook can never satisfy.
 *
 * ## Two rules that keep this migration safe
 *
 * 1. **The id is preserved, never regenerated.** Notes carry their notebook's
 *    id inside their own encrypted content. Minting a fresh id when promoting a
 *    notebook to an item would orphan every note in it. The create endpoint
 *    takes an optional client-supplied id precisely so a client can supply
 *    its own.
 * 2. **The metadata blob keeps being written.** It stays the record every
 *    client reads while both formats are live; the item is written alongside
 *    it, so a client that reads only the blob still sees every notebook.
 */

/**
 * What a member may do in a shared notebook.
 *
 * `view` and `edit` map onto the share's `permission` and are enforced by the
 * server for each NOTE. `contribute` additionally means "may add and remove
 * notes", which is a collection-level right, and is why a note's `notebook_id`
 * has to be visible to the server.
 */
export type NotebookPermission = 'view' | 'edit' | 'contribute';

/**
 * A member of a shared notebook, as recorded in the OWNER's roster.
 *
 * The public keys are cached here so a member can seal a new note's content key
 * to everyone else without a lookup per recipient. That is the entire reason
 * the roster is shared rather than kept in the owner's metadata: a recipient
 * who cannot read the member list cannot wrap a note for the others.
 */
export interface NotebookMember {
  userId: string;
  email: string;
  /** X25519, for sealing content keys to them. */
  sharingPublicKey: string;
  /** Ed25519, for verifying wraps they send. */
  signingPublicKey: string | null;
  permission: NotebookPermission;
}

/** The decrypted content of a notebook item, matching what android writes. */
export interface NotebookItemContent {
  title: string;
  body: string;
  note_type: string;
  color: string | null;
  is_pinned: boolean;
  is_archived: boolean;
  labels: string[];
  sort_order: number;
  /**
   * The roster. Written ONLY by the owner — invites are owner-only, and that
   * is enforced by HOW the notebook is shared, not by trust: the notebook item
   * goes out with `view` permission whatever a member's note permission is,
   * because the server grants writes to any `edit` recipient, and an
   * edit-shared notebook item would let a member rewrite this list and invite
   * whoever they liked.
   */
  members: NotebookMember[];
}

/** Server item_type for a notebook. Notes are 1, user metadata is 10. */
export const ITEM_TYPE_NOTEBOOK = 2;

/**
 * Build the content a notebook item carries.
 *
 * Deliberately the same shape a note uses, with the notebook's name in
 * `title` — that is what android already writes, and a divergence here would
 * hand the other client an item it cannot render.
 */
export function notebookItemContent(
  name: string,
  members: NotebookMember[] = [],
): NotebookItemContent {
  return {
    title: name,
    body: '',
    note_type: 'text',
    color: null,
    is_pinned: false,
    is_archived: false,
    labels: [],
    sort_order: 0,
    members,
  };
}

/**
 * Rewrite a notebook's content, keeping everything this client did not set out
 * to change.
 *
 * Rebuilding from [notebookItemContent] instead would silently drop every field
 * this version does not know about. A notebook created on android carries
 * `edit_mode`, which web has no notion of; one created anywhere carries
 * `color`, which [notebookItemContent] hard-codes to null. Sharing or renaming
 * such a notebook on web would quietly reset its colour and strip its edit
 * mode — a cross-client data loss with no error and no way to notice, since the
 * fields simply stop being there.
 *
 * `base` is the notebook's last-known decrypted content. When there is none —
 * this client has never opened it — the caller falls back to a fresh document,
 * which is the only honest option: writing a merge over a base we never read
 * would be inventing one.
 */
export function mergeNotebookContent(
  base: Record<string, unknown>,
  changes: { title?: string; members?: NotebookMember[] },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  if (changes.title !== undefined) next.title = changes.title;
  if (changes.members !== undefined) next.members = changes.members;
  return next;
}

/**
 * A notebook item's decrypted content as a plain object, or null if it is not
 * one. Tolerant for the same reason [membersFrom] is: this parses a document
 * written by another client, possibly a newer one.
 */
export function notebookContentFrom(decrypted: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(decrypted) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * What the NOTEBOOK ITEM itself is shared with — `view`, or `contribute` for a
 * member who may add and remove notes.
 *
 * **Never `edit`.** The server's write check matches `permission = 'edit'`
 * exactly, so an edit-share on the notebook item would let the recipient
 * rewrite the ROSTER and invite whoever they liked — which is the whole invite
 * mechanism. `contribute` is a separate value precisely so the server can grant
 * the collection right (add/remove notes) without granting write on the object
 * that carries the member list.
 *
 * A member's ability to edit note CONTENT rides on the note shares instead.
 */
export function notebookItemSharePermission(
  permission: NotebookPermission,
): 'view' | 'contribute' {
  return permission === 'contribute' ? 'contribute' : 'view';
}

/** @deprecated use [notebookItemSharePermission]; kept for callers that always
 *  meant read-only. */
export const NOTEBOOK_ITEM_SHARE_PERMISSION = 'view' as const;

/**
 * Recover the grant the owner chose, from the two rows it was written across.
 *
 * A notebook share is stored in two places with two different vocabularies: the
 * collection right on the NOTEBOOK item (`view` | `contribute`, never `edit` —
 * see [notebookItemSharePermission]) and the item right on each CHILD note
 * (`edit` | `view`). Neither alone says what was granted: `contribute` and
 * `edit` both leave the notes on `edit`, and both leave the notebook on
 * something that is not `edit`.
 *
 * Reading only the children would make a `contribute` grant display as "Can
 * edit" — and, because the permission control skips a no-op change, would
 * make a contributor impossible to demote to a plain editor.
 */
export function notebookGrantFrom(
  objectPermission: string | null | undefined,
  childPermission: string | null | undefined,
): NotebookPermission {
  if (objectPermission === 'contribute') return 'contribute';
  return childPermission === 'edit' ? 'edit' : 'view';
}

/**
 * The members of a notebook item, from its decrypted content.
 *
 * Tolerant on purpose: this parses a document written by another client, on a
 * device we do not control, possibly by a version newer than this one. A
 * malformed one should cost its own member list, not the whole notebook list.
 */
export function membersFrom(decrypted: string): NotebookMember[] {
  try {
    const parsed = JSON.parse(decrypted) as { members?: unknown };
    if (!Array.isArray(parsed.members)) return [];
    // Filter rather than trust: a member with no id or no sharing key cannot be
    // sealed to, and keeping them would make "shared with N people" a lie the
    // crypto cannot honour.
    return parsed.members.filter((m): m is NotebookMember =>
      !!m && typeof m === 'object'
      && typeof (m as NotebookMember).userId === 'string' && !!(m as NotebookMember).userId
      && typeof (m as NotebookMember).sharingPublicKey === 'string'
      && !!(m as NotebookMember).sharingPublicKey);
  } catch {
    return [];
  }
}

export function notebookNameFrom(decrypted: string): string | null {
  try {
    const parsed = JSON.parse(decrypted) as { title?: unknown };
    return typeof parsed.title === 'string' && parsed.title ? parsed.title : null;
  } catch {
    return null;
  }
}

/**
 * Which notebooks still need an item minting for them.
 *
 * Pure so the backfill's decision is testable without a network: given what is
 * in the metadata blob and which item ids the server already returned, this is
 * the set to create. Idempotent — running it twice creates nothing the second
 * time, which matters because it runs on every load.
 */
export function notebooksMissingItems(
  metadataNotebooks: readonly { id: string; name: string }[],
  existingItemIds: ReadonlySet<string>,
): { id: string; name: string }[] {
  return metadataNotebooks.filter(nb => nb.id && !existingItemIds.has(nb.id));
}
