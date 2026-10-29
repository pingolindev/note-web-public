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

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * How the web editor uses DOMPurify, pinned against these published advisories.
 * Every one of them needs an option or mode this app does not use:
 *
 *   GHSA-cg2g-xh64-v4q7 (critical)  SAFE_FOR_TEMPLATES
 *   GHSA-mrv2-3pqr-j5jr (high)      IN_PLACE, with a hook that removes a parent or sibling
 *   GHSA-p98j-92pf-mc4p (low)       IN_PLACE, with a node-removing afterSanitize hook
 *   GHSA-6688-9rhm-gjv2 (low)       IN_PLACE
 *   GHSA-c6gr-qvv4-5v3f (low)       PARSER_MEDIA_TYPE application/xhtml+xml
 *
 * Note bodies (anyone's who shares a note), KaTeX output and import
 * instructions all go through ONE call: sanitize(html, { USE_PROFILES: { html:
 * true } }), and its one hook only removes attributes. The lockfile is past
 * every advisory's range (3.4.17). If a change needs one of those options,
 * these tests make it a decision, not an accident.
 */
const src = join(__dirname, '..');
const root = join(src, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Comments quote what they explain; assert on code. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const app = files(src).map((p) => ({ p: p.slice(src.length + 1), c: code(readFileSync(p, 'utf-8')) }));
const sanitizer = app.find((f) => f.p === join('lib', 'sanitizeHtml.ts'))!;

describe('DOMPurify is used only in the way none of these advisories reaches', () => {
  it('one module imports it', () => {
    expect(app.filter((f) => /from 'dompurify'|require\('dompurify'\)|import\('dompurify'\)/.test(f.c)).map((f) => f.p)).toEqual([
      join('lib', 'sanitizeHtml.ts'),
    ]);
  });

  it('one call, the html profile and nothing else', () => {
    expect(sanitizer.c.match(/DOMPurify\.sanitize\(/g)).toHaveLength(1);
    expect(sanitizer.c).toContain('return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });');
  });

  it('no code anywhere sets the options the advisories need', () => {
    for (const option of ['SAFE_FOR_TEMPLATES', 'IN_PLACE', 'PARSER_MEDIA_TYPE']) {
      expect(app.filter((f) => f.c.includes(option)).map((f) => f.p), option).toEqual([]);
    }
  });

  it('the one hook removes attributes, never a node', () => {
    expect(sanitizer.c.match(/DOMPurify\.addHook\(/g)).toHaveLength(1);
    expect(sanitizer.c).toContain("DOMPurify.addHook('afterSanitizeAttributes', (node) => {");
    expect(sanitizer.c).toContain('node.removeAttribute(attr);');
    expect(sanitizer.c).not.toMatch(/\.remove\(\)|removeChild\(|replaceWith\(|\.parentNode/);
  });

  it('the lockfile installs a DOMPurify past every advisory (3.4.17 or later)', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf-8'));
    const version = String(lock.packages?.['node_modules/dompurify']?.version ?? '');
    const [major, minor, patch] = version.split('.').map(Number);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(major > 3 || (major === 3 && (minor > 4 || (minor === 4 && patch >= 17)))).toBe(true);
  });
});
