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
 * Notebooks after a password reset.
 *
 * Every object a user encounters should be usable no matter what, so a
 * notebook a reset left unusable is rebuilt on the person's behalf, with all
 * the same attributes, notes and shares.
 *
 * What a reset by e-mail does to notebooks:
 *
 *   - The LIST of notebooks (`item_type = 10`: names, label colours, standing
 *     share lists, editor modes, accepted invitations) is sealed under the
 *     vault key, which a reset replaces. Read with the current key alone, the
 *     list would be gone for good. The server keeps ONE list row per account,
 *     so no new one could be written either: every notebook made after the
 *     reset would vanish on the next device, and the page would log "Server
 *     reports a metadata row this client cannot find" at every write.
 *   - A notebook's RECORD (`item_type = 2`: its name and its people) opens with
 *     a key wrapped under that vault key. A notebook listed whose record no key
 *     opens cannot be shared as itself, nor renamed for its readers, nor have
 *     its people changed.
 *
 * What is done (here the rules, in `notebooksStore` and `notebookRepairRun`
 * the work):
 *
 *   - The list is read with the keys recovered from before a reset as well, and
 *     written again under this identity's when one of those is what opened it.
 *   - A list no key opens is written over by this page's, and CARRIED inside
 *     the new one (`beforeReset`): nothing in it is lost, and a recovery key
 *     used later merges it back, adding only what is missing. While it is
 *     locked, every notebook of the account's whose record opens is put on the
 *     list, so the ones made since the reset are kept.
 *   - A listed notebook whose record no key opens is REBUILT in place, on the
 *     person's behalf: the same id (its notes and its readers' acceptances
 *     stay), the same name (from the list), the same people (from the server's
 *     share rows), and a new key under this identity, sealed and signed to each
 *     of them. Its earlier record is carried in the list (`rebuiltNotebooks`),
 *     and what it had that the new one lacks is put back after a recovery.
 *   - A notebook with no key at all (one from before notebooks had keys) is
 *     given one.
 *
 * Notes from before the reset stay locked for their owner, and readable for the
 * people they were shared with, until the recovery key is used: that is what a
 * reset by e-mail does, and the page says so.
 *
 * Pure: what is decided here has tests of its own.
 */

/** Something sealed under a vault key, as the server stores it. */
export interface Sealed {
  ciphertext: string;
  nonce: string;
}

/**
 * A notebook's record as it was before it was rebuilt: the wrap of its key
 * under a vault key, and its content. The wrap is null for a notebook that had
 * none, whose content was sealed under the vault key itself.
 */
export interface EarlierRecord {
  wrappedKey: string | null;
  wrappedKeyNonce: string | null;
  ciphertext: string;
  nonce: string;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function asSealed(v: unknown): Sealed | null {
  if (!v || typeof v !== 'object') return null;
  const { ciphertext, nonce } = v as Record<string, unknown>;
  return text(ciphertext) && text(nonce) ? { ciphertext, nonce } : null;
}

const sameSealed = (a: Sealed, b: Sealed) => a.ciphertext === b.ciphertext && a.nonce === b.nonce;

/**
 * The lists from before a reset that a list carries (`beforeReset`), as far as
 * they read: what another client wrote there may be anything.
 */
export function carriedLists(value: unknown): Sealed[] {
  if (!Array.isArray(value)) return [];
  const out: Sealed[] = [];
  for (const v of value) {
    const s = asSealed(v);
    if (s && !out.some(o => sameSealed(o, s))) out.push(s);
  }
  return out;
}

/** `value` with `list` carried too, once. */
export function withCarriedList(value: unknown, list: Sealed): Sealed[] {
  const lists = carriedLists(value);
  return lists.some(l => sameSealed(l, list)) ? lists : [...lists, list];
}

/** `value` without the lists in `gone` (merged back). */
export function withoutCarriedLists(value: unknown, gone: readonly Sealed[]): Sealed[] {
  return carriedLists(value).filter(l => !gone.some(g => sameSealed(g, l)));
}

function asEarlierRecord(v: unknown): EarlierRecord | null {
  const s = asSealed(v);
  if (!s) return null;
  const { wrappedKey, wrappedKeyNonce } = v as Record<string, unknown>;
  // Both or neither: half a wrap opens nothing.
  if (text(wrappedKey) && text(wrappedKeyNonce)) return { wrappedKey, wrappedKeyNonce, ...s };
  if (wrappedKey == null && wrappedKeyNonce == null) return { wrappedKey: null, wrappedKeyNonce: null, ...s };
  return null;
}

const sameRecord = (a: EarlierRecord, b: EarlierRecord) =>
  sameSealed(a, b) && a.wrappedKey === b.wrappedKey && a.wrappedKeyNonce === b.wrappedKeyNonce;

/**
 * The records rebuilt notebooks had before (`rebuiltNotebooks`), notebook id ->
 * every earlier record, oldest first: a notebook rebuilt after each of two
 * resets has two.
 */
export function carriedRecords(value: unknown): Record<string, EarlierRecord[]> {
  const out: Record<string, EarlierRecord[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, list] of Object.entries(value as Record<string, unknown>)) {
    if (!text(id) || !Array.isArray(list)) continue;
    const records: EarlierRecord[] = [];
    for (const v of list) {
      const r = asEarlierRecord(v);
      if (r && !records.some(o => sameRecord(o, r))) records.push(r);
    }
    if (records.length > 0) out[id] = records;
  }
  return out;
}

/** `value` with `record` carried for `notebookId` too, once, after any it has. */
export function withCarriedRecord(value: unknown, notebookId: string, record: EarlierRecord): Record<string, EarlierRecord[]> {
  const all = carriedRecords(value);
  const list = all[notebookId] ?? [];
  if (!list.some(r => sameRecord(r, record))) all[notebookId] = [...list, record];
  return all;
}

/** `value` without `notebookId`'s records in `gone` (merged back). */
export function withoutCarriedRecords(value: unknown, notebookId: string, gone: readonly EarlierRecord[]): Record<string, EarlierRecord[]> {
  const all = carriedRecords(value);
  const kept = (all[notebookId] ?? []).filter(r => !gone.some(g => sameRecord(g, r)));
  if (kept.length > 0) all[notebookId] = kept;
  else delete all[notebookId];
  return all;
}

/**
 * What this page knows of one of the person's own notebooks' record.
 *
 *  - `opens`: with a key this page holds, this identity's or a recovered one.
 *    Nothing to do. One that opens only with a recovered key is NOT re-keyed:
 *    its readers hold that key, and a new one would cut each of them off until
 *    they confirm the owner's new security code; it works as it is, every
 *    session that loads the recovered identity.
 *  - `keyless`: the item has no key at all.
 *  - `locked`: a key, and nothing this page holds opens it.
 *  - `unknown`: not known enough to say: no item seen, a deleted one, not this
 *    account's, or keys not loaded.
 */
export type RecordState = 'opens' | 'keyless' | 'locked' | 'unknown';

export interface RecordFacts {
  /** Keys loaded on this page. */
  cryptoReady: boolean;
  /** An item for it has been seen, and is not a deleted one. */
  liveItem: boolean;
  /** Is the item this account's? Null when it is not known. */
  ours: boolean | null;
  /** Does the item carry a wrap? */
  wrapped: boolean;
  /** Which vault key opens that wrap, or null for none. */
  opensWith: 'current' | 'recovered' | null;
}

export function recordState(f: RecordFacts): RecordState {
  if (!f.cryptoReady || !f.liveItem || f.ours !== true) return 'unknown';
  if (!f.wrapped) return 'keyless';
  return f.opensWith ? 'opens' : 'locked';
}

export type RecordRepair = 'none' | 'give-key' | 'rebuild' | 'wait';

/**
 * What to do about a record. `earlierKeysAnswered`: this session has had an
 * answer about what the account recovered from before a reset
 * (`previousIdentitiesAnswered`). Without one, a record that opens with no key
 * here may open with one not loaded yet, and is left alone: a rebuild replaces
 * what a recovery would have opened whole.
 */
export function recordRepair(state: RecordState, earlierKeysAnswered: boolean): RecordRepair {
  if (state === 'opens') return 'none';
  if (state === 'unknown' || !earlierKeysAnswered) return 'wait';
  return state === 'keyless' ? 'give-key' : 'rebuild';
}

/** Fields of a record the person's own choices are in, never taken from an earlier one. */
const NEVER_RESTORED = new Set(['title', 'members']);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a notebook's earlier record puts back into its record now: every field
 * but its name and its people (on which the record now has the newer word: the
 * people are sharing state, and an earlier record is an old state of it) that
 * the record now lacks, or holds only as a rebuild wrote it, `defaults` (a new
 * record's value: a rebuild knew nothing better, and nothing on the page
 * changes these fields). A value the record now holds that is not the default
 * was set since, and stays. Null when nothing is put back.
 */
export function fieldsToRestore(
  now: Record<string, unknown>,
  earlier: Record<string, unknown>,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> | null {
  const next: Record<string, unknown> = { ...now };
  let added = false;
  for (const [k, v] of Object.entries(earlier)) {
    if (NEVER_RESTORED.has(k) || v === undefined) continue;
    const unset = !(k in now) || (k in defaults && same(now[k], defaults[k]));
    if (!unset || same(now[k], v)) continue;
    next[k] = v;
    added = true;
  }
  return added ? next : null;
}

/**
 * The notebooks in `found` that `listed` lacks, in the order found, each once.
 * Ids compare whatever their case.
 */
export function notebooksToAdd(
  listed: readonly { id: string }[],
  found: readonly { id: string; name: string }[],
): { id: string; name: string }[] {
  const have = new Set(listed.map(nb => nb.id.toLowerCase()));
  const out: { id: string; name: string }[] = [];
  for (const nb of found) {
    const id = nb.id.toLowerCase();
    if (!text(nb.id) || !text(nb.name) || have.has(id)) continue;
    have.add(id);
    out.push({ id: nb.id, name: nb.name });
  }
  return out;
}

/** An old key wrap kept for a rescued note's attachments (lib/noteRescue). */
export interface KeptKey {
  wrappedKey: string;
  wrappedKeyNonce: string;
  /**
   * The attachments the note had when it was rescued: the only ones sealed
   * under this key, and the only ones brought over from it (listed again
   * later, an attachment added after the rescue would be re-keyed from a key
   * it was never under). Absent: none are brought over.
   */
  attachmentIds?: string[];
}

function asKeptKey(v: unknown): KeptKey | null {
  if (!v || typeof v !== 'object') return null;
  const { wrappedKey, wrappedKeyNonce, attachmentIds } = v as Record<string, unknown>;
  if (!text(wrappedKey) || !text(wrappedKeyNonce)) return null;
  const ids = Array.isArray(attachmentIds) ? attachmentIds.filter(text) : undefined;
  return ids ? { wrappedKey, wrappedKeyNonce, attachmentIds: ids } : { wrappedKey, wrappedKeyNonce };
}

const sameKept = (a: KeptKey, b: KeptKey) => a.wrappedKey === b.wrappedKey && a.wrappedKeyNonce === b.wrappedKeyNonce;

/** The pre-rescue keys kept for rescued notes (`rescuedNotes`), note id -> each, oldest first. */
export function keptKeys(value: unknown): Record<string, KeptKey[]> {
  const out: Record<string, KeptKey[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, list] of Object.entries(value as Record<string, unknown>)) {
    if (!text(id) || !Array.isArray(list)) continue;
    const keys: KeptKey[] = [];
    for (const v of list) {
      const k = asKeptKey(v);
      if (k && !keys.some(o => sameKept(o, k))) keys.push(k);
    }
    if (keys.length > 0) out[id] = keys;
  }
  return out;
}

/** `value` with `key` kept for `noteId` too, once, after any it has. */
export function withKeptKey(value: unknown, noteId: string, key: KeptKey): Record<string, KeptKey[]> {
  const all = keptKeys(value);
  const list = all[noteId] ?? [];
  if (!list.some(k => sameKept(k, key))) all[noteId] = [...list, key];
  return all;
}

/** `value` without `noteId`'s keys in `gone`; a note with none left goes. */
export function withoutKeptKeys(value: unknown, noteId: string, gone: readonly KeptKey[]): Record<string, KeptKey[]> {
  const all = keptKeys(value);
  const kept = (all[noteId] ?? []).filter(k => !gone.some(g => sameKept(g, k)));
  if (kept.length > 0) all[noteId] = kept;
  else delete all[noteId];
  return all;
}

