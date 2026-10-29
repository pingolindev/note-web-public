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

import { describe, it, expect, afterEach } from 'vitest';
import { watchKeyboard } from './keyboardWatcher';

/**
 * `watchKeyboard` must not mistake a PINCH for a keyboard.
 *
 * The numbers below are measured ones: an 891px visual viewport, the
 * keyboard taking it to 486 (the Android WebView adjustResize case), and
 * pinch-to-zoom at scale 1.6 taking it to 556.875 — which is 62.5% of the
 * baseline, past the 80% gate, and so would read as a keyboard. In the note
 * modal that would collapse every action on the note, and because
 * un-pinching is not a keyboard closing, nothing would bring them back: zoom
 * in to read your own note, zoom out, and pin/remind/share/copy/archive/
 * delete are gone.
 *
 * The suite runs in the `node` environment (vitest.config.ts), so `window` is
 * built here. Four properties is the ENTIRE surface this module touches —
 * matchMedia, visualViewport.{height,scale} and the two resize listeners — so
 * the fake is the real contract rather than a shape that happens to satisfy
 * the code: a hand-rolled fake can keep a suite green while every dispatch
 * throws on a device.
 */
interface FakeWindow {
  win: Record<string, unknown>;
  /** Move the visual viewport and tell the page about it. */
  resize(height: number, scale?: number): void;
}

function installWindow(phone = true): FakeWindow {
  const listeners = new Map<string, Set<() => void>>();
  const add = (type: string, fn: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  };
  const remove = (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); };

  const visualViewport = {
    height: 891,
    scale: 1,
    addEventListener: add,
    removeEventListener: remove,
  };
  const win = {
    innerHeight: 891,
    visualViewport,
    matchMedia: () => ({ matches: phone }),
    addEventListener: add,
    removeEventListener: remove,
  };
  (globalThis as { window?: unknown }).window = win;
  return {
    win: win as unknown as Record<string, unknown>,
    resize(height: number, scale = 1) {
      visualViewport.height = height;
      visualViewport.scale = scale;
      for (const fn of listeners.get('resize') ?? []) fn();
    },
  };
}

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('watchKeyboard', () => {
  it('reports the keyboard up and then down again', () => {
    const env = installWindow();
    const seen: boolean[] = [];
    const stop = watchKeyboard((up) => seen.push(up));

    env.resize(486);          // IME up: 486 / 891 = 55%
    expect(seen).toEqual([true]);

    env.resize(891);          // IME down
    expect(seen).toEqual([true, false]);
    stop();
  });

  it('does NOT report a keyboard when the page is pinch-zoomed', () => {
    const env = installWindow();
    const seen: boolean[] = [];
    const stop = watchKeyboard((up) => seen.push(up));

    // Scale 1.6: the viewport shrinks to 556.875, well past the 80% gate.
    env.resize(556.875, 1.6);
    expect(seen, 'a pinch announced a keyboard').toEqual([]);

    // ...and un-pinching is not a keyboard closing, so still nothing.
    env.resize(891, 1);
    expect(seen).toEqual([]);
    stop();
  });

  it('says nothing at all while zoomed, rather than guessing', () => {
    const env = installWindow();
    const seen: boolean[] = [];
    const stop = watchKeyboard((up) => seen.push(up));

    env.resize(486);                 // keyboard up
    expect(seen).toEqual([true]);

    // Pinching WHILE the keyboard is up must not report it as closed —
    // freezing the signal is the whole point of the guard.
    env.resize(303.75, 1.6);
    expect(seen).toEqual([true]);

    env.resize(486, 1);              // un-pinch, keyboard still up
    expect(seen).toEqual([true]);
    stop();
  });

  it('tolerates the scale being a hair off 1 at rest', () => {
    const env = installWindow();
    const seen: boolean[] = [];
    const stop = watchKeyboard((up) => seen.push(up));

    env.resize(486, 1.005);   // float rounding, not a zoom
    expect(seen).toEqual([true]);
    stop();
  });

  it('is inert above the phone breakpoint', () => {
    const env = installWindow(false);
    const seen: boolean[] = [];
    const stop = watchKeyboard((up) => seen.push(up));

    env.resize(486);
    expect(seen).toEqual([]);
    stop();
  });
});
