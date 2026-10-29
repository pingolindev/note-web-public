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
 * THE KILL SWITCH. Shipped in every build, inert until routed.
 *
 * A service worker cache is per-device, survives deploys, and cannot be purged
 * from the server. If a build ever poisons it, this worker takes over, deletes
 * every cache, unregisters itself, and reloads the pages the poisoned worker
 * was controlling so they come back from the network with no worker at all.
 *
 * HOW TO PULL IT — one routing line in the web server, no code change, no test
 * change. With nginx:
 *
 *     location = /sw { try_files /sw.js =404; }
 *  →  location = /sw { try_files /sw-kill.js =404; }
 *
 * The app registers the worker at `/sw`, so whatever the server serves there
 * IS the worker. This file needs no build-time injection (the injector only touches
 * sw.js), so the build cannot fail on it, and the source-assertion suite reads
 * public/sw.js, so it stays green. That is the whole reason this is a separate
 * file and a routing change rather than an edit to sw.js: the previous
 * "documented" kill switch was a body to paste over sw.js, and pasting it made
 * the build fail (no injector slots) and the test gate go red — a multi-file
 * change under pressure, on the day you least want one.
 *
 * NO `clients.claim()`, AND ONLY CONTROLLED CLIENTS ARE RELOADED. The first
 * version claimed and reloaded `includeUncontrolled` clients, and that is an
 * infinite loop on any browser with `WindowClient.navigate`: the reload lands
 * on a page with no registration, the app registers `/sw` again on boot (it
 * always does), this worker installs, claim() makes that page controlled,
 * matchAll finds it, navigate() reloads it — 644 loads of `/` in six seconds
 * in the operations reviewer's harness, for as long as the route was in place.
 *
 * Without claim(), the Activate algorithm still hands this worker every client
 * the POISONED worker controlled — those are the pages that need reloading,
 * and `matchAll({ type: 'window' })` returns exactly them. A page that
 * registers this worker fresh after the reload is never controlled by it, is
 * never in that list, and is never reloaded. Its install → activate cycle just
 * clears the caches again and unregisters again: harmless and idempotent.
 *
 * `skipWaiting` IS deliberate here and only here: taking over immediately is
 * the point, and there is no install work to wait on.
 *
 * Reach: a browser re-fetches the worker script on navigation and on
 * `registration.update()`; the app calls update() whenever it becomes visible
 * again (offlineShell.ts), so a long-lived shell document picks this up on the
 * next foreground rather than the next cold start. WebKit has no
 * `WindowClient.navigate`, so there the caches and the registration are gone
 * and the open document simply keeps running until its next load.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch { /* storage unavailable — nothing to delete */ }
    // Controlled clients only — the ones the poisoned worker had. See the
    // header for why claim() and includeUncontrolled would loop forever.
    let clients = [];
    try {
      clients = await self.clients.matchAll({ type: 'window' });
    } catch { /* fine */ }
    try {
      await self.registration.unregister();
    } catch { /* fine */ }
    for (const c of clients) {
      if (typeof c.navigate === 'function') {
        try { await c.navigate(c.url); } catch { /* not reloadable */ }
      }
    }
  })());
});
