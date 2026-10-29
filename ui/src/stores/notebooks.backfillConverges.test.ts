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
 * The notebook backfill must not re-create items the server already holds.
 *
 * A re-create costs one `POST /api/v1/items` per notebook on every cold
 * launch, serially, each answered 409 `item_already_exists` — pure waste on
 * every start, and it keeps the app busy long after the grid is on screen.
 *
 * Two rules keep it from happening:
 *
 *  1. `loadFromSyncedItems` MERGES its page into `knownNotebookItems`. It is
 *     called once per sync PAGE, and on an ordinary launch the whole sync is
 *     an incremental delta — assigning the page would replace the map with a
 *     handful of changed rows (usually none), and every notebook it did not
 *     mention would instantly look itemless. During a multi-page full sync
 *     each page would also erase the page before it.
 *  2. The backfill runs only once a COMPLETE scan has been seen, so it never
 *     acts on a partial map.
 *
 * And a tombstoned notebook item keeps its id, so creating against it 409s
 * forever — the scan records deleted rows instead of skipping them, because
 * that is the one fact that suppresses the doomed create.
 *
 * Each test below pins one of these rules.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(7),
  encryptWithContentKey: () => ({ ciphertext: 'ct', nonce: 'n' }),
  decryptWithContentKey: () => null,
  encryptNote: () => ({ ciphertext: 'ct', nonce: 'n' }),
  decryptNote: () => JSON.stringify({
    notebooks: [{ id: NB_A, name: 'Recipes' }, { id: NB_B, name: 'Travel' }],
    labelColors: {},
  }),
}));

const NB_A = '11111111-1111-4111-8111-111111111111';
const NB_B = '22222222-2222-4222-8222-222222222222';
const ITEM_TYPE_NOTEBOOK = 2;
const ITEM_TYPE_METADATA = 10;

type Item = Parameters<typeof notebooksStore.loadFromSyncedItems>[0][number];

let notebooksStore: typeof import('./notebooks').notebooksStore;

const meta = (): Item => ({
  id: 'meta', item_type: ITEM_TYPE_METADATA, encrypted_content: 'mct',
  content_nonce: 'mn', version: 1, deleted: false,
});
const notebookItem = (id: string, deleted = false): Item => ({
  id, item_type: ITEM_TYPE_NOTEBOOK, encrypted_content: 'ct', content_nonce: 'n',
  version: 3, deleted,
});

/** ids the store tried to CREATE (POST /api/v1/items). */
const createdIds = () => apiRequest.mock.calls
  .filter(([path, opts]) => path === '/api/v1/items' && opts?.method === 'POST')
  .map(([, opts]) => (opts.body as { id: string }).id);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  // Module-level caches are the thing under test — reimport for a clean map.
  ({ notebooksStore } = await import('./notebooks'));
  apiRequest.mockResolvedValue({ success: true, data: { id: 'x', version: 1 } });
});

describe('notebook backfill convergence', () => {
  it('does nothing until a full scan has completed', async () => {
    // A cold launch: the metadata names two notebooks, and the incremental
    // sync page carries no notebook rows at all. Acting on this state would
    // send one doomed POST per notebook.
    notebooksStore.loadFromSyncedItems([meta()]);

    expect(await notebooksStore.backfillNotebookItems()).toBe(0);
    expect(createdIds()).toEqual([]);
  });

  it('an incremental page does not erase what a full scan established', async () => {
    // Full scan: both notebooks already have items.
    notebooksStore.loadFromSyncedItems([meta(), notebookItem(NB_A), notebookItem(NB_B)]);
    notebooksStore.markNotebookItemsComplete();

    // A later incremental page mentions only ONE of them.
    // Replacing the map with it would make NB_B look itemless
    // and be re-created.
    notebooksStore.loadFromSyncedItems([notebookItem(NB_A)]);

    expect(await notebooksStore.backfillNotebookItems()).toBe(0);
    expect(createdIds()).toEqual([]);
  });

  it('never re-creates a notebook whose item is tombstoned', async () => {
    // A soft-deleted row still owns the id, so a create against it 409s every
    // time. A scan that skipped deleted rows would leave the backfill treating
    // the notebook as having no item at all.
    notebooksStore.loadFromSyncedItems([meta(), notebookItem(NB_A), notebookItem(NB_B, true)]);
    notebooksStore.markNotebookItemsComplete();

    expect(await notebooksStore.backfillNotebookItems()).toBe(0);
    expect(createdIds()).toEqual([]);
  });

  it('still backfills a genuinely metadata-only notebook, once', async () => {
    // The case the backfill exists for: NB_A has an item, NB_B has none.
    notebooksStore.loadFromSyncedItems([meta(), notebookItem(NB_A)]);
    notebooksStore.markNotebookItemsComplete();

    expect(await notebooksStore.backfillNotebookItems()).toBe(1);
    expect(createdIds()).toEqual([NB_B]);

    // Idempotent: the write registered NB_B, so a second pass is silent.
    apiRequest.mockClear();
    expect(await notebooksStore.backfillNotebookItems()).toBe(0);
    expect(createdIds()).toEqual([]);
  });

  it('a 409 suppresses that id for the rest of the session', async () => {
    notebooksStore.loadFromSyncedItems([meta(), notebookItem(NB_A)]);
    notebooksStore.markNotebookItemsComplete();
    apiRequest.mockResolvedValue({
      success: false, status: 409, error_code: 'item_already_exists',
    });

    expect(await notebooksStore.backfillNotebookItems()).toBe(0);
    expect(createdIds()).toEqual([NB_B]);

    // The version-0 marker must survive the next sync page: a page that wiped
    // it would make the next pass POST NB_B all over again.
    apiRequest.mockClear();
    notebooksStore.loadFromSyncedItems([notebookItem(NB_A)]);
    expect(await notebooksStore.backfillNotebookItems()).toBe(0);
    expect(createdIds()).toEqual([]);
  });
});
