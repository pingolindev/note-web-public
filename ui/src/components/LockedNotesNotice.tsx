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
import { notesStore } from '../stores/notes';
import { getAccountUrl } from '../stores/auth';
import { LOCKED_NOTES_HOW_TO, PRE_RESET_SETTINGS_PATH, lockedNotesHeadline } from '../lib/lockedCopy';

/**
 * Says that notes still exist when this browser cannot open them.
 *
 * An email password reset replaces the account keypair, and Note's vault key is
 * derived from it, so every note written before the reset stops opening at
 * once. The ciphertext is intact and the recovery key from before the reset
 * restores it — but skipping each unreadable note and showing the new-account
 * empty state would lead to the natural conclusion that "everything is gone",
 * and the recovery key that could bring it back would go in the bin.
 *
 * Persistent on purpose: the notes stay locked until the recovery key restores
 * them, and a reminder that vanishes is how the key gets thrown away.
 */
const LockedNotesNotice: Component = () => {
  const count = () => notesStore.lockedOwnIds().size;
  return (
    <Show when={count() > 0}>
      <div class="notice-warning locked-notes-notice" role="status">
        <div>
          <strong>{lockedNotesHeadline(count())}</strong>{' '}{LOCKED_NOTES_HOW_TO}
        </div>
        <a class="btn btn-sm locked-notes-action" href={`${getAccountUrl()}${PRE_RESET_SETTINGS_PATH}`}>
          Open account settings
        </a>
      </div>
    </Show>
  );
};

export default LockedNotesNotice;
