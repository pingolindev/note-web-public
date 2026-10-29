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
 * Resolving a `/note/:id` deep link — where a push tap lands, and how the
 * Android shell opens one note.
 *
 * Kept apart from NotesView because the interesting behaviour is a timing
 * question, not a rendering one: a push tap routinely arrives BEFORE the note
 * it refers to has synced down, so "not in the list" means two completely
 * different things depending on whether the initial load has finished. Getting
 * that wrong is not a crash — it is a "note not available" banner flashing on
 * every cold start, which teaches people to ignore the banner that matters.
 */

export interface DeepLinkState {
  /** The `:id` from the route, if any. */
  wantedId?: string | null;
  /** The note already open in the modal, if any. */
  openId?: string | null;
  /** Ids currently known to the client. */
  knownIds: readonly string[];
  /** Has the initial hydrate + sync finished? */
  loaded: boolean;
}

export type DeepLinkAction =
  /** Open this note. */
  | { kind: 'open'; id: string }
  /** Say it is unavailable — the load finished and it is genuinely not here. */
  | { kind: 'missing' }
  /** Do nothing: no link, already open, or still waiting for the sync. */
  | { kind: 'wait' };

export function resolveDeepLink(state: DeepLinkState): DeepLinkAction {
  const wanted = state.wantedId;
  if (!wanted) return { kind: 'wait' };

  // Already showing it. Re-opening would fight the user closing the modal.
  if (state.openId === wanted) return { kind: 'wait' };

  if (state.knownIds.includes(wanted)) return { kind: 'open', id: wanted };

  // Absent BEFORE the first sync completes only means "not here yet".
  return state.loaded ? { kind: 'missing' } : { kind: 'wait' };
}
