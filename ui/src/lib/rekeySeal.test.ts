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
import { openRekeyRecord, recordKeyFor, rekeyKeysFrom, sealRekeyJob } from './rekeySeal';
import { createJob } from './rekeyQueue';

/**
 * A re-key job outlives a sign-out, so it is sealed: nothing a signed-out
 * browser holds names the notebook or the person, and a record opens only for
 * its own account, under its own record key.
 */

const A = '0e0e0e0e-0000-4000-8000-00000000000a';
const B = '0e0e0e0e-0000-4000-8000-00000000000b';
const NB = '11111111-1111-4111-8111-111111111111';
const NB2 = '22222222-2222-4222-8222-222222222222';
const X = 'removed@example.test';
const vaultA = new Uint8Array(32).fill(1);
const vaultB = new Uint8Array(32).fill(2);
// Ids long enough that a random ciphertext can't contain them by chance.
const NOTE1 = '33333333-3333-4333-8333-333333333333';
const NOTE2 = '44444444-4444-4444-8444-444444444444';
const job = createJob({ notebookId: NB, removedRecipient: X, noteIds: [NOTE1, NOTE2], nowMs: 5 });

describe('a sealed re-key job', () => {
  it('opens for its account, whole', async () => {
    const keys = await rekeyKeysFrom(vaultA);
    const record = await sealRekeyJob(keys, A, job);

    expect(await openRekeyRecord(keys, A, record)).toEqual(job);
  });

  it('names no notebook and no person in what is stored', async () => {
    const record = await sealRekeyJob(await rekeyKeysFrom(vaultA), A, job);
    const stored = JSON.stringify(record);

    expect(stored).not.toContain(NB);
    expect(stored).not.toContain(X);
    expect(stored).not.toContain(NOTE1);
    expect(stored).not.toContain(NOTE2);
    expect(record.k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys the record by the notebook, the same way each time, and apart for another notebook', async () => {
    const keys = await rekeyKeysFrom(vaultA);
    expect(await recordKeyFor(keys, NB)).toBe(await recordKeyFor(keys, NB));
    expect(await recordKeyFor(keys, NB)).not.toBe(await recordKeyFor(keys, NB2));
    expect(await recordKeyFor(await rekeyKeysFrom(vaultB), NB)).not.toBe(await recordKeyFor(keys, NB));
  });

  it('does not open when moved to another account', async () => {
    const keys = await rekeyKeysFrom(vaultA);
    const record = await sealRekeyJob(keys, A, job);

    // Even with A's own keys: the account is part of what the seal covers.
    expect(await openRekeyRecord(keys, B, record)).toBeNull();
    expect(await openRekeyRecord(await rekeyKeysFrom(vaultB), B, record)).toBeNull();
  });

  it('does not open under another record key', async () => {
    const keys = await rekeyKeysFrom(vaultA);
    const record = await sealRekeyJob(keys, A, job);

    expect(await openRekeyRecord(keys, A, { ...record, k: await recordKeyFor(keys, NB2) })).toBeNull();
  });

  it('does not open under another vault key, or damaged, or in another format', async () => {
    const keys = await rekeyKeysFrom(vaultA);
    const record = await sealRekeyJob(keys, A, job);

    expect(await openRekeyRecord(await rekeyKeysFrom(vaultB), A, record)).toBeNull();
    const flipped = atob(record.c);
    const damaged = btoa(String.fromCharCode(flipped.charCodeAt(0) ^ 1) + flipped.slice(1));
    expect(await openRekeyRecord(keys, A, { ...record, c: damaged })).toBeNull();
    expect(await openRekeyRecord(keys, A, { ...record, v: 2 })).toBeNull();
  });
});
