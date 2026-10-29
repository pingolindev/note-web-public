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
 * The pin/un-pin rule, which is the whole of this feature that can be wrong
 * quietly. Storage lives in the shared metadata blob and is asserted by the
 * store's own tests; these are about what the rule DOES.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveMode, withMode, isPinned, gcOverrides, clearOverrides, sanitizeOverrides,
  type ModeOverrides,
} from './editorModeOverrides';

const A = 'note-a';
const B = 'note-b';

describe('resolveMode', () => {
  it('falls back to the global when the note has no pin', () => {
    expect(resolveMode({}, A, 'preview')).toBe('preview');
  });

  it('prefers the pin when there is one', () => {
    expect(resolveMode({ [A]: 'markdown' }, A, 'preview')).toBe('markdown');
  });

  it('only applies the pin to its own note', () => {
    expect(resolveMode({ [A]: 'markdown' }, B, 'preview')).toBe('preview');
  });

  it('uses the global for a note with no id yet', () => {
    // The composer edits a note that does not exist server-side until it is
    // saved, so there is nothing to key a pin on.
    expect(resolveMode({ [A]: 'markdown' }, null, 'hybrid')).toBe('hybrid');
    expect(resolveMode({}, undefined, 'hybrid')).toBe('hybrid');
  });
});

describe('withMode', () => {
  it('pins a note when the chosen mode differs from the global', () => {
    expect(withMode({}, A, 'markdown', 'preview')).toEqual({ [A]: 'markdown' });
  });

  it('UN-pins when the chosen mode is the global', () => {
    // The rule that makes the feature reversible: picking the default back
    // deletes the key rather than storing a pin that happens to match.
    expect(withMode({ [A]: 'markdown' }, A, 'preview', 'preview')).toEqual({});
  });

  it('changes an existing pin in place', () => {
    expect(withMode({ [A]: 'markdown' }, A, 'hybrid', 'preview')).toEqual({ [A]: 'hybrid' });
  });

  it('leaves other notes alone', () => {
    expect(withMode({ [A]: 'markdown', [B]: 'hybrid' }, A, 'preview', 'preview'))
      .toEqual({ [B]: 'hybrid' });
  });

  it('returns the SAME object when nothing changed, so no needless write', () => {
    // The map shares a blob with notebooks and label colours. Saving an
    // identical map would bump its version and race another device for free.
    const pinned: ModeOverrides = { [A]: 'markdown' };
    expect(withMode(pinned, A, 'markdown', 'preview')).toBe(pinned);
    const none: ModeOverrides = {};
    expect(withMode(none, A, 'preview', 'preview')).toBe(none);
  });

  it('never mutates the map it was given', () => {
    const before: ModeOverrides = { [A]: 'markdown' };
    withMode(before, B, 'hybrid', 'preview');
    expect(before).toEqual({ [A]: 'markdown' });
  });

  it('a pin survives the global moving to match it', () => {
    // Pin A to markdown, then make markdown the global. The pin is now
    // invisible, but it is still the user's explicit choice for that note —
    // moving the global away again must bring it back.
    const pinned = withMode({}, A, 'markdown', 'preview');
    expect(resolveMode(pinned, A, 'markdown')).toBe('markdown');
    expect(resolveMode(pinned, A, 'hybrid')).toBe('markdown');
  });
});

describe('isPinned', () => {
  it('is true only when the pin differs from the current global', () => {
    expect(isPinned({ [A]: 'markdown' }, A, 'preview')).toBe(true);
    expect(isPinned({}, A, 'preview')).toBe(false);
  });

  it('is false when the pin equals the global — it changes nothing visible', () => {
    expect(isPinned({ [A]: 'markdown' }, A, 'markdown')).toBe(false);
  });

  it('is false with no note id', () => {
    expect(isPinned({ [A]: 'markdown' }, null, 'preview')).toBe(false);
  });
});

describe('gcOverrides', () => {
  it('drops pins for notes that no longer exist', () => {
    expect(gcOverrides({ [A]: 'markdown', [B]: 'hybrid' }, [A])).toEqual({ [A]: 'markdown' });
  });

  it('keeps everything when every note is still live', () => {
    const all: ModeOverrides = { [A]: 'markdown', [B]: 'hybrid' };
    expect(gcOverrides(all, [A, B])).toBe(all);      // identity — nothing to write
  });

  it('returns the same object when there is nothing to collect', () => {
    const none: ModeOverrides = {};
    expect(gcOverrides(none, [])).toBe(none);
  });

  it('accepts a Set as well as a list', () => {
    expect(gcOverrides({ [A]: 'markdown', [B]: 'hybrid' }, new Set([B]))).toEqual({ [B]: 'hybrid' });
  });

  it('collects everything when no notes are live', () => {
    expect(gcOverrides({ [A]: 'markdown' }, [])).toEqual({});
  });
});

describe('clearOverrides', () => {
  it('forgets every pin', () => {
    expect(clearOverrides({ [A]: 'markdown', [B]: 'hybrid' })).toEqual({});
  });

  it('returns the same object when already empty', () => {
    const none: ModeOverrides = {};
    expect(clearOverrides(none)).toBe(none);
  });
});

describe('sanitizeOverrides', () => {
  it('keeps known modes', () => {
    expect(sanitizeOverrides({ [A]: 'markdown', [B]: 'preview' }))
      .toEqual({ [A]: 'markdown', [B]: 'preview' });
  });

  it('drops values that are not modes', () => {
    // The blob is shared with clients this build has never met, including
    // later ones. An unknown value must not reach a UI that switches on three
    // names.
    expect(sanitizeOverrides({ [A]: 'zoomed', [B]: 42, 'c': null })).toEqual({});
  });

  it('survives a blob with no map, or a broken one', () => {
    expect(sanitizeOverrides(undefined)).toEqual({});
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides('nope')).toEqual({});
    expect(sanitizeOverrides(['nope'])).toEqual({});
  });
});
