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
 * The metadata blob's version conflict is recovered, not wedged.
 *
 * WHY THESE EXIST
 *   `persistToServer` PUTs the single item_type=10 row under a version CAS. A
 *   409 left unrecovered keeps `metadataVersion` stale, so EVERY later write
 *   409s too: the sidebar keeps accepting notebooks, label colours, share
 *   recipients and pins that never reach the server, until logout. (Android
 *   self-heals from the epoch.) A 409 from the CREATE — another device made the
 *   row first — must not throw the write away either, or `metadataItemId` stays
 *   null forever.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

// Ciphertext IS the plaintext here, so a test can read what was written.
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

type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];

function route(handler: (c: Call) => unknown) {
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
    calls.push(c);
    return handler(c);
  });
}

const metaPuts = (id: string) => calls.filter(c => c.method === 'PUT' && c.url === `/api/v1/items/${id}`);
const metaPosts = () => calls.filter(c => c.method === 'POST' && c.url === '/api/v1/items' && c.body?.item_type === 10);
const blob = (c: Call) => JSON.parse(c.body.encrypted_content);
const names = (nbs: { name: string }[]) => nbs.map(n => n.name).sort();

let notebooksStore: typeof import('./notebooks').notebooksStore;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  ({ notebooksStore } = await import('./notebooks'));
});

const META = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm';

function synced(version: number, meta: unknown) {
  notebooksStore.loadFromSyncedItems([{
    id: META, item_type: 10, version, deleted: false,
    encrypted_content: JSON.stringify(meta), content_nonce: 'n',
    updated_at: '2026-09-01T00:00:00Z',
  }]);
}

describe('a 409 on the metadata PUT', () => {
  it('re-reads the server row, merges, and retries against the server version', async () => {
    synced(4, { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: {} });
    let serverVersion = 5; // another device already wrote v5
    const serverBlob = { notebooks: [{ id: 'nb1', name: 'Work' }, { id: 'nbS', name: 'From the phone' }], labelColors: { urgent: '#f00' } };
    route(c => {
      if (c.method === 'PUT' && c.url === `/api/v1/items/${META}`) {
        if (c.body.expected_version !== serverVersion) {
          return { success: false, status: 409, error_code: 'item_version_conflict', error: 'conflict' };
        }
        serverVersion += 1;
        return { success: true, data: { id: META, version: serverVersion } };
      }
      if (c.method === 'GET' && c.url === `/api/v1/items/${META}`) {
        return { success: true, data: { id: META, version: serverVersion, encrypted_content: JSON.stringify(serverBlob), content_nonce: 'n' } };
      }
      // the notebook ITEM write that create() also does
      if (c.method === 'POST') return { success: true, data: { id: c.body.id, version: 1 } };
      return { success: true, data: [] };
    });

    notebooksStore.create('Home');
    await vi.waitFor(() => expect(metaPuts(META).length).toBe(2));

    const [first, retry] = metaPuts(META);
    expect(first.body.expected_version).toBe(4);
    expect(retry.body.expected_version).toBe(5);
    // Ours kept, theirs kept, nothing lost.
    expect(names(blob(retry).notebooks)).toEqual(['From the phone', 'Home', 'Work']);
    expect(blob(retry).labelColors).toEqual({ urgent: '#f00' });
    expect(names(notebooksStore.notebooks())).toEqual(['From the phone', 'Home', 'Work']);

    // Not wedged: the next write goes straight through at the new version.
    notebooksStore.setLabelColor('todo', '#0f0');
    await vi.waitFor(() => expect(metaPuts(META).length).toBe(3));
    expect(metaPuts(META)[2].body.expected_version).toBe(6);
    expect(blob(metaPuts(META)[2]).labelColors).toEqual({ urgent: '#f00', todo: '#0f0' });
  });

  it('honours a recipient removed locally while keeping one the phone added', async () => {
    synced(2, { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: {}, notebookShares: { nb1: [{ email: 'a@x.test', permission: 'edit' }] } });
    const serverBlob = { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: {}, notebookShares: { nb1: [
      { email: 'a@x.test', permission: 'edit' },
      { email: 'b@x.test', permission: 'view' },
    ] } };
    let serverVersion = 3;
    route(c => {
      if (c.method === 'PUT' && c.url === `/api/v1/items/${META}`) {
        if (c.body.expected_version !== serverVersion) return { success: false, status: 409, error: 'conflict' };
        serverVersion += 1;
        return { success: true, data: { id: META, version: serverVersion } };
      }
      if (c.method === 'GET') return { success: true, data: { id: META, version: serverVersion, encrypted_content: JSON.stringify(serverBlob), content_nonce: 'n' } };
      return { success: true, data: [] };
    });

    notebooksStore.removeNotebookShare('nb1', 'a@x.test');
    await vi.waitFor(() => expect(metaPuts(META).length).toBe(2));
    expect(blob(metaPuts(META)[1]).notebookShares).toEqual({ nb1: [{ email: 'b@x.test', permission: 'view' }] });
    expect(notebooksStore.getNotebookShares('nb1').map(r => r.email)).toEqual(['b@x.test']);
  });

  it('does not wedge when the re-read fails: the next write re-reads again', async () => {
    synced(4, { notebooks: [], labelColors: {} });
    let getAttempts = 0;
    let serverVersion = 5;
    route(c => {
      if (c.method === 'PUT' && c.url === `/api/v1/items/${META}`) {
        if (c.body.expected_version !== serverVersion) return { success: false, status: 409, error: 'conflict' };
        serverVersion += 1;
        return { success: true, data: { id: META, version: serverVersion } };
      }
      if (c.method === 'GET') {
        getAttempts += 1;
        if (getAttempts === 1) return { success: false, status: undefined, error: 'offline' };
        return { success: true, data: { id: META, version: serverVersion, encrypted_content: JSON.stringify({ notebooks: [], labelColors: {} }), content_nonce: 'n' } };
      }
      return { success: true, data: [] };
    });

    notebooksStore.setLabelColor('a', '#000');
    await vi.waitFor(() => expect(getAttempts).toBe(1));
    expect(metaPuts(META)).toHaveLength(1);

    notebooksStore.setLabelColor('b', '#111');
    await vi.waitFor(() => expect(metaPuts(META).length).toBe(3));
    expect(metaPuts(META)[2].body.expected_version).toBe(5);
    expect(blob(metaPuts(META)[2]).labelColors).toEqual({ a: '#000', b: '#111' });
  });
});

describe('a 409 on the metadata POST (another device created the row first)', () => {
  it('adopts the existing row from a pull and retries as an update', async () => {
    const X = 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx';
    let serverVersion = 3;
    route(c => {
      if (c.method === 'POST' && c.url === '/api/v1/items' && c.body.item_type === 10) {
        return { success: false, status: 409, error_code: 'item_metadata_exists', error: 'exists' };
      }
      if (c.method === 'POST') return { success: true, data: { id: c.body.id, version: 1 } };
      if (c.url.startsWith('/api/v1/sync/pull')) {
        return { success: true, data: {
          items: [
            { id: 'old', item_type: 10, deleted: true, version: 9, encrypted_content: '{"notebooks":[{"id":"dead","name":"Trashed"}]}', content_nonce: 'n', updated_at: '2026-09-05T00:00:00Z' },
            { id: 'n1', item_type: 1, deleted: false, version: 1, encrypted_content: '{}', content_nonce: 'n', updated_at: '2026-09-05T00:00:00Z' },
            { id: X, item_type: 10, deleted: false, version: serverVersion, encrypted_content: JSON.stringify({ notebooks: [{ id: 'nbS', name: 'Phone' }], labelColors: {} }), content_nonce: 'n', updated_at: '2026-09-06T00:00:00Z' },
          ],
          cursor: null, cursor_id: null, has_more: false,
        } };
      }
      if (c.method === 'PUT' && c.url === `/api/v1/items/${X}`) {
        if (c.body.expected_version !== serverVersion) return { success: false, status: 409, error: 'conflict' };
        serverVersion += 1;
        return { success: true, data: { id: X, version: serverVersion } };
      }
      return { success: true, data: [] };
    });

    // This session has pulled, and the pull didn't bring the metadata row (with
    // no base, nothing is written before the first pull).
    notebooksStore.markPulled();
    notebooksStore.create('Home');
    await vi.waitFor(() => expect(metaPuts(X).length).toBe(1));
    expect(metaPosts()).toHaveLength(1);
    expect(metaPuts(X)[0].body.expected_version).toBe(3);
    expect(names(blob(metaPuts(X)[0]).notebooks)).toEqual(['Home', 'Phone']);

    // The id is adopted for good: the next write is a PUT to X at v4, not
    // another POST.
    notebooksStore.setLabelColor('todo', '#0f0');
    await vi.waitFor(() => expect(metaPuts(X).length).toBe(2));
    expect(metaPosts()).toHaveLength(1);
    expect(metaPuts(X)[1].body.expected_version).toBe(4);
  });
});

describe('a 404 on the metadata PUT (the row is gone)', () => {
  it('forgets the id and creates a fresh row', async () => {
    synced(4, { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: {} });
    route(c => {
      if (c.method === 'PUT' && c.url === `/api/v1/items/${META}`) return { success: false, status: 404, error: 'gone' };
      if (c.method === 'POST' && c.body?.item_type === 10) return { success: true, data: { id: 'fresh', version: 1 } };
      if (c.method === 'POST') return { success: true, data: { id: c.body.id, version: 1 } };
      if (c.method === 'PUT' && c.url === '/api/v1/items/fresh') return { success: true, data: { id: 'fresh', version: 2 } };
      return { success: true, data: [] };
    });
    notebooksStore.create('Home');
    await vi.waitFor(() => expect(metaPosts().length).toBe(1));
    expect(names(blob(metaPosts()[0]).notebooks)).toEqual(['Home', 'Work']);

    notebooksStore.setLabelColor('todo', '#0f0');
    await vi.waitFor(() => expect(metaPuts('fresh').length).toBe(1));
    expect(metaPuts('fresh')[0].body.expected_version).toBe(1);
  });
});

/**
 * An invitation's finish must not act on this device's list alone. Another
 * of the owner's devices may have removed the person: the list is read from
 * the server again before anything is shared, and the finish waits for its
 * own write, whose merge takes such a removal in.
 */
describe('the standing list as the server holds it, for an invitation\'s finish', () => {
  const zoeWaiting = { email: 'zoe@x.test', permission: 'edit', publicKey: null };

  it('is read from the server row again, not taken from this device', async () => {
    synced(2, { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: {}, notebookShares: { nb1: [{ email: 'a@x.test', permission: 'edit' }, zoeWaiting] } });
    // Another device has removed Zoe since.
    const serverBlob = { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: {}, notebookShares: { nb1: [{ email: 'a@x.test', permission: 'edit' }] } };
    route(c => (c.method === 'GET' && c.url === `/api/v1/items/${META}`
      ? { success: true, data: { id: META, version: 3, encrypted_content: JSON.stringify(serverBlob), content_nonce: 'n' } }
      : { success: true, data: [] }));
    expect((await notebooksStore.serverStandingOf('nb1'))?.map(r => r.email)).toEqual(['a@x.test']);
    expect(notebooksStore.getNotebookShares('nb1').map(r => r.email)).toEqual(['a@x.test', 'zoe@x.test']);
    expect(await notebooksStore.serverStandingOf('nb-none')).toEqual([]);
  });

  it('is nothing when the row cannot be read', async () => {
    synced(2, { notebooks: [], labelColors: {} });
    route(() => ({ success: false, status: 503, error: 'down' }));
    expect(await notebooksStore.serverStandingOf('nb1')).toBeNull();
  });

  it('a finish waits for its write, and then sees the removal the write merged in', async () => {
    synced(2, { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: {}, notebookShares: { nb1: [zoeWaiting] } });
    // Another device removed Zoe and wrote version 3.
    const serverBlob = { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: {}, notebookShares: { nb1: [] } };
    let serverVersion = 3;
    route(c => {
      if (c.method === 'PUT' && c.url === `/api/v1/items/${META}`) {
        if (c.body.expected_version !== serverVersion) return { success: false, status: 409, error: 'conflict' };
        serverVersion += 1;
        return { success: true, data: { id: META, version: serverVersion } };
      }
      if (c.method === 'GET') return { success: true, data: { id: META, version: serverVersion, encrypted_content: JSON.stringify(serverBlob), content_nonce: 'n' } };
      return { success: true, data: [] };
    });
    const withKeys = { email: 'zoe@x.test', permission: 'edit' as const, publicKey: 'pk', userId: 'zoe-id', signingPublicKey: 'sk' };
    expect(notebooksStore.finishNotebookShare('nb1', withKeys)).toBe(true);
    // Before the write lands this device's list has them, with their keys ...
    expect(notebooksStore.getNotebookShares('nb1').map(r => r.email)).toEqual(['zoe@x.test']);
    await notebooksStore.whenWritten();
    // ... and once it has, the merge took the other device's removal in.
    expect(notebooksStore.getNotebookShares('nb1')).toEqual([]);
  });
});
