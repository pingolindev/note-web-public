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
 * A restore never puts anyone back on a notebook's standing share list.
 *
 * WHY THESE EXIST
 *   Removing someone takes them off that list, so copying the backup's
 *   `notebookShares` into every notebook that has no list would bring back
 *   everyone removed after the file was made, and the next note in the
 *   notebook would be sealed to them. The list comes from the rows the server
 *   holds on the notebook NOW; the backup's recipients are never read.
 */

const apiRequest = vi.fn();
vi.mock('../apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

// Ciphertext IS the plaintext here, so a test can read what was written.
vi.mock('../crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'wrap-1', nonce: 'wrapn-1' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(7),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
}));

/** The notes in the account now; a test sets which notebook each is in. */
let notesNow: { id: string; notebookId: string | null; deleted?: boolean }[] = [];
vi.mock('../../stores/notes', () => ({ notesStore: { notes: () => notesNow } }));
vi.mock('../../stores/reminders', () => ({ remindersStore: { reminders: () => [] } }));

const NB = '11111111-1111-4111-8111-111111111111';
const NB2 = '33333333-3333-4333-8333-333333333333';
const C1 = '22222222-2222-4222-8222-222222222221';
const C2 = '22222222-2222-4222-8222-222222222222';
const X = 'removed-since@example.test';
const Y = 'current@example.test';

type Row = { id?: string; recipient_email: string; permission: string };
type Reply = { success: true; data: unknown } | { success: false; status: number; error?: string };
type Call = { url: string; method: string; body?: any };
const calls: Call[] = [];

/** Share rows the server holds now, by item id. A Reply is returned as is. */
let serverRows: Record<string, Row[] | Reply> = {};
/** Runs inside the server's answer for an item's rows, before it returns. */
let duringRead: Record<string, () => void> = {};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  calls.length = 0;
  serverRows = {};
  duringRead = {};
  notesNow = [];
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
    const c = { url, method: opts?.method ?? 'GET', body: opts?.body };
    calls.push(c);
    const shares = /^\/api\/v1\/items\/([^/]+)\/shares$/.exec(url);
    if (shares && c.method === 'GET') {
      duringRead[shares[1]]?.();
      const rows = serverRows[shares[1]] ?? [];
      return Array.isArray(rows) ? { success: true, data: rows } : rows;
    }
    // The metadata row: created on the first write, updated after.
    if (c.method === 'POST' && url === '/api/v1/items') return { success: true, data: { id: 'meta-1', version: 1 } };
    if (c.method === 'PUT') return { success: true, data: { version: 2 } };
    return { success: false, status: 404 };
  });
});

/** Every notebook the backup names is this account's own (the notebook plan, not what these test). */
const ownPlan = (b: NoteBackup) => ({
  fileUnder: new Map((b.notebooks ?? []).map(nb => [nb.id, nb.id] as [string, string])),
  reIded: new Set<string>(),
});

async function load() {
  const m = await import('./restoreBackup');
  const restoreBackupMetadata = (b: NoteBackup) => m.restoreBackupMetadata(b, ownPlan(b));
  const { notebooksStore } = await import('../../stores/notebooks');
  // A session that has pulled (with no saved base, nothing is written before
  // the first pull).
  notebooksStore.markPulled();
  return { restoreBackupMetadata, notebooksStore };
}

function backupOf(overrides: Partial<NoteBackup> = {}): NoteBackup {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    client: 'web',
    generatedAt: '2026-08-12T00:00:00.000Z',
    isComplete: true,
    counts: { notes: 0, notebooks: 1, reminders: 0, notesWithAttachments: 0 },
    notebooks: [{ id: NB, name: 'Family' }],
    labelColors: {},
    editorModes: {},
    // What the file says: X was a member when it was made, with edit.
    notebookShares: { [NB]: [{ email: X, permission: 'edit' }] },
    notes: [],
    reminders: [],
    attachments: [],
    ...overrides,
  };
}

const shareReads = (id: string) => calls.filter(c => c.method === 'GET' && c.url === `/api/v1/items/${id}/shares`);
/** The metadata blob as last written (the store's writes are chained, so wait for them). */
async function lastBlob() {
  await vi.waitFor(() => expect(calls.some(c => c.method === 'POST' || c.method === 'PUT')).toBe(true));
  const writes = calls.filter(c => (c.method === 'POST' && c.url === '/api/v1/items') || c.method === 'PUT');
  return JSON.parse(writes[writes.length - 1].body.encrypted_content);
}
const fresh = (email: string, permission: 'edit' | 'view') =>
  ({ email, permission, publicKey: null, userId: null, signingPublicKey: null });

describe('a restore and the standing share lists', () => {
  it('does not put back someone removed after the backup was made', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    serverRows[NB] = []; // X was removed: the server holds no row for them

    const summary = await restoreBackupMetadata(backupOf());

    expect(notebooksStore.getNotebookShares(NB)).toEqual([]);
    expect(NB in notebooksStore.notebookShares()).toBe(false);
    expect(summary.sharesAdded).toBe(0);
    expect(JSON.stringify(await lastBlob())).not.toContain(X);
  });

  it("lists the server's current people, never the file's", async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    notesNow = [{ id: C1, notebookId: NB }];
    serverRows[NB] = [{ recipient_email: Y, permission: 'view' }];
    serverRows[C1] = [{ recipient_email: Y, permission: 'edit' }];

    const summary = await restoreBackupMetadata(backupOf());

    // Y edits notes: the object says view (its collection right), the note edit.
    expect(notebooksStore.getNotebookShares(NB)).toEqual([fresh(Y, 'edit')]);
    expect(summary.sharesAdded).toBe(1);
    await vi.waitFor(async () => expect((await lastBlob()).notebookShares).toEqual({ [NB]: [fresh(Y, 'edit')] }));
  });

  it("never takes the permission from the file: a demotion since stands", async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    notesNow = [{ id: C1, notebookId: NB }];
    serverRows[NB] = [{ recipient_email: Y, permission: 'view' }];
    serverRows[C1] = [{ recipient_email: Y, permission: 'view' }];

    await restoreBackupMetadata(backupOf({ notebookShares: { [NB]: [{ email: Y, permission: 'edit' }] } }));

    expect(notebooksStore.getNotebookShares(NB)).toEqual([fresh(Y, 'view')]);
  });

  it('gives a contributor edit, without reading the notes', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    notesNow = [{ id: C1, notebookId: NB }];
    serverRows[NB] = [{ recipient_email: Y, permission: 'contribute' }];

    await restoreBackupMetadata(backupOf());

    expect(notebooksStore.getNotebookShares(NB)).toEqual([fresh(Y, 'edit')]);
    expect(shareReads(C1)).toHaveLength(0);
  });

  it('gives view when any of the notes says view', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    notesNow = [{ id: C1, notebookId: NB }, { id: C2, notebookId: NB }];
    serverRows[NB] = [{ recipient_email: Y, permission: 'view' }];
    serverRows[C1] = [{ recipient_email: Y, permission: 'edit' }];
    serverRows[C2] = [{ recipient_email: Y, permission: 'view' }];

    await restoreBackupMetadata(backupOf());

    expect(notebooksStore.getNotebookShares(NB)).toEqual([fresh(Y, 'view')]);
  });

  it('gives view when no note in the notebook says anything', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    // A note elsewhere, and a deleted one here, say edit; neither counts.
    notesNow = [{ id: C1, notebookId: NB2 }, { id: C2, notebookId: NB, deleted: true }];
    serverRows[NB] = [{ recipient_email: Y, permission: 'view' }];
    serverRows[C1] = [{ recipient_email: Y, permission: 'edit' }];
    serverRows[C2] = [{ recipient_email: Y, permission: 'edit' }];

    await restoreBackupMetadata(backupOf());

    expect(notebooksStore.getNotebookShares(NB)).toEqual([fresh(Y, 'view')]);
    expect(shareReads(C1)).toHaveLength(0);
    expect(shareReads(C2)).toHaveLength(0);
  });

  /**
   * One note read that failed must not set every editor down as a reader,
   * for good (a list, once set, is never touched again). It is asked again;
   * still failing, no list is made, as when the notebook's own rows cannot be
   * read.
   */
  it("makes no list when a note's rows could not be read, even asked again", async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    notesNow = [{ id: C1, notebookId: NB }, { id: C2, notebookId: NB }];
    serverRows[NB] = [{ recipient_email: Y, permission: 'view' }];
    serverRows[C1] = [{ recipient_email: Y, permission: 'edit' }];
    serverRows[C2] = { success: false, status: 503 };

    await restoreBackupMetadata(backupOf());

    expect(notebooksStore.getNotebookShares(NB)).toEqual([]);
    expect(shareReads(C2)).toHaveLength(2);
  });

  it("never adds someone who has rows only on the notebook's notes", async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    notesNow = [{ id: C1, notebookId: NB }];
    const W = 'one-note-only@example.test';
    serverRows[NB] = [{ recipient_email: Y, permission: 'view' }];
    serverRows[C1] = [{ recipient_email: Y, permission: 'edit' }, { recipient_email: W, permission: 'edit' }];

    await restoreBackupMetadata(backupOf());

    expect(notebooksStore.getNotebookShares(NB)).toEqual([fresh(Y, 'edit')]);
  });

  it('keeps one entry per address, with the fewer rights', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    serverRows[NB] = [
      { recipient_email: 'Current@Example.test', permission: 'contribute' },
      { recipient_email: Y, permission: 'view' },
    ];

    await restoreBackupMetadata(backupOf());

    expect(notebooksStore.getNotebookShares(NB)).toEqual([fresh('Current@Example.test', 'view')]);
  });

  it('sets no list when the read fails or is not a list', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    serverRows[NB] = { success: false, status: 500, error: 'Failed to list shares' };
    serverRows[NB2] = { success: true, data: { recipient_email: X, permission: 'edit' } };

    const summary = await restoreBackupMetadata(backupOf({
      notebooks: [{ id: NB, name: 'Family' }, { id: NB2, name: 'Work' }],
      notebookShares: { [NB]: [{ email: X, permission: 'edit' }], [NB2]: [{ email: X, permission: 'edit' }] },
    }));

    expect(notebooksStore.notebookShares()).toEqual({});
    expect(summary.sharesAdded).toBe(0);
  });

  it('leaves an existing list exactly as it is, and does not ask about it', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    const cached = { email: 'kept@example.test', permission: 'view' as const, publicKey: 'aa'.repeat(32), userId: 'kept-id', signingPublicKey: 'bb'.repeat(32) };
    notebooksStore.addNotebookShare(NB, cached);
    const before = JSON.stringify(notebooksStore.getNotebookShares(NB));
    serverRows[NB] = [{ recipient_email: Y, permission: 'contribute' }];

    await restoreBackupMetadata(backupOf());

    expect(JSON.stringify(notebooksStore.getNotebookShares(NB))).toBe(before);
    expect(shareReads(NB)).toHaveLength(0);
  });

  it('asks only about the notebooks the backup names, each once', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    const LOCAL = '44444444-4444-4444-8444-444444444444';
    notebooksStore.restoreFromBackup({ notebooks: [{ id: LOCAL, name: 'Mine, not in the file' }] });
    serverRows[NB] = [{ recipient_email: Y, permission: 'contribute' }];
    serverRows[NB2] = [{ recipient_email: Y, permission: 'contribute' }];

    const summary = await restoreBackupMetadata(backupOf({
      notebooks: [{ id: NB, name: 'Family' }, { id: NB2, name: 'Work' }, { id: NB, name: 'Family' }],
      notebookShares: {},
    }));

    expect(shareReads(NB)).toHaveLength(1);
    expect(shareReads(NB2)).toHaveLength(1);
    expect(shareReads(LOCAL)).toHaveLength(0);
    expect(summary.sharesAdded).toBe(2);
  });

  it('never asks about an id from the file that is not a UUID', async () => {
    const { restoreBackupMetadata } = await load();

    await restoreBackupMetadata(backupOf({ notebooks: [{ id: '../../users/me', name: 'Odd' }], notebookShares: {} }));

    expect(calls.filter(c => c.url.endsWith('/shares'))).toEqual([]);
  });

  it('keeps a list made while the rows were being read', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    const madeMeanwhile = { email: 'invited-now@example.test', permission: 'edit' as const, publicKey: 'cc'.repeat(32), userId: 'n-id', signingPublicKey: null };
    serverRows[NB] = [{ recipient_email: Y, permission: 'contribute' }];
    duringRead[NB] = () => notebooksStore.addNotebookShare(NB, madeMeanwhile);

    const summary = await restoreBackupMetadata(backupOf());

    expect(notebooksStore.getNotebookShares(NB)).toEqual([madeMeanwhile]);
    expect(summary.sharesAdded).toBe(0);
  });

  it('sets nothing when the account changed while the rows were being read', async () => {
    const { restoreBackupMetadata, notebooksStore } = await load();
    const { setTabAccount } = await import('../account');
    serverRows[NB] = [{ recipient_email: Y, permission: 'contribute' }];
    duringRead[NB] = () => setTabAccount('0e0e0e0e-0000-4000-8000-00000000000b');

    const summary = await restoreBackupMetadata(backupOf());

    expect(summary.sharesAdded).toBe(0);
    expect(notebooksStore.getNotebookShares(NB)).toEqual([]);
  });
});
