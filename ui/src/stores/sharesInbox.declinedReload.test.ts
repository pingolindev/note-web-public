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
 * The notebooks the server says this account declined are kept per account
 * across a RELOAD: a page loaded again has them from its first moment, before
 * the inbox has answered, and keeps them when it then gets no answer.
 * sharesInbox.ownNote's "new page" confirms the tab's account again, which
 * reads them back on the account change; a real reload loads every module
 * anew with the account confirmed BEFORE this store, and only the store's
 * first read can have them — so this pins that first read, which no other
 * test covers. Its own file: the reload re-imports the modules, which no
 * other test here should see.
 */
const ME = '11111111-1111-4111-8111-111111111111';
const NB = '7c7c7c7c-0000-4000-8000-000000000001';

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  getPinnedUserKeys: vi.fn(() => null),
  pinUserKeys: vi.fn(),
  unwrapContentKeyFromSender: vi.fn(),
  decryptWithContentKey: vi.fn(),
  verifyNoteShareWrapGen: vi.fn(),
  approveUserKeyChange: vi.fn(),
  computeSafetyNumber: vi.fn(),
}));
vi.mock('./auth', () => ({ authStore: { user: () => ({ id: ME }) } }));
vi.mock('./notes', () => ({ extrasFrom: () => ({}) }));

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
vi.stubGlobal('localStorage', memoryStorage());

describe('the notebooks the server says were declined, across a reload', () => {
  it('a page loaded again has them before any answer, and keeps them when it then gets none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (await import('../lib/account')).setTabAccount(ME);
    const first = (await import('./sharesInbox')).sharesInboxStore;
    apiRequest.mockImplementation((url: string) => Promise.resolve(url.startsWith('/api/v1/shares/inbox')
      ? { success: true, data: { shares: [], has_more: false, declined_notebooks: [{ id: NB, declined_at: '2026-10-06T09:00:00Z' }] } }
      : { success: false }));
    expect(await first.load()).toBe(true);
    expect([...first.declinedNotebooks()]).toEqual([NB]);

    // Loaded again: every module anew, the tab's account confirmed before the inbox's store loads.
    vi.resetModules();
    (await import('../lib/account')).setTabAccount(ME);
    const again = (await import('./sharesInbox')).sharesInboxStore;
    expect(again.answered()).toBe(false);
    expect([...again.declinedNotebooks()]).toEqual([NB]);

    apiRequest.mockImplementation(() => Promise.resolve({ success: false, status: 503 }));
    await again.load();
    expect(again.gotNoAnswer()).toBe(true);
    expect([...again.declinedNotebooks()]).toEqual([NB]);
    warn.mockRestore();
  });
});
