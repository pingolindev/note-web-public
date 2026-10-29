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

import { describe, it, expect } from 'vitest';
import { declinedOnTheServersWord, readInboxAnswer, sharesOfDeclinedNotebooks } from './inboxPage';

describe('reading one answer of the inbox', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ share_id: `s${i}` }));

  describe('a page, from a server that says whether more follows', () => {
    it('is its shares, and more follows exactly when the server says so', () => {
      expect(readInboxAnswer({ shares: rows(2), has_more: true }, 500)).toEqual({ rows: rows(2), more: true, declined: null, offered: null });
      expect(readInboxAnswer({ shares: rows(2), has_more: false }, 500)).toEqual({ rows: rows(2), more: false, declined: null, offered: null });
    });

    /**
     * An invitation is the notebook's own row, the oldest of the invitation:
     * with a page's worth of notes it lies on a later page, and an inbox shown
     * as far as it was read would not know the notebook was on offer. The
     * first page says so itself.
     */
    describe('the notebooks on offer', () => {
      const A = '6b6b6b6b-0000-4000-8000-00000000000a';
      const B = '6b6b6b6b-0000-4000-8000-00000000000b';
      const page = (offered_notebooks: unknown) => readInboxAnswer({ shares: [], has_more: true, offered_notebooks }, 500);

      it('are the ids the server names', () => {
        expect(page([A, B])?.offered).toEqual([A, B]);
      });
      it('in one spelling, however the server writes them', () => {
        expect(page([A.toUpperCase()])?.offered).toEqual([A]);
      });
      it('none on offer is an EMPTY list, which says so', () => {
        expect(page([])?.offered).toEqual([]);
      });
      it('"not told" when the answer does not say: null, never "none"', () => {
        expect(readInboxAnswer({ shares: [], has_more: false }, 500)?.offered).toBeNull();
        expect(page(null)?.offered).toBeNull();
        expect(page(undefined)?.offered).toBeNull();
      });
      it('and when what it says is no list', () => {
        for (const said of ['all', 7, {}, { ids: [A] }, true]) expect(page(said)?.offered, JSON.stringify(said)).toBeNull();
      });
      /** A list with a hole looks whole and is not: everything missing from it would read as "not on offer". */
      it('the WHOLE list or nothing: one entry that is no id, and the list says nothing', () => {
        for (const bad of [null, 7, '', {}, [A], undefined]) expect(page([A, bad, B])?.offered, JSON.stringify(bad)).toBeNull();
      });
      it('says nothing of the shares or of what follows', () => {
        expect(readInboxAnswer({ shares: rows(2), has_more: true, offered_notebooks: 'x' }, 500))
          .toEqual({ rows: rows(2), more: true, declined: null, offered: null });
      });
      it('the bare list of an older server never says', () => {
        expect(readInboxAnswer(rows(2), 3)?.offered).toBeNull();
      });
    });

    /** The answer's `has_more` decides, not the page's length against a page size. */
    it('does not look at how long the page is', () => {
      expect(readInboxAnswer({ shares: rows(3), has_more: false }, 3)?.more).toBe(false);
      expect(readInboxAnswer({ shares: rows(9), has_more: false }, 3)?.more).toBe(false);
      expect(readInboxAnswer({ shares: rows(1), has_more: true }, 3)?.more).toBe(true);
      expect(readInboxAnswer({ shares: [], has_more: true }, 3)?.more).toBe(true);
    });

    const D = (id: string, declined_at = '2026-10-07T10:00:00Z') => ({ id, declined_at });

    it('carries the declined notebooks and since when, when the server names them, and null when it does not', () => {
      expect(readInboxAnswer({ shares: [], has_more: false, declined_notebooks: [D('a'), D('b', '2026-10-06T09:00:00.5Z')] }, 500)?.declined)
        .toEqual([{ id: 'a', at: '2026-10-07T10:00:00Z' }, { id: 'b', at: '2026-10-06T09:00:00.5Z' }]);
      expect(readInboxAnswer({ shares: [], has_more: false, declined_notebooks: [] }, 500)?.declined).toEqual([]);
      expect(readInboxAnswer({ shares: [], has_more: false }, 500)?.declined).toBeNull();
      expect(readInboxAnswer({ shares: [], has_more: false, declined_notebooks: null }, 500)?.declined).toBeNull();
      expect(readInboxAnswer({ shares: [], has_more: false, declined_notebooks: 'a' }, 500)?.declined).toBeNull();
    });

    /** An entry is an id WITH a time that parses: the time is half of the rule that uses it. */
    it('keeps only whole entries out of a declined list', () => {
      const list = [
        D('a'), 'b', 7, null, { id: 'c' }, { declined_at: '2026-10-07T10:00:00Z' }, D(''), D('d', 'yesterday'),
        { id: 5, declined_at: '2026-10-07T10:00:00Z' }, D('e', '2026-10-07T11:00:00Z'),
      ];
      expect(readInboxAnswer({ shares: [], has_more: false, declined_notebooks: list }, 500)?.declined?.map(d => d.id))
        .toEqual(['a', 'e']);
    });
  });

  describe('the bare list, from a server that predates has_more', () => {
    it('is the rows, and more follows when the page is as long as a page can be', () => {
      expect(readInboxAnswer(rows(2), 3)).toEqual({ rows: rows(2), more: false, declined: null, offered: null });
      expect(readInboxAnswer(rows(3), 3)?.more).toBe(true);
      expect(readInboxAnswer(rows(4), 3)?.more).toBe(true);
      expect(readInboxAnswer([], 3)).toEqual({ rows: [], more: false, declined: null, offered: null });
    });
  });

  /** Null, never an empty inbox: an empty inbox read to its end evicts every received note. */
  describe('anything else', () => {
    it('is not an answer', () => {
      for (const data of [null, undefined, 'shares', 0, 7, true, {}, { shares: [] }, { has_more: false }, { shares: {}, has_more: false },
        { shares: [], has_more: 'false' }, { shares: [], has_more: 0 }, { shares: [], has_more: null }, { rows: [], has_more: false }]) {
        expect(readInboxAnswer(data, 500), JSON.stringify(data)).toBeNull();
      }
    });
  });
});

describe('the notebooks declined on the server\'s word', () => {
  const none = new Map<string, string>();
  const noneListed = new Set<string>();
  const T1 = '2026-10-07T10:00:00Z';
  const T2 = '2026-10-07T11:00:00Z';
  const D = (id: string, at = T1) => ({ id, at });

  it('are the ones the answer names, each with its time', () => {
    expect([...declinedOnTheServersWord([D('a'), D('b', T2)], noneListed, none)]).toEqual([['a', T1], ['b', T2]]);
    expect([...declinedOnTheServersWord([], noneListed, new Map([['old', T1]]))]).toEqual([]);
  });

  /** The row is the newer fact: the owner removed the reader and invited them again. */
  it('never one the same answer lists a share of', () => {
    expect([...declinedOnTheServersWord([D('a'), D('b')], new Set(['a']), none).keys()]).toEqual(['b']);
  });

  it('stay as they were when the answer does not say', () => {
    const before = new Map([['a', T1], ['b', T2]]);
    expect([...declinedOnTheServersWord(null, noneListed, before)]).toEqual([['a', T1], ['b', T2]]);
  });

  it('and even then lose a notebook this answer offers', () => {
    expect([...declinedOnTheServersWord(null, new Set(['a']), new Map([['a', T1], ['b', T2]])).keys()]).toEqual(['b']);
  });

  /** Ids are compared in one form everywhere; one that is no id names nothing. */
  it('are kept in the form ids are compared in, and one that is no id is dropped', () => {
    const canonical = (id: string) => (id === 'not-an-id' ? null : id.toLowerCase());
    expect([...declinedOnTheServersWord([D('ABC'), D('not-an-id')], noneListed, none, canonical).keys()]).toEqual(['abc']);
    // And a notebook on offer is recognised under either spelling.
    expect([...declinedOnTheServersWord([D('ABC')], new Set(['abc']), none, canonical).keys()]).toEqual([]);
  });

  /** Unchanged, it is the SAME map: nothing that reads it has to recompute on every refresh. */
  it('are the very same map when nothing changed', () => {
    const before = new Map([['a', T1], ['b', T2]]);
    expect(declinedOnTheServersWord([D('b', T2), D('a', T1)], noneListed, before)).toBe(before);
    expect(declinedOnTheServersWord(null, noneListed, before)).toBe(before);
    expect(declinedOnTheServersWord([D('a', T2), D('b', T2)], noneListed, before)).not.toBe(before);
    expect(declinedOnTheServersWord([D('a')], noneListed, before)).not.toBe(before);
  });
});

/**
 * After a decline, nothing of that share shows up. The same rule the server
 * applies when it writes a share, for the share it could not tell was the
 * notebook's.
 */
describe('the shares that belong to a declined notebook', () => {
  const NOTEBOOK = 2;
  const DECLINED_AT = '2026-10-07T10:00:00.000Z';
  const AFTER = '2026-10-07T10:00:05.000Z';
  const BEFORE = '2026-10-07T09:59:55.000Z';
  const declined = new Map([['nb-declined', DECLINED_AT]]);
  const noteIn = (id: string, notebook: string | null | undefined, sharedAt = AFTER) =>
    ({ id, itemType: 1, sharedAt, note: { ownerNotebookId: notebook } });

  it('are the notes whose own content names it, shared after it was declined', () => {
    const shares = [noteIn('a', 'nb-declined'), noteIn('b', 'nb-other'), noteIn('c', 'nb-declined')];
    expect(sharesOfDeclinedNotebooks(shares, declined, NOTEBOOK).map(s => s.id)).toEqual(['a', 'c']);
  });

  /**
   * One the reader already held when they declined was shared with them by
   * itself: the decline dismissed every share of the notebook's it knew of.
   * Its owner filing it into that notebook later takes nothing away.
   */
  it('never a share older than the decline, nor one made at that very instant', () => {
    const shares = [noteIn('held-before', 'nb-declined', BEFORE), noteIn('at-the-instant', 'nb-declined', DECLINED_AT)];
    expect(sharesOfDeclinedNotebooks(shares, declined, NOTEBOOK)).toEqual([]);
  });

  /** Both times are the server's, with fractions of a second the page's own clock never sees. */
  it('compares the server\'s two times as times, whatever their spelling', () => {
    const since = new Map([['nb-declined', '2026-10-07T10:00:00.250000Z']]);
    expect(sharesOfDeclinedNotebooks([noteIn('later', 'nb-declined', '2026-10-07T10:00:00.251Z')], since, NOTEBOOK).map(s => s.id)).toEqual(['later']);
    expect(sharesOfDeclinedNotebooks([noteIn('earlier', 'nb-declined', '2026-10-07T10:00:00.249999Z')], since, NOTEBOOK)).toEqual([]);
    expect(sharesOfDeclinedNotebooks([noteIn('other-zone', 'nb-declined', '2026-10-07T12:00:01+02:00')], since, NOTEBOOK).map(s => s.id)).toEqual(['other-zone']);
    // An offset is part of the time: 11:59:59 at +02:00 is 09:59:59 in UTC, BEFORE the decline,
    // though its digits read later; and 08:00:01 at -02:00 is after it, though they read earlier.
    expect(sharesOfDeclinedNotebooks([noteIn('reads-later', 'nb-declined', '2026-10-07T11:59:59+02:00')], since, NOTEBOOK)).toEqual([]);
    expect(sharesOfDeclinedNotebooks([noteIn('reads-earlier', 'nb-declined', '2026-10-07T08:00:01-02:00')], since, NOTEBOOK).map(s => s.id)).toEqual(['reads-earlier']);
  });

  /**
   * `Date.parse` keeps milliseconds, and the server compares to the
   * microsecond: a share made in the same millisecond as the decline, a
   * few microseconds later, is kept away by the server's rule and the
   * Android app's, and must be by this page too.
   */
  it('to the microsecond, as the server does', () => {
    const since = new Map([['nb-declined', '2026-10-07T09:58:18.873138Z']]);
    const at = (t: string) => sharesOfDeclinedNotebooks([noteIn('x', 'nb-declined', t)], since, NOTEBOOK).length === 1;
    expect(at('2026-10-07T09:58:18.873139Z')).toBe(true);     // one microsecond later
    expect(at('2026-10-07T09:58:18.873138Z')).toBe(false);    // the same instant
    expect(at('2026-10-07T09:58:18.873137Z')).toBe(false);    // one microsecond earlier
    expect(at('2026-10-07T09:58:18.8731381Z')).toBe(true);    // a digit the other does not carry
    expect(at('2026-10-07T09:58:18.874Z')).toBe(true);        // fewer digits, later
    expect(at('2026-10-07T09:58:18.873Z')).toBe(false);       // fewer digits, earlier
    expect(at('2026-10-07T09:58:19Z')).toBe(true);            // no fraction at all
    expect(at('2026-10-07T09:58:18Z')).toBe(false);
  });

  it('a time that is no time decides nothing', () => {
    const since = new Map([['nb-declined', '2026-10-07T09:58:18.873138Z']]);
    for (const t of ['', 'soon', '2026-10-07', '2026-10-07 09:58:19Z', '2026-10-07T09:58:19', '2026-10-07T09:58:19.Z', '2026-10-07T09:58:19.1234567890Z']) {
      expect(sharesOfDeclinedNotebooks([noteIn('x', 'nb-declined', t)], since, NOTEBOOK), t).toEqual([]);
    }
    // Nor a decline whose time is none: nothing is "later than" it.
    const noTime = new Map([['nb-declined', 'last tuesday']]);
    expect(sharesOfDeclinedNotebooks([noteIn('x', 'nb-declined', '2026-10-08T00:00:00Z')], noTime, NOTEBOOK)).toEqual([]);
  });

  it('never a note shared on its own, or one that names no notebook', () => {
    const shares = [noteIn('a', null), noteIn('b', undefined), noteIn('c', ''), { id: 'd', itemType: 1, sharedAt: AFTER, note: {} }];
    expect(sharesOfDeclinedNotebooks(shares, declined, NOTEBOOK)).toEqual([]);
  });

  /** A row this page could not open says nothing about where it belongs. */
  it('never a share that did not open', () => {
    expect(sharesOfDeclinedNotebooks([{ id: 'a', itemType: 1, sharedAt: AFTER, note: null }], declined, NOTEBOOK)).toEqual([]);
  });

  /** The invitation itself is not a note of the notebook: its row is the question, and has its own answer. */
  it('never a notebook\'s own share, even one whose content names a declined notebook', () => {
    const shares = [{ id: 'nb', itemType: NOTEBOOK, sharedAt: AFTER, note: { ownerNotebookId: 'nb-declined' } }];
    expect(sharesOfDeclinedNotebooks(shares, declined, NOTEBOOK)).toEqual([]);
  });

  it('a share with no type is a note, as everywhere else', () => {
    expect(sharesOfDeclinedNotebooks([{ id: 'a', sharedAt: AFTER, note: { ownerNotebookId: 'nb-declined' } }], declined, NOTEBOOK).map(s => s.id))
      .toEqual(['a']);
  });

  it('finds the notebook under any spelling of its id', () => {
    const canonical = (id: string) => id.toLowerCase();
    expect(sharesOfDeclinedNotebooks([noteIn('a', 'NB-DECLINED')], declined, NOTEBOOK, canonical).map(s => s.id)).toEqual(['a']);
    expect(sharesOfDeclinedNotebooks([noteIn('a', 'NB-DECLINED')], declined, NOTEBOOK)).toEqual([]);
    expect(sharesOfDeclinedNotebooks([noteIn('a', 'x')], declined, NOTEBOOK, () => null)).toEqual([]);
  });

  it('nothing at all when nothing is declined', () => {
    expect(sharesOfDeclinedNotebooks([noteIn('a', 'nb-declined')], new Map(), NOTEBOOK)).toEqual([]);
  });
});
