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
 * Register the service worker so the app opens offline.
 *
 * ## Why this exists at startup, not on push opt-in
 *
 * Registered only from `ensurePushSubscription`, i.e. only for someone who had
 * turned notifications on and granted permission, the worker would never
 * install for anyone else, nor would the offline shell it carries.
 * Registration has to be unconditional — with the exceptions below.
 *
 * ## Where it applies, and where it deliberately does not
 *
 * Both mobile clients ARE this web app — Android's home screen is
 * WebAppActivity at the origin root, iOS's RootView renders WebShellView — and
 * NEITHER keeps a worker: the offline shell is the browser's. Both decisions
 * are shipped by deploying the web editor rather than by an app release.
 *
 * iOS IS SKIPPED, AND ITS WORKER REMOVED. The shell judges every TLS challenge
 * a PAGE's loads raise, but a worker's soft update has no page: WebKit fetches
 * the script itself and settles the challenge with the system's default
 * trust. So a certificate from a key the shell refuses and the system still
 * trusts would be accepted for the worker, and from the next cold start that
 * worker would serve the document the shell hands the vault key to
 * (WebKeyBridge checks the frame and the origin, never who served the
 * document). The iOS shell therefore registers nothing, and on every start
 * unregisters what an earlier build registered and drops the worker's caches
 * (`retireIosShellWorker`). That does not remove the registration: WebKit
 * keeps its row while this page is its client, and this page is the shell's
 * only one, so the row survives every launch until the shell clears it before
 * its first load. The shell is recognised by what it writes at document start
 * (`isIosShell`), which every build that can have a worker writes. Cost: a
 * cold start with no network shows the shell's retry view. (A WKWebView that
 * has not opted into App-Bound Domains has NO `navigator.serviceWorker` at
 * all — absent, not inert — and the guard below exits silently there.)
 *
 * ANDROID IS SKIPPED ON PURPOSE. The Android shell already ships the build in
 * the APK and serves it from `WebViewClient.shouldInterceptRequest` when there
 * is no validated network. That hook is per-WebView; a service worker's own
 * `fetch()` calls route through `ServiceWorkerController`, which the shell
 * never configures — so once a worker controlled the document, the instant
 * APK answer for a captive portal or a connected-but-dead Wi-Fi would never be
 * consulted, and the load would wait out a network timeout instead. The
 * worker would make a proven path worse and give Android nothing it lacks.
 * The shell marks itself in the user agent (`PingolinNativeShell`,
 * WebAppActivity.kt), which is the same signal UpgradePrompt already uses.
 *
 * ## The script URL is `/sw`, not `/sw.js`
 *
 * Cloudflare caches responses by file extension: with the origin sending
 * `Cache-Control: no-cache` for `/sw.js`, the edge still returns
 * `max-age=28800` with `cf-cache-status: MISS` — the same rule that caches an
 * HTML error page under a stylesheet's URL for eight hours. An
 * extension-less path is not subject to that rule (`/` comes back `DYNAMIC`),
 * and the web server serves the same file at `/sw`. `updateViaCache: 'none'`
 * keeps the BROWSER's HTTP cache out of the update check as well. It is also
 * what makes the kill switch a routing change: whatever the server serves at
 * `/sw` is the worker (see public/sw-kill.js).
 *
 * Both registration sites — this one and `ensurePushSubscription` — must use
 * the same URL, or every registration would flip the script back and forth.
 *
 * ## When a new build takes over
 *
 * No `skipWaiting`, no forced update prompt, no reload-on-update. A new worker
 * installs and WAITS; it activates only once every page on the origin that the
 * current worker controls has gone away — in a browser that means every tab,
 * not a reload of one; in a shell it means the document being torn down. Until
 * then the page runs build N+1 from the network while the offline copy is N,
 * which is consistent, just not current. Taking over sooner would have a page
 * executing build N while the worker serves N+1, and a lazy chunk from N is
 * then in neither place. See the header of `public/sw.js`.
 *
 * Long-lived shell documents would otherwise only re-fetch the worker on a
 * navigation. `registration.update()` on every return to the foreground is
 * what lets a new build — or the kill switch — reach them on the next
 * foreground rather than the next cold start.
 */

/** The one script URL. `ensurePushSubscription` imports this rather than
 *  spelling it again. */
export const SW_URL = '/sw';

/** Prefix of every cache the worker owns. Mirrored as a literal in `public/sw.js`,
 *  which cannot import; a test pins the two together. */
export const CACHE_PREFIX = 'pingolin-note-';

/** UA marker the Android shell sets (WebAppActivity.kt `SHELL_UA_TOKEN`). */
const ANDROID_SHELL_UA_TOKEN = 'PingolinNativeShell';

export function isAndroidShell(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return ua.includes(ANDROID_SHELL_UA_TOKEN);
}

/** What the iOS shell writes at document start, before any page script runs
 *  (the Note iOS app's WebShellView): `markerScript()`, `WebAppDeviceState`
 *  and the key hand-off. Every build that can have a worker writes the first
 *  two; any one of the three is enough, so one script failing does not bring
 *  the worker back. */
type ShellMarkers = { __pingolinNativeShell?: unknown; __pingolinDevice?: unknown; __pingolinKeyBridge?: unknown };

/** The Android shell writes the same two markers, so it is told apart by its
 *  user agent; it never registers either (see the header). */
export function isIosShell(
  w: ShellMarkers | undefined = typeof window === 'undefined' ? undefined : (window as unknown as ShellMarkers),
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  if (!w || isAndroidShell(ua)) return false;
  return w.__pingolinNativeShell !== undefined || w.__pingolinDevice !== undefined || w.__pingolinKeyBridge !== undefined;
}

/**
 * Remove the worker a shipped build registered in the iOS shell, and the caches
 * it filled (see the header). The registrations go FIRST: once none is left no
 * install can start, so nothing refills a cache after it is deleted. Each half
 * is best-effort and runs whatever the other managed.
 */
export async function retireIosShellWorker(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((reg) => reg.unregister().catch(() => false)));
  } catch {
    // Nothing to read, or WebKit refused: the caches below still go.
  }
  try {
    if (typeof caches === 'undefined') return;
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
  } catch {
    // Best-effort, like registration itself.
  }
}

/** Registration is best-effort: the app works without it, offline aside. */
export async function registerOfflineShell(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // Dev runs from the Vite server, where `sw.js` carries the unreplaced
  // placeholders and precaches nothing. Registering it there would only add a
  // confusing extra actor to every debugging session.
  if (import.meta.env.DEV) return;
  if (isAndroidShell()) return;
  if (isIosShell()) {
    await retireIosShellWorker();
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' });
    // A precache that fails — an asset 404s because a deploy landed between
    // page load and install, storage pressure, a document that names chunks
    // this build did not ship — leaves the new worker `redundant` and the old
    // one (or none) in charge, with nothing said anywhere. Say it, so an
    // offline shell that never installed is at least findable in a console.
    const installing = reg.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'redundant') {
        console.warn('[offlineShell] service worker install failed; offline shell not updated');
      }
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void reg.update().catch(() => {});
      });
    }
  } catch {
    // A failed registration is not a failed app. Nothing above this cares.
  }
}

/*
 * WHY THE APP NEVER DELETES THE OFFLINE CACHES — and never unregisters.
 *
 * Sign-out leaves the worker AND its caches alone. Both hold nothing that is
 * anyone's: the caches are public, content-hashed assets and the document,
 * never a note and never an API response; the registration is the browser's.
 *
 * WHY NOT UNREGISTER. The Web Push subscription hangs off the registration:
 * unregistering deactivates it, and since the only other subscribe lives
 * inside the reminder picker, a re-login on the same browser would silently
 * stop reminders until the next one was set. The subscription is the
 * account's and is unsubscribed on sign-out (auth.ts); the registration stays.
 *
 * WHY NOT DELETE THE CACHES EITHER. The worker fills its cache exactly once
 * per build, at install; nothing refills it afterwards. A delete on every
 * session end would include the no-session boot — which runs ~1 s after the
 * very first `register()`. Polled from inside the worker, such a delete
 * looks like this:
 *
 *    803 ms  caches=1 entries=0 state=installing   ← install opened the cache
 *   1305 ms  caches=0 entries=0 state=installing   ← the page deleted it
 *   2708 ms  caches=0 entries=0 state=activated    ← install "succeeded", empty
 *
 * `cache.put()` onto a deleted store does not reject, so the worker would
 * activate with nothing and offline would be dead in that browser until the
 * next deploy; an ordinary sign-out would do the same to a signed-in user.
 * The worker also fails its install if the cache vanished underneath it
 * (sw.js), but the first line of defence is that no app code touches those
 * caches at all. The only things that may: the worker's own activate (stale
 * builds), the kill switch (sw-kill.js), which deletes everything on purpose,
 * and `retireIosShellWorker` in the iOS shell alone. That one cannot race an
 * install: nothing in that shell registers, and it unregisters before it
 * deletes. It costs no push either — the iOS app's reminders come by APNs
 * (PushNotificationManager.swift), not Web Push.
 *
 * The two shells never come through sign-out here. iOS: `WebShellModel.teardown()`
 * calls `removeData(ofTypes: allWebsiteDataTypes())`, whose set includes
 * service worker registrations and cache storage. Android: the worker is never
 * registered there (see above), so there is nothing to clear.
 */
