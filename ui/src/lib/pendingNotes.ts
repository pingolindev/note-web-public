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
 * Where a note written offline lives until the server accepts it.
 *
 * ## The failure this prevents
 *
 * A create that cannot reach the server is queued for replay, which keeps the
 * note safe. Done alone, the composer would clear, the grid would never gain
 * a row, and the note would be invisible until something reloaded the app.
 * Safe and invisible is indistinguishable from lost, so the note is shown
 * immediately, marked as not yet synced.
 *
 * That creates a second hazard. The replay reuses the ORIGINAL id, so when the
 * create finally lands there are two candidates for one note: the optimistic
 * row already on screen and the accepted one coming back. Prepending the
 * second is a visible duplicate. [placeNote] is the rule that resolves it, and
 * it lives here — separate from the store — so it can be tested without
 * standing up crypto, IndexedDB and the network.
 */

/** The little this module needs to identify a row. */
export interface Placeable {
  id: string;
}

/**
 * Put [note] into [list], replacing any row that already carries its id.
 *
 * Replace-in-place rather than remove-and-prepend: the optimistic row may be
 * somewhere the user is currently looking at, and a note that jumps to the top
 * of the grid the instant it syncs moves away from where they left it.
 *
 * A note with an id nobody has seen goes to the front, which is where a
 * freshly created note belongs.
 */
export function placeNote<T extends Placeable>(list: readonly T[], note: T): T[] {
  const at = list.findIndex(n => n?.id === note.id);
  if (at === -1) return [note, ...list];
  const next = [...list];
  next[at] = note;
  return next;
}

/**
 * Whether an offline create should add a row at all.
 *
 * False for a replay (one queued earlier, now being retried): the row is
 * already there. Without this check every failed retry — and a phone with no
 * signal retries on every wake-up — would stack another copy of the same note
 * on top of the grid.
 */
export function shouldShowQueued(isReplay: boolean): boolean {
  return !isReplay;
}

/**
 * ## An edit never replaces a waiting create
 *
 * The queue holds ONE entry per note id. A note written offline waits there as
 * a `create`; an edit of its card queued as an `update` under the same id
 * would REPLACE the create. The replay would then send a PUT for a note the
 * server had never been given: refused, the entry dropped, and the card left
 * saying "Not synced" with nothing behind it — the next sign-out would delete
 * the only copy of the person's note. And when the create HAD landed (its
 * answer was lost), the PUT would be a version conflict: a "(conflict copy)"
 * of a note nobody else had touched, and the original never passed on to its
 * notebook's people.
 *
 * So an edit of a note whose create is still queued is FOLDED into that
 * create: the entry stays a create, carries the note as it is now, and
 * remembers what was changed (`edits`). When the create is on the server (it
 * went through, or it turns out to have landed before) those changes are sent
 * as an ordinary update of the row the server has: the create itself cannot
 * carry all of them (archiving, a position), and a create that had landed
 * holds the note as it was before them.
 *
 * The rules are here, apart from the store, so that each has a test.
 */

/** A queue entry, as far as these rules read it (`noteDb.PendingEdit`). */
export interface QueuedEdit<N> {
  id: string;
  note: N;
  op: 'update' | 'create';
  queuedAt: string;
  account?: string;
  edits?: Partial<N>;
  remade?: boolean;
}

/** What an edit can change on a note: the fields `updateNote` sends. */
export const EDITABLE = [
  'title', 'body', 'noteType', 'color', 'isPinned', 'isArchived', 'labels',
  'checklistItems', 'sortOrder', 'editMode', 'notebookId', 'hasAttachments',
] as const;

/**
 * The changes in `content`, and nothing else of it. `null` is a change (no
 * colour, no notebook); `undefined` is "not touched".
 */
export function editsIn<N extends object>(content: Partial<N>): Partial<N> {
  const out: Record<string, unknown> = {};
  const from = content as Record<string, unknown>;
  for (const field of EDITABLE) {
    if (from[field] !== undefined) out[field] = from[field];
  }
  return out as Partial<N>;
}

/** Are there any? */
export function hasEdits<N extends object>(edits: Partial<N> | null | undefined): edits is Partial<N> {
  return !!edits && Object.keys(edits).length > 0;
}

/** The waiting create with a change folded in: still a create, of the note as it is now. */
export function foldIntoCreate<N extends object>(entry: QueuedEdit<N>, change: Partial<N>): QueuedEdit<N> {
  return {
    ...entry,
    op: 'create',
    note: { ...entry.note, ...change },
    edits: { ...(entry.edits ?? {}), ...change },
  };
}

/**
 * The create of a card that says it is waiting and has none in the queue.
 *
 * That is the state an older build of this page can leave behind: an
 * `update` where the create was (a browser edited offline with the older
 * page, not yet replayed), or nothing at all (replayed, refused and dropped).
 * The card still holds the note, and it is the only copy. Its whole content
 * counts as changed: whether an earlier attempt landed is not known here,
 * and if one did, the row on the server is older than the card.
 */
export function createFromCard<N extends { id: string }>(card: N, change: Partial<N>, now: string): QueuedEdit<N> {
  const note: N = { ...card, ...change };
  return { id: card.id, note, op: 'create', queuedAt: now, edits: editsIn<N>(note), remade: true };
}

/**
 * A create has reached the server (`onServer` is the note as the server has
 * it), or it ended without (`null`): what becomes of its queue entry.
 *
 * @returns null when the entry simply goes. Otherwise the update that takes
 *   its place, and the changes it carries: what was edited on the card while
 *   the create waited, or while it was on its way.
 */
export function afterCreate<N extends object>(
  entry: QueuedEdit<N> | null | undefined,
  onServer: N | null,
  now: string,
): { queue: QueuedEdit<N>; edits: Partial<N> } | null {
  if (!entry || entry.op !== 'create' || onServer === null || !hasEdits(entry.edits)) return null;
  return {
    edits: entry.edits,
    queue: { id: entry.id, note: { ...onServer, ...entry.edits }, op: 'update', queuedAt: now, account: entry.account },
  };
}

/**
 * ## What a create that has landed may still send
 *
 * A replayed create can find its note already on the server: the first
 * attempt was taken and its answer lost. What was changed on the card since
 * (`edits`) is then sent as an update. Sent blindly against the row as it is
 * NOW, it would silently replace whatever anybody else had written there in
 * the meantime: the note has been on the server, and on the person's other
 * devices, the whole time.
 *
 * A new note is at version 1 (`LANDED_AT`). A row still at that version is the
 * note as this create sent it, and the changes are simply sent. A row that has
 * moved on was changed by someone since. Changes that hold no words (a pin, a
 * colour, a move) are still sent: they are put on the row as it is now, and
 * replace nobody's words. Changes that hold WORDS are a conflict, and both are
 * kept, as for any edit of a note changed elsewhere: the card's note becomes a
 * note of its own, and the row stays as it is.
 *
 * A create made again from a card (`remade`) is a repair, and its "changes"
 * are the whole card, which may be an old one. Nothing of such a card is sent
 * over a row that was changed since it landed. The row is taken as it is,
 * and only if the card holds other words than the row are they kept, as a
 * note of their own.
 */

/** The version the server gives a note it has just been sent. */
export const LANDED_AT = 1;

/** The words of a note: what a person wrote, as far as two notes can be told apart by it. */
export function wordsOf(note: { title?: string | null; body?: string | null; checklistItems?: unknown } | null | undefined): string {
  const items = Array.isArray(note?.checklistItems) ? note.checklistItems : [];
  return JSON.stringify([note?.title ?? '', note?.body ?? '', items]);
}

/**
 * What a create that found its note on the server does with the changes it
 * carries. `row` is the note as the server has it now, at `rowVersion`.
 *
 * - `send`: as an update of the row. Nobody changed the row since it landed,
 *   or the changes hold no words, or the card's words are the row's: nothing
 *   anybody wrote can be replaced by it.
 * - `keep-as-copy`: nothing is sent. The row was changed since it landed and
 *   the card holds words the row does not: the card's note is kept as a note
 *   of its own, and the row is taken as it is.
 * - `nothing`: there is nothing to send or to keep (no changes; or a card
 *   made into a create again whose words are the row's, on a row changed
 *   since: an old card).
 */
export function afterLanding<N extends object>(
  entry: Pick<QueuedEdit<N>, 'note' | 'edits' | 'remade'> | null | undefined,
  row: { title?: string | null; body?: string | null; checklistItems?: unknown },
  rowVersion: number,
): 'send' | 'keep-as-copy' | 'nothing' {
  if (!entry || !hasEdits(entry.edits)) return 'nothing';
  // The row is the note as this create sent it: what the card holds is newer.
  if (rowVersion === LANDED_AT) return 'send';
  const sameWords = wordsOf(entry.note as { title?: string | null }) === wordsOf(row);
  if (entry.remade) return sameWords ? 'nothing' : 'keep-as-copy';
  return !carriesText(entry.edits) || sameWords ? 'send' : 'keep-as-copy';
}

/**
 * Do these changes hold TEXT the person wrote? What decides whether they are
 * kept as a note of their own when the note they were made on is gone. A
 * position, a pin or a colour has nothing to rescue.
 */
export function carriesText<N extends object>(edits: Partial<N> | null | undefined): boolean {
  if (!edits) return false;
  const e = edits as Record<string, unknown>;
  return e.title !== undefined || e.body !== undefined || e.checklistItems !== undefined;
}
