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
  classifyFailure,
  decideOfflineBoot,
  OFFLINE_TRUST_WINDOW_MS,
  type CachedSession,
} from './offlineSession';

const session: CachedSession = { id: 'u1', email: 'a@b.c', verifiedAt: 1_000_000 };

/**
 * What a failed /auth/me proves. Getting this wrong in either direction is
 * user-visible: too strict and an aeroplane signs people out of an offline-
 * capable app; too loose and a real logout leaves a stale session running.
 */
describe('classifyFailure', () => {
  it('a thrown fetch is not proof of anything — that is the offline case', () => {
    expect(classifyFailure({ threw: true })).toBe('unknown');
  });

  it('a JSON 401 from the auth service IS proof the session ended', () => {
    expect(classifyFailure({ status: 401, contentType: 'application/json' })).toBe('denied');
    expect(classifyFailure({ status: 403, contentType: 'application/json; charset=utf-8' }))
      .toBe('denied');
  });

  /**
   * Hotel wifi answers every request with a login page. Treating that as proof
   * of logout would sign people out for connecting to wifi.
   */
  it('an HTML 401/403 is an edge challenge or captive portal, not a logout', () => {
    expect(classifyFailure({ status: 403, contentType: 'text/html' })).toBe('unknown');
    expect(classifyFailure({ status: 401, contentType: null })).toBe('unknown');
  });

  it('a backend blip is not a logout', () => {
    for (const status of [500, 502, 503, 429]) {
      expect(classifyFailure({ status, contentType: 'application/json' })).toBe('unknown');
    }
  });
});

describe('decideOfflineBoot', () => {
  it('resumes a session confirmed inside the window', () => {
    const d = decideOfflineBoot({ cached: session, nowMs: session.verifiedAt + 60_000 });
    expect(d).toEqual({ kind: 'resume', session });
  });

  it('resumes right up to the edge of the window', () => {
    const d = decideOfflineBoot({
      cached: session,
      nowMs: session.verifiedAt + OFFLINE_TRUST_WINDOW_MS,
    });
    expect(d.kind).toBe('resume');
  });

  it('signs out once the last confirmation is older than the window', () => {
    const d = decideOfflineBoot({
      cached: session,
      nowMs: session.verifiedAt + OFFLINE_TRUST_WINDOW_MS + 1,
    });
    expect(d).toEqual({ kind: 'sign-out', reason: 'stale' });
  });

  it('signs out when there is no cached session at all', () => {
    expect(decideOfflineBoot({ cached: null, nowMs: 1 }))
      .toEqual({ kind: 'sign-out', reason: 'no-session' });
    expect(decideOfflineBoot({ cached: { ...session, id: '' }, nowMs: 1 }))
      .toEqual({ kind: 'sign-out', reason: 'no-session' });
  });

  /**
   * Without this, winding the clock forward and back again extends offline
   * access indefinitely — the window is only as good as the clock it trusts.
   */
  it('refuses a confirmation timestamped in the future', () => {
    const d = decideOfflineBoot({ cached: session, nowMs: session.verifiedAt - 1 });
    expect(d).toEqual({ kind: 'sign-out', reason: 'clock' });
  });

  /**
   * The window mirrors the auth server's refresh-cookie lifetime, so offline
   * trust can never outlive the session the server itself would still honour.
   */
  it('matches the server refresh-cookie lifetime', () => {
    expect(OFFLINE_TRUST_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
