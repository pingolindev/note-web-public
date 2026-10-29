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
 * Taking someone out of a shared notebook.
 *
 * Removal is three separate things, and only doing all three actually removes
 * anyone:
 *
 *  1. **Drop them from the roster.** The roster is what every member reads to
 *     seal a NEW note to everyone in the notebook. Leave them in it and the
 *     other members' clients keep sealing future notes to the person who was
 *     just removed — the removal undone by the next note anyone writes.
 *  2. **Revoke their share on the notebook OBJECT, and re-key it.** Without the
 *     revoke they keep their inbox entry for the notebook itself, which means
 *     they go on receiving its name and its member list. Without the re-key
 *     they still hold the key that opens all of it, so every later roster
 *     update is written under a key they have — they cannot fetch it any more,
 *     which is what actually stops them, but the rotation is the
 *     defence-in-depth behind that.
 *  3. **Re-key every note in it.** Handled by the resumable job in
 *     [rekeyDrain] — the slow part, and the part that has to survive a closed
 *     tab.
 *
 * The owner's own STANDING LIST, which seals the owner's new notes, is a
 * fourth; [removeNotebookMember] takes them off it before any of these.
 */

import { apiRequest } from './apiClient';
import { notebooksStore } from '../stores/notebooks';
import { rotateNotebookContentKey } from './shareUtils';
import type { NotebookMember } from './notebookItem';

interface ShareRow { id: string; recipient_email: string; permission: string }

/**
 * The roster with `email` taken out, or null if there is nothing to change.
 *
 * Matching is on email because that is what the share rows carry; the roster's
 * own `userId` is what the re-key job needs afterwards.
 */
export function rosterWithout(
  members: readonly NotebookMember[],
  email: string,
): NotebookMember[] | null {
  const target = email.toLowerCase();
  const next = members.filter(m => m.email.toLowerCase() !== target);
  return next.length === members.length ? null : next;
}

/** The removed member's user id, from the roster, for the re-key job. */
export function userIdFor(members: readonly NotebookMember[], email: string): string | null {
  const target = email.toLowerCase();
  return members.find(m => m.email.toLowerCase() === target)?.userId ?? null;
}

/** The share rows this recipient holds on the notebook object. */
async function theirSharesOn(notebookId: string, email: string): Promise<ShareRow[] | null> {
  const list = await apiRequest<ShareRow[]>(`/api/v1/items/${notebookId}/shares`);
  if (!list.success || !Array.isArray(list.data)) return null;
  const target = email.toLowerCase();
  return list.data.filter(s => s.recipient_email.toLowerCase() === target);
}

/**
 * Revoke a recipient's share on the notebook item itself, and rotate its
 * content key so what remains is not readable with the key they hold.
 *
 * Both in one rotate-shares transaction — the same atomic endpoint the notes
 * use — so there is no window where the revoke has landed and the re-key has
 * not, or vice versa.
 *
 * Falls back to a plain DELETE if the rotation cannot run or does not land.
 * Revocation is the part that stops access: it is one server call, atomic and
 * instant, and it must not become conditional on the slower, more fragile
 * re-keying succeeding. A notebook that is revoked but not re-keyed is a much
 * better outcome than one that is neither.
 *
 * Returns true when there was nothing to revoke as well as when the revoke
 * landed: both mean "they no longer hold a share on this notebook".
 */
export async function revokeNotebookObjectShare(
  notebookId: string,
  email: string,
): Promise<{ revoked: boolean; rotated: boolean }> {
  const theirs = await theirSharesOn(notebookId, email);
  if (theirs === null) return { revoked: false, rotated: false };
  if (theirs.length === 0) return { revoked: true, rotated: false };

  const shareIds = theirs.map(s => s.id);
  const rotation = await rotateNotebookContentKey(notebookId, shareIds, 'notebook_removal').catch(() => null);
  if (rotation?.rotated) return { revoked: true, rotated: true };

  console.warn(
    `[note] notebook ${notebookId} could not be re-keyed; revoking without rotation`,
  );
  let allGone = true;
  for (const id of shareIds) {
    const r = await apiRequest(`/api/v1/shares/${id}?reason=notebook_removal`, { method: 'DELETE' });
    if (!r.success) allGone = false;
  }
  return { revoked: allGone, rotated: false };
}

/**
 * Do the two instant parts of a removal: the roster and the notebook object.
 *
 * Deliberately ordered roster-first. It is the one that stops OTHER members
 * sealing new notes to the removed person, and it needs the notebook's content
 * key — which is still the key they hold, so doing it before anything else
 * keeps it a single straightforward write.
 *
 * Both parts are reported rather than thrown so the caller can start the
 * re-keying regardless: a failure here must not leave the slow part undone too.
 */
export async function revokeNotebookAccess(
  notebookId: string,
  email: string,
): Promise<{
  rosterUpdated: boolean;
  objectRevoked: boolean;
  objectRotated: boolean;
  removedUserId: string | null;
}> {
  const members = notebooksStore.membersOf(notebookId);
  const removedUserId = userIdFor(members, email);

  let rosterUpdated = true;
  const next = rosterWithout(members, email);
  if (next !== null) {
    rosterUpdated = await notebooksStore.setNotebookMembers(notebookId, next);
    if (!rosterUpdated) {
      console.warn(`[note] roster for ${notebookId} still lists ${email}; other members may re-share to them`);
    }
  }

  let objectRevoked = false;
  let objectRotated = false;
  try {
    const r = await revokeNotebookObjectShare(notebookId, email);
    objectRevoked = r.revoked;
    objectRotated = r.rotated;
  } catch {
    objectRevoked = false;
  }
  if (!objectRevoked) {
    console.warn(`[note] notebook ${notebookId} is still shared with ${email}`);
  }

  return { rosterUpdated, objectRevoked, objectRotated, removedUserId };
}
