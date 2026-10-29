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

import { For, Show, createSignal } from 'solid-js';
import { sharesInboxStore } from '../stores/sharesInbox';

/**
 * Security banner shown when a share sender's directory signing/sharing key no
 * longer matches the key we TOFU-pinned. A legitimate rotation (the auth
 * regenerate flow) and a malicious server key-substitution are indistinguishable
 * from the wire, so every share from that sender is dropped as 'invalid' until
 * the user compares the Signal-style safety number out-of-band and approves the
 * new key. Approving re-pins the rotated keys and reloads the inbox so the
 * previously-hidden shares verify + decrypt. Dismiss hides it without approving.
 */
export default function KeyChangeAlarms() {
  return (
    <Show when={sharesInboxStore.keyChangeAlarms().length > 0}>
      <div
        style={{
          margin: '8px 12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
        }}
        role="alert"
      >
        <For each={sharesInboxStore.keyChangeAlarms()}>
          {(alarm) => (
            <AlarmCard userId={alarm.userId} email={alarm.email} affected={alarm.affectedCount} />
          )}
        </For>
      </div>
    </Show>
  );
}

function AlarmCard(props: { userId: string; email: string | null; affected: number }) {
  const [revealed, setRevealed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const approve = async () => {
    setBusy(true);
    try {
      await sharesInboxStore.approveKeyChange(props.userId);
    } finally {
      setBusy(false);
    }
  };

  // Same themed warning surface as BlockedShares, so it follows the light
  // and dark themes.
  return (
    <div class="notice-warning notice-warning-static">
      <div style={{ 'font-weight': '600' }}>
        ⚠️ Is this really {props.email ?? 'this sender'}?
      </div>
      <div style={{ 'margin-top': '4px' }}>
        <Show
          when={props.affected > 0}
          fallback={<>Anything they share stays hidden until you confirm it's them.</>}
        >
          {props.affected} shared note{props.affected === 1 ? '' : 's'} from this sender{' '}
          {props.affected === 1 ? 'is' : 'are'} hidden until you confirm it's them.
        </Show>
      </div>
      <div style={{ 'margin-top': '6px' }}>
        They may have reset their password. Only confirm after checking their security
        code with them over a call or in person. If you weren't expecting this, don't confirm.
      </div>

      <Show
        when={revealed()}
        fallback={
          <button
            class="btn-icon"
            style={{ 'margin-top': '8px', 'text-decoration': 'underline', background: 'none' }}
            onClick={() => setRevealed(true)}
          >
            Show security code
          </button>
        }
      >
        <code class="notice-warning-code">
          {sharesInboxStore.safetyNumber(props.userId) ?? 'Security code unavailable'}
        </code>
      </Show>

      <div style={{ 'margin-top': '10px', display: 'flex', gap: '8px' }}>
        <button class="btn" disabled={busy()} onClick={approve}>
          {busy() ? 'Confirming…' : "It's them"}
        </button>
        {/* Secondary on purpose: a bare `.btn` is the accent primary, so leaving
            this one bare would put two competing primaries side by side on a
            security prompt — the one place a reader should be able to tell
            "approve" from "dismiss" at a glance. */}
        <button
          class="btn btn-secondary"
          disabled={busy()}
          onClick={() => sharesInboxStore.dismissKeyChange(props.userId)}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
