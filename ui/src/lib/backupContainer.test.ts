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

import { describe, it, expect } from 'vitest';
import {
  sealBackup, openBackup, isEncryptedContainer,
  CONTAINER_FORMAT, CONTAINER_VERSION, KDF_MEMORY_KIB,
} from './backupContainer';

/**
 * The sealed-backup container.
 *
 * An export is a plaintext file, and as a BACKUP that is the wrong default:
 * backups are files people keep, sync and forget, and for Track that file is a
 * complete history of where someone has been. These cover the properties that
 * make sealing worth anything — that a wrong passphrase fails, that the header
 * cannot be edited to weaken the work factor, and that a hostile file cannot
 * make the reader do something absurd before it ever checks the tag.
 *
 * Argon2id at 64 MiB is deliberately slow, so these tests take a moment each.
 */

const PAYLOAD = { format: 'pingolin-note-backup', notes: [{ id: 'n1', title: 'Secret' }] };
const PASS = 'correct horse battery staple';

describe('sealing and opening a backup', () => {
  it('round-trips a payload', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    const opened = await openBackup(sealed, PASS);
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.payload).toEqual(PAYLOAD);
  }, 30000);

  it('produces a container that does not contain the plaintext', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    // The whole point. A file that leaked its contents into the envelope would
    // pass a round-trip test and still be useless.
    expect(JSON.stringify(sealed)).not.toContain('Secret');
    expect(JSON.stringify(sealed)).not.toContain('pingolin-note-backup');
  }, 30000);

  it('records its KDF parameters so a future increase leaves old files readable', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-track');
    expect(sealed.format).toBe(CONTAINER_FORMAT);
    expect(sealed.formatVersion).toBe(CONTAINER_VERSION);
    expect(sealed.product).toBe('pingolin-track');
    expect(sealed.kdf.algorithm).toBe('argon2id');
    expect(sealed.kdf.memoryKib).toBe(KDF_MEMORY_KIB);
    expect(sealed.kdf.salt.length).toBeGreaterThan(0);
  }, 30000);

  it('uses a fresh salt and nonce every time', async () => {
    const a = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    const b = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    // Same passphrase and same payload must not produce the same bytes, or two
    // backups reveal that nothing changed between them.
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  }, 60000);

  it('refuses a wrong passphrase', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    const opened = await openBackup(sealed, 'not the passphrase');
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.wrongPassphrase).toBe(true);
  }, 60000);

  it('refuses an empty passphrase rather than deriving from nothing', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    const opened = await openBackup(sealed, '');
    expect(opened.ok).toBe(false);
  }, 30000);

  it('will not seal without a passphrase', async () => {
    await expect(sealBackup(PAYLOAD, '', 'pingolin-note')).rejects.toThrow();
  });
});

describe('resisting a tampered container', () => {
  it('fails when the KDF work factor is edited down', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    // Not the AAD doing this one: the parameters are inputs to the KDF, so a
    // changed value derives a different key and the file simply stops opening.
    // Worth pinning anyway — it is the property that makes a downgrade attempt
    // pointless rather than merely detectable.
    const tampered = { ...sealed, kdf: { ...sealed.kdf, memoryKib: 8192, iterations: 1 } };
    const opened = await openBackup(tampered, PASS);
    expect(opened.ok).toBe(false);
  }, 60000);

  it('fails when the product label is swapped', async () => {
    // THIS is what the associated data buys. `product` never reaches the KDF,
    // so without the AAD it is freely editable on a file that still decrypts —
    // and a Track backup relabelled as a Note one sails into the wrong parser.
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    const opened = await openBackup({ ...sealed, product: 'pingolin-track' }, PASS);
    expect(opened.ok).toBe(false);
  }, 60000);

  it('fails when the ciphertext is edited', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    const bytes = sealed.ciphertext;
    const flipped = bytes.slice(0, 8) + (bytes[8] === 'A' ? 'B' : 'A') + bytes.slice(9);
    const opened = await openBackup({ ...sealed, ciphertext: flipped }, PASS);
    expect(opened.ok).toBe(false);
  }, 30000);

  it('refuses absurd KDF parameters BEFORE doing the work', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    // A hostile file asking for 8 GiB of Argon2 memory would hang or crash the
    // tab long before the tag check could reject it, so the range check has to
    // come first.
    const huge = { ...sealed, kdf: { ...sealed.kdf, memoryKib: 8_388_608 } };
    const started = Date.now();
    const opened = await openBackup(huge, PASS);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error).toMatch(/outside the supported range/i);
    expect(Date.now() - started).toBeLessThan(1000); // rejected, not attempted
  }, 30000);

  it('refuses a container from a future format version', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    const opened = await openBackup({ ...sealed, formatVersion: 99 }, PASS);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error).toMatch(/newer version/i);
  }, 30000);

  it('refuses an unknown cipher or KDF', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    expect((await openBackup({ ...sealed, cipher: 'rot13' }, PASS)).ok).toBe(false);
    expect((await openBackup({ ...sealed, kdf: { ...sealed.kdf, algorithm: 'md5' } }, PASS)).ok).toBe(false);
  }, 30000);
});

describe('telling a sealed backup from a plain one', () => {
  it('recognises a container', async () => {
    const sealed = await sealBackup(PAYLOAD, PASS, 'pingolin-note');
    expect(isEncryptedContainer(sealed)).toBe(true);
  }, 30000);

  it('does not mistake a plain backup for one', () => {
    // Both are JSON objects the user picks from the same file dialog, so the
    // reader has to branch on this rather than on the file extension.
    expect(isEncryptedContainer(PAYLOAD)).toBe(false);
    expect(isEncryptedContainer({ format: CONTAINER_FORMAT })).toBe(false); // no ciphertext
    expect(isEncryptedContainer(null)).toBe(false);
    expect(isEncryptedContainer('a string')).toBe(false);
  });
});
