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
import { moveOfPeople, sameNotebook, serverNotebook, settled, withChange } from './notebookMove';

/** A card, as far as these rules read one (and a title, to see that nothing else is touched). */
type Card = { notebookId?: string | null; movedFrom?: string | null; movedFromPeople?: string[]; title?: string };
const card = (c: Card): Card => c;

// With letters in them: an id of digits alone reads the same in either case,
// so it could not tell a comparison that minds the case from one that does not.
const NB = 'aaaaaaaa-1111-4111-8111-11111111111a';
const NB2 = 'bbbbbbbb-2222-4222-8222-22222222222b';

describe('where the server has a note', () => {
  it('is where the card says, when nothing is owed', () => {
    expect(serverNotebook({ notebookId: NB })).toBe(NB);
    expect(serverNotebook({ notebookId: null })).toBeNull();
    expect(serverNotebook({})).toBeNull();
  });

  it('is where the card says it was moved from, while a move is owed', () => {
    expect(serverNotebook({ notebookId: null, movedFrom: NB })).toBe(NB);
    // `null` is a place too: in no notebook.
    expect(serverNotebook({ notebookId: NB, movedFrom: null })).toBeNull();
  });
});

describe('one notebook or another', () => {
  it('no notebook is the same as no notebook, however it is written', () => {
    expect(sameNotebook(null, undefined)).toBe(true);
    expect(sameNotebook(undefined, undefined)).toBe(true);
    expect(sameNotebook(null, NB)).toBe(false);
    expect(sameNotebook(NB, null)).toBe(false);
  });

  it('an id is the same id whatever its case', () => {
    expect(NB.toUpperCase()).not.toBe(NB);
    expect(sameNotebook(NB, NB.toUpperCase())).toBe(true);
    expect(sameNotebook(NB, NB2)).toBe(false);
  });
});

describe('a change put on a card', () => {
  it('a move away from where the server has the note is remembered', () => {
    expect(withChange(card({ notebookId: NB, title: 'a' }), { notebookId: null })).toEqual({ notebookId: null, title: 'a', movedFrom: NB });
    expect(withChange(card({ notebookId: null }), { notebookId: NB })).toEqual({ notebookId: NB, movedFrom: null });
    expect(withChange(card({}), { notebookId: NB })).toEqual({ notebookId: NB, movedFrom: null });
  });

  it('a second move keeps the place the SERVER has the note in, not the place in between', () => {
    const once = withChange(card({ notebookId: NB }), { notebookId: null });
    expect(withChange(once, { notebookId: NB2 })).toEqual({ notebookId: NB2, movedFrom: NB });
  });

  it('a move back to where the server has it leaves nothing owed', () => {
    const away = withChange(card({ notebookId: NB }), { notebookId: null });
    expect(withChange(away, { notebookId: NB })).toEqual({ notebookId: NB });
    expect('movedFrom' in withChange(away, { notebookId: NB.toUpperCase() })).toBe(false);
  });

  it('a change that moves nothing leaves what is owed as it is', () => {
    const away = withChange(card({ notebookId: NB, title: 'a' }), { notebookId: null });
    expect(withChange(away, { title: 'b' })).toEqual({ notebookId: null, title: 'b', movedFrom: NB });
    expect(withChange(card({ notebookId: NB, title: 'a' }), { title: 'b' })).toEqual({ notebookId: NB, title: 'b' });
  });

  it('what a change says was owed is never taken: the card knows, a queued copy of it may be out of date', () => {
    // The queue keeps whole cards. One queued while a move from NB was owed, replayed onto a card that owes nothing:
    expect(withChange(card({ notebookId: null }), { notebookId: null, movedFrom: NB })).toEqual({ notebookId: null });
    // ...and one that says nothing was owed, replayed onto a card that owes a move:
    const owes = card({ notebookId: null, movedFrom: NB });
    expect(withChange(owes, { notebookId: null })).toEqual({ notebookId: null, movedFrom: NB });
    expect(withChange(owes, { notebookId: null, movedFrom: undefined })).toEqual({ notebookId: null, movedFrom: NB });
  });

  it('the card it was given is not changed', () => {
    const given = card({ notebookId: NB });
    withChange(given, { notebookId: null });
    expect(given).toEqual({ notebookId: NB });
  });

  /** Who still has the note through the notebook it left goes with the move, and only the card's. */
  it('who still has it there is kept with the move, as the card has it, never as a change says', () => {
    const owes = card({ notebookId: null, movedFrom: NB, movedFromPeople: ['ben@example.test'] });
    expect(withChange(owes, { title: 'b' })).toEqual({ notebookId: null, movedFrom: NB, movedFromPeople: ['ben@example.test'], title: 'b' });
    expect(withChange(owes, { notebookId: NB2 })).toEqual({ notebookId: NB2, movedFrom: NB, movedFromPeople: ['ben@example.test'] });
    // A queued copy's list is not the card's.
    expect(withChange(owes, { movedFromPeople: ['zoe@example.test'] })).toEqual({ notebookId: null, movedFrom: NB, movedFromPeople: ['ben@example.test'] });
    expect(withChange(card({ notebookId: NB }), { notebookId: null, movedFromPeople: ['zoe@example.test'] })).toEqual({ notebookId: null, movedFrom: NB });
  });

  it('moved back, the list goes with the move', () => {
    const owes = card({ notebookId: null, movedFrom: NB, movedFromPeople: ['ben@example.test'] });
    expect(withChange(owes, { notebookId: NB })).toEqual({ notebookId: NB });
  });
});

describe('a move that has been carried through', () => {
  it('is taken off the card, and nothing else is', () => {
    expect(settled(card({ notebookId: null, movedFrom: NB, title: 'a' }))).toEqual({ notebookId: null, title: 'a' });
    expect(settled(card({ notebookId: NB, movedFrom: null }))).toEqual({ notebookId: NB });
  });

  it('a card that owes nothing is given back as it is', () => {
    const given = card({ notebookId: NB });
    expect(settled(given)).toBe(given);
  });

  it('who still had it goes with it', () => {
    expect(settled(card({ notebookId: null, movedFrom: NB, movedFromPeople: ['ben@example.test'] }))).toEqual({ notebookId: null });
    expect(settled(card({ notebookId: null, movedFromPeople: ['ben@example.test'] }))).toEqual({ notebookId: null });
  });
});

describe('who loses a note and who is given it', () => {
  const ben = { email: 'ben@example.test' };
  const zoe = { email: 'Zoe@Example.test' };
  const amy = { email: 'amy@example.test' };

  it('out of a notebook: its people lose it', () => {
    expect(moveOfPeople([ben, zoe], [], true)).toEqual({ remove: [ben, zoe], add: [] });
  });

  it('into a notebook: its people are given it', () => {
    expect(moveOfPeople([], [ben], true)).toEqual({ remove: [], add: [ben] });
  });

  it('from one to another: whoever is in both keeps what they have', () => {
    expect(moveOfPeople([ben, zoe], [{ email: 'zoe@example.test' }, amy], true)).toEqual({ remove: [ben], add: [amy] });
  });

  it('when it is not known that the first notebook\'s people have it, everyone in the new one is given it', () => {
    const after = [{ email: 'zoe@example.test' }, amy];
    expect(moveOfPeople([ben, zoe], after, false)).toEqual({ remove: [ben], add: after });
    // Still nobody who stays is taken off it.
    expect(moveOfPeople([ben], [ben], false)).toEqual({ remove: [], add: [ben] });
  });
});
