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
 * Which key may open an attachment on this page, and whether the note can
 * vouch for it.
 *
 * Attachments are sealed under the note's content key, and the owner's page
 * also holds the note's RETIRED keys (retainedKeys.ts) — every key the note had
 * before someone was removed from it. A removed member still holds those, and
 * with the server's help can put a file under one of them into the note. So a
 * retired key is for the owner's VIEWING only:
 *
 *  - a file whose metadata opens only under a retired key is shown FLAGGED;
 *  - its blob opens only under the key that opened its metadata (the same-key
 *    rule). Upload seals both under one key and a re-key swaps both in one
 *    PUT, so a mixed pair is only ever a server's swap, and the flag is known
 *    from the metadata before anything is downloaded;
 *  - nothing opened under a retired key is re-sealed, except by the person's
 *    own "Keep file" after they have seen it (attachmentUpload.keepAttachment).
 *
 * Pure: the key material and the retired store come in as arguments, so the
 * rules are testable without a DOM or a network.
 */
import { decryptWithContentKey } from './crypto';

/** An attachment's metadata as this page opened it. */
export interface OpenedMeta {
  /** The metadata JSON exactly as it opened (what Keep re-seals). */
  json: string;
  filename: string | null;
  contentType: string;
  /** The key that opened it — the only key its blob may open under. */
  key: Uint8Array;
  /** Opened only under a retired key: shown flagged, never re-sealed by a re-key. */
  unconfirmed: boolean;
}

function parsed(json: string, key: Uint8Array, unconfirmed: boolean): OpenedMeta | null {
  try {
    const meta = JSON.parse(json);
    return {
      json,
      filename: typeof meta?.filename === 'string' && meta.filename ? meta.filename : null,
      contentType: typeof meta?.content_type === 'string' ? meta.content_type : '',
      key,
      unconfirmed,
    };
  } catch {
    return null;
  }
}

/**
 * Open an attachment's sealed metadata: the note's current key first, and the
 * retired keys only when it fails. `retired` is read lazily, so the common case
 * (everything under the current key) never touches the retired store.
 */
export function openAttachmentMeta(
  att: { encrypted_meta: string; meta_nonce: string },
  noteId: string,
  currentKey: Uint8Array,
  retired: () => readonly Uint8Array[],
): OpenedMeta | null {
  const sealed = { ciphertext: att.encrypted_meta, nonce: att.meta_nonce };
  const current = decryptWithContentKey(sealed, currentKey, noteId);
  if (current) return parsed(current, currentKey, false);
  for (const key of retired()) {
    const json = decryptWithContentKey(sealed, key, noteId);
    if (json) return parsed(json, key, true);
  }
  return null;
}

/**
 * The keys an attachment's blob may be opened with: only the key that opened
 * its metadata; the current key alone when the metadata opened under none.
 */
export function blobKeysFor(opened: OpenedMeta | null, currentKey: Uint8Array): Uint8Array[] {
  return [opened ? opened.key : currentKey];
}

/**
 * Whether a card offers "Keep file": it is flagged, this page holds the bytes
 * it opened, AND this page saw them reach the person — an image's `load`, a
 * video's `play`, or a download or shell save started from that card. Held
 * bytes alone are not seen: images and videos load on their own.
 */
export function keepOffered(card: { unconfirmed: boolean; held: boolean; seen: boolean }): boolean {
  return card.unconfirmed && card.held && card.seen;
}

/** The flag on a card whose file couldn't be confirmed. */
export const UNCONFIRMED_ATTACHMENT_TITLE = "Couldn't be confirmed";
/** The line under it. */
export const UNCONFIRMED_ATTACHMENT_BODY =
  'Someone who no longer has access to this note could have added or changed this file.';
export const KEEP_ATTACHMENT_LABEL = 'Keep file';
export const DELETE_UNCONFIRMED_LABEL = 'Delete';
export const KEEP_ATTACHMENT_FAILED = "Couldn't keep this file. Try again.";
