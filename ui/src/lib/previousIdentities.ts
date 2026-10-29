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
 * Identities from before a password reset.
 *
 * An email password reset replaces the account keypair, and note's vault key is
 * derived from it — so a reset makes EVERY note undecryptable at once. The
 * ciphertext is untouched; the key that opens it is simply gone until the user
 * recovers it with their recovery key in the account portal.
 *
 * That portal seals the recovered key under a value this app can derive from the
 * key it already federates, which is the only way it could reach us: we never
 * see the auth master key the portal's own copy is wrapped under.
 */

import {
  addPreviousIdentityKeys,
  addPreviousVaultKeys,
  deriveAppKey,
  decryptWithKey,
  getPreviousVaultKeys,
  getSharingPrivateKey,
  setPreviousIdentityKeys,
  setPreviousVaultKeys,
  PREVIOUS_IDENTITY_LABEL,
} from './crypto';
import { bridgePreviousVaultKeys } from './keyOps';
import { inBridgeMode } from './keyBridge';
import { accountFetch } from './account';

interface PreviousIdentityResponse {
  identities?: Array<{
    key_version: number;
    app_sealed_private_key?: { nonce: string; ciphertext: string };
  }>;
}

/** What one fetch opened: VAULT keys from the iOS shell, or private keys opened here. */
type Opened = { vault: Uint8Array[] } | { priv: Uint8Array[] };

/**
 * Bumped by resetPreviousIdentities(). A fetch or a shell read still out when
 * the account signs out or switches must add nothing afterwards: the shell's
 * answer carries no account check of its own, so without this a sign-out
 * during that read would put the previous account's keys into the next
 * session's memory.
 */
let epoch = 0;

/**
 * How long one load may take, answer and all, before the page goes on without
 * it.
 *
 * Every sync waits for the load before it asks for a single note, and the load
 * is made once and kept: without a limit, one request that never came back (a
 * connection that went quiet, a shell that did not answer) would stop every
 * sync of the session, with no error and nothing on screen. Going on without
 * it costs only that notes from before a password reset stay locked a little
 * longer, which is what they were.
 */
export const LOAD_LIMIT_MS = 20_000;

/**
 * After a load that did not get its answer, the next is not tried before this:
 * a server that keeps failing is not asked again at every sync.
 */
export const RETRY_AFTER_MS = 60_000;

/** `LOAD_LIMIT_MS` over: said by a load that was given up on. */
const GIVEN_UP = Symbol('given up');

/**
 * `work`, or `GIVEN_UP` once it has taken `LOAD_LIMIT_MS`. The work is told
 * through `signal`, so that a request still out is dropped and not left
 * hanging on the connection.
 */
async function withinLimit<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T | typeof GIVEN_UP> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof GIVEN_UP>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(GIVEN_UP);
    }, LOAD_LIMIT_MS);
  });
  try {
    return await Promise.race([work(controller.signal), limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** The server (or the shell) did not say: not "nothing was recovered". */
const NO_ANSWER = Symbol('no answer');

/**
 * Fetch and open whatever the account has recovered. `NO_ANSWER` when the
 * fetch failed. Null when this page holds no key to open it with, or when the
 * account's key changed while the fetch was out (a sign-out or an account
 * switch): the caller then keeps whatever it already holds.
 */
async function openRecovered(authApiUrl: string, signal?: AbortSignal): Promise<Opened | null | typeof NO_ANSWER> {
  // In the iOS key-bridge shell the page holds no private key to open these
  // with; the shell does it natively and hands over only each era's VAULT key
  // (the key bridge's previousVaultKeys op).
  const fromShell = await bridgePreviousVaultKeys();
  // A failed call is no answer, never "nothing recovered".
  if (fromShell === 'no-answer') return NO_ANSWER;
  if (fromShell) return { vault: fromShell };

  const current = getSharingPrivateKey();
  if (!current) return null;

  let body: { data?: PreviousIdentityResponse } | null = null;
  try {
    const response = await accountFetch(`${authApiUrl}/auth/previous-identities`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) return NO_ANSWER;
    // Under the same limit: an answer whose body never ends is no answer.
    body = await response.json();
  } catch {
    return NO_ANSWER;
  }
  // Opened for a key this page no longer holds: another account's, or none.
  if (getSharingPrivateKey() !== current) return null;

  const rows = body?.data?.identities ?? [];
  const wrap = deriveAppKey(current, PREVIOUS_IDENTITY_LABEL);
  const privateKeys: Uint8Array[] = [];
  for (const row of rows) {
    if (!row.app_sealed_private_key) continue;
    try {
      const privateKey = decryptWithKey(row.app_sealed_private_key, wrap);
      if (privateKey.length === 32) privateKeys.push(privateKey);
    } catch {
      // Sealed under a key we no longer hold — another reset since. It opens
      // nothing, so skipping it is right and saying so would be noise.
    }
  }
  return { priv: privateKeys };
}

/**
 * Fetch and open whatever the account has recovered.
 *
 * Returns 0 for the overwhelmingly common case — no reset, nothing recovered,
 * or a recovery predating this. Never throws: a failure here must not break an
 * otherwise working session, it only means older notes stay unreadable.
 */
export async function loadPreviousIdentities(authApiUrl: string): Promise<number> {
  return (await load(authApiUrl)) ?? 0;
}

/**
 * Has this session had an ANSWER about what the account recovered from before
 * a password reset? Until it has, a key that nothing here opens may yet open
 * with one not loaded, and nothing is to be rebuilt on the strength of "it
 * does not open" (lib/notebookRepair).
 */
let answered = false;

export function previousIdentitiesAnswered(): boolean {
  return answered;
}

/** As `loadPreviousIdentities`; null when there was no answer within the limit. */
async function load(authApiUrl: string): Promise<number | null> {
  const at = epoch;
  const opened = await withinLimit(signal => openRecovered(authApiUrl, signal));
  if (opened === GIVEN_UP || opened === NO_ANSWER) return null;
  if (!opened || at !== epoch) return 0;
  answered = true;
  if ('vault' in opened) {
    setPreviousVaultKeys(opened.vault);
    return opened.vault.length;
  }
  if (opened.priv.length === 0) return 0;
  setPreviousIdentityKeys(opened.priv);
  return opened.priv.length;
}

/**
 * Load once per session, at the point of need.
 *
 * Called before a sync pull rather than at login: it returns nothing for almost
 * every account, and putting it here means no key-restore path can forget it.
 * After a re-check opens more, it answers with the grown count, which is what
 * makes the next sync pull everything once (notes.ts, repullForRecovery).
 */
let pending: Promise<number> | null = null;
/** After a load with no answer: when the next one may be tried (`RETRY_AFTER_MS`). */
let retryNotBefore = 0;

/**
 * An ANSWER is kept for the session. A load that got none is not: kept, one
 * failure would answer "nothing recovered" for the rest of the session, and
 * (without a limit) one that never ended would hold every sync that asked.
 * The next sync after `RETRY_AFTER_MS` asks again; until then the answer is 0
 * at once.
 */
export async function ensurePreviousIdentities(authApiUrl: string): Promise<number> {
  if (!pending) {
    if (Date.now() < retryNotBefore) return 0;
    const at = epoch;
    const mine: Promise<number> = load(authApiUrl).then((count) => {
      if (count === null) {
        // Only if it is still this session's load: a sign-out has its own start.
        if (pending === mine && at === epoch) {
          pending = null;
          retryNotBefore = Date.now() + RETRY_AFTER_MS;
        }
        return 0;
      }
      if (count > 0) {
        console.info(`[crypto] ${count} recovered pre-reset identity(ies) available`);
      }
      return count;
    });
    pending = mine;
  }
  return pending;
}

/**
 * Check again what the account has recovered, and ADD what opens.
 *
 * The set only grows: the import replaces what it is given, so this passes the
 * union, and an empty, stale or wrong answer changes nothing here. Returns how
 * many identities opened that were not held before — 0 when nothing new did,
 * when the fetch failed, or when this page cannot open them.
 */
export async function recheckPreviousIdentities(authApiUrl: string): Promise<number> {
  const at = epoch;
  // The start-up load first, so a re-check never races it.
  await ensurePreviousIdentities(authApiUrl);
  if (at !== epoch) return 0;
  // Under the limit too: a re-check that never ended would keep its gate
  // shut, and no later one would run.
  const opened = await withinLimit(signal => openRecovered(authApiUrl, signal));
  // No answer; or signed out or switched while it was out: add nothing.
  if (opened === GIVEN_UP || opened === NO_ANSWER || !opened || at !== epoch) return 0;
  answered = true;
  const added = 'vault' in opened
    ? addPreviousVaultKeys(opened.vault)
    : addPreviousIdentityKeys(opened.priv);
  if (added > 0) {
    pending = Promise.resolve(getPreviousVaultKeys().length);
    console.info(`[crypto] ${added} more pre-reset identity(ies) opened on a re-check`);
  }
  return added;
}

/** At most one re-check per this window, whatever triggers it. */
export const RECHECK_WINDOW_MS = 3 * 60 * 1000;

export interface RecheckGate {
  /** A trigger. Runs now, or leaves the one pending flag. */
  request(): void;
  /** Sign-out or account switch: drop the flag, the timer and the window. */
  reset(): void;
}

/**
 * The re-check's limit. At most one run per window. A request refused because
 * a run is going or the window is open leaves ONE pending flag, which runs a
 * single re-check when the window ends (or at the next request after that);
 * that run is the next window's one. So a flood of triggers costs at most one
 * fetch per window.
 */
export function createRecheckGate(
  run: () => Promise<void>,
  opts: {
    windowMs: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  },
): RecheckGate {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer
    ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let running = false;
  let lastRunAt: number | null = null;
  let flagged = false;
  let timer: unknown = null;
  // Bumped by reset(), so a run that outlives a sign-out cannot touch the state
  // the next account starts from.
  let generation = 0;

  const windowLeft = () =>
    lastRunAt === null ? 0 : Math.max(0, lastRunAt + opts.windowMs - now());

  const arm = () => {
    if (timer !== null || running) return;
    timer = setTimer(() => {
      timer = null;
      if (flagged) request();
    }, windowLeft());
  };

  const start = () => {
    running = true;
    flagged = false;
    lastRunAt = now();
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const gen = generation;
    void run()
      .catch(() => { /* a failed re-check only means: try at the next trigger */ })
      .finally(() => {
        if (gen !== generation) return;
        running = false;
        if (flagged) arm();
      });
  };

  function request(): void {
    if (running || windowLeft() > 0) {
      flagged = true;
      arm();
      return;
    }
    start();
  }

  function reset(): void {
    generation++;
    running = false;
    flagged = false;
    lastRunAt = null;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return { request, reset };
}

/** What the page says about itself: is anything still locked since a reset,
 *  and how to reload once more opens. Set by the notes view while it is shown. */
export interface RecheckHooks {
  stillLocked: () => boolean;
  onNewIdentities: () => void;
}

let hooks: RecheckHooks | null = null;
let recheckUrl = '/api/v1';

const gate = createRecheckGate(async () => {
  // Re-read at run time: a deferred run may find everything open by then.
  if (!hooks?.stillLocked()) return;
  const added = await recheckPreviousIdentities(recheckUrl);
  if (added > 0) hooks?.onNewIdentities();
}, { windowMs: RECHECK_WINDOW_MS });

export function configurePreviousIdentitiesRecheck(next: RecheckHooks | null, authApiUrl = '/api/v1'): void {
  hooks = next;
  recheckUrl = authApiUrl;
}

/**
 * The tab came back into view: if notes are still locked since a reset,
 * check whether the account has restored them since. The web editor gets no
 * push for this — the server's nudge goes to phones only — so this is its way.
 */
export function requestPreviousIdentitiesRecheck(): void {
  if (!hooks?.stillLocked()) return;
  gate.request();
}

/**
 * The app shell says the account's earlier data may have changed (the mobile
 * apps' `pingolin-identities` window event, sent after the phone got the
 * server's nudge).
 *
 * In the iOS key-bridge shell the native side has already made the gated GET,
 * sends this only when something new opened, and the page's read is local IPC,
 * so re-read now. Anywhere else (the Android shell) the page makes its own
 * GET, so the event goes through the gate like a tab coming into view.
 */
export function onShellIdentitiesEvent(): void {
  if (!hooks?.stillLocked()) return;
  if (!inBridgeMode()) {
    gate.request();
    return;
  }
  void (async () => {
    const added = await recheckPreviousIdentities(recheckUrl);
    if (added > 0) hooks?.onNewIdentities();
  })();
}

/** Sign-out and account switch: forget the held identities, the count and the
 *  re-check's flag and window. */
export function resetPreviousIdentities(): void {
  epoch++;
  pending = null;
  retryNotBefore = 0;
  answered = false;
  setPreviousIdentityKeys([]);
  gate.reset();
}
