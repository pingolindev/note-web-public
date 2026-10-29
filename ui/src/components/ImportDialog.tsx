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

import { Component, lazy, Suspense } from 'solid-js';

/**
 * LAZY, and it has to stay that way.
 *
 * NotesView imports SettingsPanel and SettingsPanel imports this dialog, so a
 * static import of ImportView here would be a static edge from the NOTE LIST
 * to the importer. That would drag ImportView's chunk — 421KB raw, 94.6% of
 * it KaTeX, JSZip and DOMPurify — into the list's own chunk, so every cold
 * start would fetch, parse and execute a ZIP library to render note cards.
 * A `lazy()` at the route (index.tsx) cannot prevent that: a static import
 * anywhere wins.
 */
const ImportView = lazy(() => import('../pages/ImportView'));

interface Props {
  onClose: () => void;
}

/**
 * Import in a dialog rather than a whole page.
 *
 * Handing off to the `/import` route would mean leaving Settings — and the
 * notes behind it — to do something that takes one file picker. The route
 * still exists for a direct link; this renders the same surface in the app's
 * standard modal shell (`modal-overlay` / `modal-card`, the same one the rest
 * of the app uses) so it looks like part of the app instead of a separate
 * screen.
 */
const ImportDialog: Component<Props> = (props) => {
  return (
    <div
      class="modal-overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).classList.contains('modal-overlay')) props.onClose();
      }}
    >
      <div class="modal-card modal-card-lg" role="dialog" aria-modal="true" aria-label="Import notes">
        <div class="modal-header modal-header-bar">
          <h2>Import notes</h2>
          <button class="btn-icon" onClick={props.onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div class="modal-scroll">
          {/* The chunk is fetched on first open, so give the wait a spinner —
              without a boundary Solid renders nothing at all and the dialog would
              open as an empty card. */}
          <Suspense fallback={<div class="loading-wrapper"><div class="loading-spinner" /></div>}>
            <ImportView embedded onClose={props.onClose} />
          </Suspense>
        </div>
      </div>
    </div>
  );
};

export default ImportDialog;
