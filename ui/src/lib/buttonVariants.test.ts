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
 * A class that styles nothing does not fail — it inherits the platform's idea
 * of the thing. Ten buttons in this app are written as a bare `class="btn"`
 * (Save, Add, Set, Close, …) on the convention that a bare `.btn` is the
 * primary button; `.btn-secondary` and `.btn-link` are the opt-outs. Without a
 * `background` on `.btn`, all ten would render in the browser's DEFAULT button
 * chrome. On the dark phone UI that is a light grey box, so "Close is the only
 * filled button" — which reads as a deliberate emphasis on a dismissive action
 * when it is really an unstyled control. Nothing throws; it just looks wrong.
 *
 * Read against the real stylesheet, so this fails if the declaration is ever
 * dropped rather than merely if someone edits a copy of the rule.
 */
const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

/** The body of the first top-level rule whose selector is exactly `sel`. */
function ruleBody(sel: string): string {
  // Anchored at line start so `.btn {` does not match `.btn-primary {` or a
  // nested/media-scoped variant of the same name.
  const re = new RegExp(`^\\${sel}\\s*\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  if (!m) throw new Error(`no top-level rule for ${sel}`);
  return m[1];
}

describe('.btn is styled, not left to the browser', () => {
  it('declares its own background so a bare .btn is never UA chrome', () => {
    const body = ruleBody('.btn');
    expect(body).toMatch(/(^|\s)background\s*:/);
  });

  it('declares a foreground colour to go with that background', () => {
    expect(ruleBody('.btn')).toMatch(/(^|\s)color\s*:/);
  });

  it('still lets the variants override it', () => {
    // If these ever stop declaring their own background, a bare-.btn default
    // would silently repaint every secondary and link button as primary.
    expect(ruleBody('.btn-secondary')).toMatch(/background\s*:/);
    expect(ruleBody('.btn-link')).toMatch(/background\s*:/);
  });
});

/**
 * The bodies of every `@media (hover: none)` block, concatenated.
 *
 * Not `css.slice(css.indexOf('@media (hover: none)'))` — everything from the
 * FIRST such block to the end of the file, which is only "inside a hover:none
 * block" as long as no ordinary rule for the same selector happens to sit
 * below it. A hover:none block earlier in the sheet would pull the plain
 * `.note-card-select` rule into range and the assertions would read it
 * instead. Match the braces so the tests read what they claim to.
 */
function hoverNoneBlocks({ topLevelOnly = false } = {}): string {
  const AT = '@media (hover: none)';
  const out: string[] = [];
  for (let i = css.indexOf(AT); i !== -1; i = css.indexOf(AT, i + 1)) {
    // A nested block is indented; a top-level one starts its own line.
    if (topLevelOnly && !(i === 0 || css[i - 1] === '\n')) continue;
    const open = css.indexOf('{', i);
    if (open === -1) continue;
    let depth = 0;
    for (let j = open; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { out.push(css.slice(open + 1, j)); break; }
    }
  }
  return out.join('\n');
}

describe('the touch select affordance is not offered while it is inert', () => {
  /**
   * On touch the card's select circle is deliberately not tappable — a tap
   * opens the note and a long press selects (the rule's own comment says so).
   * `pointer-events: none` would leave the button in the accessibility tree:
   * assistive tech would be offered "Select note" on every card and
   * activating it would do nothing. `display: none` takes it out of the tree,
   * so what is offered matches what works.
   */
  it('hides the unselected circle outright under hover:none', () => {
    const touch = hoverNoneBlocks();
    // Anchored to the start of a line: an unanchored `.note-card-select {`
    // also matches the `.note-card:hover .note-card-select` rule above it,
    // which is a different declaration and would make this assert the wrong
    // thing.
    const rule = touch.match(/(?:^|\n)\s*\.note-card-select\s*\{([^}]*)\}/);
    expect(rule, '.note-card-select rule inside @media (hover: none)').toBeTruthy();
    expect(rule![1]).toMatch(/display\s*:\s*none/);
  });

  it('brings it back for the selecting and selected states', () => {
    const touch = hoverNoneBlocks();
    const rule = touch.match(
      /\.note-card\.selecting\s+\.note-card-select,\s*\.note-card\.selected\s+\.note-card-select\s*\{([^}]*)\}/,
    );
    expect(rule, 'selecting/selected restore rule').toBeTruthy();
    expect(rule![1]).toMatch(/display\s*:\s*inline-flex/);
  });
});

describe('a notebook row\u2019s actions exist on touch', () => {
  /**
   * Share / Rename / Delete on a notebook row are hidden at rest (`opacity: 0`
   * AND `pointer-events: none`) and revealed only by `:hover`. On a phone that
   * is a control that does not exist: the first tap merely applies sticky
   * :hover, so the icons appear and nothing fires, which makes sharing a
   * notebook an invisible two-tap gesture. Unlike the note card's strip, these
   * have nowhere else to live — no long press, no selection bar — so on touch
   * they are painted rather than removed.
   */
  it('paints them and makes them tappable under hover:none', () => {
    const rule = hoverNoneBlocks().match(/(?:^|\n)\s*\.sidebar-item-actions\s*\{([^}]*)\}/);
    expect(rule, '.sidebar-item-actions rule inside @media (hover: none)').toBeTruthy();
    expect(rule![1]).toMatch(/opacity\s*:\s*1/);
    expect(rule![1]).toMatch(/pointer-events\s*:\s*auto/);
    // Absolutely positioned they would sit ON TOP of the note count; back in
    // flow they sit beside it, so the row shows both.
    expect(rule![1]).toMatch(/position\s*:\s*static/);
  });

  it('is not confined to phone widths — a touch tablet has no hover either', () => {
    // The other hover:none blocks in this sheet are nested inside
    // `@media (max-width: 600px)`, which would leave a landscape tablet with
    // the broken behaviour. This one has to stand on its own.
    const topLevel = hoverNoneBlocks({ topLevelOnly: true });
    expect(topLevel).toMatch(/\.sidebar-item-actions\s*\{/);
  });
});
