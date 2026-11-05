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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ACCOUNT_RECHECK_MS, SHELL_ACCOUNT_EVENT, startAccountRecheck } from './accountRecheck';

/** The open tab re-checks its account on coming into view and once a minute. */

function fakeDocument() {
  const listeners = new Set<() => void>();
  const shell = new Set<() => void>();
  const of = (type: string) => (type === SHELL_ACCOUNT_EVENT ? shell : listeners);
  return {
    visibilityState: 'hidden' as DocumentVisibilityState,
    addEventListener: (type: string, fn: () => void) => { of(type).add(fn); },
    removeEventListener: (type: string, fn: () => void) => { of(type).delete(fn); },
    show(state: DocumentVisibilityState) { this.visibilityState = state; listeners.forEach(fn => fn()); },
    shellSays() { shell.forEach(fn => fn()); },
    listeners,
    shell,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startAccountRecheck', () => {
  it('re-checks once a minute', () => {
    const recheck = vi.fn();
    startAccountRecheck(recheck, fakeDocument() as unknown as Document);
    vi.advanceTimersByTime(ACCOUNT_RECHECK_MS - 1);
    expect(recheck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recheck).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ACCOUNT_RECHECK_MS);
    expect(recheck).toHaveBeenCalledTimes(2);
    expect(ACCOUNT_RECHECK_MS).toBe(60_000);
  });

  it('re-checks when the tab comes into view, not when it goes out of it', () => {
    const recheck = vi.fn();
    const doc = fakeDocument();
    startAccountRecheck(recheck, doc as unknown as Document);
    doc.show('hidden');
    expect(recheck).not.toHaveBeenCalled();
    doc.show('visible');
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it("re-checks at once on the iOS app's word, while the tab stays in view", () => {
    const recheck = vi.fn();
    const doc = fakeDocument();
    startAccountRecheck(recheck, doc as unknown as Document);
    doc.shellSays();
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(SHELL_ACCOUNT_EVENT).toBe('pingolin-account');
  });

  it('stops all of them when stopped', () => {
    const recheck = vi.fn();
    const doc = fakeDocument();
    const stop = startAccountRecheck(recheck, doc as unknown as Document);
    stop();
    doc.show('visible');
    doc.shellSays();
    vi.advanceTimersByTime(ACCOUNT_RECHECK_MS * 3);
    expect(recheck).not.toHaveBeenCalled();
    expect(doc.listeners.size).toBe(0);
    expect(doc.shell.size).toBe(0);
  });
});
