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

const { ME, prune, remember, order, inbox, mine, sig, tab } = vi.hoisted(() => ({
  ME: '0e0e0e0e-0000-4000-8000-00000000000e',
  /** In what order sync asked the notebooks store to remember and to prune. */
  order: [] as string[],
  prune: vi.fn(async (_live: ReadonlySet<string>) => {}),
  remember: vi.fn((_listed: ReadonlySet<string> | null) => {}),
  /** The shares inbox, as a test sets it BEFORE boot. `listed` = every notebook the server names, blocked rows too. */
  inbox: { fresh: true, notebooks: [] as { itemId: string; sharerEmail?: string }[], answered: true, listed: null as string[] | null, declined: [] as string[], sharedNotes: [] as { itemId: string; sharerEmail?: string }[],
    /** Every notebook the SERVER says is on offer, or null when it has not said. */
    offered: null as string[] | null },
  /** The reader's own record of the invitations they accepted, and what this device has seen accepted. */
  mine: { accepted: [] as string[], seen: [] as string[] },
  /** The same, as live signals of the store's own solid-js: installed by boot(). */
  sig: {} as Record<string, any>,
  tab: { cryptoReady: true },
}));

/**
 * Notes that came with a notebook invitation its reader has not accepted are
 * held out of their own lists, and their labels out of the chip row.
 *
 * Two things make that safe, and both are store wiring: the notes are judged
 * against the inbox AND the reader's own acceptances, and those acceptances
 * are pruned only against an inbox that really answered. A failed inbox
 * request empties the list, so a prune run against it would forget every
 * acceptance — and with it take every accepted notebook's notes off the
 * screen.
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
  isCryptoReady: () => tab.cryptoReady,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  unwrapContentKeyWithVault: () => null,
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: () => { throw new Error('vault-direct decrypt fails in this file'); },
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: vi.fn(async () => ({ ok: true })),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));
vi.mock('./notebooks', () => ({
  notebooksStore: {
    hasNotebookItem: () => false, learnNotebookItem: async () => false, notebookItemState: async () => 'none', getNotebookShares: () => [], notebooks: () => [], membersOf: () => [],
    loadFromSyncedItems: () => {}, gcEditorModes: () => {}, markNotebookItemsComplete: () => {}, markFullyPulled: () => {}, markPulled: () => {}, whenHoldsReady: async () => {},
    acceptedNotebooks: () => sig.accepted(),
    seenAcceptedNotebooks: () => sig.seen(),
    rememberAcceptances: (listed: ReadonlySet<string> | null) => { order.push('remember'); remember(listed); },
    pruneAcceptances: (live: ReadonlySet<string>) => { order.push('prune'); return prune(live); },
  },
}));
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: () => undefined,
    load: async () => inbox.fresh,
    sharedNotebooks: () => sig.notebooks(),
    answered: () => sig.answered(),
    gotNoAnswer: () => sig.noAnswer(),
    listedNotebookIds: () => sig.listed(),
    declinedNotebooks: () => sig.declined(),
    offeredNotebooks: () => sig.offered(),
    sharedNotes: () => sig.sharedNotes(),
    applyLocalEdit: () => {},
  },
}));
vi.mock('./auth', () => ({
  authStore: {
    user: () => ({ id: ME, email: 'me@example.test' }),
    /** Why this tab has no keys, or null when it has them: a live signal, like the store's own. */
    keysUnavailable: () => (sig.keysLocked() ? 'locked' : null),
  },
  getCachedOwner: () => ME,
}));
let cachedRows: unknown[] = [];
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => cachedRows,
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

const cached = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, body: '', noteType: 'text', color: null, isPinned: false, isArchived: false,
  labels: [], sortOrder: 0, editMode: 'rich', notebookId: null, hasAttachments: false, version: 1,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', deleted: false, ...over,
});

let notesStore: typeof import('./notes').notesStore;
async function boot() {
  vi.resetModules();
  // Signals of the SAME solid-js the store is about to import, so what the
  // store derives from them is live: a test can change the inbox after the
  // first read and see the hold follow (with plain values, nothing here
  // would ever re-run).
  const { createSignal } = await import('solid-js');
  [sig.notebooks, sig.setNotebooks] = createSignal(inbox.notebooks);
  [sig.answered, sig.setAnswered] = createSignal(inbox.answered);
  [sig.noAnswer, sig.setNoAnswer] = createSignal(false);
  [sig.listed, sig.setListed] = createSignal<ReadonlySet<string> | null>(
    inbox.listed === null ? new Set(inbox.notebooks.map(n => n.itemId)) : new Set(inbox.listed));
  [sig.declined, sig.setDeclined] = createSignal<ReadonlySet<string>>(new Set(inbox.declined));
  [sig.offered, sig.setOffered] = createSignal<ReadonlySet<string> | null>(inbox.offered === null ? null : new Set(inbox.offered));
  [sig.sharedNotes, sig.setSharedNotes] = createSignal(inbox.sharedNotes);
  [sig.accepted, sig.setAccepted] = createSignal(mine.accepted);
  [sig.seen, sig.setSeen] = createSignal(mine.seen);
  [sig.keysLocked, sig.setKeysLocked] = createSignal(!tab.cryptoReady);
  (await import('../lib/account')).setTabAccount(ME);
  ({ notesStore } = await import('./notes'));
  await notesStore.hydrateFromCache();
}
const byId = (id: string) => notesStore.notes().find(n => n.id === id)!;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  // The account's one-time full pull is not this file's subject.
  localStorage.setItem(`pingolin_note_opened_via_pulled.${ME}`, '1');
  inbox.fresh = true;
  inbox.notebooks = [{ itemId: 'nb-pending' }, { itemId: 'nb-accepted' }];
  inbox.answered = true;
  inbox.listed = null;
  inbox.declined = [];
  inbox.offered = null;
  inbox.sharedNotes = [];
  mine.accepted = ['nb-accepted'];
  mine.seen = [];
  tab.cryptoReady = true;
  order.length = 0;
  remember.mockClear();
  cachedRows = [
    cached('mine', { openedVia: 'vault', labels: ['home'] }),
    cached('from-pending', { openedVia: 'share', ownerNotebookId: 'nb-pending', labels: ['theirs-pending'] }),
    cached('from-accepted', { openedVia: 'share', ownerNotebookId: 'nb-accepted', labels: ['theirs-accepted'] }),
    cached('on-its-own', { openedVia: 'share', labels: ['theirs-single'] }),
    cached('mine-forged', { openedVia: 'vault', ownerNotebookId: 'nb-pending', labels: ['mine-too'] }),
  ];
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ success: true, data: { items: [], cursor: '2026-09-25T00:00:00Z', cursor_id: null, has_more: false } });
  prune.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('notes held for an invitation not yet accepted', () => {
  it('holds only the received notes of an unanswered invitation', async () => {
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(false);
    expect(notesStore.heldForInvitation(byId('on-its-own'))).toBe(false);
    expect(notesStore.heldForInvitation(byId('mine'))).toBe(false);
  });

  /** An invitation naming a notebook id cannot take a note of our own off the screen. */
  it('never holds a note our own vault opened', async () => {
    await boot();
    expect(notesStore.heldForInvitation(byId('mine-forged'))).toBe(false);
  });

  it('keeps their labels out of the chip row, and everybody else\'s in', async () => {
    await boot();
    expect(notesStore.allLabels()).toEqual(['home', 'mine-too', 'theirs-accepted', 'theirs-single']);
  });

  it('lets the notes and their labels through once the invitation is accepted', async () => {
    mine.accepted = ['nb-accepted', 'nb-pending'];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    expect(notesStore.allLabels()).toContain('theirs-pending');
  });

  it('on a cold start, holds until the inbox has answered', async () => {
    inbox.notebooks = [];
    inbox.answered = false;
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(false);
  });

  /**
   * As the store is after a refresh that FAILED on a cold start: it has
   * finished, the inbox is empty, and nothing says what is on offer (no list
   * was ever applied). A failure never leaves a list in place, so neither
   * does this test: with one, it would pass while an offline session held
   * these notes from start to end.
   */
  it('holds nothing when the inbox could not be asked: offline, the cached notes are shown', async () => {
    inbox.notebooks = [];
    inbox.answered = true;
    await boot();
    sig.setListed(null);
    sig.setNoAnswer(true);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(false);
    // The next refresh gets an answer that does not say what is on offer: held again.
    sig.setNoAnswer(false);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    // And one that does say ends it.
    sig.setOffered(new Set<string>());
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
  });

  it('a refresh under way after one that got no answer still holds nothing: only an answer changes it', async () => {
    inbox.notebooks = [];
    inbox.answered = false;
    await boot();
    sig.setListed(null);
    // Not asked yet: held.
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    // Asked, and no answer.
    sig.setNoAnswer(true);
    sig.setAnswered(true);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
  });
});

describe('acceptances are pruned only against an inbox that answered', () => {
  it('prunes against the list when the refresh was authoritative', async () => {
    await boot();
    await notesStore.sync();
    expect(prune).toHaveBeenCalledTimes(1);
    expect([...prune.mock.calls[0][0]]).toEqual(['nb-pending', 'nb-accepted']);
  });

  /**
   * A sender changes keys: their notebook's row is refused until the reader
   * approves the new key, so it is not among the rows this page opened,
   * while the refresh itself succeeds. Pruned against the opened rows, the
   * acceptance would be struck on every device. The server still NAMES the
   * notebook, and that is what the prune is run against.
   */
  it('prunes against every notebook the server names, a blocked one included', async () => {
    inbox.notebooks = [{ itemId: 'nb-pending' }];
    inbox.listed = ['nb-pending', 'nb-accepted'];
    await boot();
    await notesStore.sync();
    expect([...prune.mock.calls[0][0]]).toEqual(['nb-pending', 'nb-accepted']);
    expect([...prune.mock.calls[0][0]]).not.toEqual(inbox.notebooks.map(n => n.itemId));
  });

  /**
   * A failed refresh empties the inbox. Pruned against that, every acceptance
   * would be "stale": each shared notebook would go back to "new" on every
   * device.
   */
  it('prunes nothing when the refresh failed', async () => {
    inbox.fresh = false;
    inbox.notebooks = [];
    await boot();
    await notesStore.sync();
    expect(prune).not.toHaveBeenCalled();
  });
});

/**
 * What this device has seen accepted is brought up to date at every sync:
 * with the list when the inbox answered with one, and before the prune, so
 * that it is taken from the shared list as it arrived.
 */
describe('the device\'s memory of acceptances is kept at every sync', () => {
  it('is handed the list the inbox answered with', async () => {
    inbox.listed = ['nb-pending', 'nb-accepted'];
    await boot();
    await notesStore.sync();
    expect(remember).toHaveBeenCalledTimes(1);
    expect([...remember.mock.calls[0][0]!]).toEqual(['nb-pending', 'nb-accepted']);
    // Both are done at every sync with a list. In which order makes no
    // difference (the prune takes out exactly what the list no longer names,
    // which the memory forgets by the same list), so none is pinned here.
    expect([...order].sort()).toEqual(['prune', 'remember']);
  });

  /** One failed request must not make the device forget: it is told there was no list. */
  it('is told there was no list when the refresh failed', async () => {
    inbox.fresh = false;
    await boot();
    await notesStore.sync();
    expect(remember).toHaveBeenCalledTimes(1);
    expect(remember.mock.calls[0][0]).toBeNull();
    expect(order).toEqual(['remember']);
  });

  /**
   * An inbox answer that fills the page is applied and is not a list (it
   * may be the newest 500 rows of more), so the store says "not fresh" for
   * it. Nothing is pruned and the device forgets nothing.
   */
  it('is told there was no list when the answer filled the page', async () => {
    inbox.fresh = false;                 // what load() returns for a full page
    inbox.listed = null;
    await boot();
    sig.setListed(null);                 // and it names no notebooks
    await notesStore.sync();
    expect(remember.mock.calls[0][0]).toBeNull();
    expect(prune).not.toHaveBeenCalled();
  });
});

describe('the rules of the hold, in the store', () => {
  /** The shared list came back without the notebook; this device had seen it accepted. */
  it('does not hold the notes of a notebook this device has seen accepted', async () => {
    mine.accepted = [];
    mine.seen = ['nb-accepted'];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(false);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.allLabels()).toContain('theirs-accepted');
  });

  it('holds them on a device that never saw it accepted', async () => {
    mine.accepted = [];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(true);
  });

  /** The reader pressed Decline; the notebook is no longer pending, its notes are still in memory. */
  it('holds the notes of a notebook declined on this page', async () => {
    inbox.notebooks = [{ itemId: 'nb-accepted' }];
    inbox.declined = ['nb-pending'];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.allLabels()).not.toContain('theirs-pending');
  });

  /**
   * The same on the device that did NOT decline. The inbox no longer
   * lists the invitation, the copies are still in memory, and the
   * server says the notebook was declined (the store hands both kinds of
   * decline over as one set).
   */
  it('holds the notes of a declined notebook once the inbox no longer lists its invitation', async () => {
    inbox.notebooks = [{ itemId: 'nb-accepted' }];
    await boot();
    // Without the word that it was declined they stand in the grid: nothing is pending any more.
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    sig.setDeclined(new Set(['nb-pending']));
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.allLabels()).not.toContain('theirs-pending');
  });

  /** A note the inbox still shares in its own right was never part of what was declined. */
  it('does not hold a note of that notebook that still has a share of its own', async () => {
    inbox.notebooks = [{ itemId: 'nb-accepted' }];
    inbox.declined = ['nb-pending'];
    inbox.sharedNotes = [{ itemId: 'from-pending' }];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    expect(notesStore.allLabels()).toContain('theirs-pending');
    // Its share goes (the owner withdrew it): now it is a copy left behind, and held.
    sig.setSharedNotes([]);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
  });

  /**
   * A tab with no keys runs no sync, so its inbox never answers. The
   * cold-start hold must not last the whole page there.
   */
  it('does not hold on a guess in a tab that has no keys and cannot ask', async () => {
    inbox.notebooks = [];
    inbox.answered = false;
    tab.cryptoReady = false;
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    await notesStore.sync();
    expect(prune).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    expect(sig.answered()).toBe(false);
  });

  /**
   * The keys arrive while the page is open (the app hands them over late,
   * or the reader unlocks). The question is open again at that moment: the
   * notes are held until the inbox answers, as on any cold start. A
   * keys-less sync must not latch "answered", or they would stay on screen
   * until the next focus.
   */
  it('holds again the moment the keys arrive, until the inbox answers', async () => {
    inbox.notebooks = [];
    inbox.answered = false;
    tab.cryptoReady = false;
    await boot();
    await notesStore.sync();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    tab.cryptoReady = true;
    sig.setKeysLocked(false);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    sig.setNotebooks([{ itemId: 'nb-pending' }, { itemId: 'nb-accepted' }]);
    sig.setAnswered(true);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(false);
  });
});

/**
 * The hold is derived, and it has to follow what it is derived from while the
 * page is open: the inbox answering, an invitation accepted or declined.
 */
describe('the hold follows the inbox and the reader while the page is open', () => {
  it('lets the notes through when the inbox answers that nothing is pending', async () => {
    inbox.notebooks = [];
    inbox.answered = false;
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    sig.setAnswered(true);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
  });

  it('lets them and their labels through the moment the invitation is accepted', async () => {
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.allLabels()).not.toContain('theirs-pending');
    sig.setAccepted(['nb-accepted', 'nb-pending']);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    expect(notesStore.allLabels()).toContain('theirs-pending');
  });

  /** The sequence a decline produces: marked declined, then the inbox stops listing it. */
  it('keeps them held through a decline, when the notebook stops being pending', async () => {
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    sig.setDeclined(new Set(['nb-pending']));
    sig.setNotebooks([{ itemId: 'nb-accepted' }]);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.allLabels()).not.toContain('theirs-pending');
  });

  it('holds a newly offered notebook\'s notes as soon as the inbox lists it', async () => {
    inbox.notebooks = [{ itemId: 'nb-accepted' }];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    sig.setNotebooks([{ itemId: 'nb-accepted' }, { itemId: 'nb-pending' }]);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
  });
});

/**
 * An invitation is the notebook's OWN row, the oldest of the invitation:
 * once the notebook has a page's worth of notes, that row lies on a later
 * page. An inbox shown as far as it was read (a later page failed) can have
 * the notes and no invitation among its rows. So the first page says which
 * notebooks are on offer, whatever was read after it.
 */
describe('a notebook the SERVER says is on offer, whose own row is not among the rows read', () => {
  beforeEach(() => {
    // The inbox answered, and the invitation's own row is not in what was read.
    inbox.notebooks = [{ itemId: 'nb-accepted' }];
    inbox.answered = true;
  });

  it('the control: without the server\'s word its notes are shown', async () => {
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
  });

  it('holds its notes, and keeps their labels out of the chip row', async () => {
    inbox.offered = ['nb-pending', 'nb-accepted'];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    expect(notesStore.allLabels()).not.toContain('theirs-pending');
  });

  it('holds nothing of a notebook the reader accepted, on offer though it is', async () => {
    inbox.offered = ['nb-pending', 'nb-accepted'];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(false);
    // Nor one this device has seen accepted, when the shared list has lost it.
    mine.accepted = [];
    mine.seen = ['nb-accepted'];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(false);
  });

  it('never a note our own vault opened, and never one shared on its own', async () => {
    inbox.offered = ['nb-pending'];
    await boot();
    expect(notesStore.heldForInvitation(byId('mine-forged'))).toBe(false);
    expect(notesStore.heldForInvitation(byId('on-its-own'))).toBe(false);
    expect(notesStore.heldForInvitation(byId('mine'))).toBe(false);
  });

  it('a server that says NOTHING is on offer holds nothing by it; the rows read still do', async () => {
    inbox.offered = [];
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    sig.setNotebooks([{ itemId: 'nb-pending' }]);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
  });

  /**
   * The inbox answered, was NOT read to its end, and the server sent no list
   * of what is on offer (one that does not send it, or more notebooks on
   * offer than it lists). The rows name some invitations and are silent
   * about the rest: nothing is known, and the notes of a notebook not
   * accepted are held, as before the first answer.
   */
  it('an inbox that stopped early with no word on what is on offer holds as before it answered', async () => {
    await boot();
    // The control: read to its end, the rows are every invitation there is.
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    sig.setListed(null);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    // Never what the reader accepted, their own notes, or a note shared on its own.
    expect(notesStore.heldForInvitation(byId('from-accepted'))).toBe(false);
    expect(notesStore.heldForInvitation(byId('mine'))).toBe(false);
    expect(notesStore.heldForInvitation(byId('on-its-own'))).toBe(false);
    // The server's word ends it either way: on offer, or not.
    sig.setOffered(new Set<string>());
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    sig.setOffered(new Set(['nb-pending']));
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
  });

  it('follows the server\'s word while the page is open, and the reader\'s answer', async () => {
    await boot();
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
    sig.setOffered(new Set(['nb-pending']));
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(true);
    sig.setAccepted(['nb-accepted', 'nb-pending']);
    expect(notesStore.heldForInvitation(byId('from-pending'))).toBe(false);
  });
});

/**
 * A decline takes the declined notes' copies off this device at once. A
 * completed sync would too, but only on an inbox it read to its end.
 */
describe('taking received notes off this device', () => {
  it('removes the notes asked for, from the list and from the cache', async () => {
    await boot();
    const noteDb = await import('../lib/noteDb');
    notesStore.dropReceived(['from-pending', 'from-accepted']);
    expect(notesStore.notes().map(n => n.id).sort()).toEqual(['mine', 'mine-forged', 'on-its-own']);
    expect((noteDb.removeNote as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => c[0]).sort()).toEqual(['from-accepted', 'from-pending']);
  });

  /** An id handed to this never takes a note of our own off the device. */
  it('never removes a note our own vault opened, whatever id is asked for', async () => {
    await boot();
    const noteDb = await import('../lib/noteDb');
    (noteDb.removeNote as unknown as { mockClear: () => void }).mockClear();
    notesStore.dropReceived(['mine', 'mine-forged', 'no-such-note']);
    expect(notesStore.notes().map(n => n.id).sort()).toEqual(['from-accepted', 'from-pending', 'mine', 'mine-forged', 'on-its-own']);
    expect(noteDb.removeNote).not.toHaveBeenCalled();
  });

  it('asked for nothing, does nothing', async () => {
    await boot();
    const before = notesStore.notes();
    notesStore.dropReceived([]);
    expect(notesStore.notes()).toBe(before);
  });
});

/**
 * A block declines that person's unanswered notebooks.
 * The store says which those are, from the invitations it holds as pending
 * (lib/notebookInvites `unansweredFrom` has the rule's own tests).
 */
describe('the notebooks a block of somebody declines', () => {
  it('are their invitations not answered here: the rows read, and what the server says is on offer', async () => {
    inbox.notebooks = [
      { itemId: 'nb-pending', sharerEmail: 'Sam@Example.test' },
      { itemId: 'nb-accepted', sharerEmail: 'sam@example.test' },
      { itemId: 'nb-anns', sharerEmail: 'ann@example.test' },
    ];
    inbox.offered = ['nb-pending', 'nb-accepted', 'nb-anns', 'nb-past-what-was-read'];
    await boot();
    expect(notesStore.unansweredNotebooksFrom('sam@example.test').sort()).toEqual(['nb-past-what-was-read', 'nb-pending']);
    expect(notesStore.unansweredNotebooksFrom('ann@example.test').sort()).toEqual(['nb-anns', 'nb-past-what-was-read']);
  });

  it('none of a notebook that was accepted since', async () => {
    inbox.notebooks = [{ itemId: 'nb-pending', sharerEmail: 'sam@example.test' }];
    await boot();
    expect(notesStore.unansweredNotebooksFrom('sam@example.test')).toEqual(['nb-pending']);
    sig.setAccepted(['nb-pending']);
    expect(notesStore.unansweredNotebooksFrom('sam@example.test')).toEqual([]);
  });

  /**
   * The list of acceptances is one document shared by every device, and
   * older clients may empty it after one failed request. The notebook is
   * then "not accepted" by the list, and a block of its owner would DECLINE
   * it: its notes would go, for good. What this device has seen accepted is
   * not an unanswered invitation.
   */
  it('never one this device has seen accepted, whatever the list of acceptances says now', async () => {
    inbox.notebooks = [
      { itemId: 'nb-pending', sharerEmail: 'sam@example.test' },
      { itemId: 'nb-accepted', sharerEmail: 'sam@example.test' },
    ];
    inbox.offered = ['nb-pending', 'nb-accepted', 'nb-seen-and-past-what-was-read'];
    mine.seen = ['nb-accepted', 'nb-seen-and-past-what-was-read'];
    await boot();
    expect(notesStore.unansweredNotebooksFrom('sam@example.test')).toEqual(['nb-pending']);
    // An older build empties the list: both are "not accepted" by it now.
    sig.setAccepted([]);
    expect(notesStore.unansweredNotebooksFrom('sam@example.test')).toEqual(['nb-pending']);
    // What this device has NOT seen accepted is still declined with the block.
    sig.setSeen([]);
    expect(notesStore.unansweredNotebooksFrom('sam@example.test').sort()).toEqual(['nb-accepted', 'nb-pending', 'nb-seen-and-past-what-was-read']);
  });
});
