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
 * Answers about a list that are worked out once per list, not once per question.
 *
 * Made for the notes list and the shares inbox. Three questions are each
 * answered by walking a whole list, and each is asked once per row of another
 * list:
 *
 *   - "is this share one of my own notes?"  per inbox row, over every note;
 *   - "is this note shared with me?"         per note and per card, over every share;
 *   - "which shares are notebooks?"          per card, over every share.
 *
 * With 10,000 shares and 1,000 own notes, the first alone takes 26 s walked
 * naively, on the page's only thread, at the start of every sync.
 *
 * Both helpers key on the list being THE SAME ARRAY. The stores replace their
 * list on every change and never edit one in place (a signal that was edited
 * in place would not tell its readers either), so an answer is always about
 * the list as it is now: nothing is remembered across a change. That matters
 * for the first question, which is a trust check: a table built at the
 * start of a load and consulted after the list had changed could let through
 * a share of a note that became the account's own in between.
 */

/**
 * `list.find(x => keyOf(x) === key)` without the walk: the FIRST element with
 * each key. An element whose key is null is found by no key.
 */
export function firstByKey<T>(keyOf: (x: T) => string | null): (list: readonly T[], key: string) => T | undefined {
  let indexed: readonly T[] | null = null;
  let index = new Map<string, T>();
  return (list, key) => {
    if (list !== indexed) {
      const next = new Map<string, T>();
      for (const x of list) {
        const k = keyOf(x);
        if (k !== null && !next.has(k)) next.set(k, x);
      }
      index = next;
      indexed = list;
    }
    return index.get(key);
  };
}

/** `derive(list)`, worked out again only when the list is another array. */
export function keptPerList<T, R>(derive: (list: readonly T[]) => R): (list: readonly T[]) => R {
  let from: readonly T[] | null = null;
  let value: R;
  return (list) => {
    if (list !== from) {
      value = derive(list);
      from = list;
    }
    return value;
  };
}
