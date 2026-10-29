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
import { mathReady, renderMarkdown } from './markdown';

/**
 * Math renders WITHOUT KaTeX loaded, and safely.
 *
 * KaTeX is 272KB raw; reached statically from the note list (NoteCard ->
 * renderMarkdown -> katex), it would make every cold start download, parse
 * and compile a typesetter that most notes never need. It is a dynamic
 * import, which means there is a window — the first few hundred ms, and
 * forever if the chunk fetch fails — where renderMarkdown must produce
 * something sane on its own.
 *
 * These tests run in exactly that state: nothing here awaits the import, so
 * `katex` is still null inside the module and this is the pre-upgrade path.
 *
 * The escaping case is the one that matters beyond cosmetics. In this state
 * the LaTeX source reaches innerHTML as raw text instead of going through
 * KaTeX, so a `<` in a formula has to come out escaped or math becomes an
 * HTML injection vector. sanitizeHtml is a second line of defence, not a
 * licence to emit markup here.
 */
describe('math before KaTeX has loaded', () => {
  it('starts out not ready', () => {
    expect(mathReady()).toBe(false);
  });

  it('renders a block formula as its own source, marked pending', () => {
    // Block math is `$$` alone on its own line, both ends (see renderMarkdown).
    const html = renderMarkdown('$$\na^2 + b^2\n$$');
    expect(html).toContain('math-pending');
    expect(html).toContain('a^2 + b^2');
    // Not a KaTeX render — no typeset output should appear.
    expect(html).not.toContain('katex');
  });

  it('renders an inline formula as its own source, marked pending', () => {
    const html = renderMarkdown('before $x_1$ after');
    expect(html).toContain('math-pending');
    expect(html).toContain('x_1');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('ESCAPES the LaTeX source rather than emitting markup', () => {
    const html = renderMarkdown('$$\n<img src=x onerror=alert(1)>\n$$');
    expect(html).toContain('&lt;');
    expect(html).not.toContain('<img');
    const inline = renderMarkdown('a $<script>alert(1)</script>$ b');
    expect(inline).not.toContain('<script>');
    expect(inline).toContain('&lt;');
  });

  it('leaves ordinary markdown untouched', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });
});
