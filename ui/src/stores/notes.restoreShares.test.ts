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
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, type NoteBackup } from '../lib/backupFormat';

const { ME } = vi.hoisted(() => ({ ME: '0e0e0e0e-0000-4000-8000-00000000000e' }));

/**
 * After a restore, a new note in a notebook reaches the people the server
 * lists on it now, and nobody removed since the backup was made.
 *
 * The real notebooks and notes stores, end to end: the restore fills the
 * standing list, and the new note's fan-out reads it. A list taken from the
 * file would seal the note below to the removed person.
 */

const apiRequest = vi.fn();
vi.mock('../lib/apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
vi.mock('../lib/crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(1),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  unwrapContentKeyWithVault: () => new Uint8Array(32).fill(1),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptWithContentKey: (d: { ciphertext: string }) => d.ciphertext,
  encryptNote: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
  decryptNote: (d: { ciphertext: string }) => d.ciphertext,
  getPinnedUserKeys: () => null,
}));
vi.mock('../lib/previousIdentities', () => ({ ensurePreviousIdentities: async () => 0 }));

const shareNoteWithRecipientResult = vi.fn();
vi.mock('../lib/shareUtils', () => ({
  shareNoteWithRecipientResult: (...a: unknown[]) => shareNoteWithRecipientResult(...a),
  unshareNoteWithRecipient: vi.fn(async () => true),
  rotateContentKey: vi.fn(async () => ({ rotated: true })),
}));

const lookupDirectoryKeys = vi.fn();
vi.mock('../lib/recipientKeys', async () => {
  const real = await vi.importActual<typeof import('../lib/recipientKeys')>('../lib/recipientKeys');
  return { ...real, lookupDirectoryKeys: (...a: unknown[]) => lookupDirectoryKeys(...a) };
});
vi.mock('./sharesInbox', () => ({
  sharesInboxStore: {
    getByItemId: () => undefined,
    load: async () => true,
    sharedNotebooks: () => [],
    applyLocalEdit: () => {},
  },
}));
vi.mock('./auth', () => ({
  authStore: { user: () => ({ id: ME, email: 'me@example.test' }) },
  getCachedOwner: () => ME,
}));
vi.mock('./reminders', () => ({ remindersStore: { reminders: () => [] } }));
vi.mock('../lib/noteDb', () => ({
  loadNotes: async () => [],
  loadCursor: async () => null,
  loadCursorId: async () => null,
  putNote: vi.fn(async () => {}),
  putNotes: vi.fn(async () => {}),
  removeNote: vi.fn(async () => {}),
  queuePending: vi.fn(async () => {}),
  removePending: vi.fn(async () => {}),
  listPending: async () => [],
  getPending: async () => null,
  saveCursor: async () => {},
  saveCursorId: async () => {},
}));

const NB = '11111111-1111-4111-8111-111111111111';
const X = 'removed-since@example.test';
const Y = 'current@example.test';

/** The rows the server holds on the notebook object now. */
let notebookRows: { recipient_email: string; permission: string }[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  notebookRows = [];
  shareNoteWithRecipientResult.mockResolvedValue({ ok: true });
  lookupDirectoryKeys.mockImplementation(async (emails: string[]) => new Map(emails.map(e =>
    [e.toLowerCase(), { userId: `${e}-id`, sharingPub: '55'.repeat(32), signingPub: '66'.repeat(32) }])));
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: { id?: string; item_type?: number } }) => {
    if (url === `/api/v1/items/${NB}/shares`) return { success: true, data: notebookRows };
    if (url === '/api/v1/items' && opts?.method === 'POST') {
      return { success: true, data: { id: opts.body?.id ?? 'meta-1', version: 1, created_at: 't', updated_at: 't' } };
    }
    if (opts?.method === 'PUT') return { success: true, data: { version: 2 } };
    return { success: false, status: 404 };
  });
});

function backup(): NoteBackup {
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
    // X was a member when the file was made.
    notebookShares: { [NB]: [{ email: X, permission: 'edit' }] },
    notes: [],
    reminders: [],
    attachments: [],
  };
}

/** The restore with every backup notebook filed as this account's own (filing is not what these test). */
async function restoreAsOwn() {
  const m = await import('../lib/importers/restoreBackup');
  return (b: NoteBackup) => m.restoreBackupMetadata(b, {
    fileUnder: new Map(b.notebooks.map(nb => [nb.id, nb.id] as [string, string])),
    reIded: new Set<string>(),
  });
}

const sealedTo = () => shareNoteWithRecipientResult.mock.calls.map(c => (c[2] as { email: string }).email);

describe('a new note in a restored notebook', () => {
  it('is not sealed to someone removed after the backup was made', async () => {
    const restoreBackupMetadata = await restoreAsOwn();
    const { notesStore } = await import('./notes');
    notebookRows = []; // X was removed: no row on the notebook now

    await restoreBackupMetadata(backup());
    await notesStore.createNote({ title: 'Plans', notebookId: NB });

    expect(sealedTo()).not.toContain(X);
    expect(sealedTo()).toEqual([]);
  });

  it("is sealed to the people the server lists on the notebook now", async () => {
    const restoreBackupMetadata = await restoreAsOwn();
    const { notesStore } = await import('./notes');
    notebookRows = [{ recipient_email: Y, permission: 'contribute' }];

    await restoreBackupMetadata(backup());
    await notesStore.createNote({ title: 'Plans', notebookId: NB });

    expect(sealedTo()).toEqual([Y]);
    expect((shareNoteWithRecipientResult.mock.calls[0][2] as { permission: string }).permission).toBe('edit');
  });
});
