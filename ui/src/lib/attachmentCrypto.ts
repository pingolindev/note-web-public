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
 * Main-thread front end for attachment-blob crypto. Routes the work to the
 * dedicated Web Worker (attachmentCryptoWorker.ts) so 100 MB-scale crypto never
 * janks the UI, and falls back to running the same code on the main thread in
 * environments without Worker support (and for tiny whole-buffer payloads).
 *
 * FORMATS (attachmentFormat.ts has the byte layout): new blobs are written as
 * the chunked v2 stream; v1 (`nonce(24) || ciphertext`, one AEAD) still opens
 * on every path. The streaming entry points are the ones to use for files:
 *
 *   encryptFile(key, fileOrBlob)          → Blob of v2 ciphertext
 *   decryptResponse(keys, fetchResponse)  → { blob, keyIndex } | null
 *
 * Neither ever holds the whole file in the JS or WASM heap: plaintext is read
 * one 1 MiB slice at a time and each sealed or opened chunk goes straight into
 * blob storage, which the browser may page to disk. Holding the whole file
 * would take ~5-6.6x its size in memory, which for a 100 MB attachment kills
 * the renderer on a 3-4 GB phone.
 *
 * SECURITY: keys handed to the worker are always a fresh COPY (`key.slice()`)
 * that is TRANSFERRED — the caller keeps its own key, and the worker zeroes its
 * copy after use. The fallback runs on the caller's key in place (never zeroed
 * — the caller owns it and reuses it for the session). Keys are never logged
 * on either path.
 */
import CryptoWorker from './attachmentCryptoWorker?worker';
import {
  StreamDecryptor,
  createEncryptor,
  decryptAny,
  encryptV2,
  type SecretStreamSodium,
} from './attachmentFormat';

/** Below this size, whole-buffer operations run synchronously — a worker
 *  round-trip (structured clone + WASM in-worker) isn't worth it for small
 *  blobs, and small crypto does not jank the main thread. */
const WORKER_MIN_BYTES = 128 * 1024;

/** Result of a blob decrypt: the plaintext plus WHICH candidate key opened it
 *  (0 = the primary/current content key; >0 = a retained pre-rotation key). The
 *  index lets the rotation re-key skip a blob already sealed under the new key. */
export interface BlobDecryptResult {
  // ArrayBuffer-backed (not the generic ArrayBufferLike) so it drops straight
  // into a `new Blob([...])` / `fetch({ body })` without a re-copy.
  plaintext: Uint8Array<ArrayBuffer>;
  keyIndex: number;
}

/** Streamed decrypt result: the plaintext as a Blob (typed as asked). */
export interface StreamDecryptResult {
  blob: Blob;
  keyIndex: number;
}

interface WorkerReply {
  result?: ArrayBuffer;
  plaintext?: ArrayBuffer | null;
  keyIndex?: number;
  blob?: Blob | null;
}

interface Pending {
  resolve: (v: WorkerReply) => void;
  reject: (e: unknown) => void;
}

let worker: Worker | null = null;
let readyPromise: Promise<boolean> | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * Lazily construct the worker and await its libsodium `ready` handshake ONCE.
 * Memoised: resolves true if the worker initialised (subsequent ops may use it),
 * false if Worker is unavailable / construction failed / init timed out (callers
 * then use the main-thread fallback and never transfer a buffer to a dead worker).
 */
function ensureWorkerReady(): Promise<boolean> {
  if (readyPromise) return readyPromise;
  // Capture THIS attempt's promise so late worker events can tell whether the
  // module memo still points at them (vs. a successor that re-inited after a
  // prior fail/timeout). Assigned by the `readyPromise = ...` below before any
  // async event fires.
  const myPromise: Promise<boolean> = readyPromise = new Promise<boolean>((resolve) => {
    if (typeof Worker === 'undefined') { resolve(false); return; }
    let w: Worker;
    try {
      w = new CryptoWorker();
    } catch {
      resolve(false);
      return;
    }
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) {
        // Init timed out. Tear the worker down and clear the memo so a LATER
        // operation can retry constructing a fresh one. This call still
        // resolves false and falls back to the main thread.
        try { w.terminate(); } catch { /* ignore */ }
        readyPromise = null;
        resolve(false);
      }
    }, 5000);

    w.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: number; ok?: boolean } & WorkerReply;
      if (d?.type === 'ready') {
        ready = true;
        clearTimeout(timer);
        worker = w;
        resolve(true);
        return;
      }
      if (d?.type === 'result' && typeof d.id === 'number') {
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        if (d.ok) p.resolve(d);
        else p.reject(new Error('attachment crypto worker failed'));
      }
    });

    const fail = () => {
      // Worker crashed — reject everything in flight, tear the errored worker
      // down, and clear the memo so the NEXT op re-inits a fresh worker.
      try { w.terminate(); } catch { /* ignore */ }
      // Only clear the module memo if it STILL points at this attempt. A late
      // error/messageerror from a superseded worker must not null out a
      // healthy successor's `worker`/`readyPromise`.
      if (readyPromise === myPromise) {
        worker = null;
        readyPromise = null;
      }
      for (const p of pending.values()) p.reject(new Error('attachment crypto worker error'));
      pending.clear();
      if (!ready) { clearTimeout(timer); resolve(false); }
    };
    w.addEventListener('error', fail);
    w.addEventListener('messageerror', fail);
  });
  return myPromise;
}

/** Ceiling on the worker's own part of one operation. Even a 100 MB AEAD is a
 *  few seconds, so this only trips on a genuinely wedged worker (an op that
 *  never posts a result and never fires 'error') — bounding the await instead
 *  of stranding the caller, and every subsequent op, forever. Streamed
 *  decrypts arm it only once the last chunk is sent, so a slow network can
 *  never trip it. */
const OP_TIMEOUT_MS = 60_000;
/** Extra allowance per MiB for a file-sized operation on a slow phone. */
const OP_TIMEOUT_PER_MIB_MS = 1_000;

function timeoutFor(bytes: number): number {
  return OP_TIMEOUT_MS + Math.ceil(bytes / (1024 * 1024)) * OP_TIMEOUT_PER_MIB_MS;
}

/** Register a reply slot for `id`; `arm(ms)` starts its wedge timeout. */
function expect(w: Worker, id: number): { promise: Promise<WorkerReply>; arm: (ms: number) => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<WorkerReply>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
      reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
    });
  });
  const arm = (ms: number) => {
    timer = setTimeout(() => {
      const p = pending.get(id);
      if (!p) return; // already settled
      pending.delete(id);
      // Wedged worker: drop it so the NEXT op constructs a fresh one instead
      // of awaiting a worker that will never reply. Guarded so we don't null a
      // successor that already replaced this worker.
      if (worker === w) { worker = null; readyPromise = null; }
      try { w.terminate(); } catch { /* ignore */ }
      p.reject(new Error('attachment crypto worker timed out'));
    }, ms);
  };
  return { promise, arm };
}

function post(
  msg: { id: number; type: string; [k: string]: unknown },
  transfer: Transferable[],
  timeoutMs: number = OP_TIMEOUT_MS,
): Promise<WorkerReply> {
  const w = worker;
  if (!w) return Promise.reject(new Error('attachment crypto worker unavailable'));
  const { promise, arm } = expect(w, msg.id);
  arm(timeoutMs);
  w.postMessage(msg, transfer);
  return promise;
}

/** A transferable ArrayBuffer holding exactly `u`'s bytes (copies only if `u` is
 *  a partial view over a larger buffer). */
function fullBuffer(u: Uint8Array): ArrayBuffer {
  const buf = u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer : u.slice().buffer;
  // Our call sites only ever pass ArrayBuffer-backed arrays (file/response
  // bytes), never a SharedArrayBuffer, so this narrowing is sound.
  return buf as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Main-thread fallback: the same attachmentFormat code, on a lazily loaded
// libsodium (the chunk crypto.ts already loads, so no second download).
// ---------------------------------------------------------------------------

let localSodium: Promise<SecretStreamSodium> | null = null;

function mainThreadSodium(): Promise<SecretStreamSodium> {
  if (!localSodium) {
    localSodium = import('libsodium-wrappers').then(async (mod) => {
      await mod.default.ready;
      return mod.default as unknown as SecretStreamSodium;
    });
  }
  return localSodium;
}

async function encryptSourceLocally(key: Uint8Array, source: Blob): Promise<Blob> {
  const s = await mainThreadSodium();
  const enc = createEncryptor(s, key);
  const parts: Blob[] = [new Blob([enc.header as Uint8Array<ArrayBuffer>])];
  const size = source.size;
  let pos = 0;
  do {
    const end = Math.min(pos + enc.chunkSize, size);
    const plain = new Uint8Array(await source.slice(pos, end).arrayBuffer());
    const ct = enc.push(plain, end === size);
    plain.fill(0);
    parts.push(new Blob([ct as Uint8Array<ArrayBuffer>]));
    pos = end;
  } while (pos < size);
  return new Blob(parts, { type: 'application/octet-stream' });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a file (or any Blob) into a v2 ciphertext Blob, streaming: one chunk
 * of the file is read and sealed at a time. The result goes straight into
 * `fetch(url, { method: 'PUT', body })` and its `.size` is the size to register.
 */
export async function encryptFile(key: Uint8Array, source: Blob): Promise<Blob> {
  if (source.size >= WORKER_MIN_BYTES && await ensureWorkerReady() && worker) {
    const id = nextId++;
    const keyCopy = key.slice();          // never hand the caller's key to the worker
    const res = await post(
      { id, type: 'encryptBlob', key: keyCopy.buffer, source },
      [keyCopy.buffer],
      timeoutFor(source.size),
    );
    if (!res.blob) throw new Error('attachment encrypt failed');
    return res.blob;
  }
  return encryptSourceLocally(key, source);
}

/**
 * Decrypt a downloaded attachment as it streams in, trying each candidate key
 * in order (primary content key first, then any retained pre-rotation keys).
 * Reads v2 chunk by chunk and v1 whole. Null when the response is not OK, the
 * body cannot be read, or no key opens it. `contentType` types the Blob.
 */
export async function decryptResponse(
  keys: Uint8Array[],
  resp: Response,
  contentType = 'application/octet-stream',
): Promise<StreamDecryptResult | null> {
  if (keys.length === 0 || !resp.ok) return null;
  const body = resp.body;
  if (!body) {
    // No streaming body in this environment: read it whole.
    const packet = new Uint8Array(await resp.arrayBuffer());
    const dec = await decryptBlob(keys, packet);
    return dec ? { blob: new Blob([dec.plaintext], { type: contentType }), keyIndex: dec.keyIndex } : null;
  }

  if (await ensureWorkerReady() && worker) {
    const w = worker;
    const id = nextId++;
    const keyCopies = keys.map((k) => k.slice());
    const { promise, arm } = expect(w, id);
    // Settled by `dend`'s reply, or rejected by a worker crash / wedge.
    promise.catch(() => {});
    w.postMessage({ type: 'dstart', id, keys: keyCopies.map((k) => k.buffer) }, keyCopies.map((k) => k.buffer));
    const reader = body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        if (worker !== w) throw new Error('attachment crypto worker went away');
        received += value.length;
        const buf = fullBuffer(value);
        w.postMessage({ type: 'dchunk', id, data: buf }, [buf]);
      }
    } catch {
      // Network error mid-body, or the worker died: drop the stream.
      try { w.postMessage({ type: 'dabort', id }); } catch { /* worker gone */ }
      pending.delete(id);
      return null;
    }
    w.postMessage({ type: 'dend', id, contentType });
    arm(timeoutFor(received));
    try {
      const res = await promise;
      return res.blob ? { blob: res.blob, keyIndex: res.keyIndex ?? 0 } : null;
    } catch {
      return null;
    }
  }

  // No worker: same streaming decrypt on the main thread.
  const s = await mainThreadSodium();
  const dec = new StreamDecryptor(s, keys);
  const parts: Blob[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        for (const piece of dec.write(value)) parts.push(new Blob([piece as Uint8Array<ArrayBuffer>]));
      }
    }
    for (const piece of dec.end()) parts.push(new Blob([piece as Uint8Array<ArrayBuffer>]));
  } catch {
    return null;
  }
  return { blob: new Blob(parts, { type: contentType }), keyIndex: dec.keyIndex };
}

/**
 * Encrypt a buffer already in memory into v2 bytes. Large buffers go to the
 * worker; small ones (and no-worker environments) run on the main thread.
 * Prefer `encryptFile` for anything file-sized — this one holds the plaintext
 * and the ciphertext at once. Throws on worker failure (the caller's buffer is
 * transferred, so a retry isn't possible).
 */
export async function encryptBlob(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (data.length >= WORKER_MIN_BYTES && await ensureWorkerReady() && worker) {
    const id = nextId++;
    const keyCopy = key.slice();          // never hand the caller's key to the worker
    const dataBuf = fullBuffer(data);
    const res = await post({ id, type: 'encrypt', key: keyCopy.buffer, data: dataBuf },
      [keyCopy.buffer, dataBuf], timeoutFor(data.length));
    if (!res.result) throw new Error('attachment encrypt failed');
    return new Uint8Array(res.result);
  }
  return encryptV2(await mainThreadSodium(), key, data);
}

/**
 * Decrypt a whole v1 or v2 blob already in memory, trying each candidate key in
 * order. Returns the plaintext and the index of the key that opened it, or
 * null if none did. Prefer `decryptResponse` for downloads.
 */
export async function decryptBlob(keys: Uint8Array[], packet: Uint8Array): Promise<BlobDecryptResult | null> {
  if (keys.length === 0) return null;
  if (packet.length >= WORKER_MIN_BYTES && await ensureWorkerReady() && worker) {
    const id = nextId++;
    const keyCopies = keys.map((k) => k.slice());
    const keyBuffers = keyCopies.map((k) => k.buffer);
    const dataBuf = fullBuffer(packet);
    try {
      const res = await post({ id, type: 'decrypt', keys: keyBuffers, data: dataBuf },
        [...keyBuffers, dataBuf], timeoutFor(packet.length));
      if (!res.plaintext) return null;
      return { plaintext: new Uint8Array(res.plaintext), keyIndex: res.keyIndex ?? 0 };
    } catch {
      // Worker failed mid-flight; `packet` was transferred so we can't cleanly
      // retry. Surface as a decrypt miss — callers degrade (warn / retry /
      // leave the blob for the owner's retained-key fallback).
      return null;
    }
  }
  const r = decryptAny(await mainThreadSodium(), keys, packet);
  return r ? { plaintext: r.plaintext, keyIndex: r.keyIndex } : null;
}
