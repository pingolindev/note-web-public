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
 * Pins keyed by canonical ids, with no-drop folding of other spellings.
 *
 * A pin blob named by the account id exactly as /auth/me spells it, with its
 * contacts only lower-cased, would let a server that re-spells an id (case,
 * hyphens) start this browser's trust from empty: every contact a first
 * contact again, the TOFU reset the pins exist to prevent. These pin that
 * every spelling finds the same pins, that folding other spellings in keeps
 * every source verbatim and loses nothing, that records which disagree become
 * a conflict no key matches until the person approves one, and that an id that
 * is not an account id is never "not pinned".
 */

const ME = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const BOB = 'bbbbbbbb-0000-4000-8000-0000000000bb';
const CAROL = 'cccccccc-0000-4000-8000-0000000000cc';
const BLOB = 'pingolin_note_pinned_keys';

const hex = (c: string) => c.repeat(64);
const pin = (sharing: string, signing: string, first: number, last: number, approved?: number) => ({
  sharingPubkeyHex: hex(sharing),
  signingPubkeyHex: hex(signing),
  firstPinnedAt: first,
  lastVerifiedAt: last,
  ...(approved ? { userApprovedChangeAt: approved } : {}),
});

function memoryStorage(opts: { failWritesTo?: string; dropWritesTo?: string } = {}): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => {
      if (k === opts.failWritesTo) throw new DOMException('quota', 'QuotaExceededError');
      if (k === opts.dropWritesTo) return; // a write that "succeeds" and stores nothing
      m.set(k, String(v));
    },
  } as Storage;
}

describe('foldPins', () => {
  let fold: typeof import('./pinMerge');
  beforeEach(async () => { fold = await import('./pinMerge'); });

  it('merges two spellings of one contact with the same keys: earliest pin, latest check and approval', () => {
    const out = fold.foldPins([
      { [BOB]: pin('a', 'b', 200, 300, 250) },
      { [BOB.toUpperCase()]: pin('A', 'B', 100, 400) },
    ]);
    expect(out.pins).toEqual({ [BOB]: pin('a', 'b', 100, 400, 250) });
    expect(out.conflicts).toBe(0);
  });

  it('marks a conflict when the keys differ: all-zero keys, the earliest pin, never either record', () => {
    const out = fold.foldPins([
      { [BOB]: pin('a', 'b', 200, 300) },
      { [BOB.replace(/-/g, '')]: pin('c', 'b', 100, 250) },
    ]);
    expect(out.pins[BOB]).toEqual({
      sharingPubkeyHex: fold.CONFLICT_KEY_HEX, signingPubkeyHex: fold.CONFLICT_KEY_HEX,
      firstPinnedAt: 100, lastVerifiedAt: 300, conflict: true,
    });
    expect(out.conflicts).toBe(1);
  });

  it('keeps a conflict a conflict, whatever it is folded with', () => {
    const out = fold.foldPins([{ [BOB]: fold.conflictPin(50, 60) }, { [BOB]: pin('a', 'b', 10, 20) }]);
    expect(out.pins[BOB].conflict).toBe(true);
    expect(out.pins[BOB].firstPinnedAt).toBe(10);
    // Two conflicts hold the same (all-zero) keys: still a conflict.
    const twice = fold.foldPins([{ [BOB]: fold.conflictPin(5, 6) }, { [BOB.toUpperCase()]: fold.conflictPin(7, 8) }]);
    expect(twice.pins[BOB].conflict).toBe(true);
    expect(twice.conflicts).toBe(0);
  });

  it('drops what is not a pin or not keyed by an account id, and counts it', () => {
    const out = fold.foldPins([
      { [CAROL]: pin('a', 'b', 1, 1), 'not-an-id': pin('a', 'b', 1, 1), [BOB]: { sharingPubkeyHex: 1 } },
      null, 'junk', [pin('a', 'b', 1, 1)],
    ]);
    expect(Object.keys(out.pins)).toEqual([CAROL]);
    expect(out.dropped).toBe(2);
  });
});

describe('the pin store', () => {
  let crypto: typeof import('./crypto');
  let local: Storage;

  async function load(storage: Storage = memoryStorage()) {
    local = storage;
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.resetModules();
    crypto = await import('./crypto');
    await crypto.initCrypto();
  }

  beforeEach(() => load());
  afterEach(() => vi.unstubAllGlobals());

  it('an upper-cased /me id finds the same blob, and contacts in any spelling the same pin', () => {
    local.setItem(`${BLOB}.${ME}`, JSON.stringify({ [BOB]: pin('a', 'b', 1, 1) }));
    crypto.loadPinnedKeysFromStorage(ME.toUpperCase());
    expect(crypto.getPinnedUserKeys(BOB.toUpperCase())?.sharingPubkeyHex).toBe(hex('a'));
    expect(crypto.pinUserKeys(BOB.replace(/-/g, ''), hex('a'), hex('b')).state).toBe('Matched');
    expect(crypto.allowSealToRecipient(BOB.toUpperCase(), hex('b'), hex('a'))).toBe(true);
  });

  it('refuses an id that is not an account id: never pinned, never a first contact', () => {
    crypto.loadPinnedKeysFromStorage(ME);
    expect(() => crypto.pinUserKeys('someone', hex('a'), hex('b'))).toThrow();
    expect(() => crypto.approveUserKeyChange('someone', hex('a'), hex('b'))).toThrow();
    expect(crypto.getPinnedUserKeys('someone')?.conflict).toBe(true);
    expect(crypto.allowSealToRecipient('someone', hex('b'), hex('a'))).toBe(false);
    expect(local.getItem(`${BLOB}.${ME}`)).toBeNull();
  });

  it('a conflict matches no key and is never a first contact, until the person approves one', () => {
    local.setItem(`${BLOB}.${ME}`, JSON.stringify({
      [BOB]: pin('a', 'b', 1, 1), [BOB.toUpperCase()]: pin('c', 'd', 2, 2),
    }));
    crypto.loadPinnedKeysFromStorage(ME);
    for (const [s, g] of [['a', 'b'], ['c', 'd'], ['0', '0']]) {
      expect(crypto.pinUserKeys(BOB, hex(s), hex(g))).toEqual({ state: 'ChangedBoth', previousPinnedAt: 1 });
      expect(crypto.allowSealToRecipient(BOB, hex(g), hex(s))).toBe(false);
    }
    crypto.approveUserKeyChange(BOB, hex('c'), hex('d'));
    expect(crypto.pinUserKeys(BOB, hex('c'), hex('d')).state).toBe('Matched');
    expect(crypto.getPinnedUserKeys(BOB)?.conflict).toBeUndefined();
  });

  describe('migratePinnedKeys', () => {
    it("folds every spelling of the account's blob into the canonical one, keeping each source verbatim", () => {
      const upper = JSON.stringify({ [BOB]: pin('a', 'b', 100, 200) });
      const bare = JSON.stringify({ [CAROL.toUpperCase()]: pin('c', 'd', 5, 6), [BOB]: pin('A', 'B', 50, 300) });
      local.setItem(`${BLOB}.${ME.toUpperCase()}`, upper);
      local.setItem(`${BLOB}.${ME.replace(/-/g, '')}`, bare);
      local.setItem(`${BLOB}.${BOB}`, JSON.stringify({ [CAROL]: pin('x', 'y', 1, 1) })); // another account's

      crypto.migratePinnedKeys(ME, true);

      expect(JSON.parse(local.getItem(`${BLOB}.${ME}`)!)).toEqual({
        [BOB]: pin('a', 'b', 50, 300),
        [CAROL]: pin('c', 'd', 5, 6),
      });
      const copies = [0, 1, 2].map(n => local.getItem(`${BLOB}.${ME}.premerge.${n}`));
      expect(copies.slice(0, 2).sort()).toEqual([upper, bare].sort());
      expect(copies[2]).toBeNull();
      expect(local.getItem(`${BLOB}.${ME.toUpperCase()}`)).toBeNull();
      expect(local.getItem(`${BLOB}.${ME.replace(/-/g, '')}`)).toBeNull();
      expect(local.getItem(`${BLOB}.${BOB}`)).not.toBeNull();
    });

    it('a second run changes nothing and copies nothing again', () => {
      local.setItem(`${BLOB}.${ME.toUpperCase()}`, JSON.stringify({ [BOB]: pin('a', 'b', 1, 1) }));
      crypto.migratePinnedKeys(ME, true);
      const before = [...Array(local.length)].map((_, i) => [local.key(i), local.getItem(local.key(i)!)]);
      crypto.migratePinnedKeys(ME, true);
      const after = [...Array(local.length)].map((_, i) => [local.key(i), local.getItem(local.key(i)!)]);
      expect(after).toEqual(before);
    });

    it('a clean canonical blob with no other spelling is left exactly as it is', () => {
      const raw = JSON.stringify({ [BOB]: { ...pin('a', 'b', 1, 1), extra: 'kept' } });
      local.setItem(`${BLOB}.${ME}`, raw);
      crypto.migratePinnedKeys(ME, true);
      expect(local.getItem(`${BLOB}.${ME}`)).toBe(raw);
      expect(local.length).toBe(1);
    });

    it('a canonical blob with other spellings inside is rewritten canonically, its original kept', () => {
      const raw = JSON.stringify({ [BOB.toUpperCase()]: pin('a', 'b', 1, 1), junk: pin('a', 'b', 1, 1) });
      local.setItem(`${BLOB}.${ME}`, raw);
      crypto.migratePinnedKeys(ME, false);
      expect(JSON.parse(local.getItem(`${BLOB}.${ME}`)!)).toEqual({ [BOB]: pin('a', 'b', 1, 1) });
      expect(local.getItem(`${BLOB}.${ME}.premerge.0`)).toBe(raw);
    });

    it('a failed write deletes no source', async () => {
      await load(memoryStorage({ failWritesTo: `${BLOB}.${ME}` }));
      const upper = JSON.stringify({ [BOB]: pin('a', 'b', 1, 1) });
      local.setItem(`${BLOB}.${ME.toUpperCase()}`, upper);
      crypto.migratePinnedKeys(ME, true);
      expect(local.getItem(`${BLOB}.${ME.toUpperCase()}`)).toBe(upper);
    });

    it('a write that does not read back deletes no source', async () => {
      await load(memoryStorage({ dropWritesTo: `${BLOB}.${ME}` }));
      const upper = JSON.stringify({ [BOB]: pin('a', 'b', 1, 1) });
      local.setItem(`${BLOB}.${ME.toUpperCase()}`, upper);
      crypto.migratePinnedKeys(ME, true);
      expect(local.getItem(`${BLOB}.${ME.toUpperCase()}`)).toBe(upper);
    });

    it('a failed copy deletes no source and writes nothing', async () => {
      await load(memoryStorage({ failWritesTo: `${BLOB}.${ME}.premerge.0` }));
      const upper = JSON.stringify({ [BOB]: pin('a', 'b', 1, 1) });
      local.setItem(`${BLOB}.${ME.toUpperCase()}`, upper);
      crypto.migratePinnedKeys(ME, true);
      expect(local.getItem(`${BLOB}.${ME.toUpperCase()}`)).toBe(upper);
      expect(local.getItem(`${BLOB}.${ME}`)).toBeNull();
    });

    it("adopts the older builds' un-namespaced blob only for the recorded owner, and only when it is all there is", () => {
      const base = JSON.stringify({ [BOB]: pin('a', 'b', 1, 1) });
      local.setItem(BLOB, base);
      crypto.migratePinnedKeys(ME, false);
      expect(local.getItem(`${BLOB}.${ME}`)).toBeNull();
      expect(local.getItem(BLOB)).toBe(base);

      crypto.migratePinnedKeys(ME, true);
      expect(JSON.parse(local.getItem(`${BLOB}.${ME}`)!)).toEqual({ [BOB]: pin('a', 'b', 1, 1) });
      expect(local.getItem(BLOB)).toBeNull();
      expect(local.getItem(`${BLOB}.${ME}.premerge.0`)).toBe(base);
    });

    it('never adopts the un-namespaced blob beside a blob the account already has', () => {
      local.setItem(BLOB, JSON.stringify({ [CAROL]: pin('x', 'y', 1, 1) }));
      local.setItem(`${BLOB}.${ME}`, JSON.stringify({ [BOB]: pin('a', 'b', 1, 1) }));
      crypto.migratePinnedKeys(ME, true);
      expect(Object.keys(JSON.parse(local.getItem(`${BLOB}.${ME}`)!))).toEqual([BOB]);
    });

    it('loading the pins folds other spellings of the account too', () => {
      local.setItem(`${BLOB}.${ME.toUpperCase()}`, JSON.stringify({ [BOB]: pin('a', 'b', 1, 1) }));
      crypto.loadPinnedKeysFromStorage(ME);
      expect(crypto.getPinnedUserKeys(BOB)?.sharingPubkeyHex).toBe(hex('a'));
      expect(local.getItem(`${BLOB}.${ME.toUpperCase()}`)).toBeNull();
    });
  });
});

describe('the people-list view of a conflict', () => {
  it('reads as changed, whatever the directory says', async () => {
    const { classifyRecipientKey } = await import('./recipientKeys');
    const { conflictPin, CONFLICT_KEY_HEX } = await import('./pinMerge');
    const dir = { userId: BOB, sharingPub: CONFLICT_KEY_HEX, signingPub: CONFLICT_KEY_HEX };
    expect(classifyRecipientKey(conflictPin(1, 1), dir as never)).toBe('changed');
  });
});
