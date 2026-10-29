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
 * The open tab's account re-check: whenever the tab comes into view, and
 * once a minute. A sign-in as someone else in another tab replaces the
 * shared cookie under this one; the re-check notices and the tab reloads.
 * What stops a hidden tab's timers in between is the account header on every
 * request (lib/account.ts), not this: it only makes the reload come sooner.
 */

/** How often an open tab re-checks its account. */
export const ACCOUNT_RECHECK_MS = 60_000;

/** Start re-checking; returns the stop. */
export function startAccountRecheck(recheck: () => void, doc: Document = document): () => void {
  const onVisible = () => {
    if (doc.visibilityState === 'visible') recheck();
  };
  doc.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(recheck, ACCOUNT_RECHECK_MS);
  return () => {
    doc.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  };
}
