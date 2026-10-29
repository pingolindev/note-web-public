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

import type { ImportProgress, ImportedNote } from '../types';

/**
 * Parses Evernote ENEX exports — XML wrapping one or more `<note>`
 * elements with `<title>`, `<content>` (ENML / HTML inside a CDATA),
 * `<created>`, `<updated>`, `<tag>`.
 *
 * Mirrors the Note Android app's EvernoteParser and intentionally stays
 * minimal: the body is reduced to plain text (enmlToText), so the
 * imported note is lossy but readable.
 */
export async function* parseEvernoteEnex(file: Blob): AsyncGenerator<ImportProgress> {
  const text = await file.text();

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) {
    yield { kind: 'error', message: `Couldn't parse ENEX XML: ${(e as Error).message}` };
    return;
  }
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    yield { kind: 'error', message: `ENEX XML parse error: ${parserError.textContent ?? 'unknown'}` };
    return;
  }

  const noteEls = Array.from(doc.querySelectorAll('note'));
  let count = 0;
  for (const el of noteEls) {
    const title = el.querySelector('title')?.textContent?.trim() ?? '';
    const rawContent = el.querySelector('content')?.textContent ?? '';
    const body = enmlToText(rawContent);
    const created = parseEnDate(el.querySelector('created')?.textContent);
    const updated = parseEnDate(el.querySelector('updated')?.textContent);
    const tags = Array.from(el.querySelectorAll('tag'))
      .map((t) => t.textContent?.trim() ?? '')
      .filter(Boolean);

    count++;
    yield { kind: 'parsing', current: count, total: noteEls.length, currentTitle: title };

    const note: ImportedNote = {
      title,
      body,
      noteType: 'text',
      checklistItems: null,
      labels: tags,
      color: null,
      isPinned: false,
      isArchived: false,
      createdAt: created,
      updatedAt: updated,
    };
    yield { kind: 'note', note };
  }

  yield { kind: 'done', total: count };
}

/**
 * Crude ENML → plain-text. ENML is a subset of XHTML; we strip
 * tags and decode the common entities so the user sees readable
 * content. There is no HTML→Markdown conversion.
 */
function enmlToText(enml: string): string {
  return enml
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ENEX timestamps look like `20140523T130000Z`. */
function parseEnDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
}
