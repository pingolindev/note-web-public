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

import type { Plugin } from 'vite';

/**
 * Every font this app uses ships three encodings of the same glyphs — KaTeX's
 * stylesheet and @fontsource both list `woff2, woff, truetype` in one `src:`.
 * A browser downloads only the FIRST format it understands, so on every engine
 * that can run this esnext build the woff and ttf copies are never fetched —
 * but Vite still emits them, and the Note Android build copies the whole
 * `dist` into the APK as the offline bundle, where they are dead weight a user
 * carries on their phone.
 *
 * This drops them at the source: the `src:` list keeps its woff2 entry, the
 * other two url()s are removed from the emitted CSS, and the orphaned font
 * assets are deleted from the bundle.
 *
 * woff2 is supported by every browser this app targets and by Android
 * WebView since Chromium 36; there is no engine that reaches this build and
 * needs the fallbacks.
 */
export function woff2Only(): Plugin {
  const DROP = /\.(woff|ttf|otf|eot)$/;
  return {
    name: 'pingolin-woff2-only',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      // 1. Strip the non-woff2 url()s out of every emitted stylesheet.
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue;
        const css = typeof file.source === 'string'
          ? file.source
          : Buffer.from(file.source).toString('utf8');
        file.source = css.replace(
          /,\s*url\([^)]*\.(?:woff|ttf|otf|eot)\)\s*format\((?:"|')[^"']*(?:"|')\)/g,
          '',
        );
      }
      // 2. Delete the now-unreferenced font assets.
      let dropped = 0;
      let bytes = 0;
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type !== 'asset' || !DROP.test(file.fileName)) continue;
        bytes += typeof file.source === 'string'
          ? Buffer.byteLength(file.source)
          : file.source.byteLength;
        delete bundle[name];
        dropped++;
      }
      if (dropped > 0) {
        this.info(`woff2-only: dropped ${dropped} font files (${bytes} bytes)`);
      }
    },
  };
}
