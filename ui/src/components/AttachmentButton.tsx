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

import { Component, createSignal, createEffect, createMemo, For, Show, onCleanup } from 'solid-js';
import { apiRequest } from '../lib/apiClient';
import { shellSave, shellSaveAvailable } from '../lib/shellSave';
import { decryptResponse } from '../lib/attachmentCrypto';
import { getRetained } from '../lib/retainedKeys';
import {
  uploadFile as sharedUploadFile,
  fetchAttachmentCiphertext,
  fitsUploadLimit,
  keepAttachment,
} from '../lib/attachmentUpload';
import {
  openAttachmentMeta,
  blobKeysFor,
  keepOffered,
  type OpenedMeta,
  UNCONFIRMED_ATTACHMENT_TITLE,
  UNCONFIRMED_ATTACHMENT_BODY,
  KEEP_ATTACHMENT_LABEL,
  DELETE_UNCONFIRMED_LABEL,
  KEEP_ATTACHMENT_FAILED,
} from '../lib/attachmentTrust';
import UpgradePrompt from './UpgradePrompt';
import { confirmAction } from './ConfirmDialog';

interface Attachment {
  id: string;
  encrypted_meta: string;
  meta_nonce: string;
  size_bytes: number;
}

interface DecryptedAttachment {
  id: string;
  /** This VERSION of the row (its id and sealed metadata): the bytes held for
   *  a card, and whether they were seen, belong to the version they were
   *  opened for, never to a later copy of the same id. */
  card: string;
  filename: string;
  contentType: string;
  size: number;
  blobUrl?: string;
  /** How its metadata opened here; null when it opened under no key. */
  opened: OpenedMeta | null;
  /** Opened only under a retired key: shown flagged (attachmentTrust.ts). */
  unconfirmed: boolean;
}

interface Props {
  noteId: string;
  attachments: Attachment[];
  contentKey: Uint8Array;
  onAttachmentAdded: () => void;
}

/** A row's version: its id and its sealed metadata (a re-seal changes the latter). */
const cardOf = (att: Attachment) => `${att.id}:${att.encrypted_meta}`;

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'video/mp4', 'video/webm',
  'application/pdf',
  'text/plain', 'text/markdown',
];

const AttachmentButton: Component<Props> = (props) => {
  const [uploading, setUploading] = createSignal(false);
  const [progress, setProgress] = createSignal(0);
  const [error, setError] = createSignal('');
  // Set when the register call is denied for storage quota (402) — shows the
  // upgrade prompt instead of a raw one-line error.
  const [storageLimit, setStorageLimit] = createSignal(false);
  const [loadedBlobs, setLoadedBlobs] = createSignal<Record<string, string>>({}); // by card
  // The Blob OBJECTS behind the object URLs. The shell save path needs real
  // bytes, and `fetch(blobUrl)` — the textbook way back from URL to Blob —
  // is blocked by the page's own CSP (connect-src has no blob:) and would fail
  // as an unhandled rejection with no visible error. The Blob is already
  // retained in memory by its object URL, so keeping the reference costs
  // nothing.
  const blobObjects: Record<string, Blob> = {}; // by card
  // How each held Blob's metadata opened WITH it — what "Keep file" re-seals
  // together with those bytes, and never a later copy.
  const heldMeta: Record<string, OpenedMeta> = {}; // by card
  // Cards whose content this page saw reach the person: an image's `load`, a
  // video's `play`, a download or shell save started from the card. Loading
  // alone is not seeing — previews load on their own.
  const [seen, setSeen] = createSignal<Record<string, true>>({}); // by card
  const markSeen = (card: string) => setSeen(prev => (prev[card] ? prev : { ...prev, [card]: true }));
  const [keeping, setKeeping] = createSignal<string | null>(null);

  /** Let go of what is held for `attId`'s versions — all of them, or all but `keep`. */
  const dropHeld = (attId: string, keep?: string) => {
    const mine = (card: string) => card.startsWith(`${attId}:`) && card !== keep;
    for (const [card, url] of Object.entries(loadedBlobs())) if (mine(card)) URL.revokeObjectURL(url);
    for (const card of Object.keys(blobObjects)) if (mine(card)) delete blobObjects[card];
    for (const card of Object.keys(heldMeta)) if (mine(card)) delete heldMeta[card];
    const without = <T,>(prev: Record<string, T>) => Object.keys(prev).some(mine)
      ? Object.fromEntries(Object.entries(prev).filter(([card]) => !mine(card)))
      : prev;
    setSeen(without);
    setLoadedBlobs(without);
  };

  // Cleanup blob URLs on unmount
  onCleanup(() => {
    Object.values(loadedBlobs()).forEach(url => URL.revokeObjectURL(url));
  });

  // Memoized: without it each setLoadedBlobs would re-run the per-attachment
  // WASM metadata decrypt for all K attachments (read at :length/:each/
  // preview), making inline previews O(K^2) on the main thread. createMemo
  // recomputes only when the attachments/content-key/loaded-blobs inputs
  // actually change.
  const decryptedAttachments = createMemo((): DecryptedAttachment[] => {
    const blobs = loadedBlobs();
    // Retired content keys are resolved lazily on the FIRST metadata the current
    // key can't open (a post-rotation blob whose sealed meta is still under the
    // old key, e.g. an interrupted re-key), so the common case pays no
    // localStorage read / unwrap. They open files for the owner's VIEWING only,
    // and whatever opens only under one is flagged (attachmentTrust.ts).
    let retained: Uint8Array[] | null = null;
    const retired = () => (retained ??= getRetained(props.noteId));
    return props.attachments.map(att => {
      const card = cardOf(att);
      const opened = openAttachmentMeta(att, props.noteId, props.contentKey, retired);
      if (!opened) {
        return {
          id: att.id, card, filename: `File ${att.id.slice(0, 6)}`, contentType: '', size: att.size_bytes,
          blobUrl: blobs[card], opened: null, unconfirmed: false,
        };
      }
      return {
        id: att.id,
        card,
        filename: opened.filename || 'Untitled',
        contentType: opened.contentType,
        size: att.size_bytes,
        blobUrl: blobs[card],
        opened,
        unconfirmed: opened.unconfirmed,
      };
    });
  });

  const loadAttachment = async (att: DecryptedAttachment) => {
    const attId = att.id;
    if (loadedBlobs()[att.card]) return;

    try {
      // Presigned R2 URL first (direct, fast), the authenticated proxy if that
      // fails (CORS / network).
      const resp = await fetchAttachmentCiphertext(attId);
      if (!resp) return;

      // Under the key that opened its metadata, and no other (a retired one
      // for a flagged file). Decrypted in the worker AS IT DOWNLOADS, one chunk
      // at a time, straight into a Blob: reading the whole ciphertext into
      // memory first and then copying it twice more makes a 100 MB attachment
      // fatal on a phone.
      const dec = await decryptResponse(
        blobKeysFor(att.opened, props.contentKey),
        resp,
        att.contentType || 'application/octet-stream',
      );
      if (!dec) {
        console.warn('Failed to decrypt attachment content', attId);
        return;
      }

      // The list may have moved on while this downloaded: hold nothing for a
      // version of the row that is no longer shown.
      if (!props.attachments.some(a => cardOf(a) === att.card)) return;
      const blob = dec.blob;
      const blobUrl = URL.createObjectURL(blob);
      dropHeld(attId, att.card); // an earlier version of this row, now superseded
      blobObjects[att.card] = blob;
      if (att.opened) heldMeta[att.card] = att.opened;
      setLoadedBlobs(prev => ({ ...prev, [att.card]: blobUrl }));
    } catch (e) {
      console.warn('Failed to decrypt attachment:', e);
    }
  };

  // Auto-load images and videos for inline preview
  const autoLoadPreviews = () => {
    for (const att of decryptedAttachments()) {
      if (!att.blobUrl && (att.contentType.startsWith('image/') || att.contentType.startsWith('video/'))) {
        loadAttachment(att);
      }
    }
  };

  // Reactively auto-load previews when attachments list changes
  createEffect(() => {
    const atts = props.attachments; // track the prop
    if (atts.length > 0) {
      setTimeout(autoLoadPreviews, 100);
    }
  });

  const handleFileSelect = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ALLOWED_TYPES.join(',');
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      for (const file of files) await uploadFile(file);
    };
    input.click();
  };

  const uploadFile = async (file: File) => {
    if (!fitsUploadLimit(file.size)) {
      setError(`File too large: ${file.name} (max 100 MB)`);
      return;
    }
    setUploading(true);
    setProgress(0);
    setError('');
    setStorageLimit(false);

    try {
      setProgress(40);
      // Delegate encrypt + PUT + register to the shared uploader, sealing with
      // the per-note content key so share recipients can decrypt.
      const result = await sharedUploadFile(props.noteId, file, props.contentKey);
      if (!result.success) {
        // The register call's only quota gate is storage — a 402 (or the
        // explicit code) means the user is out of free storage. Surface the
        // upgrade prompt rather than swallowing it as a generic error.
        if (result.status === 402 || result.errorCode === 'quota_storage_exceeded') {
          setStorageLimit(true);
        } else {
          setError(result.error || 'Upload failed');
        }
        return;
      }

      setProgress(100);
      props.onAttachmentAdded();
    } catch (e) {
      setError(`Upload error: ${e instanceof Error ? e.message : 'Unknown'}`);
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (att: DecryptedAttachment) => {
    setError(''); // a previous failure must not read as this one's verdict
    let url = att.blobUrl;
    if (!url) {
      await loadAttachment(att);
      url = loadedBlobs()[att.card];
    }
    if (!url) return;
    // Inside the Android shell an <a download> on a blob: URL does nothing —
    // there is no download UI and DownloadManager cannot fetch blob: — so
    // hand the bytes to the shell instead. NOT via fetch(blobUrl): connect-src
    // in the page's CSP does not include blob:, so that fetch throws — use the
    // Blob object kept from decryption.
    // Both failures report through `error()` — the strip this component
    // already renders — rather than `alert()`: this branch only runs inside a
    // shell, and an alert cannot be seen there. On iOS the WebView implements
    // no WKUIDelegate panel method, so `alert()` is a silent no-op; on Android
    // it renders as a stock system dialog headed `The page at "https://…"
    // says:`, which is the browser's chrome announcing itself in the middle of
    // the app.
    if (shellSaveAvailable()) {
      try {
        const blob = blobObjects[att.card];
        const handed = blob ? await shellSave(att.filename, att.contentType, blob) : false;
        if (handed) { markSeen(att.card); return; }
        setError('This file is too large to save from the app. Use the web app to download it.');
      } catch (e) {
        // console.error is forwarded to logcat by the shell; an unhandled
        // rejection here would be invisible.
        console.error('shell save failed:', e);
        setError('Saving failed: ' + (e instanceof Error ? e.message : String(e)));
      }
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = att.filename;
    a.click();
    markSeen(att.card);
  };

  // "Keep file" on a flagged card: re-seals exactly the bytes and metadata this
  // page opened and the person saw, under the note's current key. The open note
  // re-reads its list when it lands (attachmentsResealed).
  const handleKeep = async (att: DecryptedAttachment) => {
    setError('');
    setKeeping(att.card);
    try {
      const blob = blobObjects[att.card];
      const opened = heldMeta[att.card];
      const ok = await keepAttachment({
        noteId: props.noteId,
        attachmentId: att.id,
        seen: !!seen()[att.card],
        held: blob && opened ? { blob, opened } : undefined,
        currentKey: props.contentKey,
      });
      if (!ok) setError(KEEP_ATTACHMENT_FAILED);
    } catch (e) {
      console.warn('[note] keep attachment failed', att.id, e);
      setError(KEEP_ATTACHMENT_FAILED);
    } finally {
      setKeeping(null);
    }
  };

  const handleDelete = async (attId: string) => {
    if (!(await confirmAction({
      message: 'Delete this attachment?',
      detail: 'The file is removed from the note and from storage. This cannot be undone.',
      confirmLabel: 'Delete attachment',
      destructive: true,
    }))) return;
    await apiRequest(`/api/v1/attachments/${attId}`, { method: 'DELETE' });
    // Cleanup blob URLs
    dropHeld(attId);
    props.onAttachmentAdded();
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <div class="attachment-section">
      <div class="attachment-header">
        <button class="fmt-btn attachment-add-btn" onClick={handleFileSelect} disabled={uploading()} title="Add attachment">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
          <span class="attachment-plus">+</span>
        </button>
        <Show when={uploading()}>
          <div class="upload-progress">
            <div class="upload-bar" style={{ width: `${progress()}%` }} />
          </div>
        </Show>
      </div>

      <Show when={error()}>
        <div class="attachment-error">{error()}</div>
      </Show>

      <Show when={storageLimit()}>
        <UpgradePrompt message="You've used your 100 MB free storage. Premium raises it to 10 GB." />
      </Show>

      <Show when={decryptedAttachments().length > 0}>
        <div class="attachment-gallery">
          <For each={decryptedAttachments()}>
            {(att) => (
              <div class="attachment-card">
                {/* Inline preview for images */}
                <Show when={att.contentType.startsWith('image/') && att.blobUrl}>
                  <img
                    class="attachment-preview-img" src={att.blobUrl} alt={att.filename} loading="lazy"
                    onLoad={() => markSeen(att.card)}
                  />
                </Show>

                {/* Inline preview for videos */}
                <Show when={att.contentType.startsWith('video/') && att.blobUrl}>
                  <video
                    class="attachment-preview-video" src={att.blobUrl} controls preload="metadata"
                    onPlay={() => markSeen(att.card)}
                  />
                </Show>

                {/* Non-previewable files */}
                <Show when={!att.contentType.startsWith('image/') && !att.contentType.startsWith('video/')}>
                  <div class="attachment-file-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>
                    </svg>
                  </div>
                </Show>

                {/* Loading state */}
                <Show when={att.contentType.startsWith('image/') && !att.blobUrl}>
                  <div class="attachment-loading">Loading...</div>
                </Show>

                <div class="attachment-card-footer">
                  <span class="attachment-name" title={att.filename}>{att.filename}</span>
                  <span class="attachment-size">{formatSize(att.size)}</span>
                  <div class="attachment-card-actions">
                    <button class="attachment-action" onClick={() => handleDownload(att)} title="Download">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                    <button class="attachment-action attachment-action-danger" onClick={() => handleDelete(att.id)} title="Delete">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                </div>

                {/* Opened only under a key from before someone lost access:
                    shown, never brought forward unless the person keeps it
                    after seeing it (attachmentTrust.ts). */}
                <Show when={att.unconfirmed}>
                  <div class="notice-warning attachment-unconfirmed">
                    <div class="attachment-unconfirmed-title">{UNCONFIRMED_ATTACHMENT_TITLE}</div>
                    <div>{UNCONFIRMED_ATTACHMENT_BODY}</div>
                    <div class="attachment-unconfirmed-actions">
                      <Show when={keepOffered({ unconfirmed: att.unconfirmed, held: !!att.blobUrl, seen: !!seen()[att.card] })}>
                        <button class="btn" disabled={keeping() === att.card} onClick={() => handleKeep(att)}>
                          {KEEP_ATTACHMENT_LABEL}
                        </button>
                      </Show>
                      <button class="btn btn-secondary" onClick={() => handleDelete(att.id)}>
                        {DELETE_UNCONFIRMED_LABEL}
                      </button>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default AttachmentButton;
