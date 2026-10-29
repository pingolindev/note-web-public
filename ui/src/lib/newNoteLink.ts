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
 * Parsing a `/new` deep link — how the Android shell opens a fresh note.
 *
 * ## Why the parameters live in the FRAGMENT, not the query string
 *
 * Share-into-app hands us the text the user is sharing, and that is note
 * content. A query string is sent to the server in the request line of the GET,
 * so `/new?body=...` would put plaintext note content in the server's logs and
 * break the end-to-end guarantee outright. Fragments are never transmitted.
 *
 * This is the same reasoning — and the same mechanism — as the client-key
 * handoff, which carries the wrapping key in `#ck=` precisely because
 * "fragments never reach the server". Whatever arrives here must be stripped
 * from the URL immediately after reading, the way `stripClientKeyFragment()`
 * does, so it does not linger in history.
 */

export type NewNoteMode = 'text' | 'checklist';

export interface NewNoteRequest {
  mode: NewNoteMode;
  title: string;
  body: string;
}

/**
 * Reads `#type=checklist&title=…&body=…`.
 *
 * Always returns a usable request: a malformed or hostile fragment degrades to
 * an empty text note rather than throwing, because the alternative is a share
 * that opens a blank screen instead of a composer.
 */
/**
 * Take the `/new` request out of the address bar, and strip it.
 *
 * ⚠️ THE COLD ARRIVAL ONLY — a document that BOOTS at `/new`, where
 * `window.location` is the truth because no router has moved yet.
 *
 * It must not be used for a `/new` that arrives by client-side navigation,
 * which is how the Android shell actually delivers share-into-app on a warm
 * app (`__pingolinNavigate` -> `navigate('/new#…')`). solid-router updates its
 * location signal and runs effects BEFORE it commits the history entry, so at
 * that moment `window.location` still holds the PREVIOUS URL: an effect sees
 * `router=/new#body=…` while `win=/new`, so a read from here would return the
 * old page's empty hash and the user's shared text would never be seen. That
 * path reads `useLocation().hash` and strips through `navigate()`; see the
 * effect in NotesView.
 *
 * Returns undefined when the address bar is not a `/new` link — which is also
 * what makes this safe to call twice: the strip is the consumption.
 */
let coldRead = false;

export function consumeNewNoteLink(): NewNoteRequest | undefined {
  // ONCE PER DOCUMENT. "Booted at /new" is a fact about this document load,
  // not about whatever NotesView instance happens to be asking — and a route
  // change re-creates that component, so the question gets asked again every
  // time. With the router leading `window.location`, a navigation AWAY from
  // `/new` re-creates NotesView while the address bar still reads `/new`, and
  // the cold read would fire on the way out: the Android back delegate's
  // `navigate('/')` would reopen an empty composer on a Back press, and cost
  // a second spurious Back before the app could exit. A document boots once,
  // so this answers once.
  if (coldRead) return undefined;
  coldRead = true;
  if (typeof window === 'undefined' || window.location.pathname !== '/new') return undefined;
  const req = parseNewNoteLink(window.location.hash);
  // Synchronously, before anything can read it again: this is the user's note
  // content, and it must not linger in history. Same treatment as `#ck=`.
  try {
    history.replaceState(null, '', '/');
  } catch { /* non-fatal */ }
  return req;
}

export function parseNewNoteLink(fragment: string | null | undefined): NewNoteRequest {
  const empty: NewNoteRequest = { mode: 'text', title: '', body: '' };
  if (!fragment) return empty;

  try {
    const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
    // Anything other than the one alternate mode is text. An unrecognised type
    // must not produce a third state.
    const mode: NewNoteMode = params.get('type') === 'checklist' ? 'checklist' : 'text';
    return {
      mode,
      title: params.get('title') ?? '',
      body: params.get('body') ?? '',
    };
  } catch {
    return empty;
  }
}

/**
 * A `/new` request with nowhere to put it yet.
 *
 * The fragment is stripped the instant it is read — it is the user's note
 * content — so from that moment this module holds the ONLY copy. It is needed
 * when a share arrives with no composer mounted: a note open over the grid, or
 * any view but Notes. Module scope rather than component state so it also
 * survives NotesView being re-created, which a route change does.
 */
let stashed: NewNoteRequest | undefined;

export function stashNewNoteRequest(req: NewNoteRequest): void {
  stashed = req;
}

/** Take it, once. */
export function takeNewNoteRequest(): NewNoteRequest | undefined {
  const req = stashed;
  stashed = undefined;
  return req;
}
