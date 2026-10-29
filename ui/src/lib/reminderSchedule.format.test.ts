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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatReminder } from './reminderSchedule';

/**
 * The "Next week" preset lands 7 days out at 09:00. Read late on a Wednesday
 * evening that is 6.5 days away; rounded to 6, it would take the "under a
 * week" branch and print the bare weekday — "Next week — Wed, 9:00 AM", on a
 * Wednesday.
 */
const at = (iso: string) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };
afterEach(() => vi.useRealTimers());

describe('formatReminder', () => {
  it('never labels a future reminder with only the weekday it already is', () => {
    // Wednesday 2026-09-02, 23:00 local. "Next week" = 2026-09-09 09:00.
    at('2026-09-02T23:00:00');
    const out = formatReminder(new Date('2026-09-09T09:00:00').toISOString());
    expect(out).toMatch(/Wed/);
    // The disambiguating part: a day number has to be in there.
    expect(out).toMatch(/\d{1,2}/);
    expect(out).not.toMatch(/^Wed, \d{1,2}:\d{2}/);
  });

  it('keeps Today and Tomorrow, which are never ambiguous', () => {
    at('2026-09-02T10:00:00');
    expect(formatReminder(new Date('2026-09-02T18:00:00').toISOString())).toMatch(/^Today, /);
    expect(formatReminder(new Date('2026-09-03T09:00:00').toISOString())).toMatch(/^Tomorrow, /);
  });

  it('still carries the weekday for a mid-week reminder', () => {
    at('2026-09-02T10:00:00');
    const out = formatReminder(new Date('2026-09-05T09:00:00').toISOString());
    expect(out).toMatch(/Sat/);
    expect(out).toMatch(/Sep/);
  });

  it('leaves the past alone', () => {
    at('2026-09-02T10:00:00');
    expect(formatReminder(new Date('2026-09-01T09:00:00').toISOString())).toMatch(/^Yesterday, /);
  });
});
