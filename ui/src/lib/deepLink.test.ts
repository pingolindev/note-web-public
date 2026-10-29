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
import { resolveDeepLink } from './deepLink';

/**
 * `/note/:id` resolution.
 *
 * The case worth protecting is the race: a push tap opens the app at a note
 * that has not synced down yet. Treating "absent" as "missing" would flash a
 * "note isn't available" banner on every cold start — which is worse than no
 * banner, because it trains people to dismiss the one that is telling the
 * truth.
 */
describe('resolveDeepLink', () => {
  it('opens the note when it is already known', () => {
    expect(resolveDeepLink({
      wantedId: 'n1', knownIds: ['n0', 'n1'], loaded: true,
    })).toEqual({ kind: 'open', id: 'n1' });
  });

  it('waits — does NOT report missing — while the first sync is still running', () => {
    expect(resolveDeepLink({
      wantedId: 'n1', knownIds: [], loaded: false,
    })).toEqual({ kind: 'wait' });
  });

  it('opens the note once a later sync brings it in', () => {
    const before = resolveDeepLink({ wantedId: 'n1', knownIds: [], loaded: false });
    const after = resolveDeepLink({ wantedId: 'n1', knownIds: ['n1'], loaded: true });
    expect(before).toEqual({ kind: 'wait' });
    expect(after).toEqual({ kind: 'open', id: 'n1' });
  });

  it('reports missing only after the load finished without it', () => {
    expect(resolveDeepLink({
      wantedId: 'gone', knownIds: ['n0'], loaded: true,
    })).toEqual({ kind: 'missing' });
  });

  /**
   * Without this the effect re-opens the modal the moment the user closes it,
   * because the route param is still set — an editor that cannot be dismissed.
   */
  it('does nothing when the wanted note is already open', () => {
    expect(resolveDeepLink({
      wantedId: 'n1', openId: 'n1', knownIds: ['n1'], loaded: true,
    })).toEqual({ kind: 'wait' });
  });

  it('does nothing when there is no deep link at all', () => {
    expect(resolveDeepLink({ knownIds: ['n1'], loaded: true })).toEqual({ kind: 'wait' });
    expect(resolveDeepLink({ wantedId: null, knownIds: [], loaded: true })).toEqual({ kind: 'wait' });
  });

  /** A different note being open must not block the link from resolving. */
  it('switches to the linked note when a different one is open', () => {
    expect(resolveDeepLink({
      wantedId: 'n2', openId: 'n1', knownIds: ['n1', 'n2'], loaded: true,
    })).toEqual({ kind: 'open', id: 'n2' });
  });
});
