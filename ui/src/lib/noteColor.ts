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
 * A note's colour, and the one shape it is allowed to take on a card.
 *
 * `NoteCard` exposes the chosen colour to CSS as `--note-color`, and
 * index.css washes the card with it. A custom property is a token stream, not
 * a colour: whatever string is handed over arrives in the stylesheet verbatim,
 * and only fails when the `color-mix()` around it tries to use it. A card
 * carrying
 *
 *     style="--note-color: null; --card-span: 101;"
 *
 * has the STRING "null", which is truthy, so a guard in the markup
 * (`note.color ? … : undefined`) lets it through. `color-mix(in srgb, null 14%,
 * …)` is invalid at computed-value time, which drops the whole `background`
 * declaration, and the card paints `rgba(0, 0, 0, 0)`: fully transparent, the
 * page showing through it, next to its opaque neighbours.
 *
 * So the markup asks this instead of asking whether the value is truthy. The
 * palette in ColorPicker.tsx is hex and nothing else, so hex is what a card
 * accepts; anything else is treated as "no colour", which is what a card
 * carrying rubbish should look like.
 *
 * ⚠️ This is the SECOND of two guards, not the only one. index.css paints the
 * wash as a `background-image` over an opaque `background-color`, so an
 * invalid value can only drop the wash, never the ground. Either alone
 * prevents the transparent card; both exist because one is about what the
 * data may contain and the other about what CSS may do with it.
 */

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — what ColorPicker produces. */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The colour to put on a card, or null when there is nothing safe to put. */
export function noteColorValue(color: unknown): string | null {
  if (typeof color !== 'string') return null;
  const trimmed = color.trim();
  return HEX.test(trimmed) ? trimmed : null;
}
