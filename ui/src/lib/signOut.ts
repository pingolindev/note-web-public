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
 * The web page's own sign-out, once its dialog has been answered (NotesView;
 * the shells have their own).
 *
 * Signing out clears this device's data, the queue of what is waiting to sync
 * included: an edit made offline, and a removal that still owes its sharing
 * (the person it takes off can open the note until it goes). What is waiting is
 * sent first, for ten seconds at most. If anything is still waiting then, the
 * person is asked once more. A count that cannot be read is asked about too:
 * "could not tell" is never "nothing left".
 */
import type { ConfirmOptions } from '../components/ConfirmDialog';

export const SEND_FIRST_MS = 10_000;

/** What the person is asked when changes are still waiting. */
export const LEFT_QUESTION: ConfirmOptions = {
  message: "Some changes haven't synced yet.",
  detail: "If you sign out now, they'll be lost.",
  confirmLabel: 'Sign out anyway',
  cancelLabel: 'Stay signed in',
  destructive: true,
};

export interface SignOutSteps {
  /** Send what is waiting (notesStore.flushPending). */
  flush: () => Promise<void>;
  /** How many changes are still waiting; throws when that cannot be read. */
  waiting: () => Promise<number>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  logout: () => void | Promise<void>;
  /** A pause (for tests). */
  pause?: (ms: number) => Promise<void>;
}

/** Signs out, unless the person chose to stay signed in: true when it signed out. */
export async function signOutAfterSending(steps: SignOutSteps): Promise<boolean> {
  const pause = steps.pause ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  await Promise.race([steps.flush().catch(() => undefined), pause(SEND_FIRST_MS)]);
  let left: number;
  try {
    left = await steps.waiting();
  } catch {
    left = 1;
  }
  if (left > 0 && !(await steps.confirm(LEFT_QUESTION))) return false;
  await steps.logout();
  return true;
}
