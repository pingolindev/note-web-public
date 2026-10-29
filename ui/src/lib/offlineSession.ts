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
 * Deciding whether a boot with no reachable server may resume the last session.
 *
 * Gating startup on a live `/auth/me` and treating ANY failure as "logged out"
 * would make an aeroplane-mode launch redirect to the account portal — which
 * is equally unreachable. Everything downstream is built for offline (noteDb
 * caches decrypted notes precisely so the grid renders without the vault key;
 * notes.ts queues and replays edits); this is the front door.
 *
 * Two decisions live here, kept pure so they can be tested without a network,
 * a clock, or a browser:
 *
 *   1. Was that failure proof the session ended, or just proof we could not ask?
 *   2. If we could not ask, is the last confirmation recent enough to trust?
 *
 * The shape follows what password managers do with cached vaults: allow offline
 * use for a bounded window, and enforce revocation on reconnect rather than by
 * refusing to start. The compensating control: `checkAuth` calls
 * `wipeLocalUserData()` on a definitive denial.
 */

/** What a failed `/auth/me` actually proves. */
export type AuthFailure =
  /** The auth service explicitly rejected this session. It is over. */
  | 'denied'
  /** We could not get an answer. Says nothing about the session. */
  | 'unknown';

export interface FailureInput {
  /** HTTP status, when a response came back at all. */
  status?: number;
  /** `content-type` of that response. */
  contentType?: string | null;
  /** True when fetch threw (offline, DNS failure, connection reset). */
  threw?: boolean;
}

/**
 * Only a well-formed rejection from the auth service counts as "signed out".
 *
 * A thrown fetch is the offline case. A 5xx/429 is a backend blip. And a 401 or
 * 403 carrying HTML rather than JSON is an edge challenge or a captive portal —
 * hotel wifi answers every request with a login page, and treating that as
 * proof of logout would sign people out for connecting to wifi. `checkAuth`
 * applies exactly this content-type reasoning on the response path; this
 * extends it to the throw path.
 */
export function classifyFailure(input: FailureInput): AuthFailure {
  if (input.threw) return 'unknown';
  if (input.status === 401 || input.status === 403) {
    return (input.contentType || '').includes('application/json') ? 'denied' : 'unknown';
  }
  return 'unknown';
}

/** The last server-confirmed session, persisted for offline resume. */
export interface CachedSession {
  id: string;
  email: string;
  registration_status?: string;
  guardian_managed?: boolean;
  /**
   * Entitlements as of the last confirmation. Cached so a paying user going
   * offline does not read as free — which would hide features they paid for
   * and show upgrade prompts. Opaque here to keep this module free of store
   * imports; the caller owns the shape.
   */
  subscriptions?: unknown[];
  /** The account's registered public keys (standard base64) as of the last
   *  confirmation: the offline resume checks the tab's keys against them. */
  sharing_public_key?: string;
  signing_public_key?: string;
  /** Epoch ms of the last successful `/auth/me`. */
  verifiedAt: number;
}

export type BootDecision =
  /** Render from cache as this user; re-verify when the network returns. */
  | { kind: 'resume'; session: CachedSession }
  /** No trustworthy cached session — fall through to the normal signed-out path. */
  | { kind: 'sign-out'; reason: 'no-session' | 'stale' | 'clock' };

/**
 * How long a cached session may be used without the server confirming it.
 *
 * Deliberately NOT a new invented number: it mirrors the auth server's
 * refresh-cookie lifetime (30 days, its maximum session timeout). That is
 * already the longest the server would honour this session without contact, so
 * offline trust can never outlive online trust.
 */
export const OFFLINE_TRUST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function decideOfflineBoot(opts: {
  cached: CachedSession | null;
  nowMs: number;
  windowMs?: number;
}): BootDecision {
  const { cached, nowMs } = opts;
  const windowMs = opts.windowMs ?? OFFLINE_TRUST_WINDOW_MS;

  if (!cached || !cached.id) return { kind: 'sign-out', reason: 'no-session' };

  const age = nowMs - cached.verifiedAt;
  // A verifiedAt in the future means the clock moved backwards (timezone fix,
  // NTP correction, a user changing the date). Treat it as untrustworthy rather
  // than as infinitely fresh — otherwise setting the clock forward and back is
  // a way to extend offline access indefinitely.
  if (age < 0) return { kind: 'sign-out', reason: 'clock' };
  if (age > windowMs) return { kind: 'sign-out', reason: 'stale' };

  return { kind: 'resume', session: cached };
}
