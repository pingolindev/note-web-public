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
  groupBlockedShares, groupHeadline, bannerTitle, plainReason, plainAdvice,
} from './blockedShareSummary';
import type { BlockedShare } from '../stores/sharesInbox';

const share = (over: Partial<BlockedShare> = {}): BlockedShare => ({
  shareId: 's1',
  itemId: 'i1',
  ownerId: 'o1',
  sharerEmail: 'alice@example.com',
  sharedAt: '2026-09-01T00:00:00Z',
  reason: "This share can't be opened on this device. Ask the sender to share it again.",
  wrapTrust: 'no-key',
  ...over,
});

describe('groupBlockedShares', () => {
  /** The motivating case: one sender, two notes, the same sentence twice. */
  it('collapses two notes from one sender into a single row', () => {
    const groups = groupBlockedShares([
      share({ shareId: 's1', itemId: 'i1' }),
      share({ shareId: 's2', itemId: 'i2' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].shares).toHaveLength(2);
    expect(groupHeadline(groups[0])).toBe('2 notes from alice@example.com');
  });

  it('keeps senders apart', () => {
    const groups = groupBlockedShares([
      share({ shareId: 's1', sharerEmail: 'bob@example.com' }),
      share({ shareId: 's2', sharerEmail: 'alice@example.com' }),
    ]);
    expect(groups.map(g => g.sender)).toEqual(['alice@example.com', 'bob@example.com']);
  });

  /** Merging different verdicts would put one wrong sentence on both. */
  it('splits one sender whose notes failed in different ways', () => {
    const groups = groupBlockedShares([
      share({ shareId: 's1', wrapTrust: 'no-key' }),
      share({ shareId: 's2', wrapTrust: 'invalid' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map(g => g.reason)).size).toBe(2);
  });

  it('names a sender-less row rather than printing an empty address', () => {
    const groups = groupBlockedShares([share({ sharerEmail: null })]);
    expect(groups[0].sender).toBe('Someone');
    expect(groupHeadline(groups[0])).toBe('A note from Someone');
  });

  /** The duplicated technical sentence was half the complaint. */
  it('de-duplicates identical technical reasons in the details line', () => {
    const groups = groupBlockedShares([
      share({ shareId: 's1' }),
      share({ shareId: 's2' }),
    ]);
    expect(groups[0].detail).toBe(
      "This share can't be opened on this device. Ask the sender to share it again.",
    );
  });

  it('orders a group newest first', () => {
    const groups = groupBlockedShares([
      share({ shareId: 'old', sharedAt: '2026-08-01T00:00:00Z' }),
      share({ shareId: 'new', sharedAt: '2026-09-02T00:00:00Z' }),
    ]);
    expect(groups[0].shares.map(s => s.shareId)).toEqual(['new', 'old']);
  });
});

describe('wording', () => {
  it('never shows the raw crypto sentence as the reason', () => {
    for (const t of ['no-key', 'invalid', 'unsigned-stripped', 'unverified', 'verified'] as const) {
      expect(plainReason(t)).not.toMatch(/unwrap|content key|private key|signature didn't verify/i);
    }
  });

  /** A mismatched signature is exactly when "just ask again" is wrong advice. */
  it('does not tell the user to re-request a note whose signature did not match', () => {
    expect(plainAdvice('invalid')).toMatch(/another channel/i);
    expect(plainAdvice('no-key')).toMatch(/share them again/i);
  });

  it('counts the notes, not the groups, in the title', () => {
    const groups = groupBlockedShares([
      share({ shareId: 's1', sharerEmail: 'a@x.com' }),
      share({ shareId: 's2', sharerEmail: 'b@x.com' }),
      share({ shareId: 's3', sharerEmail: 'b@x.com' }),
    ]);
    expect(bannerTitle(groups)).toBe("3 shared notes couldn't be opened");
    expect(bannerTitle(groupBlockedShares([share()]))).toBe("A shared note couldn't be opened");
  });
});

describe('the banner names what was actually refused', () => {
  /**
   * A notebook OBJECT can be refused exactly as a note can, and announcing it
   * as "A shared note couldn't be opened" would send the reader to look for a
   * note that was never shared, while the notebook they were expecting
   * silently failed to appear.
   */
  const nb = (over = {}) => share({ itemType: 2, ...over });

  it('calls a refused notebook a notebook', () => {
    const groups = groupBlockedShares([nb()]);
    expect(bannerTitle(groups)).toBe("A shared notebook couldn't be opened");
    expect(groupHeadline(groups[0])).toMatch(/^A notebook from /);
  });

  it('still calls a refused note a note', () => {
    const groups = groupBlockedShares([share({ itemType: 1 })]);
    expect(bannerTitle(groups)).toBe("A shared note couldn't be opened");
    expect(groupHeadline(groups[0])).toMatch(/^A note from /);
  });

  it('treats a row with no item type as a note, as every older client did', () => {
    expect(bannerTitle(groupBlockedShares([share()]))).toBe("A shared note couldn't be opened");
  });

  it('reaches for a word true of both when a set mixes them', () => {
    // Same sender, same verdict \u2014 one group, two kinds.
    const groups = groupBlockedShares([share({ itemType: 1 }), nb()]);
    expect(bannerTitle(groups)).toBe("2 shared items couldn't be opened");
  });

  it('pluralises each kind on its own', () => {
    expect(bannerTitle(groupBlockedShares([nb(), nb({ shareId: 'b' })])))
      .toBe("2 shared notebooks couldn't be opened");
  });
});
