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
import { MAX_LABEL_CHARS, openNoteLabel, plainLine } from './noteCardLabel';

/**
 * A note card is a plain container whose one real control is the open button
 * (`.note-card-open`), with Select and the action strip as its SIBLINGS.
 *
 * As a `role="button"` <div> holding all of those controls (and any link in
 * its preview), the card fails axe `nested-interactive`, and
 * `aria-command-name` for a card with no accessible name.
 *
 * Source assertions for the structure: this suite runs on `environment: 'node'`
 * with no jsdom and no solid testing library, and the include glob is
 * `src/**\/*.{test,spec}.ts` — a .tsx test would never be collected.
 */
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8');

/** Code without comments, so that markup quoted in a comment cannot
 * satisfy or fail an assertion about the real markup.
 */
const codeOnly = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
   .replace(/\/\*[\s\S]*?\*\//g, '')
   .replace(/^\s*\/\/.*$/gm, '');

const card = codeOnly(src('components/NoteCard.tsx'));
const css = codeOnly(src('index.css'));

/** The declarations of every top-level rule whose selector is exactly `selector`. */
const rule = (selector: string) => {
  const bodies: string[] = [];
  for (let at = css.indexOf(`\n${selector} {`); at !== -1; at = css.indexOf(`\n${selector} {`, at + 1)) {
    bodies.push(css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)));
  }
  expect(bodies.length, `no rule for ${selector}`).toBeGreaterThan(0);
  return bodies.join('\n');
};

describe('the card is a container, not a button', () => {
  it('has no role="button" or tabIndex anywhere in the card', () => {
    expect(card).not.toMatch(/role="button"/);
    expect(card).not.toMatch(/tabIndex/);
  });

  it('keeps its pointer handlers on the card itself', () => {
    const root = card.slice(card.indexOf('<div\n      class={cardClass()}'), card.indexOf('<button'));
    expect(root).toContain('onClick={handleClick}');
    expect(root).toContain('onPointerDown=');
  });

  it('opens with exactly one real button, named, placed before Select', () => {
    const opens = card.match(/class="note-card-open"/g) ?? [];
    expect(opens).toHaveLength(1);
    const open = card.slice(card.lastIndexOf('<button', card.indexOf('class="note-card-open"')), card.indexOf('/>', card.indexOf('class="note-card-open"')));
    expect(open).toContain('type="button"');
    expect(open).toContain('aria-label={openNoteLabel(props.note)}');
    expect(open).toContain('onKeyDown={handleOpenKeyDown}');
    expect(card.indexOf('class="note-card-open"')).toBeLessThan(card.indexOf('class="note-card-select"'));
  });

  it('handles only the MODIFIED keys itself — plain Enter/Space are the button’s own', () => {
    const handler = card.slice(card.indexOf('const handleOpenKeyDown'), card.indexOf('return (', card.indexOf('const handleOpenKeyDown')));
    expect(handler).toMatch(/if \(!e\.ctrlKey && !e\.metaKey\) return;/);
    expect(handler).toContain('e.preventDefault()');
    expect(handler).toContain('selectionStore.toggle(props.note.id)');
  });
});

describe('the open button in the stylesheet', () => {
  it('covers the card but takes no pointer events, so clicks reach the card as before', () => {
    const open = rule('.note-card-open');
    expect(open).toMatch(/position:\s*absolute/);
    expect(open).toMatch(/inset:\s*0/);
    expect(open).toMatch(/pointer-events:\s*none/);
  });

  it('draws its focus ring on the card, since the card clips its own children', () => {
    expect(rule('.note-card')).toMatch(/overflow:\s*hidden/);
    expect(rule('.note-card:has(> .note-card-open:focus-visible)')).toMatch(/outline:\s*2px solid/);
    // The card itself is not focusable, so a ring keyed on it would be dead.
    expect(css).not.toMatch(/\n\.note-card:focus-visible\s*\{/);
  });

  it('still reveals Select and the action strip when focus is inside the card', () => {
    expect(css).toMatch(/\.note-card:focus-within \.note-card-actions/);
    expect(css).toMatch(/\.note-card:focus-within \.note-card-select/);
  });
});

const note = (over: Partial<Parameters<typeof openNoteLabel>[0]>) =>
  ({ title: '', body: '', noteType: 'text', ...over });

describe('openNoteLabel', () => {
  it('names a titled note by its title', () => {
    expect(openNoteLabel(note({ title: '  Groceries ', body: 'milk' }))).toBe('Open note: Groceries');
  });

  it('names an untitled note by the first line it shows, as plain text', () => {
    expect(openNoteLabel(note({ body: '\n\n# Trip **plan**\nday one' }))).toBe('Open note: Trip plan');
    expect(openNoteLabel(note({ body: '- [ ] call [the vet](https://x.test)' }))).toBe('Open note: call the vet');
  });

  it('names an untitled checklist by its first unchecked item', () => {
    const checklistItems = [
      { text: 'done already', checked: true },
      { text: '', checked: false },
      { text: 'buy _eggs_', checked: false },
    ];
    expect(openNoteLabel(note({ noteType: 'checklist', checklistItems }))).toBe('Open note: buy eggs');
  });

  it('falls back to a fully ticked checklist’s first item', () => {
    const checklistItems = [{ text: 'all done', checked: true }];
    expect(openNoteLabel(note({ noteType: 'checklist', checklistItems }))).toBe('Open note: all done');
  });

  it('never returns an empty name', () => {
    expect(openNoteLabel(note({}))).toBe('Open untitled note');
    expect(openNoteLabel(note({ body: '  \n#  \n- ' }))).toBe('Open untitled note');
  });

  it('cuts a long name short', () => {
    const label = openNoteLabel(note({ title: 'x'.repeat(200) }));
    expect(label).toBe(`Open note: ${'x'.repeat(MAX_LABEL_CHARS)}…`);
  });
});

describe('plainLine', () => {
  it('keeps what only looks like markup', () => {
    expect(plainLine('rename my_var to snake_case')).toBe('rename my_var to snake_case');
    expect(plainLine('5 * 3 = 15')).toBe('5 * 3 = 15');
    expect(plainLine('#hashtag stays')).toBe('#hashtag stays');
  });

  it('drops the markers a reader would not see', () => {
    expect(plainLine('> 1. `code` and ~~gone~~ *soft*')).toBe('code and gone soft');
    expect(plainLine('![alt text](a.png)')).toBe('alt text');
  });
});
