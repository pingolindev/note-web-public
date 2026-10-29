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
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The web's own sign-out (not the shells'): the dialog says the device clears
 * "anything still waiting to sync", and wiping the queue at once would lose a
 * move that still owed its sharing (the notebook it left would keep the note
 * for its people). What is waiting is sent first when it can be, for ten
 * seconds at most, and anything left is asked about (lib/signOut, tested
 * there). The repository has no DOM tests: read from the source.
 */
describe('signing out of the web page', () => {
  it('after its dialog, sends what is waiting and asks about anything left (lib/signOut), with the store\'s own steps', () => {
    const view = readFileSync(join(__dirname, 'NotesView.tsx'), 'utf8');
    const handler = view.slice(view.indexOf("message: 'Sign out?',"), view.indexOf('title="Sign out"'));
    const call = handler.indexOf('await signOutAfterSending({');
    expect(call).toBeGreaterThan(0);
    expect(handler.slice(call)).toContain('flush: () => notesStore.flushPending(),');
    expect(handler.slice(call)).toContain('waiting: () => notesStore.waitingCount(),');
    expect(handler.slice(call)).toContain('confirm: confirmAction,');
    expect(handler.slice(call)).toContain('logout: () => authStore.logout(),');
    // Signed out only by it: never straight after the dialog.
    expect(handler.slice(0, call)).not.toContain('authStore.logout()');
  });
});
