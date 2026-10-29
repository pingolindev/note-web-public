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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Rebuilding a notebook record no key here opens (lib/notebookRepair):
 * recreated on the person's behalf with all the same attributes, notes and
 * shares. The same rotation as any other, with the record's content given
 * instead of read: these pin what is written, to whom the new key goes, and
 * that nothing tries to open what cannot be opened.
 */

const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const unwrapContentKeyWithVault = vi.fn();
const decryptWithContentKey = vi.fn();
const encryptWithContentKey = vi.fn();
const wrapContentKeyForRecipient = vi.fn();
const allowSealToRecipient = vi.fn();
const signNoteShareWrap = vi.fn();
vi.mock('./crypto', () => ({
  unwrapContentKeyWithVault: (...a: unknown[]) => unwrapContentKeyWithVault(...a),
  decryptWithContentKey: (...a: unknown[]) => decryptWithContentKey(...a),
  generateContentKey: () => new Uint8Array(32).fill(2),
  encryptWithContentKey: (...a: unknown[]) => encryptWithContentKey(...a),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'new-wk', nonce: 'new-wn' }),
  wrapContentKeyForRecipient: (...a: unknown[]) => wrapContentKeyForRecipient(...a),
  allowSealToRecipient: (...a: unknown[]) => allowSealToRecipient(...a),
  ensureSigningKey: () => true,
  signNoteShareWrap: (...a: unknown[]) => signNoteShareWrap(...a),
  getSharingPublicKeyHex: () => 'my-pub',
}));
vi.mock('./attachmentUpload', () => ({ rekeyNoteAttachments: vi.fn(), listAttachmentsForRekey: vi.fn() }));
const retainContentKey = vi.fn();
vi.mock('./retainedKeys', () => ({ retain: (...a: unknown[]) => retainContentKey(...a) }));
vi.mock('../stores/notes', () => ({ notesStore: { notes: () => [], applyLocalPatch: vi.fn() } }));
const adoptRebuiltRecord = vi.fn();
/** The owner's own list of whom each notebook is shared with (its standing list). */
let standing: { email: string }[] = [];
vi.mock('../stores/notebooks', () => ({
  notebooksStore: {
    getNotebookShares: () => standing,
    notebookContentKey: () => null,
    membersOf: () => [],
    notebookWrap: () => null,
    notebookVersion: () => null,
    adoptRotatedNotebookKey: vi.fn(),
    adoptRebuiltRecord: (...a: unknown[]) => adoptRebuiltRecord(...a),
  },
}));
vi.mock('../stores/auth', () => ({ authStore: { user: () => ({ id: 'me' }) } }));

const { rebuildNotebookRecord, rescueNoteFromCopy } = await import('./shareUtils');
const { ASK_AGAIN_AFTER_MS } = await import('./askTwice');

const NB = 'nb-1';
const OWNER_ASKED = { attended: true };
const NOBODY_ASKED = { attended: false };
type Row = { id: string; recipient_email: string; permission: string; has_wrap?: boolean };

/** The server: the notebook's rows, each child note's rows, and who the directory knows. */
function serverWith(opts: {
  rows: Row[] | null;
  children?: Record<string, Row[] | null>;
  directory?: string[] | null;
  generation?: number;
}) {
  apiRequest.mockImplementation(async (url: string, o?: { method?: string; body?: any }) => {
    if (url === `/api/v1/items/${NB}` && !o?.method) {
      return { success: true, data: { encrypted_content: 'locked', content_nonce: 'n', content_key_generation: opts.generation ?? 5 } };
    }
    if (url === `/api/v1/items/${NB}/shares`) return opts.rows ? { success: true, data: opts.rows } : { success: false };
    const child = /^\/api\/v1\/items\/(.+)\/shares$/.exec(url)?.[1];
    if (child && opts.children && child in opts.children) {
      const rows = opts.children[child];
      return rows ? { success: true, data: rows } : { success: false };
    }
    if (url === '/api/v1/users/public-keys') {
      if (opts.directory === null) return { success: false };
      const known = opts.directory ?? (opts.rows ?? []).map(r => r.recipient_email);
      return { success: true, data: { users: (o!.body.emails as string[]).filter(e => known.includes(e)).map(e => ({
        email: e, user_id: `u-${e}`, sharing_public_key: `pk-${e}`, signing_public_key: `sk-${e}`,
      })) } };
    }
    if (url === `/api/v1/items/${NB}/rotate-shares`) return { success: true, data: { version: 9, content_key_generation: 6 } };
    return { success: false };
  });
}

const rotateBody = () => apiRequest.mock.calls.find(c => String(c[0]).endsWith('/rotate-shares'))?.[1].body;
/** The record written, as the rotation encrypted it. */
const written = () => JSON.parse(encryptWithContentKey.mock.calls[0][0]);

beforeEach(() => {
  vi.clearAllMocks();
  standing = [];
  encryptWithContentKey.mockImplementation((p: string) => ({ ciphertext: `ct(${p.length})`, nonce: 'cn' }));
  wrapContentKeyForRecipient.mockImplementation((_k: unknown, pub: string) => `sealed-for-${pub}`);
  allowSealToRecipient.mockReturnValue(true);
  signNoteShareWrap.mockReturnValue('sig');
});

describe('a notebook record rebuilt in place', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('is written new, under a new key, with nothing opened: there was nothing that could be', async () => {
    serverWith({ rows: [] });
    const r = await rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED);
    expect(r.rotated).toBe(true);
    expect(unwrapContentKeyWithVault).not.toHaveBeenCalled();
    expect(decryptWithContentKey).not.toHaveBeenCalled();
    expect(written()).toEqual({
      title: 'Family', body: '', note_type: 'text', color: null, is_pinned: false, is_archived: false,
      labels: [], sort_order: 0, members: [],
    });
    expect(rotateBody()).toMatchObject({
      encrypted_content: expect.stringMatching(/^ct\(/), wrapped_content_key: 'new-wk', wrapped_content_key_nonce: 'new-wn',
      expected_version: 7, remove_share_ids: [], update_shares: [],
    });
    // A notebook has no attachments: no old key is kept for any.
    expect(retainContentKey).not.toHaveBeenCalled();
    expect(adoptRebuiltRecord).toHaveBeenCalledWith(NB, {
      wrappedKey: 'new-wk', nonce: 'new-wn', version: 9, members: [], content: written(),
    });
  });

  it('its people are those on the owner\'s own list who hold its key now, each given the new one, signed under the next generation', async () => {
    standing = [{ email: 'ann@example.test' }, { email: 'BEN@example.test' }];
    serverWith({
      rows: [
        { id: 's-ann', recipient_email: 'ann@example.test', permission: 'contribute', has_wrap: true },
        { id: 's-ben', recipient_email: 'ben@example.test', permission: 'view' },
      ],
      children: { n1: [{ id: 'c1', recipient_email: 'ben@example.test', permission: 'edit' }], n2: [{ id: 'c2', recipient_email: 'ben@example.test', permission: 'edit' }] },
      generation: 5,
    });
    const r = await rebuildNotebookRecord(NB, 'Family', 7, ['n1', 'n2'], OWNER_ASKED);
    expect(r.rotated).toBe(true);
    expect(written().members).toEqual([
      { userId: 'u-ann@example.test', email: 'ann@example.test', sharingPublicKey: 'pk-ann@example.test', signingPublicKey: 'sk-ann@example.test', permission: 'contribute' },
      { userId: 'u-ben@example.test', email: 'ben@example.test', sharingPublicKey: 'pk-ben@example.test', signingPublicKey: 'sk-ben@example.test', permission: 'edit' },
    ]);
    expect(rotateBody().update_shares).toEqual([
      { share_id: 's-ann', wrapped_key: 'sealed-for-pk-ann@example.test', wrap_signature: 'sig' },
      { share_id: 's-ben', wrapped_key: 'sealed-for-pk-ben@example.test', wrap_signature: 'sig' },
    ]);
    // The generation the server goes to: its own, plus one.
    expect(signNoteShareWrap.mock.calls.length).toBe(2);
    expect(signNoteShareWrap.mock.calls.every(c => (c[0] as { contentKeyVersion: number }).contentKeyVersion === 6)).toBe(true);
  });

  it('never someone invited before they had an account (a row with no key), nor one the send gate refuses', async () => {
    standing = [{ email: 'ann@example.test' }, { email: 'zoe@example.test' }, { email: 'sam@example.test' }];
    serverWith({
      rows: [
        { id: 's-ann', recipient_email: 'ann@example.test', permission: 'view', has_wrap: true },
        { id: 's-zoe', recipient_email: 'zoe@example.test', permission: 'view', has_wrap: false },
        { id: 's-sam', recipient_email: 'sam@example.test', permission: 'view', has_wrap: true },
      ],
    });
    allowSealToRecipient.mockImplementation((userId: string) => userId !== 'u-sam@example.test');
    await rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED);
    expect(written().members.map((m: { email: string }) => m.email)).toEqual(['ann@example.test']);
    expect(rotateBody().update_shares.map((u: { share_id: string }) => u.share_id)).toEqual(['s-ann']);
    expect(wrapContentKeyForRecipient.mock.calls.map(c => c[1])).toEqual(['pk-ann@example.test']);
    // Nobody is taken off: those not given the key keep their rows.
    expect(rotateBody().remove_share_ids).toEqual([]);
  });

  it('a holder the owner\'s own list does not name is never written into it nor given the key: the server chose them', async () => {
    standing = [{ email: 'ann@example.test' }];
    serverWith({
      rows: [
        { id: 's-ann', recipient_email: 'ann@example.test', permission: 'view', has_wrap: true },
        { id: 's-mallory', recipient_email: 'mallory@evil.test', permission: 'view', has_wrap: true },
      ],
    });
    const r = await rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED);
    expect(r.rotated).toBe(true);
    expect(written().members.map((m: { email: string }) => m.email)).toEqual(['ann@example.test']);
    expect(rotateBody().update_shares.map((u: { share_id: string }) => u.share_id)).toEqual(['s-ann']);
    expect(wrapContentKeyForRecipient.mock.calls.map(c => c[1])).toEqual(['pk-ann@example.test']);
    // Left as it is: not removed, not given the key.
    expect(rotateBody().remove_share_ids).toEqual([]);
  });

  it('with the owner\'s own list unknown here, nobody is written in or given the key', async () => {
    standing = [];
    serverWith({ rows: [{ id: 's-ann', recipient_email: 'ann@example.test', permission: 'view', has_wrap: true }] });
    expect((await rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED)).rotated).toBe(true);
    expect(written().members).toEqual([]);
    expect(rotateBody().update_shares).toEqual([]);
  });

  /**
   * One note read that failed must not read as view and write every editor
   * into the record as a reader for good. It is asked again; still failing,
   * nothing is rebuilt now (the repair says it did not go through, and is
   * made again).
   */
  it('a note read that fails is asked again, and the right it then reads is written', async () => {
    standing = [{ email: 'ben@example.test' }];
    serverWith({
      rows: [{ id: 's-ben', recipient_email: 'ben@example.test', permission: 'view' }],
      children: { n1: [{ id: 'c1', recipient_email: 'ben@example.test', permission: 'edit' }], n2: [{ id: 'c2', recipient_email: 'ben@example.test', permission: 'edit' }] },
    });
    const answer = apiRequest.getMockImplementation()!;
    let failedOnce = false;
    apiRequest.mockImplementation(async (url: string, o?: unknown) => {
      if (url === '/api/v1/items/n2/shares' && !failedOnce) { failedOnce = true; return { success: false, error: 'Network error' }; }
      return answer(url, o);
    });
    vi.useFakeTimers();
    const p = rebuildNotebookRecord(NB, 'Family', 7, ['n1', 'n2'], OWNER_ASKED);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 2);
    expect((await p).rotated).toBe(true);
    expect(written().members[0].permission).toBe('edit');
  });

  it('one that fails even asked again: nothing is rebuilt, nothing written', async () => {
    standing = [{ email: 'ben@example.test' }];
    serverWith({
      rows: [{ id: 's-ben', recipient_email: 'ben@example.test', permission: 'view' }],
      children: { n1: [{ id: 'c1', recipient_email: 'ben@example.test', permission: 'edit' }], n2: null },
    });
    vi.useFakeTimers();
    const p = rebuildNotebookRecord(NB, 'Family', 7, ['n1', 'n2'], OWNER_ASKED);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 2);
    expect((await p).rotated).toBe(false);
    expect(rotateBody()).toBeUndefined();
    expect(encryptWithContentKey).not.toHaveBeenCalled();
  });

  it('edit only when every note row of theirs says edit', async () => {
    standing = [{ email: 'ben@example.test' }];
    serverWith({
      rows: [{ id: 's-ben', recipient_email: 'ben@example.test', permission: 'view' }],
      children: { n1: [{ id: 'c1', recipient_email: 'ben@example.test', permission: 'edit' }], n2: [{ id: 'c2', recipient_email: 'ben@example.test', permission: 'view' }] },
    });
    await rebuildNotebookRecord(NB, 'Family', 7, ['n1', 'n2'], OWNER_ASKED);
    expect(written().members[0].permission).toBe('view');
  });

  it('nothing is rebuilt when its rows, its record or the directory cannot be read', async () => {
    standing = [{ email: 'a@example.test' }];
    for (const opts of [{ rows: null }, { rows: [{ id: 's', recipient_email: 'a@example.test', permission: 'view' }], directory: null }]) {
      vi.clearAllMocks();
      serverWith(opts as Parameters<typeof serverWith>[0]);
      const r = await rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED);
      expect(r.rotated).toBe(false);
      expect(rotateBody()).toBeUndefined();
      expect(adoptRebuiltRecord).not.toHaveBeenCalled();
    }
    vi.clearAllMocks();
    serverWith({ rows: [] });
    apiRequest.mockImplementation(async (url: string) => url === `/api/v1/items/${NB}/shares` ? { success: true, data: [] } : { success: false });
    expect((await rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED)).rotated).toBe(false);
    expect(adoptRebuiltRecord).not.toHaveBeenCalled();
  });

  it('a rotation the server refuses (another device first) adopts nothing', async () => {
    serverWith({ rows: [] });
    const base = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, o?: unknown) =>
      String(url).endsWith('/rotate-shares') ? { success: false, status: 409 } : base(url, o));
    const r = await rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED);
    expect(r.rotated).toBe(false);
    expect(adoptRebuiltRecord).not.toHaveBeenCalled();
  });
});

describe('reads a rebuild cannot go without, and a rebuild nobody asked for', () => {
  const ROWS: Row[] = [
    { id: 's-ann', recipient_email: 'ann@example.test', permission: 'view', has_wrap: true },
    { id: 's-ben', recipient_email: 'ben@example.test', permission: 'view', has_wrap: true },
  ];
  /** The server as `serverWith` has it, but calls `from`..`to` (counted from 1) to `path` get no answer. */
  function failingCalls(path: string, from: number, to: number) {
    serverWith({ rows: ROWS });
    const base = apiRequest.getMockImplementation()!;
    let calls = 0;
    apiRequest.mockImplementation(async (url: string, o?: unknown) => {
      if (url === path) { calls++; if (calls >= from && calls <= to) return { success: false }; }
      return base(url, o);
    });
  }
  /** Run `work`, letting the moment before a second ask go by. */
  async function withTime<T>(work: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    const p = work();
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 3);
    return p;
  }
  afterEach(() => { vi.useRealTimers(); });

  it('nobody asked for it and others hold it: not rebuilt, nothing read or sent, and it says how many', async () => {
    serverWith({ rows: ROWS });
    const r = await rebuildNotebookRecord(NB, 'Family', 7, [], NOBODY_ASKED);
    expect(r).toMatchObject({ rotated: false, remainingCount: 2 });
    expect(rotateBody()).toBeUndefined();
    expect(apiRequest.mock.calls.some(c => c[0] === '/api/v1/users/public-keys')).toBe(false);
    // Stopped by the rebuild itself, before the key change reads anything.
    expect(apiRequest.mock.calls.some(c => c[0] === `/api/v1/items/${NB}` && !c[1]?.method)).toBe(false);
    expect(adoptRebuiltRecord).not.toHaveBeenCalled();
  });

  it('nobody asked for it and nobody else holds it: rebuilt, and nobody given a key', async () => {
    serverWith({ rows: [] });
    expect((await rebuildNotebookRecord(NB, 'Family', 7, [], NOBODY_ASKED)).rotated).toBe(true);
    expect(rotateBody().update_shares).toEqual([]);
  });

  it('the directory not read by the rotation itself (the rebuild read it first), even asked again: not sent', async () => {
    standing = ROWS.map(r => ({ email: r.recipient_email }));
    failingCalls('/api/v1/users/public-keys', 2, 3);
    const r = await withTime(() => rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED));
    expect(r.rotated).toBe(false);
    expect(r.reWrapFailures).toEqual(['ann@example.test', 'ben@example.test']);
    expect(rotateBody()).toBeUndefined();
    expect(adoptRebuiltRecord).not.toHaveBeenCalled();
  });

  it('who has the item not read by the rotation itself, even asked again: not sent', async () => {
    standing = ROWS.map(r => ({ email: r.recipient_email }));
    failingCalls(`/api/v1/items/${NB}/shares`, 2, 3);
    expect((await withTime(() => rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED))).rotated).toBe(false);
    expect(rotateBody()).toBeUndefined();
  });

  it('a read that gets no answer once is asked again, and then it goes', async () => {
    standing = ROWS.map(r => ({ email: r.recipient_email }));
    failingCalls('/api/v1/users/public-keys', 2, 2);
    const r = await withTime(() => rebuildNotebookRecord(NB, 'Family', 7, [], OWNER_ASKED));
    expect(r.rotated).toBe(true);
    expect(rotateBody().update_shares.map((u: { share_id: string }) => u.share_id)).toEqual(['s-ann', 's-ben']);
  });

});

describe('a note rescued from the copy this browser kept', () => {
  const NOTE = 'note-1';
  const copy = {
    id: NOTE, title: 'kept', body: 'the body', noteType: 'text', color: null, isPinned: false, isArchived: false,
    labels: ['x'], sortOrder: 2, editMode: 'rich', notebookId: 'nb-new', hasAttachments: false,
    version: 4, createdAt: '', updatedAt: '', deleted: false, extras: { from_android: 1 },
    wrappedContentKey: 'old-wk', wrappedContentKeyNonce: 'old-wn', contentKeyGeneration: 1,
  } as never;
  function noteServer(directory: boolean, holders: { id: string; recipient_email: string; permission: string; has_wrap?: boolean }[] = []) {
    apiRequest.mockImplementation(async (url: string, o?: { method?: string; body?: any }) => {
      if (url === `/api/v1/items/${NOTE}` && !o?.method) return { success: true, data: { encrypted_content: 'locked', content_nonce: 'n', content_key_generation: 3 } };
      if (url === `/api/v1/items/${NOTE}/shares`) return { success: true, data: holders };
      if (url === '/api/v1/users/public-keys') {
        return directory
          ? { success: true, data: { users: [{ email: 'ann@example.test', user_id: 'u-ann', sharing_public_key: 'pk-ann', signing_public_key: 'sk-ann' }] } }
          : { success: false };
      }
      if (url === `/api/v1/items/${NOTE}/rotate-shares`) return { success: true, data: { version: 5, content_key_generation: 4 } };
      return { success: false };
    });
  }

  it('is written as a save writes it, where its sharing has it, under a new key, at the copy\'s version, given to nobody', async () => {
    noteServer(true);
    const r = await rescueNoteFromCopy(copy, 'nb-old');
    expect(r.applied).toMatchObject({ version: 5, contentKeyGeneration: 4, wrappedForVault: { wrappedKey: 'new-wk', nonce: 'new-wn' } });
    // Nothing is opened: the old key opens with nothing here.
    expect(unwrapContentKeyWithVault).not.toHaveBeenCalled();
    expect(decryptWithContentKey).not.toHaveBeenCalled();
    expect(written()).toEqual({
      from_android: 1, title: 'kept', body: 'the body', note_type: 'text', color: null, is_pinned: false, is_archived: false,
      labels: ['x'], checklist_items: null, sort_order: 2, edit_mode: 'rich', notebook_id: 'nb-old', has_attachments: false,
    });
    expect(rotateBody()).toMatchObject({ expected_version: 4, remove_share_ids: [], update_shares: [] });
    expect(signNoteShareWrap).not.toHaveBeenCalled();
    // There is no old key to keep: it opens with nothing.
    expect(retainContentKey).not.toHaveBeenCalled();
  });

  it('someone else holds it: nothing is sent, nobody is looked up, and it says how many', async () => {
    noteServer(true, [{ id: 's-mallory', recipient_email: 'mallory@evil.test', permission: 'edit', has_wrap: true }]);
    const r = await rescueNoteFromCopy(copy, 'nb-old');
    expect(r).toMatchObject({ rotated: false, remainingCount: 1 });
    expect(rotateBody()).toBeUndefined();
    expect(apiRequest.mock.calls.some(c => c[0] === '/api/v1/users/public-keys')).toBe(false);
    expect(wrapContentKeyForRecipient).not.toHaveBeenCalled();
  });

  it('a row with no key (invited before they had an account) is nobody holding it', async () => {
    noteServer(true, [{ id: 's-zoe', recipient_email: 'zoe@example.test', permission: 'edit', has_wrap: false }]);
    expect((await rescueNoteFromCopy(copy, 'nb-old')).rotated).toBe(true);
    expect(rotateBody().update_shares).toEqual([]);
  });

  it('who has it not read, even asked again: not sent', async () => {
    noteServer(true);
    const base = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, o?: unknown) => url === `/api/v1/items/${NOTE}/shares` ? { success: false } : base(url, o));
    vi.useFakeTimers();
    const p = rescueNoteFromCopy(copy, 'nb-old');
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 2);
    const r = await p;
    vi.useRealTimers();
    expect(r.rotated).toBe(false);
    expect(rotateBody()).toBeUndefined();
  });
});
