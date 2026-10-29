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
 * Web Worker: attachment BLOB encryption and decryption, off the main thread.
 *
 * WHY: attachment blobs are up to 100 MB (200 MB re-key budget on rotation).
 * Sealing or opening them on the main thread janks the UI; doing it as ONE
 * AEAD (the v1 format) also needs the whole file several times over in memory
 * — 561 MiB RSS to encrypt a 100 MB file, 661 MiB with a decrypt, inside the
 * Android WebView too. This worker writes the chunked v2 format
 * (attachmentFormat.ts) from a Blob, one 1 MiB chunk at a time, and decrypts
 * downloads chunk by chunk as they arrive, so its heap stays at a few MiB
 * whatever the file size. v1 blobs still open (whole).
 *
 * SECURITY: the content key crosses into a same-origin dedicated worker — no
 * more exposed than the main thread (workers are same-origin-isolated; the CSP
 * pins `worker-src 'self' blob:`). Each key arrives as a TRANSFERRED copy (the
 * caller keeps its own key), is used, and is ZEROED (`fill(0)`) once the
 * operation ends. Plaintext chunks read from a file are wiped after sealing.
 * Keys are never logged.
 *
 * Message protocol (see attachmentCrypto.ts for the main-thread half):
 *   in  { type:'encrypt', id, key:ArrayBuffer, data:ArrayBuffer }          whole buffer → v2
 *   out { type:'result',  id, ok:true, result:ArrayBuffer }                (transferred)
 *   in  { type:'decrypt', id, keys:ArrayBuffer[], data:ArrayBuffer }       whole buffer, v1 or v2
 *   out { type:'result',  id, ok:true, plaintext:ArrayBuffer|null, keyIndex:number }
 *   in  { type:'encryptBlob', id, key:ArrayBuffer, source:Blob }           streamed → v2
 *   out { type:'result',  id, ok:true, blob:Blob }
 *   in  { type:'dstart', id, keys:ArrayBuffer[] }                          streamed decrypt:
 *   in  { type:'dchunk', id, data:ArrayBuffer }                            ciphertext as it
 *   in  { type:'dend',   id, contentType:string }                          arrives, then end
 *   out { type:'result', id, ok:true, blob:Blob|null, keyIndex:number }    (after dend)
 *   in  { type:'dabort', id }                                              drop a stream
 *   out { type:'result', id, ok:false }                                    (on error)
 *   out { type:'ready' }   // posted once libsodium has initialised
 */
import _sodium from 'libsodium-wrappers';
import {
  StreamDecryptor,
  createEncryptor,
  decryptAny,
  encryptV2,
  type SecretStreamSodium,
} from './attachmentFormat';

// Minimal typed view of the dedicated-worker global. Declared locally (rather
// than pulling in the `webworker` TS lib, which collides with the default DOM
// lib on `self` / `postMessage` / `MessageEvent`) so this file typechecks under
// the project's DOM-lib default. `MessageEvent` / `Transferable` come from DOM.
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}
const ctx = self as unknown as WorkerScope;

type Sodium = typeof _sodium;
let sodium: Sodium | null = null;

async function ensureSodium(): Promise<Sodium> {
  if (sodium) return sodium;
  await _sodium.ready;
  sodium = _sodium;
  return sodium;
}

function ss(s: Sodium): SecretStreamSodium {
  return s as unknown as SecretStreamSodium;
}

/** Zero a transferred key buffer once we're done with it. */
function zero(buf: ArrayBuffer): void {
  try { new Uint8Array(buf).fill(0); } catch { /* detached — nothing to zero */ }
}

/** One in-flight streamed decrypt. `failed` latches the first error: later
 *  chunks are dropped and `dend` reports the failure. */
interface DecryptStream {
  keys: ArrayBuffer[];
  dec: StreamDecryptor;
  parts: Blob[];
  failed: boolean;
}
const streams = new Map<number, DecryptStream>();

/** Stream a Blob through the v2 writer: one chunk read, sealed, wiped and
 *  parked in blob storage at a time, so neither the file nor its ciphertext
 *  is ever whole in this heap. */
async function encryptSource(s: Sodium, key: Uint8Array, source: Blob): Promise<Blob> {
  const enc = createEncryptor(ss(s), key);
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

function pushPieces(st: DecryptStream, pieces: Uint8Array[]): void {
  for (const p of pieces) {
    st.parts.push(new Blob([p as Uint8Array<ArrayBuffer>]));
    p.fill(0);
  }
}

interface EncryptMsg { type: 'encrypt'; id: number; key: ArrayBuffer; data: ArrayBuffer }
interface DecryptMsg { type: 'decrypt'; id: number; keys: ArrayBuffer[]; data: ArrayBuffer }
interface EncryptBlobMsg { type: 'encryptBlob'; id: number; key: ArrayBuffer; source: Blob }
interface DStartMsg { type: 'dstart'; id: number; keys: ArrayBuffer[] }
interface DChunkMsg { type: 'dchunk'; id: number; data: ArrayBuffer }
interface DEndMsg { type: 'dend'; id: number; contentType?: string }
interface DAbortMsg { type: 'dabort'; id: number }
type InMsg = EncryptMsg | DecryptMsg | EncryptBlobMsg | DStartMsg | DChunkMsg | DEndMsg | DAbortMsg;

const KNOWN = new Set(['encrypt', 'decrypt', 'encryptBlob', 'dstart', 'dchunk', 'dend', 'dabort']);

function endStream(id: number): void {
  const st = streams.get(id);
  if (!st) return;
  streams.delete(id);
  for (const kb of st.keys) zero(kb);
  st.parts = [];
}

async function handle(s: Sodium, msg: InMsg): Promise<void> {
  const id = msg.id;
  switch (msg.type) {
    case 'encrypt': {
      try {
        const out = encryptV2(ss(s), new Uint8Array(msg.key), new Uint8Array(msg.data));
        ctx.postMessage({ type: 'result', id, ok: true, result: out.buffer }, [out.buffer]);
      } catch {
        ctx.postMessage({ type: 'result', id, ok: false });
      } finally {
        zero(msg.key);  // wipe our transferred key copy
        zero(msg.data); // wipe the transferred file plaintext
      }
      return;
    }
    case 'decrypt': {
      // Try each candidate key in order (primary content key, then any
      // retained pre-rotation keys) — return the first success + its index.
      try {
        const keys = msg.keys.map((k) => new Uint8Array(k));
        const r = decryptAny(ss(s), keys, new Uint8Array(msg.data));
        if (r) {
          ctx.postMessage(
            { type: 'result', id, ok: true, plaintext: r.plaintext.buffer, keyIndex: r.keyIndex },
            [r.plaintext.buffer],
          );
        } else {
          ctx.postMessage({ type: 'result', id, ok: true, plaintext: null, keyIndex: -1 });
        }
      } catch {
        ctx.postMessage({ type: 'result', id, ok: false });
      } finally {
        for (const kb of msg.keys) zero(kb); // wipe every transferred key copy
      }
      return;
    }
    case 'encryptBlob': {
      try {
        const blob = await encryptSource(s, new Uint8Array(msg.key), msg.source);
        ctx.postMessage({ type: 'result', id, ok: true, blob });
      } catch {
        ctx.postMessage({ type: 'result', id, ok: false });
      } finally {
        zero(msg.key);
      }
      return;
    }
    case 'dstart': {
      const keys = msg.keys.map((k) => new Uint8Array(k));
      streams.set(id, { keys: msg.keys, dec: new StreamDecryptor(ss(s), keys), parts: [], failed: false });
      return;
    }
    case 'dchunk': {
      const st = streams.get(id);
      if (!st || st.failed) return;
      try {
        pushPieces(st, st.dec.write(new Uint8Array(msg.data)));
      } catch {
        // A wrong key or a forged chunk: stop decrypting now, report at dend.
        st.failed = true;
        st.parts = [];
      }
      return;
    }
    case 'dend': {
      const st = streams.get(id);
      if (!st) {
        ctx.postMessage({ type: 'result', id, ok: false });
        return;
      }
      try {
        if (!st.failed) pushPieces(st, st.dec.end());
      } catch {
        st.failed = true;
      }
      if (st.failed) {
        // A decrypt miss, same shape as the whole-buffer path's null.
        ctx.postMessage({ type: 'result', id, ok: true, blob: null, keyIndex: -1 });
      } else {
        const blob = new Blob(st.parts, { type: msg.contentType || 'application/octet-stream' });
        ctx.postMessage({ type: 'result', id, ok: true, blob, keyIndex: st.dec.keyIndex });
      }
      endStream(id);
      return;
    }
    case 'dabort': {
      endStream(id);
      return;
    }
  }
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data as InMsg;
  if (!msg || !KNOWN.has(msg.type)) return;

  // Stream order holds without a queue: every handler except `encryptBlob`
  // runs synchronously once libsodium is ready, and each message's handler is
  // a microtask of its own event, so a stream's chunks reach its decryptor in
  // arrival order. `encryptBlob` awaits file reads, which only lets unrelated
  // operations (a preview decrypt) run alongside it rather than behind it.
  void ensureSodium().then((s) => handle(s, msg)).catch(() => {
    // ensureSodium() rejected before the handler ran, so nothing above zeroed
    // the transferred key copies (and, for encrypt, the file plaintext). Wipe
    // them here too so no raw key bytes linger in the worker heap on a
    // WASM-init failure, THEN report it.
    if (msg.type === 'encrypt') { zero(msg.key); zero(msg.data); }
    else if (msg.type === 'encryptBlob') zero(msg.key);
    else if (msg.type === 'decrypt' || msg.type === 'dstart') for (const kb of msg.keys) zero(kb);
    else if (msg.type === 'dend') endStream(msg.id);
    if (msg.type !== 'dchunk' && msg.type !== 'dstart' && msg.type !== 'dabort') {
      ctx.postMessage({ type: 'result', id: msg.id, ok: false });
    }
  });
});

// Front-load the WASM compile off the main thread and signal readiness.
void ensureSodium().then(() => ctx.postMessage({ type: 'ready' }));
