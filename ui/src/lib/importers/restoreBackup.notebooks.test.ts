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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, type NoteBackup } from '../backupFormat';

/**
 * A restore files notes only into notebooks this account owns, gives those
 * notebooks their items before any note, re-files what another account holds
 * under the derived id, and says what really happened.
 *
 * WHY THESE EXIST
 *   - The server files a note only into a notebook whose LIVE item the caller
 *     owns or holds a `contribute` share on. A restore into a new account, or
 *     of a notebook deleted since the backup, that created no items first
 *     would get a 403 for every note filed in a notebook while the page said
 *     "Restored N note(s)".
 *   - A squatter's item under a notebook's id, shared with `contribute`, would
 *     have the restored notes filed into THEIR notebook, with the id sitting
 *     in the sidebar as the user's own.
 */

const ME = '0e0e0e0e-0000-4000-8000-00000000000e';
const OTHER = '0e0e0e0e-0000-4000-8000-00000000000f';

const apiRequest = vi.fn();
vi.mock('../apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../crypto', () => ({
  isCryptoReady: () => true,
  getVaultKey: () => new Uint8Array(32).fill(1),
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'ours', nonce: 'n' }),
  unwrapContentKeyWithVault: (key: string) => (key === 'ours' ? new Uint8Array(32).fill(7) : null),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
}));
let liveNotes: { id: string; notebookId: string | null; deleted?: boolean }[] = [];
vi.mock('../../stores/notes', () => ({ notesStore: { notes: () => liveNotes, sync: async () => {} } }));
vi.mock('../../stores/reminders', () => ({ remindersStore: { reminders: () => [] } }));
/** Every write budget made: one restore keeps ONE, for its notes and its reminders. */
const budgets: unknown[] = [];
vi.mock('./rateLimit', async (orig) => {
  const real = await orig<typeof import('./rateLimit')>();
  return { ...real, writesForRun: (...a: Parameters<typeof real.writesForRun>) => { const w = real.writesForRun(...a); budgets.push(w); return w; } };
});

const NB_NEW = '11111111-1111-4111-8111-111111111111';   // no item anywhere yet
const NB_SQUAT = '22222222-2222-4222-8222-222222222222'; // another account holds this id
const NB_TRASH = '33333333-3333-4333-8333-333333333333'; // our own, in the trash
const N1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const N2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const N3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];
/** The server: ids another account holds; rows a GET returns; notebook items created. */
let held = new Set<string>();
const madeNotebooks = new Set<string>();
const madeItems = new Set<string>();
let rows: Record<string, unknown> = {};
let notebooksStore: typeof import('../../stores/notebooks').notebooksStore;
let m: typeof import('./restoreBackup');

function backupOf(over: Partial<NoteBackup> = {}): NoteBackup {
  const note = (id: string, notebookId: string | null) => ({
    id, title: id, body: '', noteType: 'text', color: null, isPinned: false, isArchived: false, labels: [],
    sortOrder: 0, editMode: 'rich' as const, notebookId, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
  return {
    format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, client: 'web', generatedAt: '2026-08-12T00:00:00.000Z',
    isComplete: true, counts: { notes: 3, notebooks: 3, reminders: 0, notesWithAttachments: 0 },
    notebooks: [{ id: NB_NEW, name: 'New' }, { id: NB_SQUAT, name: 'Squatted' }, { id: NB_TRASH, name: 'Trashed' }],
    labelColors: {}, editorModes: { [N1]: 'markdown', [N2]: 'markdown' }, notebookShares: {},
    notes: [note(N1, NB_NEW), note(N2, NB_SQUAT), note(N3, NB_TRASH)] as unknown as NoteBackup['notes'],
    reminders: [
      { id: 'r1', itemId: N1, triggerAt: '2026-12-01T00:00:00Z', repeatRule: null },
      { id: 'r2', itemId: 'gone-note', triggerAt: '2026-12-01T00:00:00Z', repeatRule: null },
    ],
    attachments: [],
    ...over,
  } as NoteBackup;
}

beforeEach(async () => {
  await new Promise(r => setTimeout(r, 10));
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  liveNotes = [];
  madeNotebooks.clear();
  madeItems.clear();
  held = new Set([NB_SQUAT]);
  rows = {
    [NB_TRASH]: { success: true, data: { id: NB_TRASH, user_id: ME, version: 2, deleted: true, content_nonce: 'n', encrypted_content: '{}' } },
    [NB_SQUAT]: { success: true, data: { id: NB_SQUAT, user_id: OTHER, version: 1, deleted: false, content_nonce: 'n', encrypted_content: '{}' } },
  };
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: any }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
    calls.push(c);
    if (c.method === 'POST' && url === '/api/v1/items') {
      const id = c.body.id as string | undefined;
      if (c.body.item_type === 10) return { success: true, data: { id: 'meta', version: 1 } };
      if (id && held.has(id)) return { success: false, status: 403, error: 'You do not have write access to this item', error_code: 'item_not_owned' };
      if (id && id === NB_TRASH) return { success: false, status: 409, error_code: 'item_already_exists', error: 'An item with this id already exists' };
      // The server's placement rule: a note goes only into a notebook whose live item we own.
      if (c.body.item_type === 1 && c.body.notebook_id && !madeNotebooks.has(c.body.notebook_id)) {
        return { success: false, status: 403, error: 'You do not have permission to add notes to that notebook' };
      }
      if (id && madeItems.has(id)) return { success: false, status: 409, error_code: 'item_already_exists', error: 'An item with this id already exists' };
      if (c.body.item_type === 2) madeNotebooks.add(id!);
      if (id) madeItems.add(id);
      return { success: true, data: { id, version: 1 } };
    }
    const g = /^\/api\/v1\/items\/([^/]+)$/.exec(url);
    if (g && c.method === 'GET' && madeItems.has(g[1]) && !rows[g[1]]) {
      return { success: true, data: { id: g[1], user_id: ME, version: 1, deleted: false, content_nonce: 'n',
        encrypted_content: JSON.stringify({ title: 'x', members: [] }), wrapped_content_key: 'ours', wrapped_content_key_nonce: 'n' } };
    }
    if (g && c.method === 'GET') return rows[g[1]] ?? { success: false, status: 404 };
    if (c.method === 'PUT') return { success: true, data: { version: 2 } };
    if (url.endsWith('/shares')) return { success: true, data: [] };
    return { success: false, status: 404 };
  });
  ({ notebooksStore } = await import('../../stores/notebooks'));
  const { setTabAccount } = await import('../account');
  setTabAccount(null);
  setTabAccount(ME);
  notebooksStore.beginHoldsRead().open();
  notebooksStore.markPulled();
  m = await import('./restoreBackup');
});

const notebookPosts = () => calls.filter(c => c.method === 'POST' && c.body?.item_type === 2).map(c => c.body.id);
const notePosts = () => calls.filter(c => c.method === 'POST' && c.body?.item_type === 1);

describe("the backup's notebooks, made this account's own first", () => {
  it('creates the item of one that has none, keeps one ours already, and re-files a squatted one under the derived id', async () => {
    const key = await m.restoreIdKey();
    const { derivedRestoreId } = await import('../restoreIds');
    const squatNew = await derivedRestoreId(key!, 'notebook', NB_SQUAT);

    const plan = await m.restoreBackupNotebooks(backupOf(), key);

    expect(plan.fileUnder.get(NB_NEW)).toBe(NB_NEW);
    expect(plan.fileUnder.get(NB_SQUAT)).toBe(squatNew);
    expect(plan.reIded.has(NB_SQUAT)).toBe(true);
    // Ours but in the trash: its notes restore unfiled.
    expect(plan.fileUnder.has(NB_TRASH)).toBe(false);
    expect(notebookPosts()).toEqual([NB_NEW, NB_SQUAT, squatNew, NB_TRASH]);
  });

  it('adopts a 409 that is ours by its row and our vault', async () => {
    held = new Set();
    rows[NB_TRASH] = { success: true, data: { id: NB_TRASH, user_id: ME, version: 5, deleted: false, content_nonce: 'n',
      encrypted_content: JSON.stringify({ title: 'Trashed', members: [] }), wrapped_content_key: 'ours', wrapped_content_key_nonce: 'n' } };

    const plan = await m.restoreBackupNotebooks(backupOf(), null);

    expect(plan.fileUnder.get(NB_TRASH)).toBe(NB_TRASH);
    expect(notebooksStore.notebookVersion(NB_TRASH)).toBe(5);
  });

  it('files nothing into a squatted notebook without a key to derive with', async () => {
    const plan = await m.restoreBackupNotebooks(backupOf(), null);
    expect(plan.fileUnder.has(NB_SQUAT)).toBe(false);
  });

  it('keeps an own notebook this client already opens, with no create', async () => {
    notebooksStore.loadFromSyncedItems([{ id: NB_NEW, item_type: 2, version: 3, deleted: false, content_nonce: 'n',
      encrypted_content: JSON.stringify({ title: 'New', members: [] }), wrapped_content_key: 'ours', wrapped_content_key_nonce: 'n' }]);

    const plan = await m.restoreBackupNotebooks(backupOf({ notebooks: [{ id: NB_NEW, name: 'New' }] }), null);

    expect(plan.fileUnder.get(NB_NEW)).toBe(NB_NEW);
    expect(notebookPosts()).toEqual([]);
  });
});

describe('the metadata and the notes, by the plan', () => {
  it("puts only planned notebooks in the metadata, under their planned ids, and asks the server's rows only for own ones", async () => {
    const key = await m.restoreIdKey();
    const plan = await m.restoreBackupNotebooks(backupOf(), key);

    await m.restoreBackupMetadata(backupOf(), plan);

    const ids = notebooksStore.notebooks().map(nb => nb.id).sort();
    expect(ids).toEqual([NB_NEW, plan.fileUnder.get(NB_SQUAT)!].sort());
    expect(ids).not.toContain(NB_SQUAT);
    expect(ids).not.toContain(NB_TRASH);
    // A re-filed notebook is new: it starts with no standing list, and nobody's rows are asked for it.
    const asked = calls.filter(c => c.url.endsWith('/shares')).map(c => c.url);
    expect(asked).toEqual([`/api/v1/items/${NB_NEW}/shares`]);
  });

  it('files each note under its planned notebook, and unfiles one whose notebook is not ours', async () => {
    const plan = { fileUnder: new Map([[NB_NEW, NB_NEW], [NB_SQUAT, 'derived-nb']]), reIded: new Set([NB_SQUAT]) };
    const planned = m.planBackup(backupOf(), plan);
    const byId = new Map(planned.notes.map(n => [n.id, n.notebookId]));
    expect(byId.get(N1)).toBe(NB_NEW);
    expect(byId.get(N2)).toBe('derived-nb');
    expect(byId.get(N3)).toBeNull();
    expect(planned.notebooks.map(nb => nb.id)).toEqual([NB_NEW, 'derived-nb']);
  });

  it('counts as unfiled only the notes this restore created that lost a notebook the file defines', () => {
    const plan = { fileUnder: new Map([[NB_NEW, NB_NEW]]), reIded: new Set<string>() };
    expect(m.unfiledCount(backupOf(), plan, new Set([N1, N2, N3]))).toBe(2);
    expect(m.unfiledCount(backupOf(), plan, new Set([N1, N3]))).toBe(1);
  });

  it("points reminders, pins and attachment refs at each note's final id, and drops a note's that wasn't restored", () => {
    const finalIds = new Map([[N1, 'n1-final']]);
    const b = m.remindersFor(backupOf({ attachments: [{ noteId: N1, filenames: null }, { noteId: N2, filenames: null }] }), finalIds);
    expect(b.reminders.map(r => r.itemId)).toEqual(['n1-final']);
    expect(b.attachments.map(a => a.noteId)).toEqual(['n1-final']);

    m.restoreBackupEditorModes(backupOf(), finalIds);
    expect(notebooksStore.editorModes()['n1-final']).toBe('markdown');
    expect(notebooksStore.editorModes()[N2]).toBeUndefined();
  });
});

describe('what the restored view says', () => {
  it('the real count, and a line each for notes not restored and notes restored outside their notebook, never the file count', () => {
    expect(m.restoreSummary({ restored: 2, failed: 1, unfiled: 1, notebooksAdded: 2, remindersRestored: 0 })).toEqual({
      summary: 'Restored 2 note(s), 2 notebook(s).',
      lines: ["1 note(s) couldn't be restored.", '1 note(s) were restored outside their notebook.'],
    });
    expect(m.restoreSummary({ restored: 3, failed: 0, unfiled: 0, notebooksAdded: 0, remindersRestored: 1 })).toEqual({
      summary: 'Restored 3 note(s), 1 reminder(s).',
      lines: [],
    });
  });
});

describe('a whole restore', () => {
  it("creates the notebooks' items before any note, and so restores the notes filed in them", async () => {
    const r = await m.runRestore(backupOf(), () => {});

    const firstNote = calls.findIndex(c => c.method === 'POST' && c.body?.item_type === 1);
    const lastNotebook = calls.map(c => c.method === 'POST' && c.body?.item_type === 2).lastIndexOf(true);
    expect(lastNotebook).toBeLessThan(firstNote);
    // N1 in its new notebook, N2 in the re-filed one, N3 unfiled (its notebook is in the trash).
    expect(notePosts().map(c => c.body.notebook_id ?? null)).toEqual([NB_NEW, expect.any(String), null]);
    expect(notePosts()[1].body.notebook_id).not.toBe(NB_SQUAT);
    expect(r!.summary).toBe('Restored 3 note(s), 2 notebook(s).');
    expect(r!.warnings).toContain('1 note(s) were restored outside their notebook.');
  });

  it('re-files a note whose own id another account holds, and still counts it restored', async () => {
    held = new Set([NB_SQUAT, N3]);
    const r = await m.runRestore(backupOf(), () => {});
    expect(r!.summary).toBe('Restored 3 note(s), 2 notebook(s).');
  });

  it("reports a note that couldn't be restored, and not as restored", async () => {
    const { derivedRestoreId } = await import('../restoreIds');
    held = new Set([NB_SQUAT, N3, await derivedRestoreId((await m.restoreIdKey())!, 'note', N3)]);
    const r = await m.runRestore(backupOf(), () => {});
    expect(r!.summary).toBe('Restored 2 note(s), 2 notebook(s).');
    expect(r!.warnings).toContain("1 note(s) couldn't be restored.");
  });

  it("keeps one write budget for the whole restore, the notes' and the reminders'", async () => {
    budgets.length = 0;
    await m.runRestore(backupOf(), () => {});
    expect(budgets).toHaveLength(1);
  });

  it('restores the same file again cleanly: every note already here, nothing made twice', async () => {
    await m.runRestore(backupOf(), () => {});
    const made = madeItems.size;
    const again = await m.runRestore(backupOf(), () => {});
    expect(again!.summary).toMatch(/^Restored 3 note\(s\)/);
    expect(again!.warnings.some(w => /couldn't be restored/.test(w))).toBe(false);
    expect(madeItems.size).toBe(made);
  });
});
