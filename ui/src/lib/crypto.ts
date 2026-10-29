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
 * Client-side E2EE crypto for note content.
 *
 * Uses libsodium (XChaCha20-Poly1305).
 * Notes are encrypted/decrypted entirely in the browser.
 * The server never sees plaintext content.
 *
 * Key restoration:
 * 1. Try sessionStorage (survives page refresh)
 * 2. Try server-stored client-key (cross-origin, Proton-style)
 * 3. Otherwise stay LOCKED and send the user to the account portal.
 *
 * There is no step that makes a key. The vault key is always
 * BLAKE2b(sharing private key, "pingolin-note-vault") and every account has a
 * sharing key, so a vault key this tab cannot derive is a key this tab has not
 * been given yet — never one it may invent. Minting a random one whenever the
 * server did not answer would lose every edit made under it with the tab.
 */

// libsodium-wrappers is ~140 kB after gzip — biggest single dep in
// the main chunk. Lazy-load it from initCrypto() so the bundle that
// boots the SPA shell doesn't pay for it; the import resolves before
// any crypto operation runs because every other function in this
// module checks the cached `sodium` reference, which initCrypto seeds.
type Sodium = typeof import('libsodium-wrappers').default;

import { blake3 } from '@noble/hashes/blake3';
import { fromB64Fast as fromB64, toB64Fast as toB64 } from './fastBase64';
import { bridgeMarker } from './keyBridge';
import { accountFetch, canonicalAccountId, clearAllAccountStores, isStopped, tryCanonicalAccountId } from './account';
import { conflictPin, foldPins, isCanonicalPinBlob, type StoredPin } from './pinMerge';
import { scheduleKeep } from './keptTrust';
import { isAndroidShell } from './offlineShell';

export interface EncryptedData {
  nonce: string;      // base64
  ciphertext: string; // base64
}

let sodium: Sodium | null = null;
let vaultKey: Uint8Array | null = null;
// X25519 sharing keypair — needed for NaCl sealed box wrap/unwrap of
// per-note content keys shared with us by other users. Held in memory
// for the duration of the session (and sessionStorage for page refreshes).
let sharingPrivateKey: Uint8Array | null = null;
let sharingPublicKey: Uint8Array | null = null;
// Ed25519 signing keypair, for signing share invites and rotate rewraps.
// Loaded from the auth /me response (encrypted_signing_private_key blob).
// The libsodium sign secret key is 64 bytes (seed || pubkey).
let signingSecretKey: Uint8Array | null = null;
let signingPublicKeyBytes: Uint8Array | null = null;

const SESSION_KEY = 'pingolin_note_session_key';
const SESSION_SHARING_PRIV = 'pingolin_note_sharing_priv';
const SESSION_SHARING_PUB = 'pingolin_note_sharing_pub';
const SESSION_SIGN_SECRET = 'pingolin_note_sign_secret';
const SESSION_SIGN_PUBLIC = 'pingolin_note_sign_public';
// The wrapping key ("client key"). The server must NEVER hold it: storing it
// next to the ciphertext it decrypts would be an escrow the server could
// exploit, which is the whole point of the design. It reaches this origin via
// the redirect fragment and is persisted here in localStorage only for
// same-origin restores (new tabs, where sessionStorage is empty).
const STORAGE_KEY_CLIENTKEY = 'pingolin_note_client_key';
// The opaque id of the server-side blob the wrapping key above opens.
// Stored beside it because it is only meaningful with it. Each browser
// has its own blob: with one shared blob per user, a login in any browser
// would strand all the others.
const STORAGE_KEY_BLOBID = 'pingolin_note_client_blob';
// The canonical id of the account every tab-kept secret above belongs to.
// Written before any of them, removed with them. A tab's keys are used
// only for that account, and only when their public keys are the ones
// /auth/me registers for it: a tab left open under account A after B signed
// in elsewhere must never hand A's keys to B's session.
const SESSION_ACCOUNT = 'pingolin_note_tab_account';
// TOFU pin store keyed by user_id, persisted DURABLY as plaintext JSON in
// localStorage. Pins are PUBLIC keys — there is nothing to hide, and encrypting
// them defeats them: under a per-tab sessionStorage key a fresh tab cannot
// decrypt the store, so it silently forgets every pin and re-TOFUs whatever key
// the server advertises. Plaintext localStorage is shared across tabs
// and survives reloads, so pins actually persist.
const PIN_STORAGE_KEY = 'pingolin_note_pinned_keys';
// Keys left by an earlier encrypted-at-rest pin scheme — swept on logout so
// stale ciphertext (and the dead per-tab key) don't linger.
const PIN_STORAGE_LEGACY_BLOB_KEY = 'pingolin_note_pinned_keys_blob';
const PIN_STORAGE_LEGACY_NONCE_KEY = 'pingolin_note_pinned_keys_nonce';
const PIN_STORAGE_LEGACY_CLIENT_KEY = 'pingolin_note_pin_client_key';

// Wire-format domain for share-invite wraps. The "pingolin.sig.v1.*" naming is
// shared across products so key-management tooling can scan for one prefix.
// Note's wrap is sealed_box (not crypto_box_easy), so the canonical input
// *contents* are Note-specific even though the primitives are shared.
const DOMAIN_NOTE_SHARE_INVITE = 'pingolin.sig.v1.note_share_invite';

export async function initCrypto(): Promise<void> {
  if (sodium) return;
  const mod = await import('libsodium-wrappers');
  await mod.default.ready;
  sodium = mod.default;
}

export function isCryptoReady(): boolean {
  return sodium !== null && vaultKey !== null;
}

/** Set the active vault key (loaded from storage or derived from password) */
export function setVaultKey(key: Uint8Array): void {
  vaultKey = key;
  persistToSessionStorage();
}

/** The vault key an account's sharing private key implies. */
function vaultKeyFor(sharingPriv: Uint8Array): Uint8Array {
  if (!sodium) throw new Error('Crypto not initialized');
  return sodium.crypto_generichash(32, sharingPriv, sodium.from_string('pingolin-note-vault'));
}

/**
 * Is a vault key found in sessionStorage one this account can actually own?
 *
 *  - With the sharing PRIVATE key beside it (a browser unlock, the Android
 *    shell's handoff) the vault key must be exactly the one that key derives.
 *  - With only the sharing PUBLIC key (the iOS shell, which keeps the private
 *    key native and answers private-key operations over a bridge) there is
 *    nothing to derive from, so it is taken on the shell's word.
 *  - With neither, nothing legitimate could have produced it: a vault key
 *    stored alone can only be a RANDOM one, which dies with the tab while a
 *    reload would keep writing notes under it. Refusing it sends the tab back
 *    through federation, which recovers the real key.
 */
export type SessionVaultVerdict = 'derived' | 'shell-supplied' | 'mismatch' | 'unverifiable';

export function judgeSessionVault(
  vault: Uint8Array,
  sharingPriv: Uint8Array | null,
  sharingPub: Uint8Array | null,
): SessionVaultVerdict {
  if (!sodium) throw new Error('Crypto not initialized');
  if (sharingPriv) {
    const derived = vaultKeyFor(sharingPriv);
    const ok = derived.length === vault.length && sodium.memcmp(derived, vault);
    try { sodium.memzero(derived); } catch { derived.fill(0); }
    return ok ? 'derived' : 'mismatch';
  }
  return sharingPub ? 'shell-supplied' : 'unverifiable';
}

/** /auth/me's account: its canonical id and the public keys it registers. */
export interface AccountKeys {
  id: string;
  sharingPub: Uint8Array | null;
  signingPub: Uint8Array | null;
}

let expected: AccountKeys | null = null;

/**
 * The account this tab's state must belong to, once /auth/me (or the offline
 * resume) names it. Until then nothing is restored and nothing is persisted:
 * a secret is never written without the account it belongs to.
 */
export function expectAccount(acct: AccountKeys | null): void {
  expected = acct;
}

export function expectedAccount(): AccountKeys | null {
  return expected;
}

/** The account /auth/me describes: a canonical id plus its public keys as
 *  served (standard base64; anything that is not a 32-byte key reads as none). */
export function accountKeysFrom(id: string, sharingB64?: string | null, signingB64?: string | null): AccountKeys {
  const dec = (b?: string | null): Uint8Array | null => {
    if (!sodium || !b) return null;
    try {
      const v = sodium.from_base64(b, sodium.base64_variants.ORIGINAL);
      return v.length === 32 ? v : null;
    } catch {
      return null;
    }
  };
  return { id, sharingPub: dec(sharingB64), signingPub: dec(signingB64) };
}

/** Same account, same registered keys? (The open-tab re-check.) */
export function sameAccountKeys(a: AccountKeys | null, b: AccountKeys | null): boolean {
  if (!a || !b || a.id !== b.id) return false;
  const eq = (x: Uint8Array | null, y: Uint8Array | null) => (x === null && y === null) || sameKey(x, y);
  return eq(a.sharingPub, b.sharingPub) && eq(a.signingPub, b.signingPub);
}

/** Inside a native shell the page never writes tab keys: the app's hand-off
 *  at document start is their only writer. */
function inNativeShell(): boolean {
  return bridgeMarker() !== null || isAndroidShell();
}

/** Constant-time equality of two keys; false when either is missing. */
function sameKey(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!sodium || !a || !b || a.length !== b.length) return false;
  return sodium.memcmp(a, b);
}

/** What a tab holds, as read back from sessionStorage. */
export interface TabKeys {
  account: string | null;
  vault: Uint8Array | null;
  sharingPriv: Uint8Array | null;
  sharingPub: Uint8Array | null;
  signSecret: Uint8Array | null;
  signPub: Uint8Array | null;
}

/**
 * May these tab keys be used for this account?
 *
 *  - A recorded account must be this one (canonical ids).
 *  - The account must register a sharing key, and the tab's must equal it:
 *    DERIVED from the private key when the tab has one (and the vault key must
 *    be the one that key derives), or, in the iOS key-bridge shell only (its
 *    marker set), the public key the shell handed over.
 *  - When the account registers a signing key and the tab holds one, they are
 *    the same key.
 *  - Nothing recorded (a copy saved by an older build, or a native shell's
 *    hand-off, which carries no id) is used only on that proof by the keys.
 *
 * Anything else is refused, and the caller wipes before anything runs.
 */
export function tabKeysBelongTo(tab: TabKeys, acct: AccountKeys, bridged: boolean): boolean {
  if (!sodium) return false;
  if (tab.account !== null && tryCanonicalAccountId(tab.account) !== acct.id) return false;
  // (An account that registers no sharing key matches nothing: sameKey is
  // false when either side is missing.)
  if (tab.sharingPriv) {
    const pub = sodium.crypto_scalarmult_base(tab.sharingPriv);
    const ok = sameKey(pub, acct.sharingPub);
    try { sodium.memzero(pub); } catch { pub.fill(0); }
    if (!ok) return false;
    if (tab.vault && judgeSessionVault(tab.vault, tab.sharingPriv, null) !== 'derived') return false;
  } else {
    if (!bridged) return false;
    if (!sameKey(tab.sharingPub, acct.sharingPub)) return false;
  }
  if (acct.signingPub) {
    let tabSigningPub: Uint8Array | null = null;
    if (tab.signSecret) tabSigningPub = normalizeSigningSecret(tab.signSecret)?.pub ?? null;
    else if (tab.signPub) tabSigningPub = tab.signPub;
    if ((tab.signSecret || tab.signPub) && !sameKey(tabSigningPub, acct.signingPub)) return false;
  }
  return true;
}

/**
 * Wipe everything this tab holds for an account — sessionStorage and memory —
 * because it is not, or may not be, the signed-in account's. Pins in memory go
 * too (their durable blob is namespaced and stays).
 */
export function wipeTabState(): void {
  if (sodium) {
    if (vaultKey) { try { sodium.memzero(vaultKey); } catch { vaultKey.fill(0); } }
    if (sharingPrivateKey) { try { sodium.memzero(sharingPrivateKey); } catch { sharingPrivateKey.fill(0); } }
    if (signingSecretKey) { try { sodium.memzero(signingSecretKey); } catch { signingSecretKey.fill(0); } }
  }
  vaultKey = null;
  sharingPrivateKey = null;
  sharingPublicKey = null;
  signingSecretKey = null;
  signingPublicKeyBytes = null;
  pinnedKeys.clear();
  pinsLoaded = false;
  forgetSessionKeys();
  try {
    sessionStorage.removeItem(STORAGE_KEY_CLIENTKEY);
    sessionStorage.removeItem(STORAGE_KEY_BLOBID);
    sessionStorage.removeItem(SESSION_ACCOUNT);
  } catch { /* storage unavailable — nothing persisted to forget */ }
}

/** Drop every key sessionStorage holds for this tab — used when what it holds
 *  cannot be trusted, so the next rung starts clean instead of re-reading it. */
function forgetSessionKeys(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_SHARING_PRIV);
    sessionStorage.removeItem(SESSION_SHARING_PUB);
    sessionStorage.removeItem(SESSION_SIGN_SECRET);
    sessionStorage.removeItem(SESSION_SIGN_PUBLIC);
  } catch { /* storage unavailable — nothing persisted to forget */ }
}

/**
 * Try to restore the keys this tab kept (a page refresh, or a native shell's
 * hand-off), for the account /auth/me confirmed (`expectAccount`). Keys that
 * are not that account's — `tabKeysBelongTo` — are wiped, with everything else
 * the tab held, before anything runs; the caller goes on down its rungs.
 * With no confirmed account nothing is restored.
 */
export function restoreFromSession(): boolean {
  if (!sodium) return false;
  const acct = expected;
  if (!acct) return false;
  try {
    // In the iOS key-bridge shell the private halves live natively and are
    // never read from storage, even when a stale value sits there from an
    // older build.
    const bridged = bridgeMarker() !== null;
    if (bridged) {
      sessionStorage.removeItem(SESSION_SHARING_PRIV);
      sessionStorage.removeItem(SESSION_SIGN_SECRET);
    }
    const read = (k: string) => {
      const v = sessionStorage.getItem(k);
      return v ? sodium!.from_base64(v, sodium!.base64_variants.ORIGINAL) : null;
    };
    const tab: TabKeys = {
      account: sessionStorage.getItem(SESSION_ACCOUNT),
      vault: read(SESSION_KEY),
      sharingPriv: bridged ? null : read(SESSION_SHARING_PRIV),
      sharingPub: read(SESSION_SHARING_PUB),
      signSecret: bridged ? null : read(SESSION_SIGN_SECRET),
      signPub: read(SESSION_SIGN_PUBLIC),
    };
    const zero = (b: Uint8Array | null) => { if (b) { try { sodium!.memzero(b); } catch { b.fill(0); } } };
    if (!tab.vault && !tab.sharingPriv && !tab.sharingPub && !tab.signSecret && !tab.signPub) {
      // Nothing kept. A lone account mark belongs to nothing any more.
      if (tab.account !== null) sessionStorage.removeItem(SESSION_ACCOUNT);
      return false;
    }
    if (!tab.vault || !tabKeysBelongTo(tab, acct, bridged)) {
      console.warn('[note/crypto] this tab\'s keys are not the signed-in account\'s — wiped, re-federating');
      zero(tab.vault); zero(tab.sharingPriv); zero(tab.signSecret);
      wipeTabState();
      return false;
    }
    vaultKey = tab.vault;
    if (tab.sharingPriv) {
      sharingPrivateKey = tab.sharingPriv;
      // Derived, not read: sealed-box open needs the exact public half of THIS
      // private key.
      sharingPublicKey = sodium.crypto_scalarmult_base(tab.sharingPriv);
    } else {
      // The iOS shell keeps the private half native and answers for it over a
      // bridge (lib/keyOps.ts). Drop any private key an earlier handoff left
      // in memory, so nothing opens or signs with an identity the shell no
      // longer vouches for.
      if (sharingPrivateKey) {
        try { sodium.memzero(sharingPrivateKey); } catch { sharingPrivateKey.fill(0); }
      }
      sharingPrivateKey = null;
      sharingPublicKey = tab.sharingPub;
    }
    if (tab.signSecret && acct.signingPub) {
      // Normalize here too: a raw assignment would let a malformed
      // 96-byte handoff sit in memory until crypto_sign_detached
      // threw mid-share. (tabKeysBelongTo matched its public half
      // to the registered key.)
      const norm = normalizeSigningSecret(tab.signSecret);
      if (norm) {
        signingSecretKey = norm.secret;
        signingPublicKeyBytes = norm.pub;
      }
    } else if (tab.signSecret) {
      // The account registers no signing key, so nothing can check this
      // secret, and a partial hand-off can leave the previous account's
      // behind. Dropped; the legacy key is installed below.
      sessionStorage.removeItem(SESSION_SIGN_SECRET);
      if (signingSecretKey) {
        try { sodium.memzero(signingSecretKey); } catch { signingSecretKey.fill(0); }
      }
      signingSecretKey = null;
      signingPublicKeyBytes = null;
    } else if (tab.signPub && !tab.sharingPriv) {
      // Same shell, same rule for the signing half: public key only, the
      // secret stays native.
      if (signingSecretKey) {
        try { sodium.memzero(signingSecretKey); } catch { signingSecretKey.fill(0); }
      }
      signingSecretKey = null;
      signingPublicKeyBytes = acct.signingPub ? tab.signPub : null;
    }
    // A signing public key only where the account registers that key
    // (tabKeysBelongTo compared them); an unchecked one is not used.
    if (tab.signPub && !signingPublicKeyBytes && acct.signingPub) {
      signingPublicKeyBytes = tab.signPub;
    }
    zero(tab.signSecret);
    // A set with no account recorded (saved by an older build, or a
    // native shell's hand-off) proved itself above; from here on it is
    // bound.
    if (tab.account === null && !inNativeShell()) {
      sessionStorage.setItem(SESSION_ACCOUNT, acct.id);
    }
    // No persisted signing key but we do have the sharing key →
    // install the X25519-seeded shortcut. See installSigningKeyFromSharingKey.
    // Never in bridge mode: there is no private key to derive from, and the
    // shortcut signs with the wrong identity.
    if (!bridged && !signingSecretKey && sharingPrivateKey) {
      installSigningKeyFromSharingKey();
    }
    return vaultKey !== null;
  } catch {
    // sessionStorage not available (e.g., incognito)
  }
  return false;
}

/**
 * Restore the vault key by decrypting the server-stored ciphertext with a
 * wrapping key supplied by the CALLER — the redirect fragment (cross-origin) or
 * localStorage (same-origin). Enables cross-origin key restoration (e.g., login
 * on the account portal, then navigate to the note app on a different subdomain).
 *
 * Flow (Proton "session fork" model):
 * 1. Fetch the encrypted_private_key ciphertext from GET /api/v1/auth/client-key
 *    (the server stores ONLY opaque bytes and stays blind).
 * 2. Use the supplied wrapping key to decrypt it (NaCl secretbox).
 * 3. Derive a note-specific vault key from the private key via BLAKE2b.
 *
 * The wrapping key is NEVER read from the server response — the server does
 * not store it. On success the wrapping key is persisted to localStorage
 * so a same-origin new tab can restore without a fresh fragment.
 */
export type RestoreFailure = 'no-ciphertext' | 'bad-key' | 'error';
export type RestoreResult = { ok: true } | { ok: false; reason: RestoreFailure };

export async function restoreFromClientKey(
  apiBaseUrl: string,
  wrappingKeyB64: string,
  blobId?: string | null,
): Promise<RestoreResult> {
  if (!sodium) return { ok: false, reason: 'error' };
  if (!wrappingKeyB64) return { ok: false, reason: 'error' };
  // Keys are opened only for a confirmed account, and checked against it
  // before anything is installed.
  const acct = expected;
  if (!acct) return { ok: false, reason: 'error' };
  // The iOS key-bridge shell owns the private keys; loading them into the page
  // from the server ciphertext would undo the point of the bridge.
  if (bridgeMarker() !== null) return { ok: false, reason: 'error' };

  try {
    // 1. Fetch the ciphertext from the auth service (client_key is NOT read).
    // Name the blob THIS key opens: without the id the server can only return
    // the shared legacy ciphertext, which after a login in any other browser
    // is sealed under a different key and will not decrypt. Omitted when we
    // have no id (a portal that handed over none) — the legacy answer still
    // works.
    const blobQuery = blobId ? `?blob_id=${encodeURIComponent(blobId)}` : '';
    const resp = await accountFetch(`${apiBaseUrl}/auth/client-key${blobQuery}`, {
      credentials: 'include',
    });
    if (!resp.ok) return { ok: false, reason: 'error' };

    const data = await resp.json();
    // Nothing is installed for an account this tab no longer acts as: a stop, or
    // another confirmation, while the fetch was out.
    if (isStopped() || expected !== acct) return { ok: false, reason: 'error' };
    const encPrivKeyB64 = data?.data?.encrypted_private_key;
    const nonceB64 = data?.data?.encrypted_private_key_nonce;

    if (!encPrivKeyB64 || !nonceB64) {
      console.warn('Client-key response missing ciphertext fields');
      return { ok: false, reason: 'no-ciphertext' };
    }

    // 2. Decrypt private key using the caller-supplied wrapping key (NaCl secretbox)
    const clientKey = sodium.from_base64(wrappingKeyB64, sodium.base64_variants.ORIGINAL);
    const ciphertext = sodium.from_base64(encPrivKeyB64, sodium.base64_variants.ORIGINAL);
    const nonce = sodium.from_base64(nonceB64, sodium.base64_variants.ORIGINAL);

    let privateKeyBytes: Uint8Array;
    try {
      privateKeyBytes = sodium.crypto_secretbox_open_easy(ciphertext, nonce, clientKey);
    } catch (e) {
      console.error('Failed to decrypt private key with wrapping key:', e);
      return { ok: false, reason: 'bad-key' };
    }
    if (!privateKeyBytes || privateKeyBytes.length !== 32) {
      console.error('Failed to decrypt private key with wrapping key');
      return { ok: false, reason: 'bad-key' };
    }
    // The key must be this account's: its public half is the sharing key
    // /auth/me registers. Another account's key is treated like a wrong
    // wrapping key — the caller invalidates it and stays locked.
    {
      const pub = sodium.crypto_scalarmult_base(privateKeyBytes);
      const mine = sameKey(pub, acct.sharingPub);
      try { sodium.memzero(pub); } catch { pub.fill(0); }
      if (!mine) {
        try { sodium.memzero(privateKeyBytes); } catch { privateKeyBytes.fill(0); }
        console.warn('[note/crypto] the handed-over key is not the signed-in account\'s');
        return { ok: false, reason: 'bad-key' };
      }
    }

    // 3. Derive a note-specific vault key from the private key using BLAKE2b
    // This gives each app (track, note) a different key from the same master material
    vaultKey = sodium.crypto_generichash(32, privateKeyBytes, sodium.from_string('pingolin-note-vault'));

    // Keep the X25519 sharing keypair loaded so we can unwrap content
    // keys shared TO us (NaCl sealed box decryption). The public key is
    // derived from the private scalar via scalarmult_base.
    sharingPrivateKey = new Uint8Array(privateKeyBytes);
    sharingPublicKey = sodium.crypto_scalarmult_base(sharingPrivateKey);

    // Prefer the REAL Ed25519 signing seed when the server exposes it under the
    // client_key (the account portal seals it there at login). That makes our
    // share-wrap signatures verify against the directory's signing_public_key,
    // so recipients accept our shares. Fall back to the X25519 shortcut for an
    // account whose client_key carries no sealed signing seed.
    const encSigningB64 = data?.data?.encrypted_signing_private_key;
    const signingNonceB64 = data?.data?.encrypted_signing_private_key_nonce;
    let realSigningLoaded = false;
    if (encSigningB64 && signingNonceB64) {
      try {
        const signCipher = sodium.from_base64(encSigningB64, sodium.base64_variants.ORIGINAL);
        const signNonce = sodium.from_base64(signingNonceB64, sodium.base64_variants.ORIGINAL);
        const plain = sodium.crypto_secretbox_open_easy(signCipher, signNonce, clientKey);
        // The portal seals the 32-byte seed; older blobs hold the full
        // 64-byte libsodium signing secret (seed||verifying-key) —
        // accept both, the seed is the first half.
        if (plain && (plain.length === 32 || plain.length === 64)) {
          const seed = plain.length === 64 ? plain.subarray(0, 32) : plain;
          const kp = sodium.crypto_sign_seed_keypair(seed);
          // Used only when it is the account's registered signing key. With
          // none registered nothing can check it: the legacy key below.
          const registered = sameKey(kp.publicKey, acct.signingPub);
          try { sodium.memzero(kp.privateKey); } catch { kp.privateKey.fill(0); }
          if (registered) {
            importSigningPrivateKey(sodium.to_base64(seed, sodium.base64_variants.ORIGINAL));
            realSigningLoaded = true;
          } else {
            console.warn('[note/crypto] the handed-over signing key is not the account\'s registered one; not used');
          }
        }
        // importSigningPrivateKey wipes its own decoded copy; wipe ours too
        // (subarray above is a view into plain, so this covers the seed).
        if (plain) {
          try { sodium.memzero(plain); } catch { plain.fill(0); }
        }
      } catch (e) {
        console.warn('[note/crypto] real signing seed decrypt failed; using shortcut', e);
      }
    }
    if (!realSigningLoaded) {
      installSigningKeyFromSharingKey();
    }

    // Persist the wrapping key locally so a same-origin new tab (empty
    // sessionStorage, no fresh fragment) can restore without the server holding
    // the key. clearKeys() wipes it on logout.
    setLocalClientKey(wrappingKeyB64);

    // Persist to sessionStorage for page refreshes
    persistToSessionStorage();

    console.log('Vault key restored from client-key ciphertext (wrapping key from fragment/localStorage)');
    return { ok: true };
  } catch (e) {
    console.error('Failed to restore vault key from client-key:', e);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Read the locally-persisted wrapping key. A same-origin RELOAD uses
 * this (with the server ciphertext) to restore without the server holding the
 * key. Kept in sessionStorage (tab-scoped) — a brand-new tab has none and
 * silently re-federates via requestKeyViaIframe, so the key never persists
 * across tab-close where an XSS could later exfiltrate it. Returns null when
 * none has been stored yet (or a legacy localStorage value, swept on next clear).
 */
export function getLocalClientKey(): string | null {
  try {
    const key = sessionStorage.getItem(STORAGE_KEY_CLIENTKEY);
    if (!key) return null;
    // Only for the account it was stored for; another account's is wiped
    // with everything else the tab held for it.
    if (!expected || tryCanonicalAccountId(sessionStorage.getItem(SESSION_ACCOUNT)) !== expected.id) {
      wipeTabState();
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

/** The blob id stored alongside the local wrapping key, or null when none is
 * stored.
 */
export function getLocalBlobId(): string | null {
  try {
    if (!expected || tryCanonicalAccountId(sessionStorage.getItem(SESSION_ACCOUNT)) !== expected.id) return null;
    return sessionStorage.getItem(STORAGE_KEY_BLOBID);
  } catch {
    return null;
  }
}

/** Remember which blob the locally-stored wrapping key opens. */
export function setLocalBlobId(blobId: string | null): void {
  try {
    if (!blobId) { sessionStorage.removeItem(STORAGE_KEY_BLOBID); return; }
    // As persistToSessionStorage: never without the account, never in a shell.
    if (!expected || inNativeShell()) return;
    sessionStorage.setItem(SESSION_ACCOUNT, expected.id);
    sessionStorage.setItem(STORAGE_KEY_BLOBID, blobId);
  } catch { /* storage unavailable — falls back to the legacy request */ }
}

/** Persist the wrapping key locally (never to the server), tab-scoped. */
function setLocalClientKey(clientKeyB64: string): void {
  // As persistToSessionStorage: never without the account, never in a shell.
  if (!expected || inNativeShell()) return;
  try {
    sessionStorage.setItem(SESSION_ACCOUNT, expected.id);
    sessionStorage.setItem(STORAGE_KEY_CLIENTKEY, clientKeyB64);
  } catch {
    /* sessionStorage unavailable (e.g. incognito) — same-origin new-tab restore
       will just fall back to iframe federation / a fresh portal login */
  }
}

/**
 * What the server says about this account's private-key ciphertext, asked when
 * no wrapping key is available locally (no fragment, no sessionStorage).
 *
 *  - `present`: a ciphertext exists. The account has keys this tab has not
 *    unlocked yet — federate them from the account portal.
 *  - `absent`: the server answered, authoritatively, that it holds none. That
 *    is NOT a new account: every account has a sharing key, and one that has
 *    only ever signed in on a phone simply never wrote this row. A portal
 *    sign-in seals one.
 *  - `unknown`: no trustworthy answer — offline, a 5xx, a 429, a WAF page, a
 *    body that is not the auth service's JSON.
 *
 * None of the three is a reason to make a key. A boolean answering `false`
 * for every failure as well as for `absent`, with `false` minting a random
 * vault key, would let an auth-server blip on a cold start put the tab on a
 * throwaway key; editing a note shown from the offline cache would then
 * re-wrap it under that key and replace the stored wrap — unreadable on
 * every device once the tab closed. Callers stay locked on all three and
 * use the answer only to decide what to try next and what to tell the user.
 */
export type StoredKeyProbe = 'present' | 'absent' | 'unknown';

export async function probeStoredKey(apiBaseUrl: string): Promise<StoredKeyProbe> {
  let resp: Response;
  try {
    resp = await accountFetch(`${apiBaseUrl}/auth/client-key`, { credentials: 'include' });
  } catch {
    return 'unknown';
  }
  if (!resp.ok) return 'unknown';
  try {
    const body = await resp.json();
    // Only the auth service's own envelope is an answer. Anything else that
    // parsed — a proxy's JSON error page, a captive portal — is not.
    if (body?.success !== true || !body.data || typeof body.data !== 'object') return 'unknown';
    return body.data.encrypted_private_key ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

/** Persist vault key to sessionStorage for page refresh survival */
function persistToSessionStorage(): void {
  if (!sodium || !vaultKey) return;
  // Never a secret without the account it belongs to; and inside a native
  // shell the app's hand-off is the only writer (it rewrites these at every
  // document start).
  if (!expected || inNativeShell()) return;
  const bridged = bridgeMarker() !== null;
  try {
    sessionStorage.setItem(SESSION_ACCOUNT, expected.id);
    sessionStorage.setItem(SESSION_KEY, sodium.to_base64(vaultKey, sodium.base64_variants.ORIGINAL));
    if (sharingPrivateKey && !bridged) {
      sessionStorage.setItem(SESSION_SHARING_PRIV, sodium.to_base64(sharingPrivateKey, sodium.base64_variants.ORIGINAL));
    }
    if (sharingPublicKey) {
      sessionStorage.setItem(SESSION_SHARING_PUB, sodium.to_base64(sharingPublicKey, sodium.base64_variants.ORIGINAL));
    }
    if (signingSecretKey && !bridged) {
      sessionStorage.setItem(SESSION_SIGN_SECRET, sodium.to_base64(signingSecretKey, sodium.base64_variants.ORIGINAL));
    }
    if (signingPublicKeyBytes) {
      sessionStorage.setItem(SESSION_SIGN_PUBLIC, sodium.to_base64(signingPublicKeyBytes, sodium.base64_variants.ORIGINAL));
    }
  } catch {
    // sessionStorage not available
  }
}

/**
 * Wrap a content key for a specific recipient using their X25519 public
 * key. NaCl sealed box: anonymous sender, only the holder of the matching
 * private key can open. Used when sharing a note with someone — the
 * recipient's public key comes from the auth `/public-keys` lookup.
 */
export function wrapContentKeyForRecipient(
  contentKey: Uint8Array,
  recipientPublicKeyB64: string,
): string | null {
  if (!sodium) return null;
  try {
    const pk = sodium.from_base64(recipientPublicKeyB64, sodium.base64_variants.ORIGINAL);
    if (pk.length !== 32) {
      // Accept hex-encoded keys too — the auth service encodes with hex.
      const hex = recipientPublicKeyB64;
      const match = /^[0-9a-fA-F]+$/.test(hex) && hex.length === 64;
      if (!match) return null;
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      const sealed = sodium.crypto_box_seal(contentKey, bytes);
      return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
    }
    const sealed = sodium.crypto_box_seal(contentKey, pk);
    return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
  } catch {
    return null;
  }
}

/**
 * Unwrap a sealed-box content key addressed to us. The wrapper used our
 * public key; we decrypt with our X25519 keypair.
 */
export function unwrapContentKeyFromSender(wrappedB64: string): Uint8Array | null {
  if (!sodium || !sharingPrivateKey || !sharingPublicKey) return null;
  try {
    const sealed = sodium.from_base64(wrappedB64, sodium.base64_variants.ORIGINAL);
    const key = sodium.crypto_box_seal_open(sealed, sharingPublicKey, sharingPrivateKey);
    return key && key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** Returns our X25519 sharing public key (hex) if loaded. Used when
 *  sharing: sharer sends their own public key alongside the wrapped
 *  content key so the recipient can verify / trace provenance. */
export function getSharingPublicKeyHex(): string | null {
  if (!sodium || !sharingPublicKey) return null;
  let hex = '';
  for (const b of sharingPublicKey) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Clear all in-memory keys. Called on logout. */
export function clearKeys(): void {
  if (sodium) {
    if (vaultKey) sodium.memzero(vaultKey);
    if (sharingPrivateKey) sodium.memzero(sharingPrivateKey);
    if (signingSecretKey) sodium.memzero(signingSecretKey);
  }
  vaultKey = null;
  sharingPrivateKey = null;
  sharingPublicKey = null;
  signingSecretKey = null;
  signingPublicKeyBytes = null;
  expected = null;
  // Drop the in-memory pin map too, so a subsequent login in this tab starts
  // from the persisted store (or empty) rather than another session's pins.
  pinnedKeys.clear();
  pinsLoaded = false;
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_SHARING_PRIV);
    sessionStorage.removeItem(SESSION_SHARING_PUB);
    sessionStorage.removeItem(SESSION_SIGN_SECRET);
    sessionStorage.removeItem(SESSION_SIGN_PUBLIC);
    // KEEP this user's namespaced pin blob; reset the namespace and sweep only
    // the base key (the pre-login fallback, which belongs to nobody). Pins are
    // public keys, namespaced by user id, so keeping them costs nothing a
    // logout protects — and deleting them would re-open first contact for
    // every sender at the next sign-in: a server that substituted a sharer's
    // key right after a re-login would simply be TOFU-pinned, and a signature
    // stripped from a sender this browser had verified would read as a first
    // share. Both native Note apps keep their pins the same way.
    pinStorageUserId = null;
    localStorage.removeItem(PIN_STORAGE_KEY);
    // Sweep the legacy encrypted-at-rest pin store (older builds).
    sessionStorage.removeItem(PIN_STORAGE_LEGACY_CLIENT_KEY);
    localStorage.removeItem(PIN_STORAGE_LEGACY_BLOB_KEY);
    localStorage.removeItem(PIN_STORAGE_LEGACY_NONCE_KEY);
    // Drop the persisted wrapping key too. It lives in sessionStorage; the
    // localStorage sweep clears any value an older build left behind, which
    // would otherwise outlive this logout.
    sessionStorage.removeItem(STORAGE_KEY_CLIENTKEY);
    localStorage.removeItem(STORAGE_KEY_CLIENTKEY);
    sessionStorage.removeItem(STORAGE_KEY_BLOBID);
    sessionStorage.removeItem(SESSION_ACCOUNT);
    // Sweep the remaining app-data localStorage keys so a same-device
    // account switch never leaves the prior user's data behind. The primary leak
    // is the notebook/label/share metadata cache (`pingolin_note_metadata`, which
    // holds DECRYPTED note metadata); also the shared-inbox cursors, the
    // settings blob, the push-endpoint idempotency marker, the retired content
    // keys (each vault-wrapped, swept anyway) and the locked-note ids. Every
    // account's copy goes, and the older builds' single copy (ACCOUNT_SCOPED_STORES).
    clearAllAccountStores();
    localStorage.removeItem('pingolin_note_settings');
    // The last-authenticated user id (stores/auth.ts OWNER_KEY). Swept
    // here so a logout/wipe forces the next login to be treated as first-login
    // (no stale owner id → the cross-account mismatch wipe stays correct).
    localStorage.removeItem('pingolin_note_owner');
    // The last server-confirmed session (stores/auth.ts SESSION_KEY_NAME), which
    // exists so a boot with no reachable server can resume rather than redirect
    // to an unreachable portal. It MUST die with the session: leaving it behind
    // would let a logged-out or wiped browser resume offline as the prior user.
    localStorage.removeItem('pingolin_note_session');
  } catch {
    // ignore
  }
}

// ============================================================================
// Per-note content keys
// ============================================================================
//
// Each note gets a random 32-byte content key. The note's content is
// encrypted under it, and the content key itself is wrapped with the
// owner's vault key (for cross-device owner decryption) and sealed to each
// recipient's X25519 public key, so shares are E2EE end-to-end.
//
// Legacy notes (from before per-note content keys) have no
// wrapped_content_key; they keep decrypting directly under the vault key.
// Migration is lazy: the first save of such a note populates its
// wrapped_content_key.

/** Generate a random 256-bit content key. */
export function generateContentKey(): Uint8Array {
  if (!sodium) throw new Error('Crypto not ready');
  return sodium.randombytes_buf(32);
}

/** Wrap a content key with the vault key via NaCl secretbox. */
export function wrapContentKeyWithVault(contentKey: Uint8Array): { wrappedKey: string; nonce: string } {
  if (!sodium || !vaultKey) throw new Error('Crypto not ready');
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const wrapped = sodium.crypto_secretbox_easy(contentKey, nonce, vaultKey);
  return {
    wrappedKey: sodium.to_base64(wrapped, sodium.base64_variants.ORIGINAL),
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
  };
}

/** Unwrap a vault-wrapped content key. Returns null on auth failure. */
export function unwrapContentKeyWithVault(wrappedKeyB64: string, nonceB64: string): Uint8Array | null {
  if (!sodium || !vaultKey) return null;
  try {
    const wrapped = sodium.from_base64(wrappedKeyB64, sodium.base64_variants.ORIGINAL);
    const nonce = sodium.from_base64(nonceB64, sodium.base64_variants.ORIGINAL);
    const key = sodium.crypto_secretbox_open_easy(wrapped, nonce, vaultKey);
    if (key && key.length === 32) return key;
  } catch {
    // Fall through: a note from before a password reset is wrapped under a
    // vault key derived from the OLD identity, and failing here is exactly how
    // an account full of unreadable notes looks.
  }

  // Current key first, always. Preferring a recovered one would keep the app
  // reading through a superseded identity long after the user moved off it.
  for (const previous of previousVaultKeys) {
    try {
      const wrapped = sodium.from_base64(wrappedKeyB64, sodium.base64_variants.ORIGINAL);
      const nonce = sodium.from_base64(nonceB64, sodium.base64_variants.ORIGINAL);
      const key = sodium.crypto_secretbox_open_easy(wrapped, nonce, previous);
      if (key && key.length === 32) return key;
    } catch {
      // Not this one either.
    }
  }
  return null;
}

// ============================================================================
// AAD v2 — bind a note-content ciphertext to its item_id
// ============================================================================
//
// Mirrors the Rust SDK's `note_content_aad_v2`,
// `encrypt_note_with_content_key` and `decrypt_note_with_content_key` — the
// context bytes must match byte-for-byte or the clients cannot read each
// other's notes. The AEAD tag covers the AAD, so a
// ciphertext sealed with AAD(item_id = A) fails to open when a curious server
// presents it under item_id = B, defeating a ciphertext-relocation attack.
//
// Write flag. While TRUE, note content is WRITTEN with the v2 context AAD;
// while FALSE it is written with empty AAD (v1 — byte-identical to every
// pre-v2 ciphertext; null-AAD ct === empty-array-AAD ct). Decryption ALWAYS
// tries the v2 context-AAD first and falls back to v1, so every client reads
// both. The flag has to agree with the Rust SDK's: a v2 ciphertext whose AAD
// doesn't byte-match on another client is unreadable everywhere.
const AAD_V2_WRITE_ENABLED = true;

/**
 * v2 context-AAD binding a note-content ciphertext to its `item_id`. 32-byte
 * BLAKE3 over a u16-length-prefixed TLV. MUST stay byte-identical to the Rust
 * SDK `note_content_aad_v2`:
 *   input       = u16le(0) || u32le(0) || u16le(len(item_id)) || item_id || u16le(0)
 *   context_key = BLAKE3::derive_key("pingolin.aad.v2.context", "pingolin.aad.v2.note_content")
 *   aad         = BLAKE3::keyed_hash(context_key, input)
 * (container id + extra are empty for note content; key_version is 0 — notes
 * don't per-note-version the content key.) Cross-checked against the Rust SDK:
 * aad("item-1") = a40b78faec114481be36d3929dd9bebc1f521b66feb6d67291a2a2417813f207.
 */
export function noteContentAadV2(itemId: string): Uint8Array {
  const id = new TextEncoder().encode(itemId);
  if (id.length > 0xffff) throw new Error('item_id exceeds u16 length prefix');
  const input = new Uint8Array(2 + 4 + 2 + id.length + 2);
  const view = new DataView(input.buffer);
  let off = 0;
  view.setUint16(off, 0, true); off += 2;          // LP(container = "")
  view.setUint32(off, 0, true); off += 4;          // key_version = 0
  view.setUint16(off, id.length, true); off += 2;  // LP(item_id) length, u16 LE
  input.set(id, off); off += id.length;            // item_id UTF-8 bytes
  view.setUint16(off, 0, true);                     // LP(extra = "")
  return blake3KeyedHash(aadContextKey(), input);
}

/**
 * The AAD v2 context key.
 *
 * Both inputs are string literals, so this value is a compile-time constant:
 * deriving it inside noteContentAadV2 on EVERY encrypt and decrypt would put
 * a BLAKE3 key derivation on the hot path of every note in the list (7.4us
 * per call against 2.6us hoisted, for identical output bytes).
 *
 * Lazily memoised rather than computed at module load, because sodium has to be
 * ready first.
 */
let cachedAadContextKey: Uint8Array | null = null;
function aadContextKey(): Uint8Array {
  if (!cachedAadContextKey) {
    cachedAadContextKey = blake3DeriveKey(
      'pingolin.aad.v2.context',
      new TextEncoder().encode('pingolin.aad.v2.note_content'),
    );
  }
  return cachedAadContextKey;
}

/**
 * Encrypt note plaintext under an arbitrary content key. `itemId` binds the
 * ciphertext to its note when AAD v2 writes are enabled; while disabled it is
 * unused on the write side (empty AAD → byte-identical to legacy ciphertexts).
 */
export function encryptWithContentKey(plaintext: string, contentKey: Uint8Array, itemId: string): EncryptedData {
  if (!sodium) throw new Error('Crypto not ready');
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = AAD_V2_WRITE_ENABLED ? noteContentAadV2(itemId) : new Uint8Array(0);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext), aad, null, nonce, contentKey,
  );
  return {
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: toB64Fast(ciphertext),
  };
}

/**
 * Decrypt ciphertext under a content key. Returns null on failure.
 *
 * Tries the v2 context-AAD (bound to `itemId`) first, then falls back to the v1
 * empty AAD for legacy ciphertexts. A ciphertext presented under the wrong
 * `itemId` fails BOTH (v2 mismatches, v1 fails because it was sealed with a
 * non-empty AAD) → null = tamper rejected.
 */
/**
 * Base64 for LARGE payloads — note ciphertext, not keys. Tier table and the
 * encode-side trap live in lib/fastBase64.ts; these wrappers just wire in
 * sodium as the floor. Deliberately NOT applied to key material — those are
 * 32 bytes, where the difference is unmeasurable and sodium's constant-time
 * decoder is the conservative choice.
 */
function fromB64Fast(b64: string): Uint8Array {
  // Callers are all past the `if (!sodium) return null` guard, but the
  // compiler cannot see that across the function boundary.
  return fromB64(b64, (v) => sodium!.from_base64(v, sodium!.base64_variants.ORIGINAL));
}

/** Encode-side twin of [fromB64Fast]; see lib/fastBase64.ts for the tier
 *  table (the btoa chunk loop everyone reaches for is 8x SLOWER than
 *  sodium on encode — the shared util knows this, hand-rolled code
 *  doesn't). */
function toB64Fast(bytes: Uint8Array): string {
  return toB64(bytes, (v) => sodium!.to_base64(v, sodium!.base64_variants.ORIGINAL));
}

export function decryptWithContentKey(encrypted: EncryptedData, contentKey: Uint8Array, itemId: string): string | null {
  if (!sodium) return null;
  try {
    const nonce = fromB64Fast(encrypted.nonce);
    const ciphertext = fromB64Fast(encrypted.ciphertext);
    try {
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, ciphertext, noteContentAadV2(itemId), nonce, contentKey,
      );
      return sodium.to_string(plaintext);
    } catch {
      // Legacy v1 ciphertext (empty AAD) — fall back.
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, ciphertext, new Uint8Array(0), nonce, contentKey,
      );
      return sodium.to_string(plaintext);
    }
  } catch {
    return null;
  }
}

/**
 * Does this content open as sealed FOR THIS ITEM (the id is bound into it)?
 *
 * `decryptWithContentKey` also takes the older format that names no item: it
 * has to, for notes written before the binding. This is for the one reader
 * that must not: a row taken as "the note this browser just sent" is a note
 * this build sealed, and this build binds every note to its id.
 */
export function opensBoundToItem(encrypted: EncryptedData, contentKey: Uint8Array, itemId: string): boolean {
  if (!sodium) return false;
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, fromB64Fast(encrypted.ciphertext), noteContentAadV2(itemId), fromB64Fast(encrypted.nonce), contentKey,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive a per-note session key for the real-time collab relay from a
 * 32-byte secret. The server never sees the secret, so updates encrypted
 * with the derived key are unreadable to the relay.
 *
 * Uses BLAKE2b (via crypto_generichash) keyed with the secret — the
 * secret is already 32 bytes of random material so no separate HKDF pass
 * is needed.
 *
 * For an owned note, pass the note's unwrapped per-note content key. For
 * a shared note, pass the content key sealed for us by the sender (from
 * `sharesInboxStore`). Owner and recipient hold the same content key, so
 * they derive the same session key and can decrypt each other's frames.
 *
 * Legacy vault-encrypted notes (no content key) can fall back to passing
 * the vault key directly — only the owner can collab on those anyway.
 */
export function deriveCollabKey(noteId: string, secret: Uint8Array): Uint8Array | null {
  if (!sodium) return null;
  if (secret.length !== 32) return null;
  const context = sodium.from_string(`pingolin-note-collab:${noteId}`);
  return sodium.crypto_generichash(32, context, secret);
}

/** Returns the in-memory vault key, or null if unavailable. Exposed so
 * the collab session can derive a fallback key for legacy notes that
 * have no per-note content key yet. */
export function getVaultKey(): Uint8Array | null {
  return vaultKey;
}

/**
 * Encrypt a binary collab payload with a per-note session key.
 * Returns nonce || ciphertext as a single buffer so the wire format is
 * self-contained.
 */
export function encryptCollabPayload(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (!sodium) throw new Error('Crypto not ready');
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, null, null, nonce, key,
  );
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return out;
}

/** Decrypt a buffer produced by encryptCollabPayload. Returns null on auth failure. */
export function decryptCollabPayload(key: Uint8Array, packet: Uint8Array): Uint8Array | null {
  if (!sodium) return null;
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  if (packet.length < nonceLen) return null;
  const nonce = packet.subarray(0, nonceLen);
  const ciphertext = packet.subarray(nonceLen);
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, ciphertext, null, nonce, key,
    );
  } catch {
    return null;
  }
}

/** Encrypt plaintext with the vault key */
export function encryptNote(plaintext: string): EncryptedData {
  if (!sodium || !vaultKey) throw new Error('Crypto not ready');

  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    null, null, nonce, vaultKey
  );

  return {
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext: toB64Fast(ciphertext),
  };
}

/** Decrypt ciphertext with the vault key */
export function decryptNote(encrypted: EncryptedData): string {
  if (!sodium || !vaultKey) throw new Error('Crypto not ready');

  const nonce = fromB64Fast(encrypted.nonce);
  // Legacy notes (written before per-note content keys) can be as large as
  // any other, so this path uses the fast decode too.
  const ciphertext = fromB64Fast(encrypted.ciphertext);

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, ciphertext, null, nonce, vaultKey
  );

  return sodium.to_string(plaintext);
}

/**
 * `decryptNote` with the vault keys from before a password reset, the current
 * one NOT tried: what to try once that one has failed. Null when none opens.
 *
 * Read only, as every use of those keys is: what opens here is written back,
 * if at all, under the CURRENT identity. The notebook list (`item_type = 10`)
 * is the one thing sealed straight under the vault key, so with only the
 * current key tried, a reset would leave it unreadable for good, the
 * recovery key included.
 */
export function decryptNoteWithRecoveredVault(encrypted: EncryptedData): string | null {
  if (!sodium) return null;
  for (const previous of previousVaultKeys) {
    try {
      const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, fromB64Fast(encrypted.ciphertext), null, fromB64Fast(encrypted.nonce), previous,
      );
      return sodium.to_string(plaintext);
    } catch {
      // Not this one.
    }
  }
  return null;
}

/**
 * Which vault key opens a wrapped content key: this identity's ('current'),
 * one from before a password reset ('recovered'), or none (null). Says which,
 * and hands no key out: whoever needs the key unwraps it with
 * `unwrapContentKeyWithVault`. Null too before keys are loaded.
 */
export function vaultKeyThatOpens(wrappedKeyB64: string, nonceB64: string): 'current' | 'recovered' | null {
  if (!sodium || !vaultKey) return null;
  const s = sodium;
  const opens = (key: Uint8Array): boolean => {
    try {
      const opened = s.crypto_secretbox_open_easy(
        s.from_base64(wrappedKeyB64, s.base64_variants.ORIGINAL),
        s.from_base64(nonceB64, s.base64_variants.ORIGINAL),
        key,
      );
      const ok = !!opened && opened.length === 32;
      if (opened) s.memzero(opened);
      return ok;
    } catch {
      return false;
    }
  };
  if (opens(vaultKey)) return 'current';
  for (const previous of previousVaultKeys) {
    if (opens(previous)) return 'recovered';
  }
  return null;
}

/** Encrypt binary data with the vault key. Returns nonce + ciphertext as a single Uint8Array. */
export function encryptBinary(data: Uint8Array): { nonce: string; ciphertext: Uint8Array } {
  if (!sodium || !vaultKey) throw new Error('Crypto not ready');

  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    data, null, null, nonce, vaultKey
  );

  return {
    nonce: sodium.to_base64(nonce, sodium.base64_variants.ORIGINAL),
    ciphertext,
  };
}

/** Decrypt binary ciphertext with the vault key. Returns raw Uint8Array. */
export function decryptBinary(ciphertext: Uint8Array, nonce: string): Uint8Array {
  if (!sodium || !vaultKey) throw new Error('Crypto not ready');

  const nonceBytes = sodium.from_base64(nonce, sodium.base64_variants.ORIGINAL);
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null, ciphertext, null, nonceBytes, vaultKey
  );
}


// =============================================================================
// Wrap signatures (Ed25519 over BLAKE3-keyed-hash of canonical wrap-context)
//
// Note's wrap primitive is sealed_box (anonymous, no nonce, no explicit
// ephemeral exposed in the wire format) — different from Track's
// crypto_box_easy. The signed canonical input is therefore Note-specific:
//
//   ctx_key = BLAKE3.derive_key("pingolin.sig.v1.context_key", DOMAIN)
//   msg = u8(16)|sender_uuid_bytes
//       ‖ u8(16)|recipient_uuid_bytes
//       ‖ u8(16)|item_uuid_bytes
//       ‖ u32_le(content_key_version)
//       ‖ u8(LEN)|wrapped_key_bytes
//   sig_input = BLAKE3.keyed_hash(ctx_key, msg)
//   signature = Ed25519.sign(sig_input)
//
// `wrapped_key_bytes` is the raw decoded bytes of the sealed_box blob (the
// base64-decoded form of the wrapped key a share carries);
// length-prefixed with u8 since 80 bytes fits.
//
// Same Ed25519 primitive, same BLAKE3 keyed-hash construction, same
// pingolin.sig.v1.* domain root used product-wide. The wraps do not interop
// byte-for-byte across products (different inputs) — only the construction is
// shared.
// =============================================================================

/**
 * Normalize whatever a signing-key blob turned out to hold into the 64-byte
 * signing secret + 32-byte public key libsodium wants.
 *
 * Three shapes exist in the wild, from a cross-client contract drift (the
 * wrong length makes crypto_sign_detached fail with "invalid privateKey
 * length", and every share is refused):
 *   32 = the seed (the intended contract);
 *   64 = the full secret, seed||pub — some accounts' server blob stores this;
 *   96 = secret||pub — a shell handoff that appended the public key to what
 *        was ALREADY the full secret. The first 64 bytes are the true secret.
 */
function normalizeSigningSecret(bytes: Uint8Array): { secret: Uint8Array; pub: Uint8Array } | null {
  if (!sodium) return null;
  if (bytes.length === 32) {
    const kp = sodium.crypto_sign_seed_keypair(bytes);
    return { secret: kp.privateKey, pub: kp.publicKey };
  }
  if (bytes.length === 64 || bytes.length === 96) {
    const secret = bytes.slice(0, 64);
    return { secret, pub: secret.slice(32, 64) };
  }
  return null;
}

/** Install the Ed25519 signing keypair from a signing-key blob (base64).
 *  Nominally a 32-byte seed from the auth /me response
 *  (encrypted_signing_private_key, decrypted with the master key); the
 *  64/96-byte legacy shapes are normalized — see normalizeSigningSecret. */
export function importSigningPrivateKey(secretSeedBase64: string): void {
  if (!sodium) throw new Error('Crypto not initialized');
  const seed = sodium.from_base64(secretSeedBase64, sodium.base64_variants.ORIGINAL);
  const norm = normalizeSigningSecret(seed);
  if (!norm) {
    throw new Error(`Invalid signing key length: ${seed.length} (expected 32, 64 or 96)`);
  }
  const kp = { privateKey: norm.secret, publicKey: norm.pub };
  // libsodium calls the secret half `privateKey` — it's the 64-byte
  // signing secret (seed || pubkey concat). Wipe any previous one.
  if (signingSecretKey) {
    try { sodium.memzero(signingSecretKey); } catch { signingSecretKey.fill(0); }
  }
  signingSecretKey = kp.privateKey;
  signingPublicKeyBytes = kp.publicKey;
  try { sodium.memzero(seed); } catch { seed.fill(0); }
  persistToSessionStorage();
}

/** Returns true if a signing keypair is currently loaded — or, in the iOS
 * key-bridge shell, if the shell says it can sign and the public half is here
 * (the secret never enters the page there). */
export function hasSigningKey(): boolean {
  const bridge = bridgeMarker();
  if (bridge) return bridge.signing && signingPublicKeyBytes !== null;
  return signingSecretKey !== null && signingPublicKeyBytes !== null;
}

/**
 * Ensure a signing keypair is loaded, installing the X25519-seeded shortcut as
 * a last resort, and report whether one is now available.
 *
 * Every send path MUST gate on this rather than on `hasSigningKey()` alone.
 * The restore paths (`restoreFromSession` / `restoreFromClientKey`) already
 * install a signing key, but a session that reached a vault key by another
 * route — a handoff that carried no signing pair — lands here with
 * `signingSecretKey === null`. Sharing from such a session would emit an
 * UNSIGNED wrap, which recipients drop once they hold a pin for us, so the
 * share would silently never arrive. Recover if we can; the caller refuses
 * to share if we can't.
 */
export const SIGNING_KEY_MISMATCH_MESSAGE =
  "This browser isn't set up to share for your account, so anyone you share with " +
  "would reject the note. Sign in again at the account portal, then share again.";

export const SIGNING_UNAVAILABLE_MESSAGE =
  "This browser can't prove the share comes from you, so the recipient's app " +
  'would hide it. Sign in again at the account portal, then share again.';

export function ensureSigningKey(): boolean {
  if (hasSigningKey()) return true;
  // Nothing to recover from in the bridge shell — and never the shortcut.
  if (bridgeMarker() !== null) return false;
  // Only possible when the X25519 sharing private key survived — that is the
  // seed the shortcut derives from.
  installSigningKeyFromSharingKey();
  return hasSigningKey();
}

/**
 * Install the signing keypair by reusing the loaded X25519 sharing private
 * key as the Ed25519 seed.
 *
 * The fallback when no real signing seed is available. The auth /me blob
 * carrying `encrypted_signing_private_key` is encrypted with the master key,
 * which the web client never has in scope — login happens on the account
 * portal origin, not here. So web signs with a key that is stable and
 * identifiable but does NOT verify against the server's stored Ed25519
 * verifying key. The mobile clients DO hold the master key during SRP step
 * 2; they detect this X25519-as-Ed25519-seed mismatch on next login and POST
 * /auth/signing-key/regenerate, after which web picks up the corrected
 * signing_public_key on its next /auth/me. Until that happens for an
 * account, recipients see that account's web-written wraps as unverifiable.
 *
 * Called from restoreFromSession / restoreFromClientKey paths so the
 * signing key is loaded as a side effect of vault-key restoration.
 */
export function installSigningKeyFromSharingKey(): void {
  if (!sodium || !sharingPrivateKey || bridgeMarker() !== null) return;
  try {
    const seedB64 = sodium.to_base64(sharingPrivateKey, sodium.base64_variants.ORIGINAL);
    importSigningPrivateKey(seedB64);
  } catch (e) {
    console.warn('[note/crypto] installSigningKeyFromSharingKey failed:', e);
  }
}

/** Hex-encode the in-memory Ed25519 verifying key. Useful for debugging
 *  and for echoing back to the auth backend during regenerate flows. */
export function getSigningPublicKeyHex(): string | null {
  if (!signingPublicKeyBytes) return null;
  return bytesToHex(signingPublicKeyBytes);
}

/** Parameters that go into the Note share-invite signature. */
export interface NoteShareWrapParams {
  /** Sender (sharer) user_id, UUID hex form (with or without hyphens). */
  senderUserId: string;
  /** Recipient user_id, UUID hex form. */
  recipientUserId: string;
  /** Item being shared, UUID hex form. */
  itemId: string;
  /** Content-key version — bumped on every rotate-shares. */
  contentKeyVersion: number;
  /** The base64 sealed_box blob the recipient will unseal. */
  wrappedKeyBase64: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const b = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error('Invalid hex char');
    out[i] = b;
  }
  return out;
}

/** UUID (canonical with or without dashes) → 16 raw bytes. */
function uuidToBytes(uuid: string): Uint8Array {
  const stripped = uuid.replace(/-/g, '').toLowerCase();
  if (stripped.length !== 32 || !/^[0-9a-f]{32}$/.test(stripped)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  return hexToBytes(stripped);
}

/** BLAKE3 derive_key wrapper — matches Rust `blake3::derive_key`. */
function blake3DeriveKey(context: string, keyMaterial: Uint8Array): Uint8Array {
  return blake3(keyMaterial, { context, dkLen: 32 });
}

/** BLAKE3 keyed_hash wrapper — matches Rust `blake3::keyed_hash`. */
function blake3KeyedHash(key: Uint8Array, msg: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error(`blake3KeyedHash: key must be 32 bytes (got ${key.length})`);
  }
  return blake3(msg, { key, dkLen: 32 });
}

function pushLp(chunks: Uint8Array[], bytes: Uint8Array): void {
  if (bytes.length > 255) {
    throw new Error('sig field exceeds u8 length prefix');
  }
  chunks.push(new Uint8Array([bytes.length]));
  chunks.push(bytes);
}

/** Compute the canonical sig_input for a note share-invite wrap. */
function computeNoteWrapSigInput(params: NoteShareWrapParams): Uint8Array {
  if (!sodium) throw new Error('Crypto not initialized');
  const ctxKey = blake3DeriveKey(
    'pingolin.sig.v1.context_key',
    new TextEncoder().encode(DOMAIN_NOTE_SHARE_INVITE),
  );

  const sender = uuidToBytes(params.senderUserId);
  const recipient = uuidToBytes(params.recipientUserId);
  const item = uuidToBytes(params.itemId);
  const wrappedKey = sodium.from_base64(params.wrappedKeyBase64, sodium.base64_variants.ORIGINAL);

  const ver = new Uint8Array(4);
  new DataView(ver.buffer).setUint32(0, params.contentKeyVersion >>> 0, true);

  const chunks: Uint8Array[] = [];
  pushLp(chunks, sender);
  pushLp(chunks, recipient);
  pushLp(chunks, item);
  chunks.push(ver);
  pushLp(chunks, wrappedKey);

  let total = 0;
  for (const c of chunks) total += c.length;
  const msg = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    msg.set(c, off);
    off += c.length;
  }
  return blake3KeyedHash(ctxKey, msg);
}

/** Sign a note share-invite wrap with our Ed25519 key. Returns
 * a 128-char lowercase hex string (raw 64-byte signature). Throws if
 * no signing key is loaded. */
export function signNoteShareWrap(params: NoteShareWrapParams): string {
  if (!sodium) throw new Error('Crypto not initialized');
  if (!signingSecretKey) throw new Error('No signing keypair loaded');
  const sigInput = computeNoteWrapSigInput(params);
  const sig = sodium.crypto_sign_detached(sigInput, signingSecretKey);
  return bytesToHex(sig);
}

/** Verify a note share-invite wrap signature. Returns true on a
 *  valid signature, false on a structurally well-formed but
 *  mathematically-invalid one. Throws on parse errors (bad hex).
 *
 *  Verify-both. The sig_input binds `content_key_version`, but a signature
 *  made under the legacy version 0 (see `trySignShareWrap` /
 *  `NoteShareWrapParams`) does NOT actually pin the version — a malicious
 *  server can replay an OLDER shared-note version and it still verifies.
 *  Signing the REAL version closes that. So this verifier accepts a
 *  signature valid under the PASSED version OR under legacy 0: it
 *  recomputes with 0 only when the passed version is non-zero and the first
 *  check failed. A real-version sig verifies here, AND a legacy-0 sig from a
 *  signer that still uses 0 does too. Mirrors the mobile-sdk note-collab-sdk
 *  `verify_note_share_wrap` byte-for-byte (same sig_input framing).
 *
 *  ORDERING CONSTRAINT: signers may emit the real version only where every
 *  client that verifies (web, Android, iOS) accepts both forms; a verifier
 *  that checks a single version rejects the other form. */
export function verifyNoteShareWrap(
  signingPubkeyHex: string,
  signatureHex: string,
  params: NoteShareWrapParams,
): boolean {
  return verifyNoteShareWrapGen(signingPubkeyHex, signatureHex, params).verified;
}

/** Outcome of {@link verifyNoteShareWrapGen}: the verify-both boolean plus
 *  the content-key generation the signature ACTUALLY validated under (the
 *  passed version, or 0 when it only validated via the legacy-0 fallback or
 *  did not verify). Mirrors mobile-sdk `WrapVerifyResult`. */
export interface WrapVerifyResult {
  verified: boolean;
  effectiveGeneration: number;
}

/** Verify-both that also reports which generation the signature verified
 *  under. Readers enforce rollback protection by keying a per-item
 *  highest-seen floor on `effectiveGeneration` — NOT the server-claimed one.
 *  A legacy gen-0 sig the server relabels "generation 99" verifies here via
 *  fallback but reports 0, so it cannot launder past the floor. Must match the
 *  mobile SDK's `verify_note_share_wrap_gen` byte-for-byte. */
export function verifyNoteShareWrapGen(
  signingPubkeyHex: string,
  signatureHex: string,
  params: NoteShareWrapParams,
): WrapVerifyResult {
  if (!sodium) throw new Error('Crypto not initialized');
  const pk = hexToBytes(signingPubkeyHex);
  if (pk.length !== 32) throw new Error('signing pubkey must be 32 bytes');
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 64) throw new Error('signature must be 64 bytes');
  // Primary check under the PASSED version. Computed outside the try so a
  // malformed `params` still throws (the parse-error contract above).
  const primaryInput = computeNoteWrapSigInput(params);
  try {
    if (sodium.crypto_sign_verify_detached(sig, primaryInput, pk)) {
      return { verified: true, effectiveGeneration: params.contentKeyVersion >>> 0 };
    }
    // Fallback: a legacy sig signed under version 0. Only attempted when a
    // non-zero real version was passed and the primary check failed — so the
    // pin keeps its teeth: a sig valid under NEITHER the passed version nor 0
    // is still rejected (no blanket accept). Reports generation 0, not the
    // claimed one — the anti-laundering pin.
    if (params.contentKeyVersion !== 0) {
      const legacyInput = computeNoteWrapSigInput({ ...params, contentKeyVersion: 0 });
      if (sodium.crypto_sign_verify_detached(sig, legacyInput, pk)) {
        return { verified: true, effectiveGeneration: 0 };
      }
    }
    return { verified: false, effectiveGeneration: 0 };
  } catch {
    return { verified: false, effectiveGeneration: 0 };
  }
}

// =============================================================================
// TOFU pinning of share-counterparty keys
//
// Plaintext JSON in localStorage (pins are public keys), namespaced by the
// signed-in user's id and KEPT across logout — see clearKeys. Keyed by user_id
// (the OTHER party in a share — sender if I'm the recipient, recipient if I'm
// the sender). Both ids are canonical (lib/account.ts), so a server that
// changes an id's spelling finds the same pins; a non-UUID is never "not
// pinned" (pinMerge.ts).
// =============================================================================

export type PinState = 'NewPinning' | 'Matched' | 'ChangedSharing' | 'ChangedSigning' | 'ChangedBoth';

export interface PinResult {
  state: PinState;
  /** Unix seconds; 0 when state === 'NewPinning'. */
  previousPinnedAt: number;
}

type PinRecord = StoredPin;

const pinnedKeys: Map<string, PinRecord> = new Map();
let pinsLoaded = false;
// Namespaces the durable pin blob by the current (local) user id so a shared
// browser keeps accounts' pins separate; null pre-login falls back to the base
// key.
let pinStorageUserId: string | null = null;

// localStorage key for this user's pin blob. Namespaced by user id (falls back
// to the base key pre-login).
function pinStorageKey(): string {
  return pinStorageUserId ? `${PIN_STORAGE_KEY}.${pinStorageUserId}` : PIN_STORAGE_KEY;
}

function persistPinnedKeys(): void {
  try {
    const obj: Record<string, PinRecord> = {};
    for (const [k, v] of pinnedKeys.entries()) obj[k] = v;
    // Plaintext JSON keyed by user_id: pins are public keys, so there is
    // nothing to encrypt, and durable localStorage means a new tab keeps them.
    localStorage.setItem(pinStorageKey(), JSON.stringify(obj));
    // In a shell, whose sign-out wipe deletes them, the app keeps a copy.
    scheduleKeep();
  } catch (e) {
    console.warn('[note/crypto] failed to persist pinned keys:', e);
  }
}

/** Save one source blob verbatim beside `target` before anything is discarded:
 *  `<target>.premerge.<n>`, unless an identical copy is already there. */
function savePremerge(target: string, raw: string): void {
  let n = 0;
  for (;;) {
    const held = localStorage.getItem(`${target}.premerge.${n}`);
    if (held === null) break;
    if (held === raw) return;
    n++;
  }
  localStorage.setItem(`${target}.premerge.${n}`, raw);
}

/**
 * Fold every pin blob this account kept under another spelling of its id into
 * the canonical one, dropping nothing (the rule is pinMerge.ts):
 *  1. the sources: the canonical blob, blobs named by any other spelling of the
 *     account's id, and the older builds' un-namespaced blob when it is the only
 *     one and the browser recorded this account as its owner (`ownerKnown`);
 *  2. each source saved verbatim first (savePremerge);
 *  3. folded by canonical contact id and written under the canonical name;
 *  4. the other sources removed only once that write reads back.
 * Nothing changes when the canonical blob is all there is and already clean.
 * A failure anywhere keeps every source. Only counts are logged.
 */
export function migratePinnedKeys(account: string, ownerKnown: boolean): void {
  const target = `${PIN_STORAGE_KEY}.${account}`;
  try {
    const others: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === null || k === target || !k.startsWith(`${PIN_STORAGE_KEY}.`)) continue;
      if (tryCanonicalAccountId(k.slice(PIN_STORAGE_KEY.length + 1)) === account) others.push(k);
    }
    const current = localStorage.getItem(target);
    if (ownerKnown && current === null && others.length === 0 && localStorage.getItem(PIN_STORAGE_KEY) !== null) {
      others.push(PIN_STORAGE_KEY);
    }
    const parse = (raw: string): unknown => {
      try { return JSON.parse(raw); } catch { return null; }
    };
    if (others.length === 0 && (current === null || isCanonicalPinBlob(parse(current)))) return;

    const sources = current === null ? others : [target, ...others];
    const raws = sources.map(k => localStorage.getItem(k) ?? '');
    for (const raw of raws) savePremerge(target, raw);
    const fold = foldPins(raws.map(parse));
    const out = JSON.stringify(fold.pins);
    localStorage.setItem(target, out);
    if (localStorage.getItem(target) !== out) {
      console.warn('[note/crypto] pin fold did not read back; every source kept');
      return;
    }
    for (const k of others) localStorage.removeItem(k);
    console.info(`[note/crypto] pins folded: ${sources.length} source(s), ${fold.conflicts} conflict(s), ${fold.dropped} dropped`);
  } catch (e) {
    console.warn('[note/crypto] pin fold failed; every source kept', e);
  }
}

/**
 * An erased account (lib/forgetAccount.ts): remove its pin blob under every
 * spelling of its id, and the copies a fold kept. Nobody else's.
 */
export function forgetPinnedKeys(account: string): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === null || !k.startsWith(`${PIN_STORAGE_KEY}.`)) continue;
      const rest = k.slice(PIN_STORAGE_KEY.length + 1);
      const spelling = rest.replace(/\.premerge\.\d+$/, '');
      if (tryCanonicalAccountId(spelling) === account) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
    if (pinStorageUserId === account) {
      pinnedKeys.clear();
      pinsLoaded = false;
    }
  } catch { /* storage unavailable: nothing to remove */ }
}

/** Pin blobs written by older versions, one per browser: an erased account's
 * only when the browser recorded it as the owner (the caller's check). */
export function forgetLegacyPinnedKeys(): void {
  try {
    localStorage.removeItem(PIN_STORAGE_KEY);
    localStorage.removeItem(PIN_STORAGE_LEGACY_BLOB_KEY);
    localStorage.removeItem(PIN_STORAGE_LEGACY_NONCE_KEY);
  } catch { /* storage unavailable: nothing to remove */ }
}

/**
 * Load this user's pinned-keys blob from localStorage. Pass the current user's
 * id to namespace (and, if it differs from a prior call, switch to) the right
 * blob — a shared browser must not let user B load user A's pins. Best-effort:
 * a missing or corrupt blob simply starts the pin set empty. Idempotent per user.
 * The id must be an account id (it throws otherwise); the blob is named, and
 * its contacts keyed, by canonical ids (migratePinnedKeys, foldPins).
 */
export function loadPinnedKeysFromStorage(userId?: string): void {
  // Adopt/switch the user namespace before the idempotency guard so a login
  // that arrives after an anonymous pre-login load still binds the right blob.
  const id = userId === undefined ? undefined : canonicalAccountId(userId);
  if (id && id !== pinStorageUserId) {
    migratePinnedKeys(id, false);
    pinStorageUserId = id;
    pinsLoaded = false;
    pinnedKeys.clear();
  }
  if (pinsLoaded) return;
  pinsLoaded = true;
  try {
    const raw = localStorage.getItem(pinStorageKey());
    if (!raw) return;
    const { pins } = foldPins([JSON.parse(raw)]);
    pinnedKeys.clear();
    for (const [k, r] of Object.entries(pins)) pinnedKeys.set(k, r);
  } catch (e) {
    console.warn('[note/crypto] failed to load pinned keys:', e);
  }
}

function nowSecs(): number { return Math.floor(Date.now() / 1000); }

/** Pin (or compare) a counterparty's sharing+signing pubkeys. */
export function pinUserKeys(
  userId: string,
  sharingPubkeyHex: string,
  signingPubkeyHex: string,
): PinResult {
  if (!sodium) throw new Error('Crypto not initialized');
  if (!/^[0-9a-fA-F]{64}$/.test(sharingPubkeyHex)) {
    throw new Error(`Invalid sharing pubkey hex (got ${sharingPubkeyHex.length} chars)`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(signingPubkeyHex)) {
    throw new Error(`Invalid signing pubkey hex (got ${signingPubkeyHex.length} chars)`);
  }
  if (!pinsLoaded) loadPinnedKeysFromStorage();

  // Not an account id: an error, never a first contact.
  const key = canonicalAccountId(userId);
  const now = nowSecs();
  const sharingLower = sharingPubkeyHex.toLowerCase();
  const signingLower = signingPubkeyHex.toLowerCase();
  const existing = pinnedKeys.get(key);

  if (!existing) {
    pinnedKeys.set(key, {
      sharingPubkeyHex: sharingLower,
      signingPubkeyHex: signingLower,
      firstPinnedAt: now,
      lastVerifiedAt: now,
    });
    persistPinnedKeys();
    return { state: 'NewPinning', previousPinnedAt: 0 };
  }
  // A conflict matches nothing until the person approves a key.
  if (existing.conflict) return { state: 'ChangedBoth', previousPinnedAt: existing.firstPinnedAt };
  const sharingMatch = existing.sharingPubkeyHex === sharingLower;
  const signingMatch = existing.signingPubkeyHex === signingLower;
  let state: PinState;
  if (sharingMatch && signingMatch) state = 'Matched';
  else if (!sharingMatch && signingMatch) state = 'ChangedSharing';
  else if (sharingMatch && !signingMatch) state = 'ChangedSigning';
  else state = 'ChangedBoth';
  if (state === 'Matched') {
    pinnedKeys.set(key, { ...existing, lastVerifiedAt: now });
    persistPinnedKeys();
  }
  return { state, previousPinnedAt: existing.firstPinnedAt };
}

/** Overwrite a pin after the user has confirmed via the SAS UI. */
export function approveUserKeyChange(
  userId: string,
  newSharingPubkeyHex: string,
  newSigningPubkeyHex: string,
): void {
  if (!pinsLoaded) loadPinnedKeysFromStorage();
  const key = canonicalAccountId(userId);
  const now = nowSecs();
  const existing = pinnedKeys.get(key);
  // A fresh record: approving clears a conflict.
  pinnedKeys.set(key, {
    sharingPubkeyHex: newSharingPubkeyHex.toLowerCase(),
    signingPubkeyHex: newSigningPubkeyHex.toLowerCase(),
    firstPinnedAt: existing?.firstPinnedAt ?? now,
    lastVerifiedAt: now,
    userApprovedChangeAt: now,
  });
  persistPinnedKeys();
}

/** Read a pin (returns null if unpinned). An id that is not an account id
 *  reads as a conflict: never matched, never a first contact. */
export function getPinnedUserKeys(userId: string): PinRecord | null {
  if (!pinsLoaded) loadPinnedKeysFromStorage();
  const key = tryCanonicalAccountId(userId);
  if (!key) return conflictPin(0, 0);
  return pinnedKeys.get(key) ?? null;
}

/**
 * SEND-SIDE gate (TOFU), applied the same way by the Android app. Decide
 * whether it's safe to seal a per-note content key to `recipientUserId` under
 * the directory-returned `sharingPubkeyHex`. Blindness-critical and symmetric
 * with the receive-side pin check (sharesInbox.ts): a compromised server that
 * substitutes a recipient's sharing key at share time would otherwise make us
 * seal the content key to an attacker-held key.
 *
 *  - No `sharingPubkeyHex` → true (nothing to seal, so nothing to verify).
 *  - A `sharingPubkeyHex` present but NO `recipientUserId` → false: we hold a
 *    key but have no identity to look its pin up under, so we cannot verify it
 *    wasn't substituted. A malicious server that returns
 *    `{sharing_public_key: <attacker>, user_id: null}` must not slip a key past
 *    the pin by nulling the identity → fail closed. A legitimate directory hit
 *    always carries a user_id, so real first-time shares are unaffected.
 *    BOTH an EXPLICIT mismatch AND an unverifiable (identity-less) key refuse.
 *  - No pin yet → trust-on-first-use: pin the directory keys (best-effort;
 *    `pinUserKeys` needs both as 64-char hex, which the auth directory returns —
 *    if the server didn't return a well-formed signing key we can't pin yet but
 *    still proceed, matching android) and return true.
 *  - Pin exists and its sharing key matches (case-insensitive) → true.
 *  - Pin exists and its sharing key DIFFERS → false: the caller MUST skip this
 *    recipient and NOT seal under the substituted key.
 *
 * Never overwrites an existing pin — a rotated key needs out-of-band
 * safety-number approval via `approveUserKeyChange`.
 */
export function allowSealToRecipient(
  recipientUserId: string | null | undefined,
  signingPubkeyHex: string | null | undefined,
  sharingPubkeyHex: string | null | undefined,
): boolean {
  if (!sharingPubkeyHex) return true; // nothing to seal → nothing to verify
  if (!recipientUserId) return false; // have a key but no identity to verify it against → refuse (fail closed)
  // Not an account id: nothing to look a pin up under → refuse, never TOFU.
  const key = tryCanonicalAccountId(recipientUserId);
  if (!key) return false;
  if (!pinsLoaded) loadPinnedKeysFromStorage();
  const existing = pinnedKeys.get(key);
  if (!existing) {
    // TOFU: record the directory keys so a LATER substitution is caught.
    // pinUserKeys validates 64-char hex and throws otherwise; if the server
    // didn't return a well-formed signing key we can't pin yet but still
    // proceed (matches android, which needs a non-blank signing key to pin).
    if (signingPubkeyHex) {
      try { pinUserKeys(recipientUserId, sharingPubkeyHex, signingPubkeyHex); } catch { /* best-effort */ }
    }
    return true;
  }
  // A conflict matches nothing until the person approves a key.
  if (existing.conflict) return false;
  return existing.sharingPubkeyHex.toLowerCase() === sharingPubkeyHex.toLowerCase();
}

// =============================================================================
// Safety numbers (Signal-style SAS for out-of-band verification)
//
// Symmetric: peer.computeSafetyNumber(self) === self.computeSafetyNumber(peer)
// thanks to lex-min ordering of the two material blobs. Mirrors the Track
// mobile-sdk + web implementations bytewise — same domain string and layout.
// =============================================================================

const SAS_CONTEXT_KEY = 'pingolin.sas.v1';

export function computeSafetyNumber(
  selfUserId: string,
  peerUserId: string,
  peerSharingPubkeyHex: string,
  peerSigningPubkeyHex: string,
): string {
  if (!sodium) throw new Error('Crypto not initialized');
  if (!sharingPublicKey) throw new Error('No sharing public key loaded');
  if (!signingPublicKeyBytes) throw new Error('No signing public key loaded');

  const selfUuid = uuidToBytes(selfUserId);
  const peerUuid = uuidToBytes(peerUserId);
  const peerSharing = hexToBytes(peerSharingPubkeyHex);
  const peerSigning = hexToBytes(peerSigningPubkeyHex);
  if (peerSharing.length !== 32 || peerSigning.length !== 32) {
    throw new Error('peer pubkeys must be 32 bytes each');
  }

  const materialSelf = new Uint8Array(80);
  materialSelf.set(selfUuid, 0);
  materialSelf.set(sharingPublicKey, 16);
  materialSelf.set(signingPublicKeyBytes, 48);

  const materialPeer = new Uint8Array(80);
  materialPeer.set(peerUuid, 0);
  materialPeer.set(peerSharing, 16);
  materialPeer.set(peerSigning, 48);

  // Lex-min ordering so peer.computeSafetyNumber(self) gives the same
  // SAS as self.computeSafetyNumber(peer).
  const aLessB = (() => {
    for (let i = 0; i < 80; i++) {
      if (materialSelf[i] < materialPeer[i]) return true;
      if (materialSelf[i] > materialPeer[i]) return false;
    }
    return false;
  })();
  const combined = new Uint8Array(160);
  if (aLessB) { combined.set(materialSelf, 0); combined.set(materialPeer, 80); }
  else        { combined.set(materialPeer, 0); combined.set(materialSelf, 80); }

  const sasKey = blake3DeriveKey(SAS_CONTEXT_KEY, new TextEncoder().encode('safety_number'));
  const fullHash = blake3KeyedHash(sasKey, combined);
  const sasBytes = fullHash.slice(0, 30);

  // 30 bytes → 60-digit decimal string, zero-padded → 12 groups of 5.
  let big = 0n;
  for (let i = 0; i < sasBytes.length; i++) big = (big << 8n) | BigInt(sasBytes[i]);
  const sasDigits = big.toString(10).padStart(60, '0');
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) groups.push(sasDigits.slice(i * 5, i * 5 + 5));
  return groups.join(' ');
}

// ============================================================================
// Identities from before a password reset
// ============================================================================
//
// note's vault key is DERIVED from the sharing private key:
//
//     vaultKey = BLAKE2b-256(sharing private key, "pingolin-note-vault")
//
// so an email password reset — which replaces that keypair — changes the vault
// key and makes EVERY note undecryptable at once. Not lost: the ciphertext is
// untouched and the earlier key is recoverable, but until it is, the app shows
// an account full of notes it cannot read.
//
// If the user still had their recovery key, the account portal recovers that
// identity and seals it under a value derived from the key we already hold:
//
//     wrap = BLAKE2b-256(current sharing private key, "pingolin.previous-identity")
//
// Same construction, different label, so neither derived key can stand in for
// the other. From each recovered private key we re-derive that era's vault key
// and use it ONLY as a fallback, after the current one has failed.

export const PREVIOUS_IDENTITY_LABEL = 'pingolin.previous-identity';
export const VAULT_LABEL = 'pingolin-note-vault';

/** BLAKE2b keyed by a label — the one derivation all three apps share. */
export function deriveAppKey(privateKey: Uint8Array, label: string): Uint8Array {
  if (!sodium) throw new Error('Crypto not ready');
  return sodium.crypto_generichash(32, privateKey, sodium.from_string(label));
}

/** Open a base64 secretbox blob with a key we already hold. */
export function decryptWithKey(
  blob: { nonce: string; ciphertext: string },
  key: Uint8Array,
): Uint8Array {
  if (!sodium) throw new Error('Crypto not ready');
  return sodium.crypto_secretbox_open_easy(
    sodium.from_base64(blob.ciphertext, sodium.base64_variants.ORIGINAL),
    sodium.from_base64(blob.nonce, sodium.base64_variants.ORIGINAL),
    key,
  );
}

/** The current sharing private key, or null before keys are loaded. */
export function getSharingPrivateKey(): Uint8Array | null {
  return sharingPrivateKey;
}

/**
 * Vault keys from before a reset. Read-only: nothing WRAPS with these, so no
 * note is ever written back under an identity the user has moved off.
 */
let previousVaultKeys: Uint8Array[] = [];

export function setPreviousIdentityKeys(privateKeys: Uint8Array[]): void {
  for (const k of previousVaultKeys) {
    try { sodium?.memzero(k); } catch { k.fill(0); }
  }
  previousVaultKeys = privateKeys.map((pk) => deriveAppKey(pk, VAULT_LABEL));
}

/**
 * Previous VAULT keys handed over as such — the iOS key-bridge shell derives
 * them natively (op `previousVaultKeys`) so no recovered private key ever
 * enters the page. Same slot, same read-only use as setPreviousIdentityKeys.
 */
export function setPreviousVaultKeys(vaultKeys: Uint8Array[]): void {
  for (const k of previousVaultKeys) {
    try { sodium?.memzero(k); } catch { k.fill(0); }
  }
  previousVaultKeys = vaultKeys.filter(k => k.length === 32);
}

/**
 * ADD vault keys to what this page holds; never replace it. A re-check
 * after a restore may only widen what opens here: an empty, stale or wrong
 * answer leaves every key already held in place. Returns how many were new.
 */
export function addPreviousVaultKeys(vaultKeys: Uint8Array[]): number {
  let added = 0;
  for (const k of vaultKeys) {
    if (k.length !== 32) continue;
    if (previousVaultKeys.some((held) => sameBytes(held, k))) continue;
    previousVaultKeys = [...previousVaultKeys, k];
    added++;
  }
  return added;
}

/** {@link addPreviousVaultKeys} for recovered private keys, derived exactly as
 *  setPreviousIdentityKeys derives them. */
export function addPreviousIdentityKeys(privateKeys: Uint8Array[]): number {
  return addPreviousVaultKeys(privateKeys.map((pk) => deriveAppKey(pk, VAULT_LABEL)));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function hasPreviousVaultKeys(): boolean {
  return previousVaultKeys.length > 0;
}

export function getPreviousVaultKeys(): Uint8Array[] {
  return previousVaultKeys;
}
