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
import { encryptFile, decryptResponse, encryptBlob, decryptBlob } from './attachmentCrypto';
import { V2_CHUNK_SIZE, isV2, v2EncryptedSize } from './attachmentFormat';
import vectors from './attachmentFormat.vectors.json';

/**
 * The public attachment-crypto API that upload, view and re-key call. Node has
 * no Worker, so these run the main-thread fallback — the same attachmentFormat
 * code the worker runs, behind the same entry points.
 */

beforeAll(async () => {
  await sodiumInit.ready;
});

const fromHex = (h: string): Uint8Array<ArrayBuffer> => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 13 + 5) & 0xff);
const key = new Uint8Array(32).map((_, i) => 200 - i);
const otherKey = new Uint8Array(32).fill(9);

/** A Response whose body arrives in `piece`-byte reads, like a network. */
function trickle(bytes: Uint8Array, piece: number, init?: ResponseInit): Response {
  let off = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (off >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(off, off + piece));
      off += piece;
    },
  });
  return new Response(stream, init);
}

async function bytesOf(b: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await b.arrayBuffer());
}

describe('encryptFile → decryptResponse', () => {
  it('round-trips a multi-chunk file through a trickled download', async () => {
    const data = pattern(2 * V2_CHUNK_SIZE + 12345);
    const sealed = await encryptFile(key, new Blob([data]));
    expect(sealed.size).toBe(v2EncryptedSize(data.length));
    const ct = await bytesOf(sealed);
    expect(isV2(ct)).toBe(true);

    const r = await decryptResponse([key], trickle(ct, 65536), 'image/png');
    expect(r).not.toBeNull();
    expect(r!.keyIndex).toBe(0);
    expect(r!.blob.type).toBe('image/png');
    expect(r!.blob.size).toBe(data.length);
    expect(Buffer.from(await bytesOf(r!.blob)).equals(Buffer.from(data))).toBe(true);
  });

  it('round-trips an empty file', async () => {
    const sealed = await encryptFile(key, new Blob([]));
    const r = await decryptResponse([key], new Response(sealed));
    expect(r!.blob.size).toBe(0);
  });

  it('opens a v1 blob written before the format change', async () => {
    const r = await decryptResponse([fromHex(vectors.key)], trickle(fromHex(vectors.v1.blob), 50));
    expect(r!.blob.size).toBe(vectors.v1.plaintext_len);
  });

  it('opens the shared v2 vector', async () => {
    const r = await decryptResponse([otherKey, fromHex(vectors.key)], new Response(fromHex(vectors.v2_multi.blob)));
    expect(r!.keyIndex).toBe(1);
    expect(r!.blob.size).toBe(vectors.v2_multi.plaintext_len);
  });

  it('is null for a wrong key, a failed response, a truncated body', async () => {
    const ct = await bytesOf(await encryptFile(key, new Blob([pattern(5000)])));
    expect(await decryptResponse([otherKey], new Response(ct))).toBeNull();
    expect(await decryptResponse([key], new Response(ct, { status: 404 }))).toBeNull();
    expect(await decryptResponse([key], new Response(ct.slice(0, ct.length - 3)))).toBeNull();
    expect(await decryptResponse([], new Response(ct))).toBeNull();
  });
});

describe('whole-buffer entry points', () => {
  it('encryptBlob writes v2, and decryptBlob reads both formats', async () => {
    const data = pattern(4000);
    const ct = await encryptBlob(key, data);
    expect(isV2(ct)).toBe(true);
    const r = await decryptBlob([otherKey, key], ct);
    expect(r!.keyIndex).toBe(1);
    expect(Buffer.from(r!.plaintext).equals(Buffer.from(data))).toBe(true);

    const v1 = await decryptBlob([fromHex(vectors.key)], fromHex(vectors.v1.blob));
    expect(v1!.plaintext.length).toBe(vectors.v1.plaintext_len);
    expect(await decryptBlob([otherKey], ct)).toBeNull();
  });
});
