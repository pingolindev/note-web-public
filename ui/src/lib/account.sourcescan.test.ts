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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every same-origin request goes through accountFetch, so every one names
 * the tab's account and every 409 `account_mismatch` stops the tab. A raw
 * `fetch(` anywhere else would be a request the check never sees. The only
 * others are the presigned object-store URLs (another host; they carry no
 * cookie and reach no handler). The collab socket, the one channel fetch does
 * not cover, is collab.ts's alone and sends the account in its first frame.
 */

const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [path] : [];
  });
}

/** `file:line: code` for every line matching `pattern`, comments aside. */
function uses(pattern: RegExp): string[] {
  return sources(SRC).flatMap((path) =>
    readFileSync(path, 'utf8').split('\n').flatMap((line, i) => {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return [];
      return pattern.test(code) ? [`${relative(SRC, path)}:${i + 1}: ${code}`] : [];
    }));
}

describe('the one door for requests', () => {
  it('no raw fetch outside accountFetch, except the presigned object-store URLs', () => {
    const raw = uses(/(^|[^A-Za-z0-9_.])fetch\(/).filter(u => !/accountFetch\(/.test(u));
    const allowed = [
      /^lib\/account\.ts:\d+: const resp = await fetch\(input, \{ \.\.\.init, headers \}\);$/,
      /^lib\/attachmentUpload\.ts:\d+: const uploadResp = await fetch\(uploadUrl, \{$/,
      /^lib\/attachmentUpload\.ts:\d+: resp = await fetch\(presign\.data\.url\);$/,
      /^lib\/attachmentUpload\.ts:\d+: const putResp = await fetch\(presign\.data\.url, \{$/,
    ];
    expect(raw.filter(u => !allowed.some(a => a.test(u)))).toEqual([]);
    // And each allowance is still what it says (a moved line fails here, not silently).
    expect(allowed.every(a => raw.some(u => a.test(u)))).toBe(true);
  });

  it('no request channel the check does not cover', () => {
    expect(uses(/sendBeacon\(|new EventSource\(|new XMLHttpRequest\(|\.fetchLater\(/)).toEqual([]);
    expect(uses(/new WebSocket\(/)).toEqual([
      expect.stringMatching(/^lib\/collab\.ts:\d+: const ws = new WebSocket\(url\);$/),
    ]);
  });
});
