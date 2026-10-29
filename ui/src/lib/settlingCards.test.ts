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
 * A card sliding to a new slot must not become the drop target as it passes
 * under the cursor: a note moving across the board to adjust would take over
 * the movement. The LAYOUT moved, the pointer did not, and only the pointer
 * expresses intent.
 *
 * It takes THREE files agreeing on one string, none of which type-checks
 * against the others:
 *
 *   flip.ts       puts `note-card-settling` on the card while its FLIP runs
 *   index.css     pointer-events: none, so it loses the HIT TEST
 *   NotesView.tsx excludes it from the nearest-card fallback, which searches
 *                 with querySelectorAll and cannot see pointer-events at all
 *
 * Drop any one and the failure comes back in a form the other two hide: with
 * only the CSS, the fallback picks the very card the hit test just refused.
 */
const SRC = join(__dirname, '..');
const FLIP = readFileSync(join(SRC, 'lib', 'flip.ts'), 'utf-8');
const CSS = readFileSync(join(SRC, 'index.css'), 'utf-8');
const VIEW = readFileSync(join(SRC, 'pages', 'NotesView.tsx'), 'utf-8');
const CLASS = 'note-card-settling';

describe('a card in flight is not a drop target', () => {
  it('flip.ts marks the card when it starts the animation', () => {
    expect(FLIP).toContain(`const SETTLING = '${CLASS}'`);
    expect(FLIP).toMatch(/c\.classList\.add\(SETTLING\)/);
  });

  it('and unmarks it when the animation ends OR is cancelled', () => {
    // A replaced FLIP cancels; only handling onfinish would leave the class on
    // a card that is standing still, making it permanently untargetable.
    expect(FLIP).toMatch(/anim\.onfinish = \(\) => clearWhenSettled\(c\)/);
    expect(FLIP).toMatch(/anim\.oncancel = \(\) => clearWhenSettled\(c\)/);
  });

  it('only unmarks once NOTHING is still animating that card', () => {
    // cancel/finish events are asynchronous, so the old animation's event can
    // land after a new FLIP has re-added the class. Removing unconditionally
    // would strip the mark off a card that is still in flight.
    expect(FLIP).toMatch(/playState === 'running'/);
    expect(FLIP).toMatch(/if \(!stillMoving\) c\.classList\.remove\(SETTLING\)/);
  });

  it('index.css takes it out of the hit test, but only during a drag', () => {
    const rule = new RegExp(`body\\.notes-dragging \\.${CLASS}\\s*\\{[^}]*pointer-events:\\s*none`);
    expect(CSS).toMatch(rule);
  });

  it('a click outside a drag is NOT blocked', () => {
    // The scope matters: FLIP also plays on reorders that have nothing to do
    // with dragging, and swallowing clicks there would break ordinary use.
    const unscoped = new RegExp(`(^|[^ ])\\.${CLASS}\\s*\\{[^}]*pointer-events:\\s*none`, 'm');
    expect(CSS).not.toMatch(unscoped);
  });

  it('a marker left by a PAUSED animation is reconciled, not left forever', () => {
    // A paused animation (backgrounded tab) fires neither finish nor cancel,
    // and a card left marked can never be targeted again.
    expect(FLIP).toMatch(/querySelectorAll<HTMLElement>\(`\.\$\{SETTLING\}`\)\.forEach\(clearWhenSettled\)/);
  });

  it('the nearest-card fallback skips it too', () => {
    expect(VIEW).toContain(`:not(.dragging):not(.${CLASS})`);
  });

  it('the fallback still excludes the card being dragged', () => {
    // The two exclusions live in one selector string, and it would be easy
    // to replace rather than extend.
    expect(VIEW).toMatch(/\.note-card\[data-note-id\]:not\(\.dragging\)/);
  });
});
