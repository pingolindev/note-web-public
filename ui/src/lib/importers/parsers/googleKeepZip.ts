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
import type { ImportProgress, ImportedNote, ImportedChecklistItem } from '../types';
import { keepColor } from '../colorMap';

/**
 * Parse a Google Takeout `Keep.zip` export. The Takeout layout puts
 * one JSON file per note under `Takeout/Keep/*.json` plus binary
 * attachments alongside, which this parser does not yield.
 *
 * Mirrors the Note Android app's GoogleKeepParser.
 */
export async function* parseGoogleKeepZip(file: Blob): AsyncGenerator<ImportProgress> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (e) {
    yield { kind: 'error', message: `Couldn't open ZIP: ${(e as Error).message}` };
    return;
  }

  const jsonEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith('.json'),
  );

  let count = 0;
  for (const entry of jsonEntries) {
    let raw: string;
    try {
      raw = await entry.async('string');
    } catch {
      continue;
    }
    const note = parseKeepNote(raw);
    if (!note) continue;
    count++;
    yield { kind: 'parsing', current: count, total: jsonEntries.length, currentTitle: note.title };
    yield { kind: 'note', note };
  }

  yield { kind: 'done', total: count };
}

function parseKeepNote(json: string): ImportedNote | null {
  let obj: any;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (obj.isTrashed === true) return null;

  const title: string = obj.title ?? '';
  const hasList = Array.isArray(obj.listContent) && obj.listContent.length > 0;

  let noteType: 'text' | 'checklist' = 'text';
  let body = '';
  let checklistItems: ImportedChecklistItem[] | null = null;

  if (hasList) {
    noteType = 'checklist';
    checklistItems = obj.listContent.map((it: any) => ({
      text: typeof it.text === 'string' ? it.text : '',
      checked: !!it.isChecked,
    }));
    body = checklistItems!
      .map((i) => `${i.checked ? '[x]' : '[ ]'} ${i.text}`)
      .join('\n');
  } else {
    body = obj.textContent ?? '';
  }

  const labels: string[] = Array.isArray(obj.labels)
    ? obj.labels.map((l: any) => l?.name).filter(Boolean)
    : [];

  const tsUsec = typeof obj.userEditedTimestampUsec === 'number'
    ? obj.userEditedTimestampUsec
    : null;
  const tsMs = tsUsec !== null ? Math.floor(tsUsec / 1000) : null;

  return {
    title,
    body,
    noteType,
    checklistItems,
    labels,
    color: keepColor(obj.color),
    isPinned: !!obj.isPinned,
    isArchived: !!obj.isArchived,
    createdAt: tsMs,
    updatedAt: tsMs,
  };
}
