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
 * A background share says WHY it did not go out.
 *
 * With only a boolean and a console warning, an owner whose recipient's key
 * had changed would see nothing. The reason is what lets the badge and the
 * Share panel say "their key changed — verify it" instead of silence.
 */

const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const allowSealToRecipient = vi.fn();
const ensureSigningKey = vi.fn();
vi.mock('./crypto', () => ({
  wrapContentKeyForRecipient: () => 'sealed',
  allowSealToRecipient: (...a: unknown[]) => allowSealToRecipient(...a),
  ensureSigningKey: (...a: unknown[]) => ensureSigningKey(...a),
  signNoteShareWrap: () => 'ab'.repeat(64),
  getSharingPublicKeyHex: () => 'my-pub',
  unwrapContentKeyWithVault: () => null,
  decryptWithContentKey: () => null,
  generateContentKey: () => new Uint8Array(32),
  encryptWithContentKey: () => ({ ciphertext: 'c', nonce: 'n' }),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'n' }),
}));
vi.mock('./attachmentUpload', () => ({ rekeyNoteAttachments: async () => {}, listAttachmentsForRekey: async () => [] }));
vi.mock('./retainedKeys', () => ({ retain: () => {} }));
vi.mock('../stores/notes', () => ({ notesStore: { notes: () => [], applyLocalPatch: () => {} } }));
vi.mock('../stores/notebooks', () => ({ notebooksStore: {} }));
vi.mock('../stores/auth', () => ({ authStore: { user: () => ({ id: '11111111-1111-4111-8111-111111111111' }) } }));

const { shareNoteWithRecipientResult, shareNoteWithRecipient } = await import('./shareUtils');

const recipient = {
  email: 'ben@example.test',
  permission: 'edit' as const,
  publicKey: 'cc'.repeat(32),
  userId: '22222222-2222-4222-8222-222222222222',
  signingPublicKey: 'dd'.repeat(32),
};
const KEY = new Uint8Array(32).fill(3);

beforeEach(() => {
  apiRequest.mockReset();
  allowSealToRecipient.mockReset().mockReturnValue(true);
  ensureSigningKey.mockReset().mockReturnValue(true);
});

describe('shareNoteWithRecipientResult', () => {
  it('refuses a changed key without contacting the server, and says so', async () => {
    allowSealToRecipient.mockReturnValue(false);
    expect(await shareNoteWithRecipientResult('n1', KEY, recipient)).toEqual({ ok: false, reason: 'key-changed' });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('refuses when it cannot sign, and says so', async () => {
    ensureSigningKey.mockReturnValue(false);
    expect(await shareNoteWithRecipientResult('n1', KEY, recipient)).toEqual({ ok: false, reason: 'cannot-sign' });
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('reports a 402 as "upgrade" and any other refusal as "failed"', async () => {
    apiRequest.mockResolvedValueOnce({ success: false, status: 402 });
    expect(await shareNoteWithRecipientResult('n1', KEY, recipient)).toEqual({ ok: false, reason: 'upgrade' });
    apiRequest.mockResolvedValueOnce({ success: false, status: 500 });
    expect(await shareNoteWithRecipientResult('n1', KEY, recipient)).toEqual({ ok: false, reason: 'failed' });
  });

  it('succeeds, and the boolean wrapper agrees', async () => {
    apiRequest.mockResolvedValue({ success: true, data: {} });
    expect(await shareNoteWithRecipientResult('n1', KEY, recipient)).toEqual({ ok: true });
    expect(await shareNoteWithRecipient('n1', KEY, recipient)).toBe(true);
  });
});
