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
 * What Note says when notes are locked — pure, so the words are testable.
 *
 * Two different locks, two different remedies:
 *  - the TAB has no keys at all (keysUnavailableCopy): unlock at the account
 *    portal, where a sign-in hands the key back;
 *  - some of the account's OWN notes do not open with its current key
 *    (lockedNotesHeadline): an email password reset replaced the keypair, and
 *    the recovery key from before the reset restores them.
 */

export type KeysUnavailableReason = 'not-federated' | 'no-server-key' | 'unreachable' | 'app';

const KEYS_UNAVAILABLE: Record<KeysUnavailableReason, { title: string; body: string }> = {
  'not-federated': {
    title: 'Your notes are locked in this tab',
    body: "This tab couldn't unlock your encrypted notes, so they can't be opened or saved here. Unlock in your account to restore them — nothing has been lost.",
  },
  'no-server-key': {
    title: 'Unlock your notes in this browser',
    body: "This browser hasn't unlocked your encrypted notes yet. Unlock with your password in your account to open and save them here — nothing has been lost.",
  },
  unreachable: {
    title: 'Your notes are locked for now',
    body: "We couldn't reach the server to unlock your encrypted notes, so they can't be opened or saved yet. They unlock when the connection is back — nothing has been lost.",
  },
  // The iOS shell keeps the keys in the app and hands this page only what it
  // needs; if it handed nothing, only the app can fix it.
  app: {
    title: 'Your notes are locked in this app',
    body: "The app couldn't unlock your encrypted notes on this screen, so they can't be opened or saved. Sign out and sign in again in the app to unlock them — nothing has been lost.",
  },
};

/** Whether the notice offers the portal's Unlock. Not in the iOS key-bridge
 *  shell: a portal sign-in hands keys to a browser tab, not to the app. */
export function offersPortalUnlock(reason: KeysUnavailableReason): boolean {
  return reason !== 'app';
}

export function keysUnavailableCopy(reason: KeysUnavailableReason): { title: string; body: string } {
  return KEYS_UNAVAILABLE[reason];
}

/** The account portal's card that restores notes from before a reset. The
 *  anchor is the portal's; without it the link still lands on Settings. */
export const PRE_RESET_SETTINGS_PATH = '/settings#pre-reset-data';

export function lockedNotesHeadline(count: number): string {
  return count === 1
    ? '1 note from before your password reset is locked.'
    : `${count} notes from before your password reset are locked.`;
}

export const LOCKED_NOTES_HOW_TO =
  'If you still have your recovery key, restore them in Account → Settings → ' +
  'Data from before your password reset.';
