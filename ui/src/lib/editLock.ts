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
 * Cooperative edit lock client — "X is editing this note" signal.
 *
 * Not a hard lock: editing still works whether or not we hold it. The
 * banner just warns concurrent editors about each other. CRDT-based live
 * collaboration is lib/collab.ts.
 */
import { apiRequest } from './apiClient';

export interface LockRecord {
  holder_user_id: string;
  holder_display_name: string;
  acquired_at: string;
  expires_at: string;
}

/**
 * Success carries the record (or null — nobody holds it). Failure carries the
 * HTTP status so callers can tell "gone forever" (401/403 dead session,
 * 404 deleted note) from a transient blip. With null on any failure, a
 * backgrounded modal could heartbeat a deleted note's lock thousands of times
 * over hours of 401s without anyone able to notice.
 */
export type LockResult =
  | { ok: true; record: LockRecord | null }
  | { ok: false; status?: number };

export async function acquireLock(
  noteId: string,
  displayName: string,
): Promise<LockResult> {
  const r = await apiRequest<LockRecord>(`/api/v1/items/${noteId}/lock`, {
    method: 'POST',
    body: { display_name: displayName },
  });
  return r.success ? { ok: true, record: r.data } : { ok: false, status: r.status };
}

export async function peekLock(noteId: string): Promise<LockResult> {
  const r = await apiRequest<LockRecord | null>(`/api/v1/items/${noteId}/lock`);
  return r.success ? { ok: true, record: r.data } : { ok: false, status: r.status };
}

export async function releaseLock(noteId: string): Promise<void> {
  await apiRequest(`/api/v1/items/${noteId}/lock`, { method: 'DELETE' });
}
