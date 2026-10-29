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
 * Auth Helpers - Shared authentication utilities
 *
 * Extracts common authentication logic to reduce duplication in auth store.
 */

import type { EncryptedData } from '../lib/crypto';
import { accountFetch } from '../lib/account';

// libsodium loaded lazily — ~140 kB gzipped, only needed when the
// auth flow has encrypted keys to process. Most app paths never
// call processEncryptedKeys.

/**
 * Raw encrypted keys data from server response
 */
export interface EncryptedKeysData {
  master_key: {
    nonce: string;
    ciphertext: string;
  };
  sharing_private_key: {
    nonce: string;
    ciphertext: string;
  };
}

/**
 * Raw KDF parameters from server response
 */
export interface KdfParamsData {
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
}

/**
 * Server response containing encrypted keys and KDF params
 */
export interface AuthResponseWithKeys {
  encrypted_keys?: EncryptedKeysData;
  kdf_params?: KdfParamsData;
}

/**
 * Convert server KDF params to internal format
 */
export function convertKdfParams(params: KdfParamsData) {
  return {
    salt: params.salt,
    memoryKib: params.memory_kib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };
}

/**
 * Convert server encrypted key to crypto module format
 */
export function convertEncryptedKey(key: { nonce: string; ciphertext: string }): EncryptedData {
  return {
    nonce: key.nonce,
    ciphertext: key.ciphertext,
  };
}

/**
 * Process encrypted keys from login/2FA response.
 *
 * This function:
 * 1. Initializes the crypto module
 * 2. Converts server response format to internal format
 * 3. Decrypts the user's private keys using their password
 * 4. Persists the keys to local storage
 * 5. Returns the client key for server storage
 *
 * @param data - Server response with encrypted keys and KDF params
 * @param password - User's password for key derivation
 * @returns The client key for server storage, or null if no keys were processed
 * @throws If key decryption fails
 */
export async function processEncryptedKeys(
  data: AuthResponseWithKeys,
  password: string
): Promise<string | null> {
  if (
    !data.encrypted_keys?.master_key ||
    !data.encrypted_keys?.sharing_private_key ||
    !data.kdf_params
  ) {
    console.warn('[Note] No encrypted keys from server — cross-origin federation unavailable');
    return null;
  }

  try {
    const { default: sodiumLib } = await import('libsodium-wrappers');
    await sodiumLib.ready;
    const sodium = sodiumLib;

    const kdf = data.kdf_params;

    // 1. Derive master key from password using Argon2id (same as track/account portal)
    const salt = sodium.from_base64(kdf.salt, sodium.base64_variants.ORIGINAL);
    const masterKeyDerived = sodium.crypto_pwhash(
      32,
      password,
      salt,
      kdf.iterations,
      kdf.memory_kib * 1024,
      sodium.crypto_pwhash_ALG_ARGON2ID13
    );

    // 2. Decrypt master key using password-derived key (NaCl secretbox / XSalsa20-Poly1305)
    const mkNonce = sodium.from_base64(data.encrypted_keys.master_key.nonce, sodium.base64_variants.ORIGINAL);
    const mkCiphertext = sodium.from_base64(data.encrypted_keys.master_key.ciphertext, sodium.base64_variants.ORIGINAL);
    const masterKey = sodium.crypto_secretbox_open_easy(mkCiphertext, mkNonce, masterKeyDerived);
    sodium.memzero(masterKeyDerived);

    if (!masterKey || masterKey.length !== 32) {
      throw new Error('Failed to decrypt master key');
    }

    // 3. Decrypt sharing private key using master key
    const skNonce = sodium.from_base64(data.encrypted_keys.sharing_private_key.nonce, sodium.base64_variants.ORIGINAL);
    const skCiphertext = sodium.from_base64(data.encrypted_keys.sharing_private_key.ciphertext, sodium.base64_variants.ORIGINAL);
    const sharingPrivateKey = sodium.crypto_secretbox_open_easy(skCiphertext, skNonce, masterKey);
    sodium.memzero(masterKey);

    if (!sharingPrivateKey || sharingPrivateKey.length !== 32) {
      throw new Error('Failed to decrypt sharing private key');
    }

    // 4. Generate client key and encrypt private key for cross-origin storage (Proton-style)
    const clientKey = sodium.randombytes_buf(32);
    const encNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const encryptedPrivateKey = sodium.crypto_secretbox_easy(sharingPrivateKey, encNonce, clientKey);
    sodium.memzero(sharingPrivateKey);

    // 5. Store encrypted private key on server.
    // Upload ONLY the ciphertext — the wrapping key (client_key) is
    // never sent to the server. (The account portal is the authoritative writer
    // of this blob at login and hands the wrapping key to note-ui via the
    // redirect fragment; this local path is a legacy fallback.)
    const clientKeyB64 = sodium.to_base64(clientKey, sodium.base64_variants.ORIGINAL);
    const apiUrl = import.meta.env.VITE_API_URL || '/api/v1';
    await accountFetch(`${apiUrl}/auth/client-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        encrypted_private_key: sodium.to_base64(encryptedPrivateKey, sodium.base64_variants.ORIGINAL),
        encrypted_private_key_nonce: sodium.to_base64(encNonce, sodium.base64_variants.ORIGINAL),
      }),
    });

    console.log('[Note] Cross-origin E2EE keys stored for federation');
    return clientKeyB64;
  } catch (err) {
    console.error('[Note] Failed to process keys for federation:', err);
    return null;
  }
}

/**
 * Legacy no-op retained for API symmetry.
 *
 * Do NOT restore a body here. POSTing the wrapping key (client_key) to the
 * server is exactly the escrow that would let the server decrypt users'
 * private keys. The ciphertext is uploaded by processEncryptedKeys (and,
 * authoritatively, by the account portal at login), so there is nothing this
 * can legitimately do.
 */
export async function storeClientKeyOnServer(
  _clientKey?: string,
  _apiUrl: string = ''
): Promise<boolean> {
  return true;
}

/**
 * Response from client-key endpoint with encrypted private key for cross-origin E2EE
 */
export interface ClientKeyResponse {
  client_key: string | null;
  encrypted_private_key?: string;
  encrypted_private_key_nonce?: string;
}

/**
 * Retrieve client key and encrypted private key from server.
 * The encrypted private key enables cross-origin E2EE (Proton-style).
 *
 * @param apiUrl - Base API URL
 * @returns Client key data or null if not found
 */
export async function getClientKeyFromServer(apiUrl: string = ''): Promise<ClientKeyResponse | null> {
  try {
    const response = await accountFetch(`${apiUrl}/auth/client-key`, {
      credentials: 'include',
    });

    if (response.ok) {
      const data = await response.json();
      // The server never stores the wrapping key (client_key is always null).
      // Gate on the ciphertext; the wrapping key comes from the redirect
      // fragment or localStorage, never from the server.
      if (data.data?.encrypted_private_key) {
        return {
          client_key: data.data.client_key ?? null,
          encrypted_private_key: data.data.encrypted_private_key,
          encrypted_private_key_nonce: data.data.encrypted_private_key_nonce,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Process encrypted keys and store client key on server.
 *
 * Convenience function that combines processEncryptedKeys and storeClientKeyOnServer.
 *
 * @param data - Server response with encrypted keys and KDF params
 * @param password - User's password for key derivation
 * @param apiUrl - Base API URL (optional)
 * @returns true if keys were processed successfully, false otherwise
 */
export async function processAndPersistKeys(
  data: AuthResponseWithKeys,
  password: string,
  apiUrl: string = ''
): Promise<boolean> {
  try {
    const clientKey = await processEncryptedKeys(data, password);

    if (clientKey) {
      await storeClientKeyOnServer(clientKey, apiUrl);
    }

    return true;
  } catch {
    // Key decryption failed - user may need to re-register
    // Continue login but E2EE features won't work
    return false;
  }
}
