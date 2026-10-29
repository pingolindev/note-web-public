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
 * Base64 Utilities
 *
 * Base64url and base64 encoding/decoding helpers, shared by WebAuthn and
 * other callers.
 */

/**
 * Convert a Base64URL string to a Uint8Array.
 */
export function base64UrlToUint8Array(base64url: string): Uint8Array {
  // Convert base64url to standard base64
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');

  // Pad with '=' if needed
  const paddedBase64 = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4),
    '='
  );

  const binaryString = atob(paddedBase64);
  const bytes = new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes;
}

/**
 * Convert a Uint8Array to a Base64URL string.
 */
export function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  let binaryString = '';

  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }

  // Convert to base64
  const base64 = btoa(binaryString);

  // Convert base64 to base64url
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert an ArrayBuffer to a Base64URL string.
 */
export function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  return uint8ArrayToBase64Url(new Uint8Array(buffer));
}

/**
 * Convert a Base64URL string to an ArrayBuffer.
 */
export function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const uint8 = base64UrlToUint8Array(base64url);
  // Create a new ArrayBuffer and copy data to ensure correct type
  const buffer = new ArrayBuffer(uint8.length);
  new Uint8Array(buffer).set(uint8);
  return buffer;
}

/**
 * Convert a standard base64 string to base64url.
 */
export function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Convert a base64url string to standard base64.
 */
export function base64UrlToBase64(base64url: string): string {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
}

/**
 * Encode a string to base64.
 */
export function stringToBase64(str: string): string {
  return btoa(str);
}

/**
 * Decode a base64 string.
 */
export function base64ToString(base64: string): string {
  return atob(base64);
}

/**
 * Encode a string to base64url.
 */
export function stringToBase64Url(str: string): string {
  return base64ToBase64Url(btoa(str));
}

/**
 * Decode a base64url string.
 */
export function base64UrlToString(base64url: string): string {
  return atob(base64UrlToBase64(base64url));
}
