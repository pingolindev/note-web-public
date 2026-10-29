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
  placeNote, shouldShowQueued, editsIn, hasEdits, foldIntoCreate, createFromCard, afterCreate, afterLanding, carriesText, wordsOf,
  EDITABLE, LANDED_AT,
  type QueuedEdit,
} from './pendingNotes';

const n = (id: string, title = '') => ({ id, title });

describe('placing a note that has just been created', () => {
  it('puts a brand-new note at the front', () => {
    expect(placeNote([n('a'), n('b')], n('c')).map(x => x.id)).toEqual(['c', 'a', 'b']);
  });

  /**
   * The whole point. A note written offline is already on screen under this
   * id; the create that finally lands must take its place, not sit above it.
   */
  it('replaces the offline row instead of duplicating it', () => {
    const list = [n('a'), n('queued', 'Shopping'), n('b')];
    const landed = placeNote(list, n('queued', 'Shopping'));

    expect(landed).toHaveLength(3);
    expect(landed.filter(x => x.id === 'queued')).toHaveLength(1);
  });

  /** A note that syncs while being read must not jump to the top of the grid. */
  it('leaves the replaced note exactly where it was', () => {
    const landed = placeNote([n('a'), n('queued'), n('b')], n('queued'));
    expect(landed.map(x => x.id)).toEqual(['a', 'queued', 'b']);
  });

  it('takes the incoming version of the row, not the stale one', () => {
    const landed = placeNote([n('queued', 'old title')], n('queued', 'new title'));
    expect(landed[0].title).toBe('new title');
  });

  it('does not mutate the list it was given', () => {
    const before = [n('a'), n('queued')];
    placeNote(before, n('queued', 'changed'));
    expect(before.map(x => x.title)).toEqual(['', '']);
  });

  /** Cached rows can arrive with holes in them. */
  it('survives a hole in the list', () => {
    const list = [n('a'), undefined as unknown as { id: string }, n('b')];
    expect(() => placeNote(list, n('c'))).not.toThrow();
  });
});

describe('whether a queued create shows a row', () => {
  it('shows one for a note written just now', () => {
    expect(shouldShowQueued(false)).toBe(true);
  });

  /**
   * A phone with no signal retries the queue on every wake-up. Adding a row
   * per attempt would stack copies of one note up the grid.
   */
  it('adds nothing on a replay, however many times it fails', () => {
    expect(shouldShowQueued(true)).toBe(false);
  });
});

/**
 * An edit never replaces a waiting create: the rules. The store's own tests
 * (stores/notes.waitingCreate.test) run them against a server and a queue.
 */
type Note = {
  id: string; title: string; body: string; color: string | null; notebookId: string | null;
  isPinned: boolean; isArchived: boolean; labels: string[]; version: number; pendingSync?: boolean;
};
const note = (over: Partial<Note> = {}): Note => ({
  id: 'n1', title: 'Shopping', body: 'milk', color: null, notebookId: null,
  isPinned: false, isArchived: false, labels: [], version: 0, ...over,
});
const waiting = (over: Partial<QueuedEdit<Note>> = {}): QueuedEdit<Note> => ({
  id: 'n1', note: note(), op: 'create', queuedAt: '2026-10-07T09:00:00Z', account: 'acct', ...over,
});

describe('what counts as an edit', () => {
  it('is the fields an update sends, and nothing else of what it was handed', () => {
    const handed = { ...note({ title: 'Edited' }), wrappedContentKey: 'w', createdAt: 't', deleted: false } as Partial<Note>;
    expect(editsIn<Note>(handed)).toEqual({
      title: 'Edited', body: 'milk', color: null, notebookId: null, isPinned: false, isArchived: false, labels: [],
    });
  });

  it('keeps a field set to nothing (no colour, no notebook) and leaves out one not touched', () => {
    expect(editsIn<Note>({ color: null, notebookId: null, title: undefined })).toEqual({ color: null, notebookId: null });
    expect(editsIn<Note>({})).toEqual({});
  });

  it('never the id, the version or the waiting mark: those are the card\'s, not an edit', () => {
    for (const field of ['id', 'version', 'pendingSync', 'createdAt', 'updatedAt', 'deleted', 'wrappedContentKey']) {
      expect(EDITABLE as readonly string[]).not.toContain(field);
    }
  });

  it('every field of a note that an update can change is one', () => {
    expect([...EDITABLE].sort()).toEqual([
      'body', 'checklistItems', 'color', 'editMode', 'hasAttachments', 'isArchived', 'isPinned', 'labels',
      'noteType', 'notebookId', 'sortOrder', 'title',
    ]);
  });

  it('is told apart from none', () => {
    expect(hasEdits({ title: 'x' })).toBe(true);
    expect(hasEdits({})).toBe(false);
    expect(hasEdits(null)).toBe(false);
    expect(hasEdits(undefined)).toBe(false);
  });
});

describe('an edit of a note whose create is still waiting', () => {
  it('stays a create, of the note as it is now, and remembers what was changed', () => {
    const folded = foldIntoCreate(waiting(), { title: 'Groceries' });
    expect(folded.op).toBe('create');
    expect(folded.note).toEqual(note({ title: 'Groceries' }));
    expect(folded.edits).toEqual({ title: 'Groceries' });
    // The rest of the entry is as it was: its id, when it was queued, whose it is.
    expect(folded).toMatchObject({ id: 'n1', queuedAt: '2026-10-07T09:00:00Z', account: 'acct' });
  });

  it('a second edit adds to the first, and the later word on a field wins', () => {
    const once = foldIntoCreate(waiting(), { title: 'Groceries', isPinned: true });
    const twice = foldIntoCreate(once, { title: 'Groceries for Sunday', labels: ['errands'] });
    expect(twice.edits).toEqual({ title: 'Groceries for Sunday', isPinned: true, labels: ['errands'] });
    expect(twice.note).toEqual(note({ title: 'Groceries for Sunday', isPinned: true, labels: ['errands'] }));
  });

  it('does not change the entry it was given', () => {
    const before = waiting();
    foldIntoCreate(before, { title: 'Groceries' });
    expect(before.note.title).toBe('Shopping');
    expect(before.edits).toBeUndefined();
  });
});

describe('the create of a card that waits with nothing in the queue', () => {
  it('is made from the card, with the change, and counts ALL of it as changed', () => {
    const made = createFromCard(note({ pendingSync: true }), { body: 'milk, eggs' }, '2026-10-07T10:00:00Z');
    expect(made).toMatchObject({ id: 'n1', op: 'create', queuedAt: '2026-10-07T10:00:00Z' });
    expect(made.note).toEqual(note({ pendingSync: true, body: 'milk, eggs' }));
    // Whether an earlier attempt landed is not known: if one did, the row there is older than this.
    expect(made.edits).toEqual({
      title: 'Shopping', body: 'milk, eggs', color: null, notebookId: null, isPinned: false, isArchived: false, labels: [],
    });
  });
});

describe('when a create has ended', () => {
  const NOW = '2026-10-07T11:00:00Z';
  const there = note({ version: 1 });

  it('an entry nobody edited simply goes', () => {
    expect(afterCreate(waiting(), there, NOW)).toBeNull();
    expect(afterCreate(waiting({ edits: {} }), there, NOW)).toBeNull();
  });

  it('one that was edited becomes the update of those edits, on the row the server has', () => {
    const next = afterCreate(waiting({ edits: { title: 'Groceries', isArchived: true } }), there, NOW);
    expect(next?.edits).toEqual({ title: 'Groceries', isArchived: true });
    expect(next?.queue).toEqual({
      id: 'n1', op: 'update', queuedAt: NOW, account: 'acct',
      note: note({ version: 1, title: 'Groceries', isArchived: true }),
    });
  });

  it('a create that did NOT reach the server leaves no update behind', () => {
    expect(afterCreate(waiting({ edits: { title: 'Groceries' } }), null, NOW)).toBeNull();
  });

  it('nothing is made of an entry that is not a create, or of none', () => {
    expect(afterCreate(waiting({ op: 'update', edits: { title: 'Groceries' } }), there, NOW)).toBeNull();
    expect(afterCreate(null, there, NOW)).toBeNull();
    expect(afterCreate(undefined, there, NOW)).toBeNull();
  });
});

describe('what is worth keeping of edits to a note that is gone', () => {
  it('words: a title, a body, a checklist', () => {
    expect(carriesText({ title: 'x' })).toBe(true);
    expect(carriesText({ body: '' })).toBe(true);
    expect(carriesText({ checklistItems: [] } as never)).toBe(true);
  });

  it('not a position, a pin, a colour, a label or a notebook', () => {
    expect(carriesText({ isPinned: true, color: 'teal', labels: ['a'], notebookId: 'nb', sortOrder: 3 } as never)).toBe(false);
    expect(carriesText({})).toBe(false);
    expect(carriesText(null)).toBe(false);
    expect(carriesText(undefined)).toBe(false);
  });
});

describe('what a create that found its note on the server may still send', () => {
  type N = { id: string; title: string; body: string; checklistItems?: { text: string; checked: boolean }[]; isPinned?: boolean; notebookId?: string | null };
  const row: N = { id: 'a', title: 'Shopping', body: 'milk' };
  const folded = (edits: Partial<N>, over: Partial<QueuedEdit<N>> = {}): QueuedEdit<N> => ({
    id: 'a', op: 'create', queuedAt: 't', note: { ...row, ...edits }, edits, ...over,
  });

  it('a new note is at version 1', () => {
    expect(LANDED_AT).toBe(1);
  });

  it('nothing, when the create carries no changes', () => {
    expect(afterLanding(null, row, 1)).toBe('nothing');
    expect(afterLanding({ note: row, edits: {} }, row, 1)).toBe('nothing');
    expect(afterLanding({ note: row }, row, 3)).toBe('nothing');
  });

  it('a row still as it landed takes the changes, whatever they are', () => {
    expect(afterLanding(folded({ body: 'milk, eggs' }), row, LANDED_AT)).toBe('send');
    expect(afterLanding(folded({ isPinned: true }), row, LANDED_AT)).toBe('send');
    // Also a card made into a create again: the row is what that card first sent.
    expect(afterLanding(folded({ body: 'milk, eggs' }, { remade: true }), row, LANDED_AT)).toBe('send');
  });

  it('a row changed since: words written here are kept as a note of their own, never sent over it', () => {
    const changed: N = { ...row, body: 'milk, bread' };
    expect(afterLanding(folded({ body: 'milk, eggs' }), changed, 2)).toBe('keep-as-copy');
    expect(afterLanding(folded({ title: 'Groceries' }), changed, 2)).toBe('keep-as-copy');
    expect(afterLanding(folded({ checklistItems: [{ text: 'eggs', checked: false }] }), changed, 5)).toBe('keep-as-copy');
    // With a pin beside the words, too: the words decide.
    expect(afterLanding(folded({ body: 'milk, eggs', isPinned: true }), changed, 2)).toBe('keep-as-copy');
  });

  it('a row changed since: a pin, a colour or a move holds no words and is sent', () => {
    const changed: N = { ...row, body: 'milk, bread' };
    expect(afterLanding(folded({ isPinned: true }), changed, 2)).toBe('send');
    expect(afterLanding(folded({ notebookId: 'nb' }), changed, 2)).toBe('send');
  });

  it('a row changed since, and the words written here are the words it has: sent, nothing is replaced', () => {
    const changed: N = { ...row, body: 'milk, eggs' };
    expect(afterLanding(folded({ body: 'milk, eggs', isPinned: true }), changed, 2)).toBe('send');
  });

  it('a card made into a create again, on a row changed since: nothing of it is sent', () => {
    const changed: N = { ...row, body: 'milk, bread', isPinned: true };
    // Other words than the row: kept, as a note of their own.
    expect(afterLanding(folded({ title: 'Shopping', body: 'milk' }, { remade: true }), changed, 3)).toBe('keep-as-copy');
    // The row's words: an old card of the same note. Its pin, colour and notebook are not sent either.
    expect(afterLanding(folded({ title: 'Shopping', body: 'milk, bread', isPinned: false, notebookId: 'old' }, { remade: true }), changed, 3)).toBe('nothing');
  });

  it('a card made into a create again says so, and a change folded into it keeps saying so', () => {
    const remade = createFromCard<N>(row, {}, 't');
    expect(remade.remade).toBe(true);
    expect(foldIntoCreate(remade, { body: 'milk, eggs' }).remade).toBe(true);
    // An ordinary waiting create does not.
    expect(foldIntoCreate<N>({ id: 'a', op: 'create', queuedAt: 't', note: row }, { body: 'x' }).remade).toBeUndefined();
  });

  it('the words of a note are its title, its text and its list, and nothing else', () => {
    expect(wordsOf({ title: 'a', body: 'b' })).toBe(wordsOf({ title: 'a', body: 'b', checklistItems: undefined }));
    expect(wordsOf({ title: 'a', body: 'b' })).toBe(wordsOf({ title: 'a', body: 'b', checklistItems: [] }));
    expect(wordsOf({})).toBe(wordsOf({ title: '', body: '' }));
    expect(wordsOf(null)).toBe(wordsOf({}));
    expect(wordsOf({ title: 'a', body: 'b' })).not.toBe(wordsOf({ title: 'a', body: 'c' }));
    expect(wordsOf({ title: 'a', body: 'b' })).not.toBe(wordsOf({ title: 'A', body: 'b' }));
    expect(wordsOf({ title: 'a', checklistItems: [{ text: 'x', checked: false }] })).not.toBe(wordsOf({ title: 'a', checklistItems: [{ text: 'x', checked: true }] }));
    // A pin or a colour is not words.
    expect(wordsOf({ title: 'a', body: 'b', isPinned: true, color: 'teal' } as never)).toBe(wordsOf({ title: 'a', body: 'b' }));
  });
});
