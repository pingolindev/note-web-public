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
 * How long a displaced card keeps moving.
 *
 * This is a FEEL number: it comes from a side-by-side screen recording of
 * Google Keep and Note (30fps), measured frame by frame:
 *
 *   Keep          a displaced card travels ~82px in about 6 frames   ≈ 200ms
 *   600ms slide   the same kind of move takes 18 frames               = 600ms
 *
 * and because the easing is Material's EMPHASIZED decelerate, half of that
 * 600ms goes on the last 18% of the distance — the card is still creeping
 * long after the eye has finished with it.
 *
 * The test exists because the number is easy to nudge while tuning
 * something else, and nothing else in the codebase would notice. It also
 * guards the coupling that is not obvious from flip.ts alone: a card in flight
 * is not a drop target, so this duration caps how fast the grid can accept the
 * next reorder.
 */
const SRC = join(__dirname, '..');
const FLIP = readFileSync(join(SRC, 'lib', 'flip.ts'), 'utf-8');
const VIEW = readFileSync(join(SRC, 'pages', 'NotesView.tsx'), 'utf-8');

const slideMs = () => {
  const m = /const SLIDE_MS = (\d+);/.exec(FLIP);
  return m ? Number(m[1]) : NaN;
};
const landMs = () => {
  const m = /const LAND_MS = (\d+);/.exec(VIEW);
  return m ? Number(m[1]) : NaN;
};

describe('the reposition slide', () => {
  it('is in the range a hand reads as immediate', () => {
    // Keep sits at ~200. Below ~120 the motion stops explaining where the card
    // went, which is the whole reason for animating rather than jumping; above
    // ~350 several cards are still travelling when the next swap fires, and the
    // grid seems to swirl.
    expect(slideMs()).toBeGreaterThanOrEqual(120);
    expect(slideMs()).toBeLessThanOrEqual(350);
  });

  it('is the default, so every caller gets it', () => {
    expect(FLIP).toMatch(/duration = SLIDE_MS/);
    // A caller passing its own number would silently opt out.
    expect(VIEW).toMatch(/playSlide\(oldRects\)/);
    expect(VIEW).not.toMatch(/playSlide\([^)]*,\s*\d+\s*\)/);
  });

  it('stays the SECONDARY motion — slower than putting the card down', () => {
    // The drop landing is the card in the user's own hand arriving; the slide
    // is the board reacting. If the board outran the hand it would read as the
    // grid leading the gesture.
    expect(landMs()).toBeLessThan(slideMs());
  });

  it('keeps a decelerating ease, which is what makes it read as settling', () => {
    expect(FLIP).toMatch(/easing: 'cubic-bezier\(/);
  });
});
