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
 * The inbox's verdict reads every id canonical, binds each item to the owner
 * of the first share of it accepted here and refuses anyone else's, stops
 * when a trust store it keeps can't be read, and decides nothing without this
 * account's own id.
 */

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

let me: { id: string } | null = null;
vi.mock('./auth', () => ({ authStore: { user: () => me } }));
vi.mock('./notes', () => ({ extrasFrom: () => ({}) }));

const ME = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ITEM = 'bbbbbbbb-0000-4000-8000-00000000000b';
const HEX = (id: string) => id.replace(/-/g, '');
const NOT_CONFIRMED = "This share couldn't be confirmed as coming from its sender, so it wasn't opened. Check with them another way before trusting a new copy.";
const DAMAGED = "This share is damaged, so it couldn't be opened. Ask the sender to share it again.";

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

const FLOORS = `pingolin_note_gen_floor.${ME}`;
const OWNERS = `pingolin_note_item_owner.${ME}`;
const PIN = { signingPubkeyHex: 'bb'.repeat(32), sharingPubkeyHex: 'aa'.repeat(32) };

function share(over: Record<string, unknown> = {}) {
  return {
    share_id: `aaaaaaaa-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    item_id: ITEM,
    owner_id: OWNER,
    permission: 'edit',
    wrapped_key: 'd3JhcHBlZA==',
    sharer_public_key: 'aa'.repeat(32),
    owner_email: 'owner@example.com',
    wrap_signature: null,
    content_key_generation: 1,
    item_type: 1,
    encrypted_content: 'Y2lwaGVy',
    content_nonce: 'bm9uY2U=',
    updated_at: '2026-09-29T01:00:00.000Z',
    created_at: '2026-09-29T01:00:00.000Z',
    ...over,
  };
}

/** The directory: owner@ is OWNER, other@ is OTHER, liar@ names OTHER though its share names OWNER. */
function serve(rows: unknown[]) {
  apiRequest.mockImplementation((url: string) => {
    if (url === '/api/v1/shares/inbox?page_info=true') return Promise.resolve({ success: true, data: rows });
    if (url === '/api/v1/users/public-keys') {
      return Promise.resolve({
        success: true,
        data: { users: [
          { email: 'owner@example.com', user_id: OWNER, sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32) },
          { email: 'other@example.com', user_id: OTHER, sharing_public_key: 'cc'.repeat(32), signing_public_key: 'dd'.repeat(32) },
          { email: 'liar@example.com', user_id: OTHER, sharing_public_key: 'ee'.repeat(32), signing_public_key: 'ff'.repeat(32) },
        ] },
      });
    }
    return Promise.resolve({ success: false });
  });
}
const fetchedInbox = () => apiRequest.mock.calls.some(c => c[0] === '/api/v1/shares/inbox?page_info=true');
const owners = () => JSON.parse(local.getItem(OWNERS) ?? '{}');
const floors = () => JSON.parse(local.getItem(FLOORS) ?? '{}');

beforeEach(() => {
  local.clear();
  vi.clearAllMocks();
  me = { id: ME };
  getPinnedUserKeys.mockReturnValue(null);
  unwrapContentKeyFromSender.mockReturnValue(new Uint8Array(32).fill(7));
  decryptWithContentKey.mockReturnValue(JSON.stringify({ title: 'Shared', body: 'text' }));
  verifyNoteShareWrapGen.mockReturnValue({ verified: true, effectiveGeneration: 1 });
});

describe('every id the verdict reads is canonical', () => {
  it('refuses an item id that is no UUID as damaged, before any pin or verify', async () => {
    const bad = [`{${ITEM}}`, `urn:uuid:${ITEM}`, 'bbbbbbbb0-000-4000-8000-00000000000b', 'not-an-id'];
    serve(bad.map(item_id => share({ item_id })));
    expect(await sharesInboxStore.load()).toBe(true);
    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(getPinnedUserKeys).not.toHaveBeenCalled();
    expect(verifyNoteShareWrapGen).not.toHaveBeenCalled();
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    expect(sharesInboxStore.blockedShares().map(b => b.reason)).toEqual(bad.map(() => DAMAGED));
  });

  it('drops the owner\'s OLD signed wrap served under another spelling of a floored item (the forgery case)', async () => {
    local.setItem(FLOORS, JSON.stringify({ [ITEM]: 5 }));
    getPinnedUserKeys.mockReturnValue(PIN);
    verifyNoteShareWrapGen.mockReturnValue({ verified: true, effectiveGeneration: 3 });
    for (const spelling of [ITEM.toUpperCase(), HEX(ITEM), HEX(ITEM).toUpperCase()]) {
      serve([share({ item_id: spelling, wrap_signature: 'ab'.repeat(64) })]);
      await sharesInboxStore.load();
      expect(sharesInboxStore.shares()).toHaveLength(0);
      expect(sharesInboxStore.blockedShares()[0].wrapTrust).toBe('invalid');
    }
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    expect(floors()).toEqual({ [ITEM]: 5 });
  });

  it('folds stored floors kept under other spellings to their highest, and drops keys that are no UUID', async () => {
    local.setItem(FLOORS, JSON.stringify({ [ITEM.toUpperCase()]: 7, [HEX(ITEM)]: 4, 'not-an-id': 99 }));
    getPinnedUserKeys.mockReturnValue(PIN);
    verifyNoteShareWrapGen.mockReturnValue({ verified: true, effectiveGeneration: 6 });
    serve([share({ wrap_signature: 'ab'.repeat(64) })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);

    // A generation at the floor is taken, and the floor is saved canonical.
    verifyNoteShareWrapGen.mockReturnValue({ verified: true, effectiveGeneration: 8 });
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(1);
    expect(floors()).toEqual({ [ITEM]: 8 });
  });

  it('verifies, decrypts and records under the canonical ids, and finds the share under any spelling', async () => {
    getPinnedUserKeys.mockReturnValue(PIN);
    serve([share({ item_id: ITEM.toUpperCase(), owner_id: HEX(OWNER), wrap_signature: 'ab'.repeat(64) })]);
    await sharesInboxStore.load();
    expect(getPinnedUserKeys).toHaveBeenCalledWith(OWNER);
    expect(verifyNoteShareWrapGen.mock.calls[0][2]).toMatchObject({ senderUserId: OWNER, recipientUserId: ME, itemId: ITEM });
    expect(decryptWithContentKey.mock.calls[0][2]).toBe(ITEM);
    const s = sharesInboxStore.shares()[0];
    expect([s.itemId, s.ownerId, s.note?.id]).toEqual([ITEM, OWNER, ITEM]);
    expect(sharesInboxStore.getByItemId(HEX(ITEM).toUpperCase())?.shareId).toBe(s.shareId);
    expect(sharesInboxStore.getByItemId('not-an-id')).toBeUndefined();
  });
});

describe('an item is bound to the owner of its first accepted share', () => {
  it('binds on a first contact that opened, and refuses another owner\'s share of it afterwards', async () => {
    serve([share()]);
    await sharesInboxStore.load();
    expect(owners()).toEqual({ [ITEM]: OWNER });

    serve([share({ owner_id: OTHER, owner_email: 'other@example.com', wrap_signature: 'ab'.repeat(64) })]);
    getPinnedUserKeys.mockClear();
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
    const blocked = sharesInboxStore.blockedShares();
    expect(blocked.map(b => [b.itemId, b.wrapTrust, b.reason])).toEqual([[ITEM, 'invalid', NOT_CONFIRMED]]);
    expect(unwrapContentKeyFromSender).toHaveBeenCalledTimes(1);
    expect(getPinnedUserKeys).not.toHaveBeenCalled();
    expect(sharesInboxStore.keyChangeAlarms()).toHaveLength(0);
    expect(owners()).toEqual({ [ITEM]: OWNER });
  });

  it('keeps a binding through a refresh without the owner\'s share', async () => {
    serve([share()]);
    await sharesInboxStore.load();
    serve([]);
    await sharesInboxStore.load();
    expect(owners()).toEqual({ [ITEM]: OWNER });
    serve([share({ owner_id: OTHER, owner_email: 'other@example.com' })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(owners()).toEqual({ [ITEM]: OWNER });
  });

  it('binds on a share verified against the owner\'s pin, and never moves the floor for anyone else', async () => {
    getPinnedUserKeys.mockImplementation((id: string) => (id === OWNER || id === OTHER ? PIN : null));
    verifyNoteShareWrapGen.mockReturnValue({ verified: true, effectiveGeneration: 2 });
    serve([share({ wrap_signature: 'ab'.repeat(64) })]);
    await sharesInboxStore.load();
    expect(owners()).toEqual({ [ITEM]: OWNER });
    expect(floors()).toEqual({ [ITEM]: 2 });

    verifyNoteShareWrapGen.mockReturnValue({ verified: true, effectiveGeneration: 9 });
    serve([share({ owner_id: OTHER, owner_email: 'other@example.com', wrap_signature: 'ab'.repeat(64) })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(floors()).toEqual({ [ITEM]: 2 });
  });

  it('refuses both shares of an unbound item named by two owners in one refresh, and binds nothing', async () => {
    serve([share(), share({ owner_id: OTHER, owner_email: 'other@example.com' })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(sharesInboxStore.blockedShares()).toHaveLength(2);
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    expect(local.getItem(OWNERS)).toBeNull();
  });

  it('binds notebooks too', async () => {
    serve([share({ item_type: 2 })]);
    await sharesInboxStore.load();
    expect(owners()).toEqual({ [ITEM]: OWNER });
  });

  it('never binds a share it refused, nor a first contact that did not open', async () => {
    // A pinned owner's stripped signature: refused.
    getPinnedUserKeys.mockReturnValue(PIN);
    serve([share()]);
    await sharesInboxStore.load();
    expect(local.getItem(OWNERS)).toBeNull();
    // A first contact whose content does not decrypt.
    getPinnedUserKeys.mockReturnValue(null);
    decryptWithContentKey.mockReturnValue(null);
    serve([share()]);
    await sharesInboxStore.load();
    expect(local.getItem(OWNERS)).toBeNull();
  });

  it('matches the bound owner under any spelling, and reads stored bindings canonically', async () => {
    local.setItem(OWNERS, JSON.stringify({ [ITEM.toUpperCase()]: HEX(OWNER), 'not-an-id': OWNER }));
    serve([share({ owner_id: OWNER.toUpperCase() })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(1);
    serve([share({ owner_id: OTHER, owner_email: 'other@example.com' })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
  });

  it('treats an item stored as bound to two owners under two spellings as nobody\'s', async () => {
    local.setItem(OWNERS, JSON.stringify({ [ITEM]: OWNER, [HEX(ITEM)]: OTHER }));
    serve([share()]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
  });
});

describe('the directory entry of a first contact must name the share\'s owner', () => {
  it('refuses a first share whose e-mail looks up another account, and pins nothing', async () => {
    serve([share({ owner_email: 'liar@example.com' })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    expect(pinUserKeys).not.toHaveBeenCalled();
  });

  it('still verifies a pinned owner\'s share against the pin, and raises no alarm from another account\'s keys', async () => {
    getPinnedUserKeys.mockReturnValue(PIN);
    serve([share({ owner_email: 'liar@example.com', wrap_signature: 'ab'.repeat(64) })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(1);
    expect(sharesInboxStore.keyChangeAlarms()).toHaveLength(0);
  });
});

describe('a trust store that can\'t be read stops the refresh', () => {
  for (const [what, key] of [['floors', FLOORS], ['item owners', OWNERS]] as const) {
    it(`does not fetch, open or change anything when the ${what} don't parse, and says so`, async () => {
      local.setItem(key, '{not json');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      serve([share()]);
      expect(await sharesInboxStore.load()).toBe(false);
      expect(fetchedInbox()).toBe(false);
      expect(local.getItem(key)).toBe('{not json');
      expect(error.mock.calls.some(c => String(c[0]).includes('INBOX NOT REFRESHED'))).toBe(true);
      error.mockRestore();
    });
  }

  it('keeps the inbox as it was', async () => {
    serve([share()]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(1);
    local.setItem(FLOORS, '[1, 2]');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await sharesInboxStore.load()).toBe(false);
    expect(sharesInboxStore.shares()).toHaveLength(1);
  });

  it('stops when the storage itself throws', async () => {
    const getItem = local.getItem;
    local.getItem = () => { throw new Error('SecurityError'); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    serve([share()]);
    try {
      expect(await sharesInboxStore.load()).toBe(false);
      expect(fetchedInbox()).toBe(false);
    } finally {
      local.getItem = getItem;
    }
  });
});

describe('without this account\'s own id', () => {
  it('fetches and decides nothing', async () => {
    me = null;
    serve([share()]);
    expect(await sharesInboxStore.load()).toBe(false);
    expect(fetchedInbox()).toBe(false);
    me = { id: 'not-an-id' };
    expect(await sharesInboxStore.load()).toBe(false);
    expect(fetchedInbox()).toBe(false);
  });
});
