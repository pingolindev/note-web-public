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
 * Does this selection already overlap a Markdown link?
 *
 * Wrapping any part of a link creates a nested link, which Markdown renders
 * as raw brackets. The second press of the toolbar Link button must therefore
 * be idempotent. A caret beside a link is outside it, and an image is not a
 * link: wrapping one is how Markdown links an image.
 */
export function touchesMarkdownLink(lineText: string, from: number, to: number): boolean {
  // The label's middle branch is an image: `[![alt](src)](url)` is one link.
  const link = /!?\[(?:\\.|!\[[^\]\n]*\]\([^)\n]*\)|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)/g;
  for (const match of lineText.matchAll(link)) {
    if (match[0].startsWith('!')) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (from === to ? from > start && from < end : from < end && to > start) {
      return true;
    }
  }
  return false;
}
