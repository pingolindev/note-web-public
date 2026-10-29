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

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import sodiumInit from 'libsodium-wrappers';

/**
 * A tab picks up a restore without a reload.
 *
 * After someone restores their notes from before a password reset, the page
 * re-checks the account's recovered identities when it comes back into view.
 * The re-check may only ADD (an empty or wrong answer changes nothing), it
 * reloads only when something new opened, and it runs at most once per window
 * however often it is asked.
 */

let sodium: typeof sodiumInit;

beforeAll(async () => {
  await sodiumInit.ready;
  sodium = sodiumInit;
});

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

const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL);
const vaultOf = (priv: Uint8Array) =>
  sodium.crypto_generichash(32, priv, sodium.from_string('pingolin-note-vault'));

/** Seal a recovered key the way the account portal seals it for the apps. */
function sealForApps(recoveredPriv: Uint8Array, currentPriv: Uint8Array) {
  const wrap = sodium.crypto_generichash(32, currentPriv, sodium.from_string('pingolin.previous-identity'));
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(recoveredPriv, nonce, wrap);
  return { nonce: b64(nonce), ciphertext: b64(ciphertext) };
}

/** A content key wrapped under the vault key of a given identity. */
function wrapUnderVaultOf(privateKey: Uint8Array, contentKey: Uint8Array) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const wrapped = sodium.crypto_secretbox_easy(contentKey, nonce, vaultOf(privateKey));
  return { wrappedKey: b64(wrapped), nonce: b64(nonce) };
}

let crypto: typeof import('./crypto');
let prev: typeof import('./previousIdentities');
let current: { privateKey: Uint8Array; publicKey: Uint8Array };

function signIn(identity: { privateKey: Uint8Array; publicKey: Uint8Array }) {
  sessionStorage.setItem('pingolin_note_session_key', b64(vaultOf(identity.privateKey)));
  sessionStorage.setItem('pingolin_note_sharing_priv', b64(identity.privateKey));
  sessionStorage.setItem('pingolin_note_sharing_pub', b64(identity.publicKey));
  // Restored only for the confirmed account's registered keys.
  crypto.expectAccount(crypto.accountKeysFrom('aaaaaaaa-0000-4000-8000-0000000000aa', b64(identity.publicKey)));
  expect(crypto.restoreFromSession()).toBe(true);
}

async function load(window: object = {}) {
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('window', window);
  vi.resetModules();
  crypto = await import('./crypto');
  prev = await import('./previousIdentities');
  await crypto.initCrypto();
  current = sodium.crypto_box_keypair();
  signIn(current);
}

/** The auth answer: these recovered identities, sealed for the CURRENT key. */
function answerFor(identities: Uint8Array[]) {
  return new Response(JSON.stringify({
    success: true,
    data: {
      identities: identities.map((priv, i) => ({
        key_version: i + 1,
        app_sealed_private_key: sealForApps(priv, current.privateKey),
      })),
    },
  }), { status: 200 });
}

function serve(identities: Uint8Array[] | 'fail' | 'offline') {
  const fetchMock = vi.fn(async () => {
    if (identities === 'offline') throw new TypeError('Failed to fetch');
    if (identities === 'fail') return new Response('', { status: 500 });
    return answerFor(identities);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('re-checking after a restore only ever adds', () => {
  beforeEach(() => load());

  it('adds a newly restored identity, and the next sync sees the grown count', async () => {
    const older = sodium.crypto_box_keypair().privateKey;
    const restored = sodium.crypto_box_keypair().privateKey;
    serve([older]);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(1);

    // A note written under the identity that is restored LATER.
    const contentKey = sodium.randombytes_buf(32);
    const note = wrapUnderVaultOf(restored, contentKey);
    expect(crypto.unwrapContentKeyWithVault(note.wrappedKey, note.nonce)).toBeNull();

    serve([older, restored]);
    expect(await prev.recheckPreviousIdentities('/api/v1')).toBe(1);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(2);
    expect(crypto.getPreviousVaultKeys()).toHaveLength(2);
    expect(crypto.unwrapContentKeyWithVault(note.wrappedKey, note.nonce)).toEqual(contentKey);
  });

  it('an empty, stale, failed or unreachable answer keeps every identity held', async () => {
    const older = sodium.crypto_box_keypair().privateKey;
    serve([older]);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(1);

    for (const answer of [[], 'fail', 'offline', [older]] as const) {
      serve(answer as Uint8Array[] | 'fail' | 'offline');
      expect(await prev.recheckPreviousIdentities('/api/v1'), String(answer)).toBe(0);
      expect(crypto.getPreviousVaultKeys()).toHaveLength(1);
    }
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(1);
  });

  it('a re-check whose keys changed under it opens nothing for the new ones', async () => {
    serve([]);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(0);

    const restored = sodium.crypto_box_keypair().privateKey;
    let reply: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { reply = r; })));
    const recheck = prev.recheckPreviousIdentities('/api/v1');
    await new Promise((r) => setTimeout(r, 0));

    // Another session's keys are adopted while the answer is still on its
    // way. No wipe first (as when a federation hands new keys over), so the
    // captured key is intact and only the guard stands in the way.
    const answer = answerFor([restored]);
    signIn(sodium.crypto_box_keypair());
    reply(answer);

    expect(await recheck).toBe(0);
    expect(crypto.getPreviousVaultKeys()).toHaveLength(0);
  });

  it('reset forgets the held identities and the count', async () => {
    const fetchMock = serve([sodium.crypto_box_keypair().privateKey]);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(1);
    prev.resetPreviousIdentities();
    expect(crypto.getPreviousVaultKeys()).toHaveLength(0);
    await prev.ensurePreviousIdentities('/api/v1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('in the iOS key-bridge shell, the shell\'s vault keys are added the same way', () => {
  it('adds what the shell newly hands over and keeps what it held', async () => {
    const postMessage = vi.fn();
    await load({
      __pingolinKeyBridge: { version: 1, signing: true },
      webkit: { messageHandlers: { pingolinKeys: { postMessage } } },
    });
    const a = sodium.randombytes_buf(32);
    const b = sodium.randombytes_buf(32);
    postMessage.mockResolvedValueOnce({ keys: [b64(a)] });
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(1);

    postMessage.mockResolvedValueOnce({ keys: [] });
    expect(await prev.recheckPreviousIdentities('/api/v1')).toBe(0);
    expect(crypto.getPreviousVaultKeys()).toHaveLength(1);

    postMessage.mockResolvedValueOnce({ keys: [b64(a), b64(b)] });
    expect(await prev.recheckPreviousIdentities('/api/v1')).toBe(1);
    expect(crypto.getPreviousVaultKeys()).toHaveLength(2);
  });
});

describe('the re-check gate: at most one run per window', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function harness() {
    await load();
    let t = 0;
    const timers: Array<{ fn: () => void; at: number }> = [];
    let runs = 0;
    let finishRun: (() => void) | null = null;
    const gate = prev.createRecheckGate(() => {
      runs++;
      return new Promise<void>((r) => { finishRun = r; });
    }, {
      windowMs: 1000,
      now: () => t,
      setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
      clearTimer: (h) => { const i = timers.indexOf(h as { fn: () => void; at: number }); if (i >= 0) timers.splice(i, 1); },
    });
    return {
      gate,
      timers,
      runs: () => runs,
      advance: async (ms: number) => {
        t += ms;
        for (const h of [...timers]) {
          if (h.at <= t) { timers.splice(timers.indexOf(h), 1); h.fn(); }
        }
        await flush();
      },
      finish: async () => { finishRun?.(); finishRun = null; await flush(); },
    };
  }

  it('runs at once, then a burst inside the window leaves ONE deferred run', async () => {
    const h = await harness();
    h.gate.request();
    expect(h.runs()).toBe(1);
    await h.finish();

    for (let i = 0; i < 5; i++) h.gate.request();
    expect(h.runs()).toBe(1);
    expect(h.timers).toHaveLength(1);

    await h.advance(1000);
    expect(h.runs()).toBe(2);
    await h.finish();
    await h.advance(5000);
    expect(h.runs()).toBe(2);
  });

  it('a request during a run is not a second run; it runs once the window ends', async () => {
    const h = await harness();
    h.gate.request();
    h.gate.request();
    expect(h.runs()).toBe(1);
    await h.finish();
    expect(h.timers).toHaveLength(1);
    await h.advance(1000);
    expect(h.runs()).toBe(2);
  });

  it('reset drops the pending flag and the window', async () => {
    const h = await harness();
    h.gate.request();
    await h.finish();
    h.gate.request();
    expect(h.timers).toHaveLength(1);

    h.gate.reset();
    expect(h.timers).toHaveLength(0);
    await h.advance(1000);
    expect(h.runs()).toBe(1);
    h.gate.request();
    expect(h.runs()).toBe(2);
  });
});

describe('what a tab coming back into view does', () => {
  beforeEach(() => load());

  it('nothing locked since a reset: no fetch at all', async () => {
    const fetchMock = serve([sodium.crypto_box_keypair().privateKey]);
    const onNew = vi.fn();
    prev.configurePreviousIdentitiesRecheck({ stillLocked: () => false, onNewIdentities: onNew });
    prev.requestPreviousIdentitiesRecheck();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('notes locked but nothing restored since: one fetch, no reload', async () => {
    serve([]);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(0);
    const fetchMock = serve([]);
    const onNew = vi.fn();
    prev.configurePreviousIdentitiesRecheck({ stillLocked: () => true, onNewIdentities: onNew });
    prev.requestPreviousIdentitiesRecheck();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(onNew).not.toHaveBeenCalled();
    prev.resetPreviousIdentities();
  });

  it('notes locked and a restore since: reloads once; an immediate second view fetches nothing', async () => {
    serve([]);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(0);
    const fetchMock = serve([sodium.crypto_box_keypair().privateKey]);
    const onNew = vi.fn();
    prev.configurePreviousIdentitiesRecheck({ stillLocked: () => true, onNewIdentities: onNew });

    prev.requestPreviousIdentitiesRecheck();
    await vi.waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    prev.requestPreviousIdentitiesRecheck();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledTimes(1);
    prev.resetPreviousIdentities();
  });
});

/**
 * The re-check's required client behaviour, counted in GETs to
 * /auth/previous-identities on the real module and a fake clock.
 */
describe("the re-check's client behaviour, counted in GETs", () => {
  const WINDOW = 3 * 60 * 1000;
  let onNew: ReturnType<typeof vi.fn<() => void>>;

  async function start(held: Uint8Array[] = []) {
    await load();
    serve(held);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(held.length);
    onNew = vi.fn<() => void>();
    prev.configurePreviousIdentitiesRecheck({ stillLocked: () => true, onNewIdentities: onNew });
    vi.useFakeTimers();
  }

  afterEach(() => {
    prev?.resetPreviousIdentities();
    vi.useRealTimers();
  });

  it('many triggers inside the window: no GET now, exactly one when the window ends', async () => {
    await start();
    let gets = serve([]);
    prev.requestPreviousIdentitiesRecheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(gets).toHaveBeenCalledTimes(1);

    gets = serve([]);
    for (let i = 0; i < 10; i++) prev.requestPreviousIdentitiesRecheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(gets).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(gets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * WINDOW);
    expect(gets).toHaveBeenCalledTimes(1);
  });

  it('a trigger during a running re-check: exactly one follow-up', async () => {
    await start();
    let reply: (r: Response) => void = () => {};
    const inFlight = vi.fn(() => new Promise<Response>((r) => { reply = r; }));
    vi.stubGlobal('fetch', inFlight);
    prev.requestPreviousIdentitiesRecheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlight).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i++) prev.requestPreviousIdentitiesRecheck();
    reply(answerFor([]));
    await vi.advanceTimersByTimeAsync(0);
    const followUp = serve([]);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(followUp).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * WINDOW);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('an empty answer after a good one: the count is unchanged', async () => {
    const older = sodium.crypto_box_keypair().privateKey;
    await start([older]);
    serve([]);
    prev.requestPreviousIdentitiesRecheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(1);
    expect(crypto.getPreviousVaultKeys()).toHaveLength(1);
    expect(onNew).not.toHaveBeenCalled();
  });

  it('sign-out clears everything: the keys, the count, the pending flag and the window', async () => {
    const restored = sodium.crypto_box_keypair().privateKey;
    await start();
    serve([restored]);
    prev.requestPreviousIdentitiesRecheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(onNew).toHaveBeenCalledTimes(1);
    prev.requestPreviousIdentitiesRecheck(); // inside the window: the one pending flag

    prev.resetPreviousIdentities();
    expect(crypto.getPreviousVaultKeys()).toHaveLength(0);
    const afterReset = serve([]);
    await vi.advanceTimersByTimeAsync(10 * WINDOW);
    expect(afterReset).toHaveBeenCalledTimes(0); // the flag went with it

    prev.requestPreviousIdentitiesRecheck(); // and so did the window
    await vi.advanceTimersByTimeAsync(0);
    expect(afterReset).toHaveBeenCalled();
  });

  it('extra fields in the answer make no difference', async () => {
    const restored = sodium.crypto_box_keypair().privateKey;
    await start();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      extra: { anything: [1, 2, 3] },
      data: {
        more: 'ignored',
        identities: [{
          key_version: 7,
          label: 'x',
          app_sealed_private_key: { ...sealForApps(restored, current.privateKey), alg: 'none' },
        }],
      },
    }), { status: 200 })));
    prev.requestPreviousIdentitiesRecheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(crypto.getPreviousVaultKeys()).toHaveLength(1);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(1);
  });
});

describe("the app shell's pingolin-identities event", () => {
  it('iOS key-bridge shell: re-reads the shell at once, even inside the window', async () => {
    const postMessage = vi.fn();
    await load({
      __pingolinKeyBridge: { version: 1, signing: true },
      webkit: { messageHandlers: { pingolinKeys: { postMessage } } },
    });
    postMessage.mockResolvedValue({ keys: [] });
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(0);
    const onNew = vi.fn();
    prev.configurePreviousIdentitiesRecheck({ stillLocked: () => true, onNewIdentities: onNew });

    prev.requestPreviousIdentitiesRecheck(); // opens the page's window
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

    const restored = sodium.randombytes_buf(32);
    postMessage.mockResolvedValue({ keys: [b64(restored)] });
    prev.onShellIdentitiesEvent();
    await vi.waitFor(() => expect(onNew).toHaveBeenCalledTimes(1));
    expect(crypto.getPreviousVaultKeys()).toHaveLength(1);
    prev.resetPreviousIdentities();
  });

  it('Android shell and browsers: the event is gated like a tab coming into view', async () => {
    await load();
    serve([]);
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(0);
    prev.configurePreviousIdentitiesRecheck({ stillLocked: () => true, onNewIdentities: vi.fn() });
    vi.useFakeTimers();
    try {
      let gets = serve([]);
      prev.onShellIdentitiesEvent();
      await vi.advanceTimersByTimeAsync(0);
      expect(gets).toHaveBeenCalledTimes(1);
      gets = serve([]);
      prev.onShellIdentitiesEvent();
      prev.onShellIdentitiesEvent();
      await vi.advanceTimersByTimeAsync(0);
      expect(gets).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      expect(gets).toHaveBeenCalledTimes(1);
    } finally {
      prev.resetPreviousIdentities();
      vi.useRealTimers();
    }
  });

  it('nothing locked since a reset: the event does nothing', async () => {
    await load();
    const gets = serve([sodium.crypto_box_keypair().privateKey]);
    prev.configurePreviousIdentitiesRecheck({ stillLocked: () => false, onNewIdentities: vi.fn() });
    prev.onShellIdentitiesEvent();
    await new Promise((r) => setTimeout(r, 10));
    expect(gets).not.toHaveBeenCalled();
  });
});

/**
 * A read still out when the account signs out or switches must add
 * nothing. The shell's answer carries no account check of its own, so
 * this is the guard for it.
 */
describe('a read still out at sign-out adds nothing', () => {
  async function bridgeLoad() {
    const postMessage = vi.fn();
    await load({
      __pingolinKeyBridge: { version: 1, signing: true },
      webkit: { messageHandlers: { pingolinKeys: { postMessage } } },
    });
    return postMessage;
  }

  /** The next shell read stays out until `reply` is called. */
  function holdNextRead(postMessage: ReturnType<typeof vi.fn>) {
    let reply: (v: unknown) => void = () => {};
    postMessage.mockImplementationOnce(() => new Promise((r) => { reply = r; }));
    return (v: unknown) => reply(v);
  }

  it('a shell re-check: reset while it is out, and nothing is added', async () => {
    const postMessage = await bridgeLoad();
    postMessage.mockResolvedValueOnce({ keys: [] });
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(0);

    const reply = holdNextRead(postMessage);
    const recheck = prev.recheckPreviousIdentities('/api/v1');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    prev.resetPreviousIdentities();
    reply({ keys: [b64(sodium.randombytes_buf(32))] });

    expect(await recheck).toBe(0);
    expect(crypto.getPreviousVaultKeys()).toHaveLength(0);
  });

  it('the same through the pingolin-identities bridge branch, and no reload', async () => {
    const postMessage = await bridgeLoad();
    postMessage.mockResolvedValueOnce({ keys: [] });
    expect(await prev.ensurePreviousIdentities('/api/v1')).toBe(0);
    const onNew = vi.fn<() => void>();
    prev.configurePreviousIdentitiesRecheck({ stillLocked: () => true, onNewIdentities: onNew });

    const reply = holdNextRead(postMessage);
    prev.onShellIdentitiesEvent();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    prev.resetPreviousIdentities();
    reply({ keys: [b64(sodium.randombytes_buf(32))] });
    await new Promise((r) => setTimeout(r, 10));

    expect(crypto.getPreviousVaultKeys()).toHaveLength(0);
    expect(onNew).not.toHaveBeenCalled();
  });

  it('a start-up load still out at sign-out stores nothing either', async () => {
    const postMessage = await bridgeLoad();
    const reply = holdNextRead(postMessage);
    const first = prev.ensurePreviousIdentities('/api/v1');
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    prev.resetPreviousIdentities();
    reply({ keys: [b64(sodium.randombytes_buf(32))] });

    expect(await first).toBe(0);
    expect(crypto.getPreviousVaultKeys()).toHaveLength(0);
  });
});
