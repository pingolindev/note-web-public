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
import { renderMarkdown } from './markdown';

/**
 * The preview renderer, construct by construct.
 *
 * WHY THE CASES LOOK LIKE THIS
 *   The same note has to render the same on three clients. These mirror the
 *   Android and iOS markdown tests case for case, so a divergence shows up as
 *   a failing test on one platform rather than as a user noticing their
 *   checklist is missing on their phone.
 *
 *   Some cases are there because the two mobile clients accept the construct and
 *   this renderer has to as well, or it would drop to plain prose: `+` bullets,
 *   `- [X]` with a capital X, and list items indented by up to three spaces.
 */
describe('renderMarkdown', () => {
  describe('headings', () => {
    it('renders all six levels', () => {
      // All six levels, as on both phone clients: a renderer that stopped at
      // three would print `#### ` and below as prose on the note cards.
      expect(renderMarkdown('# One')).toContain('<h1>One</h1>');
      expect(renderMarkdown('## Two')).toContain('<h2>Two</h2>');
      expect(renderMarkdown('### Three')).toContain('<h3>Three</h3>');
      expect(renderMarkdown('#### Four')).toContain('<h4>Four</h4>');
      expect(renderMarkdown('##### Five')).toContain('<h5>Five</h5>');
      expect(renderMarkdown('###### Six')).toContain('<h6>Six</h6>');
    });

    it('leaves a seventh hash as prose', () => {
      const html = renderMarkdown('####### Seven');
      expect(html).not.toContain('<h6>');
      expect(html).toContain('####### Seven');
    });

    it('needs a space after the hashes', () => {
      expect(renderMarkdown('#NotAHeading')).not.toContain('<h1>');
    });
  });

  describe('bullets', () => {
    it('accepts every marker the mobile clients accept', () => {
      for (const marker of ['-', '*', '+']) {
        expect(renderMarkdown(`${marker} item`), `marker '${marker}'`).toContain('<li>item</li>');
      }
    });

    it('keeps consecutive items inside one list', () => {
      const html = renderMarkdown('- one\n- two');
      expect(html).toContain('<li>one</li>');
      expect(html).toContain('<li>two</li>');
      expect(html.match(/<ul>/g) ?? []).toHaveLength(1);
    });

    it('accepts up to three spaces of indent and stops at four', () => {
      for (const indent of ['', ' ', '  ', '   ']) {
        expect(renderMarkdown(`${indent}- item`), `indent ${indent.length}`)
          .toContain('<li>item</li>');
      }
      // Four spaces is a code indent in markdown, not a list.
      expect(renderMarkdown('    - item')).not.toContain('<li>item</li>');
    });

    it('survives blank lines before and after the list', () => {
      const html = renderMarkdown('intro\n\n- one\n- two\n\noutro');
      expect(html).toContain('<li>one</li>');
      expect(html).toContain('<li>two</li>');
      expect(html).toContain('intro');
      expect(html).toContain('outro');
    });
  });

  describe('ordered lists', () => {
    it('renders numbered items', () => {
      expect(renderMarkdown('1. first')).toContain('<li>first</li>');
    });

    it('accepts indent like unordered items do', () => {
      expect(renderMarkdown('  2. second')).toContain('<li>second</li>');
    });
  });

  describe('checklists', () => {
    it('renders an unchecked box', () => {
      const html = renderMarkdown('- [ ] milk');
      expect(html).toContain('<input type="checkbox" disabled>');
      expect(html).toContain('milk');
      expect(html).not.toContain('checked');
    });

    it('renders a checked box', () => {
      expect(renderMarkdown('- [x] eggs')).toContain('<input type="checkbox" checked disabled>');
    });

    it('accepts a capital X, as the mobile clients do', () => {
      expect(renderMarkdown('- [X] eggs')).toContain('<input type="checkbox" checked disabled>');
    });

    it('accepts every list marker and indent a bullet accepts', () => {
      for (const marker of ['-', '*', '+']) {
        expect(renderMarkdown(`${marker} [ ] task`), `marker '${marker}'`)
          .toContain('<input type="checkbox" disabled>');
      }
      expect(renderMarkdown('  - [ ] task')).toContain('<input type="checkbox" disabled>');
    });

    it('is a checkbox, never a plain bullet', () => {
      // The bullet rule would otherwise swallow "[ ] …" as item text.
      expect(renderMarkdown('- [ ] milk')).not.toContain('<li>[ ] milk</li>');
    });

    it('still applies inline formatting to the item text', () => {
      expect(renderMarkdown('- [ ] buy **milk**')).toContain('<strong>milk</strong>');
    });

    it('mixes with plain bullets in one list', () => {
      const html = renderMarkdown('- plain\n- [ ] todo');
      expect(html).toContain('<li>plain</li>');
      expect(html).toContain('<input type="checkbox" disabled>');
      expect(html.match(/<ul>/g) ?? []).toHaveLength(1);
    });

    /**
     * THE BOX MUST HAVE AN ACCESSIBLE NAME.
     *
     * A bare `<input type="checkbox">` has none: the item's text is a sibling
     * text node, not associated with the control, so a screen reader announces
     * "checkbox, unchecked" and nothing about what it is for. axe reports it as
     * `label`, impact CRITICAL, once per task-list line rendered into a note card
     * (`.note-card-preview > ul > li > input[type="checkbox"]`).
     *
     * `disabled` does NOT satisfy the rule. Only a name does.
     *
     * The assertions below are deliberately about the SHAPE, because the shape
     * is what names it: the label has to ENCLOSE the text. An empty
     * `<label></label>` beside the input would satisfy any "is there a label"
     * check while naming nothing at all. The other assertions in this block use
     * `toContain` over the `<input …>` substring, so every one of them would
     * still pass with the wrapper removed — none of them can protect this.
     */
    it('wraps the box and its text in ONE label, which is what names it', () => {
      expect(renderMarkdown('- [ ] milk'))
        .toMatch(/<label><input type="checkbox" disabled> milk<\/label><\/li>/);
    });

    it('names a CHECKED box the same way', () => {
      expect(renderMarkdown('- [x] eggs'))
        .toMatch(/<label><input type="checkbox" checked disabled> eggs<\/label><\/li>/);
    });

    it('keeps formatted item text INSIDE the label', () => {
      // inlineFormat() output is part of the accessible name, so it has to land
      // inside the label rather than after it.
      expect(renderMarkdown('- [ ] buy **milk**'))
        .toMatch(/<label><input type="checkbox" disabled> buy <strong>milk<\/strong><\/label>/);
    });
  });

  describe('inline marks', () => {
    it('renders each mark', () => {
      expect(renderMarkdown('**b**')).toContain('<strong>b</strong>');
      expect(renderMarkdown('*i*')).toContain('<em>i</em>');
      expect(renderMarkdown('_i_')).toContain('<em>i</em>');
      expect(renderMarkdown('~~s~~')).toContain('<s>s</s>');
      expect(renderMarkdown('`c`')).toContain('<code>c</code>');
      expect(renderMarkdown('***both***')).toContain('<strong><em>both</em></strong>');
    });

    it('renders __x__ as strong, the same as everyone else', () => {
      // Never `<u>`: CommonMark, Obsidian and Android's Markwon all read
      // `__x__` as bold, so a note written here would otherwise change
      // meaning as soon as it was read anywhere else. Obsidian 1.13.4
      // renders `<strong>ubar</strong>`.
      expect(renderMarkdown('__u__')).toContain('<strong>u</strong>');
      expect(renderMarkdown('__u__')).not.toContain('<u>');
    });

    it('renders _x_ as emphasis', () => {
      expect(renderMarkdown('_e_')).toContain('<em>e</em>');
    });

    it('leaves snake_case identifiers alone', () => {
      // `_(.+?)_` with no boundary guard turns `some_method_name` into
      // `some<em>method</em>name`. The editor's decoration guards against it,
      // so without the same guard here the card and the editor would disagree
      // about the same line.
      const html = renderMarkdown('call some_method_name here');
      expect(html).not.toContain('<em>');
      expect(html).toContain('some_method_name');
    });

    it('links render with a safe target', () => {
      const html = renderMarkdown('[label](https://example.com)');
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain('rel="noopener noreferrer"');
    });

    it('refuses a javascript: URL', () => {
      expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:');
    });
  });

  describe('inline marks inside block constructs', () => {
    // inlineFormat must run inside every block construct, not only ordinary
    // paragraphs: otherwise every block below renders its markers literally —
    // in the note cards, not just the editor.
    it('formats inside a heading', () => {
      expect(renderMarkdown('# A **bold** title')).toContain('<strong>bold</strong>');
    });

    it('formats inside a bullet', () => {
      expect(renderMarkdown('- an *italic* item')).toContain('<em>italic</em>');
    });

    it('formats inside an ordered item', () => {
      expect(renderMarkdown('1. a `code` step')).toContain('<code>code</code>');
    });

    it('formats inside a blockquote', () => {
      expect(renderMarkdown('> a ~~struck~~ quote')).toContain('<s>struck</s>');
    });

    it('formats a link inside a bullet', () => {
      expect(renderMarkdown('- see [docs](https://example.com)')).toContain('href="https://example.com"');
    });
  });

  describe('blocks', () => {
    it('renders a horizontal rule', () => {
      expect(renderMarkdown('---')).toContain('<hr>');
    });

    it('renders a blockquote', () => {
      expect(renderMarkdown('> quoted')).toContain('<blockquote>quoted</blockquote>');
    });

    it('renders a fenced code block with its language', () => {
      const html = renderMarkdown('```js\nlet x = 1;\n```');
      expect(html).toContain('<pre><code class="language-js">');
      expect(html).toContain('let x = 1;');
    });

    it('leaves markdown inside a fence alone', () => {
      expect(renderMarkdown('```\n**not bold**\n```')).not.toContain('<strong>');
    });

    it('escapes HTML in ordinary text', () => {
      expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>');
    });
  });
});

/**
 * CommonMark backslash escapes — what Preview writes when "Interpret markdown"
 * is off. The renderer draws the cards, and must not show the backslash
 * itself: `\# Heading one` on every card of a note whose author asked for a
 * plain `#`.
 */
describe('backslash escapes', () => {
  it('an escaped block marker is prose, without the backslash', () => {
    expect(renderMarkdown('\\# Heading one')).toBe('<div># Heading one</div>');
    expect(renderMarkdown('\\- first item')).toBe('<div>- first item</div>');
    expect(renderMarkdown('1\\. numbered')).toBe('<div>1. numbered</div>');
    expect(renderMarkdown('\\> a quote')).toBe('<div>&gt; a quote</div>');
  });

  it('an escaped inline marker is literal, not emphasis', () => {
    expect(renderMarkdown('2 \\* 3 and \\*not italic\\*')).toBe('<div>2 * 3 and *not italic*</div>');
    expect(renderMarkdown('\\[not](a link)')).toBe('<div>[not](a link)</div>');
  });

  it('inside a code span the backslash stays, as CommonMark says', () => {
    expect(renderMarkdown('`\\#` literal')).toBe('<div><code>\\#</code> literal</div>');
  });

  it('a backslash before a letter or at the end is just a backslash', () => {
    expect(renderMarkdown('C:\\path and trailing \\')).toBe('<div>C:\\path and trailing \\</div>');
  });

  it('an escaped angle bracket still comes out HTML-safe', () => {
    expect(renderMarkdown('\\<b\\>')).toBe('<div>&lt;b&gt;</div>');
  });

  it('a real heading next to an escaped one keeps both meanings', () => {
    expect(renderMarkdown('# Real\n\\# Not')).toBe('<h1>Real</h1><div># Not</div>');
  });
});

describe('escaped delimiter runs', () => {
  it('an escaped fence or break is the whole literal run', () => {
    expect(renderMarkdown('\\```')).toBe('<div>```</div>');
    expect(renderMarkdown('\\```js')).toBe('<div>```js</div>');
    expect(renderMarkdown('\\***')).toBe('<div>***</div>');
    expect(renderMarkdown('\\---')).toBe('<div>---</div>');
  });
});

/**
 * GFM tables.
 *
 * Card previews must draw a table, as both phone clients do from the same
 * note, instead of printing its pipes verbatim. Preview mode's promise is that
 * it always renders, so raw syntax there is the mode failing.
 *
 * The cases that matter most are the NEGATIVE ones and the TRUNCATED ones:
 * NoteCard renders `body.slice(0, 500)` for every card in the grid, so a cut
 * can land anywhere, and notes are full of incidental pipes that must stay
 * prose.
 */
describe('tables', () => {
  it('renders a table with a header, a delimiter row and body rows', () => {
    expect(renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')).toBe(
      '<table class="md-table"><thead><tr><th>A</th><th>B</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    );
  });

  it('accepts the pipeless GFM shape as well as the fenced one', () => {
    expect(renderMarkdown('A | B\n--- | ---\n1 | 2')).toContain('<th>A</th><th>B</th>');
  });

  it('carries column alignment as a class, not a style attribute', () => {
    // A class survives DOMPurify's html profile without depending on whether
    // `style` happens to be allowed; sanitizeHtml() is between this and the DOM.
    const html = renderMarkdown('| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
    expect(html).toContain('<th class="md-align-left">L</th>');
    expect(html).toContain('<th class="md-align-center">C</th>');
    expect(html).toContain('<th class="md-align-right">R</th>');
    expect(html).toContain('<td class="md-align-right">3</td>');
  });

  it('leaves a line of incidental pipes as prose when no delimiter row follows', () => {
    // The single most important negative case: `cost | 5` in an ordinary note
    // must not become a table.
    expect(renderMarkdown('cost | 5')).toBe('<div>cost | 5</div>');
    expect(renderMarkdown('cost | 5\nmore | text')).toBe('<div>cost | 5</div><div>more | text</div>');
  });

  it('needs the delimiter row to have the header\'s column count', () => {
    // Two header cells over a one-cell delimiter is not a table; the `---`
    // keeps its own meaning as a rule.
    expect(renderMarkdown('cost | 5\n---')).toBe('<div>cost | 5</div><hr>');
  });

  it('pads a short row and drops cells past the header width', () => {
    const html = renderMarkdown('| A | B |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |');
    expect(html).toContain('<tr><td>1</td><td></td></tr>');
    expect(html).toContain('<tr><td>1</td><td>2</td></tr>');
    expect(html).not.toContain('<td>3</td>');
  });

  it('survives a truncation that lands in the delimiter row', () => {
    // 500-character slice cutting here: the row fails the delimiter test and
    // the lines fall back to prose, as they do without table support.
    expect(renderMarkdown('| A | B |\n|---|-')).toBe(
      '<table class="md-table"><thead><tr><th>A</th><th>B</th></tr></thead></table>'
    );
    expect(renderMarkdown('| A | B |\n|--')).toBe('<div>| A | B |</div><div>|--</div>');
  });

  it('survives a truncation that lands in a body row', () => {
    expect(renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4'))
      .toContain('<tr><td>3</td><td>4</td></tr>');
  });

  it('formats inline marks inside cells', () => {
    const html = renderMarkdown('| A | B |\n|---|---|\n| **b** | `c` |');
    expect(html).toContain('<td><strong>b</strong></td>');
    expect(html).toContain('<td><code>c</code></td>');
  });

  it('keeps an escaped pipe inside its cell instead of splitting on it', () => {
    // Escapes survive table parsing: `\|` is a literal pipe, and by the
    // time splitTableRow sees it, it is a sentinel that cannot split.
    expect(renderMarkdown('| A | B |\n|---|---|\n| a \\| b | c |'))
      .toContain('<td>a | b</td>');
  });

  it('escapes HTML inside a cell', () => {
    expect(renderMarkdown('| A |\n|---|\n| <img src=x onerror=alert(1)> |'))
      .toContain('<td>&lt;img src=x onerror=alert(1)&gt;</td>');
  });

  it('ends the table at the first line without a pipe', () => {
    expect(renderMarkdown('| A |\n|---|\n| 1 |\n\nafter'))
      .toBe('<table class="md-table"><thead><tr><th>A</th></tr></thead>'
        + '<tbody><tr><td>1</td></tr></tbody></table><br><div>after</div>');
  });
});

describe('horizontal rule', () => {
  it('tolerates trailing whitespace, matching the editor preview decorator', () => {
    // markdownDecorations.ts tests `/^---\s*$/`; a renderer testing `/^---$/`
    // would draw a rule in the editor for one trailing space and the literal text
    // "---" on the card.
    expect(renderMarkdown('--- ')).toBe('<hr>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });
});
