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
 * Registry for Android-back consumers. The shell delegates back presses to
 * `window.__pingolinBack` (NotesView), which walks these before its own
 * checks — so a component with a dismissable state (the expanded composer)
 * can consume back without NotesView knowing its internals. Handlers return
 * true when they consumed the press. Harmless in a browser: nothing calls
 * the hook there.
 */
export const backHandlers: Array<() => boolean> = [];

export function registerBackHandler(h: () => boolean): () => void {
  backHandlers.unshift(h); // newest first = innermost first
  return () => {
    const i = backHandlers.indexOf(h);
    if (i >= 0) backHandlers.splice(i, 1);
  };
}
