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
 * Pins kept under different spellings of the same ids, folded into one.
 *
 * A pin blob named by the account id exactly as the server spelled it, with
 * its contacts keyed by their ids lower-cased only, would let a server that
 * changed an id's spelling (case, hyphens) start this browser's trust from
 * empty: a first contact for everyone. Blob names and contact keys are the
 * canonical id; this folds what other spellings kept into it:
 *
 *  - records for one contact with the SAME keys merge: the earliest first pin,
 *    the latest verification and the latest approval;
 *  - records with DIFFERENT keys become a `conflict`: it reads as changed for
 *    any keys, never matched and never a first contact, until the person
 *    approves one (approveUserKeyChange), which clears it. That is the rule the
 *    mobile SDK and the other clients use, with the same all-zero sentinel
 *    keys;
 *  - a record whose contact id is not an account id, or that is not a pin, is
 *    dropped (migratePinnedKeys saves every source verbatim before that).
 */
import { tryCanonicalAccountId } from './account';

export interface StoredPin {
  sharingPubkeyHex: string;
  signingPubkeyHex: string;
  firstPinnedAt: number;
  lastVerifiedAt: number;
  userApprovedChangeAt?: number;
  /** Two records with different keys were found for this contact. */
  conflict?: true;
}

/** The keys a conflict holds. No real key is all zero, so an older build
 *  reading this store sees a changed key too. */
export const CONFLICT_KEY_HEX = '0'.repeat(64);

export function conflictPin(firstPinnedAt: number, lastVerifiedAt: number): StoredPin {
  return {
    sharingPubkeyHex: CONFLICT_KEY_HEX,
    signingPubkeyHex: CONFLICT_KEY_HEX,
    firstPinnedAt,
    lastVerifiedAt,
    conflict: true,
  };
}

export function isStoredPin(r: unknown): r is StoredPin {
  const p = r as StoredPin | null;
  return !!p && typeof p === 'object'
    && typeof p.sharingPubkeyHex === 'string' && typeof p.signingPubkeyHex === 'string';
}

const time = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
/** The earlier of two times, a missing one (0) aside. */
const earliest = (a: number, b: number): number => (a && b ? Math.min(a, b) : a || b);

function normalized(r: StoredPin): StoredPin {
  if (r.conflict === true) return conflictPin(time(r.firstPinnedAt), time(r.lastVerifiedAt));
  const approved = time(r.userApprovedChangeAt);
  return {
    sharingPubkeyHex: r.sharingPubkeyHex.toLowerCase(),
    signingPubkeyHex: r.signingPubkeyHex.toLowerCase(),
    firstPinnedAt: time(r.firstPinnedAt),
    lastVerifiedAt: time(r.lastVerifiedAt),
    ...(approved ? { userApprovedChangeAt: approved } : {}),
  };
}

function combined(a: StoredPin, b: StoredPin): StoredPin {
  const first = earliest(a.firstPinnedAt, b.firstPinnedAt);
  const last = Math.max(a.lastVerifiedAt, b.lastVerifiedAt);
  if (a.conflict || b.conflict
    || a.sharingPubkeyHex !== b.sharingPubkeyHex || a.signingPubkeyHex !== b.signingPubkeyHex) {
    return conflictPin(first, last);
  }
  const approved = Math.max(a.userApprovedChangeAt ?? 0, b.userApprovedChangeAt ?? 0);
  return {
    sharingPubkeyHex: a.sharingPubkeyHex,
    signingPubkeyHex: a.signingPubkeyHex,
    firstPinnedAt: first,
    lastVerifiedAt: last,
    ...(approved ? { userApprovedChangeAt: approved } : {}),
  };
}

export interface PinFold {
  /** Canonical contact id → its one record. */
  pins: Record<string, StoredPin>;
  /** Contacts that became conflicts here (their records disagreed). */
  conflicts: number;
  /** Records dropped: not a pin, or not keyed by an account id. */
  dropped: number;
}

/** Fold parsed pin blobs (any value; a non-object contributes nothing). */
export function foldPins(sources: unknown[]): PinFold {
  const pins: Record<string, StoredPin> = {};
  let conflicts = 0;
  let dropped = 0;
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [rawId, record] of Object.entries(source as Record<string, unknown>)) {
      const id = tryCanonicalAccountId(rawId);
      if (!id || !isStoredPin(record)) {
        dropped++;
        continue;
      }
      const incoming = normalized(record);
      const held = pins[id];
      if (!held) {
        pins[id] = incoming;
        continue;
      }
      const next = combined(held, incoming);
      if (next.conflict && !held.conflict && !incoming.conflict) conflicts++;
      pins[id] = next;
    }
  }
  return { pins, conflicts, dropped };
}

/** Is this parsed blob already keyed by canonical ids, every entry a pin? */
export function isCanonicalPinBlob(blob: unknown): boolean {
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return false;
  return Object.entries(blob as Record<string, unknown>)
    .every(([k, r]) => tryCanonicalAccountId(k) === k && isStoredPin(r));
}
