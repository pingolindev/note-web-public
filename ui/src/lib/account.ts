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
 * The account this tab acts as, and the one door every same-origin /api
 * request goes through.
 *
 * A tab left open under account A after account B signs in elsewhere shares
 * B's cookie but still holds A's keys and A's queued edits. So the tab names
 * its account on every call (`X-Pingolin-Account`), the note server refuses a
 * call whose account is not the session's with 409 `account_mismatch` before
 * any handler runs, and the tab then wipes what it holds and reloads. It never
 * retries: after a mismatch this module refuses every further request until
 * the reload.
 */

/** The request header naming the tab's account (canonical form). */
export const ACCOUNT_HEADER = 'X-Pingolin-Account';
/** The note server's error_code on a request made for another account. */
export const ACCOUNT_MISMATCH = 'account_mismatch';

const UUID_HYPHENATED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_BARE = /^[0-9a-f]{32}$/;

/**
 * An account id in its one canonical spelling: the UUID's 16 bytes written
 * lower-case and hyphenated. Accepts the hyphenated or the bare 32-hex form in
 * any case; anything else is not an account id and throws. Every comparison
 * of account ids, and every store keyed by one, uses this on both sides, so a
 * server that changes an id's case or hyphenation changes nothing here.
 */
export function canonicalAccountId(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Not an account id');
  const lower = raw.toLowerCase();
  let hex: string;
  if (UUID_HYPHENATED.test(lower)) hex = lower.replace(/-/g, '');
  else if (UUID_BARE.test(lower)) hex = lower;
  else throw new Error('Not an account id');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** `canonicalAccountId`, or null for anything that is not an account id. */
export function tryCanonicalAccountId(raw: unknown): string | null {
  try {
    return canonicalAccountId(raw);
  } catch {
    return null;
  }
}

let tabAccount: string | null = null;
let stopped = false;
let onMismatch: (() => void) | null = null;

/** The account /auth/me confirmed for this tab (canonical), or null. */
export function getTabAccount(): string | null {
  return tabAccount;
}

const accountListeners = new Set<(id: string | null) => void>();

/** Run `fn` whenever the tab's account changes: stores that read per-account
 *  values at start re-read them for the confirmed account. */
export function onTabAccountChange(fn: (id: string | null) => void): () => void {
  accountListeners.add(fn);
  return () => accountListeners.delete(fn);
}

/** Set once /auth/me (or the offline resume) names the account; null on a wipe. */
export function setTabAccount(id: string | null): void {
  const next = id === null ? null : canonicalAccountId(id);
  if (next === tabAccount) return;
  tabAccount = next;
  for (const fn of accountListeners) {
    try {
      fn(next);
    } catch (e) {
      console.error('[note/account] account listener failed', e);
    }
  }
}

/** What a mismatch does (the auth store registers: wipe the tab, then reload). */
export function onAccountMismatch(fn: (() => void) | null): void {
  onMismatch = fn;
}

/** Thrown for a request refused because it was, or would be, another account's. */
export class AccountMismatchError extends Error {
  constructor() {
    super('This tab belongs to another account');
    this.name = 'AccountMismatchError';
  }
}

/**
 * Stop this tab: no request leaves it from here on. Runs the registered
 * handler once; the reload it ends with is what lifts the stop.
 */
export function reportAccountMismatch(): void {
  if (stopped) return;
  stopped = true;
  tabAccount = null;
  try {
    onMismatch?.();
  } catch (e) {
    console.error('[note/account] mismatch handler failed', e);
  }
}

/** Whether a mismatch has stopped this tab (tests; the collab socket). */
export function isStopped(): boolean {
  return stopped;
}

/**
 * An apiRequest result refused because the request was, or would be, another
 * account's. Queued work must be KEPT on it (it is this tab's account's, and
 * runs when that account is back) and never retried now.
 */
export function isAccountStop(result: { success: boolean; error_code?: string }): boolean {
  return !result.success && result.error_code === ACCOUNT_MISMATCH;
}

async function isMismatchResponse(resp: Response): Promise<boolean> {
  if (resp.status !== 409) return false;
  try {
    const body = await resp.clone().json();
    return body?.error_code === ACCOUNT_MISMATCH;
  } catch {
    return false;
  }
}

/**
 * The one choke point for same-origin /api requests: names the tab's account
 * when one is confirmed, and turns the note server's 409 `account_mismatch`
 * into a stop (wipe + reload) and an `AccountMismatchError`, never a retry.
 */
export async function accountFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (stopped) throw new AccountMismatchError();
  const headers = new Headers(init.headers);
  if (tabAccount) headers.set(ACCOUNT_HEADER, tabAccount);
  const resp = await fetch(input, { ...init, headers });
  if (await isMismatchResponse(resp)) {
    reportAccountMismatch();
    throw new AccountMismatchError();
  }
  return resp;
}

/**
 * The per-account localStorage stores. Each is kept under
 * `<base>.<canonical account id>`; before an account is confirmed a store
 * reads as empty and writes are dropped. (The display settings stay one per
 * browser: the theme is painted before anyone is signed in, and they hold
 * nothing of an account's; sign-out still sweeps them.)
 */
export const ACCOUNT_SCOPED_STORES = [
  'pingolin_note_metadata',
  'pingolin_note_metadata_base',
  'pingolin_note_retired_keys',
  'pingolin_note_locked_own',
  'pingolin_note_prev_identities_seen',
  'pingolin_note_gen_floor',
  'pingolin_note_inbox_last_seen',
  'pingolin_note_push_endpoint',
  'pingolin_note_opened_via_pulled',
  'pingolin_note_item_owner',
  'pingolin_note_seen_accepted',
  'pingolin_note_only_mine',
] as const;

/**
 * Kept trust: the rollback floors and the item owners. Public, per
 * account, and what makes a later share checkable, so a sign-out and another
 * account's sign-in keep every account's copy, as crypto.ts keeps the pins.
 * This page never sees a typed e-mail (the portal signs people in), so the
 * typed-e-mail rule never lets it delete another account's. Only an erasure
 * deletes them, and only the erased account's (forgetAccountStores).
 */
const KEPT_TRUST_STORES: readonly string[] = ['pingolin_note_gen_floor', 'pingolin_note_item_owner'];

/** The storage key of a per-account store for this tab's account, or null. */
export function accountStorageKey(base: string, account: string | null = tabAccount): string | null {
  return account ? `${base}.${account}` : null;
}

export function scopedGetItem(base: string): string | null {
  const k = accountStorageKey(base);
  if (!k) return null;
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/** May throw (quota), like localStorage.setItem; a no-op before an account is confirmed. */
export function scopedSetItem(base: string, value: string): void {
  const k = accountStorageKey(base);
  if (!k) return;
  localStorage.setItem(k, value);
}

export function scopedRemoveItem(base: string): void {
  const k = accountStorageKey(base);
  if (!k) return;
  try {
    localStorage.removeItem(k);
  } catch { /* unavailable */ }
}

/**
 * Stores written by older versions, one per browser, have no account in
 * their key. They are this account's only when the browser's recorded owner
 * is this account (`ownerKnown`); otherwise nobody can say whose they are,
 * and they go.
 */
export function adoptLegacyStores(account: string, ownerKnown: boolean): void {
  for (const base of ACCOUNT_SCOPED_STORES) {
    try {
      const legacy = localStorage.getItem(base);
      if (legacy === null) continue;
      const k = `${base}.${account}`;
      if (ownerKnown && localStorage.getItem(k) === null) localStorage.setItem(k, legacy);
      localStorage.removeItem(base);
    } catch { /* unavailable */ }
  }
}

/** The account a per-account store key belongs to, or null for any other key. */
function storeKeyAccount(key: string): { base: string; account: string | null } | null {
  for (const base of ACCOUNT_SCOPED_STORES) {
    if (key === base) return { base, account: null };
    if (key.startsWith(`${base}.`)) return { base, account: tryCanonicalAccountId(key.slice(base.length + 1)) };
  }
  return null;
}

function removeStoreKeys(remove: (account: string | null) => boolean, keptTrustToo = false): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const owner = key === null ? null : storeKeyAccount(key);
      if (!owner) continue;
      // An account's kept trust stays unless this is that account's erasure.
      // An unscoped copy written by an older version belongs to nobody and
      // goes.
      const kept = !keptTrustToo && owner.account !== null && KEPT_TRUST_STORES.includes(owner.base);
      if (key !== null && !kept && remove(owner.account)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch { /* unavailable */ }
}

/** A different account signed in: remove every other account's stores. */
export function keepOnlyAccountStores(account: string): void {
  removeStoreKeys(owner => owner !== account);
}

/** Sign-out or a wipe: remove every account's stores, and the older builds'. */
export function clearAllAccountStores(): void {
  removeStoreKeys(() => true);
}

/** An erased account (lib/forgetAccount.ts): remove its stores, its kept
 *  trust included, and only its. */
export function forgetAccountStores(account: string): void {
  removeStoreKeys(owner => owner === account, true);
}

/** The same stores as written by older versions, one per browser: an erased
 * account's only when the browser recorded it as the owner (the caller's
 * check). */
export function forgetLegacyStores(): void {
  for (const base of ACCOUNT_SCOPED_STORES) {
    try {
      localStorage.removeItem(base);
    } catch { /* unavailable */ }
  }
}

/** Tests only: back to a fresh tab. */
export function resetAccountStateForTests(): void {
  tabAccount = null;
  stopped = false;
  onMismatch = null;
  accountListeners.clear();
}
