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
 * The sender side of a recipient's key change.
 *
 * When somebody the owner shares with resets their password, the owner's
 * screen has to say so: otherwise the Share panel lists them as before, new
 * notes in a shared notebook go to a key they no longer hold, and the one
 * error anybody sees tells them to "ask them to re-share". These pin the
 * classification the panel, the badge and the fan-out all read, and the copy
 * that goes with it.
 */

const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));

import { classifyRecipientKey, keyChangedMessage, lookupDirectoryKeys, readRecipientLookup } from './recipientKeys';

const dir = { userId: 'u1', sharingPub: 'aa'.repeat(32), signingPub: 'bb'.repeat(32) };

describe('classifyRecipientKey', () => {
  it('no directory entry: not signed up (or unknown)', () => {
    expect(classifyRecipientKey(null, undefined)).toBe('no-account');
  });

  it('no pin yet: first contact', () => {
    expect(classifyRecipientKey(null, dir)).toBe('first-contact');
  });

  it('pin matches, case-insensitively: matched', () => {
    expect(classifyRecipientKey(
      { sharingPubkeyHex: dir.sharingPub.toUpperCase(), signingPubkeyHex: dir.signingPub }, dir,
    )).toBe('matched');
  });

  it('either key differs: changed', () => {
    expect(classifyRecipientKey({ sharingPubkeyHex: 'cc'.repeat(32), signingPubkeyHex: dir.signingPub }, dir)).toBe('changed');
    expect(classifyRecipientKey({ sharingPubkeyHex: dir.sharingPub, signingPubkeyHex: 'dd'.repeat(32) }, dir)).toBe('changed');
  });
});

describe('keyChangedMessage', () => {
  it('names the usual cause and the fix — never "ask them to re-share", never keys', () => {
    const m = keyChangedMessage('ben@example.test');
    expect(m).toMatch(/ben@example\.test may have reset their password/);
    expect(m).toMatch(/until you confirm/);
    expect(m).not.toMatch(/re-share/);
    expect(m).not.toMatch(/\bkeys?\b|safety number/i);
  });
});

describe('lookupDirectoryKeys', () => {
  beforeEach(() => apiRequest.mockReset());

  it('keeps only full key sets, keyed by lower-cased email', async () => {
    apiRequest.mockResolvedValue({
      success: true,
      data: {
        users: [
          { email: 'Ben@Example.test', user_id: 'u1', sharing_public_key: 'aa', signing_public_key: 'bb' },
          { email: 'new@example.test', user_id: null, sharing_public_key: null, signing_public_key: null },
          { email: 'half@example.test', user_id: 'u3', sharing_public_key: 'cc', signing_public_key: null },
        ],
      },
    });
    const m = await lookupDirectoryKeys(['Ben@Example.test', 'new@example.test', 'half@example.test']);
    expect([...m!.keys()]).toEqual(['ben@example.test']);
    expect(m!.get('ben@example.test')).toEqual({ userId: 'u1', sharingPub: 'aa', signingPub: 'bb' });
  });

  it('is null — "could not check" — when the lookup fails, never an empty answer', async () => {
    apiRequest.mockResolvedValue({ success: false, status: 502 });
    expect(await lookupDirectoryKeys(['a@example.test'])).toBeNull();
  });

  it('batches at the server cap of 100 addresses', async () => {
    apiRequest.mockResolvedValue({ success: true, data: { users: [] } });
    const emails = Array.from({ length: 250 }, (_, i) => `p${i}@example.test`);
    await lookupDirectoryKeys(emails);
    const sizes = apiRequest.mock.calls.map(c => (c[1] as { body: { emails: string[] } }).body.emails.length);
    expect(sizes).toEqual([100, 100, 50]);
  });
});

/**
 * A key lookup that FAILED is not an empty answer, and an empty answer is not
 * an address with no account. Read that way, a share to somebody with an
 * account would go out with nothing sealed; for a notebook with no
 * invitation, and with the person on the standing list, so every later note
 * would reach them readable and with nothing to answer.
 */
describe('reading the Share panel\'s key lookup', () => {
  const ANN = { email: 'ann@example.test', user_id: 'u-ann', sharing_public_key: 'aa', signing_public_key: 'bb' };
  const ME = { email: 'me@example.test', user_id: 'u-me', sharing_public_key: 'cc', signing_public_key: 'dd' };
  const answer = (users: unknown) => ({ success: true as const, data: { users } as never });

  it('NO ANSWER is not "no account": a lookup that failed says nothing', () => {
    for (const failed of [
      { success: false as const, error: 'Auth service unreachable', status: 502 },
      { success: false as const, error: 'Too many requests', status: 429 },
      { success: false as const, error: 'Request timed out' },
    ]) {
      expect(readRecipientLookup(failed, 'ann@example.test', 'me@example.test')).toEqual({ answered: false });
    }
  });

  it('nor does an answer in no known shape', () => {
    for (const users of [undefined, null, 'none', {}, 7]) {
      expect(readRecipientLookup(answer(users), 'ann@example.test', 'me@example.test')).toEqual({ answered: false });
    }
    expect(readRecipientLookup({ success: true, data: null as never }, 'ann@example.test', null)).toEqual({ answered: false });
  });

  it('an account: its keys, and this account\'s own published signing key from the same answer', () => {
    expect(readRecipientLookup(answer([ANN, ME]), 'ann@example.test', 'me@example.test')).toEqual({
      answered: true, publicKey: 'aa', userId: 'u-ann', signingPublicKey: 'bb', myPublishedSigning: 'dd',
    });
  });

  it('whatever the order of the answer, and however the address is capitalised', () => {
    expect(readRecipientLookup(answer([ME, ANN]), 'Ann@Example.Test', 'ME@example.test')).toEqual({
      answered: true, publicKey: 'aa', userId: 'u-ann', signingPublicKey: 'bb', myPublishedSigning: 'dd',
    });
  });

  it('"no account" is what an ANSWER says: an entry with no key', () => {
    const nobody = { email: 'new@example.test', user_id: null, sharing_public_key: null, signing_public_key: null };
    expect(readRecipientLookup(answer([nobody, ME]), 'new@example.test', 'me@example.test')).toEqual({
      answered: true, publicKey: null, userId: null, signingPublicKey: null, myPublishedSigning: 'dd',
    });
  });

  it('or an answer with no entry for the address at all', () => {
    expect(readRecipientLookup(answer([]), 'new@example.test', null)).toEqual({
      answered: true, publicKey: null, userId: null, signingPublicKey: null, myPublishedSigning: null,
    });
  });

  it('an address the server spells back differently is taken by position', () => {
    const respelled = { ...ANN, email: 'ann+x@example.test' };
    expect(readRecipientLookup(answer([respelled, ME]), 'ann@example.test', 'me@example.test')).toMatchObject({
      answered: true, publicKey: 'aa', userId: 'u-ann',
    });
  });

  /** Sealed to our own key under their address, a share would look sent and open for nobody. */
  it('but never onto this account\'s OWN entry', () => {
    expect(readRecipientLookup(answer([ME]), 'ann@example.test', 'me@example.test')).toEqual({
      answered: true, publicKey: null, userId: null, signingPublicKey: null, myPublishedSigning: 'dd',
    });
  });

  it('sharing with one\'s own address is that entry, by its address', () => {
    expect(readRecipientLookup(answer([ME]), 'me@example.test', 'me@example.test')).toMatchObject({
      answered: true, publicKey: 'cc', userId: 'u-me',
    });
  });

  it('with no address of our own, nothing is said about our published key', () => {
    expect(readRecipientLookup(answer([ANN]), 'ann@example.test', null)).toMatchObject({ answered: true, publicKey: 'aa', myPublishedSigning: null });
  });
});

/**
 * Our own entry is told apart by more than its ADDRESS: one the server spelt
 * back differently would not be "mine", and the fallback (the first entry,
 * for a server that spells the recipient's address differently) would take it
 * for the recipient's. A share sealed to our own key under their address
 * looks shared and opens for nobody.
 */
describe('our own entry in the directory\'s answer', () => {
  const ME = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const mine = { email: 'Me+alias@Example.test', user_id: ME.toUpperCase(), sharing_public_key: 'aa'.repeat(32), signing_public_key: 'bb'.repeat(32) };
  const theirs = { email: 'ben@example.test', user_id: 'bbbbbbbb-0000-4000-8000-00000000000b', sharing_public_key: 'cc'.repeat(32), signing_public_key: 'dd'.repeat(32) };
  const answer = (users: unknown[]) => ({ success: true as const, data: { users: users as never[] } });

  it('is never taken for the recipient\'s, even spelt as another address: it is known by its account too', () => {
    const looked = readRecipientLookup(answer([mine]), 'ben@example.test', 'me@example.test', ME);
    expect(looked).toMatchObject({ answered: true, publicKey: null, userId: null });
  });

  it('the control: without the account it WAS taken (which is why the panel names it)', () => {
    const looked = readRecipientLookup(answer([mine]), 'ben@example.test', 'me@example.test');
    expect(looked).toMatchObject({ answered: true, publicKey: 'aa'.repeat(32) });
  });

  it('does not stand in the way of the recipient\'s own entry, first or second', () => {
    for (const users of [[theirs, mine], [mine, theirs]]) {
      expect(readRecipientLookup(answer(users), 'ben@example.test', 'me@example.test', ME)).toMatchObject({
        answered: true, publicKey: 'cc'.repeat(32), userId: theirs.user_id,
      });
    }
  });

  it('a recipient the server spells differently is still found by position, when it is not us', () => {
    const spelt = { ...theirs, email: 'Ben@Example.TEST ' };
    expect(readRecipientLookup(answer([spelt]), 'ben@example.test', 'me@example.test', ME)).toMatchObject({
      answered: true, publicKey: 'cc'.repeat(32),
    });
  });
});
