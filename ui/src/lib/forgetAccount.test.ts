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

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import sodiumInit from 'libsodium-wrappers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The web editor's /forget-account route (the erasure chain): the fragment
 * goes first; a verified receipt deletes the erased account's data from this
 * browser and nothing else; and the page always goes on to the fixed next
 * hop for its own host, never to a URL from the request.
 */

const { fake } = vi.hoisted(() => {
  const dbs = new Set<string>();
  return {
    fake: {
      dbs,
      openDB: async () => { throw new Error('the route opens no database'); },
      deleteDB: async (name: string) => { dbs.delete(name); },
    },
  };
});
vi.mock('idb', () => ({ openDB: fake.openDB, deleteDB: fake.deleteDB }));

const SUB = '3f2c9c8e-5a1b-4d7e-9c3a-1b2d3e4f5a6b'; // the vectors' erased account
const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const DEV = 'note.pingolindev.com';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}

interface Vectors { public_keys_hex: string[]; verify_at: number; cases: { name: string; receipt: string }[] }
const v: Vectors = JSON.parse(readFileSync(join(__dirname, 'testdata', 'erasure_receipt_v1.json'), 'utf8'));
const receipt = (name: string) => v.cases.find((c) => c.name === name)!.receipt;

let local: Storage;
let session: Storage;
let forget: typeof import('./forgetAccount');
const unsubscribe = vi.fn(async () => true);
let pushEndpoint: string | null;

beforeAll(async () => { await sodiumInit.ready; });

beforeEach(async () => {
  local = memoryStorage();
  session = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  pushEndpoint = null;
  unsubscribe.mockClear();
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    serviceWorker: {
      getRegistration: async () => ({
        pushManager: { getSubscription: async () => (pushEndpoint ? { endpoint: pushEndpoint, unsubscribe } : null) },
      }),
    },
  });
  fake.dbs.clear();
  vi.resetModules();
  forget = await import('./forgetAccount');
});

afterEach(() => vi.unstubAllGlobals());

/** A browser that held SUB's data and OTHER's. */
function seedBrowser() {
  for (const id of [SUB, OTHER]) {
    local.setItem(`pingolin_note_metadata.${id}`, '{}');
    local.setItem(`pingolin_note_retired_keys.${id}`, '{}');
    local.setItem(`pingolin_note_gen_floor.${id}`, '{}');
    local.setItem(`pingolin_note_pinned_keys.${id}`, '{}');
    fake.dbs.add(`pingolin-note-cache.${id}`);
  }
  local.setItem(`pingolin_note_pinned_keys.${SUB.toUpperCase()}`, '{}');
  local.setItem(`pingolin_note_pinned_keys.${SUB}.premerge.0`, '{}');
  local.setItem(`pingolin_note_push_endpoint.${SUB}`, 'https://push.example/sub');
  local.setItem(`pingolin_note_push_endpoint.${OTHER}`, 'https://push.example/other');
  local.setItem('pingolin_note_cache_accounts', JSON.stringify([SUB, OTHER]));
  local.setItem('pingolin_note_settings', '{"theme":"dark"}');
}

const keys = () => [...Array(local.length)].map((_, i) => local.key(i)!).sort();

function page(hash: string, hostname = DEV) {
  const calls: string[] = [];
  return {
    calls,
    location: {
      hash, hostname, pathname: '/forget-account',
      replace: vi.fn((url: string) => { calls.push(`replace ${url}`); }),
    },
    history: { replaceState: vi.fn(() => { calls.push('strip'); }) },
  };
}

const run = (p: ReturnType<typeof page>) =>
  forget.runForgetAccount(p, { nowSecs: () => v.verify_at, keysByHost: { [DEV]: v.public_keys_hex } });

describe('forgetAccountData', () => {
  it("deletes the erased account's data, and nobody else's", async () => {
    seedBrowser();
    local.setItem('pingolin_note_owner', SUB);
    local.setItem('pingolin_note_session', JSON.stringify({ id: SUB.toUpperCase(), verifiedAt: 1 }));
    await forget.forgetAccountData(SUB);
    expect(keys()).toEqual([
      'pingolin_note_cache_accounts',
      `pingolin_note_gen_floor.${OTHER}`,
      `pingolin_note_metadata.${OTHER}`,
      `pingolin_note_pinned_keys.${OTHER}`,
      `pingolin_note_push_endpoint.${OTHER}`,
      `pingolin_note_retired_keys.${OTHER}`,
      'pingolin_note_settings',
    ]);
    expect([...fake.dbs]).toEqual([`pingolin-note-cache.${OTHER}`]);
    expect(JSON.parse(local.getItem('pingolin_note_cache_accounts')!)).toEqual([OTHER]);
  });

  it("deletes the erased account's removal jobs, which a sign-out keeps, and nobody else's", async () => {
    const { rekeyDbName } = await import('./rekeyStore');
    seedBrowser();
    fake.dbs.add(await rekeyDbName(SUB));
    fake.dbs.add(await rekeyDbName(OTHER));

    await forget.forgetAccountData(SUB);

    expect(fake.dbs.has(await rekeyDbName(SUB))).toBe(false);
    expect(fake.dbs.has(await rekeyDbName(OTHER))).toBe(true);
  });

  it('keeps the recorded owner and cached session of the account signed in now', async () => {
    seedBrowser();
    local.setItem('pingolin_note_owner', OTHER);
    local.setItem('pingolin_note_session', JSON.stringify({ id: OTHER, verifiedAt: 1 }));
    await forget.forgetAccountData(SUB);
    expect(local.getItem('pingolin_note_owner')).toBe(OTHER);
    expect(local.getItem('pingolin_note_session')).not.toBeNull();
  });

  it('unsubscribes the push subscription only when it is the one recorded for the erased account', async () => {
    seedBrowser();
    pushEndpoint = 'https://push.example/other';
    await forget.forgetAccountData(SUB);
    expect(unsubscribe).not.toHaveBeenCalled();
    seedBrowser();
    pushEndpoint = 'https://push.example/sub';
    await forget.forgetAccountData(SUB);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  /** What an older build kept, one per browser and with no id. */
  const LEGACY_STORES = [
    'pingolin_note_metadata', 'pingolin_note_retired_keys', 'pingolin_note_locked_own',
    'pingolin_note_prev_identities_seen', 'pingolin_note_gen_floor', 'pingolin_note_inbox_last_seen',
    'pingolin_note_push_endpoint',
  ];
  function seedLegacy() {
    for (const base of LEGACY_STORES) local.setItem(base, '{}');
    local.setItem('pingolin_note_pinned_keys', '{}');
    local.setItem('pingolin_note_pinned_keys_blob', 'b');
    local.setItem('pingolin_note_pinned_keys_nonce', 'n');
    local.setItem('pingolin_note_settings', '{"theme":"dark"}');
    fake.dbs.add('pingolin-note-cache');
    session.setItem('pingolin_note_session_key', 'k'); // an older build's tab keys: no account recorded
  }
  const legacyLeft = () => ({
    stores: LEGACY_STORES.filter((b) => local.getItem(b) !== null).length,
    pins: ['pingolin_note_pinned_keys', 'pingolin_note_pinned_keys_blob', 'pingolin_note_pinned_keys_nonce']
      .filter((k) => local.getItem(k) !== null).length,
    db: fake.dbs.has('pingolin-note-cache'),
    tab: session.getItem('pingolin_note_session_key') !== null,
    settings: local.getItem('pingolin_note_settings') !== null,
  });

  it("an older build's data goes too when the browser recorded the erased account as its owner", async () => {
    seedLegacy();
    local.setItem('pingolin_note_owner', SUB.toUpperCase());
    await forget.forgetAccountData(SUB);
    expect(legacyLeft()).toEqual({ stores: 0, pins: 0, db: false, tab: false, settings: true });
    expect(local.getItem('pingolin_note_owner')).toBeNull();
  });

  it.each([
    ['another account', OTHER],
    ['nobody', null],
  ])("an older build's data stays when the recorded owner is %s", async (_label, owner) => {
    seedLegacy();
    if (owner) local.setItem('pingolin_note_owner', owner);
    await forget.forgetAccountData(SUB);
    expect(legacyLeft()).toEqual({ stores: 7, pins: 3, db: true, tab: true, settings: true });
    expect(local.getItem('pingolin_note_owner')).toBe(owner);
  });

  it("wipes this tab's keys only when the tab is the erased account's", async () => {
    session.setItem('pingolin_note_tab_account', OTHER);
    session.setItem('pingolin_note_session_key', 'k');
    await forget.forgetAccountData(SUB);
    expect(session.getItem('pingolin_note_session_key')).toBe('k');
    session.setItem('pingolin_note_tab_account', SUB);
    await forget.forgetAccountData(SUB);
    expect(session.getItem('pingolin_note_session_key')).toBeNull();
    expect(session.getItem('pingolin_note_tab_account')).toBeNull();
  });
});

describe('the route', () => {
  it('strips the fragment first, deletes on a verified receipt, then goes to the portal', async () => {
    seedBrowser();
    const p = page(`#r=${receipt('valid')}`);
    await run(p);
    expect(p.calls).toEqual(['strip', 'replace https://account.pingolindev.com/login']);
    expect(p.history.replaceState).toHaveBeenCalledWith(null, '', '/forget-account');
    expect(local.getItem(`pingolin_note_metadata.${SUB}`)).toBeNull();
    expect(local.getItem(`pingolin_note_metadata.${OTHER}`)).not.toBeNull();
  });

  it.each([
    ['a receipt for Track web only', `#r=${receipt('aud_track_web_only')}`],
    ['a tampered signature', `#r=${receipt('flipped_signature_byte')}`],
    ['an expired receipt', `#r=${receipt('expired')}`],
    ['anything beside the receipt', `#r=${receipt('valid')}&next=https://evil.example`],
    ['no receipt', ''],
  ])('%s: deletes nothing and still goes on to the fixed hop', async (_label, hash) => {
    seedBrowser();
    const before = keys();
    const p = page(hash);
    await run(p);
    expect(keys()).toEqual(before);
    expect(fake.dbs.size).toBe(2);
    expect(p.calls).toEqual(['strip', 'replace https://account.pingolindev.com/login']);
  });

  it('takes its keys from its own host: an unknown host verifies nothing and goes home', async () => {
    seedBrowser();
    const before = keys();
    const p = page(`#r=${receipt('valid')}`, 'localhost');
    await run(p);
    expect(keys()).toEqual(before);
    expect(p.calls).toEqual(['strip', 'replace /']);
  });

  it('goes to the production portal from the production host', async () => {
    const p = page('', 'note.pingolin.com');
    await forget.runForgetAccount(p);
    expect(p.calls).toEqual(['strip', 'replace https://account.pingolin.com/login']);
  });

  it("ships dev's verifying key, and none for prod", async () => {
    expect(forget.RECEIPT_KEYS_HEX).toEqual({
      'note.pingolin.com': [],
      'note.pingolindev.com': ['30d1d7e73d60a9891667d74cb76713d32b835735ff9e2af08054fdd2051f1979'],
    });
    // A real Ed25519 public key (a point on the curve), not a typo of one.
    const sodium = (await import('libsodium-wrappers')).default;
    await sodium.ready;
    const dev = sodium.from_hex(forget.RECEIPT_KEYS_HEX['note.pingolindev.com'][0]);
    expect(dev).toHaveLength(32);
    expect(() => sodium.crypto_sign_ed25519_pk_to_curve25519(dev)).not.toThrow();
  });

  it("with the compiled keys, a receipt signed by the vectors' test key is refused on dev", async () => {
    seedBrowser();
    const before = keys();
    const p = page(`#r=${receipt('valid')}`);
    await forget.runForgetAccount(p, { nowSecs: () => v.verify_at });
    expect(keys()).toEqual(before);
    expect(p.calls).toEqual(['strip', 'replace https://account.pingolindev.com/login']);
  });
});

describe('the entry point', () => {
  it('runs the route instead of the app, before anything else starts', () => {
    const src = readFileSync(join(__dirname, '..', 'index.tsx'), 'utf8');
    const branch = src.indexOf("window.location.pathname === '/forget-account'");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(src.indexOf('void NotesView.preload()'));
    expect(src).toContain("if (!forgetting) void NotesView.preload();");
    expect(src).toContain("if (!forgetting) void registerOfflineShell();");
    expect(src).toMatch(/if \(forgetting\) \{\n\s+void import\('\.\/lib\/forgetAccount'\)/);
  });
});
