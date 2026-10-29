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
 * Private-key operations behind one door.
 *
 * The iOS Note shell loads this page live from the server, so it never
 * writes the account's X25519 sharing private key — which also opens every
 * Track circle-key wrap — or the Ed25519 signing secret into it: it hands
 * over the vault key and the public keys only, and answers private-key
 * operations over a native bridge. These pin both modes: local keys
 * everywhere else, the bridge (and never a private key in the page) in the
 * shell.
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
/** Keys are restored only for the confirmed account's registered keys. */
const confirm = (sharingPub: Uint8Array, signingPub?: Uint8Array) => crypto.expectAccount(
  crypto.accountKeysFrom('aaaaaaaa-0000-4000-8000-0000000000aa', b64(sharingPub), signingPub ? b64(signingPub) : null));
const vaultOf = (priv: Uint8Array) =>
  sodium.crypto_generichash(32, priv, sodium.from_string('pingolin-note-vault'));

let session: Storage;
let postMessage: ReturnType<typeof vi.fn>;
let crypto: typeof import('./crypto');
let keyOps: typeof import('./keyOps');

async function load(bridge: { signing: boolean } | null) {
  session = memoryStorage();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', memoryStorage());
  postMessage = vi.fn();
  vi.stubGlobal('window', bridge
    ? { __pingolinKeyBridge: { version: 1, signing: bridge.signing }, webkit: { messageHandlers: { pingolinKeys: { postMessage } } } }
    : {});
  vi.resetModules();
  crypto = await import('./crypto');
  await crypto.initCrypto();
  keyOps = await import('./keyOps');
}

afterEach(() => vi.unstubAllGlobals());

describe('local-key mode (browser, Android shell): unchanged behaviour', () => {
  beforeEach(() => load(null));

  it('opens a wrap sealed to this session with its own key, and nothing else', async () => {
    const me = sodium.crypto_box_keypair();
    session.setItem('pingolin_note_session_key', b64(vaultOf(me.privateKey)));
    session.setItem('pingolin_note_sharing_priv', b64(me.privateKey));
    session.setItem('pingolin_note_sharing_pub', b64(me.publicKey));
    confirm(me.publicKey);
    expect(crypto.restoreFromSession()).toBe(true);

    const contentKey = sodium.randombytes_buf(32);
    const toMe = b64(sodium.crypto_box_seal(contentKey, me.publicKey));
    const toSomeoneElse = b64(sodium.crypto_box_seal(contentKey, sodium.crypto_box_keypair().publicKey));
    const [opened, refused] = await keyOps.openSealedKeys([toMe, toSomeoneElse]);
    expect(sodium.to_hex(opened!)).toBe(sodium.to_hex(contentKey));
    expect(refused).toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('returns null previous vault keys so the page derives its own', async () => {
    expect(await keyOps.bridgePreviousVaultKeys()).toBeNull();
  });
});

describe('bridge mode (iOS shell): the page never holds a private key', () => {
  it('ignores and removes stale private keys a previous build left in the tab', async () => {
    await load({ signing: true });
    const me = sodium.crypto_box_keypair();
    const sign = sodium.crypto_sign_keypair();
    session.setItem('pingolin_note_session_key', b64(vaultOf(me.privateKey)));
    session.setItem('pingolin_note_sharing_pub', b64(me.publicKey));
    session.setItem('pingolin_note_sign_public', b64(sign.publicKey));
    session.setItem('pingolin_note_sharing_priv', b64(me.privateKey)); // stale
    session.setItem('pingolin_note_sign_secret', b64(sign.privateKey)); // stale

    confirm(me.publicKey, sign.publicKey);
    expect(crypto.restoreFromSession()).toBe(true);
    expect(crypto.getSharingPrivateKey()).toBeNull();
    expect(session.getItem('pingolin_note_sharing_priv')).toBeNull();
    expect(session.getItem('pingolin_note_sign_secret')).toBeNull();
    // Signing is the shell's word, the public half is here, the secret is not.
    expect(crypto.hasSigningKey()).toBe(true);
    expect(() => crypto.signNoteShareWrap({
      senderUserId: '11111111-1111-4111-8111-111111111111',
      recipientUserId: '22222222-2222-4222-8222-222222222222',
      itemId: '33333333-3333-4333-8333-333333333333',
      contentKeyVersion: 1,
      wrappedKeyBase64: b64(new Uint8Array(80)),
    })).toThrow(/No signing keypair/);
    // And a re-persist never writes them back.
    crypto.setVaultKey(vaultOf(me.privateKey));
    expect(session.getItem('pingolin_note_sharing_priv')).toBeNull();
    expect(session.getItem('pingolin_note_sign_secret')).toBeNull();
  });

  it('never installs the X25519-derived signing shortcut', async () => {
    await load({ signing: false });
    const me = sodium.crypto_box_keypair();
    session.setItem('pingolin_note_session_key', b64(vaultOf(me.privateKey)));
    session.setItem('pingolin_note_sharing_pub', b64(me.publicKey));
    confirm(me.publicKey);
    expect(crypto.restoreFromSession()).toBe(true);
    expect(crypto.ensureSigningKey()).toBe(false);
    expect(keyOps.canSign()).toBe(false);
  });

  it('refuses to load keys from a portal hand-off', async () => {
    await load({ signing: true });
    const r = await crypto.restoreFromClientKey('/api/v1', b64(sodium.randombytes_buf(32)));
    expect(r).toEqual({ ok: false, reason: 'error' });
  });

  it('opens wraps over the bridge: one request per wrap, results in order', async () => {
    await load({ signing: true });
    const key = sodium.randombytes_buf(32);
    postMessage.mockImplementation(async (req: { op: string; sealed: string }) => {
      expect(req.op).toBe('openSealedKey');
      if (req.sealed === 'AAAA') return { key: b64(key) };
      if (req.sealed === 'BBBB') return { key: null };
      return { key: b64(new Uint8Array(16)) }; // wrong length: not a content key
    });
    const out = await keyOps.openSealedKeys(['AAAA', 'BBBB', 'CCCC']);
    expect(sodium.to_hex(out[0]!)).toBe(sodium.to_hex(key));
    expect(out[1]).toBeNull();
    expect(out[2]).toBeNull();
  });

  /**
   * One message per wrap, each answered on the shell's main thread: a large
   * inbox takes longer than the minute a sync may be quiet. Whoever waits is
   * told at EVERY answer, not once when all are in.
   */
  it('says so at each answer of the bridge, while the others are still out', async () => {
    await load({ signing: true });
    const answers: ((v: { key: string | null }) => void)[] = [];
    postMessage.mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
    const heard = vi.fn();
    const opening = keyOps.openSealedKeys(['AAAA', 'BBBB', 'CCCC'], heard);
    await Promise.resolve();
    expect(answers).toHaveLength(3);
    expect(heard).not.toHaveBeenCalled();
    answers[1]({ key: null });
    await new Promise(r => setTimeout(r, 0));
    expect(heard).toHaveBeenCalledTimes(1);
    answers[0]({ key: null });
    await new Promise(r => setTimeout(r, 0));
    expect(heard).toHaveBeenCalledTimes(2);
    answers[2]({ key: null });
    expect(await opening).toEqual([null, null, null]);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('a listener that throws does not fail the opening', async () => {
    await load({ signing: true });
    postMessage.mockResolvedValue({ key: null });
    expect(await keyOps.openSealedKeys(['AAAA'], () => { throw new Error('bookkeeping'); })).toEqual([null]);
  });

  it('lets a bridge failure propagate — "try later", not "unreadable"', async () => {
    await load({ signing: true });
    postMessage.mockRejectedValue(new Error('signed out'));
    await expect(keyOps.openSealedKeys(['AAAA'])).rejects.toThrow('signed out');
  });

  it('signs over the bridge with the canonical params, and rejects a malformed reply', async () => {
    await load({ signing: true });
    const params = {
      senderUserId: '11111111-1111-4111-8111-111111111111',
      recipientUserId: '22222222-2222-4222-8222-222222222222',
      itemId: '33333333-3333-4333-8333-333333333333',
      contentKeyVersion: 7,
      wrappedKeyBase64: 'c2VhbGVk',
    };
    postMessage.mockResolvedValueOnce({ signature: 'ab'.repeat(64) });
    expect(await keyOps.signShareWrap(params)).toBe('ab'.repeat(64));
    expect(postMessage).toHaveBeenCalledWith({
      op: 'signShareWrap',
      senderUserId: params.senderUserId,
      recipientUserId: params.recipientUserId,
      itemId: params.itemId,
      contentKeyVersion: 7,
      wrappedKey: 'c2VhbGVk',
    });
    postMessage.mockResolvedValueOnce({ signature: 'not-hex' });
    await expect(keyOps.signShareWrap(params)).rejects.toThrow(/no valid signature/);
  });

  it('takes previous-identity VAULT keys from the shell, and they open old notes', async () => {
    await load({ signing: true });
    const oldIdentity = sodium.crypto_box_keypair();
    const oldVault = vaultOf(oldIdentity.privateKey);
    postMessage.mockResolvedValue({ keys: [b64(oldVault), 'not base64!', b64(new Uint8Array(8))] });
    const keys = await keyOps.bridgePreviousVaultKeys();
    expect(keys!.length).toBe(1);

    const current = sodium.crypto_box_keypair();
    crypto.setVaultKey(vaultOf(current.privateKey));
    crypto.setPreviousVaultKeys(keys as Uint8Array[]);
    const contentKey = sodium.randombytes_buf(32);
    const nonce = sodium.randombytes_buf(24);
    const wrapped = sodium.crypto_secretbox_easy(contentKey, nonce, oldVault);
    const opened = crypto.unwrapContentKeyWithVault(b64(wrapped), b64(nonce));
    expect(sodium.to_hex(opened!)).toBe(sodium.to_hex(contentKey));
  });

  it('a failing previous-identity request is NO ANSWER, never "none" and never a broken session', async () => {
    await load({ signing: true });
    postMessage.mockRejectedValue(new Error('origin not allowed'));
    expect(await keyOps.bridgePreviousVaultKeys()).toBe('no-answer');
  });

  it('an answer with nothing in it is "none"', async () => {
    await load({ signing: true });
    postMessage.mockResolvedValue({ keys: [] });
    expect(await keyOps.bridgePreviousVaultKeys()).toEqual([]);
  });
});

/**
 * Cross-implementation vector for the native signer. note-ios signs over the
 * bridge with the SDK's signNoteShareWrap; its test must produce THIS
 * signature for these inputs, or every share the app signs is dropped by
 * recipients as a forgery. Ed25519 is deterministic, so the value is fixed.
 */
describe('signShareWrap vector (for note-ios)', () => {
  it('is stable for a fixed seed and params', async () => {
    await load(null);
    const seed = new Uint8Array(32).map((_, i) => i + 1);
    crypto.importSigningPrivateKey(b64(seed));
    const sig = crypto.signNoteShareWrap({
      senderUserId: '11111111-1111-4111-8111-111111111111',
      recipientUserId: '22222222-2222-4222-8222-222222222222',
      itemId: '33333333-3333-4333-8333-333333333333',
      contentKeyVersion: 3,
      wrappedKeyBase64: b64(new Uint8Array(80).map((_, i) => i)),
    });
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(sig).toBe(SIGNATURE_VECTOR);
  });
});

const SIGNATURE_VECTOR =
  'c1db352c420039759ab3ec7f8ff39347cfc5e6abdae5e6553585bf92122f80de' +
  'a469e97f5becb94a35e6f3ff8eb50e60952feb54f5f0292edc38de4d0941ba0b';
