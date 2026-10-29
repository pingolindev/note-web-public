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
 * `learnNotebookItem`: whether a notebook exists as an item on the server,
 * asked of the SERVER when this session's syncs have not said.
 *
 * What the page knows of notebook items comes from sync pages, and after a
 * reload those are a delta: a notebook nobody has touched since is not in it.
 * Reading that silence as "no item" means:
 *   - a note written into that notebook goes up WITHOUT its notebook, so the
 *     server cannot keep it from a reader who has DECLINED that notebook
 *     (a declined share shows nothing);
 *   - sharing the notebook shares its notes and NOT the notebook itself: the
 *     reader gets loose notes and no invitation to answer.
 */
const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
/** Does this account's vault open a notebook's wrap? Not for a notebook someone else shared with us. */
const vault = vi.hoisted(() => ({ opens: true }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' }),
  unwrapContentKeyWithVault: () => (vault.opens ? new Uint8Array(32).fill(7) : null),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
}));

const stored = new Map<string, string>();
vi.mock('../lib/account', async (orig) => {
  const real = await orig<typeof import('../lib/account')>();
  return {
    ...real,
    scopedGetItem: (k: string) => stored.get(k) ?? null,
    scopedSetItem: (k: string, v: string) => { stored.set(k, v); },
    scopedRemoveItem: (k: string) => { stored.delete(k); },
  };
});

const ACCOUNT = '0e0e0e0e-0000-4000-8000-00000000000e';
const NB = '10000000-0000-4000-8000-00000000000a';
let notebooksStore: typeof import('./notebooks').notebooksStore;

/** The store as a page has it right after a reload: nothing about notebook items is known yet. */
async function reloaded() {
  stored.clear();
  stored.set('pingolin_note_metadata', JSON.stringify({ notebooks: [{ id: NB, name: 'Old news' }], labelColors: {} }));
  ({ notebooksStore } = await import('./notebooks'));
  const { setTabAccount } = await import('../lib/account');
  setTabAccount(null);
  setTabAccount(ACCOUNT);
  notebooksStore.beginHoldsRead().loaded([]);
}

/** The server's answer to GET /items/{id}, and every URL asked. */
function server(answer: (url: string) => unknown) {
  const asked: string[] = [];
  apiRequest.mockImplementation((url: string, opts?: { method?: string }) => {
    if ((opts?.method ?? 'GET') === 'GET' && url.startsWith('/api/v1/items/')) {
      asked.push(url);
      return Promise.resolve(answer(url));
    }
    return Promise.resolve({ success: false, status: 503 });
  });
  return asked;
}
/** A notebook item as the server returns one. The roster is the document's own `members`. */
const notebookItem = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    id: NB, item_type: 2, version: 4, deleted: false,
    encrypted_content: JSON.stringify({ title: 'Old news', members: [{ userId: 'u-reader', email: 'reader@example.com', sharingPublicKey: 'aa', permission: 'view' }] }),
    content_nonce: 'n', wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn',
    ...over,
  },
});

beforeEach(async () => {
  await new Promise(r => setTimeout(r, 30));
  vi.clearAllMocks();
  vi.resetModules();
  vault.opens = true;
});

describe('a notebook this session\'s syncs have not mentioned', () => {
  /** The precondition, and the whole problem: the page lists the notebook (its metadata does) and has not heard of its item. */
  it('is listed by the page and unknown as an item after a reload', async () => {
    await reloaded();
    expect(notebooksStore.notebooks().map(n => n.id)).toEqual([NB]);
    expect(notebooksStore.hasNotebookItem(NB)).toBe(false);
  });

  /** Under the id that was ASKED for, whatever id the answer carries. */
  it('is recorded under the id that was asked for, not one the answer names', async () => {
    await reloaded();
    const OTHER = '20000000-0000-4000-8000-00000000000b';
    server(() => notebookItem({ id: OTHER }));
    expect(await notebooksStore.notebookItemState(NB)).toBe('item');
    expect(notebooksStore.notebookWrap(NB)).toEqual({ key: 'wrap', nonce: 'wrapn' });
    expect(notebooksStore.notebookWrap(OTHER)).toBeNull();
    expect(notebooksStore.membersOf(NB).map(m => m.email)).toEqual(['reader@example.com']);
    expect(notebooksStore.membersOf(OTHER)).toEqual([]);
  });

  /**
   * A notebook someone else shared with us: the server serves its item to a
   * member, our vault does not open its wrap, and its roster is not ours to
   * adopt from here (the same as for a sync page).
   */
  it('a notebook our vault does not open is an item with no roster taken from it', async () => {
    await reloaded();
    vault.opens = false;
    server(() => notebookItem());
    expect(await notebooksStore.notebookItemState(NB)).toBe('item');
    expect(notebooksStore.membersOf(NB)).toEqual([]);
    expect(notebooksStore.notebookWrap(NB)).toEqual({ key: 'wrap', nonce: 'wrapn' });
  });

  it('is asked of the server, once, and from then on it is known', async () => {
    await reloaded();
    const asked = server(() => notebookItem());
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(true);
    expect(asked).toEqual([`/api/v1/items/${NB}`]);
    expect(notebooksStore.hasNotebookItem(NB)).toBe(true);
    expect(notebooksStore.notebookVersion(NB)).toBe(4);
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(true);
    expect(asked).toHaveLength(1);
  });

  /** As a sync page would have recorded it: its wrap and its roster with it. */
  it('is recorded as a sync page records it, wrap and roster included', async () => {
    await reloaded();
    server(() => notebookItem());
    await notebooksStore.learnNotebookItem(NB);
    expect(notebooksStore.notebookWrap(NB)).toEqual({ key: 'wrap', nonce: 'wrapn' });
    expect(notebooksStore.membersOf(NB).map(m => m.email)).toEqual(['reader@example.com']);
  });

  it('two saves into it at the same moment ask once', async () => {
    await reloaded();
    const asked = server(() => notebookItem());
    const [a, b] = await Promise.all([notebooksStore.learnNotebookItem(NB), notebooksStore.learnNotebookItem(NB)]);
    expect([a, b]).toEqual([true, true]);
    expect(asked).toHaveLength(1);
  });
});

describe('a notebook the server has no item for', () => {
  /** Never a guess: naming a notebook that has no item fails the whole save (the server
   * requires a note's notebook to be an existing item).
   */
  it('is not named to the server, and is not asked about again on this page', async () => {
    await reloaded();
    const asked = server(() => ({ success: false, status: 404, error: 'Item not found' }));
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(notebooksStore.hasNotebookItem(NB)).toBe(false);
  });

  it('a trashed item is "taken, not ours to write": not named, and remembered', async () => {
    await reloaded();
    const asked = server(() => notebookItem({ deleted: true }));
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    expect(asked).toHaveLength(1);
    expect(notebooksStore.notebookVersion(NB)).toBeNull();
  });

  it('an item under that id that is no notebook is not a notebook', async () => {
    await reloaded();
    const asked = server(() => notebookItem({ item_type: 1 }));
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it('once its item is made, it is known', async () => {
    await reloaded();
    server(() => ({ success: false, status: 404, error: 'Item not found' }));
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    apiRequest.mockImplementation((url: string, opts?: { method?: string }) =>
      Promise.resolve(url === '/api/v1/items' && opts?.method === 'POST' ? { success: true, data: { version: 1 } } : { success: false, status: 503 }));
    expect(await notebooksStore.writeNotebookItem(NB, 'Old news')).toBe(true);
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(true);
  });
});

describe('a question the server did not answer', () => {
  /** Not "no item": the note goes up without its notebook this once, and the next save asks again. */
  it('is not an answer, and is asked again the next time', async () => {
    for (const failure of [{ success: false, status: 500 }, { success: false, status: 429 }, { success: false, error: 'Network error' }]) {
      vi.resetModules();
      await reloaded();
      const asked = server(() => failure);
      expect(await notebooksStore.learnNotebookItem(NB), JSON.stringify(failure)).toBe(false);
      expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
      expect(asked).toHaveLength(2);
      // And when it does answer, it is known.
      server(() => notebookItem());
      expect(await notebooksStore.learnNotebookItem(NB)).toBe(true);
    }
  });

  it('a request that throws is not an answer either', async () => {
    await reloaded();
    apiRequest.mockImplementation(() => Promise.reject(new Error('offline')));
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    server(() => notebookItem());
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(true);
  });
});

describe('a notebook the syncs HAVE mentioned', () => {
  const page = (over: Record<string, unknown> = {}) => [{
    id: NB, item_type: 2, version: 9, deleted: false, updated_at: '2026-10-07T00:00:00Z',
    encrypted_content: JSON.stringify({ title: 'Old news' }), content_nonce: 'n',
    wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn', ...over,
  }];

  it('is not asked about at all', async () => {
    await reloaded();
    const asked = server(() => notebookItem());
    notebooksStore.loadFromSyncedItems(page() as never);
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(true);
    expect(asked).toEqual([]);
  });

  it('nor is one a sync page showed as trashed', async () => {
    await reloaded();
    const asked = server(() => notebookItem());
    notebooksStore.loadFromSyncedItems(page({ deleted: true }) as never);
    expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    expect(asked).toEqual([]);
  });

  /** A sync page that lands while the question is on its way is the newer word. */
  it('a sync page that lands while the question is on its way is believed over the answer', async () => {
    await reloaded();
    let answer: (v: unknown) => void = () => {};
    apiRequest.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const learning = notebooksStore.learnNotebookItem(NB);
    await Promise.resolve();
    notebooksStore.loadFromSyncedItems(page({ version: 9 }) as never);
    answer(notebookItem({ deleted: true }));
    expect(await learning).toBe(true);
    expect(notebooksStore.notebookVersion(NB)).toBe(9);
  });
});

describe('no notebook at all', () => {
  it('is no item, and nothing is asked', async () => {
    await reloaded();
    const asked = server(() => notebookItem());
    expect(await notebooksStore.learnNotebookItem(null)).toBe(false);
    expect(await notebooksStore.learnNotebookItem(undefined)).toBe(false);
    expect(await notebooksStore.learnNotebookItem('')).toBe(false);
    expect(asked).toEqual([]);
  });
});

/**
 * Three answers, not two. "The server could not be asked" must not read as
 * "no item": the note would go up without its notebook and be shared, live,
 * with a reader who had declined it, and the Share panel would share a
 * notebook's notes without the notebook and say "success".
 */
describe('what the server has for a notebook: item, none, or unknown', () => {
  it('an item', async () => {
    await reloaded();
    server(() => notebookItem());
    expect(await notebooksStore.notebookItemState(NB)).toBe('item');
  });

  it('none: no such item, a trashed one, or something that is no notebook', async () => {
    for (const answer of [
      { success: false, status: 404, error: 'Item not found' },
      notebookItem({ deleted: true }),
      notebookItem({ item_type: 1 }),
    ]) {
      vi.resetModules();
      await reloaded();
      const asked = server(() => answer);
      expect(await notebooksStore.notebookItemState(NB), JSON.stringify(answer).slice(0, 60)).toBe('none');
      expect(await notebooksStore.notebookItemState(NB)).toBe('none');
      expect(asked).toHaveLength(1);
    }
  });

  it('unknown: the request failed, and nothing is remembered of it', async () => {
    for (const failure of [{ success: false, status: 503 }, { success: false, status: 429 }, { success: false, error: 'Network error' }, { success: false, status: 403 }]) {
      vi.resetModules();
      await reloaded();
      const asked = server(() => failure);
      expect(await notebooksStore.notebookItemState(NB), JSON.stringify(failure)).toBe('unknown');
      expect(await notebooksStore.notebookItemState(NB)).toBe('unknown');
      expect(asked).toHaveLength(2);
      expect(await notebooksStore.learnNotebookItem(NB)).toBe(false);
    }
    await reloaded();
    apiRequest.mockImplementation(() => Promise.reject(new Error('offline')));
    expect(await notebooksStore.notebookItemState(NB)).toBe('unknown');
  });

  it('no notebook at all is none, and nothing is asked', async () => {
    await reloaded();
    const asked = server(() => notebookItem());
    for (const id of [null, undefined, '']) expect(await notebooksStore.notebookItemState(id)).toBe('none');
    expect(asked).toEqual([]);
  });

  it('what the syncs said is the answer, with nothing asked', async () => {
    await reloaded();
    const asked = server(() => notebookItem());
    const row = { id: NB, item_type: 2, version: 9, deleted: false, updated_at: '2026-10-07T00:00:00Z', encrypted_content: JSON.stringify({ title: 'Old news' }), content_nonce: 'n', wrapped_content_key: 'wrap', wrapped_content_key_nonce: 'wrapn' };
    notebooksStore.loadFromSyncedItems([row] as never);
    expect(await notebooksStore.notebookItemState(NB)).toBe('item');
    notebooksStore.loadFromSyncedItems([{ ...row, deleted: true }] as never);
    expect(await notebooksStore.notebookItemState(NB)).toBe('none');
    expect(asked).toEqual([]);
  });
});

/**
 * The same rule in three more places: after a reload the page has "not
 * heard of" an untouched notebook's item, and must not read that as
 * "there is none".
 */
describe('after a reload, a notebook the syncs have not mentioned', () => {
  /** Every call the page made, as [method, url]. */
  function everything(get: unknown = notebookItem()) {
    const calls: [string, string, unknown][] = [];
    apiRequest.mockImplementation((url: string, opts?: { method?: string; body?: unknown }) => {
      const method = opts?.method ?? 'GET';
      calls.push([method, url, opts?.body]);
      if (method === 'GET' && url === `/api/v1/items/${NB}`) return Promise.resolve(get);
      if (method === 'PUT' && url === `/api/v1/items/${NB}`) return Promise.resolve({ success: true, data: { version: 5 } });
      if (method === 'DELETE') return Promise.resolve({ success: true });
      return Promise.resolve({ success: false, status: 503 });
    });
    return calls;
  }
  const settle = () => new Promise(r => setTimeout(r, 20));

  /**
   * Deleting it has to delete its ITEM on the server too: left behind, the
   * item keeps every reader's invitation to it, or their accepted (now empty)
   * notebook. A delete sent only for an item this session's syncs had
   * mentioned would miss it.
   */
  it('is deleted on the server too when its notebook is deleted', async () => {
    await reloaded();
    const calls = everything();
    notebooksStore.remove(NB);
    await settle();
    expect(calls.filter(c => c[0] === 'DELETE').map(c => c[1])).toEqual([`/api/v1/items/${NB}`]);
    expect(notebooksStore.notebooks()).toEqual([]);
  });

  it('a lookup that answers after the notebook was deleted records nothing of it', async () => {
    await reloaded();
    let answer: (v: unknown) => void = () => {};
    apiRequest.mockImplementation((url: string, opts?: { method?: string }) =>
      ((opts?.method ?? 'GET') === 'GET' && url === `/api/v1/items/${NB}`
        ? new Promise((resolve) => { answer = resolve; })
        : Promise.resolve({ success: true })));
    const asking = notebooksStore.notebookItemState(NB);
    await Promise.resolve();
    notebooksStore.remove(NB);
    answer(notebookItem());
    expect(await asking).toBe('unknown');
    expect(notebooksStore.hasNotebookItem(NB)).toBe(false);
    expect(notebooksStore.notebookWrap(NB)).toBeNull();
  });

  /** Its title is the name every READER of a shared notebook sees. */
  it('is renamed on the server too: the item is asked for first, then written', async () => {
    await reloaded();
    const calls = everything();
    notebooksStore.rename(NB, 'Latest news');
    await settle();
    const toTheItem = calls.filter(c => c[1] === `/api/v1/items/${NB}`).map(c => c[0]);
    expect(toTheItem).toEqual(['GET', 'PUT']);
    const put = calls.find(c => c[0] === 'PUT' && c[1] === `/api/v1/items/${NB}`)![2] as { encrypted_content: string; expected_version: number };
    expect(JSON.parse(put.encrypted_content).title).toBe('Latest news');
    expect(put.expected_version).toBe(4);
    // The roster the item carried is written back with the new name, not lost.
    expect(JSON.parse(put.encrypted_content).members.map((m: { email: string }) => m.email)).toEqual(['reader@example.com']);
  });

  /**
   * One lookup with no answer must not end the rename of the item there and
   * then, or every reader keeps the name it had. A blip is not "no item".
   */
  it('the item is asked for once more when there was no answer, and then renamed', async () => {
    await reloaded();
    const calls: [string, string][] = [];
    let asked = 0;
    apiRequest.mockImplementation((url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? 'GET';
      calls.push([method, url]);
      if (method === 'GET' && url === `/api/v1/items/${NB}`) {
        return Promise.resolve(++asked === 1 ? { success: false, status: 503 } : notebookItem());
      }
      if (method === 'PUT' && url === `/api/v1/items/${NB}`) return Promise.resolve({ success: true, data: { version: 5 } });
      return Promise.resolve({ success: false, status: 503 });
    });
    notebooksStore.rename(NB, 'Latest news');
    await settle();
    expect(calls.filter(c => c[1] === `/api/v1/items/${NB}`).map(c => c[0])).toEqual(['GET', 'GET', 'PUT']);
  });

  it('with no answer twice it is not written, and not asked for a third time', async () => {
    await reloaded();
    const calls = everything({ success: false, status: 503 });
    notebooksStore.rename(NB, 'Latest news');
    await settle();
    expect(calls.filter(c => c[1] === `/api/v1/items/${NB}`).map(c => c[0])).toEqual(['GET', 'GET']);
    // This page's own list has the new name either way.
    expect(notebooksStore.notebooks()[0].name).toBe('Latest news');
  });

  it('a notebook with no item is renamed in the page\'s own list only, as before', async () => {
    await reloaded();
    const calls = everything({ success: false, status: 404, error: 'Item not found' });
    notebooksStore.rename(NB, 'Latest news');
    await settle();
    expect(calls.filter(c => c[0] === 'PUT' && c[1] === `/api/v1/items/${NB}`)).toEqual([]);
    expect(notebooksStore.notebooks()[0].name).toBe('Latest news');
  });

  it('its roster can be written: the item is asked for first', async () => {
    await reloaded();
    const calls = everything();
    const members = [{ userId: 'u-new', email: 'new@example.com', sharingPublicKey: 'bb', permission: 'view' as const }];
    expect(await notebooksStore.setNotebookMembers(NB, members as never)).toBe(true);
    expect(calls.filter(c => c[1] === `/api/v1/items/${NB}`).map(c => c[0])).toEqual(['GET', 'PUT']);
    expect(notebooksStore.membersOf(NB).map(m => m.email)).toEqual(['new@example.com']);
  });

  it('a roster write for a notebook the server could not be asked about fails, and writes nothing', async () => {
    await reloaded();
    const calls = everything({ success: false, status: 503 });
    expect(await notebooksStore.setNotebookMembers(NB, [] as never)).toBe(false);
    expect(calls.filter(c => c[0] === 'PUT')).toEqual([]);
  });
});

/** What one account's page learned of notebook items is not the next account's. */
describe('an account change', () => {
  it('forgets "no item", and a lookup still on its way records nothing for the next account', async () => {
    await reloaded();
    const asked = server(() => ({ success: false, status: 404, error: 'Item not found' }));
    expect(await notebooksStore.notebookItemState(NB)).toBe('none');
    notebooksStore.reset();
    server(() => notebookItem());
    expect(await notebooksStore.notebookItemState(NB)).toBe('item');
    expect(asked).toHaveLength(1);

    vi.resetModules();
    await reloaded();
    let answer: (v: unknown) => void = () => {};
    apiRequest.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const asking = notebooksStore.notebookItemState(NB);
    await Promise.resolve();
    notebooksStore.reset();
    answer(notebookItem());
    expect(await asking).toBe('unknown');
    expect(notebooksStore.hasNotebookItem(NB)).toBe(false);
    expect(notebooksStore.notebookWrap(NB)).toBeNull();
  });
});
