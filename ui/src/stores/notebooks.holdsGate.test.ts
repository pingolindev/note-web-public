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

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The holds gate: closed at every account confirmation and every read of the
 * removal jobs, opened only by the read begun last, and one promise for as
 * long as it is closed.
 *
 * WHY THESE EXIST
 *   If a second arm before the gate opened replaced its promise, everything
 *   already waiting on the first — the sync, and the whole metadata write queue,
 *   a removal's list write among them — would wait until a reload, and the other
 *   devices would keep sealing new notes to the person just removed. And if any
 *   read could open it, an older one could too, holding the jobs as they were
 *   when it began.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(7),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
}));

const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
const NB = '11111111-1111-4111-8111-111111111111';
const A = '0e0e0e0e-0000-4000-8000-00000000000a';
const B = '0e0e0e0e-0000-4000-8000-00000000000b';
const X = 'removed@example.test';
const Y = 'stays@example.test';
const entry = (email: string) => ({ email, permission: 'edit' as const, publicKey: null, userId: null, signingPublicKey: null });

let notebooksStore: typeof import('./notebooks').notebooksStore;
const calls: { url: string; method: string }[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
    calls.push({ url, method: opts?.method ?? 'GET' });
    if (opts?.method === 'PUT') return { success: true, data: { version: 2 } };
    return { success: false, status: 404 };
  });
  ({ notebooksStore } = await import('./notebooks'));
  // A session with a base, so writes are not held for a pull; X and Y on the list.
  notebooksStore.loadFromSyncedItems([{ id: META, item_type: 10, version: 1, deleted: false,
    encrypted_content: JSON.stringify({ notebooks: [{ id: NB, name: 'Family' }], labelColors: {},
      notebookShares: { [NB]: [entry(X), entry(Y)] } }),
    content_nonce: 'n', updated_at: 't' }]);
});

const settle = (p: Promise<unknown>) =>
  Promise.race([p.then(() => 'resolved'), new Promise(r => setTimeout(() => r('hung'), 100))]);
const emails = () => notebooksStore.getNotebookShares(NB).map(r => r.email);
const puts = () => calls.filter(c => c.method === 'PUT').length;

describe('the holds gate closed twice before it opens', () => {
  it('releases a sync that waited on the first arm', async () => {
    notebooksStore.beginHoldsRead();                 // e.g. the start's read
    const sync = notebooksStore.whenHoldsReady();    // the sync starts and waits
    const second = notebooksStore.beginHoldsRead();  // the keys arrive again in a retained document
    second.loaded([]);                               // its read finishes and opens the gate

    expect(await settle(sync)).toBe('resolved');
  });

  it('lets a metadata write queued during the first arm go', async () => {
    notebooksStore.beginHoldsRead();
    notebooksStore.setLabelColor('work', '#123456'); // a write enters the tail and waits on the gate
    await new Promise(r => setTimeout(r, 20));
    expect(puts()).toBe(0);
    const second = notebooksStore.beginHoldsRead();
    second.loaded([]);

    await vi.waitFor(() => expect(puts()).toBeGreaterThan(0));
  });
});

describe('a read that finishes after a later one began', () => {
  it('neither holds anyone nor opens the gate; the later one does', async () => {
    const first = notebooksStore.beginHoldsRead();
    const second = notebooksStore.beginHoldsRead();
    const sync = notebooksStore.whenHoldsReady();

    first.loaded([{ notebookId: NB, removedRecipients: [X] }]);
    first.open();
    expect(first.latest()).toBe(false);
    expect(await settle(sync)).toBe('hung');
    expect(emails()).toEqual([X, Y]);

    second.loaded([]);
    expect(await settle(sync)).toBe('resolved');
    expect(emails()).toEqual([X, Y]);
  });

  it('opens nothing for an account no longer here', async () => {
    const { setTabAccount } = await import('../lib/account');
    setTabAccount(null);
    setTabAccount(A);
    const forA = notebooksStore.beginHoldsRead();
    setTabAccount(B); // B confirmed: its own read holds and opens
    const sync = notebooksStore.whenHoldsReady();

    forA.loaded([]);
    expect(await settle(sync)).toBe('hung');

    notebooksStore.beginHoldsRead().loaded([]);
    expect(await settle(sync)).toBe('resolved');
  });
});

describe('a waiter woken as the gate opened, then closed again before it ran', () => {
  it('waits again, for the read begun last', async () => {
    const first = notebooksStore.beginHoldsRead();
    const waiter = notebooksStore.whenHoldsReady();
    first.loaded([]);
    const second = notebooksStore.beginHoldsRead(); // the same tick: before the waiter runs

    expect(await settle(waiter)).toBe('hung');
    second.loaded([{ notebookId: NB, removedRecipients: [X] }]);
    expect(await settle(waiter)).toBe('resolved');
    expect(emails()).toEqual([Y]);
  });
});

describe('no account', () => {
  it('opens the gate: there is nothing to hold, and a read in flight is another account’s', async () => {
    const { setTabAccount } = await import('../lib/account');
    setTabAccount(null);
    setTabAccount(A);
    const forA = notebooksStore.beginHoldsRead();

    setTabAccount(null);

    expect(await settle(notebooksStore.whenHoldsReady())).toBe('resolved');
    expect(forA.latest()).toBe(false);
  });
});
