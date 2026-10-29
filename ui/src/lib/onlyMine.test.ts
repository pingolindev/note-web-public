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
import {
  arrivedThroughShare, inScope, keepOutOfScope, onlyMineApplies, rememberOnlyMine, storedOnlyMine,
  ONLY_MINE_STORE,
} from './onlyMine';
import { ACCOUNT_SCOPED_STORES } from './account';

/**
 * "Only mine" leaves other people's notes out of the plain Notes grid.
 *
 * Three things here can each go wrong quietly: what counts as mine (a wrong
 * answer hides a note of the reader's own), where the filter acts (inside a
 * shared notebook it would empty the notebook), and what a change made out of
 * its place does to the remembered choice.
 */
describe('what counts as somebody else\'s note', () => {
  it('is a note a share\'s key opened', () => {
    expect(arrivedThroughShare({ openedVia: 'share' })).toBe(true);
  });

  it('is never a note our own vault opened', () => {
    expect(arrivedThroughShare({ openedVia: 'vault' })).toBe(false);
  });

  /**
   * A cache from before the stamp, or a wrap that does not open: the origin is
   * not known. Hiding a note that turns out to be the reader's own is the
   * worse mistake, so it stays.
   */
  it('is never a note whose origin is not known', () => {
    expect(arrivedThroughShare({})).toBe(false);
    expect(arrivedThroughShare({ openedVia: undefined })).toBe(false);
  });

  /**
   * The server's word decides nothing: `foreignOwner` and an inbox row are
   * both things a server could set on a note of ours.
   */
  it('reads nothing but the key that opened the note', () => {
    const ours = { openedVia: 'vault' as const, foreignOwner: true, isShared: true, ownerNotebookId: 'their-notebook' };
    expect(arrivedThroughShare(ours)).toBe(false);
  });
});

describe('where "Only mine" acts', () => {
  const plain = { view: 'active', notebook: null, searching: false };

  it('acts in the plain Notes grid', () => {
    expect(onlyMineApplies(plain)).toBe(true);
  });

  /** An accepted shared notebook holds nothing but other people's notes. */
  it('does not act inside a notebook', () => {
    expect(onlyMineApplies({ ...plain, notebook: 'nb1' })).toBe(false);
  });

  it('does not act over a search\'s results', () => {
    expect(onlyMineApplies({ ...plain, searching: true })).toBe(false);
  });

  it('does not act in Shared with me, Reminders, Archive or Trash', () => {
    for (const view of ['inbox', 'reminders', 'archived', 'trash']) {
      expect(onlyMineApplies({ ...plain, view })).toBe(false);
    }
  });
});

describe('the filters as they act in a place', () => {
  const on = { label: 'work' as string | null, onlyMine: true };

  it('keeps "Only mine" where it applies', () => {
    expect(inScope(on, true)).toBe(on);
  });

  it('drops only "Only mine" where it does not, and keeps the rest', () => {
    expect(inScope(on, false)).toEqual({ label: 'work', onlyMine: false });
  });

  it('hands back the same object when there is nothing to drop', () => {
    const off = { label: null, onlyMine: false };
    expect(inScope(off, false)).toBe(off);
  });
});

describe('a change made in a place', () => {
  const stored = { label: 'work' as string | null, onlyMine: true };

  it('is taken whole where "Only mine" applies: All clears it', () => {
    expect(keepOutOfScope({ label: null, onlyMine: false }, stored, true)).toEqual({ label: null, onlyMine: false });
  });

  /** "All" inside a notebook, where the chip is not even on screen. */
  it('leaves the remembered choice alone where it does not apply', () => {
    expect(keepOutOfScope({ label: null, onlyMine: false }, stored, false)).toEqual({ label: null, onlyMine: true });
  });

  it('never turns it ON from a place where it does not apply', () => {
    const off = { label: null as string | null, onlyMine: false };
    expect(keepOutOfScope({ label: 'x', onlyMine: true }, off, false)).toEqual({ label: 'x', onlyMine: false });
  });
});

/**
 * Remembered for the ACCOUNT, on this device. As one key for the whole
 * browser, the next person to sign in on a shared computer would have their
 * shared notes left out, and with the filter row folded nothing would say so.
 */
describe('remembered for the account, on this device', () => {
  /** One account's slot, as lib/account's scoped accessors present it. */
  const slot = () => {
    let value: string | null = null;
    return { read: () => value, write: (v: string) => { value = v; }, peek: () => value };
  };

  it('is off until the reader turns it on', () => {
    expect(storedOnlyMine(slot().read)).toBe(false);
  });

  it('comes back on after being turned on, and off after being turned off', () => {
    const s = slot();
    rememberOnlyMine(s.write, true);
    expect(s.peek()).toBe('1');
    expect(storedOnlyMine(s.read)).toBe(true);
    rememberOnlyMine(s.write, false);
    expect(storedOnlyMine(s.read)).toBe(false);
  });

  it('reads nothing else as on', () => {
    expect(storedOnlyMine(() => 'true')).toBe(false);
    expect(storedOnlyMine(() => '')).toBe(false);
  });

  /** Another account's sign-in finds the slot empty: lib/account reads null before and for it. */
  it('is off for an account that has stored nothing', () => {
    expect(storedOnlyMine(() => null)).toBe(false);
  });

  /** It is swept at sign-out and kept apart per account because it is one of the account's stores. */
  it('lives in a per-account store', () => {
    expect(ACCOUNT_SCOPED_STORES).toContain(ONLY_MINE_STORE);
  });

  /**
   * It is called in the middle of every change to the filter row. A storage
   * that is full, or forbidden (a private window), must not stop the chip.
   */
  it('a storage that throws costs the memory, not the change', () => {
    expect(() => rememberOnlyMine(() => { throw new Error('QuotaExceededError'); }, true)).not.toThrow();
    expect(storedOnlyMine(() => { throw new Error('SecurityError'); })).toBe(false);
  });
});
