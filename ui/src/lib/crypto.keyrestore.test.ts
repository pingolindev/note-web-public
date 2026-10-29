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
 * A vault key is derived, restored or refused — never invented.
 *
 * WHY THESE EXIST
 *   A probe that answers "no stored key" for ANY failure — offline, 5xx, 429,
 *   a WAF page — exactly as for a genuine "no ciphertext" invites the app to
 *   mint a RANDOM vault key and mark crypto ready. The real key is always
 *   BLAKE2b(sharing private key, "pingolin-note-vault"), so everything written
 *   under a random one is lost with the tab — and a reload does not undo it
 *   once the random key is persisted to sessionStorage, the first thing the
 *   next load restores.
 *
 *   These pin the three halves of the rule: the probe tells a failure from a
 *   genuine answer, there is no minting function to call, and a session vault
 *   key that nothing legitimate could have produced is refused.
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

const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
const vaultOf = (priv: Uint8Array) =>
  sodium.crypto_generichash(32, priv, sodium.from_string('pingolin-note-vault'));

let crypto: typeof import('./crypto');
let session: Storage;
let local: Storage;

beforeEach(async () => {
  session = memoryStorage();
  local = memoryStorage();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  vi.resetModules();
  crypto = await import('./crypto');
  await crypto.initCrypto();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeStoredKey: only the auth service can say "absent"', () => {
  const respond = (init: { status?: number; body?: unknown; raw?: string } | 'throw') =>
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (init === 'throw') throw new TypeError('Failed to fetch');
      const status = init.status ?? 200;
      const text = init.raw ?? JSON.stringify(init.body);
      return new Response(text, { status, headers: { 'content-type': 'application/json' } });
    }));

  it('reads a ciphertext row as present', async () => {
    respond({ body: { success: true, data: { encrypted_private_key: 'AAAA', encrypted_private_key_nonce: 'BBBB' } } });
    expect(await crypto.probeStoredKey('/api/v1')).toBe('present');
  });

  it("reads the auth service's own empty answer as absent", async () => {
    // The auth server's legacy path with no row: 200, every field null.
    respond({ body: { success: true, data: { client_key: null, blob_missing: false, encrypted_private_key: null } } });
    expect(await crypto.probeStoredKey('/api/v1')).toBe('absent');
  });

  it.each([
    ['a thrown fetch (offline)', 'throw' as const],
    ['a 500', { status: 500, body: { success: false, error: 'boom' } }],
    ['a 502 from a rolling deploy', { status: 502, raw: '<html>Bad gateway</html>' }],
    ['a 429 rate limit', { status: 429, body: { success: false } }],
    ['a WAF 403 page', { status: 403, raw: '<html>Access denied</html>' }],
    ['a 200 that is not JSON (captive portal)', { status: 200, raw: '<html>Sign in to Wi-Fi</html>' }],
    ['a 200 JSON that is not the auth envelope', { status: 200, body: { ok: true } }],
    ['a 200 envelope reporting failure', { status: 200, body: { success: false, data: {} } }],
  ])('reads %s as unknown — never as absent', async (_label, init) => {
    respond(init);
    expect(await crypto.probeStoredKey('/api/v1')).toBe('unknown');
  });
});

describe('nothing in the page mints a vault key', () => {
  it('exports neither generateVaultKey nor the boolean probe', () => {
    expect('generateVaultKey' in crypto).toBe(false);
    expect('serverHasStoredKey' in crypto).toBe(false);
  });
});

describe('judgeSessionVault', () => {
  it('accepts exactly the vault key the sharing private key derives', () => {
    const kp = sodium.crypto_box_keypair();
    expect(crypto.judgeSessionVault(vaultOf(kp.privateKey), kp.privateKey, kp.publicKey)).toBe('derived');
  });

  it('refuses a vault key the sharing private key does not derive', () => {
    const kp = sodium.crypto_box_keypair();
    expect(crypto.judgeSessionVault(sodium.randombytes_buf(32), kp.privateKey, kp.publicKey)).toBe('mismatch');
  });

  it("takes the iOS shell's word when only the public key is handed over", () => {
    const kp = sodium.crypto_box_keypair();
    expect(crypto.judgeSessionVault(vaultOf(kp.privateKey), null, kp.publicKey)).toBe('shell-supplied');
  });

  it('refuses a vault key with no sharing key at all — the shape of a randomly minted one', () => {
    expect(crypto.judgeSessionVault(sodium.randombytes_buf(32), null, null)).toBe('unverifiable');
  });
});

describe('restoreFromSession', () => {
  // Keys are restored only for the account /auth/me confirmed, and only when
  // they are its registered keys (crypto.tabaccount.test.ts).
  const ACCT = 'aaaaaaaa-0000-4000-8000-0000000000aa';
  const expect_ = (sharingPub: Uint8Array, signingPub?: Uint8Array) =>
    crypto.expectAccount(crypto.accountKeysFrom(ACCT, b64(sharingPub), signingPub ? b64(signingPub) : null));

  it('refuses a persisted throwaway key, forgets it, and stays locked', () => {
    // A throwaway vault key persisted on its own: a vault key and nothing else,
    // because a randomly minted key has no sharing keypair to go with it.
    expect_(sodium.crypto_box_keypair().publicKey);
    session.setItem('pingolin_note_session_key', b64(sodium.randombytes_buf(32)));
    expect(crypto.restoreFromSession()).toBe(false);
    expect(crypto.isCryptoReady()).toBe(false);
    expect(session.getItem('pingolin_note_session_key')).toBeNull();
  });

  it('refuses a vault key that does not match the sharing key beside it', () => {
    const kp = sodium.crypto_box_keypair();
    expect_(kp.publicKey);
    session.setItem('pingolin_note_session_key', b64(sodium.randombytes_buf(32)));
    session.setItem('pingolin_note_sharing_priv', b64(kp.privateKey));
    session.setItem('pingolin_note_sharing_pub', b64(kp.publicKey));
    expect(crypto.restoreFromSession()).toBe(false);
    expect(crypto.isCryptoReady()).toBe(false);
    expect(session.getItem('pingolin_note_sharing_priv')).toBeNull();
  });

  it('restores a consistent browser / Android-shell handoff', () => {
    const kp = sodium.crypto_box_keypair();
    expect_(kp.publicKey);
    session.setItem('pingolin_note_session_key', b64(vaultOf(kp.privateKey)));
    session.setItem('pingolin_note_sharing_priv', b64(kp.privateKey));
    session.setItem('pingolin_note_sharing_pub', b64(kp.publicKey));
    expect(crypto.restoreFromSession()).toBe(true);
    expect(crypto.isCryptoReady()).toBe(true);
    expect(crypto.getSharingPublicKeyHex()).toBe(sodium.to_hex(kp.publicKey));
  });

  it('derives the sharing public key rather than trusting a mismatched one', () => {
    const kp = sodium.crypto_box_keypair();
    const stranger = sodium.crypto_box_keypair();
    expect_(kp.publicKey);
    session.setItem('pingolin_note_session_key', b64(vaultOf(kp.privateKey)));
    session.setItem('pingolin_note_sharing_priv', b64(kp.privateKey));
    session.setItem('pingolin_note_sharing_pub', b64(stranger.publicKey));
    expect(crypto.restoreFromSession()).toBe(true);
    expect(crypto.getSharingPublicKeyHex()).toBe(sodium.to_hex(kp.publicKey));
  });

  it('restores an iOS-shell handoff (public keys only) with no private key in memory', () => {
    const kp = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();
    // Public keys alone are taken only inside the key-bridge shell.
    vi.stubGlobal('window', { __pingolinKeyBridge: { version: 1, signing: false } });
    expect_(kp.publicKey, sign.publicKey);
    session.setItem('pingolin_note_session_key', b64(vaultOf(kp.privateKey)));
    session.setItem('pingolin_note_sharing_pub', b64(kp.publicKey));
    session.setItem('pingolin_note_sign_public', b64(sign.publicKey));
    expect(crypto.restoreFromSession()).toBe(true);
    expect(crypto.isCryptoReady()).toBe(true);
    expect(crypto.getSharingPrivateKey()).toBeNull();
    // No signing secret in the page, and no X25519-derived stand-in either.
    expect(crypto.hasSigningKey()).toBe(false);
    expect(crypto.getSigningPublicKeyHex()).toBe(sodium.to_hex(sign.publicKey));
  });
});

describe('logout keeps this user\'s TOFU pins', () => {
  const me = 'aaaaaaaa-0000-4000-8000-000000000001';
  const sender = 'bbbbbbbb-0000-4000-8000-000000000002';
  const sharing = 'aa'.repeat(32);
  const signing = 'bb'.repeat(32);

  it('survives clearKeys and reloads for the same user', () => {
    crypto.loadPinnedKeysFromStorage(me);
    crypto.approveUserKeyChange(sender, sharing, signing);
    expect(local.getItem(`pingolin_note_pinned_keys.${me}`)).not.toBeNull();

    crypto.clearKeys();
    expect(crypto.getPinnedUserKeys(sender)).toBeNull(); // memory is dropped…
    expect(local.getItem(`pingolin_note_pinned_keys.${me}`)).not.toBeNull(); // …the blob is not

    crypto.loadPinnedKeysFromStorage(me);
    expect(crypto.getPinnedUserKeys(sender)?.signingPubkeyHex).toBe(signing);
  });

  it('does not hand one account the pins of another', () => {
    crypto.loadPinnedKeysFromStorage(me);
    crypto.approveUserKeyChange(sender, sharing, signing);
    crypto.clearKeys();
    crypto.loadPinnedKeysFromStorage('cccccccc-0000-4000-8000-000000000003');
    expect(crypto.getPinnedUserKeys(sender)).toBeNull();
  });

  it('still sweeps the un-namespaced pre-login blob', () => {
    local.setItem('pingolin_note_pinned_keys', JSON.stringify({}));
    crypto.clearKeys();
    expect(local.getItem('pingolin_note_pinned_keys')).toBeNull();
  });
});
