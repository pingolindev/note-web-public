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
 * Notebooks store — manages notebook CRUD.
 * Notebook definitions are stored as an encrypted "system note" (item_type=10)
 * so they sync across devices via the same E2EE pipeline.
 * localStorage is used as a fast cache; server is the source of truth.
 */

import { createSignal } from 'solid-js';
import { apiRequest } from '../lib/apiClient';
import { ASK_AGAIN_AFTER_MS, askTwice } from '../lib/askTwice';
import {
  encryptNote, decryptNote, isCryptoReady,
  generateContentKey, wrapContentKeyWithVault, encryptWithContentKey,
  unwrapContentKeyWithVault, decryptWithContentKey,
  decryptNoteWithRecoveredVault, vaultKeyThatOpens,
} from '../lib/crypto';
import { extrasFrom } from '../lib/metadataBlob';
import { mergeMetadata, type MergeableMetadata } from '../lib/metadataMerge';
import {
  ITEM_TYPE_NOTEBOOK, membersFrom, mergeNotebookContent, notebookContentFrom,
  notebookGrantFrom, notebookItemContent, notebooksMissingItems,
  type NotebookMember,
} from '../lib/notebookItem';
import {
  carriedLists, carriedRecords, fieldsToRestore, keptKeys, notebooksToAdd, recordState,
  withCarriedList, withCarriedRecord, withKeptKey, withoutCarriedLists, withoutCarriedRecords, withoutKeptKeys,
  type EarlierRecord, type KeptKey, type RecordState, type Sealed,
} from '../lib/notebookRepair';
import { parseRemembered, rememberedAcceptances, staleAcceptances, withAccepted, withoutAccepted } from '../lib/notebookInvites';
import {
  sanitizeOverrides, withMode, gcOverrides, clearOverrides,
  type EditorMode, type ModeOverrides,
} from '../lib/editorModeOverrides';
import { getTabAccount, isAccountStop, onTabAccountChange, scopedGetItem, scopedRemoveItem, scopedSetItem, tryCanonicalAccountId } from '../lib/account';
import { registerOwnNotebookCheck } from '../lib/ownNotes';

export interface Notebook {
  id: string;
  name: string;
  noteCount: number;
}

/** Recipient who has standing access to every note in a given notebook.
 *  Stored in the owner's encrypted metadata so we can auto-share new
 *  notes added to the notebook without re-prompting for their email. */
export interface NotebookShareRecipient {
  email: string;
  permission: 'edit' | 'view';
  /** Cached X25519 sharing public key (hex or base64). Cache avoids a
   *  server lookup each time we wrap a new note's content key. If the
   *  key has rotated, the wrap still succeeds but the recipient won't
   *  be able to open the note — next share action does a fresh lookup. */
  publicKey: string | null;
  /** Cached recipient user_id (UUID). Needed for the wrap signature, whose
   *  canonical sig_input includes the recipient's UUID. Set when the cache was
   *  last filled by a /users/public-keys lookup; null on entries written
   *  before the field existed — those wraps are sent unsigned. */
  userId?: string | null;
  /** Cached recipient Ed25519 signing pubkey (hex). Used for TOFU pin
   *  and SAS display; not strictly needed to send a signed wrap, but
   *  having it cached avoids a second lookup. */
  signingPublicKey?: string | null;
}

interface UserMetadata {
  notebooks: { id: string; name: string }[];
  labelColors: Record<string, string>;  // label → color hex
  /** notebookId → recipients that should receive every note in this
   *  notebook. Populated by the Share panel when sharing a notebook. */
  notebookShares?: Record<string, NotebookShareRecipient[]>;
  /** noteId → the editor mode that note is pinned to. Absent means the note
   *  follows the global setting. Lives HERE and never in the note body,
   *  because the body syncs to collaborators and `/shared/:token` readers —
   *  a view preference stored there would impose one reader's choice on
   *  everyone, and writing it would bump `updated_at` and reorder the notes
   *  list just because someone looked at a note. */
  editorModes?: Record<string, EditorMode>;
  /**
   * Notebook ids this user has accepted an invitation to.
   *
   * Being added to a shared notebook is being enrolled in a place other people
   * keep putting notes in, so it is offered rather than imposed. The decision
   * is the recipient's own view of their own account — nobody else's business
   * — which is why it lives in their encrypted metadata and not in a server
   * column or the owner's roster.
   */
  acceptedNotebooks?: string[];
  /**
   * Lists from before a password reset that no key opened when this one was
   * written over them (lib/notebookRepair). Opaque until a recovery key opens
   * them, and then merged back. Held as an extra like any unknown field.
   */
  beforeReset?: unknown;
  /** Rebuilt notebooks' records as they were before (lib/notebookRepair). */
  rebuiltNotebooks?: unknown;
  /** Rescued notes' old key wraps, for their attachments (lib/noteRescue). */
  rescuedNotes?: unknown;
  /**
   * The people and acceptances set aside when the list turned out locked
   * (`unconfirmed`), kept with the list until the server confirms them
   * ([notebooksStore.confirmHeldPeople]). In memory only, they would be lost
   * at the first reload after a write without them.
   */
  heldAside?: unknown;
}

const CACHE_KEY = 'pingolin_note_metadata';
const ITEM_TYPE_METADATA = 10; // Reserved item type for user metadata

/**
 * Notebook items that exist on the server, id -> version. Filled on every sync
 * scan. The version is what makes a rename possible: `PUT /items/{id}` takes
 * `expected_version`, so without it the item's title would drift out of step
 * with the metadata blob — and android renders a web notebook from the ITEM
 * once one exists, so a stale title there is a visible wrong name, not a
 * harmless inconsistency.
 */
let knownNotebookItems: Map<string, number> = new Map();
/** Notebooks the server answered "no such item" for, on this page (`notebookItemState`). */
const notebooksWithNoItem = new Set<string>();
/** Lookups under way, so that two saves into one notebook ask once. */
const notebookItemLookups = new Map<string, Promise<void>>();
/** Notebook item id -> the account it belongs to, as the server's rows say. */
const notebookItemOwners = new Map<string, string>();

/**
 * The server's list row when no key this page holds opens it: a list from
 * before a password reset (lib/notebookRepair). Not adopted, there being
 * nothing to read, and not lost: what this page writes goes over it and
 * CARRIES it (`beforeReset`, [currentBlob]), and a recovery key used later
 * merges it back ([notebooksStore.mergeBackEarlierLists]).
 */
let lockedListRow: { id: string; version: number; sealed: Sealed } | null = null;
/** The list on the server opened only with a key recovered from before a
 *  reset: it is to be written again under this identity's. */
let listOpenedWithRecoveredKey = false;

/**
 * The list from a server row: with this identity's key, else with one
 * recovered from before a reset (`recovered`). Null when nothing here opens
 * it, or what opens is not a list.
 */
function openList(row: { encrypted_content: string; content_nonce: string }): { meta: UserMetadata; recovered: boolean } | null {
  const sealed = { nonce: row.content_nonce, ciphertext: row.encrypted_content };
  const read = (plaintext: string): UserMetadata | null => {
    const parsed = JSON.parse(plaintext) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UserMetadata : null;
  };
  try {
    const meta = read(decryptNote(sealed));
    if (meta) return { meta, recovered: false };
  } catch { /* not with this identity's key */ }
  try {
    const plaintext = decryptNoteWithRecoveredVault(sealed);
    const meta = plaintext === null ? null : read(plaintext);
    if (meta) return { meta, recovered: true };
  } catch { /* nor with one from before */ }
  return null;
}

/**
 * People and acceptances this page held when the server's list turned out
 * locked (from before a password reset): set aside, not written and not
 * sealed to, until the server confirms them (`confirmHeldPeople`). This
 * browser's copy may be older than the list the reset locked: someone taken
 * off a notebook, or an invitation declined, on another device since would
 * come back for every device with the first write over it. Per account;
 * null when nothing is set aside.
 */
let unconfirmed: { shares: Record<string, NotebookShareRecipient[]>; accepted: string[] } | null = null;

/**
 * What a list says was set aside (`heldAside`), as this page holds it: null
 * when it says nothing, or nothing it says reads as people or notebooks.
 */
function heldAsideFrom(meta: UserMetadata): typeof unconfirmed {
  const held = meta.heldAside as { shares?: unknown; accepted?: unknown } | undefined;
  if (!held || typeof held !== 'object') return null;
  const shares: Record<string, NotebookShareRecipient[]> = {};
  if (held.shares && typeof held.shares === 'object' && !Array.isArray(held.shares)) {
    for (const [id, people] of Object.entries(held.shares as Record<string, unknown>)) {
      if (!Array.isArray(people)) continue;
      const kept = people.filter((p): p is NotebookShareRecipient => !!p && typeof p === 'object' && typeof (p as { email?: unknown }).email === 'string');
      if (kept.length > 0) shares[id] = kept;
    }
  }
  const accepted = Array.isArray(held.accepted) ? held.accepted.filter((id): id is string => typeof id === 'string') : [];
  return Object.keys(shares).length > 0 || accepted.length > 0 ? { shares, accepted } : null;
}

/** `emails` taken off a notebook on this page: not put back as set aside either. */
function dropFromUnconfirmed(notebookId: string, emails: readonly string[]): void {
  if (!unconfirmed?.shares[notebookId]) return;
  const gone = new Set(emails.map(e => e.toLowerCase()));
  const left = unconfirmed.shares[notebookId].filter(p => !gone.has(p.email.toLowerCase()));
  const shares = { ...unconfirmed.shares };
  if (left.length > 0) shares[notebookId] = left;
  else delete shares[notebookId];
  unconfirmed = Object.keys(shares).length > 0 || unconfirmed.accepted.length > 0 ? { shares, accepted: unconfirmed.accepted } : null;
}
/** Set aside once per account: a second hold (after a write) must not set aside what was confirmed since. */
let setAsideDone = false;

/**
 * Take the server's list row as one no key here opens: remember it, and write
 * over it from now on (carrying it). The merge base goes, whatever the version:
 * a reset changes keys, not the row's version, and a base from before it reads
 * every notebook missing from another device's list as deleted there — so when
 * a fresh device writes the list first, the browser that held the account
 * would drop every notebook from before the reset.
 */
function holdLockedList(row: { id: string; version: number; encrypted_content: string; content_nonce: string }) {
  lockedListRow = { id: row.id, version: row.version, sealed: { ciphertext: row.encrypted_content, nonce: row.content_nonce } };
  // The base in memory as well as the one kept: the merge reads `lastServerMeta`.
  lastServerMeta = null;
  dropBase();
  // What is set aside below, and notebooks kept from their items while the list
  // is locked, would read as this page's own changes in a merge: a change made
  // before this list is not merged ([unsent]).
  sessionStartBlob = null;
  unsent = null;
  maybeLanded = null;
  metadataItemId = row.id;
  metadataVersion = row.version;
  if (!setAsideDone) {
    setAsideDone = true;
    const shares = notebookShares();
    const accepted = acceptedNotebooks();
    if (Object.keys(shares).length > 0 || accepted.length > 0) {
      // People are taken off the list in memory too: it is what a new note is
      // sealed to. Acceptances stay (they decide which notes show, and showing
      // is not sharing) but are not written until confirmed (currentBlob).
      unconfirmed = { shares, accepted };
      setNotebookShares({});
    }
  }
}
/** Notebooks deleted on this page: a lookup that answers afterwards records nothing of them. */
const notebooksRemovedHere = new Set<string>();
/**
 * How many accounts this page has held (`reset` moves it on). A lookup started
 * for one account records nothing once another has taken the page.
 */
let lookupEpoch = 0;

/** What the server has for a notebook id (`notebooksStore.notebookItemState`). */
export type NotebookItemState =
  /** A live notebook item: the notebook may be named to the server. */
  | 'item'
  /** No item, a trashed one, or not a notebook: it must not be named (the server requires
   * a note's notebook to be an existing item).
   */
  | 'none'
  /** The server could not be asked. NOT "none": see the callers. */
  | 'unknown';

/**
 * Has a COMPLETE scan of this account's notebook items been seen this session?
 *
 * Only a full pull (no stored cursor) that ran to its last page can tell us
 * which notebooks genuinely have no item. An incremental page says nothing
 * about the notebooks it did not mention, so a backfill decided on one is not
 * a repair — it is a create per notebook against ids the server already has.
 * Set by [markNotebookItemsComplete], read only by [backfillNotebookItems].
 */
let knownNotebookItemsComplete = false;

/**
 * Notebook id -> its wrapped content key, as returned by sync. Wrapped under
 * the vault, so only the owner can open it — which is exactly the point: it is
 * how the owner re-seals a notebook to a member without rotating the key, and
 * how a rename keeps the key its members already hold.
 */
const notebookWraps = new Map<string, { key: string; nonce: string }>();

/**
 * Notebook id -> its roster, read from the item's encrypted content on sync.
 *
 * Held because a rename rewrites the WHOLE content document: without carrying
 * the members forward, renaming a shared notebook would silently empty its
 * roster and orphan everyone in it.
 */
const notebookMembers = new Map<string, NotebookMember[]>();

/** The roster for a notebook, or empty if it has none / could not be read. */
function membersOf(notebookId: string): NotebookMember[] {
  return notebookMembers.get(notebookId) ?? [];
}

/**
 * Which key opened a notebook here: 'vault' when its cached wrap opens
 * with our vault, which makes the notebook ours; otherwise null.
 *
 * Nothing here produces 'share': this browser reads a notebook's roster only
 * through its vault (loadFromSyncedItems), never through a share. A member's
 * roster, if one is ever read here, must come with 'share', and only then may
 * the inbox name the notebook's owner (notes.ts notebookNoteRecipients).
 */
function notebookOpenedVia(id: string): 'vault' | 'share' | null {
  const wrap = notebookWraps.get(id);
  if (!wrap || !isCryptoReady()) return null;
  const key = unwrapContentKeyWithVault(wrap.key, wrap.nonce);
  if (!key) return null;
  key.fill(0);
  return 'vault';
}

/**
 * The canonical form of a notebook's id, worked out once per id. The inbox
 * asks the question below once per share; canonicalising every notebook's id
 * again for each one would cost, with 10,000 shares and 20 notebooks, 200,000
 * conversions per sync. What an id's canonical form is never changes, so
 * nothing here can go stale: which notebooks there are, and which key opens
 * each, are still asked every time.
 */
const canonicalNotebookIds = new Map<string, string | null>();
function canonicalNotebookId(nbId: string): string | null {
  let canonical = canonicalNotebookIds.get(nbId);
  if (canonical === undefined) {
    canonical = tryCanonicalAccountId(nbId);
    canonicalNotebookIds.set(nbId, canonical);
  }
  return canonical;
}

/** The inbox refuses a share naming a notebook this browser opened as its own.
 * Ids compare canonically, so another spelling of it is refused too. */
registerOwnNotebookCheck((itemId) => {
  const id = tryCanonicalAccountId(itemId);
  if (id === null) return false;
  for (const nbId of notebookWraps.keys()) {
    if (canonicalNotebookId(nbId) === id && notebookOpenedVia(nbId) === 'vault') return true;
  }
  return false;
});

/**
 * The last-known decrypted content of each notebook item.
 *
 * Every write to a notebook rewrites the WHOLE document, so anything not
 * carried forward is destroyed. Rebuilding from `notebookItemContent` keeps
 * only the fields THIS client knows about: an android notebook's `edit_mode`
 * would vanish and its `color` would be reset to null, just from someone
 * sharing or renaming it on web. Keeping the document we last read lets writes
 * change the roster and the title and leave the rest exactly as found.
 */
const notebookContents = new Map<string, Record<string, unknown>>();

/**
 * The document to write for a notebook, with `changes` applied over whatever
 * this client last read.
 *
 * With no known content — never opened here — this falls back to a fresh
 * document. That is the honest choice: merging over a base we never read would
 * be inventing one.
 */
function contentToWrite(
  notebookId: string,
  name: string,
  members: NotebookMember[],
): Record<string, unknown> {
  const base = notebookContents.get(notebookId);
  return base
    ? mergeNotebookContent(base, { title: name, members })
    : notebookItemContent(name, members) as unknown as Record<string, unknown>;
}

let metadataItemId: string | null = null;
let metadataVersion: number = 0;
/**
 * The last blob this client saw on the server, decoded: the BASE of the
 * three-way merge a version conflict needs. Set from a sync, an acknowledged
 * write, or the re-read a 409 triggers — never from a write that failed. The
 * localStorage cache is not usable for this: it is saved after every attempt,
 * successful or not.
 */
let lastServerMeta: UserMetadata | null = null;

/**
 * That base, kept per account across loads. Without it every session starts
 * with no base: a write built before the first sync (a resume's hold, a
 * pruned acceptance) POSTs, meets the existing row's 409, and merges with
 * nothing to compare, so every entry in the stale cache reads as a local
 * addition and someone ANOTHER device had removed is written back. Saved only
 * when the base comes from the server (a sync's adopt, a write that landed, a
 * 409's re-read), dropped with the row ('gone'), and swept with the metadata
 * cache (account.ts ACCOUNT_SCOPED_STORES).
 */
const BASE_KEY = 'pingolin_note_metadata_base';

/** A base came from the server, saved or this session; without one no write is
 *  built before this session's first pull (see [persistToServerLocked]). */
let baseKnown = false;
/** Has this session finished a pull? Set by the sync (markPulled). */
let pulledThisSession = false;
/** Has this session finished a FULL pull, every row of the account's to its
 *  last page, the trash included? Set by the sync (markFullyPulled). */
let fullyPulledThisSession = false;
/** A write held back for that pull. */
let writeWaitsForPull = false;
/**
 * The cache as this session first read it, kept while no base is known. A
 * change made before the first pull lives only in the signals and the cache,
 * and adopting the row that pull brings replaces them: the change would be
 * lost, and the held write would send the server's own blob back. Against this
 * blob as base, that adoption merges the change over the row instead
 * (loadFromSyncedItems), so what another device removed stays removed. Dropped
 * once a base is known: a merge against it then would read everything synced
 * since as this session's own.
 */
let sessionStartBlob: UserMetadata | null = null;
/**
 * Changes in the signals the server has not confirmed, and the server state they
 * sit on. Every row this page sees, adopted from a sync or re-read at a conflict,
 * would otherwise REPLACE them (a sync while a write is on its way, a write that
 * failed, a first pull with no base), or be merged against a state they do not
 * sit on (a conflict after a sync moved the base: what that row removed came
 * back). So the current signals are merged over each such row against `base`,
 * and the row becomes `base`. Null when nothing is unconfirmed. In memory only:
 * a reload starts again from the cache and the saved base.
 */
let unsent: { base: UserMetadata | null } | null = null;
/** A write whose answer never came (5xx, no answer): it may have landed. Written
 *  against `expectedVersion` (0: a create). Settled at the first row seen that
 *  is newer ([mergeUnsentOver]). */
let maybeLanded: { blob: UserMetadata; expectedVersion: number } | null = null;
/** Bumped by every write asked for (persistToServer): a write built after the
 *  last bump carries every change made so far. */
let writesAsked = 0;
/** Writes asked for and not yet through persistToServerLocked (queued, or on
 *  their way). One of them sends whatever the signals hold when it is built. */
let writesPending = 0;

/** The blob as JSON with keys sorted and the modelled fields defaulted: two
 *  blobs that say the same thing compare equal. */
function canonicalBlob(meta: UserMetadata): string {
  const norm = {
    ...meta,
    notebooks: (meta.notebooks ?? []).map(nb => ({ id: nb.id, name: nb.name })),
    labelColors: meta.labelColors ?? {},
    notebookShares: meta.notebookShares ?? {},
    editorModes: meta.editorModes ?? {},
    acceptedNotebooks: meta.acceptedNotebooks ?? [],
  };
  return JSON.stringify(norm, (_k, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
    : v);
}

/**
 * The signals merged over a row the server holds now (`server`, at `version`),
 * against the state the unconfirmed changes sit on ([unsent]). A write whose
 * answer never came is settled here first. Landed, it IS the version after the
 * one it expected (a create's is 1: one lands only where no row is):
 *   - The row is that write: it landed, and the row is the state.
 *   - The row is that version, and not that write: it did not land.
 *   - The row is later: unknown. It landed and another device wrote over it,
 *     or it did not and others wrote (rare: it was asked again at once,
 *     [persistToServerLocked]). An update is taken as landed, as a 5xx after
 *     the server took the write is the usual lost answer: what another device
 *     removed since stays removed. A create is taken as not landed: the row it
 *     meets was most likely there before it. Either way the people on a
 *     notebook's list and the accepted notebooks are those both readings keep,
 *     with the lower of the two rights ([sharedByBoth]): this can only lower
 *     what is shared.
 *   - The row is older (a sync page read before the write): it settles
 *     nothing, and the write is settled at a later row.
 */
function mergeUnsentOver(server: UserMetadata, version: number): UserMetadata {
  const merge = (base: UserMetadata | null) => mergeMetadata(
    base as MergeableMetadata | null, currentBlob() as MergeableMetadata, server as MergeableMetadata,
  ) as UserMetadata;
  const notLanded = unsent ? unsent.base : null;
  const pending = maybeLanded && version > maybeLanded.expectedVersion ? maybeLanded : null;
  if (!pending) return merge(notLanded);
  maybeLanded = null;
  if (canonicalBlob(server) === canonicalBlob(pending.blob)) return merge(server);
  if (version < pending.expectedVersion + 2) return merge(notLanded);
  return pending.expectedVersion > 0
    ? sharedByBoth(merge(pending.blob), merge(notLanded))
    : sharedByBoth(merge(notLanded), merge(pending.blob));
}

/** `taken`, its people on each notebook's list and its accepted notebooks cut
 *  down to those `other` has too; a person either reading lets only view, views. */
function sharedByBoth(taken: UserMetadata, other: UserMetadata): UserMetadata {
  const shares: Record<string, NotebookShareRecipient[]> = {};
  for (const [id, list] of Object.entries(taken.notebookShares ?? {})) {
    const there = new Map((other.notebookShares?.[id] ?? []).map(r => [String(r.email).toLowerCase(), r]));
    const kept = list.flatMap(r => {
      const o = there.get(String(r.email).toLowerCase());
      if (!o) return [];
      return [o.permission === 'view' && r.permission !== 'view' ? { ...r, permission: 'view' as const } : r];
    });
    if (kept.length > 0) shares[id] = kept;
  }
  const accepted = new Set(other.acceptedNotebooks ?? []);
  return {
    ...taken,
    notebookShares: shares,
    acceptedNotebooks: (taken.acceptedNotebooks ?? []).filter(id => accepted.has(id)),
  };
}
/** Waiting on this session's pulls (nextPullEvent): woken by every finished
 * pull and by every reset, so a waiter whose session ended re-checks rather
 * than waits on for good. */
let pullWaiters: Array<() => void> = [];

function wakePullWaiters() {
  const waiting = pullWaiters;
  pullWaiters = [];
  for (const wake of waiting) wake();
}

function saveBase() {
  if (!metadataItemId || !lastServerMeta) return;
  baseKnown = true;
  sessionStartBlob = null;
  try {
    scopedSetItem(BASE_KEY, JSON.stringify({ id: metadataItemId, version: metadataVersion, blob: lastServerMeta }));
  } catch { /* quota: this session still has it in memory */ }
}

function dropBase() {
  baseKnown = false;
  scopedRemoveItem(BASE_KEY);
}

/** Adopt the saved base, if this account has one that reads whole. */
function loadBase() {
  try {
    const raw = scopedGetItem(BASE_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved.id === 'string' && typeof saved.version === 'number'
        && saved.blob && typeof saved.blob === 'object') {
      metadataItemId = saved.id;
      metadataVersion = saved.version;
      lastServerMeta = saved.blob as UserMetadata;
      baseKnown = true;
      return;
    }
  } catch { /* unreadable: treated as none */ }
  baseKnown = false;
}

function loadCache(): UserMetadata {
  try {
    const raw = scopedGetItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { notebooks: [], labelColors: {} };
}

function saveCache(meta: UserMetadata) {
  scopedSetItem(CACHE_KEY, JSON.stringify(meta));
}

const [notebooks, setNotebooks] = createSignal<Notebook[]>(
  loadCache().notebooks.map(nb => ({ ...nb, noteCount: 0 }))
);
const [labelColors, setLabelColors] = createSignal<Record<string, string>>(
  loadCache().labelColors
);
const [notebookShares, setNotebookShares] = createSignal<Record<string, NotebookShareRecipient[]>>(
  loadCache().notebookShares ?? {}
);
const [editorModes, setEditorModes] = createSignal<ModeOverrides>(
  sanitizeOverrides(loadCache().editorModes)
);
const [acceptedNotebooks, setAcceptedNotebooks] = createSignal<string[]>(
  loadCache().acceptedNotebooks ?? []
);

/**
 * The acceptances THIS DEVICE remembers, beside the shared list above and
 * never written into it (lib/notebookInvites, "the acceptance this device
 * remembers"): a notebook seen accepted here keeps its notes on screen when
 * another client empties the shared list.
 */
const SEEN_ACCEPTED_KEY = 'pingolin_note_seen_accepted';
function loadSeenAccepted(): string[] {
  try { return parseRemembered(scopedGetItem(SEEN_ACCEPTED_KEY)); } catch { return []; }
}
const [seenAccepted, setSeenAccepted] = createSignal<string[]>(loadSeenAccepted());
/** This tab's last write of the memory reached the store (see `keepSeenAccepted`). */
let seenAcceptedStored = true;
function keepSeenAccepted(next: string[]): void {
  const now = seenAccepted();
  if (next.length === now.length && next.every(id => now.includes(id))) return;
  // What THIS tab learned and forgot since it last looked, applied to what is
  // stored now. Another tab shares the store: writing this tab's whole list
  // would put back a notebook the other tab had just forgotten on a decline
  // (`saveFloors` in the inbox store reads again first for the same reason).
  const learned = next.filter(id => !now.includes(id));
  const forgotten = now.filter(id => !next.includes(id));
  // The store is the base while this tab's writes reach it. Once one has
  // failed (a full or forbidden storage), what this page holds is all there is.
  const base = seenAcceptedStored ? loadSeenAccepted() : now;
  const merged = [...new Set([...base, ...learned])].filter(id => !forgotten.includes(id));
  setSeenAccepted(merged);
  // Unwritable storage costs the memory at the next load, not this page's.
  try {
    scopedSetItem(SEEN_ACCEPTED_KEY, JSON.stringify(merged));
    seenAcceptedStored = true;
  } catch {
    seenAcceptedStored = false;
  }
}
/**
 * The shared list has just been READ here (from this account's cache, or from
 * the server): everything on it is now something this device has seen
 * accepted. It learns at once and forgets nothing: forgetting takes a list
 * from the inbox (`rememberAcceptances`). Learning only at the next sync would
 * leave a new browser with nothing remembered between its first sync and its
 * second.
 */
function sawAccepted(list: readonly string[]): void {
  keepSeenAccepted(rememberedAcceptances(seenAccepted(), list, null));
}

// The cache is per account: read it again once the tab's account is
// confirmed, or changes.
onTabAccountChange((id) => {
  // Holds belong to the account whose removals they are (heldRemovals). With
  // no account there are none to wait for; a read in flight is another's.
  clearHolds();
  const read = armHoldsGate();
  if (id === null) openHoldsGateFor(read);
  metadataItemId = null;
  metadataVersion = 0;
  lastServerMeta = null;
  lockedListRow = null;
  listOpenedWithRecoveredKey = false;
  notebookItemOwners.clear();
  pulledThisSession = false;
  fullyPulledThisSession = false;
  writeWaitsForPull = false;
  wakePullWaiters();
  loadBase();
  const cache = loadCache();
  // A copy of its own: the signals below are seeded from `cache`.
  sessionStartBlob = baseKnown ? null : loadCache();
  unsent = null;
  maybeLanded = null;
  // From this account's cache, like the signals: read at module load, before
  // an account is confirmed, the cache reads as empty, and a blob written
  // without these fields deletes them from the server.
  extras = extrasFrom(cache, KNOWN_METADATA_KEYS);
  setNotebooks(cache.notebooks.map(nb => ({ ...nb, noteCount: 0 })));
  setLabelColors(cache.labelColors);
  setNotebookShares(cache.notebookShares ?? {});
  setEditorModes(sanitizeOverrides(cache.editorModes));
  setAcceptedNotebooks(cache.acceptedNotebooks ?? []);
  setSeenAccepted(loadSeenAccepted());
  seenAcceptedStored = true;
  sawAccepted(cache.acceptedNotebooks ?? []);
});
/**
 * Keys this client owns in the metadata blob. Anything else that arrives is
 * another client's field and must survive our next save — see `extras`.
 *
 * Kept in sync with the encode site immediately below (`persistToServer`'s
 * `meta` literal). A key written there but missing here would be duplicated
 * into extras and written twice.
 */
const KNOWN_METADATA_KEYS: ReadonlySet<string> = new Set([
  'notebooks', 'labelColors', 'notebookShares', 'editorModes', 'acceptedNotebooks', 'heldAside',
]);

/**
 * Everything the blob carried that this build does not model, kept verbatim.
 *
 * There is ONE metadata item per user and every client rewrites the whole
 * thing. Rebuilding it from only the fields this version knows about deletes a
 * newer client's data on the next notebook or label-colour edit — which is
 * precisely how `editorModes` would disappear for anyone whose phone and
 * browser are on different release trains. The same hazard exists one level
 * down for the note CONTENT json, which `extrasFrom` in stores/notes.ts guards
 * against.
 */
let extras: Record<string, unknown> = {};
// Seeded from the cache, which is a copy of the last blob we saw and so the
// best source of extras before the first sync of a session lands.
extras = extrasFrom(loadCache(), KNOWN_METADATA_KEYS);

/**
 * Serialises `persistToServer`. Every write is a read-modify-write of ONE
 * shared row, and the create branch is chosen on `metadataItemId` being null —
 * so two calls that overlap before the first POST resolves BOTH see null and
 * BOTH create a row. There are a dozen call sites here and several fire in
 * bursts (a rename that also recolours, an import), so overlapping is the
 * normal case rather than the exotic one. Once an account has more than one
 * row, every client rotates between them and loses notebooks, label colours
 * and share recipients at random.
 *
 * A tail promise rather than a lock: each call waits for the one before it, so
 * the second write sees the id the first stored. The tail is kept RESOLVED —
 * a failed write must not wedge every later one, and every call site here is
 * fire-and-forget, so a rejected tail would surface as an unhandled rejection
 * rather than reaching anyone who could act on it. Logged in the same shape as
 * the decrypt failure below.
 */
let persistTail: Promise<void> = Promise.resolve();

function persistToServer(): Promise<void> {
  writesAsked++;
  // From here the signals hold a change the server has not confirmed. It sits on
  // the base, or with none yet on the cache this session started from; with
  // neither (a list no key here opens) it is not tracked ([unsent]).
  if (!unsent) {
    const base = lastServerMeta ?? sessionStartBlob;
    if (base) unsent = { base };
  }
  writesPending++;
  persistTail = persistTail
    .then(persistToServerLocked, persistToServerLocked)
    .catch(e => { console.warn('Failed to persist metadata:', e); })
    .finally(() => { writesPending--; });
  return persistTail;
}

/** The blob as this client would write it now. A list no key here opens, on
 *  the server, goes into it too (`beforeReset`): see [lockedListRow]. */
function currentBlob(): UserMetadata {
  const carried = lockedListRow ? { beforeReset: withCarriedList(extras.beforeReset, lockedListRow.sealed) } : {};
  return {
    ...extras,
    ...carried,
    notebooks: notebooks().map(nb => ({ id: nb.id, name: nb.name })),
    labelColors: labelColors(),
    notebookShares: notebookShares(),
    editorModes: editorModes(),
    // Not one set aside at a locked list and still unconfirmed.
    acceptedNotebooks: unconfirmed
      ? acceptedNotebooks().filter(id => !unconfirmed!.accepted.includes(id))
      : acceptedNotebooks(),
    // Kept with the list until confirmed.
    ...(unconfirmed ? { heldAside: { shares: unconfirmed.shares, accepted: unconfirmed.accepted } } : {}),
  };
}

/**
 * People taken off a notebook's standing share list whom the server may still
 * list there: notebook id -> lower-cased addresses.
 *
 * The standing list seals every NEW note in a notebook to its people, so a
 * removal from it must stand at every stop. But this client's list is REPLACED
 * by the server's at a sync (loadFromSyncedItems) and MERGED with it when a
 * write conflicts (rebaseOnto) — and a merge with no base, the first write
 * after a start, keeps every entry the server has. Until a write without them
 * lands, the server's older list would put them back. So every list adopted
 * from the server leaves the held people out, and a hold ends only when a
 * write that leaves them out succeeds, or when the owner adds them back.
 *
 * In memory only: a start holds them again from each outstanding re-key job
 * ([holdRemovals], from rekeyDrain), and the job is kept until the hold ends.
 */
const heldRemovals = new Map<string, Set<string>>();
/** Bumped whenever the holds are dropped wholesale (a sign-out, another account),
 *  so a hold that went that way never reads as a write that landed. */
let holdEpoch = 0;

function clearHolds() {
  heldRemovals.clear();
  holdEpoch++;
}

/**
 * The holds gate. The holds come from the sealed re-key jobs, which a
 * sign-out does not delete; until they are read for the signed-in account,
 * no list may be adopted from the server, or the first sync would put back the
 * very people a job is still taking off. Closed whenever an account is
 * confirmed or a read of its jobs begins ([beginHoldsRead]: at the start, and
 * whenever its keys arrive). Every adopt waits for it ([holdsReady]): the sync
 * (notes.ts, before its first page), a write's merge (persistToServerLocked)
 * and the restore (restoreStandingShares).
 *
 * Only the read begun LAST opens it: one begun before it may have read
 * older jobs, so it neither holds nor opens. And while closed the gate is ONE
 * promise, however often it is closed again: replacing it would leave
 * everything already waiting (the sync, and the whole write queue behind
 * persistToServerLocked) waiting until a reload.
 */
let holdsGate: Promise<void> = Promise.resolve();
/** Opens the gate; null while it is open. */
let releaseGate: (() => void) | null = null;
/** The read the gate waits for: a new one at every arm. */
let holdsRead = 0;

function armHoldsGate(): number {
  if (!releaseGate) holdsGate = new Promise<void>(resolve => { releaseGate = resolve; });
  return ++holdsRead;
}

/** Open the gate for `read`, unless a read has begun since. */
function openHoldsGateFor(read: number) {
  if (read !== holdsRead || !releaseGate) return;
  const release = releaseGate;
  releaseGate = null;
  release();
}

/** Until the gate is open: a waiter woken as it opened, then closed again, waits again. */
async function holdsReady(): Promise<void> {
  while (releaseGate) await holdsGate;
}

/** One read of the signed-in account's re-key jobs ([beginHoldsRead]). */
export interface HoldsRead {
  /** No read has begun since this one. */
  latest(): boolean;
  /**
   * The jobs were read: hold every person each one removes (in memory, no
   * write: the drains write), take them off the lists held now, and open the
   * gate. Nothing, if a read has begun since.
   */
  loaded(jobs: readonly { notebookId: string; removedRecipients: readonly string[] }[]): void;
  /** Nothing to hold (none could be read, or no one is signed in): open the gate,
   *  unless a read has begun since. */
  open(): void;
}

/** `shares` without anyone held off; a list left empty goes, as a removal leaves it. */
function withoutHeld(shares: Record<string, NotebookShareRecipient[]>): Record<string, NotebookShareRecipient[]> {
  if (heldRemovals.size === 0) return shares;
  let changed = false;
  const out: Record<string, NotebookShareRecipient[]> = {};
  for (const [id, list] of Object.entries(shares)) {
    const held = heldRemovals.get(id);
    const kept = held && Array.isArray(list) ? list.filter(r => !held.has(String(r?.email).toLowerCase())) : list;
    if (kept === list || kept.length === list.length) { out[id] = list; continue; }
    changed = true;
    if (kept.length > 0) out[id] = kept;
  }
  return changed ? out : shares;
}

/** removeNotebookShare / holdRemovals. Everything up to the write runs at the
 *  call, so the list has changed before the caller's next step. */
async function takeOffStandingList(notebookId: string, emails: readonly string[]): Promise<boolean> {
  const wanted = emails.map(e => e.toLowerCase());
  dropFromUnconfirmed(notebookId, wanted);
  const epoch = holdEpoch;
  const held = heldRemovals.get(notebookId) ?? new Set<string>();
  for (const e of wanted) held.add(e);
  if (held.size > 0) heldRemovals.set(notebookId, held);
  setNotebookShares(prev => withoutHeld(prev));
  // Written even when the list here already lacks them: an earlier write of
  // the removal may never have reached the server.
  await persistToServer();
  if (holdEpoch !== epoch) return false;
  const still = heldRemovals.get(notebookId);
  return !wanted.some(e => still?.has(e));
}

/** A write of `meta` landed: end every hold it leaves out. */
function releaseHeld(meta: UserMetadata) {
  for (const [id, held] of heldRemovals) {
    const listed = new Set((meta.notebookShares?.[id] ?? []).map(r => String(r?.email).toLowerCase()));
    for (const email of [...held]) if (!listed.has(email)) held.delete(email);
    if (held.size === 0) heldRemovals.delete(id);
  }
}

/** Adopt a blob into the signals — what a sync does, and what a merge does. */
function applyBlob(meta: UserMetadata) {
  setNotebooks((meta.notebooks ?? []).map(nb => ({ ...nb, noteCount: 0 })));
  setLabelColors(meta.labelColors ?? {});
  setNotebookShares(withoutHeld(meta.notebookShares ?? {}));
  setEditorModes(sanitizeOverrides(meta.editorModes));
  setAcceptedNotebooks(Array.isArray(meta.acceptedNotebooks) ? meta.acceptedNotebooks : []);
  sawAccepted(acceptedNotebooks());
  extras = extrasFrom(meta, KNOWN_METADATA_KEYS);
}

type WriteOutcome = 'ok' | 'conflict' | 'exists' | 'gone' | 'unanswered' | 'failed';

/**
 * A list write landed: the row is now this identity's, written whole. A locked
 * list it went over is carried in it now, so it is held as an extra like any
 * other, and a list that had opened only with a recovered key is no longer one.
 */
function landed(meta: UserMetadata) {
  lockedListRow = null;
  listOpenedWithRecoveredKey = false;
  if ('beforeReset' in meta) extras = { ...extras, beforeReset: meta.beforeReset };
}

/** A write of `meta`, built when `asked` writes had been asked for, landed: what
 *  it carried is confirmed. All of it, unless a write was asked for since: that
 *  change sits on `meta` now ([unsent]). */
function confirmed(meta: UserMetadata, asked: number) {
  maybeLanded = null;
  if (unsent) unsent = asked === writesAsked ? null : { base: meta };
}

/** Whether a write of `meta` got no answer it can be read by: none at all, or a
 *  5xx, which a proxy may send after the server took the write. It may have
 *  landed ([maybeLanded]); any other answer is the server's no. */
function unanswered(meta: UserMetadata, expectedVersion: number, status: number | undefined): boolean {
  if (status !== undefined && status < 500) return false;
  // Only while changes are tracked: settled at a merge against [unsent], and
  // left over from an untracked write, it would settle a later one wrongly.
  // Nor one sent at an older version than a write still unsettled (after a
  // sync page from before it): the row was past that version, so it cannot
  // have landed.
  if (unsent && !(maybeLanded && expectedVersion < maybeLanded.expectedVersion)) {
    maybeLanded = { blob: meta, expectedVersion };
  }
  return true;
}

/** One PUT (row known) or POST (row unknown) of `meta`. */
async function writeBlob(meta: UserMetadata): Promise<WriteOutcome> {
  // `meta` was built just before this call: every write asked for so far is in it.
  const asked = writesAsked;
  const expectedVersion = metadataItemId ? metadataVersion : 0;
  const encrypted = encryptNote(JSON.stringify(meta));
  if (metadataItemId) {
    const result = await apiRequest<{ version: number }>(`/api/v1/items/${metadataItemId}`, {
      method: 'PUT',
      body: {
        encrypted_content: encrypted.ciphertext,
        content_nonce: encrypted.nonce,
        expected_version: metadataVersion,
      },
    });
    if (result.success) {
      metadataVersion = result.data.version;
      lastServerMeta = meta;
      saveBase();
      releaseHeld(meta);
      landed(meta);
      confirmed(meta, asked);
      return 'ok';
    }
    if (result.status === 409) return 'conflict';
    // The row this client remembers no longer exists (purged, or the server
    // was restored to before it was created). Forget it and create.
    if (result.status === 404) return 'gone';
    // Refused here as another account's: it never left, and is never asked
    // again (lib/account).
    if (isAccountStop(result)) return 'failed';
    return unanswered(meta, expectedVersion, result.status) ? 'unanswered' : 'failed';
  }
  const result = await apiRequest<{ id: string; version: number }>('/api/v1/items', {
    method: 'POST',
    body: {
      item_type: ITEM_TYPE_METADATA,
      encrypted_content: encrypted.ciphertext,
      content_nonce: encrypted.nonce,
    },
  });
  if (result.success) {
    metadataItemId = result.data.id;
    metadataVersion = result.data.version;
    lastServerMeta = meta;
    saveBase();
    releaseHeld(meta);
    landed(meta);
    confirmed(meta, asked);
    return 'ok';
  }
  // The server keeps one live metadata row per user. Another device created it
  // first; this client's belief that it has none is simply stale.
  if (result.status === 409) return 'exists';
  if (isAccountStop(result)) return 'failed';
  return unanswered(meta, 0, result.status) ? 'unanswered' : 'failed';
}

interface ServerMetaRow { id: string; version: number; meta: UserMetadata }
type RawMetaRow = { id: string; version: number; encrypted_content: string; content_nonce: string };

/**
 * A server list row as this page can take it: opened (`ServerMetaRow`), or
 * `'locked'` when no key here opens it ([holdLockedList]). One opened only with
 * a recovered key is marked to be written again under this identity's.
 */
function decodeMetaRow(row: RawMetaRow): ServerMetaRow | 'locked' {
  const opened = openList(row);
  if (!opened) {
    console.warn('[note] the notebook list on the server opens with no key this page holds (from before a password reset?): it is kept inside the next one written');
    return 'locked';
  }
  if (opened.recovered) listOpenedWithRecoveredKey = true;
  return { id: row.id, version: row.version, meta: opened.meta };
}

/** The server's current copy of the row this client knows, raw. */
async function readServerMetaRow(): Promise<RawMetaRow | null> {
  if (!metadataItemId) return null;
  const r = await apiRequest<RawMetaRow & { deleted?: boolean }>(`/api/v1/items/${metadataItemId}`);
  if (!r.success || r.data.deleted) return null;
  return r.data;
}

/**
 * Find the metadata row the server holds that this client does not know
 * about: a paged pull from the epoch, keeping the newest live `item_type = 10`
 * row — the same scan android's UserMetadataStore.adoptServerMetadataRow does.
 * `/sync/pull` has no type filter, so this walks every item; it runs only on
 * a 409 from a create, which is rare, and never inside the write tail.
 */
async function findServerMetadataRow(): Promise<RawMetaRow | null> {
  let since = '1970-01-01T00:00:00Z';
  let sinceId: string | null = null;
  let newest: { id: string; version: number; encrypted_content: string; content_nonce: string; updated_at?: string } | null = null;
  for (let page = 0; page < 200; page++) {
    let url = `/api/v1/sync/pull?since=${encodeURIComponent(since)}&limit=500`;
    if (sinceId) url += `&since_id=${encodeURIComponent(sinceId)}`;
    const r = await apiRequest<{
      items: { id: string; item_type: number; deleted: boolean; version: number; encrypted_content: string; content_nonce: string; updated_at?: string }[];
      cursor: string | null; cursor_id: string | null; has_more: boolean;
    }>(url);
    if (!r.success) return null;
    for (const i of r.data.items) {
      if (i.item_type !== ITEM_TYPE_METADATA || i.deleted) continue;
      if (!newest || (i.updated_at ?? '') >= (newest.updated_at ?? '')) newest = i;
    }
    if (!r.data.has_more) break;
    since = r.data.cursor ?? since;
    sinceId = r.data.cursor_id ?? sinceId;
  }
  return newest;
}

/**
 * Merge this page's list over what the server holds and adopt the result:
 * server wins on conflicts, local additions and removals are kept. The
 * server's row becomes the new base and version, so even if the retry that
 * follows fails, the NEXT write starts from a fresh read rather than the
 * stale version that wedged this one.
 *
 * The CURRENT signals, not the blob that conflicted: a change asked for while
 * that write was on its way is in them only. Against the state they sit on
 * ([unsent], with a write whose answer never came settled first), not against
 * the base at the time of the conflict: a sync during the write moves the base,
 * and against the row it adopted, what that row removed would come back. With
 * nothing unconfirmed: the base, or with none yet the cache this session started
 * from (with nothing, a removal made before the first pull would read as never
 * made).
 */
function rebaseOnto(server: ServerMetaRow) {
  const merged = unsent ? mergeUnsentOver(server.meta, server.version) : mergeMetadata(
    (lastServerMeta ?? sessionStartBlob) as MergeableMetadata | null,
    currentBlob() as MergeableMetadata,
    server.meta as MergeableMetadata,
  ) as UserMetadata;
  metadataItemId = server.id;
  metadataVersion = server.version;
  lastServerMeta = server.meta;
  saveBase();
  applyBlob(merged);
  if (unsent) unsent = { base: server.meta };
}

/**
 * Save metadata to server as an encrypted system note.
 *
 * A version conflict is RECOVERED, not swallowed: the server's row is re-read,
 * three-way merged with what this client wanted to write (lib/metadataMerge),
 * and written once more against the server's version. A swallowed 409 would
 * leave `metadataVersion` stale, so every later write would 409 too — the
 * sidebar would keep accepting notebooks, colours and share recipients that
 * never reach the server, until logout. A 409 from the CREATE (another device
 * made the row first) adopts that row and retries as an update;
 * `metadataItemId` is never left null while the server holds a row.
 */
async function persistToServerLocked() {
  // A write's merge adopts the server's list: the holds come first.
  await holdsReady();
  if (!isCryptoReady()) return;

  // With no base, a write built now could only merge with nothing to compare,
  // and the stale cache would put back whatever another device removed. Wait for
  // this session's first pull, which either brings the row (and so a base) or
  // shows it unchanged since this cache was written. The cache keeps the change.
  if (!baseKnown && !pulledThisSession) {
    writeWaitsForPull = true;
    saveCache(currentBlob());
    return;
  }

  const meta = currentBlob();
  let outcome = await writeBlob(meta);

  if (outcome === 'gone') {
    metadataItemId = null;
    metadataVersion = 0;
    lastServerMeta = null;
    dropBase();
    // The row the changes sat on is gone, and with it what they could be
    // merged against: they are no longer tracked ([unsent]), as before there
    // was a base. Built again: a change asked for during the PUT is in the
    // signals only.
    unsent = null;
    maybeLanded = null;
    outcome = await writeBlob(currentBlob());
  }

  // No answer: asked once more, after a moment, at the same version. The
  // server's version check then says what the first did while little can have
  // happened since: landed, this one conflicts, and the row re-read below is
  // that write; not landed, this one lands, or meets another device's write.
  if (outcome === 'unanswered') {
    const epoch = lookupEpoch;
    const account = getTabAccount();
    await new Promise<void>(resolve => setTimeout(resolve, ASK_AGAIN_AFTER_MS));
    await holdsReady();
    // Signed out, or another account's page, meanwhile: what it was to write
    // was the old session's.
    if (epoch !== lookupEpoch || getTabAccount() !== account || !isCryptoReady()) return;
    outcome = await writeBlob(currentBlob());
  }

  if (outcome === 'conflict' || outcome === 'exists') {
    const row = outcome === 'conflict' ? await readServerMetaRow() : await findServerMetadataRow();
    const server = row ? decodeMetaRow(row) : null;
    if (row && server === 'locked') {
      // A list no key here opens, from before a password reset: written over,
      // and carried in what goes over it. Giving up here would fail every
      // attempt, and the server would keep the locked list for good.
      holdLockedList(row);
      outcome = await writeBlob(currentBlob());
      if (outcome !== 'ok') console.warn(`Metadata write over a locked list rejected (${outcome}); will re-read on the next write`);
    } else if (server && server !== 'locked') {
      rebaseOnto(server);
      outcome = await writeBlob(currentBlob());
      if (outcome !== 'ok') console.warn(`Metadata write still rejected after rebase (${outcome}); will re-read on the next write`);
    } else {
      console.warn(`Metadata ${outcome === 'conflict' ? 'version conflict' : 'row exists'} and the server row could not be read; will retry on the next write`);
    }
  }

  // Not through, with changes unconfirmed: the next finished pull sends them
  // (markPulled), whether or not anything else asks for a write by then.
  if (outcome !== 'ok' && unsent) writeWaitsForPull = true;
  saveCache(currentBlob());
}

/**
 * Keep a notebook item's WRAP and, when our vault opens it, its roster and
 * whole document. Without the wrap the client cannot open a notebook's content
 * key, which is what sealing it to a member requires — and a rename would
 * mint a fresh key instead of reusing the existing one. Read the roster while
 * the wrap is in hand. Failure is silent and means "no members known" — a
 * notebook whose content this client cannot open must not have its member list
 * guessed at.
 */
function adoptNotebookWrapAndRoster(i: {
  id: string; encrypted_content: string; content_nonce: string;
  wrapped_content_key?: string | null; wrapped_content_key_nonce?: string | null;
}) {
  if (!i.wrapped_content_key || !i.wrapped_content_key_nonce) return;
  notebookWraps.set(i.id, { key: i.wrapped_content_key, nonce: i.wrapped_content_key_nonce });
  try {
    const ck = unwrapContentKeyWithVault(i.wrapped_content_key, i.wrapped_content_key_nonce);
    if (ck) {
      const plain = decryptWithContentKey(
        { nonce: i.content_nonce, ciphertext: i.encrypted_content }, ck, i.id);
      if (plain) {
        notebookMembers.set(i.id, membersFrom(plain));
        // Keep the WHOLE document, not just the roster: it is the base
        // every later write merges over, and without it a share or
        // rename silently drops the fields this client does not model.
        const content = notebookContentFrom(plain);
        if (content) notebookContents.set(i.id, content);
      }
    }
  } catch { /* not openable here; leave the roster unknown */ }
}

/** One item's share rows as the server holds them now (only ours: the route
 *  lists the caller's own rows), or null when they could not be read. */
async function shareRowsNow(itemId: string): Promise<{ recipient_email: string; permission: string }[] | null> {
  try {
    const r = await apiRequest<unknown>(`/api/v1/items/${itemId}/shares`);
    if (!r.success || !Array.isArray(r.data)) return null;
    return r.data.filter((s): s is { recipient_email: string; permission: string } =>
      !!s && typeof s.recipient_email === 'string' && s.recipient_email !== '' && typeof s.permission === 'string');
  } catch {
    return null;
  }
}

/**
 * A notebook's standing list, from the server's current rows alone.
 *
 * WHO is whoever the notebook OBJECT has a row for. A row on one of its notes
 * alone is not a member: a note shared on its own and later moved in would
 * otherwise start receiving everything added after it.
 *
 * WHAT they may do is the grant the Share panel shows (notebookGrantFrom), as
 * a note right the way resealAt sets it. The object's rows carry only the
 * collection right (`view`/`contribute`, never `edit`), so for a `view` row the
 * note right comes from the notes in the notebook now. Edit only when every row
 * those notes have for them says edit and there is at least one; any other
 * answer, a failed read included, is view. The fewer rights, never the more: a
 * demotion that stopped part-way must not come back as edit. Addresses compare
 * case-insensitively, and one with several object rows is `contribute` only if
 * all of them are.
 *
 * Keys and user ids are left null, as a fresh share leaves them until the next
 * lookup; nothing here ever came from the backup.
 */
async function standingListFromServer(
  notebookId: string,
  childNoteIds: readonly string[],
): Promise<NotebookShareRecipient[]> {
  const rows = await shareRowsNow(notebookId);
  if (!rows || rows.length === 0) return [];

  // Lower-cased address -> the rights its rows carry, on the object and on
  // the notes. A note's read that fails is asked again; still failing, no
  // list is made (as for the notebook's own rows), so one failed read never
  // sets every editor down as a reader for good.
  const objectRights = rightsByAddress(rows);
  let childRights = new Map<string, { email: string; rights: string[] }>();
  if (rows.some(r => r.permission !== 'contribute')) {
    const childRows: { recipient_email: string; permission: string }[] = [];
    for (const childId of childNoteIds) {
      const read = await shareRowsNow(childId)
        ?? await new Promise<void>(r => setTimeout(r, ASK_AGAIN_AFTER_MS)).then(() => shareRowsNow(childId));
      if (!read) return [];
      childRows.push(...read);
    }
    childRights = rightsByAddress(childRows);
  }

  const list: NotebookShareRecipient[] = [];
  for (const [address, { email, rights }] of objectRights) {
    const objectRight = everyIs(rights, 'contribute') ? 'contribute' : 'view';
    const childRight = everyIs(childRights.get(address)?.rights, 'edit') ? 'edit' : 'view';
    const grant = notebookGrantFrom(objectRight, childRight);
    list.push({
      email,
      permission: grant === 'view' ? 'view' : 'edit',
      publicKey: null,
      userId: null,
      signingPublicKey: null,
    });
  }
  return list;
}

/** Rows grouped by lower-cased address, keeping the first spelling seen. */
function rightsByAddress(rows: readonly { recipient_email: string; permission: string }[]) {
  const out = new Map<string, { email: string; rights: string[] }>();
  for (const r of rows) {
    const address = r.recipient_email.toLowerCase();
    const entry = out.get(address);
    if (entry) entry.rights.push(r.permission);
    else out.set(address, { email: r.recipient_email, rights: [r.permission] });
  }
  return out;
}

/** True only when there is at least one right and every one is `right`. */
function everyIs(rights: readonly string[] | undefined, right: string): boolean {
  return !!rights && rights.length > 0 && rights.every(p => p === right);
}

export const notebooksStore = {
  notebooks,
  labelColors,

  // --- Per-note editor mode pins ---
  //
  // The global setting is the default; a pin overrides it for one note. The
  // map rides in this blob rather than in the note because the note is shared
  // and a view preference is not (see `UserMetadata.editorModes`).

  editorModes,

  /** Pin `noteId` to `mode`, or un-pin it when `mode` is the current global.
   *  Saves only when the map actually changed — this blob is shared with
   *  notebooks and label colours, and a no-op write would bump its version
   *  and race another device for nothing. */
  setEditorModeFor(noteId: string, mode: EditorMode, global: EditorMode) {
    const next = withMode(editorModes(), noteId, mode, global);
    if (next === editorModes()) return;
    setEditorModes(next);
    persistToServer();
  },

  /** Forget every pin. Without this a pinned note is only findable by opening
   *  it, so a user who pinned a few and forgot which has no way back. */
  resetEditorModes() {
    const next = clearOverrides(editorModes());
    if (next === editorModes()) return;
    setEditorModes(next);
    persistToServer();
  },

  /** Drop pins whose note is gone, so the map cannot grow without bound.
   *  Takes the FULL local note set — a partial list would collect pins for
   *  notes that are merely absent from it. */
  gcEditorModes(liveNoteIds: Iterable<string>) {
    const next = gcOverrides(editorModes(), liveNoteIds);
    if (next === editorModes()) return;
    setEditorModes(next);
    persistToServer();
  },

  /** Load metadata from synced notes (called after sync) */
  loadFromSyncedItems(items: { id: string; item_type: number; encrypted_content: string; content_nonce: string; version: number; deleted: boolean; updated_at?: string; wrapped_content_key?: string | null; wrapped_content_key_nonce?: string | null; user_id?: string | null }[]) {
    // LAST match, not the first. There is supposed to be exactly one
    // item_type=10 row, but where there is more than one, `find` takes
    // whichever the sync stream lists first — and the stream is ordered
    // ascending by (updated_at, id), so that is the OLDEST. Writing then bumps
    // that row to the end of the same order, so the next load picks a
    // different one and notebooks, label colours, share recipients and pins all
    // rotate. Newest-wins makes one row authoritative instead. It does not
    // merge the strays: recovering their contents is a deliberate one-off
    // repair, not something to do implicitly on every sync.
    // Which notebooks already exist as their own item. Collected on the way
    // past so the backfill below can be a set difference rather than a probe
    // per notebook.
    const liveNotebookItems = new Map<string, number>();
    for (const i of items) {
      if (i.item_type !== ITEM_TYPE_NOTEBOOK) continue;
      if (i.user_id) notebookItemOwners.set(i.id, i.user_id);
      if (i.deleted) {
        // A TOMBSTONED row still owns its id, so creating against it 409s.
        // Mark it "taken, but not ours to write" — the same version-0 sentinel
        // the 409 handler below uses — instead of skipping it: a skipped row
        // leaves the backfill believing the notebook has no item at all and
        // re-POSTing an id the server will never accept.
        liveNotebookItems.set(i.id, 0);
        continue;
      }
      liveNotebookItems.set(i.id, i.version);
      adoptNotebookWrapAndRoster(i);
    }
    // MERGE, never replace. `items` is ONE PAGE of a sync, and on an ordinary
    // launch the whole sync is an INCREMENTAL delta — so assigning it wholesale
    // would discard everything known about every notebook the page did not
    // happen to mention, and during a multi-page full sync each page would erase
    // the one before it. backfillNotebookItems would then read that emptied map
    // as "these notebooks have no item" and re-POST ids the server already holds,
    // every one a 409, on every launch. Version-0 markers set by the 409 handler
    // have to survive this as well, and a replace would destroy those too.
    for (const [id, version] of liveNotebookItems) knownNotebookItems.set(id, version);

    let metaItem: (typeof items)[number] | undefined;
    for (const i of items) {
      if (i.item_type !== ITEM_TYPE_METADATA || i.deleted) continue;
      if (!metaItem) { metaItem = i; continue; }
      // Compare when the server gave us a timestamp; otherwise lean on the
      // stream's ascending order and take the later one.
      const a = i.updated_at, b = metaItem.updated_at;
      if (a === undefined || b === undefined || a >= b) metaItem = i;
    }
    if (!metaItem) return;

    // With this identity's key, else with one recovered from before a password
    // reset (written again under this one's: [notebooksStore.repairAfterReset]).
    // Opening with neither, it is a list from before a reset: not adopted, and
    // carried in what this page writes over it ([holdLockedList]).
    const opened = openList(metaItem);
    if (!opened) {
      console.warn('[note] the notebook list on the server opens with no key this page holds (from before a password reset?): it is kept inside the next one written');
      holdLockedList(metaItem);
      return;
    }
    lockedListRow = null;
    if (opened.recovered) listOpenedWithRecoveredKey = true;

    try {
      const meta: UserMetadata = opened.meta;
      // Changes the server has not confirmed are in the signals only, and
      // adopting the row replaces them: they are merged over it instead,
      // against the state they sit on ([unsent]), and written at once (below).
      const keptChanges = unsent ? mergeUnsentOver(meta, metaItem.version) : null;
      let writeOwed = false;
      // What is set aside is what the list that opens says. Written by this
      // page, it is what this page set aside, kept; written since by another
      // device, whose list is newer than this page's copy, nothing here is
      // put back on the server's word alone.
      unconfirmed = heldAsideFrom(meta);

      metadataItemId = metaItem.id;
      metadataVersion = metaItem.version;
      lastServerMeta = meta;
      saveBase();

      if (meta.notebooks) {
        setNotebooks(meta.notebooks.map(nb => ({ ...nb, noteCount: 0 })));
      }
      if (meta.labelColors) {
        setLabelColors(meta.labelColors);
      }
      const shares = meta.notebookShares ?? {};
      const adopted = withoutHeld(shares);
      setNotebookShares(adopted);
      setEditorModes(sanitizeOverrides(meta.editorModes));
      setAcceptedNotebooks(Array.isArray(meta.acceptedNotebooks) ? meta.acceptedNotebooks : []);
      sawAccepted(acceptedNotebooks());
      extras = extrasFrom(meta, KNOWN_METADATA_KEYS);
      saveCache(meta);
      if (keptChanges) {
        // Through applyBlob: anyone held off a list stays off it.
        applyBlob(keptChanges);
        saveCache(currentBlob());
        if (canonicalBlob(keptChanges) === canonicalBlob(meta)) {
          unsent = null; // the row already says all of it
        } else {
          unsent = { base: meta };
          writeWaitsForPull = false;
          writeOwed = true;
        }
      }
      // The server still lists someone taken off: write the removal again.
      if (adopted !== shares) persistToServer();
      // Changes kept above go to the server at once, not at the end of the
      // sync. A write already queued or on its way sends them: queued, it is
      // built from the signals; on its way, it conflicts with this row and is
      // merged again. Else one is asked for (theirs may have failed).
      if (writeOwed && writesPending === 0) void persistToServer();
    } catch (e) {
      console.warn('Failed to decrypt metadata note:', e);
    }
  },

  /** Reset all in-memory + cursor state to empty. Called on logout so the next
   *  account signed in on this device never momentarily sees the prior user's
   *  notebooks/labels/shares in the sidebar before its own sync lands. The
   *  persisted `pingolin_note_metadata` cache is wiped by crypto.clearKeys(); this
   *  drops the derived signals and the server-item cursor those signals hydrate from. */
  reset() {
    clearHolds();
    // What one account's page learned of notebook items is not the next one's,
    // and a lookup still on its way must record nothing for it.
    lookupEpoch++;
    notebooksWithNoItem.clear();
    notebookItemLookups.clear();
    notebooksRemovedHere.clear();
    baseKnown = false;
    pulledThisSession = false;
    fullyPulledThisSession = false;
    writeWaitsForPull = false;
    sessionStartBlob = null;
    unsent = null;
    maybeLanded = null;
    wakePullWaiters();
    setNotebooks([]);
    setLabelColors({});
    setNotebookShares({});
    setEditorModes({});
    extras = {};
    metadataItemId = null;
    metadataVersion = 0;
    lastServerMeta = null;
    lockedListRow = null;
    unconfirmed = null;
    setAsideDone = false;
    listOpenedWithRecoveredKey = false;
    notebookItemOwners.clear();
  },

  /**
   * Write the `item_type = 2` row for a notebook.
   *
   * Best-effort by design. The metadata blob is the record every client
   * reads, so a failure here costs the notebook its server identity — which
   * only sharing needs — and never costs the user their notebook. Throwing
   * would turn "create a notebook" into an operation that can fail for a
   * reason the user cannot act on.
   */
  async writeNotebookItem(id: string, name: string): Promise<boolean> {
    return (await this.createNotebookItem(id, name)) === 'created';
  },

  /**
   * [writeNotebookItem], saying what happened: 'created'; 'exists' for a 409
   * (the id is taken, by us as the server tells it, or on an older server
   * by anyone); 'not-ours' for a 403 (another account holds the id); 'failed'
   * otherwise. A taken id, either way, is marked so the backfill never asks
   * again (an unmarked 403 would be retried after every full pull).
   */
  async createNotebookItem(id: string, name: string): Promise<'created' | 'exists' | 'not-ours' | 'failed'> {
    if (!isCryptoReady()) return 'failed';
    try {
      // A per-item content key, not vault-direct encryption. This is the whole
      // point of the step: a notebook encrypted under the vault key can only
      // ever be read by its owner, because sharing it would mean sharing the
      // vault. With a content key the notebook becomes an ordinary shareable
      // item — the same wrap, seal and signature path notes already use.
      //
      // Safe to write: android's decryptItemContent tries the wrapped key
      // first and falls back to vault-direct, so it reads both formats, and
      // existing vault-encrypted notebooks keep working untouched.
      const contentKey = generateContentKey();
      const wrapped = wrapContentKeyWithVault(contentKey);
      const enc = encryptWithContentKey(JSON.stringify(notebookItemContent(name)), contentKey, id);
      // The id is SUPPLIED, never generated: notes carry their notebook's id
      // inside their own encrypted content, so a fresh id here would orphan
      // every note in the notebook.
      const res = await apiRequest<any>('/api/v1/items', {
        method: 'POST',
        body: {
          id,
          item_type: ITEM_TYPE_NOTEBOOK,
          encrypted_content: enc.ciphertext,
          content_nonce: enc.nonce,
          wrapped_content_key: wrapped.wrappedKey,
          wrapped_content_key_nonce: wrapped.nonce,
        },
      });
      if (res.success) {
        knownNotebookItems.set(id, res.data?.version ?? 1);
        // Cache the wrap we just wrote. Without this the notebook is
        // unopenable by the client that CREATED it until a full sync brings the
        // item back — so `notebookContentKey` returns null, and every operation
        // that needs the content key silently does nothing:
        //   - sharing the notebook no-ops (setNotebookMembers bails on a null
        //     key), so the share reports success and grants a member nothing;
        //   - the rename that immediately follows creation in the sidebar's
        //     add flow finds no wrap and MINTS A FRESH KEY, rotating the
        //     notebook's key seconds after birth.
        notebookWraps.set(id, { key: wrapped.wrappedKey, nonce: wrapped.nonce });
        // A brand-new notebook has no members. Recording that is what makes
        // `membersOf` mean "nobody" rather than "unknown, do not guess".
        notebookMembers.set(id, []);
        return 'created';
      }
      // 409 item_already_exists: the id is taken by a row we cannot see —
      // a SOFT-DELETED item still holds it. Record it as known so the backfill
      // stops trying. Without this the retry runs on EVERY load, forever, for
      // any notebook whose item was deleted while its metadata entry survived,
      // and it never converges.
      //
      // Version 0 marks "taken, but not ours to write": renameNotebookItem
      // skips it rather than PUTting against a deleted row.
      if (res.error_code === 'item_already_exists' || res.status === 409) {
        knownNotebookItems.set(id, 0);
        return 'exists';
      }
      // 403: another account's id. Marked the same way, or the backfill would
      // POST it again after every full pull, forever.
      if (res.status === 403) {
        knownNotebookItems.set(id, 0);
        return 'not-ours';
      }
      return 'failed';
    } catch {
      return 'failed';
    }
  },

  /**
   * Give every metadata-only notebook an item. Idempotent, and safe to call on
   * every load — `notebooksMissingItems` is a set difference, so a second pass
   * writes nothing.
   */
  async backfillNotebookItems(): Promise<number> {
    // Partial knowledge cannot distinguish a metadata-only notebook from one
    // whose item simply was not in the pages we saw, and guessing wrong costs a
    // doomed round trip per notebook on EVERY launch. Do nothing until a full
    // pull has completed; the notebooks this exists to repair are not going
    // anywhere, and a create at notebook-creation time (renameNotebookItem's
    // sibling call below) already covers everything made since.
    if (!knownNotebookItemsComplete) return 0;
    const missing = notebooksMissingItems(notebooks(), new Set(knownNotebookItems.keys()));
    // In parallel: each create is independent, and serially they cost one
    // round trip apiece, which stretches this background repair across
    // seconds of the launch.
    const written = await Promise.all(
      missing.map(nb => this.writeNotebookItem(nb.id, nb.name)),
    );
    return written.filter(Boolean).length;
  },

  /**
   * The sync calls this once a FULL pull has drained its last page, which is
   * the only moment [knownNotebookItems] describes the whole account rather
   * than one delta. See [knownNotebookItemsComplete].
   */
  markNotebookItemsComplete() {
    knownNotebookItemsComplete = true;
  },

  /** The sync calls this after every pull that finished: the first one lets a
   *  write built with no base go ahead (see [persistToServerLocked]). */
  markPulled() {
    pulledThisSession = true;
    if (writeWaitsForPull) {
      writeWaitsForPull = false;
      void persistToServer();
    }
    wakePullWaiters();
  },

  /** The sync calls this once a FULL pull has drained its last page with no
   *  page failed: the notes in memory are then every note of the account's
   *  that opens here, the trash included (see notesStore.notebookNoteIds). */
  markFullyPulled() {
    fullyPulledThisSession = true;
    wakePullWaiters();
  },

  /** Has this session finished a pull — with `full`, a full one? */
  hasPulled(full = false): boolean {
    return full ? fullyPulledThisSession : pulledThisSession;
  },

  /** Resolves at this session's next finished pull or reset, whichever is
   *  first. A waiter checks again what it waits for, and the account. */
  nextPullEvent(): Promise<void> {
    return new Promise(resolve => { pullWaiters.push(resolve); });
  },

  /**
   * The notebook's content key, opened with the vault. Null when this client
   * cannot open it — a notebook it does not own, or one written before wraps
   * were captured. Callers must treat null as "cannot share this", never as
   * "share it unencrypted".
   */
  /** The raw vault wrap for a notebook, for the rotation path — which needs
   *  the stored strings, not the opened key. */
  notebookWrap(id: string): { key: string; nonce: string } | null {
    return notebookWraps.get(id) ?? null;
  },

  /** The server version of a notebook item, or null if we have never seen one.
   *  Version 0 is the "id taken by a row we cannot write" marker. */
  notebookVersion(id: string): number | null {
    const v = knownNotebookItems.get(id);
    return v && v > 0 ? v : null;
  },

  /**
   * Adopt the wrap and version a rotation produced.
   *
   * Without this the next write to the notebook PUTs against a stale version
   * and signs under a stale generation — and `notebookContentKey` keeps
   * handing back the key the rotation just retired, which is precisely the key
   * the removed member holds.
   */
  adoptRotatedNotebookKey(
    id: string,
    rotated: { wrappedKey: string; nonce: string; version: number },
  ): void {
    notebookWraps.set(id, { key: rotated.wrappedKey, nonce: rotated.nonce });
    knownNotebookItems.set(id, rotated.version);
  },

  notebookContentKey(id: string): Uint8Array | null {
    const wrap = notebookWraps.get(id);
    if (!wrap || !isCryptoReady()) return null;
    return unwrapContentKeyWithVault(wrap.key, wrap.nonce);
  },

  /** Which key opened this notebook here: see [notebookOpenedVia]. */
  notebookOpenedVia(id: string): 'vault' | 'share' | null {
    return notebookOpenedVia(id);
  },

  /** The roster as last read from the notebook's encrypted content. */
  membersOf(id: string): NotebookMember[] {
    return membersOf(id);
  },

  /**
   * Rewrite the notebook's roster, reusing its existing content key.
   *
   * Reusing is required, not an optimisation: a fresh key here would lock out
   * every member the roster already lists, which is the opposite of what adding
   * one is for.
   */
  async setNotebookMembers(id: string, members: NotebookMember[]): Promise<boolean> {
    // After a reload this page may not have heard of the item yet (see
    // `notebookItemState`): ask, or the roster cannot be written until a sync
    // happens to mention the notebook.
    if (!knownNotebookItems.has(id)) await this.notebookItemState(id);
    const version = knownNotebookItems.get(id);
    const contentKey = this.notebookContentKey(id);
    if (!version || !contentKey) return false;
    const name = notebooks().find(nb => nb.id === id)?.name;
    if (name === undefined) return false;
    try {
      const enc = encryptWithContentKey(
        JSON.stringify(contentToWrite(id, name, members)), contentKey, id);
      const res = await apiRequest<any>(`/api/v1/items/${id}`, {
        method: 'PUT',
        body: {
          encrypted_content: enc.ciphertext,
          content_nonce: enc.nonce,
          expected_version: version,
        },
      });
      if (!res.success) return false;
      if (res.data?.version) knownNotebookItems.set(id, res.data.version);
      notebookMembers.set(id, members);
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Does this notebook exist as a server ITEM (not merely in the metadata blob)?
   *
   * The server requires a note's `notebook_id` to name an existing item, so
   * writing a grouping for a notebook that has no item fails the note create
   * outright. Callers must ask before sending the column.
   * Version 0 means "id taken by a row we cannot write" (a soft-deleted item),
   * which is equally unusable as a target.
   */
  /** Notebook ids this user has accepted an invitation to. */
  acceptedNotebooks,

  isNotebookAccepted(id: string): boolean {
    return acceptedNotebooks().includes(id);
  },

  /**
   * Accept an invitation, or forget it again on decline.
   *
   * Persisted to the metadata blob so the decision follows the user to their
   * other devices — being asked the same question on every browser would make
   * the prompt feel like a nag rather than a choice.
   */
  async setNotebookAccepted(id: string, accepted: boolean): Promise<void> {
    // The reader's own answer, given here, is what this device remembers from
    // now on: before the early return, so a "no" to a notebook the shared list
    // had already lost is still remembered as a no.
    keepSeenAccepted(accepted ? withAccepted(seenAccepted(), id) : withoutAccepted(seenAccepted(), id));
    const next = accepted
      ? withAccepted(acceptedNotebooks(), id)
      : withoutAccepted(acceptedNotebooks(), id);
    if (next.length === acceptedNotebooks().length
        && next.every((v, i) => v === acceptedNotebooks()[i])) {
      return;
    }
    setAcceptedNotebooks(next);
    await persistToServer();
  },

  /** Notebooks this device has seen accepted (see `seenAccepted` above). */
  seenAcceptedNotebooks: seenAccepted,

  /**
   * Bring the device's memory up to date with the shared list.
   *
   * @param listed  every notebook the inbox lists, when it has just answered
   *                with a list; null otherwise, and then nothing is forgotten.
   */
  rememberAcceptances(listed: ReadonlySet<string> | null): void {
    keepSeenAccepted(rememberedAcceptances(seenAccepted(), acceptedNotebooks(), listed));
  },

  /**
   * Drop acceptances whose notebook is no longer shared with us.
   *
   * Without this a removed-then-re-invited recipient would find the second
   * invitation already accepted, with no question asked.
   */
  async pruneAcceptances(liveNotebookIds: ReadonlySet<string>): Promise<void> {
    const stale = staleAcceptances(acceptedNotebooks(), liveNotebookIds);
    if (stale.length === 0) return;
    setAcceptedNotebooks(acceptedNotebooks().filter(id => !stale.includes(id)));
    await persistToServer();
  },

  hasNotebookItem(id: string | null | undefined): boolean {
    if (!id) return false;
    const v = knownNotebookItems.get(id);
    return v !== undefined && v > 0;
  },

  /**
   * What the server has for this notebook, asking it when this session's
   * syncs have not said.
   *
   * What this page knows of notebook items comes from sync pages, and after a
   * reload those are a delta: a notebook nobody has touched since is not in
   * it. Answering "no item" from that silence would send a note written into
   * that notebook up WITHOUT its notebook, and everything the server does by
   * a note's notebook would not happen for it: a reader who had DECLINED the
   * notebook would get the note all the same, a push would announce it
   * as a note of its own, and the right to place a note in someone's notebook
   * would not be asked.
   *
   * One request per notebook per page, and only for a notebook the syncs have
   * not mentioned. A notebook the server has no item for is remembered as such
   * for the page.
   *
   * 'unknown' is its own answer, not "none": the request failed (offline, a
   * 5xx, a rate limit) and nothing is remembered, so the next call asks again.
   * A caller that would SHARE on the strength of "no item" must not do so on
   * "unknown": a transient failure would send the note up without its notebook
   * and share it, live, with a reader who had declined, and the Share panel
   * would share a notebook's notes without the notebook.
   */
  async notebookItemState(id: string | null | undefined): Promise<NotebookItemState> {
    if (!id) return 'none';
    const settled = (): NotebookItemState | null =>
      knownNotebookItems.has(id) ? (this.hasNotebookItem(id) ? 'item' : 'none')
        : notebooksWithNoItem.has(id) ? 'none' : null;
    const known = settled();
    if (known) return known;
    let asking = notebookItemLookups.get(id);
    if (!asking) {
      const epoch = lookupEpoch;
      asking = (async () => {
        try {
          const r = await apiRequest<{
            id: string; item_type: number; version: number; deleted?: boolean; encrypted_content: string; content_nonce: string;
            wrapped_content_key?: string | null; wrapped_content_key_nonce?: string | null; user_id?: string | null;
          }>(`/api/v1/items/${id}`);
          // Another account holds the page now, or the notebook was deleted
          // here while this was on its way: the answer is about neither.
          if (epoch !== lookupEpoch || notebooksRemovedHere.has(id)) return;
          // A sync page may have answered while this was on its way: it is the newer word.
          if (knownNotebookItems.has(id)) return;
          if (!r.success) {
            if (r.status === 404) notebooksWithNoItem.add(id);
            return;
          }
          // Recorded exactly as a sync page records it (loadFromSyncedItems):
          // a notebook item and nothing else; a tombstone as "taken, not ours
          // to write"; a live one with its wrap and roster. Under the id that
          // was ASKED for, whatever id the answer carries.
          if (r.data.item_type === ITEM_TYPE_NOTEBOOK && r.data.user_id) notebookItemOwners.set(id, r.data.user_id);
          if (r.data.item_type !== ITEM_TYPE_NOTEBOOK) {
            notebooksWithNoItem.add(id);
          } else if (r.data.deleted) {
            knownNotebookItems.set(id, 0);
          } else {
            knownNotebookItems.set(id, r.data.version);
            adoptNotebookWrapAndRoster({ ...r.data, id });
          }
        } catch {
          /* not an answer */
        } finally {
          if (notebookItemLookups.get(id) === asking) notebookItemLookups.delete(id);
        }
      })();
      notebookItemLookups.set(id, asking);
    }
    await asking;
    return settled() ?? 'unknown';
  },

  // --- After a password reset (lib/notebookRepair) ---

  /** Is the list on the server one no key here opens, and so held as locked
   *  ([lockedListRow])? Did it open only with a recovered key? */
  listAfterReset(): { locked: boolean; openedWithRecoveredKey: boolean } {
    return { locked: lockedListRow !== null, openedWithRecoveredKey: listOpenedWithRecoveredKey };
  },

  /**
   * The list opened only with a key recovered from before a reset: write it
   * again, whole, under this identity's. Its content is what was read; nothing
   * is added or taken. True when that write landed.
   */
  async rewriteListUnderThisIdentity(): Promise<boolean> {
    if (!listOpenedWithRecoveredKey) return false;
    await persistToServer();
    return !listOpenedWithRecoveredKey;
  },

  /**
   * While the list on the server is locked, put on this page's list every
   * notebook of the account's whose record opens here and which it lacks, and
   * write it over the locked one (which goes inside it). Without this, a
   * notebook made after the reset on another device would be on no list
   * anywhere. Only after a FULL pull: before one, which notebooks have an
   * item is not known. Not while the list is readable: a notebook missing
   * from a list that opens may be one deleted with its item's delete not
   * through yet.
   */
  /**
   * Put back the people and acceptances set aside when the list turned out
   * locked (`unconfirmed`), each only when the server confirms it now: a
   * notebook's person while the server still lists them on that notebook (and
   * no removal of them is held); an acceptance while the notebook is still
   * offered to this account and not declined. Nobody the server lists is added
   * who was not set aside: who is on a list is the owner's to say. A notebook
   * whose rows cannot be read, or acceptances the inbox has not answered for,
   * stay set aside for a later try. Returns how many came back.
   */
  async confirmHeldPeople(inbox: { offered: ReadonlySet<string> | null; declined: ReadonlySet<string> }): Promise<number> {
    const held = unconfirmed;
    if (!held) return 0;
    const account = getTabAccount();
    let back = 0;
    const confirmed: Record<string, NotebookShareRecipient[]> = {};
    const unread: Record<string, NotebookShareRecipient[]> = {};
    for (const [id, people] of Object.entries(held.shares)) {
      if (tryCanonicalAccountId(id) === null) continue;
      const rows = await askTwice(() => apiRequest<{ recipient_email?: unknown }[]>(`/api/v1/items/${id}/shares`));
      if (!rows.success || !Array.isArray(rows.data)) { unread[id] = people; continue; }
      const listed = new Set(rows.data.map(r => String(r?.recipient_email ?? '').toLowerCase()).filter(Boolean));
      const kept = people.filter(p => listed.has(p.email.toLowerCase()));
      if (kept.length > 0) confirmed[id] = kept;
    }
    // Acceptances: confirmed while the notebook is still on offer and not
    // declined; otherwise dropped. Unanswered by the inbox: left set aside.
    let refused: string[] = [];
    let acceptedLeft: string[] = held.accepted;
    if (inbox.offered) {
      refused = held.accepted.filter(id => !inbox.offered!.has(id) || inbox.declined.has(id));
      acceptedLeft = [];
    }
    if (getTabAccount() !== account || unconfirmed !== held) return 0;
    const fromHolds = withoutHeld(confirmed);
    setNotebookShares(prev => {
      const next = { ...prev };
      for (const [id, people] of Object.entries(fromHolds)) {
        const have = new Set((next[id] ?? []).map(p => p.email.toLowerCase()));
        const add = people.filter(p => !have.has(p.email.toLowerCase()));
        if (add.length === 0) continue;
        next[id] = [...(next[id] ?? []), ...add];
        back += add.length;
      }
      return next;
    });
    const confirmedAccepted = inbox.offered ? held.accepted.filter(id => !refused.includes(id)) : [];
    // After a reload the list here was read without them (they were not
    // written while set aside): put back.
    const missing = confirmedAccepted.filter(id => !acceptedNotebooks().includes(id));
    if (refused.length > 0 || missing.length > 0) {
      setAcceptedNotebooks([...acceptedNotebooks().filter(id => !refused.includes(id)), ...missing]);
    }
    back += confirmedAccepted.length;
    unconfirmed = Object.keys(unread).length > 0 || acceptedLeft.length > 0 ? { shares: unread, accepted: acceptedLeft } : null;
    if (back > 0 || refused.length > 0) await persistToServer();
    return back;
  },

  /** Set aside for this notebook and still unconfirmed: none may be left off its rebuild. */
  heldAsideIn(notebookId: string): number {
    return unconfirmed?.shares[notebookId]?.length ?? 0;
  },

  /** Set aside and still unconfirmed (for tests and the run's summary). */
  heldAsideCount(): number {
    if (!unconfirmed) return 0;
    return Object.values(unconfirmed.shares).reduce((n, list) => n + list.length, 0) + unconfirmed.accepted.length;
  },

  async keepNotebooksWhileListLocked(me: string): Promise<number> {
    if (!lockedListRow || !knownNotebookItemsComplete || !isCryptoReady()) return 0;
    const found: { id: string; name: string }[] = [];
    const mine = tryCanonicalAccountId(me);
    for (const [id, version] of knownNotebookItems) {
      if (!version || !mine || tryCanonicalAccountId(notebookItemOwners.get(id) ?? null) !== mine) continue;
      const title = notebookContents.get(id)?.title;
      if (typeof title === 'string' && title) found.push({ id, name: title });
    }
    const add = notebooksToAdd(notebooks(), found);
    if (add.length > 0) setNotebooks(prev => [...prev, ...add.map(nb => ({ ...nb, noteCount: 0 }))]);
    await persistToServer();
    return add.length;
  },

  /**
   * The lists from before a reset that the list carries (`beforeReset`) and a
   * key here now opens (a recovery key used since): merged back, adding only
   * what is missing, as a backup restore adds ([restoreFromBackup]). Never the
   * people of a notebook, nor which invitations were accepted: those are
   * sharing and consent, and a list from before a reset is an old state of
   * both. A notebook added back has its people read from the server's rows
   * ([restoreStandingShares]); an invitation accepted then is asked again.
   * A notebook whose item the server holds as deleted is not added back, and
   * so nothing is merged back before a full pull has said which those are
   * (or one deleted since would come back). Returns how many notebooks came
   * back.
   */
  async mergeBackEarlierLists(childNoteIds: (notebookId: string) => readonly string[]): Promise<number> {
    const carried = carriedLists(extras.beforeReset);
    if (carried.length === 0 || !isCryptoReady() || !knownNotebookItemsComplete) return 0;
    const opened: Sealed[] = [];
    const added: string[] = [];
    let alsoCarried: Record<string, unknown> = {};
    for (const list of carried) {
      const earlier = openList({ encrypted_content: list.ciphertext, content_nonce: list.nonce });
      if (!earlier) continue;
      opened.push(list);
      // What THAT list carried goes on being carried: a list from before an
      // earlier reset, records from before a rebuild, and rescued notes' old
      // keys (dropped with the list, a note rescued between two resets would
      // lose its attachments' old key for good).
      for (const older of carriedLists(earlier.meta.beforeReset)) {
        alsoCarried = { ...alsoCarried, beforeReset: withCarriedList(alsoCarried.beforeReset, older) };
      }
      for (const [nbId, records] of Object.entries(carriedRecords(earlier.meta.rebuiltNotebooks))) {
        for (const record of records) {
          alsoCarried = { ...alsoCarried, rebuiltNotebooks: withCarriedRecord(alsoCarried.rebuiltNotebooks, nbId, record) };
        }
      }
      for (const [noteId, keys] of Object.entries(keptKeys(earlier.meta.rescuedNotes))) {
        for (const key of keys) alsoCarried = { ...alsoCarried, rescuedNotes: withKeptKey(alsoCarried.rescuedNotes, noteId, key) };
      }
      const tombstones = new Set([...knownNotebookItems].filter(([, v]) => v === 0).map(([id]) => id));
      const before = new Set(notebooks().map(nb => nb.id));
      this.restoreFromBackup({
        notebooks: (earlier.meta.notebooks ?? []).filter(nb => nb && !tombstones.has(nb.id)),
        labelColors: earlier.meta.labelColors,
        editorModes: earlier.meta.editorModes,
      });
      for (const nb of notebooks()) if (!before.has(nb.id)) added.push(nb.id);
    }
    if (opened.length === 0) return 0;
    let beforeReset: unknown = withoutCarriedLists(extras.beforeReset, opened);
    for (const older of carriedLists(alsoCarried.beforeReset)) beforeReset = withCarriedList(beforeReset, older);
    let rebuiltNotebooks: unknown = extras.rebuiltNotebooks;
    for (const [nbId, records] of Object.entries(carriedRecords(alsoCarried.rebuiltNotebooks))) {
      for (const record of records) rebuiltNotebooks = withCarriedRecord(rebuiltNotebooks, nbId, record);
    }
    let rescuedNotes: unknown = extras.rescuedNotes;
    for (const [noteId, keys] of Object.entries(keptKeys(alsoCarried.rescuedNotes))) {
      for (const key of keys) rescuedNotes = withKeptKey(rescuedNotes, noteId, key);
    }
    extras = { ...extras, beforeReset, rebuiltNotebooks, rescuedNotes };
    if (added.length > 0) await this.restoreStandingShares(added, childNoteIds);
    await persistToServer();
    return added.length;
  },

  /** What is known of one of this account's notebooks' record (lib/notebookRepair). */
  recordStateOf(id: string, me: string): RecordState {
    const version = knownNotebookItems.get(id);
    const owner = notebookItemOwners.get(id);
    const wrap = notebookWraps.get(id);
    const mine = tryCanonicalAccountId(me);
    return recordState({
      cryptoReady: isCryptoReady(),
      liveItem: !!version && version > 0,
      ours: owner === undefined ? null : (mine !== null && tryCanonicalAccountId(owner) === mine),
      wrapped: !!wrap,
      opensWith: wrap ? vaultKeyThatOpens(wrap.key, wrap.nonce) : null,
    });
  },

  /**
   * The server's copy of one of this account's notebook items, read now: the
   * repairs act on what is there, not on what a sync last said. Null when it
   * cannot be read, is not a live notebook, or is not this account's.
   */
  async ownNotebookItemNow(id: string, me: string): Promise<{
    version: number; encrypted_content: string; content_nonce: string;
    wrapped_content_key: string | null; wrapped_content_key_nonce: string | null;
  } | null> {
    const r = await apiRequest<{
      item_type: number; version: number; deleted?: boolean; user_id?: string | null;
      encrypted_content: string; content_nonce: string;
      wrapped_content_key?: string | null; wrapped_content_key_nonce?: string | null;
    }>(`/api/v1/items/${id}`);
    if (!r.success || r.data.deleted || r.data.item_type !== ITEM_TYPE_NOTEBOOK) return null;
    if (!r.data.user_id || tryCanonicalAccountId(r.data.user_id) !== tryCanonicalAccountId(me)) return null;
    return {
      version: r.data.version,
      encrypted_content: r.data.encrypted_content,
      content_nonce: r.data.content_nonce,
      wrapped_content_key: r.data.wrapped_content_key ?? null,
      wrapped_content_key_nonce: r.data.wrapped_content_key_nonce ?? null,
    };
  },

  /**
   * Keep a notebook's record as it is now inside the list (`rebuiltNotebooks`),
   * before it is replaced. True only when a list write carrying it LANDED: a
   * record is never replaced while the only copy of it is the one going.
   */
  async carryRecord(id: string, record: EarlierRecord): Promise<boolean> {
    extras = { ...extras, rebuiltNotebooks: withCarriedRecord(extras.rebuiltNotebooks, id, record) };
    await persistToServer();
    const kept = carriedRecords(lastServerMeta?.rebuiltNotebooks)[id] ?? [];
    return kept.some(r => r.ciphertext === record.ciphertext && r.nonce === record.nonce
      && r.wrappedKey === record.wrappedKey && r.wrappedKeyNonce === record.wrappedKeyNonce);
  },

  /**
   * Keep a rescued note's old key wrap inside the list (`rescuedNotes`), before
   * the rescue replaces it: its attachments stay sealed under that key, and a
   * recovery key used later brings them over (lib/noteRescue). True only when a
   * list write carrying it LANDED.
   */
  async keepOldNoteKey(noteId: string, key: KeptKey): Promise<boolean> {
    extras = { ...extras, rescuedNotes: withKeptKey(extras.rescuedNotes, noteId, key) };
    await persistToServer();
    return (keptKeys(lastServerMeta?.rescuedNotes)[noteId] ?? [])
      .some(k => k.wrappedKey === key.wrappedKey && k.wrappedKeyNonce === key.wrappedKeyNonce);
  },

  /** The old key wraps kept for rescued notes, note id -> each. */
  keptNoteKeys(): Record<string, KeptKey[]> {
    return keptKeys(extras.rescuedNotes);
  },

  /** Stop keeping `noteId`'s keys in `gone` (their attachments came over). */
  async dropKeptNoteKeys(noteId: string, gone: readonly KeptKey[]): Promise<void> {
    extras = { ...extras, rescuedNotes: withoutKeptKeys(extras.rescuedNotes, noteId, gone) };
    await persistToServer();
  },

  /** Take on the record a rebuild wrote: its wrap, version, people and content. */
  adoptRebuiltRecord(id: string, rebuilt: {
    wrappedKey: string; nonce: string; version: number; members: NotebookMember[]; content: Record<string, unknown>;
  }): void {
    notebookWraps.set(id, { key: rebuilt.wrappedKey, nonce: rebuilt.nonce });
    knownNotebookItems.set(id, rebuilt.version);
    notebookMembers.set(id, rebuilt.members);
    notebookContents.set(id, rebuilt.content);
  },

  /**
   * Give a notebook with no key one (lib/notebookRepair `give-key`). Its
   * content is kept when a vault key here opens it (it was sealed under the
   * vault key itself); when none does, it is carried in the list first
   * ([carryRecord]) and the record is written new: its name, no people (a
   * notebook with no key could not have been shared as itself). The server
   * takes a first wrap on a plain write. True when the item has a key now.
   */
  async giveNotebookAKey(id: string, me: string): Promise<boolean> {
    if (!isCryptoReady()) return false;
    const name = notebooks().find(nb => nb.id === id)?.name;
    if (!name) return false;
    const item = await this.ownNotebookItemNow(id, me);
    if (!item) return false;
    if (item.wrapped_content_key) {
      // It has one by now (another device): take it, and that is all.
      adoptNotebookWrapAndRoster({ id, ...item });
      knownNotebookItems.set(id, item.version);
      return true;
    }
    let base: Record<string, unknown> | null = null;
    const sealed = { nonce: item.content_nonce, ciphertext: item.encrypted_content };
    try { base = notebookContentFrom(decryptNote(sealed)); } catch { /* not with this identity's key */ }
    if (!base) {
      try {
        const plaintext = decryptNoteWithRecoveredVault(sealed);
        base = plaintext === null ? null : notebookContentFrom(plaintext);
      } catch { /* nor with one from before */ }
    }
    if (!base && !(await this.carryRecord(id, {
      wrappedKey: null, wrappedKeyNonce: null, ciphertext: item.encrypted_content, nonce: item.content_nonce,
    }))) return false;
    const content = base
      ? mergeNotebookContent(base, { title: name, members: [] })
      : notebookItemContent(name, []) as unknown as Record<string, unknown>;
    const contentKey = generateContentKey();
    const wrapped = wrapContentKeyWithVault(contentKey);
    const enc = encryptWithContentKey(JSON.stringify(content), contentKey, id);
    const res = await apiRequest<{ version: number }>(`/api/v1/items/${id}`, {
      method: 'PUT',
      body: {
        encrypted_content: enc.ciphertext,
        content_nonce: enc.nonce,
        expected_version: item.version,
        wrapped_content_key: wrapped.wrappedKey,
        wrapped_content_key_nonce: wrapped.nonce,
      },
    });
    if (!res.success) return false;
    this.adoptRebuiltRecord(id, {
      wrappedKey: wrapped.wrappedKey, nonce: wrapped.nonce, version: res.data?.version ?? item.version + 1,
      members: [], content,
    });
    return true;
  },

  /**
   * Put back into rebuilt notebooks' records what their earlier records had
   * and they lack (lib/notebookRepair `fieldsToRestore`), for every earlier
   * record a key here now opens: a recovery key used since the rebuild. The
   * earlier record is then no longer carried. Returns how many records were
   * written.
   */
  async restoreFromEarlierRecords(): Promise<number> {
    const carried = carriedRecords(extras.rebuiltNotebooks);
    if (Object.keys(carried).length === 0 || !isCryptoReady()) return 0;
    let written = 0;
    let dropped = false;
    for (const [id, records] of Object.entries(carried)) {
      const done: EarlierRecord[] = [];
      for (const record of records) {
        let earlier: Record<string, unknown> | null = null;
        try {
          if (record.wrappedKey && record.wrappedKeyNonce) {
            const key = unwrapContentKeyWithVault(record.wrappedKey, record.wrappedKeyNonce);
            const plaintext = key ? decryptWithContentKey({ nonce: record.nonce, ciphertext: record.ciphertext }, key, id) : null;
            earlier = plaintext === null ? null : notebookContentFrom(plaintext);
          } else {
            const sealed = { nonce: record.nonce, ciphertext: record.ciphertext };
            let plaintext: string | null = null;
            try { plaintext = decryptNote(sealed); } catch { plaintext = decryptNoteWithRecoveredVault(sealed); }
            earlier = plaintext === null ? null : notebookContentFrom(plaintext);
          }
        } catch { earlier = null; }
        if (!earlier) continue;
        const now = notebookContents.get(id);
        const version = knownNotebookItems.get(id);
        const contentKey = this.notebookContentKey(id);
        if (!now || !version || !contentKey) continue;
        // Against what a rebuild writes: the fields it could only give their default.
        const next = fieldsToRestore(now, earlier, notebookItemContent('', []) as unknown as Record<string, unknown>);
        if (next) {
          const enc = encryptWithContentKey(JSON.stringify(next), contentKey, id);
          const res = await apiRequest<{ version: number }>(`/api/v1/items/${id}`, {
            method: 'PUT',
            body: { encrypted_content: enc.ciphertext, content_nonce: enc.nonce, expected_version: version },
          });
          if (!res.success) continue;
          knownNotebookItems.set(id, res.data?.version ?? version + 1);
          notebookContents.set(id, next);
          written++;
        }
        done.push(record);
      }
      if (done.length > 0) {
        extras = { ...extras, rebuiltNotebooks: withoutCarriedRecords(extras.rebuiltNotebooks, id, done) };
        dropped = true;
      }
    }
    if (dropped) await persistToServer();
    return written;
  },

  /** `notebookItemState` for callers that only name the notebook when it has an item. */
  async learnNotebookItem(id: string | null | undefined): Promise<boolean> {
    return (await this.notebookItemState(id)) === 'item';
  },

  create(name: string): Notebook {
    const nb: Notebook = {
      id: crypto.randomUUID(),
      name,
      noteCount: 0,
    };
    setNotebooks(prev => [...prev, nb]);
    persistToServer();
    void this.writeNotebookItem(nb.id, name);
    return nb;
  },

  rename(id: string, name: string) {
    setNotebooks(prev => prev.map(nb => nb.id === id ? { ...nb, name } : nb));
    persistToServer();
    void this.renameNotebookItem(id, name);
  },

  /** Keep the notebook item's title in step with the metadata blob. */
  async renameNotebookItem(id: string, name: string): Promise<void> {
    // "Not heard of" is not "no item": after a reload the syncs are a delta,
    // and an untouched notebook's item would never be renamed. Its title is
    // the name every READER of a shared notebook sees, so they would keep
    // the name it had. The server is asked first (`notebookItemState`).
    // Asked once more when there was no answer: a blip is not "no item", and
    // an item that is there keeps its OLD name for every reader if this gives
    // up.
    if (!knownNotebookItems.has(id) && (await this.notebookItemState(id)) === 'unknown') {
      await this.notebookItemState(id);
    }
    const version = knownNotebookItems.get(id);
    // No item at all — the backfill on the next load mints one carrying the
    // CURRENT name, so there is nothing to update here. Version 0 is the
    // "id taken by a row we cannot write" marker set on a 409; a PUT would
    // fail, as the server does not update a deleted row.
    //
    // With no ANSWER twice, an item that exists is not renamed now, and
    // nothing renames it afterwards; the same goes for the PUT below failing
    // (a rename made offline). This page's own list has the new name either
    // way. Readers get it at the next rename that does go through.
    if (!version || !isCryptoReady()) return;
    try {
      // REUSE the notebook's existing content key when we can open it.
      //
      // Rotating on a rename would silently lock out every member — they hold
      // the old key and a rename is not a revocation. Minting only happens when
      // the wrap is genuinely unavailable (a notebook written before wraps were
      // captured), where there is no member to lock out yet.
      const existingWrap = notebookWraps.get(id);
      const reused = existingWrap
        ? unwrapContentKeyWithVault(existingWrap.key, existingWrap.nonce)
        : null;
      // A wrap that EXISTS and will not open means this client cannot read the
      // notebook — a key from before a password reset, or one it was never
      // given. Minting here would overwrite the only pointer back to the real
      // key (and the roster sealed under it), so skip the item write; the
      // metadata blob still carries the new name. Same rule as note-android's
      // NotebookRepository.renameNotebook, and the server refuses such a PUT.
      if (existingWrap && !reused) {
        console.warn(`[note] not renaming notebook item ${id}: its content key does not open here`);
        return;
      }
      const contentKey = reused ?? generateContentKey();
      // Send a wrap only when the key is NEW. Re-sending the same wrap is
      // harmless but pointless, and omitting it leaves the server to keep the
      // wrap it already has.
      const wrapped = reused ? null : wrapContentKeyWithVault(contentKey);
      const enc = encryptWithContentKey(
        JSON.stringify(contentToWrite(id, name, membersOf(id))), contentKey, id);
      const res = await apiRequest<any>(`/api/v1/items/${id}`, {
        method: 'PUT',
        body: {
          encrypted_content: enc.ciphertext,
          content_nonce: enc.nonce,
          expected_version: version,
          ...(wrapped ? {
            wrapped_content_key: wrapped.wrappedKey,
            wrapped_content_key_nonce: wrapped.nonce,
          } : {}),
        },
      });
      if (res.success && res.data?.version) knownNotebookItems.set(id, res.data.version);
      // A minted key has to be cached or the next rename mints ANOTHER one,
      // and each rotation strands the members holding the previous key.
      if (res.success && wrapped) {
        notebookWraps.set(id, { key: wrapped.wrappedKey, nonce: wrapped.nonce });
      }
    } catch { /* metadata blob still carries the name; next load reconciles */ }
  },

  remove(id: string) {
    setNotebooks(prev => prev.filter(nb => nb.id !== id));
    // Delete the item too, or the backfill would treat the surviving row as a
    // notebook this client has simply not heard of yet.
    //
    // ALWAYS asked of the server, whatever this page knows of the item. Asking
    // only for an item this session's syncs had mentioned would miss the rest:
    // after a reload the syncs are a delta, so an untouched notebook's item
    // would SURVIVE its notebook, and with it every reader's invitation to it,
    // or their accepted (now empty) notebook. A notebook that never had an item
    // answers 404, which costs nothing.
    knownNotebookItems.delete(id);
    notebooksWithNoItem.delete(id);
    notebooksRemovedHere.add(id);
    void apiRequest(`/api/v1/items/${id}`, { method: 'DELETE' }).catch(() => {});
    // Drop the standing share list too — if the notebook is recreated
    // later, the user can re-share it explicitly.
    setNotebookShares(prev => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    persistToServer();
  },

  setLabelColor(label: string, color: string) {
    setLabelColors(prev => ({ ...prev, [label]: color }));
    persistToServer();
  },

  removeLabelColor(label: string) {
    setLabelColors(prev => {
      const next = { ...prev };
      delete next[label];
      return next;
    });
    persistToServer();
  },

  updateCounts(notes: { notebookId: string | null }[]) {
    const counts = new Map<string, number>();
    notes.forEach(n => {
      if (n.notebookId) counts.set(n.notebookId, (counts.get(n.notebookId) || 0) + 1);
    });
    // Only update if counts actually changed (avoid unnecessary re-renders)
    setNotebooks(prev => {
      let changed = false;
      const next = prev.map(nb => {
        const newCount = counts.get(nb.id) || 0;
        if (nb.noteCount !== newCount) { changed = true; return { ...nb, noteCount: newCount }; }
        return nb;
      });
      return changed ? next : prev;
    });
  },

  getById(id: string): Notebook | undefined {
    return notebooks().find(nb => nb.id === id);
  },

  /**
   * Merge a backup's metadata into this account, in ONE write.
   *
   * One write matters: all of this lives in a SINGLE `item_type = 10` row that
   * every client rewrites whole, so restoring twenty notebooks through
   * `create()` would be twenty round-trips racing each other over one row —
   * which is how an account ends up with duplicate metadata rows. Merging
   * locally and persisting once is both faster and the only version that is
   * safe.
   *
   * ADDITIVE, never destructive. A restore fills in what is missing and leaves
   * everything present alone: a notebook renamed since the backup keeps its new
   * name, a label recoloured keeps its new colour. Restoring is for getting
   * things back, not for winding the account back to the file's state — and a
   * restore must never silently overwrite newer work, because the user reaches
   * for it when something has already gone wrong.
   *
   * Notebook ids are PRESERVED, which is what lets restored notes land in the
   * right notebook: the note carries `notebook_id`, and a freshly-minted id
   * would leave every note unfiled.
   *
   * Standing share lists are NOT taken from the backup: they come from the
   * server's current rows, in [restoreStandingShares].
   */
  restoreFromBackup(backup: {
    notebooks?: { id: string; name: string }[];
    labelColors?: Record<string, string>;
    editorModes?: Record<string, string>;
  }): { notebooksAdded: number; labelColorsAdded: number; editorModesAdded: number } {
    const existingNotebooks = new Set(notebooks().map(nb => nb.id));
    const newNotebooks = (backup.notebooks ?? [])
      .filter(nb => nb && typeof nb.id === 'string' && typeof nb.name === 'string')
      .filter(nb => !existingNotebooks.has(nb.id))
      .map(nb => ({ id: nb.id, name: nb.name, noteCount: 0 }));
    if (newNotebooks.length > 0) setNotebooks(prev => [...prev, ...newNotebooks]);

    let labelColorsAdded = 0;
    if (backup.labelColors) {
      setLabelColors(prev => {
        const next = { ...prev };
        for (const [label, color] of Object.entries(backup.labelColors!)) {
          if (typeof color === 'string' && !(label in next)) { next[label] = color; labelColorsAdded++; }
        }
        return labelColorsAdded > 0 ? next : prev;
      });
    }

    let editorModesAdded = 0;
    if (backup.editorModes) {
      setEditorModes(prev => {
        // sanitizeOverrides drops anything that is not a real mode, so a
        // hand-edited or older backup cannot inject a value the editor would
        // not understand.
        const merged: Record<string, string> = { ...backup.editorModes, ...prev };
        const next = sanitizeOverrides(merged);
        editorModesAdded = Object.keys(next).length - Object.keys(prev).length;
        return editorModesAdded > 0 ? next : prev;
      });
    }

    if (newNotebooks.length || labelColorsAdded || editorModesAdded) {
      persistToServer();
    }
    return {
      notebooksAdded: newNotebooks.length,
      labelColorsAdded,
      editorModesAdded,
    };
  },

  /**
   * Give each of `notebookIds` that has no standing share list one built from
   * the server's CURRENT share rows. Run after [restoreFromBackup].
   *
   * A backup's own share lists are never used. The standing list is what
   * seals every future note in a notebook to its people, and removing someone
   * takes them off it; copying the file's list back would put everyone removed
   * since the backup was taken back on it, and each new note would go to them
   * again. So who stands on a notebook comes only from the rows the server
   * holds on it now: somebody removed since has none.
   *
   * Only a notebook with NO entry is filled; an existing list is never
   * touched, not even when the server's rows differ. A read that fails, or
   * finds nobody, leaves the notebook without an entry. `childNoteIds` names
   * the notes in a notebook now, whose rows carry the note right (see
   * [standingListFromServer]). Returns how many lists were set.
   */
  async restoreStandingShares(
    notebookIds: readonly string[],
    childNoteIds: (notebookId: string) => readonly string[],
  ): Promise<number> {
    // The restore adopts the server's rows: the holds come first.
    await holdsReady();
    const account = getTabAccount();
    const found = new Map<string, NotebookShareRecipient[]>();
    for (const id of new Set(notebookIds)) {
      if (id in notebookShares()) continue;
      // The ids come from a file and go into a request path: a UUID or nothing.
      if (tryCanonicalAccountId(id) === null) continue;
      const list = await standingListFromServer(id, childNoteIds(id));
      if (list.length > 0) found.set(id, list);
    }
    // The reads took time. Another account's signals are not this one's, and
    // a list made meanwhile (a share from the panel) is newer than ours.
    if (getTabAccount() !== account) return 0;
    let added = 0;
    setNotebookShares(prev => {
      const next = { ...prev };
      for (const [id, list] of found) {
        if (id in next) continue;
        // Never someone held off this notebook: their removal may not have
        // reached the object's rows yet (rekeyDrain retries that revoke).
        // (The filter drops a list it empties: an entry is never set empty.)
        const kept = withoutHeld({ [id]: list })[id];
        if (!kept) continue;
        next[id] = kept;
        added++;
      }
      return added > 0 ? next : prev;
    });
    if (added > 0) persistToServer();
    return added;
  },

  // --- Standing notebook-level shares ---
  //
  // Invariant: every entry in `notebookShares[notebookId]` represents a
  // recipient who must receive every note stored in that notebook. The
  // shares themselves live on the server, one row per (note, recipient)
  // pair. This metadata is the client-side source of truth for "who
  // should future notes in this notebook go to."

  notebookShares,

  getNotebookShares(notebookId: string): NotebookShareRecipient[] {
    return notebookShares()[notebookId] ?? [];
  },

  /** Add a recipient to a notebook's standing share list. Dedupes by
   *  email (case-insensitive) — re-sharing with the same email updates
   *  the permission and cached public key. */
  addNotebookShare(notebookId: string, recipient: NotebookShareRecipient) {
    const emailLc = recipient.email.toLowerCase();
    // Adding them back is the owner's word, newer than any removal still held.
    const held = heldRemovals.get(notebookId);
    if (held?.delete(emailLc) && held.size === 0) heldRemovals.delete(notebookId);
    setNotebookShares(prev => {
      const existing = prev[notebookId] ?? [];
      const filtered = existing.filter(r => r.email.toLowerCase() !== emailLc);
      return { ...prev, [notebookId]: [...filtered, recipient] };
    });
    persistToServer();
  },

  /**
   * The notebook's standing share list as the SERVER holds it now, read
   * again. For an invitation's finish, which must not act on this device's
   * list alone: another device of the owner's may have removed them. Null
   * when the row could not be read, or no key here opens it.
   */
  async serverStandingOf(notebookId: string): Promise<readonly NotebookShareRecipient[] | null> {
    const row = await readServerMetaRow();
    if (!row) return null;
    const server = decodeMetaRow(row);
    if (server === 'locked') return null;
    return server.meta.notebookShares?.[notebookId] ?? [];
  },

  /** Every write of the list asked for so far, landed or given up (the tail
   *  of [persistToServer]): what a write merged is in the list once it resolves. */
  whenWritten(): Promise<void> {
    return persistTail;
  },

  /**
   * Give a standing entry that was saved WITHOUT a key its keys: someone
   * invited before they had an account has one now, and the page has finished
   * their invitation (lib/finishInvitations).
   *
   * Only an entry that is still on the list and still without a key. This is
   * the page's own work, not the owner's word: it adds nobody, and unlike
   * `addNotebookShare` it never lifts a removal. Written with that, a finish
   * under way would put back someone the owner had removed in the meantime.
   *
   * @returns whether the entry was filled in.
   */
  finishNotebookShare(notebookId: string, recipient: NotebookShareRecipient): boolean {
    const emailLc = recipient.email.toLowerCase();
    if (heldRemovals.get(notebookId)?.has(emailLc)) return false;
    const waits = (r: NotebookShareRecipient) => r.email.toLowerCase() === emailLc && !r.publicKey;
    if (!(notebookShares()[notebookId] ?? []).some(waits)) return false;
    setNotebookShares(prev => ({
      ...prev,
      [notebookId]: (prev[notebookId] ?? []).map(r => (waits(r) ? recipient : r)),
    }));
    persistToServer();
    return true;
  },

  /**
   * Read one notebook item from the server again: its version, its wrap and,
   * when our vault opens it, its roster. For a removal's retry, which has to
   * act on the roster as the server holds it NOW: after a reload this session's
   * delta may not have brought the item, and an unknown roster reads as
   * "nobody to take out". 'live' with the roster read; 'deleted' for a
   * tombstone (its object rows can still be revoked, its roster is moot: a
   * deleted notebook takes no notes); 'gone' when the server has no such item
   * for us; 'failed' when it could not be read or opened.
   */
  async refreshNotebookItem(id: string): Promise<'live' | 'deleted' | 'gone' | 'failed'> {
    try {
      const r = await apiRequest<{
        id: string; version: number; deleted?: boolean; encrypted_content: string; content_nonce: string;
        wrapped_content_key?: string | null; wrapped_content_key_nonce?: string | null;
      }>(`/api/v1/items/${id}`);
      if (!r.success) return r.status === 404 ? 'gone' : 'failed';
      if (r.data.deleted) {
        knownNotebookItems.set(id, 0);
        return 'deleted';
      }
      knownNotebookItems.set(id, r.data.version);
      notebookMembers.delete(id);
      adoptNotebookWrapAndRoster({ ...r.data, id });
      return notebookMembers.has(id) ? 'live' : 'failed';
    } catch {
      return 'failed';
    }
  },

  /**
   * Is notebook `id` this account's own, live one, by the server's row and our
   * vault? For a restore that met a 409 on it. 'ours' when the row is this
   * account's, not trashed, and our vault opens its wrap (then its wrap, version
   * and roster are kept, as a sync would); 'trashed'; 'other' when the row is
   * another account's, or one we can't read (a 404: an older server's 409);
   * 'failed' when it couldn't be read or opened.
   */
  async readOwnNotebookItem(id: string): Promise<'ours' | 'trashed' | 'other' | 'failed'> {
    const me = getTabAccount();
    if (!me) return 'failed';
    try {
      const r = await apiRequest<{
        id: string; user_id?: string; version: number; deleted?: boolean; encrypted_content: string; content_nonce: string;
        wrapped_content_key?: string | null; wrapped_content_key_nonce?: string | null;
      }>(`/api/v1/items/${id}`);
      if (!r.success) return r.status === 404 ? 'other' : 'failed';
      if (tryCanonicalAccountId(r.data.user_id) !== me) return 'other';
      if (r.data.deleted) return 'trashed';
      adoptNotebookWrapAndRoster({ ...r.data, id });
      if (notebookOpenedVia(id) !== 'vault') return 'failed';
      knownNotebookItems.set(id, r.data.version);
      return 'ours';
    } catch {
      return 'failed';
    }
  },

  /** Wait until the holds for the signed-in account are in place (the gate). */
  whenHoldsReady(): Promise<void> {
    return holdsReady();
  },

  /**
   * A read of the signed-in account's re-key jobs begins (rekeyDepsLive: at
   * the start, and whenever its keys arrive again): the gate closes now, and
   * this read opens it unless another begins after it (see [HoldsRead]).
   */
  beginHoldsRead(): HoldsRead {
    const read = armHoldsGate();
    return {
      latest: () => read === holdsRead,
      loaded(jobs) {
        if (read !== holdsRead) return;
        for (const job of jobs) {
          const held = heldRemovals.get(job.notebookId) ?? new Set<string>();
          for (const email of job.removedRecipients) held.add(email.toLowerCase());
          if (held.size > 0) heldRemovals.set(job.notebookId, held);
        }
        setNotebookShares(prev => withoutHeld(prev));
        openHoldsGateFor(read);
      },
      open: () => openHoldsGateFor(read),
    };
  },

  /** Take `email` off a notebook's standing list, and keep them off until the
   *  server has the list without them ([holdRemovals]). */
  removeNotebookShare(notebookId: string, email: string): Promise<boolean> {
    return takeOffStandingList(notebookId, [email]);
  },

  /**
   * Take `emails` off a notebook's standing list and hold them off: every list
   * adopted from the server leaves them out until a write without them lands
   * (see heldRemovals). The list changes at once; the write follows.
   *
   * Resolves once that write has been tried: true when it landed, false when
   * the server may still list them. A re-key job keeps itself until it is true.
   */
  holdRemovals(notebookId: string, emails: readonly string[]): Promise<boolean> {
    return takeOffStandingList(notebookId, emails);
  },

  /** Remove every standing share for the given notebook (e.g. when
   *  the notebook itself is deleted). */
  clearNotebookShares(notebookId: string) {
    if (unconfirmed?.shares[notebookId]) dropFromUnconfirmed(notebookId, unconfirmed.shares[notebookId].map(p => p.email));
    setNotebookShares(prev => {
      if (!(notebookId in prev)) return prev;
      const next = { ...prev };
      delete next[notebookId];
      return next;
    });
    persistToServer();
  },
};
