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
 * Keys a tab kept are used only for the account /auth/me confirmed, and only
 * when they ARE that account's registered keys.
 *
 * The risk: a tab left open under account A shares its origin's cookie with
 * whoever signs in next. When B signs in in another tab, A's tab — or a
 * reload of it — holds A's vault and private keys in sessionStorage, and
 * must never restore them for B's session. These pin every rung:
 *   - a recorded account must be this one, and the id alone never counts: the
 *     sharing key derived from the private key must be /me's (and the vault key
 *     the one it derives), and a signing secret's public half /me's;
 *   - with no id recorded (a copy saved by an older build, or a shell's
 *     hand-off), that derivation is the proof; public keys alone are taken
 *     only inside the iOS key-bridge shell, and must be /me's;
 *   - a signing secret nothing can check (no /me signing key) is dropped;
 *   - anything else is wiped — vault, private keys, client key, blob id — and
 *     inside a native shell the page writes no keys at all.
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

const ME = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const OTHER = 'bbbbbbbb-0000-4000-8000-0000000000bb';

const K = {
  vault: 'pingolin_note_session_key',
  priv: 'pingolin_note_sharing_priv',
  pub: 'pingolin_note_sharing_pub',
  signSecret: 'pingolin_note_sign_secret',
  signPub: 'pingolin_note_sign_public',
  account: 'pingolin_note_tab_account',
  clientKey: 'pingolin_note_client_key',
  blobId: 'pingolin_note_client_blob',
};

interface Identity {
  box: { privateKey: Uint8Array; publicKey: Uint8Array };
  sign: { privateKey: Uint8Array; publicKey: Uint8Array };
}

const identity = (): Identity => ({ box: sodium.crypto_box_keypair(), sign: sodium.crypto_sign_keypair() });

let crypto: typeof import('./crypto');
let session: Storage;

async function load(window: object = {}, userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140') {
  session = memoryStorage();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('window', window);
  vi.stubGlobal('navigator', { userAgent });
  vi.resetModules();
  crypto = await import('./crypto');
  await crypto.initCrypto();
}

/** /auth/me for `id` registering `who`'s keys (signing optional). */
function confirm(id: string, who: Identity, opts: { signing?: boolean } = {}) {
  crypto.expectAccount(crypto.accountKeysFrom(
    id, b64(who.box.publicKey), opts.signing === false ? null : b64(who.sign.publicKey)));
}

/** The five fields a browser tab (or the App Store iOS shell) keeps. */
function keep(who: Identity, account?: string) {
  session.setItem(K.vault, b64(vaultOf(who.box.privateKey)));
  session.setItem(K.priv, b64(who.box.privateKey));
  session.setItem(K.pub, b64(who.box.publicKey));
  session.setItem(K.signSecret, b64(who.sign.privateKey));
  session.setItem(K.signPub, b64(who.sign.publicKey));
  if (account !== undefined) session.setItem(K.account, account);
}

function expectWiped() {
  expect(crypto.isCryptoReady()).toBe(false);
  expect(crypto.getSharingPrivateKey()).toBeNull();
  for (const k of [K.vault, K.priv, K.pub, K.signSecret, K.signPub, K.account, K.clientKey, K.blobId]) {
    expect(session.getItem(k), k).toBeNull();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('a browser tab', () => {
  beforeEach(() => load());

  it("restores this account's keys recorded for this account", () => {
    const me = identity();
    keep(me, ME);
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(true);
    expect(crypto.getSharingPublicKeyHex()).toBe(sodium.to_hex(me.box.publicKey));
    expect(crypto.getSigningPublicKeyHex()).toBe(sodium.to_hex(me.sign.publicKey));
  });

  it('refuses keys recorded for another account, even when they are these keys', () => {
    const me = identity();
    keep(me, OTHER);
    session.setItem(K.clientKey, 'wrapping-key');
    session.setItem(K.blobId, 'blob');
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it('refuses another account\'s keys recorded under this id: the id alone never counts', () => {
    keep(identity(), ME);
    confirm(ME, identity());
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it('compares the recorded account canonically', () => {
    const me = identity();
    keep(me, ME.toUpperCase());
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(true);
  });

  it('App-Store-shaped: five fields, no marker, no id, and they are /me\'s keys → used, and the id is written', () => {
    const me = identity();
    keep(me);
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(true);
    expect(session.getItem(K.account)).toBe(ME);
  });

  it('the same id-less set from another account → wiped', () => {
    keep(identity());
    session.setItem(K.clientKey, 'wrapping-key');
    confirm(ME, identity());
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it("a set whose signing secret is not /me's signing key → wiped", () => {
    const me = identity();
    keep(me);
    session.setItem(K.signSecret, b64(sodium.crypto_sign_keypair().privateKey));
    session.removeItem(K.signPub);
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it("another account's sharing key beside /me's signing key → wiped", () => {
    const me = identity();
    const other = identity();
    keep({ box: other.box, sign: me.sign });
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it("another account's sharing key when /me registers no signing key → wiped", () => {
    keep(identity());
    confirm(ME, identity(), { signing: false });
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it("a set whose signing public key is not /me's → wiped", () => {
    const me = identity();
    keep(me);
    session.removeItem(K.signSecret);
    session.setItem(K.signPub, b64(sodium.crypto_sign_keypair().publicKey));
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it('a signing secret with no /me signing key → dropped; the legacy key stands in', () => {
    const me = identity();
    keep(me);
    confirm(ME, me, { signing: false });
    expect(crypto.restoreFromSession()).toBe(true);
    // The unchecked secret is gone; the page signs with the key derived from
    // the sharing private key, as it does for any account without one.
    const legacy = sodium.crypto_sign_seed_keypair(me.box.privateKey);
    expect(crypto.getSigningPublicKeyHex()).toBe(sodium.to_hex(legacy.publicKey));
    expect(crypto.getSigningPublicKeyHex()).not.toBe(sodium.to_hex(me.sign.publicKey));
    expect(session.getItem(K.signSecret)).not.toBe(b64(me.sign.privateKey));
  });

  it('a vault key the private key does not derive → wiped', () => {
    const me = identity();
    keep(me, ME);
    session.setItem(K.vault, b64(sodium.randombytes_buf(32)));
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it('public keys alone are refused outside the key-bridge shell, even when they are /me\'s', () => {
    const me = identity();
    keep(me);
    session.removeItem(K.priv);
    session.removeItem(K.signSecret);
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it('an account that registers no sharing key restores nothing', () => {
    const me = identity();
    keep(me, ME);
    crypto.expectAccount(crypto.accountKeysFrom(ME, null, b64(me.sign.publicKey)));
    expect(crypto.restoreFromSession()).toBe(false);
  });

  it('before an account is confirmed nothing is restored and nothing is touched', () => {
    const me = identity();
    keep(me, ME);
    expect(crypto.restoreFromSession()).toBe(false);
    expect(session.getItem(K.vault)).not.toBeNull();
  });

  it("a kept blob id is only this account's", () => {
    session.setItem(K.blobId, 'blob');
    session.setItem(K.account, OTHER);
    confirm(ME, identity());
    expect(crypto.getLocalBlobId()).toBeNull();
  });

  it("a wipe clears every account's per-account stores", () => {
    const local = globalThis.localStorage;
    local.setItem(`pingolin_note_metadata.${ME}`, '{}');
    local.setItem(`pingolin_note_retired_keys.${OTHER}`, '{}');
    local.setItem('pingolin_note_gen_floor', '{}');
    crypto.clearKeys();
    expect(local.getItem(`pingolin_note_metadata.${ME}`)).toBeNull();
    expect(local.getItem(`pingolin_note_retired_keys.${OTHER}`)).toBeNull();
    expect(local.getItem('pingolin_note_gen_floor')).toBeNull();
  });

  it("a kept wrapping key is only this account's", () => {
    const me = identity();
    session.setItem(K.clientKey, 'wrapping-key');
    session.setItem(K.account, OTHER);
    confirm(ME, me);
    expect(crypto.getLocalClientKey()).toBeNull();
    expect(session.getItem(K.clientKey)).toBeNull();

    session.setItem(K.clientKey, 'wrapping-key');
    session.setItem(K.blobId, 'blob');
    session.setItem(K.account, ME);
    expect(crypto.getLocalClientKey()).toBe('wrapping-key');
    expect(crypto.getLocalBlobId()).toBe('blob');
  });
});

describe('a plain browser whose user agent claims to be the Android shell', () => {
  it("holding another account's keys → wiped", async () => {
    await load({}, 'Mozilla/5.0 (Linux; Android 15) PingolinNativeShell/1.0');
    keep(identity());
    confirm(ME, identity());
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it("holding only another account's public keys → wiped (no bridge marker)", async () => {
    await load({}, 'Mozilla/5.0 (Linux; Android 15) PingolinNativeShell/1.0');
    const me = identity();
    session.setItem(K.vault, b64(vaultOf(me.box.privateKey)));
    session.setItem(K.pub, b64(identity().box.publicKey));
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });
});

describe('inside a native shell the page writes no keys', () => {
  it('Android: a proven hand-off is used, and the page records nothing beside it', async () => {
    await load({}, 'Mozilla/5.0 (Linux; Android 15) PingolinNativeShell/1.0');
    const me = identity();
    keep(me);
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(true);
    expect(session.getItem(K.account)).toBeNull();
    // A re-persist (any key install does one) writes nothing either.
    session.clear();
    crypto.setVaultKey(vaultOf(me.box.privateKey));
    expect(session.length).toBe(0);
  });
});

describe('the iOS key-bridge shell (public keys only)', () => {
  const bridge = { __pingolinKeyBridge: { version: 1, signing: true } };

  function handOff(who: Identity, sharingPub = who.box.publicKey, signPub = who.sign.publicKey) {
    session.setItem(K.vault, b64(vaultOf(who.box.privateKey)));
    session.setItem(K.pub, b64(sharingPub));
    session.setItem(K.signPub, b64(signPub));
  }

  it("uses the hand-off when its public keys are /me's", async () => {
    await load(bridge);
    const me = identity();
    handOff(me);
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(true);
    expect(crypto.getSharingPrivateKey()).toBeNull();
    expect(session.getItem(K.account)).toBeNull();
  });

  it("wipes a hand-off whose sharing key is not /me's", async () => {
    await load(bridge);
    const me = identity();
    handOff(me, identity().box.publicKey);
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });

  it('does not take the hand-off\'s signing key when /me registers none', async () => {
    await load(bridge);
    const me = identity();
    handOff(me);
    confirm(ME, me, { signing: false });
    expect(crypto.restoreFromSession()).toBe(true);
    expect(crypto.getSigningPublicKeyHex()).toBeNull();
  });

  it("wipes a hand-off whose signing key is not /me's", async () => {
    await load(bridge);
    const me = identity();
    handOff(me, me.box.publicKey, identity().sign.publicKey);
    confirm(ME, me);
    expect(crypto.restoreFromSession()).toBe(false);
    expectWiped();
  });
});

describe('the client-key rung (a #ck hand-off, or the kept wrapping key)', () => {
  /** The auth service's client-key row: `who`'s keys sealed under `ck`. */
  function serveClientKey(who: Identity, ck: Uint8Array, opts: { signSeed?: Uint8Array } = {}) {
    const n1 = sodium.randombytes_buf(24);
    const n2 = sodium.randombytes_buf(24);
    const seed = opts.signSeed ?? who.sign.privateKey.subarray(0, 32);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: {
        encrypted_private_key: b64(sodium.crypto_secretbox_easy(who.box.privateKey, n1, ck)),
        encrypted_private_key_nonce: b64(n1),
        encrypted_signing_private_key: b64(sodium.crypto_secretbox_easy(seed, n2, ck)),
        encrypted_signing_private_key_nonce: b64(n2),
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
  }

  beforeEach(() => load());

  it("opens this account's keys and records the account beside them", async () => {
    const me = identity();
    const ck = sodium.randombytes_buf(32);
    serveClientKey(me, ck);
    confirm(ME, me);
    expect(await crypto.restoreFromClientKey('/api/v1', b64(ck))).toEqual({ ok: true });
    expect(crypto.getSigningPublicKeyHex()).toBe(sodium.to_hex(me.sign.publicKey));
    expect(session.getItem(K.account)).toBe(ME);
    expect(session.getItem(K.clientKey)).toBe(b64(ck));
  });

  it("refuses another account's key as a bad key, installing nothing", async () => {
    const ck = sodium.randombytes_buf(32);
    serveClientKey(identity(), ck);
    confirm(ME, identity());
    expect(await crypto.restoreFromClientKey('/api/v1', b64(ck))).toEqual({ ok: false, reason: 'bad-key' });
    expect(crypto.isCryptoReady()).toBe(false);
    expect(session.getItem(K.clientKey)).toBeNull();
  });

  it("uses a signing seed only when it is /me's signing key", async () => {
    const me = identity();
    const ck = sodium.randombytes_buf(32);
    serveClientKey(me, ck, { signSeed: sodium.randombytes_buf(32) });
    confirm(ME, me);
    expect(await crypto.restoreFromClientKey('/api/v1', b64(ck))).toEqual({ ok: true });
    const legacy = sodium.crypto_sign_seed_keypair(me.box.privateKey);
    expect(crypto.getSigningPublicKeyHex()).toBe(sodium.to_hex(legacy.publicKey));
  });

  it('with no /me signing key the handed seed is not used', async () => {
    const me = identity();
    const ck = sodium.randombytes_buf(32);
    serveClientKey(me, ck);
    confirm(ME, me, { signing: false });
    expect(await crypto.restoreFromClientKey('/api/v1', b64(ck))).toEqual({ ok: true });
    const legacy = sodium.crypto_sign_seed_keypair(me.box.privateKey);
    expect(crypto.getSigningPublicKeyHex()).toBe(sodium.to_hex(legacy.publicKey));
  });

  it('inside the Android shell it records nothing in the tab', async () => {
    await load({}, 'Mozilla/5.0 (Linux; Android 15) PingolinNativeShell/1.0');
    const me = identity();
    const ck = sodium.randombytes_buf(32);
    serveClientKey(me, ck);
    confirm(ME, me);
    expect(await crypto.restoreFromClientKey('/api/v1', b64(ck))).toEqual({ ok: true });
    crypto.setLocalBlobId('blob');
    expect(session.length).toBe(0);
  });

  it('installs nothing when the tab stopped, or confirmed another account, while the fetch was out', async () => {
    const me = identity();
    const ck = sodium.randombytes_buf(32);
    serveClientKey(me, ck);
    const serve = vi.mocked(fetch).getMockImplementation()!;
    confirm(ME, me);

    // Another confirmation lands while the ciphertext is on its way.
    vi.mocked(fetch).mockImplementationOnce(async (...a) => {
      confirm(OTHER, identity());
      return serve(...a);
    });
    expect(await crypto.restoreFromClientKey('/api/v1', b64(ck))).toEqual({ ok: false, reason: 'error' });
    expect(crypto.isCryptoReady()).toBe(false);
    expect(session.getItem(K.clientKey)).toBeNull();

    // A stop lands while it is on its way.
    confirm(ME, me);
    const account = await import('./account');
    vi.mocked(fetch).mockImplementationOnce(async (...a) => {
      account.reportAccountMismatch();
      return serve(...a);
    });
    expect(await crypto.restoreFromClientKey('/api/v1', b64(ck))).toEqual({ ok: false, reason: 'error' });
    expect(crypto.isCryptoReady()).toBe(false);
  });

  it('opens nothing before an account is confirmed', async () => {
    const ck = sodium.randombytes_buf(32);
    serveClientKey(identity(), ck);
    expect(await crypto.restoreFromClientKey('/api/v1', b64(ck))).toEqual({ ok: false, reason: 'error' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
