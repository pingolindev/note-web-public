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
import {
  initCrypto,
  importSigningPrivateKey,
  getSigningPublicKeyHex,
  signNoteShareWrap,
  verifyNoteShareWrap,
  verifyNoteShareWrapGen,
  type NoteShareWrapParams,
} from './crypto';

// Verify-both — mirrored from the mobile SDK's note-collab-sdk
// `note_share_wrap_verify_both_tests`. The wrap sig binds content_key_version
// (u32_le), and older signers hardcode 0; a verifier that passes the REAL
// version must accept BOTH a legacy-0 sig AND a sig signed under the real
// version, so signers of either kind keep verifying.
// The fallback is NOT a blanket accept: only the passed version and legacy 0 are
// honored, so a server can't downgrade to an arbitrary non-zero version.
describe('note share-wrap verify-both (real-or-legacy content_key_version)', () => {
  beforeAll(async () => { await initCrypto(); });

  const SENDER = '11111111-1111-1111-1111-111111111111';
  const RECIPIENT = '22222222-2222-2222-2222-222222222222';
  const ITEM = '33333333-3333-3333-3333-333333333333';
  // wrapped_key: 80 bytes of 0x11, base64 — same shape as the SDK vector. Only
  // needs to be consistent between sign and verify (in-process round-trip).
  const WRAPPED_KEY_B64 = btoa(String.fromCharCode(...new Array(80).fill(0x11)));

  const params = (version: number): NoteShareWrapParams => ({
    senderUserId: SENDER,
    recipientUserId: RECIPIENT,
    itemId: ITEM,
    contentKeyVersion: version,
    wrappedKeyBase64: WRAPPED_KEY_B64,
  });

  // Load a deterministic Ed25519 signing keypair from a 32-byte seed and return
  // its verifying-key hex (what the pin stores and the verifier is handed).
  function loadKeypair(): string {
    const seed = new Uint8Array(32).fill(0x2a);
    let raw = '';
    for (const b of seed) raw += String.fromCharCode(b);
    importSigningPrivateKey(btoa(raw));
    const pub = getSigningPublicKeyHex();
    if (!pub) throw new Error('no signing pubkey loaded');
    return pub;
  }

  it('a real-version verifier accepts both a legacy-0 sig and a real-version sig', () => {
    const pub = loadKeypair();

    // Legacy signer signs under version 0 (the hardcoded value).
    const legacySig = signNoteShareWrap(params(0));
    // Verifier passes the REAL version 5 → passed-version check fails, the
    // version-0 fallback succeeds.
    expect(verifyNoteShareWrap(pub, legacySig, params(5))).toBe(true);

    // A current signer signs under the real version 5.
    const realSig = signNoteShareWrap(params(5));
    // Verifier passes version 5 → passed-version check succeeds directly.
    expect(verifyNoteShareWrap(pub, realSig, params(5))).toBe(true);

    // Unchanged legacy path: a version-0 sig verified with a version-0 verifier
    // still passes on the first check (no fallback needed).
    expect(verifyNoteShareWrap(pub, legacySig, params(0))).toBe(true);
  });

  it('keeps the pin its teeth: a non-zero version mismatch (neither passed nor 0) is rejected', () => {
    const pub = loadKeypair();
    // Sig over version 5, verified with passed version 7 → matches neither 7 nor
    // 0 → rejected. A server can't downgrade to an arbitrary non-zero version.
    const sig5 = signNoteShareWrap(params(5));
    expect(verifyNoteShareWrap(pub, sig5, params(7))).toBe(false);
  });

  // The reader's rollback floor keys on the generation the sig
  // ACTUALLY verified under (verifyNoteShareWrapGen.effectiveGeneration), not
  // the server-claimed one. Mirrors the SDK anti-laundering test.
  it('reports the verified generation, not the claimed one (anti-laundering)', () => {
    const pub = loadKeypair();

    // Real gen-5 sig verified with 5 → effective 5.
    const realSig = signNoteShareWrap(params(5));
    expect(verifyNoteShareWrapGen(pub, realSig, params(5)))
      .toEqual({ verified: true, effectiveGeneration: 5 });

    // Legacy gen-0 sig, server CLAIMS gen 99 → verifies via fallback but reports
    // effectiveGeneration 0 (not 99), so it can't launder past a highest-seen floor.
    const legacySig = signNoteShareWrap(params(0));
    expect(verifyNoteShareWrapGen(pub, legacySig, params(99)))
      .toEqual({ verified: true, effectiveGeneration: 0 });

    // A sig that verifies under neither the claimed version nor 0 → { false, 0 }.
    const sig5 = signNoteShareWrap(params(5));
    expect(verifyNoteShareWrapGen(pub, sig5, params(7)))
      .toEqual({ verified: false, effectiveGeneration: 0 });
  });
});
