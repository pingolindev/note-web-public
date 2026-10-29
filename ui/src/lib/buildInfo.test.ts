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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The build identity has to survive a chain of hand-offs, and every link
 * is in a different language:
 *
 *   image build       --build-arg BUILD_VERSION=…
 *   Dockerfile        ARG -> ENV VITE_BUILD_…     (per-stage: must be in the
 *                                                  BUILD stage, not just the
 *                                                  production one)
 *   Vite              bakes VITE_* into the bundle
 *   SettingsPanel     shows it
 *
 * Nothing type-checks across those boundaries: a missing `ARG` in the build
 * stage, or a rename on either side, leaves the row reading "development
 * build" on a real deploy — which looks like a working feature. The image's
 * end of that chain is checked where the image is built; here the first
 * describe is the bundle's end of the binding, spelled out, and the second
 * exercises the function.
 */
const UI = join(__dirname, '..');
const PANEL = readFileSync(join(UI, 'components', 'SettingsPanel.tsx'), 'utf8');

/** Both names, everywhere: one list so a rename fails in one obvious place. */
const ARGS = ['BUILD_COMMIT', 'BUILD_VERSION'] as const;

describe('the build identity reaches the bundle', () => {
  it.each(ARGS)('buildInfo reads VITE_%s, the same name the Dockerfile writes', (name) => {
    expect(readFileSync(join(UI, 'lib', 'buildInfo.ts'), 'utf8')).toContain(`VITE_${name}`);
  });

  it('Settings actually renders it', () => {
    expect(PANEL).toContain("from '../lib/buildInfo'");
    expect(PANEL).toMatch(/buildInfo\(\)/);
    expect(PANEL).toMatch(/settings-about-value/);
  });

  it('puts the full sha where it can be copied, not just the short one', () => {
    expect(PANEL).toMatch(/title=\{build\.commit/);
  });
});

/**
 * buildInfo reads `import.meta.env` into module-level constants, so each case
 * stubs the env and re-imports. That is the only way to see what a REAL build
 * produces rather than what the source file says.
 */
async function withEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, '');
    else vi.stubEnv(k, v);
  }
  const mod = await import('./buildInfo');
  return mod.buildInfo();
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('what it shows', () => {
  it('names the image version and the commit, in that order', async () => {
    const b = await withEnv({
      VITE_BUILD_VERSION: '0.1.668',
      VITE_BUILD_COMMIT: '142524151c6337d5bf40ec6e5dc122fe835bf828',
    });
    expect(b.label).toBe('0.1.668 · 1425241');
    expect(b.version).toBe('0.1.668');
    expect(b.commit).toBe('142524151c6337d5bf40ec6e5dc122fe835bf828');
  });

  it('carries no build date, only the version and the commit', async () => {
    const b = await withEnv({
      VITE_BUILD_VERSION: '0.1.668',
      VITE_BUILD_COMMIT: '142524151c6337d5bf40ec6e5dc122fe835bf828',
    });
    // A sha is full of digits, so "no date" has to be asserted as the things a
    // rendered date actually contains: a clock, a month name, or a separator.
    expect(b.label).not.toMatch(/:\d\d|\b(?:AM|PM)\b/i);
    expect(b.label).not.toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
    expect(b.label).not.toMatch(/\d{4}-\d{2}-\d{2}|\d+\/\d+\/\d+/);
    expect(Object.keys(b)).not.toContain('builtAt');
    expect(readFileSync(join(UI, 'lib', 'buildInfo.ts'), 'utf8')).not.toContain('BUILD_TIME');
  });

  it('says so plainly when the bundle was built with no identity', async () => {
    const b = await withEnv({ VITE_BUILD_VERSION: undefined, VITE_BUILD_COMMIT: undefined });
    expect(b.label).toBe('development build');
    expect(b.version).toBeNull();
    expect(b.commit).toBeNull();
  });

  it('treats the Dockerfile ARG default as no identity at all', async () => {
    // `docker build` with no --build-arg yields the literal string "unknown".
    const b = await withEnv({ VITE_BUILD_VERSION: 'unknown', VITE_BUILD_COMMIT: 'unknown' });
    expect(b.label).toBe('development build');
  });

  it('treats an unsubstituted shell placeholder as no identity either', async () => {
    const b = await withEnv({ VITE_BUILD_VERSION: '$BUILD_VERSION', VITE_BUILD_COMMIT: '$BUILD_COMMIT' });
    expect(b.label).toBe('development build');
  });

  it('still identifies the build when only one half arrived', async () => {
    // A half-wired Dockerfile must not blank the row: whichever value made it
    // through is still more than "development build" on a deployed bundle.
    expect((await withEnv({ VITE_BUILD_VERSION: '0.1.668', VITE_BUILD_COMMIT: '' })).label)
      .toBe('0.1.668');
    expect((await withEnv({ VITE_BUILD_VERSION: '', VITE_BUILD_COMMIT: 'abcdef1234567' })).label)
      .toBe('abcdef1');
  });

  it('shortens the sha to what a person can read back', async () => {
    const b = await withEnv({ VITE_BUILD_COMMIT: '142524151c6337d5bf40ec6e5dc122fe835bf828', VITE_BUILD_VERSION: '' });
    expect(b.shortCommit).toBe('1425241');
    expect(b.shortCommit).toHaveLength(7);
  });
});
