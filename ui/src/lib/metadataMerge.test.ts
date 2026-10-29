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
import { mergeKeyed, mergeMetadata } from './metadataMerge';

/**
 * The rules a 409 recovery on the metadata blob relies on. Each case is a
 * real way the blob diverges between two devices; the wrong answer in each is
 * a notebook, share recipient or pin silently lost.
 */

const m = (o: Record<string, unknown>) => new Map(Object.entries(o));
const o = (map: Map<string, unknown>) => Object.fromEntries(map);

describe('mergeKeyed', () => {
  it('keeps a local addition the server does not have', () => {
    expect(o(mergeKeyed(m({ a: 1 }), m({ a: 1, b: 2 }), m({ a: 1 })))).toEqual({ a: 1, b: 2 });
  });

  it('lets the server win when both added the same key with different values', () => {
    expect(o(mergeKeyed(m({}), m({ b: 'mine' }), m({ b: 'theirs' })))).toEqual({ b: 'theirs' });
  });

  it('honours a local removal of an entry the server still holds unchanged', () => {
    // We removed a recipient; the server's copy is exactly what we removed from.
    expect(o(mergeKeyed(m({ a: 1, b: 2 }), m({ a: 1 }), m({ a: 1, b: 2 })))).toEqual({ a: 1 });
  });

  it('keeps an entry we removed if the server changed it since', () => {
    // Their edit is newer than the state we removed from: server wins.
    expect(o(mergeKeyed(m({ a: 1, b: 2 }), m({ a: 1 }), m({ a: 1, b: 3 })))).toEqual({ a: 1, b: 3 });
  });

  it('drops an entry the server deleted that we did not touch', () => {
    expect(o(mergeKeyed(m({ a: 1, b: 2 }), m({ a: 1, b: 2 }), m({ a: 1 })))).toEqual({ a: 1 });
  });

  it('keeps a local change when the server did not change that entry', () => {
    expect(o(mergeKeyed(m({ a: 1 }), m({ a: 9 }), m({ a: 1 })))).toEqual({ a: 9 });
  });

  it('lets the server win when both changed the same entry', () => {
    expect(o(mergeKeyed(m({ a: 1 }), m({ a: 9 }), m({ a: 5 })))).toEqual({ a: 5 });
  });

  it('with no base, treats every local entry as an addition and the server as authority on clashes', () => {
    expect(o(mergeKeyed(null, m({ a: 'mine', b: 2 }), m({ a: 'theirs', c: 3 })))).toEqual({ a: 'theirs', c: 3, b: 2 });
  });

  it('keeps the server order and appends local additions', () => {
    const out = mergeKeyed(null, m({ z: 1, a: 1 }), m({ b: 1, c: 1 }));
    expect([...out.keys()]).toEqual(['b', 'c', 'z', 'a']);
  });
});

describe('mergeMetadata', () => {
  const base = {
    notebooks: [{ id: 'nb1', name: 'Work' }],
    labelColors: { urgent: '#f00' },
    notebookShares: { nb1: [{ email: 'A@x.test', permission: 'edit' }] },
    editorModes: { n1: 'markdown' },
    acceptedNotebooks: ['nbX'],
    someFutureField: { v: 1 },
  };

  it('merges a local notebook creation with a concurrent server rename', () => {
    const local = { ...base, notebooks: [{ id: 'nb1', name: 'Work' }, { id: 'nb2', name: 'Home' }] };
    const server = { ...base, notebooks: [{ id: 'nb1', name: 'Office' }] };
    const out = mergeMetadata(base, local, server);
    expect(out.notebooks).toEqual([{ id: 'nb1', name: 'Office' }, { id: 'nb2', name: 'Home' }]);
  });

  it('honours a local recipient removal and keeps a recipient the server added', () => {
    const local = { ...base, notebookShares: {} };
    const server = { ...base, notebookShares: { nb1: [
      { email: 'A@x.test', permission: 'edit' },
      { email: 'b@x.test', permission: 'view' },
    ] } };
    const out = mergeMetadata(base, local, server);
    expect(out.notebookShares).toEqual({ nb1: [{ email: 'b@x.test', permission: 'view' }] });
  });

  it('matches recipients case-insensitively by email', () => {
    const local = { ...base, notebookShares: { nb1: [{ email: 'a@x.test', permission: 'edit' }] } };
    const server = { ...base };
    const out = mergeMetadata(base, local, server);
    // Same person; the server's spelling wins on a clash, no duplicate.
    expect(out.notebookShares?.nb1).toHaveLength(1);
  });

  it('keeps a pin set locally and a pin set on the server', () => {
    const local = { ...base, editorModes: { n1: 'markdown', n2: 'rich' } };
    const server = { ...base, editorModes: { n1: 'markdown', n3: 'rich' } };
    expect(mergeMetadata(base, local, server).editorModes).toEqual({ n1: 'markdown', n3: 'rich', n2: 'rich' });
  });

  it('unions accepted notebooks and honours a local decline', () => {
    const local = { ...base, acceptedNotebooks: ['nbY'] }; // dropped nbX, added nbY
    const server = { ...base, acceptedNotebooks: ['nbX', 'nbZ'] };
    expect(mergeMetadata(base, local, server).acceptedNotebooks).toEqual(['nbZ', 'nbY']);
  });

  it('carries fields it does not model, server winning on a clash', () => {
    const local = { ...base, someFutureField: { v: 2 }, mine: true };
    const server = { ...base, someFutureField: { v: 3 }, theirs: 1 };
    const out = mergeMetadata(base, local, server);
    expect(out.someFutureField).toEqual({ v: 3 });
    expect(out.mine).toBe(true);
    expect(out.theirs).toBe(1);
  });

  it('with no base, keeps every local addition and every server entry', () => {
    const local = { notebooks: [{ id: 'nb2', name: 'Home' }], labelColors: { a: '#000' } };
    const server = { notebooks: [{ id: 'nb1', name: 'Work' }], labelColors: { a: '#fff', b: '#111' } };
    const out = mergeMetadata(null, local, server);
    expect(out.notebooks).toEqual([{ id: 'nb1', name: 'Work' }, { id: 'nb2', name: 'Home' }]);
    expect(out.labelColors).toEqual({ a: '#fff', b: '#111' });
  });

  it('always yields every known collection, so a partial server blob cannot erase ours', () => {
    const out = mergeMetadata(null, { notebooks: [{ id: 'x', name: 'X' }] }, {});
    expect(out.notebooks).toEqual([{ id: 'x', name: 'X' }]);
    expect(out.labelColors).toEqual({});
    expect(out.notebookShares).toEqual({});
    expect(out.editorModes).toEqual({});
    expect(out.acceptedNotebooks).toEqual([]);
  });
});
