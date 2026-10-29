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
 * "Blocked people": the words, and the two small decisions, of the Settings
 * section and of the Block action on an invitation.
 *
 * A section in Settings where you can add a user's address. The server keeps
 * a block list (POST /api/v1/shares/block, POST /api/v1/shares/unblock, GET
 * /api/v1/shares/blocks). Besides the Block action on a shared NOTE's card,
 * this is where someone can say "not from this person" — declining an
 * invitation alone lets its sender invite them again — and the section is
 * shown, with a field to add an address, even while the list is empty.
 *
 * The wording is product copy and only changes deliberately. "even
 * after changing their email address" holds because the server applies a
 * block to the account it is tied to, not only to the address (as in Track).
 */
export const BLOCKED_PEOPLE = {
  title: 'Blocked people',
  description: "People you block can't share notes or notebooks with you, even after changing their email address. They are not notified.",
  fieldLabel: 'Email address',
  block: 'Block',
  unblock: 'Unblock',
  empty: "You haven't blocked anyone.",
} as const;

/** Something@something.something, with no spaces: enough to tell an address from a slip of the hand. */
const LOOKS_LIKE_AN_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The address to block for what was typed, or null when there is nothing to
 * send: not an address, or one that is already on the list (in any case: the
 * server keeps one row per address whatever its case).
 */
export function addressToBlock(typed: string, blocked: readonly { blocked_email: string }[]): string | null {
  const address = typed.trim();
  if (!LOOKS_LIKE_AN_ADDRESS.test(address)) return null;
  const lower = address.toLowerCase();
  return blocked.some(b => b.blocked_email.toLowerCase() === lower) ? null : address;
}

/**
 * The list as it is shown: by address, whatever its case. Compared as plain
 * text, so that the order is the same in every browser and language.
 */
export function inListOrder<B extends { blocked_email: string }>(blocked: readonly B[]): B[] {
  const key = (b: B) => b.blocked_email.toLowerCase();
  return [...blocked].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Is this share from that address? Addresses are compared whatever their case. */
export function isFrom(sharerEmail: string | null | undefined, email: string): boolean {
  return (sharerEmail ?? '').toLowerCase() === email.toLowerCase();
}

/** Whether the server's list has been read on this page: not yet, yes, or it could not be. */
export type BlockedListRead = 'loading' | 'read' | 'unread';

/**
 * What stands under the field. "You haven't blocked anyone." is a statement
 * about the server's list, so it is made only once that list has been READ:
 * otherwise a list that could not be read would say it too, to someone with
 * a list full of people.
 */
export function blockedListView(count: number, read: BlockedListRead): 'people' | 'nobody' | 'unread' | 'nothing' {
  if (count > 0) return 'people';
  if (read === 'read') return 'nobody';
  return read === 'unread' ? 'unread' : 'nothing';
}

/** A block or an unblock the server TOOK on this page, since it opened. */
export interface Settled {
  blocked: boolean;
  /** The address as it was typed or listed. */
  address: string;
  at: string;
}

/**
 * The list to show: the list as read just now (or what was on screen, when it
 * could not be read), put right by what the server has TAKEN on this page.
 *
 * @param listed  the list as read back just now, or null when it could not be
 * @param shown   what was on screen
 * @param settled the blocks and unblocks the server took on this page, by
 *                lower-cased address
 *
 * The list is read from a replica, which can be a moment behind. An address is
 * on the list, or off it, because the server said so when it took the request;
 * a read can add to that and never take it back. Without this:
 *
 * - a block would be missing from the read that followed it, until the next
 *   visit;
 * - a second block's read would drop the FIRST again, and an unblock's read
 *   would bring its row back.
 */
export function listAsKnown<T extends { blocked_email: string; created_at: string }>(
  listed: readonly T[] | null,
  shown: readonly T[],
  settled: ReadonlyMap<string, Settled>,
): (T | { blocked_email: string; created_at: string })[] {
  const key = (address: string) => address.toLowerCase();
  const out: (T | { blocked_email: string; created_at: string })[] =
    (listed ?? shown).filter(b => settled.get(key(b.blocked_email))?.blocked !== false);
  for (const [address, s] of settled) {
    if (s.blocked && !out.some(b => key(b.blocked_email) === address)) {
      out.push({ blocked_email: s.address, created_at: s.at });
    }
  }
  return out;
}

/**
 * What is known of the list after a block or an unblock the server TOOK.
 *
 * Read just now: 'read'. Not read, and never read on this page: nothing is
 * said about it ('loading', which shows no words). 'unread' would put "That
 * didn't go through" under an action that did: someone whose list could not
 * be read when the page opened, who blocked an address and unblocked it
 * again, would be told so.
 */
export function readAfterAction(before: BlockedListRead, readNow: boolean): BlockedListRead {
  if (readNow || before === 'read') return 'read';
  return 'loading';
}
