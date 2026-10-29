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
import { approveUserKeyChange, getPinnedUserKeys } from './crypto';

// Recovery primitive behind the web editor's sender-key-change alarm UI
// (sharesInboxStore.approveKeyChange → approveUserKeyChange). When a sender
// rotates their signing/sharing key, every share from them is dropped as
// 'invalid' against the OLD pin; approving the change (after an out-of-band
// safety-number check) must re-pin to the NEW keys and stamp
// userApprovedChangeAt so those shares verify + decrypt on the next load.
// If this contract breaks, the alarm UI's "Approve" button silently fails
// to recover the hidden shares.
//
// Runs sodium-free: approveUserKeyChange / getPinnedUserKeys touch only the
// in-memory pin map (persistence to localStorage is best-effort try/caught and
// simply no-ops under the node test env).
describe('sender key-change approval re-pins to the new keys', () => {
  const uid = 'a1b2c3d4-0000-4000-8000-000000000001';
  const s1 = 'aa'.repeat(32);
  const sign1 = 'bb'.repeat(32);
  const s2 = 'cc'.repeat(32);
  const sign2 = 'dd'.repeat(32);

  it('overwrites both pinned keys and records the approval time', () => {
    approveUserKeyChange(uid, s1, sign1);
    expect(getPinnedUserKeys(uid)?.sharingPubkeyHex).toBe(s1);
    expect(getPinnedUserKeys(uid)?.signingPubkeyHex).toBe(sign1);

    // A later approval (the rotation case) must fully replace the pin.
    approveUserKeyChange(uid, s2, sign2);
    const pin = getPinnedUserKeys(uid);
    expect(pin?.sharingPubkeyHex).toBe(s2);
    expect(pin?.signingPubkeyHex).toBe(sign2);
    expect(pin?.userApprovedChangeAt ?? 0).toBeGreaterThan(0);
  });

  it('leaves other senders untouched', () => {
    const other = 'a1b2c3d4-0000-4000-8000-000000000002';
    approveUserKeyChange(uid, s1, sign1);
    approveUserKeyChange(other, s2, sign2);
    expect(getPinnedUserKeys(uid)?.signingPubkeyHex).toBe(sign1);
    expect(getPinnedUserKeys(other)?.signingPubkeyHex).toBe(sign2);
  });
});
