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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The page's half of kept trust: in a shell, the pins, floors and owners go
 * to the app after every change, and come back at the same account's next
 * sign-in, folded in so they only ever add.
 *
 * WHY THESE EXIST
 *   The shells' sign-out wipe deletes every website store. Without this, the
 *   pins, floors and owners kept across a sign-out would go with it, so every
 *   sign-in in a shell would start as a first contact for everyone: a server
 *   could then pass off any key, any old wrap, any owner.
 */

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

const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const B = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const SENDER = 'cccccccc-0000-4000-8000-0000000000cc';
const ITEM = '11111111-1111-4111-8111-111111111111';
const ITEM2 = '22222222-2222-4222-8222-222222222222';
const ITEM3 = '33333333-3333-4333-8333-333333333333';
/** An item id with letters: its upper-case spelling is another spelling (an all-digit one is its own). */
const LETTERED = 'abcdef12-abcd-4abc-8abc-abcdefabcdef';
const OWNER = 'dddddddd-0000-4000-8000-0000000000dd';
const OTHER_OWNER = 'eeeeeeee-0000-4000-8000-0000000000ee';
const pin = (k: string) => ({ sharingPubkeyHex: k.repeat(64), signingPubkeyHex: k.repeat(64), firstPinnedAt: 10, lastVerifiedAt: 20 });

const PINS = 'pingolin_note_pinned_keys';
const FLOORS = 'pingolin_note_gen_floor';
const OWNERS = 'pingolin_note_item_owner';

type Native = (request: Record<string, any>) => unknown;
let sent: Record<string, any>[];
let store: Storage;
let kt: typeof import('./keptTrust');
let setTabAccount: (id: string | null) => void;

/** The iOS shell: the key bridge, whose ops reply or reject. */
const iosShell = (native: Native) => ({
  __pingolinKeyBridge: { version: 1, signing: false },
  webkit: { messageHandlers: { pingolinKeys: { postMessage: async (m: Record<string, any>) => { sent.push(m); return native(m); } } } },
});

/** The Android shell: pingolinTrust, whose replies come back as messages carrying the request's id. */
function androidShell(native: Native) {
  let listener: ((e: { data: unknown }) => void) | null = null;
  const pingolinTrust = {
    postMessage(s: string) {
      const request = JSON.parse(s);
      sent.push(request);
      void Promise.resolve().then(async () => {
        try {
          const reply = await native(request);
          if (reply !== undefined) listener?.({ data: JSON.stringify({ ...(reply as object), id: request.id }) });
        } catch { /* no reply */ }
      });
    },
    addEventListener(_type: string, fn: (e: { data: unknown }) => void) { listener = fn; },
  };
  return { window: { pingolinTrust }, deliver: (data: string) => listener?.({ data }) };
}

async function load(win: object) {
  sent = [];
  store = memoryStorage();
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('window', win);
  vi.resetModules();
  ({ setTabAccount } = await import('./account'));
  kt = await import('./keptTrust');
  setTabAccount(null);
  setTabAccount(A);
}

const put = (base: string, account: string, value: unknown) => store.setItem(`${base}.${account}`, JSON.stringify(value));
const held = (base: string, account = A) => {
  const raw = store.getItem(`${base}.${account}`);
  return raw === null ? null : JSON.parse(raw);
};
const keeps = () => sent.filter(m => m.op === 'keepTrust');
const copy = (over: Record<string, unknown> = {}) => ({
  v: 1, account: A, state: 'copy', pins: null, floors: null, owners: null, ...over,
});
const settle = () => new Promise(r => setTimeout(r, 20));

beforeEach(async () => {
  // Let the last test's keeps go first: its module's timers would send through this test's shell.
  await new Promise(r => setTimeout(r, 30));
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the adopt', () => {
  it("folds the app's copy in for the confirmed account, and asks only for it", async () => {
    await load(iosShell(() => copy({
      pins: JSON.stringify({ [SENDER]: pin('a') }),
      floors: JSON.stringify({ [ITEM]: 3 }),
      owners: JSON.stringify({ [ITEM]: OWNER }),
    })));

    await kt.adoptKeptTrust(A);

    expect(sent[0]).toEqual({ op: 'keptTrust', v: 1, account: A });
    expect(held(PINS)[SENDER].sharingPubkeyHex).toBe('a'.repeat(64));
    expect(held(FLOORS)).toEqual({ [ITEM]: 3 });
    expect(held(OWNERS)).toEqual({ [ITEM]: OWNER });
  });

  it("makes a conflict of a kept pin with other keys than the page's, never the kept key", async () => {
    await load(iosShell(() => copy({ pins: JSON.stringify({ [SENDER]: pin('b') }) })));
    put(PINS, A, { [SENDER]: pin('a') });

    await kt.adoptKeptTrust(A);

    expect(held(PINS)[SENDER].conflict).toBe(true);
    expect(held(PINS)[SENDER].sharingPubkeyHex).toBe('0'.repeat(64));
  });

  it('keeps the highest floor of any spelling, and drops a key that is not an item id', async () => {
    await load(iosShell(() => copy({ floors: JSON.stringify({ [LETTERED]: 3, [LETTERED.toUpperCase()]: 7, 'not-an-id': 9 }) })));
    put(FLOORS, A, { [LETTERED]: 5, [ITEM2]: 2 });

    await kt.adoptKeptTrust(A);

    expect(held(FLOORS)).toEqual({ [LETTERED]: 7, [ITEM2]: 2 });
  });

  it('never replaces an owner: a kept owner that differs, or a kept conflict, makes a conflict', async () => {
    await load(iosShell(() => copy({ owners: JSON.stringify({ [ITEM]: OTHER_OWNER, [ITEM2]: 'conflict', [ITEM3]: OWNER }) })));
    put(OWNERS, A, { [ITEM]: OWNER, [ITEM2]: OWNER });

    await kt.adoptKeptTrust(A);

    expect(held(OWNERS)).toEqual({ [ITEM]: 'conflict', [ITEM2]: 'conflict', [ITEM3]: OWNER });
  });

  it("leaves the page's own store as it is where the copy has none", async () => {
    await load(iosShell(() => copy({ floors: JSON.stringify({ [ITEM]: 3 }) })));
    store.setItem(`${OWNERS}.${A}`, `{"${LETTERED.toUpperCase()}":"${OWNER}"}`);

    await kt.adoptKeptTrust(A);

    expect(store.getItem(`${OWNERS}.${A}`)).toBe(`{"${LETTERED.toUpperCase()}":"${OWNER}"}`);
  });

  it('ignores a reply naming another account: nothing folded, and no keep that session', async () => {
    await load(iosShell(() => copy({ account: B, floors: JSON.stringify({ [ITEM]: 3 }) })));

    await kt.adoptKeptTrust(A);
    kt.scheduleKeep();
    await settle();

    expect(held(FLOORS)).toBeNull();
    expect(keeps()).toEqual([]);
  });

  it("lets keeps go after 'none': one follows the adopt, with this account's blobs", async () => {
    await load(iosShell(m => (m.op === 'keepTrust' ? { v: 1, state: 'kept' } : { v: 1, account: A, state: 'none' })));
    put(PINS, A, { [SENDER]: pin('a') });

    await kt.adoptKeptTrust(A);
    await vi.waitFor(() => expect(keeps()).toHaveLength(1));

    expect(keeps()[0]).toEqual({
      op: 'keepTrust', v: 1, account: A,
      pins: JSON.stringify({ [SENDER]: pin('a') }), floors: null, owners: null,
    });
  });

  it.each([
    ['the app says its store is unreadable', () => ({ v: 1, state: 'unreadable' })],
    ['the app refuses', () => { throw new Error('unknown op'); }],
    ['the copy does not parse', () => copy({ pins: '{not json', floors: JSON.stringify({ [ITEM]: 3 }) })],
    ['the reply is not this contract', () => ({ v: 2, account: A, state: 'none' })],
  ])('sends no keep that session when %s, and folds nothing', async (_why, native) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await load(iosShell(m => (m.op === 'keepTrust' ? { v: 1, state: 'kept' } : native())));

    await kt.adoptKeptTrust(A);
    kt.scheduleKeep();
    await settle();

    expect(held(FLOORS)).toBeNull();
    expect(keeps()).toEqual([]);
    if (_why === 'the copy does not parse') {
      expect(error.mock.calls.some(c => String(c[0]).includes('could not be read'))).toBe(true);
    }
  });

  it("does not fold into the page's own store when that doesn't parse, and sends no keep", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await load(iosShell(m => (m.op === 'keepTrust' ? { v: 1, state: 'kept' } : copy({ floors: JSON.stringify({ [ITEM]: 3 }) }))));
    store.setItem(`${FLOORS}.${A}`, '{broken');

    await kt.adoptKeptTrust(A);
    kt.scheduleKeep();
    await settle();

    expect(store.getItem(`${FLOORS}.${A}`)).toBe('{broken');
    expect(keeps()).toEqual([]);
  });

  it('ignores an iOS reply that comes after the bound: nothing folded, no keeps', async () => {
    vi.useFakeTimers();
    let answer!: (r: unknown) => void;
    await load(iosShell(m => (m.op === 'keepTrust'
      ? { v: 1, state: 'kept' }
      : new Promise(r => { answer = r; }))));

    const adopt = kt.adoptKeptTrust(A);
    await vi.advanceTimersByTimeAsync(kt.ANSWER_MS + 1);
    await adopt;
    answer(copy({ floors: JSON.stringify({ [ITEM]: 3 }) }));
    await vi.advanceTimersByTimeAsync(10);
    kt.scheduleKeep();
    await vi.advanceTimersByTimeAsync(10);

    expect(held(FLOORS)).toBeNull();
    expect(keeps()).toEqual([]);
  });

  it('ignores an Android reply that comes after the bound, its id notwithstanding', async () => {
    vi.useFakeTimers();
    const shell = androidShell(() => undefined); // the app answers nothing in time
    await load(shell.window);

    const adopt = kt.adoptKeptTrust(A);
    await vi.advanceTimersByTimeAsync(kt.ANSWER_MS + 1);
    await adopt;
    shell.deliver(JSON.stringify({ ...copy({ floors: JSON.stringify({ [ITEM]: 3 }) }), id: sent[0].id }));
    kt.scheduleKeep();
    await vi.advanceTimersByTimeAsync(10);

    expect(held(FLOORS)).toBeNull();
    expect(keeps()).toEqual([]);
  });

  it('does nothing outside a shell: no message, no keep', async () => {
    await load({});

    await kt.adoptKeptTrust(A);
    kt.scheduleKeep();
    expect(await kt.keepTrustNow()).toBe(false);
    await settle();

    expect(sent).toEqual([]);
  });

  it("lets an earlier account's late answer take nothing from the account confirmed since", async () => {
    let answerA!: (r: unknown) => void;
    await load(iosShell(m => {
      if (m.op === 'keepTrust') return { v: 1, state: 'kept' };
      if (m.account === A) return new Promise(r => { answerA = r; });
      return { v: 1, account: m.account, state: 'none' };
    }));
    const adoptA = kt.adoptKeptTrust(A);
    setTabAccount(B);
    await kt.adoptKeptTrust(B);
    await vi.waitFor(() => expect(keeps()).toHaveLength(1)); // B's own keep

    answerA({ v: 1, account: A, state: 'none' });
    await adoptA;
    put(FLOORS, B, { [ITEM]: 2 });
    kt.scheduleKeep();
    await vi.waitFor(() => expect(keeps()).toHaveLength(2));

    expect(keeps()[1]).toMatchObject({ account: B, floors: JSON.stringify({ [ITEM]: 2 }) });
  });

  it('asks once per account in a document', async () => {
    await load(iosShell(m => (m.op === 'keepTrust' ? { v: 1, state: 'kept' } : { v: 1, account: A, state: 'none' })));

    await kt.adoptKeptTrust(A);
    await kt.adoptKeptTrust(A);

    expect(sent.filter(m => m.op === 'keptTrust')).toHaveLength(1);
  });
});

describe('the keeps', () => {
  async function adopted(win: object) {
    await load(win);
    await kt.adoptKeptTrust(A);
    await vi.waitFor(() => expect(keeps()).toHaveLength(1)); // the keep after the adopt
    sent.length = 0;
  }
  const kept = (m: Record<string, any>) => (m.op === 'keepTrust' ? { v: 1, state: 'kept' } : { v: 1, account: m.account, state: 'none' });

  it('makes one keep of the writes in one task, with the blobs as they are when it goes', async () => {
    await adopted(iosShell(kept));

    put(FLOORS, A, { [ITEM]: 1 });
    kt.scheduleKeep();
    put(OWNERS, A, { [ITEM]: OWNER });
    kt.scheduleKeep();
    put(FLOORS, A, { [ITEM]: 2 });
    kt.scheduleKeep();
    await settle();

    expect(keeps()).toEqual([{
      op: 'keepTrust', v: 1, account: A,
      pins: null, floors: JSON.stringify({ [ITEM]: 2 }), owners: JSON.stringify({ [ITEM]: OWNER }),
    }]);
  });

  it('sends no blob over 1 MB', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await adopted(iosShell(kept));
    store.setItem(`${PINS}.${A}`, 'x'.repeat(kt.MAX_BLOB_BYTES + 1));

    kt.scheduleKeep();
    await settle();

    expect(keeps()).toEqual([]);
  });

  it('reads and names the account signed in when it goes: a switch before the send keeps nothing of the old one', async () => {
    await adopted(iosShell(kept));
    put(FLOORS, A, { [ITEM]: 4 });
    put(FLOORS, B, { [ITEM2]: 9 });

    kt.scheduleKeep();
    setTabAccount(B); // before the coalesced send
    await settle();
    expect(keeps()).toEqual([]); // B's adopt hasn't answered yet

    await kt.adoptKeptTrust(B);
    await vi.waitFor(() => expect(keeps()).toHaveLength(1));
    expect(keeps()[0]).toMatchObject({ account: B, floors: JSON.stringify({ [ITEM2]: 9 }) });
    expect(keeps().some(m => m.account === A || m.floors === JSON.stringify({ [ITEM]: 4 }))).toBe(false);
  });

  it('keepTrustNow (the shells\' last keep) sends at once: true when kept, false when refused', async () => {
    let answer: Record<string, unknown> = { v: 1, state: 'kept' };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await adopted(iosShell(m => (m.op === 'keepTrust' ? answer : { v: 1, account: A, state: 'none' })));

    expect(await kt.keepTrustNow()).toBe(true);
    answer = { v: 1, state: 'refused' };
    expect(await kt.keepTrustNow()).toBe(false);
    expect(keeps()).toHaveLength(2);
  });

  it("matches Android replies by their id: out of order, and a stranger's dropped", async () => {
    const order: ((r: unknown) => void)[] = [];
    const shell = androidShell(m => (m.op === 'keptTrust'
      ? { v: 1, account: A, state: 'none' }
      : new Promise(r => order.push(r))));
    await load(shell.window);
    await kt.adoptKeptTrust(A);
    await vi.waitFor(() => expect(order).toHaveLength(1)); // the keep after the adopt
    order.shift()!({ v: 1, state: 'kept' });

    const first = kt.keepTrustNow();
    const second = kt.keepTrustNow();
    await vi.waitFor(() => expect(order).toHaveLength(2));
    shell.deliver(JSON.stringify({ v: 1, state: 'refused', id: 999 })); // nobody asked: never the first's answer
    order[1]({ v: 1, state: 'refused' });
    order[0]({ v: 1, state: 'kept' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await first).toBe(true);
    expect(await second).toBe(false);
  });
});

describe('every write of a kept blob is followed by a keep (read from the source: the writers are deep in their stores)', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

  it('a pin write', () => {
    expect(src('lib/crypto.ts')).toMatch(
      /localStorage\.setItem\(pinStorageKey\(\), JSON\.stringify\(obj\)\);\n(\s*\/\/.*\n)*\s*scheduleKeep\(\);/);
  });

  it('a floor bump and a binding', () => {
    const inbox = src('stores/sharesInbox.ts');
    expect(inbox).toMatch(/scopedSetItem\(GEN_FLOOR_KEY, JSON\.stringify\(floors\)\);\n\s*scheduleKeep\(\);/);
    expect(inbox).toMatch(/scopedSetItem\(ITEM_OWNER_KEY, JSON\.stringify\(owners\)\);\n\s*scheduleKeep\(\);/);
  });
});

describe("the shells' last keep is offered to them (read from the source: the repo has no DOM tests)", () => {
  it('App installs window.__pingolinKeepTrustNow, and takes it away with the others', () => {
    const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
    expect(app).toMatch(/w\.__pingolinKeepTrustNow = keepTrustNow;/);
    expect(app).toMatch(/delete w\.__pingolinKeepTrustNow;/);
  });
});
