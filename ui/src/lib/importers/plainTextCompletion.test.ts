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
import { parsePlainText } from './parsers/plainText';

describe('parsePlainText drives to completion', () => {
  it('single md file yields parsing, note, done', async () => {
    const f = new File(['Title Line\n\nbody here\n'], 'single.md', { type: 'text/markdown' });
    const events: string[] = [];
    const run = (async () => {
      for await (const ev of parsePlainText(f)) events.push(ev.kind);
    })();
    await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('HANG')), 4000))]);
    expect(events).toEqual(['parsing', 'note', 'done']);
  });
});
