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
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The boot skeleton and the real board must be the same width.
 *
 * index.html paints a static placeholder before any JavaScript runs, so the
 * app takes over a layout that is already on screen. Every number in the
 * skeleton is therefore a claim about what the real grid will do, and a wrong
 * one is a visible jump at the worst possible moment.
 *
 * For example, `.keep-main` wider than 1200px with `.bs-main` left at 1200
 * puts the skeleton's first card at x=56 at a 1280 viewport and the real one
 * at x=16 — a 40px sideways lurch on every cold load. This test makes the
 * coupling cheap to see and impossible to miss.
 */
const SRC = join(__dirname, '..');
const CSS = readFileSync(join(SRC, 'index.css'), 'utf-8');
const HTML = readFileSync(join(SRC, '..', 'index.html'), 'utf-8');

const ruleBody = (text: string, selector: string) => {
  const i = text.indexOf(selector);
  expect(i, `${selector} not found`).toBeGreaterThan(-1);
  return text.slice(i, text.indexOf('}', i));
};
/** The plain px fallback — the first of the two `max-width` declarations. */
const maxWidth = (body: string) => {
  const m = /max-width:\s*(\d+)px/.exec(body);
  return m ? Number(m[1]) : NaN;
};
/** The column snap that centres the board; see the note in index.css. */
const snap = (body: string) => /max-width:\s*min\(\s*(\d+)px,\s*calc\(round\(down,\s*100% - 16px,\s*296px\)\s*\+\s*16px\)\)/.exec(body);

describe('the skeleton matches the board it stands in for', () => {
  it('.bs-main is exactly as wide as .keep-main', () => {
    const real = maxWidth(ruleBody(CSS, '.keep-main {'));
    const skeleton = maxWidth(ruleBody(HTML, '.bs-main {'));
    expect(skeleton).toBe(real);
  });

  it('and both are wide enough to be worth the change', () => {
    // 1200px is exactly four 280px columns, which would keep the board at
    // four however wide the screen; anything at or below that is too narrow.
    expect(maxWidth(ruleBody(CSS, '.keep-main {'))).toBeGreaterThan(1200);
  });

  it('both snap to a whole number of columns, or the board sits off-centre', () => {
    // The grid only ever uses `n * 296 - 16` of what it is given and packs the
    // remainder onto one side, which leaves the cards 40-120px left of centre
    // at common widths. Snapping the CONTAINER — not the grid — is what keeps
    // the section labels and the composer aligned with the first column too.
    const a = snap(ruleBody(CSS, '.keep-main {'));
    const b = snap(ruleBody(HTML, '.bs-main {'));
    expect(a, '.keep-main has no column snap').not.toBeNull();
    expect(b, '.bs-main has no column snap').not.toBeNull();
    expect(a![1]).toBe(b![1]);
  });

  it('the cap is itself a whole number of columns', () => {
    // 2088 = 7 * 280 + 6 * 16 + 32 of padding. A cap that is not a multiple
    // would leave the widest screens off-centre, which is where it is worst.
    const cap = maxWidth(ruleBody(CSS, '.keep-main {'));
    expect((cap - 32 + 16) % 296).toBe(0);
  });

  it('they flow cards the same way, or the width alone would not save it', () => {
    // Same track size, same packing direction, same gutter: the skeleton has
    // to put its cards where the real grid will.
    for (const [text, sel] of [[CSS, '.notes-grid {'], [HTML, '.bs-grid {']] as const) {
      const body = ruleBody(text, sel);
      expect(body).toMatch(/repeat\(auto-fill,\s*280px\)/);
      expect(body).toMatch(/justify-content:\s*start/);
      expect(body).toMatch(/column-gap:\s*16px/);
    }
  });

  it('and both switch to two fluid columns on a phone', () => {
    for (const text of [CSS, HTML]) {
      expect(text).toMatch(/\.(?:bs-)?(?:notes-)?grid\s*\{[^}]*repeat\(2,\s*1fr\)|repeat\(2,\s*1fr\)/);
    }
  });
});
