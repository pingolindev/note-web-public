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
 * This session's pulls, as the removal drains wait on them: every finished
 * pull and every reset wakes the waiters, so a waiter whose session ended
 * re-checks at once instead of waiting on for a pull of another account.
 */

const ACCOUNT_A = '0e0e0e0e-0000-4000-8000-0000000000aa';
const ACCOUNT_B = '0e0e0e0e-0000-4000-8000-0000000000bb';

let notebooksStore: typeof import('./notebooks').notebooksStore;
let setTabAccount: (id: string | null) => void;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0, clear: () => {} });
  ({ setTabAccount } = await import('../lib/account'));
  ({ notebooksStore } = await import('./notebooks'));
  setTabAccount(ACCOUNT_A);
});

/** Whether `p` has settled by the end of this turn of the event loop. */
async function settled(p: Promise<unknown>) {
  let done = false;
  void p.then(() => { done = true; });
  await new Promise(r => setTimeout(r, 0));
  return done;
}

describe("this session's pulls", () => {
  it('a pull wakes the waiters, and a full one says so', async () => {
    const any = notebooksStore.nextPullEvent();
    notebooksStore.markPulled();
    expect(await settled(any)).toBe(true);
    expect(notebooksStore.hasPulled()).toBe(true);
    expect(notebooksStore.hasPulled(true)).toBe(false);

    const full = notebooksStore.nextPullEvent();
    expect(await settled(full)).toBe(false);
    notebooksStore.markFullyPulled();
    expect(await settled(full)).toBe(true);
    expect(notebooksStore.hasPulled(true)).toBe(true);
  });

  it('a sign-out reset wakes the waiters and forgets both pulls', async () => {
    notebooksStore.markPulled();
    notebooksStore.markFullyPulled();
    const waiting = notebooksStore.nextPullEvent();

    notebooksStore.reset();

    expect(await settled(waiting)).toBe(true);
    expect(notebooksStore.hasPulled()).toBe(false);
    expect(notebooksStore.hasPulled(true)).toBe(false);
  });

  it('another account wakes the waiters and forgets both pulls', async () => {
    notebooksStore.markPulled();
    notebooksStore.markFullyPulled();
    const waiting = notebooksStore.nextPullEvent();

    setTabAccount(ACCOUNT_B);

    expect(await settled(waiting)).toBe(true);
    expect(notebooksStore.hasPulled()).toBe(false);
    expect(notebooksStore.hasPulled(true)).toBe(false);
  });
});
