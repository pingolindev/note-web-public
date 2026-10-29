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

import { apiRequest } from '../apiClient';
import { notebooksStore } from '../../stores/notebooks';
import { notesStore } from '../../stores/notes';
import { remindersStore } from '../../stores/reminders';
import { validateBackup, type NoteBackup } from '../backupFormat';
import { isEncryptedContainer, openBackup } from '../backupContainer';
import { isAccountStop } from '../account';
import { getVaultKey } from '../crypto';
import { derivedRestoreId, restoreIdKeyFrom } from '../restoreIds';
import { ingestProgress } from './pipeline';
import { sendWrite, writesForRun, type Writes } from './rateLimit';
import { parseBackupNotes } from './parsers/pingolinBackup';
import type { ImportState } from './types';

/**
 * The half of a restore that is NOT notes.
 *
 * Notes go through the ordinary import pipeline — parse, encrypt, POST — but a
 * backup also carries organisation that does not live in notes: notebooks,
 * label colours and editor-mode pins live in the single user-metadata row, and
 * reminders live in their own table. Restoring only the notes leaves an account
 * with every note unfiled and every reminder gone, which is not a restore.
 *
 * ORDER MATTERS. Notebooks must exist before the notes that reference them, or
 * the parser drops each note's `notebookId` as dangling and files everything at
 * the top level. Reminders must come after the notes, since a reminder points at
 * an item id that has to exist. So: metadata → notes → reminders.
 */

export interface RestoreSummary {
  notebooksAdded: number;
  labelColorsAdded: number;
  editorModesAdded: number;
  sharesAdded: number;
  remindersRestored: number;
  remindersSkipped: number;
  /** Notes the backup named as having attachments, whose files it did not carry. */
  notesMissingAttachments: number;
  /** Anything the writer already knew was missing. */
  writerWarnings: string[];
}

/**
 * Read and validate a backup file without applying any of it.
 *
 * A sealed and a plain backup are both JSON chosen from the same file dialog,
 * so this branches on the CONTENT rather than the file name. `needsPassphrase`
 * lets the caller prompt and try again instead of reporting a failure the user
 * cannot act on.
 */
export async function readBackupFile(file: Blob, passphrase?: string): Promise<
  { ok: true; backup: NoteBackup } | { ok: false; error: string; needsPassphrase?: boolean }
> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    return { ok: false, error: `Couldn't read that file: ${(e as Error).message}` };
  }

  if (isEncryptedContainer(parsed)) {
    const opened = await openBackup(parsed, passphrase ?? '');
    if (!opened.ok) {
      return { ok: false, error: opened.error, needsPassphrase: true };
    }
    parsed = opened.payload;
  }

  return validateBackup(parsed);
}

/** This account's key for derived ids (restoreIds), or null without a vault key. */
export async function restoreIdKey(): Promise<CryptoKey | null> {
  const vault = getVaultKey();
  return vault ? restoreIdKeyFrom(vault) : null;
}

/**
 * Where each backup notebook's notes go: under its own id, under the id
 * derived for it, or (absent) nowhere, restored unfiled.
 */
export interface NotebookPlan {
  fileUnder: ReadonlyMap<string, string>;
  /** Filed under a derived id: such a notebook starts with no standing list. */
  reIded: ReadonlySet<string>;
}

/**
 * Make every notebook the backup names this account's own, BEFORE the metadata
 * and the notes. The server files a note only into a notebook whose live item
 * the caller owns or holds a `contribute` share on, so:
 *  - a notebook with no item at all (a new account, or one deleted since the
 *    backup) would get every one of its notes refused with a 403 while the
 *    page said they were restored: its item is created first;
 *  - a notebook whose id another account holds must never take the notes: a
 *    squatter sharing it with `contribute` would have them filed into THEIR
 *    notebook, and the id would sit in this sidebar as the user's own. It gets
 *    the id derived for it instead, and failing that its notes are unfiled.
 * Ownership comes only from our vault opening the notebook's wrap.
 */
export async function restoreBackupNotebooks(backup: NoteBackup, reIdKey: CryptoKey | null): Promise<NotebookPlan> {
  const fileUnder = new Map<string, string>();
  const reIded = new Set<string>();
  for (const nb of backup.notebooks ?? []) {
    if (!nb || typeof nb.id !== 'string' || typeof nb.name !== 'string' || fileUnder.has(nb.id)) continue;
    const own = await ownNotebook(nb.id, nb.name);
    if (own === 'ours') {
      fileUnder.set(nb.id, nb.id);
      continue;
    }
    if (own !== 'other' || !reIdKey) continue;
    const derived = await derivedRestoreId(reIdKey, 'notebook', nb.id);
    if (await ownNotebook(derived, nb.name) === 'ours') {
      fileUnder.set(nb.id, derived);
      reIded.add(nb.id);
    }
  }
  return { fileUnder, reIded };
}

/** Make `id` an own notebook: ours already (our vault opens its wrap), made
 *  now, or on a 409 ours by the server's row. */
async function ownNotebook(id: string, name: string): Promise<'ours' | 'other' | 'trashed' | 'failed'> {
  if (notebooksStore.notebookOpenedVia(id) === 'vault') return 'ours';
  const made = await notebooksStore.createNotebookItem(id, name);
  if (made === 'created') return 'ours';
  if (made === 'not-ours') return 'other';
  if (made === 'exists') return notebooksStore.readOwnNotebookItem(id);
  return 'failed';
}

/** The backup as this account can take it: its notebooks under the ids the plan
 *  gives them (the others dropped), and each note filed accordingly. A note
 *  whose notebook isn't planned loses the reference, so it restores unfiled. */
export function planBackup(backup: NoteBackup, plan: NotebookPlan): NoteBackup {
  return {
    ...backup,
    notebooks: (backup.notebooks ?? [])
      .filter(nb => nb && plan.fileUnder.has(nb.id))
      .map(nb => ({ ...nb, id: plan.fileUnder.get(nb.id)! })),
    notes: backup.notes.map(n => {
      if (typeof n?.notebookId !== 'string') return n;
      const to = plan.fileUnder.get(n.notebookId);
      return { ...n, notebookId: to ?? null };
    }),
  };
}

/** How many of the notes this restore CREATED lost a notebook the backup
 *  defines (for "restored outside their notebook"). */
export function unfiledCount(backup: NoteBackup, plan: NotebookPlan, createdIds: ReadonlySet<string>): number {
  const defined = new Set((backup.notebooks ?? []).filter(nb => nb && typeof nb.id === 'string').map(nb => nb.id));
  return backup.notes.filter(n => n && typeof n.notebookId === 'string' && defined.has(n.notebookId)
    && !plan.fileUnder.has(n.notebookId) && createdIds.has(n.id)).length;
}

/**
 * Apply the metadata half. Run BEFORE the notes, after [restoreBackupNotebooks].
 *
 * One write to the metadata row, not one per notebook — see
 * `notebooksStore.restoreFromBackup`. Only the notebooks the plan made this
 * account's own go in, under their planned ids.
 *
 * The backup's `notebookShares` is never applied: anyone removed from a
 * notebook after the file was made would get every new note in it again. An
 * own notebook the backup names that has no standing list gets one from the
 * server's current rows instead (`notebooksStore.restoreStandingShares`); one
 * filed under a derived id is new, and starts with none.
 */
export async function restoreBackupMetadata(backup: NoteBackup, plan: NotebookPlan) {
  const planned = planBackup(backup, plan);
  const summary = notebooksStore.restoreFromBackup({
    notebooks: planned.notebooks,
    labelColors: backup.labelColors,
  });
  const own = [...plan.fileUnder.entries()].filter(([from]) => !plan.reIded.has(from)).map(([, id]) => id);
  const sharesAdded = await notebooksStore.restoreStandingShares(
    own,
    (notebookId) => notesStore.notes()
      .filter(n => !n.deleted && n.notebookId === notebookId)
      .map(n => n.id),
  );
  return { ...summary, sharesAdded };
}

/** Each backup note id → the id it is here under, for what the file keys by
 *  note (editor modes, reminders, attachments): remapped, or dropped when the
 *  note wasn't restored. */
function remapByNote<T>(entries: [string, T][], finalIds: ReadonlyMap<string, string>): [string, T][] {
  return entries.flatMap(([id, v]) => (finalIds.has(id) ? [[finalIds.get(id)!, v] as [string, T]] : []));
}

/** The editor-mode pins, AFTER the notes: keyed by each note's final id. */
export function restoreBackupEditorModes(backup: NoteBackup, finalIds: ReadonlyMap<string, string>) {
  const editorModes = Object.fromEntries(remapByNote(Object.entries(backup.editorModes ?? {}), finalIds));
  return notebooksStore.restoreFromBackup({ editorModes }).editorModesAdded;
}

/** The backup's reminders, pointed at each note's final id; a note not restored takes none. */
export function remindersFor(backup: NoteBackup, finalIds: ReadonlyMap<string, string>): NoteBackup {
  return {
    ...backup,
    reminders: (backup.reminders ?? []).flatMap(r =>
      r && typeof r.itemId === 'string' && finalIds.has(r.itemId) ? [{ ...r, itemId: finalIds.get(r.itemId)! }] : []),
    attachments: (backup.attachments ?? []).flatMap(a =>
      a && typeof a.noteId === 'string' && finalIds.has(a.noteId) ? [{ ...a, noteId: finalIds.get(a.noteId)! }] : []),
  };
}

/**
 * What the restored view says: the real outcome, never the file's count.
 * "Already here" still counts as restored, so restoring the same file twice
 * reads clean.
 */
export function restoreSummary(o: {
  restored: number;
  failed: number;
  unfiled: number;
  notebooksAdded: number;
  remindersRestored: number;
}): { summary: string; lines: string[] } {
  const parts = [`Restored ${o.restored} note(s)`];
  if (o.notebooksAdded) parts.push(`${o.notebooksAdded} notebook(s)`);
  if (o.remindersRestored) parts.push(`${o.remindersRestored} reminder(s)`);
  const lines: string[] = [];
  if (o.failed > 0) lines.push(`${o.failed} note(s) couldn't be restored.`);
  if (o.unfiled > 0) lines.push(`${o.unfiled} note(s) were restored outside their notebook.`);
  return { summary: parts.join(', ') + '.', lines };
}

/**
 * Apply the reminders half. Run AFTER the notes, so their items exist.
 *
 * A reminder whose note is missing is SKIPPED, not failed: the note may have
 * been excluded from the backup, or already deleted deliberately, and a
 * dangling reminder would fire pointing at nothing. Reminders are also a paid
 * feature, so a free account gets a clean skip rather than a wall of errors.
 */
export async function restoreBackupReminders(
  backup: NoteBackup,
  liveNoteIds: Set<string>,
  writes: Writes = writesForRun(),
): Promise<{ restored: number; skipped: number; blockedReason?: string }> {
  let restored = 0;
  let skipped = 0;

  // The app's model is one reminder per note — remindersStore.create replaces
  // any existing one for that note. So a note that ALREADY has a reminder is
  // left alone: it may be newer than the backup, and a restore must not
  // overwrite newer work.
  const notesWithReminders = new Set(remindersStore.reminders().map(r => r.itemId));

  for (const r of backup.reminders) {
    if (!r || typeof r.itemId !== 'string' || typeof r.triggerAt !== 'string') { skipped++; continue; }
    if (!liveNoteIds.has(r.itemId)) { skipped++; continue; }
    if (notesWithReminders.has(r.itemId)) { skipped++; continue; }

    const body = {
      item_id: r.itemId,
      trigger_at: r.triggerAt,
      repeat_rule: r.repeatRule ?? null,
    };
    const resp = await sendWrite(writes, () => apiRequest('/api/v1/reminders', { method: 'POST', body }));
    // The tab is another account's now: nothing more of this restore is sent.
    if (isAccountStop(resp)) break;
    if (resp.success) {
      restored++;
      notesWithReminders.add(r.itemId);
      continue;
    }

    skipped++;
    // Reminders are a paid feature (402 + PREMIUM_REQUIRED_REMINDERS). On a
    // free account EVERY reminder fails the same way, so stop and say it once
    // rather than firing one doomed request per reminder and reporting a wall
    // of identical errors.
    if (resp.status === 402) {
      const remaining = backup.reminders.length - restored - skipped;
      skipped += Math.max(0, remaining);
      return {
        restored,
        skipped,
        blockedReason: 'Reminders need a subscription, so the reminders in this backup were not restored. Your notes were.',
      };
    }
  }

  return { restored, skipped };
}

/**
 * A whole restore, in its one order: the notebooks with their items, the
 * metadata, the notes (filed as the plan says, re-filed under a derived id
 * where another account holds theirs), then the editor pins and reminders keyed
 * by each note's final id. Returns what the restored view says, or null when
 * the notes stopped on an error (already reported through `onState`).
 */
export async function runRestore(
  backup: NoteBackup,
  onState: (s: ImportState) => void,
): Promise<{ summary: string; warnings: string[] } | null> {
  const reIdKey = await restoreIdKey();
  // One budget under the server's write limit for the whole restore (rateLimit).
  const writes = writesForRun();
  const plan = await restoreBackupNotebooks(backup, reIdKey);
  const meta = await restoreBackupMetadata(backup, plan);

  let failedWith: string | null = null;
  let done: Extract<ImportState, { kind: 'complete' }> | null = null;
  // The already-unsealed, already-validated backup — not the file, which may
  // still be a sealed container this generator cannot open.
  await ingestProgress(parseBackupNotes(planBackup(backup, plan)), (s) => {
    if (s.kind === 'error') failedWith = s.message;
    if (s.kind === 'complete') done = s;
    onState(s);
  }, { reIdKey, writes });
  if (failedWith !== null || done === null) return null;
  const outcome: Extract<ImportState, { kind: 'complete' }> = done;
  const finalIds = outcome.finalIds ?? new Map<string, string>();

  restoreBackupEditorModes(backup, finalIds);
  // Reminders bind to item ids, so only offer the ones whose note is actually
  // here now — including notes that were already present before this restore.
  const liveNoteIds = new Set(notesStore.notes().filter(n => !n.deleted).map(n => n.id));
  const rem = await restoreBackupReminders(remindersFor(backup, finalIds), liveNoteIds, writes);

  const { summary, lines } = restoreSummary({
    restored: outcome.count + (outcome.present ?? 0),
    failed: outcome.failed ?? 0,
    unfiled: unfiledCount(backup, plan, outcome.createdIds ?? new Set()),
    notebooksAdded: meta.notebooksAdded,
    remindersRestored: rem.restored,
  });
  return {
    summary,
    warnings: [...backupWarnings(backup), ...(rem.blockedReason ? [rem.blockedReason] : []), ...lines],
  };
}

/** What the file says it could not bring, for the user to see before starting. */
export function backupWarnings(backup: NoteBackup): string[] {
  const warnings: string[] = [...(backup.incompleteReasons ?? [])];
  const missingAttachments = backup.attachments.length;
  if (missingAttachments > 0 && !warnings.some(w => /attachment/i.test(w))) {
    warnings.push(
      `${missingAttachments} note(s) had attachments. Backups list attachments but do not contain the files, so those notes restore without them.`,
    );
  }
  return warnings;
}
