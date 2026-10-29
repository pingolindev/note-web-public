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
 * Nothing paints hardcoded white on the accent.
 *
 * `.btn`, `.btn-primary`, `.fmt-btn.fmt-active`, `.share-avatar`,
 * `.theme-btn.active` and `.filter-chip.active` all sit on the accent. White
 * is 6.20:1 on note's light accent but only **2.77:1** on its dark one
 * (#a08aff), so white text there would put every primary action in the app
 * below AA in dark mode.
 *
 * `theme/generated/primitives.css` writes `color: var(--on-primary, #fff)` for
 * `.btn-primary`, so `theme/generate.sh` has to EMIT `--on-primary` into the
 * per-app CSS or the fallback silently wins. These rules consume the token.
 *
 * Ratios are recomputed from the real stylesheets — index.css for the rules,
 * note.css for the token values — so a later colour tweak that drops below AA
 * fails here rather than shipping.
 */
const SRC = new URL('..', import.meta.url).pathname;
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = strip(readFileSync(join(SRC, 'index.css'), 'utf8'));
const THEME = strip(readFileSync(join(SRC, '..', '..', 'theme', 'generated', 'note.css'), 'utf8'));

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const chan = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `--name` out of the light `:root` block, or the dark block. */
function token(name: string, mode: 'light' | 'dark'): string {
  const block = mode === 'light'
    ? THEME.match(/:root\s*\{([\s\S]*?)\}/)?.[1]
    : THEME.match(/\.dark,[\s\S]*?\{([\s\S]*?)\}/)?.[1];
  expect(block, `${mode} token block not found in note.css`).toBeTruthy();
  const v = block!.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  expect(v, `--${name} not defined in the ${mode} block — the generator gap is back`).toBeTruthy();
  return v!;
}

describe('accent contrast', () => {
  it('the generated theme defines --on-primary in both themes', () => {
    // The primitive asks for this token; if the generator does not emit
    // it, `#fff` wins silently.
    expect(token('on-primary', 'light')).toBe('#ffffff');
    expect(token('on-primary', 'dark')).toBe('#1a1040');
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`accent fills carry their text in ${mode} mode`, () => {
      const accent = token('accent-color', mode);
      const hover = token('accent-hover', mode);
      const ink = token('on-primary', mode);
      expect(contrast(accent, ink), `${ink} on ${accent}`).toBeGreaterThanOrEqual(4.5);
      // The hover swaps the fill and keeps the ink, so it needs its own check.
      expect(contrast(hover, ink), `${ink} on hover ${hover}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('no rule paints hardcoded white on the accent', () => {
    const offenders: string[] = [];
    let depth = 0; let selStart = 0;
    for (let i = 0; i < CSS.length; i++) {
      const c = CSS[i];
      if (c === '{') {
        if (depth === 0) {
          const end = CSS.indexOf('}', i);
          const body = CSS.slice(i + 1, end);
          const bg = body.match(/background(?:-color)?:\s*([^;]+);/)?.[1] ?? '';
          const fg = body.match(/(?:^|[^-\w])color:\s*([^;]+);/)?.[1]?.trim() ?? '';
          if (bg.includes('var(--accent-color)') && /^(white|#fff|#ffffff)$/i.test(fg)) {
            offenders.push(CSS.slice(selStart, i).trim().split('\n').pop() ?? '?');
          }
        }
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) selStart = i + 1;
      }
    }
    expect(offenders, `these are below AA in dark mode: ${offenders.join(', ')}`).toEqual([]);
  });
});
