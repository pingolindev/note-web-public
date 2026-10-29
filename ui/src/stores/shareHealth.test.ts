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
 * Who is not receiving a shared notebook's new notes.
 *
 * A note that fails to reach a standing recipient is recorded here, not only
 * logged to the console; the badge and the Share panel read this store.
 */

const pins = new Map<string, { sharingPubkeyHex: string; signingPubkeyHex: string }>();
vi.mock('../lib/crypto', () => ({
  getPinnedUserKeys: (id: string) => pins.get(id) ?? null,
}));
const lookupDirectoryKeys = vi.fn();
vi.mock('../lib/recipientKeys', async () => {
  const real = await vi.importActual<typeof import('../lib/recipientKeys')>('../lib/recipientKeys');
  return { ...real, lookupDirectoryKeys: (...a: unknown[]) => lookupDirectoryKeys(...a) };
});
const standing: Record<string, { email: string; userId?: string | null; publicKey?: string | null }[]> = {};
vi.mock('./notebooks', () => ({
  notebooksStore: {
    notebooks: () => Object.keys(standing).map(id => ({ id, name: id, noteCount: 0 })),
    getNotebookShares: (id: string) => standing[id] ?? [],
  },
}));

let store: typeof import('./shareHealth').shareHealthStore;

const OLD = { sharingPubkeyHex: 'aa'.repeat(32), signingPubkeyHex: 'bb'.repeat(32) };
const NEW = { userId: 'ben', sharingPub: 'cc'.repeat(32), signingPub: 'dd'.repeat(32) };

beforeEach(async () => {
  vi.resetModules();
  pins.clear();
  lookupDirectoryKeys.mockReset();
  for (const k of Object.keys(standing)) delete standing[k];
  ({ shareHealthStore: store } = await import('./shareHealth'));
});

describe('record / clear', () => {
  it('records a failed share under its reason and clears it on the next success', () => {
    store.record('nb', 'Ben@Example.test', { ok: false, reason: 'key-changed' });
    expect(store.notReceiving('nb')).toEqual([{ email: 'ben@example.test', reason: 'key-changed' }]);
    store.record('nb', 'ben@example.test', { ok: true });
    expect(store.notReceiving('nb')).toEqual([]);
  });

  it('maps a 402 or any other failure to "failed", and a signing refusal to "cannot-sign"', () => {
    store.record('nb', 'a@example.test', { ok: false, reason: 'upgrade' });
    store.record('nb', 'b@example.test', { ok: false, reason: 'cannot-sign' });
    expect(store.notReceiving('nb')).toEqual([
      { email: 'a@example.test', reason: 'failed' },
      { email: 'b@example.test', reason: 'cannot-sign' },
    ]);
  });
});

describe('refresh', () => {
  it('flags a standing recipient whose directory key differs from the pin', async () => {
    standing.nb = [{ email: 'ben@example.test', userId: 'ben' }];
    pins.set('ben', OLD);
    lookupDirectoryKeys.mockResolvedValue(new Map([['ben@example.test', NEW]]));
    await store.refresh();
    expect(store.notReceiving('nb')).toEqual([{ email: 'ben@example.test', reason: 'key-changed' }]);
  });

  it('clears the flag once the pin matches again (approved here or elsewhere)', async () => {
    standing.nb = [{ email: 'ben@example.test', userId: 'ben' }];
    store.record('nb', 'ben@example.test', { ok: false, reason: 'key-changed' });
    pins.set('ben', { sharingPubkeyHex: NEW.sharingPub, signingPubkeyHex: NEW.signingPub });
    lookupDirectoryKeys.mockResolvedValue(new Map([['ben@example.test', NEW]]));
    await store.refresh();
    expect(store.notReceiving('nb')).toEqual([]);
  });

  it('changes nothing when the lookup fails — "could not check" is not "fine"', async () => {
    standing.nb = [{ email: 'ben@example.test', userId: 'ben' }];
    store.record('nb', 'ben@example.test', { ok: false, reason: 'key-changed' });
    lookupDirectoryKeys.mockResolvedValue(null);
    await store.refresh();
    expect(store.notReceiving('nb')).toEqual([{ email: 'ben@example.test', reason: 'key-changed' }]);
  });

  it('does not flag first contact (no pin yet)', async () => {
    standing.nb = [{ email: 'ben@example.test', userId: 'ben' }];
    lookupDirectoryKeys.mockResolvedValue(new Map([['ben@example.test', NEW]]));
    await store.refresh();
    expect(store.notReceiving('nb')).toEqual([]);
  });
});

describe('stale-key: approved elsewhere, not yet re-sealed here', () => {
  it('flags a notebook whose standing entry still holds the old key while the pin already trusts the new one', async () => {
    standing.a = [{ email: 'ben@example.test', userId: 'ben', publicKey: NEW.sharingPub } as never];
    standing.b = [{ email: 'ben@example.test', userId: 'ben', publicKey: 'aa'.repeat(32) } as never];
    pins.set('ben', { sharingPubkeyHex: NEW.sharingPub, signingPubkeyHex: NEW.signingPub });
    lookupDirectoryKeys.mockResolvedValue(new Map([['ben@example.test', NEW]]));
    await store.refresh();
    expect(store.notReceiving('a')).toEqual([]);
    expect(store.notReceiving('b')).toEqual([{ email: 'ben@example.test', reason: 'stale-key' }]);
  });

  it('is not cleared by a new note reaching them — only by re-sealing', async () => {
    store.record('b', 'ben@example.test', { ok: false, reason: 'failed' });
    standing.b = [{ email: 'ben@example.test', userId: 'ben', publicKey: 'aa'.repeat(32) } as never];
    pins.set('ben', { sharingPubkeyHex: NEW.sharingPub, signingPubkeyHex: NEW.signingPub });
    lookupDirectoryKeys.mockResolvedValue(new Map([['ben@example.test', NEW]]));
    await store.refresh();
    store.record('b', 'ben@example.test', { ok: true });
    expect(store.notReceiving('b')).toEqual([{ email: 'ben@example.test', reason: 'stale-key' }]);
    store.clear('b', 'ben@example.test');
    expect(store.notReceiving('b')).toEqual([]);
  });
});
