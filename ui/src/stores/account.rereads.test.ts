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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Stores that read their per-account values when the module loads — before
 * /auth/me has named the account — read them again once it has. Otherwise
 * the notebook list would stay empty until the next sync, and the "shared
 * with me" badge would count shares the account had already seen.
 */

const ME = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const SENDER = '22222222-2222-4222-8222-222222222222';

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  getPinnedUserKeys: () => null,
  pinUserKeys: vi.fn(),
  unwrapContentKeyFromSender: () => new Uint8Array(32),
  decryptWithContentKey: () => JSON.stringify({ title: 'Hi', body: 'there' }),
  verifyNoteShareWrapGen: () => ({ verified: true, effectiveGeneration: 1 }),
  approveUserKeyChange: vi.fn(),
  computeSafetyNumber: vi.fn(),
  generateContentKey: () => new Uint8Array(32),
  encryptWithContentKey: () => ({ ciphertext: 'ct', nonce: 'n' }),
  encryptNote: () => ({ ciphertext: 'ct', nonce: 'n' }),
  decryptNote: () => '{}',
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'n' }),
  unwrapContentKeyWithVault: () => null,
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

let local: Storage;
let account: typeof import('../lib/account');

beforeEach(async () => {
  local = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.resetModules();
  account = await import('../lib/account');
});
afterEach(() => vi.unstubAllGlobals());

describe('re-read once the account is confirmed', () => {
  it("the notebook list: this account's cached one, no other's", async () => {
    local.setItem(`pingolin_note_metadata.${ME}`, JSON.stringify({
      notebooks: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Trips' }], labelColors: {},
    }));
    const { notebooksStore } = await import('./notebooks');
    expect(notebooksStore.notebooks()).toEqual([]);
    account.setTabAccount(ME);
    expect(notebooksStore.notebooks().map(n => n.name)).toEqual(['Trips']);
    account.setTabAccount('bbbbbbbb-0000-4000-8000-0000000000bb');
    expect(notebooksStore.notebooks()).toEqual([]);
  });

  it("the inbox cursor: shares this account already saw are not counted again", async () => {
    local.setItem(`pingolin_note_inbox_last_seen.${ME}`, '2099-01-01T00:00:00.000Z');
    const { sharesInboxStore } = await import('./sharesInbox');
    // The inbox refreshes only in a tab whose account is confirmed (it reads
    // that account's floors and item owners first): here, one that holds no
    // cursor, before this account is confirmed.
    account.setTabAccount('bbbbbbbb-0000-4000-8000-0000000000bb');
    apiRequest.mockImplementation((url: string) => {
      if (url === '/api/v1/shares/inbox?page_info=true') {
        return Promise.resolve({ success: true, data: [{
          share_id: 'aaaaaaaa-0000-4000-8000-00000000000a', item_id: 'bbbbbbbb-0000-4000-8000-00000000000b',
          owner_id: SENDER, permission: 'edit', wrapped_key: 'd3JhcHBlZA==', sharer_public_key: 'aa'.repeat(32),
          owner_email: 'sender@example.com', wrap_signature: null, content_key_generation: 1,
          encrypted_content: 'Y2lwaGVy', content_nonce: 'bm9uY2U=',
          updated_at: '2026-08-19T01:19:44.000Z', created_at: '2026-08-19T01:19:44.000Z',
        }] });
      }
      if (url === '/api/v1/users/public-keys') {
        return Promise.resolve({ success: true, data: { users: [{
          email: 'sender@example.com', user_id: SENDER,
          sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32),
        }] } });
      }
      return Promise.resolve({ success: false });
    });
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(1);
    expect(sharesInboxStore.unreadCount()).toBe(1);
    account.setTabAccount(ME);
    expect(sharesInboxStore.unreadCount()).toBe(0);
  });
});
