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
 * Preset reminder times + browser Notification helpers.
 */
import { Reminder } from '../stores/reminders';
import { NoteItem } from '../stores/notes';

export interface Preset {
  id: string;
  label: string;
  /** Returns null if the preset no longer makes sense (e.g. "Later today" after 9pm). */
  compute(): Date | null;
}

function setToday(hours: number, minutes = 0): Date {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function setDaysFromNow(days: number, hours: number, minutes = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

export const presets: Preset[] = [
  {
    id: 'later-today',
    label: 'Later today',
    compute() {
      const now = new Date();
      // 6pm if before 5pm, 9pm if between 5-8pm, else null
      if (now.getHours() < 17) return setToday(18);
      if (now.getHours() < 20) return setToday(21);
      return null;
    },
  },
  {
    id: 'tomorrow-morning',
    label: 'Tomorrow morning',
    compute: () => setDaysFromNow(1, 9),
  },
  {
    id: 'next-week',
    label: 'Next week',
    compute: () => setDaysFromNow(7, 9),
  },
];

/** Format a trigger_at ISO string as a short human-readable label. */
export function formatReminder(triggerAt: string): string {
  const d = new Date(triggerAt);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

  const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  if (d.toDateString() === now.toDateString()) return `Today, ${timeStr}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${timeStr}`;
  if (diffDays < 0) {
    // Past: "Yesterday" / date
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${timeStr}`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  // Beyond tomorrow the weekday ALONE is ambiguous, and worst exactly where it
  // is used most: the "Next week" preset lands 7 days out, which late in the
  // evening rounds to 6 and would render as the bare name of the day it
  // already is — "Next week — Wed, 9:00 AM", read on a Wednesday. The weekday
  // is still worth having (it is what people plan around), so keep it and add
  // the date that disambiguates it.
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + `, ${timeStr}`;
}

/** Ask the user for Notification permission. Returns the final permission state. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Fire a local browser notification for a reminder. */
export function fireLocal(reminder: Reminder, note: NoteItem | undefined, onClick: () => void) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const title = note?.title?.trim() || 'Reminder';
  const bodyText = note?.body
    ? note.body.slice(0, 120) + (note.body.length > 120 ? '…' : '')
    : 'Open your note';
  try {
    const n = new Notification(title, {
      body: bodyText,
      tag: `reminder-${reminder.id}`,
    });
    n.onclick = () => {
      window.focus();
      onClick();
      n.close();
    };
  } catch {
    // Some browsers throw on certain constructors; best-effort only.
  }
}
