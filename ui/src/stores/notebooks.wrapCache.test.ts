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
 * The wrap a notebook item is written with must be cached the moment it is
 * written.
 *
 * Without it, `notebookContentKey` returns null for a notebook this very client
 * just created — the wrap only comes back on the next full sync. Everything
 * that needs the content key then fails SILENTLY:
 *
 *   - `setNotebookMembers` bails on the null key, so sharing the notebook
 *     writes no roster. The notes still share, so the panel shows the recipient
 *     under "people with access" and the notebook object grants them nothing.
 *   - the rename that immediately follows creation in the sidebar's add flow
 *     finds no wrap, MINTS A FRESH KEY and rotates the notebook's key seconds
 *     after birth — stranding anyone holding the one before.
 *
 * From the outside the share looks like a success that moved zero bytes:
 * `POST /items/{note}/share -> 200`, no PUT to the notebook at all.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const generateContentKey = vi.fn();
const encryptWithContentKey = vi.fn();
const decryptWithContentKey = vi.fn();
const decryptNote = vi.fn();
const wrapContentKeyWithVault = vi.fn();
const unwrapContentKeyWithVault = vi.fn();
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: (...a: unknown[]) => generateContentKey(...a),
  wrapContentKeyWithVault: (...a: unknown[]) => wrapContentKeyWithVault(...a),
  unwrapContentKeyWithVault: (...a: unknown[]) => unwrapContentKeyWithVault(...a),
  encryptWithContentKey: (...a: unknown[]) => encryptWithContentKey(...a),
  decryptWithContentKey: (...a: unknown[]) => decryptWithContentKey(...a),
  encryptNote: () => ({ ciphertext: 'ct', nonce: 'n' }),
  decryptNote: (...a: unknown[]) => decryptNote(...a),
}));

const NB = '33333333-3333-4333-8333-333333333333';

let notebooksStore: typeof import('./notebooks').notebooksStore;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  // Fresh module state per test: the caches under test are module-level.
  ({ notebooksStore } = await import('./notebooks'));
  generateContentKey.mockReturnValue(new Uint8Array(32).fill(7));
  wrapContentKeyWithVault.mockReturnValue({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' });
  unwrapContentKeyWithVault.mockImplementation((key: string) =>
    key === 'wrap-1' ? new Uint8Array(32).fill(7) : null);
  encryptWithContentKey.mockReturnValue({ ciphertext: 'ct', nonce: 'n' });
  decryptWithContentKey.mockReturnValue(null);
  decryptNote.mockReturnValue('{}');
});

describe('creating a notebook item', () => {
  it('can open the notebook it just created, without waiting for a sync', async () => {
    apiRequest.mockResolvedValue({ success: true, data: { version: 1 } });
    expect(await notebooksStore.writeNotebookItem(NB, 'Recipes')).toBe(true);
    expect(notebooksStore.notebookContentKey(NB)).not.toBeNull();
  });

  it('leaves the key unopenable when the write failed', async () => {
    apiRequest.mockResolvedValue({ success: false, status: 500 });
    expect(await notebooksStore.writeNotebookItem(NB, 'Recipes')).toBe(false);
    expect(notebooksStore.notebookContentKey(NB)).toBeNull();
  });

  it('starts a new notebook with an empty roster, not an unknown one', async () => {
    apiRequest.mockResolvedValue({ success: true, data: { version: 1 } });
    await notebooksStore.writeNotebookItem(NB, 'Recipes');
    expect(notebooksStore.membersOf(NB)).toEqual([]);
  });
});

describe('renaming a notebook', () => {
  /**
   * The property that makes a rename safe for a SHARED notebook: members hold
   * the current content key and a rename is not a revocation.
   */
  it('reuses the existing content key rather than minting a new one', async () => {
    apiRequest.mockResolvedValue({ success: true, data: { version: 1 } });
    await notebooksStore.writeNotebookItem(NB, 'Recipes');
    generateContentKey.mockClear();

    apiRequest.mockResolvedValue({ success: true, data: { version: 2 } });
    await notebooksStore.renameNotebookItem(NB, 'Dinners');

    expect(generateContentKey).not.toHaveBeenCalled();
    const body = apiRequest.mock.calls.at(-1)?.[1]?.body as Record<string, unknown>;
    // No wrap is sent when the key is unchanged; the server keeps the
    // stored one.
    expect(body.wrapped_content_key).toBeUndefined();
  });

  /**
   * Renaming twice in a row is the sidebar's ordinary flow. If a minted key is
   * not cached, EVERY rename mints again — each one stranding the members who
   * hold the key before it.
   */
  it('does not mint a second key when it had to mint a first', async () => {
    // No create: this notebook predates wrap capture, so there is nothing to
    // reuse and the first rename legitimately mints.
    apiRequest.mockResolvedValue({ success: true, data: { version: 4 } });
    await notebooksStore.loadFromSyncedItems([{
      id: NB, item_type: 2, encrypted_content: 'ct', content_nonce: 'n',
      version: 3, deleted: false,
    }]);
    wrapContentKeyWithVault.mockReturnValue({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' });

    await notebooksStore.renameNotebookItem(NB, 'First');
    expect(generateContentKey).toHaveBeenCalledTimes(1);

    await notebooksStore.renameNotebookItem(NB, 'Second');
    expect(generateContentKey).toHaveBeenCalledTimes(1);
  });

  /**
   * A wrap that EXISTS but does not open — a notebook from before a password
   * reset — is not a notebook without a key. Minting there would replace the
   * only pointer back to the real key (and the roster sealed under it) with one
   * only this browser could open. Note Android skips this case too, and the
   * server refuses the PUT as well.
   */
  it('does not rename (and never mints) when the existing wrap does not open', async () => {
    await notebooksStore.loadFromSyncedItems([{
      id: NB, item_type: 2, encrypted_content: 'ct', content_nonce: 'n',
      version: 3, deleted: false,
      wrapped_content_key: 'wrap-from-another-era', wrapped_content_key_nonce: 'wn',
    }]);
    apiRequest.mockClear();

    await notebooksStore.renameNotebookItem(NB, 'Dinners');

    expect(generateContentKey).not.toHaveBeenCalled();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(notebooksStore.notebookWrap(NB)?.key).toBe('wrap-from-another-era');
  });
});

/**
 * The android document, byte-for-byte as the Android app writes it —
 * `edit_mode` present, `members` and `color` absent.
 */
const ANDROID_NOTEBOOK = JSON.stringify({
  title: 'Recipes', body: '', note_type: 'text',
  is_pinned: false, is_archived: false, labels: [], sort_order: 0,
  edit_mode: 'markdown',
});

/** What the store actually handed to the encrypter, parsed. */
const lastWritten = () =>
  JSON.parse(encryptWithContentKey.mock.calls.at(-1)![0] as string);

describe('writing a notebook another client created', () => {
  const seedAndroidNotebook = async () => {
    decryptWithContentKey.mockReturnValue(ANDROID_NOTEBOOK);
    decryptNote.mockReturnValue(JSON.stringify({
      notebooks: [{ id: NB, name: 'Recipes' }], labelColors: {},
    }));
    await notebooksStore.loadFromSyncedItems([
      {
        id: NB, item_type: 2, encrypted_content: 'ct', content_nonce: 'n',
        version: 3, deleted: false,
        wrapped_content_key: 'wrap-1', wrapped_content_key_nonce: 'wrapn-1',
      },
      // The metadata blob is where the sidebar name comes from, and
      // setNotebookMembers refuses to write without one.
      {
        id: 'meta', item_type: 10, encrypted_content: 'mct', content_nonce: 'mn',
        version: 1, deleted: false,
      },
    ]);
  };

  const MEMBER = {
    userId: 'u1', email: 'a@b.c', sharingPublicKey: 'pk',
    signingPublicKey: null, permission: 'view' as const,
  };

  /**
   * Sharing rewrites the whole document. Rebuilt from notebookItemContent it
   * would carry only the fields web models, so an android notebook would lose
   * its edit_mode the moment someone shared it — no error, the key just stops
   * being there.
   */
  it('sharing keeps the fields web does not model', async () => {
    await seedAndroidNotebook();
    apiRequest.mockResolvedValue({ success: true, data: { version: 4 } });

    expect(await notebooksStore.setNotebookMembers(NB, [MEMBER])).toBe(true);

    const written = lastWritten();
    expect(written.edit_mode).toBe('markdown');
    expect(written.members).toEqual([MEMBER]);
  });

  it('renaming keeps them too', async () => {
    await seedAndroidNotebook();
    apiRequest.mockResolvedValue({ success: true, data: { version: 4 } });

    await notebooksStore.renameNotebookItem(NB, 'Dinners');

    const written = lastWritten();
    expect(written.edit_mode).toBe('markdown');
    expect(written.title).toBe('Dinners');
  });

  it('does not reset a colour it was not asked to change', async () => {
    decryptWithContentKey.mockReturnValue(
      JSON.stringify({ title: 'Recipes', color: '#ff8800' }));
    await notebooksStore.loadFromSyncedItems([{
      id: NB, item_type: 2, encrypted_content: 'ct', content_nonce: 'n',
      version: 3, deleted: false,
      wrapped_content_key: 'wrap-1', wrapped_content_key_nonce: 'wrapn-1',
    }]);
    apiRequest.mockResolvedValue({ success: true, data: { version: 4 } });

    await notebooksStore.renameNotebookItem(NB, 'Dinners');

    expect(lastWritten().color).toBe('#ff8800');
  });

  /** Never opened here, so there is no base to merge over — writing a merge
   *  against an invented one would be worse than writing a fresh document. */
  it('falls back to a fresh document when it has never read the notebook', async () => {
    decryptWithContentKey.mockReturnValue(null);
    await notebooksStore.loadFromSyncedItems([{
      id: NB, item_type: 2, encrypted_content: 'ct', content_nonce: 'n',
      version: 3, deleted: false,
      wrapped_content_key: 'wrap-1', wrapped_content_key_nonce: 'wrapn-1',
    }]);
    apiRequest.mockResolvedValue({ success: true, data: { version: 4 } });

    await notebooksStore.renameNotebookItem(NB, 'Dinners');

    const written = lastWritten();
    expect(written.title).toBe('Dinners');
    expect(written.edit_mode).toBeUndefined();
  });
});
