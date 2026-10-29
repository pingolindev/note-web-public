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

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import sodiumInit from 'libsodium-wrappers-sumo';

/**
 * Reading notes from before a password reset.
 *
 * note's vault key is derived from the account keypair, so a reset changes it
 * and EVERY note stops opening at once — an account full of notes it cannot
 * read, with all the ciphertext intact. These cover the fallback, and the two
 * ways it could itself go wrong: preferring a superseded key, or letting a
 * derived key cross between apps.
 */

let sodium: typeof import('libsodium-wrappers-sumo');

beforeAll(async () => {
  await sodiumInit.ready;
  sodium = sodiumInit as unknown as typeof import('libsodium-wrappers-sumo');
});

/** Seal a recovered key the way the account portal seals it for the apps. */
function sealForApps(recoveredPriv: Uint8Array, currentPriv: Uint8Array) {
  const wrap = sodium.crypto_generichash(
    32, currentPriv, sodium.from_string('pingolin.previous-identity'));
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(recoveredPriv, nonce, wrap);
  return {
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: sodium.to_base64(ciphertext, sodium.base64_variants.ORIGINAL),
  };
}

/** A content key wrapped under the vault key of a given identity. */
function wrapUnderVaultOf(privateKey: Uint8Array, contentKey: Uint8Array) {
  const vault = sodium.crypto_generichash(32, privateKey, sodium.from_string('pingolin-note-vault'));
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const wrapped = sodium.crypto_secretbox_easy(contentKey, nonce, vault);
  return {
    wrappedKey: sodium.to_base64(wrapped, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}

describe('opening a note from before a password reset', () => {
  let crypto: typeof import('./crypto');

  beforeEach(async () => {
    vi.resetModules();
    crypto = await import('./crypto');
    await crypto.initCrypto();
  });

  it('unwraps a content key sealed under the OLD vault key', async () => {
    const oldIdentity = sodium.crypto_box_keypair();
    const newIdentity = sodium.crypto_box_keypair();
    const contentKey = sodium.randombytes_buf(32);
    const note = wrapUnderVaultOf(oldIdentity.privateKey, contentKey);

    crypto.setVaultKey(
      sodium.crypto_generichash(32, newIdentity.privateKey, sodium.from_string('pingolin-note-vault')));

    // Without the earlier identity, every older note reads as
    // undecryptable.
    expect(crypto.unwrapContentKeyWithVault(note.wrappedKey, note.nonce)).toBeNull();

    crypto.setPreviousIdentityKeys([oldIdentity.privateKey]);
    const opened = crypto.unwrapContentKeyWithVault(note.wrappedKey, note.nonce);
    expect(opened).not.toBeNull();
    expect(sodium.to_hex(opened!)).toBe(sodium.to_hex(contentKey));
  });

  it('uses the CURRENT vault key when it works', async () => {
    const oldIdentity = sodium.crypto_box_keypair();
    const newIdentity = sodium.crypto_box_keypair();
    const contentKey = sodium.randombytes_buf(32);

    crypto.setVaultKey(
      sodium.crypto_generichash(32, newIdentity.privateKey, sodium.from_string('pingolin-note-vault')));
    crypto.setPreviousIdentityKeys([oldIdentity.privateKey]);

    const note = wrapUnderVaultOf(newIdentity.privateKey, contentKey);
    const opened = crypto.unwrapContentKeyWithVault(note.wrappedKey, note.nonce);
    expect(sodium.to_hex(opened!)).toBe(sodium.to_hex(contentKey));
  });

  it('still returns null when no identity opens it', async () => {
    // A wrong recovered key must not turn "unreadable" into a wrong key that
    // then fails deeper in, somewhere with a worse error.
    const strangerIdentity = sodium.crypto_box_keypair();
    const newIdentity = sodium.crypto_box_keypair();
    const note = wrapUnderVaultOf(sodium.crypto_box_keypair().privateKey, sodium.randombytes_buf(32));

    crypto.setVaultKey(
      sodium.crypto_generichash(32, newIdentity.privateKey, sodium.from_string('pingolin-note-vault')));
    crypto.setPreviousIdentityKeys([strangerIdentity.privateKey]);

    expect(crypto.unwrapContentKeyWithVault(note.wrappedKey, note.nonce)).toBeNull();
  });

  it('opens the portal seal, and only under its own label', async () => {
    const current = sodium.crypto_box_keypair();
    const recovered = sodium.crypto_box_keypair();
    const sealed = sealForApps(recovered.privateKey, current.privateKey);

    const wrap = crypto.deriveAppKey(current.privateKey, crypto.PREVIOUS_IDENTITY_LABEL);
    expect(sodium.to_hex(crypto.decryptWithKey(sealed, wrap)))
      .toBe(sodium.to_hex(recovered.privateKey));

    // The vault label uses the same construction on the same input. If it also
    // opened this, one derived key would stand in for another.
    const vaultLabelled = crypto.deriveAppKey(current.privateKey, crypto.VAULT_LABEL);
    expect(() => crypto.decryptWithKey(sealed, vaultLabelled)).toThrow();
  });
});
