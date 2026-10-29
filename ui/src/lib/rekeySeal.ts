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
 * A removal's re-key job, sealed at rest.
 *
 * A job has to outlive a sign-out: it is what finishes a removal that stopped
 * part-way, and what keeps the removed person off the standing list until the
 * server has the list without them. What it holds is ids, progress and
 * addresses, so it is sealed under a key only its account's vault key gives,
 * and a signed-out browser holds nothing it can read.
 *
 *  - The record's KEY is a keyed hash of the notebook id, not the id: the store
 *    names no notebook. The id rides inside the seal.
 *  - The seal is AES-GCM with the format, the account and the record key as
 *    additional data, so a record moved to another account's store, or to
 *    another record key, does not open.
 *  - Both keys come from the vault key by HKDF-SHA256, each under its own
 *    versioned label (distinct from every other label in this app).
 */

import type { RekeyJob } from './rekeyQueue';

export const REKEY_SEAL_FORMAT = 1;
const RECORD_KEY_LABEL = 'pingolin-note-rekey-record-key-v1';
const SEAL_LABEL = 'pingolin-note-rekey-seal-v1';

/** One stored record: `k` its key in the store, `n` and `c` the nonce and ciphertext. */
export interface SealedRekeyRecord {
  k: string;
  v: number;
  n: string;
  c: string;
}

/** The two keys a vault key gives. */
export interface RekeyKeys {
  recordKey: CryptoKey;
  seal: CryptoKey;
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** The record-key and sealing keys for one vault key. */
export async function rekeyKeysFrom(vaultKey: Uint8Array): Promise<RekeyKeys> {
  // A copy: WebCrypto takes an ArrayBuffer-backed view, and the caller's key stays the caller's.
  const base = await crypto.subtle.importKey('raw', new Uint8Array(vaultKey), 'HKDF', false, ['deriveKey']);
  const params = (label: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(label) });
  const [recordKey, seal] = await Promise.all([
    crypto.subtle.deriveKey(params(RECORD_KEY_LABEL), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
    crypto.subtle.deriveKey(params(SEAL_LABEL), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  ]);
  return { recordKey, seal };
}

/** The store key for a notebook's job: a keyed hash, so the store names no notebook. */
export async function recordKeyFor(keys: RekeyKeys, notebookId: string): Promise<string> {
  return toHex(await crypto.subtle.sign('HMAC', keys.recordKey, utf8(`notebook:${notebookId}`)));
}

function additionalData(accountId: string, recordKey: string): Uint8Array<ArrayBuffer> {
  return utf8(`pingolin-note-rekey|v${REKEY_SEAL_FORMAT}|${accountId}|${recordKey}`);
}

/** Seal `job` for `accountId`. */
export async function sealRekeyJob(keys: RekeyKeys, accountId: string, job: RekeyJob): Promise<SealedRekeyRecord> {
  const k = await recordKeyFor(keys, job.notebookId);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const c = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: additionalData(accountId, k) },
    keys.seal,
    utf8(JSON.stringify(job)),
  );
  return { k, v: REKEY_SEAL_FORMAT, n: toB64(nonce), c: toB64(c) };
}

function looksLikeJob(j: unknown): j is RekeyJob {
  const o = j as RekeyJob;
  return !!o && typeof o.id === 'string' && typeof o.notebookId === 'string'
    && Array.isArray(o.removedRecipients) && o.removedRecipients.every(r => typeof r === 'string')
    && Array.isArray(o.pendingNoteIds) && o.pendingNoteIds.every(n => typeof n === 'string')
    && typeof o.startedAt === 'number';
}

/** Open a record for `accountId`, or null when these keys don't open it (another account's, moved, or damaged). */
export async function openRekeyRecord(keys: RekeyKeys, accountId: string, record: SealedRekeyRecord): Promise<RekeyJob | null> {
  if (!record || record.v !== REKEY_SEAL_FORMAT || typeof record.k !== 'string'
      || typeof record.n !== 'string' || typeof record.c !== 'string') return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(record.n), additionalData: additionalData(accountId, record.k) },
      keys.seal,
      fromB64(record.c),
    );
    const job: unknown = JSON.parse(new TextDecoder().decode(plain));
    return looksLikeJob(job) ? job : null;
  } catch {
    return null;
  }
}
