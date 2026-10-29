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
  needsKeyLookup, recipientsForNewNote, withLookedUpKeys,
} from './notebookFanOut';
import type { NotebookMember } from './notebookItem';

const member = (email: string, over: Partial<NotebookMember> = {}): NotebookMember => ({
  userId: `u-${email}`,
  email,
  sharingPublicKey: `pk-${email}`,
  signingPublicKey: `sk-${email}`,
  permission: 'edit',
  ...over,
});

const ALICE = member('alice@example.com');   // the owner, in these fixtures
const BOB = member('bob@example.com');
const CAROL = member('carol@example.com', { permission: 'view' });

describe('a MEMBER adding a note', () => {
  /**
   * The roster lists people the notebook was shared WITH — never its owner.
   * Sealing only to it writes a note into someone's notebook that its owner
   * cannot open.
   */
  it('includes the notebook owner', () => {
    const out = recipientsForNewNote({
      roster: [BOB, CAROL],
      ownerEmail: 'alice@example.com',
      myEmail: 'bob@example.com',
    });

    expect(out.map(r => r.email)).toEqual(['carol@example.com', 'alice@example.com']);
  });

  /** Sealing to yourself is a wasted row, and a share from yourself is
   *  something the inbox has no sensible way to render. */
  it('leaves the author out', () => {
    const out = recipientsForNewNote({
      roster: [BOB, CAROL],
      ownerEmail: 'alice@example.com',
      myEmail: 'bob@example.com',
    });

    expect(out.map(r => r.email)).not.toContain('bob@example.com');
  });

  /** `contribute` is a collection right; on a note row it would read as
   *  "no write", because user_can_write matches 'edit' exactly. */
  it('never puts contribute on a note share', () => {
    const out = recipientsForNewNote({
      roster: [member('dave@example.com', { permission: 'contribute' })],
      ownerEmail: 'alice@example.com',
      myEmail: 'bob@example.com',
    });

    expect(out.find(r => r.email === 'dave@example.com')?.permission).toBe('edit');
  });

  it('keeps a view member read-only', () => {
    const out = recipientsForNewNote({
      roster: [CAROL], ownerEmail: null, myEmail: 'bob@example.com',
    });
    expect(out[0].permission).toBe('view');
  });

  /** A member with no sharing key cannot be sealed to; keeping them would make
   *  "shared with N people" a claim the crypto cannot honour. */
  it('drops a member with no sharing key', () => {
    const out = recipientsForNewNote({
      roster: [member('nokey@example.com', { sharingPublicKey: '' })],
      ownerEmail: null,
      myEmail: 'bob@example.com',
    });
    expect(out).toEqual([]);
  });

  it('does not list the owner twice when they are also in the roster', () => {
    const out = recipientsForNewNote({
      roster: [ALICE, BOB],
      ownerEmail: 'alice@example.com',
      myEmail: 'carol@example.com',
    });
    expect(out.filter(r => r.email.toLowerCase() === 'alice@example.com')).toHaveLength(1);
  });

  it('matches addresses case-insensitively', () => {
    const out = recipientsForNewNote({
      roster: [member('Bob@Example.com')],
      ownerEmail: 'ALICE@EXAMPLE.COM',
      myEmail: 'bob@EXAMPLE.com',
    });
    expect(out.map(r => r.email.toLowerCase())).toEqual(['alice@example.com']);
  });
});

describe('the OWNER adding a note', () => {
  /** There is nobody above the owner to include. */
  it('adds no owner entry when we are the owner', () => {
    const out = recipientsForNewNote({
      roster: [BOB, CAROL],
      ownerEmail: null,
      myEmail: 'alice@example.com',
    });
    expect(out.map(r => r.email)).toEqual(['bob@example.com', 'carol@example.com']);
  });
});

describe('filling in the owner key', () => {
  /** The owner's key is not in the roster, so the caller has to fetch it. */
  it('reports who still needs a lookup', () => {
    const out = recipientsForNewNote({
      roster: [BOB], ownerEmail: 'alice@example.com', myEmail: 'bob@example.com',
    });
    expect(needsKeyLookup(out)).toEqual(['alice@example.com']);
  });

  it('fills the key in once found', () => {
    const out = recipientsForNewNote({
      roster: [BOB], ownerEmail: 'alice@example.com', myEmail: 'bob@example.com',
    });
    const filled = withLookedUpKeys(out, new Map([
      ['alice@example.com', { sharingPub: 'pk-alice', userId: 'u-alice', signingPub: 'sk-alice' }],
    ]));

    expect(filled.find(r => r.email === 'alice@example.com')).toMatchObject({
      publicKey: 'pk-alice', userId: 'u-alice', signingPublicKey: 'sk-alice',
    });
  });

  /**
   * A share with no key is a row the recipient can never open, and it would
   * make the note look shared when it is not.
   */
  it('drops anyone whose key could not be found, keeping the rest', () => {
    // Carol is the author here, so Bob stays in the list and the owner is the
    // only entry awaiting a key.
    const out = recipientsForNewNote({
      roster: [BOB], ownerEmail: 'alice@example.com', myEmail: 'carol@example.com',
    });
    const filled = withLookedUpKeys(out, new Map());

    expect(filled.map(r => r.email)).toEqual(['bob@example.com']);
  });

  it('leaves already-keyed recipients untouched', () => {
    const out = recipientsForNewNote({
      roster: [BOB], ownerEmail: null, myEmail: 'carol@example.com',
    });
    expect(withLookedUpKeys(out, new Map())).toEqual(out);
  });
});
