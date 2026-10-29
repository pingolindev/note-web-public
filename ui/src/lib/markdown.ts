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

import { createSignal } from 'solid-js';
import { pairDelimiterRuns } from './delimiterPairs';

/**
 * KaTeX IS LOADED ON FIRST SIGHT OF MATH, never at boot.
 *
 * It is 272KB raw — on its own the single largest thing the note LIST would
 * drag onto the cold-start path, via NoteCard -> renderMarkdown -> katex. Most
 * notes contain no math at all, so most launches would pay for a typesetter
 * they never use.
 *
 * Until it lands, math renders as its own source text (exactly what the catch
 * arms below do on a KaTeX error), tagged `math-pending` so it can be styled
 * as unfinished rather than looking like a rendering error. [mathReady] is a
 * Solid signal, so any memo that reads it re-runs and upgrades its output the
 * moment the chunk arrives — that is the whole upgrade mechanism, and a caller
 * that forgets to read it simply keeps the source text.
 */
let katex: typeof import('katex').default | null = null;
let katexPending = false;
const [katexLoaded, setKatexLoaded] = createSignal(false);

function ensureKatex(): void {
  if (katex || katexPending) return;
  katexPending = true;
  import('katex')
    .then(m => { katex = m.default; setKatexLoaded(true); })
    // Leave katexPending set: a failed chunk fetch that retried on every
    // keystroke would hammer the network for a cosmetic upgrade.
    .catch(() => { /* math stays as source text */ });
}

/**
 * Reactive "has KaTeX arrived yet". READ THIS inside any memo that renders
 * markdown, or math in that view stays as source text until something else
 * invalidates it.
 */
export function mathReady(): boolean {
  return katexLoaded();
}

const CALLOUT_TYPES = new Set([
  'note', 'info', 'tip', 'success', 'question', 'warning',
  'failure', 'danger', 'bug', 'example', 'quote', 'abstract', 'todo',
]);

/**
 * Minimal markdown to HTML renderer for note preview.
 * Handles: headers, bold, italic, strikethrough, code, links, lists,
 * blockquotes, hr, checklists, callouts, math.
 */
export function renderMarkdown(md: string): string {
  // Process line by line for block-level elements
  const lines = md.split('\n');
  const out: string[] = [];
  let inList = false;
  let inCodeBlock = false;
  let inMathBlock = false;
  let mathLines: string[] = [];
  let inCallout = false;
  let calloutLines: string[] = [];
  let calloutType = 'note';
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Math block ($$...$$)
    if (/^\$\$\s*$/.test(line)) {
      if (inMathBlock) {
        out.push(renderMathBlock(mathLines.join('\n')));
        inMathBlock = false;
        mathLines = [];
      } else {
        closeList();
        closeCallout();
        inMathBlock = true;
      }
      continue;
    }
    if (inMathBlock) {
      mathLines.push(line);
      continue;
    }

    // Code blocks (```)
    if (/^```(.*)$/.test(line)) {
      if (inCodeBlock) {
        out.push('</code></pre>');
        inCodeBlock = false;
        continue;
      } else {
        closeList();
        closeCallout();
        codeLang = line.replace(/^```/, '').trim();
        // codeLang is captured from the raw fence line BEFORE the per-line
        // HTML escape (that only runs on non-code lines below), so it is
        // attacker-controlled. Escape it before interpolating into the
        // double-quoted class attribute — otherwise a body like
        // ```"><img src=x onerror=alert(1)> breaks out and injects markup.
        out.push(`<pre><code${codeLang ? ` class="language-${escapeHtmlAttr(codeLang)}"` : ''}>`);
        inCodeBlock = true;
        continue;
      }
    }
    if (inCodeBlock) {
      out.push(line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '\n');
      continue;
    }

    // Callout opener `> [!type]` or `> [!type] title` — captured before
    // HTML-escaping so we can read the raw markers, then re-escape the
    // body when we flush the callout.
    const calloutOpen = line.match(/^> \[!(\w+)\]\s?(.*)$/);
    if (calloutOpen) {
      closeList();
      closeCallout();
      inCallout = true;
      const rawType = calloutOpen[1].toLowerCase();
      calloutType = CALLOUT_TYPES.has(rawType) ? rawType : 'note';
      if (calloutOpen[2]) calloutLines.push(calloutOpen[2]);
      continue;
    }
    if (inCallout) {
      if (/^> /.test(line)) {
        calloutLines.push(line.slice(2));
        continue;
      }
      if (line === '>') {
        calloutLines.push('');
        continue;
      }
      closeCallout();
      // fall through to process current line as non-callout
    }

    // Escape HTML (but preserve markdown chars)
    line = escapeHtmlText(line);
    // CommonMark backslash escapes: `\#` is a literal `#`, and must be one
    // BEFORE the block rules below look at the line (or `\#` would be prose
    // with a visible backslash on every card) and before inlineFormat (or
    // `\*` would still pair). Sentinels here, restored at the end.
    line = protectEscapes(line);

    // Headers — all six levels, as on both phone clients. This renderer draws
    // the note CARDS, so stopping at three would print `#### ` and below as
    // prose there.
    const headingMatch = line.match(/^(#{1,6}) (.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      out.push(`<h${level}>` + inlineFormat(headingMatch[2]) + `</h${level}>`);
      continue;
    }

    // Horizontal rule. `\s*` matches the editor's own preview decorator
    // (`/^---\s*$/` in markdownDecorations.ts), so a trailing space draws a
    // rule in both places instead of the literal text "---" on the card.
    if (/^---\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    // GFM tables.
    //
    // Card previews must not print a table's pipes verbatim — `|A|B|` on three
    // lines — while the same note shows a table on both phones. Preview mode
    // promises "this is what the note looks like", so raw syntax there is the
    // mode failing at its one job.
    //
    // WHAT MAKES A LINE A TABLE is the DELIMITER ROW under it, not the pipes
    // in it, so this reads ahead one line. A lone `a | b` stays prose, which
    // matters: notes are full of incidental pipes.
    //
    // Read the lookahead RAW. A delimiter row is only `|`, `-`, `:` and
    // spaces — none of which the HTML escape above rewrites — and anything
    // else in it (a backslash included) disqualifies the row, so there is
    // nothing for the escape/protect pass to contribute.
    //
    // TRUNCATION-SAFE by construction, and it has to be: NoteCard renders
    // `body.slice(0, 500)` for every card in the grid. A cut that lands in the
    // delimiter row fails the test and the lines fall through to prose; a cut
    // that lands in a body row yields a short row, padded to the header's
    // width like any other ragged GFM row.
    if (line.includes('|') && i + 1 < lines.length && DELIMITER_ROW.test(lines[i + 1])) {
      const headers = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(cellAlign);
      // GFM: the delimiter row must have exactly as many cells as the header,
      // or the block is not a table at all. Without this a two-line note like
      // "cost | 5" over "----" would become a one-column table.
      if (headers.length === aligns.length) {
        closeList();
        closeCallout();
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
          rows.push(splitTableRow(protectEscapes(escapeHtmlText(lines[j]))));
          j++;
        }
        out.push(renderTable(headers, aligns, rows));
        i = j - 1;
        continue;
      }
    }

    // EVERY BLOCK BELOW RUNS ITS CONTENT THROUGH inlineFormat.
    //
    // Interpolating the raw `$1` would leave inline marks dead everywhere except
    // an ordinary paragraph: "- buy **milk**" would render the asterisks
    // literally, and so would every heading and blockquote. That is not an
    // editor-only detail — this renderer draws the note CARDS.
    //
    // The list rules also accept what the Android and iOS apps accept: `+` as
    // a bullet, up to three spaces of indent, and a capital `[X]`, so the same
    // note renders as a list on a phone and in the browser alike.

    // Blockquote
    const quoteMatch = line.match(/^&gt; (.+)$/);
    if (quoteMatch) {
      closeList();
      out.push('<blockquote>' + inlineFormat(quoteMatch[1]) + '</blockquote>');
      continue;
    }

    // Checklists — before the bullet rule, whose content would swallow "[ ] …".
    const checkMatch = line.match(/^ {0,3}[*+-] \[([ xX])\] (.+)$/);
    if (checkMatch) {
      openList();
      const checked = checkMatch[1] !== ' ';
      // The <label> WRAPS the input, and that is the whole point: a bare
      // `<input type="checkbox">` here has no accessible name, so a screen
      // reader announces "checkbox, unchecked" and nothing about what it is
      // for — the item's text is a sibling text node, not associated with the
      // control. axe reports it as `label`, impact CRITICAL, once per task-list
      // line rendered into a note card
      // (`.note-card-preview > ul > li > input[type="checkbox"]`).
      //
      // `disabled` does NOT satisfy the rule.
      //
      // Wrapping rather than aria-label or aria-hidden, deliberately:
      //   * aria-hidden would match NoteCard's own checklist branch (a drawn,
      //     aria-hidden box) but also hides the CHECKED STATE, which is content
      //     here — `- [x]` and `- [ ]` mean different things and a sighted
      //     reader can see which.
      //   * aria-label would need the item's plain text, and inlineFormat()
      //     returns HTML.
      // A wrapping label names the control from its own content, keeps the
      // state announced, and needs no second copy of the text.
      //
      // Safe for the round trip: htmlToMarkdown's `ul` case finds the input with
      // a depth-agnostic querySelector, `case 'input'` drops it, and the default
      // case recurses through <label> to its text. Safe for styling too — the
      // CSS is `li.check input[type="checkbox"]`, a descendant selector.
      out.push(
        `<li class="check${checked ? ' checked' : ''}">` +
        `<label><input type="checkbox"${checked ? ' checked' : ''} disabled> ` +
        inlineFormat(checkMatch[2]) +
        '</label></li>'
      );
      continue;
    }

    // Unordered list
    const bulletMatch = line.match(/^ {0,3}[*+-] (.+)$/);
    if (bulletMatch) { openList(); out.push('<li>' + inlineFormat(bulletMatch[1]) + '</li>'); continue; }

    // Ordered list
    const orderedMatch = line.match(/^ {0,3}\d+\. (.+)$/);
    if (orderedMatch) { openList(); out.push('<li>' + inlineFormat(orderedMatch[1]) + '</li>'); continue; }

    // Regular line
    closeList();
    if (line.trim() === '') {
      out.push('<br>');
    } else {
      out.push('<div>' + inlineFormat(line) + '</div>');
    }
  }

  closeList();
  closeCallout();
  if (inMathBlock) {
    // Unterminated $$ — drop it back as plain text so we don't lose
    // content; the user can fix the missing closer.
    out.push('<pre>$$\n' + mathLines.join('\n')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>');
  }
  return restoreEscapes(out.join(''));

  function openList() { if (!inList) { out.push('<ul>'); inList = true; } }
  function closeList() { if (inList) { out.push('</ul>'); inList = false; } }
  function closeCallout() {
    if (!inCallout) return;
    inCallout = false;
    const body = renderMarkdown(calloutLines.join('\n'));
    out.push(`<div class="callout callout-${calloutType}">${body}</div>`);
    calloutLines = [];
  }
}

/**
 * A GFM table's delimiter row: `|---|:--:|`, `--- | ---`, `:-|-:` and so on.
 * Only pipes, dashes, colons and whitespace, and at least one dash. Anything
 * else — a letter, a backslash, a stray character from a truncated body —
 * fails, and the lines stay prose.
 */
const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/**
 * Split one table row into cells.
 *
 * Strips at most ONE leading and ONE trailing pipe, so both GFM shapes work:
 * `| a | b |` and the bare `a | b`. Splitting on a plain `|` is correct GFM —
 * `\|` is the only way to put a pipe inside a cell, and by the time a prepared
 * line reaches here an escaped pipe is already a private-use sentinel that
 * cannot split anything.
 */
function splitTableRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

/** Column alignment from one delimiter cell: `:--` `--:` `:-:`. */
function cellAlign(cell: string): '' | 'left' | 'right' | 'center' {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

/**
 * Emit the table.
 *
 * Alignment travels as a CLASS, not a `style` attribute: this HTML is handed
 * to DOMPurify before it reaches innerHTML, and `class` is allowed by the
 * html profile without depending on whether `style` happens to be.
 *
 * Ragged rows are padded and over-long rows truncated to the header's width,
 * which is both what GFM says and what makes a truncated card body safe — the
 * 500-character slice NoteCard renders can end anywhere.
 */
function renderTable(headers: string[], aligns: ReturnType<typeof cellAlign>[], rows: string[][]): string {
  const cell = (tag: 'th' | 'td', text: string, align: ReturnType<typeof cellAlign>): string =>
    `<${tag}${align ? ` class="md-align-${align}"` : ''}>${inlineFormat(text)}</${tag}>`;
  const head = '<thead><tr>'
    + headers.map((h, k) => cell('th', h, aligns[k])).join('')
    + '</tr></thead>';
  const body = rows.length
    ? '<tbody>'
      + rows.map(r => '<tr>'
        + headers.map((_, k) => cell('td', r[k] ?? '', aligns[k])).join('')
        + '</tr>').join('')
      + '</tbody>'
    : '';
  return `<table class="md-table">${head}${body}</table>`;
}

/** The renderer's outer escape: the three characters that could otherwise
 *  start markup. Markdown punctuation is deliberately left alone. */
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMathBlock(latex: string): string {
  if (!katex) {
    ensureKatex();
    return `<div class="math-block math-pending">${escapeHtmlText(latex)}</div>`;
  }
  try {
    return `<div class="math-block">${katex.renderToString(latex, {
      throwOnError: false,
      displayMode: true,
      output: 'html',
    })}</div>`;
  } catch {
    return `<pre>${latex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
  }
}

function renderMathInline(latex: string): string {
  if (!katex) {
    ensureKatex();
    return `<span class="math-pending">${escapeHtmlText(latex)}</span>`;
  }
  try {
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode: false,
      output: 'html',
    });
  } catch {
    return latex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

/** Apply inline formatting: bold, italic, strikethrough, code, links.
 *  The outer renderer HTML-escapes `&`, `<`, `>` before this runs, so
 *  text content injected via $1 is safe. Attribute-injection via
 *  link URLs is NOT — `"` isn't escaped upstream, and `javascript:`
 *  / `data:` / `vbscript:` schemes are live XSS vectors. sanitizeHref
 *  below handles both. */
function inlineFormat(text: string): string {
  // PRECEDENCE must match the editor's preview decorator
  // (applyInlineDecorations): math, then inline CODE, then links, and only
  // then the emphasis family. Running emphasis FIRST would bold the stars
  // inside a code span (`` `**` ``) and let a `*` inside a URL italicize
  // half an href — the preview and the card would disagree about the same
  // line. Code/link/math bodies are stashed behind \x00 placeholders so the
  // emphasis passes cannot see into them, mirroring the decorator's
  // `consumed` ranges.
  const stash: string[] = [];
  const put = (html: string): string => {
    stash.push(html);
    return `\x00${stash.length - 1}\x00`;
  };
  let out = text
    // Inline math first — its content shouldn't be re-processed for
    // markdown syntax (e.g. `\_` in LaTeX must not become italic).
    .replace(/(?<![\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_m, latex: string) =>
      put(renderMathInline(unescapeHtml(latex))))
    .replace(/`([^`]+)`/g, (_m, code: string) => put(`<code>${code}</code>`))
    .replace(/\[(.+?)\]\((.+?)\)/g,
      (_m, label: string, url: string) =>
        put(`<a href="${sanitizeHref(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`))
    // `__x__` is STRONG, not underline (CommonMark/Obsidian/Markwon all
    // agree); word-boundary guards keep `some_method_name` an identifier.
    // The underscore family stays regex on BOTH sides — only the
    // star/tilde/backtick family uses the shared pairing parser.
    .replace(/(?<![\w_])__(.+?)__(?![\w_])/g, '<strong>$1</strong>')
    .replace(/(?<![\w_])_(?!_)(.+?)(?<!_)_(?![\w_])/g, '<em>$1</em>');
  // STAR / TILDE / stray-BACKTICK family — the SAME delimiter-run pairing
  // parser the preview decorator uses (lib/delimiterPairs.ts), applied by
  // per-character style flags: paired markers and empty-pair halves drop,
  // styled spans emit properly nested tags even when constructs cross.
  out = ((): string => {
    const res = pairDelimiterRuns(out);
    const n = out.length;
    const drop = new Uint8Array(n);
    for (const [a, b] of res.markers) for (let i = a; i < b; i++) drop[i] = 1;
    for (const [a, b] of res.pairHalves) for (let i = a; i < b; i++) drop[i] = 1;
    const fb = new Uint8Array(n);
    const fi = new Uint8Array(n);
    const fs = new Uint8Array(n);
    for (const st of res.styles) {
      for (let i = st.from; i < st.to; i++) {
        if (st.bold) fb[i] = 1;
        if (st.italic) fi[i] = 1;
        if (st.strike) fs[i] = 1;
      }
    }
    let html = '';
    let cb = 0, ci = 0, cs = 0;
    const closeAll = () => {
      if (ci) html += '</em>';
      if (cb) html += '</strong>';
      if (cs) html += '</s>';
      cb = ci = cs = 0;
    };
    for (let i = 0; i < n; i++) {
      if (drop[i]) continue;
      if (fb[i] !== cb || fi[i] !== ci || fs[i] !== cs) {
        closeAll();
        if (fs[i]) { html += '<s>'; cs = 1; }
        if (fb[i]) { html += '<strong>'; cb = 1; }
        if (fi[i]) { html += '<em>'; ci = 1; }
      }
      html += out[i];
    }
    closeAll();
    return html;
  })();
  // Restore stashed spans (a stashed body never contains \x00 itself).
  out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => stash[Number(i)]);
  return out;
}

/**
 * CommonMark backslash escapes, the way Preview writes them when "Interpret
 * markdown" is off: a backslash before ASCII punctuation makes that character
 * literal (`\# Heading` is a paragraph reading "# Heading"). Without this the
 * backslash itself would be drawn on every card.
 *
 * Each escaped character becomes one private-use code point (U+E100 + its
 * ASCII code) so neither the block rules nor `inlineFormat` can see it;
 * `restoreEscapes` puts the character back at the very end, HTML-escaped
 * where the outer escape would have applied. The three characters the outer
 * pass has ALREADY turned into entities arrive as `\&lt;` etc. and are
 * matched in that form. Backslashes inside a code span stay literal, as
 * CommonMark says.
 */
const ESC_BASE = 0xE100;
const ENTITY_ESC: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&' };
function protectEscapes(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '`') {
      // Copy a whole code span through untouched (its closer is the same run
      // length); an unmatched run is ordinary text.
      const run = /^`+/.exec(line.slice(i))![0];
      const close = line.indexOf(run, i + run.length);
      if (close !== -1 && line[close + run.length] !== '`') {
        out += line.slice(i, close + run.length);
        i = close + run.length;
        continue;
      }
      out += run;
      i += run.length;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      const rest = line.slice(i + 1);
      const ent = /^(&lt;|&gt;|&amp;)/.exec(rest);
      if (ent) {
        out += String.fromCharCode(ESC_BASE + ENTITY_ESC[ent[1]].charCodeAt(0));
        i += 1 + ent[1].length;
        continue;
      }
      const code = rest.charCodeAt(0);
      // ASCII punctuation: !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
      if ((code >= 0x21 && code <= 0x2f) || (code >= 0x3a && code <= 0x40)
          || (code >= 0x5b && code <= 0x60) || (code >= 0x7b && code <= 0x7e)) {
        out += String.fromCharCode(ESC_BASE + code);
        i += 2;
        // An escaped delimiter neutralises its whole run: `\```` is a literal
        // fence and `\***` a literal break, not one literal character followed
        // by an emphasis or code opener the pairing pass would swallow.
        const d = rest[0];
        if (d === '`' || d === '*' || d === '_' || d === '~') {
          while (i < line.length && line[i] === d) { out += String.fromCharCode(ESC_BASE + code); i++; }
        }
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
function restoreEscapes(html: string): string {
  return html.replace(/[\uE100-\uE17F]/g, (m) => {
    const c = String.fromCharCode(m.charCodeAt(0) - ESC_BASE);
    return c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c;
  });
}

/** Reverse the HTML escape the outer renderer applied — KaTeX needs
 *  raw `&`, `<`, `>` to parse LaTeX correctly. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Escape the five HTML-significant characters so a string is safe to
 *  interpolate into element text or a double-quoted attribute value. */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip dangerous URL schemes + escape characters that could break
 * out of the href attribute.
 *
 * Attack surface: the markdown of a note is attacker-controlled once
 * decrypted (a note shared with you is written by someone else), and
 * this renderer turns it into HTML that's assigned via `innerHTML`.
 * Without this guard a note containing
 * `[x](javascript:alert(document.cookie))` would let the note's author
 * run arbitrary JS in a recipient's browser. */
function sanitizeHref(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  // Lowercase prefix check — tolerate whitespace between `:` and
  // letters (browsers accept `java\nscript:` too) by stripping all
  // ASCII control chars before comparison.
  const stripped = trimmed
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .toLowerCase();
  const dangerous = ['javascript:', 'data:', 'vbscript:', 'file:'];
  for (const scheme of dangerous) {
    if (stripped.startsWith(scheme)) return '#';
  }
  // HTML-attribute-escape the chars that could break out of href="…".
  // `&` and `<` were already handled upstream but we re-apply defensively
  // so the function is safe to call in isolation.
  return trimmed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
