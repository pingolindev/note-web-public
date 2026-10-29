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
 * Reading one answer of `GET /api/v1/shares/inbox`.
 *
 * The server answers in one of two shapes:
 *
 * - `{ shares, has_more, declined_notebooks? }` when asked with
 *   `page_info=true`. `has_more` is the server's own word on whether older
 *   shares follow, and `declined_notebooks` is `[{ id, declined_at }]`: the
 *   notebooks this account has declined, and since when.
 * - The bare list, from a server that ignores `page_info`.
 *
 * Without `has_more` the end of the inbox has to be INFERRED: a page shorter
 * than this client's own copy of the server's page limit is taken for the
 * last one. A copy can go stale, and a client whose copy is larger than the
 * server's limit takes every full page for the whole inbox — one sync would
 * then evict every received note past the first page. The inference is kept
 * for the bare list only, where nothing better exists.
 *
 * An answer in neither shape is NOT an empty inbox. An empty inbox read to
 * its end is "everything was withdrawn", and what follows from it (received
 * notes evicted, acceptances forgotten) must never rest on something this
 * could not read.
 */
export interface InboxAnswer<Row> {
  rows: Row[];
  /** Older shares follow this page. */
  more: boolean;
  /**
   * The notebooks the server says this account has declined, and since when,
   * or null when the answer does not say: an older server, a page after the
   * first (it describes the inbox, so only the first page carries it), or the
   * server's own lookup failing. Null is "not told", never "none".
   */
  declined: DeclinedNotebook[] | null;
  /**
   * EVERY notebook on offer to this account, accepted or not, or null when the
   * answer does not say (as for `declined`; the server also leaves the list
   * out when it would not be whole). Null is "not told", never "none".
   *
   * It is what a partly read inbox cannot know by itself. An invitation is
   * the notebook's own row, the oldest of the invitation, so with a page's
   * worth of notes it lies on a later page. An inbox shown as far as it was
   * read would then hold notes of a notebook it could not know was on offer,
   * and show them.
   */
  offered: string[] | null;
}

/**
 * A time as the server writes one: RFC 3339, with up to nine digits of a
 * second's fraction (`…T09:58:18.873138Z`; the server's are UTC, and an
 * offset is read too).
 */
const SERVER_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

/** The instant a server time names: whole seconds since 1970, and the nanoseconds past them. */
function serverTime(text: string): { seconds: number; nanos: number } | null {
  const m = SERVER_TIME.exec(text);
  if (!m) return null;
  const wholeSeconds = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  if (!Number.isFinite(wholeSeconds)) return null;
  const offset = m[8] === undefined ? 0 : (m[8] === '-' ? -1 : 1) * (+m[9] * 60 + +m[10]) * 60;
  return { seconds: wholeSeconds - offset, nanos: +(m[7] ?? '').padEnd(9, '0') };
}

/** Is this a time as the server writes one? */
export function isServerTime(text: unknown): text is string {
  return typeof text === 'string' && serverTime(text) !== null;
}

/**
 * Is server time `a` LATER than server time `b`, to the last digit they carry?
 *
 * Not `Date.parse(a) > Date.parse(b)`. The server compares these two times to
 * the microsecond, and `Date.parse` keeps milliseconds: a share made in the
 * same millisecond as a decline, a few microseconds after it, is "later" to
 * the server and to the Android app and would be "not later" to this page,
 * which would go on showing it. A fraction of six digits is also more than
 * the language promises `Date.parse` will read at all. So the fields are read
 * here: the whole seconds through `Date.UTC`, which is exact, and the
 * fraction as the digits it is.
 *
 * False when either is not a server time: a time that cannot be read decides
 * nothing.
 */
export function isLaterServerTime(a: string, b: string): boolean {
  const x = serverTime(a);
  const y = serverTime(b);
  if (!x || !y) return false;
  return x.seconds !== y.seconds ? x.seconds > y.seconds : x.nanos > y.nanos;
}

/** A notebook this account declined, and the server's time of that decline. */
export interface DeclinedNotebook {
  id: string;
  /** As the server wrote it (RFC 3339). Compared with a share's `created_at`, from the same clock. */
  at: string;
}

/**
 * @param data             the answer's `data`, as parsed
 * @param legacyPageLimit  the page size to infer "more" from when the server
 *                         sent the bare list
 * @returns null when the answer is in neither shape
 */
export function readInboxAnswer<Row>(data: unknown, legacyPageLimit: number): InboxAnswer<Row> | null {
  if (Array.isArray(data)) {
    return { rows: data as Row[], more: data.length >= legacyPageLimit, declined: null, offered: null };
  }
  if (typeof data !== 'object' || data === null) return null;
  const page = data as { shares?: unknown; has_more?: unknown; declined_notebooks?: unknown; offered_notebooks?: unknown };
  if (!Array.isArray(page.shares) || typeof page.has_more !== 'boolean') return null;
  const declined = Array.isArray(page.declined_notebooks)
    ? page.declined_notebooks.flatMap((d: unknown): DeclinedNotebook[] => {
      const entry = d as { id?: unknown; declined_at?: unknown } | null;
      // An entry that is not an id with a time says nothing usable: a time
      // that cannot be read would compare as "no share is later than it".
      return entry !== null && typeof entry === 'object'
        && typeof entry.id === 'string' && entry.id !== ''
        && isServerTime(entry.declined_at)
        ? [{ id: entry.id, at: entry.declined_at }]
        : [];
    })
    : null;
  // The whole list or nothing: an entry that is no id would leave a list that
  // looks whole and is not, and everything missing from it reads as "not on
  // offer".
  const offered = Array.isArray(page.offered_notebooks)
    && page.offered_notebooks.every((id: unknown) => typeof id === 'string' && id !== '')
    ? (page.offered_notebooks as string[]).map(id => id.toLowerCase())
    : null;
  return { rows: page.shares as Row[], more: page.has_more, declined, offered };
}

/**
 * The notebooks to treat as declined on the server's word: id -> since when.
 *
 * A notebook the SAME answer lists a share of is left out, whatever the
 * declined list says: an owner who removed the reader and invited them again
 * leaves, for a moment, a list that can still name the notebook beside a row
 * that offers it. The row is the newer fact, and a notebook on offer is a
 * question the reader has not answered.
 *
 * @param canonical  an id in the form this client compares ids in, or null for
 *                   one that is no id at all (dropped)
 * @param previous   what an earlier answer said; kept when this one does not say
 */
export function declinedOnTheServersWord(
  declined: readonly DeclinedNotebook[] | null,
  listedNow: ReadonlySet<string>,
  previous: ReadonlyMap<string, string>,
  canonical: (id: string) => string | null = (id) => id,
): ReadonlyMap<string, string> {
  const said = new Map<string, string>();
  if (declined === null) {
    for (const [id, at] of previous) said.set(id, at);
  } else {
    for (const d of declined) {
      const id = canonical(d.id);
      if (id !== null) said.set(id, d.at);
    }
  }
  for (const id of listedNow) said.delete(id);
  // The same notebooks since the same times: the SAME map, so that nothing
  // that reads it recomputes on every refresh.
  if (said.size === previous.size && [...said].every(([id, at]) => previous.get(id) === at)) return previous;
  return said;
}

/**
 * The shares of NOTES that belong to a notebook this account has declined
 * and were made AFTER the decline.
 *
 * The server keeps such a share away itself when the note's row says which
 * notebook it is in. One whose row does not say (an older page on the
 * owner's side, or one that did not know the notebook's item yet) is written
 * live, and only the decrypted note names the notebook. "Nothing shows up
 * after a decline" includes that one. It is the same rule the server
 * applies, by the same two facts: the notebook was declined, and the share
 * is later than the decline.
 *
 * A share OLDER than the decline is not one of these. The decline dismissed
 * every share of the notebook's notes it knew of, so one that is still live
 * was shared with the reader by itself: theirs in its own right, wherever its
 * owner files the note afterwards.
 */
export function sharesOfDeclinedNotebooks<S extends { itemType?: number; sharedAt: string; note: { ownerNotebookId?: string | null } | null }>(
  shares: readonly S[],
  declined: ReadonlyMap<string, string>,
  notebookItemType: number,
  canonical: (id: string) => string | null = (id) => id,
): S[] {
  if (declined.size === 0) return [];
  return shares.filter((s) => {
    if (s.itemType === notebookItemType || !s.note?.ownerNotebookId) return false;
    const notebook = canonical(s.note.ownerNotebookId);
    const since = notebook === null ? undefined : declined.get(notebook);
    return since !== undefined && isLaterServerTime(s.sharedAt, since);
  });
}
