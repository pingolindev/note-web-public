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
 * Auth store — manages cookie-based auth and crypto key restoration.
 *
 * Login is handled by the account portal (SRP, 2FA, passkeys).
 * This store checks the shared cookie and restores E2EE keys.
 */

import { createSignal } from 'solid-js';
import {
  initCrypto,
  restoreFromSession,
  restoreFromClientKey,
  getLocalClientKey,
  getLocalBlobId,
  setLocalBlobId,
  probeStoredKey,
  clearKeys,
  loadPinnedKeysFromStorage,
  migratePinnedKeys,
  expectAccount,
  expectedAccount,
  accountKeysFrom,
  sameAccountKeys,
  wipeTabState,
  type StoredKeyProbe,
} from '../lib/crypto';
import { adoptLegacyCache, clearLocalCache, keepOnlyAccountCache } from '../lib/noteDb';
import {
  classifyFailure,
  decideOfflineBoot,
  type CachedSession,
} from '../lib/offlineSession';
import { clearAll as clearRetainedKeys } from '../lib/retainedKeys';
import { ensurePushSubscription, unsubscribePush } from '../lib/webPush';
import { notebooksStore } from './notebooks';
import type { KeysUnavailableReason } from '../lib/lockedCopy';
import { inBridgeMode } from '../lib/keyBridge';
import { adoptKeptTrust } from '../lib/keptTrust';
import { resetPreviousIdentities } from '../lib/previousIdentities';
import {
  accountFetch,
  AccountMismatchError,
  adoptLegacyStores,
  getTabAccount,
  keepOnlyAccountStores,
  onAccountMismatch,
  reportAccountMismatch,
  setTabAccount,
  tryCanonicalAccountId,
} from '../lib/account';

interface SubscriptionInfo {
  service: string;
  plan: string;
  status: string;
  product_slug?: string;
  /** "individual" or "bundle" — a bundle entitles the user to all products. */
  subscription_type?: string;
}

interface User {
  id: string;
  email: string;
  subscriptions?: SubscriptionInfo[];
  /** 'approved' | 'pending' (an account awaiting admin approval) | 'rejected' */
  registration_status?: string;
  /** True when somebody else set this account up and keeps its password — a
   *  guardian holding a young person's account. Drives the standing line above
   *  the notes list, because nothing else tells that person their notes are
   *  readable: location sharing is announced by the phone's own OS, a read is
   *  not, and there is no new-sign-in email. */
  guardian_managed?: boolean;
}

const [user, setUser] = createSignal<User | null>(null);
const [isLoggedIn, setIsLoggedIn] = createSignal(false);
const [isReady, setIsReady] = createSignal(false);
const [keysLoaded, setKeysLoaded] = createSignal(false);

/**
 * Why this tab is signed in but holds no E2EE keys, or null when it has them
 * (or has not finished looking).
 *
 *  - `not-federated`: the account has keys on the server, and the account
 *    portal could not hand this tab the key that opens them.
 *  - `no-server-key`: the server holds no ciphertext for this account yet —
 *    typically one that has only ever signed in on a phone. A sign-in at the
 *    portal seals one.
 *  - `unreachable`: the server could not be asked.
 *
 * In every case the app stays locked — nothing is decrypted, synced or
 * written, and no new vault key is minted — and <KeysUnavailableNotice/> says
 * so with a way to unlock.
 */
export type { KeysUnavailableReason };
const [keysUnavailable, setKeysUnavailableRaw] = createSignal<KeysUnavailableReason | null>(null);
/** The user hid the notice for this load. The tab is still locked. */
const [keysNoticeDismissed, setKeysNoticeDismissed] = createSignal(false);
function setKeysUnavailable(reason: KeysUnavailableReason | null): void {
  setKeysUnavailableRaw(reason);
  // A new locked state is news again; an unlock has nothing left to hide.
  setKeysNoticeDismissed(false);
}

/** The probe's answer, in the words the notice uses. Exported for its test. */
export function unavailableReasonFor(probe: StoredKeyProbe): KeysUnavailableReason {
  if (probe === 'present') return 'not-federated';
  if (probe === 'absent') return 'no-server-key';
  return 'unreachable';
}

/**
 * True when this session was resumed from cache because the server could not
 * be reached. The app is usable — noteDb holds decrypted notes and notes.ts
 * queues edits — but nothing here has been confirmed by the server on this
 * load, so the UI says so and App.tsx must not redirect to a portal that is
 * equally unreachable.
 */
const [isOffline, setIsOffline] = createSignal(false);

const API_URL = '/api/v1';

// Auth UI URL for registration/forgot-password links.
//
// Derived from the current hostname, not from a build-time env var. note-ui is
// served from the per-environment `note.` subdomain (note.pingolin.com in
// production) and the account portal is the sibling `account.` host in the
// same environment, so swapping the leading label keeps every environment
// correct from one image. The editor's Dockerfile sets no VITE_AUTH_UI_URL for
// `npm run build`, so a build-time value would always be empty, and a
// hard-coded fallback host is right for only one environment: it would send
// users of every other one to the wrong portal on login, logout, billing and
// key federation.
//
// VITE_AUTH_UI_URL still wins when set, for a local dev server pointed at a
// portal that is not a sibling host. Trailing slash is stripped once here
// because every caller appends a path (`${authUrl}/login`).
//
// Resolved lazily and memoised, not at module scope: this module is pulled in
// transitively by stores that unit tests import under vitest's `node`
// environment, where `window` does not exist, and a module-scope read of
// window.location fails the whole suite at import time.
let authUiUrl: string | null = null;

/**
 * The account portal origin for a note-ui hostname: the sibling `account.` host
 * in the same environment. Pure and exported so that tests can assert the
 * mapping for each environment.
 */
export function accountOriginForHost(hostname: string): string {
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'https://account.pingolindev.com';
  }
  const labels = hostname.split('.');
  labels[0] = 'account';
  return `https://${labels.join('.')}`;
}

function resolveAuthUiUrl(): string {
  const configured = import.meta.env.VITE_AUTH_UI_URL;
  if (configured) return configured.replace(/\/$/, '');
  // No document to derive from (unit tests under the node environment). note-ui
  // is a browser-only SPA served by nginx — there is no SSR path — so this only
  // ever fires in tests, where the value is unused.
  if (typeof window === 'undefined') return 'https://account.pingolindev.com';
  return accountOriginForHost(window.location.hostname);
}

export function getAuthUiUrl(): string {
  if (authUiUrl === null) authUiUrl = resolveAuthUiUrl();
  return authUiUrl;
}

/**
 * Billing/upgrade URL on the account portal — the CTA target for every
 * subscription-limit prompt (share, reminder, attachment, note). Derived from
 * the same origin the auth-UI federation targets (`getAccountOrigin`), so it
 * points at the account portal of the environment this page is served from
 * instead of a hard-coded host.
 *
 * The path is `/subscription`, the route the portal serves. The portal
 * answers every path with its SPA shell and a 200, so a wrong path here does
 * not fail visibly: it opens a page that renders nothing.
 */
export function getBillingUrl(): string {
  return `${getAccountUrl()}/subscription`;
}

/** Base of the account portal — the one place that may write account-level
 *  credentials (recovery address, password, passkeys). Settings links here
 *  rather than reimplementing those flows. */
export function getAccountUrl(): string {
  return getAccountOrigin() ?? getAuthUiUrl();
}

/**
 * Returns 'Premium' if the user has an active subscription that entitles
 * them to note features (product_slug === 'note' or subscription_type ===
 * 'bundle'). A track-only subscription does not grant note features, so
 * this badge matches the note server's quota check exactly — otherwise the
 * UI would advertise Premium and the server would reject reminders/sharing
 * with 402.
 */
const subscriptionTier = () => {
  const u = user();
  if (!u?.subscriptions?.length) return 'Free';
  const entitled = u.subscriptions.some(s =>
    (s.status === 'active' || s.status === 'trialing') &&
    (s.product_slug === 'note' || s.subscription_type === 'bundle')
  );
  return entitled ? 'Premium' : 'Free';
};

/**
 * Read the wrapping key the account portal handed us in the redirect
 * URL fragment (`#ck=<encodeURIComponent(base64)>`). Fragments are never sent to
 * the server, so this is how a sibling origin receives the key without the
 * server ever seeing it. URLSearchParams reverses the portal's
 * encodeURIComponent (%2B→+, %2F→/, %3D→=), yielding the ORIGINAL-variant base64
 * the crypto helpers expect. Returns null when no `ck` fragment is present.
 */
/**
 * A federated wrapping key and the opaque id of the blob it opens. `blobId`
 * is null when the portal does not send one (an older portal bundle).
 */
export interface FederatedKey {
  ck: string;
  blobId: string | null;
}

function readClientKeyFromFragment(): FederatedKey | null {
  try {
    const hash = window.location.hash;
    if (!hash || hash.length < 2) return null;
    const params = new URLSearchParams(hash.slice(1));
    const ck = params.get('ck');
    if (!ck || ck.length === 0) return null;
    // `cb` names WHICH server-side blob this key opens.
    const blobId = params.get('cb');
    return { ck, blobId: blobId && blobId.length > 0 ? blobId : null };
  } catch {
    return null;
  }
}

/**
 * Strip the wrapping key from the URL immediately after reading it, so
 * it never lingers in the address bar or browser history. note-ui uses
 * path-based (not hash-based) routing, so dropping the whole fragment is safe.
 */
function stripClientKeyFragment(): void {
  try {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    /* non-fatal */
  }
}

// --- Iframe federation (hidden-iframe + postMessage key handoff) ------------
// Cross-app postMessage contract with the account portal's /federate
// responder. The sibling posts REQUEST_TYPE and the responder replies
// RESPONSE_TYPE with the wrapping key (or null). These strings are shared with
// the portal and must match it exactly.
const FEDERATE_REQUEST_TYPE = 'pingolin-ck-request';
const FEDERATE_RESPONSE_TYPE = 'pingolin-ck';
// Tell the portal a wrapping key is dead. We only send this having PROVED it:
// the ciphertext was fetched and the key did not decrypt it.
const FEDERATE_INVALIDATE_TYPE = 'pingolin-ck-invalidate';
const FEDERATE_INVALIDATED_TYPE = 'pingolin-ck-invalidated';
// Once per tab. If the key we get after re-authenticating ALSO fails, the cause
// is not staleness and asking for the password again would just loop.
const INVALIDATE_GUARD = 'e2ee-key-invalidated';

/**
 * Ask the account portal to drop the wrapping key it just gave us.
 *
 * Without this a key that cannot decrypt the ciphertext is handed back by BOTH
 * federation routes until its 12h TTL expires, so the user sits on "encrypted
 * features unavailable until next portal login" with no way to reach that login
 * — the session is still valid, so the portal just redirects them back. Dropping
 * it means the next fork finds no key, and the portal asks for the password,
 * which re-seals and fixes it.
 *
 * Best-effort and time-boxed: if the portal never answers we carry on and end up
 * where we would have anyway.
 */
/**
 * Drop a proven-bad key and re-arm the fork, so the next hop reaches the portal
 * with nothing stale to hand back and it asks for the password instead.
 */
async function invalidateBadFederatedKey(): Promise<void> {
  const accountOrigin = getAccountOrigin();
  if (!accountOrigin || sessionStorage.getItem(INVALIDATE_GUARD)) return;
  sessionStorage.setItem(INVALIDATE_GUARD, '1');
  console.warn('[auth] federated key does not decrypt the ciphertext — invalidating it');
  setLocalBlobId(null);
  await invalidateFederatedKey(accountOrigin);
  sessionStorage.removeItem('note-e2ee-fork-attempted');
}

function invalidateFederatedKey(accountOrigin: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let iframe: HTMLIFrameElement | null = null;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (retryTimer !== null) clearInterval(retryTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      window.removeEventListener('message', onMessage);
      if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
      iframe = null;
      resolve();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== accountOrigin) return;
      const data = event.data as { type?: unknown } | null;
      if (!data || data.type !== FEDERATE_INVALIDATED_TYPE) return;
      finish();
    };

    try {
      window.addEventListener('message', onMessage);
      iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('title', 'pingolin-federate-invalidate');
      iframe.style.display = 'none';
      iframe.src = `${accountOrigin}/federate`;
      const send = () => {
        // The account the key is for: the portal acts only for
        // the account its own session is.
        try { iframe?.contentWindow?.postMessage({ type: FEDERATE_INVALIDATE_TYPE, account: getTabAccount() }, accountOrigin); } catch { /* ignore */ }
      };
      iframe.addEventListener('load', () => {
        send();
        retryTimer = setInterval(send, 300);
      });
      document.body.appendChild(iframe);
      timeoutTimer = setTimeout(finish, timeoutMs);
    } catch {
      finish();
    }
  });
}

/**
 * Derive the account portal's ORIGIN (scheme+host, no path) from the configured
 * auth-UI URL — used as the iframe src base AND as the strict targetOrigin /
 * accepted response-origin for the postMessage handoff. Returns null only if
 * the value can't be parsed; AUTH_UI_URL is always an absolute https URL, so
 * that is a defensive branch rather than a reachable one.
 */
function getAccountOrigin(): string | null {
  try {
    return new URL(getAuthUiUrl()).origin;
  } catch {
    return null;
  }
}

/**
 * Iframe federation: request the cross-origin wrapping key from the account
 * portal via a hidden iframe + postMessage — no navigation, so the key never
 * touches a URL, address bar, or history entry. Resolves the key on success, or
 * null on refusal/timeout/error (caller then falls back to the redirect fork).
 *
 * SECURITY: the request targetOrigin and the accepted response `event.origin`
 * are both pinned to the exact account origin — a message from any other origin
 * is ignored, and the browser refuses to deliver our request to any other
 * origin. The key is never logged.
 */
function requestKeyViaIframe(accountOrigin: string, timeoutMs = 4000): Promise<FederatedKey | null> {
  return new Promise((resolve) => {
    let settled = false;
    let iframe: HTMLIFrameElement | null = null;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const onMessage = (event: MessageEvent) => {
      // Only trust a reply from the exact account origin.
      if (event.origin !== accountOrigin) return;
      const data = event.data as { type?: unknown; ck?: unknown; blobId?: unknown } | null;
      if (!data || data.type !== FEDERATE_RESPONSE_TYPE) return;
      const ck = typeof data.ck === 'string' && data.ck.length > 0 ? data.ck : null;
      // The responder names the blob its key opens.
      const blobId = typeof data.blobId === 'string' && data.blobId.length > 0 ? data.blobId : null;
      finish(ck ? { ck, blobId } : null);
    };

    const cleanup = () => {
      if (retryTimer !== null) clearInterval(retryTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      window.removeEventListener('message', onMessage);
      if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
      iframe = null;
    };

    const finish = (val: FederatedKey | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };

    try {
      window.addEventListener('message', onMessage);
      iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('title', 'pingolin-federate');
      iframe.style.display = 'none';
      iframe.src = `${accountOrigin}/federate`;

      const sendRequest = () => {
        // targetOrigin pinned to the account origin — dropped by the browser if
        // the frame isn't (yet) on that origin, so nothing leaks pre-navigation.
        // It names the account the key is for: the portal hands over only the
        // key of the account its own session is.
        try { iframe?.contentWindow?.postMessage({ type: FEDERATE_REQUEST_TYPE, account: getTabAccount() }, accountOrigin); } catch { /* ignore */ }
      };

      // The responder installs its listener on mount, which can be after the
      // iframe's load event — send once on load, then retry until we get a reply
      // or time out. The request carries no state, so retries are safe.
      iframe.addEventListener('load', () => {
        sendRequest();
        retryTimer = setInterval(sendRequest, 300);
      });

      document.body.appendChild(iframe);
      timeoutTimer = setTimeout(() => finish(null), timeoutMs);
    } catch {
      finish(null);
    }
  });
}

/**
 * The id of the last authenticated account, kept in a dedicated localStorage
 * key that clearKeys() sweeps on wipe.
 *
 * It tells whether a different account is now signing in: when the current
 * session's user differs from it (or there is no session), the full logout
 * wipe runs BEFORE any hydration, so account B never renders account A's
 * decrypted state after a *non-logout* session end (portal-side logout /
 * cookie expiry). It also decides who may adopt the stores an older version
 * kept once per browser: they are adopted only by the account recorded here.
 */
const OWNER_KEY = 'pingolin_note_owner';

export function getCachedOwner(): string | null {
  try { return localStorage.getItem(OWNER_KEY); } catch { return null; }
}

/**
 * The last server-confirmed session, for resuming when the server cannot be
 * reached. Holds an id, an email and a timestamp — no key material and no note
 * content. Swept by clearKeys() alongside OWNER_KEY, so a logout or a wipe
 * leaves nothing to resume from.
 */
const SESSION_KEY_NAME = 'pingolin_note_session';

function readCachedSession(): CachedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY_NAME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSession;
    return parsed && typeof parsed.id === 'string' && typeof parsed.verifiedAt === 'number'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeCachedSession(
  u: User,
  nowMs: number,
  keys: { sharing_public_key?: string; signing_public_key?: string },
): void {
  try {
    const s: CachedSession = {
      id: u.id,
      email: u.email,
      registration_status: u.registration_status,
      guardian_managed: u.guardian_managed,
      subscriptions: u.subscriptions,
      sharing_public_key: keys.sharing_public_key,
      signing_public_key: keys.signing_public_key,
      verifiedAt: nowMs,
    };
    localStorage.setItem(SESSION_KEY_NAME, JSON.stringify(s));
  } catch { /* non-fatal */ }
}

/**
 * Resume the last confirmed session because the server could not answer.
 * Returns false when there is nothing trustworthy to resume, leaving the
 * caller's normal signed-out path to run.
 *
 * This does NOT weaken revocation: it defers it. The moment the server IS
 * reachable and answers with a definitive denial, the existing wipe runs — the
 * same compensating control password managers rely on for cached vaults.
 */
async function resumeFromCache(): Promise<boolean> {
  const decision = decideOfflineBoot({ cached: readCachedSession(), nowMs: Date.now() });
  if (decision.kind !== 'resume') return false;
  const s = decision.session;
  const accountId = tryCanonicalAccountId(s.id);
  if (!accountId) return false;

  // Cross-account safety holds offline as it does online: a cached session
  // for any account other than the browser's recorded owner is not resumed.
  const prevOwner = tryCanonicalAccountId(getCachedOwner());
  if (prevOwner && prevOwner !== accountId) return false;
  // What older builds kept once per browser (see checkAuth).
  const ownerKnown = prevOwner === accountId;
  adoptLegacyStores(accountId, ownerKnown);
  await adoptLegacyCache(accountId, ownerKnown);
  migratePinnedKeys(accountId, ownerKnown);

  // The tab acts as the cached account (its requests name it; a session that
  // turns out to be another's is refused with 409), and its kept keys are
  // used only for that account's registered keys, as online.
  setTabAccount(accountId);
  expectAccount(accountKeysFrom(accountId, s.sharing_public_key, s.signing_public_key));

  setUser({
    id: accountId,
    email: s.email,
    subscriptions: s.subscriptions as User['subscriptions'],
    registration_status: s.registration_status,
    guardian_managed: s.guardian_managed,
  });
  setIsLoggedIn(true);
  setIsOffline(true);
  // In a shell, what the app kept of this account's trust comes back first.
  await adoptKeptTrust(accountId);
  try { loadPinnedKeysFromStorage(accountId); } catch { /* non-fatal */ }

  // Only the sessionStorage rung of the key ladder can work with no server:
  // the client-key rungs fetch a ciphertext and the portal handoff is a
  // navigation. The Android shell injects those values at document start, so
  // this succeeds there; in a browser it succeeds for a reload within the same
  // tab session. When it does not, the app runs in the already-handled
  // "authenticated but no key" state — noteDb stores decrypted notes precisely
  // so the grid still renders (see its AT-REST TRADEOFF note).
  if (restoreFromSession()) {
    setKeysUnavailable(null);
    setKeysLoaded(true);
  } else {
    // Locked until the server is back: App.tsx re-runs checkAuth on the
    // `online` event, and that run can federate. In the iOS key-bridge shell
    // only the app can hand the key over.
    setKeysUnavailable(inBridgeMode() ? 'app' : 'unreachable');
  }
  setIsReady(true);
  return true;
}

function setCachedOwner(id: string): void {
  try { localStorage.setItem(OWNER_KEY, id); } catch { /* non-fatal */ }
}

/**
 * Full local wipe of one account's decrypted state — the exact set logout()
 * clears, minus the network call + navigation. Runs before another account (or
 * a no-session state) can hydrate this browser's cache. clearKeys() also sweeps
 * OWNER_KEY + pingolin_note_metadata, so callers that need the new id retained
 * must setCachedOwner() AFTER awaiting this.
 */
async function wipeLocalUserData(): Promise<void> {
  clearKeys();
  clearRetainedKeys();
  // The previous account's recovered pre-reset keys, its count and the
  // re-check's pending flag must not carry over to the next account.
  resetPreviousIdentities();
  // The push subscription belongs to the account that is leaving: if it
  // outlived a sign-out, a shared device would keep receiving the previous
  // account's "Reminder" tickles. Unsubscribe here (server row deleted, or
  // pruned on its next 404/410) and keep the worker: it holds nothing
  // account-specific, and unregistering it deactivates any subscription the
  // next login makes until a reminder happens to be set again.
  await unsubscribePush().catch(() => false);
  await clearLocalCache();
  notebooksStore.reset();
}

export const authStore = {
  user,
  subscriptionTier,
  isAuthenticated: () => isLoggedIn(),

  // Account still awaiting admin approval. While pending the app shows only
  // the <PendingReview/> gate — Note is blocked server-side anyway (the JWT
  // audience excludes "note" until approval). Cleared once an admin approves.
  isPending: () => user()?.registration_status === 'pending',

  isReady: () => isReady(),
  keysLoaded: () => keysLoaded(),

  /** Signed in, but this tab holds no E2EE keys — and why. See
   *  KeysUnavailableReason. The app is locked while this is set. */
  keysUnavailable: () => keysUnavailable(),
  /** Whether the notice should show: locked, and not hidden by the user. */
  keysNoticeVisible: () => keysUnavailable() !== null && !keysNoticeDismissed(),
  /** Hide the notice for this load. The app stays locked (keysUnavailable()
   *  still says so); the next load that cannot unlock shows it again. */
  dismissKeysUnavailable: () => setKeysNoticeDismissed(true),
  /** Where "Unlock" goes: the portal's sign-in, which hands the key back to
   *  this page (or asks for the password and seals one). A click there counts
   *  as user activation, which the hidden federation iframe can never have. */
  unlockUrl: () => `${getAuthUiUrl()}/login?redirect=${encodeURIComponent(window.location.href)}`,

  /**
   * Re-read the keys a native shell just wrote into sessionStorage and, if
   * they are good, leave the locked state. Returns whether keys are loaded —
   * the contract of `window.__pingolinKeysUpdated`, which calls this after the
   * shell re-runs its handoff against a retained document.
   */
  adoptSessionKeys(): boolean {
    // Before checkAuth has confirmed an account, restoreFromSession has nothing
    // to check the handed keys against and refuses; the confirmed run restores
    // them.
    const ok = restoreFromSession();
    if (ok) {
      setKeysUnavailable(null);
      setKeysLoaded(true);
    }
    return ok;
  },

  /** Session resumed from cache because the server was unreachable. */
  isOffline: () => isOffline(),

  /**
   * The open-tab re-check: ask /auth/me whose session this browser now
   * carries. Another account, or this account with other keys (a password
   * reset elsewhere), stops the tab: wipe, then reload. A definite sign-out
   * runs the usual wipe. A network failure proves nothing and is left for
   * the next check. Called on coming into view and on a timer; the account
   * header on every request is what stops a hidden tab in between.
   */
  async recheckAccount(): Promise<void> {
    const acct = getTabAccount();
    const keys = expectedAccount();
    if (!acct || !keys || isOffline()) return;
    let response: Response;
    try {
      response = await accountFetch(`${API_URL}/auth/me`, { credentials: 'include' });
    } catch {
      return;
    }
    if (classifyFailure({
      status: response.status,
      contentType: response.headers.get('content-type'),
    }) === 'denied' && !response.ok) {
      await wipeLocalUserData();
      window.location.reload();
      return;
    }
    if (!response.ok) return;
    let body: { data?: { id?: unknown; sharing_public_key?: string | null; signing_public_key?: string | null } };
    try {
      body = await response.json();
    } catch {
      return;
    }
    const id = tryCanonicalAccountId(body?.data?.id);
    const now = id ? accountKeysFrom(id, body.data?.sharing_public_key, body.data?.signing_public_key) : null;
    if (!now || now.id !== acct || !sameAccountKeys(now, keys)) {
      console.warn('[Note] this tab no longer matches the signed-in account — reloading');
      reportAccountMismatch();
    }
  },

  async checkAuth() {
    // Start the session check before waiting on crypto.
    //
    // /auth/me is a cookie-authenticated GET that needs no crypto at all, while
    // `initCrypto()` fetches a ~434KB chunk, decodes a ~296K-char base64
    // literal and instantiates ~222KB of WASM — and the whole app renders a
    // spinner until the session is known. Overlapping them removes a full
    // network round trip from every cold start.
    const me = accountFetch(`${API_URL}/auth/me`, { credentials: 'include' });
    // Swallow nothing — just stop an early rejection becoming an unhandled
    // rejection while we wait on crypto. The await below still sees it.
    me.catch(() => {});

    await initCrypto();

    try {
      let response = await me;
      // Single retry on 401/403 — absorbs the brief window right after an
      // SRP login redirect when the Set-Cookie header from /auth/srp/step2
      // hasn't been committed to the cookie jar by the time note-ui's first
      // /me call leaves the browser. Without this, the user gets bounced
      // back to the login page on what they see as a successful first-time
      // login.
      if (!response.ok && (response.status === 401 || response.status === 403)) {
        await new Promise((r) => setTimeout(r, 200));
        response = await accountFetch(`${API_URL}/auth/me`, {
          credentials: 'include',
        });
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          // Only a genuine auth denial from the auth service is proof the
          // session ended, and that always carries a JSON error body
          // (content-type: application/json). A Cloudflare / WAF edge 403 serves
          // an HTML challenge page — NOT proof the cookie is gone — so treat it
          // as transient and do NOT wipe (wiping would destroy the offline-edit
          // queue + retained keys over an edge block). The success-path
          // owner-mismatch wipe below stays the primary cross-account defense,
          // so skipping the wipe on a non-JSON edge 403 reopens nothing.
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            // Definitive no-session (portal-side logout / cookie expiry) — the
            // retry above already re-checked. Wipe this browser's decrypted-note
            // cache + derived state BEFORE returning so the NEXT account can't
            // hydrate the prior one's plaintext.
            await wipeLocalUserData();
          }
        }
        // Any OTHER non-OK (500/502/503/429 — a transient backend blip or rate
        // limit) is NOT proof the session is gone: the cookie may still be
        // valid. Do NOT wipe — that would destroy the `pending` IDB offline-edit
        // queue and retained keys on a temporary outage. Since it is not proof,
        // do not sign the user out either: resume from the last confirmed
        // session if it is recent enough, and re-verify when the server is back.
        if (classifyFailure({
          status: response.status,
          contentType: response.headers.get('content-type'),
        }) === 'unknown' && await resumeFromCache()) {
          return;
        }
        setUser(null);
        setIsLoggedIn(false);
        setIsReady(true);
        return;
      }

      const userData = await response.json();
      // The account in its one canonical spelling: every comparison and
      // every store keyed by it uses this.
      const accountId = tryCanonicalAccountId(userData?.data?.id);
      if (!accountId) {
        console.warn('[Note] /auth/me named no account id');
        setUser(null);
        setIsLoggedIn(false);
        setIsReady(true);
        return;
      }
      // Before hydrating anything: if the authenticated user differs
      // from the last one we cached decrypted notes for, run the full logout
      // wipe so account B never renders account A's cache. First login (no prior
      // id) does NOT wipe. Store the new id AFTER the wipe — clearKeys() sweeps
      // OWNER_KEY, so writing it earlier would be undone.
      const prevOwner = tryCanonicalAccountId(getCachedOwner());
      if (prevOwner && prevOwner !== accountId) {
        await wipeLocalUserData();
      }
      // What older builds kept once per browser (the note cache and its queue,
      // the metadata, settings and the rest) is this account's only if the
      // browser recorded this account as its owner; otherwise nobody can say
      // whose it is, and it is deleted unread. Then nothing of any other
      // account stays behind: a different account has signed in.
      const ownerKnown = prevOwner === accountId;
      adoptLegacyStores(accountId, ownerKnown);
      await adoptLegacyCache(accountId, ownerKnown);
      migratePinnedKeys(accountId, ownerKnown);
      keepOnlyAccountStores(accountId);
      void keepOnlyAccountCache(accountId);
      setCachedOwner(accountId);
      // From here the tab acts as this account: its requests name it, and the
      // keys it kept are used only if they are this account's.
      setTabAccount(accountId);
      expectAccount(accountKeysFrom(
        accountId, userData.data.sharing_public_key, userData.data.signing_public_key,
      ));

      const confirmed: User = { id: accountId, email: userData.data.email, subscriptions: userData.data.subscriptions, registration_status: userData.data.registration_status, guardian_managed: userData.data.guardian_managed };
      setUser(confirmed);
      setIsLoggedIn(true);
      // Re-arm push for this account. Sign-out unsubscribes (above), and the
      // only other subscribe lives inside the reminder picker — without this,
      // after a re-login reminders would stay silent on this browser until the
      // next reminder was set. Runs only if permission was granted earlier.
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        void ensurePushSubscription();
      }
      // The server just confirmed this session, so any earlier offline resume
      // is settled and the clock on the offline trust window restarts here.
      setIsOffline(false);
      writeCachedSession(confirmed, Date.now(), {
        sharing_public_key: userData.data.sharing_public_key ?? undefined,
        signing_public_key: userData.data.signing_public_key ?? undefined,
      });

      // In a shell, whose sign-out wipe deleted them, what the app kept of this
      // account's pins, floors and owners comes back first. Nothing has read
      // them yet: the inbox starts only after checkAuth.
      await adoptKeptTrust(accountId);
      // Rehydrate this user's TOFU pin store under their id namespace.
      // Without it, a shared browser would let user B load user A's pins.
      // Reads localStorage only (no key material), so it is safe to run
      // before the vault key is restored below.
      try { loadPinnedKeysFromStorage(accountId); } catch { /* non-fatal */ }

      // Restore E2EE vault key.
      // 1. Cross-origin fragment handoff. The account portal appended
      //    the wrapping key to the redirect fragment (#ck=...); fragments never
      //    reach the server. Read it, STRIP it from the URL immediately, then
      //    decrypt the server ciphertext with it.
      //
      //    BEFORE sessionStorage, not after: a fragment is the portal handing
      //    this tab the account's CURRENT key, seconds ago. The tab's session
      //    copy can be from an older identity — a password reset done in this
      //    tab replaces the account keypair, and preferring the stored copy
      //    would keep the page writing new notes under a superseded vault key
      //    that the account's other devices can no longer open.
      // In the iOS key-bridge shell the app owns the private keys; nothing is
      // loaded from a portal hand-off there.
      const bridged = inBridgeMode();
      const fragmentKey = bridged ? null : readClientKeyFromFragment();
      if (fragmentKey) {
        stripClientKeyFragment();
        const fragmentResult = await restoreFromClientKey(API_URL, fragmentKey.ck, fragmentKey.blobId);
        if (!fragmentResult.ok && fragmentResult.reason === 'bad-key') {
          await invalidateBadFederatedKey();
        }
        if (fragmentResult.ok) {
          setLocalBlobId(fragmentKey.blobId);
          // Fork/handoff succeeded — reset the guard so a future keyless state
          // (e.g. cleared storage) can federate again.
          sessionStorage.removeItem('note-e2ee-fork-attempted');
          setKeysUnavailable(null);
          setKeysLoaded(true);
          setIsReady(true);
          return;
        }
      }

      // 2. sessionStorage (instant, survives page refresh).
      if (restoreFromSession()) {
        setKeysUnavailable(null);
        setKeysLoaded(true);
        setIsReady(true);
        return;
      }

      // Bridge shell: the handoff is the only way in. Without a vault key from
      // it, stay locked — the app owns re-authentication, and a trip to the
      // portal would load private keys into this page.
      if (bridged) {
        console.warn('[Note] Notes locked: the app did not hand this page a key.');
        setKeysUnavailable('app');
        setKeysLoaded(true);
        setIsReady(true);
        return;
      }

      // 3. Same-origin: use the locally-persisted wrapping key (never the
      //    server). Populated by a prior fragment handoff on this origin.
      const localKey = getLocalClientKey();
      if (localKey) {
        if ((await restoreFromClientKey(API_URL, localKey, getLocalBlobId())).ok) {
          setKeysUnavailable(null);
          setKeysLoaded(true);
          setIsReady(true);
          return;
        }
      }

      // 4. No wrapping key available. This tab STAYS LOCKED until the account
      //    portal hands it the key; it never makes one.
      //
      //    The note vault key is DERIVED from the sharing private key, and every
      //    account has one — so there is no "first-time user" who needs a fresh
      //    key, only a user whose key has not reached this tab. The probe's "no
      //    ciphertext" answer cannot tell those apart from a failed request, and
      //    a key minted here would die with the tab, while an edit to a note
      //    shown from the offline cache would re-wrap that note under it and
      //    replace the stored wrap.
      //    Locked means isCryptoReady() stays false: sync, create and update
      //    all refuse, and the notice says why.
      // Asked in parallel with the iframe below: its answer only matters if
      // that fails, and awaiting it first would put a round trip in front of
      // every successful federation.
      const probeP = probeStoredKey(API_URL);

      // FIRST the hidden-iframe + postMessage handoff: frame the account
      // portal's /federate responder and ask it for the wrapping key. No
      // navigation — the key never touches a URL/address bar/history, and
      // there's no login-page flash. Reuse the SAME decrypt/persist path as the
      // fragment reader (restoreFromClientKey). Worth asking whatever the probe
      // said: a per-browser blob can exist where the probe's legacy answer is
      // empty, and after an `unknown` the portal may be fine.
      const accountOrigin = getAccountOrigin();
      if (accountOrigin) {
        const iframeKey = await requestKeyViaIframe(accountOrigin);
        const iframeResult = iframeKey
          ? await restoreFromClientKey(API_URL, iframeKey.ck, iframeKey.blobId)
          : null;
        if (iframeResult && !iframeResult.ok && iframeResult.reason === 'bad-key') {
          await invalidateBadFederatedKey();
        }
        if (iframeKey && iframeResult?.ok) {
          setLocalBlobId(iframeKey.blobId);
          sessionStorage.removeItem('note-e2ee-fork-attempted');
          setKeysUnavailable(null);
          setKeysLoaded(true);
          setIsReady(true);
          return;
        }
      }

      // Iframe handoff unavailable (portal not logged in / no key / framing
      // blocked / timeout) — fall back to the full-page redirect fork: bounce
      // once through the (cookie-)logged-in portal, which either hands the key
      // straight back in #ck= (Proton session-fork) or, when it holds none for
      // this browser, asks for the password and seals one. Guarded so a portal
      // that can't federate degrades instead of looping.
      //
      // Not on `unknown`: that answer means the server could not be asked, and
      // a page-wide redirect during an outage strands the user on the portal's
      // error page instead of their cached notes. The notice carries the same
      // link, for when they choose it.
      const probe = await probeP;
      const forkAttempted = sessionStorage.getItem('note-e2ee-fork-attempted');
      if (!forkAttempted && probe !== 'unknown') {
        sessionStorage.setItem('note-e2ee-fork-attempted', '1');
        const authUrl = getAuthUiUrl();
        const returnUrl = encodeURIComponent(window.location.href);
        console.warn(`[Note] No wrapping key in this tab (server copy: ${probe}) — unlocking via the account portal`);
        window.location.href = `${authUrl}/login?redirect=${returnUrl}`;
        return;
      }
      // Say so IN THE UI, then stay locked. A fresh portal sign-in re-seals and
      // hands a key off.
      console.warn(`[Note] Notes locked: no key for this tab (server copy: ${probe}).`);
      setKeysUnavailable(unavailableReasonFor(probe));
      setKeysLoaded(true);
      setIsReady(true);
    } catch (e) {
      // A tab stopped for another account's session is reloading: nothing
      // resumes.
      if (e instanceof AccountMismatchError) return;
      // A thrown fetch is the offline case — DNS failure, no route, connection
      // reset. It proves nothing about the session, and signing out here would
      // redirect to an account portal that is equally unreachable. Resume the
      // last confirmed session instead.
      if (await resumeFromCache()) return;
      setUser(null);
      setIsLoggedIn(false);
      setIsReady(true);
    }
  },

  redirectToLogin: () => {
    const returnUrl = encodeURIComponent(window.location.href);
    const authUrl = getAuthUiUrl();
    window.location.href = `${authUrl}/login?redirect=${returnUrl}`;
  },

  async logout() {
    try {
      await accountFetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch { /* ignore */ }
    clearKeys();
    resetPreviousIdentities();
    // Explicitly wipe the retired-content-key store on logout too. clearKeys()
    // already sweeps its localStorage key by literal; this is the self-documenting
    // belt-and-suspenders at the logout call site (both remove the same key).
    clearRetainedKeys();
    // See wipeLocalUserData: the subscription is the account's, the worker is not.
    await unsubscribePush().catch(() => false);
    // Wipe the decrypted-note IndexedDB cache + sync cursor so plaintext does
    // not survive a same-device account switch (best-effort; navigation follows).
    await clearLocalCache();
    // Reset the in-memory notebook/label/share signals too — clearKeys() drops
    // their persisted cache, but the derived signals would otherwise keep the
    // prior user's sidebar visible until navigation completes.
    notebooksStore.reset();
    setUser(null);
    setIsLoggedIn(false);
    setKeysLoaded(false);
    const authUrl = getAuthUiUrl();
    window.location.href = `${authUrl}/login`;
  },

  resendVerificationEmail: async (email: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await accountFetch(`${API_URL}/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        credentials: 'include',
      });
      const data = await response.json();
      return { success: data.success, error: data.error };
    } catch {
      return { success: false, error: 'Network error' };
    }
  },
};

// A request refused with 409 account_mismatch, or a re-check that finds another
// account: this tab holds another account's state. Wipe what it holds for it —
// keys in memory and in sessionStorage — and reload; the reload confirms
// whoever is signed in now and starts clean. The account's own namespaced
// caches stay for when it is back.
onAccountMismatch(() => {
  wipeTabState();
  resetPreviousIdentities();
  window.location.reload();
});
