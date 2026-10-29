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
 * ERASURE RECEIPT v1: the auth server's signed word that an account is gone,
 * which the web editor's /forget-account route checks before it deletes that
 * account's data from this browser.
 *
 * The auth server signs, with a key used for nothing else, the context string
 * "pingolin.erasure_receipt.v1\n" followed by the exact payload
 *
 *   {"v":1,"purpose":"pingolin.erasure_receipt","sub":<canonical id>,
 *    "aud":["track-web","note-web"],"iat":<s>,"exp":<s>,"jti":<32 hex>}
 *
 * and the portal carries base64url(payload) "." base64url(signature) in the
 * URL fragment only. Every rule below is checked before anything is deleted,
 * and any failure deletes nothing. The tests reproduce every case of the
 * shared vectors (testdata/erasure_receipt_v1.json).
 */
import type sodiumModule from 'libsodium-wrappers';

type Sodium = typeof sodiumModule;

export const RECEIPT_CONTEXT = 'pingolin.erasure_receipt.v1\n';
/** This app's name in the receipt's audience. */
export const RECEIPT_AUDIENCE = 'note-web';

const B64URL = /^[A-Za-z0-9_-]+$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JTI = /^[0-9a-f]{32}$/;
/** Exactly these members, no more and no fewer (sorted). */
const FIELDS = ['aud', 'exp', 'iat', 'jti', 'purpose', 'sub', 'v'];
/** A v1 receipt is about 350 characters. */
const MAX_RECEIPT_LENGTH = 2048;
/** How far ahead of this clock a receipt may have been issued. */
const MAX_CLOCK_AHEAD_SECS = 300;
/** The longest a receipt may live. */
const MAX_LIFETIME_SECS = 600;

export type ReceiptVerdict = { ok: true; sub: string } | { ok: false; refused: string };

const refuse = (refused: string): ReceiptVerdict => ({ ok: false, refused });

/** base64url without padding, or null. */
function b64url(sodium: Sodium, s: string): Uint8Array | null {
  if (!B64URL.test(s)) return null;
  try {
    return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    return null;
  }
}

/**
 * Check `receipt` against the verifying keys (this environment's [current,
 * previous], tried in turn) at `nowSecs`. Returns the canonical id of the
 * erased account, or why it was refused.
 */
export function verifyErasureReceipt(
  sodium: Sodium,
  receipt: string,
  publicKeys: readonly Uint8Array[],
  nowSecs: number,
): ReceiptVerdict {
  if (receipt.length > MAX_RECEIPT_LENGTH) return refuse('format: too long');
  const parts = receipt.split('.');
  if (parts.length !== 2) return refuse('format: two parts');
  const payload = b64url(sodium, parts[0]);
  const signature = b64url(sodium, parts[1]);
  if (!payload || !signature) return refuse('format: base64url, no padding');
  if (signature.length !== 64) return refuse('format: 64-byte signature');

  const context = sodium.from_string(RECEIPT_CONTEXT);
  const signed = new Uint8Array(context.length + payload.length);
  signed.set(context);
  signed.set(payload, context.length);
  // libsodium's verify is strict: it refuses a non-canonical S and a
  // small-order key.
  const signedByAKey = publicKeys.some((key) => {
    if (key.length !== 32) return false;
    try {
      return sodium.crypto_sign_verify_detached(signature, signed, key);
    } catch {
      return false;
    }
  });
  if (!signedByAKey) return refuse('signature');

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    return refuse('payload: JSON');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return refuse('payload: object');
  const c = claims as Record<string, unknown>;
  const keys = Object.keys(c).sort();
  if (keys.length !== FIELDS.length || keys.some((k, i) => k !== FIELDS[i])) return refuse('fields');
  if (c.v !== 1) return refuse('v');
  if (c.purpose !== 'pingolin.erasure_receipt') return refuse('purpose');
  if (!Array.isArray(c.aud) || !c.aud.every((a) => typeof a === 'string') || !c.aud.includes(RECEIPT_AUDIENCE)) {
    return refuse('aud');
  }
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return refuse('times: integers');
  const iat = c.iat as number;
  const exp = c.exp as number;
  if (!(iat <= nowSecs + MAX_CLOCK_AHEAD_SECS)) return refuse('times: issued ahead');
  if (!(nowSecs <= exp)) return refuse('times: expired');
  if (!(exp - iat <= MAX_LIFETIME_SECS)) return refuse('times: lifetime');
  if (exp < iat) return refuse('times: order');
  if (typeof c.sub !== 'string' || !CANONICAL_UUID.test(c.sub)) return refuse('sub');
  if (typeof c.jti !== 'string' || !JTI.test(c.jti)) return refuse('jti');
  return { ok: true, sub: c.sub };
}
