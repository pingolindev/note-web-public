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
import { extrasFrom } from './metadataBlob';

const KNOWN = new Set(['notebooks', 'labelColors', 'notebookShares', 'editorModes']);

describe('extrasFrom', () => {
  it('keeps a field this build has never heard of', () => {
    // The case that matters: a newer client wrote something, and this one is
    // about to rewrite the blob for an unrelated reason.
    expect(extrasFrom({ notebooks: [], somethingNewer: { a: 1 } }, KNOWN))
      .toEqual({ somethingNewer: { a: 1 } });
  });

  it('does not echo back the fields the caller already models', () => {
    // They are re-derived from live state; echoing them would let a stale copy
    // win over the signal.
    expect(extrasFrom(
      { notebooks: [{ id: 'n', name: 'N' }], labelColors: {}, notebookShares: {}, editorModes: {} },
      KNOWN,
    )).toEqual({});
  });

  it('survives a blob that is missing, empty or the wrong shape', () => {
    expect(extrasFrom(undefined, KNOWN)).toEqual({});
    expect(extrasFrom(null, KNOWN)).toEqual({});
    expect(extrasFrom({}, KNOWN)).toEqual({});
    expect(extrasFrom('nope', KNOWN)).toEqual({});
    expect(extrasFrom([1, 2], KNOWN)).toEqual({});
  });

  it('preserves falsy values rather than dropping them', () => {
    // The case a naive `if (value)` guard drops. A newer client's `false`,
    // `0`, `null` or `""` is data, and losing it is the same data loss as
    // losing the key — just harder to notice. Membership test, not truthiness.
    expect(extrasFrom({ flagOff: false, count: 0, blank: '', absent: null }, KNOWN))
      .toEqual({ flagOff: false, count: 0, blank: '', absent: null });
  });

  it('round-trips: rebuild = unknown + known, and nothing is lost', () => {
    const fromServer = {
      notebooks: [{ id: 'n1', name: 'Work' }],
      labelColors: { home: '#fff' },
      editorModes: { 'note-1': 'markdown' },
      futureThing: [1, 2, 3],
    };
    const rebuilt: Record<string, unknown> = {
      ...extrasFrom(fromServer, KNOWN),
      notebooks: fromServer.notebooks,
      labelColors: fromServer.labelColors,
      notebookShares: {},
      editorModes: fromServer.editorModes,
    };
    expect(rebuilt.futureThing).toEqual([1, 2, 3]);
    expect(Object.keys(rebuilt).sort()).toEqual(
      ['editorModes', 'futureThing', 'labelColors', 'notebookShares', 'notebooks'],
    );
  });
});
