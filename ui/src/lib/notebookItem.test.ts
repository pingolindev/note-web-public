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
  ITEM_TYPE_NOTEBOOK,
  NOTEBOOK_ITEM_SHARE_PERMISSION,
  membersFrom,
  mergeNotebookContent,
  notebookContentFrom,
  notebookItemContent,
  notebookGrantFrom,
  notebookItemSharePermission,
  notebookNameFrom,
  notebooksMissingItems,
  type NotebookPermission,
} from './notebookItem';

describe('notebookItemContent', () => {
  /**
   * Android renders a notebook item by reading `title` out of a note-shaped
   * content document. A different shape here hands the other client an item it
   * cannot render, and the failure is silent — an untitled notebook, not an
   * error.
   */
  it('puts the name in title, in the note-shaped document android writes', () => {
    const c = notebookItemContent('Recipes');
    expect(c.title).toBe('Recipes');
    expect(c.body).toBe('');
    expect(c.note_type).toBe('text');
  });

  it('round-trips through the reader', () => {
    expect(notebookNameFrom(JSON.stringify(notebookItemContent('Trip 2026')))).toBe('Trip 2026');
  });

  it('is item type 2, not the note or metadata type', () => {
    expect(ITEM_TYPE_NOTEBOOK).toBe(2);
  });
});

describe('notebookNameFrom', () => {
  /** Parsing another client's document, possibly a newer version of it. */
  it('returns null rather than throwing on anything unusable', () => {
    expect(notebookNameFrom('not json')).toBeNull();
    expect(notebookNameFrom('{}')).toBeNull();
    expect(notebookNameFrom('{"title":""}')).toBeNull();
    expect(notebookNameFrom('{"title":42}')).toBeNull();
    expect(notebookNameFrom('null')).toBeNull();
  });
});

describe('notebooksMissingItems', () => {
  const nbs = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

  it('names the notebooks that have no item yet', () => {
    expect(notebooksMissingItems(nbs, new Set(['a']))).toEqual([{ id: 'b', name: 'B' }]);
  });

  /**
   * This runs on every load, so a second pass must create nothing — otherwise
   * the backfill mints a duplicate item per notebook per session.
   */
  it('is idempotent once every notebook has an item', () => {
    expect(notebooksMissingItems(nbs, new Set(['a', 'b']))).toEqual([]);
  });

  it('creates items for everything when the server has none', () => {
    expect(notebooksMissingItems(nbs, new Set())).toHaveLength(2);
  });

  /** An id-less entry would mint an item nothing can reference. */
  it('skips an entry with no id', () => {
    expect(notebooksMissingItems([{ id: '', name: 'broken' }], new Set())).toEqual([]);
  });

  /**
   * A SOFT-DELETED item still holds its id, and `POST /items` answers 409
   * `item_already_exists`. Without recording that id as known, the backfill
   * would retry it on every page load and never converge. The store marks
   * such an id known (version 0), which is what this set models — so the
   * notebook must drop out of the missing list.
   */
  it('treats an id known-but-unwritable as no longer missing', () => {
    expect(notebooksMissingItems(nbs, new Set(['a', 'b']))).toEqual([]);
    expect(notebooksMissingItems(nbs, new Set(['b']))).toEqual([{ id: 'a', name: 'A' }]);
  });
});

describe('the roster', () => {
  const member = {
    userId: 'u1', email: 'a@b.c',
    sharingPublicKey: 'x25519', signingPublicKey: 'ed25519',
    permission: 'edit' as const,
  };

  it('a new notebook starts with nobody in it', () => {
    expect(notebookItemContent('Recipes').members).toEqual([]);
  });

  it('round-trips members through the encrypted document', () => {
    const json = JSON.stringify(notebookItemContent('Trip', [member]));
    expect(membersFrom(json)).toEqual([member]);
  });

  /**
   * A member with no id or no sharing key cannot be sealed to. Keeping them
   * would make "shared with N people" a claim the crypto cannot honour — the
   * note would go out wrapped for everyone except them, silently.
   */
  it('drops members that cannot be sealed to', () => {
    const json = JSON.stringify({ members: [
      member,
      { ...member, userId: '' },
      { ...member, sharingPublicKey: undefined },
      null,
      'not an object',
    ] });
    expect(membersFrom(json)).toEqual([member]);
  });

  it('treats anything unparseable as an empty roster', () => {
    for (const j of ['not json', '{}', '{"members":null}', '{"members":"x"}']) {
      expect(membersFrom(j)).toEqual([]);
    }
  });

  /**
   * The notebook ITEM is always shared view-only, whatever a member may do to
   * its notes: the server grants writes to any `edit` recipient, so an
   * edit-shared notebook item would let a member rewrite the roster and
   * invite people. Invites are owner-only, and this is what enforces it.
   */
  it('shares the notebook object itself as view-only', () => {
    expect(NOTEBOOK_ITEM_SHARE_PERMISSION).toBe('view');
  });
});

/**
 * The android document, byte-for-byte as the Android app writes it. Note
 * `edit_mode`, which web has no notion of, and the ABSENT `members` and
 * `color`.
 */
const ANDROID_NOTEBOOK = JSON.stringify({
  title: 'Recipes', body: '', note_type: 'text',
  is_pinned: false, is_archived: false, labels: [], sort_order: 0,
  edit_mode: 'markdown',
});

describe('rewriting a notebook written by another client', () => {
  /**
   * Every write rewrites the WHOLE document, so a rebuild from
   * notebookItemContent keeps only the fields THIS version knows about. Sharing
   * or renaming an android notebook on web would strip its edit_mode and reset
   * its colour — silently, since the fields simply stop being there.
   */
  it('keeps fields this version does not model', () => {
    const base = notebookContentFrom(ANDROID_NOTEBOOK)!;
    const next = mergeNotebookContent(base, { members: [] });

    expect(next.edit_mode).toBe('markdown');
    expect(next.note_type).toBe('text');
  });

  it('does not reset a colour it was never asked to change', () => {
    const base = notebookContentFrom(JSON.stringify({ title: 'Recipes', color: '#ff8800' }))!;
    const next = mergeNotebookContent(base, { title: 'Dinners' });

    expect(next.color).toBe('#ff8800');
    expect(next.title).toBe('Dinners');
  });

  it('applies the roster it WAS asked to change', () => {
    const base = notebookContentFrom(ANDROID_NOTEBOOK)!;
    const members = [{
      userId: 'u1', email: 'a@b.c', sharingPublicKey: 'pk',
      signingPublicKey: null, permission: 'view' as const,
    }];
    expect(mergeNotebookContent(base, { members }).members).toEqual(members);
  });

  /** An unmentioned field is left alone, not blanked. */
  it('leaves the title alone when only the roster changes', () => {
    const base = notebookContentFrom(ANDROID_NOTEBOOK)!;
    expect(mergeNotebookContent(base, { members: [] }).title).toBe('Recipes');
  });

  /** A missing roster reads as "nobody" — which is what makes an android
   *  notebook shareable at all. */
  it('reads an absent members key as an empty roster', () => {
    expect(membersFrom(ANDROID_NOTEBOOK)).toEqual([]);
  });
});

describe('notebookContentFrom', () => {
  it('returns null for something that is not an object', () => {
    expect(notebookContentFrom('[]')).toBeNull();
    expect(notebookContentFrom('"a string"')).toBeNull();
    expect(notebookContentFrom('not json')).toBeNull();
  });

  it('reads an ordinary document', () => {
    expect(notebookContentFrom(ANDROID_NOTEBOOK)?.title).toBe('Recipes');
  });
});

describe('what the notebook OBJECT is shared with', () => {
  /**
   * The invariant the whole invite mechanism rests on. The server's write check
   * matches `permission = 'edit'` exactly, so an edit-share on the notebook
   * item would let a member rewrite the ROSTER and invite whoever they liked.
   * No input may ever produce it.
   */
  it('never grants edit on the notebook object', () => {
    for (const p of ['view', 'edit', 'contribute'] as const) {
      expect(notebookItemSharePermission(p)).not.toBe('edit');
    }
  });

  /** The collection right needs its own value: the server reads `contribute`
   *  on the notebook row as "may add and remove notes". */
  it('passes contribute through so the server can enforce it', () => {
    expect(notebookItemSharePermission('contribute')).toBe('contribute');
  });

  /** Editing NOTES is carried by the note shares, not by the notebook object,
   *  so an edit member still gets a read-only notebook object. */
  it('gives an edit member a read-only notebook object', () => {
    expect(notebookItemSharePermission('edit')).toBe('view');
    expect(notebookItemSharePermission('view')).toBe('view');
  });
});

describe('reading a grant back off the two rows it was written across', () => {
  /**
   * A grant is stored twice, in two vocabularies: the collection right on the
   * notebook item and the item right on every child note. The children alone
   * cannot tell `contribute` from `edit` — both leave the notes on `edit` — so a
   * Share panel that read only them would show a contributor as "Can edit". That
   * would be wrong on screen and also a trap: the permission control skips a
   * change that matches what is displayed, so selecting "Can edit" on a
   * contributor would do nothing and there would be no way to demote one.
   */
  const write = (grant: NotebookPermission) => ({
    object: notebookItemSharePermission(grant),
    child: grant === 'view' ? 'view' : 'edit',
  });

  it('round-trips every grant the picker can produce', () => {
    for (const grant of ['view', 'edit', 'contribute'] as const) {
      const { object, child } = write(grant);
      expect(notebookGrantFrom(object, child), grant).toBe(grant);
    }
  });

  it('tells contribute apart from edit, which the children alone cannot', () => {
    // Same child permission, different grant — the notebook row is the only
    // thing that distinguishes them.
    expect(notebookGrantFrom('contribute', 'edit')).toBe('contribute');
    expect(notebookGrantFrom('view', 'edit')).toBe('edit');
  });

  it('falls back to the narrowest reading when a row is missing', () => {
    // Someone on the notebook object but on no note yet (an empty notebook).
    expect(notebookGrantFrom('contribute', undefined)).toBe('contribute');
    // Someone on the notes but not on the object (a pre-notebook-object share).
    expect(notebookGrantFrom(undefined, 'edit')).toBe('edit');
    expect(notebookGrantFrom(undefined, undefined)).toBe('view');
    expect(notebookGrantFrom(null, null)).toBe('view');
  });
});
