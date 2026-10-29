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

/**
 * Service worker for Pingolin Note — Web Push, and the offline app shell.
 *
 * ## Push (unchanged)
 *
 * "Tickle-only": the server sends an opaque push with no reminder text (it is
 * E2EE-blind). The SW shows a generic "Reminder" that focuses/opens the app,
 * which then fetches pending reminders over the normal authenticated API and
 * renders the real title/body from the decrypted note. No note content ever
 * rides the push payload.
 *
 * ## Offline shell
 *
 * Both mobile clients ARE this web app — Android's home screen is
 * WebAppActivity at the origin root, iOS's RootView renders WebShellView — so
 * whether the app opens offline is decided here, not in either app.
 *
 * ## Where this runs
 *
 * The browser, and iOS — whose shell had to opt into App-Bound Domains first,
 * because a WKWebView that has not done so has no `navigator.serviceWorker`
 * at all (note-ios 0a88476). NOT the Android shell: its `shouldInterceptRequest`
 * offline path is per-WebView and a worker's own fetches bypass it, which would
 * have turned an instant captive-portal answer into a network timeout. The app
 * skips registration there (offlineShell.ts, by the shell's UA token).
 *
 * ## The rules, and why each one is the safe version
 *
 * PRECACHE THE BUILD AS A SET, AND CHECK IT IS ONE SET. `install` fetches every
 * asset of THIS build and the document, verifies each, and only then stores
 * them together. The list of assets is baked in at build time; the document is
 * fetched live — so during a rolling deploy the two can DISAGREE: hashed assets
 * for build N answered from the edge or the browser's HTTP cache, `index.html`
 * (no-cache) for build N+1 from a new pod. `addAll` would have accepted that,
 * and offline you would get a document whose chunks are in neither cache nor
 * network. So the fetched document must reference only assets in this build's
 * list, or the install is rejected and the previous worker stays in charge.
 *
 * EVERY PRECACHE FETCH REVALIDATES (`cache: 'no-cache'`) AND IS CHECKED. An
 * HTML body that the edge once served under an asset URL can sit in the
 * browser's HTTP cache for eight hours, and `addAll` would read it as-is. A
 * conditional request carries that entry's validators, which the real asset
 * never matches, so what arrives is the real asset or a 404 — and an unchanged
 * hashed asset comes back 304 and is reused, so a new build does not
 * re-download ~4 MiB per device. No credentials are sent, and any non-document
 * entry that arrives as `text/html` is refused: nothing poisoned reaches a
 * cache that cannot be purged.
 *
 * `/api/` IS NEVER CACHED. Auth-scoped, E2EE payloads. A cached API response is
 * a cross-account leak waiting for a shared device, and stale ciphertext for
 * everyone else.
 *
 * ASSETS ARE CACHE-FIRST, and that is only safe because they are
 * CONTENT-HASHED: `index-C0ffee.js` either is that exact file or does not
 * exist. Nothing hashed can go stale, so there is no revalidation to get wrong.
 *
 * NAVIGATIONS ARE NETWORK-FIRST, WITH A DEADLINE. The document is the one
 * unhashed URL, so it is the one thing that can go stale; the cache is the
 * fallback, not the source of truth. But "network first" with no clock is a
 * blank page for as long as a dead Wi-Fi takes to time out — minutes, on a
 * captive portal or a connected-but-dead link. If the cached document exists,
 * the network gets NAV_TIMEOUT_MS to answer; a 5xx also falls back to the
 * cached shell, because the shell can still open notes from IndexedDB while
 * an error page cannot. 3xx/4xx pass through. With nothing cached, the network
 * result is returned whatever it is.
 *
 * NO `skipWaiting`, AND `clients.claim()` ONLY ON A FIRST INSTALL. Taking over
 * a running page mid-session means it is executing build N while the SW serves
 * build N+1 — a lazy chunk from N is in neither cache, goes to the network, and
 * the server has only N+1. A first install has no such split in the common
 * case — the page is running the build being cached. The exception is a deploy
 * landing between the page load and the worker's own fetch (page N, worker
 * N+1); that page is already exposed to a 404 on its next lazy chunk with or
 * without a worker, so claiming changes nothing for it.
 *
 * ACTIVATE DELETES EVERY OTHER CACHE — unless a newer worker is mid-install.
 * This is the self-heal: whatever a bad build put on a device is gone the next
 * time a good one loads. But an install for N+1 can be running while N
 * activates, and N would delete the cache N+1 is filling; N then leaves it.
 *
 * A FAILED INSTALL LEAVES NO CACHE BEHIND. `caches.open` creates the name
 * before anything is stored; an empty leftover would make the next activate
 * think a previous build existed and skip the first-install claim.
 *
 * ## The kill switch
 *
 * A service worker cache is per-device, survives deploys, and cannot be purged
 * from the server. `public/sw-kill.js` ships in every build, inert. To pull it:
 * change what the web server serves at `/sw` from `/sw.js` to `/sw-kill.js` —
 * one routing line, no code or test change. The app registers at `/sw`, so
 * whatever is served there is the worker; sw-kill.js clears every cache,
 * unregisters, and reloads open pages. Pasting a body over THIS file instead
 * would not build (the injector needs its slots): routing is the right lever.
 *
 * ## Logout
 *
 * Browser: `clearOfflineCaches()` runs from `clearLocalCache()`, the path that
 * already promises a clean slate before another account can hydrate. It drops
 * the caches and keeps the registration — the push subscription hangs off the
 * registration and is the account's, so sign-out unsubscribes that instead.
 * iOS: `teardown()` calls `removeData(ofTypes: allWebsiteDataTypes())`, whose
 * set includes service worker registrations and cache storage. Android: never
 * registered, nothing to clear.
 */

/* Replaced at build time by scripts/inject-sw-precache.mjs. The literals here
   are the DEV values, and they MUST be valid JavaScript as written: `vite dev`
   serves this file verbatim, and ensurePushSubscription registers it there for
   anyone with notifications on. An empty precache list means install caches
   nothing and every fetch falls through to the network, which is exactly what
   dev should do. (A bare `__PRECACHE_URLS__` identifier here was a
   ReferenceError at evaluation, which took dev push down with it.) */
const BUILD_ID = '__BUILD_ID__';
const PRECACHE = /** @type {string[]} */ ([] /* __PRECACHE_URLS__ */);

const CACHE_PREFIX = 'pingolin-note-';
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const DOCUMENT = '/index.html';
/** How long a navigation waits for the network when a cached document exists. */
const NAV_TIMEOUT_MS = 4000;

/**
 * Fetch every entry fresh, verify each, and only then store — an atomic
 * precache with checks `cache.addAll` does not make. Returns nothing; throws
 * on the first problem, leaving the cache untouched.
 */
async function precacheVerified(cache) {
  const responses = new Map();
  for (const url of PRECACHE) {
    // REVALIDATE through the HTTP cache rather than bypass it, and send no
    // cookies. 'no-cache' means a conditional request: an unchanged hashed
    // asset the browser already holds comes back 304 and is reused, so a new
    // build does not re-download ~4 MiB per device for files that did not
    // change. It is still safe against an eight-hour edge poison sitting in
    // that cache: the conditional request carries the poison's validators,
    // which the real asset never matches, so the response is the real asset
    // (or a 404) — and the checks below run on whatever actually arrives.
    // ('reload' would be safe too, at the cost of the full download every time.)
    const res = await fetch(new Request(url, { cache: 'no-cache', credentials: 'omit' }));
    if (!res.ok || res.redirected) throw new Error(`precache: ${url} -> ${res.status}${res.redirected ? ' (redirected)' : ''}`);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (url !== DOCUMENT && type.includes('text/html')) {
      throw new Error(`precache: ${url} is text/html — a fallback document under an asset URL`);
    }
    responses.set(url, res);
  }
  // The document must belong to THIS build: every asset it references has to
  // be in the list it was built with, or offline it would ask for chunks that
  // exist nowhere.
  const doc = responses.get(DOCUMENT);
  if (doc) {
    const html = await doc.clone().text();
    const referenced = new Set([...html.matchAll(/\/assets\/[^"'\s)]+/g)].map((m) => m[0]));
    const listed = new Set(PRECACHE);
    for (const ref of referenced) {
      if (!listed.has(ref)) throw new Error(`precache: document references ${ref}, which this build did not ship`);
    }
  }
  for (const [url, res] of responses) await cache.put(url, res);
}

self.addEventListener('install', (event) => {
  // No skipWaiting — see the header. A new build waits for the old page to go.
  if (!PRECACHE.length) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await precacheVerified(cache);
      // The store can be deleted WHILE it is being filled — on 2026-09-05 the
      // page's no-session boot wipe raced this install: the cache vanished at
      // 1.3 s, every put silently went nowhere (a put onto a deleted Cache does
      // not reject), and the worker activated with NOTHING, so offline was dead
      // in that browser until the next deploy. Ask the registry, not the
      // handle, before declaring success. A failed install leaves the previous
      // worker in charge and the next register() tries this build again.
      if (!(await caches.has(CACHE_NAME)) || !(await (await caches.open(CACHE_NAME)).match(DOCUMENT))) {
        throw new Error('precache: cache vanished during install');
      }
    } catch (err) {
      // Leave nothing behind: an empty cache of ours would count as a
      // "previous build" at the next activate and suppress the first-install
      // claim. The install itself still fails, so the old worker stays.
      await caches.delete(CACHE_NAME).catch(() => {});
      throw err;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const ours = keys.filter((k) => k.startsWith(CACHE_PREFIX));
    const stale = ours.filter((k) => k !== CACHE_NAME);
    // A newer worker can be installing while this one activates; deleting
    // "stale" caches then would empty the one it is filling. Leave cleanup to
    // its own activate.
    if (!self.registration.installing) {
      await Promise.all(stale.map((k) => caches.delete(k)));
    }
    // First install only: there was no cache of ours before this one, so no
    // client can be running a different build. Claiming then is what makes the
    // app work offline after a single visit instead of two.
    if (stale.length === 0) await self.clients.claim();
  })());
});

/** Same-origin only; everything else is somebody else's problem. */
function isOurs(url) {
  return url.origin === self.location.origin;
}

/** A cache lookup that cannot fail a request: storage errors read as a miss. */
async function cachedOrNull(key) {
  try {
    return (await caches.match(key, { cacheName: CACHE_NAME })) || null;
  } catch {
    return null;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!isOurs(url)) return;

  // Never the API. Auth-scoped and E2EE — see the header.
  if (url.pathname.startsWith('/api/')) return;

  // The document: network-first with a deadline, cache as the fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const network = fetch(req);
      // Nothing cached: whatever the network says, however long it takes.
      const cached = await cachedOrNull(DOCUMENT);
      if (!cached) return network;
      const timer = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
      try {
        const res = await Promise.race([network, timer]);
        if (res === null) return cached;                 // deadline: dead link
        if (res.status >= 500) return cached;            // outage: shell beats error page
        return res;                                      // fresh document, or a real 3xx/4xx
      } catch {
        return cached;                                   // offline
      }
    })());
    return;
  }

  // Content-hashed assets: cache-first, because a hashed URL cannot go stale.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cached = await cachedOrNull(req);
      if (cached) return cached;
      return fetch(req);
    })());
  }
});

self.addEventListener('push', (event) => {
  let payload = { reminderId: null };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // Ignore malformed payloads — still show the generic notification.
  }

  // Silent "your notes changed elsewhere" tickle: don't show a notification,
  // just tell any open tab to pull. (A visible client lets us skip the
  // notification without penalty; a closed/hidden tab will catch up on its
  // next focus via the app's visibilitychange sync.)
  if (payload.kind === 'sync') {
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: 'note-sync' });
    })());
    return;
  }

  const title = 'Reminder';
  const options = {
    body: 'Tap to view your reminders',
    tag: payload.reminderId ? `reminder-${payload.reminderId}` : 'reminder',
    icon: '/favicon.png',
    badge: '/favicon.png',
    data: payload,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      // Prefer an already-open tab on our origin
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) {
      return self.clients.openWindow('/');
    }
  })());
});
