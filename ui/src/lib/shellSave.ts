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
 * Hand a file to the Android shell for saving.
 *
 * A WebView cannot download a `blob:` URL: `<a download>` does nothing
 * (there is no download UI) and DownloadManager cannot fetch blob: schemes —
 * so attachment "Download" and the backup export would silently do nothing
 * in the app. The shell registers an origin-scoped WebMessageListener named
 * `pingolinSave` (WebViewCompat.addWebMessageListener), which injects a
 * `window.pingolinSave` object into documents on our origin only; the page
 * posts `{filename, mimeType, dataBase64}` and the shell writes it into the
 * device's Downloads via MediaStore.
 *
 * Same additive-hook posture as `__pingolinNavigate`: in a browser (or an old
 * APK) the object is absent, [shellSaveAvailable] is false, and callers keep
 * the anchor-download path that works everywhere else.
 *
 * Base64 because WebMessageListener carries strings (and transferable
 * ArrayBuffers only on newer WebViews); chunked encoding because a single
 * `String.fromCharCode(...bytes)` overflows the argument limit long before a
 * real attachment does. The size cap exists because the message crosses the
 * bridge as ONE string: past ~24MB of base64 the copy itself becomes a jank
 * and OOM hazard, and a file that large deserves a streamed design rather
 * than a quiet failure — callers surface the limit instead.
 */

import { toB64Fast } from './fastBase64';

type ShellSaveWindow = Window & {
  pingolinSave?: { postMessage(message: string): void };
};

export const SHELL_SAVE_MAX_BYTES = 18 * 1024 * 1024;

export function shellSaveAvailable(): boolean {
  return typeof (window as ShellSaveWindow).pingolinSave?.postMessage === 'function';
}

// Encoding lives in fastBase64.ts: a chunked String.fromCharCode loop is
// 8x SLOWER than even sodium's WASM at these sizes, and a save payload can
// be 18MB — a third of a second of main-thread jank.

/**
 * Returns true when the file was handed to the shell, false when the shell
 * hook is unavailable or the payload exceeds [SHELL_SAVE_MAX_BYTES] — in
 * either case the caller decides the fallback (anchor download in a browser;
 * a visible "too large" message in the shell, never silence).
 *
 * ⚠️ HANDED OVER IS NOT SAVED. `true` here means `postMessage` returned,
 * which is the bridge accepting the string, not the file reaching disk. The
 * write happens AFTER this resolves: on Android a MediaStore insert into
 * Downloads, on iOS a share sheet the user can dismiss. Either can fail — no
 * space, a revoked permission, a cancelled sheet — and the page is not told:
 * the WebMessageListener is one-way as used here, with no reply that carries
 * the outcome. So a caller can prove the file was OFFERED and nothing more —
 * treat a `true` as "the shell has it", not "the user has it".
 */
export async function shellSave(
  filename: string,
  mimeType: string,
  data: Blob | string,
): Promise<boolean> {
  const hook = (window as ShellSaveWindow).pingolinSave;
  if (!hook) return false;
  const bytes = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : new Uint8Array(await data.arrayBuffer());
  if (bytes.length > SHELL_SAVE_MAX_BYTES) return false;
  hook.postMessage(JSON.stringify({
    filename,
    mimeType: mimeType || 'application/octet-stream',
    dataBase64: toB64Fast(bytes),
  }));
  return true;
}
