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
 * Parses Standard Notes' decrypted JSON backup. The export looks like
 * `{ items: [ { content_type: "Note", content: { title, text }, ... } ] }`.
 *
 * Encrypted backups are not supported (the file would arrive as
 * `enc_item_key` blobs we can't decrypt without the user's passphrase
 * locally) — the import walkthrough warns the user to choose
 * the decrypted option.
 *
 * Mirrors the Android app's StandardNotesParser.
 */
export async function* parseStandardNotesJson(file: Blob): AsyncGenerator<ImportProgress> {
  let parsed: any;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    yield { kind: 'error', message: `Couldn't parse JSON: ${(e as Error).message}` };
    return;
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    yield { kind: 'error', message: 'Backup is missing an `items` array.' };
    return;
  }

  const items: any[] = parsed.items;
  const notes = items.filter(
    (it) => it && it.content_type === 'Note' && it.content && typeof it.content.text === 'string',
  );

  let count = 0;
  for (const it of notes) {
    count++;
    const title: string = it.content.title ?? '';
    yield { kind: 'parsing', current: count, total: notes.length, currentTitle: title };

    const note: ImportedNote = {
      title,
      body: it.content.text ?? '',
      noteType: 'text',
      checklistItems: null,
      labels: [],
      color: null,
      isPinned: !!it.content.pinned,
      isArchived: !!it.content.archived,
      createdAt: parseSnDate(it.created_at),
      updatedAt: parseSnDate(it.updated_at),
    };
    yield { kind: 'note', note };
  }

  yield { kind: 'done', total: count };
}

function parseSnDate(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
