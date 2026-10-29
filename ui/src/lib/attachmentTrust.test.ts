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

import { describe, it, expect, vi } from 'vitest';

/**
 * On the owner's page a retired key opens an attachment for VIEWING only.
 * What is pinned: the current key comes first and the retired store is read
 * only when it fails; a file whose metadata opens only under a retired key is
 * flagged; its blob may open under that key alone (and a current-key label
 * under the current key alone); "Keep file" is offered only for a flagged
 * card whose bytes are held AND were seen.
 */

// A transparent stand-in for the metadata seal: `meta:<key byte 0>:<json>`
// opens only under a key whose first byte matches.
vi.mock('./crypto', () => ({
  decryptWithContentKey: (enc: { ciphertext: string }, key: Uint8Array) => {
    const m = /^meta:(\d+):(.*)$/.exec(enc.ciphertext);
    return m && Number(m[1]) === key[0] ? m[2] : null;
  },
}));

import { openAttachmentMeta, blobKeysFor, keepOffered } from './attachmentTrust';

const CURRENT = new Uint8Array(32).fill(0x11);
const RETIRED_A = new Uint8Array(32).fill(0x22);
const RETIRED_B = new Uint8Array(32).fill(0x33);
const sealedUnder = (key: Uint8Array, json = '{"filename":"a.png","content_type":"image/png"}') =>
  ({ encrypted_meta: `meta:${key[0]}:${json}`, meta_nonce: 'n' });

describe('opening an attachment on the owner’s page', () => {
  it('opens under the current key unflagged, without reading the retired store', () => {
    const retired = vi.fn(() => [RETIRED_A]);
    const opened = openAttachmentMeta(sealedUnder(CURRENT), 'note-1', CURRENT, retired);
    expect(opened).toMatchObject({ filename: 'a.png', contentType: 'image/png', unconfirmed: false });
    expect(opened!.key).toBe(CURRENT);
    expect(retired).not.toHaveBeenCalled();
  });

  it('flags a file that opens only under a retired key, and names that key', () => {
    const opened = openAttachmentMeta(sealedUnder(RETIRED_B), 'note-1', CURRENT, () => [RETIRED_A, RETIRED_B]);
    expect(opened).toMatchObject({ filename: 'a.png', unconfirmed: true });
    expect(opened!.key).toBe(RETIRED_B);
    expect(opened!.json).toBe('{"filename":"a.png","content_type":"image/png"}');
  });

  it('opens nothing under a key it was not given', () => {
    const stranger = new Uint8Array(32).fill(0x77);
    expect(openAttachmentMeta(sealedUnder(stranger), 'note-1', CURRENT, () => [RETIRED_A])).toBeNull();
  });

  it('treats metadata that is not JSON as unopened', () => {
    expect(openAttachmentMeta(sealedUnder(CURRENT, 'not json'), 'note-1', CURRENT, () => [])).toBeNull();
  });
});

describe('which keys a blob may open under (the same-key rule)', () => {
  it('a current-key label: the current key alone, never a retired one', () => {
    const opened = openAttachmentMeta(sealedUnder(CURRENT), 'note-1', CURRENT, () => [RETIRED_A]);
    expect(blobKeysFor(opened, CURRENT)).toEqual([CURRENT]);
  });

  it('a flagged label: the retired key that opened it, alone', () => {
    const opened = openAttachmentMeta(sealedUnder(RETIRED_A), 'note-1', CURRENT, () => [RETIRED_A, RETIRED_B]);
    const keys = blobKeysFor(opened, CURRENT);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(RETIRED_A);
  });

  it('a label that opened under no key: the current key alone', () => {
    expect(blobKeysFor(null, CURRENT)).toEqual([CURRENT]);
  });
});

describe('when "Keep file" is offered', () => {
  it('only on a flagged card whose bytes are held and were seen', () => {
    expect(keepOffered({ unconfirmed: true, held: true, seen: true })).toBe(true);
  });

  it('never on a card that is not flagged', () => {
    expect(keepOffered({ unconfirmed: false, held: true, seen: true })).toBe(false);
  });

  it('never before a seen event, even with the bytes held (previews load on their own)', () => {
    expect(keepOffered({ unconfirmed: true, held: true, seen: false })).toBe(false);
  });

  it('never without the bytes held', () => {
    expect(keepOffered({ unconfirmed: true, held: false, seen: true })).toBe(false);
  });
});
