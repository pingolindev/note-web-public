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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The iOS shell keeps no service worker (the header of offlineShell.ts says
 * why). Behaviour, not source: the two halves run against a fake navigator,
 * window and CacheStorage.
 *
 *   - Skip: in the iOS shell neither registration site registers.
 *   - Retire: every registration an earlier build left is unregistered, then
 *     the worker's `pingolin-note-` caches are deleted and nobody else's.
 *
 * `import.meta.env.DEV` is true under vitest and would return before either
 * half, so it is stubbed false; the browser case below is the control that
 * shows this harness reaches `register()` at all.
 */

vi.mock('./apiClient', () => ({ apiRequest: vi.fn(async () => ({ success: false })) }));

import { registerOfflineShell, retireIosShellWorker, isIosShell } from './offlineShell';
import { ensurePushSubscription } from './webPush';

const SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ANDROID_SHELL_UA = 'Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 PingolinNativeShell/1.0';

/** What each document-start script of the iOS shell writes, one at a time. */
const MARKERS: Record<string, unknown> = {
  __pingolinNativeShell: 'pingolin-close',
  __pingolinDevice: { rows: [] },
  __pingolinKeyBridge: { version: 1, signing: true },
};

interface Options {
  ua?: string;
  markers?: Record<string, unknown>;
  registrations?: number;
  cacheNames?: string[];
  unregisterRejects?: boolean;
  getRegistrationsRejects?: boolean;
  push?: boolean;
}

/** A fake page; `log` records every service-worker and cache call in order. */
function page(opts: Options = {}) {
  const log: string[] = [];
  const names = new Set(opts.cacheNames ?? ['pingolin-note-0a1b2c3d4e5f', 'pingolin-note-9f8e7d6c5b4a', 'someone-else']);
  const regs = Array.from({ length: opts.registrations ?? 1 }, (_, i) => ({
    scope: 'https://note.pingolindev.com/',
    installing: null,
    async unregister() {
      log.push(`unregister ${i}`);
      if (opts.unregisterRejects) throw new Error('refused');
      return true;
    },
    async update() { log.push('update'); },
    pushManager: { async getSubscription() { return null; }, async subscribe() { return null; } },
  }));
  const fallback = regs[0] ?? { installing: null, async update() {}, pushManager: { async getSubscription() { return null; } } };
  const serviceWorker = {
    async register(url: string, o: unknown) { log.push(`register ${url} ${JSON.stringify(o)}`); return fallback; },
    async getRegistrations() {
      log.push('getRegistrations');
      if (opts.getRegistrationsRejects) throw new Error('refused');
      return regs;
    },
    async getRegistration() { return regs[0]; },
    ready: Promise.resolve(fallback),
  };
  const push = opts.push ? { PushManager: function PushManager() {}, Notification: { permission: 'granted' } } : {};
  vi.stubGlobal('navigator', { userAgent: opts.ua ?? SAFARI_UA, serviceWorker });
  vi.stubGlobal('window', { ...(opts.markers ?? {}), ...push });
  if (opts.push) vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} });
  vi.stubGlobal('caches', {
    async keys() { log.push('caches.keys'); return [...names]; },
    async delete(name: string) { log.push(`caches.delete ${name}`); return names.delete(name); },
  });
  // Where the page keeps what is not synced yet (IndexedDB `pending`) and its
  // settings: any property read on either is recorded.
  const touched: string[] = [];
  const spy = (store: string) => new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'string') touched.push(`${store}.${prop}`);
      return () => undefined;
    },
  });
  vi.stubGlobal('indexedDB', spy('indexedDB'));
  vi.stubGlobal('localStorage', spy('localStorage'));
  return { log, names, touched };
}

beforeEach(() => { vi.stubEnv('DEV', false); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('the iOS shell keeps no service worker', () => {
  it('a browser still registers /sw (the control: this harness reaches register())', async () => {
    const { log } = page();
    await registerOfflineShell();
    expect(log).toEqual(['register /sw {"updateViaCache":"none"}']);
  });

  it('the Android shell neither registers nor clears anything, as before', async () => {
    const { log } = page({ ua: ANDROID_SHELL_UA, markers: { __pingolinNativeShell: 'pingolin-close', __pingolinDevice: {} } });
    await registerOfflineShell();
    expect(log).toEqual([]);
  });

  for (const [marker, value] of Object.entries(MARKERS)) {
    it(`the iOS shell, known by ${marker} alone, registers nothing and retires what a shipped build left`, async () => {
      const { log, names } = page({ markers: { [marker]: value }, registrations: 2 });
      await registerOfflineShell();
      expect(log.filter((l) => l.startsWith('register'))).toEqual([]);
      expect(log).toContain('unregister 0');
      expect(log).toContain('unregister 1');
      expect([...names]).toEqual(['someone-else']);
      // Registrations first: once none is left, no install can refill a cache.
      const lastUnregister = Math.max(log.indexOf('unregister 0'), log.indexOf('unregister 1'));
      const firstDelete = log.findIndex((l) => l.startsWith('caches.delete'));
      expect(firstDelete).toBeGreaterThan(lastUnregister);
    });
  }

  it('a refused unregister still deletes the caches', async () => {
    const { names } = page({ markers: MARKERS, unregisterRejects: true });
    await expect(retireIosShellWorker()).resolves.toBeUndefined();
    expect([...names]).toEqual(['someone-else']);
  });

  it('a refused registration list still deletes the caches', async () => {
    const { log, names } = page({ markers: MARKERS, getRegistrationsRejects: true });
    await expect(registerOfflineShell()).resolves.toBeUndefined();
    expect(log.filter((l) => l.startsWith('register'))).toEqual([]);
    expect([...names]).toEqual(['someone-else']);
  });

  it('the retirement touches neither IndexedDB, where unsynced edits wait, nor localStorage', async () => {
    const { log, names, touched } = page({ markers: MARKERS, registrations: 2 });
    await registerOfflineShell();
    expect(log).toContain('unregister 1');
    expect([...names]).toEqual(['someone-else']);
    expect(touched).toEqual([]);
    // The spies do see a touch: an empty list above is not for want of looking.
    (globalThis as unknown as { indexedDB: { deleteDatabase(n: string): void } }).indexedDB.deleteDatabase('probe');
    expect(touched).toEqual(['indexedDB.deleteDatabase']);
  });

  it('nothing registered and nothing cached is no error', async () => {
    const { log } = page({ markers: MARKERS, registrations: 0, cacheNames: [] });
    await expect(registerOfflineShell()).resolves.toBeUndefined();
    expect(log).toEqual(['getRegistrations', 'caches.keys']);
  });

  it('recognises the iOS shell only by its markers, and never the Android shell', () => {
    expect(isIosShell({}, SAFARI_UA)).toBe(false);
    expect(isIosShell(undefined, SAFARI_UA)).toBe(false);
    expect(isIosShell({ __pingolinNativeShell: 'pingolin-close' }, ANDROID_SHELL_UA)).toBe(false);
    for (const [marker, value] of Object.entries(MARKERS)) expect(isIosShell({ [marker]: value }, SAFARI_UA)).toBe(true);
  });
});

describe('the push path does not bring the worker back', () => {
  it('a browser with permission registers through it (the control)', async () => {
    const { log } = page({ push: true });
    await ensurePushSubscription();
    expect(log).toContain('register /sw {"updateViaCache":"none"}');
  });

  it('the iOS shell does not, even if it reported push support', async () => {
    const { log } = page({ push: true, markers: { __pingolinDevice: { rows: [] } } });
    await expect(ensurePushSubscription()).resolves.toBeNull();
    expect(log.filter((l) => l.startsWith('register'))).toEqual([]);
  });
});
