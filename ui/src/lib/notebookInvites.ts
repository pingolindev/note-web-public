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

/**
 * Notebooks other people have shared with this user, and whether they have
 * said yes to them yet.
 *
 * ## Why an invitation at all
 *
 * Sharing a notebook is not like sharing a note. A note arrives, you read it,
 * that is the whole transaction. A notebook is a place you are being added
 * to — its owner can keep putting notes in it, and (with a `contribute`
 * share) you can put notes in it too. Being enrolled in that silently, by
 * someone typing your address, is not something to do without asking.
 *
 * So a shared notebook starts as an INVITATION: it shows under "Shared
 * Notebooks" with its name and who sent it, and does nothing else until the
 * recipient accepts. Accepting is recorded in the recipient's own encrypted
 * metadata — it is their decision about their own view, and no one else's
 * business. Declining dismisses the shares that have arrived, the notebook's
 * and its notes', and the server writes any note the owner adds later
 * already dismissed (see `awaitsInvitation`).
 *
 * ## What this module is
 *
 * The decision logic, kept free of the store, the network and the inbox so it
 * can be tested directly. Reading a name out of a document another client
 * wrote is deliberately tolerant: a malformed one costs its own row, never the
 * whole section.
 */

/** The shape this needs from an inbox row — not the whole IncomingShare. */
export interface NotebookShareRow {
  shareId: string;
  itemId: string;
  sharerEmail: string | null;
  permission?: string;
  /** Decrypted content, if this client could open it. */
  note: { title?: string } | null;
  error: string | null;
}

export interface NotebookInvite {
  notebookId: string;
  /** The newest of the notebook's own share rows: the one the invitation shows. */
  shareId: string;
  /** EVERY share row of the notebook, newest first. Declining dismisses them all:
   *  one left standing would keep the invitation, and the notebook, on offer. */
  shareIds: string[];
  /** The notebook's name, or null when this client cannot read it. */
  name: string | null;
  sharer: string;
  /** The sender's address as the share carries it, or null when it carries none: what a block names. */
  sharerEmail: string | null;
  /**
   * The collection right the owner granted: `contribute` means the recipient
   * may add and remove notes, anything else is read-only membership.
   */
  permission: string;
  accepted: boolean;
  /**
   * True when the share arrived but could not be opened — a dropped signature,
   * a key we do not hold. Shown as unavailable rather than hidden: a share the
   * recipient was told about and cannot open is something they should see, not
   * a silent gap.
   */
  unreadable: boolean;
}

const UNKNOWN_SENDER = 'Unknown sender';

/**
 * Turn the notebook rows of an inbox into invitations.
 *
 * One invitation per notebook, the NEWEST row speaking for it. The rows come
 * in the server's order, which is newest share first, so that is the first
 * row met for each notebook — not the last row, which is the oldest. Sharing
 * a notebook again with the same address updates its row in place; two rows
 * for one notebook means it reached this account through two addresses.
 */
export function invitesFrom(
  rows: readonly NotebookShareRow[],
  acceptedIds: readonly string[],
): NotebookInvite[] {
  const accepted = new Set(acceptedIds);
  const byNotebook = new Map<string, NotebookInvite>();
  for (const row of rows) {
    const known = byNotebook.get(row.itemId);
    if (known) {
      known.shareIds.push(row.shareId);
      continue;
    }
    byNotebook.set(row.itemId, {
      notebookId: row.itemId,
      shareId: row.shareId,
      shareIds: [row.shareId],
      name: typeof row.note?.title === 'string' && row.note.title ? row.note.title : null,
      sharer: row.sharerEmail ?? UNKNOWN_SENDER,
      sharerEmail: row.sharerEmail,
      permission: row.permission ?? 'view',
      accepted: accepted.has(row.itemId),
      unreadable: row.note === null,
    });
  }
  return [...byNotebook.values()];
}

/** Invitations still awaiting a decision — what the section badges. */
export function pendingInvites(invites: readonly NotebookInvite[]): NotebookInvite[] {
  return invites.filter(i => !i.accepted);
}

/** The notebooks somebody shared with this user that they have not accepted. */
export function pendingNotebookIds(
  sharedNotebookIds: readonly string[],
  acceptedIds: readonly string[],
): Set<string> {
  const accepted = new Set(acceptedIds);
  return new Set(sharedNotebookIds.filter(id => !accepted.has(id)));
}

/** The most notebooks one block names as unanswered: the server's own limit. */
export const UNANSWERED_MAX = 2000;

/**
 * The notebooks a block of `address` is to DECLINE: that person's invitations
 * the reader has not answered.
 *
 * A block dismisses everything its sender has shared. Dismissed alone, an
 * unanswered notebook would not be a declined one: a note somebody ELSE then
 * added to it would arrive, in a notebook the reader had never taken. The
 * server declines them in the block's own transaction, and has to be told
 * which they are: what a reader accepted is kept in their own encrypted
 * settings.
 *
 * Named: the unanswered invitations whose row this page has read and that are
 * this sender's, and those it has no row for at all (an inbox longer than was
 * read: the server tells whose they are, and declines only this sender's).
 * Nothing of anybody this page KNOWS to be someone else is named.
 */
export function unansweredFrom(
  address: string,
  pending: ReadonlySet<string>,
  rows: readonly { itemId: string; sharerEmail: string | null }[],
): string[] {
  const sender = address.trim().toLowerCase();
  const senderOf = new Map<string, string>();
  for (const row of rows) senderOf.set(row.itemId, (row.sharerEmail ?? '').trim().toLowerCase());
  return [...pending]
    .filter((id) => {
      const known = senderOf.get(id);
      return known === undefined || known === sender;
    })
    .slice(0, UNANSWERED_MAX);
}

/** What is known, right now, about the invitations this user holds. */
export interface InvitationState {
  /** Invited and not answered. */
  pending: ReadonlySet<string>;
  /** Invited and accepted. */
  accepted: ReadonlySet<string>;
  /**
   * The inbox has answered at least once on this page (with a list, or with a
   * failure). Until it has, `pending` is empty because nothing is known, not
   * because nothing is pending.
   */
  inboxKnown: boolean;
  /**
   * Notebooks the reader said no to: on this page, or (on the server's word)
   * on another device or before a reload. Declining dismisses the shares, so
   * the notebook stops being `pending` at once, while its notes stay in
   * memory until the next completed sync takes them out. Absent = none.
   */
  declined?: ReadonlySet<string>;
  /**
   * The ids of the received notes the inbox, as last applied, still holds a
   * share of. Only read for a note of a `declined` notebook: such a note is
   * the reader's in its own right, and a decline does not hold it. Absent =
   * none.
   */
  stillShared?: ReadonlySet<string>;
  /**
   * Notebooks this device has seen ACCEPTED (lib/notebookInvites, "the
   * acceptance this device remembers"). Absent = none.
   */
  seenAccepted?: ReadonlySet<string>;
}

/**
 * Whether a note is waiting on an invitation its reader has not accepted.
 *
 * The invitation above promises that a shared notebook "does nothing else
 * until the recipient accepts". Its notes arrive all the same: each is shared
 * on its own row, so without this they would be in the reader's Notes grid
 * before the question had been answered. Such a note is held out of the
 * reader's own lists until they accept; it stays under "Shared with me".
 *
 * Only a note a SHARE'S key opened can be held: a note our own vault opened
 * is ours, and no invitation, real or made up by a server, takes it off the
 * screen. It is matched by the owner's notebook id alone, never by
 * `notebookId`, which names a notebook of ours.
 *
 * Before the inbox has answered, a received note in a notebook we have not
 * accepted is held too. The grid paints from the cache before the inbox is
 * asked, so without this every cold start would show the held notes and then
 * take them away. What that costs is small: a note shared on its own out of
 * somebody's notebook, with no invitation behind it, appears when the inbox
 * answers rather than at once. A failed answer counts as an answer, so offline
 * nothing stays held on a guess.
 *
 * Three more rules, in this order:
 *
 * - A notebook the reader has just DECLINED holds its notes. Without it,
 *   pressing Decline would put the declined notebook's notes INTO the grid:
 *   it stops being pending while they are still in memory.
 * - A notebook the list says is accepted holds nothing.
 * - A notebook this DEVICE has seen accepted holds nothing either, even when
 *   the list has lost it. The list is one encrypted document shared by every
 *   device, and older builds still in people's hands — the Note Android
 *   app's native sync and older web bundles, including the ones inside
 *   installed apps — empty it after a single failed inbox request. With the
 *   hold, that would take the notebook's notes off the screen on every
 *   device, again and again. The invitation still asks again; the notes stay.
 *
 * Deliberately left as it is: a note shared ON ITS OWN that sits in a
 * notebook the owner later invites the reader to is held while that
 * invitation is unanswered. Every note of a shared notebook has its own share
 * row, so the only thing that tells the two apart is which row is older, and
 * that is the server's `created_at`: the hold would then rest on a timestamp
 * the server chooses, for a case that costs one note of somebody else's a
 * place in the grid until an invitation is answered. (Re-sharing does not
 * rewrite those timestamps.)
 *
 * Also accepted:
 * - The device remembers notebook IDS. A device that was closed while a
 *   notebook was withdrawn and offered again never saw it unlisted, so it
 *   still counts it as seen accepted and shows its notes while the invitation
 *   reads "new".
 * - "Listed" counts every notebook row the server sends, the ones this page
 *   refuses included. That is what keeps an acceptance through a sender's key
 *   change, and a forged row and a rotated key look the same until the reader
 *   approves the key. A row keeps an acceptance and a memory alive; it never
 *   opens anything.
 *
 * A note the owner adds to a declined notebook LATER does not arrive as a
 * note of its own: the server writes it already dismissed.
 *
 * `declined` also carries the notebooks the SERVER says were declined, for
 * the device that did NOT decline. It holds the notebook's notes in memory,
 * and the next inbox answer no longer lists the invitation: nothing is
 * pending, so until the sync that follows takes the copies out they would
 * stand in the grid, as on the device that declined.
 *
 * And one exception, for both. A note that still has a share of its OWN in
 * the inbox (`stillShared`) is not held by a decline. It is a note the reader
 * holds in its own right: shared with them by itself, and filed into that
 * notebook by its owner afterwards. It was never part of what they declined,
 * and a decline must not take it off their screen for good. (The decline
 * itself dismisses every share of a note that is in the notebook THEN, so
 * what is left in memory afterwards has no share and stays held; while a
 * decline is still on its way the invitation is pending, which holds them.)
 */
export function awaitsInvitation(
  note: { id?: string; openedVia?: 'vault' | 'share'; ownerNotebookId?: string | null },
  state: InvitationState,
): boolean {
  if (note.openedVia !== 'share' || !note.ownerNotebookId) return false;
  const notebook = note.ownerNotebookId;
  if (state.declined?.has(notebook)) {
    const sharedInItsOwnRight = note.id !== undefined && state.stillShared?.has(note.id) === true;
    if (!sharedInItsOwnRight) return true;
  }
  if (state.accepted.has(notebook) || state.seenAccepted?.has(notebook)) return false;
  return state.pending.has(notebook) || !state.inboxKnown;
}

/**
 * The acceptance this device remembers.
 *
 * Kept on the device, per account, beside the shared list and never instead of
 * it: it is not sent anywhere, it accepts nothing, and the invitation's own
 * row still reads "new" when the shared list has lost the notebook. All it
 * decides is that notes the reader had on this screen are not taken off it by
 * another client's mistake (see `awaitsInvitation`).
 *
 * @param seen      what the device remembered
 * @param accepted  the shared list as it is now
 * @param listed    every notebook the inbox LISTS, blocked rows included, or
 *                  null when the inbox has not answered with a list. Only a
 *                  list can make the device forget: a notebook the server no
 *                  longer offers was withdrawn, declined or left, and a later
 *                  invitation to it is a new question.
 */
export function rememberedAcceptances(
  seen: readonly string[],
  accepted: readonly string[],
  listed: ReadonlySet<string> | null,
): string[] {
  const all = [...new Set([...seen, ...accepted])];
  return listed === null ? all : all.filter(id => listed.has(id));
}

/** What a device kept under its account, read tolerantly: anything else is "nothing remembered". */
export function parseRemembered(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((v): v is string => typeof v === 'string' && v !== ''))] : [];
  } catch {
    return [];
  }
}

/**
 * What to call a notebook this client cannot read.
 *
 * Never a blank row: the recipient was told something was shared with them, so
 * the row has to say so even when its name is out of reach.
 */
export function displayName(invite: NotebookInvite): string {
  return invite.name ?? 'Unavailable notebook';
}

/**
 * Recording an acceptance. Idempotent — accepting twice (two tabs, a double
 * click) must not put the id in the list twice.
 */
export function withAccepted(acceptedIds: readonly string[], notebookId: string): string[] {
  return acceptedIds.includes(notebookId) ? [...acceptedIds] : [...acceptedIds, notebookId];
}

/**
 * Forgetting one, so a re-share can be offered again.
 *
 * Used on decline as well as on removal: leaving a declined notebook in the
 * accepted list would make a later re-invitation land already-accepted.
 */
export function withoutAccepted(acceptedIds: readonly string[], notebookId: string): string[] {
  return acceptedIds.filter(id => id !== notebookId);
}

/**
 * Accepted ids that no longer correspond to anything in the inbox.
 *
 * The owner can remove someone, or delete the notebook; the acceptance would
 * otherwise sit in the recipient's metadata forever. Cleaning it is also what
 * makes a re-invitation to the same notebook arrive as a fresh question rather
 * than silently pre-accepted.
 */
export function staleAcceptances(
  acceptedIds: readonly string[],
  liveNotebookIds: ReadonlySet<string>,
): string[] {
  return acceptedIds.filter(id => !liveNotebookIds.has(id));
}

/**
 * What this invitation actually grants, in the recipient's words.
 *
 * "Can read" and "can add and remove notes" are different things to agree to,
 * and an invitation that does not say which is being offered is asking someone
 * to accept an unknown. The mobile apps say it too.
 */
export function inviteGrantText(invite: NotebookInvite): string {
  if (invite.unreadable) {
    return "This notebook could not be opened — what arrived was incomplete or couldn't be confirmed as coming from the sender. Ask the sender to share it again.";
  }
  return invite.permission === 'contribute'
    ? 'You will be able to read the notes in it, and add and remove notes yourself.'
    : 'You will be able to read the notes in it.';
}
