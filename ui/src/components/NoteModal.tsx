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

import { Component, createSignal, createEffect, createMemo, on, onMount, onCleanup, Show, For } from 'solid-js';
import { collabKeyFor, NoteItem, notesStore, openedWith, ownsSharedCache } from '../stores/notes';
import { apiRequest } from '../lib/apiClient';
import SharePanel from './SharePanel';
import NoteEditor, { type EditorHandle } from './NoteEditor';
import LabelEditor from './LabelEditor';
import ColorPicker from './ColorPicker';
import { settingsStore, type EditorMode } from '../stores/settings';
import { resolveMode, isPinned } from '../lib/editorModeOverrides';
import { notebooksStore } from '../stores/notebooks';
import AttachmentButton from './AttachmentButton';
import NoteToolDialog from './NoteToolDialog';
import NotebookPicker from './NotebookPicker';
import { confirmAction } from './ConfirmDialog';
import ReminderPicker from './ReminderPicker';
import { remindersStore } from '../stores/reminders';
import { formatReminder } from '../lib/reminderSchedule';
import ChecklistNoteEditor, { type ChecklistHandle } from './ChecklistNoteEditor';
import { dropTrailingEmptyItems, itemsToMarkdown, markdownToItems, type ChecklistItem } from '../lib/checklistItems';
import { attachmentsResealed, filesFromClipboard, uploadFile } from '../lib/attachmentUpload';
import { acquireLock, peekLock, releaseLock, type LockRecord } from '../lib/editLock';
import { authStore } from '../stores/auth';
import { CollabSession } from '../lib/collab';
import { sharesInboxStore } from '../stores/sharesInbox';
import { putDraft, getDraft, removeDraft } from '../lib/noteDb';
import { watchKeyboard } from '../lib/keyboardWatcher';

/**
 * The sections `bottom-hidden` removes, as a selector list.
 *
 * A HAND-MAINTAINED MIRROR of this rule in index.css:
 *
 *     .note-modal.bottom-hidden .note-modal-tools { display: none; }
 *
 * It is ONE row. The colour/label controls live in dialogs and the action
 * icons on the footer's own line, so collapsing hides the tool row and nothing
 * else — the four actions, the mode button and Done stay put with the keyboard
 * up, which is where a person needs them. The save state is not in here at
 * all: it rides the title line, which never collapses.
 *
 * The keyboard watcher declines to collapse when focus is inside one of them,
 * because focusing a text field there raises the keyboard, and collapsing on
 * THAT deletes the field being typed into and takes focus with it — nothing
 * could be typed into it on a phone at all. Nothing in either language binds
 * the two lists; if the CSS rule gains or loses a section and this does not
 * follow, that failure returns. `lib/chromeCollapse.test.ts` is the binding:
 * it parses both and fails on a drift.
 */
export const BOTTOM_HIDDEN_SECTIONS = '.note-modal-tools';

type Tool = null | 'colour' | 'labels' | 'attachments';

interface Props {
  note: NoteItem;
  onClose: () => void;
  /** Open with a tool already showing. The composer uses this: attachments
   *  belong to a SAVED note (they are encrypted with its content key and
   *  uploaded against its id), so "attach" on a draft creates the note first
   *  and lands here with the picker open. */
  initialTool?: Tool;
}

const NoteModal: Component<Props> = (props) => {
  // Capture the note id up-front. Solid's `props` is a live proxy —
  // when the parent flips `editingNote()` to null to unmount us, any
  // cleanup code reading `noteId` crashes because `props.note`
  // goes null before onCleanup runs.
  const noteId = props.note.id;

  // --- Editor mode for THIS note ---
  //
  // The global setting is the default; cycling here pins the open note. Coming
  // back round to whatever the global currently is un-pins it, so the note
  // follows the default again — that reversal is the only way out, which is
  // why the button keeps cycling through all three rather than toggling.
  const globalMode = () => settingsStore.settings().editorMode;
  const noteMode = () => resolveMode(notebooksStore.editorModes(), noteId, globalMode());
  const notePinned = () => isPinned(notebooksStore.editorModes(), noteId, globalMode());
  /** Display name for a mode, so the tooltip never interpolates the raw
   *  enum ("keeps its own mode, hybrid") next to a button labelled
   *  "Hybrid". */
  const modeName = (m: string) =>
    m === 'hybrid' ? 'Hybrid' : m === 'markdown' ? 'Markdown' : 'Preview';
  const cycleNoteMode = () => {
    const modes: EditorMode[] = ['hybrid', 'markdown', 'preview'];
    const next = modes[(modes.indexOf(noteMode()) + 1) % modes.length];
    notebooksStore.setEditorModeFor(noteId, next, globalMode());
  };

  const [title, setTitle] = createSignal(props.note.title);
  const [fmtActive, setFmtActive] = createSignal({ bold: false, italic: false, strike: false, code: false });
  const [body, setBody] = createSignal(props.note.body);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [showShare, setShowShare] = createSignal(false);
  const [showReminder, setShowReminder] = createSignal(false);
  const [labels, setLabels] = createSignal<string[]>(props.note.labels || []);
  const [noteColor, setNoteColor] = createSignal<string | null>(props.note.color);
  const [notebookId, setNotebookId] = createSignal<string | null>(props.note.notebookId);
  const [attachments, setAttachments] = createSignal<any[]>([]);
  /**
   * Colour palette + label row + notebook picker: collapsed until asked for.
   *
   * Eleven colour dots over two rows, a label field and a notebook select take
   * ~180px of EVERY modal when always open, whether or not the person opening
   * the note intends to touch any of them — and the editor is what is left
   * over. In a 900px window that leaves the note itself about 330px, so a long
   * note scrolls inside a small box under a large permanently-open toolbox.
   *
   * Collapsed does not mean hidden: the row summarises what is currently set,
   * so the note's colour, labels and notebook are still readable at a glance —
   * only the CONTROLS are behind the click.
   */
  /** Which tool dialog is open, if any. One at a time by construction. */
  const [tool, setTool] = createSignal<Tool>(props.initialTool ?? null);
  const notebookName = () =>
    notebooksStore.notebooks().find(nb => nb.id === notebookId())?.name ?? null;
  const [maximized, setMaximized] = createSignal(settingsStore.settings().alwaysMaximize);
  // --- Phone chrome collapse -----------------------------------------------
  // With the IME up a phone keeps ~5 text lines once the title, the two-row
  // format toolbar, attachments, labels, the palette and the action row have
  // taken their fixed share of the shrunken 100dvh. So the bottom chrome
  // (attachments/labels/palette/actions) yields to the KEYBOARD — and to
  // nothing else.
  //
  // It does not start collapsed, which would be wrong in a way that only shows
  // on a phone: card hover actions do not exist on touch, so the moment a note
  // opened, pin, remind, share, copy, archive, DELETE, colour, labels, notebook
  // and attachments would all be display:none behind a bare chevron — every
  // action the note has, hidden at rest with no hint that anything was there.
  // Collapsing is something the keyboard causes; it is not the resting state.
  //
  // The top (format toolbar) starts visible and only moves by hand via its own
  // chevron pair. Desktop never engages: the .top-hidden/.bottom-hidden CSS
  // and the expanders live exclusively in the max-width:600px block, so the
  // signals are inert anywhere wider.
  const [topHidden, setTopHidden] = createSignal(false);
  const [bottomHidden, setBottomHidden] = createSignal(false);
  // Set when the PERSON collapsed the bottom chrome with its chevron, cleared
  // when they expand it again. The keyboard's collapse is undone when the
  // keyboard goes away; a deliberate one is not — see the watcher in onMount.
  const [userCollapsed, setUserCollapsed] = createSignal(false);
  const [otherEditor, setOtherEditor] = createSignal<LockRecord | null>(null);
  let lockHeartbeat: ReturnType<typeof setInterval> | null = null;
  let lockPoll: ReturnType<typeof setInterval> | null = null;
  let collabSession: CollabSession | null = null;
  const [collabConnected, setCollabConnected] = createSignal(false);
  const [collabPeers, setCollabPeers] = createSignal(0);
  const [collabSessionSig, setCollabSessionSig] = createSignal<CollabSession | null>(null);

  // Per-note content key for attachments — the same key the note BODY uses.
  // resolveCollabSecret() (declared below, hoisted) yields the content key for
  // both the owner (vault-unwrapped) and a share recipient (from the inbox),
  // so attachments encrypt/decrypt with a shareable key. Null for legacy
  // vault-only notes / before crypto is ready → attachment UI is hidden.
  const attachmentContentKey = createMemo<Uint8Array | null>(() => resolveCollabSecret());

  const isChecklist = () => props.note.noteType === 'checklist';
  const initialItems: ChecklistItem[] = isChecklist()
    ? (props.note.checklistItems?.length ? props.note.checklistItems : markdownToItems(props.note.body))
    : [];
  const [checklistItems, setChecklistItems] = createSignal<ChecklistItem[]>(initialItems);

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let editorHandle: EditorHandle | null = null;
  let checklistHandle: ChecklistHandle | null = null;

  // --- Crash-window draft stash --------------------------------------------
  // The 1500ms debounce RESETS on every keystroke, so continuous typing
  // defers the save indefinitely — and a crash mid-typing (screen on, so no
  // visibilitychange fires either) would lose everything since the last pause.
  // While dirty, the live draft goes to IDB once a second on a FIXED interval;
  // a save that lands with nothing typed during it removes the entry, so a
  // surviving draft at next open means the process died with unsaved text.
  let draftTimer: ReturnType<typeof setInterval> | null = null;
  // The note version the draft is typed against, from the LIVE store row —
  // props.note is the object the modal opened with, and our own saves bump
  // the version past it (a stale base would make every post-crash restore
  // look like a cross-device conflict and get dropped).
  const liveVersion = () =>
    notesStore.notes().find(n => n.id === noteId)?.version ?? props.note.version;
  const stashDraft = () => {
    // Same ownership rule as every plaintext write to the shared cache: a
    // stale tab of a signed-out account must not stash into the next
    // account's store.
    if (!dirty() || !ownsSharedCache()) return;
    void putDraft({
      id: noteId,
      title: title(),
      body: isChecklist() ? itemsToMarkdown(checklistItems()) : body(),
      checklistItems: isChecklist() ? checklistItems() : undefined,
      labels: labels(),
      color: noteColor(),
      notebookId: notebookId(),
      baseVersion: liveVersion(),
      stashedAt: Date.now(),
    });
  };
  const stopDraftTimer = () => {
    if (draftTimer) { clearInterval(draftTimer); draftTimer = null; }
  };
  // Applied by NoteEditor's onReady when the draft read wins the race with
  // the (lazy) editor mount; setContent dispatches a real change, so
  // onChange -> setBody -> scheduleSave runs and the restore gets saved.
  let pendingRestoreBody: string | null = null;

  /**
   * Why this note's changes cannot reach the server right now, or null.
   *  - `key`: its content key does not open with the keys this browser holds
   *    (updateNote refused rather than re-key it — see notesStore).
   *  - `locked`: this tab holds no E2EE keys at all yet.
   */
  const cannotSave = (): 'key' | 'locked' | null =>
    notesStore.keyRefusedIds().has(noteId) ? 'key'
      : authStore.keysUnavailable() !== null ? 'locked'
      : null;

  const scheduleSave = () => {
    setDirty(true);
    if (!draftTimer) draftTimer = setInterval(stashDraft, 1000);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 1500);
  };

  const saveNow = async () => {
    if (!dirty()) return;
    setSaving(true);
    // Clear dirty BEFORE the round-trip so edits typed DURING the await (which
    // re-set dirty via scheduleSave) are not clobbered. Clearing it AFTER the
    // await would leave a keystroke that landed mid-save with its debounced
    // re-save short-circuiting on `!dirty()` — the edit would be lost.
    setDirty(false);
    let ok = false;
    try {
      if (isChecklist()) {
        // Trimmed for STORAGE only — the signal keeps the row, so the
        // empty one the user just added stays on screen with the cursor
        // in it. It reaches the note the moment it has text. Without
        // this, tapping the add row and closing would leave a blank
        // checkbox drawn on the card. Trailing only; see
        // lib/checklistItems for why a blank row in the MIDDLE stays.
        const items = dropTrailingEmptyItems(checklistItems());
        ok = await notesStore.updateNote(noteId, {
          title: title(),
          body: itemsToMarkdown(items),
          checklistItems: items,
          labels: labels(),
          color: noteColor(),
          notebookId: notebookId(),
        });
      } else {
        ok = await notesStore.updateNote(noteId, {
          title: title(),
          body: body(),
          labels: labels(),
          color: noteColor(),
          notebookId: notebookId(),
        });
      }
    } finally {
      // ALWAYS clear it. Without the finally, anything updateNote throws —
      // a crypto failure, a network error, a rejected fetch — would leave `saving`
      // true for the life of the modal, so the note would sit there reading
      // "Saving..." forever with nothing in flight.
      setSaving(false);
    }
    // updateNote returns false when the server did not accept the write. For a
    // transient error it has already queued the snapshot for offline replay
    // (data is safe); re-marking dirty is the conservative choice — the note
    // stays flagged unsaved so close()/onCleanup fire another save and a genuine
    // non-queued 4xx still has a retry path rather than being silently dropped.
    if (!ok) setDirty(true);
    else if (!dirty()) {
      // Saved, and nothing was typed during the await — the draft is
      // confirmed superseded (a transient-queued snapshot counts: the
      // pending store now carries the text). Keystrokes that landed
      // mid-save re-set dirty, and the next interval tick re-stashes.
      stopDraftTimer();
      void removeDraft(noteId);
    }
  };

  const close = () => {
    // Fire-and-forget the final save. If the network is slow or the
    // server 5xxs, onCleanup still runs one last saveNow and the dirty
    // replay loop catches it on next sync. Awaiting here would trap
    // the modal open whenever the request hangs.
    if (saveTimer) clearTimeout(saveTimer);
    if (dirty()) saveNow().catch((e) => console.warn('[NoteModal] save on close failed', e));
    props.onClose();
  };

  const handlePin = async () => {
    await notesStore.updateNote(noteId, { isPinned: !props.note.isPinned });
  };

  const handleArchive = async () => {
    await notesStore.updateNote(noteId, { isArchived: !props.note.isArchived });
    props.onClose();
  };

  /**
   * Moving the whole note to Trash from inside the editor asks first, as
   * deleting one attachment out of the same modal and delete-forever do: the
   * app guards its large destructions as well as its small ones. The
   * reversible path says so plainly; the permanent one in NotesView says the
   * opposite, which is the distinction a native confirm() could never draw and
   * the whole reason ConfirmDialog exists.
   */
  const handleDelete = async () => {
    if (!(await confirmAction({
      message: 'Move this note to Trash?',
      detail: `${props.note.title?.trim() || 'This note'} stays in Trash until you empty it, and can be restored from there.`,
      confirmLabel: 'Move to Trash',
      destructive: true,
    }))) return;
    await notesStore.deleteNote(noteId);
    props.onClose();
  };

  // Track mousedown origin to prevent closing when drag-selecting text
  // and the mouse ends up outside the modal
  let mouseDownOnOverlay = false;

  const handleBackdropDown = (e: MouseEvent) => {
    mouseDownOnOverlay = (e.target as HTMLElement).classList.contains('note-modal-overlay');
  };

  const handleBackdropUp = (e: MouseEvent) => {
    if (mouseDownOnOverlay && (e.target as HTMLElement).classList.contains('note-modal-overlay')) {
      close();
    }
    mouseDownOnOverlay = false;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  const handlePaste = async (e: ClipboardEvent) => {
    const files = filesFromClipboard(e);
    if (files.length === 0) return;
    e.preventDefault();
    const contentKey = attachmentContentKey();
    if (!contentKey) {
      console.warn('Paste upload skipped: no content key for note', noteId);
      return;
    }
    for (const file of files) {
      const result = await uploadFile(noteId, file, contentKey);
      if (!result.success) {
        console.warn('Paste upload failed:', result.error);
      }
    }
    // Refresh attachments list + flip hasAttachments on the note.
    const r = await apiRequest<any[]>(`/api/v1/items/${noteId}/attachments`);
    if (r.success) {
      setAttachments(r.data);
      notesStore.updateNote(noteId, { hasAttachments: r.data.length > 0 });
    }
  };

  // Identity captured at component scope so openCollabSession (declared
  // below, called from onMount) can see them too — without this, strict-
  // mode module code throws ReferenceError on first note open.
  const me = authStore.user();
  const displayName = (me as any)?.display_name || me?.email || '';
  const myId = me?.id;

  // The re-key after a removal and "Keep file" both re-seal this note's files
  // on the server while the list here still holds the rows from before, so
  // each one would read as unconfirmed until the note is reopened. Re-read it
  // when this page re-sealed any of them.
  createEffect(on(attachmentsResealed, (r) => {
    if (!r || r.noteId.toLowerCase() !== noteId.toLowerCase()) return;
    apiRequest<any[]>(`/api/v1/items/${noteId}/attachments`).then(res => {
      if (res.success) setAttachments(res.data);
    });
  }, { defer: true }));

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('paste', handlePaste);
    // The toolbar stays through keyboard transitions (collapse it by hand with
    // its chevron). The bottom sections lend their space to the keyboard and
    // TAKE IT BACK when the keyboard goes.
    const unwatchKeyboard = watchKeyboard((up) => {
      if (!up) {
        // The collapse must not be one-way: if nothing but the slim
        // bar ever set this false again, one viewport shrink would
        // strip every action off the note for the rest of its life.
        // A hand-made collapse is the one thing that survives the
        // keyboard going away — the person meant it.
        if (!userCollapsed()) setBottomHidden(false);
        return;
      }
      // ... UNLESS the keyboard that just opened belongs to the row we would
      // hide: hiding it would display:none the field being typed into and
      // take focus with it, so nothing could be typed there on a phone at
      // all. The text fields — the label input above all — live in dialogs,
      // which `bottom-hidden` does not touch.
      //
      // The guard stays anyway. It is cheap, it makes that failure
      // impossible rather than merely unlikely, and `.note-modal-tools`
      // can gain a focusable control at any time — the three buttons in it are
      // focusable right now. The selector is exactly what the rule hides (see
      // BOTTOM_HIDDEN_SECTIONS); anything else focused — the body editor,
      // which is what this collapse is FOR — still yields the space.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest(BOTTOM_HIDDEN_SECTIONS)) {
        return;
      }
      setBottomHidden(true);
    });
    onCleanup(unwatchKeyboard);

    // Restore a crash-surviving draft. Only against the exact version it was
    // typed on: if another device's edit arrived in between, the crashed
    // keystrokes are superseded work and restoring them would clobber the
    // newer note — the guard drops the draft instead (the rare case).
    void getDraft(noteId).then((draft) => {
      if (!draft || draft.baseVersion !== liveVersion()) {
        if (draft) void removeDraft(noteId);
        return;
      }
      const current = isChecklist() ? itemsToMarkdown(checklistItems()) : body();
      if (draft.body === current && draft.title === title()) {
        void removeDraft(noteId);
        return;
      }
      setTitle(draft.title);
      setLabels(draft.labels);
      setNoteColor(draft.color);
      setNotebookId(draft.notebookId);
      if (isChecklist()) {
        setChecklistItems(draft.checklistItems ?? markdownToItems(draft.body));
      } else if (editorHandle) {
        editorHandle.setContent(draft.body);
      } else {
        setBody(draft.body);
        pendingRestoreBody = draft.body;
      }
      // Make the restore durable: dirty + the normal save path.
      scheduleSave();
    });
    // Load attachments
    apiRequest<any[]>(`/api/v1/items/${noteId}/attachments`).then(r => {
      if (r.success) setAttachments(r.data);
    });

    // Cooperative edit lock: acquire on open, heartbeat every 30s, and
    // poll every 5s to notice if someone else has taken over. Two rules
    // keep a retained document from heartbeating a deleted note's lock
    // indefinitely:
    //  - a hidden document releases the lock and stops both timers — nobody
    //    is editing behind a turned-off screen, and TRIM_MEMORY discard is
    //    not guaranteed to ever fire on an idle device;
    //  - three consecutive gone-forever failures (401/403 dead session,
    //    404 deleted note) stop the timers for the modal's lifetime.
    let lockHardFails = 0;
    const stopLockTimers = () => {
      if (lockHeartbeat) { clearInterval(lockHeartbeat); lockHeartbeat = null; }
      if (lockPoll) { clearInterval(lockPoll); lockPoll = null; }
    };
    const noteLockResult = (r: import('../lib/editLock').LockResult) => {
      if (r.ok) {
        lockHardFails = 0;
        if (r.record && r.record.holder_user_id !== myId) {
          setOtherEditor(r.record);
        } else {
          setOtherEditor(null);
        }
        return;
      }
      if (r.status === 401 || r.status === 403 || r.status === 404) {
        if (++lockHardFails >= 3) {
          stopLockTimers();
          console.warn('edit-lock heartbeat stopped: session or note is gone', r.status);
        }
      }
    };
    const refreshLock = async () => noteLockResult(await acquireLock(noteId, displayName));
    const checkLock = async () => noteLockResult(await peekLock(noteId));
    const startLockTimers = () => {
      if (lockHeartbeat || lockPoll) return;
      refreshLock();
      lockHeartbeat = setInterval(refreshLock, 30_000);
      lockPoll = setInterval(checkLock, 5_000);
    };
    const onLockVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stopLockTimers();
        releaseLock(noteId).catch(() => {});
      } else {
        lockHardFails = 0;
        startLockTimers();
      }
    };
    document.addEventListener('visibilitychange', onLockVisibility);
    onCleanup(() => document.removeEventListener('visibilitychange', onLockVisibility));

    startLockTimers();

    // Real-time collaboration — text notes only, since checklists use a
    // separate structured editor, and only for notes somebody else can
    // actually be editing.
    if (!isChecklist() && canHaveCollaborators()) {
      openCollabSession();
    }
  });

  /**
   * Could anyone else be in this note?
   *
   * Opening a session costs an 88KB yjs chunk, a WebSocket and an AEAD
   * handshake, which would be paid on EVERY text note — including the
   * overwhelming majority that have never been shared with anyone and
   * therefore cannot have a second participant. Sharing state is the honest
   * proxy for "a collaborator is possible": `isShared` is the server's own
   * `shared_by_me`, and an inbox entry means someone shared it with US.
   */
  const canHaveCollaborators = () => {
    // Read the LIVE row, not props.note: the prop is the snapshot the
    // modal opened with, so sharing a note you are already editing would
    // never flip it and the owner's session would never open — the peer
    // would sit alone in the room ("Live", zero others) with no sync.
    // The store read keeps this reactive, which is the whole point of
    // the late-open effect below.
    const live = notesStore.notes().find(n => n?.id === noteId);
    return !!(live ? live.isShared : props.note.isShared)
      // An incoming share makes a room only for a note its key opened.
      || (!!sharesInboxStore.getByItemId(noteId) && openedWith(live ?? props.note) === 'share');
  };

  /**
   * ...and open one late if that changes while the note is open, so sharing a
   * note you are already editing still gives you live collaboration without a
   * reopen. `isShared` comes from the notes signal, so this re-runs when the
   * next sync reports the share.
   */
  createEffect(() => {
    if (isChecklist() || collabSession || !canHaveCollaborators()) return;
    openCollabSession();
  });

  // Cached secret, kept to detect a rotation (content-key change while the
  // modal is open). When the wrapped key on the current note changes or a
  // fresh share-inbox entry arrives, we tear down the session and reopen
  // with the new key so Yjs frames keep decrypting.
  let activeCollabKey: Uint8Array | null = null;

  function resolveCollabSecret(): Uint8Array | null {
    const live = notesStore.notes().find(n => n?.id === noteId) ?? props.note;
    return collabKeyFor(live, sharesInboxStore.getByItemId(noteId));
  }

  function openCollabSession() {
    const secret = resolveCollabSecret();
    activeCollabKey = secret;
    collabSession = new CollabSession(noteId, props.note.body, {
      name: displayName || 'Someone',
      color: '',
      userId: myId || '',
    }, secret);
    collabSession.onConnectionChange(setCollabConnected);
    collabSession.onPeersChange(setCollabPeers);
    collabSession.onRemoteChange(() => {
      const next = collabSession!.getText();
      setBody(next);
      scheduleSave();
    });
    collabSession.connect();
    // `collabSession` is a plain variable assigned AFTER first render — a
    // Show or JSX prop reading it directly can never react. The signal is
    // what the pill's <Show> and NoteEditor's yText/awareness props read:
    // without it the indicator would never appear and the editor would bind
    // to a null Y.Text forever (local edits would never enter the Yjs doc).
    setCollabSessionSig(collabSession);
  }

  function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Watch for rotation. Whenever the note's wrapped key or the inbox
  // share's content key changes, compare against what the live session
  // was opened with — destroy + reopen on mismatch.
  createEffect(() => {
    if (isChecklist() || !collabSession) return;
    // Track both signals so Solid re-runs on either change.
    const live = notesStore.notes().find(n => n?.id === noteId);
    const inbox = sharesInboxStore.getByItemId(noteId);
    void live?.wrappedContentKey; void inbox?.contentKey;
    const next = resolveCollabSecret();
    if (!bytesEqual(next, activeCollabKey)) {
      collabSession?.destroy();
      collabSession = null;
      openCollabSession();
    }
  });

  onCleanup(() => {
    if (dirty()) saveNow();
    if (saveTimer) clearTimeout(saveTimer);
    stopDraftTimer();
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('paste', handlePaste);
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    if (lockPoll) clearInterval(lockPoll);
    // Best-effort release. Server ignores if someone else holds it.
    releaseLock(noteId).catch(() => {});
    collabSession?.destroy();
    collabSession = null;
  });

  return (
    <div class="note-modal-overlay" onMouseDown={handleBackdropDown} onMouseUp={handleBackdropUp}>
      <div
        class={maximized() ? 'note-modal note-modal-maximized' : 'note-modal'}
        classList={{ 'top-hidden': topHidden(), 'bottom-hidden': bottomHidden() }}
      >
        <Show when={collabSessionSig() && !isChecklist()}>
          <div class="note-modal-collab-status" title={collabConnected() ? 'Synced in real time' : 'Reconnecting…'}>
            <span class={collabConnected() ? 'collab-dot connected' : 'collab-dot'} />
            <Show when={collabPeers() > 0} fallback={
              <span>{collabConnected() ? 'Live' : 'Reconnecting…'}</span>
            }>
              <span>{collabPeers() === 1 ? '1 other editing' : `${collabPeers()} others editing`}</span>
            </Show>
          </div>
        </Show>
        <Show when={noteColor()}>
          <div class="note-color-bar modal-color-bar" style={{ background: noteColor()! }} />
        </Show>
        <Show when={otherEditor()}>
          <div class="note-modal-coedit-banner" role="alert">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="7" r="4"/>
              <path d="M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2"/>
            </svg>
            <span>
              <strong>{otherEditor()!.holder_display_name || 'Someone else'}</strong>
              {' is editing this note — your changes may conflict.'}
            </span>
          </div>
        </Show>
        {/* The title line carries the save state, the maximize toggle and the
            toolbar caret, so none of them costs a row of its own. The caret is
            ONE button that flips its icon rather than two that appear in
            different places: sitting at the title's right edge in BOTH states,
            it does not move when the toolbar opens, so the target stays where
            the hand left it.

            ⚠️ The maximize toggle is IN this row, not floating over it: a
            `position: absolute` toggle on `.note-modal` would lay a 32x32
            button over the right end of this very line — covering all but 15px²
            of the word "Saved" on a desktop, where the caret is display:none
            and the indicator is the last thing in the row. The two controls are
            never both visible (maximize is hidden on a phone, the caret only
            exists there), so the row holds either one without crowding. */}
        <div class="note-titlebar">
          <input
            class="note-modal-title"
            type="text"
            placeholder="Title"
            value={title()}
            onInput={(e) => { setTitle(e.currentTarget.value); scheduleSave(); }}
          />
          <span class="save-indicator" role="status" aria-live="polite">
            {cannotSave() ? 'Not saved' : saving() || dirty() ? 'Saving…' : 'Saved'}
          </span>
          <button
            class="note-modal-maximize"
            onClick={() => setMaximized(v => !v)}
            title={maximized() ? 'Restore' : 'Maximize'}
            aria-label={maximized() ? 'Restore note' : 'Maximize note'}
          >
            <Show when={maximized()} fallback={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 3h6v6"/>
                <path d="M9 21H3v-6"/>
                <path d="M21 3l-7 7"/>
                <path d="M3 21l7-7"/>
              </svg>
            }>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 14h6v6"/>
                <path d="M20 10h-6V4"/>
                <path d="M14 10l7-7"/>
                <path d="M3 21l7-7"/>
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
        {/* Why this note's changes are NOT reaching the server, when the answer
            is not "a save is in flight". Without it a refused save would read
            "Saving…" for the life of the modal. */}
        <Show when={cannotSave()}>
          <div class="notice-warning note-modal-save-refused" role="alert">
            <Show
              when={cannotSave() === 'key'}
              fallback={
                <Show
                  when={authStore.keysUnavailable() !== 'app'}
                  fallback={<>
                    Your notes are locked in this app, so changes can't be saved yet.
                    Sign out and sign in again in the app — your text stays here in
                    the meantime.
                  </>}
                >
                  Your notes are locked in this tab, so changes can't be saved yet.{' '}
                  <a href={authStore.unlockUrl()}>Unlock your notes</a> first — your
                  text stays here in the meantime.
                </Show>
              }
            >
              This note can't be saved from this browser: it's from before a password
              reset, and this browser can't open it yet. Your changes are kept on this
              device and save once it's restored (Account → Settings → Data from before
              your password reset).
            </Show>
          </div>
        </Show>

        {/* Toolbar — inserts markdown syntax (text notes only) */}
        <Show when={!isChecklist()}>
        <div class="format-toolbar-row">
        <div class="format-toolbar" onPointerDown={(e) => { if ((e.target as HTMLElement).closest('.fmt-btn')) e.preventDefault(); }}>
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
        {/* No caret here: sticky inside the scroller would pin it
            over a button. It sits on the TITLE LINE, so it does not
            move when the toolbar opens or closes. */}
        </div>
        </Show>

        {/* Checklist toolbar — undo/redo only (Keep-style; no markdown modes) */}
        <Show when={isChecklist()}>
        <div class="format-toolbar-row">
        <div class="format-toolbar" onPointerDown={(e) => { if ((e.target as HTMLElement).closest('.fmt-btn')) e.preventDefault(); }}>
          <button class="fmt-btn" onClick={() => checklistHandle?.undo()} title="Undo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
          </button>
          <button class="fmt-btn" onClick={() => checklistHandle?.redo()} title="Redo">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
          </button>
        </div>
        {/* No caret here: sticky inside the scroller would pin it
            over a button. It sits on the TITLE LINE, so it does not
            move when the toolbar opens or closes. */}
        </div>
        </Show>

        {/* Editor — branch by note type */}
        <Show when={isChecklist()} fallback={
          <NoteEditor
            value={body()}
            noteId={noteId}
            onChange={(v) => { setBody(v); scheduleSave(); }}
            placeholder="Take a note..."
            onStylesChange={setFmtActive}
            onReady={(h) => {
              editorHandle = h;
              if (pendingRestoreBody !== null) {
                h.setContent(pendingRestoreBody);
                pendingRestoreBody = null;
              }
            }}
            yText={collabSessionSig()?.yText}
            awareness={collabSessionSig()?.awareness}
          />
        }>
          <ChecklistNoteEditor
            items={checklistItems()}
            onChange={(items) => { setChecklistItems(items); scheduleSave(); }}
            onReady={(h) => { checklistHandle = h; }}
          />
        </Show>

        {/* Share and Remind sit ABOVE the action row, not after it. Rendered
            last, the share panel would draw BELOW the modal's own Preview/Close
            bar, so the modal's "Close" and the panel's "Done" would end up
            stacked as two exits with different meanings — and on the Android
            shell, which renders this same panel, the note tools bar would sit
            between them. The reminder picker is position:absolute so its
            placement is unaffected by the order; it travels with Share to keep
            the two popovers adjacent in the source. */}
        <Show when={showShare()}>
          <SharePanel noteId={noteId} onClose={() => setShowShare(false)} />
        </Show>

        <Show when={showReminder()}>
          <ReminderPicker
            noteId={noteId}
            existing={remindersStore.byNoteId().get(noteId)}
            onClose={() => setShowReminder(false)}
          />
        </Show>

        {/* ROW 1 — the tools. Each opens a dialog; none of them expands in
            place, which keeps this chrome to two rows. `bottom-hidden` hides
            exactly this row. */}
        <div class="note-modal-tools">
          {/* Each button SHOWS what is set, so the dialog is for changing a
              value rather than for finding out what it is. On a phone Colour
              and Attachments show only their icons (`.note-tool-icon-only` in
              index.css) so Labels & Notebooks fits whole; their words stay
              for screen readers. No title: above 600px the words are on
              screen, a phone has no hover, and a title that differs from the
              name ("Attachments" vs "Attachments 2") is read out again as a
              description. */}
          <button class="note-tool note-tool-icon-only" onClick={() => setTool('colour')}>
            <span
              class="note-tool-swatch"
              classList={{ none: !noteColor() }}
              style={noteColor() ? { background: noteColor()! } : undefined}
              aria-hidden="true"
            />
            <span class="note-tool-text">Colour</span>
          </button>

          <button class="note-tool" onClick={() => setTool('labels')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.59 13.41 12 22l-9-9V3h10l7.59 7.59a2 2 0 0 1 0 2.82z"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor"/></svg>
            <span class="note-tool-text">Labels &amp; Notebooks</span>
            <Show when={labels().length}>
              <span class="note-tool-count">{labels().length}</span>
            </Show>
          </button>

          <button class="note-tool note-tool-icon-only" onClick={() => setTool('attachments')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            <span class="note-tool-text">Attachments</span>
            <Show when={attachments().length}>
              <span class="note-tool-count">{attachments().length}</span>
            </Show>
          </button>
        </div>

        {/* ROW 2 — four actions on the left, the mode/save/exit cluster on the
            right. Pin and Archive are not here: both are list-level decisions about
            where a note LIVES, both are already on the card's own action strip
            and in the selection bar, and neither is something you reach for
            with the note open in front of you. */}
        <div class="note-modal-footer">
          {/* The tools caret lives on the footer, at its left edge, in BOTH
              states. As two buttons in two different rows, opening the tools
              would move the control that closes them up a row and the next tap
              would land on Colour. The footer is the row that is always on
              screen, so anchoring it here is what keeps it still. Collapsing
              sets `userCollapsed`, which outlives the next keyboard-down;
              expanding clears it, handing the row back to the keyboard. */}
          <button
            class="chrome-toggle chrome-toggle-bottom"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              const hide = !bottomHidden();
              setBottomHidden(hide);
              setUserCollapsed(hide);
            }}
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
          <div class="note-modal-actions">
            <button
              class={remindersStore.byNoteId().has(noteId) ? 'card-action card-action-active' : 'card-action'}
              onClick={() => setShowReminder(s => !s)}
              title={remindersStore.byNoteId().get(noteId) ? `Reminder: ${formatReminder(remindersStore.byNoteId().get(noteId)!.triggerAt)}` : 'Remind me'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 2.6.8 5.1 2.3 7.3.4.6-.1 1.4-.9 1.4H3.6c-.8 0-1.3-.8-.9-1.4C4.2 14.1 5 11.6 5 9a7 7 0 0 1 7-7z"/><path d="M9 21a3 3 0 0 0 6 0"/></svg>
            </button>
            {/* Lit when the note is already shared, so the state is visible
                without opening the panel. Reads `isShared` from the synced row
                (server-computed), not from the encrypted content. */}
            <button
              class={props.note.isShared ? 'card-action is-shared' : 'card-action'}
              onClick={() => setShowShare(s => !s)}
              title={props.note.isShared ? 'Shared — manage access' : 'Share'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            </button>
            <button class="card-action" onClick={() => {
              const text = [title(), body()].filter(Boolean).join('\n\n');
              navigator.clipboard.writeText(text);
            }} title="Copy">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="card-action" onClick={handleDelete} title="Delete">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
          <div class="note-modal-status">
          {/* The mode button says "keeps its own mode", never "pinned" — the
              pin badge and the Pinned grid section already own that word for
              something else entirely. */}
            <button
              class="fmt-btn fmt-mode-btn"
              /* Keeps the caret — and therefore the keyboard — where it is.
                 `.format-toolbar` does this for every `.fmt-btn` inside it;
                 this button carries the same class but sits in the footer, so
                 without this it would be the one control that blurs the editor,
                 drops the IME, and takes the note's visible height with it. */
              onPointerDown={(e) => e.preventDefault()}
              onClick={cycleNoteMode}
              title={notePinned()
                ? `This note keeps its own mode, ${modeName(noteMode())}. Keep clicking to reach ${modeName(globalMode())} and it will follow the default again.`
                : `Editor mode for this note (currently the default, ${modeName(globalMode())}). Click to give this note its own mode.`}
            >
              <span class="mode-label">{modeName(noteMode())}</span>
              <span class="mode-scope" classList={{ pinned: notePinned() }}>
                {notePinned() ? '(this note)' : '(default)'}
              </span>
            </button>
            {/* The save state is on the TITLE line — see the titlebar. */}
            <button class="btn btn-sm" onClick={close}>Done</button>
          </div>
        </div>

        {/* The tool dialogs. Rendered last so they stack above the modal. */}
        <Show when={tool() === 'colour'}>
          <NoteToolDialog title="Colour" onClose={() => setTool(null)}>
            <ColorPicker selected={noteColor()} onChange={(c) => { setNoteColor(c); scheduleSave(); }} />
          </NoteToolDialog>
        </Show>

        <Show when={tool() === 'labels'}>
          {/* The notebook lives here rather than under Colour: both answer
              "where does this note belong", and the title says so instead of
              leaving it to be discovered. */}
          <NoteToolDialog title="Labels & Notebooks" onClose={() => setTool(null)}>
            <LabelEditor labels={labels()} onChange={(l) => { setLabels(l); scheduleSave(); }} />
            <NotebookPicker
              value={notebookId()}
              onChange={(id) => { setNotebookId(id); scheduleSave(); }}
            />
          </NoteToolDialog>
        </Show>

        <Show when={tool() === 'attachments'}>
          <NoteToolDialog title="Attachments" onClose={() => setTool(null)}>
            {/* Attachments — encrypted with the per-note content key (shareable). */}
            <Show when={attachmentContentKey()}>
              {(contentKey) => (
                <AttachmentButton
                  noteId={noteId}
                  attachments={attachments()}
                  contentKey={contentKey()}
                  onAttachmentAdded={async () => {
                    const r = await apiRequest<any[]>(`/api/v1/items/${noteId}/attachments`);
                    if (r.success) {
                      setAttachments(r.data);
                      notesStore.updateNote(noteId, { hasAttachments: r.data.length > 0 });
                    }
                  }}
                />
              )}
            </Show>
          </NoteToolDialog>
        </Show>
      </div>
    </div>
  );
};

export default NoteModal;
