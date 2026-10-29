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
 * Shared attachment upload — handles presign, encrypt, PUT to R2, register.
 * Used by AttachmentButton, paste handlers, and the composer.
 */
import { createSignal } from 'solid-js';
import { apiRequest, type QuotaError } from './apiClient';
import {
  encryptWithContentKey,
  decryptWithContentKey,
} from './crypto';
// Attachment BLOBS are encrypted/decrypted in the worker as a chunked stream
// (attachmentFormat.ts v2; v1 blobs still open), so neither an upload nor a
// download ever holds the whole file in memory. Metadata (tiny) stays on the
// sync `encryptWithContentKey` / `decryptWithContentKey`.
import { encryptFile, decryptResponse } from './attachmentCrypto';
import { v2EncryptedSize } from './attachmentFormat';
import { keepOffered, type OpenedMeta } from './attachmentTrust';
import { accountFetch } from './account';

export const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/webm',
  'application/pdf',
  'text/plain', 'text/markdown',
];

export const MAX_FILE_SIZE = 100 * 1024 * 1024;

/** The server's per-object ceiling, which it applies to the
 *  ENCRYPTED size. */
export const MAX_ENCRYPTED_SIZE = 100 * 1024 * 1024;

/** Whether a file of `size` plaintext bytes can be uploaded: under the
 *  user-facing 100 MB, and small enough that its ciphertext (format overhead
 *  included) still fits the server's per-object cap — otherwise the register
 *  call would refuse it after the whole upload had been paid for. */
export function fitsUploadLimit(size: number): boolean {
  return size <= MAX_FILE_SIZE && v2EncryptedSize(size) <= MAX_ENCRYPTED_SIZE;
}

export interface UploadResult {
  success: boolean;
  error?: string;
  /** HTTP status of the failing call — 402 for a storage-quota denial. */
  status?: number;
  /** Machine-readable error code preserved from the register response
   *  (e.g. `quota_storage_exceeded`). */
  errorCode?: string;
  /** Structured quota detail when the register call is quota-denied. */
  quota?: QuotaError;
}

export async function uploadFile(noteId: string, file: File, contentKey: Uint8Array): Promise<UploadResult> {
  if (!fitsUploadLimit(file.size)) {
    return { success: false, error: `File too large (max 100 MB): ${file.name}` };
  }

  // Encrypt the file with the per-note content key (shareable) so that share
  // recipients — who hold the content key, not the owner's vault key — can
  // decrypt it. The v2 stream carries its own header, so there is no separate
  // content nonce to store. Streamed from the File one chunk at a time: the
  // file is never read into memory whole (whole, a 100 MB attachment would
  // need ~0.5-0.6 GB of renderer memory for the crypto alone).
  const encryptedBlob = await encryptFile(contentKey, file);

  // The encrypted length is signed into the PUT URL's Content-Length header.
  // R2 therefore cannot accept an object larger than the size this request
  // declares and the quota ultimately accounts for.
  const presignResult = await apiRequest<{ url: string; object_key: string }>(
    '/api/v1/attachments/presign-upload',
    { method: 'POST', body: { size_bytes: encryptedBlob.size } },
  );
  if (!presignResult.success) return { success: false, error: 'Failed to get upload URL' };
  const { url: uploadUrl, object_key } = presignResult.data;

  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    body: encryptedBlob,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!uploadResp.ok) return { success: false, error: 'Upload failed' };

  // Metadata is likewise sealed with the content key and AAD-bound to the note.
  const encMeta = encryptWithContentKey(
    JSON.stringify({ filename: file.name, content_type: file.type }),
    contentKey,
    noteId,
  );
  const registerResult = await apiRequest('/api/v1/attachments', {
    method: 'POST',
    body: {
      r2_key: object_key,
      item_id: noteId,
      // The ENCRYPTED size — that is what the R2 object actually occupies and
      // what the server's storage quota counts. Android registers the
      // ciphertext size too, so both platforms account the same blob alike.
      size_bytes: encryptedBlob.size,
      encrypted_meta: encMeta.ciphertext,
      meta_nonce: encMeta.nonce,
    },
  });
  if (!registerResult.success) {
    // Preserve status/error_code/quota so the caller can distinguish a
    // storage-quota 402 (→ upgrade prompt) from a generic failure instead of
    // collapsing everything to "Failed to register attachment".
    return {
      success: false,
      error: registerResult.error || 'Failed to register attachment',
      status: registerResult.status,
      errorCode: registerResult.error_code,
      quota: registerResult.quota,
    };
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Attachment re-keying (content-key rotation)
// ---------------------------------------------------------------------------
//
// Attachments are sealed under the per-note CONTENT key (see uploadFile) so
// share recipients — who hold the content key, not the owner's vault key — can
// decrypt them. When `shareUtils.rotateContentKey` mints a fresh content key
// (an unshare / notebook-move), it re-encrypts the note BODY under the new key
// but the attachment BLOBS in R2 stay sealed under the previous key, which a
// survivor who re-fetches after rotation cannot open. This module re-encrypts
// each blob (+ its sealed metadata) under the new content key on a FRESH R2
// object and repoints the row via PUT /attachments/{id}. The server retires
// the replaced object after a 48h grace period. Mirrors the mobile apps'
// staged "new object + swap" design.
//
// WHAT it may bring forward: only the files that were there BEFORE the
// removal, and only from the IMMEDIATELY previous key. A removed member keeps
// every key the note had while they were in it, and with the server's help
// can put a file under one of them into the note; re-sealing that under the
// new key would present it to everyone as the owner's. So the rows are
// captured before the removal (listAttachmentsForRekey, called by
// rotateContentKey or by a caller that removes first) and the pass never lists
// again, and a file that doesn't open under the previous key is left alone —
// the owner's page shows it flagged (attachmentTrust.ts).

export interface AttachmentRow {
  id: string;
  encrypted_meta: string;
  meta_nonce: string;
  size_bytes: number;
}

export interface RekeyAttachmentsResult {
  /** Attachments we tried to move (within the bounds below). */
  attempted: number;
  /** Blobs re-encrypted under the new key + swapped. */
  rekeyed: number;
  /** Not under the previous key (its metadata or its blob): left alone, never re-sealed. */
  skipped: number;
  /** Blobs we could not re-key (download/upload/swap failed). */
  failed: number;
}

/**
 * The note's attachment rows, for the re-key after a removal. Call it BEFORE the
 * removal: whatever it returns is all the re-key will ever bring forward. Null
 * when the list can't be read — the re-key then brings nothing forward.
 */
export async function listAttachmentsForRekey(noteId: string): Promise<AttachmentRow[] | null> {
  const r = await apiRequest<AttachmentRow[]>(`/api/v1/items/${noteId}/attachments`);
  return r.success && Array.isArray(r.data) ? r.data : null;
}

/** The last note whose files this page re-sealed on the server — a fresh
 *  object per change, so the same note twice still notifies. The open note
 *  re-reads its list on it: the rows it holds are from before the re-seal. */
const [resealed, setResealed] = createSignal<{ noteId: string } | null>(null);
export const attachmentsResealed = resealed;

/**
 * Seal `plain` and its metadata JSON under `key` on a FRESH object and repoint
 * the row to it (PUT /attachments/{id}; owner-only on the server). The one
 * re-seal path: the re-key pass and Keep both come through here.
 */
async function sealAndSwap(
  noteId: string,
  attachmentId: string,
  plain: Blob,
  metaJson: string,
  key: Uint8Array,
): Promise<boolean> {
  // Re-sealed as v2 whatever the source format was, streamed from the
  // decrypted Blob — so a re-key never holds a whole file in memory either.
  const newBlob = await encryptFile(key, plain);
  const encMeta = encryptWithContentKey(metaJson, key, noteId);

  // Fresh object (no in-place R2 overwrite) — matches the mobile design;
  // the backend retires the OLD object after the swap.
  const presign = await apiRequest<{ url: string; object_key: string }>(
    '/api/v1/attachments/presign-upload',
    { method: 'POST', body: { size_bytes: newBlob.size } },
  );
  if (!presign.success) return false;
  const putResp = await fetch(presign.data.url, {
    method: 'PUT', body: newBlob, headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!putResp.ok) return false;

  return rekeyAttachment(attachmentId, {
    r2_key: presign.data.object_key,
    encrypted_meta: encMeta.ciphertext,
    meta_nonce: encMeta.nonce,
    // The new object's real size: same plaintext, but a v1 source re-sealed
    // as v2 differs by the format overhead, and the quota counts objects.
    size_bytes: newBlob.size,
  });
}

// Bound the work a single rotation performs so a pathological note (many/huge
// attachments) can't stall the unshare. Beyond these, blobs are left under the
// old key, and the owner's page shows them flagged.
const MAX_REKEY_ATTACHMENTS = 50;
const MAX_REKEY_TOTAL_BYTES = 200 * 1024 * 1024;

/** Open the download of an attachment's ciphertext: presigned R2 URL first
 *  (direct, fast), falling back to the authenticated proxy on CORS/network
 *  failure. The body is left unread so the caller can stream-decrypt it.
 *  Shared with AttachmentButton.loadAttachment. */
export async function fetchAttachmentCiphertext(attId: string): Promise<Response | null> {
  let resp: Response | null = null;
  const presign = await apiRequest<{ url: string }>(`/api/v1/attachments/${attId}/presign-download`);
  if (presign.success) {
    try {
      resp = await fetch(presign.data.url);
    } catch {
      // CORS or network error — fall back to the proxy below.
    }
  }
  if (!resp || !resp.ok) {
    resp = await accountFetch(`/api/v1/attachments/${attId}/download`, { credentials: 'include' });
  }
  return resp.ok ? resp : null;
}

/**
 * Low-level re-key swap. PUT /api/v1/attachments/{id} atomically repoints the
 * attachment row to `r2_key` (a fresh object from presign-upload holding
 * ciphertext re-encrypted under the note's NEW content key) and swaps its
 * sealed metadata. Owner-only (enforced by the server).
 * Returns whether the swap landed.
 */
export async function rekeyAttachment(
  attachmentId: string,
  body: { r2_key: string; encrypted_meta: string; meta_nonce: string; size_bytes: number },
): Promise<boolean> {
  const r = await apiRequest(`/api/v1/attachments/${attachmentId}`, { method: 'PUT', body });
  return r.success;
}

/**
 * Re-encrypt the attachments of `noteId` captured BEFORE the removal
 * (`listedBefore`, from listAttachmentsForRekey) from `oldKey` — the note's key
 * immediately before this rotation — to `newKey`, swapping each via
 * PUT /attachments/{id}.
 *
 * Never lists: a row the server adds after the removal is not in
 * `listedBefore`, so it is never brought forward. Each row's metadata is the
 * CAPTURED one, and both it and the blob must open under `oldKey` alone; a row
 * under any other key is left untouched (a retired key opens it for the
 * owner's viewing only, flagged). Best-effort and bounded by count + total
 * bytes so a rotation never stalls on a huge note.
 */
export async function rekeyNoteAttachments(
  noteId: string,
  listedBefore: readonly AttachmentRow[],
  oldKey: Uint8Array,
  newKey: Uint8Array,
): Promise<RekeyAttachmentsResult> {
  const res: RekeyAttachmentsResult = { attempted: 0, rekeyed: 0, skipped: 0, failed: 0 };

  let budgetBytes = MAX_REKEY_TOTAL_BYTES;
  for (const att of listedBefore.slice(0, MAX_REKEY_ATTACHMENTS)) {
    // Stay within the byte budget — an over-budget blob stays under the old
    // key (the owner's page shows it flagged).
    if (att.size_bytes > budgetBytes) continue;

    res.attempted++;
    try {
      // The captured metadata, under the previous key alone — tiny, so first:
      // a row that isn't under it is never downloaded. AAD-bound to noteId
      // (unchanged by rotation).
      const metaJson = decryptWithContentKey(
        { ciphertext: att.encrypted_meta, nonce: att.meta_nonce }, oldKey, noteId,
      );
      if (!metaJson) { res.skipped++; continue; }

      const resp = await fetchAttachmentCiphertext(att.id);
      if (!resp) { res.failed++; continue; }
      // The blob under the same key as its metadata: the previous key, alone.
      const dec = await decryptResponse([oldKey], resp);
      if (!dec) { res.skipped++; continue; }

      if (await sealAndSwap(noteId, att.id, dec.blob, metaJson, newKey)) {
        res.rekeyed++;
        budgetBytes -= att.size_bytes;
      } else {
        res.failed++;
      }
    } catch (e) {
      console.warn('[note] attachment re-key failed', att.id, e);
      res.failed++;
    }
  }
  if (res.rekeyed > 0) setResealed({ noteId });
  return res;
}

/**
 * "Keep file" on a flagged attachment: the ONE re-seal of a file that opened
 * only under a retired key. Seals exactly the bytes and the metadata this
 * page opened and the person saw, under the note's CURRENT key, through the
 * same seal-and-swap as the re-key.
 *
 * Never downloads and never re-lists: the bytes are the ones already held, so
 * the server cannot swap them after the person looked. Refused, with nothing
 * sent, unless the page holds the bytes with the metadata they opened with,
 * that metadata opened only under a retired key (a flagged file), and the
 * person saw them (attachmentTrust.keepOffered).
 */
export async function keepAttachment(k: {
  noteId: string;
  attachmentId: string;
  seen: boolean;
  /** The Blob this page opened for this card, and how its metadata opened with it. */
  held: { blob: Blob; opened: OpenedMeta } | undefined;
  currentKey: Uint8Array;
}): Promise<boolean> {
  if (!k.held || !keepOffered({ unconfirmed: k.held.opened.unconfirmed, held: true, seen: k.seen })) return false;
  const ok = await sealAndSwap(k.noteId, k.attachmentId, k.held.blob, k.held.opened.json, k.currentKey);
  if (ok) setResealed({ noteId: k.noteId });
  return ok;
}

/** Extracts image/video files from a clipboard paste event. */
export function filesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && ALLOWED_TYPES.includes(file.type)) {
      files.push(file);
    }
  }
  return files;
}
