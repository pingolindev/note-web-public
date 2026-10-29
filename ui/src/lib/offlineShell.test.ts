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

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * The service worker's caching rules, asserted on the shipped source.
 *
 * WHY THE RULES ARE STRICT. A service worker cache is worse than a CDN in one
 * specific way: it is per-device, it survives deploys, and it cannot be purged
 * from the server. A stale asset served with a 200 from a CDN can be purged;
 * one served from a worker cache cannot. Every rule below is what stops a bad
 * build becoming permanent.
 *
 * Source assertions: the worker is not a module and never runs in this
 * environment (`environment: 'node'`, no jsdom, no ServiceWorkerGlobalScope),
 * so behaviour is asserted where it is written.
 */
const root = join(__dirname, '..', '..');
const sw = readFileSync(join(root, 'public', 'sw.js'), 'utf-8');
const shell = readFileSync(join(__dirname, 'offlineShell.ts'), 'utf-8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

/** Comments quote the rules they explain; assert on code. */
const code = sw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const shellCode = shell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** One function's source, from `header` to the brace that closes its body. */
function fnSource(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start < 0) return '';
  let depth = 0;
  for (let i = src.indexOf('{', src.indexOf(')', start)); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}
const retire = fnSource(shellCode, 'export async function retireIosShellWorker');

describe('what the worker will not cache', () => {
  it('never caches the API', () => {
    // Auth-scoped, E2EE payloads. A cached one is a cross-account leak on a
    // shared device and stale ciphertext everywhere else.
    expect(code).toContain("url.pathname.startsWith('/api/')");
    const at = code.indexOf("url.pathname.startsWith('/api/')");
    // Bare `return` — no respondWith, so the request goes to the network
    // untouched rather than through any cache path.
    expect(code.slice(at, at + 80)).toMatch(/\)\s*return;/);
  });

  it('never caches a non-GET request', () => {
    expect(code).toContain("req.method !== 'GET'");
  });

  it('never caches cross-origin requests', () => {
    expect(code).toContain('isOurs(url)');
    expect(code).toContain('url.origin === self.location.origin');
  });

  it('does not cache itself', () => {
    // A worker that caches its own script is how a bad one becomes permanent.
    const injector = readFileSync(join(root, 'scripts', 'inject-sw-precache.mjs'), 'utf-8');
    expect(injector).toMatch(/sw\.js/);
    expect(injector).toContain('/index.html');
  });
});

describe('freshness rules', () => {
  it('assets are cache-first, which is only safe because they are hashed', () => {
    const at = code.indexOf("url.pathname.startsWith('/assets/')");
    expect(at).toBeGreaterThan(-1);
    const block = code.slice(at, at + 400);
    expect(block).toContain('cachedOrNull(req)');
    expect(block).toContain('return fetch(req)');
  });

  it('navigations are network-FIRST, cache only as the offline fallback', () => {
    const at = code.indexOf("req.mode === 'navigate'");
    expect(at).toBeGreaterThan(-1);
    const block = code.slice(at, at + 700);
    // The network request is issued first; the cache is consulted only to
    // decide whether a deadline/5xx fallback is even possible.
    expect(block.indexOf('fetch(req)')).toBeLessThan(block.indexOf('cachedOrNull(DOCUMENT)'));
    expect(block).toContain('Promise.race([network, timer])');
  });
});

describe('a bad build must not become permanent', () => {
  it('does not skipWaiting', () => {
    // Taking over a running page means it executes build N while the worker
    // serves N+1, and a lazy chunk from N is then in neither place.
    expect(code).not.toContain('skipWaiting');
  });

  it('claims clients ONLY when no earlier cache of ours existed', () => {
    const at = code.indexOf('clients.claim()');
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(Math.max(0, at - 120), at)).toContain('stale.length === 0');
  });

  it('activate deletes every cache that is not this build', () => {
    // The self-heal: whatever a bad build left is gone on the next good load.
    expect(code).toContain("const CACHE_PREFIX = 'pingolin-note-';");
    expect(code).toContain('k.startsWith(CACHE_PREFIX)');
    expect(code).toContain('k !== CACHE_NAME');
    expect(code).toContain('caches.delete(k)');
  });

  it('precaches atomically AND verified, so a partial or mismatched build never serves', () => {
    // Not addAll: every entry is fetched fresh (cache: 'reload', no
    // credentials), checked, and only then put — and the document must name
    // only assets in this build's list, or a rolling deploy pairs N's chunks
    // with N+1's index.html and offline is a blank page.
    expect(code).not.toContain('cache.addAll(');
    expect(code).toContain('precacheVerified(cache)');
    expect(code).toContain("cache: 'no-cache', credentials: 'omit'");
    expect(code).toContain('!res.ok || res.redirected');
    expect(code).toContain("type.includes('text/html')");
    expect(code).toContain('did not ship');
    expect(code).toContain('await cache.put(url, res)');
  });

  it('a failed install leaves no cache behind', () => {
    // An empty leftover would count as a "previous build" at the next
    // activate and suppress the first-install claim.
    expect(code).toContain('await caches.delete(CACHE_NAME)');
  });

  it('activate leaves other caches alone while a newer worker is installing', () => {
    expect(code).toContain('if (!self.registration.installing)');
  });

  it('navigations have a deadline and fall back on 5xx, when a shell is cached', () => {
    expect(code).toContain('NAV_TIMEOUT_MS');
    expect(code).toContain('res.status >= 500');
    // With nothing cached, the network result is returned whatever it is.
    expect(code).toContain('if (!cached) return network;');
  });

  it('a cache lookup that throws reads as a miss, never a failed request', () => {
    expect(code).toContain('async function cachedOrNull(');
    expect(code).not.toMatch(/const cached = await caches\.match\(/);
  });

  it('the kill switch is a separate, routable worker that needs no injection', () => {
    // The injector needs sw.js's slots, so a kill-switch body pasted over sw.js
    // could not build. sw-kill.js ships inert; pulling it is a one-line nginx
    // routing change.
    const kill = readFileSync(join(root, 'public', 'sw-kill.js'), 'utf-8');
    expect(kill).toContain('registration.unregister()');
    expect(kill).toContain('caches.delete(k)');
    expect(kill).toContain('self.skipWaiting()');
    expect(kill).toContain("typeof c.navigate === 'function'"); // WebKit has no navigate()
    // No claim, controlled clients only — anything else reloads forever on
    // Chromium, because the app re-registers /sw on every boot. Asserted on
    // the CODE: the header explains both by name.
    const killCode = kill.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(killCode).not.toContain('clients.claim');
    expect(killCode).toContain("matchAll({ type: 'window' })");
    expect(killCode).not.toContain('includeUncontrolled');
    expect(kill).not.toContain('__BUILD_ID__');
    expect(sw).toMatch(/kill switch/i);
  });

  it('long-lived shell documents check for a new worker on every foreground', () => {
    expect(shell).toContain("document.addEventListener('visibilitychange'");
    expect(shell).toContain('reg.update()');
  });

  it('sign-out drops the caches but KEEPS the registration', () => {
    // Unregistering deactivates the Web Push subscription, and nothing
    // re-subscribes until the next reminder is set. The subscription is the
    // account's (unsubscribed in auth.ts); the registration is the browser's.
    // The one unregister is the iOS shell's retirement, which has no push to
    // lose (APNs) and is not on any sign-out path.
    expect(retire).toContain('reg.unregister()');
    expect(shellCode.replace(retire, '')).not.toContain('unregister(');
    const auth = readFileSync(join(__dirname, '..', 'stores', 'auth.ts'), 'utf-8');
    expect(auth).not.toContain('unregister(');
    expect(auth).not.toContain('retireIosShellWorker');
    expect(auth).toContain('await unsubscribePush().catch(() => false);');
    expect(auth).toContain('void ensurePushSubscription();');
  });

  it('the injector uses function replacements, so a $ in an asset name cannot corrupt the worker', () => {
    const injector = readFileSync(join(root, 'scripts', 'inject-sw-precache.mjs'), 'utf-8');
    expect(injector).toContain('.replace(BUILD_ID_SLOT, () =>');
    expect(injector).toContain('.replace(PRECACHE_SLOT, () =>');
  });
});

describe('push behaviour is untouched', () => {
  it('still relays the sync tickle as "note-sync"', () => {
    // The app listens for exactly this string; a paraphrase silently kills
    // cross-device sync and nothing fails loudly.
    expect(sw).toContain("postMessage({ type: 'note-sync' })");
    expect(sw).toContain("payload.kind === 'sync'");
  });

  it('still shows the content-free reminder', () => {
    // The server is E2EE-blind; no note text may ride the payload.
    expect(sw).toContain("const title = 'Reminder';");
    expect(sw).toContain("body: 'Tap to view your reminders'");
  });
});

describe('registration and teardown', () => {
  it('registers for everyone, not only push opt-in', () => {
    expect(shell).toContain('navigator.serviceWorker.register(SW_URL');
    expect(shell).toContain('registerOfflineShell');
    const entry = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf-8');
    expect(entry).toContain('registerOfflineShell()');
  });

  it('both registration sites use ONE script URL, served extension-less', () => {
    // Two URLs on one scope would flip the registration back and forth; and
    // Cloudflare caches by extension, so /sw.js would sit at the edge for 8h
    // (origin no-cache, edge max-age=28800) — kill switch included.
    const push = readFileSync(join(__dirname, 'webPush.ts'), 'utf-8');
    expect(shell).toContain("export const SW_URL = '/sw';");
    expect(push).toContain("import { SW_URL, isIosShell } from './offlineShell'");
    expect(push).toContain('register(SW_URL');
    expect(push).not.toContain("register('/sw.js')");
    // Update checks must not be served from the browser's HTTP cache either.
    expect(shell).toContain("updateViaCache: 'none'");
    expect(push).toContain("updateViaCache: 'none'");
  });

  it('does NOT register inside the Android shell', () => {
    // A worker's own fetches bypass WebViewClient.shouldInterceptRequest, so
    // it would turn the APK bundle's instant captive-portal answer into a
    // network timeout. Android keeps its bundle; the worker is skipped there.
    expect(shell).toContain("'PingolinNativeShell'");
    expect(shell).toContain('if (isAndroidShell()) return;');
  });

  it('bounds the push path\'s wait for an active worker', () => {
    // `.ready` never settles if the precache install fails; the reminder
    // picker fire-and-forgets this, so an unbounded wait is a silent hang.
    const push = readFileSync(join(__dirname, 'webPush.ts'), 'utf-8');
    expect(push).toContain('Promise.race([');
    expect(push).toContain('navigator.serviceWorker.ready,');
    expect(push).toContain('READY_TIMEOUT_MS');
  });

  it('surfaces a failed install instead of swallowing it', () => {
    expect(shell).toContain("installing.state === 'redundant'");
    expect(shell).toContain('console.warn');
  });

  it('pins the cache prefix in both places that spell it', () => {
    expect(shell).toContain("export const CACHE_PREFIX = 'pingolin-note-';");
    expect(code).toContain("const CACHE_PREFIX = 'pingolin-note-';");
    expect(code).toContain('`${CACHE_PREFIX}${BUILD_ID}`');
  });

  it('does not register in dev, where the placeholders are unreplaced', () => {
    expect(shell).toContain('import.meta.env.DEV');
  });

  it('no app code deletes the offline caches — the wipe path least of all', () => {
    // The worker fills its cache ONCE per build, at install, and nothing
    // refills it. Deleting `pingolin-note-*` at every session end — including
    // the no-session boot, ~1 s after the very first register() — would pull
    // the cache from under a worker that is still installing, and the worker
    // would activate with nothing. Offline would be dead in that browser until
    // the next deploy; an ordinary sign-out would do the same.
    const db = readFileSync(join(__dirname, 'noteDb.ts'), 'utf-8');
    const dbCode = db.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(dbCode).not.toContain('clearOfflineCaches');
    expect(dbCode).not.toContain('caches.');
    // And offlineShell.ts itself only registers and updates — it never deletes,
    // except where nothing registers: the iOS shell's retirement, reached only
    // from the branch that returns before register().
    expect(retire).toContain('caches.delete(name)');
    expect(shellCode.replace(retire, '')).not.toContain('caches.delete');
    expect(shellCode).not.toContain('clearOfflineCaches');
    expect(shellCode.split('retireIosShellWorker(').length - 1).toBe(2); // its definition + one call
    expect(fnSource(shellCode, 'export async function registerOfflineShell')).toContain(
      'if (isIosShell()) {\n    await retireIosShellWorker();\n    return;\n  }\n  try {',
    );
    // The only deleters: the worker's own activate (stale builds, asserted
    // above), the kill switch (everything, on purpose) and that retirement.
  });

  it('the worker fails its install if the cache vanished underneath it', () => {
    // A put onto a deleted Cache does not reject, so without this the race
    // above ends in an ACTIVATED worker with an empty cache — the worst state,
    // because nothing ever installs this build again. Asking the registry
    // (`caches.has`) turns it into a failed install the next visit retries.
    const at = code.indexOf('await precacheVerified(cache);');
    expect(at).toBeGreaterThan(-1);
    const afterPrecache = code.slice(at, code.indexOf('} catch (err) {', at));
    expect(afterPrecache).toContain('await caches.has(CACHE_NAME)');
    expect(afterPrecache).toContain('.match(DOCUMENT)');
    expect(afterPrecache).toContain('cache vanished during install');
  });
});

describe('the build bakes in a real precache list', () => {
  it('the build script runs the injector', () => {
    expect(pkg.scripts.build).toContain('inject-sw-precache');
  });

  it('the shipped worker still carries its placeholders', () => {
    // public/sw.js is the TEMPLATE. Unreplaced placeholders mean dev caches
    // nothing, which is what dev should do.
    expect(sw).toContain('__BUILD_ID__');
    expect(sw).toContain('__PRECACHE_URLS__');
  });

  it('an empty precache list makes install a no-op', () => {
    expect(code).toContain('if (!PRECACHE.length) return;');
  });

  it('if a build has been run, its output has no placeholders left', () => {
    const dist = join(root, 'dist', 'sw.js');
    if (!existsSync(dist)) return; // nothing built here; the build runs separately
    // Comment-stripped, like `code` above: the header explains the placeholders
    // by name, and a comment is not a placeholder. The injector applies the
    // same rule to its own final guard.
    const built = readFileSync(dist, 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(built).not.toContain('__BUILD_ID__');
    expect(built).not.toContain('__PRECACHE_URLS__');
    expect(built).toMatch(/const BUILD_ID = "[0-9a-f]{12}";/);
    expect(built).toMatch(/const PRECACHE = [\s\S]*?\(\["\/assets\//);
  });
});
