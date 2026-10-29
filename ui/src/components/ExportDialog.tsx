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

interface Props {
  exporting: boolean;
  passphrase: string;
  onPassphrase: (v: string) => void;
  /**
   * Why the export did not happen, empty when nothing has gone wrong. It is
   * shown HERE, in the dialog that asked for the export, because the one thing
   * that can fail — handing an oversized file to the Android/iOS shell —
   * happens only inside a shell, and a shell is the one place the browser's
   * own `alert()` cannot be seen (iOS implements no WKUIDelegate panel method
   * at all). The dialog stays open while this is set.
   */
  error?: string;
  onCancel: () => void;
  onExport: () => void;
}

/**
 * Asks the passphrase question at the moment the user chooses to export.
 *
 * The choice belongs to the export, so it is asked once, here, and the button
 * says what it will do. A passphrase field kept permanently in Settings would
 * ask "encrypt with a passphrase?" of everyone who opens Settings, whether or
 * not they are exporting, and the export button would silently change its own
 * label depending on whether that field happened to have text in it.
 */
const ExportDialog: Component<Props> = (props) => {
  const encrypted = () => props.passphrase.length > 0;

  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).classList.contains('modal-overlay') && !props.exporting) {
          props.onCancel();
        }
      }}
    >
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Export my data">
        <div class="modal-header">
          <h2>Export my data</h2>
          <p>Your notes, notebooks, labels and reminders, in one file.</p>
        </div>

        <div class="modal-content">
          <label class="dialog-field">
            <span>Encrypt with a passphrase (optional)</span>
            <input
              type="password"
              autocomplete="new-password"
              value={props.passphrase}
              onInput={(e) => props.onPassphrase(e.currentTarget.value)}
              placeholder="Leave blank for a readable file"
              disabled={props.exporting}
            />
          </label>
          <p class="dialog-hint">
            <Show
              when={encrypted()}
              fallback={
                <>
                  Without a passphrase the file is readable — that is what another
                  app needs to import it, but it also means anyone who opens the
                  file can read your notes.
                </>
              }
            >
              The file will be encrypted and only you can open it. There is no way
              to recover a lost passphrase.
            </Show>
          </p>
          <Show when={props.error}>
            <p class="dialog-error" role="alert">{props.error}</p>
          </Show>
        </div>

        <div class="modal-actions" style={{ gap: '8px' }}>
          <button class="btn btn-secondary" onClick={props.onCancel} disabled={props.exporting}>
            Cancel
          </button>
          <button class="btn btn-primary" onClick={props.onExport} disabled={props.exporting}>
            {props.exporting
              ? 'Exporting…'
              : encrypted()
                ? 'Export encrypted backup'
                : 'Export my data'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportDialog;
