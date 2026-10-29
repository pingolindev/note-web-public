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
 * Every operation that needs a PRIVATE key, behind one door.
 *
 * In a browser and in the Android shell the page holds its own keys and these
 * run locally. In the iOS shell (lib/keyBridge.ts) the page holds only the
 * vault key and the two public keys, and these go over the native bridge,
 * which answers with results and never with a key (the long-term X25519 key
 * also opens every Track circle-key wrap, so it must not be handed to
 * server-delivered JavaScript).
 *
 * All three are async because the bridge is. Callers keep their policies:
 * a wrap that cannot be signed is not sent, a wrap that does not open is
 * skipped — and a bridge that fails outright is "try again later".
 */
import {
  unwrapContentKeyFromSender,
  signNoteShareWrap,
  ensureSigningKey,
  hasSigningKey,
  type NoteShareWrapParams,
} from './crypto';
import { bridgeMarker, callKeyBridge } from './keyBridge';

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Standard padded base64 → bytes, without depending on libsodium being ready
 *  (the bridge replies can arrive before any local crypto has been needed). */
function fromBase64(value: string): Uint8Array | null {
  if (!B64.test(value)) return null;
  try {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Open share wraps addressed to this user (crypto_box_seal_open). One result
 * per wrap, in order: the 32-byte content key, or null for a wrap that does
 * not open. THROWS when the bridge itself fails, so the caller can leave the
 * inbox as it was for the next sync instead of marking shares unreadable.
 */
export async function openSealedKeys(
  sealedB64: string[],
  onReply: () => void = () => {},
): Promise<(Uint8Array | null)[]> {
  if (!bridgeMarker()) return sealedB64.map(s => unwrapContentKeyFromSender(s));
  // `onReply` at EVERY answer of the bridge, not once at the end. In the iOS
  // shell this is one message per wrap, each answered on the app's main
  // thread after two reads of the Keychain: for an inbox of thousands of rows
  // the whole batch can take longer than the minute a sync may be quiet
  // (lib/oneAtATime), and the sync would be given up on, again and again,
  // each new one queueing its own batch behind the last.
  const replies = await Promise.all(sealedB64.map(async (sealed) => {
    const reply = await callKeyBridge<{ key?: string | null }>({ op: 'openSealedKey', sealed });
    try { onReply(); } catch { /* the caller's bookkeeping never fails an open */ }
    return reply;
  }));
  return replies.map(r => {
    const key = typeof r?.key === 'string' ? fromBase64(r.key) : null;
    return key && key.length === 32 ? key : null;
  });
}

/** Can this session sign a share wrap right now? In a browser this may install
 *  the legacy X25519-derived key (ensureSigningKey); in the bridge shell it is
 *  the shell's word, and never that shortcut. */
export function canSign(): boolean {
  return bridgeMarker() ? hasSigningKey() : ensureSigningKey();
}

/**
 * Ed25519-sign a note share-invite wrap: 128 lowercase hex chars. THROWS when
 * signing is unavailable or the bridge fails — callers already refuse to send
 * a share they could not sign.
 */
export async function signShareWrap(params: NoteShareWrapParams): Promise<string> {
  if (!bridgeMarker()) return signNoteShareWrap(params);
  const reply = await callKeyBridge<{ signature?: string }>({
    op: 'signShareWrap',
    senderUserId: params.senderUserId,
    recipientUserId: params.recipientUserId,
    itemId: params.itemId,
    contentKeyVersion: params.contentKeyVersion >>> 0,
    wrappedKey: params.wrappedKeyBase64,
  });
  const sig = reply?.signature;
  if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) {
    throw new Error('key bridge returned no valid signature');
  }
  return sig;
}

/**
 * The vault keys of identities from before a password reset, from the bridge
 * shell. Null outside it — the page derives them itself there
 * (lib/previousIdentities.ts). Never throws: like loadPreviousIdentities, a
 * failure only means older notes stay locked.
 */
/** The shell did not answer: the call failed. Not "nothing was recovered". */
export type BridgeNoAnswer = 'no-answer';

export async function bridgePreviousVaultKeys(): Promise<Uint8Array[] | null | BridgeNoAnswer> {
  if (!bridgeMarker()) return null;
  try {
    const reply = await callKeyBridge<{ keys?: unknown }>({ op: 'previousVaultKeys' });
    const keys = Array.isArray(reply?.keys) ? reply.keys : [];
    return keys
      .map(k => (typeof k === 'string' ? fromBase64(k) : null))
      .filter((k): k is Uint8Array => !!k && k.length === 32);
  } catch {
    // One failed call is no answer. Read as "none", it would mark the session
    // answered, and the notebook rebuild and the note rescue would go ahead on
    // keys the recovered ones would have opened.
    return 'no-answer';
  }
}
