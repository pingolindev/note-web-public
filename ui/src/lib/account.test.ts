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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The tab's account: one canonical spelling for every id, the header on
 * every same-origin request, a stop (never a retry) on the note server's
 * 409 `account_mismatch`, and the per-account localStorage stores.
 */

const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  } as Storage;
}

let account: typeof import('./account');
let local: Storage;

beforeEach(async () => {
  local = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.resetModules();
  account = await import('./account');
});

afterEach(() => vi.unstubAllGlobals());

describe('canonicalAccountId', () => {
  it('writes every spelling of a UUID as lower-case hyphenated', () => {
    expect(account.canonicalAccountId(A)).toBe(A);
    expect(account.canonicalAccountId(A.toUpperCase())).toBe(A);
    expect(account.canonicalAccountId(A.replace(/-/g, ''))).toBe(A);
    expect(account.canonicalAccountId(A.replace(/-/g, '').toUpperCase())).toBe(A);
  });

  it('refuses anything that is not an account id', () => {
    for (const bad of [`{${A}}`, `urn:uuid:${A}`, ` ${A}`, `${A} `, A.slice(1), `${A}0`, 'me', '', 42, null, undefined, {}]) {
      expect(() => account.canonicalAccountId(bad)).toThrow();
      expect(account.tryCanonicalAccountId(bad)).toBeNull();
    }
  });
});

describe('accountFetch: the header, and the stop', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const respond = (status: number, body: unknown, contentType = 'application/json') =>
    fetchMock.mockResolvedValueOnce(new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'content-type': contentType } },
    ));

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  const sentHeader = (call = 0) =>
    new Headers((fetchMock.mock.calls[call][1] as RequestInit).headers).get(account.ACCOUNT_HEADER);

  it('names the confirmed account, canonically, on every request', async () => {
    account.setTabAccount(A.toUpperCase());
    respond(200, { ok: true });
    await account.accountFetch('/api/v1/items', { headers: { 'Content-Type': 'application/json' } });
    expect(sentHeader()).toBe(A);
    // The caller's own headers are kept.
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('content-type')).toBe('application/json');
  });

  it('sends no header before an account is confirmed', async () => {
    respond(200, { ok: true });
    await account.accountFetch('/api/v1/auth/me');
    expect(sentHeader()).toBeNull();
  });

  it("a 409 account_mismatch stops the tab: handler once, a throw, and no request after it", async () => {
    const onStop = vi.fn();
    account.onAccountMismatch(onStop);
    account.setTabAccount(A);
    respond(409, { success: false, error_code: 'account_mismatch' });
    await expect(account.accountFetch('/api/v1/items')).rejects.toBeInstanceOf(account.AccountMismatchError);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(account.isStopped()).toBe(true);
    expect(account.getTabAccount()).toBeNull();

    await expect(account.accountFetch('/api/v1/items')).rejects.toBeInstanceOf(account.AccountMismatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    account.reportAccountMismatch();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('any other 409 is an ordinary answer: a version conflict is not a stop', async () => {
    account.setTabAccount(A);
    respond(409, { success: false, error_code: 'version_conflict' });
    expect((await account.accountFetch('/api/v1/items/x')).status).toBe(409);
    respond(409, '<html>conflict</html>', 'text/html');
    expect((await account.accountFetch('/api/v1/items/x')).status).toBe(409);
    expect(account.isStopped()).toBe(false);
  });

  it('isAccountStop reads the stop off an apiRequest result', () => {
    expect(account.isAccountStop({ success: false, error_code: 'account_mismatch' })).toBe(true);
    expect(account.isAccountStop({ success: false, error_code: 'version_conflict' })).toBe(false);
    expect(account.isAccountStop({ success: true, error_code: 'account_mismatch' })).toBe(false);
  });
});

describe('onTabAccountChange', () => {
  it('runs on a change of account, not on the same one again', () => {
    const seen: (string | null)[] = [];
    account.onTabAccountChange((id) => seen.push(id));
    account.setTabAccount(A);
    account.setTabAccount(A.toUpperCase());
    account.setTabAccount(B);
    account.setTabAccount(null);
    expect(seen).toEqual([A, B, null]);
  });
});

describe('the per-account stores', () => {
  const STORE = 'pingolin_note_inbox_last_seen';

  it('read as empty and drop writes before an account is confirmed', () => {
    local.setItem(STORE, 'legacy');
    expect(account.scopedGetItem(STORE)).toBeNull();
    account.scopedSetItem(STORE, 'x');
    expect([...Array(local.length)].map((_, i) => local.key(i))).toEqual([STORE]);
  });

  it("keep each account's value under its own canonical id", () => {
    account.setTabAccount(A.toUpperCase());
    account.scopedSetItem(STORE, 'a');
    account.setTabAccount(B);
    expect(account.scopedGetItem(STORE)).toBeNull();
    account.scopedSetItem(STORE, 'b');
    expect(local.getItem(`${STORE}.${A}`)).toBe('a');
    expect(local.getItem(`${STORE}.${B}`)).toBe('b');
    account.scopedRemoveItem(STORE);
    expect(local.getItem(`${STORE}.${B}`)).toBeNull();
    expect(local.getItem(`${STORE}.${A}`)).toBe('a');
  });

  it("adopt an older build's stores only for the browser's recorded owner", () => {
    local.setItem('pingolin_note_metadata', 'meta');
    local.setItem(STORE, 'old-value');
    local.setItem(`${STORE}.${A}`, 'newer');
    account.adoptLegacyStores(A, true);
    expect(local.getItem(`pingolin_note_metadata.${A}`)).toBe('meta');
    // Never over a value the account already has.
    expect(local.getItem(`${STORE}.${A}`)).toBe('newer');
    expect(local.getItem('pingolin_note_metadata')).toBeNull();
    expect(local.getItem(STORE)).toBeNull();
  });

  it('delete them unread when the owner is not known', () => {
    local.setItem('pingolin_note_metadata', 'meta');
    local.setItem('pingolin_note_retired_keys', '{}');
    account.adoptLegacyStores(A, false);
    expect(local.length).toBe(0);
  });

  /** Kept trust: every account's floors and item owners, like its pins. */
  const KEPT = ['pingolin_note_gen_floor', 'pingolin_note_item_owner'];

  it("keep only the signed-in account's stores when a different account signs in, and every account's kept trust", () => {
    for (const base of account.ACCOUNT_SCOPED_STORES) {
      local.setItem(`${base}.${A}`, 'a');
      local.setItem(`${base}.${B}`, 'b');
      local.setItem(base, 'legacy');
      local.setItem(`${base}.not-an-id`, 'junk');
    }
    local.setItem('pingolin_note_owner', A);
    local.setItem(`pingolin_note_pinned_keys.${B}`, '{}');
    account.keepOnlyAccountStores(A);
    const left = [...Array(local.length)].map((_, i) => local.key(i)).sort();
    expect(left).toEqual([
      ...account.ACCOUNT_SCOPED_STORES.map(base => `${base}.${A}`),
      ...KEPT.map(base => `${base}.${B}`),
      'pingolin_note_owner',
      `pingolin_note_pinned_keys.${B}`,
    ].sort());
  });

  it("a wipe clears every account's stores and the older builds', but no account's kept trust", () => {
    for (const base of account.ACCOUNT_SCOPED_STORES) {
      local.setItem(`${base}.${A}`, 'a');
      local.setItem(`${base}.${B}`, 'b');
      local.setItem(base, 'legacy');
    }
    local.setItem(`pingolin_note_pinned_keys.${A}`, '{}');
    local.setItem('unrelated', 'x');
    account.clearAllAccountStores();
    const left = [...Array(local.length)].map((_, i) => local.key(i)).sort();
    expect(left).toEqual([
      ...KEPT.flatMap(base => [`${base}.${A}`, `${base}.${B}`]),
      `pingolin_note_pinned_keys.${A}`,
      'unrelated',
    ].sort());
  });

  it("an erasure removes that account's stores, its kept trust too, and nobody else's", () => {
    for (const base of account.ACCOUNT_SCOPED_STORES) {
      local.setItem(`${base}.${A}`, 'a');
      local.setItem(`${base}.${A.toUpperCase()}`, 'a2');
      local.setItem(`${base}.${B}`, 'b');
    }
    account.forgetAccountStores(A);
    const left = [...Array(local.length)].map((_, i) => local.key(i)).sort();
    expect(left).toEqual(account.ACCOUNT_SCOPED_STORES.map(base => `${base}.${B}`).sort());
  });
});
