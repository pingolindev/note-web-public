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
 * Base64 for LARGE payloads — note ciphertext, backup containers, shell save
 * blobs. Not for key material: keys are 32 bytes, where the difference is
 * unmeasurable and sodium's constant-time decoder is the conservative choice.
 *
 * ⚠️ Base64 can cost MORE than the cipher. Benchmarked on a 7MB note:
 * `sodium.from_base64` 43ms against 16ms for the XChaCha20-Poly1305 decrypt
 * itself — 70% of "decryption is slow" is not the decryption. The encode
 * side has the same shape, and every autosave pays it.
 *
 * Tier order is DIRECTION-SPECIFIC, from a 7MB benchmark (node 24 / V8, and
 * the same relative shape reproduced in Chromium):
 *
 *   decode:  native `Uint8Array.fromBase64` (SIMD-class, ~GB/s)
 *            → `atob` + charCode loop (13ms — 3.3x faster than sodium)
 *            → sodium WASM (43ms — compiled WITHOUT SIMD)
 *
 *   encode:  native `Uint8Array.prototype.toBase64` (~2ms class)
 *            → sodium WASM (29–43ms)
 *            → `btoa` over a TextDecoder('latin1') binary string (41ms)
 *
 * The obvious-looking chunked `String.fromCharCode` + `btoa` ENCODE loop is
 * a trap: 288ms at 7MB — 8x SLOWER than sodium — because it builds a 9.3MB
 * rope string by concatenation. Do not use it.
 *
 * Every browser we target (current Chromium WebViews, Safari/WebKit 18.2+,
 * Firefox 133+) has the native codec, so the fallback tiers exist for old
 * engines, where they keep the plain-codec speed rather than improving it.
 *
 * NO security implication: base64 is a transport encoding, and the AEAD tag
 * authenticates the same bytes however they were decoded. Malformed input
 * throws in every tier, and all outputs are standard padded base64 —
 * byte-identical to sodium's `base64_variants.ORIGINAL`.
 */

type NativeDecoder = { fromBase64?: (s: string) => Uint8Array };
type NativeEncoder = { toBase64?: () => string };

export function fromB64Fast(
  b64: string,
  sodiumFallback?: (s: string) => Uint8Array,
): Uint8Array {
  const native = (Uint8Array as unknown as NativeDecoder).fromBase64;
  if (native) return native(b64);
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (sodiumFallback) return sodiumFallback(b64);
  throw new Error('No base64 decoder available');
}

export function toB64Fast(
  bytes: Uint8Array,
  sodiumFallback?: (b: Uint8Array) => string,
): string {
  const native = (bytes as unknown as NativeEncoder).toBase64;
  if (native) return native.call(bytes);
  if (sodiumFallback) return sodiumFallback(bytes);
  if (typeof btoa === 'function') {
    // Single native latin1 pass, then btoa — the only non-native encode
    // that is not slower than sodium (see the header table).
    return btoa(new TextDecoder('latin1').decode(bytes));
  }
  throw new Error('No base64 encoder available');
}
