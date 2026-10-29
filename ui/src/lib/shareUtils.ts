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
 * Helpers for programmatic share/unshare when the user isn't driving the
 * Share panel directly. Used by:
 *   - notesStore.createNote — auto-share a new note added to a shared notebook
 *   - notesStore.updateNote — reconcile shares when a note changes notebooks
 *
 * The Share panel has its own flow with progress UI and error surfacing.
 * This module is the silent counterpart for background reconciliation.
 */
import { apiRequest } from './apiClient';
import { ASK_AGAIN_AFTER_MS, askTwice } from './askTwice';
import {
  wrapContentKeyForRecipient,
  getSharingPublicKeyHex,
  generateContentKey,
  wrapContentKeyWithVault,
  unwrapContentKeyWithVault,
  encryptWithContentKey,
  decryptWithContentKey,
  allowSealToRecipient,
} from './crypto';
import { canSign, signShareWrap } from './keyOps';
import { listAttachmentsForRekey, rekeyNoteAttachments, type AttachmentRow } from './attachmentUpload';
import { retain as retainContentKey } from './retainedKeys';
import type { NotebookShareRecipient } from '../stores/notebooks';
import { notebooksStore } from '../stores/notebooks';
import {
  notebookGrantFrom, notebookItemContent, notebookItemSharePermission,
  type NotebookMember, type NotebookPermission,
} from './notebookItem';
import { notesStore, type NoteItem } from '../stores/notes';
import { noteDocument } from './noteDocument';
import { authStore } from '../stores/auth';

/** Signature over a fresh share-invite wrap. Returns null if signing isn't
 * possible right now (no signing key, missing recipient user_id, etc.).
 *
 * A null here is FATAL to the share, never a fall-through: an unsigned wrap
 * is dropped by any recipient that already holds a TOFU pin for us, so
 * sending one produces a share that silently never arrives. Every caller must
 * abort rather than POST an unsigned wrap.
 *
 * Sign under the REAL content-key generation (`content_key_generation`). The
 * caller supplies it — a share-create binds the item's CURRENT generation
 * (same content key), a rotate binds CURRENT + 1 (the server bumps generation
 * by exactly 1 in rotate-shares, so the fresh wrap the recipient receives
 * verifies under the post-bump value). Recipients feed the verified
 * generation into a per-item rollback floor, so a replayed older wrap (valid
 * sig, lower generation) is rejected. Legacy readers still accept these via
 * the SDK's verify-both fallback. */
async function trySignShareWrap(
  noteId: string,
  recipientUserId: string | null | undefined,
  wrappedKeyB64: string,
  contentKeyVersion: number,
): Promise<string | null> {
  // Through lib/keyOps: local keys in a browser, the native bridge in the iOS
  // shell, where the signing secret never enters the page.
  if (!canSign()) return null;
  const me = authStore.user();
  if (!me?.id) return null;
  if (!recipientUserId) return null;
  try {
    return await signShareWrap({
      senderUserId: me.id,
      recipientUserId,
      itemId: noteId,
      contentKeyVersion: contentKeyVersion >>> 0,
      wrappedKeyBase64: wrappedKeyB64,
    });
  } catch (e) {
    console.warn('[note] signing the share wrap failed; not sending it:', e);
    return null;
  }
}

/**
 * How many times a key change signs the new key for someone who stays, a
 * pause (`ASK_AGAIN_AFTER_MS`) apart, before it stops. One failed call to
 * the iOS shell's signer must not make that person silently lose the note:
 * the page tries again automatically, and after several tries asks the
 * user to try again later or reach out to support.
 */
export const SIGN_ATTEMPTS = 3;

/** {@link trySignShareWrap}, tried again after a pause while it gives no
 *  signature: {@link SIGN_ATTEMPTS} times in all. */
async function signShareWrapTryingAgain(
  noteId: string,
  recipientUserId: string | null | undefined,
  wrappedKeyB64: string,
  contentKeyVersion: number,
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const sig = await trySignShareWrap(noteId, recipientUserId, wrappedKeyB64, contentKeyVersion);
    if (sig || attempt >= SIGN_ATTEMPTS) return sig;
    await new Promise<void>(resolve => setTimeout(resolve, ASK_AGAIN_AFTER_MS));
  }
}

/**
 * The item's CURRENT content-key generation, straight from the server.
 *
 * Only the notes store tracks a local generation, and it holds
 * `item_type === 1` rows exclusively (stores/notes.ts: `if (item.item_type !== 1)
 * continue`). So for anything that is not a note — a notebook — there is no
 * local value to read and the server's is the only one there is. It is also the
 * value the RECIPIENT verifies against (`content_key_generation` off the inbox
 * row), which is what makes it the right one to sign under.
 *
 * Returns null when the read fails: callers must fail closed rather than guess.
 * A missing generation falling back to 1 would sign every wrap for a notebook
 * that has ever been rotated under the wrong generation, and the recipient
 * would drop it as a forged signature.
 */
async function fetchContentKeyGeneration(itemId: string): Promise<number | null> {
  const r = await apiRequest<{ content_key_generation?: number }>(`/api/v1/items/${itemId}`);
  if (!r.success) return null;
  return r.data.content_key_generation ?? 1;
}

/**
 * Why a background share did not go out.
 *  - `key-changed`: the recipient's key differs from the one pinned here, and
 *    the owner has not approved the new one (SharePanel's "Approve new key").
 *  - `cannot-sign`: no signing key, so the wrap would be one the recipient's
 *    app has to reject.
 *  - `upgrade`: sharing is a paid feature and the server said so (402).
 *  - `failed`: anything else the request came back with.
 */
export type ShareFailure = 'key-changed' | 'cannot-sign' | 'upgrade' | 'failed';
export type ShareOutcome = { ok: true } | { ok: false; reason: ShareFailure };

/** POST /items/{id}/share with a freshly-wrapped content key. Returns
 *  whether the share row was created. Silent on failure — caller logs. */
export async function shareNoteWithRecipient(
  noteId: string,
  contentKey: Uint8Array,
  recipient: NotebookShareRecipient,
  opts: { contentKeyGeneration?: number } = {},
): Promise<boolean> {
  return (await shareNoteWithRecipientResult(noteId, contentKey, recipient, opts)).ok;
}

/** shareNoteWithRecipient, saying WHY when it did not share — what the
 *  notebook fan-out records so the owner can see who is not receiving. */
export async function shareNoteWithRecipientResult(
  noteId: string,
  contentKey: Uint8Array,
  recipient: NotebookShareRecipient,
  opts: { contentKeyGeneration?: number } = {},
): Promise<ShareOutcome> {
  // Send-side TOFU pin gate: refuse to auto-share when the recipient's
  // cached/directory sharing key no longer matches their pinned key — a server
  // key substitution would otherwise seal the content key to an attacker-held
  // key. Mirrors note-android allowSealToRecipient (TOFU-pin on first contact,
  // refuse on an explicit mismatch); recovery is the owner approving the new
  // key in the Share panel after comparing safety numbers.
  if (
    recipient.publicKey &&
    !allowSealToRecipient(recipient.userId ?? null, recipient.signingPublicKey ?? null, recipient.publicKey)
  ) {
    console.warn(`[note] refusing auto-share to ${recipient.email}: recipient key changed (pin mismatch)`);
    return { ok: false, reason: 'key-changed' };
  }
  const wrapped = recipient.publicKey
    ? wrapContentKeyForRecipient(contentKey, recipient.publicKey)
    : null;
  // Share-create reuses the CURRENT content key → bind its current generation
  // (no rotation happens here). Base 1 when the local copy predates the field.
  //
  // `opts.contentKeyGeneration` is how a NON-NOTE item supplies its own: the
  // notes store only ever holds item_type 1, so the lookup below can never
  // match a notebook and would silently bottom out at 1 for one.
  const currentGen = opts.contentKeyGeneration
    ?? notesStore.notes().find(n => n.id === noteId)?.contentKeyGeneration
    ?? 1;
  const wrap_signature = wrapped
    ? await trySignShareWrap(noteId, recipient.userId ?? null, wrapped, currentGen)
    : null;
  // FAIL CLOSED: a wrap we could not sign is a dead letter (see
  // trySignShareWrap) — recipients holding a pin for us drop it, and nothing
  // tells either side. Refuse the POST and tell the owner instead.
  if (wrapped && !wrap_signature) {
    console.warn(`[note] refusing auto-share to ${recipient.email}: wrap could not be signed`);
    return { ok: false, reason: 'cannot-sign' };
  }
  const r = await apiRequest(`/api/v1/items/${noteId}/share`, {
    method: 'POST',
    body: {
      email: recipient.email,
      permission: recipient.permission,
      wrapped_key: wrapped,
      wrap_signature,
      sharer_public_key: getSharingPublicKeyHex(),
    },
  });
  if (r.success) return { ok: true };
  return { ok: false, reason: r.status === 402 ? 'upgrade' : 'failed' };
}

/**
 * Share a NOTEBOOK with a recipient: seal the notebook's content key to them,
 * then record them in the roster.
 *
 * ## Order is deliberate: the share first, the roster LAST
 *
 * "Sealed but not in the roster" is not access the owner cannot see: the
 * Share panel lists the notebook object's own share rows, read from the
 * server, and a removal finds those rows by address (lib/notebookRemoval,
 * `theirSharesOn`). Neither looks at the roster.
 *
 * What the roster IS read for is sealing NEW notes: the owner's page falls
 * back to it when the standing list is empty (stores/notes.ts,
 * `notebookNoteRecipients`), and a member's phone seals to everyone on it
 * (note-android `NotebookShareFanOut.rosterRecipientsFor`). Written first, a
 * share that then failed would leave the person on it with no invitation, and
 * the next note anybody added would reach them, readable, with nothing to
 * answer — as for any free account that tries to share a notebook: the
 * roster would be written, then the share would come back 402.
 *
 * Roster last, every place this can stop leaves FEWER people receiving, never
 * more: a share with no roster entry is an invitation whose notes have not
 * been sent, which the owner sees in the panel and can send again or remove.
 *
 * ## The notebook object goes out view-only, whatever they may do to its notes
 *
 * The server grants writes to any `edit` recipient, so an edit-shared
 * notebook item would let a member rewrite the roster and invite people.
 * Invites are owner-only, and this is what enforces it. Their real
 * permission rides in the roster and governs the NOTES.
 */
export async function shareNotebookWithRecipient(
  notebookId: string,
  recipient: NotebookShareRecipient,
  permission: NotebookPermission,
): Promise<boolean> {
  return (await shareNotebookWithRecipientResult(notebookId, recipient, permission)) === 'shared';
}

/** What became of sharing a notebook as an object (`shareNotebookWithRecipientResult`). */
export type NotebookShareOutcome =
  /** The notebook's key is sealed to them and the roster names them: they have an invitation. */
  | 'shared'
  /** There is nobody to seal to yet: the address has no account, or it has published no key. */
  | 'no-account'
  /** This browser cannot open the notebook, so it holds no key of it to pass on. */
  | 'cannot-open'
  /**
   * It was tried and did not happen, and why: the share's own reason
   * (`ShareFailure`), or 'failed' for the generation read or the roster write.
   */
  | ShareFailure;

/**
 * `shareNotebookWithRecipient`, saying WHY when the notebook was not shared.
 *
 * The caller needs the difference. A `ShareFailure` is a share that should
 * have happened and did not: the notebook's notes must not go out without
 * it, or the reader gets loose notes and no invitation to answer. And it
 * needs to know WHICH failure: a free account is shown the upgrade prompt,
 * not told to check its connection. 'no-account' and 'cannot-open' are
 * notebooks that cannot be shared as an object, and those are shared note
 * by note (an address with no account gets its notes as invitations to sign
 * up, with nothing sealed).
 */
export async function shareNotebookWithRecipientResult(
  notebookId: string,
  recipient: NotebookShareRecipient,
  permission: NotebookPermission,
): Promise<NotebookShareOutcome> {
  if (!recipient.userId || !recipient.publicKey) return 'no-account';
  const contentKey = notebooksStore.notebookContentKey(notebookId);
  // Null means this client cannot open the notebook — never a reason to fall
  // back to something weaker.
  if (!contentKey) return 'cannot-open';

  // A notebook has no local generation to read (the notes store holds notes
  // only), so ask the server for the one the recipient will verify against. No
  // answer means no share: an unsigned-at-the-wrong-generation wrap is dropped
  // by the recipient as a forgery, which looks to the owner exactly like a
  // successful share. (The roster write below moves the item's `version`, not
  // its key's generation: read before or after it, this is the same number.)
  const generation = await fetchContentKeyGeneration(notebookId);
  if (generation === null) {
    console.warn(`[note] not sharing notebook ${notebookId}: could not read its content-key generation`);
    return 'failed';
  }

  // `contribute` is a valid share permission but not a NOTE permission —
  // the cast is the seam between the two vocabularies, and is safe because the
  // server treats anything that is not 'edit' as read-only for the ITEM while
  // reading 'contribute' as the collection right.
  const shared = await shareNoteWithRecipientResult(notebookId, contentKey, {
    ...recipient,
    permission: notebookItemSharePermission(permission) as 'edit' | 'view',
  }, { contentKeyGeneration: generation });
  if (!shared.ok) return shared.reason;

  const existing = notebooksStore.membersOf(notebookId);
  const member: NotebookMember = {
    userId: recipient.userId,
    email: recipient.email,
    sharingPublicKey: recipient.publicKey,
    signingPublicKey: recipient.signingPublicKey ?? null,
    permission,
  };
  // Replace rather than append, so re-sharing to change someone's permission
  // does not leave two entries for one person — and the LAST one silently wins.
  const next = [...existing.filter(m => m.userId !== member.userId), member];
  // Not written: they hold an invitation, and no member's new note reaches them
  // until the owner shares again. Said as a failure, so that the panel stops
  // and says so instead of sending the notes and calling it shared.
  if (!(await notebooksStore.setNotebookMembers(notebookId, next))) {
    console.warn(`[note] notebook ${notebookId} is shared with ${recipient.email}, but its member list could not be written`);
    return 'failed';
  }
  return 'shared';
}

/**
 * Rotate the note's per-note content key, optionally removing share
 * rows in the same atomic operation. Forward-secrecy: the removed
 * recipients keep the *old* content key from past ciphertext, but
 * future ciphertext uses a fresh key they were never given; every
 * remaining share recipient receives the new key re-sealed under
 * their public key.
 *
 * Uses the backend `rotate-shares` endpoint so the item update, share
 * deletes, and remaining-recipient rewrap all land in one transaction.
 * That closes the race where two owners revoking concurrently could
 * leave a straggling stale wrap.
 *
 * Steps:
 *   1. Fetch the current ciphertext (we rotate on the server's copy
 *      rather than the cached NoteItem in case another device edited).
 *   2. Unwrap the current content key with the vault; decrypt.
 *   3. Generate a fresh content key, re-encrypt the plaintext, wrap
 *      the new key under the vault.
 *   4. Look up every remaining recipient's public key and seal the
 *      new content key for each.
 *   5. POST /items/{id}/rotate-shares with the new ciphertext + wrap +
 *      remove_share_ids + per-share rewraps. The backend applies it all
 *      in one transaction, optimistic-version-gated.
 */
/** What the rotation needs to know about an item, whatever kind it is. */
interface RotatableItem {
  itemId: string;
  wrappedContentKey: string | null | undefined;
  wrappedContentKeyNonce: string | null | undefined;
  version: number;
  /** Local generation, when the caller tracks one. Notes do; notebooks read
   *  the server's instead. */
  contentKeyGeneration?: number | null;
}

export interface RotationResult {
  rotated: boolean;
  remainingCount: number;
  reWrapFailures: string[];
  /** True when rotation also invalidated a public share link (backend
   *  deletes the token row so stale URLs return 404). Owners can
   *  surface a "link revoked" notice to avoid confusion. */
  revokedShareLink: boolean;
  /** The new key could not be signed for someone who stays, even tried again
   *  ({@link SIGN_ATTEMPTS}): nothing was sent, and nobody's access changed. */
  couldNotSign?: boolean;
  /** The item's key, or what the server has under it, does not open here:
   *  nothing was sent. Not the connection. */
  notOpenHere?: boolean;
  /** The server refused the write: the item changed since it was read (409),
   *  by an edit or a change to its sharing. Nothing changed. */
  changedElsewhere?: boolean;
  /** The server answered, and refused for another reason (a 429, a 5xx, a
   *  403…): not the connection, and not said to be. Nothing changed. */
  refused?: boolean;
  /** Present only on success — what the caller must mirror into its own store
   *  so the next edit reuses the new key instead of rotating again. */
  applied?: {
    /** Null for a rebuilt record (lib/notebookRepair): there was no key that opened it. */
    oldKey: Uint8Array | null;
    newKey: Uint8Array;
    wrappedForVault: { wrappedKey: string; nonce: string };
    version: number;
    contentKeyGeneration: number;
  };
}

/** A request the server answered, and refused (any status): not the
 *  connection. One with no answer has no status. */
function refusedByServer(r: { success: boolean; status?: number }): boolean {
  return !r.success && r.status !== undefined;
}

const NOT_ROTATED: RotationResult = {
  rotated: false, remainingCount: 0, reWrapFailures: [], revokedShareLink: false,
};

/**
 * Rotate one item's content key: mint a fresh one, re-encrypt under it,
 * re-seal to whoever remains, and hand the server the share rows to delete —
 * all in a single rotate-shares transaction, so concurrent revokes from two
 * devices cannot leave straggling stale wraps.
 *
 * Generic over the KIND of item on purpose. Notes and notebooks differ only in
 * where the wrap and version come from and what has to be updated afterwards;
 * the security-critical middle — the TOFU send gate, the signature, the
 * generation the wraps are signed under — must be one implementation, because
 * two copies of it drift and only one of them gets fixed.
 */
/**
 * Why recipients are being dropped, recorded by the server (the `reason` of
 * a rotate-shares request, or `DELETE /shares/{id}?reason=`). A notebook
 * removal rotates every child note; only the client knows those rotations
 * belong to it, so it says so. Absent means `rotate`.
 */
export type RevokeReason = 'rotate' | 'notebook_removal';

async function rotateItemContentKey(
  item: RotatableItem,
  removeShareIds: string[],
  opts: {
    retainOldKey: boolean;
    reason?: RevokeReason;
    /**
     * The content to write, for a record no key here opens (lib/notebookRepair
     * `rebuild`): it is put under the new key in place of what the old one
     * would have opened. Everything else is this one rotation: the same
     * holders, the same send gate, the same signatures, one transaction.
     */
    rebuiltContent?: string;
    /**
     * Nobody asked for it: a note rescued or a notebook rebuilt after a
     * password reset. Then it gives the new key to NOBODY: an item anyone else
     * holds is not changed, and the result says how many hold it. Who holds an
     * item is the server's word, and on first contact the send gate takes the
     * server's word for their key too: a key change nobody asked for would let
     * the server choose who reads the item.
     */
    unattended?: boolean;
    /**
     * Only these addresses (in lower case) are given the new key; anyone else
     * who holds the item keeps the wrap they have, which opens nothing after
     * it, and can be added again. For a rebuild, whose people must come from
     * the owner's own list and never from the server's rows.
     */
    sealOnlyTo?: ReadonlySet<string>;
  },
): Promise<RotationResult> {
  const itemId = item.itemId;
  let oldKey: Uint8Array | null = null;
  let plaintext: string;
  // Read now, not from a cache: the generation the new wraps are signed under
  // is the server's, and so is the content a rotation re-encrypts.
  let serverItem: Awaited<ReturnType<typeof apiRequest<{
    encrypted_content: string; content_nonce: string; content_key_generation?: number;
  }>>>;
  if (opts.rebuiltContent === undefined) {
    if (!item.wrappedContentKey || !item.wrappedContentKeyNonce) {
      // Legacy / unshareable — encrypted under the vault key itself, so there is
      // no content key to rotate.
      return NOT_ROTATED;
    }
    oldKey = unwrapContentKeyWithVault(item.wrappedContentKey, item.wrappedContentKeyNonce);
    if (!oldKey) return { ...NOT_ROTATED, notOpenHere: true };

    // Decrypt the current ciphertext → plaintext JSON. We need the canonical
    // on-server plaintext rather than the cached fields so we don't silently
    // drop content out of sync with the server copy.
    serverItem = await askTwice(() => apiRequest<{
      encrypted_content: string; content_nonce: string; content_key_generation?: number;
    }>(`/api/v1/items/${itemId}`));
    if (!serverItem.success) return { ...NOT_ROTATED, ...(refusedByServer(serverItem) ? { refused: true } : {}) };
    const opened = decryptWithContentKey(
      { nonce: serverItem.data.content_nonce, ciphertext: serverItem.data.encrypted_content },
      oldKey,
      itemId,
    );
    if (opened === null) return { ...NOT_ROTATED, notOpenHere: true };
    plaintext = opened;
  } else {
    serverItem = await askTwice(() => apiRequest<{
      encrypted_content: string; content_nonce: string; content_key_generation?: number;
    }>(`/api/v1/items/${itemId}`));
    if (!serverItem.success) return { ...NOT_ROTATED, ...(refusedByServer(serverItem) ? { refused: true } : {}) };
    plaintext = opts.rebuiltContent;
  }

  const newKey = generateContentKey();
  const newCiphertext = encryptWithContentKey(plaintext, newKey, itemId);
  const wrappedForVault = wrapContentKeyWithVault(newKey);

  // Fetch the full share list including the soon-to-be-removed rows.
  // We filter remove_share_ids out of the rewrap list so we don't seal
  // the new key for someone we're about to cut off.
  interface ShareRow {
    id: string; recipient_email: string; permission: string;
    /** Does the row carry a key at all? Absent from a server that does not say: read as yes. */
    has_wrap?: boolean;
  }
  // Not read even when asked again: nothing is sent. rotate-shares re-keys only
  // the rows it is given, and every other row keeps the old wrap, which opens
  // nothing after it: sent without the list, a removal would cut off everyone
  // it did not name, and say nothing.
  const sharesResp = await askTwice(() => apiRequest<ShareRow[]>(`/api/v1/items/${itemId}/shares`));
  if (!(sharesResp.success && Array.isArray(sharesResp.data))) return NOT_ROTATED;
  const allShares: ShareRow[] = sharesResp.data;
  const removeSet = new Set(removeShareIds);
  // Only people who HOLD the key are given the new one. A row with no key is
  // someone invited before they had an account: nothing could be sealed for
  // them, and their invitation is finished by its own road, notebook first
  // (lib/finishInvitations). Re-sealed here, the first re-key after they
  // signed up (anyone's removal, a move, a note's removal) would hand them the
  // note by itself: readable, with no invitation, to whatever account the
  // directory named for the address at that moment. Their row stays as it
  // is, without a key, and that is not a failure of this re-key.
  const holders = allShares.filter(s => !removeSet.has(s.id) && s.has_wrap !== false);
  if (opts.unattended && holders.length > 0) {
    return { ...NOT_ROTATED, remainingCount: holders.length, reWrapFailures: holders.map(s => s.recipient_email) };
  }
  const remaining = opts.sealOnlyTo
    ? holders.filter(s => opts.sealOnlyTo!.has(s.recipient_email.toLowerCase()))
    : holders;

  // The server bumps content_key_generation by exactly 1 in rotate-shares
  // (the ONLY bump path), so the re-sealed wraps the remaining recipients get
  // must be signed under CURRENT + 1 — the generation they'll read them at.
  // The caller's local generation when it tracks one (notes), else the
  // server's own value (notebooks). Either way + 1, because the server bumps by
  // exactly one and the recipient reads the wraps at the bumped generation.
  const rotateGen =
    (item.contentKeyGeneration ?? serverItem.data.content_key_generation ?? 1) + 1;

  const reWrapFailures: string[] = [];
  const updateShares: { share_id: string; wrapped_key: string; wrap_signature: string | null }[] = [];
  if (remaining.length > 0) {
    const keyLookup = await askTwice(() => apiRequest<{
      users: { email: string; user_id: string | null; sharing_public_key: string | null; signing_public_key: string | null }[];
    }>(
      '/api/v1/users/public-keys',
      { method: 'POST', body: { emails: remaining.map(s => s.recipient_email) } },
    ));
    // Their keys not read even when asked again: nothing is sent, for the same
    // reason. Every one of them would have kept a wrap that opens nothing.
    if (!keyLookup.success) {
      return {
        ...NOT_ROTATED, remainingCount: remaining.length, reWrapFailures: remaining.map(s => s.recipient_email),
        ...(refusedByServer(keyLookup) ? { refused: true } : {}),
      };
    }
    const pubByEmail = new Map<string, { sharingPub: string; userId: string | null; signingPub: string | null }>();
    for (const u of keyLookup.data.users) {
      if (u.sharing_public_key) {
        pubByEmail.set(u.email.toLowerCase(), {
          sharingPub: u.sharing_public_key,
          userId: u.user_id,
          signingPub: u.signing_public_key,
        });
      }
    }
    for (const s of remaining) {
      const entry = pubByEmail.get(s.recipient_email.toLowerCase());
      // Send-side TOFU pin gate: don't re-wrap the fresh content key to a
      // recipient whose directory key no longer matches their pin — a server
      // substitution would hand the rotated key to an attacker. Refusing here
      // surfaces them as a re-wrap failure (same as a missing pubkey), leaving
      // the owner to re-share out-of-band. Mirrors note-android
      // allowSealToRecipient.
      const allowed = entry
        ? allowSealToRecipient(entry.userId, entry.signingPub, entry.sharingPub)
        : false;
      const wrapped = entry && allowed ? wrapContentKeyForRecipient(newKey, entry.sharingPub) : null;
      const sig = wrapped
        ? await signShareWrapTryingAgain(itemId, entry?.userId ?? null, wrapped, rotateGen)
        : null;
      if (wrapped && sig) {
        updateShares.push({ share_id: s.id, wrapped_key: wrapped, wrap_signature: sig });
      } else if (wrapped) {
        // Sealed, and not signed even when tried again. An unsigned rewrap is
        // dropped by them (they hold a pin for us by now), and without one the
        // note is re-keyed past them: either way they would silently lose it.
        // So the key change stops here, before anything is sent: nobody's
        // access changes, and the caller asks the user to try again later or
        // reach out to support.
        console.warn(`[note] rotate: the new key could not be signed for ${s.recipient_email}; nothing is sent`);
        return { ...NOT_ROTATED, remainingCount: remaining.length, reWrapFailures: [s.recipient_email], couldNotSign: true };
      } else {
        // Without a pubkey we can't generate a new seal. The backend
        // endpoint requires a wrapped_key per remaining share — skip
        // this recipient and surface them as a failure so the caller
        // can prompt the owner to re-share once the recipient provisions
        // a key.
        reWrapFailures.push(s.recipient_email);
      }
    }
  }

  // Availability safety net: retain the OLD content key BEFORE committing the
  // rotation, so a crash in the window between the server rotation landing and
  // the best-effort attachment re-key finishing cannot orphan the owner's
  // pre-rotation attachment blobs (they stay sealed under oldKey in R2 until the
  // re-key reaches them). The owner's attachment decrypt path falls back to this
  // retained key. Mirrors the note-ios ContentKeyRotator retain-before-commit
  // ordering; retain() is idempotent + deduped, so writing it ahead of a PUT
  // that then fails is harmless (the item keeps oldKey as its current key).
  //
  // Skipped for items that cannot have attachments — a notebook is a name and a
  // roster — where retaining would only grow a store of keys nothing reads.
  if (opts.retainOldKey && oldKey) retainContentKey(itemId, oldKey);

  const put = await apiRequest<{ version: number; content_key_generation?: number; revoked_share_link?: boolean }>(
    `/api/v1/items/${itemId}/rotate-shares`,
    {
      method: 'POST',
      body: {
        encrypted_content: newCiphertext.ciphertext,
        content_nonce: newCiphertext.nonce,
        wrapped_content_key: wrappedForVault.wrappedKey,
        wrapped_content_key_nonce: wrappedForVault.nonce,
        expected_version: item.version,
        remove_share_ids: removeShareIds,
        update_shares: updateShares,
        ...(opts.reason ? { reason: opts.reason } : {}),
      },
    },
  );
  if (!put.success) {
    return {
      rotated: false, remainingCount: remaining.length, reWrapFailures, revokedShareLink: false,
      ...(put.status === 409 ? { changedElsewhere: true } : refusedByServer(put) ? { refused: true } : {}),
    };
  }

  return {
    rotated: true,
    remainingCount: remaining.length,
    reWrapFailures,
    revokedShareLink: put.data.revoked_share_link ?? false,
    applied: {
      oldKey,
      newKey,
      wrappedForVault,
      version: put.data.version,
      // Keep the local generation in lockstep with the server's post-bump value
      // so a subsequent rotate signs under the correct CURRENT + 1. Fall back to
      // our predicted rotateGen if the server response omits it.
      contentKeyGeneration: put.data.content_key_generation ?? rotateGen,
    },
  };
}

/** How many times a note's key change is made when the server answers that the
 *  note changed since it was read: the first, and twice more. */
export const CHANGED_ELSEWHERE_ATTEMPTS = 3;

export async function rotateContentKey(
  noteId: string,
  removeShareIds: string[] = [],
  reason?: RevokeReason,
  /** For a caller that removed someone BEFORE this call (a delete-only
   *  revoke): the attachment rows it listed before that removal, or null if
   *  that listing failed. Absent → this lists them itself, before rotating. */
  opts: { attachmentsListedBefore?: readonly AttachmentRow[] | null } = {},
): Promise<{
  rotated: boolean;
  remainingCount: number;
  reWrapFailures: string[];
  revokedShareLink: boolean;
  couldNotSign?: boolean;
  notOpenHere?: boolean;
  changedElsewhere?: boolean;
  refused?: boolean;
}> {
  const note = notesStore.notes().find(n => n.id === noteId);
  if (!note) return NOT_ROTATED;

  // The attachments the re-key below may bring forward are the ones there
  // BEFORE the removal: anything the server lists after it could come from
  // the person just removed, sealed under the key they still hold. For the
  // callers that pass the rows they remove, rotate-shares IS the removal, so
  // list first. Null (the list couldn't be read) brings nothing forward;
  // nothing is ever listed after the removal instead.
  const listedBefore = opts.attachmentsListedBefore !== undefined
    ? opts.attachmentsListedBefore
    : await listAttachmentsForRekey(noteId);

  const atVersion = (version: number) => rotateItemContentKey(
    {
      itemId: noteId,
      wrappedContentKey: note.wrappedContentKey,
      wrappedContentKeyNonce: note.wrappedContentKeyNonce,
      version,
      contentKeyGeneration: note.contentKeyGeneration,
    },
    removeShareIds,
    { retainOldKey: true, reason },
  );
  let triedAt = note.version;
  let result = await atVersion(note.version);
  // Changed elsewhere since it was read (409: an edit, or a change to its
  // sharing): tried again by itself, from the version the server has now,
  // before anything is said. Only the version is the server's: the key
  // stays this device's, so a key changed elsewhere does not open here,
  // and says so.
  for (let attempt = 1; attempt < CHANGED_ELSEWHERE_ATTEMPTS && result.changedElsewhere; attempt++) {
    const now = await askTwice(() => apiRequest<{ version?: number }>(`/api/v1/items/${noteId}`));
    if (!now.success || typeof now.data?.version !== 'number') {
      // Not read again: the words say why it stops here, not what came before
      // it. No answer is the connection; an answer that refuses, or makes no
      // sense, is not.
      const { changedElsewhere: _before, ...rest } = result;
      result = { ...rest, ...(now.success || refusedByServer(now) ? { refused: true } : {}) };
      break;
    }
    triedAt = now.data.version;
    result = await atVersion(now.data.version);
  }
  if (!result.applied) return result;

  // Mirror the rotated wrap into the local notes signal so subsequent
  // edits reuse the new key rather than generating yet another rotation.
  const rewrapped = {
    wrappedContentKey: result.applied.wrappedForVault.wrappedKey,
    wrappedContentKeyNonce: result.applied.wrappedForVault.nonce,
    contentKeyGeneration: result.applied.contentKeyGeneration,
  };
  if (triedAt === note.version) {
    notesStore.applyLocalPatch({ ...note, ...rewrapped, version: result.applied.version, updatedAt: new Date().toISOString() });
  } else {
    // Applied at a version this page had not read: someone changed the note
    // since. The server re-encrypted ITS words, so the note is taken as the
    // server has it now. The card's own words at the new version would be the
    // words from before that change, and the next save from here would be
    // accepted over it, with no conflict copy. Not read just now: the card
    // keeps its own version, so its next save meets the 409 and the conflict
    // path takes the server's words; only the key moves, for the writes after
    // that.
    if (!(await notesStore.adoptServerRow(noteId))) notesStore.applyLocalPatch({ ...note, ...rewrapped });
  }

  // Forward secrecy for ATTACHMENTS. rotate-shares re-encrypted the note BODY
  // under newKey, but the attachment blobs in R2 are still sealed under oldKey.
  // Re-encrypt the ones listed before the removal under the new content key +
  // swap each (PUT /attachments/{id}) so survivors decrypt them under the
  // current key. Best-effort: the body rotation (the security-critical part)
  // already committed, so a failure here must NOT fail the rotation. Bounded
  // (see rekeyNoteAttachments).
  if (listedBefore && listedBefore.length > 0 && result.applied.oldKey) {
    try {
      await rekeyNoteAttachments(noteId, listedBefore, result.applied.oldKey, result.applied.newKey);
    } catch (e) {
      console.warn('[note] attachment re-key after rotation failed (best-effort):', e);
    }
  }

  return result;
}

/**
 * Rotate a NOTEBOOK's content key, cutting off the given share rows.
 *
 * The notebook object carries the collection's name and its roster — the list
 * every member reads to seal a new note to everyone. Someone removed from a
 * notebook holds the key that opens all of that, so leaving it un-rotated
 * means every later roster update is written under a key they have. They can
 * no longer FETCH it, which is what actually stops them; this is the
 * defence-in-depth behind that.
 *
 * `remove_share_ids` is handed to the same atomic endpoint the notes use, so
 * the revoke and the re-key land in one transaction rather than leaving a
 * window where one has happened and the other has not.
 */
export async function rotateNotebookContentKey(
  notebookId: string,
  removeShareIds: string[] = [],
  reason?: RevokeReason,
): Promise<RotationResult> {
  const wrap = notebooksStore.notebookWrap(notebookId);
  const version = notebooksStore.notebookVersion(notebookId);
  if (!wrap || !version) return NOT_ROTATED;

  const result = await rotateItemContentKey(
    {
      itemId: notebookId,
      wrappedContentKey: wrap.key,
      wrappedContentKeyNonce: wrap.nonce,
      version,
      // Notebooks keep no local generation; the server's own value is read
      // inside the rotation.
      contentKeyGeneration: null,
    },
    removeShareIds,
    // A notebook has no attachments, so there is nothing for a retained key to
    // rescue.
    { retainOldKey: false, reason },
  );
  if (!result.applied) return result;

  // Adopt the new wrap and version, or the next write to this notebook signs
  // under a stale generation and PUTs against a stale version.
  notebooksStore.adoptRotatedNotebookKey(notebookId, {
    wrappedKey: result.applied.wrappedForVault.wrappedKey,
    nonce: result.applied.wrappedForVault.nonce,
    version: result.applied.version,
  });
  return result;
}

/**
 * Rebuild a notebook record that no key here opens (lib/notebookRepair
 * `rebuild`): recreated on the person's behalf with all the same attributes,
 * notes and shares. In place: the same id, so its notes and every reader's
 * acceptance stay; the name it has in the owner's list; and its people as
 * the server's share rows hold them now, each one who holds the notebook's
 * key now given the new one, through the same send gate and signatures as
 * any rotation, in one rotate-shares transaction.
 *
 * Who is on the new record: everyone with a row on the notebook item that
 * carries a key (one without is an invitation not finished yet, and is finished
 * by its own road) and whose directory key the send gate takes. Their right is
 * read as `standingListFromServer` reads it: `contribute` from the notebook's
 * own row, else `edit` only if every note row of theirs in the notebook says
 * edit, a failed read reading as none. `childNoteIds`: every note of the
 * account's in the notebook, the locked ones included (`notebookNoteIds`).
 *
 * The caller keeps the old record first (`notebooksStore.carryRecord`).
 */
export async function rebuildNotebookRecord(
  notebookId: string,
  name: string,
  version: number,
  childNoteIds: readonly string[],
  opts: {
    /**
     * The owner asked for it (the Share panel's repair). Otherwise (the repair
     * after a load) a notebook anyone else holds is not rebuilt at all: who
     * holds it is the server's word.
     */
    attended: boolean;
  },
): Promise<RotationResult> {
  interface Row { id: string; recipient_email: string; permission: string; has_wrap?: boolean }
  const rowsRes = await apiRequest<Row[]>(`/api/v1/items/${notebookId}/shares`);
  if (!rowsRes.success || !Array.isArray(rowsRes.data)) return NOT_ROTATED;
  const allHolders = rowsRes.data.filter(r => r && typeof r.recipient_email === 'string' && r.has_wrap !== false);
  if (!opts.attended && allHolders.length > 0) {
    return { ...NOT_ROTATED, remainingCount: allHolders.length, reWrapFailures: allHolders.map(r => r.recipient_email) };
  }
  // Its people come from the OWNER's own list of whom it is shared with (the
  // standing list, written by the owner under their own key), and only those
  // of them who hold its key now: never from the server's rows alone. A row
  // for anyone else is left as it is (its old key opens nothing after this),
  // shown in the panel to be shared with again.
  const ownList = new Set(notebooksStore.getNotebookShares(notebookId).map(r => r.email.toLowerCase()));
  const holders = allHolders.filter(r => ownList.has(r.recipient_email.toLowerCase()));

  // Each holder's note rights in this notebook. A read that fails is asked
  // again; still failing, nothing is rebuilt now: read as no rights, every
  // editor would be written into the record as a reader for good.
  const childRights = new Map<string, string[]>();
  if (holders.some(r => r.permission !== 'contribute')) {
    for (const childId of childNoteIds) {
      const res = await askTwice(() => apiRequest<Row[]>(`/api/v1/items/${childId}/shares`));
      if (!res.success || !Array.isArray(res.data)) return NOT_ROTATED;
      for (const row of res.data) {
        if (!row || typeof row.recipient_email !== 'string') continue;
        const address = row.recipient_email.toLowerCase();
        childRights.set(address, [...(childRights.get(address) ?? []), row.permission]);
      }
    }
  }

  const members: NotebookMember[] = [];
  if (holders.length > 0) {
    const lookup = await apiRequest<{
      users: { email: string; user_id: string | null; sharing_public_key: string | null; signing_public_key: string | null }[];
    }>('/api/v1/users/public-keys', { method: 'POST', body: { emails: holders.map(r => r.recipient_email) } });
    if (!lookup.success) return NOT_ROTATED;
    const byAddress = new Map(lookup.data.users.map(u => [String(u.email).toLowerCase(), u]));
    const seen = new Set<string>();
    for (const row of holders) {
      const address = row.recipient_email.toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      const u = byAddress.get(address);
      if (!u?.user_id || !u.sharing_public_key) continue;
      // The same gate the rotation below seals through: nobody is put on the
      // record who will not be given its key.
      if (!allowSealToRecipient(u.user_id, u.signing_public_key, u.sharing_public_key)) continue;
      const rights = holders.filter(r => r.recipient_email.toLowerCase() === address).map(r => r.permission);
      const objectRight = rights.length > 0 && rights.every(p => p === 'contribute') ? 'contribute' : 'view';
      const notes = childRights.get(address);
      const childRight = notes && notes.length > 0 && notes.every(p => p === 'edit') ? 'edit' : 'view';
      members.push({
        userId: u.user_id,
        email: row.recipient_email,
        sharingPublicKey: u.sharing_public_key,
        signingPublicKey: u.signing_public_key,
        permission: notebookGrantFrom(objectRight, childRight),
      });
    }
  }

  const content = notebookItemContent(name, members) as unknown as Record<string, unknown>;
  const result = await rotateItemContentKey(
    { itemId: notebookId, wrappedContentKey: null, wrappedContentKeyNonce: null, version, contentKeyGeneration: null },
    [],
    {
      retainOldKey: false,
      rebuiltContent: JSON.stringify(content),
      unattended: !opts.attended,
      // The new key goes to the people written into the record, and to nobody else.
      sealOnlyTo: new Set(members.map(m => m.email.toLowerCase())),
    },
  );
  if (!result.applied) return result;
  notebooksStore.adoptRebuiltRecord(notebookId, {
    wrappedKey: result.applied.wrappedForVault.wrappedKey,
    nonce: result.applied.wrappedForVault.nonce,
    version: result.applied.version,
    members,
    content,
  });
  return result;
}

/**
 * How many hold an item's key besides its owner (rows that carry a key), or
 * null when the list could not be read.
 */
export async function holdersOf(itemId: string): Promise<number | null> {
  const r = await askTwice(() => apiRequest<{ recipient_email?: unknown; has_wrap?: boolean }[]>(`/api/v1/items/${itemId}/shares`));
  if (!r.success || !Array.isArray(r.data)) return null;
  return r.data.filter(row => row && typeof row.recipient_email === 'string' && row.has_wrap !== false).length;
}

/**
 * Re-save a note that no key here opens from the copy this browser kept
 * (lib/noteRescue). The same rotation as any other, given the content (what a
 * save writes, lib/noteDocument, in `notebookId`) instead of reading it: a new
 * key wrapped under this identity's vault, the people the note is shared with
 * given it through the send gate and signed, at the copy's version (the
 * server refuses it if the note moved on since). Unattended: nobody is left
 * without the new key by a failure here. The caller takes the new wrap on,
 * and keeps the old one first when the note has attachments.
 */
export async function rescueNoteFromCopy(copy: NoteItem, notebookId: string | null): Promise<RotationResult> {
  return rotateItemContentKey(
    { itemId: copy.id, wrappedContentKey: null, wrappedContentKeyNonce: null, version: copy.version, contentKeyGeneration: null },
    [],
    { retainOldKey: false, rebuiltContent: JSON.stringify(noteDocument(copy, { notebookId })), unattended: true },
  );
}

/** Delete the share row for (noteId, email) if one exists. */
export async function unshareNoteWithRecipient(
  noteId: string,
  email: string,
): Promise<boolean> {
  interface ShareRow { id: string; recipient_email: string }
  const r = await apiRequest<ShareRow[]>(`/api/v1/items/${noteId}/shares`);
  if (!r.success || !Array.isArray(r.data)) return false;
  const emailLc = email.toLowerCase();
  const target = r.data.find(s => s.recipient_email.toLowerCase() === emailLc);
  if (!target) return true; // nothing to do
  const del = await apiRequest(`/api/v1/shares/${target.id}`, { method: 'DELETE' });
  return del.success;
}
