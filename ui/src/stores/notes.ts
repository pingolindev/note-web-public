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
 * Notes store — manages note CRUD and sync with the backend.
 *
 * All encryption/decryption happens here in the browser.
 * The store maintains a local cache in memory and syncs via delta pull/push.
 */

import { createSignal, createMemo, createRoot } from 'solid-js';
import { apiRequest } from '../lib/apiClient';
import {
  encryptNote, decryptNote, isCryptoReady, EncryptedData,
  generateContentKey, wrapContentKeyWithVault, unwrapContentKeyWithVault,
  encryptWithContentKey, decryptWithContentKey, opensBoundToItem, vaultKeyThatOpens,
} from '../lib/crypto';
import { ensurePreviousIdentities, previousIdentitiesAnswered } from '../lib/previousIdentities';
import { notebooksStore } from './notebooks';
import { sharesInboxStore } from './sharesInbox';
import { authStore, getCachedOwner } from './auth';
import {
  shareNoteWithRecipientResult, shareNotebookWithRecipientResult, unshareNoteWithRecipient, rotateContentKey,
} from '../lib/shareUtils';
import { finishWaitingIn, anyWaiting, isUnfinished, FINISH_RETRY_MS, type FinishSteps, type Tried } from '../lib/finishInvitations';
import { ownerSharesSettled } from '../lib/ownerShareInFlight';
import { forgetUnsent, rememberUnsent, RETRYABLE, unsentShares } from '../lib/unsentShares';
import { forgetTakeBack, notesToTakeBack, rememberTakeBack } from '../lib/notesToTakeBack';
import { listAttachmentsForRekey } from '../lib/attachmentUpload';
import { needsKeyLookup, recipientsForNewNote, withLookedUpKeys, type FanOutRecipient } from '../lib/notebookFanOut';
import { lookupDirectoryKeys } from '../lib/recipientKeys';
import { shareHealthStore } from './shareHealth';
import { planDrop, compareNoteOrder, isPositionOnly, canWriteNote,
         createSwapGate, resetSwapGate, releaseLatch, considerSwap, type Pointer } from '../lib/dropOrder';
import * as noteDb from '../lib/noteDb';
import { receiveNotebookId } from '../lib/notebookId';
import { awaitsInvitation, pendingNotebookIds, unansweredFrom, type InvitationState } from '../lib/notebookInvites';
import { matchesSearch } from '../lib/noteSearch';
import { moveOfPeople, sameNotebook, serverNotebook, settled, withChange, type Addressed } from '../lib/notebookMove';
import { noteDocument } from '../lib/noteDocument';
import { askTwice } from '../lib/askTwice';
import { positivelyOwn, rescuePlan, type RescueOutcome } from '../lib/noteRescue';
import {
  placeNote, shouldShowQueued, editsIn, hasEdits, foldIntoCreate, createFromCard, afterCreate, afterLanding, carriesText,
} from '../lib/pendingNotes';
import { isAccountStop, isStopped, scopedGetItem, scopedRemoveItem, scopedSetItem, tryCanonicalAccountId } from '../lib/account';
import { registerOwnNoteCheck } from '../lib/ownNotes';
import { firstByKey } from '../lib/listIndex';
import { oneAtATime, type RunControl } from '../lib/oneAtATime';

/**
 * Stale-tab fence for the note cache.
 *
 * Tabs of one account share its note cache and pending-edit queue. A tab left
 * open under account A after account B logs in (same origin → shared cookie)
 * still holds A's in-memory identity and vault key, and must not write A's
 * plaintext snapshot — e.g. through the post-5xx offline-queue path below —
 * once the browser's cache belongs to B: B's sign-in wipes A's data, and a late
 * write would bring it back.
 *
 * `authStore.user()?.id` is this tab's authenticated identity (in-memory,
 * per-tab, only changes on a full reload). `getCachedOwner()` is the last
 * account to authenticate on this browser (localStorage OWNER_KEY, shared +
 * live across tabs; a logout/account-switch wipe sets it to B or clears it).
 * A definite A≠B mismatch means this tab no longer owns the shared cache, so we
 * skip the write. Unknown-on-either-side falls through to allow so first-login /
 * pre-owner offline queueing keeps working.
 */
export function ownsSharedCache(): boolean {
  const tabUser = authStore.user()?.id;
  const owner = tryCanonicalAccountId(getCachedOwner());
  // Strict when this tab is authenticated: a logged-in tab may only write the
  // shared cache when it still matches the browser's cache owner. Blocking the
  // no-owner window too (tabUser set, owner null) closes a stale-tab race where
  // a wipe cleared OWNER_KEY out from under a tab still holding A's identity +
  // vault key. Unauthenticated (no tabUser) still falls through so first-login /
  // pre-owner queueing keeps working — checkAuth sets OWNER_KEY *before* setUser,
  // so a legitimately authenticated tab never sees a null owner.
  return !tabUser || tabUser === owner;
}

/**
 * Keys this client owns in the decrypted content JSON. Anything else that
 * arrives is another client's field and must survive our next save — see
 * `NoteItem.extras`.
 *
 * Kept in sync with the two encode sites below (`createNote`'s literal and
 * `updateNote`'s `merged`). A key written there but missing here would be
 * duplicated into extras and written twice.
 */
const KNOWN_CONTENT_KEYS = new Set([
  'title', 'body', 'note_type', 'color', 'is_pinned', 'is_archived',
  'labels', 'checklist_items', 'sort_order', 'edit_mode', 'notebook_id',
  'has_attachments',
]);

/** Everything in the decrypted JSON that isn't ours, kept verbatim. */
export function extrasFrom(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
  let extras: Record<string, unknown> | undefined;
  for (const key of Object.keys(parsed)) {
    if (KNOWN_CONTENT_KEYS.has(key)) continue;
    (extras ??= {})[key] = parsed[key];
  }
  return extras;
}

export interface NoteItem {
  id: string;
  title: string;
  body: string;
  noteType: string;
  color: string | null;
  isPinned: boolean;
  isArchived: boolean;
  labels: string[];
  checklistItems?: { text: string; checked: boolean }[];
  sortOrder: number;
  editMode: 'rich' | 'markdown';
  notebookId: string | null;
  /**
   * The OWNER's notebook id on a note shared with us. Three things depend on it:
   *
   *  - the write path: a recipient's edit re-encrypts the whole payload, so
   *    without somewhere to park this the save would delete the owner's
   *    notebook assignment;
   *  - FILTERED, via `noteIsInNotebook` (NotesView) — matching `notebookId`
   *    alone opens an accepted shared notebook empty;
   *  - RENDERED, on the inbox card — its presence is what says a note arrived
   *    as part of a notebook somebody shared, rather than on its own.
   *
   * So it is load-bearing UI state, not scratch space: dropping it from a
   * decode path silently empties a shared notebook and silently removes the
   * "from <notebook>" clause, with nothing failing. `noteDb` keeps it for free
   * (`putNote` structured-clones the whole NoteItem), and the inbox re-decodes
   * it on every fetch.
   *
   * Still never to be matched against one of OUR notebook ids — see
   * [receiveNotebookId] for why the two ids stay separate.
   */
  ownerNotebookId?: string | null;
  hasAttachments: boolean;
  /**
   * True when WE have shared this note with someone. Comes from the server
   * (`shared_by_me` on the sync row) rather than from the encrypted content,
   * because share rows are server-side state the payload knows nothing about.
   *
   * Absent on a note built outside sync (a fresh create, an inbox stub), so
   * it reads as false until the next pull — a note briefly un-badged is
   * self-correcting; one wrongly badged as shared is a privacy scare.
   */
  isShared?: boolean;
  /**
   * How many distinct people WE have shared this note with, from the server's
   * `shared_with_count` on the sync row.
   *
   * `isShared` answers "is it shared"; this answers "with how many", which the
   * card has to say next. Computing it client-side is not possible for a note
   * shared on its OWN — only a notebook's roster is local — and asking per note
   * is the N+1 that `shared_by_me` was added to avoid.
   *
   * UNDEFINED, not 0, when the server did not send it: a backend predating the
   * field, or an endpoint that omits it. The card then falls back to the
   * notebook roster and finally to a bare "Sharing", rather than announcing
   * "with 0 people" about a note that is demonstrably shared.
   */
  sharedWithCount?: number;
  /**
   * True when the note belongs to ANOTHER user and reached us through a
   * share — sync rows carry the OWNER's user_id. The revoked-share eviction
   * keys on this: a foreign note whose inbox row is gone was unshared and
   * must not survive locally. `/sync/pull` can never tombstone it — the
   * share row that let it flow is the very row the revoke deleted — so
   * eviction against the authoritative inbox is the only path. Absent on
   * caches from before the flag = unknown → never evicted, only re-stamped.
   */
  foreignOwner?: boolean;
  /**
   * Which key opened this note in this browser: the account's own vault
   * ('vault': the vault-wrapped content key, or the vault itself on a legacy
   * note) or an accepted share's key ('share'). A note is sealed with the key
   * that opened it: one opened through the vault is never saved, or edited
   * live, under a share's key, whatever the inbox holds. Absent on caches
   * written by older builds — [openedWith] then decides from the key the
   * note holds.
   */
  openedVia?: 'vault' | 'share';
  /**
   * Keys in the decrypted content JSON this client does not know about,
   * kept verbatim so a save does not destroy them.
   *
   * Both phone clients do this deliberately — Note Android has
   * `KNOWN_KEYS` + `extrasFrom`, Note iOS has `extras` "written back
   * verbatim on encode". A web save built from a fixed literal would
   * silently drop anything the other two added: any field shipped to a
   * phone before the web knows about it would survive a phone save and be
   * destroyed by the next web save — data loss that only shows up during a
   * staggered rollout.
   */
  extras?: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  /** Server-side wrapped content key. When null/undefined the note is
   * legacy and uses vault-key encryption directly; on next write we
   * rotate it to a fresh content key. */
  wrappedContentKey?: string | null;
  wrappedContentKeyNonce?: string | null;
  /** Monotonic per-item content-key generation. Bumped by the server on every
   * rotate-shares. The share signer binds it into the wrap signature
   * (share-create → this value; rotate → this value + 1) and recipients enforce
   * it as a rollback floor. Absent (base 1) on older rows and partial
   * constructors (importers, inbox stubs); read as `?? 1`. */
  contentKeyGeneration?: number;
  /**
   * Written offline and not yet accepted by the server.
   *
   * The note lives in the pending queue and in the grid at the same time: the
   * queue is what makes it survive, the grid entry is what makes the person
   * who wrote it believe that. Without this the composer would clear, the
   * note would go to IDB, and nothing on screen would show it existed —
   * indistinguishable from having lost it.
   *
   * Cleared by the create that finally lands (see the success branch of
   * [createNote], which replaces the optimistic row in place).
   */
  pendingSync?: boolean;
  /**
   * The notebook the SERVER has this note in (`null`: none), for as long as a
   * move made here has not been carried through: sent, and the note's sharing
   * brought in line with it. Absent: nothing is owed. Kept with the card, on
   * this device only (lib/notebookMove).
   */
  movedFrom?: string | null;
  /**
   * Who had the note through `movedFrom`, by address, still owed taking off;
   * kept and dropped with it, on this device only (lib/notebookMove).
   */
  movedFromPeople?: string[];
}

/** Outcome of a create attempt. `note` is the created item on server success;
 *  `queued` is true when the create couldn't reach the server but was safely
 *  persisted to the offline queue for replay. The composer treats either as
 *  "text is safe, reset the form"; only `{ note: null, queued: false }`
 *  (a hard denial like the 402 note-cap, or a non-owner tab) means "keep the
 *  user's text so nothing is lost". */
export interface CreateResult {
  note: NoteItem | null;
  queued: boolean;
  /** Refused because this tab holds no E2EE keys (it is locked until the
   *  account portal unlocks it). The composer keeps the text and says why. */
  locked?: boolean;
}

/** The decrypted content object a create sends up, as built by createNote. */
interface NewNoteContent {
  title: string;
  body: string;
  note_type: string;
  color: string | null;
  is_pinned: boolean;
  is_archived: boolean;
  labels: string[];
  checklist_items: { text: string; checked: boolean }[] | null;
  sort_order: number;
  edit_mode: string;
  notebook_id: string | null;
  has_attachments: boolean;
}

/**
 * The grid row for a note this client just wrote.
 *
 * Shared by both outcomes of a create — the one the server accepted and the
 * one queued offline — so the two rows cannot drift into different shapes.
 * That matters because the queued row is later REPLACED by the accepted one:
 * if they disagreed about a field, a note would visibly change when it synced.
 *
 * Server-assigned fields (`version`, timestamps) come in via [over] once the
 * server has spoken. A note still sitting in the offline queue has none of
 * them, so it gets version 0 and local timestamps until the create lands.
 */
function localNote(
  id: string,
  content: NewNoteContent,
  wrapped: { wrappedKey: string; nonce: string },
  over: Partial<NoteItem> = {},
): NoteItem {
  const now = new Date().toISOString();
  return {
    id,
    title: content.title,
    body: content.body,
    noteType: content.note_type,
    color: content.color,
    isPinned: content.is_pinned,
    isArchived: false,
    labels: content.labels,
    checklistItems: content.checklist_items || undefined,
    sortOrder: content.sort_order,
    editMode: content.edit_mode as 'rich' | 'markdown',
    notebookId: content.notebook_id,
    hasAttachments: content.has_attachments || false,
    version: 0,
    createdAt: now,
    updatedAt: now,
    deleted: false,
    wrappedContentKey: wrapped.wrappedKey,
    wrappedContentKeyNonce: wrapped.nonce,
    // Made here, under our own vault.
    openedVia: 'vault',
    ...over,
  };
}

interface ServerItem {
  id: string;
  user_id: string;
  item_type: number;
  encrypted_content: string;
  content_nonce: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted: boolean;
  circle_id: string | null;
  content_size: number;
  /** Server-computed: this user has shared the item with someone. */
  shared_by_me?: boolean;
  /** How many distinct people WE have shared this item with. Absent on a
   *  backend predating it, and on every non-sync SELECT. */
  shared_with_count?: number;
  wrapped_content_key?: string | null;
  wrapped_content_key_nonce?: string | null;
  content_key_generation?: number;
  /** The server's notebook column: written only while the notebook has an
   * item (see the create path), so a hint beside the payload's own notebook
   * id, never instead of it. */
  notebook_id?: string | null;
}

interface SyncResponse {
  items: ServerItem[];
  cursor: string | null;
  /** Tie-breaker paired with `cursor`: the id of the last item in the page.
   *  Echoed back as `since_id` so a group of same-`updated_at` notes split
   *  across a page boundary is neither skipped nor re-sent. */
  cursor_id: string | null;
  has_more: boolean;
  /** item_id -> how many DISTINCT people we have shared it with.
   *
   *  A side channel, because `shared_with_count` rides an item's own sync row
   *  and sharing does not touch `items` — so this device could never hear that
   *  a count moved on another one. Absent when we have shared nothing, and
   *  absent on the fast path; both mean "no information", never "zero". */
  share_counts?: Record<string, number>;
}

const [notes, setNotes] = createSignal<NoteItem[]>([]);

/**
 * Which key opened `n` here: its own [NoteItem.openedVia], or, on a note
 * cached by an older build, the key it holds. A wrap that opens with our
 * vault is 'vault'. No wrap at all is 'vault' too: every shared note carries
 * its owner's wrapped key, so only a legacy own note has none. A wrap that
 * does not open is null: neither can be told (an own note locked by a
 * password reset, or a shared note until the one-time re-pull re-opens it),
 * and it is never sealed under a share's key either — its save is refused.
 *
 * Never 'share' without openedVia: the foreign stamp an older build wrote
 * was the server's word about user_id, so it decides nothing here.
 */
export function openedWith(n: NoteItem): 'vault' | 'share' | null {
  if (n.openedVia) return n.openedVia;
  if (n.wrappedContentKey && n.wrappedContentKeyNonce) {
    const key = unwrapContentKeyWithVault(n.wrappedContentKey, n.wrappedContentKeyNonce);
    if (key) {
      key.fill(0);
      return 'vault';
    }
    return null;
  }
  return 'vault';
}

/**
 * The key a note's live-collab session runs on: the key that opened it.
 * An accepted share's key only for a note that key opened; a note opened
 * through our vault uses its own wrapped key, whatever the inbox holds.
 */
export function collabKeyFor(
  note: NoteItem,
  incoming: { contentKey: Uint8Array | null } | undefined,
): Uint8Array | null {
  if (incoming?.contentKey && openedWith(note) === 'share') return incoming.contentKey;
  if (note.wrappedContentKey && note.wrappedContentKeyNonce) {
    return unwrapContentKeyWithVault(note.wrappedContentKey, note.wrappedContentKeyNonce);
  }
  return null;
}

/**
 * The first note with a given id, by its canonical form: what
 * `notes().find(x => x && tryCanonicalAccountId(x.id) === id)` returns, without
 * walking the list. The inbox asks once per share, and with 10,000 shares and
 * 1,000 notes the walk would be 26 s of every sync (lib/listIndex).
 */
const noteWithId = firstByKey<NoteItem>(x => (x ? tryCanonicalAccountId(x.id) : null));

/** The inbox refuses a share naming a note this browser opened as its own.
 * Ids compare canonically, so another spelling of an own note's id is refused too.
 * Asked of the list as it is at that moment, and `openedWith` is asked each time:
 * only the search for the note is a lookup. */
registerOwnNoteCheck((itemId) => {
  const id = tryCanonicalAccountId(itemId);
  if (id === null) return false;
  const n = noteWithId(notes(), id);
  return n !== undefined && openedWith(n) === 'vault';
});
const [syncing, setSyncing] = createSignal(false);
const [lastSync, setLastSync] = createSignal<string | null>(null);
// Tie-breaker id paired with lastSync (the compound (updated_at, id) keyset
// cursor). Sent back as `since_id`; null on first sync → backend safely
// falls back to a plain `updated_at > since`.
const [lastSyncId, setLastSyncId] = createSignal<string | null>(null);
const [cacheLoaded, setCacheLoaded] = createSignal(false);
// Raised when note creation is rejected for hitting the free note cap (402
// quota_notes_exceeded). NotesView watches this to show the upgrade prompt
// instead of the create silently returning null.
const [noteLimitReached, setNoteLimitReached] = createSignal(false);
/**
 * Ids of rows the server sent that this client could not open.
 *
 * `decryptServerItem` returns null when a note will not decrypt and the sync
 * loop does `if (!note) continue`, so such a row simply never enters the store.
 * That is the right thing for the grid — there is nothing to draw — but it
 * makes the notes invisible to everything downstream, INCLUDING the backup:
 * export takes `notesStore.notes()`, so without this set a note the client
 * cannot read would be quietly absent from a file offered as a complete copy
 * of the account.
 *
 * A Set rather than a count because it survives re-sync: the same ids fail
 * again each time, and re-adding them must not inflate the number.
 */
const [undecryptableIds, setUndecryptableIds] = createSignal<Set<string>>(new Set());

/**
 * Ids of OUR OWN notes whose key this client cannot open — the notes an email
 * password reset leaves behind, since the vault key is derived from the account
 * keypair the reset replaces.
 *
 * A subset of what `undecryptableIds` would say, kept apart because the two
 * are read for different things: the backup needs every unreadable row, while
 * the "locked notes" banner must not count a note somebody shared with us
 * (theirs to fix, and <BlockedShares/> already speaks for it). Fed from two
 * places — the sync, for rows it could not open, and a check of the cached
 * notes' wraps (lockedOwnFromCache), because on a browser that already held the
 * notes the sync cursor is past them and they never come back to fail.
 *
 * Without it a reset account would open Note to the new-account empty state,
 * and a user who read that as "everything is gone" might throw away the
 * recovery key that could restore it.
 */
const [lockedOwnIds, setLockedOwnIdsRaw] = createSignal<Set<string>>(new Set());

/**
 * lockedOwnIds is PERSISTED, because the incremental pull never returns a note
 * that has not changed: on a browser that first opened the account after its
 * reset, the locked notes fail once — on the first full pull — and a reload
 * would otherwise forget them, taking the banner with it after one visit.
 * Opaque item ids only, TAGGED with the account they belong to and loaded only
 * for that signed-in account (hydrateLockedOwn) — so after an account switch
 * the previous account's ids can never be counted, or re-saved, as the next
 * one's. Swept with the rest of the app data on logout (crypto.clearKeys).
 * Written only while this tab owns the shared cache.
 */
const LOCKED_OWN_KEY = 'pingolin_note_locked_own';
/** How many recovered pre-reset identities the last FULL re-pull saw. */
const PREV_IDENTITIES_SEEN_KEY = 'pingolin_note_prev_identities_seen';
/**
 * Set once a FULL pull has opened again every row this account has here, so
 * each carries the key that opened it (NoteItem.openedVia). A row cached by
 * an older version has none, and its foreign stamp decides nothing.
 */
const OPENED_VIA_PULLED_KEY = 'pingolin_note_opened_via_pulled';
/** The account this page completed that pull for: a browser whose storage
 *  cannot keep the mark pulls in full once per load, not at every sync. */
let openedViaPulledFor: string | null = null;

/** The account whose locked set is in memory, or null before hydration. */
let lockedOwnFor: string | null = null;

/**
 * The server's notebook column of every note row of this account's OWN that
 * the pulls have seen, the trash and the rows that don't open here included:
 * a removal re-keys or revokes the notes of the notebook, and memory holds
 * only the ones that open. Per account, started again by the first pull of
 * another one.
 */
let ownRowNotebooks: { account: string | null; byNote: Map<string, string | null> } = { account: null, byNote: new Map() };

/** What the server holds of an own note that no key here opened (rescue after a reset). */
export interface RowNoKeyOpens {
  version: number;
  wrappedKey: string | null;
  wrappedKeyNonce: string | null;
}
/**
 * This account's own note rows that this session's pulls could not open, by id:
 * after a password reset, the notes from before it (lib/noteRescue). What the
 * server holds of each, as the pull saw it. Per account, like ownRowNotebooks;
 * a row that opens, or is deleted, goes.
 */
let rowsNoKeyOpens: { account: string | null; byId: Map<string, RowNoKeyOpens> } = { account: null, byId: new Map() };
/** A removal needs the account's every row (notebookNoteIds): the next sync pulls in full. */
let fullPullWanted = false;

/** Load the persisted locked set for `userId`, once per account. A set saved
 *  for anybody else is ignored. */
function hydrateLockedOwn(userId: string | null): void {
  if (!userId || lockedOwnFor === userId) return;
  lockedOwnFor = userId;
  let ids: string[] = [];
  try {
    const saved = JSON.parse(scopedGetItem(LOCKED_OWN_KEY) ?? 'null') as { owner?: unknown; ids?: unknown } | null;
    if (saved && tryCanonicalAccountId(saved.owner) === userId && Array.isArray(saved.ids)) {
      ids = saved.ids.filter((x): x is string => typeof x === 'string');
    }
  } catch { /* nothing usable saved */ }
  setLockedOwnIdsRaw(new Set(ids));
}

function setLockedOwnIds(next: Set<string> | ((prev: Set<string>) => Set<string>)): void {
  const before = lockedOwnIds();
  const after = typeof next === 'function' ? next(before) : next;
  if (after === before) return;
  setLockedOwnIdsRaw(after);
  if (!lockedOwnFor || !ownsSharedCache()) return;
  try {
    if (after.size === 0) scopedRemoveItem(LOCKED_OWN_KEY);
    else scopedSetItem(LOCKED_OWN_KEY, JSON.stringify({ owner: lockedOwnFor, ids: [...after] }));
  } catch { /* storage unavailable: the banner lasts this load */ }
}

function previousIdentitiesSeen(): number {
  try { return parseInt(scopedGetItem(PREV_IDENTITIES_SEEN_KEY) ?? '0', 10) || 0; } catch { return 0; }
}

/**
 * Notes whose last save was REFUSED because the key that wrapped them does not
 * open here. See updateNote: minting a replacement key would have re-keyed the
 * note out from under every other device and every recipient, so the edit is
 * kept locally instead and the editor says why.
 */
const [keyRefusedIds, setKeyRefusedIds] = createSignal<Set<string>>(new Set());

function withId(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
}

function withoutId(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

/**
 * Which cached notes are OURS and carry a wrap that no key we hold opens.
 *
 * Pure over its inputs so the rule can be tested without a store: a note counts
 * only when it is positively ours (`positivelyOwn`: counting by the stamp
 * alone misses a note made here shortly before a password reset), not an
 * incoming share, not deleted, and wrapped (a legacy vault-direct note has no
 * wrap to test from the cache).
 */
export function lockedOwnFromCache(
  cached: NoteItem[],
  canOpen: (wrappedKey: string, nonce: string) => boolean,
  isIncomingShare: (id: string) => boolean,
): Set<string> {
  const locked = new Set<string>();
  for (const n of cached) {
    if (!n || n.deleted || !positivelyOwn(n) || isIncomingShare(n.id)) continue;
    if (!n.wrappedContentKey || !n.wrappedContentKeyNonce) continue;
    if (!canOpen(n.wrappedContentKey, n.wrappedContentKeyNonce)) locked.add(n.id);
  }
  return locked;
}

// Drag state
const [dragPreview, setDragPreview] = createSignal<NoteItem[] | null>(null);
const [draggedId, setDraggedId] = createSignal<string | null>(null);
/** Whether a hover may reorder the preview: the same-target latch and the
 * just-vacated slots, with the rules and the cases they answer in
 * lib/dropOrder.ts. Kept there because it is pure decision logic that can
 * be tested on its own. */
const swapGate = createSwapGate();

/** The queue drain under way, settled when it ends — see notesStore.flushPending. */
let flushing: Promise<void> | null = null;

/** Set once the cached notes' wraps have been checked this load — see the
 *  end of `sync`. */
let lockedCacheChecked = false;

/**
 * Note ids with a DIRECT save in flight. Saves are LOCAL-FIRST — the
 * edit is written to the pending store BEFORE the network attempt and
 * removed when the server confirms — so a drain that fires mid-save (they
 * hang off every sync trigger) would read the pre-written entry and replay
 * the same edit concurrently: two PUTs, and the 409 machinery would fork a
 * duplicate "conflict copy" of a note that never conflicted. The drain
 * skips these ids; the entry is still there for the NEXT drain if the
 * direct save dies with the process.
 */
const savingNotes = new Set<string>();
/** Notes a rescue is re-saving right now (`rescueFromCopies`): a save waits for it. */
const rescuingNotes = new Set<string>();

/**
 * Notes deleted HERE while their create was on its way. The create's answer
 * comes after the delete and would put the note back: the create that lands
 * finds its id here and deletes the note there too.
 */
const deletedWhileSaving = new Set<string>();

/**
 * One pass over the offline queue.
 *
 * op:'create' replays as a create reusing the original id, so a still-offline
 * re-flush overwrites the same pending entry rather than duplicating the note;
 * op:'update' replays via updateNote. Only drop the entry on genuine server
 * success — a transient failure re-queues under the same id (createNote and
 * updateNote both do this) and must be left in place.
 */
async function drainPending(): Promise<void> {
  let pending = await noteDb.listPending();
  if (await requeueWaitingCards(pending)) pending = await noteDb.listPending();
  for (const p of pending) {
    // A tab stopped for another account's session sends nothing more; the
    // entries stay queued for their own account.
    if (isStopped()) return;
    if (savingNotes.has(p.id)) continue;
    const ok = p.op === 'create'
      ? (await notesStore.createNote(p.note, p.id)).note !== null
      : p.sharingOnly
        // Only a move's sharing is owed: no words are sent.
        ? await notesStore.carryOwedMove(p.id, p.note)
        : await notesStore.updateNote(p.id, p.note);
    // A create and an update each end their OWN entry: removed, kept, or (a
    // create whose card was edited meanwhile) turned into the update of those
    // edits. Removing it here as well would delete that update, and with it the
    // edit. Only a tab that may not write the queue leaves the entry to us.
    if (ok && !ownsSharedCache()) await noteDb.removePending(p.id);
  }
}

/**
 * One at a time for each note's queue entry: what reads the entry and then
 * writes it (an edit folding itself into a waiting create, a create ending its
 * entry) runs in turn, or an edit folded in between the two would be written
 * over, or removed with the entry.
 */
const entryTurns = new Map<string, Promise<void>>();
function inTurn<T>(id: string, work: () => Promise<T>): Promise<T> {
  const mine = (entryTurns.get(id) ?? Promise.resolve()).then(work, work);
  const over = mine.then(() => {}, () => {});
  entryTurns.set(id, over);
  void over.then(() => { if (entryTurns.get(id) === over) entryTurns.delete(id); });
  return mine;
}

/** A card the server has not confirmed: shown by a create that could not be sent (`waitForReplay`). */
function waitsForItsCreate(n: NoteItem | null | undefined): n is NoteItem {
  return !!n && n.pendingSync === true;
}

/**
 * Where the server's SHARING has a note while a move made here is owed: the
 * card's own record (`movedFrom`), else the queued card's (a change's
 * `movedFrom`), else where the card says it is. A pull or a version conflict
 * lays the server's row over the card, and the card's record goes with it; the
 * queue keeps its own. Only for whom a move takes the note from: the card
 * itself never takes a change's `movedFrom` (lib/notebookMove `withChange`).
 */
function sharingNotebook(existing: NoteItem, change: Partial<NoteItem>): string | null {
  if (existing.movedFrom !== undefined) return existing.movedFrom;
  if (change.movedFrom !== undefined) return change.movedFrom ?? null;
  return existing.notebookId ?? null;
}

/**
 * Who still has the note through that notebook (`movedFromPeople`): the card's
 * list, and the queued card's for the same move. The card's record may have
 * lost its list (a pull lays the server's row over the card, and keeps only
 * what it is told to), and taking off someone who no longer has the note does
 * nothing.
 */
function sharingPeople(existing: NoteItem, change: Partial<NoteItem>): string[] | undefined {
  const onCard = existing.movedFrom !== undefined ? existing.movedFromPeople : undefined;
  const queued = change.movedFrom !== undefined
    && (existing.movedFrom === undefined || sameNotebook(existing.movedFrom, change.movedFrom ?? null))
    ? change.movedFromPeople
    : undefined;
  if (onCard === undefined) return queued;
  if (queued === undefined) return onCard;
  return [...new Set([...onCard, ...queued].map(e => e.toLowerCase()))];
}

/** The card with `change` on it, remembering where the sharing has the note, and who has it there, while a move is owed. */
function withOwedMove(existing: NoteItem, change: Partial<NoteItem>): NoteItem {
  const from = sharingNotebook(existing, change);
  const people = sharingPeople(existing, change);
  const next = withChange(existing, change);
  if (sameNotebook(next.notebookId ?? null, from)) {
    delete next.movedFrom;
    delete next.movedFromPeople;
  } else {
    next.movedFrom = from;
    if (people !== undefined) next.movedFromPeople = people;
    else delete next.movedFromPeople;
  }
  return next;
}

/**
 * `change`, carrying the move this note's queue entry still owes when neither
 * the card nor the change remembers one: an edit made in another tab, whose
 * card never had the move or was re-based since. The edit's entry takes the
 * owed one's place in the queue, so without this its save would end the move:
 * the old notebook's people would keep the note, and it would never be
 * re-keyed. Where the note goes comes with it too, unless the change says: the
 * queue has it as this browser last moved it, and a tab that has not pulled
 * since would put the note back where it was.
 */
function withQueuedMove(change: Partial<NoteItem>, existing: NoteItem, entry: noteDb.PendingEdit | null): Partial<NoteItem> {
  if (existing.movedFrom !== undefined || change.movedFrom !== undefined) return change;
  if (entry?.op !== 'update' || entry.note.movedFrom === undefined) return change;
  return {
    ...change,
    movedFrom: entry.note.movedFrom,
    ...(entry.note.movedFromPeople !== undefined ? { movedFromPeople: entry.note.movedFromPeople } : {}),
    ...(change.notebookId === undefined ? { notebookId: entry.note.notebookId ?? null } : {}),
  };
}

/** `people`, and the addresses in `more` they do not have yet, as people a move takes the note from. */
function withAddresses(people: Addressed[], more: readonly string[] | undefined): Addressed[] {
  if (!more || more.length === 0) return people;
  const have = new Set(people.map(r => r.email.toLowerCase()));
  return [...people, ...more.filter(e => !have.has(e.toLowerCase())).map(email => ({ email }))];
}

/**
 * Who a move still owes taking off, kept with the move: on the card, and in
 * the note's queue entry while it carries the move. A later try reads them
 * there when the notebook's own list is gone, the notebook deleted.
 */
async function rememberOwedPeople(id: string, people: string[]): Promise<void> {
  const card = notes().find(n => n?.id === id);
  if (card) {
    const kept: NoteItem = { ...card, movedFromPeople: people };
    setNotes(prev => prev.map(n => n.id === id ? kept : n));
    if (ownsSharedCache()) noteDb.putNote(kept);
  }
  if (!ownsSharedCache()) return;
  await inTurn(id, async () => {
    const entry = await noteDb.getPending(id);
    if (entry?.op === 'update' && entry.note.movedFrom !== undefined) {
      await noteDb.queuePending({ ...entry, note: { ...entry.note, movedFromPeople: people } });
    }
  });
}

/**
 * Who a note in this notebook was passed on to, by address, as a create passes
 * it (notebookNoteRecipients): the owner's standing list, or, for a notebook
 * someone else owns, its roster and its owner. Read from the standing list
 * alone, a member's own note moved out of another's notebook would be taken
 * from nobody. Nothing is looked up: taking someone off needs no key.
 */
function notebookPeopleOf(notebookId: string): Addressed[] {
  const standing = notebooksStore.getNotebookShares(notebookId);
  if (standing.length > 0) return standing;
  const roster = notebooksStore.membersOf(notebookId);
  if (roster.length === 0) return [];
  const inboxRow = notebooksStore.notebookOpenedVia(notebookId) === 'share'
    ? sharesInboxStore.getByItemId(notebookId)
    : undefined;
  return recipientsForNewNote({
    roster,
    ownerEmail: inboxRow?.sharerEmail ?? null,
    myEmail: authStore.user()?.email ?? null,
  });
}

/**
 * A move's sharing, carried through: the note taken from the people of the
 * notebook its sharing had it in (`from`) who are not in the one it is in now
 * (`to`), given to `to`'s people, and re-keyed when anyone was taken off.
 *
 * 'owed' when a removal or the re-key did not go through: nothing is settled
 * and the next drain comes back to it (a re-key refused after the removals is
 * owed too, or the people taken off would keep the key).
 * `giveTo` false: the server did not place the note in `to`, and its people
 * are given nothing (the same rule as for a create).
 * `owedPeople`: who an earlier try found had it through `from`, still owed
 * taking off whatever `from`'s own list says now.
 */
async function carryMoveThrough(
  id: string,
  from: string | null,
  to: string | null,
  passedOn: boolean,
  contentKey: Uint8Array,
  giveTo: boolean,
  owedPeople?: readonly string[],
): Promise<'done' | 'owed'> {
  // As for a new note: an invitation that can be finished now is, before this
  // note is sealed to anyone on the notebook's list.
  if (to && giveTo) await finishInvitationsIn(to);
  const oldRecipients = from ? withAddresses(notebookPeopleOf(from), owedPeople) : [];
  /** Still owed: who has it through `from` goes with the move, for the next try. */
  const owe = async (): Promise<'owed'> => {
    await rememberOwedPeople(id, oldRecipients.map(r => r.email.toLowerCase()));
    return 'owed';
  };
  const newRecipients = to && giveTo ? notebooksStore.getNotebookShares(to) : [];
  const people = moveOfPeople<Addressed>(oldRecipients, newRecipients, passedOn);
  const adding = new Set(people.add.map(r => r.email.toLowerCase()));

  // Recipients who only belonged to the previous notebook lose access. If
  // they were also shared the note by hand, they need adding again: the
  // documented trade-off of the simpler model. The revokes are delete-only, so
  // the rotation below comes AFTER them: the attachments it may bring forward
  // are the ones listed here, before anyone is dropped.
  const attachmentsListedBefore = people.remove.length > 0 ? await listAttachmentsForRekey(id) : null;
  let revokedAny = false;
  let removalFailed = false;
  for (const r of people.remove) {
    const ok = await unshareNoteWithRecipient(id, r.email);
    if (!ok) {
      console.warn(`Failed to unshare ${id} from ${r.email} on notebook move`);
      removalFailed = true;
    }
    revokedAny = true;
  }
  // Someone could not be taken off just now: still owed, and nobody is given
  // the note yet. Given it first, the new notebook's people would keep it for
  // good if the note moved on before the removal went through: moved back,
  // nothing would be owed any more; moved on to a notebook of nobody's, the
  // re-key would re-wrap the new key for them. The next try gives it to
  // whoever the notebook it is in then has. Nor is the note re-keyed: the new
  // key would be sealed for the very person who is still on it.
  if (removalFailed) return owe();
  // The new notebook's people are given it, sealed to the keys they hold NOW
  // (see withCurrentDirectoryKeys).
  const toAdd = await withCurrentDirectoryKeys(newRecipients.filter(r => adding.has(r.email.toLowerCase())));
  for (const r of toAdd) {
    const outcome = await shareNoteWithRecipientResult(id, contentKey, r);
    if (to) shareHealthStore.record(to, r.email, outcome);
    // Sent again later when it did not go (lib/unsentShares).
    if (to) { if (outcome.ok) forgetUnsent(id, r.email); else rememberUnsent(id, to, r.email, outcome.reason); }
    if (!outcome.ok) console.warn(`Failed to auto-share ${id} to ${r.email} on notebook move (${outcome.reason})`);
  }
  // Forward secrecy: the move reused the note's content key, and the revokes
  // were delete-only, so whoever lost access still holds a key that opens every
  // later edit. The revoked rows are gone: the re-key re-wraps only the rest.
  if (revokedAny) {
    const rot = await rotateContentKey(id, [], undefined, { attachmentsListedBefore });
    if (!rot.rotated) {
      console.warn(`Rotation after notebook-move unshare failed for ${id}`);
      return owe();
    }
  }
  return 'done';
}

/**
 * This save's queue entry, made the job of the sharing its move still owes: its
 * words went up (`PendingEdit.sharingOnly`). Only the entry this save queued: a
 * later edit's entry carries the move by itself, and its words are not up yet.
 */
async function owedSharingOnly(id: string, queuedAt: string | null, card: NoteItem): Promise<void> {
  if (!ownsSharedCache() || queuedAt === null) return;
  await inTurn(id, async () => {
    const entry = await noteDb.getPending(id);
    if (!entry || entry.op !== 'update' || entry.queuedAt !== queuedAt) return;
    await noteDb.queuePending({ ...entry, note: card, sharingOnly: true });
  });
}

/** A note's document as a conflict compares it: what was written, not where it is filed nor its place in the grid. */
function wordsOf(doc: Record<string, unknown>): string {
  const { notebook_id: _filed, sort_order: _place, ...words } = doc;
  return JSON.stringify(words);
}

/**
 * Queue an edit of a note. When the note's CREATE is still in the queue, the
 * edit is folded into it instead, and never takes its place
 * (lib/pendingNotes).
 *
 * @returns the create that now carries the edit, or null when the edit was
 *   queued as an update, as for any note the server has.
 */
async function queueEdit(id: string, existing: NoteItem, content: Partial<NoteItem>): Promise<noteDb.PendingEdit | null> {
  const entry = await noteDb.getPending(id);
  const change = editsIn(content);
  if (entry?.op === 'create') {
    const folded = foldIntoCreate(entry, change);
    await noteDb.queuePending(folded);
    return folded;
  }
  // A card that says it is waiting, and no create behind it: a state an
  // older version can leave in a browser. The card is the only copy of the
  // note.
  const card = notes().find(n => n?.id === id);
  if (waitsForItsCreate(card)) {
    const remade = createFromCard(card, change, new Date().toISOString());
    await noteDb.queuePending(remade);
    return remade;
  }
  await noteDb.queuePending({
    id,
    // The whole card as it will be, remembering where the note's sharing is
    // while a move is owed: a pull or a conflict may take that off the card
    // before the drain comes.
    note: withOwedMove(existing, content),
    op: 'update',
    queuedAt: new Date().toISOString(),
  });
  return null;
}

/**
 * The end of a create's queue entry (see `afterCreate`).
 *
 * @returns what was changed on the card since the create was queued, now in
 *   the queue as an update for the caller to send; null when the entry is gone.
 */
async function endCreate(
  id: string,
  onServer: NoteItem | null,
  /**
   * Set when the changes the entry carried have been dealt with another way
   * (kept as a note of their own, or found to be nothing): they are not sent.
   * These are the changes that were looked at. If the entry holds others by
   * now, one was folded in since, and it has not been looked at: the entry
   * stays a create, and the next drain looks at all of it.
   */
  dealtWith?: Partial<NoteItem> | null,
): Promise<Partial<NoteItem> | null> {
  if (onServer === null) {
    await noteDb.removePending(id);
    return null;
  }
  const entry = await noteDb.getPending(id);
  if (dealtWith !== undefined) {
    const now = entry?.op === 'create' && hasEdits(entry.edits) ? entry.edits : null;
    if (JSON.stringify(now) !== JSON.stringify(dealtWith)) return null;
    await noteDb.removePending(id);
    return null;
  }
  const next = afterCreate(entry, onServer, new Date().toISOString());
  if (next === null) {
    await noteDb.removePending(id);
    return null;
  }
  await noteDb.queuePending(next.queue);
  return next.edits;
}

/** The changes a waiting create carries, for a card that the create is about to replace. */
async function editsWaitingOn(id: string): Promise<Partial<NoteItem> | null> {
  const entry = await noteDb.getPending(id);
  return entry?.op === 'create' && hasEdits(entry.edits) ? entry.edits : null;
}

/**
 * Show a note's card with these changes on it. A change that moves the note
 * is remembered as a move still to be carried through (lib/notebookMove).
 */
function showEdits(id: string, edits: Partial<NoteItem>): void {
  if (!notes().some(n => n?.id === id)) return;
  setNotes(prev => prev.map(n => n.id === id ? withChange(n, edits) : n));
  const shown = notes().find(n => n?.id === id);
  if (shown && ownsSharedCache()) noteDb.putNote(shown);
}

/**
 * Every card that waits for its create has that create in the queue.
 *
 * A card left saying "Not synced" after its entry has been dropped would
 * never be sent; the card still holds the note, so its create is queued
 * again from it. (A card with an UPDATE where its create was is put right
 * when that update is replayed: `queueEdit`.)
 *
 * @returns whether anything was queued.
 */
async function requeueWaitingCards(pending: noteDb.PendingEdit[]): Promise<boolean> {
  if (!ownsSharedCache()) return false;
  const queued = new Set(pending.map(p => p.id));
  let any = false;
  for (const card of notes()) {
    if (!waitsForItsCreate(card) || card.deleted || queued.has(card.id) || savingNotes.has(card.id)) continue;
    await inTurn(card.id, async () => {
      if (await noteDb.getPending(card.id)) return;
      // This page's card may be an OLD one. The cache is shared by this
      // account's tabs and a tab's cards are not: another tab may have sent
      // this note and gone on editing it, or deleted it, since this page drew
      // the card. Made again from such a card, the note's create would replace
      // what was written since, or bring back a note that had been deleted.
      // The cache says which it is.
      const stored = await noteDb.getNote(card.id);
      // Gone from the cache (deleted in another tab), or the cache cannot be
      // read: nothing is made from this card.
      if (!stored) return;
      if (!waitsForItsCreate(stored)) {
        // Sent by another tab: this page takes the card as it is now.
        setNotes(prev => prev.map(n => n.id === card.id ? stored : n));
        return;
      }
      await noteDb.queuePending(createFromCard(card, {}, new Date().toISOString()));
      any = true;
    });
  }
  return any;
}

/**
 * Version conflict (409): the server moved past the version this edit was
 * based on. Keep BOTH, exactly as the Android client does — the local text
 * becomes a NEW owned note titled "… (conflict copy)", and the original
 * re-adopts the server's winning state on the next sync pull.
 *
 * Without this branch a 409 would fall through the transient-error floor
 * (status undefined | >=500 | 429), which loses data two ways: a
 * modal-close save is DROPPED outright (nothing queued, the modal's text
 * dies with the modal), and a QUEUED edit is worse — it stays in the
 * pending store, re-reads the note's NEWER version on the next flush, and
 * silently OVERWRITES the state that had won. Forking removes both: the
 * local edit is durable immediately, and returning true lets the drain
 * remove the queue entry instead of re-clobbering.
 *
 * `ownedNote` decides whether the fork inherits the notebook: a recipient's
 * fork of a SHARED note must not try to join the owner's notebook (the
 * grouping id belongs to them, and the server would refuse or misfile it).
 * `extras` are not carried — createNote has no channel for them, and a
 * conflict copy losing unknown cross-client fields beats losing the body.
 * A 402 at the cap leaves the fork uncreated and returns false, so the
 * editor keeps the text dirty rather than dropping it.
 */
async function forkConflictCopy(
  existing: NoteItem,
  content: Partial<NoteItem>,
  ownedNote: boolean,
  /**
   * Where the server has the note now, when the caller read its row: an
   * owned note's copy is filed there, unless the save moves the note
   * (`moves`). 'unread': the row could not be read, and the copy is filed in
   * none. Absent: in the card's. Filed in the card's, an edit that raced a
   * move OUT would go, as a copy, to the people the move had just taken off.
   */
  serverHas?: { notebookId: string | null } | 'unread',
  /**
   * The save moves the note (updateNote's `moved`: where it puts it is not
   * where the server's sharing has it): the copy is filed where the move puts
   * it. Asked of the change instead (does it name a notebook?), a replay would
   * always be a move, since it passes the whole queued card, and the copy of
   * words typed offline would go to the notebook the card had then, and its
   * people, after another device had moved the note out.
   */
  moves = false,
): Promise<boolean> {
  const local = { ...existing, ...content };
  const title = `${(local.title ?? '').trim() || 'Untitled'} (conflict copy)`;
  const filedIn = !ownedNote ? undefined
    : moves || serverHas === undefined ? local.notebookId
    : serverHas === 'unread' ? null
    : serverHas.notebookId;
  const created = await notesStore.createNote({
    title,
    body: local.body,
    noteType: local.noteType,
    color: local.color,
    labels: local.labels,
    checklistItems: local.checklistItems,
    editMode: local.editMode,
    notebookId: filedIn,
  });
  if (created.note === null && !created.queued) return false;
  // Pull the server's winning state over the original. Fire-and-forget: the
  // fork is already durable, and awaiting a full sync here would hold the
  // save path hostage to a slow pull.
  void notesStore.sync();
  return true;
}

/**
 * A server row → the decrypted note, or null when this client cannot open it.
 *
 * The one decode path for rows that arrive OUTSIDE the offline cache: the sync
 * page and the single-row re-read a version conflict triggers (adoptServerRow).
 * `myUserId` is who WE are, for the ownership stamp; null leaves it unknown.
 */
function decryptServerItem(item: ServerItem, myUserId: string | null): NoteItem | null {
  try {
    // Per-note content key. Three code paths in
    // order of likelihood:
    //   1. Owned note with wrapped_content_key → unwrap with vault.
    //   2. Shared-to-us note → the wrapped_content_key in the
    //      row was wrapped under the OWNER's vault so it's opaque
    //      to us; look up the content key the sender sealed for
    //      us on the inbox row and decrypt with that.
    //   3. Legacy note from before per-note keys → decrypt
    //      directly under the vault.
    let decrypted: string | null = null;
    if (item.wrapped_content_key && item.wrapped_content_key_nonce) {
      const contentKey = unwrapContentKeyWithVault(
        item.wrapped_content_key,
        item.wrapped_content_key_nonce,
      );
      if (contentKey) {
        decrypted = decryptWithContentKey(
          { nonce: item.content_nonce, ciphertext: item.encrypted_content },
          contentKey,
          item.id,
        );
      }
    }
    // Path 2 below is the ONLY signal that this row is a note shared
    // WITH us rather than one we own: the content key came from an
    // inbox row the sender sealed for us, not from our vault. A row the
    // server itself names as ours never takes a share's key: a
    // share of an own note is a key the server chose.
    const ours = myUserId !== null && tryCanonicalAccountId(item.user_id) === myUserId;
    let fromIncomingShare = false;
    if (decrypted === null && !ours) {
      const share = sharesInboxStore.getByItemId(item.id);
      if (share?.contentKey) {
        decrypted = decryptWithContentKey(
          { nonce: item.content_nonce, ciphertext: item.encrypted_content },
          share.contentKey,
          item.id,
        );
        if (decrypted !== null) fromIncomingShare = true;
      }
    }
    if (decrypted === null) {
      decrypted = decryptNote({
        nonce: item.content_nonce,
        ciphertext: item.encrypted_content,
      });
    }
    const openedVia: 'vault' | 'share' = fromIncomingShare ? 'share' : 'vault';
    const parsed = JSON.parse(decrypted);

    return {
      id: item.id,
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
      ...receiveNotebookId(parsed.notebook_id, fromIncomingShare),
      hasAttachments: parsed.has_attachments || false,
      isShared: item.shared_by_me === true,
      sharedWithCount: typeof item.shared_with_count === 'number'
        ? item.shared_with_count
        : undefined,
      // Ownership follows the key that opened the note: our vault
      // opened it, so it is ours, whatever the row's user_id says; a share's
      // key opened it, so it is foreign.
      foreignOwner: openedVia === 'share',
      openedVia,
      extras: extrasFrom(parsed),
      version: item.version,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      deleted: item.deleted,
      wrappedContentKey: item.wrapped_content_key ?? null,
      wrappedContentKeyNonce: item.wrapped_content_key_nonce ?? null,
      contentKeyGeneration: item.content_key_generation ?? 1,
    };
  } catch (e) {
    console.warn('Failed to decrypt note:', item.id, e);
    return null;
  }
}

/**
 * Re-base the local copy of `id` on the server's current row.
 *
 * Called right after a version conflict has been forked into a conflict copy.
 * Without it the original keeps the STALE version it lost with, and the next
 * keystroke on it 409s and forks again — one conflict copy per edit, until a
 * sync pull happens to bring the row back. After a restore that pull never
 * comes (every device's cursor is ahead of the server), so the loop would run
 * forever. Fetching the row by id sidesteps the cursor entirely.
 *
 * The inbox copy of a shared note is re-based too, since that is where the
 * shared-note branch of updateNote reads its version from.
 */
async function adoptServerRow(id: string): Promise<boolean> {
  return (await adoptServerRowNote(id)) !== undefined;
}

/** Where the server has a note, from `adoptServerRowNote`'s answer, for a conflict copy (`forkConflictCopy`). */
function serverPlacement(adopted: { note: NoteItem | null } | undefined): { notebookId: string | null } | 'unread' | undefined {
  if (adopted === undefined) return 'unread';
  // Deleted there: filed as the card was.
  if (adopted.note === null) return undefined;
  return { notebookId: adopted.note.notebookId ?? null };
}

/**
 * As adoptServerRow, saying what it took: the note (null when the server has
 * it deleted) and the row's notebook column; undefined when it took nothing.
 */
async function adoptServerRowNote(id: string): Promise<{ note: NoteItem | null; rowNotebook: string | null } | undefined> {
  const r = await apiRequest<ServerItem>(`/api/v1/items/${id}`);
  if (!r.success || r.data.item_type !== 1) return undefined;
  const note = decryptServerItem(r.data, authStore.user()?.id ?? null);
  if (!note) return undefined;
  if (note.deleted) {
    setNotes(prev => prev.filter(n => n.id !== id));
    if (ownsSharedCache()) noteDb.removeNote(id);
    return { note: null, rowNotebook: null };
  }
  if (notes().some(n => n?.id === id)) {
    setNotes(prev => prev.map(n => n.id === id ? note : n));
    if (ownsSharedCache()) noteDb.putNote(note);
  }
  if (sharesInboxStore.getByItemId(id)) {
    sharesInboxStore.applyLocalEdit(id, note, note.updatedAt);
  }
  return { note, rowNotebook: r.data.notebook_id ?? null };
}

/**
 * A replayed create whose note is already on the server (409,
 * `item_already_exists`): take the server's row for it.
 *
 * ONLY a row that is this account's OWN note. The 409 and this read are both
 * the server's word. Taken on that word alone, any row served for the id
 * would end the create: the queue entry would go, and a note that may exist
 * nowhere but in this browser would be shown as synced. So the row has to
 * name this account as its owner AND open with our vault, as the note this
 * browser sent does. Anything else is not a landing: nothing is taken, the
 * entry stays, and the card goes on saying that it is waiting, which is all
 * that is known.
 *
 * @returns null when there is nothing to take (no answer just now, or a row
 *   that is not this account's own note, the one asked for, sealed as this
 *   build seals one); 'trashed' when the note has landed and was put in the
 *   trash since; otherwise the note as the server has it, the notebook its ROW
 *   names, and its content key. The caller wipes the key.
 */
async function adoptLandedCreate(
  id: string,
): Promise<{
  note: NoteItem; rowNotebook: string | null; contentKey: Uint8Array;
  /** The row's content as the server holds it, for a write that changes nothing of it. */
  sealed: { ciphertext: string; nonce: string };
} | 'trashed' | null> {
  const r = await apiRequest<ServerItem>(`/api/v1/items/${id}`);
  if (!r.success) return null;
  const row = r.data;
  const me = tryCanonicalAccountId(authStore.user()?.id);
  if (me === null || row.item_type !== 1 || tryCanonicalAccountId(row.user_id) !== me) return null;
  // The row that was ASKED for. Any own note opens with our vault: a
  // row with ANOTHER note's id would pass every check here, take this
  // card's place and end this note's create.
  if (typeof row.id !== 'string' || row.id.toLowerCase() !== id.toLowerCase()) return null;
  // And sealed FOR that id, under a key of its own: as this build seals every
  // note it sends. The older formats (no key of its own, or content that names
  // no item) are for reading old notes, and a note sent a moment ago is not one.
  const contentKey = row.wrapped_content_key && row.wrapped_content_key_nonce
    ? unwrapContentKeyWithVault(row.wrapped_content_key, row.wrapped_content_key_nonce)
    : null;
  if (!contentKey) return null;
  // A row the server names as ours never takes a share's key
  // (decryptServerItem): what opens here was opened by our vault.
  const note = opensBoundToItem({ nonce: row.content_nonce, ciphertext: row.encrypted_content }, contentKey, id)
    ? decryptServerItem(row, me)
    : null;
  if (!note || note.openedVia !== 'vault' || note.deleted) contentKey.fill(0);
  if (!note || note.openedVia !== 'vault') return null;
  if (note.deleted) {
    setNotes(prev => prev.filter(n => n.id !== id));
    if (ownsSharedCache()) noteDb.removeNote(id);
    return 'trashed';
  }
  if (notes().some(n => n?.id === id)) {
    setNotes(prev => prev.map(n => n.id === id ? note : n));
    if (ownsSharedCache()) noteDb.putNote(note);
  }
  return {
    note, rowNotebook: row.notebook_id ?? null, contentKey,
    sealed: { ciphertext: row.encrypted_content, nonce: row.content_nonce },
  };
}

/**
 * Pass a note in a shared notebook on to that notebook's people: one share
 * each, sealed with the note's own content key. A failure is recorded, not
 * just logged: the sidebar badge and the Share panel are how the owner learns
 * that someone stopped receiving. The note itself stays as it is.
 */
async function passOnToNotebook(
  noteId: string,
  notebookId: string,
  contentKey: Uint8Array,
  /**
   * The generation of `contentKey`, when the caller has it from the note's own
   * row. Without it the share reads the card in memory, and with no card there
   * signs for generation 1: a wrap its reader drops as forged whenever the
   * note's key has been changed since.
   */
  contentKeyGeneration?: number,
): Promise<void> {
  // Someone invited before they had an account, who has one now: their
  // invitation first, and the notebook with it (lib/finishInvitations).
  await finishInvitationsIn(notebookId);
  const recipients = await notebookNoteRecipients(notebookId);
  for (const r of recipients) {
    const outcome = await shareNoteWithRecipientResult(
      noteId, contentKey, r, contentKeyGeneration === undefined ? {} : { contentKeyGeneration });
    shareHealthStore.record(notebookId, r.email, outcome);
    if (outcome.ok) {
      forgetUnsent(noteId, r.email);
    } else {
      rememberUnsent(noteId, notebookId, r.email, outcome.reason);
      console.warn(`Auto-share of new note ${noteId} to ${r.email} failed (${outcome.reason})`);
    }
  }
  // "It is retried with the next note you add" (the Share panel): the notes
  // of this notebook that did not reach someone, sent again now.
  await resendUnsent(notebookId, noteId);
}

/** The most notes `resendUnsent` sends in one go. */
const RESEND_PER_GO = 20;

/**
 * The most notes one finish of an invitation shares: with the notebook's
 * own share, under the 30 a minute the server takes from an owner. The
 * rest are sent later, `RESEND_PER_GO` at a time.
 */
export const FINISH_NOTES_PER_GO = 25;

/** What a finish could not send at once is not sent again sooner (the server's limit is per rolling minute). */
const FINISH_LEFT_WAIT_MS = 60_000;

/**
 * Send again the notes that did not reach someone in a notebook
 * (lib/unsentShares). Each only while it stands: the note still in that
 * notebook, ours, not deleted, its key opening here, and the person still
 * among the notebook's people; what no longer stands is forgotten, and so
 * is a failure that will not pass (the Share panel shows it).
 * `notebookId`: that notebook's alone; `except`: a note just passed on.
 * At most RESEND_PER_GO shares a go. Never throws.
 */
async function resendUnsent(notebookId?: string, except?: string): Promise<void> {
  try {
    const now = Date.now();
    const due = unsentShares()
      .filter(e => (notebookId === undefined || e.notebookId === notebookId) && e.noteId !== except
        && (e.notBefore === undefined || e.notBefore <= now))
      .slice(0, RESEND_PER_GO);
    const peopleOf = new Map<string, Awaited<ReturnType<typeof notebookNoteRecipients>>>();
    for (const e of due) {
      const n = notes().find(x => x?.id === e.noteId);
      // Not landed yet: kept for the next go.
      if (n?.pendingSync) continue;
      // Where the note is NOW. Moved on to another notebook the person is in
      // too, it is sent there: the move gave it only to that notebook's people
      // who were not in the one it left, taking them to have it, so this entry
      // must not be forgotten.
      const where = n?.notebookId ?? null;
      if (!n || n.deleted || !where || openedWith(n) === 'share'
        || !n.wrappedContentKey || !n.wrappedContentKeyNonce) {
        forgetUnsent(e.noteId, e.email);
        continue;
      }
      let people = peopleOf.get(where);
      if (!people) {
        people = await notebookNoteRecipients(where);
        peopleOf.set(where, people);
      }
      const r = people.find(p => p.email.toLowerCase() === e.email.toLowerCase());
      if (!r) { forgetUnsent(e.noteId, e.email); continue; }
      // And as it stands right before the seal: the people are read once a go,
      // and someone the owner removed while it went on would otherwise be
      // sealed the rest of it, with nothing to take them back.
      const current = notes().find(x => x?.id === e.noteId);
      if (!current || current.deleted || current.notebookId !== where
        || !notebookPeopleOf(where).some(p => p.email.toLowerCase() === e.email.toLowerCase())) {
        forgetUnsent(e.noteId, e.email);
        continue;
      }
      const contentKey = unwrapContentKeyWithVault(n.wrappedContentKey, n.wrappedContentKeyNonce);
      if (!contentKey) { forgetUnsent(e.noteId, e.email); continue; }
      try {
        const outcome = await shareNoteWithRecipientResult(n.id, contentKey, r);
        shareHealthStore.record(where, r.email, outcome);
        if (outcome.ok || !RETRYABLE.has(outcome.reason)) forgetUnsent(e.noteId, e.email);
        // Still owed, now in the notebook the note is in.
        else if (where !== e.notebookId) rememberUnsent(e.noteId, where, e.email, outcome.reason);
      } finally {
        contentKey.fill(0);
      }
    }
  } catch (err) {
    console.warn('[note] could not send again the notes that did not reach someone', err);
  }
}

/** How far a row's time may be past the deletion's, by the two clocks, and still go (lib/notesToTakeBack). */
const TAKE_BACK_CLOCK_MARGIN_MS = 5 * 60_000;

/**
 * Take every person off a note: one key change with all its rows, or, when
 * that is not sent, each row revoked, as the notebook object's own removal
 * does (lib/notebookRemoval). `before`: only its rows made up to then (with
 * the clocks' margin), and none of someone who has the note now through the
 * notebook it is in. 'unread' when its rows could not be read even asked
 * again; a note the server no longer has for us (404) has nobody left on it.
 */
async function takeEveryoneOff(noteId: string, before?: string): Promise<'done' | 'unread'> {
  const r = await askTwice(() => apiRequest<{ id: string; recipient_email?: string | null; created_at?: string }[]>(`/api/v1/items/${noteId}/shares`));
  if (!r.success) return (r as { status?: number }).status === 404 ? 'done' : 'unread';
  if (!Array.isArray(r.data)) return 'unread';
  const until = before === undefined ? Infinity : Date.parse(before) + TAKE_BACK_CLOCK_MARGIN_MS;
  // A move or a share since, into a notebook someone is in too, re-uses their
  // row, and a row keeps the time it was first made (the server's upsert), so
  // it looks as old as the deletion: by time alone they would be taken off a
  // note they now have through its notebook.
  const staying = before === undefined ? new Set<string>() : peopleThroughItsNotebook(noteId);
  const shareIds = r.data
    .filter(s => !s.created_at || !(Date.parse(s.created_at) > until))
    .filter(s => !(s.recipient_email && staying.has(s.recipient_email.toLowerCase())))
    .map(s => s.id);
  if (shareIds.length === 0) return 'done';
  const rot = await rotateContentKey(noteId, shareIds);
  if (rot.rotated) return 'done';
  console.warn(`Rotation on notebook-delete unshare failed for ${noteId}; revoking without it`);
  for (const id of shareIds) {
    const gone = await apiRequest(`/api/v1/shares/${id}`, { method: 'DELETE' });
    if (!gone.success && gone.status !== 404) console.warn(`Notebook-delete unshare: share ${id} of ${noteId} was not revoked`);
  }
  return 'done';
}

/**
 * Who has a note through the notebook it is in now, by address in lower case
 * (`notebookPeopleOf`). Nobody through a notebook that is gone: the card may
 * name the deleted one itself until a pull says otherwise.
 */
function peopleThroughItsNotebook(noteId: string): Set<string> {
  const n = notes().find(x => x?.id === noteId);
  const where = n && !n.deleted ? (n.notebookId ?? null) : null;
  if (!where || !notebooksStore.notebooks().some(nb => nb.id === where)) return new Set();
  return new Set(notebookPeopleOf(where).map(p => p.email.toLowerCase()));
}

/** When `takeBackSoon` last went (ms). */
let takeBackLookedAt = 0;

/**
 * After a sync: take off the people a notebook's deletion could not take off
 * (lib/notesToTakeBack), at most once in ten minutes, not waited for.
 */
function takeBackSoon(): void {
  try {
    if (!ownsSharedCache() || !isCryptoReady()) return;
    if (Date.now() - takeBackLookedAt < FINISH_RETRY_MS) return;
    const due = notesToTakeBack();
    if (due.length === 0) return;
    takeBackLookedAt = Date.now();
    void (async () => {
      for (const e of due) {
        try {
          if (await takeEveryoneOff(e.noteId, e.before) === 'done') forgetTakeBack(e.noteId);
        } catch (err) {
          console.warn('[note] could not take people off a note of a deleted notebook', err);
        }
      }
    })();
  } catch (e) {
    console.warn('[note] could not look for notes to take people off', e);
  }
}

/** When `resendUnsentSoon` last went (ms). */
let unsentLookedAt = 0;

/**
 * After a sync: send again what did not reach someone (`resendUnsent`), at
 * most once in ten minutes, and not waited for: a notebook that gets no new
 * note is not left out.
 */
function resendUnsentSoon(): void {
  try {
    if (!ownsSharedCache() || !isCryptoReady()) return;
    if (Date.now() - unsentLookedAt < FINISH_RETRY_MS) return;
    if (unsentShares().length === 0) return;
    unsentLookedAt = Date.now();
    void resendUnsent();
  } catch (e) {
    console.warn('[note] could not look for notes to send again', e);
  }
}

/**
 * What is known about the notebook invitations this user holds, for
 * `awaitsInvitation` (lib/notebookInvites).
 *
 * Made on first use and kept for the page, not at load like the memos below:
 * it reads two other stores, and this module can finish loading before they do.
 */
/** A declined notebook's notes are held, except one the inbox still shares in its own
 *  right: the set of those, made only when something is declined at all. */
function declinedAnd(declined: ReadonlySet<string>): Pick<InvitationState, 'declined' | 'stillShared'> {
  if (declined.size === 0) return { declined };
  return { declined, stillShared: new Set(sharesInboxStore.sharedNotes().map(s => s.itemId)) };
}
/** Does the inbox, as last applied, say every notebook that is on offer? (See `inboxKnown` below.) */
function offersAreKnown(): boolean {
  return sharesInboxStore.offeredNotebooks() !== null || sharesInboxStore.listedNotebookIds() !== null;
}
/**
 * The invitations a block may DECLINE: on offer, not accepted, and never one
 * this DEVICE has seen accepted.
 *
 * `pending` goes by the list of acceptances, which is one encrypted document
 * shared by every device, and older clients may empty it after a single
 * failed request (lib/notebookInvites). The hold knows this: a notebook this
 * device has seen accepted holds nothing. A block must know it too, or a
 * block of its owner would DECLINE a notebook the reader is in, which lasts:
 * its notes would go, and every note added to it later would stay away.
 */
function unanswered(state: InvitationState): ReadonlySet<string> {
  const seen = state.seenAccepted;
  if (!seen || seen.size === 0) return state.pending;
  return new Set([...state.pending].filter(id => !seen.has(id)));
}
let invitationStateMemo: (() => InvitationState) | undefined;
function invitationState(): InvitationState {
  invitationStateMemo ??= createRoot(() => createMemo<InvitationState>(() => {
    const accepted = notebooksStore.acceptedNotebooks();
    return {
      // On offer: the invitations among the rows this page has read, and every
      // notebook the server says is on offer. The rows alone miss an
      // invitation whose own row lies past what was read.
      pending: pendingNotebookIds(
        [...sharesInboxStore.sharedNotebooks().map(s => s.itemId), ...(sharesInboxStore.offeredNotebooks() ?? [])],
        accepted,
      ),
      accepted: new Set(accepted),
      // Answered, or cannot be asked: a tab with no keys runs no sync, so its
      // inbox never answers, and the notes held until it does would stay
      // held for the whole page. Read from the auth store and not latched:
      // when the keys arrive the question is open again, the cold-start hold
      // is back, and the view syncs at once.
      //
      // "Answered" is an answer that says WHICH notebooks are on offer: the
      // server's own list, or an inbox read to its end, whose rows are all of
      // them. One that stopped early without the list (a server that does not
      // send it, or more notebooks on offer than it lists) names some
      // invitations and is silent about the rest, whose notes would be shown.
      // They are held as before the first answer.
      //
      // NO answer at all is not that: the server could not be reached. The
      // inbox is then empty and silent, and nothing is held on a guess, or an
      // offline session would never show these notes at all.
      inboxKnown: (sharesInboxStore.answered() && (offersAreKnown() || sharesInboxStore.gotNoAnswer()))
        || authStore.keysUnavailable() !== null,
      ...declinedAnd(sharesInboxStore.declinedNotebooks()),
      seenAccepted: new Set(notebooksStore.seenAcceptedNotebooks()),
    };
  }));
  return invitationStateMemo();
}

/**
 * The labels on the notes the reader's own lists can show: not deleted, and
 * not held for an invitation they have not accepted. A label only those notes
 * carry would be a chip that opens an empty grid, worded by whoever sent the
 * invitation.
 */
let shownLabelsMemo: (() => string[]) | undefined;
function shownLabels(): string[] {
  shownLabelsMemo ??= createRoot(() => createMemo(() => {
    const state = invitationState();
    const set = new Set<string>();
    for (const n of notes()) {
      if (n.deleted || awaitsInvitation(n, state)) continue;
      n.labels.forEach(l => set.add(l));
    }
    return [...set].sort();
  }));
  return shownLabelsMemo();
}

// Pinned first, then sortOrder, then newest. The comparator lives in
// lib/dropOrder.ts because a drop's whole job is to produce a sortOrder that
// lands the card somewhere specific UNDER THIS ORDER — and dropOrder.test.ts
// checks that by sorting with this same function rather than a copy of it.
const sortedActiveNotes = createMemo(() =>
  notes()
    .filter(n => !n.deleted && !n.isArchived)
    .sort(compareNoteOrder)
);

/**
 * The OWNER's standing recipients with the keys the directory publishes NOW.
 *
 * The standing list caches each recipient's key from when they were invited.
 * After a recipient's password reset that is a key they no longer hold:
 * sealed to it, every new note "shares" fine and none can be opened — and a
 * pin gate comparing the cached key with a pin taken from the same cache
 * could never notice. With the current key the gate in shareNoteWithRecipient
 * does its job: a match seals, a change is refused and recorded for the owner
 * to approve. A failed lookup keeps the cached keys.
 */
async function withCurrentDirectoryKeys<T extends FanOutRecipient>(recipients: T[]): Promise<T[]> {
  // Never for someone saved WITHOUT a key (invited before they had an
  // account): given one here, the next note would be sealed straight to
  // them, and they would have a note with no invitation to answer. Their
  // invitation is finished first, notebook and all (lib/finishInvitations).
  const refresh = recipients.filter(r => !isUnfinished(r));
  if (refresh.length === 0) return recipients;
  const dir = await lookupDirectoryKeys(refresh.map(r => r.email)).catch(() => null);
  if (!dir) return recipients;
  return recipients.map(r => {
    const current = isUnfinished(r) ? undefined : dir.get(r.email.toLowerCase());
    return current
      ? { ...r, publicKey: current.sharingPub, userId: current.userId, signingPublicKey: current.signingPub }
      : r;
  });
}

/** When each waiting invitation was last tried on this page (lib/finishInvitations). */
const invitationsTried: Tried = new Map();
/** When this page last looked for invitations to finish after a sync. */
let invitationsLookedAt = 0;

/** How an invitation is finished here: see lib/finishInvitations for the rule. */
const finishSteps: FinishSteps = {
  standing: (notebookId) => notebooksStore.getNotebookShares(notebookId),
  lookup: (emails) => lookupDirectoryKeys(emails),
  shareNotebook: async (notebookId, recipient, grant) => {
    // The notebook ITSELF, or nothing. One the server has no item for cannot
    // be shared as an object, and its notes are not sent without that here:
    // the Share panel still can, note by note.
    let item = await notebooksStore.notebookItemState(notebookId);
    if (item === 'unknown') item = await notebooksStore.notebookItemState(notebookId);
    if (item !== 'item') return false;
    return (await shareNotebookWithRecipientResult(notebookId, recipient, grant)) === 'shared';
  },
  shareNotes: async (notebookId, recipient, stillWaiting) => {
    const unsent: string[] = [];
    let tried = 0;
    let stopped = false;
    for (const n of notes()) {
      // Removed meanwhile: not one more note.
      if (!stillWaiting()) return unsent;
      // Our own notes in it that the server has: one still waiting to be
      // created is passed on when its create lands.
      if (n.deleted || n.pendingSync || n.notebookId !== notebookId || openedWith(n) === 'share') continue;
      if (!n.wrappedContentKey || !n.wrappedContentKeyNonce) continue;
      // A few at most, and none after one that did not go: the server takes
      // 30 shares a minute from an owner, and the rest would be refused too.
      // They go later, once the entry has its keys (`sendLater`).
      if (stopped || tried >= FINISH_NOTES_PER_GO) { unsent.push(n.id); continue; }
      const contentKey = unwrapContentKeyWithVault(n.wrappedContentKey, n.wrappedContentKeyNonce);
      if (!contentKey) continue;
      tried++;
      try {
        const outcome = await shareNoteWithRecipientResult(n.id, contentKey, recipient);
        shareHealthStore.record(notebookId, recipient.email, outcome);
        if (!outcome.ok) { unsent.push(n.id); stopped = true; }
      } finally {
        contentKey.fill(0);
      }
    }
    return unsent;
  },
  sendLater: (notebookId, email, noteIds) => {
    const now = Date.now();
    for (const id of noteIds) rememberUnsent(id, notebookId, email, 'failed', now, now + FINISH_LEFT_WAIT_MS);
  },
  saveStanding: (notebookId, recipient) => notebooksStore.finishNotebookShare(notebookId, recipient),
  serverStanding: (notebookId) => notebooksStore.serverStandingOf(notebookId),
  written: () => notebooksStore.whenWritten(),
  ownerShareSettled: (notebookId, email) => ownerSharesSettled(notebookId, email),
  takeBack: async (notebookId, email) => {
    try {
      // Their removal, run again over what the finish had done by then: off
      // the roster, the notebook taken back, each note revoked and re-keyed.
      // (Loaded when needed: that module reads this store.)
      const { removeNotebookMember } = await import('../lib/removeNotebookMember');
      await removeNotebookMember(notebookId, email);
    } catch (e) {
      console.warn('[note] could not take back an invitation finished for someone who was removed meanwhile', e);
    }
  },
  now: () => Date.now(),
};

/** Finish the invitations of this notebook whose people have an account now. Never throws. */
async function finishInvitationsIn(notebookId: string): Promise<void> {
  try {
    await finishWaitingIn(notebookId, finishSteps, invitationsTried);
  } catch (e) {
    console.warn('[note] could not finish an invitation', e);
  }
}

/**
 * After a sync: finish whatever invitation has been waiting for its reader to
 * sign up. Not waited for, and asked of the directory at most once in ten
 * minutes: it is the owner's page that finishes it, whenever it is next open,
 * and nobody is waiting on this second.
 */
function finishInvitationsSoon(): void {
  try {
    if (!ownsSharedCache() || !isCryptoReady()) return;
    if (Date.now() - invitationsLookedAt < FINISH_RETRY_MS) return;
    const waiting = anyWaiting(notebooksStore.notebooks().map(nb => nb.id), finishSteps.standing);
    // Nothing waits: nothing is asked, and the next sync looks again.
    if (waiting.length === 0) return;
    invitationsLookedAt = Date.now();
    void (async () => {
      for (const notebookId of waiting) await finishInvitationsIn(notebookId);
    })();
  } catch (e) {
    // Never the sync's failure: it has done its work.
    console.warn('[note] could not look for invitations to finish', e);
  }
}

/**
 * Everyone a new note in `notebookId` has to reach.
 *
 * Two different answers depending on who is adding it, which is the whole
 * reason this is not a one-liner:
 *
 *  - The OWNER has a standing recipient list in their metadata; that is what
 *    `notebookShares` is for.
 *  - A MEMBER has no such list. They have the roster inside the notebook item —
 *    which is exactly why the roster is shared rather than kept in the owner's
 *    metadata — plus the notebook's owner, who is NOT in the roster and whose
 *    key therefore has to be looked up. Without the owner, a member's note goes
 *    into someone's notebook that its owner cannot open.
 *
 * The owner comes from the inbox only for a notebook opened through an
 * accepted share. This browser reads a roster only through its vault, so a
 * roster here is OUR notebook's, whatever the inbox serves. Asking the inbox
 * anyway would let a served row naming an own notebook, with its metadata
 * withheld so the standing list above is empty, add an "owner" of the
 * server's choosing to every new note in it.
 */
/**
 * Does a note in this notebook go to anyone else? (Its standing share list, or
 * a roster.) Read from what the page holds: nothing is asked of the server.
 */
function notebookHasRecipients(notebookId: string): boolean {
  return notebooksStore.getNotebookShares(notebookId).length > 0
    || notebooksStore.membersOf(notebookId).length > 0;
}

async function notebookNoteRecipients(notebookId: string) {
  const standing = notebooksStore.getNotebookShares(notebookId);
  if (standing.length > 0) return withCurrentDirectoryKeys(standing);

  const roster = notebooksStore.membersOf(notebookId);
  if (roster.length === 0) return [];

  const inboxRow = notebooksStore.notebookOpenedVia(notebookId) === 'share'
    ? sharesInboxStore.getByItemId(notebookId)
    : undefined;
  const wanted = recipientsForNewNote({
    roster,
    // Null when the notebook is ours: there is nobody above us to include.
    ownerEmail: inboxRow?.sharerEmail ?? null,
    myEmail: authStore.user()?.email ?? null,
  });

  // A MEMBER seals to the keys in the roster — written by the owner inside the
  // notebook's own ciphertext, so a server cannot swap them the way it could
  // swap a directory answer. Only entries the roster lacks are looked up.
  const missing = needsKeyLookup(wanted);
  if (missing.length === 0) return wanted;

  const found = new Map<string, { sharingPub: string; userId: string | null; signingPub: string | null }>();
  try {
    const r = await apiRequest<{
      users: { email: string; user_id: string | null; sharing_public_key: string | null; signing_public_key: string | null }[];
    }>('/api/v1/users/public-keys', { method: 'POST', body: { emails: missing } });
    if (r.success) {
      for (const u of r.data.users) {
        if (u.sharing_public_key) {
          found.set(u.email.toLowerCase(), {
            sharingPub: u.sharing_public_key,
            userId: u.user_id,
            signingPub: u.signing_public_key,
          });
        }
      }
    }
  } catch {
    // Leave them unfound; withLookedUpKeys drops anyone we cannot seal to
    // rather than writing a share row the recipient could never open.
  }
  return withLookedUpKeys(wanted, found);
}

const syncOneAtATime = oneAtATime((run) => notesStore.syncOnce(run));

export const notesStore = {
  notes,
  syncing,
  cacheLoaded,
  draggedId,
  /** Ids the server sent that this client could not decrypt. Read by the
   *  backup so a file short of them can say so instead of implying it holds
   *  everything. */
  undecryptableIds,
  /** Our own notes whose key does not open here — the ones a password reset
   *  locks. Drives <LockedNotesNotice/> and keeps the onboarding line away. */
  lockedOwnIds,
  /** Notes whose last save was refused because their key does not open here.
   *  The editor reads it to say so instead of "Saving…" forever. */
  keyRefusedIds,
  /** True after a create was blocked by the free note cap. NotesView renders
   *  the upgrade prompt off this; call dismissNoteLimit() to clear it. */
  noteLimitReached,
  dismissNoteLimit() {
    setNoteLimitReached(false);
  },

  /**
   * Every note of notebook `notebookId` of this account's own, for a removal:
   * the trashed ones and the ones that don't open here included.
   * Null until this session has a full pull — after one, memory holds every
   * note that opens here, trashed ones too (by the payload's own notebook id),
   * and ownRowNotebooks every own row's server column (the ones that don't
   * open). Before one, the cache may lack the trash and a delta brings only
   * what changed, so nothing is answered and a full pull is asked for.
   */
  notebookNoteIds(notebookId: string): string[] | null {
    const account = authStore.user()?.id ?? null;
    if (!notebooksStore.hasPulled(true) || ownRowNotebooks.account !== account) {
      notesStore.requestFullPull();
      return null;
    }
    const ids = new Set(notes().filter(n => n && n.notebookId === notebookId).map(n => n.id));
    for (const [id, nb] of ownRowNotebooks.byNote) if (nb === notebookId) ids.add(id);
    return [...ids];
  },

  /** Have the next sync pull every row (see notebookNoteIds), and start one.
   *  Asked again while that is wanted, nothing more starts: the flag stands
   *  until a full pull lands, and every sync after a failed one honours it. */
  requestFullPull() {
    if (fullPullWanted) return;
    fullPullWanted = true;
    void notesStore.sync();
  },

  /**
   * Load previously-cached notes from IndexedDB before the first network
   * sync. Call this once at app boot. Safe to call multiple times — idempotent.
   */
  async hydrateFromCache() {
    if (cacheLoaded()) return;
    const [cached, cursor, cursorId] = await Promise.all([
      noteDb.loadNotes(),
      noteDb.loadCursor(),
      noteDb.loadCursorId(),
    ]);
    if (cached.length > 0) setNotes(cached);
    if (cursor) setLastSync(cursor);
    if (cursorId) setLastSyncId(cursorId);
    setCacheLoaded(true);
  },

  /**
   * Replay any edits that were queued while offline.
   *
   * Re-entrancy guarded. This is hung off every sync trigger (regaining
   * the network, a push tickle, the tab becoming visible) as well as onMount,
   * and several of those fire together — a phone waking up does all of them at
   * once. Two overlapping passes would both read the same pending row and both
   * POST it under the same client-supplied id; the second gets a 409, which is
   * not a retryable status, so the entry would never be dropped and the note
   * would be stuck in the queue for good.
   */
  async flushPending() {
    // A call while a drain is under way waits for THAT drain. Returning at
    // once would let the sign-out's own flush (NotesView, the dialog's
    // "sends what is waiting first") sign out and wipe the queue while the
    // drain still had what it owed to send. Never a second pass alongside.
    if (flushing) return flushing;
    let ended!: () => void;
    flushing = new Promise<void>(resolve => { ended = resolve; });
    try {
      await drainPending();
    } finally {
      flushing = null;
      ended();
    }
  },

  /**
   * Drain the offline queue and say how much is LEFT. The Android shell calls
   * this (via window.__pingolinFlushPending) immediately before a sign-out or
   * account-switch wipe: the wipe destroys this document and its IndexedDB,
   * and this is what makes the logout dialog's promise — "Any unsynced
   * changes will be uploaded first" — true for this page's queue, not only
   * for the NATIVE store. A non-zero return is the shell's signal that edits
   * are about to burn.
   */
  /** How many changes are waiting to sync; throws when that cannot be read (noteDb.countPending). */
  waitingCount(): Promise<number> {
    return noteDb.countPending();
  },

  async flushPendingAndReport(): Promise<number> {
    await notesStore.flushPending();
    // Throws when the queue cannot be read: "could not tell" is never "0 left"
    // (noteDb.countPending). The shell warns on a failure as on a count.
    return noteDb.countPending();
  },

  activeNotes: createMemo(() => dragPreview() || sortedActiveNotes()),

  /** All unique labels across the notes the reader's lists can show (see shownLabels). */
  allLabels: (): string[] => shownLabels(),

  /**
   * A note that came with a notebook invitation its reader has not accepted:
   * kept out of their own lists until they do (lib/notebookInvites).
   */
  heldForInvitation: (n: NoteItem): boolean => awaitsInvitation(n, invitationState()),

  /**
   * The notebooks a block of `address` declines beside dismissing what that
   * person shared: their invitations not answered here (lib/notebookInvites
   * `unansweredFrom`). For `sharesInboxStore.blockSender`.
   */
  unansweredNotebooksFrom: (address: string): string[] =>
    unansweredFrom(address, unanswered(invitationState()), sharesInboxStore.sharedNotebooks()),

  /** All unique notebook IDs */
  allNotebooks: createMemo(() => {
    const set = new Set<string>();
    notes().filter(n => !n.deleted && n.notebookId).forEach(n => set.add(n.notebookId!));
    return [...set];
  }),

  archivedNotes: createMemo(() =>
    notes().filter(n => !n.deleted && n.isArchived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  ),

  trashNotes: createMemo(() =>
    notes().filter(n => n.deleted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  ),

  /**
   * Sync, one at a time (lib/oneAtATime): asked while a sync is running, this
   * waits for ONE follow-up that starts when it ends, however many ask. The
   * promise settles with a sync that started at or after the call, so what the
   * caller wrote before asking is in it.
   */
  sync(): Promise<void> {
    return syncOneAtATime();
  },

  /** One sync, started now whatever else is running. For `sync` alone to call. */
  /**
   * @param run  this run as lib/oneAtATime sees it. `run.alive()` says that
   *   something came back from the server (a run that says nothing for a
   *   minute is given up on). `run.inCharge()` is false once that happened:
   *   the run applies nothing more then, because what it holds was read long
   *   ago.
   */
  async syncOnce(run: RunControl = { inCharge: () => true, alive: () => {} }) {
    if (!isCryptoReady()) return;
    setSyncing(true);
    const inCharge = run.inCharge;

    try {
      // Refresh the inbox first so any newly-arrived shares expose their
      // unwrapped content keys before the main sync loop tries to decrypt
      // the corresponding items. This is what makes "Alice added a note
      // to a shared notebook" reach Bob on his next refresh without
      // manual intervention. `inboxFresh` records whether the AUTHORITATIVE
      // list was applied — the revoked-share eviction below must never run
      // against a transiently-empty inbox.
      // STARTED TOGETHER, awaited separately. The inbox refresh and the
      // previous-identity fetch have no data dependency on each other, and each
      // is a full round trip that gates the sync loop below (around 300ms each
      // on a mid-range phone), so running them in series would spend a whole
      // extra round trip before the first page is even asked for. Both are
      // still fully resolved before the loop, so nothing downstream changes.
      // Each page of the inbox that arrives is a sign of life: a long inbox is
      // twenty requests, and none of them is the run being stuck.
      const inboxLoad = sharesInboxStore.load(run.alive).catch(() => false);
      const identitiesReady = ensurePreviousIdentities('/api/v1').catch(() => {});

      const inboxFresh = await inboxLoad;
      const myUserId = authStore.user()?.id ?? null;
      hydrateLockedOwn(myUserId);
      if (ownRowNotebooks.account !== myUserId) ownRowNotebooks = { account: myUserId, byNote: new Map() };
      if (rowsNoKeyOpens.account !== myUserId) rowsNoKeyOpens = { account: myUserId, byId: new Map() };

      // Forget acceptances whose notebook is no longer shared with us — the
      // owner removed us, or deleted it. Left behind, a later re-invitation to
      // the same notebook would arrive already accepted and never ask.
      //
      // Only against the AUTHORITATIVE list. A refresh that fails empties the
      // inbox, and pruning against that would forget EVERY acceptance, on every
      // device: one failed request would put each shared notebook back to
      // "new", and since its notes are held until the reader accepts again
      // (heldForInvitation), it would take them off the screen too.
      //
      // And against every notebook the list NAMES, not the rows this page could
      // open (`sharedNotebooks()`): a sender's key change blocks their rows
      // until the reader approves it, the refresh still succeeds, and pruning
      // against the opened rows would strike the acceptance on every device.
      const listed = inboxFresh ? sharesInboxStore.listedNotebookIds() : null;
      // What this device has seen accepted: brought up to date at every sync,
      // and made to forget only by a list (lib/notebookInvites).
      notebooksStore.rememberAcceptances(listed);
      if (listed !== null) {
        void notebooksStore.pruneAcceptances(listed).catch(() => { /* retried on the next sync */ });
      }

      let since = lastSync() || '1970-01-01T00:00:00Z';
      let cursor = since;
      // Tie-breaker paired with `cursor`. Null on a first sync (or an
      // upgraded client that persisted a cursor before this field existed)
      // → we omit since_id and the backend falls back to `updated_at > since`.
      let cursorId = lastSyncId();
      let hasMore = true;
      let syncFailed = false;

      // Make any RECOVERED pre-reset identity available before decrypting what
      // comes back. note's vault key is derived from the account keypair, so an
      // email password reset makes EVERY older note unreadable — without this
      // the sync succeeds and the notes arrive as undecryptable rows. Kicked
      // off above alongside the inbox; this is where it must have landed.
      const identities = (await identitiesReady) ?? 0;
      run.alive();

      // A pre-reset identity recovered since the last full pull may open notes
      // that failed before — and the incremental pull will never return them
      // again, because they have not changed. Pull everything once, so they
      // come back readable (and leave the locked set) instead of staying
      // missing until the next sign-in.
      const repullForRecovery = identities > previousIdentitiesSeen() && lockedOwnIds().size > 0;
      // Once per account: a full pull opens every row again, so each
      // gets openedVia from the key that opened it, not from an old stamp.
      const repullForOpenedVia = myUserId !== null && openedViaPulledFor !== myUserId
        && scopedGetItem(OPENED_VIA_PULLED_KEY) === null;
      // A removal's note list needs every row, the trash included, which an
      // incremental pull over the cache can't give: the cache drops a trashed
      // note (noteDb.removeNote below) and memory starts from the cache.
      if (repullForRecovery || repullForOpenedVia || fullPullWanted) {
        since = '1970-01-01T00:00:00Z';
        cursor = since;
        cursorId = null;
      }

      // The notebooks store adopts the metadata row from these pages: the holds
      // from the re-key jobs have to be in place first.
      await notebooksStore.whenHoldsReady();
      run.alive();
      while (hasMore) {
        let url = `/api/v1/sync/pull?since=${encodeURIComponent(cursor)}&limit=100`;
        if (cursorId) url += `&since_id=${encodeURIComponent(cursorId)}`;
        // A page is a hundred notes: each piece of it that arrives is a sign
        // of life, so a large page on a slow link is not taken for a stuck run.
        const result = await apiRequest<SyncResponse>(url, { onProgress: run.alive });
        run.alive();
        // A run that was given up on stops here, before this page is merged:
        // the merge below takes each row as the server's latest, and a page
        // that stalled for a minute would put older rows back over the ones
        // the newer run has written.
        if (!inCharge()) return;
        if (!result.success) { syncFailed = true; break; }

        const { items: serverItems, cursor: nextCursor, cursor_id: nextCursorId, has_more, share_counts } = result.data;

        // Pass metadata items (item_type=10) to notebooks store
        notebooksStore.loadFromSyncedItems(serverItems);

        // Decrypt the whole page, then merge into the notes signal in a
        // single O(N + page) pass below (see the Map merge after the loop).
        const decryptedNotes: NoteItem[] = [];
        // Written in ONE IndexedDB transaction after the loop. putNote opens a
        // transaction per call, so a 100-item sync page would cost 100 of them;
        // putNotes writes the whole page in one, several times faster.
        const toPersist: NoteItem[] = [];
        const cardsById = new Map(notes().filter((n): n is NoteItem => !!n).map(n => [n.id, n]));
        for (const item of serverItems) {
          // Only item_type=1 are notes. Skip metadata (10, handled by
          // notebooksStore above) and notebook/label items (2/3) — the latter
          // come from Android, which stores notebooks as their own items;
          // without this they'd surface here as phantom "notes".
          if (item.item_type !== 1) continue;
          if (myUserId && tryCanonicalAccountId(item.user_id) === myUserId) {
            ownRowNotebooks.byNote.set(item.id, item.notebook_id ?? null);
          }

          const note = decryptServerItem(item, myUserId);
          if (!note) {
            // Remember it. Skipping is correct — there is nothing to render —
            // but silence is not: the backup is built from this store, so an
            // unreadable note would otherwise vanish from a file that calls
            // itself complete. A deleted row is not a failure; it has no
            // content left to open.
            if (!item.deleted) {
              // A page older than this page's copy, which opens: the
              // row it carries was replaced since (a rescue). Nothing
              // to mark: recording the old row from a late pull page
              // would make the note read as locked again.
              const kept = notes().find(n => n?.id === item.id);
              if (kept && kept.version > item.version && kept.wrappedContentKey && kept.wrappedContentKeyNonce
                && vaultKeyThatOpens(kept.wrappedContentKey, kept.wrappedContentKeyNonce) !== null) continue;
              setUndecryptableIds((prev) => withId(prev, item.id));
              // Ours, as the row says — not a note shared with us, whose key is
              // its owner's to re-send. Unknown self = not counted.
              if (myUserId && tryCanonicalAccountId(item.user_id) === myUserId) {
                setLockedOwnIds((prev) => withId(prev, item.id));
                // What the server holds of it: a copy this browser kept may be
                // re-saved from (notesStore.rescueFromCopies).
                rowsNoKeyOpens.byId.set(item.id, {
                  version: item.version,
                  wrappedKey: item.wrapped_content_key ?? null,
                  wrappedKeyNonce: item.wrapped_content_key_nonce ?? null,
                });
              }
            } else {
              // Deleted since: nothing left to unlock or to count.
              setUndecryptableIds((prev) => withoutId(prev, item.id));
              setLockedOwnIds((prev) => withoutId(prev, item.id));
              rowsNoKeyOpens.byId.delete(item.id);
            }
            continue;
          }
          rowsNoKeyOpens.byId.delete(note.id);
          // It opened this time — an earlier failure may have been a key that
          // has since arrived (ensurePreviousIdentities runs before this loop).
          if (undecryptableIds().has(note.id)) {
            setUndecryptableIds((prev) => withoutId(prev, note.id));
          }
          if (lockedOwnIds().has(note.id)) {
            setLockedOwnIds((prev) => withoutId(prev, note.id));
          }
          // A move made here, still owed its sharing, stays remembered
          // through a pull that brings the note where the move put it:
          // laid over the card, the server's row would take the record
          // with it, and the people the note was moved away from would be
          // taken off nothing.
          const before = cardsById.get(note.id);
          const pulled = before?.movedFrom !== undefined && !note.deleted && !sameNotebook(note.notebookId ?? null, before.movedFrom)
            ? {
              ...note,
              movedFrom: before.movedFrom,
              // And who it still owes taking off, with it.
              ...(before.movedFromPeople !== undefined ? { movedFromPeople: before.movedFromPeople } : {}),
            }
            : note;
          decryptedNotes.push(pulled);
          // Deletions are rare and go straight through; the writes are
          // batched below.
          if (pulled.deleted) noteDb.removeNote(pulled.id);
          else toPersist.push(pulled);
        }

        // Merge the whole page in one pass: seed a Map from the current
        // notes (preserving order), then set/overwrite by id. Map keeps
        // insertion order, so existing notes stay in place (updated) and
        // new ones append at the end — the same result as a per-item
        // findIndex + array-clone, but O(N + page) not O(N²).
        if (toPersist.length > 0) noteDb.putNotes(toPersist);

        if (decryptedNotes.length > 0) {
          setNotes(prev => {
            const byId = new Map<string, NoteItem>();
            for (const n of prev) if (n) byId.set(n.id, n);
            for (const n of decryptedNotes) byId.set(n.id, n);
            return Array.from(byId.values());
          });
        }

        // Apply the side channel BEFORE hasMore, so it lands even on the last
        // page of a multi-page sync. Only ids we hold: a count for a note this
        // device cannot decrypt has nothing to attach to. An ABSENT map means
        // "no information" — leave every count alone — while a present map that
        // omits an id means that id is shared with nobody, so it goes to 0.
        if (share_counts) {
          setNotes(prev => {
            let touched = false;
            const next = prev.map(n => {
              const want = share_counts[n.id] ?? 0;
              // `isShared` moves with it. It is the server's `shared_by_me` and
              // rides the same item row, so removing the LAST recipient on
              // another device would otherwise leave this one showing a bare
              // "Sharing" badge — the count correctly 0, the badge still there.
              const shared = want > 0;
              if (n.sharedWithCount === want && n.isShared === shared) return n;
              touched = true;
              return { ...n, sharedWithCount: want, isShared: shared };
            });
            return touched ? next : prev;
          });
        }

        hasMore = has_more;
        // cursor and cursor_id move in lockstep: the backend derives both
        // from the same last item, so both are null together (empty/fast-path
        // page) or both advance together. Keep the prior pair when null.
        cursor = nextCursor || cursor;
        cursorId = nextCursorId ?? cursorId;
      }

      // Collect editor-mode pins for notes that no longer exist, so the map in
      // the metadata blob can't grow without bound.
      //
      // GUARDED HARD, because the failure is silent data loss: `notes()` is
      // the merged local set, and treating an INCOMPLETE one as the whole
      // truth would delete pins for notes that are merely not here yet. So
      // only after a run that reached the last page without erroring, and
      // never against an empty set — which is what a fresh device looks like
      // before its first page lands, and would otherwise wipe every pin the
      // user has.
      if (!syncFailed && notes().length > 0) {
        notebooksStore.gcEditorModes(notes().map(n => n.id));
      }

      // Same completeness rule as gcEditorModes above, for the same reason: a
      // FULL pull that reached its last page is the only run after which the
      // notebook-item map describes the whole account instead of one delta.
      // Only then can backfillNotebookItems tell a metadata-only notebook from
      // one whose item merely wasn't in the pages we fetched — and getting that
      // wrong is a doomed create per notebook on every single launch.
      // Only ever RAISED: a transient failure to fetch the identities reads as
      // 0, and lowering the mark on it would trigger another full re-pull the
      // next time the fetch works.
      if (!syncFailed && identities > previousIdentitiesSeen() && ownsSharedCache()) {
        try { scopedSetItem(PREV_IDENTITIES_SEEN_KEY, String(identities)); } catch { /* next load re-pulls */ }
      }
      // A finished pull, full or not: the notebooks store may now build a write
      // it held back for want of a merge base.
      if (!syncFailed) notebooksStore.markPulled();
      if (!syncFailed && since === '1970-01-01T00:00:00Z') {
        notebooksStore.markNotebookItemsComplete();
        // Every page read, none failed: memory holds every note of this
        // account's that opens here, trashed ones with them (a pull has no
        // `deleted` filter), and ownRowNotebooks every own row
        // (notebookNoteIds).
        fullPullWanted = false;
        notebooksStore.markFullyPulled();
        // Every row of this account's was just opened again. Marked only
        // after a pull that reached its last page, and stored only while this
        // tab owns the cache it wrote those rows to.
        openedViaPulledFor = myUserId;
        if (ownsSharedCache()) {
          try { scopedSetItem(OPENED_VIA_PULLED_KEY, '1'); } catch { /* the next load pulls in full again */ }
        }
      }

      // Revoked-share eviction. The owner unsharing deletes the share
      // row, after which /sync/pull can never return the item to us
      // again — no tombstone can flow. The authoritative inbox is the
      // only truth: a FOREIGN note with no inbox row was revoked, and
      // keeping the local copy shows the recipient a note the owner
      // withdrew. Guards, in order: the inbox list must be fresh (not a
      // transient failure emptied to []), the sync must have completed
      // (a half-merged set is not the truth), and only notes POSITIVELY
      // stamped foreign are touched — unknown provenance is never
      // evicted. Also re-stamp foreign on anything the fresh inbox
      // currently lists, so pre-flag cached copies become evictable the
      // moment their share is later revoked.
      if (inboxFresh && !syncFailed) {
        const restamp = notes().filter(
          n => n.foreignOwner !== true && sharesInboxStore.getByItemId(n.id) && openedWith(n) !== 'vault',
        );
        if (restamp.length > 0) {
          setNotes(prev => prev.map(
            n => restamp.some(r => r.id === n.id) ? { ...n, foreignOwner: true } : n,
          ));
          noteDb.putNotes(restamp.map(n => ({ ...n, foreignOwner: true })));
        }
        const evicted = notes().filter(
          n => n.foreignOwner === true && !sharesInboxStore.getByItemId(n.id) && openedWith(n) !== 'vault',
        );
        if (evicted.length > 0) {
          const ids = new Set(evicted.map(n => n.id));
          setNotes(prev => prev.filter(n => !ids.has(n.id)));
          for (const id of ids) noteDb.removeNote(id);
        }
      }

      // Our own CACHED notes whose wrap no key we hold opens. The incremental
      // pull above never returns a note that has not changed, so on a browser
      // that already held an account's notes when its password was reset this
      // is the only way to find the ones the reset locked (see lockedOwnIds).
      // Once per load, after a completed pull — by then any recovered pre-reset
      // identity has been loaded (ensurePreviousIdentities, above), and later
      // failures are caught row by row in the loop.
      if (!syncFailed && !lockedCacheChecked) {
        lockedCacheChecked = true;
        // Who on our shared notebooks' standing lists has a key that no longer
        // matches the one pinned here — the badge must not wait for the next
        // note to be added to find out. Background; never blocks the sync.
        void shareHealthStore.refresh().catch(() => {});
        const fromCache = lockedOwnFromCache(
          notes(),
          (key, nonce) => {
            const ck = unwrapContentKeyWithVault(key, nonce);
            if (!ck) return false;
            ck.fill(0);
            return true;
          },
          (id) => sharesInboxStore.getByItemId(id) !== undefined,
        );
        const cachedIds = new Set(notes().map(n => n.id));
        setLockedOwnIds((prev) => {
          // The cache check is authoritative for notes we hold a copy of; a row
          // the loop failed to open that has no cached copy stays counted.
          const next = new Set<string>();
          for (const id of prev) if (!cachedIds.has(id)) next.add(id);
          for (const id of fromCache) next.add(id);
          return next.size === prev.size && [...next].every(id => prev.has(id)) ? prev : next;
        });
      }

      // Nor does it move the cursor: its own is behind the newer run's.
      if (!inCharge()) return;
      setLastSync(cursor);
      setLastSyncId(cursorId);
      // Persist the cursor into the SHARED META store only if this tab still
      // owns the cache. A stale post-account-switch tab pulls account B's rows
      // under B's cookie; letting it advance the shared cursor would corrupt
      // B's sync watermark (the in-memory cursor above stays per-tab and is
      // harmless).
      if (ownsSharedCache()) {
        noteDb.saveCursor(cursor);
        noteDb.saveCursorId(cursorId);
      }
      // The sync is done. Someone invited before they had an account may have
      // one now (lib/finishInvitations), and a note that did not reach someone
      // is sent again (lib/unsentShares); neither is waited for.
      if (inCharge()) { finishInvitationsSoon(); resendUnsentSoon(); takeBackSoon(); }
    } finally {
      // Not by a run that was given up on: the run in charge is still syncing,
      // and its spinner is not this one's to take down.
      if (inCharge()) setSyncing(false);
    }
  },

  async createNote(content: Partial<NoteItem>, existingId?: string): Promise<CreateResult> {
    if (!isCryptoReady()) return { note: null, queued: false, locked: true };

    // Give new notes a negative sortOrder so they appear at the top
    const minSort = Math.min(0, ...notes().filter(n => !n.deleted && !n.isArchived).map(n => n.sortOrder || 0));

    const noteContent = {
      title: content.title || '',
      body: content.body || '',
      note_type: content.noteType || 'text',
      color: content.color || null,
      is_pinned: content.isPinned || false,
      is_archived: false,
      labels: content.labels || [],
      checklist_items: content.checklistItems || null,
      sort_order: minSort - 1,
      edit_mode: content.editMode || 'rich',
      notebook_id: content.notebookId || null,
      has_attachments: content.hasAttachments || false,
    };

    // Generate a per-note content key, encrypt the note body with it, and
    // wrap the content key with the vault key so the owner can decrypt
    // across devices. The wrapped key travels with the item; recipients
    // get their own wrapping through their share rows.
    // Client-generate the item id (mirrors note-android's UUID.randomUUID())
    // so the content AAD can bind to it: the server accepts a client-supplied
    // id and echoes it back as result.data.id.
    // A queued-then-replayed create reuses its original id (existingId) so a
    // re-flush overwrites the same pending entry instead of duplicating it.
    const itemId = existingId ?? crypto.randomUUID();
    const contentKey = generateContentKey();
    const encrypted = encryptWithContentKey(JSON.stringify(noteContent), contentKey, itemId);
    const wrapped = wrapContentKeyWithVault(contentKey);

    // LOCAL-FIRST durability: the create is on disk BEFORE the network is
    // asked. A queue write made only AFTER a failed attempt would lose the
    // note entirely to a process death mid-POST (Android LMK killing the
    // backgrounded WebView is the common case). The entry is removed once
    // the server confirms (or on a hard denial that will never retry); a
    // transient failure or a crash leaves it for the next drain.
    const preQueued = ownsSharedCache();
    let keepEntry = false;
    /** The note as the server has it, once this create is known to be there. */
    let onServer: NoteItem | null = null;
    /**
     * The changes the entry carried, when they are NOT to be sent after this
     * create: kept as a note of their own, or nothing (`afterLanding`).
     */
    let dealtWith: Partial<NoteItem> | null | undefined;
    if (preQueued) {
      savingNotes.add(itemId);
      // Not for a REPLAY: its entry is the one being replayed, and it may
      // carry what was changed on the card since (`edits`), which a fresh
      // entry would not.
      if (existingId === undefined) {
        await noteDb.queuePending({
          id: itemId,
          note: { ...content, id: itemId } as NoteItem,
          op: 'create',
          queuedAt: new Date().toISOString(),
        });
      }
    }
    /**
     * Not sent now, kept for the next drain: the create stays in the queue and
     * the note is shown as waiting. For a tab that cannot own the queue it is a
     * hard failure instead, so that the composer keeps the text.
     */
    const waitForReplay = (): CreateResult => {
      if (!ownsSharedCache()) return { note: null, queued: false };
      // The entry was pre-written (local-first) — just keep it.
      keepEntry = true;
      // Show it. The queue alone kept the note safe but invisible: the
      // composer cleared and the grid never gained a row, so writing a
      // note offline looked exactly like losing one. A replay reuses this
      // id, so the landing create replaces this row rather than adding a
      // second (see the dedupe in the success branch).
      //
      // Not written on a replay (existingId set) — the row is already
      // there, and re-prepending it would move a note the user is looking
      // at.
      if (shouldShowQueued(existingId !== undefined)) {
        const optimistic = localNote(itemId, noteContent, wrapped, { pendingSync: true });
        setNotes(prev => placeNote(prev, optimistic));
        noteDb.putNote(optimistic);
      }
      return { note: null, queued: true };
    };
    const run = async (): Promise<CreateResult> => {
      // Does the notebook exist as an item on the server? Asked when this
      // page's syncs have not said (`notebookItemState`), and asked once more
      // when the first try got no answer: a blip is not worth a queued note.
      let notebookItem = await notebooksStore.notebookItemState(content.notebookId);
      if (notebookItem === 'unknown') notebookItem = await notebooksStore.notebookItemState(content.notebookId);
      // No answer, and the notebook is shared with people. Sent now, the note
      // would go up WITHOUT its notebook, be passed on to those people below,
      // and reach a reader who DECLINED the notebook, live and with a push:
      // the server keeps a declined notebook's notes away by the notebook on
      // the note's row, and this row would name none. So it waits, like any
      // create the server could not take. A notebook that goes to nobody is
      // saved at once, without its notebook on the row; the next save names it.
      if (notebookItem === 'unknown' && content.notebookId && notebookHasRecipients(content.notebookId)) {
        return waitForReplay();
      }
      const post = (notebookId: string | null) => apiRequest<ServerItem>('/api/v1/items', {
        method: 'POST',
        body: {
          id: itemId,
          item_type: 1,
          encrypted_content: encrypted.ciphertext,
          content_nonce: encrypted.nonce,
          wrapped_content_key: wrapped.wrappedKey,
          wrapped_content_key_nonce: wrapped.nonce,
          // Server-visible grouping. The name stays encrypted; this is an
          // opaque id, and it is what lets the server enforce who may add
          // notes to a notebook rather than trusting the client to police
          // it.
          //
          // ⚠️ ONLY when the notebook exists as an item. The server's
          // notebook column must reference an existing item, so naming a
          // metadata-only notebook makes the whole create fail with a 500 —
          // note creation, the app's core action, fails. Until the notebook
          // backfill has minted the item, the grouping simply is not
          // recorded.
          //
          // The server is ASKED when this page's syncs have not said
          // (`notebookItemState`): after a reload they are a delta, an
          // untouched notebook is not in it, and the note would go up
          // without its notebook.
          notebook_id: notebookId,
        },
      });
      const notebookIdForServer = notebookItem === 'item' ? (content.notebookId ?? null) : null;
      let result = await post(notebookIdForServer);
      // The server will not have this note IN that notebook: the writer may
      // read the notebook and not add to it (a 403, and only a note that names
      // a notebook can get one here). The note is still theirs. It is saved
      // without the notebook on its row and passed on to NOBODY: what the
      // server refused to place must not reach the notebook's people by the
      // fan-out below instead. Left as a refusal, a note written offline would
      // be shown as saved and then dropped at its replay.
      let placementRefused = false;
      if (!result.success && result.status === 403 && notebookIdForServer !== null) {
        placementRefused = true;
        result = await post(null);
      }

      if (!result.success) {
        // The browser's session is another account's now: this tab is wiping
        // and reloading. The create stays queued for its own account, and
        // nothing else is sent or forked.
        if (isAccountStop(result)) {
          keepEntry = true;
          return { note: null, queued: false };
        }
        // A REPLAY that finds its note already on the server (409,
        // item_already_exists). The first attempt's answer was lost after the
        // server had taken the note (the request's time limit), and this is
        // that note again, under the same id and from the same account: it has
        // LANDED. The row here takes the server's (its version above all: the
        // waiting row has none, and its next edit would be refused as a
        // conflict), and the queue entry goes.
        //
        // Kept, like the refusals below, it would be sent again at every drain
        // for good: the count of unsent changes would never reach 0, and the
        // Android app would warn about unsynced changes at every sign-out.
        if (existingId !== undefined && result.status === 409 && result.error_code === 'item_already_exists') {
          const landed = await adoptLandedCreate(itemId);
          // Nothing to take: no row just now, or one that is not this
          // account's own note. The entry stays, the next drain asks
          // again, and the card goes on saying that it is waiting.
          if (landed === null) {
            if (ownsSharedCache()) keepEntry = true;
            return { note: null, queued: false };
          }
          if (landed === 'trashed') {
            // Deleted somewhere else since it landed, and CHANGED here
            // while it waited: the text written here is kept as a note
            // of its own, as an edit of a note deleted elsewhere is.
            // Without it the text would go with the entry.
            //
            // Never for a note that was deleted HERE: that is the
            // person's own word about this text, and a copy would bring
            // the note back as "(conflict copy)", to its notebook's
            // people too. A delete made here takes the entry with it
            // (`deleteNote`); this is for the one made while this very
            // replay was on its way.
            const entry = preQueued && !deletedWhileSaving.has(itemId) ? await noteDb.getPending(itemId) : null;
            if (entry?.op === 'create' && carriesText(entry.edits)) {
              const kept = await forkConflictCopy(entry.note, {}, true);
              if (!kept) keepEntry = true;
            }
            return { note: null, queued: false };
          }
          onServer = landed.note;
          // The card is the server's row now. What was changed on it while
          // the create waited is put back on it and sent when this create
          // has ended (below), unless that would replace what somebody
          // wrote on the row since it landed: then the card's note is kept
          // as a note of its own, and the row stays as it is
          // (`afterLanding`).
          const entry = preQueued ? await noteDb.getPending(itemId) : null;
          const carried = entry?.op === 'create' && hasEdits(entry.edits) ? entry : null;
          const verdict = afterLanding(carried, landed.note, landed.note.version);
          if (carried && verdict !== 'send') {
            if (verdict === 'keep-as-copy') {
              const kept = await forkConflictCopy(carried.note, {}, true);
              if (!kept) {
                // Not just now (the copy could not be made): the entry stays,
                // and the next drain comes back here.
                landed.contentKey.fill(0);
                onServer = null;
                keepEntry = true;
                return { note: null, queued: false };
              }
            }
            dealtWith = carried.edits ?? null;
          }
          const waitingEdits = carried && verdict === 'send' ? (carried.edits ?? null) : null;
          if (waitingEdits) showEdits(itemId, waitingEdits);
          // LEAVING the notebook it landed in: the changes move it. It
          // is then passed on to nobody here. The move, sent when this
          // create has ended, takes it from whoever the first attempt
          // reached and gives it to everyone in the notebook it goes
          // to.
          const leaving = waitingEdits !== null && withChange(landed.note, waitingEdits).movedFrom !== undefined;
          // It has landed, and it still has to reach its notebook's people:
          // the first attempt never got as far as passing it on (its answer
          // was lost, or the page died right after it). Returning here
          // without that would leave a note in a shared notebook that looks
          // synced and that nobody else ever receives. With the key of the
          // row that is ON the server: this replay made a new one, which
          // opens nothing there. A share made twice is the same share (an
          // upsert).
          try {
              const into = leaving ? null : (landed.note.notebookId ?? null);
            // A row that names NO notebook, while the notebook has an
            // item for it to name. Either the server refused to place
            // the note there, or the notebook had no item yet when the
            // note first went up and has one since (read as refused,
            // that note would never reach the notebook's people). The
            // row cannot say which, so the server is ASKED: the note
            // is placed now, by a write that changes nothing else of
            // it. Taken, the row names the notebook (which is also
            // what keeps the note from a reader who declined it);
            // refused, it is as it was.
            //
            // NOT when the server has just refused to place it, in
            // this very replay (`placementRefused`): the answer is
            // known. And "taken" is what the ROW says afterwards,
            // never the status alone: the server answers 200 to a
            // write it may not place, and leaves the column as it was.
            let placedNow = false;
            if (into !== null && landed.rowNotebook === null && notebookItem === 'item' && !placementRefused) {
              const placing = await apiRequest<ServerItem>(`/api/v1/items/${itemId}`, {
                method: 'PUT',
                body: {
                  encrypted_content: landed.sealed.ciphertext,
                  content_nonce: landed.sealed.nonce,
                  expected_version: landed.note.version,
                  notebook_id: into,
                },
              });
              if (placing.success) {
                placedNow = sameNotebook(placing.data.notebook_id, into);
                const moved = { version: placing.data.version, updatedAt: placing.data.updated_at };
                onServer = { ...landed.note, ...moved };
                if (notes().some(n => n?.id === itemId)) {
                  setNotes(prev => prev.map(n => n.id === itemId ? { ...n, ...moved } : n));
                  const shown = notes().find(n => n?.id === itemId);
                  if (shown && ownsSharedCache()) noteDb.putNote(shown);
                }
              }
            }
            // Only a note the server has IN that notebook, as the create
            // below (`placementRefused`): its row names the notebook (it did,
            // or it does now), or the notebook has no item on the server for
            // a row to name. What the server did not place is passed on to
            // nobody.
            const placed = into !== null && (
              landed.rowNotebook !== null
                ? landed.rowNotebook.toLowerCase() === into.toLowerCase()
                : notebookItem === 'none' || placedNow
            );
            if (into !== null && placed) {
              await passOnToNotebook(itemId, into, landed.contentKey, landed.note.contentKeyGeneration);
            }
          } finally {
            landed.contentKey.fill(0);
          }
          return { note: null, queued: false };
        }
        // Free note-cap hit → surface the upgrade prompt instead of failing
        // silently. The server gates note creation with a 402
        // (quota_notes_exceeded); older servers may omit the code, so trigger on
        // either signal. Hard denial (queued:false) → the composer keeps the text.
        // A REPLAY that the server refuses for good keeps its queue entry: the
        // note is on screen as waiting, and with the entry gone nothing would
        // ever send it, on this device or any other ("never drop a queue entry
        // whose card is still on screen"). It is tried again at each drain,
        // which is what the card says.
        const refusedForGood = (): CreateResult => {
          if (existingId !== undefined && ownsSharedCache()) keepEntry = true;
          return { note: null, queued: false };
        };
        if (result.status === 402 || result.error_code === 'quota_notes_exceeded') {
          setNoteLimitReached(true);
          return refusedForGood();
        }
        // Transient failure (offline / 5xx / 429 rate-limit) — queue the create
        // for offline replay so the new note isn't lost. Persisted to the SHARED
        // IDB only if this tab still owns it (see ownsSharedCache); a stale
        // post-account-switch tab must not seed B's queue with A's plaintext.
        // flushPending replays this via createNote(note, id).
        if (result.status === undefined || result.status >= 500 || result.status === 429) {
          return waitForReplay();
        }
        return refusedForGood();
      }

      const note = localNote(result.data.id, noteContent, wrapped, {
        version: result.data.version,
        createdAt: result.data.created_at,
        updatedAt: result.data.updated_at,
      });
      onServer = note;
      // Deleted here while it was on its way (see `deletedWhileSaving`): the
      // note is deleted there too, and is neither shown again nor passed on.
      // If that cannot be done just now, the note is shown: it is on the
      // server, and the card is where it can be deleted. It is still not
      // passed on to its notebook's people.
      const deletedHere = deletedWhileSaving.has(itemId);
      if (deletedHere) {
        const gone = await apiRequest(`/api/v1/items/${itemId}`, { method: 'DELETE' });
        if (gone.success || gone.status === 404) {
          onServer = null;
          return { note: null, queued: false };
        }
      }
      // A replay: what was changed on the card while this was on its way stays
      // on the card (it is sent when this create has ended, below).
      const waitingEdits = preQueued && existingId !== undefined ? await editsWaitingOn(itemId) : null;
      // The card as it is shown: the note as the server has it, with those
      // changes. One that MOVES the note is remembered on the card until it
      // has been carried through (lib/notebookMove).
      const shown = waitingEdits ? withChange(note, waitingEdits) : note;

      // Persist to the SHARED IDB (and this tab's in-memory grid) only if this
      // tab still owns the cache — a stale post-account-switch tab must not
      // write A's plaintext into a cache now owned by B (ownsSharedCache).
      if (ownsSharedCache()) {
        // Replace, don't prepend: a create that was queued offline already put a
        // row here under this same id, and a blind prepend would leave the user
        // looking at the note twice. Replacing in place also keeps it where it
        // is on screen instead of jumping it to the top as it syncs.
        setNotes(prev => placeNote(prev, shown));
        noteDb.putNote(shown);
      }

      // If this note landed in a shared notebook, fan out shares to every
      // recipient on that notebook's standing share list. We still have
      // the unwrapped content key in scope, so the wrap is direct (no
      // vault round-trip needed). Failures are logged; the note itself
      // stays created either way.
      //
      // Not when the server refused to place the note in that notebook (see
      // `placementRefused`).
      //
      // And not when the note is already LEAVING it: moved on the card while
      // this create was on its way. Passed on first, it would reach people it
      // is being taken away from, and nothing would take it back. The move,
      // sent when this create has ended, gives it to everyone in the notebook
      // it goes to.
      const leaving = shown.movedFrom !== undefined;
      if (note.notebookId && !placementRefused && !leaving && !deletedHere) {
        await passOnToNotebook(note.id, note.notebookId, contentKey);
      }
      return { note, queued: false };
    };
    let out: CreateResult;
    /** Changed on the card while this create waited or was on its way. */
    let since: Partial<NoteItem> | null = null;
    try {
      out = await run();
      if (preQueued && !keepEntry) {
        // The entry goes; or, when the card was edited meanwhile, the update
        // of those edits takes its place (`endCreate`).
        const reached = onServer;
        const dealt = dealtWith;
        try { since = await inTurn(itemId, () => endCreate(itemId, reached, dealt)); } catch { /* stale entry replays and 409s once; not fatal */ }
      }
    } finally {
      if (preQueued) savingNotes.delete(itemId);
      deletedWhileSaving.delete(itemId);
    }
    if (since) {
      showEdits(itemId, since);
      await notesStore.updateNote(itemId, since);
    }
    return out;
  },

  /** `retrying` is set only by the position-only 409 path below, so a re-based
   *  write that races again stops instead of looping. */
  async updateNote(id: string, content: Partial<NoteItem>, retrying = false): Promise<boolean> {
    if (!isCryptoReady()) return false;
    // A rescue of this note under way holds its turn: its new key first, or
    // this save would read the card on the old one and write it back so.
    if (rescuingNotes.has(id)) await inTurn(id, async () => {});

    // A shared note may show up in notes() too (the sync pull also returns
    // items shared with the current user). It takes the shares-inbox
    // path — the only place we hold the per-note content key the owner
    // sealed for us — but ONLY when that key is what opened it here: a
    // note this browser opened through its own vault is sealed under its
    // own key, whatever the inbox holds (a share of an own note is a key
    // someone else chose).
    const incomingShare = sharesInboxStore.getByItemId(id);
    const cached = notes().find(n => n?.id === id);
    const existing = cached ?? incomingShare?.note ?? null;
    if (!existing) return false;
    const viaShare = incomingShare !== undefined && openedWith(existing) === 'share';
    // A move the queue still owes for this note, unknown to this card: carried
    // by this edit, whose entry takes that one's place.
    if (!viaShare && ownsSharedCache()) content = withQueuedMove(content, existing, await noteDb.getPending(id));

    // The document a save writes (lib/noteDocument): another client's fields
    // first, so ours always win on a key clash.
    const merged = noteDocument(existing, content);

    // Shared-note branch. We never touch wrapped_content_key — only the
    // owner can rotate it. Version bumps are tracked on the inbox entry.
    // LOCAL-FIRST durability (see createNote): the edit is written to the
    // pending store BEFORE any encrypt/PUT work. The runner's terminals
    // decide the entry's fate — server success, a hard 4xx that will never
    // retry, and the 409 conflict-fork all make it obsolete (removed
    // below); a transient failure sets keepEntry, and a THROW skips the
    // removal entirely — a crash mid-save is exactly the case the
    // pre-write exists for.
    const preQueued = ownsSharedCache();
    let keepEntry = false;
    /** When this save's own update entry was queued: the entry it may make sharing-only. */
    let queuedAt: string | null = null;
    if (preQueued) {
      const sendUnderWay = savingNotes.has(id);
      savingNotes.add(id);
      // An edit of a note whose CREATE is still in the queue is folded into
      // that create and never takes its place: a PUT for a note the server was
      // never given is refused, and the entry it would replace is the only
      // thing that would send the note (lib/pendingNotes).
      const waiting = await inTurn(id, async () => {
        const create = await queueEdit(id, existing, content);
        if (create === null) queuedAt = (await noteDb.getPending(id))?.queuedAt ?? null;
        return create;
      });
      if (waiting !== null) {
        showEdits(id, editsIn(content));
        // Its create is on its way right now (a drain's replay): that send
        // takes these changes with it when it ends (createNote), and the
        // guard on this id is its own.
        if (sendUnderWay) return true;
        // Sent now, as the create it still is. Stored either way: the queue
        // holds the note as it is, which is what `true` says to the editor.
        try {
          await notesStore.createNote(waiting.note, id);
        } finally {
          savingNotes.delete(id);
        }
        return true;
      }
    }
    const run = async (): Promise<boolean> => {
      if (viaShare && incomingShare) {
        if (!incomingShare.contentKey) {
          // Share exists but we couldn't unwrap the content key (likely a
          // pre-E2EE share). Can't edit it safely — and say so, rather than
          // leave the editor on "Saving…".
          setKeyRefusedIds(prev => withId(prev, id));
          return false;
        }
        const encrypted = encryptWithContentKey(JSON.stringify(merged), incomingShare.contentKey, id);
        const result = await apiRequest<ServerItem>(`/api/v1/items/${id}`, {
          method: 'PUT',
          body: {
            encrypted_content: encrypted.ciphertext,
            content_nonce: encrypted.nonce,
            expected_version: existing.version,
          },
        });
        if (!result.success) {
          // Another account's session: keep the edit queued, send nothing more.
          if (isAccountStop(result)) {
            keepEntry = true;
            return false;
          }
          // Version conflict on a shared note: fork to an OWNED copy (the
          // recipient cannot win a CAS race against the owner, and retrying
          // with the refreshed version would overwrite the owner's edit).
          // ownedNote=false so the fork does not claim the owner's notebook.
          if (result.status === 409) {
            // Same rule on a shared note: a position is not an edit to rescue.
            if (isPositionOnly(content)) {
              await adoptServerRow(id);
              return retrying ? false : notesStore.updateNote(id, content, true);
            }
            const forked = await forkConflictCopy(existing, content, false);
            // Then re-base the original on the server's row, so the next edit
            // does not fork again (see adoptServerRow).
            await adoptServerRow(id);
            return forked;
          }
          // 404: the server no longer shows us this item — the share was
          // revoked or the note is gone. The text is still the user's; keep
          // it as an owned copy rather than drop the edit.
          if (result.status === 404) {
            // ⚠️ SAME RULE AS THE 409 ABOVE. A drag writes nothing but a
            // sortOrder, and a position is not an edit to rescue:
            // forking on it makes a "(conflict copy)" of somebody else's
            // note because the user moved a card. Dragging a note must
            // never be able to create one.
            if (isPositionOnly(content)) return false;
            return forkConflictCopy(existing, content, false);
          }
          // Offline or server error — queue for later replay, mirroring
          // the owner branch. On next flushPending, updateNote runs again
          // and hits this same shared-note branch (inbox content key is
          // restored by the preceding sharesInboxStore.load() in sync).
          // 429 (rate-limited) is transient too — queue it rather than drop
          // the edit on the floor.
          if (result.status === undefined || result.status >= 500 || result.status === 429) {
            const snapshot: NoteItem = { ...existing, ...content };
            sharesInboxStore.applyLocalEdit(id, snapshot, new Date().toISOString());
            if (cached) {
              setNotes(prev => prev.map(n => n.id === id ? snapshot : n));
            }
            // Persist to the SHARED IDB only if this tab still owns it — a stale
            // post-account-switch tab must not repopulate B's cache with A's
            // plaintext (see ownsSharedCache).
            if (ownsSharedCache()) {
              // Pre-written (local-first) — keep the entry for the next drain.
              keepEntry = true;
              if (cached) noteDb.putNote(snapshot);
            }
          }
          return false;
        }
        const updatedNote: NoteItem = {
          ...existing,
          ...content,
          version: result.data.version,
          updatedAt: result.data.updated_at,
        };
        sharesInboxStore.applyLocalEdit(id, updatedNote, result.data.updated_at);
        setKeyRefusedIds(prev => withoutId(prev, id));
        // Also mirror the edit into the main notes() cache if sync already
        // put the shared item there, so any grid tile or modal that reads
        // from notesStore repaints immediately.
        if (cached) {
          setNotes(prev => prev.map(n => n.id === id ? updatedNote : n));
          noteDb.putNote(updatedNote);
        }
        return true;
      }

      // Per-note content key path. If the note already has a wrapped content
      // key (created with one, or given one on an earlier save), unwrap it and
      // reuse — a stable key simplifies share re-wrapping. If legacy (no
      // wrapped key yet), generate one now and send both to the server, which
      // stores the wrap only while the row has none (the first save).
      //
      // A wrap that EXISTS but will not open is not a legacy note, and minting
      // a replacement for it would lose data: the edit would go up under a
      // brand-new content key, the server would replace the owner's wrap with
      // one only THIS tab's vault key opens, and every other device, every
      // recipient holding the old key and every attachment sealed under it
      // would lose the note. The server refuses such a PUT too. So refuse
      // here, keep the edit locally, and say why: the usual cause is a note
      // from before a password reset, which opens again once the recovery key
      // restores that identity — at which point the queued edit replays under
      // the note's own key.
      //
      // Where the SERVER has the note, and where this save puts it. They
      // differ for a move made now, and for one made earlier that has not
      // been carried through: put on the card while the server could not be
      // reached, or folded into the note's create. The card remembers where
      // the server has it (`movedFrom`, lib/notebookMove). Compared with the
      // card's own notebook instead, a move sent later would be no move at
      // all: nobody would be taken off the note, and nobody given it.
      // Where it is, as the card or (when a pull or a conflict took it off the
      // card) the queued card remembers: sharingNotebook.
      const from = sharingNotebook(existing, content);
      const target = content.notebookId !== undefined ? (content.notebookId ?? null) : (existing.notebookId ?? null);
      const moved = !sameNotebook(from, target);
      /** Owed from before this save: whether the first notebook's people ever got the note is not known. */
      const owedFromBefore = existing.movedFrom !== undefined || content.movedFrom !== undefined;
      /** The card as this save leaves it while the server has not been told: the move is remembered. */
      const waiting = (): NoteItem => withOwedMove(existing, content);
      if (existing.wrappedContentKey && existing.wrappedContentKeyNonce) {
        const opened = unwrapContentKeyWithVault(existing.wrappedContentKey, existing.wrappedContentKeyNonce);
        if (!opened) {
          console.warn(`[note] refusing to save ${id}: its content key does not open with the keys this tab holds`);
          setKeyRefusedIds(prev => withId(prev, id));
          const snapshot: NoteItem = waiting();
          setNotes(prev => prev.map(n => n.id === id ? snapshot : n));
          if (ownsSharedCache()) {
            // Pre-written (local-first) — keep it for a drain that can open it.
            keepEntry = true;
            noteDb.putNote(snapshot);
          }
          return false;
        }
        opened.fill(0);
      }

      // Does the note's notebook exist as an item on the server? Asked when
      // this page's syncs have not said, and once more after no answer.
      let notebookItem = await notebooksStore.notebookItemState(merged.notebook_id);
      if (notebookItem === 'unknown') notebookItem = await notebooksStore.notebookItemState(merged.notebook_id);
      // A MOVE into a notebook that is shared with people, and no answer:
      // saved now, the row would not name the notebook, and the move's own
      // sharing below would hand the note, live, to a reader who declined
      // that notebook. It waits, like any save the server could not take:
      // shown as it will be, kept for the next drain.
      const movingInto = moved ? target : null;
      if (notebookItem === 'unknown' && movingInto && notebooksStore.getNotebookShares(movingInto).length > 0) {
        const snapshot: NoteItem = waiting();
        setNotes(prev => prev.map(n => n.id === id ? snapshot : n));
        if (ownsSharedCache()) {
          keepEntry = true;
          noteDb.putNote(snapshot);
        }
        return false;
      }

      let payload: {
        encrypted_content: string;
        content_nonce: string;
        expected_version: number;
        wrapped_content_key?: string;
        wrapped_content_key_nonce?: string;
        /** Owner branch only. `null` un-files; ABSENT means "leave it alone",
         *  which is what the shared-note branch relies on. */
        notebook_id?: string | null;
      };
      let newWrappedKey: string | null = existing.wrappedContentKey ?? null;
      let newWrappedNonce: string | null = existing.wrappedContentKeyNonce ?? null;
      /** Only a legacy note's FIRST wrap goes up on a PUT. An unchanged wrap is
       *  omitted — the server keeps what it holds — so this client never even
       *  proposes a wrap change outside rotate-shares, and a stale cached wrap
       *  (another device rotated) cannot be mistaken for one. */
      let mintedWrap = false;

      let contentKey: Uint8Array | null = null;
      if (existing.wrappedContentKey && existing.wrappedContentKeyNonce) {
        contentKey = unwrapContentKeyWithVault(existing.wrappedContentKey, existing.wrappedContentKeyNonce);
      }
      if (!contentKey) {
        // Legacy note (no wrap at all — an unopenable wrap was refused above):
        // generate a content key on first save after migration.
        contentKey = generateContentKey();
        const wrapped = wrapContentKeyWithVault(contentKey);
        newWrappedKey = wrapped.wrappedKey;
        newWrappedNonce = wrapped.nonce;
        mintedWrap = true;
      }
      const encrypted = encryptWithContentKey(JSON.stringify(merged), contentKey, id);
      payload = {
        encrypted_content: encrypted.ciphertext,
        content_nonce: encrypted.nonce,
        expected_version: existing.version,
        ...(mintedWrap && newWrappedKey && newWrappedNonce
          ? { wrapped_content_key: newWrappedKey, wrapped_content_key_nonce: newWrappedNonce }
          : {}),
        // Keep the server-visible grouping in step with the encrypted payload.
        // Sent as `null` when the note is in no notebook — the server reads an
        // absent field as "leave it alone", so omitting it would strand the
        // old grouping on the row. Owner branch only; the server gates the
        // column on ownership anyway.
        //
        // ⚠️ A notebook with no ITEM is never NAMED: the server's notebook
        // column must reference an existing item, and naming a metadata-only
        // notebook 500s the whole save. The grouping is recorded once the
        // backfill mints the item. The server is asked when this page's syncs
        // have not said (`notebookItemState`, above); with no answer it is not
        // named either.
        //
        // What the row says INSTEAD depends on whether the note has moved:
        // - It stays where it was: the column is left alone (omitted).
        //   Whatever the row says is still right, and `null` would take a
        //   notebook off a row that names it correctly.
        // - It MOVED here: `null`. The row still names the notebook the note
        //   has just left, and the server goes by that: it would keep such a
        //   note away from a reader who had declined the OLD notebook even
        //   when its owner later shares it with them on its own.
        ...(merged.notebook_id && notebookItem !== 'item'
          ? (movingInto ? { notebook_id: null } : {})
          : { notebook_id: merged.notebook_id ?? null }),
      };

      const result = await apiRequest<ServerItem>(`/api/v1/items/${id}`, {
        method: 'PUT',
        body: payload,
      });

      if (!result.success) {
        // Another account's session: keep the edit queued, send nothing more.
        if (isAccountStop(result)) {
          keepEntry = true;
          return false;
        }
        // Version conflict: keep both, never drop and never clobber. See
        // forkConflictCopy — without this branch the transient floor below
        // would swallow the 409. Then re-base the original on the server's
        // row: one fork per divergence, never one per keystroke
        // (adoptServerRow).
        if (result.status === 409) {
          // A reorder has nothing to lose — see isPositionOnly. Take the
          // server's row (which refreshes the version) and put the position
          // back on top of it, once. If that races again, the order simply
          // comes from the server; nothing is duplicated either way.
          if (isPositionOnly(content)) {
            await adoptServerRow(id);
            return retrying ? false : notesStore.updateNote(id, content, true);
          }
          // The server's row first. Words it has already, sent from here
          // before (another tab replaying this save), are no conflict, and
          // no copy is made of them. And a move it has is still owed its
          // sharing, whatever else happened to the note.
          const adopted = await adoptServerRowNote(id);
          const theirs = adopted?.note ?? null;
          const sameWords = theirs !== null && wordsOf(noteDocument(theirs)) === wordsOf(merged);
          const forked = sameWords ? true : await forkConflictCopy(existing, content, true, serverPlacement(adopted), moved);
          if (theirs && moved) {
            const there = theirs.notebookId ?? null;
            if (!sameNotebook(there, from)) {
              const key = theirs.wrappedContentKey && theirs.wrappedContentKeyNonce
                ? unwrapContentKeyWithVault(theirs.wrappedContentKey, theirs.wrappedContentKeyNonce)
                : null;
              const thereItem = there === null ? 'none' : await notebooksStore.notebookItemState(there);
              const giveTo = there === null || thereItem === 'none' || sameNotebook(adopted?.rowNotebook ?? null, there);
              const outcome = key ? await carryMoveThrough(id, from, there, !owedFromBefore, key, giveTo, sharingPeople(existing, content)) : 'owed';
              const now = notes().find(n => n?.id === id) ?? theirs;
              if (outcome === 'owed') {
                const owed: NoteItem = { ...now, movedFrom: from };
                setNotes(prev => prev.map(n => n.id === id ? owed : n));
                if (ownsSharedCache()) noteDb.putNote(owed);
                keepEntry = true;
                await owedSharingOnly(id, queuedAt, owed);
              }
            } else if (sameWords) {
              // The move never reached the server, and nothing else of this
              // save differs from it: sent again, on the server's version.
              keepEntry = true;
              return retrying ? false : notesStore.updateNote(id, content, true);
            }
          }
          return forked;
        }
        // 404: the server has no such row for us. It was purged, or the server
        // was restored to a point before this note existed. Either way the
        // note is the user's and the edit is in hand — re-create it under the
        // SAME id (the server accepts a supplied id; the backup restore
        // pipeline does exactly this) instead of dropping the edit on the
        // floor: returning false here would remove the queue entry as
        // "handled", and the text would be gone.
        if (result.status === 404) {
          // ⚠️ A POSITION HAS NOTHING TO RESCUE — and re-creating on one is
          // actively wrong twice over. The row is gone from the server, so a
          // POST here would RESURRECT a note deleted on another device because
          // this one moved a card; and if the POST then 409s (the id is taken
          // after all) the branch below forks a "(conflict copy)". Both come
          // from a drag, which writes only a sortOrder. The note's text is not
          // at risk, so drop the write and let sync settle the row.
          if (isPositionOnly(content)) return false;
          const recreated = await apiRequest<ServerItem>('/api/v1/items', {
            method: 'POST',
            body: {
              id,
              item_type: 1,
              encrypted_content: encrypted.ciphertext,
              content_nonce: encrypted.nonce,
              wrapped_content_key: newWrappedKey ?? undefined,
              wrapped_content_key_nonce: newWrappedNonce ?? undefined,
              // Same rule as createNote: only a notebook that exists as an
              // item may be named, or the server fails the whole create.
              notebook_id: notebookItem === 'item' ? (merged.notebook_id ?? null) : null,
            },
          });
          if (recreated.success) {
            const revived: NoteItem = {
              ...settled(existing),
              ...content,
              version: recreated.data.version,
              createdAt: recreated.data.created_at,
              updatedAt: recreated.data.updated_at,
              wrappedContentKey: recreated.data.wrapped_content_key ?? newWrappedKey ?? existing.wrappedContentKey ?? null,
              wrappedContentKeyNonce: recreated.data.wrapped_content_key_nonce ?? newWrappedNonce ?? existing.wrappedContentKeyNonce ?? null,
            };
            setNotes(prev => prev.map(n => n.id === id ? revived : n));
            noteDb.putNote(revived);
            return true;
          }
          if (isAccountStop(recreated)) {
            keepEntry = true;
            return false;
          }
          // The id is taken after all (a race with a sync that restored it):
          // treat it as the conflict it is.
          if (recreated.status === 409) {
            const adopted = await adoptServerRowNote(id);
            return forkConflictCopy(existing, content, true, serverPlacement(adopted), moved);
          }
          // Note cap or another hard denial: keep the editor dirty.
          if (recreated.status !== undefined && recreated.status < 500 && recreated.status !== 429) {
            return false;
          }
          // Transient: fall through to the queue below.
        }
        // Offline or server error — queue for later if no cached version
        // exists. 429 (rate-limited) is transient too, so queue it instead of
        // losing the edit (the 4xx floor would otherwise drop a rate-limited
        // save silently).
        if (result.status === undefined || result.status >= 500 || result.status === 429) {
          const snapshot: NoteItem = waiting();
          // Still update local state so the UI reflects the user's intent.
          setNotes(prev => prev.map(n => n.id === id ? snapshot : n));
          // Persist to the SHARED IDB only if this tab still owns it — a stale
          // tab whose account was switched out from under it must not write A's
          // plaintext into a cache now owned by B (see ownsSharedCache).
          if (ownsSharedCache()) {
            // Pre-written (local-first) — keep the entry for the next drain.
            keepEntry = true;
            noteDb.putNote(snapshot);
          }
        }
        return false;
      }

      // The server has the save. A move is still owed its sharing (below):
      // the card goes on remembering where the note was until that is done,
      // so that a page closed in between still carries it through.
      const updated: NoteItem = {
        ...waiting(),
        version: result.data.version,
        updatedAt: result.data.updated_at,
        wrappedContentKey: result.data.wrapped_content_key ?? newWrappedKey ?? existing.wrappedContentKey ?? null,
        wrappedContentKeyNonce: result.data.wrapped_content_key_nonce ?? newWrappedNonce ?? existing.wrappedContentKeyNonce ?? null,
      };
      setNotes(prev => prev.map(n => n.id === id ? updated : n));
      noteDb.putNote(updated);
      setKeyRefusedIds(prev => withoutId(prev, id));

      // Reconcile standing notebook shares when the note moves in or out
      // of a notebook. Only runs for owner edits — share recipients can't
      // change notebookId (the shared branch returned earlier).
      if (moved && contentKey) {
        // Given to the new notebook's people only where the server placed it
        // (the same rule as for a create): its row names the notebook, or the
        // notebook has no item for a row to name.
        const giveTo = target === null || notebookItem === 'none'
          || sameNotebook(result.data.notebook_id ?? null, target);
        const outcome = await carryMoveThrough(id, from, target, !owedFromBefore, contentKey, giveTo, sharingPeople(existing, content));
        if (outcome === 'owed') {
          // Still owed: the card goes on remembering where the note was, and
          // the queue keeps the job, without the words, which are up.
          keepEntry = true;
          await owedSharingOnly(id, queuedAt, notes().find(n => n?.id === id) ?? updated);
          return true;
        }
      }
      // The move is carried through (or there was none): nothing is owed.
      // On the card as it is NOW: a re-key above has written its new wrap.
      if (updated.movedFrom !== undefined) {
        setNotes(prev => prev.map(n => n.id === id ? settled(n) : n));
        const now = notes().find(n => n?.id === id);
        if (now && ownsSharedCache()) noteDb.putNote(now);
      }

      return true;
    };
    try {
      const ok = await run();
      if (preQueued && !keepEntry) {
        try { await noteDb.removePending(id); } catch { /* stale entry replays and 409-forks once; not silent loss */ }
      }
      return ok;
    } finally {
      if (preQueued) savingNotes.delete(id);
      deletedWhileSaving.delete(id);
    }
  },

  /** Forward-secret teardown of a notebook's standing shares — called when
   *  a shared notebook is deleted. Each child note that still has shares is
   *  rotated to a fresh content key with ALL its share rows revoked, so no
   *  former recipient's cached content key can decrypt future edits. Without
   *  this, deleting a shared notebook silently leaves every recipient with
   *  working access (their per-note shares + keys outlive the notebook).
   *  Best-effort + offline-tolerant; mirrors the note-android
   *  NotebookShareWriter.unshareNotebookFromAll path.
   *
   *  A note's rows are asked for twice when the first ask gets no answer, and
   *  a key change that is not sent (it asks for them again itself, and sends
   *  nothing it could not read) falls back to revoking the rows one by one, as
   *  the notebook object's own removal does (lib/notebookRemoval): revoked but
   *  not re-keyed is far better than neither, and the deletion promises that
   *  they lose access. */
  async unshareNotebookChildren(notebookId: string): Promise<void> {
    const at = new Date().toISOString();
    const children = notes().filter(n => !n.deleted && n.notebookId === notebookId);
    for (const n of children) {
      if (await takeEveryoneOff(n.id) !== 'unread') continue;
      // Not read even asked again: taken off later, every row made before now,
      // so its people do not keep access for good.
      console.warn(`Notebook-delete unshare: the rows of ${n.id} could not be read; its people are taken off later`);
      rememberTakeBack(n.id, at);
    }
  },

  async deleteNote(id: string): Promise<boolean> {
    const result = await apiRequest(`/api/v1/items/${id}`, { method: 'DELETE' });
    if (!result.success) {
      // 404 = the server holds no such item FOR US. Either it was purged, or
      // this is a stale copy of someone else's note whose share was revoked
      // (DELETE is owner-scoped, so a foreign id 404s). Both mean the same
      // thing: nothing to keep — drop the local copy instead of stranding an
      // undeletable card.
      if (result.status === 404) {
        // Its create may be on its way right now, and land after this.
        if (savingNotes.has(id)) deletedWhileSaving.add(id);
        setNotes(prev => prev.filter(n => n.id !== id));
        noteDb.removeNote(id);
        // And what is queued for it. A note still waiting to be created is
        // deleted by this; its create left in the queue would make it
        // again at the next replay, and refused there (a free account at
        // its limit), it would be tried for ever with no card left to
        // delete.
        if (ownsSharedCache()) await inTurn(id, () => noteDb.removePending(id));
        return true;
      }
      return false;
    }
    if (savingNotes.has(id)) deletedWhileSaving.add(id);
    setNotes(prev => prev.map(n => n.id === id ? { ...n, deleted: true } : n));
    noteDb.removeNote(id);
    // And what is queued for it, as above. A create that landed with its
    // answer lost, left in the queue here with whatever was typed on the card
    // since, would find the note deleted at its replay, take that for a delete
    // made somewhere else, and bring the text back as a note called
    // "(conflict copy)", passed on to its notebook's people.
    // Except the sharing a move still owes: in the trash the note keeps its
    // people, and restored, those of the notebook it left would keep it. That
    // job stays, without the words, until the note is purged.
    if (ownsSharedCache()) await inTurn(id, async () => {
      const entry = await noteDb.getPending(id);
      if (entry?.op === 'update' && entry.note.movedFrom !== undefined) {
        if (!entry.sharingOnly) await noteDb.queuePending({ ...entry, sharingOnly: true });
      } else await noteDb.removePending(id);
    });
    return true;
  },

  /** Restore a note from trash */
  async restoreNote(id: string): Promise<boolean> {
    const result = await apiRequest(`/api/v1/items/${id}/restore`, { method: 'POST' });
    if (!result.success) return false;
    setNotes(prev => prev.map(n => n.id === id ? { ...n, deleted: false } : n));
    return true;
  },

  /** Permanently delete (remove from local state; server already soft-deleted) */
  permanentlyDelete(id: string) {
    setNotes(prev => prev.filter(n => n.id !== id));
    // Precise counterpart to the post-sync sweep: this is the one moment we
    // KNOW a note is gone for good, so its pin can go with it. A note in the
    // trash keeps its pin — `restoreNote` brings it back and the user would
    // expect the mode to come back too.
    notebooksStore.gcEditorModes(notes().map(n => n.id));
  },

  /**
   * Mark a note as shared-by-me, or no longer shared, in the local cache.
   *
   * The badge is driven by `shared_by_me`, which the server computes for
   * each sync row — but sharing does not bump the note's `updated_at`, and
   * the pull returns only rows with `updated_at > since`. A note the owner
   * just shared is therefore NOT returned by the incremental sync, so the
   * flag never arrives and the badge never appears. It would show up only
   * after some unrelated edit bumped the note, which is to say: never, at
   * the moment it matters.
   *
   * The client already knows — it just did the sharing — so it records it
   * locally and persists it. A full sync (a fresh browser, no cursor) still
   * gets the authoritative value from the server.
   */
  /**
   * Record a share change the sync will not tell us about.
   *
   * `shared_by_me` and `shared_with_count` both ride the sync rows, and a
   * share does not bump the note's `updated_at` — the pull returns rows past
   * the cursor by `updated_at`, then id — so once the client's cursor is past
   * this note no incremental pull returns it again. Whatever we hold is what
   * the card shows, through reloads.
   *
   * `recipientCount` is patched here as well as the boolean: adding a SECOND
   * recipient leaves `isShared` already true, so an equality guard on the
   * boolean alone would return early and throw the update away, and the card
   * would sit on "Sharing with 1 person" no matter how many people it reached.
   */
  setLocallyShared(noteId: string, shared: boolean, recipientCount?: number) {
    const current = notes().find(n => n.id === noteId);
    if (!current) return;
    const countChanged = recipientCount !== undefined
      && current.sharedWithCount !== recipientCount;
    if (current.isShared === shared && !countChanged) return;
    this.applyLocalPatch({
      ...current,
      isShared: shared,
      ...(recipientCount !== undefined ? { sharedWithCount: recipientCount } : {}),
    });
  },

  /**
   * The sharing a move still owes, for a queued entry that carries only that
   * (`PendingEdit.sharingOnly`): no words are sent. Ends the entry when it is
   * through; keeps it, and the card's record of the move, otherwise.
   */
  async carryOwedMove(id: string, queued: NoteItem): Promise<boolean> {
    if (savingNotes.has(id)) return false;
    savingNotes.add(id);
    try {
      const endEntry = () => inTurn(id, async () => {
        const entry = await noteDb.getPending(id);
        if (entry?.sharingOnly && ownsSharedCache()) await noteDb.removePending(id);
      });
      // Where the server has the note NOW: this page's card may be older than
      // the move (another tab made it) or than a later one.
      const adopted = await adoptServerRowNote(id);
      if (adopted === undefined) {
        // Not read just now: kept for the next drain. Purged: nothing is owed.
        const r = await apiRequest(`/api/v1/items/${id}`);
        if (!r.success && r.status === 404) { await endEntry(); return true; }
        return false;
      }
      const card = adopted.note;
      // In the trash: still owed. Restored, the people of the notebook it
      // left would keep it; the job waits for the note to come back, or to
      // be purged.
      if (!card) return false;
      const from = sharingNotebook(card, queued);
      const to = card.notebookId ?? null;
      // The server has it where its sharing has it: moved back, or never moved.
      if (sameNotebook(from, to)) { await endEntry(); return true; }
      const key = card.wrappedContentKey && card.wrappedContentKeyNonce
        ? unwrapContentKeyWithVault(card.wrappedContentKey, card.wrappedContentKeyNonce)
        : null;
      if (!key) return false;
      const toItem = to === null ? 'none' : await notebooksStore.notebookItemState(to);
      const giveTo = to === null || toItem === 'none' || sameNotebook(adopted.rowNotebook, to);
      // Whether the first notebook's people ever got it is not known here: the
      // new notebook's people are all given it (a share made twice is the same).
      const outcome = await carryMoveThrough(id, from, to, false, key, giveTo, sharingPeople(card, queued));
      if (outcome === 'owed') {
        const now = notes().find(n => n?.id === id) ?? card;
        this.applyLocalPatch({ ...now, movedFrom: from });
        return false;
      }
      await endEntry();
      return true;
    } finally {
      savingNotes.delete(id);
    }
  },

  // --- After a password reset: copies this browser kept (lib/noteRescue) ---

  /**
   * Does this browser hold a copy of one of the account's own notes whose key
   * no key here opens? (A password reset happened since it was kept.) Then the
   * rows have to be pulled in full for the rescue to know what the server
   * holds: an incremental pull never brings an unchanged note again.
   */
  cachedCopiesNoKeyOpens(): boolean {
    return notes().some(n => !!n && !n.deleted && positivelyOwn(n)
      && !sharesInboxStore.getByItemId(n.id)
      && !!n.wrappedContentKey && !!n.wrappedContentKeyNonce
      && vaultKeyThatOpens(n.wrappedContentKey, n.wrappedContentKeyNonce) === null);
  },

  /**
   * Re-save, under this identity's key, every note of the account's that no key
   * here opens and of which this browser holds a copy that is the server's
   * LATEST version. See lib/noteRescue for the rules; `rescue` writes one
   * (shareUtils `rescueNoteFromCopy`), and `keepOldKey` carries the old key in
   * the list first when the note has attachments (they stay sealed under it,
   * and a recovery key brings them back). One note at a time, each in its
   * queue entry's turn, and never one being saved right now.
   *
   * A save of the same note that starts while it is rescued still holds the
   * card from before: refused for its key, it shows the edit on that card and
   * keeps it queued. The next pull brings the rescued row, which opens, and the
   * queued edit is sent under the new key.
   */
  async rescueFromCopies(deps: {
    rescue: (copy: NoteItem, notebookId: string | null) => Promise<{ applied?: { wrappedForVault: { wrappedKey: string; nonce: string }; version: number; contentKeyGeneration: number }; remainingCount?: number }>;
    keepOldKey: (id: string, wrap: { wrappedKey: string; wrappedKeyNonce: string; attachmentIds: string[] }) => Promise<boolean>;
    attachmentsOf: (id: string) => Promise<readonly { id: string }[] | null>;
    /** Rescues (rotations) at most in this call: the server allows ten a minute. */
    limit: number;
  }): Promise<{ rescued: number; stale: number; held: number; waiting: number; left: number; movesQueued: number }> {
    const out = { rescued: 0, stale: 0, held: 0, waiting: 0, left: 0, movesQueued: 0 };
    const me = tryCanonicalAccountId(authStore.user()?.id ?? null);
    if (!me || !isCryptoReady() || !previousIdentitiesAnswered() || rowsNoKeyOpens.account !== me) return out;
    let tried = 0;
    const rows = [...rowsNoKeyOpens.byId];
    for (let i = 0; i < rows.length; i++) {
      const [id, row] = rows[i];
      if (tryCanonicalAccountId(authStore.user()?.id ?? null) !== me) return out;
      if (tried >= deps.limit) { out.left = rows.length - i; break; }
      rescuingNotes.add(id);
      const outcome = await inTurn(id, async (): Promise<RescueOutcome> => {
        if (savingNotes.has(id)) return 'later';
        const card = notes().find(n => n?.id === id);
        const pending = ownsSharedCache() ? await noteDb.getPending(id) : null;
        const plan = rescuePlan({
          card: card ?? null,
          row,
          pending: pending ? { op: pending.op, note: pending.note } : null,
          incomingShare: sharesInboxStore.getByItemId(id) !== undefined,
          rowKeyOpens: row.wrappedKey && row.wrappedKeyNonce ? vaultKeyThatOpens(row.wrappedKey, row.wrappedKeyNonce) !== null : false,
        });
        if (plan.do === 'leave') return 'leave';
        if (plan.do === 'locked' || plan.do === 'held') {
          // An older copy than the server's, or a note others hold: what the
          // server has is locked for this identity, and counted so. (The card is
          // positively ours already: nothing is stamped on the server's word.)
          setLockedOwnIds(prev => withId(prev, id));
          return plan.do === 'locked' ? 'stale' : 'held';
        }
        if (row.wrappedKey && row.wrappedKeyNonce) {
          const attachments = await deps.attachmentsOf(id);
          if (attachments === null) return 'later';
          if (attachments.length > 0
            && !(await deps.keepOldKey(id, { wrappedKey: row.wrappedKey, wrappedKeyNonce: row.wrappedKeyNonce, attachmentIds: attachments.map(a => a.id) }))) return 'later';
        }
        tried++;
        const r = await deps.rescue(plan.copy, plan.notebookId);
        if (!r.applied) {
          // Someone else holds it after all (the server's list): left as it is,
          // counted, and remembered on the card so it is not tried again.
          if ((r.remainingCount ?? 0) > 0) {
            if (card) this.applyLocalPatch({ ...card, isShared: true, sharedWithCount: r.remainingCount });
            setLockedOwnIds(prev => withId(prev, id));
            return 'held';
          }
          return 'later';
        }
        const rescued: NoteItem = {
          ...plan.copy,
          version: r.applied.version,
          wrappedContentKey: r.applied.wrappedForVault.wrappedKey,
          wrappedContentKeyNonce: r.applied.wrappedForVault.nonce,
          contentKeyGeneration: r.applied.contentKeyGeneration,
          foreignOwner: false,
          openedVia: 'vault',
        };
        // Where the server's sharing has it, until the move is carried through.
        if (plan.owesMove) rescued.movedFrom = plan.notebookId;
        else delete rescued.movedFrom;
        // Trashed meanwhile: it stays in the trash rather than coming
        // back, and owes no move.
        const trashed = notes().find(n => n?.id === id)?.deleted === true;
        if (trashed) { rescued.deleted = true; delete rescued.movedFrom; }
        const owesMove = plan.owesMove && !trashed;
        this.applyLocalPatch(rescued);
        if (ownsSharedCache()) {
          if (owesMove) {
            // The move goes through the normal save, under the new key.
            await noteDb.queuePending({ id, note: rescued, op: 'update', queuedAt: new Date().toISOString() });
          } else if (pending) {
            // What was waiting went up with the rescue; not an edit another
            // tab queued meanwhile, which stays.
            const now = await noteDb.getPending(id);
            if (now && now.queuedAt === pending.queuedAt) await noteDb.removePending(id);
          }
        }
        rowsNoKeyOpens.byId.delete(id);
        setUndecryptableIds(prev => withoutId(prev, id));
        setLockedOwnIds(prev => withoutId(prev, id));
        setKeyRefusedIds(prev => withoutId(prev, id));
        if (owesMove) out.movesQueued++;
        return 'rescued';
      }).finally(() => rescuingNotes.delete(id));
      if (outcome === 'rescued') out.rescued++;
      else if (outcome === 'stale') out.stale++;
      else if (outcome === 'held') out.held++;
      else if (outcome === 'later') out.waiting++;
    }
    return out;
  },

  /** Replace an entry in the notes signal with a pre-computed snapshot.
   *  Used by share rotation to mirror a fresh wrapped_content_key into
   *  the local cache without another server round-trip. */
  applyLocalPatch(note: NoteItem) {
    setNotes(prev => prev.map(n => (n.id === note.id ? note : n)));
    // Persist to the SHARED IDB only if this tab still owns it — a stale
    // post-account-switch tab must not write A's plaintext into a cache now
    // owned by B (see ownsSharedCache).
    if (ownsSharedCache()) noteDb.putNote(note);
  },

  /** Take the note as the server has it now: its words, version and key
   * (`adoptServerRow`). For a change applied at a version this page had not
   * read (lib/shareUtils `rotateContentKey` after a retry).
   * False when nothing was taken (no answer just now). */
  adoptServerRow(id: string): Promise<boolean> {
    return adoptServerRow(id);
  },

  // --- Drag lifecycle ---

  dragStart(noteId: string) {
    setDraggedId(noteId);
    setDragPreview([...sortedActiveNotes()]);
    resetSwapGate(swapGate);
  },

  /**
   * Drop the dragged card adjacent to the hovered target. Cursor
   * over a card → source takes that card's slot, the card is
   * displaced to where source came from.
   *
   * Inserting at targetIndex after splicing source out is
   * direction-aware: source above → lands after target, source
   * below → lands before target. That's the Keep behavior —
   * hover card X, dragged lands at X's spot.
   *
   * Latch is keyed on targetId only. Stays on the same card → no
   * re-swap (prevents layout-shift oscillation where target's
   * position changes under the still cursor). Cursor leaves the
   * card → latch clears via dragLeave, so coming back triggers a
   * fresh swap.
   */
  dragMove(targetIndex: number, targetId: string, pointer: Pointer) {
    const preview = dragPreview();
    const id = draggedId();
    if (!preview || !id) return;

    const sourceIndex = preview.findIndex(n => n.id === id);
    if (sourceIndex < 0) return;
    // ⚠️ considerSwap MUTATES the gate on a refusal too, which is the point —
    // see lib/dropOrder.ts. A version that pruned only on success could not
    // release its own block, and the drag would go dead mid-gesture.
    if (!considerSwap(swapGate, { sourceIndex, targetIndex, targetId, pointer }).swap) return;

    const reordered = [...preview];
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    setDragPreview(reordered);
  },

  /** Called when the cursor leaves a card's bounding box. Clears
   *  the latch so re-entering triggers a fresh swap. */
  dragLeave(cardId: string) {
    releaseLatch(swapGate, cardId);
  },

  async dragEnd(dropped: boolean) {
    const preview = dragPreview();
    const id = draggedId();

    // Always clear drag state immediately
    setDraggedId(null);
    setDragPreview(null);
    resetSwapGate(swapGate);

    if (!dropped || !preview || !id) return;

    // ONE write, not a whole-list renumber. Rewriting every note's
    // sortOrder to its preview index (0..N) would mean N sequential
    // encrypted PUTs that nothing awaits — over a minute on an account of
    // some 70 notes — and any reload mid-fanout would leave the ordering
    // permanently half-rewritten, while the positive indexes collide with
    // createNote's negative-descending scheme, scrambling the notes that
    // never got their PUT. A drag assigns the moved note the MIDPOINT
    // between its new neighbours' sortOrders (floats are fine — the field
    // is a JSON number end to end), which is a single durable write. The
    // full renumber is only the fallback for midpoint exhaustion
    // (neighbours too close after many repeated drags into the same gap),
    // where it is actually needed.
    //
    // ⚠️ THE NEIGHBOURS ARE THE ONES IN THE CARD'S OWN SECTION, which is
    // why this is a call and not four lines of arithmetic: `isPinned`
    // outranks `sortOrder` in the sort above, so a midpoint taken across
    // the Pinned / Other notes boundary is a number that means nothing
    // where the card actually lives — it would send a pinned card back to
    // slot 0 and an unpinned one to the end of the grid, both durably. See
    // lib/dropOrder.ts.
    // A section can hold notes shared TO us with `view` permission; the server
    // refuses those writes 403, so the renumber must not claim them.
    const plan = planDrop(preview, id, n => canWriteNote(sharesInboxStore.getByItemId(n.id)));
    if (plan.kind === 'none') return;

    if (plan.kind === 'single') {
      setNotes(prevNotes => prevNotes.map(n => (n.id === id ? { ...n, sortOrder: plan.sortOrder } : n)));
      await notesStore.updateNote(id, { sortOrder: plan.sortOrder });
      return;
    }

    // Midpoint exhausted: renumber sparsely (gaps of 1024) so the next
    // few hundred drags into any gap stay single-write.
    const updates = plan.updates;
    setNotes(prevNotes => prevNotes.map(n => {
      const u = updates.find(x => x.id === n.id);
      return u ? { ...n, sortOrder: u.sortOrder } : n;
    }));
    // Parallel, not sequential: each note is an independent row, and a
    // 16-note renumber awaited one-by-one held a multi-second window in
    // which a reload (or tab close) stranded the ordering half-rewritten —
    // exactly the failure the midpoint fast path exists to avoid.
    await Promise.all(updates.map(u => notesStore.updateNote(u.id, { sortOrder: u.sortOrder })));
  },

  search(query: string): NoteItem[] {
    return notes().filter(n => !n.deleted && matchesSearch(n, query));
  },

  /**
   * Take RECEIVED notes off this device, now: the reader has just declined
   * the notebook they came with, and their shares are dismissed. A completed
   * sync evicts them too, but only on an inbox it read to its end, and until
   * then a reload would bring them back on screen.
   *
   * Only a note a share's key opened. A note our own vault opened is ours, and
   * nothing asked of this by id takes it off the device.
   */
  dropReceived(ids: readonly string[]): void {
    const gone = new Set(notes().filter(n => ids.includes(n.id) && openedWith(n) === 'share').map(n => n.id));
    if (gone.size === 0) return;
    setNotes(prev => prev.filter(n => !gone.has(n.id)));
    for (const id of gone) noteDb.removeNote(id);
  },
};
