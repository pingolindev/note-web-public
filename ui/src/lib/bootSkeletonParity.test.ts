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
 * Three skeletons draw the same wait, and a user sees all three in a row.
 *
 *   1. index.html's inline `#boot-skeleton`, the only thing that can paint
 *      before the bundle runs;
 *   2. components/BootSkeleton.tsx, the same markup, rendered by App.tsx's
 *      loading and Suspense fallbacks once Solid has booted (the inline copy
 *      hides itself the instant #root is non-empty);
 *   3. NotesView's in-grid `.note-card-skeleton`, once the app is up but the
 *      notes have not arrived.
 *
 * Any disagreement between them is a JUMP, because they hand over to each
 * other mid-wait with nothing else changing on screen. An in-grid card with
 * no height of its own collapses to `.note-card`'s 60px min-height under a
 * grid still reserving 240px — six stubs where the boot skeleton had just
 * drawn six cards; a `.bs-composer` row in index.html that BootSkeleton.tsx
 * lacks appears and then vanishes.
 *
 * Nothing in HTML, CSS or TSX binds them. This is that binding — a source
 * scan, the same shape as chromeCollapse.test.ts, because the failure mode is
 * an edit to one file and silence from the other two.
 */
const SRC = join(__dirname, '..');
const HTML = readFileSync(join(SRC, '..', 'index.html'), 'utf8');
const TSX = readFileSync(join(SRC, 'components', 'BootSkeleton.tsx'), 'utf8');
const NOTES_VIEW = readFileSync(join(SRC, 'pages', 'NotesView.tsx'), 'utf8');
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8');

/** The inline skeleton's MARKUP — not its <style>, which names the same classes. */
const HTML_MARKUP = HTML.slice(HTML.indexOf('<div id="boot-skeleton"'));
const HTML_STYLE = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
/** The component's JSX. */
const TSX_MARKUP = TSX.slice(TSX.indexOf('const BootSkeleton'));

const classesIn = (src: string): Set<string> =>
  new Set([...src.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)).filter(c => c.startsWith('bs-')));

/** `height: 240px` out of a rule, whichever file it lives in. */
const heightOf = (src: string, selector: string): number | null => {
  const rule = src.match(new RegExp(`${selector.replace('.', '\\.')}\\s*(,[^{]*)?\\{[^}]*\\}`));
  const h = rule?.[0].match(/height:\s*(\d+)px/);
  return h ? Number(h[1]) : null;
};

describe('the boot skeleton and its component render the same thing', () => {
  it('uses the same set of bs- blocks in both', () => {
    expect([...classesIn(TSX_MARKUP)].sort()).toEqual([...classesIn(HTML_MARKUP)].sort());
  });

  it('draws the same number of cards in both', () => {
    const htmlCards = [...HTML_MARKUP.matchAll(/class="bs-card"/g)].length;
    const forEach = TSX_MARKUP.match(/each=\{\[([^\]]*)\]\}>\{\(\) => <div class="bs-card"/);
    expect(forEach, 'BootSkeleton.tsx no longer renders bs-card from a For').toBeTruthy();
    expect(forEach![1].split(',').length).toBe(htmlCards);
  });

  it('styles every bs- block it draws, and draws every one it styles', () => {
    const styled = new Set([...HTML_STYLE.matchAll(/\.(bs-[a-z-]+)/g)].map(m => m[1]));
    expect([...styled].sort()).toEqual([...classesIn(HTML_MARKUP)].sort());
  });
});

describe('the in-grid skeleton hands over from the boot skeleton without moving', () => {
  it('is the same height as a boot-skeleton card', () => {
    const boot = heightOf(HTML_STYLE, '.bs-card');
    const inGrid = heightOf(CSS, '.note-card-skeleton');
    expect(boot, '.bs-card lost its explicit height').toBe(240);
    expect(inGrid, '.note-card-skeleton has no height — it will collapse to the 60px min-height').toBe(boot);
  });

  it('is not pushed down by the empty grid that renders beside it', () => {
    // While the notes are arriving NotesView renders the ordinary grid (empty)
    // AND the loading grid. The empty one is 0px tall but would still carry
    // `.notes-grid`'s own margin, putting the skeleton cards 16px below where
    // the boot skeleton had just drawn them.
    expect(CSS).toMatch(/\.notes-grid:empty\s*\{[^}]*display:\s*none/);
  });

  it('is drawn the same number of times', () => {
    const htmlCards = [...HTML_MARKUP.matchAll(/class="bs-card"/g)].length;
    const inGrid = NOTES_VIEW.match(/each=\{\[([^\]]*)\]\}>\s*\{\(\) => <div class="note-card note-card-skeleton" \/>\}/);
    expect(inGrid, 'NotesView no longer renders note-card-skeleton from a For').toBeTruthy();
    expect(inGrid![1].split(',').length).toBe(htmlCards);
  });
});
