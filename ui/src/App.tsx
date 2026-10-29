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

import { Component, createSignal, onCleanup, onMount, ParentProps, Show, Suspense } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { authStore } from './stores/auth';
import { notesStore } from './stores/notes';
import { keysArrivedAgain, startRemovalJobs } from './lib/rekeyDepsLive';
import { keepTrustNow } from './lib/keptTrust';
import { ConfirmHost } from './components/ConfirmDialog';
import { PromptHost } from './components/PromptDialog';
import BootSkeleton from './components/BootSkeleton';
import { startAccountRecheck } from './lib/accountRecheck';

// There are no unauthenticated paths: every route requires a session.

type ShellNavWindow = Window & {
  __pingolinNavigate?: (path: string) => void;
  __pingolinFlushPending?: () => Promise<number>;
  __pingolinKeysUpdated?: () => boolean;
  __pingolinKeepTrustNow?: () => Promise<boolean>;
};

const App: Component<ParentProps> = (props) => {
  const [loading, setLoading] = createSignal(true);
  const navigate = useNavigate();

  // Let the Android shell route WITHOUT reloading the document.
  //
  // A WebView built per note open and destroyed on close makes every tap
  // re-fetch index.html, re-parse ~1MB of JS, re-instantiate the libsodium
  // WASM and re-run checkAuth before it even fetches the note: on a Galaxy
  // A50 that is over three seconds from tap to usable, and a second open of
  // the same note costs the same, because none of that work survives a
  // destroyed WebView. Disk caching cannot help; the cost is parse and
  // execute, not download.
  //
  // The shell keeps one WebView alive and calls this instead of loadUrl, so
  // repeat opens are a client-side route change and pay only the note fetch and
  // decrypt. The shell falls back to loadUrl when this is undefined, so an older
  // APK against a newer web app, or a newer APK against an older one, both work
  // — which is what lets the two ship independently.
  //
  // Absolute URLs are refused: this is reachable from any script on the page,
  // and a router that will navigate anywhere is a redirect gadget. Same-origin
  // paths only.
  onMount(() => {
    const w = window as ShellNavWindow;
    w.__pingolinNavigate = (path: string) => {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return;
      // A TAP IS AN EVENT; A LOCATION IS AN IDENTITY.
      //
      // The shell calls this once per widget tap, share or push open. For
      // `/new` that call is a request to DO something, not to BE somewhere —
      // and two identical taps produce the identical string, which the router
      // correctly reports as no change, so the second one would do nothing at
      // all. Tap the Quick Capture "+", discard the composer, tap again: that
      // is the ordinary way the widget is used.
      //
      // A nonce makes each call a distinct location, which is the honest
      // encoding of "this is another event". `parseNewNoteLink` ignores the
      // `_` key (it reads only type/title/body), and NotesView's own strip
      // takes the whole fragment off the URL immediately, so it is never seen
      // and never persists. It carries no note content, so it is nothing the
      // fragment-only rule exists to protect.
      //
      // `/note/:id` and `/` are genuine destinations and are left alone: two
      // taps on the same note should be one location, and they are.
      if (path === '/new' || path.startsWith('/new#') || path.startsWith('/new?')) {
        const sep = path.includes('#') ? '&' : '#';
        navigate(`${path}${sep}_=${Date.now().toString(36)}`);
        return;
      }
      navigate(path);
    };
    // Pre-wipe drain hook. The shell's sign-out wipe destroys this document
    // and its IndexedDB; the OFFLINE QUEUE lives there, and the native abort
    // guard only sees the native store — so without this call an account
    // switch would report "clean" while the web editor's unsynced edits are
    // lost. Returns the count still pending after the drain (0 = safe to wipe).
    w.__pingolinFlushPending = () => notesStore.flushPendingAndReport();
    // Key-handoff refresh hook. The shell's document-start script only runs
    // on a page LOAD; a RETAINED document that lives across a native
    // re-login would keep signing with the previous session's identity — the
    // signature would not match the directory and every share would be
    // refused. The shell re-runs the handoff script against the live
    // document and then calls this so the in-memory keys reload too —
    // and, when the document had been left locked, unlocks it.
    w.__pingolinKeysUpdated = () => {
      const ok = authStore.adoptSessionKeys();
      // Keys arrived again in this document: its removal jobs are read again,
      // and nothing is adopted from the server until they are.
      if (ok) keysArrivedAgain();
      return ok;
    };
    // The shell's last keep before its sign-out wipe: this account's pins,
    // floors and owners, handed over once more. The shell bounds the wait.
    w.__pingolinKeepTrustNow = keepTrustNow;
    onCleanup(() => {
      delete w.__pingolinNavigate;
      delete w.__pingolinFlushPending;
      delete w.__pingolinKeysUpdated;
      delete w.__pingolinKeepTrustNow;
    });
  });

  onMount(async () => {
    try {
      await authStore.checkAuth();
    } catch (e) {
      console.error('Auth check failed:', e);
    } finally {
      setLoading(false);
    }

    // If not authenticated after check, redirect immediately
    // (don't let child routes flash before redirect)
    //
    // Except when the session was resumed from cache because the server could
    // not be reached: the portal we would redirect to is on the same network
    // that just failed us, so the redirect can only strand the user on an error
    // page. Render the cached notes and re-verify when the network returns.
    if (!authStore.isAuthenticated() && !authStore.isOffline()) {
      authStore.redirectToLogin();
    }

    // Finish any removal that was interrupted: its holds first, then its
    // re-keying (startRemovalJobs).
    await startRemovalJobs(authStore.isAuthenticated());
  });

  // Re-verify as soon as the network is back. This is what keeps the offline
  // window honest: a session revoked while the device was offline is enforced
  // here, on the first reachable /auth/me, rather than by having refused to
  // start. Deliberately only fires when we ARE running on a cached session —
  // an ordinary reconnect needs no re-check.
  const onOnline = () => {
    if (authStore.isOffline()) void authStore.checkAuth();
  };
  window.addEventListener('online', onOnline);
  onCleanup(() => window.removeEventListener('online', onOnline));

  // An open tab re-checks its account when it comes into view and once a
  // minute (lib/accountRecheck.ts).
  onCleanup(startAccountRecheck(() => void authStore.recheckAccount()));

  // Assisted-lane account still awaiting admin approval: a terminal under-review
  // gate matching the account app. Note is blocked server-side anyway (the JWT
  // audience excludes "note" until approval), so there's nothing functional to
  // show. Cleared once an admin approves.
  const PendingReview = () => (
    <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center">
      <div style="max-width:420px">
        <div style="font-size:44px;line-height:1;margin-bottom:12px">⏳</div>
        <h1 style="font-size:22px;font-weight:700;color:var(--text-primary,#111827);margin:0">Your account is under review</h1>
        <p style="margin-top:12px;color:var(--text-muted,#6b7280);line-height:1.5">
          Every privacy account request is checked by an admin before access is granted.
          We'll email you the moment it's approved — then Note unlocks automatically.
        </p>
        <button
          onClick={() => authStore.logout()}
          style="margin-top:20px;padding:8px 20px;border:1px solid var(--border-color,#d1d5db);border-radius:8px;background:var(--bg-secondary,#ffffff);color:var(--text-primary,#111827);font-size:14px;cursor:pointer"
        >
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* index.html has already painted this exact skeleton and hidden itself
          the moment we rendered; continuing it here is what makes the handoff
          invisible. A spinner in this slot would be the SECOND of three
          loading appearances for one wait. */}
      <Show when={!loading()} fallback={<BootSkeleton />}>
        <Show when={authStore.isAuthenticated()} fallback={
          <div class="loading-wrapper">
            <div class="loading-spinner" />
            <p style="margin-top: 16px; color: var(--text-muted)">Redirecting to login...</p>
          </div>
        }>
          {/* SUSPENSE, or the fallback is replaced by a SECOND blank screen.
              `props.children` is the router outlet, i.e. the lazy NotesView
              chunk. Without a boundary Solid renders "" until that chunk
              resolves, so the user would watch the loading state disappear
              into nothing for the length of the download and read it as a
              hang. Same skeleton as the gate above, so crossing this
              boundary is not a visible event. */}
          <Show
            when={authStore.isPending()}
            fallback={
              <Suspense fallback={<BootSkeleton />}>
                {props.children}
              </Suspense>
            }
          >
            <PendingReview />
          </Show>
        </Show>
      </Show>
      {/* One host for every confirmation in the app, mounted outside the auth
          gate so a dialog opened from deep inside the note modal is not
          rendered within it — the note modal's overlay is z-index 100 and a
          dialog nested inside it would inherit that stacking context. */}
      <ConfirmHost />
      {/* And its sibling for the one question that needs an answer typed
          rather than chosen — a sealed backup's passphrase. Same reasons for
          the same placement. */}
      <PromptHost />
    </>
  );
};

export default App;
