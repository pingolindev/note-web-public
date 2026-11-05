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

import { describe, it, expect } from 'vitest';
import { touchesMarkdownLink } from './blockToolbar';

describe('touchesMarkdownLink', () => {
  it('recognizes the label, URL, and complete inserted link', () => {
    const line = 'before [label](https://) after';
    expect(touchesMarkdownLink(line, 8, 13)).toBe(true);
    expect(touchesMarkdownLink(line, 16, 24)).toBe(true);
    expect(touchesMarkdownLink(line, 7, 25)).toBe(true);
  });

  it('recognizes a caret anywhere inside a link', () => {
    const line = '[label](https://)';
    expect(touchesMarkdownLink(line, 3, 3)).toBe(true);
  });

  it('reads a caret beside a link as outside it', () => {
    expect(touchesMarkdownLink('[a](b)', 6, 6)).toBe(false);
    expect(touchesMarkdownLink('[a](b)', 0, 0)).toBe(false);
    expect(touchesMarkdownLink('[a](b) tail', 6, 6)).toBe(false);
    expect(touchesMarkdownLink('[a](b)', 1, 1)).toBe(true);
    expect(touchesMarkdownLink('[a](b)', 5, 5)).toBe(true);
  });

  it('does not take an image for a link', () => {
    expect(touchesMarkdownLink('![a](b)', 0, 7)).toBe(false);
    expect(touchesMarkdownLink('![a](b)', 3, 3)).toBe(false);
    expect(touchesMarkdownLink('![a](b) [c](d)', 10, 10)).toBe(true);
  });

  it('reads a link around an image as one link', () => {
    const line = '[![a](b)](https://)';
    expect(touchesMarkdownLink(line, 10, 18)).toBe(true);
    expect(touchesMarkdownLink(line, 0, 19)).toBe(true);
    expect(touchesMarkdownLink(line, 4, 4)).toBe(true);
    expect(touchesMarkdownLink(`${line} tail`, 20, 24)).toBe(false);
  });

  it('does not block a plain selection or a nearby link', () => {
    expect(touchesMarkdownLink('plain text', 0, 5)).toBe(false);
    expect(touchesMarkdownLink('head [label](https://)', 0, 4)).toBe(false);
    const line = '[label](https://) tail';
    const tail = line.indexOf('tail');
    expect(touchesMarkdownLink(line, tail, tail + 4)).toBe(false);
  });
});
