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

import { lazy } from 'solid-js';
import { render } from 'solid-js/web';
import { Route, Router } from '@solidjs/router';
import App from './App';
// Self-host IBM Plex (via @fontsource) so the browser never reaches
// out to fonts.googleapis.com — the app is E2EE end-to-end and
// shouldn't leak a request-per-visit to Google. Latin-only subsets
// to keep the bundle footprint tight — the default `NNN.css` import
// pulls in every language subset (Cyrillic, Greek, Vietnamese, etc.)
// and balloons the asset count.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './index.css';
import { registerOfflineShell } from './lib/offlineShell';

// Lazy-loaded so the critical bundle stays small — the notes app pulls in Yjs,
// CodeMirror and libsodium.
const NotesView = lazy(() => import('./pages/NotesView'));
const ImportView = lazy(() => import('./pages/ImportView'));

// START THE LIST CHUNK NOW, not after the auth phase.
//
// App gates the router outlet on `!loading()`, which only flips in the finally
// of `await authStore.checkAuth()` — and Solid's <Show> never reads its
// children while the condition is false. So the lazy() above would not even
// BEGIN its fetch until the /auth/me round trip and the libsodium WASM
// instantiate had both finished, leaving the download strictly after work it
// could have overlapped. preload() is the same trick NotesView uses on
// NoteModal; it is a prefetch, so a failure is retried by the ordinary lazy
// load when the route mounts.
// The erasure chain's stop here (lib/forgetAccount.ts) runs INSTEAD of the app:
// nothing signs in, loads or registers first, because the ordinary start would
// wipe every account's data on this browser, not only the erased one's.
const forgetting = window.location.pathname === '/forget-account';

if (!forgetting) void NotesView.preload();

// Fire-and-forget: the app must not wait on it, and a failure is survivable.
// Registered for EVERYONE, not only people who enabled notifications —
// registering it only alongside notifications would leave the offline shell
// uninstalled for most users.
if (!forgetting) void registerOfflineShell();

const root = document.getElementById('root');

if (forgetting) {
  void import('./lib/forgetAccount').then(({ runForgetAccount }) => runForgetAccount(window));
} else if (root) {
  render(
    () => (
      <Router root={App}>
        {/* Dedicated import surface, separate from the Settings panel. */}
        {/* Wrapped: ImportView also renders inside the Settings import
             dialog, so it takes its own props and is not a bare
             RouteSectionProps component. */}
        <Route path="/import" component={() => <ImportView />} />
        {/* Deep link to one note. Same component as the catch-all — the note
             opens as the usual modal over the grid, so backing out of it
             leaves the user somewhere sensible rather than on a dead end.
             This is what a push tap (and the Android shell) navigates to. */}
        <Route path="/note/:id" component={NotesView} />
        {/* Start a new note. Parameters ride in the FRAGMENT, never the query
             string: share-into-app passes the user's text, and a query string
             would put note content in the server's request log. Same reasoning
             as the `#ck=` key handoff. */}
        <Route path="/new" component={NotesView} />
        <Route path="/*" component={NotesView} />
      </Router>
    ),
    root
  );
}
