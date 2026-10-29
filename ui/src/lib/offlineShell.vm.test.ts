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

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import vm from 'vm';

/**
 * The service worker, EXECUTED.
 *
 * `offlineShell.test.ts` asserts on the worker's source, which pins the shape
 * of the code but cannot fail on behaviour: a rule can be present in the text
 * and wrong in the branch. This runs `public/sw.js` inside `vm` against a fake
 * `self` / `caches` / `fetch`, dispatches install, activate and fetch events,
 * and asserts what the worker actually DOES — no jsdom, no browser.
 *
 * The precache list is injected the way the build does it, by replacing the
 * same two slots `scripts/inject-sw-precache.mjs` replaces, so a drift in the
 * slot text breaks this too.
 */
const SW_SRC = readFileSync(join(__dirname, '..', '..', 'public', 'sw.js'), 'utf-8');
const KILL_SRC = readFileSync(join(__dirname, '..', '..', 'public', 'sw-kill.js'), 'utf-8');
const ORIGIN = 'https://note.test';
const BUILD = 'abc123def456';
const ASSETS = ['/assets/index-AAAA.js', '/assets/index-BBBB.css'];
const PRECACHE = [...ASSETS, '/index.html'];
const CACHE = `pingolin-note-${BUILD}`;
/** A document that references exactly this build's assets. */
const GOOD_DOC = `<html><script src="/assets/index-AAAA.js"></script><link href="/assets/index-BBBB.css"></html>`;

type Handler = (event: any) => void;
type FetchImpl = (url: string, init?: any) => Promise<Response>;

const js = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/javascript' } });
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

/** A minimal CacheStorage: named caches holding url → Response. */
function fakeCaches() {
  const store = new Map<string, Map<string, Response>>();
  const deleted: string[] = [];
  const api = {
    async open(name: string) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      // Like the real Cache, this handle is bound to the store it was opened
      // on: after `caches.delete(name)` it is orphaned, and puts still succeed
      // into it. That detachment is what the vanished-cache test relies on.
      return {
        async put(url: string, res: Response) { m.set(new URL(url, ORIGIN).href, res); },
        async match(url: string) { const hit = m.get(new URL(url, ORIGIN).href); return hit ? hit.clone() : undefined; },
      };
    },
    async has(name: string) { return store.has(name); },
    async keys() { return [...store.keys()]; },
    async delete(name: string) { deleted.push(name); return store.delete(name); },
    async match(req: any, opts?: { cacheName?: string }) {
      if ((globalThis as any).__cacheThrows) throw new Error('storage exploded');
      const url = new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
      const names = opts?.cacheName ? [opts.cacheName] : [...store.keys()];
      for (const n of names) {
        const hit = store.get(n)?.get(url);
        if (hit) return hit.clone();
      }
      return undefined;
    },
    _store: store,
    _deleted: deleted,
    _seed(name: string, urls: string[]) {
      const m = new Map<string, Response>();
      for (const u of urls) m.set(new URL(u, ORIGIN).href, new Response(`cached:${u}`, { status: 200 }));
      store.set(name, m);
    },
  };
  return api;
}

/** Default network: hashed assets are JS, the document is the good one. */
const defaultFetch: FetchImpl = async (u) => {
  const path = new URL(u, ORIGIN).pathname;
  if (path === '/index.html') return html(GOOD_DOC);
  return js(`net:${path}`);
};

function boot(opts: { precache?: string[]; fetchImpl?: FetchImpl; installing?: boolean } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const claims: number[] = [];
  const posted: any[] = [];
  const fetchCalls: { url: string; cache?: string; credentials?: string }[] = [];
  const caches = fakeCaches();
  (globalThis as any).__cacheThrows = false;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;

  const self: any = {
    location: new URL(ORIGIN + '/'),
    addEventListener(type: string, fn: Handler) { (handlers[type] ??= []).push(fn); },
    clients: {
      async claim() { claims.push(1); },
      async matchAll() { return [{ postMessage: (m: any) => posted.push(m), focus: async () => 'focused' }]; },
      openWindow: async () => null,
    },
    registration: { showNotification: async () => {}, installing: opts.installing ? {} : null },
  };
  const src = SW_SRC
    .replace("const BUILD_ID = '__BUILD_ID__';", `const BUILD_ID = ${JSON.stringify(BUILD)};`)
    .replace('([] /* __PRECACHE_URLS__ */)', `(${JSON.stringify(opts.precache ?? PRECACHE)})`);
  expect(src).not.toContain('__BUILD_ID__;');
  // In a real worker a relative URL resolves against the worker's location;
  // Node's Request demands an absolute one. Resolve here, as the browser would.
  class WorkerRequest extends Request {
    constructor(input: any, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, ORIGIN).href : input, init);
    }
  }
  vm.runInNewContext(src, {
    self, caches, URL, Response, Request: WorkerRequest, TypeError, Error, Promise, Map, Set, console, setTimeout,
    fetch: (req: any) => {
      const url = typeof req === 'string' ? req : req.url;
      fetchCalls.push({ url, cache: req?.cache, credentials: req?.credentials });
      return fetchImpl(url, req);
    },
  });
  const dispatch = async (type: string, event: any): Promise<Response | null> => {
    const waits: Promise<any>[] = [];
    event.waitUntil = (p: Promise<any>) => { waits.push(p); };
    const slot: { p: Promise<Response> | null } = { p: null };
    event.respondWith = (p: any) => { slot.p = Promise.resolve(p); };
    for (const h of handlers[type] ?? []) h(event);
    await Promise.all(waits);
    return slot.p ? await slot.p : null;
  };
  return { handlers, dispatch, caches, claims, posted, fetchCalls };
}

const req = (path: string, extra: Record<string, any> = {}) =>
  ({ method: 'GET', url: ORIGIN + path, mode: 'no-cors', ...extra });

describe('install — a verified, atomic precache', () => {
  it('stores the whole build into a cache named for it', async () => {
    const w = boot();
    await w.dispatch('install', {});
    const stored = w.caches._store.get(CACHE)!;
    expect([...stored.keys()].sort()).toEqual(PRECACHE.map((u) => ORIGIN + u).sort());
  });

  it('revalidates through the HTTP cache and sends no credentials for every entry', async () => {
    // 'no-cache' = conditional request: an eight-hour edge poison's validators
    // never match the real asset, so the real asset (or a 404) arrives — and an
    // unchanged hashed asset is a 304, reused, not a 4 MiB re-download per build.
    const w = boot();
    await w.dispatch('install', {});
    const pre = w.fetchCalls.filter((c) => PRECACHE.some((u) => c.url.endsWith(u)));
    expect(pre.length).toBe(PRECACHE.length);
    for (const c of pre) { expect(c.cache).toBe('no-cache'); expect(c.credentials).toBe('omit'); }
  });

  it('rejects the whole install when ONE asset is missing — and leaves no cache behind', async () => {
    const w = boot({ fetchImpl: async (u) => u.endsWith('BBBB.css') ? js('', 404) : defaultFetch(u) });
    await expect(w.dispatch('install', {})).rejects.toThrow(/precache/);
    expect(w.caches._store.has(CACHE)).toBe(false);
    expect(w.caches._deleted).toContain(CACHE);
  });

  it('rejects an asset that comes back as text/html — the SPA-fallback poison', async () => {
    const w = boot({ fetchImpl: async (u) => u.endsWith('AAAA.js') ? html('<!doctype html>') : defaultFetch(u) });
    await expect(w.dispatch('install', {})).rejects.toThrow(/text\/html/);
    expect(w.caches._store.has(CACHE)).toBe(false);
  });

  it('rejects a document that names an asset this build did not ship', async () => {
    // Rolling deploy: assets for N from the edge, index.html for N+1 from a
    // new pod. Offline that document would ask for chunks that exist nowhere.
    const w = boot({
      fetchImpl: async (u) => new URL(u, ORIGIN).pathname === '/index.html'
        ? html('<script src="/assets/index-NEXT.js"></script>')
        : defaultFetch(u),
    });
    await expect(w.dispatch('install', {})).rejects.toThrow(/did not ship/);
    expect(w.caches._store.has(CACHE)).toBe(false);
  });

  it('rejects a redirected entry', async () => {
    const w = boot({
      fetchImpl: async (u) => {
        const r = js(`net:${u}`);
        if (u.endsWith('AAAA.js')) Object.defineProperty(r, 'redirected', { value: true });
        return new URL(u, ORIGIN).pathname === '/index.html' ? html(GOOD_DOC) : r;
      },
    });
    await expect(w.dispatch('install', {})).rejects.toThrow(/redirected/);
  });

  it('caches nothing at all with the dev placeholder list', async () => {
    const w = boot({ precache: [] });
    await w.dispatch('install', {});
    expect(w.caches._store.size).toBe(0);
  });
});

describe('install — the cache is deleted underneath it', () => {
  // A page wipe that deletes `pingolin-note-*` ~0.5 s into the first install
  // leaves every put landing in a detached Cache: the install "succeeds", and
  // an ACTIVATED worker holds nothing — the one state nothing ever repairs,
  // because this build never installs again. The install must fail instead.
  it('rejects, so the browser retries this build on the next visit', async () => {
    const holder: { caches: ReturnType<typeof fakeCaches> | null } = { caches: null };
    const w = boot({
      fetchImpl: async (u) => {
        // The document is the LAST entry fetched; delete the store while the
        // worker is still verifying, as a page wipe would.
        if (new URL(u, ORIGIN).pathname === '/index.html') await holder.caches!.delete(CACHE);
        return defaultFetch(u);
      },
    });
    holder.caches = w.caches;
    await expect(w.dispatch('install', {})).rejects.toThrow(/vanished/);
    expect(await w.caches.keys()).not.toContain(CACHE);
    expect(w.caches._store.has(CACHE)).toBe(false);
  });

  it('a cache that survives install intact is accepted', async () => {
    const w = boot();
    await w.dispatch('install', {});
    expect(await w.caches.has(CACHE)).toBe(true);
    expect(await (await w.caches.open(CACHE)).match('/index.html')).toBeDefined();
  });
});

describe('activate', () => {
  let w: ReturnType<typeof boot>;
  beforeEach(() => { w = boot(); });

  it('deletes every OTHER pingolin-note cache and leaves foreign caches alone', async () => {
    w.caches._seed('pingolin-note-oldbuild', ['/index.html']);
    w.caches._seed(CACHE, ['/index.html']);
    w.caches._seed('someone-elses-cache', ['/x']);
    await w.dispatch('activate', {});
    expect(w.caches._deleted).toEqual(['pingolin-note-oldbuild']);
    expect(w.caches._store.has(CACHE)).toBe(true);
    expect(w.caches._store.has('someone-elses-cache')).toBe(true);
  });

  it('claims clients on a FIRST install only', async () => {
    await w.dispatch('activate', {});
    expect(w.claims.length).toBe(1);
  });

  it('does NOT claim when a previous build of ours was installed', async () => {
    w.caches._seed('pingolin-note-oldbuild', ['/index.html']);
    await w.dispatch('activate', {});
    expect(w.claims.length).toBe(0);
  });

  it('leaves other caches alone while a newer worker is mid-install', async () => {
    // Deleting "stale" caches then would empty the one N+1 is filling.
    const w2 = boot({ installing: true });
    w2.caches._seed('pingolin-note-newer', ['/index.html']);
    await w2.dispatch('activate', {});
    expect(w2.caches._deleted).toEqual([]);
  });
});

describe('fetch', () => {
  it('leaves /api/ alone entirely — no respondWith', async () => {
    const w = boot();
    await w.dispatch('install', {});
    expect(await w.dispatch('fetch', { request: req('/api/v1/sync/pull') })).toBeNull();
  });

  it('leaves non-GET and cross-origin requests alone', async () => {
    const w = boot();
    await w.dispatch('install', {});
    expect(await w.dispatch('fetch', { request: req('/assets/index-AAAA.js', { method: 'POST' }) })).toBeNull();
    expect(await w.dispatch('fetch', { request: { method: 'GET', url: 'https://elsewhere.test/assets/x.js', mode: 'no-cors' } })).toBeNull();
  });

  it('serves a cached asset without touching the network', async () => {
    const w = boot();
    await w.dispatch('install', {});
    const before = w.fetchCalls.length;
    const r = await w.dispatch('fetch', { request: req('/assets/index-AAAA.js') });
    expect(await r!.text()).toBe('net:/assets/index-AAAA.js'); // the precached body
    expect(w.fetchCalls.length).toBe(before);
  });

  it('goes to the network for an asset it does not hold', async () => {
    const w = boot();
    await w.dispatch('install', {});
    const r = await w.dispatch('fetch', { request: req('/assets/other-ZZZZ.js') });
    expect(await r!.text()).toBe('net:/assets/other-ZZZZ.js');
  });

  it('a storage error on lookup reads as a miss, not a failed request', async () => {
    const w = boot();
    await w.dispatch('install', {});
    (globalThis as any).__cacheThrows = true;
    const r = await w.dispatch('fetch', { request: req('/assets/index-AAAA.js') });
    expect(await r!.text()).toBe('net:/assets/index-AAAA.js');
  });

  it('navigation: returns a fresh document when the network answers', async () => {
    const w = boot();
    await w.dispatch('install', {});
    const r = await w.dispatch('fetch', { request: req('/notes', { mode: 'navigate' }) });
    expect(r!.status).toBe(200);
    // The NETWORK's answer for /notes, not the cached document.
    expect(await r!.text()).toBe('net:/notes');
  });

  it('navigation: falls back to the cached shell on a 5xx', async () => {
    // The shell can still open notes from IndexedDB; an ingress error page cannot.
    const w = boot();
    await w.dispatch('install', {});
    const w2 = boot({ fetchImpl: async (u, init) => init?.mode === 'navigate' || u.endsWith('/notes') ? html('bad gateway', 502) : defaultFetch(u) });
    await w2.dispatch('install', {});
    const r = await w2.dispatch('fetch', { request: req('/notes', { mode: 'navigate' }) });
    expect(r!.status).toBe(200);
    expect(await r!.text()).toBe(GOOD_DOC);
  });

  it('navigation: passes a 5xx through when nothing is cached', async () => {
    const w = boot({ precache: [], fetchImpl: async () => html('bad gateway', 502) });
    await w.dispatch('install', {});
    const r = await w.dispatch('fetch', { request: req('/notes', { mode: 'navigate' }) });
    expect(r!.status).toBe(502);
  });

  it('navigation: a 4xx passes through even with a cached shell', async () => {
    const w = boot({ fetchImpl: async (u) => u.endsWith('/gone') ? html('nope', 404) : defaultFetch(u) });
    await w.dispatch('install', {});
    const r = await w.dispatch('fetch', { request: req('/gone', { mode: 'navigate' }) });
    expect(r!.status).toBe(404);
  });

  it('navigation: falls back to the cached document when the network FAILS', async () => {
    let online = true;
    const w = boot({ fetchImpl: async (u, init) => { if (!online) throw new TypeError('offline'); return defaultFetch(u, init); } });
    await w.dispatch('install', {});
    online = false;
    const r = await w.dispatch('fetch', { request: req('/notes/123', { mode: 'navigate' }) });
    expect(await r!.text()).toBe(GOOD_DOC);
  });

  it('navigation: does not wait for a dead link when a shell is cached', async () => {
    // A connected-but-dead Wi-Fi never rejects; it just never answers.
    const w = boot({ fetchImpl: (u, init) => init?.mode === 'navigate' || u.endsWith('/notes') ? new Promise(() => {}) : defaultFetch(u) });
    await w.dispatch('install', {});
    const started = Date.now();
    const r = await w.dispatch('fetch', { request: req('/notes', { mode: 'navigate' }) });
    expect(await r!.text()).toBe(GOOD_DOC);
    expect(Date.now() - started).toBeLessThan(4000 + 1500);
  }, 10000);

  it('navigation: rejects offline when nothing was ever cached, rather than serving junk', async () => {
    const w = boot({ precache: [], fetchImpl: async () => { throw new TypeError('offline'); } });
    await w.dispatch('install', {});
    await expect(w.dispatch('fetch', { request: req('/', { mode: 'navigate' }) })).rejects.toThrow(/offline/);
  });
});

describe('push is untouched', () => {
  it('relays the sync tickle as "note-sync"', async () => {
    const w = boot();
    await w.dispatch('push', { data: { json: () => ({ kind: 'sync' }) } });
    expect(w.posted).toEqual([{ type: 'note-sync' }]);
  });
});

describe('the kill switch worker', () => {
  it('parses, needs no injection, and clears + unregisters + reloads', async () => {
    expect(KILL_SRC).not.toContain('__BUILD_ID__');
    expect(KILL_SRC).not.toContain('__PRECACHE_URLS__');
    const handlers: Record<string, Handler[]> = {};
    const navigated: string[] = [];
    const matchAllOpts: any[] = [];
    let unregistered = 0, skipped = 0, claimed = 0;
    const caches = fakeCaches();
    caches._seed('pingolin-note-poisoned', ['/index.html']);
    caches._seed('unrelated', ['/x']);
    const controlled = [
      { url: ORIGIN + '/a', navigate: async (u: string) => { navigated.push(u); } },
      { url: ORIGIN + '/b' }, // WebKit: no navigate()
    ];
    // A page that registered this worker FRESH after a reload: never controlled.
    const uncontrolled = { url: ORIGIN + '/fresh', navigate: async (u: string) => { navigated.push(u); } };
    const self: any = {
      addEventListener(type: string, fn: Handler) { (handlers[type] ??= []).push(fn); },
      skipWaiting() { skipped++; },
      clients: {
        async claim() { claimed++; },
        async matchAll(opts: any) {
          matchAllOpts.push(opts);
          return opts?.includeUncontrolled ? [...controlled, uncontrolled] : controlled;
        },
      },
      registration: { async unregister() { unregistered++; return true; } },
    };
    vm.runInNewContext(KILL_SRC, { self, caches, Promise, console });
    for (const h of handlers.install ?? []) h({});
    const waits: Promise<any>[] = [];
    for (const h of handlers.activate ?? []) h({ waitUntil: (p: Promise<any>) => waits.push(p) });
    await Promise.all(waits);
    expect(skipped).toBe(1);
    expect(caches._store.size).toBe(0);
    expect(unregistered).toBe(1);
    // THE LOOP GUARD: no claim, and only controlled clients are reloaded. With
    // either, a page that re-registers on boot is reloaded again, forever —
    // hundreds of loads within seconds.
    expect(claimed).toBe(0);
    expect(matchAllOpts).toEqual([{ type: 'window' }]);
    expect(navigated).toEqual([ORIGIN + '/a']); // controlled only; WebKit client skipped
  });
});
