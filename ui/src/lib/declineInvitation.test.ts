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
import { blockFromInvitation, declineNotebook, DeclineNotDone, type BlockSteps, type DeclineSteps } from './declineInvitation';

/**
 * Declining a notebook invitation. The sequence lives outside the component
 * so that each step is checked: that its dismissals went through, and that
 * the one call that forgets the notebook is still made. The decline is one
 * request the server carries out whole: after a decline, nothing of that
 * share shows up.
 */
type Answer = boolean | 'throws';
/**
 * @param answer  what the server's decline answers: one answer for every time
 *                it is asked, or one per time, the last repeating
 * @param inbox   what reading the inbox again finds: the list was read to its
 *                end ('list') or not ('no list'), and whether it still holds a
 *                share of the notebook
 */
function steps(
  answer: Answer | Answer[] = true,
  inbox: {
    read: 'list' | 'no list' | 'throws'; offered: boolean;
    /** The notebook's notes the inbox holds AFTER it was read again (none unless a test says so). */
    late?: { shareId: string; noteId: string }[];
  } = { read: 'list', offered: false },
) {
  const log: string[] = [];
  const answers = Array.isArray(answer) ? [...answer] : [answer];
  const s: DeclineSteps = {
    markDeclined: (id, shareIds) => { log.push(`mark ${id} [${shareIds.join(',')}]`); },
    unmarkDeclined: (id) => { log.push(`unmark ${id}`); },
    decline: async (id, shareIds) => {
      log.push(`decline ${id} [${shareIds.join(',')}]`);
      const now = answers.length > 1 ? answers.shift()! : answers[0];
      if (now === 'throws') throw new Error('network');
      return now;
    },
    forgetAcceptance: async (id) => { log.push(`forget ${id}`); },
    forgetNotes: (ids) => { log.push(`drop [${ids.join(',')}]`); },
    reloadInbox: async () => {
      log.push('reload');
      if (inbox.read === 'throws') throw new Error('offline');
      return inbox.read === 'list';
    },
    isOffered: (id) => { log.push(`offered? ${id}`); return inbox.offered; },
    notesNow: () => inbox.late ?? [],
    syncNotes: () => { log.push('sync'); },
  };
  return { s, log };
}
/** The server did not take it, and its list says so: the notebook is still on offer. */
const refused = (answer: false | 'throws' = false) => steps(answer, { read: 'list', offered: true });
const ASKED = 'decline nb [s1,s2,nb-new,nb-old]';
const INVITE = { notebookId: 'nb', shareIds: ['nb-new', 'nb-old'] };
const NOTES = [{ shareId: 's1', noteId: 'n1' }, { shareId: 's2', noteId: 'n2' }];

describe('a decline that goes through', () => {
  it('marks first, asks the server once, then forgets, drops the copies, reloads and syncs', async () => {
    const { s, log } = steps();
    await declineNotebook(INVITE, NOTES, s);
    expect(log).toEqual([
      'mark nb [nb-new,nb-old]',
      'decline nb [s1,s2,nb-new,nb-old]',
      'forget nb', 'drop [n1,n2]', 'reload', 'sync',
    ]);
  });

  /** One request, all or nothing: there is no state in which some of the notebook's notes are dismissed and its invitation is not. */
  it('is ONE request to the server, however many notes the notebook has', async () => {
    const { s, log } = steps();
    const many = Array.from({ length: 700 }, (_, i) => ({ shareId: `s${i}`, noteId: `n${i}` }));
    await declineNotebook(INVITE, many, s);
    expect(log.filter(l => l.startsWith('decline '))).toHaveLength(1);
  });

  /** The shares this page knows to be the notebook's: its notes' and its own rows, each once. */
  it('names the notes\' shares and every row of the notebook, each once', async () => {
    const { s, log } = steps();
    await declineNotebook(
      { notebookId: 'nb', shareIds: ['row', 'row', 's1'] },
      [{ shareId: 's1', noteId: 'n1' }, { shareId: 's1', noteId: 'n1' }],
      s,
    );
    expect(log).toContain('decline nb [s1,row]');
  });

  it('a notebook with no notes on this page is declined all the same', async () => {
    const { s, log } = steps();
    await declineNotebook(INVITE, [], s);
    expect(log).toEqual(['mark nb [nb-new,nb-old]', 'decline nb [nb-new,nb-old]', 'forget nb', 'drop []', 'reload', 'sync']);
  });

  /** Without this test the call could be deleted with every other test passing. */
  it('forgets the acceptance, on the shared list and on this device', async () => {
    const { s, log } = steps();
    await declineNotebook(INVITE, NOTES, s);
    expect(log).toContain('forget nb');
  });

  /**
   * The copies go at once, by their NOTE ids. A sync evicts them only on an
   * inbox it read to its end, and a reload before that would show them again.
   */
  it('takes the declined notes\' copies off this device, by note id, once the server has taken the decline', async () => {
    const { s, log } = steps();
    await declineNotebook(INVITE, NOTES, s);
    expect(log).toContain('drop [n1,n2]');
    expect(log.indexOf('drop [n1,n2]')).toBeGreaterThan(log.findIndex(l => l.startsWith('decline ')));
  });

  /** The notes are off this page from the first moment, not when the answer comes back. */
  it('marks the notebook before the request leaves', async () => {
    const { s, log } = steps();
    await declineNotebook(INVITE, NOTES, s);
    expect(log.indexOf('mark nb [nb-new,nb-old]')).toBe(0);
  });

  it('the sync is started after the inbox was read again', async () => {
    const { s, log } = steps();
    await declineNotebook(INVITE, NOTES, s);
    expect(log.indexOf('sync')).toBeGreaterThan(log.indexOf('reload'));
  });
});

/**
 * `apiRequest` answers a failure, it does not throw. A "no" the server
 * did not take must not make this device forget the notebook.
 */
describe('a decline the server did not take', () => {
  it('stops, and says which notebook', async () => {
    await expect(declineNotebook(INVITE, NOTES, refused().s)).rejects.toBeInstanceOf(DeclineNotDone);
    await expect(declineNotebook(INVITE, NOTES, refused().s)).rejects.toMatchObject({ notebookId: 'nb' });
  });

  it('forgets nothing, drops nothing and starts no sync', async () => {
    const { s, log } = refused();
    await expect(declineNotebook(INVITE, NOTES, s)).rejects.toBeInstanceOf(DeclineNotDone);
    expect(log.some(l => l.startsWith('forget '))).toBe(false);
    expect(log.some(l => l.startsWith('drop '))).toBe(false);
    expect(log).not.toContain('sync');
  });

  it('a request that throws is a decline that did not go through, not a crash', async () => {
    const { s, log } = refused('throws');
    await expect(declineNotebook(INVITE, NOTES, s)).rejects.toBeInstanceOf(DeclineNotDone);
    expect(log.some(l => l.startsWith('forget '))).toBe(false);
  });

  /**
   * The mark goes with it: the invitation stands exactly as it did before the
   * press. Left behind, the mark outranks an acceptance, and one made on
   * another device would open an empty notebook on this page.
   */
  it('takes its mark back, after the inbox was read', async () => {
    for (const answer of [false, 'throws'] as const) {
      const { s, log } = refused(answer);
      await expect(declineNotebook(INVITE, NOTES, s)).rejects.toBeInstanceOf(DeclineNotDone);
      // Asked twice (the second time in case the first yes was lost), then the list decides.
      expect(log).toEqual(['mark nb [nb-new,nb-old]', ASKED, ASKED, 'reload', 'offered? nb', 'unmark nb']);
    }
  });

  /** No list, no verdict: "the notebook is gone" can only be read off a list read to its end. */
  it('an inbox that could not be read to its end proves nothing: still a failure, whatever it seems to hold', async () => {
    for (const inbox of [
      { read: 'no list', offered: false }, { read: 'no list', offered: true },
      { read: 'throws', offered: false }, { read: 'throws', offered: true },
    ] as const) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { s, log } = steps(false, inbox);
      await expect(declineNotebook(INVITE, NOTES, s), JSON.stringify(inbox)).rejects.toBeInstanceOf(DeclineNotDone);
      expect(log[log.length - 1]).toBe('unmark nb');
      expect(log.some(l => l.startsWith('forget ') || l.startsWith('drop ') || l === 'sync')).toBe(false);
      warn.mockRestore();
    }
  });

  it('pressed again, it asks the server again and finishes', async () => {
    await expect(declineNotebook(INVITE, NOTES, refused().s)).rejects.toBeInstanceOf(DeclineNotDone);
    const second = steps(true);
    await expect(declineNotebook(INVITE, NOTES, second.s)).resolves.toBeUndefined();
    expect(second.log).toContain('forget nb');
    expect(second.log).not.toContain('unmark nb');
  });
});

/**
 * A yes can be lost on its way back: the request timed out, the server had
 * taken it. The request does the same thing however often it is made, so it
 * is made once more; and when that fails too, the inbox is read again, and
 * if the server's list, read to its end, no longer offers the notebook, the
 * decline went through.
 */
describe('a decline whose answer was lost', () => {
  it('a yes the second time is a yes: finished as any decline that went through', async () => {
    for (const first of [false, 'throws'] as const) {
      const { s, log } = steps([first, true]);
      await expect(declineNotebook(INVITE, NOTES, s)).resolves.toBeUndefined();
      expect(log).toEqual(['mark nb [nb-new,nb-old]', ASKED, ASKED, 'forget nb', 'drop [n1,n2]', 'reload', 'sync']);
    }
  });

  it('a yes the first time is not asked for again', async () => {
    const { s, log } = steps(true);
    await declineNotebook(INVITE, NOTES, s);
    expect(log.filter(l => l === ASKED)).toHaveLength(1);
  });

  it('is asked no more than twice', async () => {
    const { s, log } = refused();
    await expect(declineNotebook(INVITE, NOTES, s)).rejects.toBeInstanceOf(DeclineNotDone);
    expect(log.filter(l => l === ASKED)).toHaveLength(2);
  });

  it('is finished as a decline that went through: forgets, drops the copies, syncs, and reports no failure', async () => {
    for (const answer of [false, 'throws'] as const) {
      const { s, log } = steps(answer, { read: 'list', offered: false });
      await expect(declineNotebook(INVITE, NOTES, s)).resolves.toBeUndefined();
      expect(log).toEqual([
        'mark nb [nb-new,nb-old]', ASKED, ASKED, 'reload', 'offered? nb',
        'forget nb', 'drop [n1,n2]', 'sync',
      ]);
    }
  });

  it('keeps its mark, and does not read the inbox a second time', async () => {
    const { s, log } = steps(false, { read: 'list', offered: false });
    await declineNotebook(INVITE, NOTES, s);
    expect(log).not.toContain('unmark nb');
    expect(log.filter(l => l === 'reload')).toHaveLength(1);
  });
});

/**
 * Once the server has taken the decline it is DONE. A failure in what
 * follows must not read "That didn't go through", with Accept still on
 * offer, for a notebook that has just been declined.
 */
describe('after the server has taken it, nothing fails the decline', () => {
  const failingAt = (step: 'forgetAcceptance' | 'forgetNotes' | 'reloadInbox' | 'syncNotes') => {
    const { s, log } = steps();
    s[step] = (() => { log.push(`${step} threw`); throw new Error(step); }) as never;
    return { s, log };
  };

  it('a failure to forget the acceptance, to drop the copies, to reload or to sync is not a failed decline', async () => {
    for (const step of ['forgetAcceptance', 'forgetNotes', 'reloadInbox', 'syncNotes'] as const) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { s } = failingAt(step);
      await expect(declineNotebook(INVITE, NOTES, s)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    }
  });

  it('and the steps after the one that failed still run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { s, log } = failingAt('forgetAcceptance');
    await declineNotebook(INVITE, NOTES, s);
    expect(log.slice(-4)).toEqual(['forgetAcceptance threw', 'drop [n1,n2]', 'reload', 'sync']);
    warn.mockRestore();
  });

  it('a rejected promise from one of them is caught too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { s, log } = steps();
    s.reloadInbox = async () => { log.push('reload'); throw new Error('offline'); };
    await expect(declineNotebook(INVITE, NOTES, s)).resolves.toBeUndefined();
    expect(log[log.length - 1]).toBe('sync');
    warn.mockRestore();
  });
});

/**
 * The first request names the notes this page knew, and the server adds
 * every note whose row says it is in the notebook. A note neither covers (an
 * older page on the owner's side filed it into the notebook, without the
 * notebook on its row, in the moments before the press) would stay live; and
 * being OLDER than the decline it would never be kept away later. What the
 * inbox shows of the notebook once it is read again is declined too.
 */
describe('what the page had not loaded when the reader pressed Decline', () => {
  const LATE = [{ shareId: 'late-1', noteId: 'n9' }];

  it('is declined with it, in a second request that names only that, and taken off this device', async () => {
    const { s, log } = steps(true, { read: 'list', offered: false, late: LATE });
    await expect(declineNotebook(INVITE, NOTES, s)).resolves.toBeUndefined();
    expect(log).toEqual([
      'mark nb [nb-new,nb-old]', ASKED, 'forget nb', 'drop [n1,n2]', 'reload',
      'decline nb [late-1]', 'drop [n9]', 'sync',
    ]);
  });

  it('nothing more is asked when the inbox shows nothing new of the notebook', async () => {
    for (const late of [[], [{ shareId: 's1', noteId: 'n1' }, { shareId: 'nb-new', noteId: 'nb' }]]) {
      const { s, log } = steps(true, { read: 'list', offered: false, late });
      await declineNotebook(INVITE, NOTES, s);
      expect(log.filter(l => l.startsWith('decline '))).toEqual([ASKED]);
    }
  });

  it('only what was not named the first time is named the second', async () => {
    const { s, log } = steps(true, { read: 'list', offered: false, late: [{ shareId: 's2', noteId: 'n2' }, ...LATE] });
    await declineNotebook(INVITE, NOTES, s);
    expect(log.filter(l => l.startsWith('decline '))).toEqual([ASKED, 'decline nb [late-1]']);
    expect(log).toContain('drop [n9]');
  });

  it('a second request the server does not take fails nothing, and takes nothing off this device', async () => {
    for (const second of [false, 'throws'] as const) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { s, log } = steps([true, second], { read: 'list', offered: false, late: LATE });
      await expect(declineNotebook(INVITE, NOTES, s)).resolves.toBeUndefined();
      expect(log).not.toContain('drop [n9]');
      expect(log[log.length - 1]).toBe('sync');
      // Asked twice, and said when neither went through.
      expect(log.filter(l => l === 'decline nb [late-1]')).toHaveLength(2);
      expect(warn.mock.calls.some(c => String(c[0]).includes('1 note(s) of notebook nb that had not loaded yet could not be declined'))).toBe(true);
      warn.mockRestore();
    }
  });

  it('that request is asked a second time, and a yes the second time counts', async () => {
    for (const first of [false, 'throws'] as const) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { s, log } = steps([true, first, true], { read: 'list', offered: false, late: LATE });
      await expect(declineNotebook(INVITE, NOTES, s)).resolves.toBeUndefined();
      expect(log.filter(l => l === 'decline nb [late-1]')).toHaveLength(2);
      expect(log.slice(-2)).toEqual(['drop [n9]', 'sync']);
      expect(warn.mock.calls.some(c => String(c[0]).includes('could not be declined'))).toBe(false);
      warn.mockRestore();
    }
  });

  it('and not asked a second time when the first answer was yes', async () => {
    const { s, log } = steps(true, { read: 'list', offered: false, late: LATE });
    await declineNotebook(INVITE, NOTES, s);
    expect(log.filter(l => l === 'decline nb [late-1]')).toHaveLength(1);
  });

  it('after a decline whose answer was lost and which the list confirmed, too', async () => {
    const { s, log } = steps([false, false, true], { read: 'list', offered: false, late: LATE });
    await expect(declineNotebook(INVITE, NOTES, s)).resolves.toBeUndefined();
    expect(log.slice(-3)).toEqual(['decline nb [late-1]', 'drop [n9]', 'sync']);
  });

  it('never when the decline itself did not happen', async () => {
    const { s, log } = steps(false, { read: 'list', offered: true, late: LATE });
    await expect(declineNotebook(INVITE, NOTES, s)).rejects.toBeInstanceOf(DeclineNotDone);
    expect(log).not.toContain('decline nb [late-1]');
  });
});

/**
 * "Block" pressed on an invitation is the decline above, with the one request
 * being a block that declines. A block and nothing else would leave the
 * notebook undeclined, and after an unblock its new notes would arrive with no
 * invitation left to answer.
 */
describe('a block pressed on an invitation', () => {
  /**
   * A decline's steps (`steps` above) plus the block's own three.
   * @param alone  what a block by itself answers (asked only when the answer was lost)
   */
  function blockSteps(
    answer: Answer | Answer[] = true,
    inbox: Parameters<typeof steps>[1] = { read: 'list', offered: false },
    theirs: string[] = ['n1', 'x9'],
    alone: Answer = true,
  ) {
    const { s, log } = steps(answer, inbox);
    const answers = Array.isArray(answer) ? [...answer] : [answer];
    const b: BlockSteps = {
      ...s,
      block: async (email, declining) => {
        log.push(`block ${email} declining ${declining.notebookId} [${declining.shareIds.join(',')}]`);
        const now = answers.length > 1 ? answers.shift()! : answers[0];
        if (now === 'throws') throw new Error('network');
        return now;
      },
      blockOnly: async (email) => {
        log.push(`block ${email} alone`);
        if (alone === 'throws') throw new Error('network');
        return alone;
      },
      theirNotes: () => { log.push('their notes'); return theirs; },
    };
    return { b, log };
  }
  const WHO = 'sam@example.test';
  const BLOCKED = `block ${WHO} declining nb [s1,s2,nb-new,nb-old]`;

  it('is ONE request that blocks and declines, and then every step of a decline', async () => {
    const { b, log } = blockSteps();
    await blockFromInvitation(INVITE, NOTES, WHO, b);
    expect(log).toEqual([
      'their notes',
      'mark nb [nb-new,nb-old]',
      BLOCKED,
      'forget nb',
      'drop [n1,n2]',
      'reload',
      'sync',
      // And the rest of what that sender had shared leaves this device.
      'drop [n1,x9]',
    ]);
  });

  it('never sends a decline of its own beside the block', async () => {
    const { b, log } = blockSteps();
    await blockFromInvitation(INVITE, NOTES, WHO, b);
    expect(log.filter(l => l.startsWith('decline '))).toEqual([]);
    expect(log.filter(l => l.startsWith('block '))).toHaveLength(1);
  });

  it("lists the sender's notes BEFORE the block takes them off the inbox", async () => {
    const { b, log } = blockSteps();
    await blockFromInvitation(INVITE, NOTES, WHO, b);
    expect(log.indexOf('their notes')).toBeLessThan(log.indexOf(BLOCKED));
    expect(log.indexOf('drop [n1,x9]')).toBeGreaterThan(log.indexOf(BLOCKED));
  });

  it('when the server takes neither, nothing is blocked or forgotten, and the invitation stands', async () => {
    const { b, log } = blockSteps(false, { read: 'list', offered: true });
    await expect(blockFromInvitation(INVITE, NOTES, WHO, b)).rejects.toBeInstanceOf(DeclineNotDone);
    // Asked twice (a yes lost on its way back is a yes the second time), then the list is read.
    expect(log.filter(l => l === BLOCKED)).toHaveLength(2);
    expect(log).toContain('unmark nb');
    expect(log.some(l => l.startsWith('forget '))).toBe(false);
    expect(log.some(l => l.startsWith('drop '))).toBe(false);
  });

  it('a request that throws is one the server did not take', async () => {
    const { b, log } = blockSteps('throws', { read: 'list', offered: true });
    await expect(blockFromInvitation(INVITE, NOTES, WHO, b)).rejects.toBeInstanceOf(DeclineNotDone);
    expect(log.some(l => l.startsWith('drop '))).toBe(false);
  });

  /**
   * "No longer offered" proves the decline half only: the notebook can leave
   * the list for a reason of its own (its owner took the reader out, another
   * device declined it) while this request never arrived. The invitation would
   * go from the screen, and the reader would take the sender for blocked, who
   * is not.
   */
  describe('when neither request was answered and the list no longer offers the notebook', () => {
    it('the block is made once more, by itself, and its yes makes this done', async () => {
      const { b, log } = blockSteps(false, { read: 'list', offered: false });
      await blockFromInvitation(INVITE, NOTES, WHO, b);
      expect(log.filter(l => l === BLOCKED)).toHaveLength(2);
      expect(log.indexOf(`block ${WHO} alone`)).toBeGreaterThan(log.indexOf('offered? nb'));
      expect(log.filter(l => l === `block ${WHO} alone`)).toHaveLength(1);
      expect(log).toContain('forget nb');
      expect(log).toContain('drop [n1,x9]');
      expect(log).not.toContain('unmark nb');
    });

    it('a block the server does not take then is a block that did not happen: nothing is forgotten', async () => {
      for (const alone of [false, 'throws'] as const) {
        const { b, log } = blockSteps(false, { read: 'list', offered: false }, ['n1', 'x9'], alone);
        await expect(blockFromInvitation(INVITE, NOTES, WHO, b)).rejects.toBeInstanceOf(DeclineNotDone);
        expect(log).toContain(`block ${WHO} alone`);
        expect(log).toContain('unmark nb');
        expect(log.some(l => l.startsWith('forget '))).toBe(false);
        expect(log.some(l => l.startsWith('drop '))).toBe(false);
      }
    });

    it('a block that was answered yes is not made again', async () => {
      for (const answer of [true, [false, true]] as (Answer | Answer[])[]) {
        const { b, log } = blockSteps(answer);
        await blockFromInvitation(INVITE, NOTES, WHO, b);
        expect(log.some(l => l.endsWith(' alone'))).toBe(false);
      }
    });

    it('nor is one made while the notebook is still on offer, or the list could not be read', async () => {
      for (const inbox of [{ read: 'list', offered: true }, { read: 'no list', offered: false }, { read: 'throws', offered: false }] as const) {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { b, log } = blockSteps(false, inbox);
        await expect(blockFromInvitation(INVITE, NOTES, WHO, b)).rejects.toBeInstanceOf(DeclineNotDone);
        expect(log.some(l => l.endsWith(' alone'))).toBe(false);
        warn.mockRestore();
      }
    });
  });

  /** A decline does nothing but decline: gone from the list is done, and nothing more is asked. */
  it('a plain decline whose answer was lost asks nothing more', async () => {
    const { s, log } = steps(false, { read: 'list', offered: false });
    await declineNotebook(INVITE, NOTES, s);
    expect(log).toContain('forget nb');
    expect(log).not.toContain('unmark nb');
  });

  it("what the inbox shows of the notebook afterwards goes through the block's request too", async () => {
    const late = [{ shareId: 's7', noteId: 'n7' }];
    const { b, log } = blockSteps(true, { read: 'list', offered: false, late });
    await blockFromInvitation(INVITE, NOTES, WHO, b);
    expect(log).toContain(`block ${WHO} declining nb [s7]`);
    expect(log).toContain('drop [n7]');
    expect(log.filter(l => l.startsWith('decline '))).toEqual([]);
  });

  it("taking the sender's other notes off the device is tidying: a failure there does not undo the block", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { b } = blockSteps();
    let calls = 0;
    const flaky: BlockSteps = { ...b, forgetNotes: (ids) => { if (++calls === 2) throw new Error('idb'); b.forgetNotes(ids); } };
    await expect(blockFromInvitation(INVITE, NOTES, WHO, flaky)).resolves.toBeUndefined();
    expect(warn.mock.calls.some(c => String(c[0]).includes('after a block'))).toBe(true);
    warn.mockRestore();
  });
});

