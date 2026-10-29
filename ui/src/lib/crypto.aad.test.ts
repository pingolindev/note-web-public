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
import { noteContentAadV2, initCrypto, decryptWithContentKey } from './crypto';

// Cross-language guard: locked on the Rust side in the mobile SDK's
// note-collab-sdk (aad_matches_cross_language_vector). A break means v2 notes
// written by the web editor are undecryptable in the Android app — silent
// data loss.
const hex = (u8: Uint8Array) => Buffer.from(u8).toString('hex');

describe('note-content AAD v2 cross-language parity (note-collab-sdk vectors)', () => {
  it('item-1', () =>
    expect(hex(noteContentAadV2('item-1')))
      .toBe('a40b78faec114481be36d3929dd9bebc1f521b66feb6d67291a2a2417813f207'));
  it('empty', () =>
    expect(hex(noteContentAadV2('')))
      .toBe('cebee88dbd30651ea49ab04b835f81074591e3ef3fbe1fc841c694e1b96de1a1'));
  it('utf8+emoji', () =>
    expect(hex(noteContentAadV2('note-🔥-ünïcode')))
      .toBe('457e61491ac7dc8f9e658a557ebf00b0f1129af3ffce04137fcede8ae99076ba'));
});

// SEMANTIC interop: the AAD-parity tests above prove the AAD *input* matches;
// this proves the full v2 encrypt path (AAD wired into XChaCha20-Poly1305 +
// nonce||ct framing + base64) is byte-compatible, so a v2 note actually decrypts
// across platforms. This is the guard against web-written notes being
// undecryptable on the mobile SDK.
//
// Vector locked in note-collab-sdk `cross_language_v2_ciphertext_vector`:
// key = 32×0x2a, nonce = 24×0x07, item_id = "item-A".
describe('note-content v2 SEMANTIC interop (note-collab-sdk ↔ note-web)', () => {
  beforeAll(async () => { await initCrypto(); });

  const KEY = new Uint8Array(32).fill(0x2a);
  const NONCE_B64 = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH';
  const CT_B64 = 's4U7w5J5wVGIsFfH5UDugg7dbhIQX00xazjSx4T0iNZKNIzKFpoE';

  it('decrypts a Rust-written v2 ciphertext under the correct item_id', () => {
    expect(decryptWithContentKey({ nonce: NONCE_B64, ciphertext: CT_B64 }, KEY, 'item-A'))
      .toBe('pingolin aad-v2 interop');
  });

  it('rejects a relocated ciphertext (wrong item_id)', () => {
    expect(decryptWithContentKey({ nonce: NONCE_B64, ciphertext: CT_B64 }, KEY, 'item-B'))
      .toBeNull();
  });
});
