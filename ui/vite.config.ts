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

import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import path from 'path';
import { woff2Only } from './vite-woff2-only';

export default defineConfig({
  plugins: [solidPlugin(), woff2Only()],
  server: {
    port: 3003,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'esnext',
    modulePreload: { polyfill: false },
    /**
     * NEVER inline a font, whatever its size.
     *
     * Vite inlines any asset under `assetsInlineLimit` (4096 bytes by default)
     * as a `data:` URI — and the editor's CSP (sent by the server that hosts
     * it) says `font-src 'self'`, which does not permit `data:`. The browser refuses the font and the page
     * carries on silently.
     *
     * One font is small enough to hit this: KaTeX_Size3, 3,641 bytes, where
     * the other 19 KaTeX faces are larger and are emitted as files. Inlined,
     * it would make large delimiters — the tall parentheses, brackets, sums
     * and integrals KaTeX draws at display size — fall back to a substitute on
     * every client, announced only by a console error the native shells log as
     * `web console ERROR: Refused to load the font 'data:font/woff2;…'`.
     *
     * Emitting it as a file rather than widening the CSP to `data:` also means
     * it is cached on its own, instead of being re-downloaded inside the
     * stylesheet whenever any other rule in that stylesheet changes.
     */
    assetsInlineLimit: (filePath: string) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
    commonjsOptions: {
      include: [/libsodium/, /node_modules/],
    },
  },
  // ES-module worker (attachmentCryptoWorker.ts): lets the worker use the same
  // ESM libsodium import shape as crypto.ts and builds cleanly under Vite's
  // separate worker compilation. The worker + its libsodium copy are emitted as
  // their OWN chunk, fetched lazily only when a large attachment is first
  // encrypted/decrypted, so it never weighs on initial page load. Module workers
  // are supported by every browser this esnext build targets; attachmentCrypto.ts
  // falls back to the synchronous main-thread AEAD where Worker is unavailable.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    include: ['libsodium-wrappers', 'libsodium-wrappers-sumo'],
  },
  resolve: {
    alias: {
      // The sumo build is here ONLY for the backup container's Argon2id — the
      // standard libsodium-wrappers build this app otherwise uses does not
      // include crypto_pwhash. Aliased to the CJS entry because the ESM one
      // imports `./libsodium-sumo.mjs` as a sibling, which lives in a different
      // package directory and does not resolve.
      'libsodium-wrappers-sumo': path.resolve(
        __dirname,
        'node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
      ),
    },
  },
});
