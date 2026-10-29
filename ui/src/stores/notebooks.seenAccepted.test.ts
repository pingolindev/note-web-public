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
 * The acceptances THIS DEVICE remembers.
 *
 * The shared list of accepted notebooks is one encrypted document for every
 * device, and older clients may empty it after a single failed inbox request.
 * The notes of a notebook held until its invitation is accepted would then
 * leave the screen on every device. This memory is what stops that: kept
 * under the account on this device, learned from the shared list, forgotten
 * only when the inbox stops listing the notebook or the reader says no here.
 * The rules are lib/notebookInvites; this is the store keeping them.
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

/** This account's localStorage, by store name. */
const stored = new Map<string, string>();
let storageFails = false;
vi.mock('../lib/account', async (orig) => {
  const real = await orig<typeof import('../lib/account')>();
  return {
    ...real,
    scopedGetItem: (k: string) => stored.get(k) ?? null,
    scopedSetItem: (k: string, v: string) => { if (storageFails) throw new Error('QuotaExceededError'); stored.set(k, v); },
    scopedRemoveItem: (k: string) => { stored.delete(k); },
  };
});

const ACCOUNT = '0e0e0e0e-0000-4000-8000-00000000000e';
const KEY = 'pingolin_note_seen_accepted';
let notebooksStore: typeof import('./notebooks').notebooksStore;

async function start(opts: { accepted?: string[]; remembered?: string[] | string } = {}) {
  stored.clear();
  stored.set('pingolin_note_metadata', JSON.stringify({ notebooks: [], labelColors: {}, acceptedNotebooks: opts.accepted ?? [] }));
  if (opts.remembered !== undefined) stored.set(KEY, typeof opts.remembered === 'string' ? opts.remembered : JSON.stringify(opts.remembered));
  ({ notebooksStore } = await import('./notebooks'));
  const { setTabAccount } = await import('../lib/account');
  setTabAccount(null);
  setTabAccount(ACCOUNT);
  notebooksStore.beginHoldsRead().loaded([]);
}
const onDisk = () => JSON.parse(stored.get(KEY) ?? 'null');

beforeEach(async () => {
  await new Promise(r => setTimeout(r, 30));
  vi.clearAllMocks();
  vi.resetModules();
  storageFails = false;
  // A server that takes no write: what is remembered here must not depend on one.
  apiRequest.mockResolvedValue({ success: false, status: 503 });
});

describe('what the device remembers of the acceptances', () => {
  it('reads what the account stored, once the account is confirmed', async () => {
    await start({ remembered: ['nb1', 'nb2'] });
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1', 'nb2']);
  });

  it('reads an unreadable record as nothing remembered', async () => {
    await start({ remembered: '{not json' });
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual([]);
  });

  it('learns the shared list, and stores it under the account', async () => {
    await start({ accepted: ['nb1', 'nb2'] });
    notebooksStore.rememberAcceptances(null);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1', 'nb2']);
    expect(onDisk()).toEqual(['nb1', 'nb2']);
  });

  /** The case it exists for. */
  it('keeps a notebook the shared list has LOST while the inbox still lists it', async () => {
    await start({ accepted: [], remembered: ['nb1'] });
    notebooksStore.rememberAcceptances(new Set(['nb1', 'nb9']));
    expect(notebooksStore.acceptedNotebooks()).toEqual([]);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1']);
  });

  it('forgets a notebook the inbox no longer lists', async () => {
    await start({ accepted: ['nb1'], remembered: ['nb1', 'nb2'] });
    notebooksStore.rememberAcceptances(new Set(['nb1']));
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1']);
    expect(onDisk()).toEqual(['nb1']);
  });

  it('forgets nothing when the inbox gave no list', async () => {
    await start({ accepted: [], remembered: ['nb1', 'nb2'] });
    notebooksStore.rememberAcceptances(null);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1', 'nb2']);
  });

  /** It never writes into the shared list: it is a memory, not an acceptance. */
  it('never adds to the shared list, and asks the server for nothing', async () => {
    await start({ accepted: [], remembered: ['nb1'] });
    notebooksStore.rememberAcceptances(new Set(['nb1']));
    notebooksStore.rememberAcceptances(null);
    expect(notebooksStore.acceptedNotebooks()).toEqual([]);
    expect(notebooksStore.isNotebookAccepted('nb1')).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('the reader\'s own answer, given on this device', () => {
  it('an acceptance is remembered at once, whether or not the write lands', async () => {
    await start();
    await notebooksStore.setNotebookAccepted('nb3', true).catch(() => {});
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb3']);
    expect(onDisk()).toEqual(['nb3']);
  });

  it('a decline is forgotten at once', async () => {
    await start({ accepted: ['nb3'], remembered: ['nb3'] });
    await notebooksStore.setNotebookAccepted('nb3', false).catch(() => {});
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual([]);
    expect(onDisk()).toEqual([]);
  });

  /**
   * The shared list had already lost the notebook, so declining changes
   * nothing in it and returns early. The device must still stop remembering.
   */
  it('a decline of a notebook the shared list had already lost is still a no', async () => {
    await start({ accepted: [], remembered: ['nb1'] });
    await notebooksStore.setNotebookAccepted('nb1', false);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual([]);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('where it is kept', () => {
  it('is one of the account\'s own stores: swept at sign-out, and never read as another account\'s', async () => {
    const { ACCOUNT_SCOPED_STORES } = await import('../lib/account');
    expect(ACCOUNT_SCOPED_STORES).toContain(KEY);
  });

  it('is read again when the account is confirmed anew', async () => {
    await start({ remembered: ['nb1'] });
    stored.set(KEY, JSON.stringify(['other']));
    const { setTabAccount } = await import('../lib/account');
    setTabAccount(null);
    setTabAccount(ACCOUNT);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['other']);
  });

  /** A full or forbidden storage costs the memory at the next load, not this page's. */
  it('a storage that cannot be written still remembers for this page', async () => {
    await start();
    storageFails = true;
    await expect(notebooksStore.setNotebookAccepted('nb1', true).catch(() => {})).resolves.toBeUndefined();
    expect(() => notebooksStore.rememberAcceptances(null)).not.toThrow();
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1']);
    expect(onDisk()).toBeNull();
  });
});

/**
 * It learns the moment the shared list is READ here, not at the next sync.
 * A new browser with one accepted notebook would remember nothing after
 * sign-in and the first sync if the memory were brought up to date only at
 * the start of a sync, because the list arrives in the middle of that sync.
 */
describe('learning the shared list as soon as it is read', () => {
  const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
  const pulled = (acceptedNotebooks: string[] | undefined) => [{
    id: META, item_type: 10, deleted: false, version: 3, content_nonce: 'n', updated_at: 't',
    encrypted_content: JSON.stringify({ notebooks: [], labelColors: {}, ...(acceptedNotebooks ? { acceptedNotebooks } : {}) }),
  }];

  it('from this account\'s cache, when the account is confirmed', async () => {
    await start({ accepted: ['nb1', 'nb2'] });
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1', 'nb2']);
    expect(onDisk()).toEqual(['nb1', 'nb2']);
  });

  it('from the metadata a sync pulls', async () => {
    await start();
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual([]);
    notebooksStore.loadFromSyncedItems(pulled(['nb7']));
    expect(notebooksStore.acceptedNotebooks()).toEqual(['nb7']);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb7']);
    expect(onDisk()).toEqual(['nb7']);
  });

  /** The wipe itself, as it arrives: the pulled list has lost the notebook, and the device has not. */
  it('a pulled list that has LOST a notebook does not make the device forget it', async () => {
    await start({ accepted: ['nb1'] });
    notebooksStore.loadFromSyncedItems(pulled([]));
    expect(notebooksStore.acceptedNotebooks()).toEqual([]);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1']);
    notebooksStore.loadFromSyncedItems(pulled(undefined));
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['nb1']);
  });
});

/**
 * Two tabs of one account share the store. If each wrote its own whole
 * list, a tab that had not seen a decline made in the other one would
 * write the declined notebook back.
 */
describe('two tabs, one store', () => {
  it('learning here does not put back what the other tab forgot', async () => {
    await start({ remembered: ['a', 'b'] });
    stored.set(KEY, JSON.stringify(['a']));            // the other tab: 'b' was declined there
    await notebooksStore.setNotebookAccepted('c', true).catch(() => {});
    expect(onDisk()).toEqual(['a', 'c']);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['a', 'c']);
  });

  it('forgetting here does not lose what the other tab learned', async () => {
    await start({ remembered: ['a', 'b'] });
    stored.set(KEY, JSON.stringify(['a', 'b', 'z']));  // the other tab: 'z' was accepted there
    await notebooksStore.setNotebookAccepted('b', false).catch(() => {});
    expect(onDisk()).toEqual(['a', 'z']);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['a', 'z']);
  });

  /** Once a write has failed, the store is no longer this page's base: what it holds is all there is. */
  it('after a write that failed, the page goes on from what it holds', async () => {
    await start({ remembered: ['a'] });
    storageFails = true;
    await notebooksStore.setNotebookAccepted('b', true).catch(() => {});
    await notebooksStore.setNotebookAccepted('c', true).catch(() => {});
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual(['a', 'b', 'c']);
    expect(onDisk()).toEqual(['a']);
    storageFails = false;
    await notebooksStore.setNotebookAccepted('d', true).catch(() => {});
    expect(onDisk()).toEqual(['a', 'b', 'c', 'd']);
  });
});

/**
 * The third place the shared list is read: a write that met a newer row on
 * the server merges with it and adopts the result. What the server's row
 * says is accepted is learned there too.
 */
describe('learning from a merge with the server\'s row', () => {
  const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';
  const base = { notebooks: [], labelColors: {}, notebookShares: {}, acceptedNotebooks: [] as string[] };
  const serverNow = { ...base, acceptedNotebooks: ['nb-accepted-elsewhere'] };

  it('learns the acceptances the server\'s row carries', async () => {
    let serverVersion = 5;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
      const method = opts?.method ?? 'GET';
      if (method === 'PUT' && url === `/api/v1/items/${META}`) {
        if (opts!.body.expected_version !== serverVersion) return { success: false, status: 409, error: 'conflict' };
        serverVersion += 1;
        return { success: true, data: { version: serverVersion } };
      }
      if (method === 'GET' && url === `/api/v1/items/${META}`) {
        return { success: true, data: { id: META, version: serverVersion, encrypted_content: JSON.stringify(serverNow), content_nonce: 'n' } };
      }
      if (method === 'POST' && url === '/api/v1/items') return { success: false, status: 409, error: 'exists' };
      return { success: false, status: 404 };
    });
    stored.clear();
    stored.set('pingolin_note_metadata', JSON.stringify(base));
    stored.set('pingolin_note_metadata_base', JSON.stringify({ id: META, version: 4, blob: base }));
    ({ notebooksStore } = await import('./notebooks'));
    const { setTabAccount } = await import('../lib/account');
    setTabAccount(null);
    setTabAccount(ACCOUNT);
    notebooksStore.beginHoldsRead().loaded([]);
    expect(notebooksStore.seenAcceptedNotebooks()).toEqual([]);

    // A write at the stale version: 409, read the server's row, merge, adopt.
    await notebooksStore.setNotebookAccepted('nb-accepted-here', true);
    await new Promise(r => setTimeout(r, 30));

    expect(notebooksStore.acceptedNotebooks()).toContain('nb-accepted-elsewhere');
    expect(notebooksStore.seenAcceptedNotebooks()).toContain('nb-accepted-elsewhere');
    expect(notebooksStore.seenAcceptedNotebooks()).toContain('nb-accepted-here');
  });
});

