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
 * A restore that meets the server's per-user write limit, through the real
 * apiRequest: the server is a fetch that answers with the note server's own
 * 429 (status 429, a JSON body, no Retry-After).
 *
 * WHY THESE EXIST
 *   Taking that 429 as the note's own answer would make a re-restore of a
 *   large file, or one restore after another, report present notes as
 *   "couldn't be restored", and a large import would lose the notes past the
 *   limit.
 */

const ME = '0e0e0e0e-0000-4000-8000-00000000000e';
const OTHER = '0e0e0e0e-0000-4000-8000-00000000000f';

/** The server, as a fetch. Each test sets `answer`. */
type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error;
let answer: (url: string, init: RequestInit) => Reply;
const sent: { url: string; method: string; body: unknown }[] = [];
let tab: string | null = ME;
vi.mock('../account', async (orig) => {
  const real = await orig<typeof import('../account')>();
  return {
    ...real,
    getTabAccount: () => tab,
    accountFetch: async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
      const r = answer(url, init);
      if (r instanceof Error) throw r;
      const headers = { 'content-type': r.text !== undefined ? 'text/html' : 'application/json', ...(r.headers ?? {}) };
      return new Response(r.text ?? JSON.stringify(r.body ?? {}), { status: r.status, headers });
    },
  };
});
vi.mock('../crypto', () => ({
  isCryptoReady: () => true,
  generateContentKey: () => new Uint8Array(32).fill(7),
  wrapContentKeyWithVault: () => ({ wrappedKey: 'w', nonce: 'wn' }),
  encryptWithContentKey: (plaintext: string) => ({ ciphertext: plaintext, nonce: 'n' }),
}));
vi.mock('../../stores/notes', () => ({ notesStore: { sync: async () => {}, notes: () => [] } }));
vi.mock('../../stores/reminders', () => ({ remindersStore: { reminders: () => [] } }));

const { ingestProgress } = await import('./pipeline');
const { restoreBackupReminders } = await import('./restoreBackup');
const { writesForRun } = await import('./rateLimit');
const { AccountMismatchError } = await import('../account');
type ImportedNote = import('./types').ImportedNote;
type ImportState = import('./types').ImportState;

/** The note server's 429, byte for byte: its rate limiter's body, no Retry-After. */
const LIMITED = { status: 429, body: { success: false, error: 'Rate limit exceeded. Please slow down.', error_code: 'rate_limit_exceeded' } };
const CREATED = (id: string) => ({ status: 201, body: { success: true, data: { id } } });
const CONFLICT = { status: 409, body: { success: false, error: 'An item with this id already exists' } };
const OWN_ROW = (id: string) => ({ status: 200, body: { success: true, data: { id, user_id: ME, deleted: false } } });

function fakeClock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, advance: (ms: number) => { t += ms; } };
}
const idOf = (i: number) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
const note = (i: number): ImportedNote => ({
  title: `t${i}`, body: 'b', noteType: 'text', checklistItems: null, labels: [], color: null,
  isPinned: false, isArchived: false, createdAt: null, updatedAt: null, id: idOf(i),
} as ImportedNote);
async function* notes(n: number) {
  for (let i = 0; i < n; i++) yield { kind: 'note' as const, note: note(i) };
  yield { kind: 'done' as const, total: n };
}
async function restore(n: number, clock = fakeClock()) {
  let done: Extract<ImportState, { kind: 'complete' }> | null = null;
  await ingestProgress(notes(n), s => { if (s.kind === 'complete') done = s; }, { writes: writesForRun(clock) });
  // Null when the run stopped without an outcome (an account stop).
  return { done: done as unknown as Extract<ImportState, { kind: 'complete' }>, clock };
}
const posts = () => sent.filter(s => s.method === 'POST' && s.url === '/api/v1/items');

beforeEach(() => {
  sent.length = 0;
  tab = ME;
});

describe("a restore that meets the server's write limit", () => {
  it('sends the same note again after the 429 and counts it created, not failed', async () => {
    let n = 0;
    answer = (url, init) => (init.method === 'POST' ? (n++ === 0 ? LIMITED : CREATED(idOf(0))) : OWN_ROW(idOf(0)));
    const { done, clock } = await restore(1);
    expect(done).toMatchObject({ count: 1, failed: 0 });
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body).toEqual(posts()[0].body); // the same request, the same id
    expect(clock.slept).toEqual([2000]);
  });

  it('counts a present note present when its POST met the limit first', async () => {
    let n = 0;
    answer = (url, init) => (init.method === 'POST' ? (n++ === 0 ? LIMITED : CONFLICT) : OWN_ROW(idOf(0)));
    const { done } = await restore(1);
    expect(done).toMatchObject({ count: 0, present: 1, failed: 0 });
  });

  it('fails a note only after five resends and 62 s of the limit', async () => {
    answer = () => LIMITED;
    const { done, clock } = await restore(1);
    expect(done).toMatchObject({ count: 0, failed: 1 });
    expect(posts()).toHaveLength(6);
    expect(clock.slept).toEqual([2000, 4000, 8000, 16000, 32000]);
  });

  it('waits what a Retry-After says', async () => {
    let n = 0;
    answer = (url, init) => (init.method === 'POST' ? (n++ === 0 ? { ...LIMITED, headers: { 'Retry-After': '7' } } : CREATED(idOf(0))) : OWN_ROW(idOf(0)));
    const { clock } = await restore(1);
    expect(clock.slept).toEqual([7000]);
  });

  it("sends every other answer once, with no retry: a 500, a 401, another account's id, a 429 that isn't the limit's, a network error, another account's session", async () => {
    const cases: [string, Reply][] = [
      ['500', { status: 500, body: { success: false, error: 'boom' } }],
      ['401', { status: 401, body: { success: false, error: 'Unauthorized' } }],
      ['429 from something else', { status: 429, text: '<html>Too Many Requests</html>' }],
      ['429 without the code', { status: 429, body: { success: false, error: 'slow down' } }],
      ['network', new TypeError('Failed to fetch')],
    ];
    for (const [, reply] of cases) {
      sent.length = 0;
      answer = (url, init) => (init.method === 'POST' ? reply : OWN_ROW(idOf(0)));
      const { done, clock } = await restore(1);
      expect(done.failed).toBe(1);
      expect(posts()).toHaveLength(1);
      expect(clock.slept).toEqual([]);
    }
  });

  it('stops resending once another account is the tab\'s, and the run stops there', async () => {
    answer = (url, init) => { if (init.method === 'POST') tab = OTHER; return LIMITED; };
    const { done } = await restore(2);
    expect(done).toBeNull();
    expect(posts()).toHaveLength(1);
  });

  it("never sends a write once another account is the tab's: a switch between two writes stops the run", async () => {
    answer = (url, init) => {
      if (init.method === 'POST') { tab = OTHER; return CREATED(idOf(0)); }
      return OWN_ROW(idOf(0));
    };
    const { done } = await restore(3);
    expect(posts()).toHaveLength(1); // the second note's write never went out on the other account's session
    expect(done).toBeNull(); // the account stop: no "Restored" outcome, nothing more sent
  });

  it("stops the run at accountFetch's own account stop, sending that write once and nothing after it", async () => {
    answer = (url, init) => (init.method === 'POST' ? new AccountMismatchError() : OWN_ROW(idOf(0)));
    const { done } = await restore(3);
    expect(posts()).toHaveLength(1);
    expect(done).toBeNull();
  });

  it('keeps a re-restore of 250 present notes under 200 writes a minute, and every note present', async () => {
    const clock = fakeClock();
    const at: number[] = [];
    answer = (url, init) => {
      if (init.method === 'POST') { at.push(clock.now()); clock.advance(20); return CONFLICT; }
      const id = url.split('/').pop()!;
      return OWN_ROW(id);
    };
    const { done } = await restore(250, clock);
    expect(done).toMatchObject({ count: 0, present: 250, failed: 0 });
    for (let i = 0; i < at.length; i++) {
      expect(at.filter(t => t > at[i] - 60_000 && t <= at[i]).length).toBeLessThanOrEqual(200);
    }
    expect(at[at.length - 1] - at[0]).toBeGreaterThanOrEqual(60_000);
  });
});

describe("the reminders of a restore", () => {
  it("are not sent once another account is the tab's", async () => {
    answer = (url, init) => {
      if (init.method === 'POST' && url === '/api/v1/reminders') { tab = OTHER; return { status: 201, body: { success: true, data: {} } }; }
      return { status: 404, body: { success: false } };
    };
    const backup = { reminders: [0, 1, 2].map(i => ({ itemId: idOf(i), triggerAt: '2030-01-01T00:00:00Z', repeatRule: null })) };
    const r = await restoreBackupReminders(backup as never, new Set([0, 1, 2].map(idOf)), writesForRun(fakeClock()));
    expect(sent.filter(s => s.url === '/api/v1/reminders')).toHaveLength(1);
    expect(r).toMatchObject({ restored: 1, skipped: 0 }); // the run ended there; nothing after it was even tried
  });
});

describe("the reminders of a restore that meet the server's write limit", () => {
  it('are sent again after the 429 and counted restored', async () => {
    let n = 0;
    answer = (url, init) => (init.method === 'POST' && url === '/api/v1/reminders'
      ? (n++ === 0 ? LIMITED : { status: 201, body: { success: true, data: {} } })
      : { status: 404, body: { success: false } });
    const clock = fakeClock();
    const backup = { reminders: [{ itemId: idOf(0), triggerAt: '2030-01-01T00:00:00Z', repeatRule: null }] };
    const r = await restoreBackupReminders(backup as never, new Set([idOf(0)]), writesForRun(clock));
    expect(r).toMatchObject({ restored: 1, skipped: 0 });
    expect(sent.filter(s => s.url === '/api/v1/reminders')).toHaveLength(2);
    expect(clock.slept).toEqual([2000]);
  });
});
