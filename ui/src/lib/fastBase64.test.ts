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

import { describe, it, expect, beforeAll } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { fromB64Fast, toB64Fast } from './fastBase64';

/**
 * The codec must be BYTE-IDENTICAL to sodium's base64_variants.ORIGINAL in
 * both directions — ciphertext written by one tier is read back by whichever
 * tier the next session's engine has, and by Android/iOS through the same
 * strings. Sizes cover the padding cases (0/1/2 mod 3) and a payload large
 * enough to cross the fallback tiers' chunking boundaries.
 */

let sodium: typeof _sodium;

const sodiumEncode = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
const sodiumDecode = (s: string) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

function deterministicBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 2654435761) & 0xff;
  return out;
}

beforeAll(async () => {
  await _sodium.ready;
  sodium = _sodium;
});

describe('fastBase64 matches sodium ORIGINAL exactly', () => {
  const sizes = [0, 1, 2, 3, 4, 31, 32, 33, 0x8000 - 1, 0x8000, 0x8000 + 1, 1_000_003];

  it.each(sizes)('encode(%i bytes) equals sodium.to_base64', (n) => {
    const data = deterministicBytes(n);
    expect(toB64Fast(data, sodiumEncode)).toBe(sodiumEncode(data));
  });

  it.each(sizes)('decode(%i bytes) round-trips and equals sodium.from_base64', (n) => {
    const data = deterministicBytes(n);
    const b64 = sodiumEncode(data);
    const viaFast = fromB64Fast(b64, sodiumDecode);
    const viaSodium = sodiumDecode(b64);
    expect(viaFast.length).toBe(n);
    expect(Buffer.from(viaFast).equals(Buffer.from(viaSodium))).toBe(true);
  });

  it('every byte value survives the round trip', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(fromB64Fast(toB64Fast(all, sodiumEncode), sodiumDecode))).toEqual(
      Array.from(all),
    );
  });

  it('malformed input throws instead of silently decoding', () => {
    // A tampered ciphertext string must fail loudly in whichever tier runs;
    // decryptWithContentKey catches and returns null, same as sodium's path.
    expect(() => fromB64Fast('@@not-base64@@', sodiumDecode)).toThrow();
  });
});
