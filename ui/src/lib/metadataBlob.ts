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
 * Keeping fields we don't understand in the shared metadata blob.
 *
 * There is exactly ONE item_type=10 item per user, and every client rewrites
 * the whole of it. A client that rebuilds it from only the fields its own
 * version models will DELETE anything a newer client wrote, on the next
 * notebook rename or label-colour change — silently, and from the other
 * device's point of view at random.
 *
 * The note body has the same hazard one level down, which is why unknown
 * content fields are preserved there too (`extrasFrom` in `stores/notes.ts`).
 * Every field a newer client adds survives only if the older clients carry
 * it through untouched.
 *
 * Its own module, and pure, because the store it serves reads localStorage at
 * import time and cannot be loaded in a test.
 */

/** Everything in the decrypted blob that isn't ours, kept verbatim.
 *
 *  Mirrors `extrasFrom` in `stores/notes.ts`, which does the same job one
 *  level down for the note CONTENT json. Same name, same shape, so the two
 *  read as one idea rather than two coincidences. */
export function extrasFrom(
  meta: unknown, known: ReadonlySet<string>,
): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(meta as Record<string, unknown>)) {
    // Membership, never truthiness: a `false`, `0` or `null` a newer client
    // wrote is data, and an `if (value)` guard here would silently drop it.
    if (known.has(key)) continue;
    extras[key] = (meta as Record<string, unknown>)[key];
  }
  return extras;
}
