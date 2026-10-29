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
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Nothing in the app asks through `window.confirm()`, `alert()` or `prompt()`.
 *
 * The browser's native confirm dialog renders in the OS's chrome rather than
 * the app's, is identical whether the answer moves a note to Trash or
 * destroys it on every device, and cannot say which.
 *
 * alert() and prompt() are banned too, and not for looks: inside a shell —
 * the single place a native dialog cannot work — they fail. On iOS the shell
 * implements no WKUIDelegate panel method, so alert() is a silent no-op and
 * prompt() returns null immediately (which a sealed-backup restore would read
 * as "cancelled", making it impossible and silent). On Android they render as
 * the system box headed `The page at "https://…" says:` — and a prompt with
 * `password=false`: a backup's passphrase typed in the clear.
 *
 * A source scan rather than a behavioural test because the failure mode is
 * REAPPEARANCE: all three are globals that need no import, so a new call site
 * costs nothing to write and nothing catches it. This is what catches it.
 */
const SRC = join(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The file's lines with comments blanked out, line numbers preserved.
 *
 * Needed once the scan covers alert() and prompt(): the replacements are
 * documented at their call sites, and `the browser's own \`alert()\`` in a
 * comment is prose, not a call. Block comments are tracked across lines (JSX
 * `{/* … *\/}` blocks have continuation lines that start with ordinary words),
 * and a line whose first non-space characters are `//` is dropped whole.
 *
 * Deliberately NOT a general comment stripper: it never removes anything from
 * a line of real code, so it cannot hide a call. The worst it can do is report
 * one that is not there, which is loud and one reword away.
 */
function codeLines(text: string): string[] {
  let inBlock = false;
  return text.split('\n').map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) return out;
        inBlock = false;
        i = end + 2;
        continue;
      }
      const block = line.indexOf('/*', i);
      const lineComment = line.indexOf('//', i);
      if (lineComment !== -1 && (block === -1 || lineComment < block)) {
        return out + line.slice(i, lineComment);
      }
      if (block === -1) return out + line.slice(i);
      out += line.slice(i, block);
      inBlock = true;
      i = block + 2;
    }
    return out;
  });
}

describe('confirmations', () => {
  it('no source file calls the native confirm(), alert() or prompt()', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      codeLines(readFileSync(file, 'utf8')).forEach((line, i) => {
        // `confirmAction(` / `promptAction(` and any `.confirm(` are ours; a
        // bare one after a non-identifier character is the global.
        if (/(^|[^.\w])(confirm|alert|prompt)\s*\(/.test(line)
          && !/(confirm|prompt)Action\s*\(/.test(line)) {
          offenders.push(`${file.replace(SRC, '')}:${i + 1}`);
        }
      });
    }
    expect(offenders, `these ask through the browser's dialog: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('every confirmAction call names a button and a consequence', () => {
    // A dialog whose confirm button says "OK" is the native one with extra
    // steps; the point of the replacement is that the button says what it does.
    const calls: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith('ConfirmDialog.tsx')) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/confirmAction\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
        calls.push(`${file.replace(SRC, '')} :: ${m[1]}`);
      }
    }
    // Every site, so a dropped one shows up here rather than silently: the
    // eight destructive actions ConfirmDialog lists, the two note-delete paths
    // (the grid's and the open note's), web sign-out (which both native shells
    // confirm too), and an invitation's block of its sender, which asks what a
    // note's card asks.
    expect(calls.length).toBe(12);
    for (const call of calls) {
      expect(call, 'missing confirmLabel').toContain('confirmLabel:');
      expect(call, 'missing message').toContain('message:');
      expect(call, 'missing detail — the sentence a native dialog had no room for')
        .toContain('detail:');
    }
  });

  it('Escape is captured, so it cannot also close what is behind the dialog', () => {
    // NoteModal and NotesView both bind Escape to `document` — closing the note
    // and clearing the selection. `stopPropagation` does nothing between
    // listeners on the same node, so a bubble-phase handler here would cancel
    // the dialog AND close the note under it with one keypress. Capture phase
    // plus stopImmediatePropagation is what makes the dialog modal in fact.
    const src = readFileSync(join(SRC, 'components', 'ConfirmDialog.tsx'), 'utf8');
    expect(src).toMatch(/addEventListener\('keydown',\s*onKeyDown,\s*true\)/);
    expect(src).toContain('stopImmediatePropagation');
    // And the same for Android hardware back, which walks its own registry.
    expect(src).toContain('registerBackHandler');
  });

  it('the destructive confirm button is actually painted', () => {
    // Same trap as the bare `.btn`: a class that styles nothing does not throw,
    // it inherits the platform's idea of a button.
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    const rule = css.match(/^\.btn-danger \{([^}]*)\}/m);
    expect(rule, '.btn-danger rule not found in index.css').not.toBeNull();
    expect(/(^|;)\s*background\s*:/.test(rule![1])).toBe(true);
    expect(/(^|;)\s*color\s*:/.test(rule![1])).toBe(true);
  });

  /**
   * …and painted in colours that carry text.
   *
   * `--error` / `--on-error`, the pair nominally FOR exactly this, fails WCAG AA
   * in both themes — light #e53935 on white is 4.23:1, dark #f87171 on #7f1d1d
   * is 3.62:1, against the 4.5:1 that 14px/600 text needs. The pair is shared
   * with the other Pingolin apps (`colorOnError` is in the Android apps'
   * Material themes), so `.btn-danger` sets its own colours rather than moving
   * the token.
   *
   * This computes the ratio from the real stylesheet, so a later colour tweak
   * that drops below AA fails here rather than shipping.
   */
  it('the destructive button clears WCAG AA in both themes', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');

    const luminance = (hex: string): number => {
      const h = hex.replace('#', '');
      const chan = [0, 2, 4].map((i) => {
        const c = parseInt(h.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
    };
    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    /** background + color out of the first rule matching `selector`. */
    const pair = (selector: string): { bg: string; fg: string } => {
      const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm');
      const body = css.match(re)?.[1];
      expect(body, `${selector} not found in index.css`).toBeTruthy();
      const bg = body!.match(/background:\s*(#[0-9a-fA-F]{6})/)?.[1];
      const fg = body!.match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1];
      return { bg: bg!, fg: fg! };
    };

    // Light: both literals, so both are readable here.
    const light = pair('.btn-danger');
    expect(light.bg, 'light .btn-danger has no literal background').toBeTruthy();
    expect(light.fg, 'light .btn-danger has no literal color').toBeTruthy();
    expect(contrast(light.bg, light.fg)).toBeGreaterThanOrEqual(4.5);

    // Dark: the fill is `var(--error)`, resolved from the generated theme so
    // this still measures what actually renders.
    const theme = readFileSync(join(SRC, '..', '..', 'theme', 'generated', 'note.css'), 'utf8');
    const darkError = theme.match(/\.dark,[\s\S]*?--error:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(darkError, 'dark --error not found in the generated theme').toBeTruthy();
    const darkFg = css.match(/^:root\.dark \.btn-danger \{([^}]*)\}/m)?.[1]
      ?.match(/color:\s*(#[0-9a-fA-F]{6})/)?.[1];
    expect(darkFg, ':root.dark .btn-danger has no literal color').toBeTruthy();
    expect(contrast(darkError!, darkFg!)).toBeGreaterThanOrEqual(4.5);

    // And the button has to be findable against the card it sits on.
    expect(contrast(light.bg, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(darkError!, '#1e1e32')).toBeGreaterThanOrEqual(3);
  });
});
