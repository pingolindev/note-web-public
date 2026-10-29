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

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import sodiumInit from 'libsodium-wrappers';
import vectors from './attachmentFormat.vectors.json';

/**
 * Upload and re-key as the app runs them, with the network mocked. What is
 * pinned: an upload streams the file into a v2 blob and registers the size of
 * what it actually PUT; a re-key turns a v1 blob under the old key into a v2
 * blob under the new one and reports the new object's size; a file whose
 * ciphertext would exceed the server's per-object cap is refused up front.
 */

// Metadata sealing is crypto.ts's (tested elsewhere); a transparent stand-in
// keeps these tests about the blob path. `meta:<key byte 0>:<json>` lets a test
// see which key sealed it.
vi.mock('./crypto', () => ({
  encryptWithContentKey: (json: string, key: Uint8Array) => ({ ciphertext: `meta:${key[0]}:${json}`, nonce: 'n' }),
  decryptWithContentKey: (enc: { ciphertext: string }, key: Uint8Array) => {
    const m = /^meta:(\d+):(.*)$/.exec(enc.ciphertext);
    return m && Number(m[1]) === key[0] ? m[2] : null;
  },
}));
// The owner's retired keys. The re-key must never use them, so tests that put a
// key here prove it is ignored (and a pass that read the store again would fail).
const hoisted = vi.hoisted(() => ({ retired: [] as Uint8Array[] }));
vi.mock('./retainedKeys', () => ({ getRetained: () => hoisted.retired }));

const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

import {
  uploadFile, rekeyNoteAttachments, fitsUploadLimit, MAX_ENCRYPTED_SIZE,
  listAttachmentsForRekey, keepAttachment, attachmentsResealed, type AttachmentRow,
} from './attachmentUpload';
import { decryptBlob, encryptBlob } from './attachmentCrypto';
import type { OpenedMeta } from './attachmentTrust';
import { isV2, v2EncryptedSize } from './attachmentFormat';

const fromHex = (h: string): Uint8Array<ArrayBuffer> => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 3 + 1) & 0xff);

let fetchMock: ReturnType<typeof vi.fn>;
const puts: Array<{ url: string; body: Uint8Array }> = [];

beforeAll(async () => {
  await sodiumInit.ready;
});

beforeEach(() => {
  apiRequest.mockReset();
  hoisted.retired = [];
  puts.length = 0;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      puts.push({ url, body: new Uint8Array(await (init.body as Blob).arrayBuffer()) });
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fitsUploadLimit', () => {
  it('counts the ciphertext against the server cap, not just the file size', () => {
    const maxPlain = MAX_ENCRYPTED_SIZE - (v2EncryptedSize(MAX_ENCRYPTED_SIZE) - MAX_ENCRYPTED_SIZE);
    expect(v2EncryptedSize(maxPlain)).toBe(MAX_ENCRYPTED_SIZE);
    expect(fitsUploadLimit(maxPlain)).toBe(true);
    expect(fitsUploadLimit(maxPlain + 1)).toBe(false);
    // Exactly 100 MB is under the user-facing limit, but its ciphertext would
    // not fit the server's per-object cap, so it is refused up front.
    expect(fitsUploadLimit(100 * 1024 * 1024)).toBe(false);
    expect(fitsUploadLimit(0)).toBe(true);
  });
});

describe('uploadFile', () => {
  it('PUTs a v2 blob that opens under the content key and registers its real size', async () => {
    const key = new Uint8Array(32).fill(7);
    const data = pattern(300_000);
    apiRequest.mockImplementation(async (url: string, opts?: { body?: Record<string, unknown> }) => {
      if (url === '/api/v1/attachments/presign-upload') return { success: true, data: { url: 'https://r2/put', object_key: 'k1' } };
      if (url === '/api/v1/attachments') return { success: true, data: opts?.body };
      return { success: false, error: 'unexpected' };
    });

    const res = await uploadFile('note-1', new File([data], 'a.png', { type: 'image/png' }), key);
    expect(res.success).toBe(true);
    expect(puts).toHaveLength(1);
    const body = puts[0].body;
    expect(isV2(body)).toBe(true);
    const opened = await decryptBlob([key], body);
    expect(Buffer.from(opened!.plaintext).equals(Buffer.from(data))).toBe(true);

    const register = apiRequest.mock.calls.find((c) => c[0] === '/api/v1/attachments')!;
    expect(register[1].body.size_bytes).toBe(body.length);
    expect(register[1].body.size_bytes).toBe(v2EncryptedSize(data.length));
  });

  it('refuses a file whose ciphertext would exceed the cap before asking for an upload URL', async () => {
    const huge = { size: 100 * 1024 * 1024, name: 'big.mp4' } as File;
    const res = await uploadFile('note-1', huge, new Uint8Array(32));
    expect(res.success).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});


describe('rekeyNoteAttachments (only what was there before the removal, only from the previous key)', () => {
  const oldKey = fromHex(vectors.key); // opens the shared v1 vector
  const newKey = new Uint8Array(32).fill(0x33);
  const retiredKey = new Uint8Array(32).fill(0x44);

  const row = (metaKeyByte: number, size: number, filename = 'f'): AttachmentRow =>
    ({ id: 'att-1', encrypted_meta: `meta:${metaKeyByte}:{"filename":"${filename}"}`, meta_nonce: 'n', size_bytes: size });

  /** The server as it is AFTER the removal: att-1's blob, and a list that now
   *  names att-1 differently and has gained att-2. */
  function serve(ciphertext: Uint8Array<ArrayBuffer>) {
    apiRequest.mockImplementation(async (url: string) => {
      if (url === '/api/v1/items/note-9/attachments') {
        return { success: true, data: [
          { id: 'att-1', encrypted_meta: `meta:${oldKey[0]}:{"filename":"server-now"}`, meta_nonce: 'n', size_bytes: 1 },
          { id: 'att-2', encrypted_meta: `meta:${oldKey[0]}:{"filename":"planted"}`, meta_nonce: 'n', size_bytes: 1 },
        ] };
      }
      if (url === '/api/v1/attachments/att-1/presign-download') return { success: true, data: { url: 'https://r2/get' } };
      if (url === '/api/v1/attachments/att-2/presign-download') return { success: true, data: { url: 'https://r2/get' } };
      if (url === '/api/v1/attachments/presign-upload') return { success: true, data: { url: 'https://r2/put2', object_key: 'k2' } };
      if (url === '/api/v1/attachments/att-1') return { success: true, data: null };
      return { success: false, error: 'unexpected ' + url };
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts.push({ url, body: new Uint8Array(await (init.body as Blob).arrayBuffer()) });
        return new Response(null, { status: 200 });
      }
      if (url === 'https://r2/get') return new Response(ciphertext);
      return new Response(null, { status: 404 });
    });
  }
  const called = (url: string) => apiRequest.mock.calls.some((c) => c[0] === url);

  it('re-keys a row captured before the removal from the previous key, with the captured metadata, and never lists', async () => {
    serve(fromHex(vectors.v1.blob));
    const res = await rekeyNoteAttachments('note-9', [row(oldKey[0], vectors.v1.plaintext_len)], oldKey, newKey);
    expect(res).toEqual({ attempted: 1, rekeyed: 1, skipped: 0, failed: 0 });
    const body = puts[0].body;
    expect(isV2(body)).toBe(true);
    const opened = await decryptBlob([newKey], body);
    expect(opened!.plaintext.length).toBe(vectors.v1.plaintext_len);
    expect(await decryptBlob([oldKey], body)).toBeNull();

    const swap = apiRequest.mock.calls.find((c) => c[0] === '/api/v1/attachments/att-1')!;
    expect(swap[1].method).toBe('PUT');
    expect(swap[1].body.size_bytes).toBe(body.length);
    // The metadata captured before the removal, re-sealed — not what the server lists now.
    expect(swap[1].body.encrypted_meta).toBe(`meta:${newKey[0]}:{"filename":"f"}`);
    expect(called('/api/v1/items/note-9/attachments')).toBe(false);
    expect(called('/api/v1/attachments/att-2/presign-download')).toBe(false);
  });

  it('never brings forward a row the server lists only after the removal', async () => {
    serve(fromHex(vectors.v1.blob));
    expect(await rekeyNoteAttachments('note-9', [], oldKey, newKey))
      .toEqual({ attempted: 0, rekeyed: 0, skipped: 0, failed: 0 });
    expect(apiRequest).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('leaves a captured row under a retired key alone, with that key in the retired store, without downloading it', async () => {
    hoisted.retired = [retiredKey];
    serve(await encryptBlob(retiredKey, pattern(10)));
    expect(await rekeyNoteAttachments('note-9', [row(retiredKey[0], 50)], oldKey, newKey))
      .toEqual({ attempted: 1, rekeyed: 0, skipped: 1, failed: 0 });
    expect(called('/api/v1/attachments/att-1/presign-download')).toBe(false);
    expect(called('/api/v1/attachments/presign-upload')).toBe(false);
    expect(puts).toHaveLength(0);
  });

  it('leaves alone previous-key metadata whose blob opens only under a retired key', async () => {
    hoisted.retired = [retiredKey];
    serve(await encryptBlob(retiredKey, pattern(10)));
    expect(await rekeyNoteAttachments('note-9', [row(oldKey[0], 50)], oldKey, newKey))
      .toEqual({ attempted: 1, rekeyed: 0, skipped: 1, failed: 0 });
    expect(called('/api/v1/attachments/presign-upload')).toBe(false);
    expect(called('/api/v1/attachments/att-1')).toBe(false);
    expect(puts).toHaveLength(0);
  });

  it('leaves alone a blob under the new key, and counts a failed download as failed', async () => {
    serve(await encryptBlob(newKey, pattern(10)));
    expect(await rekeyNoteAttachments('note-9', [row(oldKey[0], 50)], oldKey, newKey))
      .toEqual({ attempted: 1, rekeyed: 0, skipped: 1, failed: 0 });
    expect(puts).toHaveLength(0);

    serve(fromHex(vectors.v1.blob));
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
    expect(await rekeyNoteAttachments('note-9', [row(oldKey[0], 50)], oldKey, newKey))
      .toEqual({ attempted: 1, rekeyed: 0, skipped: 0, failed: 1 });
  });

  it('announces a re-seal of this note only when it re-keyed something', async () => {
    serve(await encryptBlob(newKey, pattern(10)));
    const before = attachmentsResealed();
    await rekeyNoteAttachments('note-9', [row(oldKey[0], 50)], oldKey, newKey);
    expect(attachmentsResealed()).toBe(before);

    serve(fromHex(vectors.v1.blob));
    await rekeyNoteAttachments('note-9', [row(oldKey[0], vectors.v1.plaintext_len)], oldKey, newKey);
    expect(attachmentsResealed()).toEqual({ noteId: 'note-9' });
    expect(attachmentsResealed()).not.toBe(before);
  });
});

describe('listAttachmentsForRekey', () => {
  it('returns the rows, or null when they cannot be read', async () => {
    const rows = [{ id: 'a', encrypted_meta: 'm', meta_nonce: 'n', size_bytes: 1 }];
    apiRequest.mockResolvedValueOnce({ success: true, data: rows });
    expect(await listAttachmentsForRekey('note-9')).toEqual(rows);
    expect(apiRequest).toHaveBeenLastCalledWith('/api/v1/items/note-9/attachments');

    apiRequest.mockResolvedValueOnce({ success: false, error: 'down' });
    expect(await listAttachmentsForRekey('note-9')).toBeNull();
    apiRequest.mockResolvedValueOnce({ success: true, data: {} });
    expect(await listAttachmentsForRekey('note-9')).toBeNull();
  });
});

describe('keepAttachment (the one re-seal of a flagged file, after the person saw it)', () => {
  const current = new Uint8Array(32).fill(0x55);
  const retiredKey = new Uint8Array(32).fill(0x44);
  const shown = pattern(5000);
  const opened = (over: Partial<OpenedMeta> = {}): OpenedMeta => ({
    json: '{"filename":"k.png"}', filename: 'k.png', contentType: 'image/png',
    key: retiredKey, unconfirmed: true, ...over,
  });

  function serveSwap(swapOk = true) {
    apiRequest.mockImplementation(async (url: string) => {
      if (url === '/api/v1/attachments/presign-upload') return { success: true, data: { url: 'https://r2/put3', object_key: 'k3' } };
      if (url === '/api/v1/attachments/att-7') return swapOk ? { success: true, data: null } : { success: false, error: 'no' };
      return { success: false, error: 'unexpected ' + url };
    });
  }
  const keep = (over: Partial<Parameters<typeof keepAttachment>[0]> = {}) => keepAttachment({
    noteId: 'note-9', attachmentId: 'att-7', seen: true,
    held: { blob: new Blob([shown]), opened: opened() }, currentKey: current, ...over,
  });

  it('seals exactly the held bytes and metadata under the CURRENT key, and downloads nothing', async () => {
    serveSwap();
    expect(await keep()).toBe(true);
    expect(puts).toHaveLength(1);
    const sealed = await decryptBlob([current], puts[0].body);
    expect(Buffer.from(sealed!.plaintext).equals(Buffer.from(shown))).toBe(true);
    expect(await decryptBlob([retiredKey], puts[0].body)).toBeNull();
    const swap = apiRequest.mock.calls.find((c) => c[0] === '/api/v1/attachments/att-7')!;
    expect(swap[1].method).toBe('PUT');
    expect(swap[1].body.encrypted_meta).toBe(`meta:${current[0]}:{"filename":"k.png"}`);
    // No download of any kind, and no list: only the presign, the PUT of the new object and the swap.
    expect(apiRequest.mock.calls.map((c) => c[0])).toEqual(['/api/v1/attachments/presign-upload', '/api/v1/attachments/att-7']);
    expect(fetchMock.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(true);
  });

  it('refuses a file that is not flagged, and sends nothing', async () => {
    serveSwap();
    expect(await keep({ held: { blob: new Blob([shown]), opened: opened({ unconfirmed: false, key: current }) } })).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses before a seen event, and sends nothing', async () => {
    serveSwap();
    expect(await keep({ seen: false })).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without held bytes, and sends nothing', async () => {
    serveSwap();
    expect(await keep({ held: undefined })).toBe(false);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a swap that did not land, and announces one that did', async () => {
    serveSwap(false);
    const before = attachmentsResealed();
    expect(await keep()).toBe(false);
    expect(attachmentsResealed()).toBe(before);

    serveSwap(true);
    expect(await keep({ noteId: 'note-9' })).toBe(true);
    expect(attachmentsResealed()).toEqual({ noteId: 'note-9' });
    expect(attachmentsResealed()).not.toBe(before);
  });
});
