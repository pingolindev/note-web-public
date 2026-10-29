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

import { describe, it, expect, vi } from 'vitest';
import { signOutAfterSending, LEFT_QUESTION, SEND_FIRST_MS, type SignOutSteps } from './signOut';

/**
 * The web's sign-out after its dialog (lib/signOut): what is waiting is sent
 * first, ten seconds at most, and anything still left is asked about once
 * more.
 */
function steps(over: Partial<SignOutSteps> = {}) {
  const done: string[] = [];
  const s = {
    flush: vi.fn(async () => { done.push('flush'); }),
    waiting: vi.fn(async () => 0),
    confirm: vi.fn(async () => true),
    logout: vi.fn(() => { done.push('logout'); }),
    pause: vi.fn((ms: number) => new Promise<void>(resolve => { done.push(`pause ${ms}`); void resolve; })),
    ...over,
  };
  return { s, done };
}

describe('signing out of the web page, after its dialog', () => {
  it('everything sent: signs out, asking nothing more', async () => {
    const { s, done } = steps();
    expect(await signOutAfterSending(s)).toBe(true);
    expect(s.confirm).not.toHaveBeenCalled();
    expect(done).toEqual(['flush', `pause ${SEND_FIRST_MS}`, 'logout']);
  });

  it('something left: asked in exactly these words, and "Stay signed in" keeps it signed in', async () => {
    const { s } = steps({ waiting: vi.fn(async () => 2), confirm: vi.fn(async () => false) });
    expect(await signOutAfterSending(s)).toBe(false);
    expect(s.confirm).toHaveBeenCalledWith({
      message: "Some changes haven't synced yet.",
      detail: "If you sign out now, they'll be lost.",
      confirmLabel: 'Sign out anyway',
      cancelLabel: 'Stay signed in',
      destructive: true,
    });
    expect(s.logout).not.toHaveBeenCalled();
  });

  it('"Sign out anyway" signs out', async () => {
    const { s } = steps({ waiting: vi.fn(async () => 1), confirm: vi.fn(async () => true) });
    expect(await signOutAfterSending(s)).toBe(true);
    expect(s.logout).toHaveBeenCalledTimes(1);
  });

  it('what is waiting cannot be counted: asked too, never taken for nothing left', async () => {
    const { s } = steps({ waiting: vi.fn(async () => { throw new Error('queue not read'); }), confirm: vi.fn(async () => false) });
    expect(await signOutAfterSending(s)).toBe(false);
    expect(s.confirm).toHaveBeenCalledWith(LEFT_QUESTION);
  });

  it('a send that takes longer than ten seconds is not waited for past them', async () => {
    let tenSecondsUp!: () => void;
    const { s } = steps({
      flush: vi.fn(() => new Promise<void>(() => {})),
      pause: vi.fn(() => new Promise<void>(resolve => { tenSecondsUp = resolve; })),
      waiting: vi.fn(async () => 1),
      confirm: vi.fn(async () => false),
    });
    const out = signOutAfterSending(s);
    await Promise.resolve();
    expect(s.confirm).not.toHaveBeenCalled();
    tenSecondsUp();
    expect(await out).toBe(false);
    expect(s.confirm).toHaveBeenCalledTimes(1);
  });

  it('a send that fails is counted as it is, and asked about', async () => {
    const { s } = steps({ flush: vi.fn(async () => { throw new Error('offline'); }), waiting: vi.fn(async () => 3), confirm: vi.fn(async () => false) });
    expect(await signOutAfterSending(s)).toBe(false);
    expect(s.confirm).toHaveBeenCalledTimes(1);
  });
});
