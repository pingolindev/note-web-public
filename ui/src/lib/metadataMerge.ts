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
 * Three-way merge of the user-metadata blob (`item_type = 10`).
 *
 * There is ONE metadata row per user and every write replaces the whole blob
 * under a version CAS. When the CAS fails (409) another device wrote first,
 * and the only correct recovery is to read what it wrote and re-apply OUR
 * change on top — not to retry our blob (which would erase theirs) and not to
 * give up (which erases ours: the notebook, share recipient or pin the user
 * just made is gone with nothing on screen).
 *
 * `base` is the last blob this client saw from the server, `local` is what it
 * wants to write, `server` is what is there now. Per entry:
 *
 *   - present locally, absent from base   → a local addition: kept, unless the
 *                                            server ALSO added it (server wins)
 *   - absent locally, present in base     → a local removal: honoured, unless
 *                                            the server changed the entry since
 *                                            (server wins — it is newer than
 *                                            the state we removed from)
 *   - changed locally, unchanged on server → local change kept
 *   - changed on both                     → server wins
 *   - everything else                     → server's value
 *
 * With no base (never saw the server's blob) every local entry counts as an
 * addition, which is the same rule collapsed to "server wins on conflicts,
 * local additions kept".
 *
 * Pure and dependency-free so the store can be tested through it and so the
 * rules live in one place; the store only decides WHEN to merge.
 */

export interface MetadataNotebook { id: string; name: string }
export interface MetadataRecipient { email: string }

/** The subset of the blob this module understands. Everything else — extras a
 *  newer client wrote — is merged as opaque per-key values. */
export interface MergeableMetadata {
  notebooks?: MetadataNotebook[];
  labelColors?: Record<string, string>;
  notebookShares?: Record<string, MetadataRecipient[]>;
  editorModes?: Record<string, string>;
  acceptedNotebooks?: string[];
  [extra: string]: unknown;
}

const KNOWN = new Set(['notebooks', 'labelColors', 'notebookShares', 'editorModes', 'acceptedNotebooks']);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Three-way merge of keyed entries. `Map`s keep insertion order, so the result
 * lists the server's entries in the server's order with local additions
 * appended — a notebook list never reshuffles under the user's cursor.
 */
export function mergeKeyed<V>(
  base: Map<string, V> | null,
  local: Map<string, V>,
  server: Map<string, V>,
): Map<string, V> {
  const out = new Map<string, V>();
  for (const [k, sv] of server) {
    const bv = base?.get(k);
    const lv = local.get(k);
    const inBase = base?.has(k) ?? false;
    if (!local.has(k)) {
      // Local removal — honoured only if the server still has what we removed.
      if (inBase && same(bv, sv)) continue;
      out.set(k, sv);
      continue;
    }
    if (same(lv, sv)) { out.set(k, sv); continue; }
    const serverChanged = !inBase || !same(bv, sv);
    const localChanged = !inBase || !same(bv, lv);
    // Both changed → server wins. Only we changed → ours.
    out.set(k, serverChanged ? sv : (localChanged ? (lv as V) : sv));
  }
  for (const [k, lv] of local) {
    if (out.has(k) || server.has(k)) continue;
    // Absent from server. A local addition (not in base) is kept; an entry
    // the server deleted since base is gone.
    if (base?.has(k)) continue;
    out.set(k, lv);
  }
  return out;
}

const byId = (list: MetadataNotebook[] | undefined) =>
  new Map((list ?? []).map(nb => [nb.id, nb]));
const byKey = <V>(rec: Record<string, V> | undefined) =>
  new Map(Object.entries(rec ?? {}));
const asSet = (list: string[] | undefined) =>
  new Map((list ?? []).map(x => [x, true as const]));
const byEmail = (list: MetadataRecipient[] | undefined) =>
  new Map((list ?? []).map(r => [String(r.email).toLowerCase(), r]));

function mergeShares(
  base: Record<string, MetadataRecipient[]> | undefined | null,
  local: Record<string, MetadataRecipient[]> | undefined,
  server: Record<string, MetadataRecipient[]> | undefined,
): Record<string, MetadataRecipient[]> {
  const ids = new Set([...Object.keys(local ?? {}), ...Object.keys(server ?? {})]);
  const out: Record<string, MetadataRecipient[]> = {};
  for (const id of ids) {
    const merged = mergeKeyed(
      base && id in base ? byEmail(base[id]) : (base ? new Map() : null),
      byEmail(local?.[id]),
      byEmail(server?.[id]),
    );
    if (merged.size > 0) out[id] = [...merged.values()];
  }
  return out;
}

export function mergeMetadata(
  base: MergeableMetadata | null,
  local: MergeableMetadata,
  server: MergeableMetadata,
): MergeableMetadata {
  const out: MergeableMetadata = {};

  // Extras first, so a known key can never be shadowed by a stale copy.
  const extraKeys = new Set([...Object.keys(local), ...Object.keys(server)].filter(k => !KNOWN.has(k)));
  const baseExtras = base
    ? new Map(Object.entries(base).filter(([k]) => !KNOWN.has(k)))
    : null;
  const mergedExtras = mergeKeyed(
    baseExtras,
    new Map([...extraKeys].filter(k => k in local).map(k => [k, local[k]])),
    new Map([...extraKeys].filter(k => k in server).map(k => [k, server[k]])),
  );
  for (const [k, v] of mergedExtras) out[k] = v;

  out.notebooks = [...mergeKeyed(base ? byId(base.notebooks) : null, byId(local.notebooks), byId(server.notebooks)).values()];
  out.labelColors = Object.fromEntries(
    mergeKeyed(base ? byKey(base.labelColors) : null, byKey(local.labelColors), byKey(server.labelColors)),
  );
  out.notebookShares = mergeShares(base?.notebookShares, local.notebookShares, server.notebookShares);
  out.editorModes = Object.fromEntries(
    mergeKeyed(base ? byKey(base.editorModes) : null, byKey(local.editorModes), byKey(server.editorModes)),
  );
  out.acceptedNotebooks = [...mergeKeyed(
    base ? asSet(base.acceptedNotebooks) : null,
    asSet(local.acceptedNotebooks),
    asSet(server.acceptedNotebooks),
  ).keys()];
  return out;
}
