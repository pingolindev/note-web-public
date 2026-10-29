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

import { describe, it, expect } from 'vitest';
import { allowSealToRecipient, approveUserKeyChange, getPinnedUserKeys } from './crypto';

// Send-side TOFU pin gate behind SharePanel + shareUtils. Before sealing a
// per-note content key to a directory-looked-up recipient key, callers consult
// allowSealToRecipient; a compromised server that substitutes a recipient's
// sharing key must NOT be able to make us seal the content key to it. The
// Android app applies the same rule.
//
// Runs sodium-free: approveUserKeyChange / getPinnedUserKeys / the mismatch
// branch of allowSealToRecipient touch only the in-memory pin map (the TOFU
// pinUserKeys write needs sodium and is try/caught, so a first-contact allow
// still returns true under the node test env).
describe('send-side pin gate refuses sealing to a substituted recipient key', () => {
  const uid = 'b1b2c3d4-0000-4000-8000-000000000010';
  const sharing = 'aa'.repeat(32);
  const signing = 'bb'.repeat(32);
  const substituted = 'cc'.repeat(32);

  it('allows sealing when the directory sharing key matches the pin', () => {
    approveUserKeyChange(uid, sharing, signing); // seed a pin out-of-band
    expect(getPinnedUserKeys(uid)?.sharingPubkeyHex).toBe(sharing);
    expect(allowSealToRecipient(uid, signing, sharing)).toBe(true);
    // Case-insensitive hex compare, like the receive side.
    expect(allowSealToRecipient(uid, signing.toUpperCase(), sharing.toUpperCase())).toBe(true);
  });

  it('refuses sealing when the directory sharing key differs from the pin', () => {
    approveUserKeyChange(uid, sharing, signing);
    expect(allowSealToRecipient(uid, signing, substituted)).toBe(false);
  });

  it('refuses a present sharing key that carries no identity (server nulls the user_id)', () => {
    // A malicious server returning {sharing_public_key: <attacker>, user_id: null}
    // dodges the pin lookup (no identity to key it under). A key we cannot verify
    // must fail closed, not seal to the substituted key.
    expect(allowSealToRecipient(null, signing, sharing)).toBe(false);
    expect(allowSealToRecipient(undefined, signing, sharing)).toBe(false);
  });

  it('is conservative: no sharing key at all never blocks (nothing to seal)', () => {
    expect(allowSealToRecipient(uid, signing, null)).toBe(true);
    expect(allowSealToRecipient(undefined, undefined, undefined)).toBe(true);
  });

  it('never overwrites an existing pin on a mismatch (recovery stays out-of-band)', () => {
    approveUserKeyChange(uid, sharing, signing);
    allowSealToRecipient(uid, signing, substituted); // refused
    expect(getPinnedUserKeys(uid)?.sharingPubkeyHex).toBe(sharing);
  });
});
