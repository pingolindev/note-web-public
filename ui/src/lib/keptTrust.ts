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
 * Kept trust in the shells (the page's half).
 *
 * Three stores outlive a sign-out: the pins, the rollback floors and the item
 * owners. In a browser they simply stay in localStorage. The shells can't
 * keep them there: their sign-out wipe deletes every website store, these
 * three with the rest, so every sign-in in a shell would start from a first
 * contact for everyone, with no floors and no owners. So in a shell the page
 * hands the three blobs to the native side after every change, and asks for
 * them back when the same account signs in again, before anything reads them.
 *
 *  - The folds only add. A kept pin with other keys than the page's is a
 *    conflict, never the kept key (foldPins); a floor takes the higher
 *    generation; an owner is never replaced, and a kept owner that differs
 *    makes the item a conflict (trustFolds).
 *  - Keeps go only after a REAL answer for this account in this document (a copy,
 *    or "none"). After no answer, an unreadable native store or a copy that
 *    doesn't parse, nothing is sent, so a copy never folded in is never
 *    overwritten with less.
 *  - Every message names the account. A reply naming another, or arriving after
 *    the bound, is ignored; a keep reads and names the account signed in when it
 *    goes.
 *  - Outside a shell nothing here runs.
 *
 * The messages are the iOS key bridge's contract v2 ops (the pingolinKeys
 * bridge), and the same JSON over `window.pingolinTrust` on Android, there with
 * an `id` that each reply carries back.
 */

import { accountStorageKey, getTabAccount, onTabAccountChange } from './account';
import { callKeyBridge, inBridgeMode } from './keyBridge';
import { foldPins } from './pinMerge';
import { foldFloors, foldOwners } from './trustFolds';

/** The three kept stores, by the field each has in a message. */
const STORES = {
  pins: 'pingolin_note_pinned_keys',
  floors: 'pingolin_note_gen_floor',
  owners: 'pingolin_note_item_owner',
} as const;
type Blobs = { [K in keyof typeof STORES]: string | null };

/** A reply after this is no answer, on both channels. */
export const ANSWER_MS = 2000;
/** The shells keep no blob over this (UTF-8 bytes); the page doesn't send one. */
export const MAX_BLOB_BYTES = 1024 * 1024;

type Reply = Record<string, unknown>;
interface Channel { send(message: Record<string, unknown>): Promise<unknown> }

/** Android's WebMessageListener object (WebViewCompat.addWebMessageListener). */
interface TrustPort {
  postMessage(message: string): void;
  addEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
}

let nextId = 1;
const waiting = new Map<number, (reply: unknown) => void>();
let listeningTo: TrustPort | null = null;

/** An Android reply goes to the request with its id; any other is dropped. */
function onPortMessage(event: { data: unknown }): void {
  let reply: unknown;
  try {
    reply = typeof event.data === 'string' ? JSON.parse(event.data) : null;
  } catch {
    return;
  }
  const id = (reply as { id?: unknown } | null)?.id;
  if (typeof id !== 'number') return;
  const answer = waiting.get(id);
  if (!answer) return;
  waiting.delete(id);
  answer(reply);
}

function androidChannel(port: TrustPort): Channel {
  if (listeningTo !== port) {
    if (typeof port.addEventListener === 'function') port.addEventListener('message', onPortMessage);
    else port.onmessage = onPortMessage;
    listeningTo = port;
  }
  return {
    send(message) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiting.set(id, resolve);
        try {
          port.postMessage(JSON.stringify({ ...message, id }));
        } catch (e) {
          waiting.delete(id);
          reject(e);
        }
      });
    },
  };
}

/** The shell's channel: the iOS key bridge, Android's pingolinTrust, or none. */
function channel(): Channel | null {
  if (typeof window === 'undefined') return null;
  if (inBridgeMode()) return { send: (m) => callKeyBridge(m as { op: string } & Record<string, unknown>) };
  const port = (window as unknown as { pingolinTrust?: TrustPort }).pingolinTrust;
  if (port && typeof port.postMessage === 'function') return androidChannel(port);
  return null;
}

/** The reply, or undefined when there was none in time: a refusal, a timeout,
 *  or a reply after the bound (ignored, on both channels). */
async function ask(ch: Channel, message: Record<string, unknown>): Promise<Reply | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ANSWER_MS); });
  try {
    const reply = await Promise.race([ch.send(message).then((r) => r, () => undefined), bound]);
    return reply && typeof reply === 'object' && !Array.isArray(reply) ? (reply as Reply) : undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The account whose adopt has run in this document, and the one whose adopt got
 *  a real answer: only that account's blobs are ever sent. */
let adoptedFor: string | null = null;
let keepsFor: string | null = null;

// A new account is adopted afresh (its adopt resets keepsFor); until it has
// answered, no keep goes, since each one names the account signed in then.
onTabAccountChange(() => {
  adoptedFor = null;
});

/** A stored blob for `account`, as it is stored (null when there is none). */
function storedBlob(base: string, account: string): string | null {
  const k = accountStorageKey(base, account);
  return k ? localStorage.getItem(k) : null;
}

/** A blob from a message or from storage, parsed: null for none; undefined when
 *  it doesn't parse as a JSON object. */
function parsed(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Fold the kept copy into what this page holds for `account`. False, folding
 *  nothing, when the copy or the page's own store doesn't parse. */
function foldIn(account: string, copy: Reply): boolean {
  const names = Object.keys(STORES) as (keyof typeof STORES)[];
  const kept: Record<string, Record<string, unknown> | null> = {};
  const held: Record<string, Record<string, unknown> | null> = {};
  for (const name of names) {
    const k = parsed(copy[name]);
    const h = parsed(storedBlob(STORES[name], account));
    if (k === undefined || h === undefined) return false;
    kept[name] = k;
    held[name] = h;
  }
  const folded: Record<keyof typeof STORES, Record<string, unknown>> = {
    pins: foldPins([held.pins, kept.pins]).pins,
    floors: foldFloors([held.floors, kept.floors]),
    owners: foldOwners([held.owners, kept.owners]),
  };
  for (const name of names) {
    if (kept[name] === null) continue; // nothing kept: the page's own store stays as it is
    const next = JSON.stringify(folded[name]);
    if (next !== storedBlob(STORES[name], account)) localStorage.setItem(accountStorageKey(STORES[name], account)!, next);
  }
  return true;
}

/**
 * At an account's confirmation in a shell (checkAuth), before its pins load and
 * before the inbox reads a floor or an owner: ask the shell for the account's
 * kept copy, at most ANSWER_MS, and fold it in. Once per account in a document.
 * Never throws: a failure boots without the kept copy.
 */
export async function adoptKeptTrust(account: string): Promise<void> {
  const ch = channel();
  if (!ch || adoptedFor === account) return;
  adoptedFor = account;
  keepsFor = null;
  let reply: Reply | undefined;
  try {
    reply = await ask(ch, { op: 'keptTrust', v: 1, account });
  } catch {
    reply = undefined;
  }
  // Another account was confirmed meanwhile: its own adopt runs.
  if (getTabAccount() !== account || adoptedFor !== account) return;
  if (reply?.v !== 1 || reply.account !== account || (reply.state !== 'copy' && reply.state !== 'none')) {
    if (reply?.v === 1 && reply.state === 'unreadable') console.warn('[note] the app could not read the trust it keeps for this account');
    return;
  }
  if (reply.state === 'copy') {
    let folded = false;
    try {
      folded = foldIn(account, reply);
    } catch {
      folded = false;
    }
    if (!folded) {
      console.error('[note] the trust the app kept for this account could not be read: nothing is kept in the app this session');
      return;
    }
  }
  keepsFor = account;
  scheduleKeep();
}

/** The account's three blobs as stored, or null when storage can't be read. */
function blobsOf(account: string): Blobs | null {
  try {
    return {
      pins: storedBlob(STORES.pins, account),
      floors: storedBlob(STORES.floors, account),
      owners: storedBlob(STORES.owners, account),
    };
  } catch {
    return null;
  }
}

/** Hand the signed-in account's blobs to the shell now. True when it kept them. */
async function sendKeep(): Promise<boolean> {
  const ch = channel();
  // Read and named for the account signed in NOW, and only after its adopt got
  // a real answer: never one account's blobs under another's name.
  const account = getTabAccount();
  if (!ch || !account || keepsFor !== account) return false;
  const blobs = blobsOf(account);
  if (!blobs) return false;
  for (const [name, blob] of Object.entries(blobs)) {
    if (blob !== null && new TextEncoder().encode(blob).length > MAX_BLOB_BYTES) {
      console.warn(`[note] this account's kept ${name} are over 1 MB: the app doesn't keep them`);
      return false;
    }
  }
  const reply = await ask(ch, { op: 'keepTrust', v: 1, account, ...blobs });
  const kept = reply?.v === 1 && reply.state === 'kept';
  if (!kept) console.warn('[note] the app did not keep this account\'s trust this time');
  return kept;
}

let keepQueued = false;

/** A kept blob was written (a pin, a floor, a binding): one keep per task. */
export function scheduleKeep(): void {
  if (keepQueued || keepsFor === null) return;
  keepQueued = true;
  setTimeout(() => {
    keepQueued = false;
    void sendKeep();
  }, 0);
}

/** `window.__pingolinKeepTrustNow`: the shells' last keep before their sign-out
 *  wipe (bounded on their side). True when the shell kept the blobs. */
export function keepTrustNow(): Promise<boolean> {
  return sendKeep().catch(() => false);
}
