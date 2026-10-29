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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * checkAuth in a shell: the app's copy of this account's kept trust is
 * folded in BEFORE the pins load, so the first share the inbox checks meets the
 * pins this account had before its last sign-out. And a pin taken afterwards
 * goes back to the app.
 *
 * WHY THESE EXIST
 *   The shells' sign-out wipe deletes the page's pins with the rest. A copy
 *   folded in after the pins had loaded would sit unread in storage until the
 *   next start, and the inbox would meet every sender as a first contact.
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
const SENDER = 'cccccccc-0000-4000-8000-0000000000cc';
const START = 'https://note.pingolindev.com/';
const keptPin = { sharingPubkeyHex: 'b'.repeat(64), signingPubkeyHex: 'c'.repeat(64), firstPinnedAt: 10, lastVerifiedAt: 20 };

type Native = (request: Record<string, any>) => unknown;
let sent: Record<string, any>[];
let crypto: typeof import('../lib/crypto');
let authStore: typeof import('./auth').authStore;

const iosShell = (native: Native) => ({
  __pingolinKeyBridge: { version: 1, signing: false },
  webkit: { messageHandlers: { pingolinKeys: { postMessage: async (m: Record<string, any>) => { sent.push(m); return native(m); } } } },
});

function androidShell(native: Native) {
  let listener: ((e: { data: unknown }) => void) | null = null;
  return {
    pingolinTrust: {
      postMessage(s: string) {
        const request = JSON.parse(s);
        sent.push(request);
        void Promise.resolve().then(async () => {
          const reply = await native(request);
          if (reply !== undefined) listener?.({ data: JSON.stringify({ ...(reply as object), id: request.id }) });
        });
      },
      addEventListener(_type: string, fn: (e: { data: unknown }) => void) { listener = fn; },
    },
  };
}

/** The app: a copy of ME's pins with SENDER in it, or none; it keeps whatever it's sent. */
const theApp = (withCopy: boolean): Native => (m) => {
  if (m.op === 'keepTrust') return { v: 1, state: 'kept' };
  if (m.op !== 'keptTrust') throw new Error('unknown op');
  return withCopy
    ? { v: 1, account: m.account, state: 'copy', pins: JSON.stringify({ [SENDER]: keptPin }), floors: null, owners: null }
    : { v: 1, account: m.account, state: 'none' };
};

async function start(shell: object) {
  sent = [];
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('window', Object.assign({
    location: { href: START, hostname: 'note.pingolindev.com', pathname: '/', search: '', hash: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  }, shell));
  vi.stubGlobal('history', { replaceState: () => {} });
  vi.stubGlobal('document', {
    createElement: () => ({ setAttribute() {}, style: {}, addEventListener() {}, parentNode: null }),
    body: { appendChild() {} },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth/me')) return json(200, { success: true, data: ME });
    if (url.includes('/auth/client-key')) return json(200, { success: true, data: { encrypted_private_key: null } });
    return json(404, { success: false });
  }));
  vi.resetModules();
  crypto = await import('../lib/crypto');
  await crypto.initCrypto();
  ({ authStore } = await import('./auth'));
  vi.useFakeTimers();
  const done = authStore.checkAuth();
  await vi.advanceTimersByTimeAsync(10_000);
  await done;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("checkAuth in a shell, with the app's copy of this account's pins", () => {
  it.each([
    ['Android', () => androidShell(theApp(true))],
    ['iOS', () => iosShell(theApp(true))],
  ])('(%s) has the kept pin in place when the pins load', async (_shell, shell) => {
    await start(shell());

    expect(sent.find(m => m.op === 'keptTrust')).toMatchObject({ op: 'keptTrust', v: 1, account: ME.id });
    expect(crypto.getPinnedUserKeys(SENDER)?.sharingPubkeyHex).toBe(keptPin.sharingPubkeyHex);
  });
});

describe('a pin taken after checkAuth', () => {
  it('goes back to the app, named for the account', async () => {
    await start(androidShell(theApp(false)));
    const sharing = sodium.to_hex(sodium.crypto_box_keypair().publicKey);
    const signing = sodium.to_hex(sodium.crypto_sign_keypair().publicKey);

    crypto.pinUserKeys(SENDER, sharing, signing);
    await vi.advanceTimersByTimeAsync(10);

    const last = sent.filter(m => m.op === 'keepTrust').pop()!;
    expect(last.account).toBe(ME.id);
    expect(JSON.parse(last.pins)[SENDER].sharingPubkeyHex).toBe(sharing);
  });
});

describe('both of checkAuth\'s pin loads come after the adopt (read from the source)', () => {
  it('the online confirmation and the offline resume', () => {
    const auth = readFileSync(join(__dirname, 'auth.ts'), 'utf8');
    const pairs = auth.match(/await adoptKeptTrust\(accountId\);\n(\s*\/\/.*\n)*\s*try \{ loadPinnedKeysFromStorage\(accountId\); \}/g) ?? [];
    const loads = auth.match(/loadPinnedKeysFromStorage\(accountId\)/g) ?? [];
    expect(loads).toHaveLength(2);
    expect(pairs).toHaveLength(2);
  });
});
