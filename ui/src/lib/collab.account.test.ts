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
 * The collab socket names its account in its FIRST frame: a WebSocket
 * carries no custom header, and a query string would land in the proxy's
 * logs. The relay closes a socket whose hello is not the session's account
 * with 4409; the tab then stops (wipe, reload) and never reconnects as it
 * was.
 */

const ME = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const NOTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

class FakeSocket {
  static OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.made.push(this); }
  send(data: unknown) { this.sent.push(data); }
  close() {}
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
}

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

let collab: typeof import('./collab');
let account: typeof import('./account');

beforeEach(async () => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { location: { protocol: 'https:', host: 'note.pingolindev.com' } });
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  vi.resetModules();
  const crypto = await import('./crypto');
  await crypto.initCrypto();
  account = await import('./account');
  collab = await import('./collab');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const session = () => new collab.CollabSession(NOTE, '', undefined, new Uint8Array(32).fill(7));

describe('the collab socket', () => {
  it('opens nothing before the account is confirmed', () => {
    session().connect();
    expect(FakeSocket.made).toHaveLength(0);
  });

  it('sends the hello first, before any Yjs frame, and nothing names the account in the URL', () => {
    account.setTabAccount(ME);
    session().connect();
    const [ws] = FakeSocket.made;
    expect(ws.url).toBe(`wss://note.pingolindev.com/api/v1/collab/${NOTE}`);
    ws.open();
    expect(ws.sent[0]).toBe(JSON.stringify({ account: ME }));
    expect(ws.sent.length).toBeGreaterThan(1);
    expect(ws.sent.slice(1).every(f => typeof f !== 'string')).toBe(true);
  });

  it('a 4409 close stops the tab and never reconnects', async () => {
    const onStop = vi.fn();
    account.onAccountMismatch(onStop);
    account.setTabAccount(ME);
    session().connect();
    FakeSocket.made[0].open();
    FakeSocket.made[0].onclose?.({ code: collab.CLOSE_ACCOUNT_MISMATCH });
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(account.isStopped()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it('any other close reconnects as before', async () => {
    account.setTabAccount(ME);
    session().connect();
    FakeSocket.made[0].onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.made).toHaveLength(2);
  });

  it('a stopped tab opens nothing, even with an account set again', () => {
    account.reportAccountMismatch();
    account.setTabAccount(ME);
    session().connect();
    expect(FakeSocket.made).toHaveLength(0);
  });
});
