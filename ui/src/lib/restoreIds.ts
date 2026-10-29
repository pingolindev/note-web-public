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
 * The id a restore gives a note or a notebook whose own id another account
 * holds.
 *
 * Ids are global, so while the account a backup came from exists, or while
 * someone has squatted an id, the backup's own id can't be used: the server
 * answers 403 item_not_owned. The restore then files the item under an id
 * DERIVED from this account's vault key and the original id:
 *
 *  - keyed, so nobody who merely knows the original id (a past recipient of the
 *    note, a squatter) can compute it in advance and squat it too;
 *  - deterministic, so restoring the same file again finds it (its 409 is ours)
 *    instead of making a copy;
 *  - separate for notes and notebooks (a domain label each), and shaped as a v4
 *    UUID, which is what every client and the server expect of an id.
 *
 * The key comes from the vault key by HKDF-SHA256 under this module's own
 * versioned label. A password reset changes the vault key, so after one, a
 * later restore derives other ids and may duplicate what an earlier one
 * re-filed.
 */

import { tryCanonicalAccountId } from './account';

const RESTORE_ID_LABEL = 'pingolin-note-restore-id-v1';

export type RestoreIdKind = 'note' | 'notebook';

/** The keyed-hash key for one vault key. */
export async function restoreIdKeyFrom(vaultKey: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new Uint8Array(vaultKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(RESTORE_ID_LABEL) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
}

/** The derived id for `originalId`, a canonical v4-shaped UUID. */
export async function derivedRestoreId(key: CryptoKey, kind: RestoreIdKind, originalId: string): Promise<string> {
  const original = tryCanonicalAccountId(originalId) ?? originalId.toLowerCase();
  const mac = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`pingolin-note-restore-id|${kind}|${original}`)));
  const b = mac.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
