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

import { Component, createSignal, onCleanup, onMount, Show, For, lazy } from 'solid-js';
import { registerBackHandler } from '../lib/backHandlers';
import { settingsStore } from '../stores/settings';
import { modeName, nextEditorMode } from '../lib/editorModeOverrides';
import ColorPicker from './ColorPicker';
import NotebookPicker from './NotebookPicker';
import LabelPalette from './LabelPalette';
// CodeMirror + lang-markdown + language-data weigh ~650 kB minified.
// The composer is collapsed on first paint of the notes grid, so defer
// NoteEditor until the user actually clicks into "Take a note...".
const NoteEditor = lazy(() => import('./NoteEditor'));
import type { EditorHandle } from './NoteEditor';
import { putDraft, getDraft, removeDraft } from '../lib/noteDb';
import { ownsSharedCache } from '../stores/notes';
import type { NoteItem } from '../stores/notes';
import { watchKeyboard } from '../lib/keyboardWatcher';
import ChecklistNoteEditor, { type ChecklistItem, type ChecklistHandle } from './ChecklistNoteEditor';

type Mode = 'text' | 'checklist';

/**
 * `ok` is true when the note reached the server OR was safely queued offline
 * (the composer may reset); false on a hard denial (e.g. the note-cap), so the
 * composer keeps the user's text instead of discarding it.
 *
 * `note` is null when the create was QUEUED — offline, there is no server id
 * yet. That matters for attachments: they upload against the note's id and are
 * encrypted with its content key, so there is nothing to attach to until the
 * create lands. The composer says so rather than dropping a file quietly.
 */
export interface CreateOutcome {
  ok: boolean;
  note: NoteItem | null;
  /** Refused because this tab holds no E2EE keys yet. The text stays in the
   *  composer and the composer says why, instead of just not closing. */
  locked?: boolean;
}

interface Props {
  onCreate: (title: string, body: string, color?: string | null, labels?: string[], notebookId?: string | null) => Promise<CreateOutcome>;
  onCreateList: (title: string, items: ChecklistItem[], color?: string | null, labels?: string[], notebookId?: string | null) => Promise<CreateOutcome>;
  /** Save the draft and open it with the attachment picker up — see the note
   *  on `CreateOutcome`. Absent on platforms with no attachment support. */
  onAttachToNew?: (note: NoteItem) => void;
  /**
   * Open already expanded, prefilled. Set by the `/new` deep link — the
   * quick-capture widget and share-into-app on Android. Read once on mount:
   * this seeds the composer, it does not keep it in sync, or a re-render would
   * fight the user's typing.
   */
  initial?: { mode?: Mode; title?: string; body?: string };
  /**
   * Hands the parent the expand functions, and a reader for whether the
   * composer is open. On phones the collapsed "Take a note..." row is hidden
   * and the compose triggers live outside this component — the notebook line's
   * icon pair in a narrow mouse window, the floating buttons on touch — so
   * both the trigger and the rule for hiding it while the composer is up have
   * to be answerable from outside.
   */
  bind?: (api: {
    expandText: () => void;
    expandList: () => void;
    expanded: () => boolean;
    /** Seed and open from a `/new` link that arrived AFTER mount. */
    openWith: (init: { mode?: Mode; title?: string; body?: string }) => Promise<void>;
  } | null) => void;
}

const NoteComposer: Component<Props> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  /** Desktop full screen. The phone gets `.composer-fullscreen` from
   *  `expanded()` alone — there it is the only way the composer is shown at
   *  all — so this is a separate, deliberate control. Reset with the draft. */
  const [maximized, setMaximized] = createSignal(false);
  const [fmtActive, setFmtActive] = createSignal({ bold: false, italic: false, strike: false, code: false });
  const [mode, setMode] = createSignal<Mode>('text');
  const [title, setTitle] = createSignal('');
  const [body, setBody] = createSignal('');
  const [items, setItems] = createSignal<ChecklistItem[]>([{ text: '', checked: false }]);
  const [noteColor, setNoteColor] = createSignal<string | null>(null);
  const [labels, setLabels] = createSignal<string[]>([]);
  const [notebookId, setNotebookId] = createSignal<string | null>(null);
  const [labelInput, setLabelInput] = createSignal('');

  let editorHandle: EditorHandle | null = null;
  // Same phone editing-chrome collapse as NoteModal: the keyboard hides the
  // toolbar (top) and labels/meta (bottom) independently; chevrons restore
  // or re-hide each. The footer (Discard/Save) always stays.
  const [topHidden, setTopHidden] = createSignal(false);
  const [bottomHidden, setBottomHidden] = createSignal(false);
  // The toolbar stays through keyboard transitions (chevron collapses it by
  // hand); only labels/meta yield automatically.
  onCleanup(watchKeyboard((up) => {
    setBottomHidden(up);
  }));
  let checklistHandle: ChecklistHandle | null = null;
  // Guards against a double-submit: awaiting the create keeps the composer
  // expanded during the round-trip, so a second Save click could fire a
  // duplicate create before the first resolves.
  let submitting = false;

  // --- Crash-window draft stash (same mechanism as NoteModal's) -----------
  // The composer commits on back/collapse, but a crash mid-compose would lose
  // the text. While expanded with content, the draft goes to IDB once a second
  // under a fixed sentinel id; save()/discard() clear it via reset().
  const COMPOSER_DRAFT_ID = '__pingolin-composer__';
  let draftTimer: ReturnType<typeof setInterval> | null = null;
  const stashDraft = () => {
    if (!expanded() || !ownsSharedCache()) return;
    const bodyText = mode() === 'checklist'
      ? items().filter(it => it.text.trim() || it.checked).map(it => it.text).join('\n')
      : body();
    if (!title().trim() && !bodyText.trim()) return;
    void putDraft({
      id: COMPOSER_DRAFT_ID,
      title: title(),
      body: bodyText,
      checklistItems: mode() === 'checklist' ? items() : undefined,
      labels: labels(),
      color: noteColor(),
      notebookId: notebookId(),
      baseVersion: null,
      stashedAt: Date.now(),
    });
  };
  const startDraftTimer = () => {
    if (!draftTimer) draftTimer = setInterval(stashDraft, 1000);
  };
  const stopDraftTimer = () => {
    if (draftTimer) { clearInterval(draftTimer); draftTimer = null; }
  };
  onCleanup(stopDraftTimer);

  /** A `/new` link has filled this composer. The draft read below must not
   *  land on top of it: `getDraft` is an IDB round trip, and a share arriving
   *  inside that window would be overwritten by a draft from an hour ago. */
  let seeded = false;

  /** Is there anything in here worth not losing? */
  const hasContent = () => {
    const bodyText = mode() === 'checklist'
      ? items().filter(it => it.text.trim() || it.checked).map(it => it.text).join('')
      : body();
    return !!(title().trim() || bodyText.trim());
  };

  /**
   * Fill the composer from a `/new` link and open it.
   *
   * Kept apart from onMount because the SHELL'S WARM PATH cannot reach onMount:
   * share-into-app on an already-running app calls `__pingolinNavigate('/new#…')`,
   * which is a client-side route change between two routes that render the SAME
   * component — so nothing remounts, and the seed has to be pushable into a
   * composer that is already alive. See the location effect in NotesView.
   */
  const seedFrom = (init: { mode?: Mode; title?: string; body?: string }) => {
    seeded = true;
    setMode(init.mode ?? 'text');
    setTitle(init.title ?? '');
    if ((init.mode ?? 'text') === 'checklist') {
      // Shared text becomes one line per item — that is what a person sharing a
      // list into a checklist means. An empty trailing item keeps the usual
      // "type the next one" affordance.
      const lines = (init.body ?? '').split('\n').map(t => t.trim()).filter(Boolean);
      setItems(lines.length ? [...lines.map(text => ({ text, checked: false })), { text: '', checked: false }]
                            : [{ text: '', checked: false }]);
    } else {
      setBody(init.body ?? '');
    }
    setExpanded(true);
    startDraftTimer();
  };

  /**
   * A share that arrives while something is already half-written.
   *
   * The draft is COMMITTED first, not discarded and not appended to: the
   * shared text belongs in its own note, and silently overwriting a note
   * somebody was in the middle of writing would destroy their work.
   * `save()` creates the note and resets, so what follows is a clean
   * composer.
   */
  const openWith = async (init: { mode?: Mode; title?: string; body?: string }) => {
    if (expanded() && hasContent()) await save();
    seedFrom(init);
  };

  onMount(() => {
    const init = props.initial;
    if (!init) {
      // No deep-link prefill: restore a crash-surviving composer draft. An
      // explicit prefill wins over the draft (the user is acting NOW); the
      // draft stays put for the next plain open in that case.
      void getDraft(COMPOSER_DRAFT_ID).then((draft) => {
        if (!draft || seeded) return;
        setMode(draft.checklistItems ? 'checklist' : 'text');
        setTitle(draft.title);
        if (draft.checklistItems) {
          setItems(draft.checklistItems.length ? draft.checklistItems : [{ text: '', checked: false }]);
        } else {
          setBody(draft.body);
        }
        setLabels(draft.labels);
        setNoteColor(draft.color);
        setNotebookId(draft.notebookId);
        setExpanded(true);
        startDraftTimer();
      });
      return;
    }
    seedFrom(init);
  });

  const expandText = () => {
    setMode('text');
    setExpanded(true);
    startDraftTimer();
  };

  const expandList = () => {
    setMode('checklist');
    setExpanded(true);
    startDraftTimer();
  };

  onMount(() => props.bind?.({ expandText, expandList, expanded, openWith }));
  onCleanup(() => props.bind?.(null));

  const save = async (): Promise<CreateOutcome> => {
    if (submitting) return { ok: false, note: null };
    const t = title().trim();
    // Default ok so an empty composer (nothing to create) still resets/collapses.
    let outcome: CreateOutcome = { ok: true, note: null };
    submitting = true;
    try {
      if (mode() === 'checklist') {
        const kept = items().filter(it => it.text.trim().length > 0 || it.checked);
        if (t || kept.length > 0) {
          outcome = await props.onCreateList(t, kept, noteColor(), labels(), notebookId());
        }
      } else {
        const b = body().trim();
        if (t || b) {
          outcome = await props.onCreate(t, b, noteColor(), labels(), notebookId());
        }
      }
    } finally {
      submitting = false;
    }
    // Only clear the form once the create was accepted or safely queued —
    // discarding the text before the create resolves loses it if the create
    // is refused.
    if (outcome.ok) reset();
    // A locked tab refuses every create; without a word the composer simply
    // would not close, which reads as a broken button.
    setLockedError(outcome.locked ? "Can't save — unlock your encrypted notes first (see the notice above)." : null);
    return outcome;
  };

  const [attachError, setAttachError] = createSignal<string | null>(null);
  const [lockedError, setLockedError] = createSignal<string | null>(null);

  /**
   * ATTACHING A DRAFT MEANS SAVING IT FIRST. An attachment is uploaded against
   * a note id and encrypted with that note's content key, neither of which a
   * draft has — so a draft cannot take one directly. The note is created and
   * opened with the picker already up: one click, and it lands where the
   * attachment will live.
   */
  const attachToNew = async () => {
    setAttachError(null);
    const hasContent = mode() === 'checklist'
      ? items().some(it => it.text.trim().length > 0)
      : body().trim().length > 0 || title().trim().length > 0;
    if (!hasContent) {
      setAttachError('Write something first — an attachment needs a note to belong to.');
      return;
    }
    const outcome = await save();
    if (outcome.note) {
      props.onAttachToNew?.(outcome.note);
    } else if (outcome.ok) {
      // Queued offline: the note is safe, but it has no id to attach to yet.
      setAttachError('Saved offline. Open the note to attach a file once you are back online.');
    }
  };

  const discard = () => {
    reset();
  };

  const reset = () => {
    stopDraftTimer();
    void removeDraft(COMPOSER_DRAFT_ID);
    setTitle('');
    setBody('');
    setItems([{ text: '', checked: false }]);
    setNoteColor(null);
    setLabels([]);
    setNotebookId(null);
    setLabelInput('');
    editorHandle = null;
    setExpanded(false);
    setMaximized(false);
    setMode('text');
  };

  // Android back on an expanded composer commits the draft (same as
  // tapping outside) instead of exiting the app: without this hook the
  // shell's back handling cannot see the composer, and a draft in
  // progress would drop the user at the launcher.
  const unregisterBack = registerBackHandler(() => {
    if (!expanded()) return false;
    void save();
    return true;
  });
  onCleanup(unregisterBack);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') discard();
  };

  const addLabel = () => {
    const l = labelInput().trim();
    if (l && !labels().includes(l)) {
      setLabels(prev => [...prev, l]);
    }
    setLabelInput('');
  };

  return (
    <div
      class="composer"
      classList={{ 'composer-fullscreen': expanded(), 'composer-maximized': expanded() && maximized() }}
      onClick={(e) => e.stopPropagation()}
    >
      <Show when={!expanded()}>
        <div class="composer-collapsed">
          <span class="composer-placeholder" onClick={expandText}>Take a note...</span>
          <div class="composer-quick-actions">
            <button
              class="composer-quick-btn"
              title="New list"
              aria-label="New list"
              onClick={(e) => { e.stopPropagation(); expandList(); }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="5" width="6" height="6" rx="1"/>
                <path d="M5 8l1.5 1.5L9 6"/>
                <line x1="13" y1="8" x2="21" y2="8"/>
                <rect x="3" y="13" width="6" height="6" rx="1"/>
                <line x1="13" y1="16" x2="21" y2="16"/>
              </svg>
            </button>
          </div>
        </div>
      </Show>
      <Show when={expanded()}>
        <div
          class="composer-expanded"
          classList={{ 'top-hidden': topHidden(), 'bottom-hidden': bottomHidden() }}
          onKeyDown={handleKeyDown}
        >
          <Show when={noteColor()}>
            <div class="note-color-bar" style={{ background: noteColor()!, height: '4px', margin: '0 0 8px', 'border-radius': '4px 4px 0 0' }} />
          </Show>

          {/* The toolbar caret rides the title line, exactly as it does in
              NoteModal: one button that flips its icon, at the title's right
              edge in BOTH states, so opening the toolbar does not move it. */}
          <div class="note-titlebar">
            <input
              class="composer-title"
              type="text"
              placeholder="Title"
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
            />
            <button
              class="composer-maximize"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setMaximized(v => !v)}
              title={maximized() ? 'Restore' : 'Full screen'}
              aria-label={maximized() ? 'Restore composer' : 'Compose full screen'}
            >
              <Show when={maximized()} fallback={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>
                </svg>
              }>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>
                </svg>
              </Show>
            </button>
            <button
              class="chrome-toggle chrome-toggle-top"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setTopHidden(h => !h)}
              aria-expanded={!topHidden()}
              aria-label={topHidden() ? 'Show formatting toolbar' : 'Hide formatting toolbar'}
              title={topHidden() ? 'Show formatting toolbar' : 'Hide formatting toolbar'}
            >
              <Show
                when={topHidden()}
                fallback={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
              </Show>
            </button>
          </div>

          {/* Text mode: markdown toolbar + NoteEditor */}
          <Show when={mode() === 'text'}>
            <div class="format-toolbar-row">
            <div class="format-toolbar composer-toolbar" onPointerDown={(e) => { if ((e.target as HTMLElement).closest('.fmt-btn')) e.preventDefault(); }}>
              <button class="fmt-btn" onClick={() => editorHandle?.undo()} title="Undo (Ctrl+Z)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
              </button>
              <button class="fmt-btn" onClick={() => editorHandle?.redo()} title="Redo (Ctrl+Shift+Z)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
              </button>
              <span class="fmt-sep" />
              <button class="fmt-btn" classList={{ 'fmt-active': fmtActive().bold }} aria-pressed={fmtActive().bold} onClick={() => editorHandle?.wrapSelection('**', '**')} title="Bold (Ctrl+B)"><strong>B</strong></button>
              <button class="fmt-btn" classList={{ 'fmt-active': fmtActive().italic }} aria-pressed={fmtActive().italic} onClick={() => editorHandle?.wrapSelection('*', '*')} title="Italic (Ctrl+I)"><em>I</em></button>
              <button class="fmt-btn" classList={{ 'fmt-active': fmtActive().strike }} aria-pressed={fmtActive().strike} onClick={() => editorHandle?.wrapSelection('~~', '~~')} title="Strikethrough"><s>S</s></button>
              <button class="fmt-btn" classList={{ 'fmt-active': fmtActive().code }} aria-pressed={fmtActive().code} onClick={() => editorHandle?.wrapSelection('`', '`')} title="Inline code">
                <code style="font-size:12px">&lt;/&gt;</code>
              </button>
              <span class="fmt-sep" />
              <button class="fmt-btn" onClick={() => editorHandle?.insertLinePrefix('- ')} title="Bullet list">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
              </button>
              <button class="fmt-btn" onClick={() => editorHandle?.insertLinePrefix('1. ')} title="Numbered list">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="8" font-size="8" fill="currentColor" stroke="none">1</text><text x="2" y="14" font-size="8" fill="currentColor" stroke="none">2</text><text x="2" y="20" font-size="8" fill="currentColor" stroke="none">3</text></svg>
              </button>
              <button class="fmt-btn" onClick={() => editorHandle?.insertLinePrefix('- [ ] ')} title="Checklist">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="M5 8l1.5 1.5L9 6"/><line x1="13" y1="8" x2="21" y2="8"/><rect x="3" y="13" width="6" height="6" rx="1"/><line x1="13" y1="16" x2="21" y2="16"/></svg>
              </button>
              <button class="fmt-btn" onClick={() => editorHandle?.insertBlock('```\n', '\n```')} title="Code block">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              </button>
              <span class="fmt-sep" />
              <button class="fmt-btn" onClick={() => editorHandle?.cycleHeading()} title="Heading (click again for the next level)">H</button>
              <button class="fmt-btn" onClick={() => editorHandle?.insertLink()} title="Link">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </button>
              <button class="fmt-btn" onClick={() => editorHandle?.insertDivider()} title="Divider">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/></svg>
              </button>
              <button class="fmt-btn" onClick={() => editorHandle?.insertLinePrefix('> ')} title="Quote">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z"/></svg>
              </button>
            </div>
            </div>

            <div class="composer-editor">
              <NoteEditor
                value={body()}
                onChange={setBody}
                placeholder="Take a note..."
                onReady={(h) => { editorHandle = h; }}
                onStylesChange={setFmtActive}
              />
            </div>
          </Show>

          {/* Checklist mode: interactive list + undo/redo (no markdown toolbar) */}
          <Show when={mode() === 'checklist'}>
            <div class="format-toolbar-row">
            <div class="format-toolbar composer-toolbar" onPointerDown={(e) => { if ((e.target as HTMLElement).closest('.fmt-btn')) e.preventDefault(); }}>
              <button class="fmt-btn" onClick={() => checklistHandle?.undo()} title="Undo">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
              </button>
              <button class="fmt-btn" onClick={() => checklistHandle?.redo()} title="Redo">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
              </button>
            </div>
            </div>
            <div class="composer-editor">
              <ChecklistNoteEditor
                items={items()}
                onChange={setItems}
                onReady={(h) => { checklistHandle = h; }}
              />
            </div>
          </Show>

          {/* Labels */}
          <div class="composer-labels">
            <For each={labels()}>
              {(l) => (
                <span class="label-chip editable">
                  {l}
                  <button class="label-remove" onClick={() => setLabels(prev => prev.filter(x => x !== l))}>&times;</button>
                </span>
              )}
            </For>
            <input
              class="label-input"
              type="text"
              placeholder="Add label..."
              value={labelInput()}
              onInput={(e) => setLabelInput(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(); } }}
            />
          </div>
          {/* This input is a hand-rolled copy of LabelEditor without the modal's
              typeahead, so without the palette a label could not be reused here
              without retyping it exactly. Same palette as the modal, so both agree. */}
          <LabelPalette
            selected={labels()}
            onPick={(l) => setLabels(prev => (prev.includes(l) ? prev : [...prev, l]))}
          />

          {/* Color + notebook row */}
          <div class="composer-meta">
            <ColorPicker selected={noteColor()} onChange={setNoteColor} />
            <NotebookPicker value={notebookId()} onChange={setNotebookId} />
            <Show when={props.onAttachToNew}>
              <button
                type="button"
                class="composer-attach"
                onPointerDown={(e) => e.preventDefault()}
                onClick={attachToNew}
                title="Attach a file — saves the note first"
                aria-label="Attach a file"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                </svg>
                <span>Attach</span>
              </button>
            </Show>
          </div>
          <Show when={attachError()}>
            <p class="composer-attach-note">{attachError()}</p>
          </Show>
          <Show when={lockedError()}>
            <p class="composer-attach-note" role="alert">{lockedError()}</p>
          </Show>

          <div class="composer-footer">
            <button
              class="chrome-toggle chrome-toggle-bottom"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setBottomHidden(h => !h)}
              aria-expanded={!bottomHidden()}
              aria-label={bottomHidden() ? 'Show note tools' : 'Hide note tools'}
              title={bottomHidden() ? 'Show note tools' : 'Hide note tools'}
            >
              <Show
                when={bottomHidden()}
                fallback={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
              </Show>
            </button>
              {/* The label is the CURRENT mode, not the one you would switch to:
                  cycling from Preview lands on Hybrid, and Hybrid genuinely shows the
                  markers. The tooltip names where the next click goes, so the button
                  reads as a cycle. */}
            <button
              class="fmt-btn fmt-mode-btn"
              /* Same reason as NoteModal's: this carries `.fmt-btn` but sits
                 outside `.format-toolbar`, so without this handler it would be the
                 one button that takes focus off the editor — and on a phone that
                 closes the IME. */
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => settingsStore.cycleEditorMode()}
              title={`Editor mode: ${modeName(settingsStore.settings().editorMode)}. Click for ${modeName(nextEditorMode(settingsStore.settings().editorMode))}.`}
            >
              <span class="mode-label">{modeName(settingsStore.settings().editorMode)}</span>
            </button>
            <button class="btn btn-sm btn-secondary" onClick={discard}>Discard</button>
            <button class="btn btn-sm" onClick={save}>Save</button>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default NoteComposer;
