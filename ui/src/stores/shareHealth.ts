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
 * Who on a notebook's standing share list is NOT receiving new notes, and why.
 *
 * A note added to a shared notebook is sealed to every standing recipient in
 * the background. When that fails — most often because the recipient reset
 * their password, so their key no longer matches the one this browser pinned —
 * no share row is written: the recipient's side shows nothing at all, not even
 * a blocked share, while the owner's panel still lists them under "People with
 * access". This is what the sidebar badge and the Share panel read to say so.
 *
 * In memory, rebuilt each load: `refresh()` re-derives the key-change half
 * from the directory and the pins (the durable facts), and the background
 * fan-out records everything else as it happens.
 */
import { createSignal } from 'solid-js';
import { getPinnedUserKeys } from '../lib/crypto';
import { classifyRecipientKey, lookupDirectoryKeys } from '../lib/recipientKeys';
import type { ShareOutcome } from '../lib/shareUtils';
import { notebooksStore } from './notebooks';

/**
 *  - `key-changed`: their key differs from the one pinned here; nothing is
 *    sealed to it until the owner compares safety numbers and approves it.
 *  - `stale-key`: their new key is approved here (the pin matches), but this
 *    notebook's shares were sealed to their OLD one — approving in one
 *    notebook re-seals that notebook only. New notes reach them; the notes
 *    already here need "Update to their new key" in this notebook's panel.
 *  - `cannot-sign`: this browser has no signing key, so it will not send a
 *    wrap the recipient's app would have to reject.
 *  - `failed`: the share request itself failed.
 */
export type NotReceivingReason = 'key-changed' | 'stale-key' | 'cannot-sign' | 'failed';

type Health = Record<string, Record<string, NotReceivingReason>>;

const [health, setHealth] = createSignal<Health>({});

function setReason(notebookId: string, email: string, reason: NotReceivingReason | null): void {
  const emailLc = email.toLowerCase();
  setHealth(prev => {
    const current = prev[notebookId] ?? {};
    if ((current[emailLc] ?? null) === reason) return prev;
    const nextForNotebook = { ...current };
    if (reason) nextForNotebook[emailLc] = reason;
    else delete nextForNotebook[emailLc];
    const next = { ...prev };
    if (Object.keys(nextForNotebook).length === 0) delete next[notebookId];
    else next[notebookId] = nextForNotebook;
    return next;
  });
}

/** The reason a failed share maps to, or null for a success. */
export function reasonFor(outcome: ShareOutcome): NotReceivingReason | null {
  if (outcome.ok) return null;
  if (outcome.reason === 'key-changed') return 'key-changed';
  if (outcome.reason === 'cannot-sign') return 'cannot-sign';
  return 'failed';
}

export const shareHealthStore = {
  /** People on `notebookId`'s standing list who are not receiving new notes. */
  notReceiving(notebookId: string): { email: string; reason: NotReceivingReason }[] {
    const forNotebook = health()[notebookId] ?? {};
    return Object.entries(forNotebook).map(([email, reason]) => ({ email, reason }));
  },

  /** Note the outcome of sealing a new note in `notebookId` to `email`. A
   *  success clears whatever was recorded for them. */
  record(notebookId: string, email: string, outcome: ShareOutcome): void {
    // A new note reaching them says nothing about the notes already sealed to
    // their old key: only re-sealing the notebook (clear) ends `stale-key`.
    const recorded = health()[notebookId]?.[email.toLowerCase()] ?? null;
    if (outcome.ok && recorded === 'stale-key') return;
    setReason(notebookId, email, reasonFor(outcome));
  },

  /** Forget what was recorded for `email` in `notebookId` (after the owner
   *  approved their new key and re-shared). */
  clear(notebookId: string, email: string): void {
    setReason(notebookId, email, null);
  },

  /**
   * Compare every standing recipient's CURRENT directory key with the key
   * pinned for them here, and flag the ones that changed. One batched lookup
   * for all shared notebooks. A failed lookup changes nothing — "could not
   * check" must never clear a flag, or a network blip would hide a key change.
   */
  async refresh(): Promise<void> {
    const pairs: { notebookId: string; email: string; cachedUserId: string | null; cachedKey: string | null }[] = [];
    for (const nb of notebooksStore.notebooks()) {
      for (const r of notebooksStore.getNotebookShares(nb.id)) {
        pairs.push({ notebookId: nb.id, email: r.email, cachedUserId: r.userId ?? null, cachedKey: r.publicKey ?? null });
      }
    }
    if (pairs.length === 0) return;
    const dir = await lookupDirectoryKeys(pairs.map(p => p.email));
    if (!dir) return;
    for (const p of pairs) {
      const current = dir.get(p.email.toLowerCase());
      const userId = current?.userId ?? p.cachedUserId;
      const pin = userId ? getPinnedUserKeys(userId) : null;
      const status = classifyRecipientKey(pin, current);
      const recorded = health()[p.notebookId]?.[p.email.toLowerCase()] ?? null;
      const staleHere = status === 'matched' && !!current && !!p.cachedKey &&
        p.cachedKey.toLowerCase() !== current.sharingPub.toLowerCase();
      if (status === 'changed') setReason(p.notebookId, p.email, 'key-changed');
      else if (staleHere) setReason(p.notebookId, p.email, 'stale-key');
      else if (recorded === 'key-changed' || recorded === 'stale-key') setReason(p.notebookId, p.email, null);
    }
  },

  reset(): void {
    setHealth({});
  },
};
