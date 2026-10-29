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
 * Reminders store — manages note reminders via the server-scheduled endpoints.
 *
 * The server sees trigger_at (unencrypted) so it can schedule push notifications.
 * Reminder details (if any) are encrypted like note content.
 *
 * This store also schedules in-browser Notification firings via setTimeout
 * while the tab is open, for snappy local reminders without waiting for push.
 */
import { createSignal, createMemo } from 'solid-js';
import { apiRequest } from '../lib/apiClient';

export interface Reminder {
  id: string;
  itemId: string;
  triggerAt: string;
  repeatRule: string | null;
  fired: boolean;
  dismissed: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ServerReminder {
  id: string;
  item_id: string;
  user_id: string;
  trigger_at: string;
  repeat_rule: string | null;
  encrypted_details: string | null;
  details_nonce: string | null;
  fired: boolean;
  dismissed: boolean;
  created_at: string;
  updated_at: string;
}

const [reminders, setReminders] = createSignal<Reminder[]>([]);
const [loaded, setLoaded] = createSignal(false);

const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function fromServer(s: ServerReminder): Reminder {
  return {
    id: s.id,
    itemId: s.item_id,
    triggerAt: s.trigger_at,
    repeatRule: s.repeat_rule,
    fired: s.fired,
    dismissed: s.dismissed,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function clearTimer(reminderId: string) {
  const t = pendingTimeouts.get(reminderId);
  if (t !== undefined) {
    clearTimeout(t);
    pendingTimeouts.delete(reminderId);
  }
}

function scheduleLocal(r: Reminder, onFire: (r: Reminder) => void) {
  clearTimer(r.id);
  if (r.fired || r.dismissed) return;
  const delay = new Date(r.triggerAt).getTime() - Date.now();
  // setTimeout caps at ~24.8 days; only schedule within that window
  if (delay < 0 || delay > 2_000_000_000) return;
  const t = setTimeout(() => {
    pendingTimeouts.delete(r.id);
    onFire(r);
  }, delay);
  pendingTimeouts.set(r.id, t);
}

export const remindersStore = {
  reminders,
  loaded,

  /** Reminder indexed by noteId (returns the next-upcoming active reminder). */
  byNoteId: createMemo(() => {
    const map = new Map<string, Reminder>();
    const now = Date.now();
    // Sort by trigger_at ascending so upcoming ones win; fall back to latest fired.
    const sorted = [...reminders()].sort(
      (a, b) => a.triggerAt.localeCompare(b.triggerAt)
    );
    for (const r of sorted) {
      if (r.dismissed) continue;
      const existing = map.get(r.itemId);
      const isUpcoming = new Date(r.triggerAt).getTime() >= now;
      if (!existing || (isUpcoming && !existing.dismissed)) {
        map.set(r.itemId, r);
      }
    }
    return map;
  }),

  /** Upcoming reminders (not fired, not dismissed), sorted by trigger time. */
  upcoming: createMemo(() =>
    reminders()
      .filter(r => !r.dismissed && !r.fired)
      .sort((a, b) => a.triggerAt.localeCompare(b.triggerAt))
  ),

  async sync(onFire: (r: Reminder) => void) {
    const result = await apiRequest<ServerReminder[]>('/api/v1/reminders');
    if (!result.success) {
      // 402 (premium-only) is expected for free-tier users — treat as empty
      if (result.status === 402) {
        setReminders([]);
        setLoaded(true);
      }
      return;
    }
    const list = (result.data || []).map(fromServer);
    setReminders(list);
    setLoaded(true);

    // Schedule in-tab firing for anything due in the next ~24 days
    for (const r of list) scheduleLocal(r, onFire);
  },

  /** Create a reminder. Returns the created reminder or null on failure. */
  async create(itemId: string, triggerAt: Date, onFire: (r: Reminder) => void): Promise<Reminder | { error: string; status?: number } | null> {
    const result = await apiRequest<ServerReminder>('/api/v1/reminders', {
      method: 'POST',
      body: {
        item_id: itemId,
        trigger_at: triggerAt.toISOString(),
      },
    });
    if (!result.success) {
      return { error: result.error, status: result.status };
    }
    const r = fromServer(result.data);
    // Replace any existing reminder for this note in-memory
    setReminders(prev => [...prev.filter(x => x.itemId !== itemId), r]);
    scheduleLocal(r, onFire);
    return r;
  },

  async delete(reminderId: string): Promise<boolean> {
    const result = await apiRequest(`/api/v1/reminders/${reminderId}`, { method: 'DELETE' });
    if (!result.success) return false;
    clearTimer(reminderId);
    setReminders(prev => prev.filter(r => r.id !== reminderId));
    return true;
  },

  /** Delete any reminder attached to a note. Returns true if one was removed. */
  async deleteForNote(itemId: string): Promise<boolean> {
    const existing = reminders().find(r => r.itemId === itemId);
    if (!existing) return false;
    return remindersStore.delete(existing.id);
  },

  /** Mark locally as fired (server-side field; best-effort UI update). */
  markFiredLocal(reminderId: string) {
    setReminders(prev => prev.map(r => r.id === reminderId ? { ...r, fired: true } : r));
    clearTimer(reminderId);
  },

  clearAllTimers() {
    for (const t of pendingTimeouts.values()) clearTimeout(t);
    pendingTimeouts.clear();
  },
};
