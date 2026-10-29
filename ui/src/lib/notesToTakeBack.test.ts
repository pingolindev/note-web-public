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

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** What a notebook's deletion could not take off yet is kept, per account, for later. */
const ME = '0e0e0e0e-0000-4000-8000-00000000000e';
const OTHER = '0f0f0f0f-0000-4000-8000-00000000000f';
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}
const local = memoryStorage();
vi.stubGlobal('localStorage', local);
const { setTabAccount } = await import('./account');
setTabAccount(ME);
const { rememberTakeBack, forgetTakeBack, notesToTakeBack, TAKE_BACK_MAX } = await import('./notesToTakeBack');

beforeEach(() => {
  local.clear();
  setTabAccount(ME);
});

describe('a note whose people a deletion could not take off', () => {
  it('is kept, once, with the latest deletion\'s time, until it is forgotten', () => {
    rememberTakeBack('n1', '2026-10-11T00:00:00.000Z');
    rememberTakeBack('n2', '2026-10-11T00:00:01.000Z');
    rememberTakeBack('n1', '2026-10-11T00:00:02.000Z');
    expect(notesToTakeBack()).toEqual([
      { noteId: 'n2', before: '2026-10-11T00:00:01.000Z' },
      { noteId: 'n1', before: '2026-10-11T00:00:02.000Z' },
    ]);
    forgetTakeBack('n2');
    expect(notesToTakeBack().map(e => e.noteId)).toEqual(['n1']);
  });

  it('is kept per account', () => {
    rememberTakeBack('n1', '2026-10-11T00:00:00.000Z');
    setTabAccount(OTHER);
    expect(notesToTakeBack()).toEqual([]);
    setTabAccount(ME);
    expect(notesToTakeBack()).toHaveLength(1);
  });

  it(`is kept for at most ${TAKE_BACK_MAX}, the oldest going first`, () => {
    for (let i = 0; i <= TAKE_BACK_MAX; i++) rememberTakeBack(`n${i}`, '2026-10-11T00:00:00.000Z');
    const kept = notesToTakeBack();
    expect(kept).toHaveLength(TAKE_BACK_MAX);
    expect(kept[0].noteId).toBe('n1');
  });
});
