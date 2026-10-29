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
 * Who a new note in a shared notebook has to be sealed to.
 *
 * ## Why this is not just "the roster"
 *
 * When the OWNER adds a note, the answer is their standing recipient list —
 * that is what `notebookShares` in their metadata has always been for.
 *
 * When a MEMBER adds one, they have no such list. What they have is the
 * roster inside the notebook item, which is precisely why the roster is
 * shared rather than kept in the owner's metadata: a member who cannot read
 * the member list cannot wrap a note for the others, and a note only they can
 * read is not a contribution to anything.
 *
 * Two things the roster alone gets wrong, and both would produce a note that
 * silently reaches the wrong set of people:
 *
 *  1. **The owner is not in it.** The roster lists people the notebook was
 *     shared WITH. A member sealing only to the roster writes a note into
 *     someone's notebook that its owner cannot open.
 *  2. **You are in it.** Sealing a note to yourself is a wasted share row and,
 *     on the receiving side, a share from yourself — which the inbox has no
 *     sensible way to render.
 */

import type { NotebookMember } from './notebookItem';

/** A person to seal a new note's content key to. */
export interface FanOutRecipient {
  email: string;
  permission: 'edit' | 'view';
  publicKey: string | null;
  userId?: string | null;
  signingPublicKey?: string | null;
}

/**
 * The people a note added to `notebookId` must reach, from the point of view of
 * whoever is adding it.
 *
 * `ownerEmail` is the notebook's owner — null when WE are the owner, in which
 * case there is nobody above us to include. Anyone in the roster without a
 * sharing key is dropped: they cannot be sealed to, and keeping them would make
 * "shared with N people" a claim the crypto cannot honour.
 */
export function recipientsForNewNote(opts: {
  roster: readonly NotebookMember[];
  ownerEmail: string | null;
  myEmail: string | null;
}): FanOutRecipient[] {
  const me = opts.myEmail?.toLowerCase() ?? null;
  const seen = new Set<string>();
  const out: FanOutRecipient[] = [];

  for (const m of opts.roster) {
    const email = m.email.toLowerCase();
    if (email === me || seen.has(email) || !m.sharingPublicKey) continue;
    seen.add(email);
    out.push({
      email: m.email,
      // A note share is edit-or-view; `contribute` is a collection right and
      // would read as "no write" on a note row.
      permission: m.permission === 'view' ? 'view' : 'edit',
      publicKey: m.sharingPublicKey,
      userId: m.userId,
      signingPublicKey: m.signingPublicKey,
    });
  }

  // The owner last, and only when it is not us. Their key is not in the roster
  // — the caller looks it up — so this entry carries a null publicKey for the
  // caller to fill in.
  const owner = opts.ownerEmail?.toLowerCase() ?? null;
  if (owner && owner !== me && !seen.has(owner)) {
    out.push({
      email: opts.ownerEmail!,
      // The owner can always write their own notebook's notes.
      permission: 'edit',
      publicKey: null,
      userId: null,
      signingPublicKey: null,
    });
  }
  return out;
}

/** Recipients still missing a key, which the caller must look up before sealing. */
export function needsKeyLookup(recipients: readonly FanOutRecipient[]): string[] {
  return recipients.filter(r => !r.publicKey).map(r => r.email);
}

/**
 * Fill in keys fetched from the directory.
 *
 * Anyone still without one is DROPPED rather than sealed to with a placeholder:
 * a share with no key is a row the recipient can never open, and it would make
 * the note look shared when it is not.
 */
export function withLookedUpKeys(
  recipients: readonly FanOutRecipient[],
  found: ReadonlyMap<string, { sharingPub: string; userId: string | null; signingPub: string | null }>,
): FanOutRecipient[] {
  return recipients.flatMap(r => {
    if (r.publicKey) return [r];
    const entry = found.get(r.email.toLowerCase());
    if (!entry) return [];
    return [{
      ...r,
      publicKey: entry.sharingPub,
      userId: entry.userId,
      signingPublicKey: entry.signingPub,
    }];
  });
}
