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
 * Per-note editor-mode pins: the rule, with no storage and no imports.
 *
 * The global setting is the DEFAULT for every note. Changing the mode while a
 * specific note is open pins that note; setting it back to whatever the global
 * currently is un-pins it, so the note follows the default again. That is the
 * whole rule, and it is the part worth testing — where the map is kept (the
 * item_type=10 metadata blob) is a storage detail the three clients each solve
 * their own way.
 *
 * WHY NOT IN THE NOTE BODY. The body is what syncs to collaborators and to
 * share recipients, so a view preference stored there would impose one
 * reader's choice on everyone else — and writing it would bump
 * `updated_at`, reordering the notes list (`b.updatedAt.localeCompare(...)`)
 * just because somebody looked at a note in a different mode. A pin must never
 * touch the note.
 */

export type EditorMode = 'hybrid' | 'markdown' | 'preview';

/** noteId → the mode that note is pinned to. Absent means "follow the global". */
export type ModeOverrides = Record<string, EditorMode>;

const MODES: readonly string[] = ['hybrid', 'markdown', 'preview'];

/** The cycle order the mode buttons walk, shared so the label, the tooltip and
 *  the click cannot disagree about what comes next. */
export const MODE_CYCLE: readonly EditorMode[] = ['hybrid', 'markdown', 'preview'];

/** Display name for a mode. */
export function modeName(m: EditorMode): string {
  return m === 'hybrid' ? 'Hybrid' : m === 'markdown' ? 'Markdown' : 'Preview';
}

/** Where the next click goes. The button shows the mode you are IN; without
 * this the control would give no hint that it cycles at all. */
export function nextEditorMode(current: EditorMode): EditorMode {
  return MODE_CYCLE[(MODE_CYCLE.indexOf(current) + 1) % MODE_CYCLE.length];
}

/** Values arrive from a shared blob any client may have written, including
 *  future ones. Anything unrecognised is treated as absent rather than trusted
 *  into a UI that switches on three names. */
export function isEditorMode(v: unknown): v is EditorMode {
  return typeof v === 'string' && MODES.includes(v);
}

/** Drop anything that isn't a known mode. Used when parsing the blob. */
export function sanitizeOverrides(raw: unknown): ModeOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ModeOverrides = {};
  for (const [id, mode] of Object.entries(raw as Record<string, unknown>)) {
    if (id && isEditorMode(mode)) out[id] = mode;
  }
  return out;
}

/** The mode a note is actually edited in. */
export function resolveMode(
  overrides: ModeOverrides, noteId: string | null | undefined, global: EditorMode,
): EditorMode {
  if (!noteId) return global;
  return overrides[noteId] ?? global;
}

/** True when this note is pinned away from the current global — i.e. when the
 *  UI should say "(this note)" rather than "(default)". Note that a pin equal
 *  to the global reads as NOT pinned, which is the honest thing to show: it
 *  changes nothing the user can see. */
export function isPinned(
  overrides: ModeOverrides, noteId: string | null | undefined, global: EditorMode,
): boolean {
  return !!noteId && overrides[noteId] !== undefined && overrides[noteId] !== global;
}

/**
 * Apply the pin/un-pin rule.
 *
 * Returns the SAME object when nothing changed, so callers can skip a write —
 * the map lives in a blob shared with notebooks and label colours, and a
 * pointless save would bump its version and race another device for no reason.
 */
export function withMode(
  overrides: ModeOverrides, noteId: string, mode: EditorMode, global: EditorMode,
): ModeOverrides {
  const current = overrides[noteId];
  if (mode === global) {
    if (current === undefined) return overrides;   // already following the default
    const next = { ...overrides };
    delete next[noteId];
    return next;
  }
  if (current === mode) return overrides;
  return { ...overrides, [noteId]: mode };
}

/** Forget every pin. Backs "Reset all notes to the default" — without it a
 *  pinned note is only findable by opening it, so a user who pinned a few and
 *  forgot which has no way back. */
export function clearOverrides(overrides: ModeOverrides): ModeOverrides {
  return Object.keys(overrides).length === 0 ? overrides : {};
}

/**
 * Drop pins whose note is gone, so the map cannot grow forever.
 *
 * `liveIds` must be the ids the caller actually knows to exist. Passing a
 * partial list — one page of a paged sync, say — would delete pins for notes
 * that are merely absent from that page, so callers hand over the full local
 * note set or don't call this at all.
 */
export function gcOverrides(overrides: ModeOverrides, liveIds: Iterable<string>): ModeOverrides {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return overrides;
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const dead = keys.filter(id => !live.has(id));
  if (dead.length === 0) return overrides;
  const next = { ...overrides };
  for (const id of dead) delete next[id];
  return next;
}
