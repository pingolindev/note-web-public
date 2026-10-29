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

// Graduated fail-closed on the RECEIVE side, pinned to the behaviour of
// Note Android (SharesInboxRepository) and Note iOS (SharesInboxStore):
//
//   unsigned + UNPINNED sender -> shown, graded 'unverified', TOFU-pinned
//   unsigned + PINNED sender   -> dropped ('unsigned-stripped'), never opened
//   no wrapped key             -> dropped ('no-key'), never opened
//
// Rejecting EVERY unsigned wrap, pinned or not, and filtering the rejects
// out of the list would leave a share from an unpinned sender with no row,
// no error and no badge, and the recipient told nothing at all. These tests
// guard against that silence: every dropped share must still turn up in
// blockedShares().

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const getPinnedUserKeys = vi.fn();
const pinUserKeys = vi.fn();
const unwrapContentKeyFromSender = vi.fn();
const decryptWithContentKey = vi.fn();
const verifyNoteShareWrapGen = vi.fn();
vi.mock('../lib/crypto', () => ({
  getPinnedUserKeys: (...a: unknown[]) => getPinnedUserKeys(...a),
  pinUserKeys: (...a: unknown[]) => pinUserKeys(...a),
  unwrapContentKeyFromSender: (...a: unknown[]) => unwrapContentKeyFromSender(...a),
  decryptWithContentKey: (...a: unknown[]) => decryptWithContentKey(...a),
  verifyNoteShareWrapGen: (...a: unknown[]) => verifyNoteShareWrapGen(...a),
  approveUserKeyChange: vi.fn(),
  computeSafetyNumber: vi.fn(),
}));

vi.mock('./auth', () => ({ authStore: { user: () => ({ id: ME }) } }));
// notes.ts pulls in the whole note pipeline (and imports this store back), so
// stub the two symbols sharesInbox actually needs.
vi.mock('./notes', () => ({ extrasFrom: () => ({}) }));

const ME = '11111111-1111-4111-8111-111111111111';
const SENDER = '22222222-2222-4222-8222-222222222222';

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

/** One inbox row; overrides win. */
function share(over: Record<string, unknown> = {}) {
  return {
    share_id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    item_id: 'bbbbbbbb-0000-4000-8000-00000000000b',
    owner_id: SENDER,
    permission: 'edit',
    wrapped_key: 'd3JhcHBlZA==',
    sharer_public_key: 'aa'.repeat(32),
    owner_email: 'sender@example.com',
    wrap_signature: null,
    content_key_generation: 1,
    encrypted_content: 'Y2lwaGVy',
    content_nonce: 'bm9uY2U=',
    updated_at: '2026-08-19T01:19:44.000Z',
    created_at: '2026-08-19T01:19:44.000Z',
    ...over,
  };
}

/** Wire apiRequest: inbox rows, then the sender-directory lookup. */
function serve(rows: unknown[], directory = true) {
  apiRequest.mockImplementation((url: string) => {
    if (url === '/api/v1/shares/inbox?page_info=true') return Promise.resolve({ success: true, data: rows });
    if (url === '/api/v1/users/public-keys') {
      return Promise.resolve({
        success: true,
        data: {
          users: directory
            ? [{
                email: 'sender@example.com',
                user_id: SENDER,
                sharing_public_key: 'aa'.repeat(32),
                signing_public_key: 'bb'.repeat(32),
              }]
            : [],
        },
      });
    }
    return Promise.resolve({ success: false });
  });
}

beforeEach(() => {
  local.clear();
  vi.clearAllMocks();
  getPinnedUserKeys.mockReturnValue(null);
  unwrapContentKeyFromSender.mockReturnValue(new Uint8Array(32));
  decryptWithContentKey.mockReturnValue(JSON.stringify({ title: 'Hi', body: 'there' }));
  verifyNoteShareWrapGen.mockReturnValue({ verified: true, effectiveGeneration: 1 });
});

describe('unsigned wrap from an UNPINNED sender (TOFU first contact)', () => {
  it('is shown, not silently swallowed', async () => {
    serve([share({ wrap_signature: null })]);
    await sharesInboxStore.load();

    expect(sharesInboxStore.shares()).toHaveLength(1);
    expect(sharesInboxStore.shares()[0].wrapTrust).toBe('unverified');
    // Decrypted and materialized — the note actually renders.
    expect(sharesInboxStore.shares()[0].note?.title).toBe('Hi');
    expect(sharesInboxStore.blockedShares()).toHaveLength(0);
  });

  it('TOFU-pins the sender so their NEXT unsigned wrap is refused', async () => {
    serve([share({ wrap_signature: null })]);
    await sharesInboxStore.load();
    expect(pinUserKeys).toHaveBeenCalledWith(SENDER, 'aa'.repeat(32), 'bb'.repeat(32));
  });

  it('never unwraps when there is no wrapped key to open', async () => {
    serve([share({ wrapped_key: null, wrap_signature: null })]);
    await sharesInboxStore.load();

    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    const blocked = sharesInboxStore.blockedShares();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].wrapTrust).toBe('no-key');
    expect(blocked[0].sharerEmail).toBe('sender@example.com');
  });
});

describe('unsigned wrap from a PINNED sender (signature stripped)', () => {
  beforeEach(() => {
    getPinnedUserKeys.mockReturnValue({
      sharingPubkeyHex: 'aa'.repeat(32),
      signingPubkeyHex: 'bb'.repeat(32),
    });
  });

  it('is dropped WITHOUT touching the key material', async () => {
    serve([share({ wrap_signature: null })]);
    await sharesInboxStore.load();

    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    expect(decryptWithContentKey).not.toHaveBeenCalled();
  });

  it('is still REPORTED to the recipient rather than vanishing', async () => {
    serve([share({ wrap_signature: null })]);
    await sharesInboxStore.load();

    const blocked = sharesInboxStore.blockedShares();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].wrapTrust).toBe('unsigned-stripped');
    expect(blocked[0].reason).toMatch(/couldn't be confirmed as coming from its sender/i);
  });

  it('still accepts a wrap that verifies against the pin', async () => {
    serve([share({ wrap_signature: 'cc'.repeat(64) })]);
    await sharesInboxStore.load();

    expect(sharesInboxStore.shares()).toHaveLength(1);
    expect(sharesInboxStore.shares()[0].wrapTrust).toBe('verified');
    expect(sharesInboxStore.blockedShares()).toHaveLength(0);
  });

  it('drops AND reports a signature that fails against the pin', async () => {
    verifyNoteShareWrapGen.mockReturnValue({ verified: false, effectiveGeneration: 0 });
    serve([share({ wrap_signature: 'cc'.repeat(64) })]);
    await sharesInboxStore.load();

    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    expect(sharesInboxStore.blockedShares()[0].wrapTrust).toBe('invalid');
  });
});

describe('a share that is kept but cannot be decrypted', () => {
  it('is reported too — NotesView renders nothing for a null note', async () => {
    decryptWithContentKey.mockReturnValue(null);
    serve([share({ wrap_signature: null })]);
    await sharesInboxStore.load();

    expect(sharesInboxStore.shares()[0].note).toBeNull();
    expect(sharesInboxStore.blockedShares()).toHaveLength(1);
    expect(sharesInboxStore.blockedShares()[0].reason).toMatch(/is damaged, so it couldn't be opened/i);
  });
});
