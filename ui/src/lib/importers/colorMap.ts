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
 * Maps third-party colour names to hex strings that the Pingolin note
 * editor's colour palette can render. Unknown values map to null.
 *
 * Kept in sync with the Android app's importer colour mapper.
 */

const KEEP_COLORS: Record<string, string> = {
  DEFAULT: '',
  RED: '#F28B82',
  ORANGE: '#FBBC04',
  YELLOW: '#FFF475',
  GREEN: '#CCFF90',
  TEAL: '#A7FFEB',
  BLUE: '#CBF0F8',
  DARKBLUE: '#AECBFA',
  PURPLE: '#D7AEFB',
  PINK: '#FDCFE8',
  BROWN: '#E6C9A8',
  GRAY: '#E8EAED',
};

export function keepColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = KEEP_COLORS[raw.toUpperCase()];
  return v ? v : null;
}
