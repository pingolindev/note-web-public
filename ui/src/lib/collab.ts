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
 * Real-time collaboration client — Yjs-backed sync over the note server's
 * WebSocket relay.
 *
 * Every on-wire frame is wrapped in a per-note session-key AEAD, so the
 * relay is provably blind to note content — it does blind binary fan-out and
 * never parses the payload. This is FAIL CLOSED: without a session key the
 * session refuses to connect rather than fall back to plaintext Yjs.
 *
 * Lifecycle:
 *   const session = new CollabSession(noteId, initialText);
 *   session.connect();              // opens WebSocket
 *   session.yText                    // Y.Text to bind CodeMirror to
 *   session.onRemoteChange(cb)      // fires after each remote update
 *   session.destroy();              // closes socket, frees doc
 */
import * as Y from 'yjs';
import { encoding, decoding } from 'lib0';
import * as syncProtocol from 'y-protocols/sync';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
import { deriveCollabKey, encryptCollabPayload, decryptCollabPayload, getVaultKey } from './crypto';
import { blake3 } from '@noble/hashes/blake3';
import { accountFetch, getTabAccount, isStopped, reportAccountMismatch } from './account';

/** The collab relay's close code for a socket opened for another account. */
export const CLOSE_ACCOUNT_MISMATCH = 4409;

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Debounce window for the server-snapshot upload while editing.
const SNAPSHOT_DEBOUNCE_MS = 5000;

/**
 * Build a deterministic Yjs update that seeds `text` as the note "body".
 *
 * The seed's CRDT client id is DERIVED FROM THE CONTENT (BLAKE3) rather than a
 * fixed constant. Two clients that seed byte-identical text mint the same items
 * at the same (clientID, clock), so Yjs de-dups them on merge and the note
 * converges to a single copy. Two clients that seed DIVERGENT text get different
 * client ids, so their items do not collide at a shared coordinate: they
 * merge as ordinary concurrent inserts and converge to a (harmless) duplicate —
 * the safe failure — instead of both landing at (clientID=1, clock=0..) with
 * different content, which violates Yjs's (clientID, clock) dedup and
 * permanently splits the doc.
 *
 * The derivation is the low 53 bits of the little-endian u64 taken from the
 * first 8 bytes of BLAKE3(text) — 53 bits so it stays a JS safe integer.
 * Byte-identical to the mobile SDK's note-collab-sdk `deterministic_seed_update`
 * (yrs), so web↔mobile seeds of the same body still dedup — locked by
 * collab.seed.test.ts.
 */
export function deterministicSeedUpdate(text: string): Uint8Array {
  if (!text) return new Uint8Array();
  const seedDoc = new Y.Doc();
  // Content-derived seed client id — low 53 bits of the little-endian u64 from
  // the first 8 bytes of BLAKE3(text). MUST match note-collab-sdk's Rust
  // derivation byte-for-byte (n & ((1<<53)-1)). `lo` is the low 32 bits,
  // `hi & 0x1FFFFF` the next 21 bits (32 + 21 = 53); the result is
  // ≤ Number.MAX_SAFE_INTEGER, so it is represented exactly.
  const h = blake3(new TextEncoder().encode(text)); // Uint8Array(32)
  const lo = (h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0; // low 32 bits, unsigned
  const hi = (h[4] | (h[5] << 8) | (h[6] << 16) | (h[7] << 24)) >>> 0; // next 32 bits, unsigned
  seedDoc.clientID = lo + (hi & 0x1fffff) * 4294967296; // low 53 bits, exact
  seedDoc.getText('body').insert(0, text);
  const update = Y.encodeStateAsUpdate(seedDoc);
  seedDoc.destroy();
  return update;
}

export interface CollabPresence {
  /** Display name shown near the remote cursor. */
  name: string;
  /** Stable color string (CSS) for the remote caret + selection. */
  color: string;
}

/** First character of a display name, uppercased — what the remote-caret
 *  badge shows. `Array.from` so an emoji or any astral-plane first character
 *  survives as one glyph instead of half a surrogate pair. */
function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0].toUpperCase();
}

/**
 * Resolve the colour to publish for a peer's caret, selection and avatar.
 *
 * `||`, NOT `??`. Callers pass `color: ''` to mean "derive one for me" —
 * NoteModal does exactly that — and `??` only falls back on null/undefined, so
 * the empty string would pass straight through. y-codemirror.next would then
 * write `style="background-color: ; border-color: "` on the caret, an invalid
 * declaration the browser drops, leaving the caret, the selection highlight
 * and the collaborator avatar with NO colour at all. The avatar is where it
 * shows most: it is the one element that fills with the colour rather than
 * merely tinting a 2px border.
 */
export function resolvePresenceColor(presence?: CollabPresence & { userId?: string }): string {
  return (
    presence?.color?.trim() ||
    (presence?.userId ? colorForUser(presence.userId) : '') ||
    '#1a73e8'
  );
}

/** Deterministic pastel-ish color per userId — same user on multiple
 *  devices sees the same color, different users see different colors. */
function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

export class CollabSession {
  readonly doc: Y.Doc;
  readonly yText: Y.Text;
  readonly awareness: Awareness;
  private ws: WebSocket | null = null;
  private closed = false;
  /** Debounced server-snapshot upload while editing, so a tab-close/crash mid-edit
   *  still leaves a recent snapshot for the next device to adopt. */
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private retryAttempt = 0;
  private remoteChangeListeners: Array<() => void> = [];
  private connectionListeners: Array<(connected: boolean) => void> = [];
  /** Derived session key — when present every on-wire payload is
   *  XChaCha20-Poly1305 encrypted under this key. Server never sees it. */
  private sessionKey: Uint8Array | null = null;
  private awarenessHandler: ((changed: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => void) | null = null;

  constructor(
    private noteId: string,
    initialText: string = '',
    presence?: CollabPresence & { userId?: string },
    /**
     * Shared 32-byte secret both participants derive their session key
     * from. Pass the per-note content key here — owner and recipient
     * hold the same bytes, so they end up with matching session keys.
     * Falls back to the vault key (owner-only) when no secret is given,
     * which keeps legacy notes working for their owner.
     */
    secret?: Uint8Array | null,
  ) {
    this.doc = new Y.Doc();
    this.yText = this.doc.getText('body');
    this.awareness = new Awareness(this.doc);
    const base = secret ?? getVaultKey();
    this.sessionKey = base ? deriveCollabKey(noteId, base) : null;

    // Seed local presence state so remote clients can render our cursor.
    const color = resolvePresenceColor(presence);
    // y-codemirror.next renders `user.name` verbatim into the remote-caret
    // badge and offers no render hook, so publish the INITIAL: the badge is a
    // circular avatar, not a name label. Deriving it here rather than clipping
    // the name in CSS is what lets that badge use ordinary flex centring — the
    // CSS-only approach needs `font-size: 0` plus `::first-letter`, which
    // forbids `display: flex` and silently collapses every `em` on the element.
    // The full name rides along separately; nothing else reads awareness (the
    // co-edit banner comes from the lock API, and no mobile client uses
    // awareness), so this costs no information anyone is using.
    const fullName = presence?.name ?? 'You';
    this.awareness.setLocalStateField('user', {
      name: initialOf(fullName),
      fullName,
      color,
    });
    // Seed the local doc with the current text so the editor has something to
    // show before the first remote sync completes. Seed DETERMINISTICALLY (via
    // deterministicSeedUpdate, whose client id is derived from the content)
    // instead of inserting directly: if another device seeds the same body
    // concurrently, the two seeds are identical CRDT items and merge to a single
    // copy rather than duplicating. Done before the 'update' handler is
    // registered below, so the seed isn't shipped as a local edit.
    if (initialText) {
      Y.applyUpdate(this.doc, deterministicSeedUpdate(initialText));
    }
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Forward every local (non-remote) update to the relay
      if (origin === this) return;
      this.sendSyncMessage(update);
      this.scheduleSnapshotUpload();
    });

    // Forward local awareness updates to the relay. We include our own
    // clientID in the broadcast so other participants can apply the
    // merged state.
    this.awarenessHandler = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      const update = encodeAwarenessUpdate(this.awareness, changed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, update);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendRaw(this.ws, encoding.toUint8Array(encoder));
      }
    };
    this.awareness.on('update', this.awarenessHandler);
  }

  connect(): void {
    if (this.closed) return;
    // Fail closed: without a session key every frame would ride the relay as
    // plaintext Yjs, defeating its blindness. Refuse to open the socket. The
    // normal editable-note path always derives a key (the per-note content key,
    // or the vault key for the owner), so this only trips when the user could
    // not decrypt the note anyway — nothing to collaborate on.
    if (!this.sessionKey) {
      console.warn('[note/collab] no session key — refusing to open a plaintext collab socket');
      this.connectionListeners.forEach(fn => fn(false));
      return;
    }
    // Adopt the server's canonical encrypted snapshot (if any) so we take a
    // peer's CRDT op-structure instead of relying only on our deterministic seed
    // of the DB text — re-deriving ops from text diverges from a peer that
    // reached the same text via edits, duplicating the edited part. Best-effort
    // + async; the CRDT merge is order-independent so it can land after connect.
    // The socket names its account in its first frame (a WebSocket carries no
    // custom header, and a query string would land in the proxy's logs). With
    // no confirmed account, or a tab already stopped, there is nothing to open.
    const account = getTabAccount();
    if (!account || isStopped()) {
      this.connectionListeners.forEach(fn => fn(false));
      return;
    }
    void this.fetchServerSnapshot();
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/v1/collab/${this.noteId}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // FIRST, before any Yjs frame: which account this socket is for. The
      // relay reads it before joining the room and closes with
      // CLOSE_ACCOUNT_MISMATCH when it is not the session's.
      ws.send(JSON.stringify({ account }));
      this.connected = true;
      this.retryAttempt = 0;
      this.connectionListeners.forEach(fn => fn(true));
      // Send our initial state vector so other participants relay any
      // deltas we haven't seen. The backend is a dumb relay — this goes
      // to every other participant, who each reply with missing updates.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.sendRaw(ws, encoding.toUint8Array(encoder));
    };

    ws.onmessage = (event: MessageEvent) => {
      const frame = new Uint8Array(event.data as ArrayBuffer);
      const data = this.decryptFrame(frame);
      if (!data) {
        // Decryption failure — likely another client without the vault
        // key (shouldn't happen for a user's own notes). Skip the frame;
        // the sync protocol is resilient to dropped messages.
        return;
      }
      const decoder = decoding.createDecoder(data);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        const reply = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) {
          this.sendRaw(ws, encoding.toUint8Array(encoder));
        }
        if (reply === syncProtocol.messageYjsSyncStep2) {
          // A remote update applied to our doc — notify listeners.
          this.remoteChangeListeners.forEach(fn => fn());
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        applyAwarenessUpdate(this.awareness, update, this);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      this.connected = false;
      this.connectionListeners.forEach(fn => fn(false));
      this.ws = null;
      // Another account's session: stop the tab (wipe + reload), never retry.
      if (event?.code === CLOSE_ACCOUNT_MISMATCH) {
        this.closed = true;
        reportAccountMismatch();
        return;
      }
      if (this.closed) return;
      // Reconnect with exponential backoff, capped.
      const delay = Math.min(1000 * 2 ** this.retryAttempt, 30_000);
      this.retryAttempt++;
      setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      // onclose fires right after; nothing extra to do here.
    };
  }

  private sendSyncMessage(update: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.sendRaw(this.ws, encoding.toUint8Array(encoder));
  }

  /** Wrap [plain] in the per-note AEAD and ship it. The relay only ever
   *  sees opaque XChaCha20-Poly1305 ciphertext.
   *
   *  FAIL CLOSED: never put plaintext Yjs on the wire. `connect()` refuses to
   *  open a socket without a session key, so we should always have one here;
   *  if we somehow don't, drop the frame and tear the socket down rather than
   *  leak note content to the (blind) relay. */
  private sendRaw(ws: WebSocket, plain: Uint8Array): void {
    if (!this.sessionKey) {
      console.error('[note/collab] session key missing at send — closing socket to avoid plaintext');
      try { ws.close(); } catch { /* already closing */ }
      return;
    }
    ws.send(encryptCollabPayload(this.sessionKey, plain));
  }

  /** Reverse of sendRaw — unwrap the AEAD. Returns null on decryption
   *  failure (or, fail-closed, when we have no key) so the caller skips the
   *  frame instead of treating ciphertext/plaintext ambiguously. */
  private decryptFrame(wire: Uint8Array): Uint8Array | null {
    if (!this.sessionKey) return null;
    return decryptCollabPayload(this.sessionKey, wire);
  }

  /** GET the server's stored encrypted snapshot (if any) and merge it, adopting
   *  a peer's canonical CRDT op-structure instead of re-deriving ops from the DB
   *  text. Applied with origin=this so it isn't re-broadcast (peers get it via
   *  the normal sync protocol). Best-effort — falls back to the deterministic
   *  seed already applied in the constructor. */
  private async fetchServerSnapshot(): Promise<void> {
    if (this.closed || !this.sessionKey) return;
    try {
      const resp = await accountFetch(`/api/v1/collab/${this.noteId}/snapshot`, { credentials: 'same-origin' });
      if (resp.status !== 200) return;
      const update = this.decryptFrame(new Uint8Array(await resp.arrayBuffer()));
      if (update && !this.closed) Y.applyUpdate(this.doc, update, this);
    } catch {
      /* best-effort */
    }
  }

  /** PUT our full encrypted state as the note's server snapshot so later joiners
   *  adopt it instead of re-seeding. Best-effort, fire-and-forget. */
  private async uploadSnapshot(): Promise<void> {
    if (!this.sessionKey) return;
    try {
      const blob = encryptCollabPayload(this.sessionKey, Y.encodeStateAsUpdate(this.doc));
      const body = new ArrayBuffer(blob.byteLength);
      new Uint8Array(body).set(blob);
      await accountFetch(`/api/v1/collab/${this.noteId}/snapshot`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
    } catch {
      /* best-effort */
    }
  }

  /** Debounce a snapshot upload for SNAPSHOT_DEBOUNCE_MS after the last local
   *  edit, coalescing rapid edits into one PUT. */
  private scheduleSnapshotUpload(): void {
    if (this.closed) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.uploadSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  hasSessionKey(): boolean {
    return this.sessionKey !== null;
  }

  /** Number of other participants in the room, excluding ourselves.
   *  Drawn from y-protocols/awareness so it stays in sync with the
   *  remote-cursor rendering. Returns 0 when alone or disconnected. */
  peerCount(): number {
    const states = this.awareness.getStates();
    const myId = this.awareness.clientID;
    let count = 0;
    for (const clientId of states.keys()) {
      if (clientId !== myId) count++;
    }
    return count;
  }

  /** Registers [fn] to fire whenever the peer set changes (someone
   *  joins, leaves, or updates their awareness state). */
  onPeersChange(fn: (count: number) => void): () => void {
    const handler = () => fn(this.peerCount());
    this.awareness.on('change', handler);
    return () => this.awareness.off('change', handler);
  }

  onRemoteChange(fn: () => void): () => void {
    this.remoteChangeListeners.push(fn);
    return () => {
      this.remoteChangeListeners = this.remoteChangeListeners.filter(x => x !== fn);
    };
  }

  onConnectionChange(fn: (connected: boolean) => void): () => void {
    this.connectionListeners.push(fn);
    return () => {
      this.connectionListeners = this.connectionListeners.filter(x => x !== fn);
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  getText(): string {
    return this.yText.toString();
  }

  destroy(): void {
    this.closed = true;
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
    // Push our final state to the server (encoded synchronously here, before the
    // doc is destroyed) so the next device to open this note adopts it.
    void this.uploadSnapshot();
    if (this.awarenessHandler) this.awareness.off('update', this.awarenessHandler);
    this.awareness.destroy();
    this.ws?.close();
    this.ws = null;
    this.doc.destroy();
  }
}
