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
 * A read a removal cannot go without, asked once more when it gets no answer.
 *
 * When the lookup still fails, the removal stops and says it did not go
 * through — carrying on without it, every other person the note was shared
 * with would silently lose it. The key change asks for what it needs this way
 * (lib/shareUtils `rotateItemContentKey`), as does a notebook's deletion for
 * each note's people (`notesStore.unshareNotebookChildren`).
 */
import type { ApiResponse } from './apiClient';
import { isAccountStop } from './account';

/** How long to wait before asking again. */
export const ASK_AGAIN_AFTER_MS = 1000;

/** `ask`, and once more after a moment when it gets no answer. Never again for
 *  another account's answer (the tab is stopping), nor for a refusal (403),
 *  which a moment does not change; a 404 is asked again, as a replica may not
 *  have the row yet. */
export async function askTwice<T>(ask: () => Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  const first = await ask();
  if (first.success || isAccountStop(first) || (first as { status?: number }).status === 403) return first;
  await new Promise<void>(resolve => setTimeout(resolve, ASK_AGAIN_AFTER_MS));
  return ask();
}
