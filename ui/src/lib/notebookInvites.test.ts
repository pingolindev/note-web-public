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
  awaitsInvitation, displayName, inviteGrantText, invitesFrom, pendingInvites, pendingNotebookIds, staleAcceptances, withAccepted, withoutAccepted, type InvitationState, type NotebookShareRow, rememberedAcceptances, parseRemembered,
} from './notebookInvites';
import { unansweredFrom, UNANSWERED_MAX } from './notebookInvites';

const row = (over: Partial<NotebookShareRow> = {}): NotebookShareRow => ({
  shareId: 's1',
  itemId: 'nb1',
  sharerEmail: 'owner@example.com',
  note: { title: 'Recipes' },
  error: null,
  ...over,
});

describe('turning inbox rows into invitations', () => {
  it('reads the notebook name and who sent it', () => {
    const [invite] = invitesFrom([row()], []);
    expect(invite).toMatchObject({
      notebookId: 'nb1', shareId: 's1', name: 'Recipes',
      sharer: 'owner@example.com', accepted: false, unreadable: false,
    });
  });

  it('marks one the recipient has already accepted', () => {
    expect(invitesFrom([row()], ['nb1'])[0].accepted).toBe(true);
  });

  /**
   * Re-sharing a notebook — to change a permission, say — writes a second
   * share row. Two rows for one notebook would read as two invitations to the
   * same place.
   */
  /**
   * The rows come in the server's order, NEWEST FIRST, and are handed over
   * that way here: oldest first, "the last row wins" would pass for "the
   * newest row wins" while the app showed the oldest.
   */
  it('shows one invitation per notebook, newest row winning', () => {
    const invites = invitesFrom([
      row({ shareId: 'new', note: { title: 'New name' } }),
      row({ shareId: 'old', note: { title: 'Old name' } }),
    ], []);

    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ shareId: 'new', name: 'New name' });
  });

  /** Declining has to dismiss every one of them, or the notebook stays on offer. */
  it('keeps every share row of a notebook, newest first', () => {
    const invites = invitesFrom([
      row({ shareId: 'new' }), row({ shareId: 'other', itemId: 'nb2' }), row({ shareId: 'old' }),
    ], []);
    expect(invites.map(i => [i.notebookId, i.shareIds])).toEqual([['nb1', ['new', 'old']], ['nb2', ['other']]]);
  });

  /**
   * A share the recipient was told about but cannot open must still appear.
   * Hiding it turns a dropped signature or a missing key into a silent gap.
   */
  it('keeps a share it could not decrypt, marked unreadable', () => {
    const [invite] = invitesFrom([row({ note: null, error: 'no-key' })], []);
    expect(invite.unreadable).toBe(true);
    expect(invite.name).toBeNull();
    expect(displayName(invite)).toBe('Unavailable notebook');
  });

  it('names an anonymous sender rather than leaving it blank', () => {
    expect(invitesFrom([row({ sharerEmail: null })], [])[0].sharer).toBe('Unknown sender');
  });

  /** What a block names: the address itself, never the words shown for a sender without one. */
  it('carries the sender\'s address as the share has it, and none when the share has none', () => {
    expect(invitesFrom([row({ sharerEmail: 'Owner@Example.com' })], [])[0].sharerEmail).toBe('Owner@Example.com');
    const anonymous = invitesFrom([row({ sharerEmail: null })], [])[0];
    expect(anonymous.sharerEmail).toBeNull();
    expect(anonymous.sharer).toBe('Unknown sender');
  });

  it('treats an empty title as no name', () => {
    expect(invitesFrom([row({ note: { title: '' } })], [])[0].name).toBeNull();
  });
});

describe('what still needs a decision', () => {
  it('is the invitations not yet accepted', () => {
    const invites = invitesFrom([
      row({ itemId: 'nb1', shareId: 's1' }),
      row({ itemId: 'nb2', shareId: 's2' }),
    ], ['nb1']);

    expect(pendingInvites(invites).map(i => i.notebookId)).toEqual(['nb2']);
  });
});

describe('recording the decision', () => {
  it('is idempotent, so two tabs cannot double-add', () => {
    expect(withAccepted(withAccepted([], 'nb1'), 'nb1')).toEqual(['nb1']);
  });

  it('keeps the existing acceptances', () => {
    expect(withAccepted(['nb1'], 'nb2')).toEqual(['nb1', 'nb2']);
  });

  /** Leaving a declined notebook in the list would make a later re-invitation
   *  land already-accepted, with no question asked. */
  it('forgets one on decline', () => {
    expect(withoutAccepted(['nb1', 'nb2'], 'nb1')).toEqual(['nb2']);
  });

  it('does not mutate what it was given', () => {
    const before = ['nb1'];
    withAccepted(before, 'nb2');
    withoutAccepted(before, 'nb1');
    expect(before).toEqual(['nb1']);
  });
});

describe('acceptances that outlived their notebook', () => {
  /** The owner can remove the recipient, or delete the notebook outright. */
  it('finds the ones no longer in the inbox', () => {
    expect(staleAcceptances(['nb1', 'nb2'], new Set(['nb2']))).toEqual(['nb1']);
  });

  it('finds nothing when every acceptance is still live', () => {
    expect(staleAcceptances(['nb1'], new Set(['nb1', 'nb2']))).toEqual([]);
  });
});

describe('what the invitation says it grants', () => {
  const inviteWith = (permission: string, over: Partial<NotebookShareRow> = {}) =>
    invitesFrom([row({ permission, ...over })], [])[0];

  /**
   * "Can read" and "can add and remove notes" are different things to agree to.
   * An invitation that does not say which is on offer asks someone to accept an
   * unknown.
   */
  it('says so when the recipient may add and remove notes', () => {
    expect(inviteGrantText(inviteWith('contribute'))).toMatch(/add and remove/i);
  });

  it('says read-only for a plain member', () => {
    const text = inviteGrantText(inviteWith('view'));
    expect(text).toMatch(/read the notes/i);
    expect(text).not.toMatch(/add and remove/i);
  });

  /** An absent permission is the conservative reading, not the generous one. */
  it('treats an unknown permission as read-only', () => {
    expect(inviteGrantText(invitesFrom([row()], [])[0])).not.toMatch(/add and remove/i);
  });

  /** A notebook we cannot open has nothing to grant — say that instead. */
  it('explains an unopenable notebook rather than promising access', () => {
    const text = inviteGrantText(inviteWith('contribute', { note: null }));
    expect(text).toMatch(/could not be opened/i);
    expect(text).not.toMatch(/add and remove/i);
  });
});

/**
 * An invitation "does nothing else until the recipient accepts", but each
 * note is shared on its own row, so its notes would be in the reader's Notes
 * grid all the same unless something asks whether the notebook was accepted.
 */
describe('notes that came with an invitation not yet accepted', () => {
  const state = (over: Partial<InvitationState> = {}): InvitationState => ({
    pending: new Set(['nb-pending']), accepted: new Set(['nb-accepted']), inboxKnown: true, ...over,
  });
  const received = (ownerNotebookId: string | null) => ({ openedVia: 'share' as const, ownerNotebookId });

  it('lists the invitations still unanswered', () => {
    expect([...pendingNotebookIds(['a', 'b', 'c'], ['b'])]).toEqual(['a', 'c']);
    expect(pendingNotebookIds([], ['b']).size).toBe(0);
  });

  it('holds a received note whose notebook is an unanswered invitation', () => {
    expect(awaitsInvitation(received('nb-pending'), state())).toBe(true);
  });

  it('lets it through once the invitation is accepted', () => {
    expect(awaitsInvitation(received('nb-accepted'), state())).toBe(false);
    const accepted = state({ pending: new Set(), accepted: new Set(['nb-pending']) });
    expect(awaitsInvitation(received('nb-pending'), accepted)).toBe(false);
  });

  /** "A note arrives, you read it": one shared on its own was never an invitation. */
  it('never holds a note shared on its own', () => {
    expect(awaitsInvitation(received(null), state())).toBe(false);
    expect(awaitsInvitation({ openedVia: 'share' }, state())).toBe(false);
  });

  /** Shared out of a notebook whose object was not shared: there is nothing to accept. */
  it('never holds a note from a notebook with no invitation behind it', () => {
    expect(awaitsInvitation(received('nb-never-shared'), state())).toBe(false);
  });

  /**
   * A note our own vault opened is ours. An invitation naming one of OUR
   * notebook ids, which a server can make up, must not take our notes off the
   * screen.
   */
  it('never holds a note of our own, whatever the invitation names', () => {
    const forged = state({ pending: new Set(['my-notebook']) });
    expect(awaitsInvitation({ openedVia: 'vault', ownerNotebookId: 'my-notebook' }, forged)).toBe(false);
    expect(awaitsInvitation({ ownerNotebookId: 'my-notebook' }, forged)).toBe(false);
    // `notebookId` names a notebook of ours and is not read at all.
    expect(awaitsInvitation({ openedVia: 'share', notebookId: 'my-notebook' } as never, forged)).toBe(false);
  });

  /**
   * The grid paints from the cache before the inbox is asked. Until it has
   * answered, a received note in a notebook we have not accepted is held, or
   * every cold start would show the held notes and then take them away.
   */
  it('holds on a cold start until the inbox has answered', () => {
    const cold = state({ pending: new Set(), inboxKnown: false });
    expect(awaitsInvitation(received('nb-pending'), cold)).toBe(true);
    expect(awaitsInvitation(received('nb-never-shared'), cold)).toBe(true);
    // An accepted notebook is known from the reader's own record, so it never waits.
    expect(awaitsInvitation(received('nb-accepted'), cold)).toBe(false);
    expect(awaitsInvitation(received(null), cold)).toBe(false);
  });

  /** A failed answer is an answer: offline, nothing stays held on a guess. */
  it('holds nothing once the inbox has answered with nothing', () => {
    const failed = state({ pending: new Set(), inboxKnown: true });
    expect(awaitsInvitation(received('nb-pending'), failed)).toBe(false);
    expect(awaitsInvitation(received('nb-never-shared'), failed)).toBe(false);
  });
});

/**
 * The rules of the hold, and the one case it deliberately leaves alone.
 * Each is here by name.
 */
describe('the rules of the hold', () => {
  const theirs = (notebook: string | null) => ({ openedVia: 'share' as const, ownerNotebookId: notebook });
  const state = (over: Partial<InvitationState> = {}): InvitationState => ({
    pending: new Set<string>(), accepted: new Set<string>(), inboxKnown: true, ...over,
  });

  /**
   * Declining dismisses the shares, so the notebook stops being pending
   * at once; its notes are still in memory until the next completed sync.
   * Without this, pressing Decline would put them INTO the grid.
   */
  it('a notebook declined on this page holds its notes although nothing is pending any more', () => {
    expect(awaitsInvitation(theirs('nb'), state())).toBe(false);
    expect(awaitsInvitation(theirs('nb'), state({ declined: new Set(['nb']) }))).toBe(true);
    expect(awaitsInvitation(theirs('other'), state({ declined: new Set(['nb']) }))).toBe(false);
  });

  it('a decline never holds a note our own vault opened', () => {
    expect(awaitsInvitation({ openedVia: 'vault', ownerNotebookId: 'nb' }, state({ declined: new Set(['nb']) }))).toBe(false);
  });

  /**
   * `declined` also carries what the SERVER says was declined: on the device
   * that did not decline, the notebook's notes are in memory and the next inbox
   * answer no longer lists the invitation, so they would stand in the grid
   * until the sync took them out. That is the same set, and the same rule as
   * above, with one exception.
   */
  describe('a note of a declined notebook that still has a share of its own', () => {
    const copy = (id: string, notebook: string) => ({ id, openedVia: 'share' as const, ownerNotebookId: notebook });
    const declinedNb = (over: Partial<InvitationState> = {}) => state({ declined: new Set(['nb']), ...over });

    /**
     * It was shared with the reader by itself, and filed into that notebook by
     * its owner afterwards. It was never part of what they declined, and
     * nothing takes it off their screen.
     */
    it('is not held: it is theirs in its own right', () => {
      const listed = declinedNb({ stillShared: new Set(['mine-to-see']) });
      expect(awaitsInvitation(copy('mine-to-see', 'nb'), listed)).toBe(false);
      expect(awaitsInvitation(copy('left-behind', 'nb'), listed)).toBe(true);
    });

    it('a note with no id is not known to be shared: it is held', () => {
      expect(awaitsInvitation({ openedVia: 'share', ownerNotebookId: 'nb' }, declinedNb({ stillShared: new Set(['x']) }))).toBe(true);
    });

    it('with no list of what is still shared, everything of the notebook is held', () => {
      expect(awaitsInvitation(copy('n1', 'nb'), declinedNb())).toBe(true);
    });

    /**
     * While a decline is still on its way its shares are still listed, so the
     * exception applies to them: the invitation is PENDING then, and that is
     * what holds them, as it did before the press.
     */
    it('while the decline is on its way, the pending invitation holds its notes', () => {
      const onItsWay = declinedNb({ stillShared: new Set(['n1']), pending: new Set(['nb']) });
      expect(awaitsInvitation(copy('n1', 'nb'), onItsWay)).toBe(true);
    });

    /** After the exception the ordinary rules decide, as for any note shared on its own. */
    it('it follows the ordinary rules from there', () => {
      const listed = declinedNb({ stillShared: new Set(['n1']) });
      expect(awaitsInvitation(copy('n1', 'nb'), { ...listed, inboxKnown: false })).toBe(true);
      expect(awaitsInvitation(copy('n1', 'nb'), { ...listed, accepted: new Set(['nb']) })).toBe(false);
    });

    it('a copy with no share left is held against a stale acceptance too', () => {
      expect(awaitsInvitation(copy('left-behind', 'nb'), declinedNb({ stillShared: new Set(['other']), accepted: new Set(['nb']) }))).toBe(true);
      expect(awaitsInvitation(copy('left-behind', 'nb'), declinedNb({ stillShared: new Set(['other']), seenAccepted: new Set(['nb']) }))).toBe(true);
    });

    it('never a note our own vault opened', () => {
      expect(awaitsInvitation({ id: 'n1', openedVia: 'vault', ownerNotebookId: 'nb' }, declinedNb())).toBe(false);
    });
  });

  /**
   * Older versions of the app can empty the shared list of acceptances after
   * one failed inbox request. A notebook this DEVICE has seen accepted keeps
   * its notes on screen when that happens.
   */
  it('a notebook this device has seen accepted is not held when the list has lost it', () => {
    const wiped = state({ pending: new Set(['nb']) });
    expect(awaitsInvitation(theirs('nb'), wiped)).toBe(true);
    expect(awaitsInvitation(theirs('nb'), { ...wiped, seenAccepted: new Set(['nb']) })).toBe(false);
  });

  it('nor on a cold start, before the inbox has answered', () => {
    const cold = state({ inboxKnown: false });
    expect(awaitsInvitation(theirs('nb'), cold)).toBe(true);
    expect(awaitsInvitation(theirs('nb'), { ...cold, seenAccepted: new Set(['nb']) })).toBe(false);
  });

  it('a notebook the device has never seen accepted is still held', () => {
    expect(awaitsInvitation(theirs('new'), state({ pending: new Set(['new']), seenAccepted: new Set(['nb']) }))).toBe(true);
  });

  /** Declined here outranks what the device remembered: the reader has just said no. */
  it('a decline outranks the device\'s memory', () => {
    expect(awaitsInvitation(theirs('nb'), state({ declined: new Set(['nb']), seenAccepted: new Set(['nb']) }))).toBe(true);
  });

  /**
   * And the shared list, for as long as the two disagree: the write that takes
   * the acceptance off the list comes after the mark, and can fail or be merged.
   */
  it('a decline outranks an acceptance still on the shared list', () => {
    expect(awaitsInvitation(theirs('nb'), state({ declined: new Set(['nb']), accepted: new Set(['nb']) }))).toBe(true);
  });

  /**
   * A note shared on its own that sits in a notebook the owner later invites
   * the reader to is held while that invitation is unanswered. Each note of a
   * shared notebook has its own share row, so the two cannot be told apart.
   * Pinned so that changing it is a decision and not an accident.
   */
  it('a note shared on its own is held too once its notebook is offered (known)', () => {
    expect(awaitsInvitation(theirs('nb'), state({ pending: new Set(['nb']) }))).toBe(true);
  });
});

describe('the acceptance this device remembers', () => {
  /**
   * The memory holds notebook ids. A device that was closed while a notebook
   * was withdrawn and offered again never saw a list without it, so it still
   * remembers it, and shows its notes while the invitation reads "new".
   * Pinned so that changing it is a decision.
   */
  it('still remembers a notebook that was withdrawn and offered again while the device was away (known)', () => {
    const afterTheGap = rememberedAcceptances(['nb'], [], new Set(['nb']));
    expect(afterTheGap).toEqual(['nb']);
  });


  it('learns every acceptance on the shared list', () => {
    expect(rememberedAcceptances([], ['a', 'b'], null)).toEqual(['a', 'b']);
    expect(rememberedAcceptances(['a'], ['a', 'b'], null)).toEqual(['a', 'b']);
  });

  /** The case it exists for: the shared list came back empty and the notebook is still offered. */
  it('keeps a notebook the shared list has lost while the inbox still lists it', () => {
    expect(rememberedAcceptances(['a', 'b'], [], new Set(['a', 'b', 'c']))).toEqual(['a', 'b']);
  });

  /** Withdrawn, declined or left: the server no longer offers it, and a later invitation is a new question. */
  it('forgets a notebook the inbox no longer lists', () => {
    expect(rememberedAcceptances(['a', 'b'], ['a', 'b'], new Set(['a']))).toEqual(['a']);
    expect(rememberedAcceptances(['a'], [], new Set())).toEqual([]);
  });

  /** A failed or absent answer is not a list: one failed request must not make the device forget. */
  it('forgets nothing without a list', () => {
    expect(rememberedAcceptances(['a', 'b'], [], null)).toEqual(['a', 'b']);
  });

  it('never invents an acceptance from the inbox', () => {
    expect(rememberedAcceptances([], [], new Set(['offered']))).toEqual([]);
  });

  it('keeps each notebook once', () => {
    expect(rememberedAcceptances(['a', 'a'], ['a'], null)).toEqual(['a']);
  });

  it('reads what it stored, and anything else as nothing', () => {
    expect(parseRemembered(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
    expect(parseRemembered(null)).toEqual([]);
    expect(parseRemembered('')).toEqual([]);
    expect(parseRemembered('not json')).toEqual([]);
    expect(parseRemembered('{"a":1}')).toEqual([]);
    expect(parseRemembered('["a", 3, null, "", "a", "b"]')).toEqual(['a', 'b']);
  });
});

/**
 * A block declines that person's UNANSWERED notebooks. The server does it,
 * in the block's transaction, and has to be told which they are: what a
 * reader accepted is in their own encrypted settings.
 */
describe('the notebooks a block is to decline', () => {
  const rows = [
    { itemId: 'nb-sam-1', sharerEmail: 'Sam@Example.test' },
    { itemId: 'nb-sam-2', sharerEmail: ' sam@example.test ' },
    { itemId: 'nb-ann', sharerEmail: 'ann@example.test' },
    { itemId: 'nb-nobody', sharerEmail: null },
    { itemId: 'nb-sam-accepted', sharerEmail: 'sam@example.test' },
  ];
  const pending = new Set(['nb-sam-1', 'nb-sam-2', 'nb-ann', 'nb-nobody']);

  it('are that sender\'s invitations not answered here, whatever the case of the address', () => {
    expect(unansweredFrom('SAM@example.test ', pending, rows)).toEqual(['nb-sam-1', 'nb-sam-2']);
  });

  it('never one the reader accepted: it is not pending', () => {
    expect(unansweredFrom('sam@example.test', pending, rows)).not.toContain('nb-sam-accepted');
  });

  it('never one this page knows to be somebody else\'s, or nobody\'s', () => {
    const named = unansweredFrom('sam@example.test', pending, rows);
    expect(named).not.toContain('nb-ann');
    expect(named).not.toContain('nb-nobody');
  });

  /** An inbox longer than was read: the invitation is on offer, and its own row was not served. */
  it('and one the page has no row for: the server tells whose it is', () => {
    const more = new Set([...pending, 'nb-past-what-was-read']);
    expect(unansweredFrom('sam@example.test', more, rows)).toEqual(['nb-sam-1', 'nb-sam-2', 'nb-past-what-was-read']);
    // Named for anyone who is blocked: only the server knows whose it is.
    expect(unansweredFrom('ann@example.test', more, rows)).toEqual(['nb-ann', 'nb-past-what-was-read']);
  });

  it('none when nothing is pending', () => {
    expect(unansweredFrom('sam@example.test', new Set(), rows)).toEqual([]);
  });

  it('no more than the server takes in one block', () => {
    const many = new Set(Array.from({ length: UNANSWERED_MAX + 5 }, (_, i) => `nb-${i}`));
    expect(unansweredFrom('sam@example.test', many, [])).toHaveLength(UNANSWERED_MAX);
    expect(UNANSWERED_MAX).toBe(2000);
  });
});
