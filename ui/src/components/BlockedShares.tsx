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

import { For, Show, createSignal } from 'solid-js';
import { sharesInboxStore } from '../stores/sharesInbox';
import { authStore } from '../stores/auth';
import { computeSafetyNumber, getPinnedUserKeys } from '../lib/crypto';
import { lookupDirectoryKeys } from '../lib/recipientKeys';
import {
  groupBlockedShares, groupHeadline, bannerTitle, type BlockedShareGroup,
} from '../lib/blockedShareSummary';

/**
 * Banner for incoming shares this client refused to open, or opened and could
 * not decrypt.
 *
 * Without it these would vanish: the inbox fetches the row, grades it
 * untrusted, and filters it out of `shares()` — no list entry, no error, no
 * badge. The recipient would be told nothing, while the sender was told
 * "Shared". None of these are decrypted; what the banner adds is that the
 * recipient knows a note exists and what to do about it.
 *
 * GROUPED BY SENDER, in the user's words. One row per share, each printing the
 * raw crypto verdict verbatim, would render two notes from one person as
 * "Could not unwrap content key (wrong recipient or missing private key)"
 * twice — nearly half the first phone screen, with no next step. The wording
 * lives in lib/blockedShareSummary, where it is unit-tested; the technical
 * verdict is still available behind "Details" rather than deleted, because it
 * is the honest record and the only thing worth pasting into a support ticket.
 *
 * Every group is DISMISSIBLE, and that is not decoration. A share we refuse to
 * open is precisely the one the recipient can do nothing else about — they
 * cannot fix the sender's keys — so without a dismiss the banner is permanent
 * furniture, which is worse than not reporting it at all. Dismissal goes
 * through the same sticky server-side endpoint as a normal share dismissal, so
 * it stays gone across reloads and devices; dismissing a GROUP dismisses every
 * share in it, which is what "I have read this" means to the person clicking.
 *
 * Sibling of <KeyChangeAlarms/>, which covers the narrower case of a sender
 * whose pinned key changed.
 */
export default function BlockedShares() {
  const groups = () => groupBlockedShares(sharesInboxStore.blockedShares());
  const [busy, setBusy] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<string | null>(null);

  const keyOf = (g: BlockedShareGroup) => `${g.sender}:${g.shares[0].wrapTrust}`;

  /**
   * The safety number with this sender, for when they are checking a key
   * change from THEIR side — after your password reset the sender sees "new
   * key — verify" and asks you for this number, and this is where you read
   * it. From the key pinned for them here, else the one the directory
   * publishes: either way it is what this browser sees, which is exactly
   * what the comparison has to test.
   */
  const [numbers, setNumbers] = createSignal<Record<string, string | null>>({});
  const toggleNumber = async (g: BlockedShareGroup) => {
    const k = keyOf(g);
    if (k in numbers()) {
      setNumbers(prev => { const next = { ...prev }; delete next[k]; return next; });
      return;
    }
    const me = authStore.user()?.id;
    const first = g.shares[0];
    let keys: { sharing: string; signing: string } | null = null;
    const pin = getPinnedUserKeys(first.ownerId);
    // A conflict holds no keys to show (lib/pinMerge.ts): use the directory's.
    if (pin && !pin.conflict) keys = { sharing: pin.sharingPubkeyHex, signing: pin.signingPubkeyHex };
    else if (first.sharerEmail) {
      const dir = await lookupDirectoryKeys([first.sharerEmail]).catch(() => null);
      const d = dir?.get(first.sharerEmail.toLowerCase());
      if (d && d.userId === first.ownerId) keys = { sharing: d.sharingPub, signing: d.signingPub };
    }
    let num: string | null = null;
    if (me && keys) {
      try { num = computeSafetyNumber(me, first.ownerId, keys.sharing, keys.signing); } catch { num = null; }
    }
    setNumbers(prev => ({ ...prev, [k]: num }));
  };

  const dismissGroup = async (g: BlockedShareGroup) => {
    const key = keyOf(g);
    setBusy(key);
    try {
      // Sequential, not Promise.all: each dismissal is a server write against
      // the same inbox row set, and a burst of them races the store's own
      // refresh. There are at most a handful.
      for (const s of g.shares) {
        await sharesInboxStore.dismiss(s.shareId);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Show when={groups().length > 0}>
      {/* `.notice-warning` takes its colours from the theme tokens, so it follows the light and dark themes. */}
      <div class="notice-warning blocked-shares" role="status">
        <div class="blocked-shares-title">{bannerTitle(groups())}</div>
        <For each={groups()}>
          {(g) => (
            <div class="blocked-share-group">
              <div class="blocked-share-main">
                <div class="blocked-share-text">
                  <span class="blocked-share-sender">{groupHeadline(g)}</span>
                  {' — '}
                  {g.reason}
                  <Show when={g.advice}>
                    {' '}<span class="blocked-share-advice">{g.advice}</span>
                  </Show>
                </div>
                <button
                  class="btn blocked-share-dismiss"
                  disabled={busy() === keyOf(g)}
                  onClick={() => dismissGroup(g)}
                >
                  {busy() === keyOf(g) ? 'Dismissing…' : 'Dismiss'}
                </button>
              </div>
              <div class="blocked-share-toggles">
                <button
                  class="blocked-share-details-toggle"
                  aria-expanded={keyOf(g) in numbers()}
                  onClick={() => void toggleNumber(g)}
                >
                  {keyOf(g) in numbers() ? 'Hide security code' : 'Security code'}
                </button>
                <Show when={g.detail}>
                  <button
                    class="blocked-share-details-toggle"
                    aria-expanded={expanded() === keyOf(g)}
                    onClick={() => setExpanded(e => (e === keyOf(g) ? null : keyOf(g)))}
                  >
                    {expanded() === keyOf(g) ? 'Hide details' : 'Details'}
                  </button>
                </Show>
              </div>
              <Show when={keyOf(g) in numbers()}>
                <div class="notice-warning-code">
                  {numbers()[keyOf(g)] ?? 'Security code unavailable'}
                </div>
              </Show>
              <Show when={g.detail && expanded() === keyOf(g)}>
                <div class="notice-warning-code">{g.detail}</div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
