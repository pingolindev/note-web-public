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
 * The Pingolin encrypted-backup container.
 *
 * WHY THIS EXISTS
 *   An export is a plaintext file. For a one-off portability request that is
 *   fine — the user asks for it, reads it, and does something with it. As a
 *   BACKUP it is materially worse, because a backup is by definition a file
 *   people keep: it goes to a cloud drive, a USB stick, an email to themselves,
 *   and it sits there. For Track that file is a complete history of where
 *   someone has been; for Note it is everything they have written. Neither
 *   should rest unprotected just because the product that made it is E2EE.
 *
 *   So: a passphrase seals the file. Sealing is OPT-IN, because the plaintext
 *   form is what makes the export useful for portability — the point of Article
 *   20 is that another tool can read it. Supplying a passphrase turns a
 *   portability export into a backup; leaving it blank keeps the plain export.
 *
 * THE FORMAT (v1)
 *   A JSON envelope, not a binary blob, so the file survives being emailed,
 *   pasted into a text field, or stored by something that assumes text. The
 *   payload is the ordinary backup JSON, sealed with XChaCha20-Poly1305 under a
 *   key derived from the passphrase with Argon2id.
 *
 *   The KDF parameters live IN the header, so raising them later does not
 *   orphan existing files — a reader uses whatever the file says it used.
 *   Editing them down does not help an attacker: they are inputs to the
 *   derivation, so a changed value simply yields a different key and the file
 *   stops opening at all.
 *
 *   The whole header is ALSO bound in as AEAD associated data, which covers the
 *   fields the KDF does not touch — `product`, `format`, `formatVersion`,
 *   `cipher`. Without that, those are free for an attacker to rewrite on a file
 *   that still decrypts: relabel a Track backup as a Note one and it sails into
 *   whichever reader was not expecting it.
 *
 *   Pingolin Track's backups use the same container: same magic, same version,
 *   same parameter names — a backup written by one product must at least be
 *   RECOGNISED by the other, even though the payload inside is product-specific.
 */

import { fromB64Fast, toB64Fast } from './fastBase64';

/**
 * Argon2id lives in the SUMO build, which the standard `libsodium-wrappers`
 * this app otherwise uses does not include. Imported dynamically so that ~1 MB
 * of WASM is fetched only when someone actually writes or opens a sealed
 * backup, rather than on every page load for a feature most sessions never
 * touch. Loaded once and reused.
 */
type Sodium = typeof import('libsodium-wrappers-sumo');
let sodiumPromise: Promise<Sodium> | null = null;
async function loadSodium(): Promise<Sodium> {
  if (!sodiumPromise) {
    sodiumPromise = import('libsodium-wrappers-sumo').then(async (m) => {
      const s = (m as any).default ?? m;
      await s.ready;
      return s as Sodium;
    });
  }
  return sodiumPromise;
}

export const CONTAINER_FORMAT = 'pingolin-encrypted-backup';
export const CONTAINER_VERSION = 1;

/**
 * Argon2id work factors.
 *
 * Deliberately heavier than the login KDF (auth uses m=47 MiB, t=1): a login
 * runs on every sign-in and its budget is the user's patience, while this runs
 * once per export and once per restore. The file is also the most exposed
 * artifact the product produces — it outlives sessions and travels — so it is
 * worth a second of work. Recorded in the header, so raising them leaves
 * existing files readable.
 */
export const KDF_MEMORY_KIB = 65536; // 64 MiB
export const KDF_ITERATIONS = 3;
const SALT_BYTES = 16;

export interface EncryptedContainer {
  format: typeof CONTAINER_FORMAT;
  formatVersion: number;
  /** Which product wrote it, so a reader can refuse a Note backup fed to Track. */
  product: string;
  createdAt: string;
  kdf: {
    algorithm: 'argon2id';
    memoryKib: number;
    iterations: number;
    salt: string;
  };
  cipher: 'xchacha20poly1305-ietf';
  nonce: string;
  ciphertext: string;
}

const b64 = (sodium: Sodium, b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
const unb64 = (sodium: Sodium, s: string) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

/**
 * Everything the reader must agree with the writer about, as bytes.
 *
 * Bound into the AEAD as associated data.
 *
 * The KDF fields in here are belt-and-braces — they already influence the key,
 * so tampering with them breaks decryption on its own. What this genuinely
 * protects are the fields the derivation never sees: `product`, `format`,
 * `formatVersion` and `cipher`. Those would otherwise be freely editable on a
 * file that still opens, which is how a backup ends up being read by the wrong
 * product's parser.
 */
function headerAad(sodium: Sodium, c: Omit<EncryptedContainer, 'ciphertext'>): Uint8Array {
  return sodium.from_string(JSON.stringify({
    format: c.format,
    formatVersion: c.formatVersion,
    product: c.product,
    kdf: c.kdf,
    cipher: c.cipher,
    nonce: c.nonce,
  }));
}

function deriveKey(sodium: Sodium, passphrase: string, salt: Uint8Array, memoryKib: number, iterations: number): Uint8Array {
  return sodium.crypto_pwhash(
    sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
    passphrase,
    salt,
    iterations,
    memoryKib * 1024,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

/** Seal a backup document under a passphrase. */
export async function sealBackup(payload: unknown, passphrase: string, product: string): Promise<EncryptedContainer> {
  if (!passphrase) throw new Error('A passphrase is required to encrypt a backup.');
  const sodium = await loadSodium();

  const salt = sodium.randombytes_buf(SALT_BYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const key = deriveKey(sodium, passphrase, salt, KDF_MEMORY_KIB, KDF_ITERATIONS);

  const header: Omit<EncryptedContainer, 'ciphertext'> = {
    format: CONTAINER_FORMAT,
    formatVersion: CONTAINER_VERSION,
    product,
    createdAt: new Date().toISOString(),
    kdf: { algorithm: 'argon2id', memoryKib: KDF_MEMORY_KIB, iterations: KDF_ITERATIONS, salt: b64(sodium, salt) },
    cipher: 'xchacha20poly1305-ietf',
    nonce: b64(sodium, nonce),
  };

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(JSON.stringify(payload)),
    headerAad(sodium, header),
    null,
    nonce,
    key,
  );
  sodium.memzero(key);

  // The container blob is the whole vault — the one payload here that is
  // large enough for the codec to matter (see lib/fastBase64.ts).
  return { ...header, ciphertext: toB64Fast(ciphertext, (v) => b64(sodium, v)) };
}

/** Does this parsed JSON look like a sealed container rather than a plain backup? */
export function isEncryptedContainer(parsed: unknown): parsed is EncryptedContainer {
  return typeof parsed === 'object' && parsed !== null
    && (parsed as any).format === CONTAINER_FORMAT
    && typeof (parsed as any).ciphertext === 'string';
}

export type OpenResult =
  | { ok: true; payload: unknown }
  | { ok: false; error: string; wrongPassphrase?: boolean };

/**
 * Open a sealed backup.
 *
 * A failed tag is reported as a wrong passphrase, which is what it almost
 * always is — but note it is ALSO what a tampered file looks like, and the
 * message says so rather than implying the file is fine and the user is wrong.
 */
export async function openBackup(container: unknown, passphrase: string): Promise<OpenResult> {
  if (!isEncryptedContainer(container)) {
    return { ok: false, error: 'That file is not an encrypted Pingolin backup.' };
  }
  if (container.formatVersion > CONTAINER_VERSION) {
    // Refuse rather than guess: a future container may seal differently, and
    // "decrypted" with the wrong assumptions is worse than "cannot open".
    return {
      ok: false,
      error: `This backup was written by a newer version of Pingolin (container ${container.formatVersion}). Update the app, then open it.`,
    };
  }
  if (container.kdf?.algorithm !== 'argon2id' || container.cipher !== 'xchacha20poly1305-ietf') {
    return { ok: false, error: 'This backup uses encryption this version does not understand.' };
  }
  if (!passphrase) return { ok: false, error: 'Enter the passphrase for this backup.' };

  // Refuse absurd parameters instead of trying to honour them: a hostile file
  // could otherwise ask for gigabytes of Argon2 memory and hang or crash the
  // tab before the tag check ever runs.
  const memoryKib = container.kdf.memoryKib;
  const iterations = container.kdf.iterations;
  if (!Number.isFinite(memoryKib) || memoryKib < 8192 || memoryKib > 1048576
      || !Number.isFinite(iterations) || iterations < 1 || iterations > 10) {
    return { ok: false, error: 'This backup declares encryption settings outside the supported range.' };
  }

  try {
    const sodium = await loadSodium();
    const salt = unb64(sodium, container.kdf.salt);
    const nonce = unb64(sodium, container.nonce);
    const key = deriveKey(sodium, passphrase, salt, memoryKib, iterations);
    const { ciphertext, ...header } = container;
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromB64Fast(ciphertext, (v) => unb64(sodium, v)),
      headerAad(sodium, header as Omit<EncryptedContainer, 'ciphertext'>),
      nonce,
      key,
    );
    sodium.memzero(key);
    return { ok: true, payload: JSON.parse(sodium.to_string(plain)) };
  } catch {
    return {
      ok: false,
      wrongPassphrase: true,
      error: 'That passphrase did not open this backup. If you are sure it is right, the file may have been altered.',
    };
  }
}
