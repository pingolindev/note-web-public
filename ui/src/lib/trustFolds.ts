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
 * The fold rules for two of the page's kept trust stores: the rollback floors
 * and the item owners. One rule each, for both of their uses: reading a store
 * (sharesInbox), and folding in the copy a shell kept of it (keptTrust). Both
 * only ever add: a floor only rises, and an owner is never replaced.
 */

import { tryCanonicalAccountId } from './account';

/** Two spellings of one item, or two copies, bound to different owners:
 *  nobody's any more, so its shares are refused. */
export const OWNER_CONFLICT = 'conflict';

const entriesOf = (source: unknown): [string, unknown][] =>
  source && typeof source === 'object' && !Array.isArray(source)
    ? Object.entries(source as Record<string, unknown>)
    : [];

/** The floors of every source by canonical item id: the highest generation of
 *  any spelling or source. A key that isn't a UUID, or a value that isn't a
 *  positive number, is dropped. */
export function foldFloors(sources: readonly unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const source of sources) {
    for (const [k, v] of entriesOf(source)) {
      const id = tryCanonicalAccountId(k);
      if (id === null || typeof v !== 'number' || !(v > 0)) continue;
      out[id] = Math.max(out[id] ?? 0, v);
    }
  }
  return out;
}

/** The owners of every source by canonical item id, values canonical owner
 *  ids: the first binding stands, the same owner again changes nothing, and a
 *  different one (or a conflict) makes the item a conflict. An entry that isn't
 *  a UUID either side is dropped. */
export function foldOwners(sources: readonly unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    for (const [k, v] of entriesOf(source)) {
      const id = tryCanonicalAccountId(k);
      const owner = v === OWNER_CONFLICT ? OWNER_CONFLICT : tryCanonicalAccountId(v);
      if (id === null || owner === null) continue;
      out[id] = out[id] === undefined || out[id] === owner ? owner : OWNER_CONFLICT;
    }
  }
  return out;
}
