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

/**
 * A restore's note is "already here" only when the server's row is this
 * account's own live note, and a note whose id another account holds is filed
 * under the id derived for it.
 *
 * WHY THESE EXIST
 *   Counting every 409 as "already here" fails against a server that answers
 *   every taken id with 409, another account's included: a squatted id would
 *   silently drop the user's note from the restore, and the page would say it
 *   was restored.
 */

const ME = '0e0e0e0e-0000-4000-8000-00000000000e';
const OTHER = '0e0e0e0e-0000-4000-8000-00000000000f';

const apiRequest = vi.fn();
vi.mock('../apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
const sealedTo: string[] = [];
vi.mock('../crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  encryptWithContentKey: (plaintext: string, _key: Uint8Array, itemId: string) => {
    sealedTo.push(itemId);
    return { ciphertext: plaintext, nonce: 'n' };
  },
}));
vi.mock('../../stores/notes', () => ({ notesStore: { sync: async () => {} } }));
vi.mock('../account', async (orig) => {
  const real = await orig<typeof import('../account')>();
  return { ...real, getTabAccount: () => ME };
});

const { ingestProgress } = await import('./pipeline');
const { derivedRestoreId, restoreIdKeyFrom } = await import('../restoreIds');
type ImportedNote = import('./types').ImportedNote;
type ImportState = import('./types').ImportState;

const ID = '11111111-1111-4111-8111-111111111111';
const note = (over: Partial<ImportedNote> = {}): ImportedNote => ({
  title: 't', body: 'b', noteType: 'text', checklistItems: null, labels: [], color: null,
  isPinned: false, isArchived: false, createdAt: null, updatedAt: null, id: ID, ...over,
} as ImportedNote);

async function* one(n: ImportedNote) {
  yield { kind: 'note' as const, note: n };
  yield { kind: 'done' as const, total: 1 };
}

let key: CryptoKey;
let derived: string;
const posts = () => apiRequest.mock.calls.filter(c => c[1]?.method === 'POST').map(c => c[1].body.id as string);

/** The server: `creates` answers each POST by id; `rows` answers the GET of an id. */
function server(creates: Record<string, unknown>, rows: Record<string, unknown> = {}) {
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string; body?: { id: string } }) => {
    if (opts?.method === 'POST') return creates[opts.body!.id] ?? { success: true, data: { id: opts.body!.id } };
    const m = /^\/api\/v1\/items\/(.+)$/.exec(url);
    if (m) return rows[m[1]] ?? { success: false, status: 404 };
    return { success: false, status: 404 };
  });
}
const conflict = { success: false, status: 409, error: 'An item with this id already exists' };
const notOwned = { success: false, status: 403, error: 'You do not have write access to this item', error_code: 'item_not_owned' };
const row = (userId: string, deleted = false) => ({ success: true, data: { id: ID, user_id: userId, deleted } });

async function restoreOne(n: ImportedNote, withKey = true) {
  let done: Extract<ImportState, { kind: 'complete' }> | null = null;
  await ingestProgress(one(n), s => { if (s.kind === 'complete') done = s; }, { reIdKey: withKey ? key : null });
  return done! as Extract<ImportState, { kind: 'complete' }>;
}

beforeEach(async () => {
  vi.clearAllMocks();
  sealedTo.length = 0;
  key = await restoreIdKeyFrom(new Uint8Array(32).fill(1));
  derived = await derivedRestoreId(key, 'note', ID);
});

describe("a restore's note, already here", () => {
  it('is present when the 409 is for our own live note', async () => {
    server({ [ID]: conflict }, { [ID]: row(ME) });
    const r = await restoreOne(note());
    expect([r.count, r.present, r.failed]).toEqual([0, 1, 0]);
    expect(r.finalIds!.get(ID)).toBe(ID);
    expect(posts()).toEqual([ID]);
  });

  it('is not restored when the 409 is for our own note in the trash', async () => {
    server({ [ID]: conflict }, { [ID]: row(ME, true) });
    const r = await restoreOne(note());
    expect([r.count, r.present, r.failed]).toEqual([0, 0, 1]);
    expect(posts()).toEqual([ID]);
  });

  it('is not restored when the row could not be read', async () => {
    server({ [ID]: conflict }, { [ID]: { success: false, status: 503 } });
    expect((await restoreOne(note())).failed).toBe(1);
  });

  it('goes by the same rule when the server said so only in words', async () => {
    server({ [ID]: { success: false, error: 'An item with this id already exists' } }, { [ID]: row(ME) });
    expect((await restoreOne(note())).present).toBe(1);
  });
});

describe("a restore's note whose id another account holds", () => {
  it('is filed under the derived id on 403 item_not_owned, and sealed to that id', async () => {
    server({ [ID]: notOwned });
    const r = await restoreOne(note());
    expect([r.count, r.present, r.failed]).toEqual([1, 0, 0]);
    expect(posts()).toEqual([ID, derived]);
    expect(sealedTo).toEqual([ID, derived]);
    expect(r.finalIds!.get(ID)).toBe(derived);
    expect([...r.createdIds!]).toEqual([ID]);
  });

  it("is filed under the derived id on an old server's 409 whose row is another's, or not ours to read", async () => {
    server({ [ID]: conflict }, { [ID]: row(OTHER) });
    expect((await restoreOne(note())).finalIds!.get(ID)).toBe(derived);

    vi.clearAllMocks();
    server({ [ID]: conflict }, {});
    expect((await restoreOne(note())).finalIds!.get(ID)).toBe(derived);
  });

  it('is present under the derived id on a second restore', async () => {
    server({ [ID]: notOwned, [derived]: conflict }, { [derived]: { success: true, data: { id: derived, user_id: ME, deleted: false } } });
    const r = await restoreOne(note());
    expect([r.count, r.present, r.failed]).toEqual([0, 1, 0]);
    expect(r.finalIds!.get(ID)).toBe(derived);
  });

  it("is not restored when the derived id's 409 is another's row too", async () => {
    server({ [ID]: notOwned, [derived]: conflict }, { [derived]: { success: true, data: { id: derived, user_id: OTHER, deleted: false } } });
    const r = await restoreOne(note());
    expect([r.count, r.present, r.failed]).toEqual([0, 0, 1]);
    expect(posts()).toEqual([ID, derived]);
  });

  it('is not restored when the derived id is taken too, and not tried again', async () => {
    server({ [ID]: notOwned, [derived]: notOwned });
    const r = await restoreOne(note());
    expect(r.failed).toBe(1);
    expect(posts()).toEqual([ID, derived]);
  });

  it('is not restored without a key to derive with', async () => {
    server({ [ID]: notOwned });
    const r = await restoreOne(note(), false);
    expect(r.failed).toBe(1);
    expect(posts()).toEqual([ID]);
  });
});

describe('a 403 that is not about the id', () => {
  it('(a notebook we may not file into) is not restored, and nothing is re-filed', async () => {
    server({ [ID]: { success: false, status: 403, error: 'You do not have permission to add notes to that notebook' } });
    const r = await restoreOne(note({ notebookId: '22222222-2222-4222-8222-222222222222' }));
    expect(r.failed).toBe(1);
    expect(posts()).toEqual([ID]);
  });
});

describe('a foreign import (no id of its own)', () => {
  it('counts a failed create as a failure, and never asks whose the id is', async () => {
    server({});
    apiRequest.mockImplementation(async () => conflict);
    const r = await restoreOne(note({ id: undefined }));
    expect(r.failed).toBe(1);
    expect(apiRequest.mock.calls.filter(c => c[1]?.method !== 'POST')).toEqual([]);
  });
});
