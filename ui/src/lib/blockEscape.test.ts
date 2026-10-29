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

/**
 * Which typed characters get a backslash when "Interpret markdown" is off.
 *
 * The rule that matters is POSITIONAL: a marker is only escaped where it
 * would actually create a block. Escaping on sight turns "C# is a language"
 * into "C\# is a language" — wrong, and visible as noise in the other two
 * modes, which show raw source.
 *
 * The offsets are asserted rather than a boolean, because CommonMark escapes
 * a specific character: `1\. ` and not `\1. `, and the marker of an indented
 * list item rather than its leading space.
 */
import { describe, it, expect } from 'vitest';
import { blockEscapeOffset, escapedBlockMarkerOffset } from './blockEscape';

const at = (line: string) => blockEscapeOffset(line);

/** Apply the escape `blockEscapeOffset` prescribes, the way the editor does. */
const escaped = (line: string) => {
  const off = blockEscapeOffset(line);
  return off < 0 ? line : line.slice(0, off) + '\\' + line.slice(off);
};

describe('escapedBlockMarkerOffset', () => {
  it('finds the backslash the escaper wrote, for every marker it writes', () => {
    // The two functions describe the same documents from both sides: what
    // one inserts, the other must locate — and Preview then hides it.
    for (const line of ['# H', '###### H', '- x', '* x', '+ x', '   - x', '1. x', '10) x', '> x', '---', '___', '***', '```', '```js', '~~~']) {
      const off = blockEscapeOffset(line);
      expect(escapedBlockMarkerOffset(escaped(line))).toBe(off);
    }
  });

  it('an escaped heading, bullet, numbered item and quote, at their exact offsets', () => {
    expect(escapedBlockMarkerOffset('\\# Heading one')).toBe(0);
    expect(escapedBlockMarkerOffset('\\- first item')).toBe(0);
    expect(escapedBlockMarkerOffset('1\\. numbered')).toBe(1);
    expect(escapedBlockMarkerOffset('\\> a quote')).toBe(0);
  });

  it('ignores backslashes that do not neutralise a block', () => {
    expect(escapedBlockMarkerOffset('C\\# is a language')).toBe(-1);
    expect(escapedBlockMarkerOffset('\\#hashtag')).toBe(-1);
    expect(escapedBlockMarkerOffset('a \\> b')).toBe(-1);
    expect(escapedBlockMarkerOffset('\\')).toBe(-1);
    expect(escapedBlockMarkerOffset('')).toBe(-1);
    expect(escapedBlockMarkerOffset('# real heading')).toBe(-1);
  });
});

describe('blockEscapeOffset', () => {
  describe('escapes where a block would form', () => {
    it('headings, all six levels, at the first hash', () => {
      expect(at('# H')).toBe(0);
      expect(at('###### H')).toBe(0);
    });

    it('every bullet marker', () => {
      expect(at('- x')).toBe(0);
      expect(at('* x')).toBe(0);
      expect(at('+ x')).toBe(0);
    });

    it('an indented bullet, at the marker and not the indent', () => {
      expect(at('   - x')).toBe(3);
    });

    it('an ordered item, at the DELIMITER — CommonMark escapes `1\\. `', () => {
      expect(at('1. x')).toBe(1);
      expect(at('10) x')).toBe(2);
    });

    it('a quote', () => {
      expect(at('> x')).toBe(0);
    });

    it('a thematic break of any of the three characters', () => {
      expect(at('---')).toBe(0);
      expect(at('___')).toBe(0);
      expect(at('***')).toBe(0);
      expect(at('----')).toBe(0);
    });

    it('a fence', () => {
      expect(at('```')).toBe(0);
      expect(at('```js')).toBe(0);
      expect(at('~~~')).toBe(0);
    });
  });

  describe('leaves alone what would not form a block', () => {
    it('a hash mid-line', () => {
      expect(at('C# is a language')).toBe(-1);
      expect(at('issue #42')).toBe(-1);
    });

    it('a hash with no space after it', () => {
      expect(at('#hashtag')).toBe(-1);
    });

    it('a lone dash or two — a break needs three', () => {
      expect(at('-')).toBe(-1);
      expect(at('--')).toBe(-1);
    });

    it('a dash with no space, which is a word not a bullet', () => {
      expect(at('-notalist')).toBe(-1);
    });

    it('arithmetic and prose punctuation', () => {
      expect(at('2 * 3 = 6')).toBe(-1);
      expect(at('a > b')).toBe(-1);
      expect(at('e.g. 1. one')).toBe(-1);
    });

    it('inline emphasis, which is deliberately never escaped', () => {
      // `*emphasis*` becoming italic is behaviour people who do not write
      // markdown still want, and escaping every `*` would litter a note.
      expect(at('some *emphasis* here')).toBe(-1);
      expect(at('__bold__ and `code`')).toBe(-1);
    });

    it('an empty line', () => {
      expect(at('')).toBe(-1);
    });
  });
});
