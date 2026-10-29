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

const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const membersOf = vi.fn();
const setNotebookMembers = vi.fn();
vi.mock('../stores/notebooks', () => ({
  notebooksStore: {
    membersOf: (...a: unknown[]) => membersOf(...a),
    setNotebookMembers: (...a: unknown[]) => setNotebookMembers(...a),
  },
}));

const rotateNotebookContentKey = vi.fn();
vi.mock('./shareUtils', () => ({
  rotateNotebookContentKey: (...a: unknown[]) => rotateNotebookContentKey(...a),
}));

const { revokeNotebookAccess, revokeNotebookObjectShare, rosterWithout, userIdFor } =
  await import('./notebookRemoval');

const NB = 'nb-1';
const MALLORY = {
  userId: 'u-mallory', email: 'Mallory@Example.com', sharingPublicKey: 'pk',
  signingPublicKey: null, permission: 'view' as const,
};
const ALICE = {
  userId: 'u-alice', email: 'alice@example.com', sharingPublicKey: 'pk2',
  signingPublicKey: null, permission: 'edit' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  membersOf.mockReturnValue([MALLORY, ALICE]);
  setNotebookMembers.mockResolvedValue(true);
  rotateNotebookContentKey.mockResolvedValue({
    rotated: true, remainingCount: 1, reWrapFailures: [], revokedShareLink: false,
  });
});

describe('the roster after a removal', () => {
  /**
   * The roster is what every member reads to seal a NEW note to everyone in
   * the notebook. Leave someone in it and the other members' clients keep
   * sealing future notes to the person who was just removed.
   */
  it('drops the removed member', () => {
    expect(rosterWithout([MALLORY, ALICE], 'mallory@example.com')).toEqual([ALICE]);
  });

  it('matches regardless of case, since share rows carry whatever was typed', () => {
    expect(rosterWithout([MALLORY], 'MALLORY@EXAMPLE.COM')).toEqual([]);
  });

  /** Null means "nothing to write" — not "the roster is now empty". */
  it('reports no change when they were never in it', () => {
    expect(rosterWithout([ALICE], 'nobody@example.com')).toBeNull();
  });

  it('finds the removed member user id for the re-key job', () => {
    expect(userIdFor([MALLORY, ALICE], 'mallory@example.com')).toBe('u-mallory');
    expect(userIdFor([ALICE], 'mallory@example.com')).toBeNull();
  });
});

describe('revoking the notebook object', () => {
  const twoShares = async (url: string) => {
    if (url === `/api/v1/items/${NB}/shares`) {
      return { success: true, data: [
        { id: 's1', recipient_email: 'mallory@example.com', permission: 'view' },
        { id: 's2', recipient_email: 'alice@example.com', permission: 'view' },
      ] };
    }
    return { success: true };
  };

  /**
   * Revoke and re-key in ONE rotate-shares transaction, so there is no window
   * where the share is gone but the content is still readable with the key the
   * removed member holds — or the reverse.
   */
  it('rotates the notebook key, cutting off exactly their share', async () => {
    apiRequest.mockImplementation(twoShares);

    expect(await revokeNotebookObjectShare(NB, 'mallory@example.com'))
      .toEqual({ revoked: true, rotated: true });
    expect(rotateNotebookContentKey).toHaveBeenCalledWith(NB, ['s1'], 'notebook_removal');
    // The atomic path deletes the row; no separate DELETE.
    expect(apiRequest).not.toHaveBeenCalledWith('/api/v1/shares/s1?reason=notebook_removal', { method: 'DELETE' });
  });

  /**
   * Revocation is the part that stops access — one atomic server call. It must
   * never become conditional on the slower, more fragile re-keying working: a
   * notebook that is revoked but not re-keyed is a far better outcome than one
   * that is neither.
   */
  it('still revokes by plain delete when the rotation does not land', async () => {
    apiRequest.mockImplementation(twoShares);
    rotateNotebookContentKey.mockResolvedValue({
      rotated: false, remainingCount: 0, reWrapFailures: [], revokedShareLink: false,
    });

    expect(await revokeNotebookObjectShare(NB, 'mallory@example.com'))
      .toEqual({ revoked: true, rotated: false });
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/shares/s1?reason=notebook_removal', { method: 'DELETE' });
    expect(apiRequest).not.toHaveBeenCalledWith('/api/v1/shares/s2?reason=notebook_removal', { method: 'DELETE' });
  });

  it('still revokes when the rotation throws', async () => {
    apiRequest.mockImplementation(twoShares);
    rotateNotebookContentKey.mockRejectedValue(new Error('offline'));

    expect(await revokeNotebookObjectShare(NB, 'mallory@example.com'))
      .toEqual({ revoked: true, rotated: false });
    expect(apiRequest).toHaveBeenCalledWith('/api/v1/shares/s1?reason=notebook_removal', { method: 'DELETE' });
  });

  /** Nothing to revoke and a successful revoke both mean "they no longer hold
   *  a share on this notebook". Nothing to revoke also means nothing to
   *  re-key — rotating there would retire a key for no reason. */
  it('does nothing when they held no share on it', async () => {
    apiRequest.mockResolvedValue({ success: true, data: [] });
    expect(await revokeNotebookObjectShare(NB, 'mallory@example.com'))
      .toEqual({ revoked: true, rotated: false });
    expect(rotateNotebookContentKey).not.toHaveBeenCalled();
  });

  it('reports failure when the fallback delete does not land', async () => {
    rotateNotebookContentKey.mockResolvedValue({ rotated: false, remainingCount: 0, reWrapFailures: [], revokedShareLink: false });
    apiRequest.mockImplementation(async (url: string) =>
      url.startsWith('/api/v1/shares/')
        ? { success: false }
        : { success: true, data: [{ id: 's1', recipient_email: 'mallory@example.com', permission: 'view' }] });

    expect(await revokeNotebookObjectShare(NB, 'mallory@example.com'))
      .toEqual({ revoked: false, rotated: false });
  });

  it('reports failure when the share list cannot be read', async () => {
    apiRequest.mockResolvedValue({ success: false });
    expect(await revokeNotebookObjectShare(NB, 'mallory@example.com'))
      .toEqual({ revoked: false, rotated: false });
  });
});

describe('revoking access as a whole', () => {
  beforeEach(() => {
    apiRequest.mockImplementation(async (url: string) =>
      url.endsWith('/shares')
        ? { success: true, data: [{ id: 's1', recipient_email: 'mallory@example.com', permission: 'view' }] }
        : { success: true });
  });

  it('writes the roster without them, then revokes and re-keys the object', async () => {
    const r = await revokeNotebookAccess(NB, 'mallory@example.com');

    expect(setNotebookMembers).toHaveBeenCalledWith(NB, [ALICE]);
    expect(rotateNotebookContentKey).toHaveBeenCalledWith(NB, ['s1'], 'notebook_removal');
    expect(r).toEqual({
      rosterUpdated: true, objectRevoked: true, objectRotated: true,
      removedUserId: 'u-mallory',
    });
  });

  /**
   * The two halves are independent: a roster write that fails must not stop
   * the object being revoked, and neither may stop the caller starting the
   * re-keying.
   */
  it('still revokes the object when the roster write fails', async () => {
    setNotebookMembers.mockResolvedValue(false);

    const r = await revokeNotebookAccess(NB, 'mallory@example.com');

    expect(r.rosterUpdated).toBe(false);
    expect(r.objectRevoked).toBe(true);
  });

  it('still reports the user id when the object revoke throws', async () => {
    apiRequest.mockRejectedValue(new Error('offline'));

    const r = await revokeNotebookAccess(NB, 'mallory@example.com');

    expect(r.objectRevoked).toBe(false);
    expect(r.removedUserId).toBe('u-mallory');
  });

  it('does not write the roster when they were not in it', async () => {
    membersOf.mockReturnValue([ALICE]);

    await revokeNotebookAccess(NB, 'mallory@example.com');

    expect(setNotebookMembers).not.toHaveBeenCalled();
  });
});
