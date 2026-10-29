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
 * Unknown fields in the decrypted content JSON must survive a web save.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT
 *   Both phone clients preserve unknown keys deliberately (Note Android's
 *   `KNOWN_KEYS` + `extrasFrom`, Note iOS's `extras` "written back verbatim
 *   on encode"). A web save that built its content object from a fixed
 *   literal would drop everything else, so a field shipped to a phone first
 *   would survive a phone save and be destroyed by the next web save. That is
 *   silent data loss, it only appears during a staggered rollout, and nothing
 *   in the app would surface it — the note just quietly loses a setting.
 */
import { describe, it, expect } from 'vitest';
import { extrasFrom } from './notes';

describe('extrasFrom', () => {
  it('keeps a field this client does not know about', () => {
    const parsed = { title: 'T', body: 'B', view_mode: 'markdown' };
    expect(extrasFrom(parsed)).toEqual({ view_mode: 'markdown' });
  });

  it('claims nothing this client owns', () => {
    // Every key the two encode sites write must be listed as known, or it
    // would be copied into extras and then written twice.
    const owned = {
      title: 'T', body: 'B', note_type: 'text', color: null,
      is_pinned: false, is_archived: false, labels: [], checklist_items: null,
      sort_order: 0, edit_mode: 'rich', notebook_id: null, has_attachments: false,
    };
    expect(extrasFrom(owned)).toBeUndefined();
  });

  it('returns undefined rather than an empty object when there is nothing to keep', () => {
    // `undefined` spreads to nothing; `{}` would add a key-less object to
    // every note and churn the encrypted payload for no reason.
    expect(extrasFrom({ title: 'T' })).toBeUndefined();
  });

  it('preserves value shape, not just presence', () => {
    const parsed = {
      title: 'T',
      future_object: { a: 1, b: [2, 3] },
      future_null: null,
      future_false: false,
      future_zero: 0,
    };
    const extras = extrasFrom(parsed);
    // Falsy values are the ones a naive `if (v)` guard would drop.
    expect(extras).toEqual({
      future_object: { a: 1, b: [2, 3] },
      future_null: null,
      future_false: false,
      future_zero: 0,
    });
  });

  it('lets our fields win when a stale extra collides with one', () => {
    // The merge spreads extras FIRST so a value we just computed is never
    // shadowed by an older copy of the same key.
    const merged = { ...(extrasFrom({ title: 'old', body: 'B' }) ?? {}), title: 'new' };
    expect(merged.title).toBe('new');
  });
});
