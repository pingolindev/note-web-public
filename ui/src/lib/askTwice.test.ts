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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { askTwice, ASK_AGAIN_AFTER_MS } from './askTwice';

/**
 * A read a removal cannot go without, asked once more when it gets no
 * answer; if it still fails, the removal stops and says it did not go
 * through.
 */

const answered = { success: true as const, data: 'rows' };
const noAnswer = { success: false as const, error: 'Network error' };
const anotherAccount = { success: false as const, error: 'stop', error_code: 'account_mismatch' };

afterEach(() => { vi.useRealTimers(); });

describe('askTwice', () => {
  it('an answer is taken as it is: asked once', async () => {
    const ask = vi.fn(async () => answered);
    expect(await askTwice(ask)).toBe(answered);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('no answer: asked again, only after a moment, and that answer is taken', async () => {
    vi.useFakeTimers();
    const ask = vi.fn().mockResolvedValueOnce(noAnswer).mockResolvedValueOnce(answered);
    const p = askTwice(ask);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS - 1);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBe(answered);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('no answer twice: that is the answer; never a third ask', async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => noAnswer);
    const p = askTwice(ask);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 5);
    expect(await p).toBe(noAnswer);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('another account\'s answer: never asked again', async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => anotherAccount);
    const p = askTwice(ask);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 2);
    expect(await p).toBe(anotherAccount);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  /** A 403 is not worth a second wait; a 404 can be a replica that lags. */
  it('a 403 is not asked again; a 404 is', async () => {
    vi.useFakeTimers();
    const refused = { success: false as const, status: 403, error: 'Forbidden' };
    const once = vi.fn().mockResolvedValue(refused);
    expect(await askTwice(once)).toBe(refused);
    expect(once).toHaveBeenCalledTimes(1);
    const lagging = vi.fn().mockResolvedValueOnce({ success: false, status: 404, error: 'Not found' }).mockResolvedValueOnce(answered);
    const p = askTwice(lagging);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS);
    expect(await p).toBe(answered);
  });

  it('a refusal (a status) is asked again too: one more ask is cheap, and a deploy answers 502 for a moment', async () => {
    vi.useFakeTimers();
    const ask = vi.fn().mockResolvedValueOnce({ success: false, status: 502, error: 'Bad gateway' }).mockResolvedValueOnce(answered);
    const p = askTwice(ask);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS);
    expect(await p).toBe(answered);
  });
});
