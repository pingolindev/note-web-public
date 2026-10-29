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
 * Bake this build's precache list into `dist/sw.js`.
 *
 * `public/sw.js` ships two placeholders. In `vite dev` they are literally
 * `'__BUILD_ID__'` and `__PRECACHE_URLS__`, which is deliberate: an empty
 * precache list makes `install` cache nothing and every fetch fall through to
 * the network, so the dev server behaves as if there were no precache at all.
 * `vite build` copies the file verbatim, and this script rewrites it.
 *
 * WHY A SCRIPT AND NOT A PLUGIN. The list has to be the assets Vite actually
 * emitted, which is only knowable after the build. Reading `dist/` is the
 * smallest thing that is always right; a hand-maintained list drifts silently,
 * and the drift is invisible until someone is offline.
 *
 * WHAT GOES IN, AND WHAT DOES NOT. Everything under `assets/` plus the document
 * itself. Not the favicon (nice to lose, not fatal), and emphatically not
 * `sw.js` — a service worker caching itself is how a bad one becomes permanent.
 *
 * THE BUILD ID IS A HASH OF THE CONTENT, not a timestamp or a version. Two
 * builds of identical output share a cache and skip a pointless re-download;
 * any real change gets a new cache, and `activate` deletes the one it replaces.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const SW = join(DIST, 'sw.js');

if (!existsSync(SW)) {
  console.error('inject-sw-precache: dist/sw.js missing — did vite build run?');
  process.exit(1);
}

/** Every emitted asset, as a root-relative URL — recursively, so a nested
 *  asset directory is listed rather than silently omitted. */
function walk(dir, prefix) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), `${prefix}/${entry.name}`));
    else if (entry.isFile()) out.push(`${prefix}/${entry.name}`);
  }
  return out;
}
const assetsDir = join(DIST, 'assets');
const assets = existsSync(assetsDir) ? walk(assetsDir, '/assets').sort() : [];

if (!assets.length) {
  console.error('inject-sw-precache: no assets found — refusing to ship an empty precache');
  process.exit(1);
}

// The document last: if it is cached, its assets already are.
const precache = [...assets, '/index.html'];

/**
 * The document must reference only assets in this list — checked HERE, at
 * build time, as well as in the worker at install time. The worker's check is
 * what catches a rolling-deploy mismatch in the field; this one catches a
 * BUILD whose index.html names an emitted path outside dist/assets, which the
 * runtime check would otherwise reject on every device, silently, forever.
 * Fail the build instead.
 */
const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf-8');
const listed = new Set(precache);
const unlisted = [...new Set([...indexHtml.matchAll(/\/assets\/[^"'\s)]+/g)].map((m) => m[0]))]
  .filter((ref) => !listed.has(ref));
if (unlisted.length) {
  console.error(`inject-sw-precache: index.html references assets not in the precache list — refusing: ${unlisted.join(', ')}`);
  process.exit(1);
}

/**
 * Content hash over the emitted bytes, not just the names.
 *
 * Names alone would be enough while every asset is content-hashed — but
 * `index.html` is not, and it is the one file whose change must invalidate the
 * cache. Hashing bytes covers both without having to reason about which is
 * which.
 */
const hash = createHash('sha256');
for (const url of precache) {
  const file = join(DIST, url.replace(/^\//, ''));
  hash.update(url);
  hash.update(readFileSync(file));
}
const buildId = hash.digest('hex').slice(0, 12);

const src = readFileSync(SW, 'utf-8');

/**
 * The two placeholders, as the exact code they sit in — not the bare token.
 *
 * `String.prototype.replace` with a string pattern rewrites the FIRST match
 * only, so a token that also appears in a comment above the code would get
 * the replacement and the code would keep the placeholder, with the build
 * still reporting success. Matching the surrounding code and insisting on
 * exactly one occurrence closes that.
 */
const BUILD_ID_SLOT = "const BUILD_ID = '__BUILD_ID__';";
const PRECACHE_SLOT = '([] /* __PRECACHE_URLS__ */)';
for (const [name, slot] of [['BUILD_ID', BUILD_ID_SLOT], ['PRECACHE', PRECACHE_SLOT]]) {
  const n = src.split(slot).length - 1;
  if (n !== 1) {
    console.error(`inject-sw-precache: expected exactly one ${name} slot in dist/sw.js, found ${n} — has public/sw.js changed?`);
    process.exit(1);
  }
}

// Function replacements: a string replacement interprets `$&`, `$'` and
// `` $` `` in the REPLACEMENT text, and an asset named with a `$` (Vite keeps
// the source basename in `[name]-[hash]`) would expand into garbage.
const out = src
  .replace(BUILD_ID_SLOT, () => `const BUILD_ID = ${JSON.stringify(buildId)};`)
  .replace(PRECACHE_SLOT, () => `(${JSON.stringify(precache)})`);

// Defence in depth on the CODE only: the header comment names these tokens
// while explaining them, and a comment is not a placeholder.
const codeOnly = out.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
if (codeOnly.includes('__BUILD_ID__') || codeOnly.includes('__PRECACHE_URLS__')) {
  console.error('inject-sw-precache: a placeholder survived injection — refusing to ship it');
  process.exit(1);
}

writeFileSync(SW, out);
console.log(`inject-sw-precache: build ${buildId}, ${precache.length} entries precached`);
