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
import { readFileSync } from 'fs';
import { join } from 'path';
import { beginOwnerShare, ownerSharesSettled } from './ownerShareInFlight';

/**
 * An invitation's finish waits for a share the owner is making before it
 * takes anything back (lib/finishInvitations). Until the share's last step
 * writes their entry, the person reads as gone.
 */
const settledYet = async (p: Promise<void>): Promise<boolean> => {
  let settled = false;
  void p.then(() => { settled = true; });
  await new Promise(r => setTimeout(r, 0));
  return settled;
};

describe('a share the owner is making', () => {
  it('with none in flight, is settled at once', async () => {
    expect(await settledYet(ownerSharesSettled('nb', 'zoe@example.test'))).toBe(true);
  });

  it('is waited for until it ends, however the address is written', async () => {
    const end = beginOwnerShare('nb', ' Zoe@Example.test ');
    const settled = ownerSharesSettled('nb', 'zoe@example.test');
    expect(await settledYet(settled)).toBe(false);
    end();
    expect(await settledYet(settled)).toBe(true);
  });

  it('holds for that notebook and that address only', async () => {
    const end = beginOwnerShare('nb', 'zoe@example.test');
    expect(await settledYet(ownerSharesSettled('other-nb', 'zoe@example.test'))).toBe(true);
    expect(await settledYet(ownerSharesSettled('nb', 'ben@example.test'))).toBe(true);
    end();
  });

  it('one begun while waiting is waited for too, and ending one twice does nothing', async () => {
    const first = beginOwnerShare('nb', 'zoe@example.test');
    const settled = ownerSharesSettled('nb', 'zoe@example.test');
    const second = beginOwnerShare('nb', 'zoe@example.test');
    first();
    expect(await settledYet(settled)).toBe(false);
    first();
    expect(await settledYet(settled)).toBe(false);
    second();
    expect(await settledYet(settled)).toBe(true);
    expect(await settledYet(ownerSharesSettled('nb', 'zoe@example.test'))).toBe(true);
  });
});

/** The repository has no DOM tests: the Share panel's use of it is read from its source. */
describe('the Share panel', () => {
  it('marks each of its notebook shares as in flight, from before the removal is ended until after the entry is written', () => {
    const panel = readFileSync(join(__dirname, '..', 'components', 'SharePanel.tsx'), 'utf8');
    const marks = [...panel.matchAll(/const endOwnerShare = beginOwnerShare\(props\.noteId, addr\);/g)].map(m => m.index!);
    expect(marks).toHaveLength(2);
    for (const at of marks) {
      const rest = panel.slice(at);
      const first = rest.indexOf('notebookBeforeItsNotes({');
      const entry = rest.indexOf('notebooksStore.addNotebookShare(');
      const closing = rest.indexOf('} finally {');
      const ended = rest.indexOf('endOwnerShare();');
      expect(first).toBeGreaterThan(0);
      expect(entry).toBeGreaterThan(first);
      expect(closing).toBeGreaterThan(entry);
      expect(ended).toBeGreaterThan(closing);
    }
  });
});
