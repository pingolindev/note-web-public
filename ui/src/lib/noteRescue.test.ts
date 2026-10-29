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
import { rescuePlan, type RescueFacts } from './noteRescue';
import type { NoteItem } from '../stores/notes';

/**
 * When a note is rescued from this browser's copy after a password reset, and
 * from which copy (lib/noteRescue).
 */

/** A card made here, under the row's own wrap. */
const card = (over: Partial<NoteItem> = {}): NoteItem => ({
  id: 'n1', title: 'kept', body: '', noteType: 'text', color: null, isPinned: false, isArchived: false,
  labels: [], sortOrder: 0, editMode: 'rich', notebookId: 'nb', hasAttachments: false,
  version: 3, createdAt: '', updatedAt: '', deleted: false,
  wrappedContentKey: 'wk', wrappedContentKeyNonce: 'wn', openedVia: 'vault', ...over,
} as NoteItem);
const facts = (over: Partial<RescueFacts> = {}): RescueFacts => ({
  card: card(),
  row: { version: 3, wrappedKey: 'wk', wrappedKeyNonce: 'wn' },
  pending: null,
  incomingShare: false,
  rowKeyOpens: false,
  ...over,
});

describe('rescuePlan', () => {
  it('the copy of the server\'s latest version is rescued, in its own notebook', () => {
    expect(rescuePlan(facts())).toEqual({ do: 'rescue', copy: card(), notebookId: 'nb', owesMove: false });
  });

  it('an older copy is not: the note stays locked', () => {
    expect(rescuePlan(facts({ row: { version: 4, wrappedKey: 'wk', wrappedKeyNonce: 'wn' } }))).toEqual({ do: 'locked' });
    // A NEWER copy than the server's cannot be a copy of what it holds either.
    expect(rescuePlan(facts({ row: { version: 2, wrappedKey: 'wk', wrappedKeyNonce: 'wn' } }))).toEqual({ do: 'locked' });
  });

  it('nothing is done without a copy, for a deleted one, another\'s, one shared with us, or a row that opens now', () => {
    expect(rescuePlan(facts({ card: null }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ card: card({ deleted: true }) }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ card: card({ foreignOwner: true }) }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ incomingShare: true }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ rowKeyOpens: true }))).toEqual({ do: 'leave' });
  });

  it('a create waiting, or a card waiting for one, is left to that', () => {
    expect(rescuePlan(facts({ pending: { op: 'create', note: card() } }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ card: card({ pendingSync: true }) }))).toEqual({ do: 'leave' });
  });

  it('an edit waiting to be sent is the copy: the queue is written before the card', () => {
    const waiting = card({ title: 'typed' });
    expect(rescuePlan(facts({ pending: { op: 'update', note: waiting } }))).toEqual({ do: 'rescue', copy: waiting, notebookId: 'nb', owesMove: false });
    // Of the version the server has, like the card.
    expect(rescuePlan(facts({ pending: { op: 'update', note: card({ version: 2 }) } }))).toEqual({ do: 'locked' });
  });

  it('only a card POSITIVELY ours: the server\'s word that the row is ours is not enough', () => {
    expect(rescuePlan(facts({ card: card({ openedVia: undefined, foreignOwner: undefined }) }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ card: card({ openedVia: 'share', foreignOwner: undefined }) }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ card: card({ openedVia: undefined, foreignOwner: false }) }))).toMatchObject({ do: 'rescue' });
  });

  it('only a copy of THIS key: a card under another wrap than the row\'s is not rescued', () => {
    // One that opens here, say, while the server now serves a wrap nothing opens.
    expect(rescuePlan(facts({ card: card({ wrappedContentKey: 'opens-here' }) }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ card: card({ wrappedContentKeyNonce: 'other' }) }))).toEqual({ do: 'leave' });
    expect(rescuePlan(facts({ card: card({ wrappedContentKey: null, wrappedContentKeyNonce: null }) }))).toEqual({ do: 'leave' });
  });

  it('a note shared with someone, as far as this page knows, is held: left locked', () => {
    expect(rescuePlan(facts({ card: card({ isShared: true }) }))).toEqual({ do: 'held' });
    expect(rescuePlan(facts({ card: card({ sharedWithCount: 2 }) }))).toEqual({ do: 'held' });
    expect(rescuePlan(facts({ card: card({ isShared: false, sharedWithCount: 0 }) }))).toMatchObject({ do: 'rescue' });
  });

  it('a move is not claimed: written where the sharing has the note, and owed', () => {
    // The refused save of a move: the card remembers where the sharing has it.
    const moved = card({ notebookId: 'nb-new', movedFrom: 'nb' });
    expect(rescuePlan(facts({ card: moved }))).toEqual({ do: 'rescue', copy: moved, notebookId: 'nb', owesMove: true });
    // A move waiting in the queue whose card did not show it yet (a crash between the two).
    const waiting = card({ notebookId: 'nb-new' });
    expect(rescuePlan(facts({ pending: { op: 'update', note: waiting } }))).toEqual({ do: 'rescue', copy: waiting, notebookId: 'nb', owesMove: true });
    // Out of any notebook.
    expect(rescuePlan(facts({ card: card({ notebookId: null, movedFrom: 'nb' }) }))).toMatchObject({ notebookId: 'nb', owesMove: true });
    // Moved back where it was: nothing owed.
    expect(rescuePlan(facts({ pending: { op: 'update', note: card({ notebookId: 'nb' }) }, card: card({ notebookId: 'nb' }) }))).toMatchObject({ owesMove: false });
  });
});
