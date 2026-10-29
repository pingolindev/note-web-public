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
 * Notebooks after a password reset, put to work (the rules: lib/notebookRepair).
 *
 * `repairNotebooksAfterReset` runs in the background after a load's sync, as the
 * backfill of notebook items does: nothing to do for almost every account, and
 * for one whose password was reset by e-mail it makes every notebook the person
 * meets work again, with nothing asked of them. `repairNotebookNow` is the
 * Share panel's, for a notebook it is asked to share and cannot open.
 */
import { notebooksStore } from '../stores/notebooks';
import { notesStore } from '../stores/notes';
import { sharesInboxStore } from '../stores/sharesInbox';
import { authStore } from '../stores/auth';
import { scopedGetItem, scopedRemoveItem, scopedSetItem, tryCanonicalAccountId } from './account';
import { getPreviousVaultKeys, isCryptoReady, vaultKeyThatOpens } from './crypto';
import { previousIdentitiesAnswered } from './previousIdentities';
import { recordRepair, type KeptKey } from './notebookRepair';
import { holdersOf, rebuildNotebookRecord, rescueNoteFromCopy } from './shareUtils';
import { listAttachmentsForRekey, rekeyNoteAttachments } from './attachmentUpload';
import { retain as retainContentKey } from './retainedKeys';
import { unwrapContentKeyWithVault } from './crypto';

/**
 * Rebuilds in one run, at most. Each is a rotate-shares call, which the server
 * allows ten of a minute per account; the rest are done at the next load.
 */
export const REBUILDS_PER_RUN = 3;

/** How many full-pull events to wait for, when a repair needs one, before leaving it to the next load. */
const PULLS_TO_WAIT = 3;

/**
 * The rotate-shares calls the server allows an account in a minute.
 */
export const ROTATIONS_A_MINUTE = 10;
/**
 * Notes rescued from this browser's copies in one go (lib/noteRescue), and the
 * wait between two goes: each is a rotate-shares call. One of the minute's is
 * left for whatever the person does meanwhile, and the first go also counts the
 * run's rebuilds; a move a rescue left owed is sent after a wait of its own, so
 * rebuilds, rescues and owed moves together stay within the limit. A go that
 * rescues nothing ends it; the rest wait for the next load.
 */
export const RESCUES_PER_GO = ROTATIONS_A_MINUTE - 1;
export const BETWEEN_GOES_MS = 65_000;

/**
 * Per account: what a run that found nothing to do saw (`quietState`). While it
 * is all there is at the next load, that load does not pull everything again
 * to find nothing again (an account with notes locked for good would otherwise
 * pull in full at every load).
 */
const QUIET_KEY = 'note:afterResetQuiet';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface RepairSummary {
  listRewritten: boolean;
  notebooksKept: number;
  notebooksBack: number;
  keysGiven: number;
  rebuilt: number;
  restored: number;
  waiting: number;
  /** Notes re-saved from this browser's copies (lib/noteRescue). */
  notesRescued: number;
  /** Notes whose copy here is older than the server's: they stay locked. */
  notesStale: number;
  /** Notes others hold: left as they are, locked for this identity. */
  notesHeld: number;
  /** People and acceptances set aside at a locked list, put back as the server confirmed them. */
  peopleConfirmed: number;
  /** Locked notebooks others hold: left to their owner (the Share panel), not waiting. */
  notebooksHeld: number;
  /** Attachments of rescued notes brought over after a recovery. */
  attachmentsBack: number;
}

const me = (): string | null => tryCanonicalAccountId(authStore.user()?.id ?? null);

/** Every note of the account's in a notebook, the locked ones included; [] when not known. */
const noteIdsIn = (notebookId: string): readonly string[] => notesStore.notebookNoteIds(notebookId) ?? [];

/**
 * Wait for a FULL pull, asked for, if none has finished this session. False
 * when none came, or the page's account changed meanwhile.
 */
async function fullPull(account: string): Promise<boolean> {
  if (notebooksStore.hasPulled(true)) return true;
  notesStore.requestFullPull();
  for (let i = 0; i < PULLS_TO_WAIT && !notebooksStore.hasPulled(true); i++) {
    await notebooksStore.nextPullEvent();
    if (me() !== account) return false;
  }
  return notebooksStore.hasPulled(true);
}

/**
 * Rebuild one notebook record no key here opens, in place. The record as it is
 * is carried in the list first, and nothing is rebuilt unless that landed.
 */
async function rebuildOne(id: string, account: string, attended: boolean): Promise<boolean> {
  const name = notebooksStore.notebooks().find(nb => nb.id === id)?.name;
  if (!name) return false;
  const item = await notebooksStore.ownNotebookItemNow(id, account);
  if (!item) return false;
  if (!item.wrapped_content_key || !item.wrapped_content_key_nonce) {
    return notebooksStore.giveNotebookAKey(id, account);
  }
  // Another device rebuilt it since this page's sync: it opens, and there is
  // nothing to rebuild. The page learns the item again from the server.
  if (vaultKeyThatOpens(item.wrapped_content_key, item.wrapped_content_key_nonce) !== null) {
    await notebooksStore.refreshNotebookItem(id);
    return notebooksStore.notebookContentKey(id) !== null;
  }
  const childIds = notesStore.notebookNoteIds(id);
  if (!childIds) return false;
  const kept = await notebooksStore.carryRecord(id, {
    wrappedKey: item.wrapped_content_key,
    wrappedKeyNonce: item.wrapped_content_key_nonce,
    ciphertext: item.encrypted_content,
    nonce: item.content_nonce,
  });
  if (!kept) return false;
  const result = await rebuildNotebookRecord(id, name, item.version, childIds, { attended });
  return result.rotated;
}

/**
 * Make every one of the person's notebooks usable after a password reset. Safe
 * to run on every load: each step does nothing when there is nothing to do.
 */
export async function repairNotebooksAfterReset(): Promise<RepairSummary> {
  const summary: RepairSummary = {
    listRewritten: false, notebooksKept: 0, notebooksBack: 0, keysGiven: 0, rebuilt: 0, restored: 0, waiting: 0,
    notesRescued: 0, notesStale: 0, notesHeld: 0, attachmentsBack: 0, peopleConfirmed: 0, notebooksHeld: 0,
  };
  const account = me();
  if (!account || !isCryptoReady()) return summary;

  // The list first: what is on it is what the records are repaired for.
  summary.listRewritten = await notebooksStore.rewriteListUnderThisIdentity();

  const listLocked = notebooksStore.listAfterReset().locked;
  const recordsToFix = () => notebooksStore.notebooks()
    .map(nb => ({ id: nb.id, state: notebooksStore.recordStateOf(nb.id, account) }))
    .filter(({ state }) => state === 'keyless' || state === 'locked');
  // Notes a reset locked say there was one. A browser that held the account
  // before it then lists its notebooks from its own copy, and after a reload
  // its syncs are a delta that never brings their items again: what their
  // records are is not known until a FULL pull has brought every one.
  // So does a copy this browser kept of a note whose key now opens with nothing.
  const aResetHappened = listLocked || notesStore.lockedOwnIds().size > 0 || notesStore.cachedCopiesNoKeyOpens();
  // Nothing has changed since a run that found nothing to do: no pull, no run.
  if (aResetHappened && scopedGetItem(QUIET_KEY) === quietState(listLocked, recordsToFix().map(r => r.id))) return summary;
  if ((aResetHappened || recordsToFix().length > 0) && !(await fullPull(account))) return summary;
  if (me() !== account) return summary;

  // Nothing is written over a locked list, nor rebuilt, before it is known what
  // was recovered from before a reset: a list or record that opens with no key
  // here may open with one not loaded yet, and then it is read whole, nothing
  // carried and nothing asked again.
  const answered = previousIdentitiesAnswered();
  if (answered) {
    // People and acceptances this page held when its list turned out locked
    // are put back as far as the server confirms them, before anything is
    // written with them. Their own write too waits for the above: run first,
    // it would write over a locked list.
    summary.peopleConfirmed = await notebooksStore.confirmHeldPeople({
      offered: sharesInboxStore.offeredNotebooks(),
      declined: sharesInboxStore.declinedNotebooks(),
    });
    if (me() !== account) return summary;
    summary.notebooksKept = await notebooksStore.keepNotebooksWhileListLocked(account);
  }
  summary.notebooksBack = await notebooksStore.mergeBackEarlierLists(noteIdsIn);

  let rebuilds = 0;
  for (const { id, state } of recordsToFix()) {
    if (me() !== account) return summary;
    const repair = recordRepair(state, answered);
    if (repair === 'give-key') {
      if (await notebooksStore.giveNotebookAKey(id, account)) summary.keysGiven++;
    } else if (repair === 'rebuild') {
      if (rebuilds >= REBUILDS_PER_RUN) { summary.waiting++; continue; }
      rebuilds++;
      // Nobody asked for this one: a notebook anyone else holds is left to the
      // owner (the Share panel), before anything is carried.
      const held = await holdersOf(id);
      if (held === null) { summary.waiting++; continue; }
      if (held > 0) { summary.notebooksHeld++; continue; }
      if (await rebuildOne(id, account, false)) summary.rebuilt++;
    } else if (repair === 'wait') {
      summary.waiting++;
    }
  }

  summary.restored = await notebooksStore.restoreFromEarlierRecords();

  // Notes this browser kept a copy of (lib/noteRescue), in goes the
  // server's limit allows.
  if (answered) {
    // This minute's rotations so far: the run's rebuilds.
    let used = summary.rebuilt;
    for (;;) {
      if (me() !== account) return summary;
      const go = await notesStore.rescueFromCopies({
        rescue: (copy, notebookId) => rescueNoteFromCopy(copy, notebookId),
        keepOldKey: (id, key) => notebooksStore.keepOldNoteKey(id, key),
        attachmentsOf: id => listAttachmentsForRekey(id),
        limit: Math.max(0, RESCUES_PER_GO - used),
      });
      summary.notesRescued += go.rescued;
      summary.notesStale += go.stale;
      summary.notesHeld += go.held;
      summary.waiting += go.waiting;
      // A move a rescued note still owes is sent as any waiting save is, in a
      // minute of its own: each may re-key the note.
      if (go.movesQueued > 0) {
        await pause(BETWEEN_GOES_MS);
        if (me() !== account) return summary;
        try { await notesStore.flushPending(); } catch { /* the next sync sends it */ }
      }
      if (go.left === 0 || go.rescued === 0) break;
      await pause(BETWEEN_GOES_MS);
      used = 0;
    }
  }
  summary.attachmentsBack = await restoreRescuedAttachments();

  const didSomething = summary.listRewritten || summary.notebooksKept || summary.notebooksBack || summary.keysGiven || summary.rebuilt
    || summary.restored || summary.notesRescued || summary.attachmentsBack || summary.peopleConfirmed;
  if (didSomething || summary.notesStale || summary.notesHeld || summary.notebooksHeld || summary.waiting) {
    console.info('[note] notebooks after a password reset:', summary);
  }
  // Remember a run that found nothing to do and left nothing waiting, with what
  // it saw; anything else is looked at again at the next load.
  try {
    if (aResetHappened && !didSomething && summary.waiting === 0 && me() === account) {
      scopedSetItem(QUIET_KEY, quietState(notebooksStore.listAfterReset().locked, recordsToFix().map(r => r.id)));
    } else {
      scopedRemoveItem(QUIET_KEY);
    }
  } catch { /* storage unavailable: the next load looks again */ }
  return summary;
}

/** What a quiet run saw: anything here that changes is worth a full look again. */
function quietState(listLocked: boolean, records: readonly string[]): string {
  return JSON.stringify({
    listLocked,
    records: [...records].sort(),
    locked: [...notesStore.lockedOwnIds()].sort(),
    copies: notesStore.cachedCopiesNoKeyOpens(),
    recovered: getPreviousVaultKeys().length,
    answered: previousIdentitiesAnswered(),
    heldAside: notebooksStore.heldAsideCount(),
  });
}

/**
 * Rescued notes' attachments, brought over to the note's key now, for each old
 * key kept for them (`rescuedNotes`) that a key here opens: a recovery key used
 * since the rescue. Meanwhile the old key is kept on this browser too, so the
 * owner can open them before they come over (as after any rotation). A key is
 * dropped from the list only when every attachment under it came over.
 * Returns how many came over.
 */
export async function restoreRescuedAttachments(): Promise<number> {
  let brought = 0;
  for (const [noteId, keys] of Object.entries(notebooksStore.keptNoteKeys())) {
    const card = notesStore.notes().find(n => n?.id === noteId);
    if (!card?.wrappedContentKey || !card.wrappedContentKeyNonce) continue;
    // A card still under a kept key is not the rescued note yet (a save put the
    // old wrap back, say): bringing them "over" to it would drop the only kept
    // wrap with nothing changed.
    if (keys.some(k => k.wrappedKey === card.wrappedContentKey)) continue;
    const newKey = unwrapContentKeyWithVault(card.wrappedContentKey, card.wrappedContentKeyNonce);
    if (!newKey) continue;
    const done: KeptKey[] = [];
    for (const key of keys) {
      const oldKey = unwrapContentKeyWithVault(key.wrappedKey, key.wrappedKeyNonce);
      if (!oldKey) continue;
      retainContentKey(noteId, oldKey);
      // Which files it sealed is not known (kept by a build that recorded
      // none): nothing is brought over, and the key stays kept, its files
      // viewable under it, flagged, for the owner to keep. A file listed now
      // may have been added since, by anyone holding it.
      if (key.attachmentIds === undefined) continue;
      const listed = await listAttachmentsForRekey(noteId);
      if (!listed) continue;
      // Only those it had when it was rescued: sealed under this key.
      const ids = new Set(key.attachmentIds ?? []);
      const rows = listed.filter(row => ids.has(row.id));
      const r = rows.length > 0 ? await rekeyNoteAttachments(noteId, rows, oldKey, newKey) : { rekeyed: 0, failed: 0 };
      brought += r.rekeyed;
      if (r.failed === 0) done.push(key);
    }
    if (done.length > 0) await notebooksStore.dropKeptNoteKeys(noteId, done);
  }
  return brought;
}

/**
 * The Share panel's: make the notebook it is asked to share and cannot open
 * usable now. True when it opens afterwards.
 */
export async function repairNotebookNow(id: string): Promise<boolean> {
  const account = me();
  if (!account || !isCryptoReady()) return false;
  const state = notebooksStore.recordStateOf(id, account);
  if (state === 'opens') return notebooksStore.notebookContentKey(id) !== null;
  if (!(await fullPull(account)) || me() !== account) return false;
  const repair = recordRepair(notebooksStore.recordStateOf(id, account), previousIdentitiesAnswered());
  if (repair === 'give-key' && !(await notebooksStore.giveNotebookAKey(id, account))) return false;
  if (repair === 'rebuild') {
    // Its people set aside when the list turned out locked, not confirmed yet,
    // are on no list a rebuild reads: given no key, they would be cut off, and
    // nothing would say so. Confirmed first; any still set aside (their rows
    // not read), it is not rebuilt now.
    if (notebooksStore.heldAsideIn(id) > 0) await notebooksStore.confirmHeldPeople({ offered: null, declined: new Set() });
    if (notebooksStore.heldAsideIn(id) > 0 || me() !== account) return false;
    if (!(await rebuildOne(id, account, true))) return false;
  }
  if (repair === 'wait') return false;
  return notebooksStore.notebookContentKey(id) !== null;
}
