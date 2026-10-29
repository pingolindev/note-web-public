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
 * A notebook item written for a restore says what happened, a taken id is
 * never asked again, and "is this notebook ours" comes from the server's row
 * AND our vault.
 *
 * WHY THESE EXIST
 *   A 403 on a notebook item (another account's id) must be marked, or the
 *   backfill POSTs it again after every full pull, forever. And a restore needs
 *   to know whether a 409's notebook is the user's own before filing into it.
 */

const ME = '0e0e0e0e-0000-4000-8000-00000000000e';
const OTHER = '0e0e0e0e-0000-4000-8000-00000000000f';

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'ours', nonce: 'n' }),
  // Our vault opens our own wraps only.
  unwrapContentKeyWithVault: (key: string) => (key === 'ours' ? new Uint8Array(32).fill(7) : null),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
}));

const NB = '33333333-3333-4333-8333-333333333333';
let notebooksStore: typeof import('./notebooks').notebooksStore;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  ({ notebooksStore } = await import('./notebooks'));
  const { setTabAccount } = await import('../lib/account');
  setTabAccount(null);
  setTabAccount(ME);
  notebooksStore.beginHoldsRead().open();
});

const post = (reply: unknown) => apiRequest.mockImplementation(async (_u: string, o?: { method?: string }) =>
  (o?.method === 'POST' ? reply : { success: false, status: 404 }));
const notebookPosts = () => apiRequest.mock.calls.filter(c => c[1]?.method === 'POST' && c[1]?.body?.item_type === 2);

describe('creating a notebook item for a restore', () => {
  it("says created, exists (409), not-ours (403) or failed", async () => {
    post({ success: true, data: { id: NB, version: 1 } });
    expect(await notebooksStore.createNotebookItem(NB, 'A')).toBe('created');
    post({ success: false, status: 409, error_code: 'item_already_exists' });
    expect(await notebooksStore.createNotebookItem(NB, 'A')).toBe('exists');
    post({ success: false, status: 403, error_code: 'item_not_owned' });
    expect(await notebooksStore.createNotebookItem(NB, 'A')).toBe('not-ours');
    post({ success: false, status: 500 });
    expect(await notebooksStore.createNotebookItem(NB, 'A')).toBe('failed');
  });

  it('marks a 403 taken, so the backfill never POSTs it again', async () => {
    notebooksStore.restoreFromBackup({ notebooks: [{ id: NB, name: 'Squatted' }] });
    notebooksStore.markNotebookItemsComplete();
    post({ success: false, status: 403, error_code: 'item_not_owned' });

    await notebooksStore.backfillNotebookItems();
    await notebooksStore.backfillNotebookItems();

    expect(notebookPosts()).toHaveLength(1);
  });
});

describe('is a notebook ours, by its row and our vault', () => {
  const serve = (reply: unknown) => apiRequest.mockImplementation(async (url: string) =>
    (url === `/api/v1/items/${NB}` ? reply : { success: false, status: 404 }));
  const item = (over: Record<string, unknown> = {}) => ({
    success: true,
    data: { id: NB, user_id: ME, version: 4, deleted: false, content_nonce: 'n',
      encrypted_content: JSON.stringify({ title: 'A', members: [] }), wrapped_content_key: 'ours', wrapped_content_key_nonce: 'n', ...over },
  });

  it('ours: our row, live, and our vault opens its wrap (then kept, as a sync would)', async () => {
    serve(item());
    expect(await notebooksStore.readOwnNotebookItem(NB)).toBe('ours');
    expect(notebooksStore.notebookOpenedVia(NB)).toBe('vault');
    expect(notebooksStore.notebookVersion(NB)).toBe(4);
  });

  it("other: another account's row, or one we can't read (a 404)", async () => {
    serve(item({ user_id: OTHER }));
    expect(await notebooksStore.readOwnNotebookItem(NB)).toBe('other');
    serve({ success: false, status: 404 });
    expect(await notebooksStore.readOwnNotebookItem(NB)).toBe('other');
  });

  it('trashed: our row, deleted', async () => {
    serve(item({ deleted: true }));
    expect(await notebooksStore.readOwnNotebookItem(NB)).toBe('trashed');
  });

  it("failed: our row, but our vault doesn't open its wrap, or the read failed", async () => {
    serve(item({ wrapped_content_key: 'theirs' }));
    expect(await notebooksStore.readOwnNotebookItem(NB)).toBe('failed');
    expect(notebooksStore.notebookVersion(NB)).toBeNull();
    serve({ success: false, status: 503 });
    expect(await notebooksStore.readOwnNotebookItem(NB)).toBe('failed');
  });
});
