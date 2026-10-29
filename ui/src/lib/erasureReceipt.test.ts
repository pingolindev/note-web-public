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
import sodiumInit from 'libsodium-wrappers';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyErasureReceipt, RECEIPT_CONTEXT } from './erasureReceipt';

/**
 * ERASURE RECEIPT v1 against the shared test vectors: the file is pinned by
 * its sha256 and checked before anything else; every case's note-web result
 * is reproduced; and a [current, previous] key list verifies a receipt
 * signed by either key and nothing else.
 */

const VECTORS = join(__dirname, 'testdata', 'erasure_receipt_v1.json');
const VECTORS_SHA256 = '8523be5b2e519a19298a07c472a8bc6c782f54adc64b91c61d157f8038f48df1';

interface Vectors {
  test_seed_hex: string;
  public_keys_hex: string[];
  other_test_seed_hex: string;
  other_public_key_hex: string;
  verify_at: number;
  cases: { name: string; receipt: string; payload: string; expect: Record<string, 'accept' | 'refuse'> }[];
}

let sodium: typeof sodiumInit;
let v: Vectors;

beforeAll(async () => {
  // Before any other check: the file is exactly the pinned one.
  const bytes = readFileSync(VECTORS);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(VECTORS_SHA256);
  v = JSON.parse(bytes.toString('utf8'));
  await sodiumInit.ready;
  sodium = sodiumInit;
});

const keysOf = (hexes: string[]) => hexes.map((h) => sodium.from_hex(h));

describe('the shared vectors, as note-web', () => {
  it('has all 20 cases', () => {
    expect(v.cases).toHaveLength(20);
  });

  it('reproduces every note-web result', () => {
    const results = v.cases.map((c) => {
      const verdict = verifyErasureReceipt(sodium, c.receipt, keysOf(v.public_keys_hex), v.verify_at);
      return [c.name, verdict.ok ? 'accept' : 'refuse'];
    });
    expect(results).toEqual(v.cases.map((c) => [c.name, c.expect['note-web']]));
  });

  it('names the erased account in an accepted receipt', () => {
    const valid = v.cases.find((c) => c.name === 'valid')!;
    expect(verifyErasureReceipt(sodium, valid.receipt, keysOf(v.public_keys_hex), v.verify_at))
      .toEqual({ ok: true, sub: JSON.parse(valid.payload).sub });
  });

  it('the vector keys are the ones their seeds make', () => {
    expect(sodium.to_hex(sodium.crypto_sign_seed_keypair(sodium.from_hex(v.test_seed_hex)).publicKey))
      .toBe(v.public_keys_hex[0]);
    expect(sodium.to_hex(sodium.crypto_sign_seed_keypair(sodium.from_hex(v.other_test_seed_hex)).publicKey))
      .toBe(v.other_public_key_hex);
  });
});

describe('a [current, previous] key list', () => {
  function sign(seedHex: string, claims: Record<string, unknown>): string {
    const kp = sodium.crypto_sign_seed_keypair(sodium.from_hex(seedHex));
    const payload = sodium.from_string(JSON.stringify(claims));
    const context = sodium.from_string(RECEIPT_CONTEXT);
    const signed = new Uint8Array(context.length + payload.length);
    signed.set(context);
    signed.set(payload, context.length);
    const sig = sodium.crypto_sign_detached(signed, kp.privateKey);
    const enc = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING);
    return `${enc(payload)}.${enc(sig)}`;
  }

  const claims = (now: number) => ({
    v: 1, purpose: 'pingolin.erasure_receipt', sub: '3f2c9c8e-5a1b-4d7e-9c3a-1b2d3e4f5a6b',
    aud: ['track-web', 'note-web'], iat: now, exp: now + 600, jti: '5f8e2d7c4b1a09f8e7d6c5b4a3928170',
  });

  it('verifies a receipt signed by the previous key, and by the current one', () => {
    const now = v.verify_at;
    const current = v.public_keys_hex[0];
    const previous = v.other_public_key_hex;
    const byPrevious = sign(v.other_test_seed_hex, claims(now));
    const byCurrent = sign(v.test_seed_hex, claims(now));
    expect(verifyErasureReceipt(sodium, byPrevious, keysOf([current, previous]), now).ok).toBe(true);
    expect(verifyErasureReceipt(sodium, byCurrent, keysOf([current, previous]), now).ok).toBe(true);
    // The same receipts with only one key in the list: the other is refused.
    expect(verifyErasureReceipt(sodium, byPrevious, keysOf([current]), now).ok).toBe(false);
    expect(verifyErasureReceipt(sodium, byCurrent, keysOf([previous]), now).ok).toBe(false);
  });

  it("the vectors' other-key case verifies once that key is in the list", () => {
    const other = v.cases.find((c) => c.name === 'signed_by_other_key')!;
    expect(verifyErasureReceipt(sodium, other.receipt, keysOf([v.public_keys_hex[0], v.other_public_key_hex]), v.verify_at).ok)
      .toBe(true);
  });

  it('an empty list verifies nothing', () => {
    const valid = v.cases.find((c) => c.name === 'valid')!;
    expect(verifyErasureReceipt(sodium, valid.receipt, [], v.verify_at)).toEqual({ ok: false, refused: 'signature' });
  });

  it('the time rules sit exactly at their edges', () => {
    const now = v.verify_at;
    const at = (iat: number, exp: number) =>
      verifyErasureReceipt(sodium, sign(v.test_seed_hex, { ...claims(0), iat, exp }), keysOf([v.public_keys_hex[0]]), now).ok;
    expect(at(now + 300, now + 600)).toBe(true);
    expect(at(now + 301, now + 600)).toBe(false);
    expect(at(now - 600, now)).toBe(true);
    expect(at(now - 601, now - 1)).toBe(false);
    expect(at(now - 10, now + 590)).toBe(true);
    expect(at(now - 10, now + 591)).toBe(false);
    // Expiring before it was issued: refused, though every window above holds.
    expect(at(now + 200, now + 100)).toBe(false);
    expect(at(now + 100, now + 100)).toBe(true);
  });

  it('refuses for the rule that applies, not a later one', () => {
    const at = (name: string) => verifyErasureReceipt(
      sodium, v.cases.find((c) => c.name === name)!.receipt, keysOf(v.public_keys_hex), v.verify_at);
    expect(at('truncated_signature')).toEqual({ ok: false, refused: 'format: 64-byte signature' });
    expect(at('missing_field')).toEqual({ ok: false, refused: 'fields' });
    expect(at('extra_field')).toEqual({ ok: false, refused: 'fields' });
    expect(at('padded')).toEqual({ ok: false, refused: 'format: base64url, no padding' });
  });

  it('refuses anything after the signature', () => {
    const valid = v.cases.find((c) => c.name === 'valid')!.receipt;
    expect(verifyErasureReceipt(sodium, `${valid}.AAAA`, keysOf(v.public_keys_hex), v.verify_at))
      .toEqual({ ok: false, refused: 'format: two parts' });
  });

  it('refuses a jti that is not 32 hex', () => {
    const now = v.verify_at;
    for (const jti of ['5f8e2d7c', '5F8E2D7C4B1A09F8E7D6C5B4A3928170', 42]) {
      const r = sign(v.test_seed_hex, { ...claims(now), jti });
      expect(verifyErasureReceipt(sodium, r, keysOf([v.public_keys_hex[0]]), now)).toEqual({ ok: false, refused: 'jti' });
    }
  });

  it('refuses an oversized receipt before decoding it', () => {
    const big = `${'A'.repeat(2000)}.${'B'.repeat(100)}`;
    expect(verifyErasureReceipt(sodium, big, keysOf(v.public_keys_hex), v.verify_at)).toEqual({ ok: false, refused: 'format: too long' });
  });
});
