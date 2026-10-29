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

import { Component, Show } from 'solid-js';
import { authStore } from '../stores/auth';
import { keysUnavailableCopy, offersPortalUnlock } from '../lib/lockedCopy';

/**
 * Shown while this tab is signed in but holds no E2EE keys — the app is locked:
 * nothing decrypts, syncs or saves until the account portal hands the key over.
 *
 * Without it this is a dead end. Somebody who pressed Back on the portal's
 * "Enter your password to continue" screen gets the cached (or an empty) grid,
 * no sync, and a composer that swallows every note, with nothing on screen
 * connecting it to a key handoff that quietly failed. The words are Note's
 * own (lib/lockedCopy.ts).
 *
 * Persistent rather than a toast: the condition lasts until the user visits the
 * portal. The action matters more than the text — unlocking happens on the
 * account origin, where a click counts as user activation, which the hidden
 * federation iframe can never have.
 */
const KeysUnavailableNotice: Component = () => (
  <Show when={authStore.keysNoticeVisible() && authStore.keysUnavailable()} keyed>
    {(reason) => (
      <div class="notice-warning keys-unavailable-notice" role="status">
        <div class="keys-unavailable-text">
          <strong>{keysUnavailableCopy(reason).title}</strong>
          <span>{keysUnavailableCopy(reason).body}</span>
        </div>
        <div class="keys-unavailable-actions">
          <Show when={offersPortalUnlock(reason)}>
            <a class="btn btn-sm keys-unavailable-unlock" href={authStore.unlockUrl()}>
              Unlock
            </a>
          </Show>
          <button
            type="button"
            class="keys-unavailable-dismiss"
            onClick={() => authStore.dismissKeysUnavailable()}
            aria-label="Hide this notice"
          >
            ×
          </button>
        </div>
      </div>
    )}
  </Show>
);

export default KeysUnavailableNotice;
