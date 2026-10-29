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

// A share naming one of this account's OWN notes is refused before
// anything is unwrapped. Accepted, its key would seal the note's next save
// and its live edits under a key the server chose, and the note would be
// stamped foreign and later evicted from the cache.

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
vi.mock('./notes', () => ({ extrasFrom: () => ({}) }));

const ME = '11111111-1111-4111-8111-111111111111';
const SENDER = '22222222-2222-4222-8222-222222222222';
const OWN = 'bbbbbbbb-0000-4000-8000-00000000000b';
const THEIRS = 'cccccccc-0000-4000-8000-00000000000c';

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

const { sharesInboxStore, INBOX_PAGE_LIMIT, INBOX_MAX_PAGES, KEY_LOOKUP_MAX } = await import('./sharesInbox');
const { registerOwnNoteCheck, registerOwnNotebookCheck } = await import('../lib/ownNotes');

function share(over: Record<string, unknown> = {}) {
  return {
    share_id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    item_id: OWN,
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

function serve(rows: unknown[]) {
  apiRequest.mockImplementation((url: string) => {
    if (url === '/api/v1/shares/inbox?page_info=true') return Promise.resolve({ success: true, data: rows });
    if (url === '/api/v1/users/public-keys') {
      return Promise.resolve({
        success: true,
        data: { users: [{ email: 'sender@example.com', user_id: SENDER, sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32) }] },
      });
    }
    return Promise.resolve({ success: false });
  });
}

beforeEach(() => {
  local.clear();
  vi.clearAllMocks();
  getPinnedUserKeys.mockReturnValue(null);
  unwrapContentKeyFromSender.mockReturnValue(new Uint8Array(32).fill(7));
  decryptWithContentKey.mockReturnValue(JSON.stringify({ title: 'Theirs', body: 'text' }));
  verifyNoteShareWrapGen.mockReturnValue({ verified: true, effectiveGeneration: 1 });
  // OWN is a note this browser opened with its own vault; THEIRS is not.
  registerOwnNoteCheck((id) => id.toLowerCase() === OWN);
  registerOwnNotebookCheck(() => false);
});

describe('a share naming one of this account\'s own notes', () => {
  it('is refused before anything is unwrapped, pinned or decrypted', async () => {
    // A pin the directory contradicts would normally raise a key-change alarm.
    getPinnedUserKeys.mockReturnValue({ signingPubkeyHex: 'cc'.repeat(32), sharingPubkeyHex: 'dd'.repeat(32) });
    serve([share()]);
    await sharesInboxStore.load();

    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(sharesInboxStore.getByItemId(OWN)).toBeUndefined();
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    expect(decryptWithContentKey).not.toHaveBeenCalled();
    expect(pinUserKeys).not.toHaveBeenCalled();
    const blocked = sharesInboxStore.blockedShares();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].itemId).toBe(OWN);
    expect(blocked[0].wrapTrust).toBe('invalid');
    // No alarm is raised for it, even with a pin for the sender that the
    // directory contradicts.
    expect(sharesInboxStore.keyChangeAlarms()).toHaveLength(0);
  });

  it('is refused under another spelling of the own note\'s id too', async () => {
    serve([share({ item_id: OWN.toUpperCase() })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
  });

  it('leaves another owner\'s shares as they were', async () => {
    serve([share(), share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000ff', item_id: THEIRS })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares().map(s => s.itemId)).toEqual([THEIRS]);
    expect(sharesInboxStore.getByItemId(THEIRS)?.contentKey).toEqual(new Uint8Array(32).fill(7));
    expect(sharesInboxStore.getByItemId(THEIRS)?.note?.openedVia).toBe('share');
  });
});

describe('a share naming one of this account\'s own notebooks', () => {
  const OWN_NB = 'eeeeeeee-0000-4000-8000-00000000000e';
  const THEIR_NB = 'ffffffff-0000-4000-8000-00000000000f';
  beforeEach(() => {
    // OWN_NB is a notebook this browser opened with its own vault.
    registerOwnNotebookCheck((id) => id.toLowerCase() === OWN_NB);
  });

  it('is refused before anything is unwrapped, pinned or decrypted, with no alarm', async () => {
    getPinnedUserKeys.mockReturnValue({ signingPubkeyHex: 'cc'.repeat(32), sharingPubkeyHex: 'dd'.repeat(32) });
    serve([share({ item_id: OWN_NB, item_type: 2 })]);
    await sharesInboxStore.load();

    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(sharesInboxStore.sharedNotebooks()).toHaveLength(0);
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
    expect(decryptWithContentKey).not.toHaveBeenCalled();
    expect(pinUserKeys).not.toHaveBeenCalled();
    expect(sharesInboxStore.blockedShares().map(b => [b.itemId, b.wrapTrust])).toEqual([[OWN_NB, 'invalid']]);
    expect(sharesInboxStore.keyChangeAlarms()).toHaveLength(0);
  });

  it('is refused under another spelling of the own notebook\'s id too', async () => {
    serve([share({ item_id: OWN_NB.toUpperCase(), item_type: 2 })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares()).toHaveLength(0);
    expect(unwrapContentKeyFromSender).not.toHaveBeenCalled();
  });

  it('leaves a share of a notebook this browser did not open as it was', async () => {
    serve([share({ item_id: OWN_NB, item_type: 2 }), share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000fe', item_id: THEIR_NB, item_type: 2 })]);
    await sharesInboxStore.load();
    expect(sharesInboxStore.sharedNotebooks().map(s => s.itemId)).toEqual([THEIR_NB]);
    expect(sharesInboxStore.getByItemId(THEIR_NB)?.contentKey).toEqual(new Uint8Array(32).fill(7));
  });
});

/**
 * Which notebooks the server still OFFERS is a different question from
 * which rows this page will open, and the reader's acceptances are pruned
 * against the first: a sender who merely changed keys has every row
 * refused until the reader approves the new key, while the refresh
 * succeeds. Pruned against the opened rows, the acceptance would be
 * struck on every device.
 */
describe('the notebooks the server names', () => {
  /** One this browser opened with its own vault, so a share naming it is refused; and one that is somebody else's. */
  const OWN_NB = 'dddddddd-0000-4000-8000-00000000000d';
  const THEIR_NB = 'eeeeeeee-0000-4000-8000-00000000000e';
  const OTHER_SHARE = 'aaaaaaaa-0000-4000-8000-0000000000fe';
  beforeEach(() => {
    registerOwnNotebookCheck((id) => id.toLowerCase() === OWN_NB);
  });

  it('include a notebook whose row this page refuses to open', async () => {
    serve([share({ item_id: OWN_NB, item_type: 2 }), share({ share_id: OTHER_SHARE, item_id: THEIR_NB, item_type: 2 })]);
    expect(await sharesInboxStore.load()).toBe(true);
    expect(sharesInboxStore.sharedNotebooks().map(s => s.itemId)).toEqual([THEIR_NB]);
    expect(sharesInboxStore.blockedShares().map(b => b.itemId)).toEqual([OWN_NB]);
    expect([...sharesInboxStore.listedNotebookIds()!].sort()).toEqual([OWN_NB, THEIR_NB].sort());
  });

  it('are notebooks only: a shared note names none', async () => {
    serve([share(), share({ share_id: OTHER_SHARE, item_id: THEIR_NB, item_type: 2 })]);
    await sharesInboxStore.load();
    expect([...sharesInboxStore.listedNotebookIds()!]).toEqual([THEIR_NB]);
  });

  it('are none when the server answers with an empty list', async () => {
    serve([]);
    expect(await sharesInboxStore.load()).toBe(true);
    expect([...sharesInboxStore.listedNotebookIds()!]).toEqual([]);
  });

  /** A failure names nothing: the last LIST stands, and callers are told the refresh was not one. */
  it('stay as the last list said when a refresh fails', async () => {
    serve([share({ item_id: THEIR_NB, item_type: 2 })]);
    await sharesInboxStore.load();
    apiRequest.mockImplementation(() => Promise.resolve({ success: false }));
    expect(await sharesInboxStore.load()).toBe(false);
    expect([...sharesInboxStore.listedNotebookIds()!]).toEqual([THEIR_NB]);
    expect(sharesInboxStore.sharedNotebooks()).toEqual([]);
  });

  /**
   * A declined notebook's notes are kept off the screen until the server
   * offers it AGAIN, and "again" is a row the decline did not dismiss. A list
   * that still names a dismissed row is an old answer (the inbox is read from
   * a replica, which can lag the dismissal), and it must not lift the mark.
   */
  it('a notebook declined here stays declined through a stale answer that still names the dismissed row', async () => {
    sharesInboxStore.markDeclined(THEIR_NB, [OTHER_SHARE]);
    sharesInboxStore.markDeclined('never-offered-again', ['x']);
    serve([share({ share_id: OTHER_SHARE, item_id: THEIR_NB, item_type: 2 })]);
    await sharesInboxStore.load();
    expect([...sharesInboxStore.declinedNotebooks()].sort()).toEqual([THEIR_NB, 'never-offered-again'].sort());
    serve([]);
    await sharesInboxStore.load();
    expect([...sharesInboxStore.declinedNotebooks()].sort()).toEqual([THEIR_NB, 'never-offered-again'].sort());
  });

  it('and is no longer declined once the server offers it by a row that decline did not dismiss', async () => {
    sharesInboxStore.markDeclined(THEIR_NB, [OTHER_SHARE]);
    serve([share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000fd', item_id: THEIR_NB, item_type: 2 })]);
    await sharesInboxStore.load();
    expect([...sharesInboxStore.declinedNotebooks()]).not.toContain(THEIR_NB);
    expect([...sharesInboxStore.declinedNotebooks()]).toContain('never-offered-again');
  });

  it('a second decline of the same notebook adds to the rows already dismissed', async () => {
    sharesInboxStore.markDeclined('twice', ['row-1']);
    sharesInboxStore.markDeclined('twice', ['row-2']);
    const NB = '99999999-0000-4000-8000-000000000009';
    sharesInboxStore.markDeclined(NB, ['aaaaaaaa-0000-4000-8000-0000000000f1']);
    sharesInboxStore.markDeclined(NB, ['aaaaaaaa-0000-4000-8000-0000000000f2']);
    serve([share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000f1', item_id: NB, item_type: 2 }), share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000f2', item_id: NB, item_type: 2 })]);
    await sharesInboxStore.load();
    expect([...sharesInboxStore.declinedNotebooks()]).toContain(NB);
  });
});

/**
 * The server answers with one page of at most 500 rows, newest first. Taken
 * for the whole list, that one page would drop a notebook's own row first —
 * it is among the oldest — and its acceptance would be struck on every device
 * and the notes past the cut evicted. So the inbox is read to its end, with
 * the cursor the server takes; one that cannot be read to its end is shown
 * as far as it was read and is not "the list".
 *
 * Every server in this block answers with the BARE LIST, as one that predates
 * `has_more` does: the end is then inferred from the page's length. The block
 * after it is the server that says.
 */
describe('an inbox longer than one page, from a server that sends the bare list', () => {
  const id = (prefix: string, i: number) => `${prefix}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
  /** Rows `from` .. `from + n - 1`, each with its own time, newest first as the server sends them. */
  const rows = (n: number, from = 0, notebookAt = -1) => Array.from({ length: n }, (_, k) => {
    const i = from + k;
    return share({
      share_id: id('5a5a5a5a', i), item_id: id('6b6b6b6b', i), item_type: i === notebookAt ? 2 : 1,
      created_at: new Date(Date.UTC(2026, 7, 19) - i * 1000).toISOString(),
    });
  });
  /** A server that pages: `pages[k]` answers the k-th request, and every request's URL is kept. */
  function paged(pages: (unknown[] | Record<string, unknown> | 'fail')[]) {
    const asked: string[] = [];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox')) {
        const page = pages[asked.length];
        asked.push(url);
        return Promise.resolve(page === 'fail' || page === undefined ? { success: false, status: 503 } : { success: true, data: page });
      }
      if (url === '/api/v1/users/public-keys') {
        return Promise.resolve({ success: true, data: { users: [{ email: 'sender@example.com', user_id: SENDER, sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32) }] } });
      }
      return Promise.resolve({ success: false });
    });
    return asked;
  }

  it('the page is 500 rows, the server\'s cap', () => {
    expect(INBOX_PAGE_LIMIT).toBe(500);
  });

  it('a short first page is the whole list, and one request', async () => {
    const asked = paged([rows(INBOX_PAGE_LIMIT - 1, 0, 0)]);
    expect(await sharesInboxStore.load()).toBe(true);
    expect(asked).toEqual(['/api/v1/shares/inbox?page_info=true']);
    expect([...sharesInboxStore.listedNotebookIds()!]).toEqual([id('6b6b6b6b', 0)]);
  });

  /** The case the cap hid: the notebook's own row is the OLDEST, on the second page. */
  it('a full page is followed to the end, from the last row\'s time and id', async () => {
    const first = rows(INBOX_PAGE_LIMIT);
    const asked = paged([first, rows(3, INBOX_PAGE_LIMIT, INBOX_PAGE_LIMIT + 2)]);
    expect(await sharesInboxStore.load()).toBe(true);
    const last = first[first.length - 1] as { created_at: string; share_id: string };
    expect(asked).toEqual([
      '/api/v1/shares/inbox?page_info=true',
      `/api/v1/shares/inbox?page_info=true&before=${encodeURIComponent(last.created_at)}&before_id=${last.share_id}`,
    ]);
    expect(sharesInboxStore.shares().length).toBe(INBOX_PAGE_LIMIT + 3);
    expect([...sharesInboxStore.listedNotebookIds()!]).toEqual([id('6b6b6b6b', INBOX_PAGE_LIMIT + 2)]);
  });

  it('an inbox of exactly one full page takes one more request, which comes back empty', async () => {
    const asked = paged([rows(INBOX_PAGE_LIMIT, 0, 0), []]);
    expect(await sharesInboxStore.load()).toBe(true);
    expect(asked).toHaveLength(2);
    expect(sharesInboxStore.shares().length).toBe(INBOX_PAGE_LIMIT);
  });

  /** Shown as far as it was read; not the list: nothing is pruned, forgotten or evicted on it. */
  it('a later page that fails leaves what was read on screen, and no list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    paged([rows(INBOX_PAGE_LIMIT, 0, 0), 'fail']);
    expect(await sharesInboxStore.load()).toBe(false);
    expect(sharesInboxStore.shares().length).toBe(INBOX_PAGE_LIMIT);
    expect(sharesInboxStore.listedNotebookIds()).toBeNull();
    expect(sharesInboxStore.answered()).toBe(true);
    // It IS an answer, as far as it goes: what it does not say is held back.
    expect(sharesInboxStore.gotNoAnswer()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  /** A page that has had no answer for this account yet: the tab's account confirmed anew. */
  const freshPage = async () => {
    const { setTabAccount } = await import('../lib/account');
    setTabAccount(null);
    setTabAccount(ME);
  };

  /**
   * No answer at all is told apart from an answer that does not say
   * everything: offline, nothing is held on a guess. On a page that has
   * had no answer yet.
   */
  it('a refresh that gets no answer at all says so, until one does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await freshPage();
    expect(sharesInboxStore.gotNoAnswer()).toBe(false);
    paged(['fail']);
    expect(await sharesInboxStore.load()).toBe(false);
    expect(sharesInboxStore.shares()).toEqual([]);
    expect(sharesInboxStore.answered()).toBe(true);
    expect(sharesInboxStore.gotNoAnswer()).toBe(true);
    expect(sharesInboxStore.listedNotebookIds()).toBeNull();

    paged([rows(3, 0, 0)]);
    expect(await sharesInboxStore.load()).toBe(true);
    expect(sharesInboxStore.gotNoAnswer()).toBe(false);
    warn.mockRestore();
  });

  /**
   * Only an offline cold start releases the hold. Once an answer is on
   * the page, a refresh that fails says nothing new; one that could not
   * ask is no answer from anyone; an account change starts over.
   */
  it('once an answer is on the page, a refresh that fails is not "no answer"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await freshPage();
    paged([rows(3, 0, 0)]);
    expect(await sharesInboxStore.load()).toBe(true);
    paged(['fail']);
    expect(await sharesInboxStore.load()).toBe(false);
    expect(sharesInboxStore.answered()).toBe(true);
    expect(sharesInboxStore.gotNoAnswer()).toBe(false);
    warn.mockRestore();
  });

  it('nor is a refresh that could not ask: a trust record it cannot read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await freshPage();
    const { accountStorageKey } = await import('../lib/account');
    local.setItem(accountStorageKey('pingolin_note_gen_floor')!, '{not json');
    paged([rows(3, 0, 0)]);
    expect(await sharesInboxStore.load()).toBe(false);
    expect(sharesInboxStore.answered()).toBe(true);
    expect(sharesInboxStore.gotNoAnswer()).toBe(false);
    error.mockRestore();
  });

  it('an account change in the tab starts over: neither answered nor "no answer"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await freshPage();
    paged(['fail']);
    await sharesInboxStore.load();
    expect(sharesInboxStore.gotNoAnswer()).toBe(true);
    await freshPage();
    expect(sharesInboxStore.answered()).toBe(false);
    expect(sharesInboxStore.gotNoAnswer()).toBe(false);
    warn.mockRestore();
  });

  it('the notebooks the server says were declined are kept per account: a page that then gets no answer still has them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await freshPage();
    const DECLINED_NB = id('7c7c7c7c', 1);
    paged([{ shares: rows(2, 0, -1), has_more: false, declined_notebooks: [{ id: DECLINED_NB, declined_at: '2026-10-06T09:00:00Z' }] }]);
    expect(await sharesInboxStore.load()).toBe(true);
    expect([...sharesInboxStore.declinedNotebooks()]).toEqual([DECLINED_NB]);
    // A new page for the same account, offline.
    await freshPage();
    expect([...sharesInboxStore.declinedNotebooks()]).toEqual([DECLINED_NB]);
    paged(['fail']);
    await sharesInboxStore.load();
    expect(sharesInboxStore.gotNoAnswer()).toBe(true);
    expect([...sharesInboxStore.declinedNotebooks()]).toEqual([DECLINED_NB]);
    // Another account's page has none of it.
    const { setTabAccount } = await import('../lib/account');
    setTabAccount('99999999-9999-4999-8999-999999999999');
    expect([...sharesInboxStore.declinedNotebooks()]).toEqual([]);
    setTabAccount(ME);
    warn.mockRestore();
  });

  it('a first page that fails empties the inbox, as before', async () => {
    paged(['fail']);
    expect(await sharesInboxStore.load()).toBe(false);
    expect(sharesInboxStore.shares()).toEqual([]);
  });

  /** A server that does not know the cursor answers every request with the first page. */
  it('a server that sends the same page again is asked once more and no further, and nothing is listed twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const same = rows(INBOX_PAGE_LIMIT, 0, 0);
    const asked = paged([same, same, same, same]);
    expect(await sharesInboxStore.load()).toBe(false);
    expect(asked).toHaveLength(2);
    expect(sharesInboxStore.shares().length).toBe(INBOX_PAGE_LIMIT);
    expect(sharesInboxStore.listedNotebookIds()).toBeNull();
    warn.mockRestore();
  });

  it('stops at its page limit on an inbox that never ends, and that is not a list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const asked = paged(Array.from({ length: INBOX_MAX_PAGES + 5 }, (_, p) => rows(INBOX_PAGE_LIMIT, p * INBOX_PAGE_LIMIT)));
    expect(await sharesInboxStore.load()).toBe(false);
    expect(asked).toHaveLength(INBOX_MAX_PAGES);
    expect(sharesInboxStore.listedNotebookIds()).toBeNull();
    warn.mockRestore();
  });
});

/**
 * Asked with `page_info=true`, the server answers
 * `{ shares, has_more, declined_notebooks? }`, and where the inbox ends
 * is its word, not a guess from the page's length.
 */
describe('an inbox from a server that says whether more follows', () => {
  const id = (prefix: string, i: number) => `${prefix}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
  const rows = (n: number, from = 0) => Array.from({ length: n }, (_, k) => share({
    share_id: id('5a5a5a5a', from + k), item_id: id('6b6b6b6b', from + k),
    created_at: new Date(Date.UTC(2026, 7, 19) - (from + k) * 1000).toISOString(),
  }));
  /** `pages[k]` is the `data` of the k-th inbox answer, whatever its shape. */
  function answering(pages: unknown[]) {
    const asked: string[] = [];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox')) {
        const data = pages[asked.length];
        asked.push(url);
        return Promise.resolve(asked.length > pages.length ? { success: false, status: 503 } : { success: true, data });
      }
      if (url === '/api/v1/users/public-keys') {
        return Promise.resolve({ success: true, data: { users: [{ email: 'sender@example.com', user_id: SENDER, sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32) }] } });
      }
      return Promise.resolve({ success: false });
    });
    return asked;
  }

  it('a full page that is the end is one request: nobody asks for an empty page to learn it', async () => {
    const asked = answering([{ shares: rows(INBOX_PAGE_LIMIT), has_more: false }]);
    expect(await sharesInboxStore.load()).toBe(true);
    expect(asked).toHaveLength(1);
    expect(sharesInboxStore.shares().length).toBe(INBOX_PAGE_LIMIT);
  });

  /** The case a stale copy of the page size would get wrong: the server's page
   * is SHORTER than this page's copy.
   */
  it('a page shorter than this page\'s own idea of a page is followed when the server says more follows', async () => {
    const first = rows(3);
    const asked = answering([{ shares: first, has_more: true }, { shares: rows(2, 3), has_more: false }]);
    expect(await sharesInboxStore.load()).toBe(true);
    const last = first[2] as { created_at: string; share_id: string };
    expect(asked).toEqual([
      '/api/v1/shares/inbox?page_info=true',
      `/api/v1/shares/inbox?page_info=true&before=${encodeURIComponent(last.created_at)}&before_id=${last.share_id}`,
    ]);
    expect(sharesInboxStore.shares().length).toBe(5);
  });

  it('an empty inbox the server says is whole is a list of nothing', async () => {
    answering([{ shares: [], has_more: false }]);
    expect(await sharesInboxStore.load()).toBe(true);
    expect([...sharesInboxStore.listedNotebookIds()!]).toEqual([]);
  });

  /**
   * Not an empty inbox. An empty inbox read to its end is "everything was
   * withdrawn": the caller evicts every received note and forgets every
   * acceptance on it. So the refresh must answer "not the list", and the last
   * real list must stand.
   */
  it('a first answer in neither shape is a refresh that failed, never an empty inbox', async () => {
    const NB = id('6b6b6b6b', 0);
    for (const data of [null, 'ok', 7, {}, { shares: [] }, { shares: 'none', has_more: false }, { has_more: false }, { shares: [], has_more: 'no' }]) {
      answering([{ shares: [share({ share_id: id('5a5a5a5a', 0), item_id: NB, item_type: 2 })], has_more: false }]);
      expect(await sharesInboxStore.load()).toBe(true);
      expect([...sharesInboxStore.listedNotebookIds()!]).toEqual([NB]);
      answering([data]);
      expect(await sharesInboxStore.load(), JSON.stringify(data)).toBe(false);
      expect([...sharesInboxStore.listedNotebookIds()!], JSON.stringify(data)).toEqual([NB]);
    }
  });

  it('a later answer in neither shape leaves what was read on screen, and no list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answering([{ shares: rows(2), has_more: true }, { shares: rows(1, 2) }]);
    expect(await sharesInboxStore.load()).toBe(false);
    expect(sharesInboxStore.shares().length).toBe(2);
    expect(sharesInboxStore.listedNotebookIds()).toBeNull();
    warn.mockRestore();
  });

  it('a server that says more follows for ever is left at the page limit, and that is not a list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const asked = answering(Array.from({ length: INBOX_MAX_PAGES + 5 }, (_, p) => ({ shares: rows(1, p), has_more: true })));
    expect(await sharesInboxStore.load()).toBe(false);
    expect(asked).toHaveLength(INBOX_MAX_PAGES);
    warn.mockRestore();
  });

  /**
   * The sync that reads this inbox is given up on when it shows no sign of
   * life for a minute (lib/oneAtATime). A long inbox is twenty requests: each
   * answer says so, a failed one included.
   */
  it('tells whoever reads it of every answer: each page, then the senders\' keys, then the opened ones', async () => {
    const at: string[] = [];
    const asked = answering([{ shares: rows(2), has_more: true }, { shares: rows(2, 2), has_more: true }, { shares: rows(1, 4), has_more: false }]);
    const keyLookups = () => apiRequest.mock.calls.filter(c => c[0] === '/api/v1/users/public-keys').length;
    expect(await sharesInboxStore.load(() => { at.push(`${asked.length} pages, ${keyLookups()} lookups`); })).toBe(true);
    expect(at).toEqual([
      '1 pages, 0 lookups',
      '2 pages, 0 lookups',
      '3 pages, 0 lookups',
      // One batch of senders' keys, and the keys those shares were sealed with.
      '3 pages, 1 lookups',
      '3 pages, 1 lookups',
    ]);
  });

  it('of a failed answer too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const at: number[] = [];
    const asked = answering([{ shares: rows(2), has_more: true }]);
    expect(await sharesInboxStore.load(() => { at.push(asked.length); })).toBe(false);
    // The page, and the request after it that came back 503 (then the keys, as above).
    expect(at.slice(0, 2)).toEqual([1, 2]);
    warn.mockRestore();
  });
});

/**
 * If you decline a share, nothing should show up. The server keeps a
 * declined notebook's later notes away itself. What it tells this page
 * (`declined_notebooks`) is for the device that did not decline: the
 * notebook's notes it still holds in memory stay held until the sync has
 * taken them out (lib/notebookInvites, `declinedElsewhere`).
 */
describe('the notebooks the server says were declined', () => {
  const NB = '9c9c9c9c-1111-4000-8000-00000000000d';
  const OTHER_NB = '9c9c9c9c-2222-4000-8000-00000000000d';
  const ROW = 'aaaaaaaa-0000-4000-8000-0000000000c1';
  /** One entry of the server's list: the notebook, and since when it is declined. */
  const D = (id: string, declined_at = '2026-10-07T10:00:00Z') => ({ id, declined_at });
  const firstPage = (data: unknown) => apiRequest.mockImplementation((url: string) => {
    if (url === '/api/v1/shares/inbox?page_info=true') return Promise.resolve({ success: true, data });
    if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
    return Promise.resolve({ success: false });
  });
  /** A store of its own: what the server said is kept between answers, and the one above has heard things. */
  async function fresh() {
    vi.resetModules();
    const account = await import('../lib/account');
    account.setTabAccount(ME);
    return { account, store: (await import('./sharesInbox')).sharesInboxStore };
  }

  it('are declined here too, on a device that never saw the decline', async () => {
    const { store } = await fresh();
    firstPage({ shares: [], has_more: false, declined_notebooks: [D(NB), D(OTHER_NB)] });
    await store.load();
    expect([...store.declinedNotebooks()].sort()).toEqual([NB, OTHER_NB].sort());
  });

  /** The row is the newer fact: the owner removed the reader and invited them again. */
  it('never include a notebook the same answer offers, whatever the declined list says', async () => {
    const { store } = await fresh();
    firstPage({ shares: [share({ share_id: ROW, item_id: NB, item_type: 2 })], has_more: false, declined_notebooks: [D(NB), D(OTHER_NB)] });
    await store.load();
    expect([...store.declinedNotebooks()]).toEqual([OTHER_NB]);
  });

  it('stand until an answer says otherwise: one that does not say changes nothing', async () => {
    const { store } = await fresh();
    firstPage({ shares: [], has_more: false, declined_notebooks: [D(NB)] });
    await store.load();
    // The server's own lookup failed, so the page carries no list.
    firstPage({ shares: [], has_more: false });
    await store.load();
    expect([...store.declinedNotebooks()]).toEqual([NB]);
    // An older server: the bare list.
    firstPage([]);
    await store.load();
    expect([...store.declinedNotebooks()]).toEqual([NB]);
    // A refresh that failed.
    apiRequest.mockImplementation(() => Promise.resolve({ success: false }));
    await store.load();
    expect([...store.declinedNotebooks()]).toEqual([NB]);
    // And one that says: nothing is declined any more.
    firstPage({ shares: [], has_more: false, declined_notebooks: [] });
    await store.load();
    expect([...store.declinedNotebooks()]).toEqual([]);
  });

  /** It describes the inbox, so only the first page carries it: a later page saying nothing is not "none". */
  it('are read off the first page of a long inbox, and a later page without them changes nothing', async () => {
    const { store } = await fresh();
    const row = (i: number) => share({ share_id: `aaaaaaaa-0000-4000-8000-0000000001c${i}`, item_id: `cccccccc-4444-4000-8000-00000000000${i}` });
    let asked = 0;
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox')) {
        asked++;
        return Promise.resolve({ success: true, data: asked === 1
          ? { shares: [row(1)], has_more: true, declined_notebooks: [D(NB)] }
          : { shares: [row(2)], has_more: false } });
      }
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      return Promise.resolve({ success: false });
    });
    expect(await store.load()).toBe(true);
    expect(asked).toBe(2);
    expect([...store.declinedNotebooks()]).toEqual([NB]);
  });

  /** And a list on a LATER page is not the inbox's: the server sends none there, and nothing may rest on one. */
  it('are not taken from a later page', async () => {
    const { store } = await fresh();
    const row = (i: number) => share({ share_id: `aaaaaaaa-0000-4000-8000-0000000002c${i}`, item_id: `cccccccc-5555-4000-8000-00000000000${i}` });
    let asked = 0;
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox')) {
        asked++;
        return Promise.resolve({ success: true, data: asked === 1
          ? { shares: [row(1)], has_more: true, declined_notebooks: [] }
          : { shares: [row(2)], has_more: false, declined_notebooks: [D(OTHER_NB)] } });
      }
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      return Promise.resolve({ success: false });
    });
    expect(await store.load()).toBe(true);
    expect([...store.declinedNotebooks()]).toEqual([]);
  });

  it('add to a decline made on this page, and neither hides the other', async () => {
    const { store } = await fresh();
    store.markDeclined('declined-here', ['row']);
    firstPage({ shares: [], has_more: false, declined_notebooks: [D(NB)] });
    await store.load();
    expect([...store.declinedNotebooks()].sort()).toEqual([NB, 'declined-here'].sort());
  });

  /** Ids are compared in one form everywhere, and one that is no id names nothing. */
  it('are kept in the canonical form of an id, and an entry that is no id is dropped', async () => {
    const { store } = await fresh();
    firstPage({ shares: [], has_more: false, declined_notebooks: [D(NB.toUpperCase()), D('not-a-uuid')] });
    await store.load();
    expect([...store.declinedNotebooks()]).toEqual([NB]);
  });

  it('are not carried to the next account', async () => {
    const { account, store } = await fresh();
    firstPage({ shares: [], has_more: false, declined_notebooks: [D(NB)] });
    await store.load();
    expect([...store.declinedNotebooks()]).toEqual([NB]);
    account.setTabAccount('33333333-3333-4333-8333-333333333333');
    expect([...store.declinedNotebooks()]).toEqual([]);
  });
});

/**
 * Which notebooks are on offer is the server's to say, on the first page:
 * an invitation's own row is the oldest of the invitation, and an inbox
 * shown as far as it was read may not have come to it.
 */
describe('the notebooks the server says are on offer', () => {
  const NB = '9c9c9c9c-1111-4000-8000-00000000000f';
  const OTHER_NB = '9c9c9c9c-2222-4000-8000-00000000000f';
  const NOTE_ROW = 'aaaaaaaa-0000-4000-8000-0000000000f1';
  /** `pages[k]` is the `data` of the k-th inbox answer; past them the server fails. */
  function answering(pages: unknown[]) {
    let asked = 0;
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox')) {
        const data = pages[asked++];
        return Promise.resolve(asked > pages.length ? { success: false, status: 503 } : { success: true, data });
      }
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      return Promise.resolve({ success: false });
    });
  }
  async function fresh() {
    vi.resetModules();
    const account = await import('../lib/account');
    account.setTabAccount(ME);
    return { account, store: (await import('./sharesInbox')).sharesInboxStore };
  }

  it('are not known until an answer has said', async () => {
    const { store } = await fresh();
    expect(store.offeredNotebooks()).toBeNull();
    answering([{ shares: [], has_more: false }]);
    await store.load();
    expect(store.offeredNotebooks()).toBeNull();
  });

  it('are the ones the first page names', async () => {
    const { store } = await fresh();
    answering([{ shares: [], has_more: false, offered_notebooks: [NB, OTHER_NB] }]);
    await store.load();
    expect([...store.offeredNotebooks()!].sort()).toEqual([NB, OTHER_NB].sort());
  });

  /** The case it is for: the notes on the first page, the invitation's own row on one that was never read. */
  it('are known though the inbox was read no further than its first page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = await fresh();
    answering([{ shares: [share({ share_id: NOTE_ROW, item_id: 'bbbbbbbb-0000-4000-8000-0000000000f1' })], has_more: true, offered_notebooks: [NB] }]);
    expect(await store.load()).toBe(false);
    // No list of the rows (the read stopped early), and no row of the notebook among them…
    expect(store.listedNotebookIds()).toBeNull();
    expect(store.sharedNotebooks()).toEqual([]);
    // …and the notebook is on offer all the same.
    expect([...store.offeredNotebooks()!]).toEqual([NB]);
    warn.mockRestore();
  });

  it('a later page says nothing about them', async () => {
    const { store } = await fresh();
    answering([
      { shares: [share({ share_id: NOTE_ROW, item_id: 'bbbbbbbb-0000-4000-8000-0000000000f1' })], has_more: true, offered_notebooks: [NB] },
      { shares: [], has_more: false, offered_notebooks: [OTHER_NB] },
    ]);
    expect(await store.load()).toBe(true);
    expect([...store.offeredNotebooks()!]).toEqual([NB]);
  });

  it('none on offer is known as none', async () => {
    const { store } = await fresh();
    answering([{ shares: [], has_more: false, offered_notebooks: [NB] }]);
    await store.load();
    answering([{ shares: [], has_more: false, offered_notebooks: [] }]);
    await store.load();
    expect([...store.offeredNotebooks()!]).toEqual([]);
  });

  /**
   * An older list kept when an answer carries none would go on holding the
   * notes of a notebook accepted since on another device, and know nothing
   * of an invitation made since. The list is the LAST answer's.
   */
  it('are the last answer\'s: an answer that carries no list leaves none, and not an older one', async () => {
    const { store } = await fresh();
    answering([{ shares: [], has_more: false, offered_notebooks: [NB] }]);
    await store.load();
    expect([...store.offeredNotebooks()!]).toEqual([NB]);
    answering([{ shares: [], has_more: false }]);
    await store.load();
    expect(store.offeredNotebooks()).toBeNull();
  });

  it('a refresh that FAILED is no answer: what the last one said stands', async () => {
    const { store } = await fresh();
    answering([{ shares: [], has_more: false, offered_notebooks: [NB] }]);
    await store.load();
    answering([]);
    expect(await store.load()).toBe(false);
    expect([...store.offeredNotebooks()!]).toEqual([NB]);
  });

  it('are not carried to the next account', async () => {
    const { account, store } = await fresh();
    answering([{ shares: [], has_more: false, offered_notebooks: [NB] }]);
    await store.load();
    expect(store.offeredNotebooks()).not.toBeNull();
    account.setTabAccount('33333333-3333-4333-8333-333333333333');
    expect(store.offeredNotebooks()).toBeNull();
  });
});

/**
 * If you decline a share, nothing should show up. The server keeps a
 * declined notebook's later notes away when the note's row says which
 * notebook it is in. One whose row does not say (an owner's page may send no
 * notebook for a note, such as one written after a reload) arrives like any
 * other, and only its decrypted content names the notebook. A share like
 * that, made AFTER the decline, is taken off the list here and dismissed.
 * One made before the decline is the reader's in its own right.
 */
describe('a share of a declined notebook\'s note that arrives all the same', () => {
  const NB = '8a8a8a8a-1111-4000-8000-00000000000b';
  const STRAY = 'aaaaaaaa-0000-4000-8000-0000000000f1';
  const KEPT = 'aaaaaaaa-0000-4000-8000-0000000000f2';
  const STRAY_ITEM = 'cccccccc-7777-4000-8000-00000000000c';
  const KEPT_ITEM = 'cccccccc-8888-4000-8000-00000000000c';
  const DECLINED_AT = '2026-10-07T10:00:00.000000Z';
  const AFTER = '2026-10-07T10:05:00.000000Z';
  const BEFORE = '2026-10-07T09:55:00.000000Z';
  const D = (id: string, declined_at = DECLINED_AT) => ({ id, declined_at });
  /** Two shares: the first's note says it is in NB (shared at `when`), the second's is in no notebook. */
  const rows = (when = AFTER) => [
    share({ share_id: STRAY, item_id: STRAY_ITEM, created_at: when }),
    share({ share_id: KEPT, item_id: KEPT_ITEM, created_at: AFTER }),
  ];
  /** In the order the rows are opened. `notebook`: what the first note's content says. */
  const contents = (notebook: string = NB) => {
    decryptWithContentKey.mockReset();
    decryptWithContentKey
      .mockReturnValueOnce(JSON.stringify({ title: 'In the declined notebook', body: 'x', notebook_id: notebook }))
      .mockReturnValue(JSON.stringify({ title: 'On its own', body: 'y' }));
  };
  /** A server holding `data` as its inbox answer; every dismissal asked of it is kept, and answered with `dismissAnswer`. */
  function server(data: () => unknown, dismissAnswer: unknown = { success: true }) {
    const dismissed: string[] = [];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: data() });
      if (url === '/api/v1/users/public-keys') {
        return Promise.resolve({ success: true, data: { users: [{ email: 'sender@example.com', user_id: SENDER, sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32) }] } });
      }
      const m = /^\/api\/v1\/shares\/inbox\/([0-9a-f-]+)\/dismiss\?share_only=true$/.exec(url);
      if (m) { dismissed.push(m[1]); return Promise.resolve(dismissAnswer); }
      return Promise.resolve({ success: false });
    });
    return dismissed;
  }
  async function fresh() {
    vi.resetModules();
    (await import('../lib/account')).setTabAccount(ME);
    const mod = await import('./sharesInbox');
    const own = await import('../lib/ownNotes');
    own.registerOwnNoteCheck(() => false);
    own.registerOwnNotebookCheck(() => false);
    return mod.sharesInboxStore;
  }
  const settle = () => new Promise(r => setTimeout(r, 0));

  it('is not listed, not counted as unread, and is dismissed', async () => {
    const store = await fresh();
    contents();
    const dismissed = server(() => ({ shares: rows(), has_more: false, declined_notebooks: [D(NB)] }));
    expect(await store.load()).toBe(true);
    expect(store.shares().map(s => s.shareId)).toEqual([KEPT]);
    expect(store.getByItemId(STRAY_ITEM)).toBeUndefined();
    expect(store.unreadCount()).toBe(1);
    await settle();
    expect(dismissed).toEqual([STRAY]);
  });

  /**
   * What the reader already held when they declined was shared with them by
   * itself. Its owner filing it into that notebook later takes nothing away:
   * it stays on the list, and nothing is dismissed.
   */
  it('a share older than the decline is the reader\'s in its own right: listed, and not dismissed', async () => {
    const store = await fresh();
    contents();
    const dismissed = server(() => ({ shares: rows(BEFORE), has_more: false, declined_notebooks: [D(NB)] }));
    await store.load();
    await settle();
    expect(store.shares().map(s => s.shareId).sort()).toEqual([STRAY, KEPT].sort());
    expect(dismissed).toEqual([]);
  });

  it('the note\'s notebook is found under any spelling of its id', async () => {
    const store = await fresh();
    contents(NB.toUpperCase());
    const dismissed = server(() => ({ shares: rows(), has_more: false, declined_notebooks: [D(NB)] }));
    await store.load();
    await settle();
    expect(store.shares().map(s => s.shareId)).toEqual([KEPT]);
    expect(dismissed).toEqual([STRAY]);
  });

  /** And once dismissed it is not brought back by an older answer either. */
  it('stays off the list through a later answer that still carries it', async () => {
    const store = await fresh();
    contents();
    const dismissed = server(() => ({ shares: rows(), has_more: false, declined_notebooks: [D(NB)] }));
    await store.load();
    await settle();
    // The declined list is gone from this answer (an older server, or its lookup failed): the row is still not shown.
    decryptWithContentKey.mockReturnValue(JSON.stringify({ title: 'On its own', body: 'y' }));
    server(() => ({ shares: rows(), has_more: false }));
    await store.load();
    expect(store.shares().map(s => s.shareId)).toEqual([KEPT]);
    expect(dismissed).toEqual([STRAY]);
  });

  /**
   * On the SERVER'S word only. A decline pressed on this page and not yet
   * taken by the server dismisses nothing: its notes dismissed one by one
   * ahead of the answer would be the half-declined notebook again.
   */
  it('a decline that is only on its way takes nothing off the list and dismisses nothing', async () => {
    const store = await fresh();
    contents();
    const dismissed = server(() => ({ shares: rows(), has_more: false, declined_notebooks: [] }));
    store.markDeclined(NB, ['some-notebook-row']);
    await store.load();
    await settle();
    expect(dismissed).toEqual([]);
    expect(store.shares().map(s => s.shareId).sort()).toEqual([STRAY, KEPT].sort());
    // The mark still keeps its notes out of the reader's own lists (lib/notebookInvites).
    expect([...store.declinedNotebooks()]).toEqual([NB]);
  });

  /** The row is the newer fact: the notebook is on offer again, so its notes are an invitation's, not strays. */
  it('a notebook the same answer offers is not declined, and its notes stay', async () => {
    const store = await fresh();
    decryptWithContentKey.mockReset();
    decryptWithContentKey
      .mockReturnValueOnce(JSON.stringify({ name: 'The notebook' }))
      .mockReturnValueOnce(JSON.stringify({ title: 'In the notebook', body: 'x', notebook_id: NB }))
      .mockReturnValue(JSON.stringify({ title: 'On its own', body: 'y' }));
    const dismissed = server(() => ({
      shares: [share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000f0', item_id: NB, item_type: 2, created_at: AFTER }), ...rows()],
      has_more: false,
      declined_notebooks: [D(NB)],
    }));
    await store.load();
    await settle();
    expect(dismissed).toEqual([]);
    expect(store.shares()).toHaveLength(3);
  });

  /**
   * A dismissal cannot be taken back, so it rests only on a list the SAME
   * answer carried (the server reads the two in one snapshot). A list kept
   * from an earlier answer may be older than these rows: it keeps the share
   * off the list, and dismisses nothing.
   */
  it('an answer that does not say what was declined dismisses nothing, and still keeps the share off the list', async () => {
    const store = await fresh();
    const asked: string[][] = [server(() => ({ shares: [], has_more: false, declined_notebooks: [D(NB)] }))];
    await store.load();
    expect([...store.declinedNotebooks()]).toEqual([NB]);
    for (const data of [() => ({ shares: rows(), has_more: false }), () => rows()]) {
      contents();
      asked.push(server(data));
      await store.load();
      await settle();
      expect(store.shares().map(s => s.shareId)).toEqual([KEPT]);
    }
    expect(asked.flat()).toEqual([]);
    // The control: the same rows under an answer that DOES say are dismissed.
    contents();
    const told = server(() => ({ shares: rows(), has_more: false, declined_notebooks: [D(NB)] }));
    await store.load();
    await settle();
    expect(told).toEqual([STRAY]);
  });

  /**
   * The page says "this share and nothing more" (`share_only=true`). Without
   * it the server takes a NOTEBOOK's share dismissed for the notebook
   * declined, which is what pages older than the decline request mean by it.
   */
  it('a single-share dismissal says "this share only" to the server', async () => {
    const store = await fresh();
    const asked: string[] = [];
    apiRequest.mockImplementation((url: string) => { asked.push(url); return Promise.resolve({ success: true }); });
    expect(await store.dismiss(STRAY)).toBe(true);
    expect(asked).toEqual([`/api/v1/shares/inbox/${STRAY}/dismiss?share_only=true`]);
  });

  it('one whose dismissal fails is still not listed, and is tried again at the next refresh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await fresh();
    contents();
    const dismissed = server(() => ({ shares: rows(), has_more: false, declined_notebooks: [D(NB)] }), { success: false, status: 500 });
    await store.load();
    await settle();
    expect(store.shares().map(s => s.shareId)).toEqual([KEPT]);
    expect(dismissed).toEqual([STRAY]);
    expect(warn.mock.calls.some(c => String(c[0]).includes('a note of a declined notebook could not be dismissed'))).toBe(true);
    contents();
    await store.load();
    await settle();
    expect(store.shares().map(s => s.shareId)).toEqual([KEPT]);
    expect(dismissed).toEqual([STRAY, STRAY]);
    warn.mockRestore();
  });

  it('nothing is dismissed when the server names no declined notebook', async () => {
    const store = await fresh();
    contents();
    const dismissed = server(() => ({ shares: rows(), has_more: false, declined_notebooks: [] }));
    await store.load();
    await settle();
    expect(dismissed).toEqual([]);
    expect(store.shares()).toHaveLength(2);
  });
});

/** One request that the server carries out whole. */
describe('declining a notebook in one request', () => {
  const NB = '77777777-1111-4000-8000-000000000007';
  const NB_ROW = 'aaaaaaaa-0000-4000-8000-0000000000d1';
  const NOTE_ROW = 'aaaaaaaa-0000-4000-8000-0000000000d2';
  const KEPT_ROW = 'aaaaaaaa-0000-4000-8000-0000000000d3';
  const inboxRows = () => [
    share({ share_id: NB_ROW, item_id: NB, item_type: 2 }),
    share({ share_id: NOTE_ROW, item_id: 'cccccccc-1111-4000-8000-00000000000c' }),
    share({ share_id: KEPT_ROW, item_id: 'cccccccc-2222-4000-8000-00000000000c' }),
  ];
  /** A server holding `rows`, whose decline answers `declineAnswer`; every decline request is kept. */
  function server(rows: () => unknown[], declineAnswer: unknown) {
    const declines: { url: string; body: unknown; method: unknown }[] = [];
    apiRequest.mockImplementation((url: string, opts?: { method?: string; body?: unknown }) => {
      if (url.startsWith('/api/v1/shares/inbox')) return Promise.resolve({ success: true, data: { shares: rows(), has_more: false } });
      if (url === '/api/v1/users/public-keys') {
        return Promise.resolve({ success: true, data: { users: [{ email: 'sender@example.com', user_id: SENDER, sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32) }] } });
      }
      if (url.includes('/decline')) { declines.push({ url, body: opts?.body, method: opts?.method }); return Promise.resolve(declineAnswer); }
      return Promise.resolve({ success: false });
    });
    return declines;
  }
  async function fresh() {
    vi.resetModules();
    (await import('../lib/account')).setTabAccount(ME);
    const mod = await import('./sharesInbox');
    const own = await import('../lib/ownNotes');
    own.registerOwnNoteCheck(() => false);
    own.registerOwnNotebookCheck(() => false);
    return mod;
  }

  it('is one POST naming the notebook and the shares, each once', async () => {
    const { sharesInboxStore: store } = await fresh();
    const declines = server(inboxRows, { success: true, data: { dismissed: [NB_ROW, NOTE_ROW] } });
    expect(await store.declineNotebook(NB, [NOTE_ROW, NB_ROW, NOTE_ROW])).toBe(true);
    expect(declines).toEqual([{
      url: `/api/v1/shares/notebooks/${NB}/decline`,
      method: 'POST',
      body: { share_ids: [NOTE_ROW, NB_ROW] },
    }]);
  });

  it('takes what the server dismissed off the page at once, and nothing else', async () => {
    const { sharesInboxStore: store } = await fresh();
    server(inboxRows, { success: true, data: { dismissed: [NB_ROW, NOTE_ROW] } });
    await store.load();
    expect(store.shares().map(s => s.shareId).sort()).toEqual([NB_ROW, NOTE_ROW, KEPT_ROW].sort());
    expect(await store.declineNotebook(NB, [NOTE_ROW])).toBe(true);
    expect(store.shares().map(s => s.shareId)).toEqual([KEPT_ROW]);
  });

  /**
   * The refresh that follows a decline reads a replica that may not have the
   * dismissal yet. Its answer must not put the declined invitation back on
   * screen, reading "new", until the next refresh.
   */
  it('an older answer that still carries the dismissed shares does not bring them back', async () => {
    const { sharesInboxStore: store } = await fresh();
    server(inboxRows, { success: true, data: { dismissed: [NB_ROW, NOTE_ROW] } });
    await store.load();
    await store.declineNotebook(NB, [NOTE_ROW]);
    // The server's answer is unchanged: all three rows, the dismissed two included.
    expect(await store.load()).toBe(true);
    expect(store.shares().map(s => s.shareId)).toEqual([KEPT_ROW]);
    expect(store.sharedNotebooks()).toEqual([]);
    expect([...store.listedNotebookIds()!]).toEqual([]);
  });

  it('an invitation sent again is another row, and is shown', async () => {
    const { sharesInboxStore: store } = await fresh();
    let rows = inboxRows();
    server(() => rows, { success: true, data: { dismissed: [NB_ROW, NOTE_ROW] } });
    await store.load();
    store.markDeclined(NB, [NB_ROW]);
    await store.declineNotebook(NB, [NOTE_ROW]);
    const AGAIN = 'aaaaaaaa-0000-4000-8000-0000000000d9';
    rows = [share({ share_id: AGAIN, item_id: NB, item_type: 2 })];
    await store.load();
    expect(store.sharedNotebooks().map(s => s.shareId)).toEqual([AGAIN]);
    expect([...store.declinedNotebooks()]).toEqual([]);
  });

  it('a share this page refuses to open leaves its banner too', async () => {
    const { sharesInboxStore: store } = await fresh();
    // Its sender's signature does not verify against their pin: refused, and listed as such.
    getPinnedUserKeys.mockReturnValue({ signingPubkeyHex: 'bb'.repeat(32), sharingPubkeyHex: 'aa'.repeat(32) });
    verifyNoteShareWrapGen.mockReturnValue({ verified: false, effectiveGeneration: 1 });
    server(() => [share({ share_id: NB_ROW, item_id: NB, item_type: 2, wrap_signature: 'ee'.repeat(64) })], { success: true, data: { dismissed: [NB_ROW] } });
    await store.load();
    expect(store.blockedShares().map(b => b.shareId)).toEqual([NB_ROW]);
    expect(await store.declineNotebook(NB, [NB_ROW])).toBe(true);
    expect(store.blockedShares()).toEqual([]);
  });

  /** Nothing was dismissed, so nothing leaves the page, and a later answer still shows it all. */
  it('a decline the server did not take changes nothing here', async () => {
    for (const answer of [
      { success: false, status: 500 },
      { success: false, status: 400, error: 'Too many shares in one decline' },
      { success: false, error: 'Network error' },
      // A server without the route: a 404 with no body, which the client reports with no status.
      { success: false, error: 'Unexpected end of JSON input' },
      { success: false, status: 404, error: 'Not found' },
    ]) {
      const { sharesInboxStore: store } = await fresh();
      server(inboxRows, answer);
      await store.load();
      expect(await store.declineNotebook(NB, [NOTE_ROW]), JSON.stringify(answer)).toBe(false);
      expect(store.shares()).toHaveLength(3);
      await store.load();
      expect(store.shares()).toHaveLength(3);
    }
  });

  it('a yes with no list of what was dismissed is still a yes', async () => {
    const { sharesInboxStore: store } = await fresh();
    server(inboxRows, { success: true, data: null });
    expect(await store.declineNotebook(NB, [])).toBe(true);
  });

  it('names no more shares than the server takes in one decline', async () => {
    const { sharesInboxStore: store, DECLINE_MAX_SHARE_IDS } = await fresh();
    const declines = server(inboxRows, { success: true, data: { dismissed: [] } });
    await store.declineNotebook(NB, Array.from({ length: DECLINE_MAX_SHARE_IDS + 50 }, (_, i) => `id-${i}`));
    expect((declines[0].body as { share_ids: string[] }).share_ids).toHaveLength(DECLINE_MAX_SHARE_IDS);
    expect(DECLINE_MAX_SHARE_IDS).toBe(10_000);
  });
});

describe('dismissing, and accepting after all', () => {
  const dismissAnswers = (answer: unknown) => apiRequest.mockImplementation(() => Promise.resolve(answer));

  it('a dismissal the server took is a dismissal', async () => {
    dismissAnswers({ success: true });
    expect(await sharesInboxStore.dismiss('s')).toBe(true);
  });

  /** The owner withdrew it meanwhile: it is gone, which is what a dismissal wants. */
  it('a share that is no longer there (404) counts as dismissed', async () => {
    dismissAnswers({ success: false, status: 404, error: 'Share not found' });
    expect(await sharesInboxStore.dismiss('s')).toBe(true);
  });

  it('any other failure is a failure', async () => {
    for (const answer of [{ success: false, status: 500 }, { success: false, status: 429 }, { success: false, error: 'Network error' }]) {
      dismissAnswers(answer);
      expect(await sharesInboxStore.dismiss('s')).toBe(false);
    }
  });

  /** As for a decline: the next refresh may read a replica that has not got the dismissal yet. */
  it('a share dismissed here is not brought back by an older answer, and one whose dismissal failed is', async () => {
    const GONE = 'aaaaaaaa-0000-4000-8000-0000000000e1';
    const STAYS = 'aaaaaaaa-0000-4000-8000-0000000000e2';
    const rows = [share({ share_id: GONE, item_id: THEIRS }), share({ share_id: STAYS, item_id: 'cccccccc-3333-4000-8000-00000000000c' })];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: rows });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      if (url === `/api/v1/shares/inbox/${GONE}/dismiss?share_only=true`) return Promise.resolve({ success: true });
      return Promise.resolve({ success: false, status: 500 });
    });
    await sharesInboxStore.load();
    expect(await sharesInboxStore.dismiss(GONE)).toBe(true);
    expect(await sharesInboxStore.dismiss(STAYS)).toBe(false);
    await sharesInboxStore.load();
    expect(sharesInboxStore.shares().map(s => s.shareId)).toEqual([STAYS]);
  });

  it('accepting a notebook lifts a decline mark set earlier on this page, and only that one', () => {
    sharesInboxStore.markDeclined('changed-my-mind', ['r1']);
    sharesInboxStore.markDeclined('still-no', ['r2']);
    sharesInboxStore.clearDeclined('changed-my-mind');
    expect([...sharesInboxStore.declinedNotebooks()]).not.toContain('changed-my-mind');
    expect([...sharesInboxStore.declinedNotebooks()]).toContain('still-no');
    sharesInboxStore.clearDeclined('never-declined');
    expect([...sharesInboxStore.declinedNotebooks()]).toContain('still-no');
  });
});

/**
 * Refreshes overlap. If each applied its rows whenever it finished, one that
 * started BEFORE a decline could finish after the decline's own refresh and
 * put the dismissed rows back. Only the newest one applies.
 */
describe('two refreshes at once', () => {
  const NB_OLD = 'aaaaaaaa-1111-4000-8000-00000000000a';
  const NB_NEW = 'bbbbbbbb-1111-4000-8000-00000000000b';
  /** The inbox request is answered when the test says so; the key lookup at once. */
  function held() {
    const answers: ((rows: unknown[] | 'fail') => void)[] = [];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox')) {
        return new Promise((resolve) => answers.push((rows) => resolve(rows === 'fail' ? { success: false, status: 503 } : { success: true, data: rows })));
      }
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      return Promise.resolve({ success: false });
    });
    return answers;
  }
  const settle = () => new Promise(r => setTimeout(r, 0));

  it('the older one, finishing last, applies nothing and is not the list', async () => {
    const answers = held();
    const older = sharesInboxStore.load();
    await settle();
    const newer = sharesInboxStore.load();
    await settle();
    expect(answers).toHaveLength(2);
    answers[1]([share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000b1', item_id: NB_NEW, item_type: 2 })]);
    expect(await newer).toBe(true);
    expect(sharesInboxStore.sharedNotebooks().map(s => s.itemId)).toEqual([NB_NEW]);
    // The older answer arrives now, with the row the newer one no longer has.
    answers[0]([share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000b0', item_id: NB_OLD, item_type: 2 })]);
    expect(await older).toBe(false);
    expect(sharesInboxStore.sharedNotebooks().map(s => s.itemId)).toEqual([NB_NEW]);
    expect([...sharesInboxStore.listedNotebookIds()!]).toEqual([NB_NEW]);
  });

  it('the older one failing last does not empty what the newer one showed', async () => {
    const answers = held();
    const older = sharesInboxStore.load();
    await settle();
    const newer = sharesInboxStore.load();
    await settle();
    answers[1]([share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000b1', item_id: NB_NEW, item_type: 2 })]);
    await newer;
    answers[0]('fail');
    expect(await older).toBe(false);
    expect(sharesInboxStore.sharedNotebooks().map(s => s.itemId)).toEqual([NB_NEW]);
  });

  it('one refresh alone applies as it always did', async () => {
    const answers = held();
    const only = sharesInboxStore.load();
    await settle();
    answers[0]([share({ share_id: 'aaaaaaaa-0000-4000-8000-0000000000b0', item_id: NB_OLD, item_type: 2 })]);
    expect(await only).toBe(true);
    expect(sharesInboxStore.sharedNotebooks().map(s => s.itemId)).toEqual([NB_OLD]);
  });
});

/**
 * The edges of "which refresh applies". The rule is: an answer is
 * applied unless a refresh that started LATER has already applied its
 * own.
 */
describe('refreshes that overlap: the newest APPLIED wins', () => {
  const NB_OLD = 'aaaaaaaa-2222-4000-8000-00000000000a';
  const NB_NEW = 'bbbbbbbb-2222-4000-8000-00000000000b';
  const row = (id: string, item: string, over: Record<string, unknown> = {}) => share({ share_id: id, item_id: item, item_type: 2, ...over });
  async function fresh() {
    vi.resetModules();
    const account = await import('../lib/account');
    account.setTabAccount(ME);
    const mod = await import('./sharesInbox');
    const own = await import('../lib/ownNotes');
    own.registerOwnNoteCheck(() => false);
    own.registerOwnNotebookCheck(() => false);
    return { account, store: mod.sharesInboxStore };
  }
  /** The inbox request is answered when the test says so; everything else at once. */
  function held(other: (url: string) => unknown = () => ({ success: false })) {
    const answers: ((rows: unknown[] | 'fail') => void)[] = [];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) {
        return new Promise((resolve) => answers.push((rows) => resolve(rows === 'fail' ? { success: false, status: 503 } : { success: true, data: { shares: rows, has_more: false } })));
      }
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      return Promise.resolve(other(url));
    });
    return answers;
  }
  const settle = () => new Promise(r => setTimeout(r, 0));

  /**
   * The newer refresh's first page fails and empties the screen; the older
   * one's good list, landing a moment later, must not be thrown away for
   * being older, or the inbox stays empty until the next refresh.
   */
  it('a newer refresh that fails does not throw away the list an older one read', async () => {
    const { store } = await fresh();
    const answers = held();
    // Something is on screen first, so that "emptied" below is a real change.
    const first = store.load();
    await settle();
    answers[0]([row('aaaaaaaa-0000-4000-8000-0000000000c0', NB_NEW)]);
    await first;
    expect(store.sharedNotebooks().map(s => s.itemId)).toEqual([NB_NEW]);

    const older = store.load();
    await settle();
    const newer = store.load();
    await settle();
    // The NEWEST refresh failed and none later has applied: the screen is emptied (a failed
    // inbox is not "what was there before").
    answers[2]('fail');
    expect(await newer).toBe(false);
    expect(store.sharedNotebooks()).toEqual([]);
    // And the older one's good list, landing a moment later, is applied all the same.
    answers[1]([row('aaaaaaaa-0000-4000-8000-0000000000a0', NB_OLD)]);
    expect(await older).toBe(true);
    expect(store.sharedNotebooks().map(s => s.itemId)).toEqual([NB_OLD]);
    expect([...store.listedNotebookIds()!]).toEqual([NB_OLD]);
  });

  /**
   * An OLDER refresh that fails while a NEWER one is still reading must
   * not empty the screen under it: until the newer one landed, the notes
   * of unanswered invitations would be released into the grid and
   * "Shared with me" would be blank.
   */
  it('an older refresh that fails while a newer one is still reading empties nothing', async () => {
    const { store } = await fresh();
    const answers = held();
    const applied = store.load();
    await settle();
    answers[0]([row('aaaaaaaa-0000-4000-8000-0000000000c0', NB_NEW)]);
    await applied;

    const older = store.load();
    await settle();
    const newer = store.load();
    await settle();
    answers[1]('fail');
    expect(await older).toBe(false);
    // The newer one is still on its way: what was on screen stays.
    expect(store.sharedNotebooks().map(s => s.itemId)).toEqual([NB_NEW]);
    expect([...store.listedNotebookIds()!]).toEqual([NB_NEW]);
    expect(store.loading()).toBe(true);
    answers[2]([row('aaaaaaaa-0000-4000-8000-0000000000a0', NB_OLD)]);
    expect(await newer).toBe(true);
    expect(store.sharedNotebooks().map(s => s.itemId)).toEqual([NB_OLD]);
  });

  it('and when that newer one fails too, the screen is emptied then', async () => {
    const { store } = await fresh();
    const answers = held();
    const applied = store.load();
    await settle();
    answers[0]([row('aaaaaaaa-0000-4000-8000-0000000000c0', NB_NEW)]);
    await applied;

    const older = store.load();
    await settle();
    const newer = store.load();
    await settle();
    answers[1]('fail');
    await older;
    expect(store.sharedNotebooks()).toHaveLength(1);
    answers[2]('fail');
    expect(await newer).toBe(false);
    expect(store.sharedNotebooks()).toEqual([]);
  });

  /**
   * An older refresh that answers FIRST is applied, though a newer one has
   * started, so "answered" comes with its list: discarded while still
   * marking the inbox "answered", it would release the hold on a pending
   * invitation's notes with no list applied.
   */
  it('an older refresh that answers first is applied, and the inbox is "answered" with its list on screen', async () => {
    const { store } = await fresh();
    const answers = held();
    const older = store.load();
    await settle();
    const newer = store.load();
    await settle();
    expect(store.answered()).toBe(false);
    answers[0]([row('aaaaaaaa-0000-4000-8000-0000000000a0', NB_OLD)]);
    expect(await older).toBe(true);
    expect(store.answered()).toBe(true);
    expect(store.sharedNotebooks().map(s => s.itemId)).toEqual([NB_OLD]);
    // Still loading: the later refresh is under way.
    expect(store.loading()).toBe(true);
    answers[1]([row('aaaaaaaa-0000-4000-8000-0000000000b0', NB_NEW)]);
    expect(await newer).toBe(true);
    expect(store.sharedNotebooks().map(s => s.itemId)).toEqual([NB_NEW]);
    expect(store.loading()).toBe(false);
  });

  it('an older refresh that finishes after a newer one has applied puts nothing on screen', async () => {
    const { store } = await fresh();
    const answers = held();
    const older = store.load();
    await settle();
    const newer = store.load();
    await settle();
    answers[1]([row('aaaaaaaa-0000-4000-8000-0000000000b0', NB_NEW)]);
    expect(await newer).toBe(true);
    answers[0]([row('aaaaaaaa-0000-4000-8000-0000000000a0', NB_OLD)]);
    expect(await older).toBe(false);
    expect(store.sharedNotebooks().map(s => s.itemId)).toEqual([NB_NEW]);
    // And failing instead, it does not empty what the newer one showed.
    const stale = store.load();
    await settle();
    const fresher = store.load();
    await settle();
    answers[3]([row('aaaaaaaa-0000-4000-8000-0000000000b0', NB_NEW)]);
    await fresher;
    answers[2]('fail');
    expect(await stale).toBe(false);
    expect(store.sharedNotebooks().map(s => s.itemId)).toEqual([NB_NEW]);
  });

  /**
   * A decline that goes through WHILE an answer is being opened: that
   * answer still holds the invitation, and it was filtered when it arrived,
   * before the decline. It is filtered again when it is applied.
   */
  it('a share dismissed while its answer was being opened is not put on screen by that answer', async () => {
    const { store } = await fresh();
    const NB = '77777777-3333-4000-8000-000000000007';
    const NB_ROW = 'aaaaaaaa-0000-4000-8000-0000000000e7';
    const NOTE_ROW = 'aaaaaaaa-0000-4000-8000-0000000000e8';
    let releaseKeys: (v: unknown) => void = () => {};
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) {
        return Promise.resolve({ success: true, data: { shares: [
          share({ share_id: NB_ROW, item_id: NB, item_type: 2 }),
          share({ share_id: NOTE_ROW, item_id: 'cccccccc-9999-4000-8000-00000000000c' }),
        ], has_more: false } });
      }
      // The answer has arrived and is being opened: the senders' keys are still on their way.
      if (url === '/api/v1/users/public-keys') return new Promise((resolve) => { releaseKeys = resolve; });
      if (url.includes('/decline')) return Promise.resolve({ success: true, data: { dismissed: [NB_ROW, NOTE_ROW] } });
      return Promise.resolve({ success: false });
    });
    const opening = store.load();
    await settle();
    expect(await store.declineNotebook(NB, [NOTE_ROW])).toBe(true);
    releaseKeys({ success: true, data: { users: [{ email: 'sender@example.com', user_id: SENDER, sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32) }] } });
    expect(await opening).toBe(true);
    expect(store.shares()).toEqual([]);
    expect([...store.listedNotebookIds()!]).toEqual([]);
  });

  /** As for a dismissal and a decline, an older answer does not bring a blocked sender's shares back. */
  it('a blocked sender\'s shares are not brought back by an older answer', async () => {
    const { store } = await fresh();
    const THEIRS_ROW = 'aaaaaaaa-0000-4000-8000-0000000000e9';
    const rows = [share({ share_id: THEIRS_ROW, item_id: 'cccccccc-aaaa-4000-8000-00000000000c' })];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: { shares: rows, has_more: false } });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      if (url === '/api/v1/shares/block') return Promise.resolve({ success: true });
      return Promise.resolve({ success: false });
    });
    await store.load();
    expect(store.shares().map(s => s.shareId)).toEqual([THEIRS_ROW]);
    expect(await store.blockSender('Sender@Example.com')).toBe(true);
    expect(store.shares()).toEqual([]);
    await store.load();
    expect(store.shares()).toEqual([]);
  });

  /**
   * A share of theirs that this page would not open is theirs too. Left on
   * the "could not be opened" banner until the next refresh, it would ask
   * the reader about a sender they had just blocked.
   */
  it('a block takes the sender\'s shares this page would not open off the banner too, and nobody else\'s', async () => {
    const { store } = await fresh();
    const OPENED = 'aaaaaaaa-0000-4000-8000-0000000000f1';
    const REFUSED = 'aaaaaaaa-0000-4000-8000-0000000000f2';
    const ANOTHERS = 'aaaaaaaa-0000-4000-8000-0000000000f3';
    const rows = [
      share({ share_id: OPENED, item_id: 'cccccccc-aaaa-4000-8000-0000000000f1' }),
      // No UUID for an item: refused as damaged, whoever sent it.
      share({ share_id: REFUSED, item_id: 'not-an-id', owner_email: 'SENDER@example.com' }),
      share({ share_id: ANOTHERS, item_id: 'not-an-id-either', owner_email: 'another@example.com' }),
    ];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: { shares: rows, has_more: false } });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      if (url === '/api/v1/shares/block') return Promise.resolve({ success: true });
      return Promise.resolve({ success: false });
    });
    await store.load();
    expect(store.shares().map(s => s.shareId)).toEqual([OPENED]);
    expect(store.blockedShares().map(s => s.shareId).sort()).toEqual([REFUSED, ANOTHERS].sort());

    expect(await store.blockSender('sender@example.com')).toBe(true);
    expect(store.shares()).toEqual([]);
    expect(store.blockedShares().map(s => s.shareId)).toEqual([ANOTHERS]);

    // An older answer that still carries them brings neither back.
    await store.load();
    expect(store.shares()).toEqual([]);
    expect(store.blockedShares().map(s => s.shareId)).toEqual([ANOTHERS]);
  });

  it('a block the server did not take leaves every share where it was', async () => {
    const { store } = await fresh();
    const OPENED = 'aaaaaaaa-0000-4000-8000-0000000000f4';
    const REFUSED = 'aaaaaaaa-0000-4000-8000-0000000000f5';
    const rows = [
      share({ share_id: OPENED, item_id: 'cccccccc-aaaa-4000-8000-0000000000f4' }),
      share({ share_id: REFUSED, item_id: 'not-an-id' }),
    ];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: { shares: rows, has_more: false } });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      return Promise.resolve({ success: false });
    });
    await store.load();
    expect(await store.blockSender('sender@example.com')).toBe(false);
    expect(store.shares().map(s => s.shareId)).toEqual([OPENED]);
    expect(store.blockedShares().map(s => s.shareId)).toEqual([REFUSED]);
    await store.load();
    expect(store.shares().map(s => s.shareId)).toEqual([OPENED]);
    expect(store.blockedShares().map(s => s.shareId)).toEqual([REFUSED]);
  });

  /**
   * A block pressed on an invitation says which notebook it declines and
   * which shares go with it, in the ONE request; and those shares leave this
   * page whoever sent them (a contributor's note in the notebook is not the
   * blocked sender's).
   */
  it('a block pressed on an invitation names the notebook and its shares, and takes them off the page too', async () => {
    const { store } = await fresh();
    const THEIRS_ROW = 'aaaaaaaa-0000-4000-8000-0000000000a1';
    const CONTRIBUTORS = 'aaaaaaaa-0000-4000-8000-0000000000a2';
    const UNRELATED = 'aaaaaaaa-0000-4000-8000-0000000000a3';
    const NB = 'dddddddd-0000-4000-8000-0000000000d1';
    const rows = [
      share({ share_id: THEIRS_ROW, item_id: 'cccccccc-aaaa-4000-8000-0000000000a1' }),
      share({ share_id: CONTRIBUTORS, item_id: 'cccccccc-aaaa-4000-8000-0000000000a2', owner_email: 'contributor@example.com' }),
      share({ share_id: UNRELATED, item_id: 'cccccccc-aaaa-4000-8000-0000000000a3', owner_email: 'another@example.com' }),
    ];
    const asked: unknown[] = [];
    apiRequest.mockImplementation((url: string, opts?: { body?: unknown }) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: { shares: rows, has_more: false } });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      if (url === '/api/v1/shares/block') { asked.push(opts?.body); return Promise.resolve({ success: true }); }
      return Promise.resolve({ success: false });
    });
    await store.load();
    expect(store.shares()).toHaveLength(3);

    expect(await store.blockSender('sender@example.com', { notebookId: NB, shareIds: [CONTRIBUTORS, CONTRIBUTORS, 'nb-row'] })).toBe(true);
    // One request, with the notebook and each named share once.
    expect(asked).toEqual([{ email: 'sender@example.com', decline_notebook_id: NB, share_ids: [CONTRIBUTORS, 'nb-row'], unanswered_notebook_ids: [] }]);
    expect(store.shares().map(s => s.shareId)).toEqual([UNRELATED]);
    // An older answer that still carries them brings neither back.
    await store.load();
    expect(store.shares().map(s => s.shareId)).toEqual([UNRELATED]);
  });

  it('a share named for the decline that the page had not loaded is not brought in by an older answer', async () => {
    const { store } = await fresh();
    const NAMED = 'aaaaaaaa-0000-4000-8000-0000000000c1';
    let rows: unknown[] = [];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: { shares: rows, has_more: false } });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      if (url === '/api/v1/shares/block') return Promise.resolve({ success: true });
      return Promise.resolve({ success: false });
    });
    await store.load();
    expect(await store.blockSender('sender@example.com', { notebookId: 'dddddddd-0000-4000-8000-0000000000d3', shareIds: [NAMED] })).toBe(true);
    // An answer from before the block still carries it (a contributor's note in the notebook).
    rows = [share({ share_id: NAMED, item_id: 'cccccccc-aaaa-4000-8000-0000000000c1', owner_email: 'contributor@example.com' })];
    await store.load();
    expect(store.shares()).toEqual([]);
  });

  /** A list that could not be read is not an empty one. */
  it('the blocked people are a list, or null when the list could not be read', async () => {
    const { store } = await fresh();
    const people = [{ blocked_email: 'sam@example.test', created_at: '2026-10-07T00:00:00Z' }];
    apiRequest.mockImplementation(() => Promise.resolve({ success: true, data: people }));
    expect(await store.listBlocks()).toEqual(people);
    apiRequest.mockImplementation(() => Promise.resolve({ success: true, data: [] }));
    expect(await store.listBlocks()).toEqual([]);
    apiRequest.mockImplementation(() => Promise.resolve({ success: false, status: 503 }));
    expect(await store.listBlocks()).toBeNull();
    apiRequest.mockImplementation(() => Promise.resolve({ success: true, data: { not: 'a list' } }));
    expect(await store.listBlocks()).toBeNull();
  });

  it('a block made anywhere else names no notebook it was pressed on', async () => {
    const { store } = await fresh();
    const asked: unknown[] = [];
    apiRequest.mockImplementation((url: string, opts?: { body?: unknown }) => {
      if (url === '/api/v1/shares/block') { asked.push(opts?.body); return Promise.resolve({ success: true }); }
      return Promise.resolve({ success: false });
    });
    expect(await store.blockSender('sender@example.com')).toBe(true);
    expect(asked).toEqual([{ email: 'sender@example.com', unanswered_notebook_ids: [] }]);
  });

  /**
   * A block declines that person's unanswered notebooks. The page names
   * them; the server says which it declined, and those are declined on
   * this page at once.
   */
  describe('a block with the sender\'s unanswered notebooks', () => {
    const NB1 = 'dddddddd-0000-4000-8000-0000000000e1';
    const NB2 = 'dddddddd-0000-4000-8000-0000000000e2';
    const NOT_THEIRS = 'dddddddd-0000-4000-8000-0000000000e3';
    const blocking = async (answer: unknown) => {
      const { store } = await fresh();
      const asked: unknown[] = [];
      apiRequest.mockImplementation((url: string, opts?: { body?: unknown }) => {
        if (url === '/api/v1/shares/block') { asked.push(opts?.body); return Promise.resolve(answer); }
        return Promise.resolve({ success: false });
      });
      return { store, asked };
    };

    it('names each of them once, in one request with the block', async () => {
      const { store, asked } = await blocking({ success: true, data: { declined_notebooks: [NB1, NB2] } });
      expect(await store.blockSender('sender@example.com', undefined, [NB1, NB2, NB1, NOT_THEIRS])).toBe(true);
      expect(asked).toEqual([{ email: 'sender@example.com', unanswered_notebook_ids: [NB1, NB2, NOT_THEIRS] }]);
    });

    it('what the SERVER says it declined is declined here at once, and nothing else that was named', async () => {
      const { store } = await blocking({ success: true, data: { declined_notebooks: [NB1.toUpperCase(), NB2] } });
      expect([...store.declinedNotebooks()]).toEqual([]);
      await store.blockSender('sender@example.com', undefined, [NB1, NB2, NOT_THEIRS]);
      expect([...store.declinedNotebooks()].sort()).toEqual([NB1, NB2]);
    });

    it('an older server answers with no list: the block is made, and nothing is taken for declined', async () => {
      for (const answer of [{ success: true, data: null }, { success: true }, { success: true, data: { declined_notebooks: 'no list' } }]) {
        const { store } = await blocking(answer);
        expect(await store.blockSender('sender@example.com', undefined, [NB1])).toBe(true);
        expect([...store.declinedNotebooks()]).toEqual([]);
      }
    });

    it('what is not an id in the answer is passed over', async () => {
      const { store } = await blocking({ success: true, data: { declined_notebooks: [NB1, '', 7, null] } });
      await store.blockSender('sender@example.com', undefined, [NB1]);
      expect([...store.declinedNotebooks()]).toEqual([NB1]);
    });

    it('a block the server did not take declines nothing here', async () => {
      const { store } = await blocking({ success: false, status: 503, data: { declined_notebooks: [NB1] } });
      expect(await store.blockSender('sender@example.com', undefined, [NB1])).toBe(false);
      expect([...store.declinedNotebooks()]).toEqual([]);
    });

    /**
     * A decline remembers the shares it dismissed: a row of the notebook that
     * is NOT one of them is the notebook offered anew, and ends the decline.
     * Marked again by the block's answer with that memory emptied, the very
     * row the reader declined would have read as a new offer.
     */
    it('a notebook declined here before keeps the shares it was declined with', async () => {
      const ROW = 'aaaaaaaa-0000-4000-8000-0000000000e9';
      const { store } = await fresh();
      apiRequest.mockImplementation((url: string) => {
        if (url === '/api/v1/shares/block') return Promise.resolve({ success: true, data: { declined_notebooks: [NB1] } });
        // An answer from before the decline landed: it still serves the notebook's own row.
        if (url.startsWith('/api/v1/shares/inbox?')) {
          return Promise.resolve({ success: true, data: { shares: [share({ share_id: ROW, item_id: NB1, item_type: 2 })], has_more: false } });
        }
        if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
        return Promise.resolve({ success: false });
      });
      store.markDeclined(NB1, [ROW]);
      await store.blockSender('someone.else@example.com', undefined, [NB1]);
      expect([...store.declinedNotebooks()]).toEqual([NB1]);
      await store.load();
      expect([...store.declinedNotebooks()], 'the row it was declined with is not a new offer').toEqual([NB1]);
    });

    it('the block pressed on an invitation names the others as well', async () => {
      const { store, asked } = await blocking({ success: true, data: { declined_notebooks: [NB2] } });
      await store.blockSender('sender@example.com', { notebookId: NB1, shareIds: [] }, [NB1, NB2]);
      expect(asked).toEqual([{ email: 'sender@example.com', decline_notebook_id: NB1, share_ids: [], unanswered_notebook_ids: [NB1, NB2] }]);
      expect([...store.declinedNotebooks()]).toContain(NB2);
    });
  });

  it('a block pressed on an invitation that the server did not take leaves every share where it was', async () => {
    const { store } = await fresh();
    const THEIRS_ROW = 'aaaaaaaa-0000-4000-8000-0000000000b1';
    const CONTRIBUTORS = 'aaaaaaaa-0000-4000-8000-0000000000b2';
    const rows = [
      share({ share_id: THEIRS_ROW, item_id: 'cccccccc-aaaa-4000-8000-0000000000b1' }),
      share({ share_id: CONTRIBUTORS, item_id: 'cccccccc-aaaa-4000-8000-0000000000b2', owner_email: 'contributor@example.com' }),
    ];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: { shares: rows, has_more: false } });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      return Promise.resolve({ success: false, status: 503 });
    });
    await store.load();
    expect(await store.blockSender('sender@example.com', { notebookId: 'dddddddd-0000-4000-8000-0000000000d2', shareIds: [CONTRIBUTORS] })).toBe(false);
    expect(store.shares().map(s => s.shareId).sort()).toEqual([THEIRS_ROW, CONTRIBUTORS].sort());
    await store.load();
    expect(store.shares().map(s => s.shareId).sort()).toEqual([THEIRS_ROW, CONTRIBUTORS].sort());
  });

  /** What this page dismissed is one account's; the next account starts with nothing remembered. */
  it('the shares dismissed on this page are forgotten when the account changes', async () => {
    const { account, store } = await fresh();
    const ROW = 'aaaaaaaa-0000-4000-8000-0000000000ea';
    const rows = [share({ share_id: ROW, item_id: 'cccccccc-bbbb-4000-8000-00000000000c' })];
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: { shares: rows, has_more: false } });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      if (url === `/api/v1/shares/inbox/${ROW}/dismiss?share_only=true`) return Promise.resolve({ success: true });
      return Promise.resolve({ success: false });
    });
    await store.load();
    expect(await store.dismiss(ROW)).toBe(true);
    await store.load();
    expect(store.shares()).toEqual([]);
    account.setTabAccount('33333333-3333-4333-8333-333333333333');
    await store.load();
    expect(store.shares().map(s => s.shareId)).toEqual([ROW]);
  });
});

/** The key lookup takes at most 100 addresses a request, and an inbox read to its end can name more. */
describe('looking up many senders\' keys', () => {
  it('asks in requests of at most 100 addresses, and for every sender once', async () => {
    const asked: string[][] = [];
    const rows = Array.from({ length: 230 }, (_, i) => share({
      share_id: `7c7c7c7c-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
      item_id: `8d8d8d8d-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
      owner_email: `sender${i}@example.com`,
    }));
    apiRequest.mockImplementation((url: string, opts?: { body?: { emails: string[] } }) => {
      if (url.startsWith('/api/v1/shares/inbox')) return Promise.resolve({ success: true, data: rows });
      if (url === '/api/v1/users/public-keys') { asked.push(opts!.body!.emails); return Promise.resolve({ success: true, data: { users: [] } }); }
      return Promise.resolve({ success: false });
    });
    await sharesInboxStore.load();
    expect(asked.map(a => a.length)).toEqual([100, 100, 30]);
    expect(KEY_LOOKUP_MAX).toBe(100);
    expect(new Set(asked.flat()).size).toBe(230);
  });
});

describe('what one account\'s page learned', () => {
  /** A store no refresh has touched, with its own account module: the one above outlives this file. */
  async function untouched() {
    vi.resetModules();
    const account = await import('../lib/account');
    account.setTabAccount(ME);
    const { sharesInboxStore: fresh } = await import('./sharesInbox');
    return { account, fresh };
  }

  it('starts with no list and nothing declined', async () => {
    const { fresh } = await untouched();
    expect(fresh.listedNotebookIds()).toBeNull();
    expect([...fresh.declinedNotebooks()]).toEqual([]);
    expect(fresh.answered()).toBe(false);
  });

  it('is not carried to the next account', async () => {
    const { account, fresh } = await untouched();
    const NB = 'eeeeeeee-0000-4000-8000-00000000000e';
    serve([share({ item_id: NB, item_type: 2 })]);
    await fresh.load();
    fresh.markDeclined('declined-by-the-first');
    expect([...fresh.listedNotebookIds()!]).toEqual([NB]);
    account.setTabAccount(null);
    expect(fresh.listedNotebookIds()).toBeNull();
    expect([...fresh.declinedNotebooks()]).toEqual([]);
  });
});

/**
 * Three answers that every card and every synced note asks for are worked
 * out once per list (lib/listIndex) instead of by a walk of the whole list
 * each time. What must not change: an answer is about the list as it is at
 * that moment.
 */
describe('what the cards and the sync ask of the inbox', () => {
  const ITEM_A = 'abcdef01-1111-4000-8000-00000000000a';
  const ITEM_B = 'abcdef01-2222-4000-8000-00000000000b';
  const ITEM_C = 'abcdef01-3333-4000-8000-00000000000c';
  const NOTEBOOK = 'abcdef01-4444-4000-8000-00000000000d';
  const ROW_A = 'a0a0a0a0-0000-4000-8000-0000000000a1';
  const ROW_B = 'a0a0a0a0-0000-4000-8000-0000000000b1';
  const ROW_C = 'a0a0a0a0-0000-4000-8000-0000000000c1';
  const ROW_NB = 'a0a0a0a0-0000-4000-8000-0000000000d1';

  async function fresh() {
    vi.resetModules();
    (await import('../lib/account')).setTabAccount(ME);
    const own = await import('../lib/ownNotes');
    own.registerOwnNoteCheck(() => false);
    own.registerOwnNotebookCheck(() => false);
    return (await import('./sharesInbox')).sharesInboxStore;
  }
  /** The server: whatever `rows()` holds now, and every dismissal goes through. */
  function server(rows: () => unknown[]) {
    apiRequest.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/shares/inbox?')) return Promise.resolve({ success: true, data: { shares: rows(), has_more: false } });
      if (url === '/api/v1/users/public-keys') return Promise.resolve({ success: true, data: { users: [] } });
      if (/^\/api\/v1\/shares\/inbox\/[^/]+\/dismiss/.test(url)) return Promise.resolve({ success: true });
      return Promise.resolve({ success: false });
    });
  }

  it('an item\'s share is found under any spelling of the id, and never for what is no id', async () => {
    const store = await fresh();
    server(() => [share({ share_id: ROW_A, item_id: ITEM_A }), share({ share_id: ROW_B, item_id: ITEM_B })]);
    await store.load();
    expect(store.getByItemId(ITEM_A)?.shareId).toBe(ROW_A);
    expect(store.getByItemId(ITEM_A.toUpperCase())?.shareId).toBe(ROW_A);
    expect(store.getByItemId(ITEM_A.replace(/-/g, ''))?.shareId).toBe(ROW_A);
    expect(store.getByItemId(ITEM_B)?.shareId).toBe(ROW_B);
    expect(store.getByItemId(ITEM_C)).toBeUndefined();
    expect(store.getByItemId('not-an-id')).toBeUndefined();
  });

  it('the answer follows the list: asked before the shares arrive, after one is dismissed, and after another arrives', async () => {
    const store = await fresh();
    let rows = [share({ share_id: ROW_A, item_id: ITEM_A }), share({ share_id: ROW_B, item_id: ITEM_B })];
    server(() => rows);
    // Asked of the empty list first: that answer is not the one kept.
    expect(store.getByItemId(ITEM_A)).toBeUndefined();
    await store.load();
    expect(store.getByItemId(ITEM_A)?.shareId).toBe(ROW_A);

    // Dismissed on this page: gone at once, with no refresh in between.
    expect(await store.dismiss(ROW_A)).toBe(true);
    expect(store.getByItemId(ITEM_A)).toBeUndefined();
    expect(store.getByItemId(ITEM_B)?.shareId).toBe(ROW_B);

    rows = [share({ share_id: ROW_B, item_id: ITEM_B }), share({ share_id: ROW_C, item_id: ITEM_C })];
    await store.load();
    expect(store.getByItemId(ITEM_C)?.shareId).toBe(ROW_C);
    expect(store.getByItemId(ITEM_A)).toBeUndefined();
  });

  it('agrees with a walk of the list for every share in it', async () => {
    const store = await fresh();
    server(() => [
      share({ share_id: ROW_A, item_id: ITEM_A }),
      share({ share_id: ROW_B, item_id: ITEM_B }),
      share({ share_id: ROW_NB, item_id: NOTEBOOK, item_type: 2 }),
    ]);
    await store.load();
    expect(store.shares().length).toBe(3);
    for (const s of store.shares()) {
      expect(store.getByItemId(s.itemId)).toBe(store.shares().find(x => x.itemId === s.itemId));
    }
  });

  it('notes and notebooks are told apart once per list: the same lists until it changes, new ones when it does', async () => {
    const store = await fresh();
    server(() => [
      share({ share_id: ROW_A, item_id: ITEM_A }),
      share({ share_id: ROW_NB, item_id: NOTEBOOK, item_type: 2 }),
      share({ share_id: ROW_B, item_id: ITEM_B }),
    ]);
    // Asked of the empty list first.
    expect(store.sharedNotes()).toEqual([]);
    expect(store.sharedNotebooks()).toEqual([]);
    await store.load();
    const notes = store.sharedNotes();
    const notebooks = store.sharedNotebooks();
    expect(notes.map(s => s.shareId)).toEqual([ROW_A, ROW_B]);
    expect(notebooks.map(s => s.shareId)).toEqual([ROW_NB]);
    // Nothing changed: not worked out again (a card asks on every render).
    expect(store.sharedNotes()).toBe(notes);
    expect(store.sharedNotebooks()).toBe(notebooks);

    expect(await store.dismiss(ROW_A)).toBe(true);
    expect(store.sharedNotes().map(s => s.shareId)).toEqual([ROW_B]);
    expect(store.sharedNotebooks().map(s => s.shareId)).toEqual([ROW_NB]);
    // What a reader held before is as it was: the lists are replaced, never edited.
    expect(notes.map(s => s.shareId)).toEqual([ROW_A, ROW_B]);
  });
});

/**
 * An address in the PATH of a request is what a proxy's access log keeps:
 * every address a person unblocked would sit there in the clear, for as
 * long as the log is kept. So an unblock carries the address in the body.
 */
describe('an unblock', () => {
  it('is one POST whose body is the address, and whose path carries none', async () => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ success: true, data: null });
    expect(await sharesInboxStore.unblockSender('Sam+notes@Example.test')).toBe(true);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/shares/unblock', { method: 'POST', body: { email: 'Sam+notes@Example.test' } });
    for (const call of apiRequest.mock.calls) {
      expect(String(call[0])).not.toContain('@');
      expect(String(call[0])).not.toContain('%40');
    }
  });

  it('says whether the server took it', async () => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ success: false, status: 503 });
    expect(await sharesInboxStore.unblockSender('sam@example.test')).toBe(false);
  });

  it('and a block sends its address the same way', async () => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ success: true, data: null });
    await sharesInboxStore.blockSender('sam@example.test');
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/shares/block', { method: 'POST', body: { email: 'sam@example.test', unanswered_notebook_ids: [] } });
  });
});
