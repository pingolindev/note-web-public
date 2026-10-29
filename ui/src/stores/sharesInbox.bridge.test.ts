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
 * The inbox opens share wraps through lib/keyOps: locally in a browser,
 * over the native bridge in the iOS shell. Two things must hold:
 *   - only wraps the trust verdict lets through are ever sent to be opened;
 *   - a bridge that fails OUTRIGHT leaves the inbox as it was for the next
 *     sync. Treating it as "this wrap does not open" would mark every share
 *     unreadable over a transient error.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const getPinnedUserKeys = vi.fn();
vi.mock('../lib/crypto', () => ({
  getPinnedUserKeys: (...a: unknown[]) => getPinnedUserKeys(...a),
  pinUserKeys: vi.fn(),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  verifyNoteShareWrapGen: () => ({ verified: false, effectiveGeneration: 0 }),
  approveUserKeyChange: vi.fn(),
  computeSafetyNumber: vi.fn(),
}));
const openSealedKeys = vi.fn();
vi.mock('../lib/keyOps', () => ({ openSealedKeys: (...a: unknown[]) => openSealedKeys(...a) }));
vi.mock('./auth', () => ({ authStore: { user: () => ({ id: ME }) } }));
vi.mock('./notes', () => ({ extrasFrom: () => ({}) }));

const ME = '11111111-1111-4111-8111-111111111111';
const SENDER = '22222222-2222-4222-8222-222222222222';
// Ids are UUIDs: the inbox refuses any other.
const PINNED_SENDER = '33333333-3333-4333-8333-333333333333';
const I1 = 'c1c1c1c1-0000-4000-8000-0000000000c1';
const I2 = 'c2c2c2c2-0000-4000-8000-0000000000c2';
const I3 = 'c3c3c3c3-0000-4000-8000-0000000000c3';

/** This account's floors and item owners live in its per-account storage:
 * the tab's account is confirmed, over an in-memory storage. */
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
const local = memoryStorage();
vi.stubGlobal('localStorage', local);
(await import('../lib/account')).setTabAccount(ME);

const { sharesInboxStore } = await import('./sharesInbox');

function share(over: Record<string, unknown> = {}) {
  return {
    share_id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    item_id: 'bbbbbbbb-0000-4000-8000-00000000000b',
    owner_id: SENDER,
    permission: 'edit',
    wrapped_key: 'd3JhcHBlZA==',
    sharer_public_key: 'aa'.repeat(32),
    owner_email: 'sender@example.com',
    owner_directory_user_id: SENDER,
    owner_directory_sharing_key: 'aa'.repeat(32),
    owner_directory_signing_key: 'bb'.repeat(32),
    wrap_signature: null,
    content_key_generation: 1,
    encrypted_content: JSON.stringify({ title: 'Shared thing' }),
    content_nonce: 'bm9uY2U=',
    updated_at: '2026-09-23T00:00:00.000Z',
    created_at: '2026-09-23T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  local.clear();
  apiRequest.mockReset();
  openSealedKeys.mockReset();
  getPinnedUserKeys.mockReset().mockReturnValue(null);
});

describe('opening incoming share keys', () => {
  it('opens only what the verdict lets through, in one batch', async () => {
    // Pinned sender + no signature = stripped: must never be sent to be opened.
    getPinnedUserKeys.mockImplementation((id: string) =>
      id === PINNED_SENDER ? { sharingPubkeyHex: 'aa'.repeat(32), signingPubkeyHex: 'bb'.repeat(32) } : null);
    apiRequest.mockResolvedValue({
      success: true,
      data: [
        share({ share_id: 's1', item_id: I1, wrapped_key: 'b3Blbg==' }),
        share({ share_id: 's2', item_id: I2, owner_id: PINNED_SENDER, wrapped_key: 'c3RyaXBwZWQ=' }),
        share({ share_id: 's3', item_id: I3, wrapped_key: null }),
      ],
    });
    openSealedKeys.mockResolvedValue([new Uint8Array(32).fill(1)]);

    expect(await sharesInboxStore.load()).toBe(true);
    expect(openSealedKeys).toHaveBeenCalledTimes(1);
    expect(openSealedKeys).toHaveBeenCalledWith(['b3Blbg=='], expect.any(Function));
    expect(sharesInboxStore.shares().map(s => s.itemId)).toEqual([I1]);
    expect(sharesInboxStore.shares()[0].note?.title).toBe('Shared thing');
  });

  /** The opening of a large inbox outlasts the minute a sync may be quiet. */
  it('hands the opening its caller\'s sign of life, to be given at each key opened', async () => {
    apiRequest.mockResolvedValue({ success: true, data: [share({ share_id: 's1', item_id: I1 })] });
    const alive = vi.fn();
    openSealedKeys.mockImplementation(async (_sealed: string[], onReply: () => void) => {
      const before = alive.mock.calls.length;
      onReply();
      onReply();
      expect(alive.mock.calls.length).toBe(before + 2);
      return [new Uint8Array(32).fill(1)];
    });
    expect(await sharesInboxStore.load(alive)).toBe(true);
    expect(openSealedKeys).toHaveBeenCalledTimes(1);
  });

  it('and each piece of an inbox page that arrives is one too', async () => {
    apiRequest.mockResolvedValue({ success: true, data: [] });
    const alive = vi.fn();
    await sharesInboxStore.load(alive);
    const page = apiRequest.mock.calls.find(c => String(c[0]).startsWith('/api/v1/shares/inbox'));
    expect(page).toBeTruthy();
    const before = alive.mock.calls.length;
    (page![1] as { onProgress: () => void }).onProgress();
    expect(alive.mock.calls.length).toBe(before + 1);
  });

  it('keeps the inbox as it was when the bridge itself fails', async () => {
    apiRequest.mockResolvedValue({ success: true, data: [share({ share_id: 's1', item_id: I1 })] });
    openSealedKeys.mockResolvedValue([new Uint8Array(32).fill(1)]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares().map(s => s.itemId)).toEqual([I1]);

    openSealedKeys.mockRejectedValue(new Error('signed out'));
    expect(await sharesInboxStore.load()).toBe(false);
    // Not emptied, not re-graded as unreadable.
    expect(sharesInboxStore.shares().map(s => s.itemId)).toEqual([I1]);
    expect(sharesInboxStore.blockedShares()).toEqual([]);
  });
});
