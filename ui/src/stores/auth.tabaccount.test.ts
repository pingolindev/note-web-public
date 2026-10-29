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

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import sodiumInit from 'libsodium-wrappers';

/**
 * checkAuth, the offline resume, the open-tab re-check and the stop, driven
 * through the real auth store:
 *   - the tab acts as the account /auth/me names, in its canonical spelling,
 *     and the keys it kept are used only if they are that account's;
 *   - the offline resume checks them against the keys the last confirmed
 *     session recorded;
 *   - an open tab re-checks /auth/me, and another account, or this account
 *     with other keys, wipes the tab and reloads it; so does the note
 *     server's 409, and after it nothing leaves the tab;
 *   - what older builds kept once per browser is adopted only by the owner
 *     the browser recorded.
 */

let sodium: typeof sodiumInit;
beforeAll(async () => {
  await sodiumInit.ready;
  sodium = sodiumInit;
});

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

const ME = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
const vaultOf = (priv: Uint8Array) =>
  sodium.crypto_generichash(32, priv, sodium.from_string('pingolin-note-vault'));

interface Identity {
  box: { privateKey: Uint8Array; publicKey: Uint8Array };
  sign: { privateKey: Uint8Array; publicKey: Uint8Array };
}
const identity = (): Identity => ({ box: sodium.crypto_box_keypair(), sign: sodium.crypto_sign_keypair() });

/** What /auth/me answers: an account with keys, a status, or a thrown fetch. */
type MeAnswer = { id: string; who: Identity } | { status: number; json: boolean } | 'throw';
let meAnswer: MeAnswer;

let session: Storage;
let local: Storage;
let reload: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let crypto: typeof import('../lib/crypto');
let account: typeof import('../lib/account');
let authStore: typeof import('./auth').authStore;
let api: typeof import('../lib/apiClient');

function keep(who: Identity, acct?: string) {
  session.setItem('pingolin_note_session_key', b64(vaultOf(who.box.privateKey)));
  session.setItem('pingolin_note_sharing_priv', b64(who.box.privateKey));
  session.setItem('pingolin_note_sharing_pub', b64(who.box.publicKey));
  session.setItem('pingolin_note_sign_secret', b64(who.sign.privateKey));
  session.setItem('pingolin_note_sign_public', b64(who.sign.publicKey));
  if (acct) session.setItem('pingolin_note_tab_account', acct);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  session = memoryStorage();
  local = memoryStorage();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  reload = vi.fn();
  vi.stubGlobal('window', {
    location: {
      href: 'https://note.pingolindev.com/', hostname: 'note.pingolindev.com',
      pathname: '/', search: '', hash: '', protocol: 'https:', reload,
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal('history', { replaceState: () => {} });
  vi.stubGlobal('document', {
    createElement: () => ({ setAttribute() {}, style: {}, addEventListener() {}, parentNode: null }),
    body: { appendChild() {} },
  });
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/auth/me')) {
      if (meAnswer === 'throw') throw new TypeError('Failed to fetch');
      if ('status' in meAnswer) {
        return meAnswer.json
          ? json(meAnswer.status, { success: false, error: 'no session' })
          : new Response('<html>down</html>', { status: meAnswer.status });
      }
      return json(200, {
        success: true,
        data: {
          id: meAnswer.id, email: 'me@example.test',
          sharing_public_key: b64(meAnswer.who.box.publicKey),
          signing_public_key: b64(meAnswer.who.sign.publicKey),
        },
      });
    }
    if (url.includes('/auth/client-key')) return json(503, { success: false, error: 'down' });
    return json(200, { success: true, data: {} });
  });
  vi.stubGlobal('fetch', fetchMock);

  vi.resetModules();
  crypto = await import('../lib/crypto');
  await crypto.initCrypto();
  account = await import('../lib/account');
  api = await import('../lib/apiClient');
  ({ authStore } = await import('./auth'));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function runCheckAuth(): Promise<void> {
  const done = authStore.checkAuth();
  await vi.advanceTimersByTimeAsync(10_000);
  await done;
}

async function signedInAsMe(): Promise<Identity> {
  const me = identity();
  keep(me);
  meAnswer = { id: ME, who: me };
  await runCheckAuth();
  expect(crypto.isCryptoReady()).toBe(true);
  return me;
}

describe('checkAuth', () => {
  it('caches the confirmed session with its registered public keys', async () => {
    const me = await signedInAsMe();
    const cachedSession = JSON.parse(local.getItem('pingolin_note_session')!);
    expect(cachedSession.id).toBe(ME);
    expect(cachedSession.sharing_public_key).toBe(b64(me.box.publicKey));
    expect(cachedSession.signing_public_key).toBe(b64(me.sign.publicKey));
  });

  it('acts as the canonical id /auth/me names', async () => {
    const me = identity();
    keep(me);
    meAnswer = { id: ME.toUpperCase(), who: me };
    await runCheckAuth();
    expect(authStore.user()?.id).toBe(ME);
    expect(account.getTabAccount()).toBe(ME);
    expect(crypto.isCryptoReady()).toBe(true);
  });

  it('signs out on an id that is not an account id, restoring nothing', async () => {
    const me = identity();
    keep(me);
    meAnswer = { id: 'not-an-id', who: me };
    await runCheckAuth();
    expect(authStore.isAuthenticated()).toBe(false);
    expect(crypto.isCryptoReady()).toBe(false);
  });

  it("another account's keys in this tab are wiped before anything runs", async () => {
    keep(identity(), ME);
    meAnswer = { id: ME, who: identity() };
    await runCheckAuth();
    expect(crypto.isCryptoReady()).toBe(false);
    expect(session.getItem('pingolin_note_sharing_priv')).toBeNull();
  });

  it('a shell hand-off before checkAuth confirms an account is refused', () => {
    keep(identity());
    expect(authStore.adoptSessionKeys()).toBe(false);
    expect(crypto.isCryptoReady()).toBe(false);
    expect(session.getItem('pingolin_note_sharing_priv')).not.toBeNull();
  });
});

describe("what older builds kept once per browser", () => {
  it('the recorded owner adopts it; other accounts\' stores go, their kept trust stays', async () => {
    local.setItem('pingolin_note_owner', ME);
    local.setItem('pingolin_note_gen_floor', '{"n1":3}');
    local.setItem(`pingolin_note_gen_floor.${OTHER}`, '{"n2":1}');
    local.setItem(`pingolin_note_metadata.${OTHER}`, '{}');
    await signedInAsMe();
    expect(local.getItem(`pingolin_note_gen_floor.${ME}`)).toBe('{"n1":3}');
    expect(local.getItem('pingolin_note_gen_floor')).toBeNull();
    expect(local.getItem(`pingolin_note_metadata.${OTHER}`)).toBeNull();
    // Floors are kept trust, like pins: another account's sign-in keeps them.
    expect(local.getItem(`pingolin_note_gen_floor.${OTHER}`)).toBe('{"n2":1}');
  });

  it("a different account signing in sweeps the browser's leftovers of the last one", async () => {
    local.setItem('pingolin_note_owner', OTHER);
    local.setItem('pingolin_note_settings', '{"theme":"dark"}');
    const me = identity();
    keep(me);
    meAnswer = { id: ME, who: me };
    await runCheckAuth();
    expect(local.getItem('pingolin_note_settings')).toBeNull();
    expect(local.getItem('pingolin_note_owner')).toBe(ME);
    // This tab's kept keys went with the last owner's session, unchecked.
    expect(session.getItem('pingolin_note_sharing_priv')).toBeNull();
  });

  it('with no recorded owner it is deleted unread', async () => {
    local.setItem('pingolin_note_gen_floor', '{"n1":3}');
    await signedInAsMe();
    expect(local.getItem(`pingolin_note_gen_floor.${ME}`)).toBeNull();
    expect(local.getItem('pingolin_note_gen_floor')).toBeNull();
  });
});

describe('the open-tab re-check', () => {
  it('another account signed in elsewhere: wiped, reloaded, and nothing leaves the tab after', async () => {
    await signedInAsMe();
    meAnswer = { id: OTHER, who: identity() };
    await authStore.recheckAccount();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(crypto.isCryptoReady()).toBe(false);
    expect(session.getItem('pingolin_note_session_key')).toBeNull();

    const calls = fetchMock.mock.calls.length;
    const r = await api.apiRequest('/api/v1/items', { method: 'POST', body: {} });
    expect(account.isAccountStop(r)).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('another account id is a stop even with the same keys', async () => {
    const me = await signedInAsMe();
    meAnswer = { id: OTHER, who: me };
    await authStore.recheckAccount();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('this account with other keys (a reset elsewhere): wiped and reloaded', async () => {
    await signedInAsMe();
    meAnswer = { id: ME, who: identity() };
    await authStore.recheckAccount();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(crypto.isCryptoReady()).toBe(false);
  });

  it('the same account and keys: nothing happens', async () => {
    const me = await signedInAsMe();
    meAnswer = { id: ME.toUpperCase(), who: me };
    await authStore.recheckAccount();
    expect(reload).not.toHaveBeenCalled();
    expect(crypto.isCryptoReady()).toBe(true);
  });

  it('a network failure proves nothing', async () => {
    await signedInAsMe();
    meAnswer = 'throw';
    await authStore.recheckAccount();
    meAnswer = { status: 503, json: false };
    await authStore.recheckAccount();
    expect(reload).not.toHaveBeenCalled();
    expect(crypto.isCryptoReady()).toBe(true);
  });

  it('a definite sign-out wipes and reloads', async () => {
    await signedInAsMe();
    meAnswer = { status: 401, json: true };
    await authStore.recheckAccount();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(crypto.isCryptoReady()).toBe(false);
  });

  it('asks nothing before an account is confirmed', async () => {
    await authStore.recheckAccount();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the portal's key hand-off names the account", () => {
  it('the invalidation of a handed key that does not open carries the account', async () => {
    const posted: { type?: string; account?: string }[] = [];
    const listeners = new Set<(e: { origin: string; data: unknown }) => void>();
    const portal = 'https://account.pingolindev.com';
    vi.stubGlobal('window', Object.assign((globalThis as { window: object }).window, {
      addEventListener: (type: string, fn: (e: { origin: string; data: unknown }) => void) => { if (type === 'message') listeners.add(fn); },
      removeEventListener: (type: string, fn: (e: { origin: string; data: unknown }) => void) => { if (type === 'message') listeners.delete(fn); },
    }));
    const reply = (data: unknown) => setTimeout(() => listeners.forEach((fn) => fn({ origin: portal, data })), 0);
    vi.stubGlobal('document', {
      createElement: () => ({
        setAttribute() {}, style: {}, parentNode: null,
        contentWindow: {
          postMessage: (m: { type?: string; account?: string }) => {
            posted.push(m);
            // The portal hands over a key that opens nothing here, then confirms
            // the invalidation.
            if (m.type === 'pingolin-ck-request') reply({ type: 'pingolin-ck', ck: b64(sodium.randombytes_buf(32)), blobId: 'blob' });
            if (m.type === 'pingolin-ck-invalidate') reply({ type: 'pingolin-ck-invalidated' });
          },
        },
        addEventListener: (type: string, fn: () => void) => { if (type === 'load') setTimeout(fn, 0); },
      }),
      body: { appendChild() {} },
    });
    const serve = fetchMock.getMockImplementation()! as (url: string, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/client-key')) {
        return json(200, { success: true, data: {
          encrypted_private_key: b64(sodium.randombytes_buf(48)), encrypted_private_key_nonce: b64(sodium.randombytes_buf(24)),
        } });
      }
      return serve(url, init);
    });
    meAnswer = { id: ME, who: identity() };
    await runCheckAuth();
    const invalidations = posted.filter((m) => m.type === 'pingolin-ck-invalidate');
    expect(invalidations.length).toBeGreaterThan(0);
    expect(invalidations.every((m) => m.account === ME)).toBe(true);
  });

  it('the key request carries the account', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const frame = {
          setAttribute() {}, style: {}, parentNode: null,
          contentWindow: { postMessage: (m: unknown) => { posted.push(m); } },
          addEventListener: (type: string, fn: () => void) => { if (type === 'load') setTimeout(fn, 0); },
        };
        return frame;
      },
      body: { appendChild() {} },
    });
    const me = identity();
    meAnswer = { id: ME, who: me };
    await runCheckAuth();
    const requests = posted.filter((m) => (m as { type?: string }).type === 'pingolin-ck-request');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((m) => (m as { account?: string }).account === ME)).toBe(true);
  });
});

describe("the note server's 409", () => {
  it('stops the tab once: wipe, one reload, and no request after it', async () => {
    await signedInAsMe();
    fetchMock.mockImplementationOnce(async () => json(409, { success: false, error_code: 'account_mismatch' }));
    const r = await api.apiRequest('/api/v1/items', { method: 'POST', body: {} });
    expect(account.isAccountStop(r)).toBe(true);
    expect((r as { status?: number }).status).toBeUndefined();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(crypto.isCryptoReady()).toBe(false);

    const calls = fetchMock.mock.calls.length;
    await api.apiRequest('/api/v1/items');
    await authStore.checkAuth();
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(reload).toHaveBeenCalledTimes(1);
    // Nothing resumed from the cached session either: the tab stays stopped.
    expect(authStore.isOffline()).toBe(false);
    expect(account.getTabAccount()).toBeNull();
  });
});

describe('the offline resume', () => {
  function cacheSession(id: string, who: Identity | null) {
    local.setItem('pingolin_note_owner', id);
    local.setItem('pingolin_note_session', JSON.stringify({
      id, email: 'me@example.test', verifiedAt: Date.now(),
      ...(who ? { sharing_public_key: b64(who.box.publicKey), signing_public_key: b64(who.sign.publicKey) } : {}),
    }));
  }

  it("resumes with this tab's keys when they are the recorded account's", async () => {
    const me = identity();
    cacheSession(ME, me);
    keep(me, ME);
    meAnswer = 'throw';
    await runCheckAuth();
    expect(authStore.isOffline()).toBe(true);
    expect(account.getTabAccount()).toBe(ME);
    expect(crypto.isCryptoReady()).toBe(true);
  });

  it("wipes keys that are not the recorded account's, and stays locked", async () => {
    cacheSession(ME, identity());
    keep(identity());
    meAnswer = 'throw';
    await runCheckAuth();
    expect(authStore.isOffline()).toBe(true);
    expect(crypto.isCryptoReady()).toBe(false);
    expect(session.getItem('pingolin_note_sharing_priv')).toBeNull();
  });

  it("wipes a set whose signing key is not the recorded account's", async () => {
    const me = identity();
    cacheSession(ME, me);
    keep({ box: me.box, sign: identity().sign }, ME);
    meAnswer = 'throw';
    await runCheckAuth();
    expect(authStore.isOffline()).toBe(true);
    expect(crypto.isCryptoReady()).toBe(false);
  });

  it("with no recorded owner, what older builds kept is deleted, not adopted", async () => {
    const me = identity();
    cacheSession(ME, me);
    local.removeItem('pingolin_note_owner');
    local.setItem('pingolin_note_gen_floor', '{"n1":3}');
    keep(me, ME);
    meAnswer = 'throw';
    await runCheckAuth();
    expect(authStore.isOffline()).toBe(true);
    expect(local.getItem(`pingolin_note_gen_floor.${ME}`)).toBeNull();
    expect(local.getItem('pingolin_note_gen_floor')).toBeNull();
  });

  it('a session cached before the keys were recorded restores no keys', async () => {
    const me = identity();
    cacheSession(ME, null);
    keep(me, ME);
    meAnswer = 'throw';
    await runCheckAuth();
    expect(authStore.isOffline()).toBe(true);
    expect(crypto.isCryptoReady()).toBe(false);
  });
});
