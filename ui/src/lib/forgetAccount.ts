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
 * The web editor's "forget this account" route: /forget-account#r=<receipt>.
 *
 * After the auth server erases an account, the portal sends the browser once
 * through the web apps' routes (the erasure chain): the portal, then the Track
 * web app's route, then this one, then the portal's /login. Each deletes the
 * erased account's data from this browser, and nothing else. The receipt
 * (lib/erasureReceipt.ts) is the auth server's signed word that the account
 * is gone.
 *
 * This runs before anything signs in (index.tsx): the erased account's session
 * is already gone, and the ordinary no-session start wipes EVERY account's
 * data here, which this must not do.
 *
 * It never touches another account's data, the account signed in now, the
 * cookie, another account's push subscription, or the display settings. It
 * goes on to a fixed next hop derived from this page's own exact host, whether
 * or not the receipt verified; no URL is ever taken from the request.
 */
import { forgetAccountStores, forgetLegacyStores, tryCanonicalAccountId } from './account';
import { forgetAccountCache, forgetLegacyCache } from './noteDb';
import { deleteRekeyDb } from './rekeyStore';
import { forgetLegacyPinnedKeys, forgetPinnedKeys, wipeTabState } from './crypto';
import { verifyErasureReceipt } from './erasureReceipt';

/** The next hop, by this page's exact host: the portal's /login, which shows
 *  its own one-time notice. Anywhere else (a local dev server) goes to '/'. */
export const NEXT_HOP: Readonly<Record<string, string>> = {
  'note.pingolin.com': 'https://account.pingolin.com/login',
  'note.pingolindev.com': 'https://account.pingolindev.com/login',
};

/**
 * The receipt keys, [current, previous] — the auth server's receipt-signing
 * public keys — by this page's exact host, never by anything in the receipt.
 * A host whose list is empty verifies nothing, so nothing is deleted there.
 */
export const RECEIPT_KEYS_HEX: Readonly<Record<string, readonly string[]>> = {
  'note.pingolin.com': [],
  // Dev: the development auth server's receipt-signing public key.
  'note.pingolindev.com': ['30d1d7e73d60a9891667d74cb76713d32b835735ff9e2af08054fdd2051f1979'],
};

// Account records kept outside the per-account stores. Literals, as in
// crypto.clearKeys: stores/auth.ts OWNER_KEY and SESSION_KEY_NAME, crypto.ts
// SESSION_ACCOUNT, webPush.ts STORED_ENDPOINT_KEY.
const OWNER_KEY = 'pingolin_note_owner';
const CACHED_SESSION_KEY = 'pingolin_note_session';
const TAB_ACCOUNT_KEY = 'pingolin_note_tab_account';
const PUSH_ENDPOINT_KEY = 'pingolin_note_push_endpoint';

/** The receipt, when the fragment is exactly `#r=<receipt>`; else null. */
export function receiptFromFragment(hash: string): string | null {
  const m = /^#r=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(hash);
  return m ? m[1] : null;
}

/** Its push subscription, only when it is the one recorded for this account. */
async function unsubscribeRecordedPush(account: string): Promise<void> {
  const recorded = localStorage.getItem(`${PUSH_ENDPOINT_KEY}.${account}`);
  if (!recorded || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  const find = (async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub && sub.endpoint === recorded) await sub.unsubscribe();
  })();
  // A worker that never answers must not hold the chain up.
  await Promise.race([find.catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
}

/** Delete `account`'s data from this browser, and nobody else's. */
export async function forgetAccountData(account: string): Promise<void> {
  // What older builds kept once per browser, with no id (the cache database
  // with its plaintext queue, the stores, the pin blob, a tab's keys), is this
  // account's only when the browser recorded it as the owner. Read that before
  // anything is removed. Anyone else's, or nobody's, stays for the next
  // sign-in's rule.
  let ownsLegacy = false;
  try {
    ownsLegacy = tryCanonicalAccountId(localStorage.getItem(OWNER_KEY)) === account;
  } catch { /* storage unavailable: nothing to own */ }
  try {
    await unsubscribeRecordedPush(account);
  } catch { /* best effort: the server side is erased already */ }
  forgetAccountStores(account);
  forgetPinnedKeys(account);
  // Its removal jobs, which a sign-out keeps (rekeyStore): an erasure takes them.
  await deleteRekeyDb(account).catch(() => {});
  if (ownsLegacy) {
    forgetLegacyStores();
    forgetLegacyPinnedKeys();
  }
  try {
    if (ownsLegacy) localStorage.removeItem(OWNER_KEY);
    const cached = JSON.parse(localStorage.getItem(CACHED_SESSION_KEY) ?? 'null') as { id?: unknown } | null;
    if (cached && tryCanonicalAccountId(cached.id) === account) localStorage.removeItem(CACHED_SESSION_KEY);
  } catch { /* a cached session that does not parse names nobody */ }
  try {
    // This tab's keys: recorded as the account's, or recorded as nobody's on a
    // browser the account owned.
    const tabAccount = sessionStorage.getItem(TAB_ACCOUNT_KEY);
    if (tryCanonicalAccountId(tabAccount) === account || (tabAccount === null && ownsLegacy)) wipeTabState();
  } catch { /* storage unavailable */ }
  await forgetAccountCache(account);
  if (ownsLegacy) await forgetLegacyCache();
}

interface Page {
  location: Pick<Location, 'hash' | 'hostname' | 'pathname' | 'replace'>;
  history: Pick<History, 'replaceState'>;
}

/**
 * The route. The fragment is stripped first, before anything else runs, so the
 * receipt never stays in the address bar or the history.
 */
export async function runForgetAccount(
  page: Page,
  opts: { nowSecs?: () => number; keysByHost?: Readonly<Record<string, readonly string[]>> } = {},
): Promise<void> {
  const receipt = receiptFromFragment(page.location.hash);
  page.history.replaceState(null, '', page.location.pathname);
  const host = page.location.hostname;
  try {
    if (receipt) {
      const sodium = (await import('libsodium-wrappers')).default;
      await sodium.ready;
      const keys = ((opts.keysByHost ?? RECEIPT_KEYS_HEX)[host] ?? []).map((hex) => sodium.from_hex(hex));
      const now = (opts.nowSecs ?? (() => Math.floor(Date.now() / 1000)))();
      const verdict = verifyErasureReceipt(sodium, receipt, keys, now);
      if (verdict.ok) await forgetAccountData(verdict.sub);
      else console.warn(`[note/forget] receipt refused (${verdict.refused}); nothing deleted`);
    } else {
      console.warn('[note/forget] no receipt; nothing deleted');
    }
  } catch (e) {
    console.warn('[note/forget] could not finish; going on', e);
  }
  page.location.replace(NEXT_HOP[host] ?? '/');
}
