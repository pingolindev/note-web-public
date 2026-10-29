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
import * as Y from 'yjs';
import { deterministicSeedUpdate } from './collab';

describe('deterministic collab seed', () => {
  // Cross-LANGUAGE vector: MUST equal the mobile SDK's note-collab-sdk
  // deterministic_seed_update (yrs) byte-for-byte, or web↔mobile collab
  // duplicates the initial body on first open. The seed client id is DERIVED
  // FROM THE CONTENT (BLAKE3) — for "hello world" it is 3389416114571735, the
  // low 53 bits of the little-endian u64 from the first 8 bytes of the digest —
  // so this hex embeds that id as a varint. Locked in the Rust test
  // `deterministic_seed_cross_language_vector`. Change both in lockstep.
  it('produces the locked cross-language vector for "hello world"', () => {
    const hex = Buffer.from(deterministicSeedUpdate('hello world')).toString('hex');
    expect(hex).toBe('0101d79385fcfed4820600040104626f64790b68656c6c6f20776f726c6400');
  });

  // The whole point: two devices seeding the SAME body independently converge
  // to one copy, not two.
  it('is idempotent — two independent seeds of the same body merge to one copy', () => {
    const seed = deterministicSeedUpdate('hello world');
    const a = new Y.Doc();
    Y.applyUpdate(a, seed);
    const b = new Y.Doc();
    Y.applyUpdate(b, seed);
    // Full two-way sync.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(a.getText('body').toString()).toBe('hello world');
    expect(b.getText('body').toString()).toBe('hello world');
  });

  // Contrast: two plain inserts (random client ids) double on merge.
  it('plain inserts duplicate on merge (what the seed prevents)', () => {
    const a = new Y.Doc();
    a.getText('body').insert(0, 'hello');
    const b = new Y.Doc();
    b.getText('body').insert(0, 'hello');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(b.getText('body').toString()).toBe('hellohello');
  });

  it('empty text seeds nothing', () => {
    expect(deterministicSeedUpdate('').length).toBe(0);
  });

  // Identical content → identical bytes (content-derived client id is stable), so
  // two clients seeding the same body dedup on merge.
  it('identical content yields identical seed bytes', () => {
    const a = Buffer.from(deterministicSeedUpdate('hello world')).toString('hex');
    const b = Buffer.from(deterministicSeedUpdate('hello world')).toString('hex');
    expect(a).toBe(b);
  });

  // Divergent content → DIFFERENT client ids, so two divergent seeds do not
  // collide at (client=1, clock=0..) and split-brain. They merge as ordinary
  // concurrent inserts and CONVERGE (both bodies survive) — the safe failure.
  it('divergent content gets different ids and converges without data loss', () => {
    const seedA = deterministicSeedUpdate('hello world');
    const seedB = deterministicSeedUpdate('goodbye world');
    expect(Buffer.from(seedA).toString('hex')).not.toBe(Buffer.from(seedB).toString('hex'));
    const a = new Y.Doc();
    Y.applyUpdate(a, seedA);
    const b = new Y.Doc();
    Y.applyUpdate(b, seedB);
    // Full two-way sync.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const at = a.getText('body').toString();
    const bt = b.getText('body').toString();
    expect(at).toBe(bt); // converged (no permanent divergence)
    expect(at).toContain('hello world');
    expect(at).toContain('goodbye world'); // neither body silently lost
  });
});
