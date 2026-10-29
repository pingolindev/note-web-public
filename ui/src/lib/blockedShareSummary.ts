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
 * Turning refused incoming shares into something a person can read.
 *
 * One row per share, each carrying the raw verdict string the crypto layer
 * produced — "Could not unwrap content key (wrong recipient or missing private
 * key)" — with its own Dismiss button, would render that sentence twice, word
 * for word, for two notes from one sender, and on a phone the pair would fill
 * nearly half of the first screen.
 *
 * Two things are wrong there and they need different answers. The DUPLICATION
 * goes by grouping on the sender, because "2 notes from Alice" is what the
 * recipient actually has to act on — the per-note identity is useless to them,
 * they cannot open any of them. The JARGON is handled here rather than at the
 * source: `reason` stays exactly as the store produced it (it is the honest
 * technical record, and `wrapTrust` is the verdict it came from), and this
 * module maps the verdict to a sentence and a next step.
 *
 * Kept as pure functions so the wording is testable without a DOM: the words
 * are the point.
 */

import type { BlockedShare, WrapTrust } from '../stores/sharesInbox';

/** Server item_type for a notebook; anything else in a blocked set is a note. */
const ITEM_TYPE_NOTEBOOK = 2;

export interface BlockedShareGroup {
  /** Display name for the sender — their address, or a stand-in when the row carries none. */
  sender: string;
  /** Every share from this sender, newest first. */
  shares: BlockedShare[];
  /** What to tell the user, in their words. */
  reason: string;
  /** What they can do about it. Empty when there is genuinely nothing. */
  advice: string;
  /** The technical verdicts behind `reason`, for the details line. */
  detail: string;
}

const UNKNOWN_SENDER = 'Someone';

/**
 * Plain-language reason per verdict.
 *
 * Deliberately says what happened to the NOTE, not what happened to the key:
 * "wrong recipient or missing private key" is a true statement about a wrap
 * and a meaningless one to a person who just wants to read a shared note.
 */
export function plainReason(trust: WrapTrust): string {
  switch (trust) {
    case 'unsigned-stripped':
      return "They couldn't be confirmed as coming from this sender, so they weren't opened.";
    case 'invalid':
      return "They couldn't be confirmed as coming from this sender, so they weren't opened.";
    case 'no-key':
      return 'They were shared before your account could receive them, so there is nothing to open.';
    default:
      return "They can't be opened on this device.";
  }
}

/**
 * What the recipient can actually do. A banner with no next step is furniture,
 * which is why every row is dismissible — but where re-sharing genuinely fixes
 * it, say so, and where it does not, say nothing rather than send them on an
 * errand.
 */
export function plainAdvice(trust: WrapTrust): string {
  switch (trust) {
    case 'invalid':
      // A mismatched signature is the one case where "just re-share" is the
      // wrong advice: it is also what an impersonation attempt looks like.
      return 'Check with the sender through another channel before trusting a new copy.';
    case 'unsigned-stripped':
    case 'no-key':
      return 'Ask the sender to share them again.';
    default:
      return 'Ask the sender to share them again.';
  }
}

/** Newest first, so the group header matches what a reader expects to see. */
function bySharedAtDesc(a: BlockedShare, b: BlockedShare): number {
  return (b.sharedAt || '').localeCompare(a.sharedAt || '');
}

/**
 * Group blocked shares by sender, then by verdict within a sender.
 *
 * A sender who sent two notes that failed two DIFFERENT ways gets two groups —
 * merging them would force one wrong sentence onto both. That is rare; the
 * common case is one group per sender, which is the case the banner is
 * designed for.
 */
export function groupBlockedShares(blocked: readonly BlockedShare[]): BlockedShareGroup[] {
  const byKey = new Map<string, BlockedShare[]>();
  for (const b of blocked) {
    const sender = b.sharerEmail ?? '';
    const key = `${sender}\u0000${b.wrapTrust}`;
    const list = byKey.get(key);
    if (list) list.push(b);
    else byKey.set(key, [b]);
  }

  const groups: BlockedShareGroup[] = [];
  for (const [key, shares] of byKey) {
    const [sender] = key.split('\u0000');
    shares.sort(bySharedAtDesc);
    const trust = shares[0].wrapTrust;
    // The raw reasons, de-duplicated: two identical sentences for two
    // notes would be noise, so the details line must not reproduce them.
    const detail = [...new Set(shares.map(s => s.reason).filter(Boolean))].join(' ');
    groups.push({
      sender: sender || UNKNOWN_SENDER,
      shares,
      reason: plainReason(trust),
      advice: plainAdvice(trust),
      detail,
    });
  }

  // Stable, predictable order: senders alphabetically, so the banner does not
  // reshuffle itself between renders.
  groups.sort((a, b) => a.sender.localeCompare(b.sender));
  return groups;
}

/**
 * What to call the things in a set of refused shares.
 *
 * A notebook OBJECT can be refused just like a note can, and calling one "a
 * shared note" sends the reader hunting for a note that was never shared. Where
 * a set mixes the two, "item" is the only word true of both.
 */
function noun(shares: readonly BlockedShare[]): { one: string; many: string } {
  const kinds = new Set(shares.map(s => (s.itemType === ITEM_TYPE_NOTEBOOK ? 'notebook' : 'note')));
  if (kinds.size !== 1) return { one: 'item', many: 'items' };
  const only = [...kinds][0];
  return only === 'notebook'
    ? { one: 'notebook', many: 'notebooks' }
    : { one: 'note', many: 'notes' };
}

/** "2 notes from alice@example.com" / "A notebook from Someone". */
export function groupHeadline(group: BlockedShareGroup): string {
  const n = group.shares.length;
  const { one, many } = noun(group.shares);
  return n === 1
    ? `A ${one} from ${group.sender}`
    : `${n} ${many} from ${group.sender}`;
}

/** Banner title: the total across every group. */
export function bannerTitle(groups: readonly BlockedShareGroup[]): string {
  const all = groups.flatMap(g => g.shares);
  const { one, many } = noun(all);
  return all.length === 1
    ? `A shared ${one} couldn't be opened`
    : `${all.length} shared ${many} couldn't be opened`;
}
