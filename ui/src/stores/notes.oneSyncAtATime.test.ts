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

const { ME, inbox, waits } = vi.hoisted(() => ({
  ME: '0e0e0e0e-0000-4000-8000-00000000000e',
  /** The two smaller waits of a sync, held by a test that sets them. */
  waits: { identities: null as Promise<number> | null, holds: null as Promise<void> | null },
  /** The inbox refresh every sync starts with: counted, and ended by the test. */
  inbox: { loads: 0, together: 0, mostTogether: 0, open: [] as (() => void)[], onPage: [] as (() => void)[] },
}));

/**
 * One sync at a time.
 *
 * A sync is started by the page loading, by focus, by coming back online, by a
 * push, by opening "Shared with me" and by closing a note, and two can be asked
 * for together. Each begins by reading the whole shares inbox and opening every
 * share in it, so two at once do that work twice and throw one answer away.
 *
 * The rule itself has its own tests (lib/oneAtATime.test). These are about the
 * store: that `sync` goes through it, and what a caller can rely on.
 */

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

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: () => { throw new Error('vault-direct decrypt fails in this file'); },
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => (waits.identities ?? 0) }));
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: vi.fn(async () => ({ ok: true })),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => false, learnNotebookItem: async () => false, notebookItemState: async () => 'none', getNotebookShares: () => [], notebooks: () => [], membersOf: () => [],
    loadFromSyncedItems: () => {}, gcEditorModes: () => {}, markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => { await waits.holds; },
    pruneAcceptances: async () => {}, rememberAcceptances: () => {},
  },
}));
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: () => undefined,
    load: (onPage: () => void = () => {}) => {
      inbox.onPage.push(onPage);
      inbox.loads++;
      inbox.together++;
      inbox.mostTogether = Math.max(inbox.mostTogether, inbox.together);
      return new Promise<boolean>((resolve) => {
        inbox.open.push(() => { inbox.together--; resolve(true); });
      });
    },
    sharedNotebooks: () => [], listedNotebookIds: () => new Set<string>(), cannotAsk: () => {}, applyLocalEdit: () => {},
  },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => [],
  loadCursor: async () => '2026-09-20T00:00:00Z',
  loadCursorId: async () => null,
  putNote: vi.fn(async () => {}),
  putNotes: vi.fn(async () => {}),
  removeNote: vi.fn(async () => {}),
  queuePending: vi.fn(async () => {}),
  removePending: vi.fn(async () => {}),
  listPending: async () => [],
  getPending: async () => null,
  saveCursor: async () => {},
  saveCursorId: async () => {},
}));

const NOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** What the server has to give: a test changes it between two syncs. */
let serverRows: unknown[] = [];
/** When set, a pull's answer waits for the test, and carries what the server had when it was ASKED. */
let holdPulls = false;
const pullsOpen: (() => void)[] = [];
const row = (id: string, title: string) => ({
  id, user_id: ME, item_type: 1,
  encrypted_content: JSON.stringify({ title }), content_nonce: 'n', version: 2,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
  deleted: false, circle_id: null, content_size: 1,
  wrapped_content_key: 'own-wrap', wrapped_content_key_nonce: 'w-n',
});
const pulls = () => apiRequest.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/v1/sync/pull'));
/** Let everything already settled reach whoever waits for it. */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
/** End the inbox refresh of the sync that is running, and let that sync finish. */
const finishRunningSync = async () => {
  expect(inbox.open).toHaveLength(1);
  inbox.open.shift()!();
  await settle();
};
function watch(p: Promise<void>) {
  const state = { done: false };
  void p.then(() => { state.done = true; });
  return state;
}

let notesStore: typeof import('./notes').notesStore;

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  inbox.loads = 0; inbox.together = 0; inbox.mostTogether = 0; inbox.open.length = 0; inbox.onPage.length = 0;
  serverRows = [];
  waits.identities = null;
  waits.holds = null;
  holdPulls = false;
  pullsOpen.length = 0;
  apiRequest.mockReset();
  apiRequest.mockImplementation((url: string) => {
    if (!String(url).startsWith('/api/v1/sync/pull')) return Promise.resolve({ success: true, data: {} });
    // The server's answer is what it had at the moment it was asked.
    const answer = { success: true, data: { items: serverRows, cursor: '2026-09-25T00:00:00Z', cursor_id: NOTE, has_more: false } };
    if (!holdPulls) return Promise.resolve(answer);
    return new Promise((resolve) => { pullsOpen.push(() => resolve(answer)); });
  });
  vi.resetModules();
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('one sync at a time', () => {
  it('a sync asked for with none running starts at once', async () => {
    void notesStore.sync();
    expect(inbox.loads).toBe(1);
    expect(notesStore.syncing()).toBe(true);
    await finishRunningSync();
    expect(notesStore.syncing()).toBe(false);
    expect(pulls()).toHaveLength(1);
  });

  it('asked for five times while one runs, ONE more sync follows: the inbox is read twice, not six times', async () => {
    void notesStore.sync();
    const asked = [notesStore.sync(), notesStore.sync(), notesStore.sync(), notesStore.sync(), notesStore.sync()].map(watch);
    await settle();
    expect(inbox.loads).toBe(1);
    expect(pulls()).toHaveLength(0);

    await finishRunningSync();
    // The first has pulled and ended; the follow-up has started and is reading the inbox.
    expect(pulls()).toHaveLength(1);
    expect(inbox.loads).toBe(2);
    expect(asked.every(a => !a.done)).toBe(true);

    await finishRunningSync();
    expect(asked.every(a => a.done)).toBe(true);
    expect(pulls()).toHaveLength(2);
    expect(inbox.loads).toBe(2);
    expect(inbox.mostTogether).toBe(1);
    expect(inbox.open).toHaveLength(0);
  });

  /**
   * What a caller relies on (an import, a decline, a restore): the sync it
   * awaits started after it asked, so what it wrote before asking is in it. A
   * sync already running may have read the server before that.
   */
  it('the sync a caller awaits read the server AFTER the caller asked', async () => {
    holdPulls = true;
    void notesStore.sync();
    await settle();
    inbox.open.shift()!();
    await settle();
    // The first sync has asked the server for its rows; the answer is on its way.
    expect(pullsOpen).toHaveLength(1);

    // Meanwhile something is written, and a sync is asked for (as the importer does).
    serverRows = [row(NOTE, 'Imported')];
    const awaited = notesStore.sync();
    const state = watch(awaited);

    // The first sync's answer arrives: from before the write, so without it.
    pullsOpen.shift()!();
    await settle();
    expect(notesStore.notes()).toEqual([]);
    // Joining that sync would have told the caller "synced" here, with nothing to show.
    expect(state.done).toBe(false);

    // The follow-up: the inbox again, and a pull that reads the server now.
    expect(inbox.loads).toBe(2);
    inbox.open.shift()!();
    await settle();
    expect(pullsOpen).toHaveLength(1);
    pullsOpen.shift()!();
    await awaited;
    expect(notesStore.notes().map(n => n.title)).toEqual(['Imported']);
    expect(inbox.mostTogether).toBe(1);
  });

  it('after everything has ended, the next sync starts at once again', async () => {
    void notesStore.sync();
    void notesStore.sync();
    await finishRunningSync();
    await finishRunningSync();
    expect(inbox.loads).toBe(2);
    void notesStore.sync();
    expect(inbox.loads).toBe(3);
    await finishRunningSync();
    expect(inbox.mostTogether).toBe(1);
  });
});

/**
 * A sync that takes too long is given up on and another starts beside it
 * (lib/oneAtATime). When the first one's stalled answer arrives at last, it
 * holds rows read long ago: merged then, they would go back over what the
 * newer sync had written, and its cursor would go back with them.
 */
describe('a sync that was given up on applies nothing more', () => {
  it('its page is not merged over what the newer sync wrote', async () => {
    serverRows = [row(NOTE, 'New v2')];
    void notesStore.sync();
    await finishRunningSync();
    expect(notesStore.notes().map(n => n.title)).toEqual(['New v2']);

    // The same account's older answer, arriving in a run that is no longer in charge.
    serverRows = [row(NOTE, 'Old v1')];
    const overdue = notesStore.syncOnce({ inCharge: () => false, alive: () => {} });
    await settle();
    inbox.open.shift()!();
    await overdue;
    expect(notesStore.notes().map(n => n.title)).toEqual(['New v2']);
  });

  it('nor does it move the cursor', async () => {
    const noteDb = await import('../lib/noteDb');
    const saved = vi.spyOn(noteDb, 'saveCursor');
    // In charge until its (one) page has been merged, then given up on.
    let pagesAsked = 0;
    const inCharge = () => pagesAsked++ === 0;
    serverRows = [row(NOTE, 'A page')];
    const run = notesStore.syncOnce({ inCharge, alive: () => {} });
    await settle();
    inbox.open.shift()!();
    await run;
    expect(notesStore.notes().map(n => n.title)).toEqual(['A page']);
    expect(saved).not.toHaveBeenCalled();
    saved.mockRestore();
  });

  it('the control: a sync in charge merges its page and moves the cursor', async () => {
    const noteDb = await import('../lib/noteDb');
    const saved = vi.spyOn(noteDb, 'saveCursor');
    serverRows = [row(NOTE, 'A page')];
    const run = notesStore.syncOnce({ inCharge: () => true, alive: () => {} });
    await settle();
    inbox.open.shift()!();
    await run;
    expect(notesStore.notes().map(n => n.title)).toEqual(['A page']);
    expect(saved).toHaveBeenCalledWith('2026-09-25T00:00:00Z');
    saved.mockRestore();
  });

  it('the store hands each sync the question', () => {
    const { readFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const source = readFileSync(join(__dirname, 'notes.ts'), 'utf8');
    expect(source).toContain('const syncOneAtATime = oneAtATime((run) => notesStore.syncOnce(run));');
  });

  /**
   * The spinner belongs to the sync in charge. A run that was given up on ends
   * while the newer one is still working: taking the spinner down then would
   * say "done" in the middle of a sync.
   */
  it('it does not take the spinner down: that is the newer sync\'s to do', async () => {
    void notesStore.sync();
    expect(notesStore.syncing()).toBe(true);
    const overdue = notesStore.syncOnce({ inCharge: () => false, alive: () => {} });
    await settle();
    // The overdue run's inbox refresh is the second one opened: end it, and it.
    expect(inbox.open).toHaveLength(2);
    inbox.open.pop()!();
    await overdue;
    expect(notesStore.syncing()).toBe(true);
    await finishRunningSync();
    expect(notesStore.syncing()).toBe(false);
  });
});

/**
 * A sync is given up on when it has shown no sign of life for a minute
 * (lib/oneAtATime), not when it has run for one: a first sync of a large
 * account takes longer than that, honestly. So it has to SAY that it is alive,
 * every time something comes back from the server.
 */
describe('a sync says that it is alive', () => {
  const counting = () => {
    const seen = { alive: 0 };
    return { seen, run: { inCharge: () => true, alive: () => { seen.alive++; } } };
  };

  it('after every page of the pull, however many there are', async () => {
    let asked = 0;
    apiRequest.mockImplementation((url: string) => {
      if (!String(url).startsWith('/api/v1/sync/pull')) return Promise.resolve({ success: true, data: {} });
      asked++;
      return Promise.resolve({ success: true, data: { items: [row(NOTE, `Page ${asked}`)], cursor: `2026-09-25T00:00:0${asked}Z`, cursor_id: NOTE, has_more: asked < 3 } });
    });
    const { seen, run } = counting();
    const sync = notesStore.syncOnce(run);
    await settle();
    inbox.open.shift()!();
    await sync;
    expect(pulls()).toHaveLength(3);
    // The two waits before the pull (below), and each of its three pages.
    expect(seen.alive).toBe(2 + 3);
  });

  /**
   * Two smaller waits come before the pull: for the account's earlier
   * identities, and for the notebooks' holds. Each is a request of its
   * own, and the end of each is a sign of life.
   */
  it('after the wait for the earlier identities, and after the wait for the holds', async () => {
    let identitiesIn: (n: number) => void = () => {};
    let holdsIn: () => void = () => {};
    waits.identities = new Promise<number>((resolve) => { identitiesIn = resolve; });
    waits.holds = new Promise<void>((resolve) => { holdsIn = resolve; });
    const { seen, run } = counting();
    const sync = notesStore.syncOnce(run);
    await settle();
    inbox.open.shift()!();
    await settle();
    expect(seen.alive).toBe(0);
    expect(pulls()).toHaveLength(0);
    identitiesIn(0);
    await settle();
    expect(seen.alive).toBe(1);
    expect(pulls()).toHaveLength(0);
    holdsIn();
    await sync;
    // The holds, and the pull's one page.
    expect(seen.alive).toBe(3);
  });

  /** A page of a hundred notes on a slow link arrives for a while. */
  it('at each piece of a pull page that arrives', async () => {
    const { seen, run } = counting();
    const sync = notesStore.syncOnce(run);
    await settle();
    inbox.open.shift()!();
    await sync;
    const pull = apiRequest.mock.calls.find(c => String(c[0]).startsWith('/api/v1/sync/pull'));
    const before = seen.alive;
    (pull![1] as { onProgress: () => void }).onProgress();
    expect(seen.alive).toBe(before + 1);
  });

  it('after a page that FAILED too: an answer is an answer', async () => {
    apiRequest.mockImplementation((url: string) => {
      if (!String(url).startsWith('/api/v1/sync/pull')) return Promise.resolve({ success: true, data: {} });
      return Promise.resolve({ success: false, error: 'Request timed out' });
    });
    const { seen, run } = counting();
    const sync = notesStore.syncOnce(run);
    await settle();
    inbox.open.shift()!();
    await sync;
    // The two waits before the pull, and its one page.
    expect(seen.alive).toBe(2 + 1);
  });

  it('and hands the inbox the same sign of life, for each of ITS pages', async () => {
    const { seen, run } = counting();
    const sync = notesStore.syncOnce(run);
    await settle();
    expect(inbox.onPage).toHaveLength(1);
    const before = seen.alive;
    inbox.onPage[0]();
    inbox.onPage[0]();
    expect(seen.alive).toBe(before + 2);
    inbox.open.shift()!();
    await sync;
  });
});

