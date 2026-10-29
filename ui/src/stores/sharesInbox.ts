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
 * Shares inbox — notes that have been shared with the current user by
 * other owners. Parallel to `notesStore` but populated from the
 * `/api/v1/shares/inbox` endpoint and decrypted via the client's
 * X25519 sharing private key (NaCl sealed box).
 *
 * Incoming notes live alongside regular notes in the UI. Their record
 * carries the unwrapped content key in-memory so edits can re-encrypt
 * under the same per-note content key (maintaining the invariant that
 * all participants use the same key for a given note).
 */
import { createSignal } from 'solid-js';
import { apiRequest } from '../lib/apiClient';
import {
  decryptWithContentKey,
  verifyNoteShareWrapGen,
  pinUserKeys,
  getPinnedUserKeys,
  approveUserKeyChange,
  computeSafetyNumber,
} from '../lib/crypto';
import { authStore } from './auth';
import { openSealedKeys } from '../lib/keyOps';
import { extrasFrom, type NoteItem } from './notes';
// Pure + dependency-free, so it lives in lib/ and needs no stub in tests that
// mock './notes' to break the store import cycle.
import { receiveNotebookId } from '../lib/notebookId';
import { ITEM_TYPE_NOTEBOOK } from '../lib/notebookItem';
import { declinedOnTheServersWord, readInboxAnswer, sharesOfDeclinedNotebooks, type DeclinedNotebook } from '../lib/inboxPage';
import { accountStorageKey, onTabAccountChange, scopedGetItem, scopedSetItem, tryCanonicalAccountId } from '../lib/account';
import { isOwnNote, isOwnNotebook } from '../lib/ownNotes';
import { firstByKey, keptPerList } from '../lib/listIndex';
import { foldFloors, foldOwners } from '../lib/trustFolds';
import { scheduleKeep } from '../lib/keptTrust';

/** Server item_type for a note. Notebooks are 2, user metadata is 10. */
const ITEM_TYPE_NOTE = 1;

interface ServerShare {
  share_id: string;
  item_id: string;
  /** Sender's user_id. Used by the recipient to reconstruct the canonical
   * sig_input when verifying the wrap. */
  owner_id: string;
  permission: string;
  wrapped_key: string | null;
  sharer_public_key: string | null;
  owner_email: string | null;
  /** Hex-encoded Ed25519 signature over the wrap, NULL on a legacy wrap. */
  wrap_signature: string | null;
  /** The sender's DIRECTORY keys, inlined by the server so this client does
   * not have to POST /users/public-keys to get them — that call cannot
   * start until this response arrives, so it would sit as a whole round trip
   * between /shares/inbox and /sync/pull on every cold start.
   *
   * Same data, same source (the auth server's directory) as that POST
   * returns, and used for exactly the same thing: TOFU-bootstrapping a pin,
   * or detecting a substitution against one we already hold. NEVER the key a
   * wrap signature is verified against — that is always the PINNED key, below.
   *
   * Absent on an older server, and absent when the server's own lookup failed
   * (it is best-effort there and must not fail the inbox), so the fallback
   * POST has to stay. */
  owner_directory_user_id?: string | null;
  owner_directory_sharing_key?: string | null;
  owner_directory_signing_key?: string | null;
  /** The item's current content-key generation (base 1, bumped only on
   * content-key rotation). Passed into the wrap verify so a real-generation
   * sig verifies; verify-both still accepts a legacy-0 sig. Absent on an
   * older server → default 1, matching the server's own default. */
  content_key_generation?: number;
  /** 1 = note, 2 = notebook. Absent on an older server → treated as a note,
   *  which is what every client did before the field existed. */
  item_type?: number;
  encrypted_content: string;
  content_nonce: string;
  updated_at: string;
  created_at: string;
}

/** Wrap-signature verification verdict for an incoming share. */
export type WrapTrust =
  | 'verified'          // signature checked OK against the PINNED sender signing key (never a server-supplied key)
  | 'unverified'        // no pin yet (first use / TOFU bootstrap) or own user-id unknown — UI shows a soft warning.
                        // ALSO covers an UNSIGNED wrap from an unpinned sender: with no pin there is no signature to
                        // strip, so it is exactly as trustworthy as a signed wrap from an unpinned sender (both take
                        // the server's word for who sent it). Matches note-android / note-ios first-use grace.
  | 'unsigned-stripped' // PINNED sender, but the wrap arrived with NO signature — a legitimate wrap from them would
                        // carry one, so this is a stripped signature. Dropped, and surfaced via blockedShares().
  | 'no-key'            // no wrapped key at all (pre-registration invite, or a pre-E2EE row) — nothing to open
  | 'invalid';          // signature present but doesn't verify against the pinned key — DO NOT trust

export interface IncomingShare {
  shareId: string;
  itemId: string;
  /** Sender's user_id (UUID). */
  ownerId: string;
  permission: 'edit' | 'view';
  sharerPublicKey: string | null;
  /** Email of the user who shared this note with us, as the server
   * records it on the share. Older rows may be null until the owner
   * re-shares. */
  sharerEmail: string | null;
  sharedAt: string;
  updatedAt: string;
  /**
   * What was shared: 1 = note, 2 = notebook.
   *
   * A shared NOTEBOOK is the collection object — it carries the notebook's
   * name and its roster, not a document anyone wants to read as a note. Without
   * this field it would surface in "shared with me" as a phantom note titled
   * with the notebook's name.
   */
  itemType: number;
  /**
   * The share row's permission VERBATIM.
   *
   * `permission` above is narrowed to edit|view because that is what the note
   * paths understand. A NOTEBOOK share can also carry `contribute` — the
   * collection right — and narrowing it turns "may add and remove notes" into
   * a plain edit, so the invitation would offer the wrong thing.
   */
  sharePermission: string;
  /** Decrypted NoteItem — populated once the content key is unwrapped. */
  note: NoteItem | null;
  /** Unwrapped content key (kept in memory for subsequent edits/collab). */
  contentKey: Uint8Array | null;
  /** Error string if decryption failed. */
  error: string | null;
  /** Verification status of the wrap signature. */
  wrapTrust: WrapTrust;
}

/** A sender the recipient has blocked (GET /shares/blocks), as the
 * server returns it. */
export interface BlockedSender {
  blocked_email: string;
  created_at: string;
}

const [shares, setShares] = createSignal<IncomingShare[]>([]);
const [loading, setLoading] = createSignal(false);
/** A refresh has finished at least once on this page, with a list or with a
 *  failure. Before that an empty inbox means "not asked yet", which the notes
 *  held for an unanswered invitation need to tell apart (lib/notebookInvites). */
const [answered, setAnswered] = createSignal(false);
/**
 * The last refresh that finished on this page got NO answer: the inbox's first
 * page could not be read, on a page that has had no answer for this account
 * yet (an offline cold start). The inbox is then empty and says nothing, and
 * nothing is held back on a guess: offline, the notes the cache holds are
 * shown (lib/notebookInvites).
 *
 * Only then: a refresh that could not ask at all (no confirmed account, a
 * trust store that cannot be read), one that failed after an earlier answer,
 * and an account change in the tab do not release the hold.
 *
 * Told apart from an answer that ARRIVED and does not say which notebooks are
 * on offer (it stopped early, with no list from the server): that one names
 * some invitations and is silent about the rest, and the notes of those are
 * held. Reading both as "answered, offers unknown" would hold every such note
 * for the whole of an offline session.
 */
const [gotNoAnswer, setGotNoAnswer] = createSignal(false);
/** A refresh has put an answer on this page, for the tab's account (see `gotNoAnswer`). */
let answeredHere = false;
/**
 * Every notebook the server's last applied list NAMED, the rows this page
 * refuses to open included; null until a list has been applied on this page.
 *
 * `sharedNotebooks()` is the rows that passed the trust checks, and pruning
 * the reader's acceptances against that would forget a notebook whose sender
 * had merely changed keys: its row grades 'invalid' until the reader approves
 * the new key, the refresh still succeeds, and the acceptance would be struck
 * on every device. Whether a notebook is still OFFERED is a different
 * question from whether its row can be opened today, and this answers it.
 * It keeps an acceptance alive and opens nothing.
 */
const [listedNotebooks, setListedNotebooks] = createSignal<ReadonlySet<string> | null>(null);
/**
 * Notebooks declined on this page, each with the share rows that decline
 * dismissed, until the server offers the notebook again. The decline dismisses
 * the shares at once; the notes that came with them stay in memory until the
 * next completed sync, and must not be shown meanwhile (lib/notebookInvites).
 *
 * "Offered again" is a row that decline did NOT dismiss. A list that still
 * names one of the dismissed rows is an old answer: the inbox is read from a
 * replica, which can lag the dismissal by a moment, so taking any list naming
 * the notebook as a new offer would drop the mark on exactly that answer. A
 * dismissed row stays dismissed when the owner shares again (the server keeps
 * it dismissed), so a real new offer always arrives as a row with another id.
 */
const [declined, setDeclined] = createSignal<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
/**
 * The notebooks the SERVER says this account has declined, and since when, as
 * of the last inbox answer that said (`declined_notebooks`, first page): a
 * decline made on another device, or here before a reload.
 *
 * A decline dismisses the notebook's share and every note in it, and the
 * server writes any note added to it later already dismissed, so nothing of
 * it reaches this inbox. Two things are left for this page, and this is for
 * both:
 *
 * - A share the server could not tell was the notebook's: the note's row did
 *   not say which notebook it is in (the owner's page did not know the
 *   notebook's item yet, or is an older one). It arrives live. `load()` takes
 *   it off the list and dismisses it, when it was made AFTER the decline
 *   (lib/inboxPage `sharesOfDeclinedNotebooks`).
 * - The device that did NOT decline holds the notebook's notes in memory
 *   (they were an unanswered invitation's), the next answer no longer lists
 *   the invitation, and until the sync that follows has taken the copies out
 *   they would stand in the grid as notes shared on their own
 *   (lib/notebookInvites).
 *
 * Kept per account across reloads: before the inbox answers, a received note
 * of a notebook not accepted is held anyway, but an offline page that gets no
 * answer releases that hold (`gotNoAnswer`), and without this the notes of a
 * notebook declined on another device would stand in the grid then.
 */
const SERVER_DECLINED_KEY = 'pingolin_note_declined_notebooks';
function loadServerDeclined(): ReadonlyMap<string, string> {
  try {
    const raw = scopedGetItem(SERVER_DECLINED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    const out = new Map<string, string>();
    if (Array.isArray(list)) {
      for (const e of list) {
        if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string') continue;
        const id = tryCanonicalAccountId(e[0]);
        if (id !== null) out.set(id, e[1]);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}
function saveServerDeclined(declinedNow: ReadonlyMap<string, string>): void {
  try { scopedSetItem(SERVER_DECLINED_KEY, JSON.stringify([...declinedNow])); } catch { /* kept in memory only */ }
}
const [serverDeclined, setServerDeclined] = createSignal<ReadonlyMap<string, string>>(loadServerDeclined());
/** The notebooks alone, declined here or on the server's word: what the hold asks. */
const declinedNotebooks = (): ReadonlySet<string> => new Set([...declined().keys(), ...serverDeclined().keys()]);
/**
 * EVERY notebook the server says is on offer to this account, accepted or not,
 * as of the last inbox answer that said (`offered_notebooks`, first page);
 * null until one has.
 *
 * For the hold on an unanswered invitation's notes (stores/notes.ts
 * `invitationState`). The rows this page has read say which notebooks are on
 * offer only when the inbox was read to its end: an invitation is the
 * notebook's own row, the oldest of the invitation, and with a page's worth of
 * notes it lies on a later page. An inbox shown as far as it was read can hold
 * those notes without their invitation, and would show them.
 *
 * The list of the LAST answer, and null when that answer carried none: an
 * older list is not kept in its place. Kept, it would go on holding the notes
 * of a notebook whose invitation had since been accepted on another device,
 * and know nothing of one made since. What is on offer when the server has
 * not said is the hold's own question (stores/notes.ts `invitationState`):
 * the rows, when the inbox was read to its end, and otherwise not known.
 */
const [serverOffered, setServerOffered] = createSignal<ReadonlySet<string> | null>(null);
/**
 * Every share this page has dismissed: by a decline, or one at a time.
 *
 * A dismissal is never undone, so an inbox answer that still carries one of
 * these is an OLDER answer: the inbox is read from a replica, which can lag a
 * dismissal by a moment, and the refresh that follows a decline is exactly
 * the one that meets it. Its rows would go back on screen until the next
 * refresh, the invitation just declined among them, reading "new". They are
 * dropped from every answer instead. An invitation sent again is another row,
 * with another id.
 */
const dismissedHere = new Set<string>();
/** The most share ids one decline names; the server refuses more, whole. */
export const DECLINE_MAX_SHARE_IDS = 10_000;

/**
 * The most rows one inbox answer carries (the server's page limit). An answer
 * of this many rows may be the NEWEST 500 of more. Taken for the whole list,
 * that one page would drop a notebook's own row first — it is among the
 * oldest — so one sync would strike the reader's acceptance on every device
 * and evict every received note past the cut.
 *
 * So the inbox is read to its end (`fetchInbox`), with the server's cursor
 * (`before`, `before_id`: the last row's `created_at` and `share_id`). Only
 * an inbox read to its end is "the list". One that could not be (a later page
 * failed, the server sent the same page again, or it runs past
 * INBOX_MAX_PAGES) is shown as far as it was read, and prunes, forgets and
 * evicts nothing.
 *
 * WHERE THE END IS is the server's to say (`has_more`, asked for with
 * `page_info=true`). This number is only for a server that predates that and
 * sends the bare list: there a page shorter than it is taken for the last one
 * (lib/inboxPage).
 */
export const INBOX_PAGE_LIMIT = 500;
/** No refresh reads further than this many pages (10,000 shares). */
export const INBOX_MAX_PAGES = 20;
/** The most addresses one POST /users/public-keys takes; the server refuses more (max 100). */
export const KEY_LOOKUP_MAX = 100;

/**
 * Refreshes are numbered as they start, and `lastApplied` is the number of
 * the last one whose answer went on screen. Refreshes overlap (a sync's, a
 * decline's own, a key approval's) and a multi-page one is long: if each
 * applied its rows whenever it finished, one that started BEFORE a decline
 * could finish after the decline's own refresh and put the dismissed rows
 * back on screen until the next one.
 *
 * The rule: an answer is applied unless a refresh that started LATER has
 * already applied its own. An older one that finishes after that puts
 * nothing on screen and answers "not the list". (Its floors and pins were
 * saved all the same, before this is asked: they only ever rise, and are true
 * whoever read them.)
 *
 * Not "only the newest refresh STARTED applies": that would throw good
 * answers away — a newer refresh whose first page failed empties the screen,
 * and the older one's list, arriving a moment later, would be discarded for
 * being older. A failure applies nothing, so it does not count.
 */
let newestLoad = 0;
let lastApplied = 0;

/**
 * Every share addressed to this account, newest first, page after page.
 *
 * @returns null when even the first page could not be read; otherwise the
 *          rows read, whether they are ALL of them, and what the first page
 *          says of the inbox as a whole: the notebooks this account has
 *          declined, and the ones on offer to it (each null when it did not
 *          say).
 */
async function fetchInbox(onPage: () => void = () => {}): Promise<{
  rows: ServerShare[]; complete: boolean; declined: DeclinedNotebook[] | null; offered: string[] | null;
} | null> {
  const rows: ServerShare[] = [];
  const seen = new Set<string>();
  let declined: DeclinedNotebook[] | null = null;
  let offered: string[] | null = null;
  let url = '/api/v1/shares/inbox?page_info=true';
  for (let page = 0; page < INBOX_MAX_PAGES; page++) {
    // A page is five hundred rows with their notes' text: on a slow link it
    // arrives for a while, and each piece of it is a sign of life.
    const result = await apiRequest<unknown>(url, { onProgress: onPage });
    // Something came back, whatever it was: whoever reads this inbox is not stuck.
    onPage();
    // An answer in neither of the server's two shapes is a page that was not
    // read, never an empty one (lib/inboxPage).
    const answer = result.success ? readInboxAnswer<ServerShare>(result.data, INBOX_PAGE_LIMIT) : null;
    if (answer === null) {
      if (page === 0) return null;
      console.warn(`[note] the inbox could not be read past its first ${rows.length} shares: it is shown as far as it was read, and nothing is pruned, forgotten or evicted on it`);
      return { rows, complete: false, declined, offered };
    }
    if (page === 0) { declined = answer.declined; offered = answer.offered; }
    const fresh = answer.rows.filter(s => !seen.has(s.share_id));
    for (const s of fresh) seen.add(s.share_id);
    rows.push(...fresh);
    if (!answer.more) return { rows, complete: true, declined, offered };
    // A page that brought nothing new: a server that does not know the cursor
    // answers every request with the first page. Not the whole list, and not
    // worth asking again.
    if (fresh.length === 0) break;
    const last = answer.rows[answer.rows.length - 1];
    url = `/api/v1/shares/inbox?page_info=true&before=${encodeURIComponent(last.created_at)}&before_id=${encodeURIComponent(last.share_id)}`;
  }
  console.warn(`[note] the inbox was not read to its end (${rows.length} shares read): nothing is pruned, forgotten or evicted on it`);
  return { rows, complete: false, declined, offered };
}

/** A share sender whose current directory key no longer matches the key we
 *  TOFU-pinned. Their shares are dropped as 'invalid' until the user compares
 *  the safety number out-of-band and approves the rotated key. */
export interface KeyChangeAlarm {
  /** Sender's user_id (the pinned party). */
  userId: string;
  email: string | null;
  /** The server's CURRENT directory keys — what approving will re-pin to. */
  newSharingPub: string;
  newSigningPub: string;
  /** The signing key we currently trust (for context/debugging). */
  pinnedSigningPub: string;
  /** How many inbox shares from this sender are hidden by the mismatch. */
  affectedCount: number;
}
const [keyChangeAlarms, setKeyChangeAlarms] = createSignal<KeyChangeAlarm[]>([]);

/**
 * An incoming share the recipient CANNOT open, kept out of `shares()` but
 * surfaced by <BlockedShares/> so it is never silently swallowed.
 *
 * Dropped invisibly, such a share would "just not arrive": the row is
 * fetched, graded untrusted, filtered out, and nothing — no list entry, no
 * error, no badge — would ever tell the recipient a note had been shared with
 * them. The security verdict stands (nothing here is decrypted); only the
 * silence is removed.
 */
export interface BlockedShare {
  shareId: string;
  itemId: string;
  ownerId: string;
  /** Sender's email when the row carries one. */
  sharerEmail: string | null;
  sharedAt: string;
  /** Why it could not be shown. */
  reason: string;
  /** The verdict that produced `reason` — lets the UI pick its wording. */
  wrapTrust: WrapTrust;
  /** 1 = note, 2 = notebook. Carried so the banner can name what was
   * actually refused: a rejected NOTEBOOK object would otherwise be announced
   * as "a shared note", which sends the reader looking for a note that does
   * not exist. */
  itemType?: number;
}
const [blockedShares, setBlockedShares] = createSignal<BlockedShare[]>([]);

// Unread tracking — track the most recent `createdAt` the user has
// acknowledged (by opening the "Shared with me" view). Shares with
// createdAt > this cursor count toward the unread badge on the sidebar.
const LAST_SEEN_KEY = 'pingolin_note_inbox_last_seen';
function loadLastSeen(): string {
  try { return scopedGetItem(LAST_SEEN_KEY) ?? ''; } catch { return ''; }
}
const [lastSeenAt, setLastSeenAt] = createSignal<string>(loadLastSeen());
// Per account: read again once the tab's account is confirmed.
onTabAccountChange(() => {
  setLastSeenAt(loadLastSeen());
  // What one account's page learned says nothing about the next one's.
  setListedNotebooks(null);
  setDeclined(new Map<string, ReadonlySet<string>>());
  setServerDeclined(loadServerDeclined());
  setServerOffered(null);
  dismissedHere.clear();
  // Nor whether it was ever answered.
  answeredHere = false;
  setAnswered(false);
  setGotNoAnswer(false);
});

/** A trust store this page keeps and cannot read now (a blob that doesn't
 * parse, storage that throws, no confirmed account): never "empty", so the
 * inbox stops rather than decide against nothing. */
class StoreUnreadable extends Error {}

/** One per-account trust blob as stored, or null when there is none. */
function readTrustStore(base: string): Record<string, unknown> | null {
  const k = accountStorageKey(base);
  if (!k) throw new StoreUnreadable(base);
  let raw: string | null;
  try { raw = localStorage.getItem(k); } catch { throw new StoreUnreadable(base); }
  if (raw === null) return null;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { throw new StoreUnreadable(base); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new StoreUnreadable(base);
  return obj as Record<string, unknown>;
}

// Per-item rollback floor. For each shared item we persist the
// HIGHEST content-key generation we've ever accepted from a pin-verified wrap
// (keyed on the generation the signature ACTUALLY verified under, not the
// server-claimed one). A pin-verified wrap whose generation is BELOW the floor
// is a rollback — the server replaying an older wrapped content key (e.g. a
// stale key a since-removed member still holds) — and is dropped. The floor
// only ever advances, and only on 'verified' shares; legitimate generations
// are monotonic (rotate-shares only bumps), so a lower one is never valid.
// localStorage is client-only (the blind server can't tamper with it). Kept
// across a sign-out like the pins; only an erasure deletes it.
const GEN_FLOOR_KEY = 'pingolin_note_gen_floor';
/** The floors by canonical item id: another spelling of an item folds
 * to its highest generation; a key that isn't a UUID, or a value that isn't a
 * positive number, is dropped (foldFloors). Throws StoreUnreadable. */
function loadGenFloors(): Record<string, number> {
  return foldFloors([readTrustStore(GEN_FLOOR_KEY) ?? {}]);
}

// Each shared item's owner: the sender of the first share of it this
// account accepted. Only an item's owner can write a share of it (the server
// checks ownership before every wrap), so a share of a bound item from
// anyone else is the server's word, or a removed member's signature it
// replays, and is refused before anything is unwrapped. A binding is never
// removed because a share is missing from a refresh — a server that withheld
// the owner's share once could otherwise bind the item to someone else next
// time. Only an erasure removes one. Kept across a sign-out like the floors.
const ITEM_OWNER_KEY = 'pingolin_note_item_owner';
/** The bindings by canonical item id; values canonical owner ids, or
 *  OWNER_CONFLICT for two spellings of one item bound to different owners. An
 *  entry that isn't a UUID either side is dropped (foldOwners). Throws
 *  StoreUnreadable. */
function loadItemOwners(): Record<string, string> {
  return foldOwners([readTrustStore(ITEM_OWNER_KEY) ?? {}]);
}

/** Raise the floors this refresh verified. Read again first, so another tab's
 *  floors join; a store that can't be read now is left as it is. */
function saveFloors(bumps: Map<string, number>): void {
  if (bumps.size === 0) return;
  try {
    const floors = loadGenFloors();
    let changed = false;
    for (const [id, g] of bumps) {
      if ((floors[id] ?? 0) < g) { floors[id] = g; changed = true; }
    }
    if (changed) {
      scopedSetItem(GEN_FLOOR_KEY, JSON.stringify(floors));
      scheduleKeep();
    }
  } catch (e) { console.warn('[note] rollback floors were not saved this time', e); }
}

/** Bind the items this refresh accepted, each only while still unbound. */
function saveBindings(binds: Map<string, string>): void {
  if (binds.size === 0) return;
  try {
    const owners = loadItemOwners();
    let changed = false;
    for (const [id, owner] of binds) {
      if (owners[id] === undefined) { owners[id] = owner; changed = true; }
    }
    if (changed) {
      scopedSetItem(ITEM_OWNER_KEY, JSON.stringify(owners));
      scheduleKeep();
    }
  } catch (e) { console.warn('[note] item owners were not saved this time', e); }
}

function toNoteItem(itemId: string, parsed: any, updatedAt: string, createdAt: string): NoteItem {
  return {
    id: itemId,
    title: parsed.title || '',
    body: parsed.body || '',
    noteType: parsed.note_type || 'text',
    color: parsed.color || null,
    isPinned: parsed.is_pinned || false,
    isArchived: parsed.is_archived || false,
    labels: parsed.labels || [],
    checklistItems: parsed.checklist_items,
    sortOrder: parsed.sort_order ?? 0,
    editMode: parsed.edit_mode || 'rich',
    // Always an incoming share here, by construction.
    ...receiveNotebookId(parsed.notebook_id, true),
    hasAttachments: parsed.has_attachments || false,
    // A recipient editing a shared note must not destroy fields the OWNER's
    // client wrote and this one does not know about.
    extras: extrasFrom(parsed),
    version: 0,
    createdAt,
    updatedAt,
    deleted: false,
    // Opened with this share's key, and someone else's.
    openedVia: 'share',
    foreignOwner: true,
  };
}

/**
 * Three answers about `shares()` that every card and every synced note asks
 * for, worked out once per list (lib/listIndex) instead of by a walk of the
 * whole list. Readers still read `shares()` to get them, so the answers
 * follow the list as it changes.
 */
const shareOfItem = firstByKey<IncomingShare>(s => s.itemId);
const notesAmong = keptPerList<IncomingShare, readonly IncomingShare[]>(
  list => list.filter(s => s.itemType !== ITEM_TYPE_NOTEBOOK));
const notebooksAmong = keptPerList<IncomingShare, readonly IncomingShare[]>(
  list => list.filter(s => s.itemType === ITEM_TYPE_NOTEBOOK));

export const sharesInboxStore = {
  /**
   * Everything in the inbox, notes AND notebooks. Most callers want one or the
   * other — see `sharedNotes` and `sharedNotebooks`.
   */
  shares,

  /**
   * Shares that are actual notes.
   *
   * The notes list must not show notebook OBJECTS: they carry a collection's
   * name and roster, and rendering one as a note puts a phantom entry titled
   * with the notebook's name in "shared with me".
   */
  sharedNotes: (): readonly IncomingShare[] => notesAmong(shares()),

  /** Notebooks shared with this user, for the "Shared Notebooks" section. */
  sharedNotebooks: (): readonly IncomingShare[] => notebooksAmong(shares()),
  loading,
  answered,
  /** The last refresh that finished got no answer at all (see `gotNoAnswer`). */
  gotNoAnswer,
  /** Every notebook the last applied list named, blocked rows included; null before one. */
  listedNotebookIds: listedNotebooks,
  declinedNotebooks,
  /** Every notebook the server says is on offer, or null when it has not said (see `serverOffered`). */
  offeredNotebooks: serverOffered,
  /**
   * The reader said no to this notebook here: its notes are not shown again on
   * this page.
   * @param notebookShareIds  the notebook's own share rows that this decline dismisses
   */
  /**
   * The mark goes: the reader has ACCEPTED this notebook after all, or the
   * server did not take the decline (lib/declineInvitation). A mark left
   * behind would outrank an acceptance, and the notebook then accepted, here
   * or on another device, would open empty for the rest of the page.
   */
  clearDeclined(notebookId: string): void {
    if (!declined().has(notebookId)) return;
    const next = new Map(declined());
    next.delete(notebookId);
    setDeclined(next);
  },
  markDeclined(notebookId: string, notebookShareIds: readonly string[] = []): void {
    setDeclined(prev => {
      const next = new Map(prev);
      next.set(notebookId, new Set([...(prev.get(notebookId) ?? []), ...notebookShareIds]));
      return next;
    });
  },
  keyChangeAlarms,
  blockedShares,

  /** Returns true only when the AUTHORITATIVE server list was applied.
   *  Callers that reconcile local state against the inbox (the revoked-
   *  share eviction in notes.sync) must gate on this: a transient failure
   *  empties `shares` and would otherwise read as "everything revoked".
   *  An inbox that could not be read to its END is not authoritative either:
   *  what was read is applied (its shares are shown), and false is returned
   *  (INBOX_PAGE_LIMIT, `fetchInbox`). */
  /**
   * @param onAnswer called each time something this refresh waited for has come
   *   back (a page of the inbox, a batch of senders' keys, the opened keys):
   *   the sync that started it says so to lib/oneAtATime, which gives up on a
   *   run that has shown no sign of life for a minute.
   */
  async load(onAnswer: () => void = () => {}): Promise<boolean> {
    const thisLoad = ++newestLoad;
    // Set when a later refresh has already applied: this one then answers nothing.
    let discarded = false;
    /** Could the inbox's first page not be read? (see `gotNoAnswer`) */
    let firstPageUnread = false;
    setLoading(true);
    try {
      // This account's own id first, canonical: the pins, floors and item
      // owners below are its, and the SDK binds it into every wrap signature.
      // Without one nothing is fetched or decided — otherwise every share
      // would be treated as a first contact.
      const myUserId = tryCanonicalAccountId(authStore.user()?.id);
      if (myUserId === null) {
        console.warn('[note] inbox not refreshed: this tab has no confirmed account id');
        return false;
      }
      // The floors and item owners are read before anything is decided. One
      // that can't be read is never "none": the inbox stays as it was, and it
      // is read again at the next refresh.
      let floors: Record<string, number>;
      let owners: Record<string, string>;
      try {
        floors = loadGenFloors();
        owners = loadItemOwners();
      } catch (e) {
        if (!(e instanceof StoreUnreadable)) throw e;
        console.error('[note] INBOX NOT REFRESHED: a stored trust record (rollback floors or item owners) cannot be read. Nothing was fetched, opened or changed.', { store: e.message });
        return false;
      }
      const served = await fetchInbox(onAnswer);
      if (served === null) {
        firstPageUnread = true;
        // Not when a newer refresh has already put its answer on screen, and
        // not while a newer one is still READING either: its answer is on its
        // way, and emptying the screen under it would release the notes of
        // unanswered invitations into the grid and blank "Shared with me"
        // until it landed.
        if (thisLoad > lastApplied && thisLoad === newestLoad) setShares([]);
        else discarded = true;
        return false;
      }
      // A row this page dismissed is an older answer's (see `dismissedHere`).
      const result = { data: served.rows.filter(s => !dismissedHere.has(s.share_id)) };

      // Best-effort one-shot lookup for all senders' directory
      // (sharing+signing) public keys at once. These server-supplied keys
      // are used ONLY to TOFU-bootstrap a pin on first use and to detect a
      // server key-substitution against an existing pin — NEVER as the key
      // the wrap signature is verified against (verification always uses the
      // PINNED key; see the loop below). Falls back gracefully if the lookup
      // fails or returns nothing — those shares end up as 'unverified'.
      const senderEmails = Array.from(new Set(result.data.map(s => s.owner_email).filter((e): e is string => !!e)));
      const signingByEmail = new Map<string, { userId: string; signingPub: string; sharingPub: string }>();

      // Take whatever the server already inlined. It attaches each sender's
      // directory keys to the share, which removes the round trip below
      // entirely in the common case — that POST cannot even be issued until
      // this response lands, so it would sit between /shares/inbox and
      // /sync/pull on every cold start.
      for (const s of result.data) {
        if (!s.owner_email) continue;
        if (s.owner_directory_user_id && s.owner_directory_signing_key && s.owner_directory_sharing_key) {
          signingByEmail.set(s.owner_email.toLowerCase(), {
            userId: s.owner_directory_user_id,
            signingPub: s.owner_directory_signing_key,
            sharingPub: s.owner_directory_sharing_key,
          });
        }
      }

      // Only ask for what is still missing. An older server inlines nothing, and
      // even a current one leaves a sender out when its own directory lookup
      // failed — that is best-effort there on purpose, so it can never fail the
      // inbox. Either way this falls back to asking with the POST.
      const missing = senderEmails.filter(e => !signingByEmail.has(e.toLowerCase()));
      // In requests of at most KEY_LOOKUP_MAX addresses: the endpoint refuses
      // more, and an inbox read to its end can name more senders than that.
      for (let from = 0; from < missing.length; from += KEY_LOOKUP_MAX) {
        try {
          const r = await apiRequest<{
            users: { email: string; user_id: string | null; sharing_public_key: string | null; signing_public_key: string | null }[];
          }>('/api/v1/users/public-keys', { method: 'POST', body: { emails: missing.slice(from, from + KEY_LOOKUP_MAX) } });
          onAnswer();
          if (r.success) {
            for (const u of r.data.users) {
              if (u.user_id && u.signing_public_key && u.sharing_public_key) {
                signingByEmail.set(u.email.toLowerCase(), {
                  userId: u.user_id, signingPub: u.signing_public_key, sharingPub: u.sharing_public_key,
                });
              }
            }
          }
        } catch (e) {
          console.warn('[note] inbox sender-key lookup failed:', e);
        }
      }

      // The pair rule: an item no share has been accepted for yet, named by
      // shares from two different owners in this one refresh, is bound to
      // nobody this time and each of those shares is refused — nothing says
      // which came first.
      const ownersNaming = new Map<string, Set<string>>();
      for (const s of result.data) {
        const item = tryCanonicalAccountId(s.item_id);
        const owner = tryCanonicalAccountId(s.owner_id);
        if (item === null || owner === null || owners[item] !== undefined) continue;
        const named = ownersNaming.get(item) ?? new Set<string>();
        named.add(owner);
        ownersNaming.set(item, named);
      }
      // What this refresh accepted, saved once its verdicts are in.
      const floorBumps = new Map<string, number>();
      const binds = new Map<string, string>();

      // Opening a wrap is a PRIVATE-key operation, so it goes through
      // lib/keyOps — local keys in a browser, the native bridge in the iOS
      // shell — and is async there. The trust verdict below is decided
      // BEFORE any key material is touched; this only opens, in one batch,
      // the wraps the verdict lets through. A bridge that fails outright
      // leaves the inbox as it was for the next sync rather than marking
      // every share unreadable.
      // Pass 1 — the trust verdict for every share, decided BEFORE any key
      // material is touched.
      interface Grade {
        /** The share's item and owner ids, canonical; null when one isn't a UUID. */
        item: string | null;
        owner: string | null;
        wrapTrust: WrapTrust;
        error: string | null;
        pinned: ReturnType<typeof getPinnedUserKeys>;
        senderInfo: { userId: string; signingPub: string; sharingPub: string } | undefined;
      }
      const grades: Grade[] = result.data.map((s) => {
        let error: string | null = null;
        let wrapTrust: WrapTrust = 'unverified';

        // Every id this verdict reads, canonical: the SDK binds both
        // ids' parsed bytes into the wrap signature, so the floor, the pin,
        // the owner binding and every entry below must key them the same way,
        // or another spelling of a floored item would read as new. A share
        // naming either by no UUID is refused here, before anything else.
        const item = tryCanonicalAccountId(s.item_id);
        const owner = tryCanonicalAccountId(s.owner_id);
        if (item === null) {
          return {
            item, owner, wrapTrust: 'invalid', pinned: null, senderInfo: undefined,
            error: "This share is damaged, so it couldn't be opened. Ask the sender to share it again.",
          };
        }
        if (owner === null) {
          return { item, owner, wrapTrust: 'invalid', error: null, pinned: null, senderInfo: undefined };
        }

        // A share naming one of this account's OWN notes is refused
        // before anything is unwrapped, whoever sent it. Taken, its key would
        // seal that note's next save and its live edits — a key the server
        // chose. No pin is looked at or made, and no alarm is raised for it.
        // The same for an own notebook.
        if (isOwnNote(item) || isOwnNotebook(item)) {
          console.warn('[note] REFUSING a share that names one of this account\'s own notes', {
            itemId: item, shareId: s.share_id,
          });
          return { item, owner, wrapTrust: 'invalid', error: null, pinned: null, senderInfo: undefined };
        }

        // An item bound to its owner takes shares from that owner only,
        // and an unbound one named by two owners in this refresh takes none.
        // Refused before any pin, verify or unwrap: no floor moves, no pin is
        // taken and no alarm is raised for it.
        const bound = owners[item];
        if (bound !== undefined ? bound !== owner : (ownersNaming.get(item)?.size ?? 0) > 1) {
          console.warn('[note] REFUSING a share from someone other than the owner this item is bound to', {
            itemId: item, shareId: s.share_id,
          });
          return { item, owner, wrapTrust: 'invalid', error: null, pinned: null, senderInfo: undefined };
        }

        // Hoisted: the pin decides whether a MISSING signature is a stripped
        // one, so it is needed before the branch below, not just inside the
        // signed path. The server-directory keys (`senderInfo`) are used ONLY
        // to bootstrap a pin on first use and to raise a key-change alarm —
        // NEVER as the key a signature is verified against. They count only
        // when the entry the share's e-mail found names the share's owner:
        // anyone else's keys are nobody's to pin.
        const directory = s.owner_email ? signingByEmail.get(s.owner_email.toLowerCase()) : undefined;
        const senderInfo = directory && tryCanonicalAccountId(directory.userId) === owner ? directory : undefined;
        const pinned = getPinnedUserKeys(owner);
        if (directory && !senderInfo && !pinned) {
          console.warn('[note] REFUSING a first share whose directory entry names another account', {
            itemId: item, shareId: s.share_id,
          });
          return { item, owner, wrapTrust: 'invalid', error: null, pinned: null, senderInfo: undefined };
        }

        if (!s.wrapped_key) {
          wrapTrust = 'no-key';
          error = "This share arrived incomplete, so it can't be opened. Ask the sender to share it again.";
        } else if (!s.wrap_signature && pinned) {
          // GRADUATED FAIL-CLOSED. We hold this sender's pin, so a
          // legitimate wrap from them WOULD carry a signature that verifies
          // against it. A missing one is a signature a relay stripped —
          // exactly the bypass wrap signatures exist to defeat. DROP without
          // unwrapping.
          //
          // The grace below is reserved for an UNPINNED sender, where there
          // is no pin to strip a signature against. Rejecting those
          // unconditionally would buy nothing — first contact trusts the
          // server either way — while silently hiding the share: no row, no
          // error, no badge. So they render, marked unverified, and TOFU-pin
          // on first successful unwrap, as Note Android and Note iOS do.
          wrapTrust = 'unsigned-stripped';
          error = "This share couldn't be confirmed as coming from its sender, so it wasn't opened. Ask them to share it again.";
          console.warn('[note] REJECTING unsigned share from a PINNED sender (fail-closed)', {
            itemId: s.item_id, shareId: s.share_id, sender: s.owner_email ?? s.owner_id,
          });
        } else {
          // Verify the wrap signature against the sender's PINNED signing
          // key BEFORE unwrapping — NEVER against a signing key the server
          // just handed us. A malicious server can return an attacker key
          // together with a signature made by that same attacker key,
          // which would "verify" against the server-supplied key; pinning
          // (TOFU) defeats that because verification uses the key we
          // observed on first use, not whatever the server returns now:
          // never trust a signing key supplied by the server for
          // verification.
          //
          // The server-directory keys (`senderInfo`) are used ONLY to
          // BOOTSTRAP a pin on first use (below) — never as the
          // verification key once a pin already exists. Both are hoisted
          // above this branch.
          //
          // Reached by a SIGNED wrap, and by an unsigned wrap from an
          // UNPINNED sender (the `pinned` guard on the branch above lets
          // it fall through). The latter has no pin, so it lands in the
          // `unverified` arm below and is unwrapped + TOFU-pinned under
          // first-use grace.
          if (pinned && s.wrap_signature) {
            // Pin exists → verify against the PINNED signing key. If the
            // server-returned key differs from the pin, that's a key-change
            // alarm: we deliberately keep verifying against the pin (so a
            // substituted server key can't make the wrap verify) and warn.
            // A wrap re-signed under a new/rotated key then fails against the
            // old pin → 'invalid' → dropped, until the change is confirmed
            // out-of-band (safety number) and the pin re-approved.
            if (senderInfo && senderInfo.signingPub.toLowerCase() !== pinned.signingPubkeyHex.toLowerCase()) {
              console.warn('[note] KEY-CHANGE ALARM: server signing key for sender differs from pinned key — verifying against the PIN, not the server key', {
                itemId: s.item_id, ownerId: s.owner_id, sender: s.owner_email ?? s.owner_id,
              });
            }
            try {
              // Verify-both AND capture the generation the sig actually
              // verified under. Pass the server-emitted generation
              // (base 1); a real-gen sig verifies directly, a legacy-0 sig
              // verifies via fallback and reports effectiveGeneration 0
              // (so it can't launder a high claim).
              // A conflict (lib/pinMerge.ts) verifies nothing until the
              // person approves a key.
              const vr = pinned.conflict
                ? { verified: false, effectiveGeneration: 0 }
                : verifyNoteShareWrapGen(pinned.signingPubkeyHex, s.wrap_signature, {
                  senderUserId: owner,
                  recipientUserId: myUserId,
                  itemId: item,
                  contentKeyVersion: s.content_key_generation ?? 1,
                  wrappedKeyBase64: s.wrapped_key,
                });
              if (!vr.verified) {
                wrapTrust = 'invalid';
              } else {
                // ROLLBACK CHECK: reject a validly-signed wrap whose
                // generation is below the highest we've ever accepted
                // for this item — the server replaying an older wrapped
                // content key. Legit generations only increase
                // (rotate-shares bumps), so a lower one against a
                // pin-verified sender is an attack, not reordering.
                //
                // Only a REAL (>=1) generation is floored. A generation
                // of 0 is the SDK's legacy-fallback verdict — a wrap
                // signed under the hard-coded version 0 that older
                // owner devices still emit (e.g. a legit rotate from an
                // older phone after an updated device advanced the
                // floor). Flooring those would false-drop a legitimate
                // rotation and strand the recipient on stale content,
                // so gen-0 stays exempt (it also never advances the
                // floor — bumpGenFloor ignores <=0).
                const floor = floors[item] ?? 0;
                if (vr.effectiveGeneration > 0 && vr.effectiveGeneration < floor) {
                  console.warn('[note] ROLLBACK DROP: wrap verified but generation is below the per-item floor — replayed old content key', {
                    itemId: item, ownerId: owner,
                    generation: vr.effectiveGeneration, floor,
                  });
                  wrapTrust = 'invalid';
                } else {
                  wrapTrust = 'verified';
                  // Verified against this owner's pin: the item is theirs.
                  if (owners[item] === undefined) binds.set(item, owner);
                  if (vr.effectiveGeneration > floor) {
                    floors[item] = vr.effectiveGeneration;
                    floorBumps.set(item, vr.effectiveGeneration);
                  }
                }
              }
            } catch (e) {
              console.warn('[note] verifyNoteShareWrapGen parse error:', e);
              wrapTrust = 'invalid';
            }
          } else {
            // No pin yet (TOFU first use), or our own user_id is unknown → we
            // can't verify against a pin. Stay 'unverified' (soft first-use
            // warning) — NEVER 'verified', which must mean "verified against
            // the pinned key". We pin the observed sender keys below, on first
            // successful unwrap, so subsequent shares are checked against
            // them. First use must still work (no lockout).
            wrapTrust = 'unverified';
          }

        }
        return { item, owner, wrapTrust, error, pinned, senderInfo };
      });
      saveFloors(floorBumps);
      const opens = (g: Grade) => g.wrapTrust === 'verified' || g.wrapTrust === 'unverified';

      const toOpen = result.data.filter((_, i) => opens(grades[i])).map(s => s.wrapped_key as string);
      let opened: (Uint8Array | null)[];
      try {
        opened = await openSealedKeys(toOpen, onAnswer);
        onAnswer();
      } catch (e) {
        console.warn('[note] could not open incoming share keys this time; keeping the inbox as it was', e);
        return false;
      }
      const openedByIndex = new Map<number, Uint8Array | null>();
      let cursor = 0;
      grades.forEach((g, i) => { if (opens(g)) openedByIndex.set(i, opened[cursor++]); });

      // Collect sender key-change alarms across the batch so the recipient
      // can review + approve rotated keys instead of silently losing shares.
      const alarmsByUser = new Map<string, KeyChangeAlarm>();
      const out: IncomingShare[] = result.data.map((s, index) => {
        // Pass 2 — open (already done, above) and decrypt what pass 1 let through.
        const { item, owner, pinned, senderInfo } = grades[index];
        let { wrapTrust, error } = grades[index];
        let contentKey: Uint8Array | null = null;
        let note: NoteItem | null = null;
        if (wrapTrust === 'verified' || wrapTrust === 'unverified' || wrapTrust === 'invalid') {
          // GRADUATED FAIL-CLOSED (mirrors the mobile SDK's
          // store_circle_key): the sender is PINNED and the wrap signature
          // does NOT verify against the pinned signing key (or the
          // signature failed to parse → also 'invalid'). A legitimate wrap
          // from a pinned sender always verifies, so a present-but-invalid
          // signature is a server/relay forgery or key-substitution — DROP
          // it WITHOUT unwrapping. The key material of a forged share is
          // never touched: it is not unwrapped and then merely hidden by
          // the setShares() filter below. GRACE is reserved for first use
          // only (no pin → 'unverified', TOFU-pinned on unwrap below).
          // Consequence: a legitimate sender key-rotation drops that
          // sender's shares until they re-share under the rotated key AND
          // the pin is re-approved out-of-band (safety number) — intended
          // fail-closed, matching the SDK's pin-gated rejection.
          if (wrapTrust === 'invalid') {
            error = error ?? "This share couldn't be confirmed as coming from its sender, so it wasn't opened. Check with them another way before trusting a new copy.";
          } else if (item !== null && owner !== null) {
            contentKey = openedByIndex.get(index) ?? null;
            if (!contentKey) {
              error = "This share can't be opened on this device. Ask the sender to share it again.";
            } else {
              // TOFU-pin the sender's directory keys on first successful
              // unwrap when no pin existed yet. Future shares from this sender
              // then verify against this pin (so 'verified' means exactly
              // that). We never overwrite an existing pin here — a changed key
              // must go through out-of-band safety-number approval.
              if (!pinned && senderInfo) {
                try { pinUserKeys(owner, senderInfo.sharingPub, senderInfo.signingPub); } catch { /* best-effort */ }
              }
              // Decrypted under the canonical item id too, so every use of the
              // item in this verdict is one id.
              const plaintext = decryptWithContentKey(
                { nonce: s.content_nonce, ciphertext: s.encrypted_content },
                contentKey,
                item,
              );
              if (!plaintext) {
                error = "This share is damaged, so it couldn't be opened. Ask the sender to share it again.";
              } else {
                try {
                  const parsed = JSON.parse(plaintext);
                  note = toNoteItem(item, parsed, s.updated_at, s.created_at);
                  // A first contact that opened: the item is its owner's now.
                  if (wrapTrust === 'unverified' && owners[item] === undefined) binds.set(item, owner);
                } catch {
                  error = "This share is damaged, so it couldn't be opened. Ask the sender to share it again.";
                }
              }
            }
          }
        }

        // Sender key-change alarm: the sender is already PINNED but the
        // server's current directory key differs from the pin. A
        // legitimate rotation (the account's keys regenerated) OR a
        // server key-substitution both land here; either way the wrap
        // fails against the old pin → the share is dropped below. Record
        // it (with a per-sender affected count) so the recipient can
        // compare the safety number and approve the new key via
        // approveKeyChange — the only recovery path, since pinUserKeys
        // never overwrites a changed key.
        if (pinned && senderInfo) {
          const signingChanged =
            senderInfo.signingPub.toLowerCase() !== pinned.signingPubkeyHex.toLowerCase();
          const sharingChanged =
            senderInfo.sharingPub.toLowerCase() !== pinned.sharingPubkeyHex.toLowerCase();
          if (signingChanged || sharingChanged) {
            const alarmOwner = owner ?? s.owner_id;
            const prev = alarmsByUser.get(alarmOwner);
            alarmsByUser.set(alarmOwner, {
              userId: alarmOwner,
              email: s.owner_email,
              newSharingPub: senderInfo.sharingPub,
              newSigningPub: senderInfo.signingPub,
              pinnedSigningPub: pinned.signingPubkeyHex,
              affectedCount: (prev?.affectedCount ?? 0) +
                (wrapTrust === 'invalid' || wrapTrust === 'unsigned-stripped' ? 1 : 0),
            });
          }
        }

        if (wrapTrust === 'invalid') {
          console.error('[note] DROPPING share with invalid signature', {
            shareId: s.share_id, itemId: s.item_id, ownerId: s.owner_id,
          });
        }

        return {
          shareId: s.share_id,
          itemId: item ?? s.item_id,
          ownerId: owner ?? s.owner_id,
          permission: (s.permission === 'view' ? 'view' : 'edit'),
          sharerPublicKey: s.sharer_public_key,
          sharerEmail: s.owner_email,
          sharedAt: s.created_at,
          updatedAt: s.updated_at,
          itemType: s.item_type ?? ITEM_TYPE_NOTE,
          sharePermission: s.permission,
          note,
          contentKey,
          error,
          wrapTrust,
        };
      });

      // Drop wraps we can't establish trust for: cryptographically invalid
      // signatures (demonstrable server forgery), a signature STRIPPED from a
      // pinned sender, and rows carrying no wrapped key at all. Keep
      // 'verified' and 'unverified' — the latter including an unsigned
      // wrap from an unpinned sender (TOFU first use). This filter is
      // defense-in-depth for the 'invalid' case: a pinned-invalid share is
      // already never unwrapped/decrypted above (its note + contentKey are
      // null), so this only prevents it surfacing as an empty stub.
      //
      // Everything the filter removes goes to `blockedShares` — dropping it
      // is a security verdict; hiding it from the recipient is not.
      // A refresh that started after this one has already applied its answer:
      // this one applies nothing (see `lastApplied`), and what it read is not
      // "the list".
      if (thisLoad < lastApplied) {
        discarded = true;
        return false;
      }
      lastApplied = thisLoad;
      answeredHere = true;
      saveBindings(binds);
      setKeyChangeAlarms(Array.from(alarmsByUser.values()));
      // Once more, now that the answer is about to go on screen: a share
      // dismissed WHILE this answer was being opened (a decline that went
      // through meanwhile) is in it, and was not in `dismissedHere` when the
      // rows were first filtered.
      const applied = out.filter(s => !dismissedHere.has(s.shareId));
      const trusted = applied.filter(s => s.wrapTrust === 'verified' || s.wrapTrust === 'unverified');
      // Named by the server, whatever this page made of the row (see `listedNotebooks`).
      const notebookRows = applied.filter(s => s.itemType === ITEM_TYPE_NOTEBOOK);
      // Only an inbox read to its end is the list (see INBOX_PAGE_LIMIT): one
      // that was not names what it names, and says nothing about the rest.
      const complete = served.complete;
      setListedNotebooks(complete ? new Set(notebookRows.map(s => s.itemId)) : null);
      // Offered again after a decline, by a row that decline did not dismiss:
      // it is a new question, and the invitation's own state decides from here.
      const reoffered = [...declined()].filter(([id, dismissed]) =>
        notebookRows.some(s => s.itemId === id && !dismissed.has(s.shareId)));
      if (reoffered.length > 0) {
        const next = new Map(declined());
        for (const [id] of reoffered) next.delete(id);
        setDeclined(next);
      }
      // What the server says was declined, on another device or before a
      // reload; never a notebook this same answer offers (lib/inboxPage).
      const declinedOnServer = declinedOnTheServersWord(
        served.declined, new Set(notebookRows.map(s => s.itemId)), serverDeclined(), tryCanonicalAccountId);
      if (declinedOnServer !== serverDeclined()) saveServerDeclined(declinedOnServer);
      setServerDeclined(declinedOnServer);
      // What the server says is on offer (see `serverOffered`): this answer's
      // list, or none. Never an earlier answer's.
      setServerOffered(served.offered !== null ? new Set(served.offered) : null);
      // A share of a declined notebook's note, made after the decline, that
      // arrived all the same (its row did not say which notebook it is in):
      // not listed. On the server's word only: a decline still on its way
      // takes nothing off the list and dismisses nothing.
      const strays = sharesOfDeclinedNotebooks(trusted, declinedOnServer, ITEM_TYPE_NOTEBOOK, tryCanonicalAccountId);
      setShares(strays.length === 0 ? trusted : trusted.filter(s => !strays.includes(s)));
      // And it is DISMISSED, which cannot be taken back, only on a list that
      // THIS answer carried. The server reads that list and the first page's
      // shares in one snapshot, and later pages hold only shares older than
      // the first page's, so a notebook it names has nothing new on offer
      // among them. A list kept from an earlier answer may be older than
      // these rows (the owner removed the reader and is inviting them
      // again): enough to keep a share off the list until the next answer,
      // not to dismiss it.
      if (served.declined !== null) {
        for (const stray of strays) {
          void sharesInboxStore.dismiss(stray.shareId).then(
            (gone) => { if (!gone) console.warn('[note] a note of a declined notebook could not be dismissed; it is not shown, and is tried again at the next refresh'); },
            () => {},
          );
        }
      }
      // A kept-but-undecryptable share (unwrap or decrypt failed, so `note` is
      // null) renders nowhere either — NotesView filters `note !== null`. It is
      // just as invisible as a dropped one, so it belongs on the same list.
      setBlockedShares(
        applied
          .filter(s => (s.wrapTrust !== 'verified' && s.wrapTrust !== 'unverified') || s.note === null)
          .map(s => ({
            shareId: s.shareId,
            itemId: s.itemId,
            ownerId: s.ownerId,
            sharerEmail: s.sharerEmail,
            sharedAt: s.sharedAt,
            reason: s.error ?? 'This shared item could not be opened.',
            wrapTrust: s.wrapTrust,
            itemType: s.itemType,
          })),
      );
      // The AUTHORITATIVE list only when it is all of it (see INBOX_PAGE_LIMIT).
      return complete;
    } finally {
      // Still loading while a later refresh is under way.
      if (thisLoad === newestLoad) setLoading(false);
      // A refresh that was discarded has answered nothing: the one that
      // superseded it has, or will. Marked "answered" all the same, an older
      // refresh finishing first would release the hold on a pending
      // invitation's notes while the list it was waiting for was still on its
      // way.
      if (!discarded) {
        setGotNoAnswer(firstPageUnread && !answeredHere);
        setAnswered(true);
      }
    }
  },

  /** The accepted share of `itemId`, under any spelling of it. */
  getByItemId(itemId: string): IncomingShare | undefined {
    const id = tryCanonicalAccountId(itemId);
    return id === null ? undefined : shareOfItem(shares(), id);
  },

  /** Number of shares that arrived after the user's last acknowledgement.
   *  Drives the unread badge on the sidebar. */
  unreadCount(): number {
    const cursor = lastSeenAt();
    return shares().filter((s) => !cursor || s.sharedAt > cursor).length;
  },

  /** Mark the current inbox as seen up to the most recent share. Called
   *  when the user opens the "Shared with me" view — clears the badge. */
  markSeen() {
    const mostRecent = shares().reduce<string>((max, s) => (s.sharedAt > max ? s.sharedAt : max), '');
    const next = mostRecent || new Date().toISOString();
    setLastSeenAt(next);
    try { scopedSetItem(LAST_SEEN_KEY, next); } catch {}
  },

  /**
   * Apply a local edit produced by `notesStore.updateNote` on a shared note.
   * Replaces the cached note snapshot with the newly-merged content so the
   * inbox view re-renders immediately without waiting for a fresh `load()`.
   */
  applyLocalEdit(itemId: string, nextNote: NoteItem, updatedAt: string) {
    const id = tryCanonicalAccountId(itemId);
    setShares((prev) => prev.map((s) => (
      s.itemId === id
        ? { ...s, note: { ...nextNote }, updatedAt }
        : s
    )));
  },

  /**
   * Re-pin a sender's rotated keys after the user confirmed the safety
   * number out-of-band, then reload so the shares that were dropped as
   * 'invalid' against the OLD pin now verify + decrypt under the new pin.
   * This is the only recovery path from a legitimate sender key rotation —
   * pinUserKeys deliberately never overwrites a changed key.
   */
  async approveKeyChange(userId: string): Promise<void> {
    const alarm = keyChangeAlarms().find((a) => a.userId === userId);
    if (!alarm) return;
    approveUserKeyChange(userId, alarm.newSharingPub, alarm.newSigningPub);
    setKeyChangeAlarms((prev) => prev.filter((a) => a.userId !== userId));
    await sharesInboxStore.load();
  },

  /** Hide an alarm without approving (the shares stay dropped). It reappears
   *  on the next load while the server still advertises the changed key. */
  dismissKeyChange(userId: string): void {
    setKeyChangeAlarms((prev) => prev.filter((a) => a.userId !== userId));
  },

  /** Signal-style safety number for the sender's NEW keys, to compare
   *  out-of-band before approving. null when it can't be computed (own keys
   *  or user id unavailable). */
  safetyNumber(userId: string): string | null {
    const alarm = keyChangeAlarms().find((a) => a.userId === userId);
    const me = authStore.user()?.id;
    if (!alarm || !me) return null;
    try {
      return computeSafetyNumber(me, userId, alarm.newSharingPub, alarm.newSigningPub);
    } catch {
      return null;
    }
  },

  // -------------------------------------------------------------------------
  // Recipient consent: dismiss a share, block/unblock a sender
  // -------------------------------------------------------------------------

  /** Dismiss a single inbound share so it drops out of the inbox
   * (POST /shares/inbox/{id}/dismiss). Sticky server-side. Optimistically
   * removes it from the local signal on success.
   *
   * Always `share_only=true`: THIS share and nothing more. Without it the
   * server takes a notebook's share dismissed for that notebook DECLINED,
   * because that is how pages older than the decline request declined.
   * This page declines with `declineNotebook`; what it dismisses here is a
   * share it could not open, or one note, and for a notebook the reader
   * had accepted that must not keep its later notes away for good. */
  async dismiss(shareId: string): Promise<boolean> {
    const r = await apiRequest(`/api/v1/shares/inbox/${shareId}/dismiss?share_only=true`, { method: 'POST' });
    // 404: no such share is addressed to this account any more (the owner
    // withdrew it, or removed the reader, while it was on screen). It is gone,
    // which is what a dismissal wants; reported as a failure it would make a
    // decline fail with "check your connection" on every retry.
    const gone = r.success || r.status === 404;
    if (gone) {
      dismissedHere.add(shareId);
      setShares((prev) => prev.filter((s) => s.shareId !== shareId));
      // Blocked shares are dismissible too, and MUST be — a share we refuse to
      // open is exactly the one the recipient can do nothing else about, so
      // without this its banner is permanent. The server dismissal is sticky,
      // so it stays gone across reloads and devices.
      setBlockedShares((prev) => prev.filter((s) => s.shareId !== shareId));
    }
    return gone;
  },

  /**
   * Decline a notebook WHOLE, in one request
   * (POST /shares/notebooks/{id}/decline): the server dismisses the notebook's
   * share, every note in it and the shares named here, all of them or none.
   *
   * `shareIds` are the shares this page knows to belong to the notebook from
   * their decrypted content. The server finds the notebook's notes itself, by
   * the notebook each row carries; these cover a note whose row carries none.
   *
   * True only when the server took it. Anything else, an older server without
   * the route included, is a decline that did not happen: nothing was
   * dismissed, and nothing here is changed.
   */
  async declineNotebook(notebookId: string, shareIds: readonly string[]): Promise<boolean> {
    const r = await apiRequest<{ dismissed?: unknown }>(
      `/api/v1/shares/notebooks/${encodeURIComponent(notebookId)}/decline`,
      { method: 'POST', body: { share_ids: [...new Set(shareIds)].slice(0, DECLINE_MAX_SHARE_IDS) } },
    );
    if (!r.success) return false;
    const dismissed: unknown[] = Array.isArray(r.data?.dismissed) ? r.data.dismissed : [];
    const gone = new Set(dismissed.filter((id): id is string => typeof id === 'string'));
    for (const id of gone) dismissedHere.add(id);
    setShares(prev => prev.filter(s => !gone.has(s.shareId)));
    setBlockedShares(prev => prev.filter(s => !gone.has(s.shareId)));
    return true;
  },

  /** Block a sender by email (POST /shares/block). The server retroactively
   * dismisses every current share from that email and auto-dismisses future
   * ones, so drop them all from the local signal too.
   *
   * `declining` is the notebook whose INVITATION the block was pressed on:
   * the server declines it in the same transaction, with the shares named
   * (as `declineNotebook` names them). Without the decline, after an
   * unblock that notebook's new notes would arrive with nothing to answer.
   * One request, so there is never a decline that went through beside a
   * block that did not. */
  async blockSender(
    email: string,
    declining?: { notebookId: string; shareIds: readonly string[] },
    unanswered: readonly string[] = [],
  ): Promise<boolean> {
    const named = new Set(declining?.shareIds ?? []);
    const r = await apiRequest<{ declined_notebooks?: unknown } | null>('/api/v1/shares/block', {
      method: 'POST',
      body: {
        email,
        ...(declining
          ? { decline_notebook_id: declining.notebookId, share_ids: [...named].slice(0, DECLINE_MAX_SHARE_IDS) }
          : {}),
        // The sender's invitations the reader has not answered: declined with
        // the block (lib/notebookInvites `unansweredFrom`, where the caller
        // gets them). Always sent, an empty list too: it is what asks the
        // server to say which it declined.
        unanswered_notebook_ids: [...new Set(unanswered)],
      },
    });
    if (r.success) {
      // What the server declined with the block is declined here at once: the
      // notes of those notebooks are held back on this page, whoever sent
      // them, before the next read of the inbox says so. (An older server
      // answers with no list, and declined none.)
      const declinedToo: unknown[] = Array.isArray(r.data?.declined_notebooks) ? r.data.declined_notebooks : [];
      const marked = declinedToo.filter((id): id is string => typeof id === 'string' && id !== '').map(id => id.toLowerCase());
      if (marked.length > 0) {
        setDeclined((prev) => {
          const next = new Map(prev);
          for (const id of marked) next.set(id, new Set(prev.get(id) ?? []));
          return next;
        });
      }
      const lc = email.toLowerCase();
      const theirs = (s: { sharerEmail: string | null }) => (s.sharerEmail ?? '').toLowerCase() === lc;
      // The server dismissed every share of theirs: an older answer that still
      // carries one must not bring it back (see `dismissedHere`). The ones this
      // page would not open are theirs as well: they leave the "could not be
      // opened" banner with the rest, instead of standing there until the next
      // refresh asking about a sender who has just been blocked. And the shares
      // named for the decline went with it, whoever sent them.
      const gone = (s: { shareId: string; sharerEmail: string | null }) => theirs(s) || named.has(s.shareId);
      for (const s of [...shares(), ...blockedShares()]) if (gone(s)) dismissedHere.add(s.shareId);
      for (const id of named) dismissedHere.add(id);
      setShares((prev) => prev.filter((s) => !gone(s)));
      setBlockedShares((prev) => prev.filter((s) => !gone(s)));
    }
    return r.success;
  },

  /** Remove a sender block (POST /shares/unblock). Does NOT resurrect
   * previously-dismissed shares — server-side dismissal is sticky; the
   * sender re-shares to reappear.
   *
   * The address goes in the BODY, like a block's: a path is what a proxy's
   * access log keeps, and every address a person unblocked would sit there
   * in the clear. */
  async unblockSender(email: string): Promise<boolean> {
    const r = await apiRequest('/api/v1/shares/unblock', { method: 'POST', body: { email } });
    return r.success;
  },

  /** List the caller's blocked sender emails (GET /shares/blocks) for a
   *  management view. Returns [] on failure. */
  /** The people this account has blocked, or NULL when the list could not be
   * read: that is not "nobody" (read as an empty list, Settings would say
   * "You haven't blocked anyone"). */
  async listBlocks(): Promise<BlockedSender[] | null> {
    const r = await apiRequest<BlockedSender[]>('/api/v1/shares/blocks');
    return r.success && Array.isArray(r.data) ? r.data : null;
  },
};
