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

import { describe, it, expect, beforeAll } from 'vitest';
import sodiumInit from 'libsodium-wrappers';
import {
  AttachmentFormatError,
  StreamDecryptor,
  V2_CHUNK_SIZE,
  V2_HEADER_LEN,
  createEncryptor,
  decryptAny,
  encryptV2,
  isV2,
  v2ChunkSize,
  v2EncryptedSize,
  type SecretStreamSodium,
} from './attachmentFormat';
// Shared with the Android and iOS apps: the same bytes must open on all
// three. Generated once with libsodium; the key is 00..1f and plaintext byte
// i is (i*7+3) & 0xff.
import vectors from './attachmentFormat.vectors.json';

/**
 * The v2 chunked attachment format. What these pin down:
 *  - the byte layout, against fixed vectors every native reader also checks;
 *  - that v1 blobs still open (no attachment in the older format is lost);
 *  - that a streaming reader gets identical plaintext however the network
 *    splits the body;
 *  - that every way a server could tamper with a blob — truncate, reorder,
 *    splice, append, rewrite the header — is refused rather than opened.
 */

let sodium: SecretStreamSodium;

beforeAll(async () => {
  await sodiumInit.ready;
  sodium = sodiumInit as unknown as SecretStreamSodium;
});

const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 7 + 3) & 0xff);
const keyA = fromHex(vectors.key);
const keyB = new Uint8Array(32).fill(0x42);

/** Byte offsets of each chunk in a v2 blob with `chunk`-byte chunks. */
function chunkOffsets(blob: Uint8Array, chunk: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let off = V2_HEADER_LEN;
  while (off < blob.length) {
    const end = Math.min(off + chunk + 17, blob.length);
    out.push([off, end]);
    off = end;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('cross-platform vectors', () => {
  for (const name of ['v2_multi', 'v2_exact', 'v2_empty'] as const) {
    it(`${name} opens to the expected plaintext`, () => {
      const v = vectors[name];
      const r = decryptAny(sodium, [keyA], fromHex(v.blob));
      expect(r).not.toBeNull();
      expect(r!.format).toBe('v2');
      expect(r!.keyIndex).toBe(0);
      expect(Array.from(r!.plaintext)).toEqual(Array.from(pattern(v.plaintext_len)));
      expect(fromHex(v.blob).length).toBe(v2EncryptedSize(v.plaintext_len, v.chunk_size));
    });
  }

  it('a v1 blob written before this change still opens', () => {
    const r = decryptAny(sodium, [keyA], fromHex(vectors.v1.blob));
    expect(r?.format).toBe('v1');
    expect(Array.from(r!.plaintext)).toEqual(Array.from(pattern(vectors.v1.plaintext_len)));
  });

  it('the vector header is the documented layout', () => {
    const blob = fromHex(vectors.v2_multi.blob);
    expect(Array.from(blob.subarray(0, 12))).toEqual([0x50, 0x4e, 0x41, 0x54, 2, 0, 0, 0, 0x00, 0x04, 0x00, 0x00]);
    expect(v2ChunkSize(blob)).toBe(1024);
  });
});

describe('round trip', () => {
  const sizes = [0, 1, 1023, 1024, 1025, 3072, 5000];
  for (const n of sizes) {
    it(`${n} bytes with 1 KiB chunks`, () => {
      const data = pattern(n);
      const blob = encryptV2(sodium, keyA, data, 1024);
      expect(blob.length).toBe(v2EncryptedSize(n, 1024));
      expect(isV2(blob)).toBe(true);
      const r = decryptAny(sodium, [keyA], blob);
      expect(Array.from(r!.plaintext)).toEqual(Array.from(data));
    });
  }

  it('the default 1 MiB chunking on a 3 MiB + 5 byte file', () => {
    const data = pattern(3 * V2_CHUNK_SIZE + 5);
    const blob = encryptV2(sodium, keyA, data);
    expect(blob.length).toBe(v2EncryptedSize(data.length));
    expect(chunkOffsets(blob, V2_CHUNK_SIZE)).toHaveLength(4);
    const r = decryptAny(sodium, [keyA], blob);
    expect(r!.plaintext.length).toBe(data.length);
    expect(r!.plaintext[data.length - 1]).toBe(data[data.length - 1]);
  });

  it('two encryptions of the same file differ (fresh stream header each time)', () => {
    const a = encryptV2(sodium, keyA, pattern(100), 1024);
    const b = encryptV2(sodium, keyA, pattern(100), 1024);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('streaming reader', () => {
  it('gets identical plaintext however the body is split', () => {
    const data = pattern(4100);
    const blob = encryptV2(sodium, keyA, data, 1024);
    for (const step of [1, 7, 17, 36, 1041, 4096]) {
      const d = new StreamDecryptor(sodium, [keyA]);
      const parts: Uint8Array[] = [];
      for (let o = 0; o < blob.length; o += step) parts.push(...d.write(blob.subarray(o, o + step)));
      parts.push(...d.end());
      expect(Array.from(concat(...parts))).toEqual(Array.from(data));
    }
  });

  it('releases full chunks before the end of the body, not all at once at the end', () => {
    const blob = encryptV2(sodium, keyA, pattern(3000), 1024);
    const d = new StreamDecryptor(sodium, [keyA]);
    const early = d.write(blob.subarray(0, V2_HEADER_LEN + 2 * (1024 + 17)));
    expect(early.map((p) => p.length)).toEqual([1024, 1024]);
  });

  it('streams a v1 blob too (buffered, opened at the end)', () => {
    const blob = fromHex(vectors.v1.blob);
    const d = new StreamDecryptor(sodium, [keyA]);
    expect(d.write(blob.subarray(0, 100))).toEqual([]);
    expect(d.write(blob.subarray(100))).toEqual([]);
    const out = d.end();
    expect(d.format).toBe('v1');
    expect(out[0].length).toBe(300);
  });

  it('is dead after a failure and after end', () => {
    const d = new StreamDecryptor(sodium, [keyB]);
    const blob = encryptV2(sodium, keyA, pattern(2000), 1024);
    expect(() => d.write(blob)).toThrow(AttachmentFormatError);
    expect(() => d.end()).toThrow(AttachmentFormatError);
    const ok = new StreamDecryptor(sodium, [keyA]);
    ok.write(blob);
    ok.end();
    expect(() => ok.write(new Uint8Array(1))).toThrow(AttachmentFormatError);
  });
});

describe('candidate keys', () => {
  const blob = () => encryptV2(sodium, keyA, pattern(2000), 1024);

  it('reports which candidate opened the blob', () => {
    expect(decryptAny(sodium, [keyA, keyB], blob())!.keyIndex).toBe(0);
    expect(decryptAny(sodium, [keyB, keyA], blob())!.keyIndex).toBe(1);
  });

  it('opens under none → null, for v2 and for v1', () => {
    expect(decryptAny(sodium, [keyB], blob())).toBeNull();
    expect(decryptAny(sodium, [keyB], fromHex(vectors.v1.blob))).toBeNull();
    expect(decryptAny(sodium, [], blob())).toBeNull();
  });
});

describe('tampering is refused, never opened', () => {
  const data = pattern(3000); // chunks of 1024, 1024, 952
  const make = () => encryptV2(sodium, keyA, data, 1024);
  const opens = (b: Uint8Array) => decryptAny(sodium, [keyA], b) !== null;

  it('a flipped byte anywhere in the header or any chunk', () => {
    const base = make();
    for (const i of [0, 3, 4, 5, 8, 9, 12, 35, 36, 36 + 500, 36 + 1040, base.length - 1]) {
      const b = base.slice();
      b[i] ^= 0x01;
      expect(opens(b), `byte ${i}`).toBe(false);
    }
  });

  it('truncation: the final chunk dropped, cut mid-chunk, one byte short', () => {
    const base = make();
    const [, , last] = chunkOffsets(base, 1024);
    expect(opens(base.subarray(0, last[0]))).toBe(false);
    expect(opens(base.subarray(0, last[0] + 20))).toBe(false);
    expect(opens(base.subarray(0, base.length - 1))).toBe(false);
    expect(opens(base.subarray(0, V2_HEADER_LEN))).toBe(false);
  });

  it('truncation exactly on a chunk boundary of an exact-multiple file', () => {
    // 2048 bytes = two full chunks; the FINAL tag rides on the second. Without
    // it, a stream that simply stops after chunk 1 would look complete.
    const b = encryptV2(sodium, keyA, pattern(2048), 1024);
    expect(opens(b)).toBe(true);
    expect(opens(b.subarray(0, V2_HEADER_LEN + 1024 + 17))).toBe(false);
  });

  it('reordered chunks', () => {
    const base = make();
    const [c1, c2, c3] = chunkOffsets(base, 1024);
    const swapped = concat(base.subarray(0, V2_HEADER_LEN), base.subarray(...c2), base.subarray(...c1), base.subarray(...c3));
    expect(opens(swapped)).toBe(false);
  });

  it('a chunk spliced in from another blob under the same key', () => {
    const a = make();
    const other = make();
    const [c1, c2] = chunkOffsets(a, 1024);
    const [, o2] = chunkOffsets(other, 1024);
    const spliced = concat(a.subarray(0, c2[0]), other.subarray(...o2), a.subarray(c2[1]));
    expect(spliced.length).toBe(a.length);
    expect(c1[0]).toBe(V2_HEADER_LEN);
    expect(opens(spliced)).toBe(false);
  });

  it('bytes appended after the final chunk', () => {
    expect(opens(concat(make(), new Uint8Array([0])))).toBe(false);
    const extra = encryptV2(sodium, keyA, pattern(10), 1024).subarray(V2_HEADER_LEN);
    expect(opens(concat(make(), extra))).toBe(false);
  });

  it('a rewritten chunk size is refused without allocating it', () => {
    for (const size of [0, 512, 1023, 16 * 1024 * 1024, 0xffffffff]) {
      const b = make();
      new DataView(b.buffer).setUint32(8, size >>> 0, true);
      expect(v2ChunkSize(b)).toBeNull();
      expect(opens(b)).toBe(false);
    }
    // In range but wrong: every chunk boundary shifts and nothing authenticates.
    const b = make();
    new DataView(b.buffer).setUint32(8, 2048, true);
    expect(opens(b)).toBe(false);
  });

  it('a v1-looking blob whose nonce happens to start with the magic is not taken as v2', () => {
    const b = fromHex(vectors.v1.blob);
    b.set([0x50, 0x4e, 0x41, 0x54, 0x07], 0); // right magic, wrong version
    expect(isV2(b)).toBe(false);
  });
});

describe('writer misuse', () => {
  it('refuses a short non-final chunk, a push after the final one, and an out-of-range size', () => {
    const enc = createEncryptor(sodium, keyA, 1024);
    expect(() => enc.push(new Uint8Array(10), false)).toThrow(AttachmentFormatError);
    enc.push(new Uint8Array(10), true);
    expect(() => enc.push(new Uint8Array(0), true)).toThrow(AttachmentFormatError);
    expect(() => createEncryptor(sodium, keyA, 100)).toThrow(AttachmentFormatError);
    expect(() => createEncryptor(sodium, keyA, 64 * 1024 * 1024)).toThrow(AttachmentFormatError);
  });
});

describe('v2EncryptedSize', () => {
  it('counts the header plus 17 bytes per chunk, one chunk minimum', () => {
    expect(v2EncryptedSize(0)).toBe(36 + 17);
    expect(v2EncryptedSize(1)).toBe(36 + 1 + 17);
    expect(v2EncryptedSize(V2_CHUNK_SIZE)).toBe(36 + V2_CHUNK_SIZE + 17);
    expect(v2EncryptedSize(V2_CHUNK_SIZE + 1)).toBe(36 + V2_CHUNK_SIZE + 1 + 34);
    expect(v2EncryptedSize(100 * 1024 * 1024)).toBe(100 * 1024 * 1024 + 36 + 100 * 17);
  });
});
