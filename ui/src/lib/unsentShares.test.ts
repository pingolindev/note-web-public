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

/**
 * A note that did not reach somebody in a notebook is sent again
 * (stores/notes `resendUnsent`). This is what is kept for it.
 */
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
const { setTabAccount, accountStorageKey } = await import('./account');
setTabAccount(ME);
const { rememberUnsent, forgetUnsent, unsentShares, UNSENT_MAX } = await import('./unsentShares');

beforeEach(() => {
  local.clear();
  setTabAccount(ME);
});

describe('a note that did not reach someone', () => {
  it('is kept when the failure may pass, and forgotten once it reached them', () => {
    rememberUnsent('n1', 'nb', 'ben@example.test', 'failed', 1);
    rememberUnsent('n2', 'nb', 'ben@example.test', 'cannot-sign', 2);
    expect(unsentShares().map(e => e.noteId)).toEqual(['n1', 'n2']);
    forgetUnsent('n1', 'Ben@Example.test');
    expect(unsentShares().map(e => e.noteId)).toEqual(['n2']);
  });

  it('is not kept for a failure that will not pass: a changed key, a plan without sharing', () => {
    rememberUnsent('n1', 'nb', 'ben@example.test', 'key-changed');
    rememberUnsent('n2', 'nb', 'ben@example.test', 'upgrade');
    expect(unsentShares()).toEqual([]);
  });

  it('is kept once for a note and a person, from when it first did not go', () => {
    rememberUnsent('n1', 'nb', 'ben@example.test', 'failed', 1);
    rememberUnsent('n1', 'nb', 'BEN@example.test', 'failed', 5);
    expect(unsentShares()).toEqual([{ noteId: 'n1', notebookId: 'nb', email: 'BEN@example.test', since: 1 }]);
  });

  it('is kept per account', () => {
    rememberUnsent('n1', 'nb', 'ben@example.test', 'failed');
    setTabAccount(OTHER);
    expect(unsentShares()).toEqual([]);
    setTabAccount(ME);
    expect(unsentShares()).toHaveLength(1);
  });

  it(`is kept for at most ${UNSENT_MAX}, the oldest going first`, () => {
    for (let i = 0; i <= UNSENT_MAX; i++) rememberUnsent(`n${i}`, 'nb', 'ben@example.test', 'failed', i);
    const kept = unsentShares();
    expect(kept).toHaveLength(UNSENT_MAX);
    expect(kept[0].noteId).toBe('n1');
  });

  it('is nothing when what is kept cannot be read', () => {
    local.setItem(accountStorageKey('pingolin_note_unsent_shares')!, '{not json');
    expect(unsentShares()).toEqual([]);
  });
});
