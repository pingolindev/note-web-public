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

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  initCrypto, setVaultKey, setPreviousVaultKeys, encryptNote, decryptNote,
  decryptNoteWithRecoveredVault, vaultKeyThatOpens, wrapContentKeyWithVault, generateContentKey,
} from './crypto';

/**
 * The two read-only helpers the repairs after a password reset stand on
 * (lib/notebookRepair), with real keys: one for this identity, one
 * recovered from before a reset, and one this page does not hold.
 */

const CURRENT = new Uint8Array(32).fill(0x11);
const RECOVERED = new Uint8Array(32).fill(0x22);
const STRANGER = new Uint8Array(32).fill(0x33);
/** Copies are handed over: replacing the held recovered keys zeroes them, as it should. */
const held = (...keys: Uint8Array[]) => setPreviousVaultKeys(keys.map(k => k.slice()));

/** Something sealed under `key` as the list is (`encryptNote`), the current key put back after. */
function sealedUnder(key: Uint8Array, text: string) {
  setVaultKey(key);
  const sealed = encryptNote(text);
  setVaultKey(CURRENT);
  return sealed;
}

/** A content key wrapped under `key` as a notebook's is. */
function wrapUnder(key: Uint8Array) {
  setVaultKey(key);
  const wrap = wrapContentKeyWithVault(generateContentKey());
  setVaultKey(CURRENT);
  return wrap;
}

beforeAll(async () => { await initCrypto(); });
beforeEach(() => {
  setVaultKey(CURRENT);
  held(RECOVERED);
});

describe('opening the list with a key recovered from before a reset', () => {
  it('opens what a recovered key sealed, which this identity\'s key does not', () => {
    const old = sealedUnder(RECOVERED, '{"notebooks":[{"id":"x","name":"Then"}]}');
    expect(() => decryptNote(old)).toThrow();
    expect(decryptNoteWithRecoveredVault(old)).toBe('{"notebooks":[{"id":"x","name":"Then"}]}');
  });

  it('does not try this identity\'s key: that is decryptNote\'s, and is tried first by every caller', () => {
    const now = sealedUnder(CURRENT, 'now');
    expect(decryptNote(now)).toBe('now');
    expect(decryptNoteWithRecoveredVault(now)).toBeNull();
  });

  it('opens nothing sealed under a key this page does not hold, and nothing once none is recovered', () => {
    expect(decryptNoteWithRecoveredVault(sealedUnder(STRANGER, 'x'))).toBeNull();
    const old = sealedUnder(RECOVERED, 'then');
    held();
    expect(decryptNoteWithRecoveredVault(old)).toBeNull();
  });

  it('tries every recovered key, in turn', () => {
    held(STRANGER, RECOVERED);
    expect(decryptNoteWithRecoveredVault(sealedUnder(RECOVERED, 'second'))).toBe('second');
  });
});

describe('which vault key opens a notebook\'s key', () => {
  it('this identity\'s, one recovered from before a reset, or none', () => {
    const now = wrapUnder(CURRENT);
    const then = wrapUnder(RECOVERED);
    const neither = wrapUnder(STRANGER);
    expect(vaultKeyThatOpens(now.wrappedKey, now.nonce)).toBe('current');
    expect(vaultKeyThatOpens(then.wrappedKey, then.nonce)).toBe('recovered');
    expect(vaultKeyThatOpens(neither.wrappedKey, neither.nonce)).toBeNull();
  });

  it('this identity\'s first, when both would', () => {
    held(CURRENT);
    const now = wrapUnder(CURRENT);
    expect(vaultKeyThatOpens(now.wrappedKey, now.nonce)).toBe('current');
  });

  it('none for what is not a wrap at all', () => {
    expect(vaultKeyThatOpens('not base64 !!', 'nope')).toBeNull();
    const now = wrapUnder(CURRENT);
    expect(vaultKeyThatOpens(now.wrappedKey, wrapUnder(CURRENT).nonce)).toBeNull();
  });
});
