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
 * checkAuth, all the way down to the last rung: a signed-in tab that cannot get
 * its key stays LOCKED and says why. It never makes one.
 *
 * WHY THESE EXIST
 *   A last rung that asks the server whether the account has a ciphertext
 *   and, on "no" — which is also what it hears for every 5xx, 429 or dropped
 *   connection — mints a random vault key and marks crypto ready would seal
 *   everything written in that tab under a key that dies with it. There is no
 *   minting code; these drive the real store through each probe answer and
 *   check what the user is left with.
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

const ME = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'me@example.test' };
const START = 'https://note.pingolindev.com/';

type ClientKeyAnswer = 'present' | 'absent' | 'unavailable';

/** The public keys /auth/me registers for ME (keys are restored only when
 *  they are these). */
let meKeys: { sharing_public_key?: string; signing_public_key?: string };

let session: Storage;
let clientKeyAnswer: ClientKeyAnswer;
let win: { location: { href: string; hostname: string; pathname: string; search: string; hash: string } };
let crypto: typeof import('../lib/crypto');
let authStore: typeof import('./auth').authStore;

beforeEach(async () => {
  meKeys = {};
  session = memoryStorage();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', memoryStorage());
  win = {
    location: { href: START, hostname: 'note.pingolindev.com', pathname: '/', search: '', hash: '' },
  };
  vi.stubGlobal('window', Object.assign(win, {
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('history', { replaceState: () => {} });
  // The federation iframe is created and never loads (no portal here), so the
  // request ends on its timeout — the "portal could not hand a key" path.
  vi.stubGlobal('document', {
    createElement: () => ({ setAttribute() {}, style: {}, addEventListener() {}, parentNode: null }),
    body: { appendChild() {} },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/me')) return json(200, { success: true, data: { ...ME, ...meKeys } });
    if (url.includes('/auth/client-key')) {
      if (clientKeyAnswer === 'unavailable') return json(503, { success: false, error: 'down' });
      return json(200, {
        success: true,
        data: { encrypted_private_key: clientKeyAnswer === 'present' ? 'AAAA' : null },
      });
    }
    return json(404, { success: false });
  }));

  vi.resetModules();
  crypto = await import('../lib/crypto');
  await crypto.initCrypto();
  ({ authStore } = await import('./auth'));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Run checkAuth past the federation iframe's timeout. */
async function runCheckAuth(): Promise<void> {
  const done = authStore.checkAuth();
  await vi.advanceTimersByTimeAsync(10_000);
  await done;
}

describe('the last rung never mints a vault key', () => {
  it('server answers "no ciphertext": sends the user to the portal once, holding no key', async () => {
    clientKeyAnswer = 'absent';
    await runCheckAuth();
    expect(crypto.isCryptoReady()).toBe(false);
    expect(win.location.href).toBe(
      `https://account.pingolindev.com/login?redirect=${encodeURIComponent(START)}`);
  });

  it('server answers "no ciphertext" again after that trip: locked, and says so', async () => {
    clientKeyAnswer = 'absent';
    session.setItem('note-e2ee-fork-attempted', '1');
    await runCheckAuth();
    expect(crypto.isCryptoReady()).toBe(false);
    expect(win.location.href).toBe(START);
    expect(authStore.keysUnavailable()).toBe('no-server-key');
    expect(authStore.keysNoticeVisible()).toBe(true);
  });

  it('server unreachable (503): locked, no page-wide redirect into an outage', async () => {
    clientKeyAnswer = 'unavailable';
    await runCheckAuth();
    expect(crypto.isCryptoReady()).toBe(false);
    expect(win.location.href).toBe(START);
    expect(authStore.keysUnavailable()).toBe('unreachable');
  });

  it('ciphertext exists but the portal could not hand the key over: locked', async () => {
    clientKeyAnswer = 'present';
    session.setItem('note-e2ee-fork-attempted', '1');
    await runCheckAuth();
    expect(crypto.isCryptoReady()).toBe(false);
    expect(authStore.keysUnavailable()).toBe('not-federated');
  });

  it('a throwaway key an older build left in this tab is refused, not resumed', async () => {
    clientKeyAnswer = 'absent';
    session.setItem('note-e2ee-fork-attempted', '1');
    session.setItem('pingolin_note_session_key',
      sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.ORIGINAL));
    await runCheckAuth();
    expect(crypto.isCryptoReady()).toBe(false);
    expect(authStore.keysUnavailable()).toBe('no-server-key');
  });

  it('dismissing the notice hides it but leaves the tab locked', async () => {
    clientKeyAnswer = 'unavailable';
    await runCheckAuth();
    authStore.dismissKeysUnavailable();
    expect(authStore.keysNoticeVisible()).toBe(false);
    expect(authStore.keysUnavailable()).toBe('unreachable');
  });
});

describe('the rungs that do work still work', () => {
  it('a consistent session handoff unlocks with no notice', async () => {
    const kp = sodium.crypto_box_keypair();
    const vault = sodium.crypto_generichash(32, kp.privateKey, sodium.from_string('pingolin-note-vault'));
    const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
    meKeys = { sharing_public_key: b64(kp.publicKey) };
    session.setItem('pingolin_note_session_key', b64(vault));
    session.setItem('pingolin_note_sharing_priv', b64(kp.privateKey));
    session.setItem('pingolin_note_sharing_pub', b64(kp.publicKey));
    clientKeyAnswer = 'present';
    await runCheckAuth();
    expect(crypto.isCryptoReady()).toBe(true);
    expect(authStore.keysUnavailable()).toBeNull();
  });

  it('a shell that re-hands keys to a locked document unlocks it', async () => {
    const kp = sodium.crypto_box_keypair();
    const vault = sodium.crypto_generichash(32, kp.privateKey, sodium.from_string('pingolin-note-vault'));
    const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
    meKeys = { sharing_public_key: b64(kp.publicKey) };
    clientKeyAnswer = 'unavailable';
    await runCheckAuth();
    expect(authStore.keysUnavailable()).toBe('unreachable');

    session.setItem('pingolin_note_session_key', b64(vault));
    session.setItem('pingolin_note_sharing_priv', b64(kp.privateKey));
    expect(authStore.adoptSessionKeys()).toBe(true);
    expect(crypto.isCryptoReady()).toBe(true);
    expect(authStore.keysUnavailable()).toBeNull();
  });
});

describe('the iOS key-bridge shell', () => {
  it('without a handed-over vault key stays locked in the app: no portal, no client-key probe', async () => {
    // Re-import with the shell's marker present.
    vi.useRealTimers();
    vi.stubGlobal('window', Object.assign(win, {
      addEventListener: () => {},
      removeEventListener: () => {},
      __pingolinKeyBridge: { version: 1, signing: true },
    }));
    vi.resetModules();
    crypto = await import('../lib/crypto');
    await crypto.initCrypto();
    ({ authStore } = await import('./auth'));
    vi.useFakeTimers();
    win.location.hash = '#ck=AAAA';
    clientKeyAnswer = 'present';

    await runCheckAuth();

    expect(crypto.isCryptoReady()).toBe(false);
    expect(authStore.keysUnavailable()).toBe('app');
    expect(win.location.href).toBe(START);
    const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(c => c[0]);
    expect(calls.some(u => u.includes('/auth/client-key'))).toBe(false);
  });
});
