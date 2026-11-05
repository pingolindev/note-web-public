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
import { EditorState } from '@codemirror/state';
import {
  activeLinePrefixStyles,
  cycleHeadingEdit,
  linePrefixAt,
  mapLinePrefixOffset,
  mapLinePrefixPosition,
  toggleLinePrefix,
  type LinePrefixKind,
} from './linePrefix';

function apply(lineText: string, kind: LinePrefixKind): string {
  const edit = toggleLinePrefix(lineText, kind);
  return lineText.slice(0, edit.from) + edit.insert + lineText.slice(edit.to);
}

describe('toggleLinePrefix', () => {
  it('adds each toolbar prefix', () => {
    expect(apply('item', 'bullet')).toBe('- item');
    expect(apply('item', 'ordered')).toBe('1. item');
    expect(apply('item', 'checklist')).toBe('- [ ] item');
    expect(apply('item', 'quote')).toBe('> item');
  });

  it('is a toggle when the same marker is pressed again', () => {
    let line = 'item';
    for (const kind of ['bullet', 'ordered', 'checklist', 'quote'] as const) {
      line = apply(line, kind);
      expect(line).not.toBe('item');
      line = apply(line, kind);
      expect(line).toBe('item');
    }
  });

  it('replaces other block styles instead of stacking them', () => {
    const kinds = ['bullet', 'ordered', 'checklist', 'quote'] as const;
    for (const before of kinds) {
      for (const after of kinds) {
        if (before === after) continue;
        const source = apply('item', before);
        expect(apply(source, after)).toBe(apply('item', after));
      }
    }
    expect(apply('# heading', 'bullet')).toBe('- heading');
  });

  it('recognizes every marker form the editor accepts', () => {
    expect(linePrefixAt('* item')?.kind).toBe('bullet');
    expect(linePrefixAt('+ item')?.kind).toBe('bullet');
    expect(linePrefixAt('12) item')?.kind).toBe('ordered');
    expect(linePrefixAt('- [X] item')?.kind).toBe('checklist');
    expect(linePrefixAt('###### item')?.headingLevel).toBe(6);
  });

  it('keeps the indentation of a list it finds', () => {
    expect(apply('    - item', 'bullet')).toBe('    item');
    expect(apply('    - item', 'checklist')).toBe('    - [ ] item');
    expect(apply('  - item', 'ordered')).toBe('  1. item');
  });

  it('puts a new list marker where the editor reads one', () => {
    expect(apply('  item', 'bullet')).toBe('  - item');
    expect(apply('   item', 'ordered')).toBe('   1. item');
    expect(apply('    item', 'bullet')).toBe('-     item');
    expect(apply('\titem', 'checklist')).toBe('- [ ] \titem');
    expect(apply('  \titem', 'bullet')).toBe('-   \titem');
    expect(apply('', 'bullet')).toBe('- ');
    expect(apply('   ', 'bullet')).toBe('   - ');
  });

  it('puts a quote at column 0, the only place the editor reads one', () => {
    expect(apply('  item', 'quote')).toBe('>   item');
    expect(apply('  - item', 'quote')).toBe('> item');
  });

  it('does not take an indented heading or quote for one', () => {
    expect(linePrefixAt('  # text')).toBeNull();
    expect(linePrefixAt('\t> text')).toBeNull();
    expect(activeLinePrefixStyles('  # text').heading).toBe(false);
    expect(linePrefixAt('  - text')?.kind).toBe('bullet');
  });
});

describe('cycleHeadingEdit', () => {
  const step = (line: string) => {
    const edit = cycleHeadingEdit(line);
    return line.slice(0, edit.from) + edit.insert + line.slice(edit.to);
  };

  it('steps through the levels and back to none', () => {
    let line = 'item';
    for (const level of [1, 2, 3, 4, 5, 6]) {
      line = step(line);
      expect(line).toBe(`${'#'.repeat(level)} item`);
    }
    expect(step(line)).toBe('item');
  });

  it('puts the heading at column 0, the only place the editor reads one', () => {
    expect(step('  item')).toBe('#   item');
    expect(step('\titem')).toBe('# \titem');
    expect(step('  # item')).toBe('#   # item');
  });

  it('replaces any other block style', () => {
    expect(step('- item')).toBe('# item');
    expect(step('  - item')).toBe('# item');
    expect(step('> item')).toBe('# item');
    expect(step('- [ ] item')).toBe('# item');
  });
});

describe('mapLinePrefixOffset', () => {
  it('moves a content caret by the marker delta', () => {
    const added = toggleLinePrefix('item', 'bullet');
    expect(mapLinePrefixOffset(added, 0)).toBe(2);
    expect(mapLinePrefixOffset(added, 4)).toBe(6);

    const removed = toggleLinePrefix('- item', 'bullet');
    expect(mapLinePrefixOffset(removed, 2)).toBe(0);
    expect(mapLinePrefixOffset(removed, 6)).toBe(4);
  });

  it('moves a caret inside a replaced marker to the new content boundary', () => {
    const edit = toggleLinePrefix('- item', 'checklist');
    expect(mapLinePrefixOffset(edit, 1)).toBe(6);
  });

  it('puts a caret in front of the marker behind the new one', () => {
    const replaced = toggleLinePrefix('- item', 'checklist');
    expect(mapLinePrefixOffset(replaced, 0)).toBe(6);

    const indented = toggleLinePrefix('  - item', 'checklist');
    expect(mapLinePrefixOffset(indented, 0)).toBe(8);
    expect(mapLinePrefixOffset(indented, 1)).toBe(8);
    expect(mapLinePrefixOffset(indented, 2)).toBe(8);

    const inserted = toggleLinePrefix('  item', 'bullet');
    expect(mapLinePrefixOffset(inserted, 1)).toBe(4);
  });

  it('puts a caret in front of a removed marker where the content starts', () => {
    const removed = toggleLinePrefix('  - item', 'bullet');
    expect(mapLinePrefixOffset(removed, 0)).toBe(2);
    expect(mapLinePrefixOffset(removed, 3)).toBe(2);
  });
});

describe('mapLinePrefixPosition', () => {
  /** A press on the head's line, through a real state: an endpoint past the
   *  end of the document throws here as it does in the editor. */
  function press(doc: string, anchor: number, head: number, kind: LinePrefixKind) {
    const state = EditorState.create({ doc, selection: { anchor, head } });
    const line = state.doc.lineAt(head);
    const edit = toggleLinePrefix(line.text, kind);
    const next = state.update({
      changes: { from: line.from + edit.from, to: line.from + edit.to, insert: edit.insert },
      selection: {
        anchor: mapLinePrefixPosition(edit, line.from, anchor),
        head: mapLinePrefixPosition(edit, line.from, head),
      },
    }).state;
    const { from, to } = next.selection.main;
    return { doc: next.doc.toString(), selected: next.sliceDoc(from, to) };
  }

  it('keeps a backward selection when the press shortens the document', () => {
    expect(press('- a\nb', 5, 1, 'bullet')).toEqual({ doc: 'a\nb', selected: 'a\nb' });
  });

  it('keeps a backward selection when the press lengthens the document', () => {
    expect(press('abc\ndef', 7, 1, 'bullet')).toEqual({ doc: '- abc\ndef', selected: 'bc\ndef' });
  });

  it('keeps a forward selection', () => {
    expect(press('abc\ndef', 1, 7, 'bullet')).toEqual({ doc: 'abc\n- def', selected: 'bc\n- def' });
  });

  it('survives every selection of a small document, on every button', () => {
    const kinds: LinePrefixKind[] = ['bullet', 'ordered', 'checklist', 'quote'];
    for (const doc of ['- a\nb', 'abc\ndef', '  - x\n\n> y', '# h\n1. z\n']) {
      for (let anchor = 0; anchor <= doc.length; anchor++) {
        for (let head = 0; head <= doc.length; head++) {
          for (const kind of kinds) {
            expect(() => press(doc, anchor, head, kind), JSON.stringify({ doc, anchor, head, kind })).not.toThrow();
          }
        }
      }
    }
  });

  it('moves nothing on a line before the edit', () => {
    const edit = toggleLinePrefix('item', 'bullet');
    expect(mapLinePrefixPosition(edit, 10, 9)).toBe(9);
  });

  it('moves a position on a line after the edit by the delta', () => {
    const removed = toggleLinePrefix('- item', 'bullet');
    expect(mapLinePrefixPosition(removed, 10, 20)).toBe(18);
    const replaced = toggleLinePrefix('- item', 'checklist');
    expect(mapLinePrefixPosition(replaced, 10, 20)).toBe(24);
  });
});

describe('activeLinePrefixStyles', () => {
  it('reports exactly the style at the caret line', () => {
    expect(activeLinePrefixStyles('- item')).toEqual({
      bullet: true, ordered: false, checklist: false, quote: false, heading: false,
    });
    expect(activeLinePrefixStyles('1. item')).toEqual({
      bullet: false, ordered: true, checklist: false, quote: false, heading: false,
    });
    expect(activeLinePrefixStyles('- [ ] item')).toEqual({
      bullet: false, ordered: false, checklist: true, quote: false, heading: false,
    });
    expect(activeLinePrefixStyles('> item')).toEqual({
      bullet: false, ordered: false, checklist: false, quote: true, heading: false,
    });
    expect(activeLinePrefixStyles('### item')).toEqual({
      bullet: false, ordered: false, checklist: false, quote: false, heading: true,
    });
  });
});
