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
  keysUnavailableCopy, lockedNotesHeadline, LOCKED_NOTES_HOW_TO, PRE_RESET_SETTINGS_PATH,
  offersPortalUnlock, type KeysUnavailableReason,
} from './lockedCopy';

/**
 * The words matter here more than anywhere: silence, or the wrong words
 * ("Notes you add appear here"), lead people to throw away recovery keys.
 */
describe('keysUnavailableCopy', () => {
  const reasons: KeysUnavailableReason[] = ['not-federated', 'no-server-key', 'unreachable', 'app'];

  it.each(reasons)('%s: tells the user nothing is lost', (reason) => {
    const c = keysUnavailableCopy(reason);
    expect(c.title.length).toBeGreaterThan(0);
    expect(c.body).toMatch(/nothing has been lost/);
  });

  it('never tells anyone their notes are gone or that they must start again', () => {
    for (const r of reasons) {
      expect(keysUnavailableCopy(r).body).not.toMatch(/deleted|gone|start over|new account/i);
    }
  });
});

describe('lockedNotesHeadline', () => {
  it('counts in the singular and the plural', () => {
    expect(lockedNotesHeadline(1)).toBe('1 note from before your password reset is locked.');
    expect(lockedNotesHeadline(5)).toBe('5 notes from before your password reset are locked.');
  });

  it('points at the portal card that restores them', () => {
    expect(LOCKED_NOTES_HOW_TO).toMatch(/recovery key/);
    expect(LOCKED_NOTES_HOW_TO).toMatch(/Data from before your password reset/);
    expect(PRE_RESET_SETTINGS_PATH).toBe('/settings#pre-reset-data');
  });
});

describe('offersPortalUnlock', () => {
  it('offers the portal everywhere except the iOS key-bridge shell', () => {
    expect(offersPortalUnlock('not-federated')).toBe(true);
    expect(offersPortalUnlock('no-server-key')).toBe(true);
    expect(offersPortalUnlock('unreachable')).toBe(true);
    // A portal sign-in hands keys to a browser tab, never to the app.
    expect(offersPortalUnlock('app')).toBe(false);
  });
});
