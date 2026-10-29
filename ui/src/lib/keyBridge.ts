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
 * The Note iOS app's key bridge, contract v1.
 *
 * The iOS shell loads this page live from the note origin, so whatever the
 * server serves runs with whatever the shell hands it. So the shell hands
 * over only the vault key and the two PUBLIC keys — never the account's
 * X25519 sharing private key (which also opens every Track circle key) or
 * the Ed25519 signing secret — and answers the few private-key operations
 * the page needs over a native message channel that never returns a
 * private key.
 *
 * No imports on purpose: crypto.ts consults `bridgeMarker()` while restoring
 * keys, and keyOps.ts (which imports crypto.ts) does the calling.
 */

export interface KeyBridgeMarker {
  version: 1;
  /** The device holds the account's real Ed25519 seed and will sign. */
  signing: boolean;
}

type BridgeWindow = {
  __pingolinKeyBridge?: unknown;
  webkit?: { messageHandlers?: { pingolinKeys?: { postMessage: (m: unknown) => Promise<unknown> } } };
};

function bridgeWindow(): BridgeWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as BridgeWindow);
}

/**
 * The shell's marker, or null outside the iOS shell. Written by a
 * document-start script before any page script runs, so it is safe to read
 * synchronously during key restore. Anything that is not exactly version 1 is
 * local-key mode: a browser, the Android shell, or an older iOS build.
 */
export function bridgeMarker(): KeyBridgeMarker | null {
  const m = bridgeWindow()?.__pingolinKeyBridge as { version?: unknown; signing?: unknown } | undefined;
  if (!m || typeof m !== 'object' || m.version !== 1) return null;
  return { version: 1, signing: m.signing === true };
}

/** True inside the iOS shell that keeps the private keys native. */
export function inBridgeMode(): boolean {
  return bridgeMarker() !== null;
}

/**
 * One request over the channel. Resolves with the native reply; REJECTS when
 * the bridge itself could not run (origin, signed out, malformed request) —
 * callers must treat that as "try again later", never as "this share is bad".
 */
export async function callKeyBridge<T>(request: { op: string } & Record<string, unknown>): Promise<T> {
  const handler = bridgeWindow()?.webkit?.messageHandlers?.pingolinKeys;
  if (!handler) throw new Error('key bridge unavailable');
  return (await handler.postMessage(request)) as T;
}
