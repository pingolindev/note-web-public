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
 * Which key opened a notebook here. A notebook whose wrap our vault opens is
 * ours: the inbox refuses a share naming it, and a new note in it never takes
 * an "owner" from the inbox. Nothing here opens a notebook through a share, so
 * nothing is ever 'share'.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const generateContentKey = vi.fn();
const wrapContentKeyWithVault = vi.fn();
const unwrapContentKeyWithVault = vi.fn();
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: (...a: unknown[]) => generateContentKey(...a),
  wrapContentKeyWithVault: (...a: unknown[]) => wrapContentKeyWithVault(...a),
  unwrapContentKeyWithVault: (...a: unknown[]) => unwrapContentKeyWithVault(...a),
  encryptWithContentKey: () => ({ ciphertext: 'ct', nonce: 'n' }),
  decryptWithContentKey: () => null,
  encryptNote: () => ({ ciphertext: 'ct', nonce: 'n' }),
  decryptNote: () => '{}',
}));

const NB = '33333333-3333-4333-8333-333333333333';
const THEIRS = '44444444-4444-4444-8444-444444444444';

let notebooksStore: typeof import('./notebooks').notebooksStore;
let isOwnNotebook: typeof import('../lib/ownNotes').isOwnNotebook;

/** A synced notebook item, wrapped under `wrap`. */
const item = (id: string, wrap: string | null) => ({
  id, item_type: 2, encrypted_content: 'ct', content_nonce: 'n', version: 3, deleted: false,
  wrapped_content_key: wrap, wrapped_content_key_nonce: wrap ? 'wn' : null,
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  ({ notebooksStore } = await import('./notebooks'));
  ({ isOwnNotebook } = await import('../lib/ownNotes'));
  generateContentKey.mockReturnValue(new Uint8Array(32).fill(7));
  wrapContentKeyWithVault.mockReturnValue({ wrappedKey: 'own-wrap', nonce: 'own-nonce' });
  // Our vault opens our own wraps only.
  unwrapContentKeyWithVault.mockImplementation((key: string) =>
    (key === 'own-wrap' || key === 'rotated-wrap' ? new Uint8Array(32).fill(7) : null));
});

describe('notebookOpenedVia', () => {
  it("is 'vault' for a synced notebook whose wrap our vault opens, and null for one it doesn't", () => {
    notebooksStore.loadFromSyncedItems([item(NB, 'own-wrap'), item(THEIRS, 'owners-wrap')]);
    expect(notebooksStore.notebookOpenedVia(NB)).toBe('vault');
    expect(notebooksStore.notebookOpenedVia(THEIRS)).toBeNull();
    expect(notebooksStore.notebookOpenedVia('55555555-5555-4555-8555-555555555555')).toBeNull();
  });

  it("is 'vault' for a notebook created here, and null when the create failed", async () => {
    apiRequest.mockResolvedValue({ success: false, status: 500 });
    await notebooksStore.writeNotebookItem(NB, 'Recipes');
    expect(notebooksStore.notebookOpenedVia(NB)).toBeNull();

    apiRequest.mockResolvedValue({ success: true, data: { version: 1 } });
    await notebooksStore.writeNotebookItem(NB, 'Recipes');
    expect(notebooksStore.notebookOpenedVia(NB)).toBe('vault');
  });

  it("is 'vault' after a rotation here and after a rename that minted its first key", async () => {
    notebooksStore.adoptRotatedNotebookKey(NB, { wrappedKey: 'rotated-wrap', nonce: 'rn', version: 4 });
    expect(notebooksStore.notebookOpenedVia(NB)).toBe('vault');

    // A notebook written before wraps were captured: the first rename mints.
    notebooksStore.loadFromSyncedItems([item(THEIRS, null)]);
    expect(notebooksStore.notebookOpenedVia(THEIRS)).toBeNull();
    apiRequest.mockResolvedValue({ success: true, data: { version: 4 } });
    await notebooksStore.renameNotebookItem(THEIRS, 'First');
    expect(notebooksStore.notebookOpenedVia(THEIRS)).toBe('vault');
  });
});

describe('the own-notebook check the inbox asks', () => {
  it('answers for every spelling of a notebook our vault opened, and for nothing else', () => {
    notebooksStore.loadFromSyncedItems([item(NB, 'own-wrap'), item(THEIRS, 'owners-wrap')]);
    for (const spelling of [NB, NB.toUpperCase(), NB.replace(/-/g, ''), NB.replace(/-/g, '').toUpperCase()]) {
      expect(isOwnNotebook(spelling)).toBe(true);
    }
    expect(isOwnNotebook(THEIRS)).toBe(false);
    for (const bad of [`{${NB}}`, `urn:uuid:${NB}`, ` ${NB}`, 'not-an-id', '']) {
      expect(isOwnNotebook(bad)).toBe(false);
    }
  });

  /**
   * NB above is digits only, so its "other spellings" differ by hyphens alone.
   * These ids have letters: upper case is another spelling of them.
   */
  const LETTERS = 'abcdef12-3456-4abc-8def-abcdef123456';
  const OTHER = 'fedcba98-7654-4fed-8cba-fedcba987654';

  it('answers for every spelling of an id that has letters, however the notebook itself is spelled here', () => {
    // Held under an upper-case spelling, asked in canonical form and others.
    notebooksStore.loadFromSyncedItems([item(LETTERS.toUpperCase(), 'own-wrap'), item(OTHER, 'owners-wrap')]);
    for (const spelling of [LETTERS, LETTERS.toUpperCase(), LETTERS.replace(/-/g, ''), LETTERS.replace(/-/g, '').toUpperCase()]) {
      expect(isOwnNotebook(spelling), spelling).toBe(true);
    }
    for (const spelling of [OTHER, OTHER.toUpperCase(), OTHER.replace(/-/g, '')]) {
      expect(isOwnNotebook(spelling), spelling).toBe(false);
    }
  });

  /** An id's canonical form is worked out once. Everything else is asked each time. */
  it('follows what is known: asked before the notebook is synced, and again after', () => {
    expect(isOwnNotebook(LETTERS)).toBe(false);
    notebooksStore.loadFromSyncedItems([item(LETTERS, 'own-wrap')]);
    expect(isOwnNotebook(LETTERS)).toBe(true);
    expect(isOwnNotebook(OTHER)).toBe(false);
    notebooksStore.loadFromSyncedItems([item(OTHER, 'own-wrap')]);
    expect(isOwnNotebook(OTHER)).toBe(true);
  });

  it('asks which key opens the notebook each time: the same notebook, another answer once the vault opens it', () => {
    notebooksStore.loadFromSyncedItems([item(LETTERS, 'later-wrap')]);
    expect(isOwnNotebook(LETTERS)).toBe(false);
    unwrapContentKeyWithVault.mockImplementation((key: string) => (key === 'later-wrap' ? new Uint8Array(32).fill(7) : null));
    expect(isOwnNotebook(LETTERS)).toBe(true);
    unwrapContentKeyWithVault.mockImplementation(() => null);
    expect(isOwnNotebook(LETTERS)).toBe(false);
  });

  it('works out an id\'s canonical form once, however many shares ask', async () => {
    const account = await import('../lib/account');
    const canonical = vi.spyOn(account, 'tryCanonicalAccountId');
    notebooksStore.loadFromSyncedItems([item(LETTERS, 'own-wrap'), item(OTHER, 'owners-wrap')]);
    canonical.mockClear();
    const SHARED_ITEM = '0a0a0a0a-0000-4000-8000-00000000000a';
    for (let i = 0; i < 50; i++) expect(isOwnNotebook(SHARED_ITEM)).toBe(false);
    // Once per question for the id asked about, and once per notebook in all: not 50 times each.
    const forNotebooks = canonical.mock.calls.filter(c => c[0] === LETTERS || c[0] === OTHER).length;
    expect(forNotebooks).toBeLessThanOrEqual(2);
    canonical.mockRestore();
  });
});
