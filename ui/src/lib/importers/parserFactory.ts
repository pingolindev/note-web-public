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

import type { ImportProgress, ImportSource } from './types';
import { parseGoogleKeepZip } from './parsers/googleKeepZip';
import { parseEvernoteEnex } from './parsers/evernoteEnex';
import { parseStandardNotesJson } from './parsers/standardNotesJson';
import { parsePlainText } from './parsers/plainText';
import { parsePingolinBackup } from './parsers/pingolinBackup';

export type FileParser = (file: File) => AsyncGenerator<ImportProgress>;

export function fileParserFor(source: ImportSource): FileParser | null {
  switch (source) {
    case 'GOOGLE_KEEP':    return (f) => parseGoogleKeepZip(f);
    case 'EVERNOTE':       return (f) => parseEvernoteEnex(f);
    case 'STANDARD_NOTES': return (f) => parseStandardNotesJson(f);
    case 'PLAIN_TEXT':     return (f) => parsePlainText(f);
    // Restoring our own backup, not importing a foreign file. Same pipeline;
    // the difference is that this one carries ids, so it converges on a repeat
    // instead of duplicating.
    case 'PINGOLIN_BACKUP': return (f) => parsePingolinBackup(f);
  }
}
