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
import { derivedRestoreId, restoreIdKeyFrom } from './restoreIds';

/**
 * The id a restore files a note or notebook under when another account holds
 * its own: keyed by this account's vault key, the same each time, apart for
 * notes and notebooks, and shaped as a v4 UUID.
 */

const ORIGINAL = '11111111-1111-4111-8111-111111111111';
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a derived restore id', () => {
  it('is a canonical v4-shaped UUID, and not the original', async () => {
    const id = await derivedRestoreId(await restoreIdKeyFrom(new Uint8Array(32).fill(1)), 'note', ORIGINAL);
    expect(id).toMatch(V4);
    expect(id).not.toBe(ORIGINAL);
  });

  it('is the same every time for the same key and id, whatever the id spelling', async () => {
    const key = await restoreIdKeyFrom(new Uint8Array(32).fill(1));
    const again = await restoreIdKeyFrom(new Uint8Array(32).fill(1));
    const id = await derivedRestoreId(key, 'note', ORIGINAL);
    expect(await derivedRestoreId(again, 'note', ORIGINAL)).toBe(id);
    // Any spelling of one id is that id: letters in another case, or no hyphens.
    const lettered = 'abcdef12-abcd-4abc-8abc-abcdefabcdef';
    const canonical = await derivedRestoreId(key, 'note', lettered);
    expect(await derivedRestoreId(key, 'note', lettered.toUpperCase())).toBe(canonical);
    expect(await derivedRestoreId(key, 'note', lettered.replace(/-/g, ''))).toBe(canonical);
  });

  it('differs for a notebook, for another id, and under another key', async () => {
    const key = await restoreIdKeyFrom(new Uint8Array(32).fill(1));
    const note = await derivedRestoreId(key, 'note', ORIGINAL);
    expect(await derivedRestoreId(key, 'notebook', ORIGINAL)).not.toBe(note);
    expect(await derivedRestoreId(key, 'note', '22222222-2222-4222-8222-222222222222')).not.toBe(note);
    // Someone who knows only the original id (another key) can't compute it.
    expect(await derivedRestoreId(await restoreIdKeyFrom(new Uint8Array(32).fill(2)), 'note', ORIGINAL)).not.toBe(note);
  });
});
