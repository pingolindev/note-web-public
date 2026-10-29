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
import { getBillingUrl } from '../stores/auth';

/**
 * The standing end-to-end-encryption assurance shown on every subscription
 * prompt: users must never think that paying (or not) changes who can read
 * their notes. Keep this wording identical across the share, reminder,
 * attachment, and note-limit surfaces.
 */

interface Props {
  /** Headline explaining which limit/feature was hit and the benefit. */
  message: string;
  /** Optional smaller line under the headline (e.g. current usage figures). */
  detail?: string;
}

/**
 * Reusable subscription-upgrade prompt: star icon, a limit/feature message,
 * the standing E2EE privacy line, and a CTA to the account billing page.
 * Shares the `.upgrade-prompt` styling with SharePanel so all four limit
 * surfaces read identically.
 */
const UpgradePrompt: Component<Props> = (props) => {
  // Inside a native shell the web billing page must NOT be the CTA: Apple
  // 3.1.1 requires the purchase go through StoreKit (the iOS shell presents
  // the native IAP sheet), and Google Play prohibits steering to an external
  // purchase method when not on Play Billing (the Android shell shows a
  // read-only Premium explainer). The shells announce themselves with this
  // marker at document start; browsers keep the billing link. Read at render,
  // not module load — the prompt only ever mounts long after document start.
  const shellScheme = () =>
    (window as { __pingolinShellUpgrade?: string }).__pingolinShellUpgrade;

  // Second signal, and the one that has to hold when the first does not. The
  // Android shell installs its markers with addDocumentStartJavaScript, which is
  // unavailable on some WebView builds — `installNativeShellMarker` returns false
  // there and NO marker is set. Without this, those devices would fall through to
  // the browser CTA below and be shown an external web-checkout link for digital
  // goods inside the app, which is exactly the steering Play prohibits. The UA
  // token needs no feature support, so it survives on the devices the marker
  // cannot reach. Must match SHELL_UA_TOKEN in the Android app's WebAppActivity.
  const NATIVE_SHELL_UA_TOKEN = 'PingolinNativeShell';
  const inNativeShell = () =>
    !!shellScheme() || navigator.userAgent.includes(NATIVE_SHELL_UA_TOKEN);
  return (
    <div class="upgrade-prompt">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
      <p>{props.message}</p>
      <Show when={props.detail}>
        <p class="upgrade-detail">{props.detail}</p>
      </Show>
      <Show
        when={inNativeShell()}
        fallback={
          <a href={getBillingUrl()} class="btn btn-sm btn-primary" target="_blank" rel="noopener">
            Upgrade
          </a>
        }
      >
        <Show
          when={shellScheme()}
          fallback={
            /* In the shell but with no upgrade scheme to deep-link to: say where
               to go rather than offer a button that cannot work, and never fall
               back to the external link. */
            <p class="upgrade-detail">
              Manage your subscription from the Pingolin account settings on this device.
            </p>
          }
        >
        <button
          class="btn btn-sm btn-primary"
          onClick={() => {
            window.location.href = `${shellScheme()}://open`;
          }}
        >
          Premium
        </button>
        </Show>
      </Show>
    </div>
  );
};

export default UpgradePrompt;
