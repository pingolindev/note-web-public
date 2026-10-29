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
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * A note card says two things about sharing, in two fixed slots:
 *
 *   LINE 1  where it LIVES  — notebook icon + name, whoever owns the notebook
 *   LINE 2  the share FACT  — "Sharing" (you) or "Shared by <who>" (them)
 *
 * The slots mean the same thing on every card, so the eye reads the difference
 * rather than re-parsing the layout. That matters because the two kinds appear
 * in the SAME list: selecting an accepted shared notebook filters the main grid
 * with `noteIsInNotebook`, which matches `ownerNotebookId`, so somebody else's
 * notes render beside your own.
 *
 * WHAT EACH LINE MUST AVOID. "Shared via notebook" on your OWN notes reads as
 * past tense, agentless, indistinguishable from something done TO you. And a
 * line 1 gated on `notebookId`, which is nulled on an incoming share, would
 * show no notebook at all for a note someone shared with you.
 *
 * Source assertions: this suite runs on `environment: 'node'` with no jsdom and
 * no solid testing library, and the include glob is `src/**\/*.{test,spec}.ts`
 * — a .tsx test would never be collected and would report green by being absent.
 */
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8');

/**
 * Strip comments before asserting on what a block RENDERS.
 *
 * A comment in these blocks may quote wording the markup does not use, and
 * a naive `not.toContain('X')` would then fail on the explanation rather
 * than on the code. Assert on the code.
 */
const codeOnly = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // JSX comments
   .replace(/\/\*[\s\S]*?\*\//g, '')         // block comments
   .replace(/^\s*\/\/.*$/gm, '');             // line comments

const card = src('components/NoteCard.tsx');
const css = src('index.css');

/**
 * Slice from the `{/*` that OPENS the marker comment, not from the marker text
 * itself — otherwise the slice begins mid-comment, `codeOnly` never sees the
 * opening delimiter, and the wording quoted inside survives the strip.
 */
const fromComment = (marker: string, end: string) => {
  const at = card.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = card.lastIndexOf('{/*', at);
  return card.slice(open === -1 ? at : open, card.indexOf(end, at));
};

/** LINE 1 — the notebook chip, from its comment to the inbound block. */
const line1 = fromComment('LINE 1 — where this note LIVES', 'LINE 2, INBOUND');

/** LINE 2, inbound — the "Shared by …" chip.
 *
 *  ⚠️ ANCHORED ON THE MARKUP'S OWN MARKER, not on `sharesInboxStore.getByItemId`.
 *  That call is not unique to this block: the card also asks the inbox whether
 *  the note is writable, to decide whether it may be dragged (a `view` share
 *  cannot be reordered — the server refuses the write). Anchored on the call,
 *  the slice would silently move up to that line, and every assertion below
 *  would read the wrong code. */
const inbound = card.slice(
  card.indexOf('LINE 2, INBOUND'),
  card.indexOf('LINE 2, OUTBOUND'),
);

/** LINE 2, outbound — the "Sharing" badge. */
const outbound = fromComment('LINE 2, OUTBOUND', 'Written offline');

describe('line 1 — the notebook, whoever owns it', () => {
  it('is found at all (the slices below are meaningless otherwise)', () => {
    expect(line1.length).toBeGreaterThan(100);
    expect(inbound.length).toBeGreaterThan(100);
    expect(outbound.length).toBeGreaterThan(100);
  });

  it('renders for a note shared WITH us, not only our own', () => {
    // `notebookId` is nulled on an incoming share; the sender's id lands in
    // `ownerNotebookId`. Gating on the first alone would show no notebook at
    // all.
    expect(line1).toContain('props.note.notebookId || props.note.ownerNotebookId');
  });

  it('takes the name from the shared notebook object when there is one', () => {
    expect(line1).toContain('sharedNotebooks()');
  });

  it('still says SOMETHING when they shared the notes but not the notebook', () => {
    // We hold their notebook id but no name for it, and the grouping is still
    // why this note is here.
    expect(line1).toContain("'A notebook'");
  });

  it('carries the shared marker when OUR notebook is shared', () => {
    // Same marker as the sidebar row, so the fact reads identically in both
    // places — and line 2 is then free to speak only about this note.
    expect(line1).toContain('notebooksStore.getNotebookShares(props.note.notebookId).length > 0');
    expect(line1).toContain('note-card-notebook-shared');
    expect(css).toContain('.note-card-notebook-shared');
  });
});

describe('line 2 — the share fact, in two voices', () => {
  it('outbound is ACTIVE and present tense: "Sharing…"', () => {
    expect(outbound).toContain('<span>Sharing{withWhom()}</span>');
  });

  it('names the number of people', () => {
    expect(outbound).toMatch(/with \$\{recipients\(\)\}/);
    expect(outbound).toContain("'person' : 'people'");
  });

  it('prefers the SERVER count over the local notebook roster', () => {
    // shared_with_count counts distinct recipients of THIS note where the
    // share rows are, and already includes shares a notebook granted. The
    // roster is only right for the notebook case and only exists locally.
    expect(outbound).toContain('props.note.sharedWithCount');
    const serverAt = outbound.indexOf('sharedWithCount');
    const rosterAt = outbound.indexOf('getNotebookShares');
    expect(serverAt).toBeGreaterThan(-1);
    expect(rosterAt).toBeGreaterThan(serverAt);
  });

  it('degrades to bare "Sharing" rather than inventing a count', () => {
    // A note shared on its own has no roster on the client: `shared_by_me` is
    // a bare boolean and the per-note lookup is the N+1 it exists to avoid.
    expect(outbound).toMatch(/recipients\(\) > 0\s*\?/);
    expect(outbound).toContain(": '';");
  });

  it('outbound claims no direction it cannot have', () => {
    // "Shared via notebook" on your own note would read as something
    // done TO you.
    expect(codeOnly(outbound)).not.toContain('Shared via notebook');
    expect(codeOnly(outbound)).not.toContain('Via notebook');
  });

  it('inbound is PASSIVE and names the agent: "Shared by <who>"', () => {
    expect(inbound).toContain('Shared by {label}');
  });

  it('the two use different glyphs, so direction survives without reading', () => {
    // Outbound keeps the three-node share mark; inbound is an arrow into a
    // tray. A shared glyph would leave voice as the only cue.
    expect(outbound).toContain('<circle cx="18" cy="5" r="3"/>');
    expect(inbound).toContain('<polyline points="7 10 12 15 17 10"/>');
    expect(inbound).not.toContain('<circle cx="18" cy="5" r="3"/>');
  });

  it('inbound does NOT repeat the notebook — that is line 1', () => {
    // A "from <notebook>" clause here would state the same fact twice on
    // one card.
    expect(codeOnly(card)).not.toContain('note-card-shared-origin');
  });
});

/**
 * `ownerNotebookId` is load-bearing UI state, not scratch space.
 *
 * It is write-path bookkeeping — a recipient's edit re-encrypts the whole
 * payload, so without somewhere to park the sender's notebook id the save would
 * delete the owner's assignment — and it is also rendered and filtered on. A
 * doc that says "never rendered, never filtered on" is the kind of comment that
 * gets a field quietly dropped from a decode path.
 *
 * Dropping it fails SILENTLY twice over: an accepted shared notebook opens
 * empty, and line 1 disappears from every received note. Nothing throws.
 */
describe('ownerNotebookId is documented as load-bearing', () => {
  const notes = src('stores/notes.ts');
  const notesView = src('pages/NotesView.tsx');

  const doc = (() => {
    const at = notes.indexOf('ownerNotebookId?: string | null;');
    expect(at).toBeGreaterThan(-1);
    return notes.slice(Math.max(0, at - 1400), at);
  })();

  it('does not claim it is never rendered or filtered on', () => {
    expect(doc).not.toContain('Never rendered, never');
    expect(doc).not.toMatch(/never filtered on/i);
  });

  it('says it is both filtered on and rendered', () => {
    expect(doc).toMatch(/FILTERED/);
    expect(doc).toMatch(/RENDERED/);
  });

  it('the filtering it describes actually exists', () => {
    expect(notesView).toContain('noteIsInNotebook(n, nb)');
  });
});

/**
 * The two provenance lines of a note card are a pair: they share a box model
 * and a left edge.
 *
 * A notebook YOU have shared also shows a marker on its sidebar row (the
 * `sidebar marks notebooks you have shared` tests below). Sharing a notebook
 * grants standing access to every note in it, including ones added later,
 * and the share BUTTON lives in the hover-revealed action strip, so without
 * the marker a resting row would say nothing.
 */
describe('the two provenance lines are aligned', () => {
  /**
   * Line 2 has no padding of its own, so its icon is not inset from the
   * notebook icon directly above it.
   */
  const rule = (sel: string) => {
    const at = css.indexOf(sel + ' {');
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('line 2 carries no horizontal padding to inset its glyph', () => {
    expect(rule('.note-card-shared')).not.toMatch(/padding:/);
  });

  it('line 1, line 2 and the outbound badge share gap and size', () => {
    for (const sel of ['.note-card-notebook', '.note-card-shared', '.note-card-shared-badge']) {
      expect(rule(sel)).toContain('gap: 6px');
      expect(rule(sel)).toContain('font-size: 13px');
    }
  });

  it('the inbound glyph is the same 16px as the notebook glyph', () => {
    expect(inbound).toContain('<svg width="16" height="16"');
    expect(line1).toContain('<svg width="16" height="16"');
  });
});

describe('sidebar marks notebooks you have shared', () => {
  const sidebar = src('components/Sidebar.tsx');

  it('shows the marker from the notebook\'s recipient list', () => {
    expect(sidebar).toContain('notebooksStore.getNotebookShares(nb.id).length > 0');
    expect(sidebar).toContain('sidebar-item-shared');
  });

  it('is a marker, not another button', () => {
    const at = sidebar.indexOf('sidebar-item-shared');
    const block = sidebar.slice(at - 200, at + 700);
    expect(block).toContain('role="img"');
    expect(block).not.toMatch(/<button[^>]*sidebar-item-shared/);
  });

  it('fades on hover, where the action strip lands on top of it', () => {
    expect(css).toContain('.sidebar-item:hover .sidebar-item-shared { opacity: 0; }');
  });

  it('stays visible on touch, which has no hover and paints the actions in flow', () => {
    // ⚠️ Slice the BLOCK, not a fixed number of characters: a fixed slice
    // breaks the moment a comment is added ahead of the rule — a test that
    // fails on an edit it does not care about. The block ends at the first
    // `}` in column 0.
    const start = css.indexOf('@media (hover: none)');
    expect(start).toBeGreaterThan(-1);
    const end = css.indexOf('\n}\n', start);
    const touch = css.slice(start, end === -1 ? undefined : end);
    expect(touch).toContain('.sidebar-item-actions');
    expect(touch).toContain('.sidebar-item:hover .sidebar-item-shared { opacity: .8; }');
  });
});
