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
 * The generation a NOTEBOOK share is signed under.
 *
 * A wrap is signed over the item's content-key generation, and the recipient
 * verifies it against the generation the server reports. The notes store
 * cannot supply it for a notebook: it holds `item_type === 1` rows
 * exclusively, so a lookup such as
 *
 *     notesStore.notes().find(n => n.id === noteId)?.contentKeyGeneration ?? 1
 *
 * never matches a notebook and would ALWAYS sign under generation 1. That is
 * right exactly once — while a notebook has never been rotated. Removing a
 * member rotates it, so every share of a notebook after any removal would be
 * signed under 1, verified against 2+, and dropped by the recipient as a
 * forged signature: they would get the notes and no notebook object, so
 * joining would grant nothing.
 *
 * These pin the rule: the generation comes from the server, and no answer
 * means no share.
 */

const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const wrapContentKeyForRecipient = vi.fn();
const allowSealToRecipient = vi.fn();
const ensureSigningKey = vi.fn();
const signNoteShareWrap = vi.fn();
vi.mock('./crypto', () => ({
  unwrapContentKeyWithVault: vi.fn(),
  decryptWithContentKey: vi.fn(),
  generateContentKey: vi.fn(),
  encryptWithContentKey: vi.fn(),
  wrapContentKeyWithVault: vi.fn(),
  wrapContentKeyForRecipient: (...a: unknown[]) => wrapContentKeyForRecipient(...a),
  allowSealToRecipient: (...a: unknown[]) => allowSealToRecipient(...a),
  ensureSigningKey: (...a: unknown[]) => ensureSigningKey(...a),
  signNoteShareWrap: (...a: unknown[]) => signNoteShareWrap(...a),
  getSharingPublicKeyHex: () => 'my-pub',
}));

vi.mock('./attachmentUpload', () => ({ rekeyNoteAttachments: vi.fn(), listAttachmentsForRekey: vi.fn(async () => []) }));
vi.mock('./retainedKeys', () => ({ retain: vi.fn() }));
vi.mock('../stores/notes', () => ({
  // Deliberately NON-EMPTY and deliberately without the notebook: a notes store
  // that happens to be empty would pass even with a notes-store lookup.
  notesStore: {
    notes: () => [{ id: 'some-note', contentKeyGeneration: 9 }],
    applyLocalPatch: vi.fn(),
  },
}));

const setNotebookMembers = vi.fn();
/** The notebook's content key as this browser holds it; null when it cannot open the notebook. */
const notebookContentKey = vi.fn((): Uint8Array | null => new Uint8Array(32).fill(7));
vi.mock('../stores/notebooks', () => ({
  notebooksStore: {
    notebookContentKey: () => notebookContentKey(),
    membersOf: () => [],
    setNotebookMembers: (...a: unknown[]) => setNotebookMembers(...a),
    notebookWrap: vi.fn(),
    notebookVersion: vi.fn(),
    adoptRotatedNotebookKey: vi.fn(),
  },
}));

vi.mock('../stores/auth', () => ({ authStore: { user: () => ({ id: 'me' }) } }));

const { shareNotebookWithRecipient, shareNotebookWithRecipientResult } = await import('./shareUtils');

const NB_ID = 'nb-1';
const recipient = {
  email: 'them@example.com',
  permission: 'view' as const,
  publicKey: 'their-pub',
  userId: 'them',
  signingPublicKey: 'their-sign',
};

/** GET the item → `generation`; everything else succeeds. */
function serverAt(generation: number | null) {
  apiRequest.mockImplementation(async (path: string) => {
    if (path === `/api/v1/items/${NB_ID}`) {
      return generation === null
        ? { success: false, error: 'nope' }
        : { success: true, data: { content_key_generation: generation } };
    }
    return { success: true, data: {} };
  });
}

const sharePosts = () =>
  apiRequest.mock.calls.filter(([p, o]) => p === `/api/v1/items/${NB_ID}/share` && o?.method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  notebookContentKey.mockReturnValue(new Uint8Array(32).fill(7));
  setNotebookMembers.mockResolvedValue(true);
  allowSealToRecipient.mockReturnValue(true);
  wrapContentKeyForRecipient.mockReturnValue('wrapped-for-them');
  ensureSigningKey.mockReturnValue(true);
  signNoteShareWrap.mockReturnValue('sig');
});

describe('a notebook share is signed under the notebook’s OWN generation', () => {
  it('signs under the server’s generation, not the notes-store fallback of 1', async () => {
    serverAt(3);
    const ok = await shareNotebookWithRecipient(NB_ID, recipient, 'contribute');
    expect(ok).toBe(true);
    expect(signNoteShareWrap).toHaveBeenCalledTimes(1);
    // The whole rule in one assertion.
    expect(signNoteShareWrap.mock.calls[0][0].contentKeyVersion).toBe(3);
  });

  it('still signs under 1 for a notebook that has never been rotated', async () => {
    serverAt(1);
    await shareNotebookWithRecipient(NB_ID, recipient, 'view');
    expect(signNoteShareWrap.mock.calls[0][0].contentKeyVersion).toBe(1);
  });

  it('treats a server with no generation column as generation 1', async () => {
    apiRequest.mockImplementation(async (path: string) =>
      path === `/api/v1/items/${NB_ID}` ? { success: true, data: {} } : { success: true, data: {} });
    await shareNotebookWithRecipient(NB_ID, recipient, 'view');
    expect(signNoteShareWrap.mock.calls[0][0].contentKeyVersion).toBe(1);
  });

  it('does NOT borrow a generation from some other item in the notes store', async () => {
    serverAt(4);
    await shareNotebookWithRecipient(NB_ID, recipient, 'contribute');
    expect(signNoteShareWrap.mock.calls[0][0].contentKeyVersion).not.toBe(9);
  });

  it('fails closed when the generation cannot be read: no share row is written', async () => {
    serverAt(null);
    const ok = await shareNotebookWithRecipient(NB_ID, recipient, 'contribute');
    expect(ok).toBe(false);
    // Signing under a guessed generation produces a wrap the recipient drops
    // while the owner sees a success — worse than not sharing.
    expect(sharePosts()).toHaveLength(0);
    expect(signNoteShareWrap).not.toHaveBeenCalled();
  });
});

/**
 * The Share panel needs to know WHY a notebook was not shared: a share that
 * was tried and did not happen stops it (the notes must not go out without
 * the invitation), and for which reason (a free account is shown the upgrade
 * prompt, not told to check its connection); a notebook that cannot be
 * shared as an object is shared note by note.
 *
 * And in which ORDER. The roster is what new notes are sealed from (the
 * owner's page when the standing list is empty, every member's phone).
 * Written first, a share that then failed would leave the person on it with
 * no invitation, and the next note anybody added would reach them, readable.
 * Roster last: every stop leaves fewer people receiving, never more.
 */
describe('why a notebook was not shared as an object', () => {
  const rosterWrites = () => setNotebookMembers.mock.calls.length;
  /** The share's steps in the order they ran. */
  function recording(over: { generation?: number | null; share?: { success: false; status?: number } } = {}) {
    const ran: string[] = [];
    apiRequest.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === `/api/v1/items/${NB_ID}`) {
        ran.push('generation');
        return over.generation === null
          ? { success: false, error: 'nope' }
          : { success: true, data: { content_key_generation: over.generation ?? 2 } };
      }
      if (path === `/api/v1/items/${NB_ID}/share` && opts?.method === 'POST') {
        ran.push('share');
        return over.share ?? { success: true, data: {} };
      }
      return { success: true, data: {} };
    });
    setNotebookMembers.mockImplementation(async () => { ran.push('roster'); return true; });
    return ran;
  }

  it('shared: the key is sealed to them, and THEN the roster names them', async () => {
    const ran = recording();
    expect(await shareNotebookWithRecipientResult(NB_ID, recipient, 'contribute')).toBe('shared');
    expect(ran).toEqual(['generation', 'share', 'roster']);
    expect(setNotebookMembers).toHaveBeenCalledWith(NB_ID, [{
      userId: 'them', email: 'them@example.com', sharingPublicKey: 'their-pub', signingPublicKey: 'their-sign', permission: 'contribute',
    }]);
  });

  it('an address with no account, or one that has published no key, has nobody to seal to: nothing is written', async () => {
    const ran = recording();
    for (const nobody of [{ ...recipient, userId: null }, { ...recipient, publicKey: null }, { ...recipient, userId: null, publicKey: null }]) {
      expect(await shareNotebookWithRecipientResult(NB_ID, nobody, 'view')).toBe('no-account');
    }
    expect(ran).toEqual([]);
  });

  it('a notebook this browser cannot open has no key to pass on: nothing is written', async () => {
    const ran = recording();
    notebookContentKey.mockReturnValue(null);
    expect(await shareNotebookWithRecipientResult(NB_ID, recipient, 'view')).toBe('cannot-open');
    expect(ran).toEqual([]);
  });

  describe('a share that did not happen leaves NOBODY on the roster', () => {
    it('failed: the generation could not be read', async () => {
      const ran = recording({ generation: null });
      expect(await shareNotebookWithRecipientResult(NB_ID, recipient, 'view')).toBe('failed');
      expect(ran).toEqual(['generation']);
    });

    it('failed: the share itself did not get through', async () => {
      const ran = recording({ share: { success: false, status: 503 } });
      expect(await shareNotebookWithRecipientResult(NB_ID, recipient, 'view')).toBe('failed');
      expect(ran).toEqual(['generation', 'share']);
      expect(rosterWrites()).toBe(0);
    });

    /** A free account's attempt: the share comes back 402. The roster is written
     * last, so nothing is left behind.
     */
    it('upgrade: sharing is a paid feature, and the server said so', async () => {
      const ran = recording({ share: { success: false, status: 402 } });
      expect(await shareNotebookWithRecipientResult(NB_ID, recipient, 'view')).toBe('upgrade');
      expect(ran).toEqual(['generation', 'share']);
      expect(rosterWrites()).toBe(0);
    });

    it('cannot-sign: this browser has nothing to sign the share with, so it is not sent', async () => {
      const ran = recording();
      ensureSigningKey.mockReturnValue(false);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await shareNotebookWithRecipientResult(NB_ID, recipient, 'view')).toBe('cannot-sign');
      expect(ran).toEqual(['generation']);
      expect(rosterWrites()).toBe(0);
      warn.mockRestore();
    });

    it('key-changed: their key is not the one pinned here, so nothing is sealed to it', async () => {
      const ran = recording();
      allowSealToRecipient.mockReturnValue(false);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await shareNotebookWithRecipientResult(NB_ID, recipient, 'view')).toBe('key-changed');
      expect(ran).toEqual(['generation']);
      expect(rosterWrites()).toBe(0);
      warn.mockRestore();
    });
  });

  /**
   * The one stop that leaves something behind: the invitation. It is in the
   * panel's list (which reads the notebook's own share rows), the owner is told
   * the share did not go through, and sharing again writes the roster.
   */
  it('failed: the roster could not be written, after the share was made', async () => {
    const ran = recording();
    setNotebookMembers.mockImplementation(async () => { ran.push('roster'); return false; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await shareNotebookWithRecipientResult(NB_ID, recipient, 'view')).toBe('failed');
    expect(ran).toEqual(['generation', 'share', 'roster']);
    warn.mockRestore();
  });

  it('the yes-or-no form is "shared" and nothing else', async () => {
    recording();
    expect(await shareNotebookWithRecipient(NB_ID, recipient, 'view')).toBe(true);
    expect(await shareNotebookWithRecipient(NB_ID, { ...recipient, userId: null }, 'view')).toBe(false);
    recording({ share: { success: false, status: 402 } });
    expect(await shareNotebookWithRecipient(NB_ID, recipient, 'view')).toBe(false);
  });
});
