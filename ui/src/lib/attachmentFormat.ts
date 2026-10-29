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
 * Attachment blob wire formats — the one definition every client follows.
 *
 * Pure: no DOM, no Worker, no module-level sodium. The libsodium instance is
 * passed in, so the dedicated worker, the main-thread fallback and the unit
 * tests all run exactly this code.
 *
 * ## v1 (legacy — READ everywhere, not written by the web editor)
 *
 *     nonce(24) || XChaCha20-Poly1305-IETF(plaintext)      (no associated data)
 *
 * One AEAD over the whole file, so the writer needs the whole file and the
 * reader the whole blob in memory at once. libsodium.js also copies both into
 * the WASM heap: a 100 MB file measured 561 MiB RSS to encrypt and 661 MiB
 * with a decrypt, plus a 1.5 s heap-growth stall on the first large op. v2
 * avoids all of that.
 *
 * ## v2 (chunked stream — what the web editor writes)
 *
 *     offset  size  field
 *     0       4     magic 0x50 0x4E 0x41 0x54 ("PNAT")
 *     4       1     format version = 2
 *     5       3     reserved, MUST be zero (a reader rejects anything else)
 *     8       4     chunk size, u32 little-endian: plaintext bytes per chunk
 *     12      24    crypto_secretstream_xchacha20poly1305 header
 *     36      ...   chunks, each = secretstream push output (plaintext + 17)
 *
 * Every chunk except the last carries exactly `chunk size` plaintext bytes and
 * TAG_MESSAGE; the last carries 0..chunk size bytes and TAG_FINAL (an empty
 * file is one FINAL chunk of 0 bytes). No associated data. The secretstream
 * gives what a chunked format needs and a hand-rolled nonce-per-chunk scheme
 * gets wrong: chunks cannot be reordered, dropped, duplicated or spliced in
 * from another blob, and truncation is detected because the FINAL tag is
 * missing. The chunk size is authenticated structurally — altering it shifts
 * every chunk boundary and the first chunk fails to open.
 *
 * A reader:
 *  - treats a blob as v2 only when the first 8 bytes are magic + 2 + three
 *    zeros; anything else is v1. A v1 blob starts with a random nonce, so a
 *    false match needs 64 specific bits (2^-64), and even then the v2 open
 *    fails authentication and the caller reports a decrypt miss;
 *  - refuses a chunk size outside [V2_MIN_CHUNK, V2_MAX_CHUNK] before
 *    allocating anything, since the header is unauthenticated input;
 *  - requires TAG_FINAL on the last chunk and nothing after it.
 *
 * The native readers (the Android and iOS apps) implement the same rules;
 * the cross-platform vectors in attachmentFormat.test.ts are shared with
 * them.
 */

// The subset of libsodium-wrappers this module uses. Declared structurally so
// both `libsodium-wrappers` and `libsodium-wrappers-sumo` satisfy it.
export interface SecretStreamSodium {
  crypto_secretstream_xchacha20poly1305_init_push(key: Uint8Array): {
    state: unknown;
    header: Uint8Array;
  };
  crypto_secretstream_xchacha20poly1305_push(
    state: unknown,
    message: Uint8Array,
    ad: Uint8Array | null,
    tag: number,
  ): Uint8Array;
  crypto_secretstream_xchacha20poly1305_init_pull(header: Uint8Array, key: Uint8Array): unknown;
  crypto_secretstream_xchacha20poly1305_pull(
    state: unknown,
    cipher: Uint8Array,
    ad?: Uint8Array | null,
  ): { message: Uint8Array; tag: number } | false;
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: Uint8Array | null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
}

export const V2_MAGIC = [0x50, 0x4e, 0x41, 0x54] as const;
export const V2_VERSION = 2;
/** magic(4) + version(1) + reserved(3) + chunk size(4). */
export const V2_PREFIX_LEN = 12;
/** crypto_secretstream_xchacha20poly1305_HEADERBYTES. */
const SS_HEADER_LEN = 24;
/** Prefix + the secretstream header: 36 bytes. */
export const V2_HEADER_LEN = V2_PREFIX_LEN + SS_HEADER_LEN;
/** 1 MiB: big enough that per-chunk overhead is negligible (17 B per MiB),
 *  small enough that a phone never holds more than a few MiB at once. */
export const V2_CHUNK_SIZE = 1024 * 1024;
export const V2_MIN_CHUNK = 1024;
export const V2_MAX_CHUNK = 8 * 1024 * 1024;

/** crypto_secretstream_xchacha20poly1305_ABYTES: 1 tag byte + 16 MAC bytes. */
export const SS_ABYTES = 17;
const TAG_MESSAGE = 0;
const TAG_FINAL = 3;

/** v1 nonce length (crypto_aead_xchacha20poly1305_ietf_NPUBBYTES). */
export const V1_NONCE_LEN = 24;

/** Thrown for any v2 structural or authentication failure. Callers that only
 *  need "did it open" turn it into a null result. */
export class AttachmentFormatError extends Error {}

/** Whether `bytes` begins with a v2 prefix. Needs at least 8 bytes. */
export function isV2(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return (
    bytes[0] === V2_MAGIC[0] &&
    bytes[1] === V2_MAGIC[1] &&
    bytes[2] === V2_MAGIC[2] &&
    bytes[3] === V2_MAGIC[3] &&
    bytes[4] === V2_VERSION &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0
  );
}

/** The chunk size a v2 prefix declares, or null when it is out of bounds. */
export function v2ChunkSize(prefix: Uint8Array): number | null {
  if (prefix.length < V2_PREFIX_LEN || !isV2(prefix)) return null;
  const size =
    (prefix[8] | (prefix[9] << 8) | (prefix[10] << 16) | (prefix[11] << 24)) >>> 0;
  if (size < V2_MIN_CHUNK || size > V2_MAX_CHUNK) return null;
  return size;
}

/** Exact ciphertext size v2 produces for `plainLen` bytes — what the server's
 *  per-object cap and the storage quota count, so the upload can be refused
 *  before any work is done. */
export function v2EncryptedSize(plainLen: number, chunkSize: number = V2_CHUNK_SIZE): number {
  const chunks = Math.max(1, Math.ceil(plainLen / chunkSize));
  return V2_HEADER_LEN + plainLen + chunks * SS_ABYTES;
}

function prefixBytes(chunkSize: number): Uint8Array {
  const p = new Uint8Array(V2_PREFIX_LEN);
  p.set(V2_MAGIC, 0);
  p[4] = V2_VERSION;
  p[8] = chunkSize & 0xff;
  p[9] = (chunkSize >>> 8) & 0xff;
  p[10] = (chunkSize >>> 16) & 0xff;
  p[11] = (chunkSize >>> 24) & 0xff;
  return p;
}

/** Streaming v2 writer. `header` goes first; then one `push` per chunk, in
 *  order, with `last` set on (and only on) the final one. */
export interface ChunkEncryptor {
  readonly header: Uint8Array;
  readonly chunkSize: number;
  push(chunk: Uint8Array, last: boolean): Uint8Array;
}

export function createEncryptor(
  sodium: SecretStreamSodium,
  key: Uint8Array,
  chunkSize: number = V2_CHUNK_SIZE,
): ChunkEncryptor {
  if (chunkSize < V2_MIN_CHUNK || chunkSize > V2_MAX_CHUNK) {
    throw new AttachmentFormatError(`chunk size out of range: ${chunkSize}`);
  }
  const { state, header: ssHeader } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const header = new Uint8Array(V2_HEADER_LEN);
  header.set(prefixBytes(chunkSize), 0);
  header.set(ssHeader, V2_PREFIX_LEN);
  let finished = false;
  return {
    header,
    chunkSize,
    push(chunk: Uint8Array, last: boolean): Uint8Array {
      if (finished) throw new AttachmentFormatError('push after the final chunk');
      if (chunk.length > chunkSize || (!last && chunk.length !== chunkSize)) {
        throw new AttachmentFormatError('chunk length does not match the declared chunk size');
      }
      if (last) finished = true;
      return sodium.crypto_secretstream_xchacha20poly1305_push(
        state, chunk, null, last ? TAG_FINAL : TAG_MESSAGE,
      );
    },
  };
}

/** Whole-buffer v2 encrypt. Fine for buffers already in memory (tests, small
 *  payloads); large files go through `createEncryptor` chunk by chunk. */
export function encryptV2(
  sodium: SecretStreamSodium,
  key: Uint8Array,
  data: Uint8Array,
  chunkSize: number = V2_CHUNK_SIZE,
): Uint8Array<ArrayBuffer> {
  const enc = createEncryptor(sodium, key, chunkSize);
  const out = new Uint8Array(v2EncryptedSize(data.length, chunkSize));
  out.set(enc.header, 0);
  let off = V2_HEADER_LEN;
  let pos = 0;
  do {
    const end = Math.min(pos + chunkSize, data.length);
    const ct = enc.push(data.subarray(pos, end), end === data.length);
    out.set(ct, off);
    off += ct.length;
    pos = end;
  } while (pos < data.length);
  return out;
}

/** v1 open under one key; null on authentication failure. */
export function openV1(
  sodium: SecretStreamSodium,
  key: Uint8Array,
  packet: Uint8Array,
): Uint8Array | null {
  if (packet.length < V1_NONCE_LEN) return null;
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null, packet.subarray(V1_NONCE_LEN), null, packet.subarray(0, V1_NONCE_LEN), key,
    );
  } catch {
    return null;
  }
}

/**
 * Incremental reader for either format. Feed ciphertext with `write` as it
 * arrives (any split), then call `end`. Both return the plaintext pieces that
 * became available, in order; concatenated they are the file.
 *
 * `keys` are tried in order on the first chunk — the current content key,
 * then retained pre-rotation keys — and `keyIndex` reports which one opened
 * the blob (the re-key uses index 0 to mean "already under the new key").
 *
 * v2 is decrypted chunk by chunk, so memory stays at about one chunk no matter
 * how large the file is, and each input byte is copied once. v1 cannot be
 * streamed: it is buffered whole and opened at `end`.
 *
 * Every failure (wrong keys, tampering, truncation, trailing bytes, a bad
 * header) throws AttachmentFormatError; after a throw the instance is dead.
 */
export class StreamDecryptor {
  private readonly sodium: SecretStreamSodium;
  private readonly keys: Uint8Array[];
  /** Received but not yet consumed input, oldest first. */
  private queue: Uint8Array[] = [];
  private queued = 0;
  private mode: 'unknown' | 'v1' | 'v2' = 'unknown';
  private chunkSize = 0;
  private ssHeader: Uint8Array | null = null;
  private state: unknown = null;
  private finalSeen = false;
  private ended = false;
  private failed = false;
  /** Index into `keys` of the key that opened the blob; -1 until known. */
  keyIndex = -1;

  constructor(sodium: SecretStreamSodium, keys: Uint8Array[]) {
    this.sodium = sodium;
    this.keys = keys;
  }

  get format(): 'v1' | 'v2' | null {
    return this.mode === 'unknown' ? null : this.mode;
  }

  write(bytes: Uint8Array): Uint8Array[] {
    return this.run(() => {
      if (bytes.length > 0) {
        // Copy: the caller may reuse or transfer its buffer.
        this.queue.push(bytes.slice());
        this.queued += bytes.length;
      }
      if (this.mode === 'unknown') {
        if (this.queued < 8) return [];
        this.mode = isV2(this.peek(8)) ? 'v2' : 'v1';
      }
      return this.mode === 'v2' ? this.drainV2(false) : [];
    });
  }

  end(): Uint8Array[] {
    return this.run(() => {
      this.ended = true;
      // Fewer than 8 bytes in total cannot be v2, so it can only be v1.
      if (this.mode === 'unknown') this.mode = 'v1';
      if (this.mode === 'v1') return [this.finishV1()];
      const out = this.drainV2(true);
      if (!this.finalSeen) throw new AttachmentFormatError('v2 stream truncated (no final chunk)');
      return out;
    });
  }

  private run(body: () => Uint8Array[]): Uint8Array[] {
    if (this.failed) throw new AttachmentFormatError('decryptor already failed');
    if (this.ended) throw new AttachmentFormatError('decryptor already ended');
    try {
      return body();
    } catch (e) {
      this.failed = true;
      this.queue = [];
      this.queued = 0;
      throw e instanceof AttachmentFormatError ? e : new AttachmentFormatError(String(e));
    }
  }

  /** The first `n` queued bytes, without consuming them (n <= queued). */
  private peek(n: number): Uint8Array {
    if (this.queue[0].length >= n) return this.queue[0].subarray(0, n);
    const out = new Uint8Array(n);
    let o = 0;
    for (const part of this.queue) {
      const k = Math.min(part.length, n - o);
      out.set(part.subarray(0, k), o);
      o += k;
      if (o === n) break;
    }
    return out;
  }

  /** Consume exactly `n` queued bytes (n <= queued) into one fresh buffer. */
  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const head = this.queue[0];
      const k = Math.min(head.length, n - o);
      out.set(head.subarray(0, k), o);
      o += k;
      if (k === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(k);
    }
    this.queued -= n;
    return out;
  }

  private drainV2(atEnd: boolean): Uint8Array[] {
    const out: Uint8Array[] = [];
    if (this.ssHeader === null) {
      if (this.queued < V2_HEADER_LEN) {
        if (atEnd) throw new AttachmentFormatError('v2 header truncated');
        return out;
      }
      const header = this.take(V2_HEADER_LEN);
      const size = v2ChunkSize(header);
      if (size === null) throw new AttachmentFormatError('v2 chunk size out of range');
      this.chunkSize = size;
      this.ssHeader = header.subarray(V2_PREFIX_LEN, V2_HEADER_LEN);
    }
    const full = this.chunkSize + SS_ABYTES;
    while (!this.finalSeen) {
      // A full-size chunk is opened as soon as it is here; a short one can
      // only be the last, so it waits for `end`.
      if (this.queued >= full) out.push(this.openChunk(this.take(full)));
      else if (atEnd && this.queued > 0) out.push(this.openChunk(this.take(this.queued)));
      else break;
    }
    if (this.finalSeen && this.queued > 0) {
      throw new AttachmentFormatError('v2 data after the final chunk');
    }
    return out;
  }

  private openChunk(chunk: Uint8Array): Uint8Array {
    if (chunk.length < SS_ABYTES) throw new AttachmentFormatError('v2 chunk too short');
    let res: { message: Uint8Array; tag: number } | false = false;
    if (this.state === null) {
      // First chunk: find the key. init_pull cannot fail on a wrong key — only
      // the first pull authenticates — so each candidate gets a fresh state.
      for (let i = 0; i < this.keys.length; i++) {
        const st = this.sodium.crypto_secretstream_xchacha20poly1305_init_pull(this.ssHeader!, this.keys[i]);
        res = this.pull(st, chunk);
        if (res) {
          this.state = st;
          this.keyIndex = i;
          break;
        }
      }
      if (!res) throw new AttachmentFormatError('v2 first chunk opens under none of the keys');
    } else {
      res = this.pull(this.state, chunk);
      if (!res) throw new AttachmentFormatError('v2 chunk failed authentication');
    }
    const isFinal = res.tag === TAG_FINAL;
    if (!isFinal && res.tag !== TAG_MESSAGE) throw new AttachmentFormatError(`unexpected v2 tag ${res.tag}`);
    // Only the last chunk may be short; a short MESSAGE chunk means the writer
    // (or the server) broke the layout.
    if (!isFinal && res.message.length !== this.chunkSize) {
      throw new AttachmentFormatError('short v2 chunk that is not the final one');
    }
    if (isFinal) this.finalSeen = true;
    return res.message;
  }

  private pull(state: unknown, chunk: Uint8Array): { message: Uint8Array; tag: number } | false {
    try {
      return this.sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
    } catch {
      return false;
    }
  }

  private finishV1(): Uint8Array {
    const packet = this.take(this.queued);
    for (let i = 0; i < this.keys.length; i++) {
      const pt = openV1(this.sodium, this.keys[i], packet);
      if (pt) {
        this.keyIndex = i;
        return pt;
      }
    }
    throw new AttachmentFormatError('v1 blob opens under none of the keys');
  }
}

/** Whole-buffer decrypt of either format. Null when no key opens it or the
 *  blob is malformed. */
export function decryptAny(
  sodium: SecretStreamSodium,
  keys: Uint8Array[],
  packet: Uint8Array,
): { plaintext: Uint8Array<ArrayBuffer>; keyIndex: number; format: 'v1' | 'v2' } | null {
  const d = new StreamDecryptor(sodium, keys);
  try {
    const parts = [...d.write(packet), ...d.end()];
    let total = 0;
    for (const p of parts) total += p.length;
    const plaintext = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      plaintext.set(p, o);
      o += p.length;
    }
    return { plaintext, keyIndex: d.keyIndex, format: d.format ?? 'v1' };
  } catch {
    return null;
  }
}
