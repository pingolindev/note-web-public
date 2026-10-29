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
 * Convert HTML to Markdown.
 * Handles: bold, italic, underline, strikethrough, links, lists, headers, code, blockquotes, hr.
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return convertChildren(doc.body)
    .replace(/\n{2,}/g, '\n')  // Collapse any double+ newlines to single
    .trim();
}

function convertChildren(el: Node): string {
  return Array.from(el.childNodes).map(convertNode).join('');
}

function convertNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || '';
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = () => convertChildren(el);
  const trimmed = () => inner().trim();

  switch (tag) {
    case 'b':
    case 'strong':
      return `**${trimmed()}**`;

    case 'i':
    case 'em':
      return `*${trimmed()}*`;

    case 'u':
      return `__${trimmed()}__`;

    case 's':
    case 'strike':
    case 'del':
      return `~~${trimmed()}~~`;

    case 'code': {
      // If inside a <pre>, it's a code block; otherwise inline code
      if (el.parentElement?.tagName.toLowerCase() === 'pre') {
        const lang = el.className?.replace('language-', '') || '';
        return `\`\`\`${lang}\n${el.textContent || ''}\`\`\`\n`;
      }
      return `\`${trimmed()}\``;
    }

    case 'pre':
      // The <code> child handles the conversion
      return inner();

    case 'a': {
      const href = el.getAttribute('href') || '';
      return `[${trimmed()}](${href})`;
    }

    case 'h1': return `# ${trimmed()}\n`;
    case 'h2': return `## ${trimmed()}\n`;
    case 'h3': return `### ${trimmed()}\n`;
    case 'h4': return `#### ${trimmed()}\n`;

    case 'hr': return '---\n';

    case 'br': return '\n';

    case 'blockquote':
      return trimmed().split('\n').map(l => `> ${l}`).join('\n') + '\n';

    case 'ul':
      return Array.from(el.children).map(li => {
        const cb = (li as HTMLElement).querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        const t = convertNode(li).trim();
        if (cb) return cb.checked ? `- [x] ${t}` : `- [ ] ${t}`;
        return `- ${t}`;
      }).join('\n') + '\n';

    case 'ol':
      return Array.from(el.children).map((li, i) =>
        `${i + 1}. ${convertNode(li).trim()}`
      ).join('\n') + '\n';

    case 'li':
      return inner();

    case 'input':
      return '';

    // execCommand produces <font> and <span style> for colors — strip to plain text
    case 'font':
    case 'span':
      return inner();

    case 'p':
    case 'div': {
      // contentEditable wraps lines in <div> or <p>
      const c = trimmed();
      if (!c) return '\n';
      return c + '\n';
    }

    default:
      return inner();
  }
}
