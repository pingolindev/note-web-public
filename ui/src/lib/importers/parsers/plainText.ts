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

import JSZip from 'jszip';
import type { ImportProgress, ImportedNote } from '../types';

/**
 * Imports a single `.txt` / `.md` file as one note (first line → title),
 * or a `.zip` archive of plain-text/markdown files as one note per
 * archive entry.
 *
 * Mirrors the Android app's PlainTextParser.
 */
export async function* parsePlainText(file: File): AsyncGenerator<ImportProgress> {
  const isZip = file.type === 'application/zip' || file.type === 'application/x-zip-compressed';

  if (isZip) {
    yield* parsePlainTextZip(file);
  } else {
    yield* parseSingle(file);
  }
}

async function* parseSingle(file: Blob): AsyncGenerator<ImportProgress> {
  const text = await file.text();
  const { title, body } = splitTitleBody(text);
  yield { kind: 'parsing', current: 1, total: 1, currentTitle: title };
  yield { kind: 'note', note: toNote(title, body) };
  yield { kind: 'done', total: 1 };
}

async function* parsePlainTextZip(file: Blob): AsyncGenerator<ImportProgress> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (e) {
    yield { kind: 'error', message: `Couldn't open ZIP: ${(e as Error).message}` };
    return;
  }
  const entries = Object.values(zip.files).filter((e) => {
    if (e.dir) return false;
    const n = e.name.toLowerCase();
    return n.endsWith('.txt') || n.endsWith('.md') || n.endsWith('.markdown');
  });

  let count = 0;
  for (const entry of entries) {
    let text: string;
    try {
      text = await entry.async('string');
    } catch {
      continue;
    }
    const { title, body } = splitTitleBody(text);
    count++;
    yield { kind: 'parsing', current: count, total: entries.length, currentTitle: title };
    yield { kind: 'note', note: toNote(title, body) };
  }
  yield { kind: 'done', total: count };
}

function splitTitleBody(text: string): { title: string; body: string } {
  const idx = text.indexOf('\n');
  if (idx === -1) return { title: text.trim(), body: '' };
  return {
    title: text.slice(0, idx).trim(),
    body: text.slice(idx + 1),
  };
}

function toNote(title: string, body: string): ImportedNote {
  return {
    title: title.length > 0 ? title : '(untitled)',
    body,
    noteType: 'text',
    checklistItems: null,
    labels: [],
    color: null,
    isPinned: false,
    isArchived: false,
    createdAt: null,
    updatedAt: null,
  };
}
