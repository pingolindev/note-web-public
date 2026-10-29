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
import {
  carriedLists, carriedRecords, fieldsToRestore, notebooksToAdd, recordRepair, recordState, withCarriedList, withCarriedRecord, withoutCarriedLists, withoutCarriedRecords, type EarlierRecord, type RecordFacts, keptKeys, withKeptKey, withoutKeptKeys,
} from './notebookRepair';

/**
 * The rules for notebooks after a password reset: every object a user
 * encounters should be usable no matter what.
 */

const A = { ciphertext: 'ct-a', nonce: 'n-a' };
const B = { ciphertext: 'ct-b', nonce: 'n-b' };

describe('lists carried from before a reset', () => {
  it('read whatever is there as far as it reads, each once', () => {
    expect(carriedLists(undefined)).toEqual([]);
    expect(carriedLists('nonsense')).toEqual([]);
    expect(carriedLists({ ciphertext: 'x', nonce: 'y' })).toEqual([]);
    expect(carriedLists([A, null, 7, { ciphertext: '' , nonce: 'n' }, { ciphertext: 'c' }, A, { ...B, extra: 1 }])).toEqual([A, B]);
  });

  it('one is carried once, after those already carried', () => {
    expect(withCarriedList(undefined, A)).toEqual([A]);
    expect(withCarriedList([A], B)).toEqual([A, B]);
    expect(withCarriedList([A, B], A)).toEqual([A, B]);
    // The same ciphertext under another nonce is another list.
    expect(withCarriedList([A], { ...A, nonce: 'other' })).toEqual([A, { ...A, nonce: 'other' }]);
  });

  it('what was merged back is no longer carried, and nothing else goes', () => {
    expect(withoutCarriedLists([A, B], [A])).toEqual([B]);
    expect(withoutCarriedLists([A, B], [])).toEqual([A, B]);
    expect(withoutCarriedLists([A], [{ ...A, nonce: 'other' }])).toEqual([A]);
  });
});

describe('records carried from before a rebuild', () => {
  const wrapped: EarlierRecord = { wrappedKey: 'wk', wrappedKeyNonce: 'wn', ciphertext: 'c1', nonce: 'n1' };
  const keyless: EarlierRecord = { wrappedKey: null, wrappedKeyNonce: null, ciphertext: 'c2', nonce: 'n2' };

  it('read as far as they read: half a wrap opens nothing, and is dropped', () => {
    expect(carriedRecords(undefined)).toEqual({});
    expect(carriedRecords([wrapped])).toEqual({});
    expect(carriedRecords({ nb: [wrapped, keyless, { ...wrapped, wrappedKeyNonce: null }, { wrappedKey: 'x', ciphertext: 'c', nonce: 'n' }, wrapped] }))
      .toEqual({ nb: [wrapped, keyless] });
    expect(carriedRecords({ nb: [] , other: 'x' })).toEqual({});
  });

  it('a notebook rebuilt twice keeps both of its earlier records, oldest first, each once', () => {
    const once = withCarriedRecord(undefined, 'nb', wrapped);
    expect(once).toEqual({ nb: [wrapped] });
    const twice = withCarriedRecord(once, 'nb', keyless);
    expect(twice).toEqual({ nb: [wrapped, keyless] });
    expect(withCarriedRecord(twice, 'nb', wrapped)).toEqual(twice);
    expect(withCarriedRecord(twice, 'other', wrapped)).toEqual({ nb: [wrapped, keyless], other: [wrapped] });
  });

  it('what was merged back is no longer carried; a notebook with none left goes', () => {
    const both = { nb: [wrapped, keyless], other: [wrapped] };
    expect(withoutCarriedRecords(both, 'nb', [wrapped])).toEqual({ nb: [keyless], other: [wrapped] });
    expect(withoutCarriedRecords(both, 'nb', [wrapped, keyless])).toEqual({ other: [wrapped] });
    expect(withoutCarriedRecords(both, 'missing', [wrapped])).toEqual(both);
  });
});

describe('what is known of a record', () => {
  const facts = (over: Partial<RecordFacts> = {}): RecordFacts => ({
    cryptoReady: true, liveItem: true, ours: true, wrapped: true, opensWith: 'current', ...over,
  });

  it('one that opens, with this identity\'s key or a recovered one', () => {
    expect(recordState(facts())).toBe('opens');
    expect(recordState(facts({ opensWith: 'recovered' }))).toBe('opens');
  });

  it('one with no key at all, and one whose key nothing here opens', () => {
    expect(recordState(facts({ wrapped: false, opensWith: null }))).toBe('keyless');
    expect(recordState(facts({ opensWith: null }))).toBe('locked');
  });

  it('nothing is said of one not known enough: no keys, no live item, not ours, or not known whose', () => {
    expect(recordState(facts({ cryptoReady: false, opensWith: null }))).toBe('unknown');
    expect(recordState(facts({ liveItem: false, opensWith: null }))).toBe('unknown');
    expect(recordState(facts({ ours: false, opensWith: null }))).toBe('unknown');
    expect(recordState(facts({ ours: null, opensWith: null }))).toBe('unknown');
    expect(recordState(facts({ ours: false, wrapped: false, opensWith: null }))).toBe('unknown');
  });
});

describe('what is done about a record', () => {
  it('nothing for one that opens: one that opens only with a recovered key is not re-keyed', () => {
    expect(recordRepair('opens', true)).toBe('none');
    expect(recordRepair('opens', false)).toBe('none');
  });

  it('a locked record is rebuilt, and a keyless one given a key, only once it is known no recovered key opens it', () => {
    expect(recordRepair('locked', true)).toBe('rebuild');
    expect(recordRepair('keyless', true)).toBe('give-key');
    expect(recordRepair('locked', false)).toBe('wait');
    expect(recordRepair('keyless', false)).toBe('wait');
  });

  it('one not known enough is waited on', () => {
    expect(recordRepair('unknown', true)).toBe('wait');
    expect(recordRepair('unknown', false)).toBe('wait');
  });
});

describe('what an earlier record puts back', () => {
  it('every field the record now lacks, and nothing it has', () => {
    expect(fieldsToRestore(
      { title: 'Now', members: [], color: null },
      { title: 'Then', members: [{ userId: 'x' }], color: '#f00', edit_mode: 'rich', labels: ['a'] },
    )).toEqual({ title: 'Now', members: [], color: null, edit_mode: 'rich', labels: ['a'] });
  });

  it('never the name, nor the people: the record now has the newer word on both', () => {
    expect(fieldsToRestore({}, { title: 'Then', members: [{ userId: 'x' }] })).toBeNull();
    expect(fieldsToRestore({ color: null }, { color: '#f00' })).toBeNull();
  });

  it('nothing to put back is null', () => {
    expect(fieldsToRestore({ title: 'A' }, {})).toBeNull();
    expect(fieldsToRestore({ title: 'A' }, { gone: undefined })).toBeNull();
  });

  /** A rebuilt record holds a NEW record's values for what it could not know: those are not a choice. */
  it('a field the record holds only as a rebuild wrote it is put back too; one set since stays', () => {
    const defaults = { color: null, is_pinned: false, labels: [], sort_order: 0, body: '' };
    const rebuilt = { title: 'Now', members: [], color: null, is_pinned: false, labels: [], sort_order: 0, body: '' };
    expect(fieldsToRestore(rebuilt, { title: 'Then', color: '#f00', is_pinned: true, labels: ['x'], sort_order: 0, edit_mode: 'rich' }, defaults))
      .toEqual({ title: 'Now', members: [], color: '#f00', is_pinned: true, labels: ['x'], sort_order: 0, body: '', edit_mode: 'rich' });
    // Set since the rebuild: not the default any more.
    expect(fieldsToRestore({ ...rebuilt, color: '#00f' }, { color: '#f00' }, defaults)).toBeNull();
    // Without the defaults, only what is absent.
    expect(fieldsToRestore(rebuilt, { color: '#f00' })).toBeNull();
    // The earlier record holding the default too adds nothing.
    expect(fieldsToRestore(rebuilt, { color: null, sort_order: 0 }, defaults)).toBeNull();
  });
});

describe('notebooks to put on the list', () => {
  const NB = 'aaaaaaaa-1111-4111-8111-11111111111a';
  it('those found that it lacks, in the order found, each once; ids whatever their case', () => {
    expect(notebooksToAdd(
      [{ id: NB }],
      [{ id: NB.toUpperCase(), name: 'Same' }, { id: 'b', name: 'B' }, { id: 'B', name: 'B again' }, { id: 'c', name: 'C' }],
    )).toEqual([{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  });

  it('never one with no name', () => {
    expect(notebooksToAdd([], [{ id: 'x', name: '' }])).toEqual([]);
  });
});

describe('old keys kept for rescued notes (lib/noteRescue)', () => {
  const A = { wrappedKey: 'wk-a', wrappedKeyNonce: 'wn-a' };
  const B = { wrappedKey: 'wk-b', wrappedKeyNonce: 'wn-b' };

  it('are read leniently: anything malformed is dropped, a note with none is absent', () => {
    expect(keptKeys(undefined)).toEqual({});
    expect(keptKeys([A])).toEqual({});
    expect(keptKeys({ n1: [A, { wrappedKey: 'x' }, 'y', A], n2: [], n3: 'z', '': [A] })).toEqual({ n1: [A] });
  });

  it('are added once, after any already kept', () => {
    const one = withKeptKey(undefined, 'n1', A);
    expect(one).toEqual({ n1: [A] });
    expect(withKeptKey(one, 'n1', A)).toEqual({ n1: [A] });
    expect(withKeptKey(one, 'n1', B)).toEqual({ n1: [A, B] });
    expect(withKeptKey(one, 'n2', B)).toEqual({ n1: [A], n2: [B] });
  });

  it('go only when named; a note with none left goes', () => {
    const both = { n1: [A, B], n2: [B] };
    expect(withoutKeptKeys(both, 'n1', [A])).toEqual({ n1: [B], n2: [B] });
    expect(withoutKeptKeys(both, 'n2', [B])).toEqual({ n1: [A, B] });
    expect(withoutKeptKeys(both, 'n3', [A])).toEqual(both);
  });
});

