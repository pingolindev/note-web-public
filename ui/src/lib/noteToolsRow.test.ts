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
 * The note's tools row on a phone: one line, Labels & Notebooks in full.
 *
 * "Labels & Notebooks" must not wrap to two lines on a phone, which would make
 * its button, and the whole tools row with it, a line taller (and at 320px
 * push Attachments past the row's edge). The design: on a phone Colour shows
 * only its dot and Attachments only its paper-clip, so Labels & Notebooks
 * fits whole from 360px up; their words stay for screen readers; desktop and
 * tablet don't change at all.
 *
 * That lives in two files nothing else binds. NoteModal.tsx marks the two icon
 * buttons and wraps every tool's words in `.note-tool-text`; index.css, inside
 * the phone `@media`, makes the button a one-line grid, cuts what still doesn't
 * fit with an ellipsis, and clips the icon buttons' words out of sight. Drop
 * one piece and the row wraps or overflows again, the words show (or vanish
 * from screen readers), or the desktop changes — and only some of that shows
 * on a desktop, where nobody runs the phone layout. This source scan fails on
 * the edit, the way chromeCollapse.test.ts does.
 */
const SRC = join(__dirname, '..');
const PHONE = '@media (max-width: 600px)';

/** Code, not prose: a comment naming a class must not satisfy the scan. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const MODAL = stripComments(readFileSync(join(SRC, 'components', 'NoteModal.tsx'), 'utf8'));
const CSS = stripComments(readFileSync(join(SRC, 'index.css'), 'utf8')).replace(/@(import|charset)[^;]*;/g, '');

interface Rule { selector: string; media: string[]; decls: Record<string, string> }

/** Every style rule in index.css, with the at-rules it sits in (outermost first). */
function walk(css: string): Rule[] {
  const rules: Rule[] = [];
  const stack: string[] = [];
  let buf = '';
  for (const ch of css) {
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
    } else if (ch === '}') {
      const prelude = stack.pop() ?? '';
      if (!prelude.startsWith('@')) {
        const decls: Record<string, string> = {};
        for (const d of buf.split(';')) {
          const i = d.indexOf(':');
          if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
        }
        rules.push({ selector: prelude, media: stack.filter(s => s.startsWith('@')), decls });
      }
      buf = '';
    } else {
      buf += ch;
    }
  }
  return rules;
}
const RULES = walk(CSS);

/** Rules whose selector list names `cls` exactly (so `.note-tool` doesn't match `.note-tool-count`). */
const rulesFor = (cls: string) =>
  RULES.filter(r => r.selector.split(',').some(s => new RegExp(`\\.${cls}(?![\\w-])`).test(s)));
const onPhone = (r: Rule) => r.media.length === 1 && r.media[0] === PHONE;
/** The one rule for exactly `selector` inside the phone @media. */
function phoneRule(selector: string): Rule {
  const found = RULES.filter(r => r.selector === selector && onPhone(r));
  expect(found.length, `expected one \`${selector}\` rule directly inside \`${PHONE}\``).toBe(1);
  return found[0];
}

/**
 * The tools row's buttons in NoteModal.tsx: classes, title, and the words in
 * its text span. Each opening tag is one line, read whole: `[^>]*` would stop
 * at the `=>` of its onClick, and miss a title written after it.
 */
function toolButtons() {
  const row = MODAL.match(/<div class="note-modal-tools">([\s\S]*?)\n\s{8}<\/div>/);
  expect(row, 'the `.note-modal-tools` row was not found in NoteModal.tsx — if it moved, update this scan').not.toBeNull();
  return [...row![1].matchAll(/<button ([^\n]*)\n([\s\S]*?)<\/button>/g)].map(m => ({
    classes: (m[1].match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/),
    title: m[1].match(/\btitle=/) ? (m[1].match(/\btitle="([^"]*)"/)?.[1] ?? '(expression)') : null,
    texts: [...m[2].matchAll(/<span class="note-tool-text">([^<]*)<\/span>/g)].map(t => t[1]),
  }));
}

describe('the note tools row on a phone', () => {
  it('every tool button carries its words in a .note-tool-text span', () => {
    const buttons = toolButtons();
    expect(buttons.map(b => b.classes.includes('note-tool'))).toEqual([true, true, true]);
    expect(
      buttons.map(b => b.texts),
      'words outside `.note-tool-text` are neither cut nor hidden by the phone rules',
    ).toEqual([['Colour'], ['Labels &amp; Notebooks'], ['Attachments']]);
  });

  it('Colour and Attachments are the icon-only buttons, and no tool carries a title', () => {
    const buttons = toolButtons();
    expect(buttons.map(b => b.classes.includes('note-tool-icon-only'))).toEqual([true, false, true]);
    expect(
      buttons.map(b => b.title),
      'a title that differs from the name ("Attachments" vs "Attachments 2") is read out again as a description',
    ).toEqual([null, null, null]);
  });

  it('the button is a one-line grid whose words column can give its width back', () => {
    const d = phoneRule('.note-tool').decls;
    expect(d['min-height'], 'the touch floor').toBe('44px');
    expect(d['white-space'], 'without nowrap the label wraps and the row grows a line').toBe('nowrap');
    expect(d['display'], 'a flex button never shrinks below its whole label (its min-content)').toBe('inline-grid');
    expect(d['grid-auto-flow']).toBe('column');
    expect(d['grid-template-columns'], 'the words column must be able to give all its width back')
      .toBe('auto minmax(0, max-content)');
  });

  it('words that still don\'t fit are clipped with an ellipsis', () => {
    const d = phoneRule('.note-tool-text').decls;
    expect(d['overflow']).toBe('hidden');
    expect(d['text-overflow']).toBe('ellipsis');
  });

  it('the icon-only buttons keep a 44px target and never give way', () => {
    const d = phoneRule('.note-tool-icon-only').decls;
    expect(parseFloat(d['min-width']), 'the touch floor across').toBeGreaterThanOrEqual(44);
    expect(d['flex-shrink'], 'a shrinking icon button squeezes its count').toBe('0');
    expect(d['grid-template-columns'], 'no column of an icon button may give way').toBe('none');
  });

  it('their words are clipped out of sight, never removed', () => {
    const d = phoneRule('.note-tool-icon-only > .note-tool-text').decls;
    expect(d['position']).toBe('absolute');
    expect([d['width'], d['height']]).toEqual(['1px', '1px']);
    expect(d['overflow']).toBe('hidden');
    expect(d['clip-path']).toBe('inset(50%)');
    // display:none or visibility:hidden would take the words out of the
    // accessibility tree, and the button's name with them.
    for (const r of rulesFor('note-tool-text')) {
      expect(r.decls['display'], `\`${r.selector}\` must not remove the words`).not.toBe('none');
      expect(r.decls['visibility'], `\`${r.selector}\` must not remove the words`).not.toBe('hidden');
    }
  });

  it('nothing of it reaches a desktop', () => {
    for (const r of [...rulesFor('note-tool-text'), ...rulesFor('note-tool-icon-only')]) {
      expect(onPhone(r), `\`${r.selector}\` applies outside \`${PHONE}\``).toBe(true);
    }
    const top = rulesFor('note-tool').filter(r => r.media.length === 0);
    expect(top.map(r => r.selector).sort(), 'a new top-level `.note-tool` rule changes the desktop')
      .toEqual(['.note-tool', '.note-tool svg', '.note-tool:hover']);
    const base = top.find(r => r.selector === '.note-tool')!.decls;
    expect(base['display'], 'the desktop button stays the flex row it is today').toBe('inline-flex');
    for (const prop of ['white-space', 'grid-auto-flow', 'grid-template-columns', 'min-width', 'flex-shrink']) {
      expect(base[prop], `the top-level \`.note-tool\` gained ${prop}`).toBeUndefined();
    }
  });
});
