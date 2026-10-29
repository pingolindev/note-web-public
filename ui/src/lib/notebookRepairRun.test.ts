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
 * The repair after a password reset, put to work (lib/notebookRepairRun). The
 * stores and the rebuild are stand-ins: these pin the ORDER and the GATES —
 * nothing is rebuilt before it is known no recovered key opens it, the earlier
 * record is carried before it is replaced, a run rebuilds a few at most, and
 * an account with nothing from before a reset is left alone.
 */

type State = 'opens' | 'keyless' | 'locked' | 'unknown';
let states: Record<string, State>;
let opensOnServer: Record<string, boolean>;
let account: string | null;
let answered: boolean;
let fullyPulled: boolean;
let carryLands: boolean;
let locked: boolean;
const ran: string[] = [];

const store = {
  notebooks: () => Object.keys(states).map(id => ({ id, name: `name-${id}`, noteCount: 0 })),
  listAfterReset: () => ({ locked, openedWithRecoveredKey: false }),
  rewriteListUnderThisIdentity: vi.fn(async () => { ran.push('rewrite list'); return false; }),
  keepNotebooksWhileListLocked: vi.fn(async () => { ran.push('keep notebooks'); return 0; }),
  mergeBackEarlierLists: vi.fn(async () => { ran.push('merge back'); return 0; }),
  recordStateOf: (id: string) => states[id],
  ownNotebookItemNow: vi.fn(async (id: string) => ({
    version: 3, encrypted_content: `ct-${id}`, content_nonce: 'n',
    wrapped_content_key: states[id] === 'keyless' ? null : `wk-${id}`, wrapped_content_key_nonce: states[id] === 'keyless' ? null : 'wn',
  })),
  giveNotebookAKey: vi.fn(async (id: string) => { ran.push(`give key ${id}`); states[id] = 'opens'; return true; }),
  carryRecord: vi.fn(async (id: string) => { ran.push(`carry ${id}`); return carryLands; }),
  refreshNotebookItem: vi.fn(async (id: string) => { ran.push(`refresh ${id}`); states[id] = 'opens'; return 'live'; }),
  notebookContentKey: (id: string) => (states[id] === 'opens' ? new Uint8Array(32) : null),
  restoreFromEarlierRecords: vi.fn(async () => { ran.push('restore records'); return 0; }),
  hasPulled: () => fullyPulled,
  nextPullEvent: vi.fn(async () => {}),
  confirmHeldPeople: vi.fn(async () => { ran.push('confirm held people'); heldIn = { ...confirmLeaves }; return 0; }),
  heldAsideCount: () => 0,
  heldAsideIn: (id: string) => heldIn[id] ?? 0,
  keepOldNoteKey: vi.fn(async () => true),
  keptNoteKeys: () => kept,
  dropKeptNoteKeys: vi.fn(async (id: string) => { ran.push(`drop kept ${id}`); }),
};
/** Set aside for each notebook, not yet confirmed; and what a confirmation leaves set aside. */
let heldIn: Record<string, number> = {};
let confirmLeaves: Record<string, number> = {};
/** Old key wraps kept for rescued notes, note id -> keys. */
let kept: Record<string, { wrappedKey: string; wrappedKeyNonce: string; attachmentIds?: string[] }[]> = {};
/** What each go of the rescue answers, in turn (the last repeats). */
let goes: { rescued: number; stale: number; held: number; waiting: number; left: number; movesQueued: number }[] = [];
let cachedCopiesLocked = false;
let cards: { id: string; wrappedContentKey: string | null; wrappedContentKeyNonce: string | null }[] = [];
vi.mock('../stores/notebooks', () => ({ notebooksStore: store }));
let offered: ReadonlySet<string> | null = new Set();
vi.mock('../stores/sharesInbox', () => ({
  sharesInboxStore: { offeredNotebooks: () => offered, declinedNotebooks: () => new Set(['declined-nb']) },
}));
const requestFullPull = vi.fn(() => { ran.push('ask full pull'); });
let lockedNotes = 0;
const rescueFromCopies = vi.fn(async (deps: { limit: number }) => {
  ran.push(`rescue copies (${deps.limit})`);
  return goes.length > 1 ? goes.shift()! : (goes[0] ?? { rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 });
});
const flushPending = vi.fn(async () => { ran.push('flush'); });
vi.mock('../stores/notes', () => ({
  notesStore: {
    notebookNoteIds: (id: string) => (fullyPulled ? [`note-of-${id}`] : null),
    requestFullPull: () => requestFullPull(),
    lockedOwnIds: () => new Set(Array.from({ length: lockedNotes }, (_, i) => `locked-${i}`)),
    cachedCopiesNoKeyOpens: () => cachedCopiesLocked,
    rescueFromCopies: (deps: { limit: number }) => rescueFromCopies(deps),
    flushPending: () => flushPending(),
    notes: () => cards,
  },
}));
const listAttachmentsForRekey = vi.fn(async () => [{ id: 'att-1' }]);
const rekeyNoteAttachments = vi.fn(async () => ({ attempted: 1, rekeyed: 1, skipped: 0, failed: 0 }));
vi.mock('./attachmentUpload', () => ({
  listAttachmentsForRekey: (...a: unknown[]) => listAttachmentsForRekey(...(a as [])),
  rekeyNoteAttachments: (...a: unknown[]) => rekeyNoteAttachments(...(a as [])),
}));
const retainContentKey = vi.fn();
vi.mock('./retainedKeys', () => ({ retain: (...a: unknown[]) => retainContentKey(...a) }));
vi.mock('../stores/auth', () => ({ authStore: { user: () => (account ? { id: account } : null) } }));
/** The per-account storage: one account here. */
const stored = new Map<string, string>();
vi.mock('./account', () => ({
  tryCanonicalAccountId: (id: string | null) => id,
  scopedGetItem: (k: string) => stored.get(k) ?? null,
  scopedSetItem: (k: string, v: string) => { stored.set(k, v); },
  scopedRemoveItem: (k: string) => { stored.delete(k); },
}));
let recoveredKeys = 0;
vi.mock('./crypto', () => ({
  isCryptoReady: () => true,
  getPreviousVaultKeys: () => Array.from({ length: recoveredKeys }, () => new Uint8Array(32)),
  vaultKeyThatOpens: (key: string) => (opensOnServer[key.replace(/^wk-/, '')] ? 'current' : null),
  // A wrap starting "new" or "old-open" opens; anything else does not.
  unwrapContentKeyWithVault: (key: string) => (key.startsWith('new') || key.startsWith('old-open') ? new Uint8Array(32).fill(key.length) : null),
}));
vi.mock('./previousIdentities', () => ({ previousIdentitiesAnswered: () => answered }));
const rebuildNotebookRecord = vi.fn(async (id: string) => { ran.push(`rebuild ${id}`); states[id] = 'opens'; return { rotated: true } as never; });
/** How many hold each notebook besides its owner, as the server says (absent: nobody). */
let heldBy: Record<string, number | null> = {};
const holdersOf = vi.fn(async (id: string) => (id in heldBy ? heldBy[id] : 0));
vi.mock('./shareUtils', () => ({
  rebuildNotebookRecord: (...a: unknown[]) => rebuildNotebookRecord(...(a as [string])),
  rescueNoteFromCopy: vi.fn(),
  holdersOf: (id: string) => holdersOf(id),
}));

const { repairNotebooksAfterReset, repairNotebookNow, restoreRescuedAttachments, REBUILDS_PER_RUN, RESCUES_PER_GO, BETWEEN_GOES_MS, ROTATIONS_A_MINUTE } =
  await import('./notebookRepairRun');

beforeEach(() => {
  vi.clearAllMocks();
  // A test may make the pull change the account: no later test inherits it.
  store.nextPullEvent.mockImplementation(async () => { ran.push('wait for pull'); fullyPulled = true; });
  ran.length = 0;
  states = {};
  opensOnServer = {};
  account = 'me';
  answered = true;
  fullyPulled = true;
  carryLands = true;
  locked = false;
  lockedNotes = 0;
  kept = {};
  heldBy = {};
  stored.clear();
  recoveredKeys = 0;
  goes = [];
  cachedCopiesLocked = false;
  cards = [];
});

describe('after a load\'s sync', () => {
  it('an account with nothing from before a reset: no pull is asked for, nothing is rebuilt or carried', async () => {
    states = { a: 'opens', b: 'opens' };
    fullyPulled = false;
    const s = await repairNotebooksAfterReset();
    expect(requestFullPull).not.toHaveBeenCalled();
    expect(ran).toEqual(['rewrite list', 'confirm held people', 'keep notebooks', 'merge back', 'restore records', `rescue copies (${RESCUES_PER_GO})`]);
    expect(s).toMatchObject({ rebuilt: 0, keysGiven: 0, waiting: 0, notesRescued: 0 });
  });

  it('a locked record: the old one is carried FIRST, then it is rebuilt with its notes known', async () => {
    states = { a: 'locked' };
    const s = await repairNotebooksAfterReset();
    // One rebuild this minute: one rescue fewer in the first go.
    expect(ran).toEqual(['rewrite list', 'confirm held people', 'keep notebooks', 'merge back', 'carry a', 'rebuild a', 'restore records', `rescue copies (${RESCUES_PER_GO - 1})`]);
    expect(rebuildNotebookRecord).toHaveBeenCalledWith('a', 'name-a', 3, ['note-of-a'], { attended: false });
    expect(s.rebuilt).toBe(1);
  });

  it('a record whose old version did not land in the list is not rebuilt', async () => {
    states = { a: 'locked' };
    carryLands = false;
    const s = await repairNotebooksAfterReset();
    expect(rebuildNotebookRecord).not.toHaveBeenCalled();
    expect(s.rebuilt).toBe(0);
  });

  it('nothing is rebuilt or given a key until it is known what was recovered from before a reset', async () => {
    states = { a: 'locked', b: 'keyless' };
    answered = false;
    const s = await repairNotebooksAfterReset();
    expect(store.carryRecord).not.toHaveBeenCalled();
    expect(rebuildNotebookRecord).not.toHaveBeenCalled();
    expect(store.giveNotebookAKey).not.toHaveBeenCalled();
    expect(s.waiting).toBe(2);
  });

  it('nor is a locked LIST written over in the background: it may open whole with a key not loaded yet', async () => {
    locked = true;
    answered = false;
    await repairNotebooksAfterReset();
    expect(store.keepNotebooksWhileListLocked).not.toHaveBeenCalled();
    answered = true;
    await repairNotebooksAfterReset();
    expect(store.keepNotebooksWhileListLocked).toHaveBeenCalledTimes(1);
  });

  it('nor are people set aside at a locked list put back before then: their own write goes over the list too', async () => {
    locked = true;
    answered = false;
    const s = await repairNotebooksAfterReset();
    expect(store.confirmHeldPeople).not.toHaveBeenCalled();
    expect(s.peopleConfirmed).toBe(0);
    answered = true;
    await repairNotebooksAfterReset();
    expect(store.confirmHeldPeople).toHaveBeenCalledTimes(1);
    expect(ran.indexOf('confirm held people')).toBeLessThan(ran.indexOf('keep notebooks'));
  });

  it('a keyless notebook is given a key', async () => {
    states = { k: 'keyless' };
    const s = await repairNotebooksAfterReset();
    expect(ran).toContain('give key k');
    expect(s.keysGiven).toBe(1);
  });

  it('people and acceptances set aside at a locked list are confirmed against the server, with what the inbox says, before anything is written', async () => {
    offered = new Set(['nb-offered']);
    await repairNotebooksAfterReset();
    expect(store.confirmHeldPeople).toHaveBeenCalledWith({ offered, declined: new Set(['declined-nb']) });
    expect(ran.indexOf('confirm held people')).toBeLessThan(ran.indexOf('keep notebooks'));
  });

  it('a locked notebook others hold is not rebuilt after a load, nor carried: it waits for its owner', async () => {
    states = { a: 'locked', b: 'locked', c: 'locked' };
    heldBy = { a: 2, b: null };
    const s = await repairNotebooksAfterReset();
    expect(store.carryRecord.mock.calls.map(c => c[0])).toEqual(['c']);
    expect(rebuildNotebookRecord.mock.calls.map(c => c[0])).toEqual(['c']);
    // Nobody asked for this run: the rebuild is told so.
    expect((rebuildNotebookRecord.mock.calls[0] as unknown[])[4]).toEqual({ attended: false });
    // a: held by others, left to its owner; b: its holders could not be read, so it waits.
    expect(s).toMatchObject({ rebuilt: 1, waiting: 1, notebooksHeld: 1 });
  });

  it(`at most ${REBUILDS_PER_RUN} rebuilds a run; the rest wait for the next load`, async () => {
    states = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(id => [id, 'locked' as State]));
    const s = await repairNotebooksAfterReset();
    expect(rebuildNotebookRecord).toHaveBeenCalledTimes(REBUILDS_PER_RUN);
    expect(s).toMatchObject({ rebuilt: REBUILDS_PER_RUN, waiting: 5 - REBUILDS_PER_RUN });
  });

  it('one another device has rebuilt since this page\'s sync is learned again, not rebuilt', async () => {
    states = { a: 'locked' };
    opensOnServer = { a: true };
    await repairNotebooksAfterReset();
    expect(ran).toContain('refresh a');
    expect(store.carryRecord).not.toHaveBeenCalled();
    expect(rebuildNotebookRecord).not.toHaveBeenCalled();
  });

  it('with work to do and no full pull this session, one is asked for and waited on first', async () => {
    states = { a: 'locked' };
    fullyPulled = false;
    await repairNotebooksAfterReset();
    expect(ran.indexOf('ask full pull')).toBeLessThan(ran.indexOf('wait for pull'));
    expect(ran.indexOf('wait for pull')).toBeLessThan(ran.indexOf('carry a'));
  });

  /**
   * The browser that held the account before its reset lists its notebooks
   * from its own copy, and after a reload its syncs never bring their items
   * again: nothing is known of their records, so nothing looks locked. Notes
   * the reset locked say a reset happened; a full pull is asked for, and the
   * records are known after it.
   */
  it('notes a reset locked are reason enough to wait for a full pull, and the records are judged after it', async () => {
    lockedNotes = 1;
    fullyPulled = false;
    states = { a: 'unknown' };
    store.nextPullEvent.mockImplementationOnce(async () => { ran.push('wait for pull'); fullyPulled = true; states.a = 'locked'; });
    const s = await repairNotebooksAfterReset();
    expect(requestFullPull).toHaveBeenCalledTimes(1);
    expect(ran.indexOf('wait for pull')).toBeLessThan(ran.indexOf('carry a'));
    expect(s.rebuilt).toBe(1);
  });

  it('a locked LIST alone is reason enough to wait for a full pull', async () => {
    locked = true;
    fullyPulled = false;
    await repairNotebooksAfterReset();
    expect(requestFullPull).toHaveBeenCalledTimes(1);
    expect(ran.indexOf('wait for pull')).toBeLessThan(ran.indexOf('keep notebooks'));
  });

  it('a page whose account changed while it waited does nothing more', async () => {
    states = { a: 'locked' };
    fullyPulled = false;
    store.nextPullEvent.mockImplementationOnce(async () => { account = 'someone-else'; fullyPulled = true; });
    await repairNotebooksAfterReset();
    expect(store.keepNotebooksWhileListLocked).not.toHaveBeenCalled();
    expect(store.carryRecord).not.toHaveBeenCalled();
  });

  it('it stops waiting for the pull as soon as the account changes', async () => {
    states = { a: 'locked' };
    fullyPulled = false;
    store.nextPullEvent.mockImplementation(async () => { ran.push('wait for pull'); account = 'someone-else'; });
    await repairNotebooksAfterReset();
    expect(store.nextPullEvent).toHaveBeenCalledTimes(1);
    expect(store.carryRecord).not.toHaveBeenCalled();
  });

  it('signed out: nothing at all', async () => {
    account = null;
    states = { a: 'locked' };
    await repairNotebooksAfterReset();
    expect(ran).toEqual([]);
  });
});

describe('the Share panel\'s, for a notebook it cannot open', () => {
  beforeEach(() => { heldIn = {}; confirmLeaves = {}; });

  /** People set aside at a locked list are on no list a rebuild reads. */
  it('people set aside for it are confirmed first, then it is rebuilt', async () => {
    states = { a: 'locked' };
    heldIn = { a: 2 };
    expect(await repairNotebookNow('a')).toBe(true);
    expect(ran.indexOf('confirm held people')).toBeGreaterThanOrEqual(0);
    expect(ran.indexOf('confirm held people')).toBeLessThan(ran.indexOf('rebuild a'));
  });

  it('people still set aside for it after the confirmation (their rows not read): it is not rebuilt now', async () => {
    states = { a: 'locked' };
    heldIn = { a: 2 };
    confirmLeaves = { a: 1 };
    expect(await repairNotebookNow('a')).toBe(false);
    expect(rebuildNotebookRecord).not.toHaveBeenCalled();
  });

  it('people set aside for another notebook do not hold this one back', async () => {
    states = { a: 'locked' };
    heldIn = { b: 1 };
    confirmLeaves = { b: 1 };
    expect(await repairNotebookNow('a')).toBe(true);
    expect(ran).not.toContain('confirm held people');
  });

  it('one that opens needs nothing', async () => {
    states = { a: 'opens' };
    expect(await repairNotebookNow('a')).toBe(true);
    expect(ran).toEqual([]);
  });

  it('a locked one the owner asks to share is rebuilt as the owner\'s act, others holding it or not', async () => {
    states = { a: 'locked' };
    heldBy = { a: 3 };
    expect(await repairNotebookNow('a')).toBe(true);
    expect((rebuildNotebookRecord.mock.calls[0] as unknown[])[4]).toEqual({ attended: true });
  });

  it('a locked one is rebuilt, and opens', async () => {
    states = { a: 'locked' };
    expect(await repairNotebookNow('a')).toBe(true);
    expect(ran).toEqual(['carry a', 'rebuild a']);
  });

  it('a keyless one is given a key, and opens', async () => {
    states = { k: 'keyless' };
    expect(await repairNotebookNow('k')).toBe(true);
    expect(ran).toEqual(['give key k']);
  });

  it('not known yet what was recovered: false, and nothing is done', async () => {
    states = { a: 'locked' };
    answered = false;
    expect(await repairNotebookNow('a')).toBe(false);
    expect(store.carryRecord).not.toHaveBeenCalled();
  });

  it('a rebuild that did not happen: false', async () => {
    states = { a: 'locked' };
    carryLands = false;
    expect(await repairNotebookNow('a')).toBe(false);
  });
});

describe('notes rescued from this browser\'s copies (lib/noteRescue)', () => {
  const go = (over: Partial<(typeof goes)[number]> = {}) => ({ rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0, ...over });
  afterEach(() => { vi.useRealTimers(); });

  it(`in goes of ${RESCUES_PER_GO}, the next a minute later: the server allows ten rotations a minute`, async () => {
    vi.useFakeTimers();
    goes = [go({ rescued: RESCUES_PER_GO, left: 3 }), go({ rescued: 3 })];
    const run = repairNotebooksAfterReset();
    await vi.advanceTimersByTimeAsync(BETWEEN_GOES_MS - 1);
    expect(rescueFromCopies).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const s = await run;
    expect(rescueFromCopies).toHaveBeenCalledTimes(2);
    expect(s.notesRescued).toBe(RESCUES_PER_GO + 3);
  });

  it('a go that rescues nothing ends it, whatever is left: the next load tries again', async () => {
    goes = [go({ waiting: 2, left: 5 })];
    await repairNotebooksAfterReset();
    expect(rescueFromCopies).toHaveBeenCalledTimes(1);
  });

  it('nothing is rescued until it is known what a recovery key brings back', async () => {
    answered = false;
    await repairNotebooksAfterReset();
    expect(rescueFromCopies).not.toHaveBeenCalled();
  });

  it('a page whose account changed meanwhile rescues nothing', async () => {
    store.restoreFromEarlierRecords.mockImplementationOnce(async () => { account = 'someone-else'; return 0; });
    await repairNotebooksAfterReset();
    expect(rescueFromCopies).not.toHaveBeenCalled();
  });

  it('a move a rescued note still owes is sent in a minute of its own (it may re-key the note); nothing is sent when none is', async () => {
    vi.useFakeTimers();
    goes = [go({ rescued: 1, movesQueued: 1 })];
    const run = repairNotebooksAfterReset();
    await vi.advanceTimersByTimeAsync(BETWEEN_GOES_MS - 1);
    expect(flushPending).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(ran.slice(-2)).toEqual([`rescue copies (${RESCUES_PER_GO})`, 'flush']);
    vi.clearAllMocks();
    goes = [go({ rescued: 1 })];
    await repairNotebooksAfterReset();
    expect(flushPending).not.toHaveBeenCalled();
  });

  it('the first go counts the run\'s rebuilds against the minute', async () => {
    states = { a: 'locked', b: 'locked' };
    await repairNotebooksAfterReset();
    expect(rescueFromCopies.mock.calls[0][0].limit).toBe(RESCUES_PER_GO - 2);
    expect(RESCUES_PER_GO).toBe(ROTATIONS_A_MINUTE - 1);
  });

  it('a copy here whose key opens with nothing is reason enough to wait for a full pull first', async () => {
    cachedCopiesLocked = true;
    fullyPulled = false;
    await repairNotebooksAfterReset();
    expect(ran.indexOf('wait for pull')).toBeGreaterThan(-1);
    expect(ran.indexOf('wait for pull')).toBeLessThan(ran.indexOf(`rescue copies (${RESCUES_PER_GO})`));
  });
});

describe('a rescued note\'s attachments, after a recovery key opens the old key kept for them', () => {
  const OPENS = { wrappedKey: 'old-open-wk', wrappedKeyNonce: 'wn', attachmentIds: ['att-1'] };
  const CLOSED = { wrappedKey: 'old-closed-wk', wrappedKeyNonce: 'wn', attachmentIds: ['att-1'] };
  beforeEach(() => {
    cards = [{ id: 'n1', wrappedContentKey: 'new-wk', wrappedContentKeyNonce: 'nn' }];
  });

  it('come over to the note\'s key, the old key kept on this browser meanwhile; then it is no longer kept in the list', async () => {
    kept = { n1: [OPENS] };
    expect(await restoreRescuedAttachments()).toBe(1);
    expect(retainContentKey).toHaveBeenCalledWith('n1', expect.any(Uint8Array));
    expect(rekeyNoteAttachments).toHaveBeenCalledWith('n1', [{ id: 'att-1' }], expect.any(Uint8Array), expect.any(Uint8Array));
    const [, , oldKey, newKey] = rekeyNoteAttachments.mock.calls[0] as unknown as [string, unknown, Uint8Array, Uint8Array];
    expect(oldKey[0]).toBe('old-open-wk'.length);
    expect(newKey[0]).toBe('new-wk'.length);
    expect(store.dropKeptNoteKeys).toHaveBeenCalledWith('n1', [OPENS]);
  });

  it('an old key nothing here opens yet: nothing, and it stays kept', async () => {
    kept = { n1: [CLOSED] };
    expect(await restoreRescuedAttachments()).toBe(0);
    expect(rekeyNoteAttachments).not.toHaveBeenCalled();
    expect(store.dropKeptNoteKeys).not.toHaveBeenCalled();
  });

  it('one that did not come over, or a list not read: the key stays kept', async () => {
    kept = { n1: [OPENS] };
    rekeyNoteAttachments.mockResolvedValueOnce({ attempted: 2, rekeyed: 1, skipped: 0, failed: 1 });
    expect(await restoreRescuedAttachments()).toBe(1);
    expect(store.dropKeptNoteKeys).not.toHaveBeenCalled();
    listAttachmentsForRekey.mockResolvedValueOnce(null as never);
    expect(await restoreRescuedAttachments()).toBe(0);
    expect(store.dropKeptNoteKeys).not.toHaveBeenCalled();
  });

  it('a kept key with no record of its files (an earlier build): nothing comes over, nothing is listed, and it stays kept', async () => {
    const { attachmentIds: _none, ...noRecord } = OPENS;
    kept = { n1: [noRecord] };
    expect(await restoreRescuedAttachments()).toBe(0);
    expect(retainContentKey).toHaveBeenCalledWith('n1', expect.any(Uint8Array));
    expect(listAttachmentsForRekey).not.toHaveBeenCalled();
    expect(rekeyNoteAttachments).not.toHaveBeenCalled();
    expect(store.dropKeptNoteKeys).not.toHaveBeenCalled();
  });

  it('only the attachments it had when it was rescued: one added since is under the new key already', async () => {
    kept = { n1: [{ ...OPENS, attachmentIds: ['att-1'] }] };
    listAttachmentsForRekey.mockResolvedValueOnce([{ id: 'att-1' }, { id: 'att-added-since' }] as never);
    await restoreRescuedAttachments();
    expect((rekeyNoteAttachments.mock.calls[0] as unknown[])[1]).toEqual([{ id: 'att-1' }]);
  });

  it('a card still under the kept key is not the rescued note yet: nothing comes over, and the key stays kept', async () => {
    kept = { n1: [OPENS] };
    cards = [{ id: 'n1', wrappedContentKey: OPENS.wrappedKey, wrappedContentKeyNonce: 'wn' }];
    expect(await restoreRescuedAttachments()).toBe(0);
    expect(rekeyNoteAttachments).not.toHaveBeenCalled();
    expect(store.dropKeptNoteKeys).not.toHaveBeenCalled();
  });

  it('nothing for a note whose own key does not open here, or that is not here', async () => {
    kept = { n1: [OPENS], n2: [OPENS] };
    cards = [{ id: 'n1', wrappedContentKey: 'closed-wk', wrappedContentKeyNonce: 'nn' }];
    expect(await restoreRescuedAttachments()).toBe(0);
    expect(rekeyNoteAttachments).not.toHaveBeenCalled();
  });
});

describe('a run that found nothing to do', () => {
  const go = (over: Partial<(typeof goes)[number]> = {}) => ({ rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0, ...over });
  it('is remembered: the next load, with nothing changed, pulls nothing and runs nothing', async () => {
    lockedNotes = 2;
    fullyPulled = false;
    await repairNotebooksAfterReset();
    expect(requestFullPull).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    store.nextPullEvent.mockImplementation(async () => { ran.push('wait for pull'); fullyPulled = true; });
    ran.length = 0;
    fullyPulled = false;
    await repairNotebooksAfterReset();
    expect(requestFullPull).not.toHaveBeenCalled();
    expect(rescueFromCopies).not.toHaveBeenCalled();
  });

  it('anything that changes is looked at again: a recovery key used, more notes locked', async () => {
    lockedNotes = 2;
    await repairNotebooksAfterReset();
    vi.clearAllMocks();
    store.nextPullEvent.mockImplementation(async () => { ran.push('wait for pull'); fullyPulled = true; });
    recoveredKeys = 1;
    await repairNotebooksAfterReset();
    expect(rescueFromCopies).toHaveBeenCalled();
    vi.clearAllMocks();
    store.nextPullEvent.mockImplementation(async () => { ran.push('wait for pull'); fullyPulled = true; });
    await repairNotebooksAfterReset();
    expect(rescueFromCopies).not.toHaveBeenCalled();
    lockedNotes = 3;
    await repairNotebooksAfterReset();
    expect(rescueFromCopies).toHaveBeenCalled();
  });

  it('a run that did something, or left something waiting, is not remembered as quiet', async () => {
    lockedNotes = 1;
    goes = [go({ rescued: 1 })];
    await repairNotebooksAfterReset();
    expect(stored.size).toBe(0);
    goes = [go({ waiting: 1 })];
    await repairNotebooksAfterReset();
    expect(stored.size).toBe(0);
  });

  it('a notebook others hold is held, not waiting: a run with only that is quiet', async () => {
    lockedNotes = 1;
    states = { a: 'locked' };
    heldBy = { a: 2 };
    const s = await repairNotebooksAfterReset();
    expect(s).toMatchObject({ notebooksHeld: 1, waiting: 0 });
    expect(stored.size).toBe(1);
  });
});

