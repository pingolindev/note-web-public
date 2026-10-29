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
import { firstByKey, keptPerList } from './listIndex';

interface Row { id: string | null; n: number }
const keyOf = (r: Row) => r.id;
/** The plain walk the index has to agree with. */
const walk = (list: readonly Row[], key: string) => list.find(r => keyOf(r) === key);

describe('the first element with a key', () => {
  it('is the one a walk of the list would find', () => {
    const list: Row[] = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }];
    const find = firstByKey(keyOf);
    expect(find(list, 'b')).toBe(list[1]);
    expect(find(list, 'a')).toBe(list[0]);
    expect(find(list, 'z')).toBeUndefined();
  });

  it('is the FIRST of several with the same key', () => {
    const list: Row[] = [{ id: 'a', n: 1 }, { id: 'a', n: 2 }, { id: 'a', n: 3 }];
    expect(firstByKey(keyOf)(list, 'a')).toBe(list[0]);
  });

  it('an element with no key is found by no key', () => {
    const list: Row[] = [{ id: null, n: 1 }, { id: 'a', n: 2 }];
    const find = firstByKey(keyOf);
    expect(find(list, 'null')).toBeUndefined();
    expect(find(list, '')).toBeUndefined();
    expect(find(list, 'a')).toBe(list[1]);
  });

  it('is asked of the list as it is NOW: another array is read afresh, however alike', () => {
    const find = firstByKey(keyOf);
    const before: Row[] = [{ id: 'a', n: 1 }];
    expect(find(before, 'b')).toBeUndefined();
    // The same rows and one more, as a store's update makes it.
    const after = [...before, { id: 'b', n: 2 }];
    expect(find(after, 'b')).toBe(after[1]);
    // A row that left is gone.
    const later = after.filter(r => r.id !== 'a');
    expect(find(later, 'a')).toBeUndefined();
    // And back to an earlier list: its own answer, not the last one's.
    expect(find(before, 'b')).toBeUndefined();
    expect(find(before, 'a')).toBe(before[0]);
  });

  it('reads a list once, however often it is asked', () => {
    let read = 0;
    const find = firstByKey<Row>((r) => { read++; return r.id; });
    const list: Row[] = Array.from({ length: 50 }, (_, i) => ({ id: `k${i}`, n: i }));
    for (let i = 0; i < 200; i++) find(list, `k${i % 60}`);
    expect(read).toBe(50);
    find([...list], 'k1');
    expect(read).toBe(100);
  });

  it('two indexes do not share what they hold', () => {
    const byId = firstByKey(keyOf);
    const byN = firstByKey<Row>(r => String(r.n));
    const list: Row[] = [{ id: 'a', n: 7 }];
    expect(byId(list, 'a')).toBe(list[0]);
    expect(byN(list, 'a')).toBeUndefined();
    expect(byN(list, '7')).toBe(list[0]);
    expect(byId(list, '7')).toBeUndefined();
  });

  it('agrees with a walk on lists of every shape', () => {
    // Deterministic pseudo-random lists: duplicates, missing keys, absent keys.
    let seed = 12345;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const find = firstByKey(keyOf);
    for (let round = 0; round < 200; round++) {
      const list: Row[] = Array.from({ length: rand(30) }, (_, i) => ({ id: rand(5) === 0 ? null : `k${rand(12)}`, n: i }));
      for (let q = 0; q < 20; q++) {
        const key = `k${rand(15)}`;
        expect(find(list, key)).toBe(walk(list, key));
      }
    }
  });
});

describe('an answer kept per list', () => {
  it('is worked out once for a list, and again for another array', () => {
    let worked = 0;
    const evens = keptPerList<number, number[]>((list) => { worked++; return list.filter(n => n % 2 === 0); });
    const list = [1, 2, 3, 4];
    const first = evens(list);
    expect(first).toEqual([2, 4]);
    expect(evens(list)).toBe(first);
    expect(worked).toBe(1);
    const next = [...list, 6];
    expect(evens(next)).toEqual([2, 4, 6]);
    expect(worked).toBe(2);
    // The earlier list again: worked out again, not the newer list's answer.
    expect(evens(list)).toEqual([2, 4]);
    expect(worked).toBe(3);
  });

  it('keeps an answer that is undefined or null too', () => {
    let worked = 0;
    const nothing = keptPerList<number, undefined>(() => { worked++; return undefined; });
    const list = [1];
    expect(nothing(list)).toBeUndefined();
    expect(nothing(list)).toBeUndefined();
    expect(worked).toBe(1);
  });
});
