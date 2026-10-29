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
 * Is the key a share would be sealed to still the key we trust for that person?
 *
 * The SENDER side of key-change handling, beside the alarm for SENDERS of
 * incoming shares on the inbox. When the person you share WITH resets their
 * password, every new share to them is refused by the pin; without this the
 * only advice would be "Ask them to re-share", which they cannot follow,
 * while a shared notebook went on "sharing" new notes to the key cached when
 * they were invited, which they no longer hold — and nothing on the owner's
 * screen would change.
 *
 * Pure helpers plus the one directory call; the stores and the Share panel
 * decide what to do with the answer.
 */
import { apiRequest, type ApiResponse } from './apiClient';

/** A person's CURRENT keys as the account directory publishes them. */
export interface DirectoryKeys {
  userId: string;
  /** X25519 sharing public key, hex. */
  sharingPub: string;
  /** Ed25519 signing public key, hex. */
  signingPub: string;
}

/** The server's per-request cap on a key lookup. */
const LOOKUP_BATCH = 100;

/**
 * The directory's current keys, keyed by lower-cased email, for every address
 * that has an account with a full key set. Null when the lookup itself failed:
 * callers must read that as "unknown" — never as "nobody has a key", which
 * would un-flag a changed key on a network blip.
 */
export async function lookupDirectoryKeys(emails: string[]): Promise<Map<string, DirectoryKeys> | null> {
  const unique = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))];
  const out = new Map<string, DirectoryKeys>();
  for (let i = 0; i < unique.length; i += LOOKUP_BATCH) {
    const r = await apiRequest<{
      users: { email: string; user_id: string | null; sharing_public_key: string | null; signing_public_key: string | null }[];
    }>('/api/v1/users/public-keys', { method: 'POST', body: { emails: unique.slice(i, i + LOOKUP_BATCH) } });
    if (!r.success) return null;
    for (const u of r.data.users ?? []) {
      if (u.user_id && u.sharing_public_key && u.signing_public_key) {
        out.set(u.email.toLowerCase(), {
          userId: u.user_id,
          sharingPub: u.sharing_public_key,
          signingPub: u.signing_public_key,
        });
      }
    }
  }
  return out;
}

/** One entry of the directory's answer, as the server sends it. */
export interface DirectoryEntry {
  email?: string;
  user_id?: string | null;
  sharing_public_key?: string | null;
  signing_public_key?: string | null;
}

/**
 * What the directory said about the address a share is going to, and about
 * this account's own published signing key (asked in the same request).
 */
export type RecipientLookup =
  /** The directory did not answer. Nothing is known, and nothing may be shared on it. */
  | { answered: false }
  | {
    answered: true;
    /** All null for an address with no account (or one that has published no key). */
    publicKey: string | null;
    userId: string | null;
    signingPublicKey: string | null;
    /** This account's signing key as the directory publishes it, when it said. */
    myPublishedSigning: string | null;
  };

/**
 * Read the Share panel's key lookup.
 *
 * NO ANSWER IS NOT "NO ACCOUNT". A lookup that failed (502 when the account
 * service is unreachable, 429 at its rate limit, which it shares with every
 * inbox refresh) read as an empty answer, and an empty answer read as an
 * address with no account, would send a share to somebody WITH an account
 * with nothing sealed: a note they could not open, and for a notebook no
 * invitation at all, with the person put on the standing list, so that every
 * later note reached them readable and with nothing to answer.
 *
 * "No account" is only what an ANSWER says: the address's entry carries no
 * key, or the answer has no entry for it.
 */
export function readRecipientLookup(
  result: ApiResponse<{ users?: DirectoryEntry[] }>,
  address: string,
  myEmail: string | null,
  myUserId: string | null = null,
): RecipientLookup {
  if (!result.success) return { answered: false };
  const users = result.data?.users;
  // An answer in no known shape says nothing either.
  if (!Array.isArray(users)) return { answered: false };
  const byEmail = (e: string) => users.find(u => u?.email?.toLowerCase() === e.toLowerCase());
  const mine = myEmail ? byEmail(myEmail) : undefined;
  // Our own entry, however the server spells our address back: by the account
  // it names as well. Found by address alone, an own entry spelt differently
  // would not be "mine", and the fallback below would take it for the
  // recipient's.
  const me = myUserId?.toLowerCase() ?? null;
  const isMine = (u: DirectoryEntry | undefined) =>
    u !== undefined && (u === mine || (me !== null && typeof u.user_id === 'string' && u.user_id.toLowerCase() === me));
  // Matched on the address. By position only as a fallback for a server that
  // spells the address back differently, and never onto this account's OWN
  // entry: sealing somebody's share to our own key under their address would
  // look shared and open for nobody.
  const first = users[0];
  const theirs = byEmail(address) ?? (first && !isMine(first) ? first : undefined);
  return {
    answered: true,
    publicKey: theirs?.sharing_public_key ?? null,
    userId: theirs?.user_id ?? null,
    signingPublicKey: theirs?.signing_public_key ?? null,
    myPublishedSigning: mine?.signing_public_key ?? null,
  };
}

/**
 *  - `no-account`: the directory has no key set for the address — they have
 *    not signed up yet (or the lookup could not say).
 *  - `first-contact`: keys exist and this browser has never pinned them.
 *  - `matched`: the directory's keys are the ones pinned.
 *  - `changed`: the directory's keys differ from the pin. Usually a password
 *    reset; indistinguishable on the wire from a server substituting a key, so
 *    nothing is sealed to the new key until the user approves it.
 */
export type RecipientKeyStatus = 'no-account' | 'first-contact' | 'matched' | 'changed';

export function classifyRecipientKey(
  pin: { sharingPubkeyHex: string; signingPubkeyHex: string; conflict?: true } | null,
  dir: DirectoryKeys | undefined,
): RecipientKeyStatus {
  if (!dir) return 'no-account';
  if (!pin) return 'first-contact';
  // Records that disagreed (lib/pinMerge.ts): changed, whatever the keys.
  if (pin.conflict) return 'changed';
  const same =
    pin.sharingPubkeyHex.toLowerCase() === dir.sharingPub.toLowerCase() &&
    pin.signingPubkeyHex.toLowerCase() === dir.signingPub.toLowerCase();
  return same ? 'matched' : 'changed';
}

/** What to say about a changed key. */
export function keyChangedMessage(email: string): string {
  return `${email} may have reset their password, so Note can't tell on its own that ` +
    `it's still them. New notes aren't shared with them until you confirm.`;
}
