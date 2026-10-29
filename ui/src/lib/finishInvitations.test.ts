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

import { describe, it, expect, vi } from 'vitest';
import { anyWaiting, finishWaitingIn, isUnfinished, standingOf, stillWaiting, FINISH_RETRY_MS, type FinishSteps, type Tried } from './finishInvitations';
import type { NotebookShareRecipient } from '../stores/notebooks';

/**
 * An invitation made before its reader had an account is queued, and
 * finished when they have one, notebook first.
 */
const NB = 'nb-1';
const ZOE: NotebookShareRecipient = { email: 'Zoe@Example.test', permission: 'edit', publicKey: null, userId: null, signingPublicKey: null };
const BEN: NotebookShareRecipient = { email: 'ben@example.test', permission: 'view', publicKey: 'aa'.repeat(32), userId: 'ben-id', signingPublicKey: 'bb'.repeat(32) };
const ZOE_KEYS = { userId: 'zoe-id', sharingPub: 'cc'.repeat(32), signingPub: 'dd'.repeat(32) };

/** What the notes step's guard said, before and after the step's own `during` hook. */
let guardSaid: boolean[] = [];

function harness(initial: NotebookShareRecipient[], directory: Record<string, typeof ZOE_KEYS> | null) {
  guardSaid = [];
  const done: string[] = [];
  let clock = 1_000_000;
  /** The standing list as it is now: a test changes it while a step is on its way. */
  let standing = [...initial];
  /** The list as the SERVER holds it, when a test makes it differ from this device's
   *  (another device of the owner's); null when it cannot be read. */
  let server: NotebookShareRecipient[] | null | undefined;
  /** A removal of theirs still being carried through: the store will not give their entry its keys. */
  let held = false;
  /** Did every note go? */
  let notesWent = true;
  /** Run when the named step is reached, before it answers: `lookup`, `server`, `notebook`,
   *  `notes`, `written`. */
  const during: Record<string, () => void> = {};
  const steps = {
    standing: vi.fn((_id: string) => standing),
    serverStanding: vi.fn(async (_id: string) => {
      during.server?.();
      return server === undefined ? standing : server;
    }),
    written: vi.fn(async () => { during.written?.(); }),
    // A share the owner is making: `settled` runs as it ends (the owner's own steps, the entry last).
    ownerShareSettled: vi.fn(async (_id: string, email: string) => {
      done.push(`settled ${email}`);
      during.settled?.();
    }),
    lookup: vi.fn(async (emails: string[]) => {
      done.push(`lookup ${emails.join(',')}`);
      during.lookup?.();
      return directory === null ? null : new Map(Object.entries(directory));
    }),
    shareNotebook: vi.fn(async (_id: string, r: NotebookShareRecipient, grant: string) => {
      done.push(`notebook ${r.email} ${grant} ${r.publicKey}`);
      during.notebook?.();
      return true;
    }),
    shareNotes: vi.fn(async (_id: string, r: NotebookShareRecipient, stillWaiting: () => boolean) => {
      done.push(`notes ${r.email} ${r.publicKey}`);
      guardSaid.push(stillWaiting());
      during.notes?.();
      guardSaid.push(stillWaiting());
      return notesWent ? [] : ['note-that-did-not-go'];
    }),
    sendLater: vi.fn((_id: string, email: string, noteIds: readonly string[]) => { done.push(`later ${email} ${noteIds.join(',')}`); }),
    // As the store's: only an entry that is still there and still waiting is filled in.
    saveStanding: vi.fn((_id: string, r: NotebookShareRecipient) => {
      if (held || !stillWaiting(standing, r.email)) return false;
      standing = standing.map(e => (e.email.toLowerCase() === r.email.toLowerCase() ? r : e));
      done.push(`standing ${r.email} ${r.publicKey}`);
      return true;
    }),
    takeBack: vi.fn(async (_id: string, email: string) => { done.push(`take back ${email}`); }),
    now: () => clock,
  };
  const tried: Tried = new Map();
  return {
    steps, done, tried, during,
    later: (ms: number) => { clock += ms; },
    /** The owner removes them: off the standing list at once, as `removeNotebookShare` does. */
    remove: (email: string) => { standing = standing.filter(e => e.email.toLowerCase() !== email.toLowerCase()); },
    /** The owner adds them back by hand, in the Share panel: an entry with their keys, written last. */
    addedBackByHand: (email: string) => {
      standing = [...standing.filter(e => e.email.toLowerCase() !== email.toLowerCase()), { ...ZOE, email, publicKey: 'ee'.repeat(32), userId: 'by-hand' }];
    },
    /** A removal of theirs is still being carried through. */
    hold: () => { held = true; },
    /** Whether the notes all go, from now on. */
    notesGo: (go: boolean) => { notesWent = go; },
    /** The server's list from now on (another device's write); null: it cannot be read. */
    onServer: (list: NotebookShareRecipient[] | null) => { server = list; },
    /** The owner finishes the invitation by hand in the Share panel: the entry has its keys. */
    finishedByHand: (email: string) => {
      standing = standing.map(e => (e.email.toLowerCase() === email.toLowerCase() ? { ...e, publicKey: 'ee'.repeat(32), userId: 'by-hand' } : e));
    },
    standingNow: () => standing,
    run: () => finishWaitingIn(NB, steps as unknown as FinishSteps, tried),
  };
}

describe('an entry saved without a key', () => {
  it('is an unfinished invitation; one with a key is not', () => {
    expect(isUnfinished(ZOE)).toBe(true);
    expect(isUnfinished({ publicKey: '' })).toBe(true);
    expect(isUnfinished({})).toBe(true);
    expect(isUnfinished(BEN)).toBe(false);
  });

  it('is found without asking anyone', () => {
    const lists: Record<string, NotebookShareRecipient[]> = { a: [BEN], b: [BEN, ZOE], c: [] };
    expect(anyWaiting(['a', 'b', 'c'], (id) => lists[id])).toEqual(['b']);
    expect(anyWaiting([], () => [ZOE])).toEqual([]);
  });
});

describe('finishing the invitations of a notebook', () => {
  it('asks nobody when nothing is waiting', async () => {
    const h = harness([BEN], { 'zoe@example.test': ZOE_KEYS });
    expect(await h.run()).toEqual([]);
    expect(h.steps.lookup).not.toHaveBeenCalled();
  });

  it('shares the NOTEBOOK first, then its notes, then gives the standing entry its keys', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    expect(await h.run()).toEqual(['Zoe@Example.test']);
    expect(h.done).toEqual([
      // Only the one who is waiting is asked about.
      'lookup Zoe@Example.test',
      `notebook Zoe@Example.test edit ${ZOE_KEYS.sharingPub}`,
      `notes Zoe@Example.test ${ZOE_KEYS.sharingPub}`,
      `standing Zoe@Example.test ${ZOE_KEYS.sharingPub}`,
    ]);
    expect(h.steps.saveStanding).toHaveBeenCalledWith(NB, {
      email: 'Zoe@Example.test', permission: 'edit',
      publicKey: ZOE_KEYS.sharingPub, userId: 'zoe-id', signingPublicKey: ZOE_KEYS.signingPub,
    });
  });

  it('at the right the owner chose: someone invited to view is given view', async () => {
    const h = harness([{ ...ZOE, permission: 'view' }], { 'zoe@example.test': ZOE_KEYS });
    await h.run();
    expect(h.steps.shareNotebook.mock.calls[0][2]).toBe('view');
    expect(h.steps.saveStanding.mock.calls[0][1].permission).toBe('view');
  });

  it('someone who still has no account goes on waiting, and is asked about again next time', async () => {
    const h = harness([ZOE], {});
    expect(await h.run()).toEqual([]);
    expect(h.steps.shareNotebook).not.toHaveBeenCalled();
    expect(h.steps.shareNotes).not.toHaveBeenCalled();
    expect(h.steps.saveStanding).not.toHaveBeenCalled();
    await h.run();
    expect(h.steps.lookup).toHaveBeenCalledTimes(2);
  });

  /** No answer is not "no account", and it is not "has one" either. */
  it('nothing is concluded when the directory could not be asked', async () => {
    const h = harness([ZOE], null);
    expect(await h.run()).toEqual([]);
    expect(h.done).toEqual(['lookup Zoe@Example.test']);
    const failing = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    failing.steps.lookup.mockRejectedValue(new Error('offline'));
    expect(await failing.run()).toEqual([]);
    expect(failing.steps.shareNotebook).not.toHaveBeenCalled();
  });

  /** The fault itself: notes sealed to someone who holds no invitation. */
  it('when the notebook could NOT be shared, none of its notes are, and the entry stays without a key', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.steps.shareNotebook.mockResolvedValue(false);
    expect(await h.run()).toEqual([]);
    expect(h.steps.shareNotes).not.toHaveBeenCalled();
    expect(h.steps.saveStanding).not.toHaveBeenCalled();
  });

  it('the same when sharing it throws', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.steps.shareNotebook.mockRejectedValue(new Error('boom'));
    expect(await h.run()).toEqual([]);
    expect(h.steps.shareNotes).not.toHaveBeenCalled();
    expect(h.steps.saveStanding).not.toHaveBeenCalled();
  });

  it('one that could not be finished is left alone for ten minutes, then tried again', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.steps.shareNotebook.mockResolvedValue(false);
    await h.run();
    expect(h.steps.shareNotebook).toHaveBeenCalledTimes(1);
    h.later(FINISH_RETRY_MS - 1);
    await h.run();
    // Not even asked about: there is nobody due.
    expect(h.steps.lookup).toHaveBeenCalledTimes(1);
    expect(h.steps.shareNotebook).toHaveBeenCalledTimes(1);
    h.later(1);
    h.steps.shareNotebook.mockResolvedValue(true);
    expect(await h.run()).toEqual(['Zoe@Example.test']);
    expect(h.steps.shareNotebook).toHaveBeenCalledTimes(2);
  });

  it('ten minutes it is', () => {
    expect(FINISH_RETRY_MS).toBe(600_000);
  });

  it('an invitation that was finished is not held back by an earlier failure', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.steps.shareNotebook.mockResolvedValueOnce(false);
    await h.run();
    h.later(FINISH_RETRY_MS);
    await h.run();
    expect(h.tried.size).toBe(0);
  });

  /**
   * A note that did not go does not hold the invitation back: held back, a
   * notebook of more notes than the server takes from an owner in a minute
   * would never be finished, as each try shared every note again and met the
   * limit. The entry is given its keys, and what did not go is sent again
   * later (`sendLater`), once the entry is written, so such a note still goes.
   */
  it('a note that did not go: the entry is given its keys anyway, and what did not go is sent later', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.notesGo(false);
    expect(await h.run()).toEqual(['Zoe@Example.test']);
    expect(standingOf(h.standingNow(), 'zoe@example.test')).toBe('finished');
    expect(h.steps.takeBack).not.toHaveBeenCalled();
    expect(h.done.slice(-2)).toEqual([`standing Zoe@Example.test ${ZOE_KEYS.sharingPub}`, 'later Zoe@Example.test note-that-did-not-go']);
    expect(h.tried.size).toBe(0);
  });

  it('every note went: nothing is sent later', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    expect(await h.run()).toEqual(['Zoe@Example.test']);
    expect(h.steps.sendLater).not.toHaveBeenCalled();
  });

  it('and the same when the notes step stopped with an error half-way', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.steps.shareNotes.mockRejectedValueOnce(new Error('offline half-way'));
    expect(await h.run()).toEqual([]);
    expect(h.steps.saveStanding).not.toHaveBeenCalled();
    expect(h.steps.takeBack).not.toHaveBeenCalled();
    expect(h.steps.sendLater).not.toHaveBeenCalled();
    h.later(FINISH_RETRY_MS);
    expect(await h.run()).toEqual(['Zoe@Example.test']);
    warn.mockRestore();
  });

  it('each waiting person is finished or not on their own', async () => {
    const YAN: NotebookShareRecipient = { email: 'yan@example.test', permission: 'view', publicKey: null };
    const h = harness([ZOE, YAN], { 'zoe@example.test': ZOE_KEYS, 'yan@example.test': { ...ZOE_KEYS, userId: 'yan-id' } });
    h.steps.shareNotebook.mockImplementation(async (_id: string, r: NotebookShareRecipient) => r.email !== 'Zoe@Example.test');
    expect(await h.run()).toEqual(['yan@example.test']);
    expect(h.steps.saveStanding.mock.calls.map(c => c[1].email)).toEqual(['yan@example.test']);
  });
});

/**
 * The list of who is waiting must not be read just once, at the start: a
 * removal made while the finish was under way would then be undone by its
 * last write, which is the Share panel's "add them back".
 */
describe('someone removed while their invitation is being finished', () => {
  it('while the directory is being asked: nothing is sealed for them, and they are not put back', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.lookup = () => h.remove('zoe@example.test');
    expect(await h.run()).toEqual([]);
    expect(h.steps.shareNotebook).not.toHaveBeenCalled();
    expect(h.steps.shareNotes).not.toHaveBeenCalled();
    expect(h.steps.saveStanding).not.toHaveBeenCalled();
    // Nothing was done, so there is nothing to take back.
    expect(h.steps.takeBack).not.toHaveBeenCalled();
    expect(h.standingNow()).toEqual([BEN]);
  });

  it('while the notebook is on its way to them: it is taken back, and no note follows', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.notebook = () => h.remove('zoe@example.test');
    expect(await h.run()).toEqual([]);
    expect(h.steps.shareNotes).not.toHaveBeenCalled();
    expect(h.steps.saveStanding).not.toHaveBeenCalled();
    expect(h.steps.takeBack).toHaveBeenCalledWith(NB, 'Zoe@Example.test');
    expect(h.standingNow()).toEqual([BEN]);
  });

  it('the same when that share says it did not go through: it may have gone half-way', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.steps.shareNotebook.mockImplementationOnce(async () => { h.remove('zoe@example.test'); return false; });
    expect(await h.run()).toEqual([]);
    expect(h.steps.takeBack).toHaveBeenCalledWith(NB, 'Zoe@Example.test');
    h.steps.takeBack.mockClear();
    // And when it throws.
    const g = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    g.steps.shareNotebook.mockImplementationOnce(async () => { g.remove('zoe@example.test'); throw new Error('offline'); });
    expect(await g.run()).toEqual([]);
    expect(g.steps.takeBack).toHaveBeenCalledWith(NB, 'Zoe@Example.test');
  });

  it('while the notes are going out: all of it is taken back, and they are not put back on the list', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.notes = () => h.remove('zoe@example.test');
    expect(await h.run()).toEqual([]);
    // The notes step was told, note by note, that they are gone.
    expect(guardSaid).toEqual([true, false]);
    expect(h.steps.saveStanding).not.toHaveBeenCalled();
    expect(h.steps.takeBack).toHaveBeenCalledTimes(1);
    expect(h.done[h.done.length - 1]).toBe('take back Zoe@Example.test');
    expect(h.standingNow()).toEqual([BEN]);
  });

  /**
   * Another device of the owner's. This device's list is not the only one,
   * and a finish made on it alone would undo a removal made there: its write
   * would merge the removal in, and the notebook, the roster entry and the
   * notes it had given would stand, with nothing to take them back.
   */
  it('removed on another device: the server\'s list, read again first, says so, and nothing is shared', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.onServer([BEN]);
    expect(await h.run()).toEqual([]);
    expect(h.steps.serverStanding).toHaveBeenCalledWith(NB);
    expect(h.steps.shareNotebook).not.toHaveBeenCalled();
    expect(h.steps.takeBack).not.toHaveBeenCalled();
    expect(h.tried.size).toBe(0);
  });

  it('finished on another device: it is not done a second time here', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.onServer([BEN, { ...ZOE, publicKey: 'ee'.repeat(32), userId: 'there' }]);
    expect(await h.run()).toEqual([]);
    expect(h.steps.shareNotebook).not.toHaveBeenCalled();
  });

  it('the server\'s list not read: nothing is done now, and it is tried again after the pause', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.onServer(null);
    expect(await h.run()).toEqual([]);
    expect(h.steps.shareNotebook).not.toHaveBeenCalled();
    h.onServer([BEN, ZOE]);
    expect(await h.run()).toEqual([]);
    h.later(FINISH_RETRY_MS);
    expect(await h.run()).toEqual(['Zoe@Example.test']);
  });

  it('removed on another device while the finish was going: the write merges it in, and all of it is taken back', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.written = () => h.remove('zoe@example.test');
    expect(await h.run()).toEqual([]);
    expect(h.steps.written).toHaveBeenCalledTimes(1);
    expect(h.steps.takeBack).toHaveBeenCalledTimes(1);
    expect(h.done[h.done.length - 1]).toBe('take back Zoe@Example.test');
    expect(h.standingNow()).toEqual([BEN]);
  });

  it('the server\'s own change to the waiting entry won the merge: not finished, nothing taken back, tried again later', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.written = () => {
      const waitingAgain = { ...ZOE, permission: 'view' as const };
      h.remove('zoe@example.test');
      h.onServer(null);
      (h.standingNow() as NotebookShareRecipient[]).push(waitingAgain);
    };
    expect(await h.run()).toEqual([]);
    expect(h.steps.takeBack).not.toHaveBeenCalled();
    expect(h.tried.size).toBe(1);
  });

  /**
   * The owner removes them and adds them back during a finish. The Share
   * panel writes their entry LAST, so all through the re-add they read as
   * gone, and a take-back would revoke the invitation the re-add had just
   * made (keyed notes, no invitation). So the finish waits for the owner's
   * share to end, and reads the list again.
   */
  it('added back by the owner while the notes went out: the owner\'s share is waited for, and nothing is taken back', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.notes = () => h.remove('zoe@example.test');
    h.during.settled = () => h.addedBackByHand('Zoe@Example.test');
    expect(await h.run()).toEqual([]);
    expect(h.steps.ownerShareSettled).toHaveBeenCalledWith(NB, 'Zoe@Example.test');
    expect(h.steps.takeBack).not.toHaveBeenCalled();
    expect(standingOf(h.standingNow(), 'zoe@example.test')).toBe('finished');
  });

  it('the owner\'s share did not leave them on the list: once it ended, what the finish gave them is taken back', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.notes = () => h.remove('zoe@example.test');
    expect(await h.run()).toEqual([]);
    expect(h.done.slice(-2)).toEqual(['settled Zoe@Example.test', 'take back Zoe@Example.test']);
  });

  it('added back while the entry\'s write met the removal: nothing is taken back', async () => {
    const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.written = () => h.remove('zoe@example.test');
    h.during.settled = () => h.addedBackByHand('Zoe@Example.test');
    expect(await h.run()).toEqual([]);
    expect(h.steps.takeBack).not.toHaveBeenCalled();
  });

  it('held off by a removal still being carried through: taken back, unless the owner\'s share in flight leaves them on the list', async () => {
    const held = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    held.hold();
    expect(await held.run()).toEqual([]);
    expect(held.done.slice(-2)).toEqual(['settled Zoe@Example.test', 'take back Zoe@Example.test']);

    const readded = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
    readded.hold();
    readded.during.settled = () => readded.addedBackByHand('Zoe@Example.test');
    expect(await readded.run()).toEqual([]);
    expect(readded.steps.takeBack).not.toHaveBeenCalled();
  });

  it('a share that merely FAILED, with nobody removed, takes nothing back: the invitation goes on waiting', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.steps.shareNotebook.mockResolvedValueOnce(false);
    expect(await h.run()).toEqual([]);
    expect(h.steps.takeBack).not.toHaveBeenCalled();
    expect(h.standingNow()).toEqual([ZOE]);
  });

  it('when the standing entry cannot be given its keys, what was sealed is taken back', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    // The store refuses: they are held off the notebook (a removal still being carried through).
    h.steps.saveStanding.mockImplementationOnce(() => false);
    expect(await h.run()).toEqual([]);
    expect(h.steps.takeBack).toHaveBeenCalledWith(NB, 'Zoe@Example.test');
  });

  it('finished by hand in the Share panel meanwhile: the page does not do it a second time, and takes nothing back', async () => {
    const h = harness([ZOE], { 'zoe@example.test': ZOE_KEYS });
    h.during.lookup = () => h.finishedByHand('zoe@example.test');
    expect(await h.run()).toEqual([]);
    expect(h.steps.shareNotebook).not.toHaveBeenCalled();
    expect(h.steps.takeBack).not.toHaveBeenCalled();
    expect(h.standingNow()[0].userId).toBe('by-hand');
  });

  /**
   * The owner's own "finish sharing", pressed while the page's finish was on
   * its way. They are no longer waiting, and they are NOT removed: taking
   * back here would run a removal of someone the owner has just let in.
   */
  it('finished by hand while the notebook, or the notes, were on their way: nothing is taken back from them', async () => {
    for (const step of ['notebook', 'notes'] as const) {
      const h = harness([BEN, ZOE], { 'zoe@example.test': ZOE_KEYS });
      h.during[step] = () => h.finishedByHand('zoe@example.test');
      expect(await h.run(), step).toEqual([]);
      expect(h.steps.takeBack, step).not.toHaveBeenCalled();
      expect(h.steps.saveStanding, step).not.toHaveBeenCalled();
      // The owner's entry stands as the owner wrote it.
      expect(h.standingNow().find(e => e.email === ZOE.email)?.userId, step).toBe('by-hand');
    }
  });

  it('where someone stands: waiting, finished, or gone', () => {
    expect(standingOf([ZOE], 'ZOE@example.test')).toBe('waiting');
    expect(standingOf([{ ...ZOE, publicKey: 'ee'.repeat(32) }], 'zoe@example.test')).toBe('finished');
    expect(standingOf([BEN], 'zoe@example.test')).toBe('gone');
    expect(standingOf([], 'zoe@example.test')).toBe('gone');
  });

  it('the others who were waiting are finished all the same', async () => {
    const yan: NotebookShareRecipient = { email: 'yan@example.test', permission: 'view', publicKey: null, userId: null, signingPublicKey: null };
    const h = harness([ZOE, yan], { 'zoe@example.test': ZOE_KEYS, 'yan@example.test': { ...ZOE_KEYS, userId: 'yan-id' } });
    h.during.lookup = () => h.remove('zoe@example.test');
    expect(await h.run()).toEqual(['yan@example.test']);
    expect(h.standingNow().map(e => [e.email, e.userId])).toEqual([['yan@example.test', 'yan-id']]);
  });

  it('who is waiting is read by address, whatever its case, and only an entry without a key waits', () => {
    expect(stillWaiting([ZOE], 'zoe@example.test')).toBe(true);
    expect(stillWaiting([ZOE], 'ZOE@EXAMPLE.TEST')).toBe(true);
    expect(stillWaiting([BEN], 'ben@example.test')).toBe(false);
    expect(stillWaiting([], 'zoe@example.test')).toBe(false);
    expect(stillWaiting([BEN], 'zoe@example.test')).toBe(false);
  });
});
