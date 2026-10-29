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
import { removalDidNotGoThrough, TRY_AGAIN_LATER, DID_NOT_GO_THROUGH } from './notebookFirst';

/**
 * Characterization tests for content-key rotation.
 *
 * This is the path that cuts a removed recipient off: it mints a fresh content
 * key, re-encrypts the item under it, re-seals to whoever remains, and hands
 * the server the rows to delete — all in one transaction.
 *
 * These pin the behaviour that must not drift: what makes it refuse outright,
 * who gets re-sealed, what is signed and under which generation, and what is
 * actually PUT.
 */

const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const unwrapContentKeyWithVault = vi.fn();
const decryptWithContentKey = vi.fn();
const generateContentKey = vi.fn();
const encryptWithContentKey = vi.fn();
const wrapContentKeyWithVault = vi.fn();
const wrapContentKeyForRecipient = vi.fn();
const allowSealToRecipient = vi.fn();
const ensureSigningKey = vi.fn();
const signNoteShareWrap = vi.fn();
vi.mock('./crypto', () => ({
  unwrapContentKeyWithVault: (...a: unknown[]) => unwrapContentKeyWithVault(...a),
  decryptWithContentKey: (...a: unknown[]) => decryptWithContentKey(...a),
  generateContentKey: (...a: unknown[]) => generateContentKey(...a),
  encryptWithContentKey: (...a: unknown[]) => encryptWithContentKey(...a),
  wrapContentKeyWithVault: (...a: unknown[]) => wrapContentKeyWithVault(...a),
  wrapContentKeyForRecipient: (...a: unknown[]) => wrapContentKeyForRecipient(...a),
  allowSealToRecipient: (...a: unknown[]) => allowSealToRecipient(...a),
  ensureSigningKey: (...a: unknown[]) => ensureSigningKey(...a),
  signNoteShareWrap: (...a: unknown[]) => signNoteShareWrap(...a),
  getSharingPublicKeyHex: () => 'my-pub',
}));

const rekeyNoteAttachments = vi.fn();
const listAttachmentsForRekey = vi.fn();
vi.mock('./attachmentUpload', () => ({
  rekeyNoteAttachments: (...a: unknown[]) => rekeyNoteAttachments(...a),
  listAttachmentsForRekey: (...a: unknown[]) => listAttachmentsForRekey(...a),
}));

const retainContentKey = vi.fn();
vi.mock('./retainedKeys', () => ({ retain: (...a: unknown[]) => retainContentKey(...a) }));

const notes = vi.fn();
const applyLocalPatch = vi.fn();
const adoptServerRow = vi.fn();
vi.mock('../stores/notes', () => ({
  notesStore: {
    notes: () => notes(),
    applyLocalPatch: (...a: unknown[]) => applyLocalPatch(...a),
    adoptServerRow: (...a: unknown[]) => adoptServerRow(...a),
  },
}));

const notebookWrap = vi.fn();
const notebookVersion = vi.fn();
const adoptRotatedNotebookKey = vi.fn();
vi.mock('../stores/notebooks', () => ({
  notebooksStore: {
    notebookContentKey: () => null,
    membersOf: () => [],
    notebookWrap: (...a: unknown[]) => notebookWrap(...a),
    notebookVersion: (...a: unknown[]) => notebookVersion(...a),
    adoptRotatedNotebookKey: (...a: unknown[]) => adoptRotatedNotebookKey(...a),
  },
}));

vi.mock('../stores/auth', () => ({ authStore: { user: () => ({ id: 'me' }) } }));

const { rotateContentKey, rotateNotebookContentKey } = await import('./shareUtils');
const { ASK_AGAIN_AFTER_MS } = await import('./askTwice');
const { SIGN_ATTEMPTS, CHANGED_ELSEWHERE_ATTEMPTS } = await import('./shareUtils');

const NOTE_ID = 'note-1';
/** The note's attachment rows as listed before the removal. */
const ROWS = [{ id: 'att-1', encrypted_meta: 'm', meta_nonce: 'n', size_bytes: 10 }];
const OLD_KEY = new Uint8Array(32).fill(1);
const NEW_KEY = new Uint8Array(32).fill(2);

const aNote = (over: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  version: 7,
  contentKeyGeneration: 3,
  wrappedContentKey: 'wk',
  wrappedContentKeyNonce: 'wn',
  ...over,
});

/** Default happy path: one remaining recipient, everything permitted. */
function happyPath(shares: { id: string; recipient_email: string; permission: string; has_wrap?: boolean }[]) {
  apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === `/api/v1/items/${NOTE_ID}` && !opts?.method) {
      return { success: true, data: { encrypted_content: 'ct', content_nonce: 'n' } };
    }
    if (url === `/api/v1/items/${NOTE_ID}/shares`) return { success: true, data: shares };
    if (url === '/api/v1/users/public-keys') {
      return { success: true, data: { users: shares.map(s => ({
        email: s.recipient_email, user_id: `u-${s.id}`,
        sharing_public_key: `pk-${s.id}`, signing_public_key: `sk-${s.id}`,
      })) } };
    }
    if (url === `/api/v1/items/${NOTE_ID}/rotate-shares`) {
      return { success: true, data: { version: 8, content_key_generation: 4 } };
    }
    return { success: true, data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  notes.mockReturnValue([aNote()]);
  unwrapContentKeyWithVault.mockReturnValue(OLD_KEY);
  decryptWithContentKey.mockReturnValue('{"title":"t"}');
  generateContentKey.mockReturnValue(NEW_KEY);
  encryptWithContentKey.mockReturnValue({ ciphertext: 'new-ct', nonce: 'new-n' });
  wrapContentKeyWithVault.mockReturnValue({ wrappedKey: 'new-wk', nonce: 'new-wn' });
  wrapContentKeyForRecipient.mockImplementation((_k: unknown, pub: string) => `sealed-for-${pub}`);
  allowSealToRecipient.mockReturnValue(true);
  ensureSigningKey.mockReturnValue(true);
  signNoteShareWrap.mockReturnValue('sig');
  rekeyNoteAttachments.mockResolvedValue(undefined);
  listAttachmentsForRekey.mockResolvedValue(ROWS);
  notebookWrap.mockReturnValue({ key: 'wk', nonce: 'wn' });
  notebookVersion.mockReturnValue(7);
  happyPath([{ id: 's1', recipient_email: 'stays@example.com', permission: 'edit' }]);
});

describe('refusing to rotate', () => {
  /** Every one of these must leave the item ALONE: a rotation that half-runs
   *  would re-key an item nobody can open. */
  const expectUntouched = async () => {
    const r = await rotateContentKey(NOTE_ID, []);
    expect(r.rotated).toBe(false);
    expect(apiRequest).not.toHaveBeenCalledWith(
      expect.stringContaining('rotate-shares'), expect.anything());
  };

  it('refuses when the note is not in the store', async () => {
    notes.mockReturnValue([]);
    await expectUntouched();
  });

  /** A legacy note is encrypted under the vault key itself — there is no
   *  content key to rotate. */
  it('refuses a note with no wrapped content key', async () => {
    notes.mockReturnValue([aNote({ wrappedContentKey: null })]);
    await expectUntouched();
  });

  it('refuses when the vault cannot open the wrap', async () => {
    unwrapContentKeyWithVault.mockReturnValue(null);
    await expectUntouched();
  });

  /**
   * The plaintext comes from the SERVER copy, not the cached note: rotating
   * from a stale cache would re-encrypt an old body over a newer one.
   */
  it('refuses when the server copy cannot be fetched', async () => {
    apiRequest.mockResolvedValue({ success: false });
    await expectUntouched();
  });

  it('refuses when the server copy will not decrypt', async () => {
    decryptWithContentKey.mockReturnValue(null);
    await expectUntouched();
  });
});

describe('who gets the new key', () => {
  it('re-seals to the remaining recipients', async () => {
    happyPath([{ id: 's1', recipient_email: 'stays@example.com', permission: 'edit' }]);

    const r = await rotateContentKey(NOTE_ID, []);

    expect(r.rotated).toBe(true);
    expect(r.remainingCount).toBe(1);
    const body = apiRequest.mock.calls.find(c => c[0].includes('rotate-shares'))![1].body;
    expect(body.update_shares).toEqual([
      { share_id: 's1', wrapped_key: 'sealed-for-pk-s1', wrap_signature: 'sig' },
    ]);
  });

  /** The whole point: the person being cut off must not be sealed the key
   *  they are being cut off from. */
  it('never re-seals to a share it was told to remove', async () => {
    happyPath([
      { id: 'gone', recipient_email: 'removed@example.com', permission: 'edit' },
      { id: 's1', recipient_email: 'stays@example.com', permission: 'edit' },
    ]);

    const r = await rotateContentKey(NOTE_ID, ['gone']);

    const body = apiRequest.mock.calls.find(c => c[0].includes('rotate-shares'))![1].body;
    expect(body.remove_share_ids).toEqual(['gone']);
    expect(body.update_shares.map((u: { share_id: string }) => u.share_id)).toEqual(['s1']);
    expect(r.remainingCount).toBe(1);
  });

  /**
   * A row with no key is someone invited before they had an account. Once the
   * address has one, the directory answers for it, and a re-key that sealed
   * the new key to that account would hand them the note, readable, with no
   * invitation, at the first removal or move after they signed up.
   */
  it('never gives a key to a row that carries none: invited before they had an account', async () => {
    happyPath([
      { id: 's1', recipient_email: 'stays@example.com', permission: 'edit', has_wrap: true },
      { id: 's-zoe', recipient_email: 'zoe@example.com', permission: 'edit', has_wrap: false },
    ]);

    const r = await rotateContentKey(NOTE_ID, []);

    expect(r.rotated).toBe(true);
    const body = apiRequest.mock.calls.find(c => c[0].includes('rotate-shares'))![1].body;
    expect(body.update_shares).toEqual([
      { share_id: 's1', wrapped_key: 'sealed-for-pk-s1', wrap_signature: 'sig' },
    ]);
    // Nothing was sealed for them, and they were not even asked about.
    expect(wrapContentKeyForRecipient.mock.calls.map(c => c[1])).toEqual(['pk-s1']);
    const asked = apiRequest.mock.calls.find(c => c[0] === '/api/v1/users/public-keys')![1].body.emails;
    expect(asked).toEqual(['stays@example.com']);
    // Their row is not removed, and it is not a failure of this re-key.
    expect(body.remove_share_ids).toEqual([]);
    expect(r.reWrapFailures).toEqual([]);
    expect(r.remainingCount).toBe(1);
  });

  it('with nobody but such a row, nobody is asked about and nobody is sealed to', async () => {
    happyPath([{ id: 's-zoe', recipient_email: 'zoe@example.com', permission: 'edit', has_wrap: false }]);

    const r = await rotateContentKey(NOTE_ID, []);

    expect(r.rotated).toBe(true);
    expect(apiRequest.mock.calls.some(c => c[0] === '/api/v1/users/public-keys')).toBe(false);
    expect(wrapContentKeyForRecipient).not.toHaveBeenCalled();
    const body = apiRequest.mock.calls.find(c => c[0].includes('rotate-shares'))![1].body;
    expect(body.update_shares).toEqual([]);
  });

  it('a server that does not say whether a row carries a key is taken to say it does', async () => {
    happyPath([{ id: 's1', recipient_email: 'stays@example.com', permission: 'edit' }]);
    await rotateContentKey(NOTE_ID, []);
    const body = apiRequest.mock.calls.find(c => c[0].includes('rotate-shares'))![1].body;
    expect(body.update_shares.map((u: { share_id: string }) => u.share_id)).toEqual(['s1']);
  });

  /**
   * Send-side TOFU gate: a recipient whose directory key no longer matches
   * their pin might be a server substitution, and sealing would hand the fresh
   * key to whoever swapped it.
   */
  it('refuses to seal to a recipient whose key no longer matches their pin', async () => {
    allowSealToRecipient.mockReturnValue(false);

    const r = await rotateContentKey(NOTE_ID, []);

    expect(r.reWrapFailures).toEqual(['stays@example.com']);
    const body = apiRequest.mock.calls.find(c => c[0].includes('rotate-shares'))![1].body;
    expect(body.update_shares).toEqual([]);
  });


  it('reports a recipient with no published key as a failure', async () => {
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === `/api/v1/items/${NOTE_ID}` && !opts?.method) {
        return { success: true, data: { encrypted_content: 'ct', content_nonce: 'n' } };
      }
      if (url === `/api/v1/items/${NOTE_ID}/shares`) {
        return { success: true, data: [{ id: 's1', recipient_email: 'nokey@example.com', permission: 'edit' }] };
      }
      if (url === '/api/v1/users/public-keys') return { success: true, data: { users: [] } };
      return { success: true, data: { version: 8 } };
    });

    const r = await rotateContentKey(NOTE_ID, []);
    expect(r.reWrapFailures).toEqual(['nokey@example.com']);
  });
});

/**
 * A removal whose new key could not be signed for one of the others is tried
 * again automatically, and after several tries the person is asked to try
 * again later or reach out to support. An unsigned rewrap is dropped by
 * someone who holds a pin for us, and without one the note is re-keyed past
 * them: they would silently lose it while the removal went through.
 */
describe('a new key that could not be signed for someone who stays', () => {
  const rotateCall = () => apiRequest.mock.calls.find(c => String(c[0]).endsWith('/rotate-shares'));
  afterEach(() => { vi.useRealTimers(); });
  async function rotateWithPauses(removeShareIds: string[] = []) {
    vi.useFakeTimers();
    const p = rotateContentKey(NOTE_ID, removeShareIds);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * (SIGN_ATTEMPTS + 1));
    return p;
  }

  it('is signed again after a moment, and the key change goes with the signature', async () => {
    signNoteShareWrap.mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValue('sig');
    vi.useFakeTimers();
    const p = rotateContentKey(NOTE_ID, []);
    // A moment apart: not again at once.
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS - 1);
    expect(signNoteShareWrap).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signNoteShareWrap).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS);
    const r = await p;
    expect(r.rotated).toBe(true);
    expect(signNoteShareWrap).toHaveBeenCalledTimes(3);
    expect(rotateCall()![1].body.update_shares).toEqual([{ share_id: 's1', wrapped_key: 'sealed-for-pk-s1', wrap_signature: 'sig' }]);
  });

  it(`not signed even tried ${SIGN_ATTEMPTS} times: nothing is sent, nothing is kept, and the result says why`, async () => {
    signNoteShareWrap.mockReturnValue(null);
    const r = await rotateWithPauses();
    expect(r).toMatchObject({ rotated: false, couldNotSign: true, reWrapFailures: ['stays@example.com'] });
    expect(signNoteShareWrap).toHaveBeenCalledTimes(SIGN_ATTEMPTS);
    expect(rotateCall()).toBeUndefined();
    expect(retainContentKey).not.toHaveBeenCalled();
  });

  it('nor when it is one of two who stay: the other is not sent alone, and the one removed stays', async () => {
    happyPath([
      { id: 's1', recipient_email: 'stays@example.com', permission: 'edit' },
      { id: 's2', recipient_email: 'cannot@example.com', permission: 'edit' },
      { id: 's3', recipient_email: 'goes@example.com', permission: 'edit' },
    ]);
    signNoteShareWrap.mockImplementation((p: { recipientUserId: string }) => (p.recipientUserId === 'u-s2' ? null : 'sig'));
    const r = await rotateWithPauses(['s3']);
    expect(r).toMatchObject({ rotated: false, couldNotSign: true, reWrapFailures: ['cannot@example.com'] });
    expect(rotateCall()).toBeUndefined();
  });

  it('a person with no published key is not this: the key change goes, and they are reported, as before', async () => {
    happyPath([{ id: 's1', recipient_email: 'stays@example.com', permission: 'edit' }]);
    allowSealToRecipient.mockReturnValue(false);
    const r = await rotateWithPauses();
    expect(r.rotated).toBe(true);
    expect(r.couldNotSign).toBeUndefined();
    expect(r.reWrapFailures).toEqual(['stays@example.com']);
    expect(signNoteShareWrap).not.toHaveBeenCalled();
  });
});

describe('what is signed', () => {
  /**
   * The server bumps content_key_generation by exactly 1, so the re-sealed
   * wraps must be signed under CURRENT + 1 — the generation the recipient will
   * read them at. Signing under the current one makes every rewrap unverifiable.
   */
  it('signs under the generation the server will bump to', async () => {
    await rotateContentKey(NOTE_ID, []);
    expect(signNoteShareWrap).toHaveBeenCalledWith(expect.objectContaining({
      itemId: NOTE_ID, contentKeyVersion: 4,
    }));
  });

  it('treats a note with no known generation as generation 1', async () => {
    notes.mockReturnValue([aNote({ contentKeyGeneration: undefined })]);
    await rotateContentKey(NOTE_ID, []);
    expect(signNoteShareWrap).toHaveBeenCalledWith(expect.objectContaining({
      contentKeyVersion: 2,
    }));
  });
});

describe('committing the rotation', () => {
  it('sends the new ciphertext, the new vault wrap and the expected version', async () => {
    await rotateContentKey(NOTE_ID, []);

    const body = apiRequest.mock.calls.find(c => c[0].includes('rotate-shares'))![1].body;
    expect(body).toMatchObject({
      encrypted_content: 'new-ct',
      content_nonce: 'new-n',
      wrapped_content_key: 'new-wk',
      wrapped_content_key_nonce: 'new-wn',
      expected_version: 7,
    });
  });

  /**
   * Retain BEFORE committing: a crash between the server rotation landing and
   * the attachment re-key finishing would otherwise orphan blobs still sealed
   * under the old key.
   */
  it('retains the old key before committing', async () => {
    await rotateContentKey(NOTE_ID, []);
    expect(retainContentKey).toHaveBeenCalledWith(NOTE_ID, OLD_KEY);
  });

  it('mirrors the new wrap and server version into the notes store', async () => {
    await rotateContentKey(NOTE_ID, []);
    expect(applyLocalPatch).toHaveBeenCalledWith(expect.objectContaining({
      id: NOTE_ID, version: 8,
      wrappedContentKey: 'new-wk', wrappedContentKeyNonce: 'new-wn',
      contentKeyGeneration: 4,
    }));
  });

  it('reports failure and patches nothing when the server rejects it', async () => {
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url.includes('rotate-shares')) return { success: false };
      if (url === `/api/v1/items/${NOTE_ID}` && !opts?.method) {
        return { success: true, data: { encrypted_content: 'ct', content_nonce: 'n' } };
      }
      if (url.endsWith('/shares')) return { success: true, data: [] };
      return { success: true, data: { users: [] } };
    });

    const r = await rotateContentKey(NOTE_ID, []);

    expect(r.rotated).toBe(false);
    expect(applyLocalPatch).not.toHaveBeenCalled();
  });

  it('surfaces a public link the rotation invalidated', async () => {
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url.includes('rotate-shares')) {
        return { success: true, data: { version: 8, revoked_share_link: true } };
      }
      if (url === `/api/v1/items/${NOTE_ID}` && !opts?.method) {
        return { success: true, data: { encrypted_content: 'ct', content_nonce: 'n' } };
      }
      if (url.endsWith('/shares')) return { success: true, data: [] };
      return { success: true, data: { users: [] } };
    });

    expect((await rotateContentKey(NOTE_ID, [])).revokedShareLink).toBe(true);
  });

  /**
   * Attachments are re-keyed after the body rotation has already committed, so
   * a failure there must not fail the rotation.
   */
  it('still reports success when the attachment re-key fails', async () => {
    rekeyNoteAttachments.mockRejectedValue(new Error('r2 down'));
    expect((await rotateContentKey(NOTE_ID, [])).rotated).toBe(true);
  });

  it('re-keys the attachments from the old key to the new one', async () => {
    await rotateContentKey(NOTE_ID, []);
    expect(rekeyNoteAttachments).toHaveBeenCalledWith(NOTE_ID, ROWS, OLD_KEY, NEW_KEY);
  });
});

/**
 * The attachments a rotation brings forward are the ones there BEFORE the
 * removal. For a caller that passes the rows it removes, rotate-shares IS the
 * removal, so the list is read before it; a caller that removed someone
 * already hands over what it listed before that; a list that could not be
 * read brings nothing forward, and nothing is listed after the removal.
 */
describe('the attachments a rotation may bring forward', () => {
  it('are listed BEFORE rotate-shares, and exactly those are re-keyed', async () => {
    const order: string[] = [];
    listAttachmentsForRekey.mockImplementation(async () => { order.push('list'); return ROWS; });
    const inner = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, opts?: unknown) => {
      if (url.includes('rotate-shares')) order.push('rotate-shares');
      return inner(url, opts);
    });

    await rotateContentKey(NOTE_ID, ['gone']);
    expect(order).toEqual(['list', 'rotate-shares']);
    expect(listAttachmentsForRekey).toHaveBeenCalledWith(NOTE_ID);
    expect(rekeyNoteAttachments).toHaveBeenCalledTimes(1);
    expect(rekeyNoteAttachments.mock.calls[0][1]).toBe(ROWS);
  });

  it('a list that could not be read still rotates, and brings nothing forward', async () => {
    listAttachmentsForRekey.mockResolvedValue(null);
    expect((await rotateContentKey(NOTE_ID, ['gone'])).rotated).toBe(true);
    expect(listAttachmentsForRekey).toHaveBeenCalledTimes(1);
    expect(rekeyNoteAttachments).not.toHaveBeenCalled();
  });

  it('rows handed over by a caller that removed first are used, and nothing is listed', async () => {
    const before = [{ id: 'att-9', encrypted_meta: 'm9', meta_nonce: 'n', size_bytes: 3 }];
    await rotateContentKey(NOTE_ID, [], undefined, { attachmentsListedBefore: before });
    expect(listAttachmentsForRekey).not.toHaveBeenCalled();
    expect(rekeyNoteAttachments).toHaveBeenCalledWith(NOTE_ID, before, OLD_KEY, NEW_KEY);
  });

  it('a failed listing handed over lists nothing after the removal, and brings nothing forward', async () => {
    expect((await rotateContentKey(NOTE_ID, [], undefined, { attachmentsListedBefore: null })).rotated).toBe(true);
    expect(listAttachmentsForRekey).not.toHaveBeenCalled();
    expect(rekeyNoteAttachments).not.toHaveBeenCalled();
  });
});

/**
 * The notebook object carries the collection's name and its ROSTER — the list
 * every member reads to seal a new note to everyone. Someone removed from a
 * notebook holds the key that opens all of it, so leaving it un-rotated means
 * every later roster update is written under a key they have.
 *
 * Same rotation as a note, sourced from the notebooks store instead: the
 * security-critical middle (TOFU gate, signature, generation) is one
 * implementation, because two copies of it drift and only one gets fixed.
 */
describe('rotating a notebook', () => {
  const NB_ID = 'note-1'; // reuses the happy-path fixtures keyed to this id

  it('rotates and reports success', async () => {
    const r = await rotateNotebookContentKey(NB_ID, []);
    expect(r.rotated).toBe(true);
  });

  it('refuses when this client has no wrap for it', async () => {
    notebookWrap.mockReturnValue(null);
    expect((await rotateNotebookContentKey(NB_ID, [])).rotated).toBe(false);
    expect(apiRequest).not.toHaveBeenCalledWith(
      expect.stringContaining('rotate-shares'), expect.anything());
  });

  /** Version 0 is the "id taken by a row we cannot write" marker. */
  it('refuses when it has no writable version', async () => {
    notebookVersion.mockReturnValue(null);
    expect((await rotateNotebookContentKey(NB_ID, [])).rotated).toBe(false);
  });

  it('cuts off exactly the shares it was given', async () => {
    happyPath([
      { id: 'gone', recipient_email: 'removed@example.com', permission: 'view' },
      { id: 's1', recipient_email: 'stays@example.com', permission: 'view' },
    ]);

    await rotateNotebookContentKey(NB_ID, ['gone']);

    const body = apiRequest.mock.calls.find(c => c[0].includes('rotate-shares'))![1].body;
    expect(body.remove_share_ids).toEqual(['gone']);
    expect(body.update_shares.map((u: { share_id: string }) => u.share_id)).toEqual(['s1']);
  });

  /**
   * Without adopting the new wrap, notebookContentKey keeps handing back the
   * key the rotation just retired — which is precisely the key the removed
   * member holds — and the next write PUTs against a stale version.
   */
  it('adopts the new wrap and version', async () => {
    await rotateNotebookContentKey(NB_ID, []);
    expect(adoptRotatedNotebookKey).toHaveBeenCalledWith(NB_ID, {
      wrappedKey: 'new-wk', nonce: 'new-wn', version: 8,
    });
  });

  it('adopts nothing when the server rejects the rotation', async () => {
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url.includes('rotate-shares')) return { success: false };
      if (url === `/api/v1/items/${NB_ID}` && !opts?.method) {
        return { success: true, data: { encrypted_content: 'ct', content_nonce: 'n' } };
      }
      if (url.endsWith('/shares')) return { success: true, data: [] };
      return { success: true, data: { users: [] } };
    });

    expect((await rotateNotebookContentKey(NB_ID, [])).rotated).toBe(false);
    expect(adoptRotatedNotebookKey).not.toHaveBeenCalled();
  });

  /** A notebook is a name and a roster; there are no attachment blobs for a
   *  retained key to rescue, and retaining would only grow a store nothing
   *  reads. */
  it('neither retains the old key nor touches attachments', async () => {
    await rotateNotebookContentKey(NB_ID, []);
    expect(retainContentKey).not.toHaveBeenCalled();
    expect(rekeyNoteAttachments).not.toHaveBeenCalled();
  });

  /** Notebooks track no local generation, so the server's own value is what
   *  the wraps must be signed one above. */
  it('signs one above the generation the server reports', async () => {
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === `/api/v1/items/${NB_ID}` && !opts?.method) {
        return { success: true, data: {
          encrypted_content: 'ct', content_nonce: 'n', content_key_generation: 5,
        } };
      }
      if (url === `/api/v1/items/${NB_ID}/shares`) {
        return { success: true, data: [{ id: 's1', recipient_email: 'stays@example.com', permission: 'view' }] };
      }
      if (url === '/api/v1/users/public-keys') {
        return { success: true, data: { users: [{
          email: 'stays@example.com', user_id: 'u1',
          sharing_public_key: 'pk-s1', signing_public_key: 'sk-s1',
        }] } };
      }
      return { success: true, data: { version: 8, content_key_generation: 6 } };
    });

    await rotateNotebookContentKey(NB_ID, []);

    expect(signNoteShareWrap).toHaveBeenCalledWith(expect.objectContaining({
      contentKeyVersion: 6,
    }));
  });
});

describe('a read the key change needs gets no answer', () => {
  // A removal whose directory lookup failed must not be sent all the same:
  // rotate-shares re-keys only the rows it is given, so every other person
  // the note was shared with would keep a wrap that opens nothing. Silently.
  const STAYS = { id: 's1', recipient_email: 'stays@example.com', permission: 'edit' };
  const GOES = { id: 's2', recipient_email: 'goes@example.com', permission: 'edit' };
  /** The happy path, but the given calls (counted from 1) to `path` get `answer`. */
  function failing(path: string, calls: number[], answer: Record<string, unknown> = { success: false, error: 'Network error' }) {
    happyPath([STAYS, GOES]);
    const base = apiRequest.getMockImplementation()!;
    let n = 0;
    apiRequest.mockImplementation(async (url: string, o?: unknown) => {
      if (url === path && calls.includes(++n)) return answer;
      return base(url, o);
    });
  }
  const rotateCall = () => apiRequest.mock.calls.find(c => String(c[0]).endsWith('/rotate-shares'));
  const asked = (path: string) => apiRequest.mock.calls.filter(c => c[0] === path).length;
  async function removeGoes() {
    vi.useFakeTimers();
    const p = rotateContentKey(NOTE_ID, [GOES.id]);
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 3);
    return p;
  }
  afterEach(() => { vi.useRealTimers(); });

  it('their keys not read once: asked again after a moment, and the removal goes, the others given the new key', async () => {
    failing('/api/v1/users/public-keys', [1]);
    const r = await removeGoes();
    expect(r.rotated).toBe(true);
    expect(asked('/api/v1/users/public-keys')).toBe(2);
    expect(rotateCall()![1].body).toMatchObject({ remove_share_ids: ['s2'], update_shares: [{ share_id: 's1', wrapped_key: 'sealed-for-pk-s1', wrap_signature: 'sig' }] });
  });

  it('their keys not read even asked again: nothing is sent, nothing is changed here, and it says who was not given the key', async () => {
    failing('/api/v1/users/public-keys', [1, 2]);
    const r = await removeGoes();
    expect(r).toMatchObject({ rotated: false, remainingCount: 1, reWrapFailures: ['stays@example.com'] });
    expect(rotateCall()).toBeUndefined();
    expect(applyLocalPatch).not.toHaveBeenCalled();
    expect(retainContentKey).not.toHaveBeenCalled();
  });

  it('who has the note not read even asked again: nothing is sent', async () => {
    failing(`/api/v1/items/${NOTE_ID}/shares`, [1, 2]);
    const r = await removeGoes();
    expect(r.rotated).toBe(false);
    expect(asked(`/api/v1/items/${NOTE_ID}/shares`)).toBe(2);
    expect(rotateCall()).toBeUndefined();
  });

  it('the note itself not read once: asked again, and it goes', async () => {
    failing(`/api/v1/items/${NOTE_ID}`, [1]);
    expect((await removeGoes()).rotated).toBe(true);
  });

  it('another account answered: never asked again, nothing sent', async () => {
    failing('/api/v1/users/public-keys', [1, 2], { success: false, error: 'stop', error_code: 'account_mismatch' });
    const r = await removeGoes();
    expect(r.rotated).toBe(false);
    expect(asked('/api/v1/users/public-keys')).toBe(1);
    expect(rotateCall()).toBeUndefined();
  });

  it('a notebook\'s own key change: the same', async () => {
    happyPath([STAYS, GOES]);
    const base = apiRequest.getMockImplementation()!;
    apiRequest.mockImplementation(async (url: string, o?: unknown) =>
      url === '/api/v1/users/public-keys' ? { success: false } : base(url.replace('nb-1', NOTE_ID), o));
    vi.useFakeTimers();
    const p = rotateNotebookContentKey('nb-1', [GOES.id], 'notebook_removal');
    await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 3);
    const r = await p;
    expect(r.rotated).toBe(false);
    expect(rotateCall()).toBeUndefined();
    expect(adoptRotatedNotebookKey).not.toHaveBeenCalled();
  });
});

/**
 * A removal that did not go through for a reason other than the connection
 * says so in the words for it — after the page tried again by itself where
 * trying again can help: the note changed elsewhere since it was read (409).
 */
describe('a key change that fails for a reason other than the connection', () => {
  const posts = () => apiRequest.mock.calls.filter(c => c[0] === `/api/v1/items/${NOTE_ID}/rotate-shares`);
  /** rotate-shares answers each post with the next of `answers`, then taken; the note is at `version` on the server. */
  function server(answers: { success: boolean; status?: number }[], version = 9) {
    const base = apiRequest.getMockImplementation()!;
    let n = 0;
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === `/api/v1/items/${NOTE_ID}/rotate-shares`) {
        const a = answers[n++];
        if (a && !a.success) return { success: false, status: a.status, error: 'refused' };
      }
      if (url === `/api/v1/items/${NOTE_ID}` && !opts?.method) {
        return { success: true, data: { encrypted_content: 'ct', content_nonce: 'n', version } };
      }
      return base(url, opts);
    });
  }

  it('the note\'s key does not open here: says so, and nothing is sent', async () => {
    unwrapContentKeyWithVault.mockReturnValue(null);
    const r = await rotateContentKey(NOTE_ID, ['s1']);
    expect(r).toMatchObject({ rotated: false, notOpenHere: true });
    expect(posts()).toHaveLength(0);
  });

  it('what the server has under it does not open: says so, and nothing is sent', async () => {
    decryptWithContentKey.mockReturnValue(null);
    const r = await rotateContentKey(NOTE_ID, ['s1']);
    expect(r).toMatchObject({ rotated: false, notOpenHere: true });
    expect(posts()).toHaveLength(0);
  });

  it('changed elsewhere once: tried again by itself at the version the server has now, and done', async () => {
    server([{ success: false, status: 409 }], 9);
    adoptServerRow.mockResolvedValue(true);
    const r = await rotateContentKey(NOTE_ID, ['s1']);
    expect(r.rotated).toBe(true);
    expect(posts().map(c => (c[1] as { body: { expected_version: number } }).body.expected_version)).toEqual([7, 9]);
    expect(posts().map(c => (c[1] as { body: { remove_share_ids: string[] } }).body.remove_share_ids)).toEqual([['s1'], ['s1']]);
    // Applied at a version this page had not read, so the note is
    // taken as the server has it, never this card's words at the new version.
    expect(adoptServerRow).toHaveBeenCalledWith(NOTE_ID);
    expect(applyLocalPatch).not.toHaveBeenCalled();
  });

  it('tried again and done, but the server\'s copy is not read just then: the card keeps its version and takes only the key', async () => {
    server([{ success: false, status: 409 }], 9);
    adoptServerRow.mockResolvedValue(false);
    const r = await rotateContentKey(NOTE_ID, ['s1']);
    expect(r.rotated).toBe(true);
    expect(applyLocalPatch).toHaveBeenCalledTimes(1);
    expect(applyLocalPatch.mock.calls[0][0]).toMatchObject({ id: NOTE_ID, version: 7, wrappedContentKey: 'new-wk', wrappedContentKeyNonce: 'new-wn' });
  });

  it('changed elsewhere every time: tried the set number of times, then says so', async () => {
    server(Array.from({ length: 10 }, () => ({ success: false, status: 409 })));
    const r = await rotateContentKey(NOTE_ID, ['s1']);
    expect(r).toMatchObject({ rotated: false, changedElsewhere: true });
    expect(posts()).toHaveLength(CHANGED_ELSEWHERE_ATTEMPTS);
    expect(CHANGED_ELSEWHERE_ATTEMPTS).toBe(3);
  });

  it('refused for another reason: not tried again, not said to have changed elsewhere, and not said to be the connection', async () => {
    server([{ success: false, status: 500 }]);
    const r = await rotateContentKey(NOTE_ID, ['s1']);
    expect(r.rotated).toBe(false);
    expect(r.changedElsewhere).toBeUndefined();
    expect(posts()).toHaveLength(1);
    // The server answered; "check your connection" was not why.
    expect(r.refused).toBe(true);
    expect(removalDidNotGoThrough(r)).toBe(TRY_AGAIN_LATER);
  });

  it('too many requests (429) is not the connection either', async () => {
    server([{ success: false, status: 429 }]);
    const r = await rotateContentKey(NOTE_ID, ['s1']);
    expect(r).toMatchObject({ rotated: false, refused: true });
    expect(removalDidNotGoThrough(r)).toBe(TRY_AGAIN_LATER);
  });

  it('the write gets no answer: that is the connection', async () => {
    server([{ success: false }]);
    const r = await rotateContentKey(NOTE_ID, ['s1']);
    expect(r.rotated).toBe(false);
    expect(r.refused).toBeUndefined();
    expect(r.changedElsewhere).toBeUndefined();
    expect(removalDidNotGoThrough(r)).toBe(DID_NOT_GO_THROUGH);
  });

  it('changed elsewhere, and its version cannot be read again: stops there', async () => {
    vi.useFakeTimers();
    try {
      const base = apiRequest.getMockImplementation()!;
      let gets = 0;
      apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
        if (url === `/api/v1/items/${NOTE_ID}/rotate-shares`) return { success: false, status: 409, error: 'refused' };
        // The key change's own read of the note answers; the re-read of its version after the 409 does not.
        if (url === `/api/v1/items/${NOTE_ID}` && !opts?.method && ++gets > 1) return { success: false, error: 'Network error' };
        return base(url, opts);
      });
      const p = rotateContentKey(NOTE_ID, ['s1']);
      await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 3);
      const r = await p;
      expect(r).toMatchObject({ rotated: false });
      expect(posts()).toHaveLength(1);
      // It stopped because the version got no answer, which is the
      // connection, not because the note kept changing elsewhere.
      expect(r.changedElsewhere).toBeUndefined();
      expect(r.refused).toBeUndefined();
      expect(removalDidNotGoThrough(r)).toBe(DID_NOT_GO_THROUGH);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the note, or the keys of the people who stay, read and refused: not the connection; read with no answer: the connection', async () => {
    vi.useFakeTimers();
    try {
      const base = apiRequest.getMockImplementation()!;
      const cases: [string, { success: false; status?: number; error: string }, true | undefined][] = [
        [`/api/v1/items/${NOTE_ID}`, { success: false, status: 503, error: 'unavailable' }, true],
        [`/api/v1/items/${NOTE_ID}`, { success: false, error: 'Network error' }, undefined],
        ['/api/v1/users/public-keys', { success: false, status: 429, error: 'slow down' }, true],
        ['/api/v1/users/public-keys', { success: false, error: 'Network error' }, undefined],
      ];
      for (const [url, answer, refused] of cases) {
        apiRequest.mockImplementation(async (u: string, opts?: { method?: string }) =>
          u === url && !(u === `/api/v1/items/${NOTE_ID}` && opts?.method) ? answer : base(u, opts));
        // Nobody removed: the one who stays is sealed the new key, so their key is read.
        const p = rotateContentKey(NOTE_ID, []);
        await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 3);
        const r = await p;
        expect(r.rotated).toBe(false);
        expect([url, r.refused]).toEqual([url, refused]);
        expect(removalDidNotGoThrough(r)).toBe(refused ? TRY_AGAIN_LATER : DID_NOT_GO_THROUGH);
      }
      expect(posts()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('changed elsewhere, and the re-read of its version is refused: not the connection', async () => {
    vi.useFakeTimers();
    try {
      const base = apiRequest.getMockImplementation()!;
      let gets = 0;
      apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
        if (url === `/api/v1/items/${NOTE_ID}/rotate-shares`) return { success: false, status: 409, error: 'refused' };
        if (url === `/api/v1/items/${NOTE_ID}` && !opts?.method && ++gets > 1) return { success: false, status: 503, error: 'unavailable' };
        return base(url, opts);
      });
      const p = rotateContentKey(NOTE_ID, ['s1']);
      await vi.advanceTimersByTimeAsync(ASK_AGAIN_AFTER_MS * 3);
      const r = await p;
      expect(r).toMatchObject({ rotated: false, refused: true });
      expect(r.changedElsewhere).toBeUndefined();
      expect(removalDidNotGoThrough(r)).toBe(TRY_AGAIN_LATER);
    } finally {
      vi.useRealTimers();
    }
  });
});

