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

import { Component, createMemo, For, Show } from 'solid-js';
import { NoteItem, notesStore } from '../stores/notes';
import { notebooksStore } from '../stores/notebooks';
import { remindersStore } from '../stores/reminders';
import { selectionStore } from '../stores/selection';
import { formatReminder } from '../lib/reminderSchedule';
import { mathReady, renderMarkdown } from '../lib/markdown';
import { sanitizeHtml } from '../lib/sanitizeHtml';
import { sharesInboxStore } from '../stores/sharesInbox';
import { canWriteNote } from '../lib/dropOrder';
import { noteColorValue } from '../lib/noteColor';
import { openNoteLabel } from '../lib/noteCardLabel';

export type ViewMode = 'active' | 'archived' | 'trash' | 'reminders' | 'inbox';

interface Props {
  note: NoteItem;
  index: number;
  viewMode: ViewMode;
  onClick: () => void;
  onPin?: (e: Event) => void;
  onCopy?: (e: Event) => void;
  onArchive?: (e: Event) => void;
  onDelete: (e: Event) => void;
  onShare?: (e: Event) => void;
  onRestore?: (e: Event) => void;
  /** Inbox (shared-with-me) recipient-consent actions. */
  onDismiss?: (e: Event) => void;
  onBlock?: (e: Event) => void;
  /** Pointer-down intent hook — the parent wires drag logic on pointer events
   * rather than HTML5 drag-drop. Fires with the raw PointerEvent and the
   * card's note id; the handler decides whether to start a drag. */
  onDragIntent?: (e: PointerEvent, noteId: string) => void;
}

const NoteCard: Component<Props> = (props) => {
  const previewHtml = createMemo(() => {
    // Subscribe to the KaTeX chunk so a card whose math rendered as source text
    // upgrades itself once the typesetter lands. Cheap, and the alternative is
    // shipping 272KB of KaTeX to every launch for the minority of notes that
    // contain any math — see mathReady in lib/markdown.
    mathReady();
    const body = props.note.body;
    if (!body) return '';
    const truncated = body.length > 500 ? body.slice(0, 500) + '...' : body;
    return sanitizeHtml(renderMarkdown(truncated));
  });

  const hasContent = () => !!props.note.body?.trim();

  const isChecklist = () => props.note.noteType === 'checklist' && !!props.note.checklistItems;
  const uncheckedItems = () => (props.note.checklistItems || []).filter(i => !i.checked);
  const checkedCount = () => (props.note.checklistItems || []).filter(i => i.checked).length;

  const isDragged = () => notesStore.draggedId() === props.note.id;
  // A note shared with `view` permission cannot be written, and a reorder IS a
  // write — `sortOrder` lives inside the owner's encrypted blob. Dragging one
  // would preview the move, get a 403, and slide back on the next sync.
  // Withdrawing the gesture is honest:
  // `.note-card[draggable="true"] { cursor: grab }` means the card does not
  // offer the grab cursor either.
  const isDraggable = () => props.viewMode === 'active'
    && !selectionStore.isSelectionMode()
    && canWriteNote(sharesInboxStore.getByItemId(props.note.id));
  const isSelected = () => selectionStore.isSelected(props.note.id);
  // Inbox notes belong to someone else: every bulk action is an owner write
  // that would fail, so they don't participate in selection at all.
  const isSelectable = () => props.viewMode !== 'inbox';

  const cardClass = () => {
    let cls = 'note-card';
    // View class for CSS/tests that need to style or find cards per view.
    // (On touch the action strip is display:none in EVERY view — archive
    // and trash included — because the selection bar carries those actions.)
    cls += ` view-${props.viewMode}`;
    if (isDragged()) cls += ' dragging';
    if (isSelected()) cls += ' selected';
    if (selectionStore.isSelectionMode()) cls += ' selecting';
    return cls;
  };

  // Long-press on touch = select (the Keep gesture). Hover doesn't exist
  // there, so the select circle and action icons are unreachable without it;
  // a 500ms hold with <10px of travel toggles selection, and the click that
  // the same lift would otherwise fire is swallowed once.
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressOrigin: { x: number; y: number } | null = null;
  let longPressFired = false;
  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressOrigin = null;
  };

  const handleClick = (e: MouseEvent) => {
    if (longPressFired) {
      longPressFired = false;
      e.stopPropagation();
      return;
    }
    if (isSelectable() && (selectionStore.isSelectionMode() || e.ctrlKey || e.metaKey)) {
      e.stopPropagation();
      selectionStore.toggle(props.note.id);
      return;
    }
    props.onClick();
  };

  /**
   * The card is the only route into a note, so it needs a keyboard path. As a
   * bare <div> with an onClick, no role, no tabindex and no key handler, Tab
   * would walk straight PAST the card into the action strip inside it — six
   * controls that are invisible at rest, in order, the fifth of which deletes
   * the note. So the card has a tab stop, and `.note-card-actions`'
   * `visibility: hidden` (index.css) keeps the strip out of the tab order until
   * focus is inside the card. Neither half works alone: hiding the strip
   * without a focusable card would make it keyboard-UNREACHABLE rather than
   * keyboard-dangerous.
   *
   * The tab stop is `.note-card-open`, a real <button>, and not the card. A
   * button may not contain other controls, and Select, the action strip and
   * any link in the preview (markdown links render as `<a href>`) are all
   * inside the card: a card with `role="button"` fails axe
   * `nested-interactive`, and can end up with no accessible name at all
   * (`aria-command-name`). So the card is a plain container, the open button
   * is one of its controls, and the others are its siblings.
   *
   * The open button takes no pointer events (index.css), so a click or a tap
   * anywhere on the card reaches the card's own handlers: drag, long-press,
   * Ctrl/⌘-click, links in the preview. Enter or Space clicks the button, and
   * that click bubbles to `handleClick` like any other.
   *
   * Except with Ctrl/⌘ held. Ctrl/⌘+Enter or Space toggles selection, as
   * Ctrl/⌘-click does, and a native button does not carry that through: on a
   * bare <button>, Chromium 145 fires NO click for Ctrl+Enter or ⌘+Enter, and
   * Firefox 146 fires one with `ctrlKey` and `metaKey` false — which would
   * OPEN the note. So the modified keys are handled here, `preventDefault`
   * stops the native activation (no click follows in either engine), and the
   * plain keys are the button's own.
   */
  const handleOpenKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (isSelectable()) selectionStore.toggle(props.note.id);
    else props.onClick();
  };

  return (
    <div
      class={cardClass()}
      data-note-id={props.note.id}
      // A 3px stripe along the top edge alone is close to invisible as a
      // scanning aid at grid density. Exposing the note's colour as a custom
      // property lets the stylesheet wash the whole card with it; the stripe
      // below stays, so a colour is still identifiable when the wash is subtle.
      /* `noteColorValue` lets only hex colours through. A plain truthiness test is
         not enough: the STRING "null" is truthy, and it would reach the stylesheet
         verbatim as `--note-color: null`, which makes the `color-mix()` in
         index.css invalid and drops the card's background entirely. */
      style={noteColorValue(props.note.color) ? { '--note-color': noteColorValue(props.note.color)! } : undefined}
      // Explicit draggable=false — default is "auto" and some
      // browsers still initiate HTML5 drag on text selections
      // inside the card, which fights our pointer-event drag.
      draggable={false}
      onClick={handleClick}
      onPointerDown={(e) => {
        if (isSelectable() && e.pointerType !== 'mouse' && !(e.target as Element).closest('button, a, input')) {
          pressOrigin = { x: e.clientX, y: e.clientY };
          longPressFired = false;
          pressTimer = setTimeout(() => {
            pressTimer = null;
            longPressFired = true;
            selectionStore.toggle(props.note.id);
          }, 500);
        }
        if (!isDraggable()) return;
        // Left button only for a mouse; a touch/pen contact has button 0 too,
        // but the guard is really about right/middle-click on desktop.
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // Clicks on buttons/inputs inside the card shouldn't start a
        // drag — let the button handle its own onClick.
        if ((e.target as Element).closest('button, a, input, textarea, select')) return;
        props.onDragIntent?.(e, props.note.id);
      }}
      onPointerMove={(e) => {
        if (pressOrigin && Math.hypot(e.clientX - pressOrigin.x, e.clientY - pressOrigin.y) > 10) {
          cancelPress();
        }
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
    >
      {/* FIRST, so the tab order is open → select → the action strip. */}
      <button
        type="button"
        class="note-card-open"
        aria-label={openNoteLabel(props.note)}
        onKeyDown={handleOpenKeyDown}
      />
      <Show when={isSelectable()}>
      <button
        class="note-card-select"
        title={isSelected() ? 'Deselect' : 'Select note'}
        aria-label={isSelected() ? 'Deselect note' : 'Select note'}
        onClick={(e) => { e.stopPropagation(); selectionStore.toggle(props.note.id); }}
      >
        <Show when={isSelected()} fallback={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
          </svg>
        }>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9 12l2 2 4-4" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </Show>
      </button>
      </Show>
      <Show when={props.note.color}>
        <div class="note-color-bar" style={{ background: noteColorValue(props.note.color)! }} />
      </Show>
      <Show when={props.note.isPinned && props.viewMode !== 'trash'}>
        <span class="pin-badge" title="Pinned">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
        </span>
      </Show>
      {/* Corner marker so a checklist is identifiable at a glance, as on
          mobile. Same glyph as the checklist filter chip. Shifts left when a
          pin already occupies the corner. */}
      <Show when={isChecklist()}>
        <span
          class={
            props.note.isPinned && props.viewMode !== 'trash'
              ? 'checklist-badge checklist-badge-shifted'
              : 'checklist-badge'
          }
          title="Checklist"
          role="img"
          aria-label="Checklist"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 4.5 7.5 7.5 4.5" />
            <polyline points="3 12 4.5 13.5 7.5 10.5" />
            <polyline points="3 18 4.5 19.5 7.5 16.5" />
            <line x1="11" y1="6" x2="21" y2="6" />
            <line x1="11" y1="12" x2="21" y2="12" />
            <line x1="11" y1="18" x2="21" y2="18" />
          </svg>
        </span>
      </Show>
      <Show when={props.note.title}>
        <h3 class="note-card-title">{props.note.title}</h3>
      </Show>
      <Show when={isChecklist()} fallback={
        <Show when={hasContent()}>
          <div class="note-card-preview" innerHTML={previewHtml()} />
        </Show>
      }>
        <div class="note-card-checklist">
          <For each={uncheckedItems().slice(0, 5)}>
            {(item) => (
              <div class="note-card-checklist-row">
                <span class="note-card-checklist-box" aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                  </svg>
                </span>
                <span class="note-card-checklist-text">{item.text || '\u00a0'}</span>
              </div>
            )}
          </For>
          <Show when={uncheckedItems().length > 5}>
            <div class="note-card-checklist-more">+ {uncheckedItems().length - 5} more</div>
          </Show>
          <Show when={checkedCount() > 0}>
            <div class="note-card-checklist-completed">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              <span>{checkedCount()} completed</span>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.note.labels.length > 0 && props.viewMode !== 'trash'}>
        <div class="note-card-labels">
          {props.note.labels.map(l => <span class="label-chip">{l}</span>)}
        </div>
      </Show>
      {/* LINE 1 — where this note LIVES. Always the notebook, whoever owns it.
          Line 2 below is always the share fact, so the two slots mean the same
          thing on every card and the eye reads the difference instead of
          re-parsing the layout.

          A note shared with us carries the SENDER's notebook in
          `ownerNotebookId` (`notebookId` is nulled — that id names a notebook
          in their account), so both ids are read here: with `notebookId` alone
          a received note would show no notebook at all. */}
      <Show when={(props.note.notebookId || props.note.ownerNotebookId) && props.viewMode !== 'trash'}>
        {(() => {
          const ownName = () =>
            props.note.notebookId ? notebooksStore.getById(props.note.notebookId)?.name ?? null : null;
          /** Their notebook's name, when they shared the notebook object too. */
          const theirName = () =>
            props.note.ownerNotebookId
              ? sharesInboxStore.sharedNotebooks()
                  .find((s) => s.itemId === props.note.ownerNotebookId)?.note?.title ?? null
              : null;
          const name = () => ownName() ?? theirName();
          // A sender can share notes OUT of a notebook without sharing the
          // notebook object. We hold their id but no name for it, and "a
          // notebook" is still the honest answer — it is why this note is here.
          const label = () => name() ?? (props.note.ownerNotebookId ? 'A notebook' : null);
          if (!label()) return null;
          // Our own notebook, and we have shared it: the same marker the
          // sidebar row carries, so "this notebook is shared" reads the same
          // in both places. Line 2 then only has to speak about THIS note.
          const notebookIsShared = () =>
            !!props.note.notebookId
            && notebooksStore.getNotebookShares(props.note.notebookId).length > 0;
          return (
            <div class="note-card-notebook">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              <span>{label()}</span>
              <Show when={notebookIsShared()}>
                <span class="note-card-notebook-shared" role="img" aria-label="Shared notebook" title="This notebook is shared">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
                  </svg>
                </span>
              </Show>
            </div>
          );
        })()}
      </Show>

      <Show when={props.viewMode !== 'trash'}>
        {(() => {
          const share = sharesInboxStore.getByItemId(props.note.id);
          if (!share) return null;
          const label = share.sharerEmail ?? 'another user';
          // 'unverified' = first contact (TOFU): either the wrap was unsigned,
          // or it was signed but we hold no pin for this sender yet. Either way
          // the sender's identity rests on the server's word until they are
          // pinned, so say so rather than implying a checked identity.
          const unverified = share.wrapTrust === 'unverified';
          return (
            <div
              class="note-card-shared"
              title={unverified
                ? `Shared by ${label} — sender not verified yet`
                : `Shared by ${label}`}
            >
              {/* LINE 2, INBOUND. An arrow INTO a tray, not the outbound share
                  nodes: direction should be readable without reading. Where it
                  came FROM is line 1's job — repeating the notebook here would put
                  the same fact on the card twice. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span>Shared by {label}{unverified ? ' (unverified)' : ''}</span>
            </div>
          );
        })()}
      </Show>

      {/* LINE 2, OUTBOUND. "Sharing" — present tense, active voice, no agent:
          this is a thing YOU are doing. It sits directly under a line that may
          read "Shared by alice@…" on the next card along, and the pair of
          voices is what tells them apart at a glance.

          Not "Shared via notebook": that reads as something done TO you and
          puts an inbound-sounding sentence on your own notes. Where the share
          comes FROM is line 1's job: the notebook chip carries the share
          marker when the notebook itself is shared, exactly as the sidebar row
          does. Line 2 speaks only about this note.

          Hidden in trash, where the note is on its way out. */}
      <Show when={props.note.isShared && props.viewMode !== 'trash'}>
        {(() => {
          /**
           * How many people, in order of authority.
           *
           * 1. The server's `shared_with_count` — distinct recipients of THIS
           *    note, counted where the share rows are. It already includes
           *    shares a notebook granted, since sharing a notebook writes a row
           *    per note, so it is right for both kinds.
           * 2. The notebook's local roster — the fallback for a backend that
           *    predates the field, and only correct for notebook-derived
           *    shares.
           * 3. Nothing, and the label stays a bare "Sharing".
           *
           * Never 0-and-say-so: a note is only here because `isShared` is true,
           * so "with 0 people" would be self-contradicting.
           */
          const recipients = () => {
            const fromServer = props.note.sharedWithCount;
            if (typeof fromServer === 'number' && fromServer > 0) return fromServer;
            const id = props.note.notebookId;
            return id ? notebooksStore.getNotebookShares(id).length : 0;
          };
          const withWhom = () =>
            recipients() > 0
              ? ` with ${recipients()} ${recipients() === 1 ? 'person' : 'people'}`
              : '';
          return (
            <div
              class="note-card-shared-badge"
              title={recipients() > 0
                ? `You are sharing this, with everyone in its notebook (${recipients()} ` +
                  `${recipients() === 1 ? 'person' : 'people'})`
                : 'You are sharing this note'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              <span>Sharing{withWhom()}</span>
            </div>
          );
        })()}
      </Show>

      {/* Written offline, still in the replay queue. Says so plainly: the note
          is safe, and a row that looks identical to a synced one invites the
          person to close the app believing the server already has it. */}
      <Show when={props.note.pendingSync}>
        <div class="note-card-pending-badge" title="Saved on this device — will sync when you're back online">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
          </svg>
          <span>Not synced</span>
        </div>
      </Show>

      <Show when={props.note.hasAttachments}>
        <div class="note-card-attachment-badge" title="Has attachments">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </div>
      </Show>

      <Show when={remindersStore.byNoteId().get(props.note.id) && props.viewMode !== 'trash'}>
        {(() => {
          const r = remindersStore.byNoteId().get(props.note.id)!;
          const past = new Date(r.triggerAt).getTime() < Date.now();
          return (
            <span class={past ? 'reminder-chip reminder-chip-past' : 'reminder-chip'} title={formatReminder(r.triggerAt)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 2.6.8 5.1 2.3 7.3.4.6-.1 1.4-.9 1.4H3.6c-.8 0-1.3-.8-.9-1.4C4.2 14.1 5 11.6 5 9a7 7 0 0 1 7-7z"/><path d="M9 21a3 3 0 0 0 6 0"/></svg>
              <span>{formatReminder(r.triggerAt)}</span>
            </span>
          );
        })()}
      </Show>

      {/* Active/Archive actions — owner-centric (pin/share/archive/delete), so
          not shown on the shared-with-me inbox, which gets its own consent set. */}
      <Show when={props.viewMode !== 'trash' && props.viewMode !== 'inbox'}>
        <div class="note-card-actions" onClick={(e) => e.stopPropagation()}>
          <button class="card-action" onClick={props.onPin} title={props.note.isPinned ? 'Unpin' : 'Pin'}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill={props.note.isPinned ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
            </svg>
          </button>
          <button class="card-action" onClick={props.onShare} title="Share">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </button>
          <button class="card-action" onClick={props.onCopy} title="Copy">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="card-action" onClick={props.onArchive} title={props.viewMode === 'archived' ? 'Move to Notes' : 'Archive'}>
            <Show when={props.viewMode === 'archived'}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </Show>
            <Show when={props.viewMode !== 'archived'}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
            </Show>
          </button>
          <button class="card-action" onClick={props.onDelete} title="Delete">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </Show>

      {/* Trash actions */}
      <Show when={props.viewMode === 'trash'}>
        <div class="note-card-actions" onClick={(e) => e.stopPropagation()}>
          <button class="card-action" onClick={props.onRestore} title="Restore">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
          </button>
          <button class="card-action card-action-danger" onClick={props.onDelete} title="Delete forever">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      </Show>

      {/* Inbox (shared-with-me) recipient-consent actions */}
      <Show when={props.viewMode === 'inbox'}>
        <div class="note-card-actions" onClick={(e) => e.stopPropagation()}>
          <button class="card-action" onClick={props.onDismiss} title="Dismiss from inbox">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <button class="card-action card-action-danger" onClick={props.onBlock} title="Block sender">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
          </button>
        </div>
      </Show>
    </div>
  );
};

export default NoteCard;
