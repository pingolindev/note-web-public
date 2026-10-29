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
 * Shares the owner is making right now, by notebook and address.
 *
 * A share made in the Share panel writes the person's entry on the notebook's
 * standing list LAST (components/SharePanel: the removal ended, the notebook,
 * its notes, then the entry). Until then they read as gone from the list. An
 * invitation's finish that looked then would take back what the owner was
 * giving them: the roster entry and the notebook's own row would go, while
 * the notes and the keyed entry stayed — notes with no invitation. So a
 * finish waits for such a share to end before it takes anything back, and
 * reads this page's list again (lib/finishInvitations).
 *
 * One page's memory. A share made in another tab or on another device is the
 * server's list to tell, and the finish reads that again before it shares the
 * notebook, not before a take-back, which goes by this page's list: such a
 * share made while a finish takes the person back can go with it.
 */

const inFlight = new Map<string, Set<Promise<void>>>();
const key = (notebookId: string, email: string) => `${notebookId}\n${email.trim().toLowerCase()}`;

/** Marks a share of `email` in `notebookId` as being made now. Call the answer
 *  once it has ended, however it ended (a second call does nothing). */
export function beginOwnerShare(notebookId: string, email: string): () => void {
  const k = key(notebookId, email);
  let resolve!: () => void;
  const ended = new Promise<void>(r => { resolve = r; });
  const shares = inFlight.get(k) ?? new Set<Promise<void>>();
  shares.add(ended);
  inFlight.set(k, shares);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    shares.delete(ended);
    if (shares.size === 0 && inFlight.get(k) === shares) inFlight.delete(k);
    resolve();
  };
}

/** Resolves when every share of `email` the owner is making in `notebookId`
 *  has ended, one begun meanwhile included; at once when there is none. */
export async function ownerSharesSettled(notebookId: string, email: string): Promise<void> {
  for (;;) {
    const shares = inFlight.get(key(notebookId, email));
    if (!shares || shares.size === 0) return;
    await Promise.all([...shares]);
  }
}
