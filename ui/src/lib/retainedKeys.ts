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
 * Per-note store of RETIRED (pre-rotation) per-note content keys — the web
 * owner's counterpart to note-android / note-ios `RetainedContentKeyStore`.
 *
 * WHY: attachments are sealed under the per-note CONTENT key (the same key the
 * note body/collab use) so share recipients — who hold the content key, not the
 * owner's vault key — can decrypt them. When `shareUtils.rotateContentKey` mints
 * a fresh content key (an unshare / notebook-move) it re-encrypts the note BODY
 * under the new key and overwrites the item row's `wrapped_content_key`, but the
 * attachment BLOBS in R2 are NOT re-encrypted server-side. `rekeyNoteAttachments`
 * re-encrypts them to the new key best-effort, but if that pass is interrupted
 * (crash, a bounded/failed blob) the owner would be left unable to decrypt their
 * OWN pre-rotation attachments — the current content key no longer opens them.
 * This store keeps the retired key so the attachment decrypt path can fall back
 * to it. It is the owner's within-session safety net for an interrupted rotation.
 *
 * VIEWING ONLY: someone removed from the note holds these keys too, so a file
 * that opens only under one is shown flagged and never brought forward by a
 * re-key (attachmentTrust.ts); only the person's own "Keep file", after seeing
 * it, re-seals it.
 *
 * AT-REST POSTURE: each retired key is WRAPPED under the owner's vault key
 * (`wrapContentKeyWithVault`, NaCl secretbox) before it is written — the exact
 * same wrapping the item row uses for `wrapped_content_key`. The store therefore
 * NEVER holds a raw content key at rest; a curious localStorage reader (or a
 * different account on a shared browser, whose vault key differs) sees only
 * ciphertext it cannot open. Mirrors mobile, which persists the already-
 * vault-wrapped material. No new class of plaintext secret is introduced.
 *
 * LIFECYCLE: WIPED on logout. Unlike mobile — which deliberately RETAINS its
 * per-account blob across a same-account re-login — the web client wipes this on
 * logout (crypto.ts `clearKeys()` sweeps [STORAGE_KEY] by literal, and
 * `stores/auth.ts` logout also calls [clearAll]), matching how the web editor
 * sweeps every `pingolin_note_*` app-data key on logout. Cross-account
 * isolation is doubly guaranteed: the wipe on logout AND the vault-wrapping (a
 * second account cannot unwrap the first's retired keys even if a stray blob
 * survived), so a per-account namespace is unnecessary here.
 */
import { wrapContentKeyWithVault, unwrapContentKeyWithVault } from './crypto';
import { scopedGetItem, scopedRemoveItem, scopedSetItem } from './account';

/**
 * Single localStorage key holding the whole `{ noteId: WrappedKey[] }` map.
 * Exported so crypto.ts `clearKeys()` can sweep it by literal WITHOUT importing
 * this module (which would create a crypto -> retainedKeys import cycle — the
 * same reason the app-data sweep there uses literal key names).
 */
export const RETAINED_KEYS_STORAGE_KEY = 'pingolin_note_retired_keys';

/**
 * Cap retained keys per note to bound growth under pathological repeated
 * rotation (oldest dropped first). Parity with mobile `MAX_PER_NOTE`.
 */
const MAX_PER_NOTE = 32;

/** One retired content key, vault-wrapped: base64 secretbox ct + base64 nonce. */
interface WrappedKey {
  /** base64 NaCl-secretbox ciphertext of the content key (under the vault key). */
  w: string;
  /** base64 secretbox nonce. */
  n: string;
}

/** noteId -> retired wraps, oldest first. */
type RetiredMap = Record<string, WrappedKey[]>;

function loadMap(): RetiredMap {
  try {
    const raw = scopedGetItem(RETAINED_KEYS_STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? (obj as RetiredMap) : {};
  } catch {
    // Corrupt/absent blob — availability feature, so just start empty.
    return {};
  }
}

function saveMap(map: RetiredMap): void {
  try {
    scopedSetItem(RETAINED_KEYS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage full/unavailable (e.g. incognito quota) — non-fatal; the
    // rotation re-key already handled the common case, this is only a fallback.
  }
}

/** Constant-time-ish equality for two 32-byte content keys. */
function keysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Record a retired (pre-rotation) content key for `noteId`. The key is WRAPPED
 * under the current vault key before it is written (never stored raw). Deduped
 * on the RAW key (the wrapped bytes differ per call because each wrap draws a
 * fresh nonce, so we unwrap existing entries and compare); keeps at most
 * [MAX_PER_NOTE] most-recent entries. No-op when crypto isn't ready (no vault
 * key to wrap under → nothing safe to persist).
 *
 * Call BEFORE committing a content-key rotation so a crash mid-rotate cannot
 * strand the owner's pre-rotation attachments (mirrors the note-ios
 * `ContentKeyRotator` retain-before-commit ordering). retain() is idempotent, so
 * writing it before a rotation that then fails is harmless (the note keeps the
 * same key, and the retained copy simply duplicates the still-current one).
 */
export function retain(noteId: string, contentKey: Uint8Array): void {
  if (contentKey.length !== 32) return;
  let wrapped: { wrappedKey: string; nonce: string };
  try {
    wrapped = wrapContentKeyWithVault(contentKey);
  } catch {
    // Crypto not ready / no vault key — we can't wrap it, so don't persist a
    // raw secret. The current-key decrypt path still works meanwhile.
    return;
  }
  const map = loadMap();
  const list = map[noteId] ?? [];
  // Dedupe on the RAW key: unwrap each existing entry and skip if we already
  // hold this key (a retried rotation retains the same old key twice).
  for (const e of list) {
    const existing = unwrapContentKeyWithVault(e.w, e.n);
    if (existing && keysEqual(existing, contentKey)) return;
  }
  list.push({ w: wrapped.wrappedKey, n: wrapped.nonce });
  while (list.length > MAX_PER_NOTE) list.shift();
  map[noteId] = list;
  saveMap(map);
}

/**
 * Retired content keys for `noteId`, oldest first, each UNWRAPPED with the
 * current vault key. Entries that don't unwrap (a different vault key, or a
 * corrupt blob) are skipped. Empty when crypto isn't ready or none are retained.
 * The caller feeds these as fallback candidates to the attachment decrypt path.
 */
export function getRetained(noteId: string): Uint8Array[] {
  const list = loadMap()[noteId];
  if (!list || list.length === 0) return [];
  const out: Uint8Array[] = [];
  for (const e of list) {
    const key = unwrapContentKeyWithVault(e.w, e.n);
    if (key) out.push(key);
  }
  return out;
}

/** Wipe the entire retired-key store. Called on logout (belt-and-suspenders with
 *  the crypto.ts `clearKeys()` literal sweep). Best-effort. */
export function clearAll(): void {
  try {
    scopedRemoveItem(RETAINED_KEYS_STORAGE_KEY);
  } catch {
    // ignore
  }
}
