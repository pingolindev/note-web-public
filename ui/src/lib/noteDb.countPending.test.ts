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

/**
 * The count of changes still waiting to be sent, which a shell asks before a
 * sign-out wipes the queue: "0" means nothing is lost. Only this account's
 * entries count, and a queue that cannot be read is an error, never "0 left".
 */
const ME = '0e0e0e0e-0000-4000-8000-00000000000e';
const OTHER = '0f0f0f0f-0000-4000-8000-00000000000f';
const getAll = vi.fn();
vi.mock('idb', () => ({
  openDB: async () => ({ getAll: (...a: unknown[]) => getAll(...a), close: () => {} }),
  deleteDB: async () => {},
}));
const { setTabAccount } = await import('./account');
setTabAccount(ME);
const { countPending } = await import('./noteDb');

describe('the count of changes still waiting to be sent', () => {
  it('counts this account\'s entries alone', async () => {
    getAll.mockResolvedValue([{ id: 'a', account: ME }, { id: 'b', account: OTHER }, { id: 'c', account: ME }]);
    expect(await countPending()).toBe(2);
  });

  it('is an error, not zero, when the queue cannot be read', async () => {
    getAll.mockRejectedValue(new Error('the queue cannot be read'));
    await expect(countPending()).rejects.toThrow();
  });
});
