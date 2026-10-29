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

import { Component, createSignal, createEffect, createMemo, For, lazy, Match, on, onCleanup, onMount, Show, Switch, untrack } from 'solid-js';
import { useLocation, useNavigate, useParams } from '@solidjs/router';
import { resolveDeepLink } from '../lib/deepLink';
import { attachMasonry } from '../lib/masonry';
import { consumeNewNoteLink, parseNewNoteLink, stashNewNoteRequest, takeNewNoteRequest } from '../lib/newNoteLink';
import { authStore } from '../stores/auth';
import { noteIsInNotebook } from '../lib/notebookId';
import { itemsToMarkdown } from '../lib/checklistItems';
import { confirmAction } from '../components/ConfirmDialog';
import { signOutAfterSending } from '../lib/signOut';
import { notesStore, NoteItem } from '../stores/notes';
import { notebooksStore } from '../stores/notebooks';
import { remindersStore, Reminder } from '../stores/reminders';
import { selectionStore } from '../stores/selection';
import SelectionBar from '../components/SelectionBar';
import { type Filters, emptyFilters, applyFilters, filtersActive, labelChips as labelChipsOf } from '../lib/filters';
import { ONLY_MINE_STORE, inScope, keepOutOfScope, onlyMineApplies, rememberOnlyMine, storedOnlyMine } from '../lib/onlyMine';
import { scopedGetItem, scopedSetItem } from '../lib/account';
import { groupBySharer } from '../lib/inboxGroups';
import { matchesSearch } from '../lib/noteSearch';
import {
  emptyStateMessage as buildEmptyStateMessage, chipsEmptiedIt,
  applyEmptyStateAction, emptyStateActionLabel, emptyStateActions,
} from '../lib/emptyStateMessage';
import { carriesAll, renameSelected } from '../lib/labelFacets';
import { FilterBar } from '../components/FilterBar';
import { fireLocal } from '../lib/reminderSchedule';
import NoteCard from '../components/NoteCard';
import NoteComposer from '../components/NoteComposer';
import { mayWriteNotesHere } from '../lib/notebookRights';
import type { CreateOutcome } from '../components/NoteComposer';
// NoteModal pulls in CodeMirror + Yjs + y-protocols (~600 kB). Keep
// it out of the initial grid render — users typically browse a few
// cards before opening one, so the extra chunk is imperceptible.
const NoteModal = lazy(() => import('../components/NoteModal'));
import SettingsPanel from '../components/SettingsPanel';
import Sidebar from '../components/Sidebar';
import SharePanel from '../components/SharePanel';
import { repairNotebooksAfterReset } from '../lib/notebookRepairRun';
import UpgradePrompt from '../components/UpgradePrompt';
import KeyChangeAlarms from '../components/KeyChangeAlarms';
import BlockedShares from '../components/BlockedShares';
import KeysUnavailableNotice from '../components/KeysUnavailableNotice';
import LockedNotesNotice from '../components/LockedNotesNotice';
import SearchBar from '../components/SearchBar';
import { sharesInboxStore } from '../stores/sharesInbox';
import { captureCardRects, playSlide } from '../lib/flip';
import { backHandlers } from '../lib/backHandlers';
import {
  configurePreviousIdentitiesRecheck, onShellIdentitiesEvent, requestPreviousIdentitiesRecheck,
} from '../lib/previousIdentities';

const NotesView: Component = () => {
  const [view, setView] = createSignal<'active' | 'archived' | 'trash' | 'reminders' | 'inbox'>('active');
  // Leaving a view abandons the selection made in it: the bulk bar acting
  // on notes that are no longer on screen (switch to Archive with three
  // active-view notes selected, tap Delete) is a data hazard, and this
  // covers every navigation path — tabs, sidebar, deep links — at once.
  createEffect(() => {
    view();
    selectionStore.clear();
  });
  const [showSettings, setShowSettings] = createSignal(false);
  // Navigation: open on a wide screen, remembered afterwards.
  //
  // Closed at EVERY width and at every load, the notebook and label lists, the
  // Reminders and Shared-with-me destinations, and the sidebar's "New notebook"
  // control would all begin each session behind a hamburger, while the filter
  // row two lines below remembers its own state across sessions (see
  // `filtersCollapsed`). At 1440 the 240px column costs nothing — it is an
  // in-flow sibling of the grid, not an overlay, until the phone breakpoint —
  // so a first visit on a wide screen opens it and anything narrower does not.
  // Once the person has an opinion, theirs wins at every width.
  //
  // 1440 rather than the 1024 where it stops being a drawer: between those two
  // it is a column IN FLOW and takes its 240px out of the grid — measured, an
  // open sidebar at 1023 leaves 2 cards where 3 fit closed. Opening by default
  // is only free where the width is there to spend, and below 1024 it would be
  // worse than not free: the drawer overlays the notes, so a default-open one
  // would cover the grid on load.
  //
  // localStorage over settingsStore for the same reason as the filter row:
  // this is per-device chrome, like a folded toolbar, not account state.
  const SIDEBAR_KEY = 'note-sidebar-open';
  const storedSidebar = localStorage.getItem(SIDEBAR_KEY);
  const [showSidebar, setShowSidebar] = createSignal(
    storedSidebar === null
      ? window.matchMedia('(min-width: 1440px)').matches
      : storedSidebar === '1'
  );
  const sidebarId = 'note-sidebar';
  /** Deliberate open/close — the hamburger and Escape. Remembered. */
  const setSidebarOpen = (open: boolean) => {
    setShowSidebar(open);
    localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0');
  };
  // Collapsible filter row (the All/type/label chips under the tabs), with
  // the choice remembered across sessions. localStorage over settingsStore:
  // this is per-device chrome, like a folded toolbar, not account state.
  const [filtersCollapsed, setFiltersCollapsed] = createSignal(
    localStorage.getItem('note-filters-collapsed') === '1'
  );
  /**
   * The row is folded away and a chip in it is on. Both are remembered, so
   * without a mark notes would be left out of the grid with nothing on screen
   * saying why. Read lazily: `filtersHere` is defined below.
   */
  const filtersHiddenButOn = () => filtersCollapsed() && filtersActive(filtersHere());
  const toggleFilters = () => {
    const next = !filtersCollapsed();
    setFiltersCollapsed(next);
    localStorage.setItem('note-filters-collapsed', next ? '1' : '0');
  };
  // Handle the composer exposes so the header's phone-side "take a note" /
  // "new list" icons can open it — the collapsed "Take a note..." row is
  // desktop-only chrome now.
  const [composerApi, setComposerApi] = createSignal<{
    expandText: () => void;
    expandList: () => void;
    expanded: () => boolean;
    openWith: (init: { mode?: 'text' | 'checklist'; title?: string; body?: string }) => Promise<void>;
  } | null>(null);
  // "All Notes" is a dropdown: pick any notebook (or all) right from the
  // indicator line instead of opening the sidebar. Same side-effects as the
  // sidebar's notebook rows so the two entry points can't drift.
  const [showNotebookMenu, setShowNotebookMenu] = createSignal(false);
  // Standard dropdown manners: a click anywhere outside the menu-wrap closes
  // it. Without this the menu would stay open over the tabs and swallow the
  // next tap. Capture phase so a stopPropagation inside a card can't keep
  // the menu alive; the trigger itself is inside .notebook-menu-wrap and
  // keeps its own toggle.
  createEffect(() => {
    if (!showNotebookMenu()) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('.notebook-menu-wrap')) setShowNotebookMenu(false);
    };
    document.addEventListener('click', close, true);
    onCleanup(() => document.removeEventListener('click', close, true));
  });
  const pickNotebook = (id: string | null) => {
    setSelectedNotebook(id);
    setFilters(f => ({ ...f, labels: [] }));
    setView('active');
    setSearchResults(null);
    setShowNotebookMenu(false);
  };
  /**
   * Below 1024px the sidebar is an OVERLAY DRAWER (`@media (max-width: 1023px)`
   * in index.css: position absolute, z-index 60, min(280px, 80vw)), so picking
   * a destination has to dismiss it, the way every drawer behaves — it is
   * covering the notes you just navigated to. At 1024 and up it is a column in
   * flow and stays put.
   *
   * ⚠️ 1023 MIRRORS THE STYLESHEET. If this number were below the breakpoint at
   * which the drawer overlays the grid, a pick in between would leave the drawer
   * sitting over the grid. Nothing binds these two numbers, so if the `.sidebar`
   * media query moves, this has to move with it.
   *
   * The RAW setter, not setSidebarOpen: this is a consequence of navigating,
   * not an opinion about the drawer, and writing it to localStorage would let
   * one tap on a narrow window decide how the app opens on a wide one.
   */
  const SIDEBAR_OVERLAY_QUERY = '(max-width: 1023px)';
  const sidebarIsDrawer = () => window.matchMedia(SIDEBAR_OVERLAY_QUERY).matches;
  const closeSidebarOnPhone = () => {
    if (sidebarIsDrawer()) setShowSidebar(false);
  };

  /**
   * Click-away, drawer mode only.
   *
   * An overlay drawer with no scrim has no click-away of its own, so the only
   * way out would be the hamburger it came from — and an overlay that covers
   * the grid rather than squeezing it makes that the difference between
   * dismissing it and hunting for the control. Capture phase, so a
   * `stopPropagation` inside a card cannot keep it open; the hamburger is
   * excluded because it carries its own toggle and would otherwise close and
   * immediately reopen. In flow (>=1024) this does nothing: a column that is
   * part of the layout is not dismissed by clicking the page.
   */
  createEffect(() => {
    if (!showSidebar()) return;
    const away = (e: MouseEvent) => {
      if (!sidebarIsDrawer()) return;
      const t = e.target as Element;
      if (t.closest?.('.sidebar') || t.closest?.('.keep-header-left')) return;
      setSidebarOpen(false);
    };
    document.addEventListener('click', away, true);
    onCleanup(() => document.removeEventListener('click', away, true));
  });
  // Keys arrived while the page is open (the app handed them over late, or the
  // reader unlocked): sync NOW. A tab with no keys runs no sync, and nothing
  // else starts one until the next focus or push; meanwhile the notes held
  // for an unanswered invitation, which a keys-less tab does not hold, would
  // stay on screen with the inbox still unasked.
  createEffect(on(() => authStore.keysUnavailable(), (now, before) => {
    if (before != null && now === null) void notesStore.sync();
  }, { defer: true }));
  const [searchQuery, setSearchQuery] = createSignal('');
  const [searchResults, setSearchResults] = createSignal<NoteItem[] | null>(null);
  // "Only mine" is remembered on this device for this ACCOUNT, in one of its
  // per-account stores, and swept with them at sign-out (lib/onlyMine).
  const [filters, setFilters] = createSignal<Filters>({ ...emptyFilters, onlyMine: storedOnlyMine(() => scopedGetItem(ONLY_MINE_STORE)) });

  // A lit label can outlive its label. `allLabels()` is derived from the
  // live notes, so deleting the last note carrying a label removes its chip
  // while `filters().labels` still names it — leaving an empty grid
  // filtered by something that is no longer on screen, and no obvious way to
  // tell why. That label goes out; the others stay lit.
  createEffect(() => {
    const all = notesStore.allLabels();
    if (filters().labels.some(l => !all.includes(l))) {
      setFilters(f => ({ ...f, labels: f.labels.filter(l => all.includes(l)) }));
    }
  });
  const [editingNote, setEditingNote] = createSignal<NoteItem | null>(null);
  /** Set only by the composer's Attach button, so the note it just created
   *  opens with the file picker already up. Cleared on close, or the NEXT note
   *  opened by hand would land on the picker too. */
  const [attachNewNote, setAttachNewNote] = createSignal(false);
  const [selectedNotebook, setSelectedNotebook] = createSignal<string | null>(null);

  /** Whether "Only mine" acts where the grid is showing from (lib/onlyMine). */
  const onlyMineHere = () => onlyMineApplies({
    view: view(), notebook: selectedNotebook(), searching: searchResults() !== null,
  });
  /** The filters as they act here: what the grid, the row and the empty state all read. */
  const filtersHere = () => inScope(filters(), onlyMineHere());
  /** A change from the row or the empty state. Out of its place "Only mine" is
   *  not on screen, so it is not theirs to change. */
  const changeFilters = (next: Filters) => {
    const kept = keepOutOfScope(next, filters(), onlyMineHere());
    if (kept.onlyMine !== filters().onlyMine) rememberOnlyMine(v => scopedSetItem(ONLY_MINE_STORE, v), kept.onlyMine);
    setFilters(kept);
  };

  // Why the grid is empty, and how to say so. See lib/emptyStateMessage: the
  // onboarding line belongs only to an account with nothing in it, never to a
  // filtered view of a full one.
  /**
   * A notebook's name, whether the viewer OWNS it or it was shared with them.
   *
   * `notebooksStore` is built from the viewer's own metadata, so a notebook
   * someone else shared resolves to nothing there. Reading only that store would
   * make the heading fall back to the literal word "Notebook" while the sidebar —
   * which reads the name off the share row — shows the real one an inch away.
   */
  const notebookNameById = (id: string): string | null =>
    notebooksStore.getById(id)?.name
      ?? sharesInboxStore.sharedNotebooks().find(s => s.itemId === id)?.note?.title
      ?? null;

  /**
   * May a note be written where the reader is standing? Not in a shared
   * notebook they may only read, or only edit the notes of: the composer is
   * not offered there (lib/notebookRights).
   */
  const mayWriteHere = () => mayWriteNotesHere(
    selectedNotebook(),
    (id) => notebooksStore.getById(id) !== undefined,
    (id) => sharesInboxStore.sharedNotebooks().find(s => s.itemId === id)?.sharePermission,
  );

  /**
   * A chip is what emptied the grid: one is on, and the place has notes for it
   * to hide. Asked of the same module as the sentence, so the funnel and the
   * ways back appear exactly where the sentence blames a chip, and not under
   * "your notes are locked" or in a notebook that is simply empty.
   */
  const narrowedByFilter = () => chipsEmptiedIt({ filters: filtersHere(), placeHasNotes: scopedNotes().length > 0 });
  const emptyStateMessage = () => buildEmptyStateMessage({
    view: view(),
    searchQuery: searchQuery().trim(),
    filters: filtersHere(),
    notebookName: selectedNotebook() ? notebookNameById(selectedNotebook()!) : null,
    lockedNotes: notesStore.lockedOwnIds().size,
    keysLocked: authStore.keysUnavailable() !== null,
    // Asked of the place itself, before any chip: if a note here carries all
    // the lit labels and another chip is what hides it, the labels are not
    // the reason and the message must not say they are.
    labelsNeverTogether: filtersHere().labels.length > 1
      && !scopedNotes().some(n => carriesAll(n, filtersHere().labels)),
    placeHasNotes: scopedNotes().length > 0,
  });
  const [sharingNotebookId, setSharingNotebookId] = createSignal<string | null>(null);

  /**
   * ---- Deep link: /new ----
   * Read once, synchronously, BEFORE the fragment is stripped. Share-into-app
   * puts the user's text here, so it is stripped immediately — the same
   * treatment the client-key handoff gives `#ck=` — and never lands in history.
   *
   * This is the COLD arrival only: a fresh document that happens to boot at
   * `/new`. The warm one is the effect below, and it is the one the Android
   * shell actually uses.
   */
  // Captured BEFORE the consume strips it — it is the key the effect below
  // uses to recognise this same navigation and not act on it twice.
  const coldNewLink = typeof window !== 'undefined' && window.location.pathname === '/new'
    ? `${window.location.pathname}${window.location.hash}`
    : null;
  const initialNewNote = consumeNewNoteLink();

  // ---- Deep link: /note/:id ----
  // Where a push tap lands, and how the Android shell opens a specific note.
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * The exact `/new` link last acted on, `pathname + hash`.
   *
   * A BOOLEAN "already taken" flag is wrong in both directions. The router
   * cannot see the `replaceState` the strip performs, so its location stays
   * at `/new#…`: a flag that STAYS SET drops the next share, and a flag that
   * CLEARS re-takes the same one on any re-run. The second failure is not
   * cosmetic — it runs away: every take calls `openWith`, which COMMITS what
   * is in the composer before seeding, so the effect would loop creating a
   * note per iteration until the page was killed. The link itself is the
   * only honest key for "have I done this one".
   */
  let lastNewLink: string | null = coldNewLink;

  /**
   * ---- Deep link: /new, arriving at a document that is ALREADY RUNNING ----
   *
   * A `/new` delivered by `window.__pingolinNavigate('/new#body=…')` — the
   * shell's client-side route hook — must not drop the user's text. If the read
   * below never happened, the address bar would sit at `/new#body=…`
   * indefinitely, because the strip is part of that read.
   *
   * ⚠️ NOT A ROUTE ANDROID TAKES for a share. `WebAppActivity.navigateTo` sends
   * every fragment-bearing URL down the FULL LOAD instead (`|| url.contains('#')`
   * returns before the hook is reached), and a share payload is always in the
   * fragment — so share-into-app on a warm Android app does not use this path.
   * What this buys is that the page is correct on its own: that branch of the
   * shell is not load-bearing, and any other caller of the hook is safe.
   *
   * ⚠️ THE ROUTER'S LOCATION LEADS `window.location`. The component IS
   * re-created on a route change (the body re-runs on every one) — but
   * solid-router updates its location signal and renders the new route BEFORE
   * it commits the history entry, so the re-run body's `consumeNewNoteLink()`
   * reads a `window.location` still holding the PREVIOUS URL and finds no
   * `/new`: while routing TO `/new` the body sees `win=/`, and an effect sees
   * `router=/new#body=…` while `win=/new` — the hash has not landed either. So
   * the fragment must come off the ROUTER here. `consumeNewNoteLink()` stays
   * the COLD path, where the document boots at `/new`, `window.location` is the
   * truth, and no router has moved.
   *
   * ⚠️ AND THE STRIP MUST NOT CHANGE ROUTE. `navigate('/', {replace:true})`
   * breaks the cold path: `/new` and `/*` are different routes, so it
   * re-creates this component — destroying the composer about to be seeded,
   * and the request held beside it. The stash in lib/newNoteLink.ts lives at
   * module scope for the same family of reason: it has to survive a
   * re-creation whatever causes one.
   */
  createEffect(() => {
    const key = `${location.pathname}${location.hash}`;
    if (location.pathname !== '/new') { lastNewLink = null; return; }
    // Already acted on this exact link — either the cold read took it, or a
    // re-run is seeing the same navigation a second time.
    if (key === lastNewLink) return;
    lastNewLink = key;
    const hash = location.hash;
    // UNTRACKED from here down: everything below is the ACTION, and an effect
    // must not subscribe to what it acts upon. Reading `composerApi()` inside
    // the tracked scope would make this re-run whenever the composer re-binds,
    // which turns a wrong guard into a runaway loop.
    untrack(() => {
    const req = parseNewNoteLink(hash);
    // Strip the user's text out of the URL and out of history, by navigating
    // to the SAME ROUTE without the fragment.
    //
    // Two things this is not, both wrong:
    //   - a bare `history.replaceState(null, '', '/')`. The router runs
    //     effects BEFORE it commits its history entry, so the strip lands
    //     first and the router's own push puts the text straight back — the
    //     address bar still reads `/new#body=…` after the note has opened.
    //     Plaintext left in the URL and in history is exactly what the
    //     fragment carrier exists to prevent.
    //   - `navigate('/', { replace: true })`. `/` and `/new` are DIFFERENT
    //     routes, so that re-creates this component and destroys the composer
    //     about to be seeded, which breaks the cold path.
    //
    // `/new` -> `/new` is the same route, so nothing is re-created, and the
    // router writes the URL itself, in its own order. Recording `/new` as the
    // link just handled is what stops the resulting re-run being read as a
    // fresh, empty share — and it leaves the router somewhere a REPEAT of the
    // same shared text is still a real change.
    lastNewLink = '/new';
    navigate('/new', { replace: true });
    const api = composerApi();
    if (api) void api.openWith(req);
    // No composer mounted — a note is open over the grid, or any view but
    // Notes. The URL is already gone, so the stash is the only copy of the
    // user's shared text; the bind callback below hands it over on the next
    // mount.
    else stashNewNoteRequest(req);
    });
  });
  // Set once the initial hydrate+sync has run. Without it we cannot tell
  // "this note hasn't arrived yet" from "this note doesn't exist", and a
  // deep link would flash "not found" every time on a cold start.
  const [notesLoaded, setNotesLoaded] = createSignal(false);
  const [deepLinkMissing, setDeepLinkMissing] = createSignal(false);

  /**
   * Opens the deep-linked note as soon as it exists.
   *
   * Re-runs on every change to the notes signal on purpose: a push tap
   * routinely arrives BEFORE the note it refers to has synced down, so the
   * first pass finds nothing and a later one opens it. Matching an already-open
   * note is skipped so this never fights the user closing the modal.
   */
  createEffect(() => {
    const notes = notesStore.notes();
    const action = resolveDeepLink({
      wantedId: params.id,
      openId: editingNote()?.id,
      knownIds: notes.map(n => n.id),
      loaded: notesLoaded(),
    });
    if (action.kind === 'open') {
      const note = notes.find(n => n.id === action.id);
      if (note) {
        setDeepLinkMissing(false);
        setEditingNote(note);
      }
    } else if (action.kind === 'missing') {
      setDeepLinkMissing(true);
    } else if (!params.id) {
      setDeepLinkMissing(false);
    }
  });

  const onReminderFire = (r: Reminder) => {
    const note = notesStore.notes().find(n => n.id === r.itemId);
    fireLocal(r, note, () => {
      if (note) setEditingNote(note);
    });
    remindersStore.markFiredLocal(r.id);
  };

  /**
   * Fetch and parse the editor bundle while the user is still looking at the
   * grid, so the first tap does not pay for it.
   *
   * The deep-link case prefetches on mount (below); this covers the ORDINARY
   * case — open the app, look at the list, tap a note — which is the path
   * essentially every open takes. On a low-end phone, NoteModal -> NoteEditor ->
   * yjs loading in series at tap time is a large part of the tap-to-editor
   * delay. They are HTTP-cache hits even then, so this is not a download — it
   * is parse and execute of ~600 kB, and it can happen earlier just as well as
   * later.
   *
   * On idle, never on the critical path: the grid must paint first, and on a
   * weak phone parsing the editor competes with rendering the list. The
   * requestIdleCallback timeout is the fallback for a page that never goes
   * idle; Safari still lacks the API entirely, hence the setTimeout arm.
   */
  const preloadEditorWhenIdle = () => {
    const go = () => { void NoteModal.preload?.(); };
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof ric === 'function') ric(go, { timeout: 4000 });
    else setTimeout(go, 1500);
  };

  onMount(async () => {
    // Start fetching the editor NOW if we were opened on a note.
    //
    // NoteModal is lazy (CodeMirror + Yjs, ~600 kB) and its import does not
    // begin until the component first renders — which is after the cache has
    // hydrated and the note has been found. On a phone that would put a 600 kB
    // download at the END of the open, in series, when it can be running
    // against the cache read and the crypto init all along.
    //
    // Fire-and-forget: it is a prefetch, and a failure here is retried by the
    // ordinary lazy load when the modal actually mounts.
    if (params.id) void NoteModal.preload?.();
    else void preloadEditorWhenIdle();

    // Load cached notes first so the grid paints immediately.
    await notesStore.hydrateFromCache();
    notebooksStore.updateCounts(notesStore.notes());

    // STARTED HERE, awaited at the bottom. /api/v1/reminders shares no data
    // with the note sync — it is a flat list the store maps and schedules on
    // its own — so run after the sync AND after flushPending it would sit at
    // the very end of a serial chain. Overlapping it with the sync removes a
    // full round trip from the tail without changing what anything sees,
    // because nothing between here and the await reads remindersStore.
    const remindersReady = remindersStore.sync(onReminderFire).catch(() => {});

    // Kick off a live sync — it refreshes the shares inbox internally
    // so any freshly-arrived shared notes decrypt on the first pass.
    await notesStore.sync();
    if (notesStore.notes().length === 0) {
      // Crypto may not have been ready on first sync — retry after a short delay
      await new Promise(r => setTimeout(r, 500));
      await notesStore.sync();
    }
    notebooksStore.updateCounts(notesStore.notes());
    // Everything the server had is now local, so a deep link that still finds
    // nothing is genuinely pointing at a note this user cannot see.
    setNotesLoaded(true);

    // Give any metadata-only notebook its own item. Runs after the sync so the
    // set of existing items is known; idempotent, so later loads write nothing.
    // Deliberately not awaited into the critical path — it is a background
    // repair, and a slow one must not hold up the grid.
    void notebooksStore.backfillNotebookItems();
    // Every notebook the person meets works after a password reset, with
    // nothing asked of them (lib/notebookRepair). For almost every account
    // there is nothing to do; background, like the line above.
    void repairNotebooksAfterReset().catch(e => console.warn('[note] notebook repair after a reset failed', e));

    // Replay any edits that were queued while offline.
    await notesStore.flushPending();

    // Reminders were fetched alongside the sync above (402 is treated as an
    // empty list for free-tier users); this is only where they must have
    // landed, so onCleanup's clearAllTimers cannot race a scheduling pass.
    await remindersReady;
  });

  onCleanup(() => {
    remindersStore.clearAllTimers();
  });

  // Global Escape: clear the selection, else close the navigation drawer.
  //
  // Innermost first, one thing per press — the same discipline as
  // __pingolinBack below, which is NOT a keyboard handler despite its shape:
  // it is the Android shell's back delegate and nothing in a browser calls it.
  // Without the drawer branch there would be no keyboard dismiss for it at
  // all; below 1440 it overlays the grid, so the only way out would be to
  // find the hamburger again.
  const globalKeyHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (selectionStore.isSelectionMode()) {
      selectionStore.clear();
      return;
    }
    if (showSidebar()) setSidebarOpen(false);
  };
  document.addEventListener('keydown', globalKeyHandler);
  onCleanup(() => document.removeEventListener('keydown', globalKeyHandler));

  // Keep-style stacking. The grid is CSS grid for its reading order; the
  // stacking comes from per-card row spans measured here. Attached once for the
  // whole page because there are four `.notes-grid` containers (pinned,
  // unpinned, each inbox group) and cards move between them.
  onMount(() => onCleanup(attachMasonry()));

  (window as { __pingolinBack?: () => boolean }).__pingolinBack = () => {
    // Android back, delegated by the shell (see WebAppActivity's back
    // callback): close whatever is open, innermost first, and return true;
    // return false only when there is nothing left to close — that is the
    // shell's cue to leave the app. A URL check on the shell side cannot do
    // this because card taps open the note modal state-locally and
    // location stays "/". Harmless in a browser: nothing calls it.
    //
    // Innermost overlays first: components (such as the composer) register
    // their own consumers so this list doesn't have to know about them.
    for (const h of backHandlers) {
      if (h()) return true;
    }
    if (sharingNote()) { setSharingNote(null); return true; }
    if (sharingNotebookId()) { setSharingNotebookId(null); return true; }
    if (showSettings()) { setShowSettings(false); return true; }
    if (editingNote() || params.id) { handleCloseModal(); return true; }
    if (showSidebar()) { setShowSidebar(false); return true; }
    if (window.location.pathname !== '/') { navigate('/', { replace: true }); return true; }
    return false;
  };
  onCleanup(() => { delete (window as { __pingolinBack?: () => boolean }).__pingolinBack; });

  // Faster cross-device sync. The service worker relays a silent "note-sync"
  // message when a push tickle says our notes changed on another device; we
  // also re-sync whenever the tab regains focus (covers the case where the
  // tab was hidden/closed and couldn't receive a silent push). Both are cheap
  // — the server's sync-watermark fast-path makes an unchanged pull a no-op.
  //
  // Drain the offline queue first. A note written offline is replayed by
  // flushPending; triggered only from onMount, a phone that regained signal
  // without reloading would keep the note queued and invisible for as long as
  // the web view stayed alive. An empty queue costs one IDB read, so this is
  // cheap enough to hang off every sync trigger rather than guessing which one
  // fires.
  const triggerSync = () => {
    notesStore.flushPending()
      .then(() => notesStore.sync())
      .then(() => notebooksStore.updateCounts(notesStore.notes()))
      .catch(() => {});
  };
  const swMessageHandler = (e: MessageEvent) => {
    if (e.data?.type === 'note-sync') triggerSync();
  };
  // Coming back into view also re-checks whether the account has restored
  // its notes from before a password reset since this tab loaded. The web
  // editor gets no push for it (phones do), so this is its way; the check is
  // rate-limited and reloads only when something new opened.
  configurePreviousIdentitiesRecheck({
    stillLocked: () => notesStore.lockedOwnIds().size > 0,
    onNewIdentities: triggerSync,
  });
  const visibilityHandler = () => {
    if (document.visibilityState === 'visible') {
      triggerSync();
      requestPreviousIdentitiesRecheck();
    }
  };
  navigator.serviceWorker?.addEventListener('message', swMessageHandler);
  document.addEventListener('visibilitychange', visibilityHandler);
  // The app shells relay the server's nudge as this event.
  window.addEventListener('pingolin-identities', onShellIdentitiesEvent);

  // The moment the network comes back, without waiting for a tab switch.
  const onlineHandler = () => triggerSync();
  window.addEventListener('online', onlineHandler);
  onCleanup(() => {
    navigator.serviceWorker?.removeEventListener('message', swMessageHandler);
    document.removeEventListener('visibilitychange', visibilityHandler);
    window.removeEventListener('online', onlineHandler);
    window.removeEventListener('pingolin-identities', onShellIdentitiesEvent);
    configurePreviousIdentitiesRecheck(null);
  });

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query.trim()) {
      setSearchResults(notesStore.search(query));
    } else {
      setSearchResults(null);
    }
  };

  /** The notes of the place the grid is showing from, before any chip narrows them. */
  const scopedNotes = () => {
    let notes: NoteItem[];
    if (searchResults() !== null && view() === 'inbox') {
      // A search typed in "Shared with me" is a search of what is listed
      // there, matched against the inbox's OWN copies. Not the notes store's
      // results narrowed to the inbox: the store skips a shared item it could
      // not open at a sync, so such a note would be in this list and gone from
      // it the moment anything was typed.
      const typed = searchQuery();
      notes = sharesInboxStore.sharedNotes()
        .map((s) => s.note)
        .filter((n): n is NoteItem => n !== null && matchesSearch(n, typed));
    } else if (searchResults() !== null) {
      notes = searchResults()!;
    } else {
      switch (view()) {
        case 'archived': notes = notesStore.archivedNotes(); break;
        case 'trash': notes = notesStore.trashNotes(); break;
        case 'reminders': {
          const byNote = remindersStore.byNoteId();
          notes = notesStore.notes()
            .filter(n => !n.deleted && byNote.has(n.id))
            .sort((a, b) => {
              const ar = byNote.get(a.id)!.triggerAt;
              const br = byNote.get(b.id)!.triggerAt;
              return ar.localeCompare(br);
            });
          break;
        }
        case 'inbox': {
          notes = sharesInboxStore.sharedNotes()
            .map((s) => s.note)
            .filter((n): n is NoteItem => n !== null);
          break;
        }
        default: notes = notesStore.activeNotes(); break;
      }
    }
    // A note that came with an invitation the reader has not accepted stays
    // out of their own lists until they do (notesStore.heldForInvitation); it
    // is under "Shared with me" meanwhile. Not a search's results, a reminder
    // or the trash: those are asked for, or are the reader's own act on it.
    if (searchResults() === null && (view() === 'active' || view() === 'archived')) {
      notes = notes.filter(n => !notesStore.heldForInvitation(n));
    }
    // Filter by notebook
    const nb = selectedNotebook();
    // Matches a shared notebook too: a recipient's copy of a note carries the
    // sender's notebook in ownerNotebookId, so filtering on notebookId alone
    // opens an accepted shared notebook empty.
    if (nb) notes = notes.filter(n => noteIsInNotebook(n, nb));
    return notes;
  };

  // Labels are part of `filters`: one source for the sidebar and the chip
  // row alike, so the two can never believe different labels are active.
  const displayedNotes = () => applyFilters(scopedNotes(), filtersHere());

  /**
   * The label chips: counted over what the grid would show with NO label lit
   * (this place, and every other chip), then narrowed by the labels that are
   * lit — so each number is what tapping that chip leaves (lib/filters
   * `labelChips`, where that arithmetic has its tests).
   */
  const labelChips = createMemo(() => labelChipsOf(scopedNotes(), filtersHere(), notesStore.allLabels()));

  const pinnedNotes = () => view() === 'active' ? displayedNotes().filter(n => n.isPinned) : [];
  const unpinnedNotes = () => view() === 'active' ? displayedNotes().filter(n => !n.isPinned) : displayedNotes();

  /** Inbox view only: group decrypted shared notes by sharer email so
   *  recipients see a per-sender section rather than one flat list. The notes
   *  listed are the ones the filter row and the search leave (lib/inboxGroups). */
  const inboxGroups = () => {
    if (view() !== 'inbox') return [] as { sharer: string; notes: NoteItem[] }[];
    return groupBySharer(sharesInboxStore.sharedNotes(), new Set(displayedNotes().map(n => n.id)));
  };

  // Returns true when the note reached the server OR was safely queued offline
  // (composer may reset); false on a hard denial like the note-cap (composer
  // keeps the text so it isn't lost).
  const handleCreate = async (title: string, body: string, color?: string | null, labels?: string[], notebookId?: string | null): Promise<CreateOutcome> => {
    const r = await notesStore.createNote({
      title,
      body,
      noteType: 'text',
      color: color || null,
      labels: labels || [],
      notebookId: notebookId || selectedNotebook() || null,
    });
    return { ok: r.note !== null || r.queued, note: r.note, locked: r.locked };
  };

  const handleCreateList = async (
    title: string,
    items: { text: string; checked: boolean }[],
    color?: string | null,
    labels?: string[],
    notebookId?: string | null,
  ): Promise<CreateOutcome> => {
    // The shared transform, not a second copy of it: a hand-rolled duplicate
    // of `itemsToMarkdown` would eventually drift.
    const body = itemsToMarkdown(items);
    const r = await notesStore.createNote({
      title,
      body,
      noteType: 'checklist',
      checklistItems: items,
      color: color || null,
      labels: labels || [],
      notebookId: notebookId || selectedNotebook() || null,
    });
    return { ok: r.note !== null || r.queued, note: r.note, locked: r.locked };
  };

  const handleCardClick = (note: NoteItem) => {
    if (view() === 'trash') return; // Don't open editor for trash
    setEditingNote(note);
  };

  const handleCloseModal = () => {
    setEditingNote(null);
    // One-shot: only the note the composer just created opens on the picker.
    setAttachNewNote(false);
    if (params.id) {
      // Route away from the note FIRST, in the shell and the browser alike.
      // The deep-link effect above reopens the note whenever params.id names it
      // and no modal is open — and setEditingNote(null) just made that true.
      // The shell RETAINS the document across closes, so skipping this navigate
      // would leave the closed note's modal remounted for the rest of the
      // process — lock heartbeat POSTing every 30s, lock poll GETting every 5s,
      // collab socket open, decrypted body in the DOM — with no Activity on
      // screen. `replace` so Back does not walk into the same trap.
      navigate('/', { replace: true });

      // Hand the close to the shell. In the stacked mode the native list sits
      // directly behind this Activity and the shell finishes it; when this
      // document IS the home (task root) the shell IGNORES the scheme — the grid
      // we just navigated to simply stays on screen. Fired either way because
      // only the shell knows which mode it is in.
      //
      // No early return: in home mode the list stays visible and should
      // refresh like the browser path, so the sync below runs. In the stacked
      // mode the Activity finishes regardless and a fired-and-canceled sync
      // costs nothing.
      const shell = (window as { __pingolinNativeShell?: string }).__pingolinNativeShell;
      if (shell) {
        window.location.href = `${shell}://close`;
      }
    }
    notesStore.sync().then(() => notebooksStore.updateCounts(notesStore.notes()));
  };

  // Keep notebook counts reactive — update whenever notes signal changes
  createEffect(() => {
    const n = notesStore.notes(); // track the signal
    notebooksStore.updateCounts(n);
  });

  const handlePin = async (note: NoteItem) => {
    await notesStore.updateNote(note.id, { isPinned: !note.isPinned });
  };

  const handleArchive = async (note: NoteItem) => {
    await notesStore.updateNote(note.id, { isArchived: !note.isArchived });
  };

  /**
   * Deleting from the grid asks first, as delete-FOREVER and deleting a single
   * attachment do. Same dialog and same wording as the modal's delete, because
   * they are the same action reached two ways and must not disagree.
   */
  const handleDelete = async (note: NoteItem) => {
    if (!(await confirmAction({
      message: 'Move this note to Trash?',
      detail: `${note.title?.trim() || 'This note'} stays in Trash until you empty it, and can be restored from there.`,
      confirmLabel: 'Move to Trash',
      destructive: true,
    }))) return;
    await notesStore.deleteNote(note.id);
  };

  const [sharingNote, setSharingNote] = createSignal<NoteItem | null>(null);

  const handleShare = (note: NoteItem) => {
    setSharingNote(note);
  };

  const handleRestore = async (note: NoteItem) => {
    await notesStore.restoreNote(note.id);
  };

  const handlePermanentDelete = async (note: NoteItem) => {
    if (await confirmAction({
      message: 'Delete this note forever?',
      detail: `${note.title?.trim() || 'This note'} cannot be recovered afterwards, on this or any other device.`,
      confirmLabel: 'Delete forever',
      destructive: true,
    })) {
      notesStore.permanentlyDelete(note.id);
    }
  };

  const handleCopy = (note: NoteItem) => {
    const text = [note.title, note.body].filter(Boolean).join('\n\n');
    navigator.clipboard.writeText(text);
  };

  // Inbox (shared-with-me) recipient consent. Dismiss drops a single share
  // from the inbox; block cuts off the sender entirely (their current shares
  // vanish + future ones are auto-dismissed server-side). The share row id and
  // sender email are resolved from the inbox store keyed on the note.
  const handleDismiss = async (note: NoteItem) => {
    const share = sharesInboxStore.getByItemId(note.id);
    if (!share) return;
    await sharesInboxStore.dismiss(share.shareId);
  };

  const handleBlock = async (note: NoteItem) => {
    const email = sharesInboxStore.getByItemId(note.id)?.sharerEmail;
    if (!email) return;
    if (!(await confirmAction({
      message: `Block ${email}?`,
      detail: "Their shared notes will be removed from your inbox and you won't receive future shares from them. You can unblock them later in Settings.",
      confirmLabel: 'Block sender',
      destructive: true,
    }))) return;
    await sharesInboxStore.blockSender(email, undefined, notesStore.unansweredNotebooksFrom(email));
  };

  // Pointer-event drag implementation. HTML5 drag-drop has too many
  // quirks (hit-testing gaps on large targets, elementFromPoint
  // disagreements during an in-flight OS drag, inconsistent cursor
  // state) — mouse events are direct and reliable.
  //
  // Flow:
  //   1. mousedown on a card → we record the intent and attach
  //      document-level mousemove/mouseup listeners. We don't
  //      actually start a drag yet; the user might just be clicking.
  //   2. mousemove past a small threshold → commit to drag. Flag
  //      the body so we can style the cursor, and set draggedId.
  //   3. mousemove during drag → elementFromPoint resolves which
  //      card the cursor is over, run the reorder.
  //   4. mouseup → commit if the drag actually started, else just
  //      let the click through.
  // Keep-style drag. The dragged note is "picked up" as a floating
  // clone that follows the cursor freely — no snapping to grid
  // positions. The original card in the grid is made invisible
  // (visibility:hidden preserves its layout slot), and the rest of
  // the grid rearranges to fit where the invisible slot lands as
  // the cursor moves over other cards.
  const DRAG_THRESHOLD_SQ = 5 * 5;
  // Touch commits to a drag by LONG-PRESS, not by movement: on a phone the
  // movement that follows pointerdown is overwhelmingly a scroll, and Keep's
  // own grid works the same way — hold to pick up, move to reorder. A finger
  // that travels more than the slop before the timer fires is a scroll, and
  // the intent is dropped so the native scroll proceeds untouched.
  const TOUCH_LONG_PRESS_MS = 350;
  const TOUCH_SCROLL_SLOP_SQ = 10 * 10;
  let dragIntent: {
    id: string; startX: number; startY: number;
    pointerId: number; pointerType: string;
  } | null = null;
  let dragActive = false;
  /** One clear per gesture — see onPointerMove. */
  let selectionClearedByDrag = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  // Last observed pointer position — the long-press timer activates the drag
  // OUTSIDE any event handler, so it needs somewhere to read the finger from.
  let lastPointerX = 0;
  let lastPointerY = 0;
  // Non-passive touchmove blocker, installed only WHILE a touch drag is
  // active: pointermove's preventDefault cannot stop scrolling (scroll is
  // negotiated on touchmove), and touch-action CSS on the cards would kill
  // ordinary list scrolling that happens to start on a card.
  const touchScrollBlocker = (ev: TouchEvent) => ev.preventDefault();
  let dragClone: HTMLElement | null = null;
  // Offset from cursor to clone's top-left, captured at pick-up so
  // the clone tracks the cursor at the grab point rather than
  // snapping to have the cursor at its corner.
  let grabOffsetX = 0;
  let grabOffsetY = 0;
  // Tracks which card the cursor was over on the previous mousemove
  // so we can clear the swap latch whenever the cursor transitions
  // off a card — the pointer-events equivalent of dragleave.
  let lastHoveredCardId: string | null = null;

  const handleDragIntent = (e: PointerEvent, noteId: string) => {
    dragIntent = {
      id: noteId, startX: e.clientX, startY: e.clientY,
      pointerId: e.pointerId, pointerType: e.pointerType,
    };
    dragActive = false;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    if (e.pointerType !== 'mouse') {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (!dragIntent || dragActive) return;
        // The finger held still long enough: this is a pick-up, not a
        // scroll. From here on the page must not scroll under the drag.
        document.addEventListener('touchmove', touchScrollBlocker, { passive: false });
        navigator.vibrate?.(15);
        activateDrag(lastPointerX, lastPointerY);
      }, TOUCH_LONG_PRESS_MS);
    }
  };

  const clearLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const abandonIntent = () => {
    clearLongPress();
    dragIntent = null;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('touchmove', touchScrollBlocker);
  };

  // Pick up the card at pointer position (x, y). Shared by the two commit
  // paths: a mouse crossing the movement threshold, and a touch long-press
  // firing from its timer (which is why this takes coordinates instead of an
  // event — the timer has none).
  const activateDrag = (x: number, y: number) => {
    const intent = dragIntent;
    if (!intent || dragActive) return;
    // Whatever the last drop left mid-flight, this gesture owns the grid now.
    clearLandings();
    selectionClearedByDrag = false;
    // Clone the source DOM BEFORE dragStart sets draggedId (which triggers
    // the .dragging class / visibility:hidden), so the clone captures a
    // fully-rendered copy to float with the pointer.
    const sourceEl = document.querySelector(
      `.note-card[data-note-id="${intent.id}"]`,
    ) as HTMLElement | null;
    if (!sourceEl) {
      abandonIntent();
      return;
    }
    const rect = sourceEl.getBoundingClientRect();
    grabOffsetX = x - rect.left;
    grabOffsetY = y - rect.top;

    const clone = sourceEl.cloneNode(true) as HTMLElement;
    clone.classList.remove('dragging');
    clone.classList.add('note-card-drag-clone');
    // A DRAG IMAGE, NOT A SECOND CARD. cloneNode(true) copies the card's six
    // labelled buttons — "Select note", Pin, Share, Copy, Archive, Delete —
    // and its `data-note-id`. They are unreachable by pointer (pointerEvents
    // below), but that is a pointer fact, not an a11y one: without `inert`
    // the clone exposes its whole subtree to the accessibility tree, buttons
    // and all.
    //
    // `inert` takes the subtree out of the a11y tree AND the tab order in one
    // attribute; `aria-hidden` restates it for a WebView too old for `inert`.
    // This matters because the clone PAINTS those controls (the hover reveals
    // are restated for `.note-card-drag-clone` in index.css, so the card in
    // your hand keeps its checkbox and its bottom row). Visible and
    // decorative is the combination that has to say so.
    clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('inert', '');
    clone.style.position = 'fixed';
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.margin = '0';
    clone.style.pointerEvents = 'none';
    clone.style.zIndex = '10000';
    document.body.appendChild(clone);
    dragClone = clone;

    dragActive = true;
    notesStore.dragStart(intent.id);
    document.body.classList.add('notes-dragging');
  };

  /**
   * Put the card down instead of teleporting it.
   *
   * Destroying the clone on pointerup and showing the real card in its slot in
   * the same frame makes the held card jump sideways while every other card on
   * the board glides: the one the user is actually touching would be the only
   * one that does not move like an object.
   *
   * So the clone flies the last short distance itself, and the real card stays
   * hidden until it lands — one continuous motion from the hand to the slot.
   * Short on purpose: this is the end of a gesture the user has already
   * committed to, not somewhere to spend 600ms.
   *
   * ⚠️ `dragEnd` must have run BEFORE this: the destination is the card's
   * committed slot, which does not exist until the preview is applied and the
   * grid has laid out. Hence the rAF.
   */
  const LAND_MS = 180;
  /** How long reveals stay instant after the card is handed back. */
  const HANDOFF_MS = 250;
  /** Un-hide any card still mid-landing. Grabbing a card inside the 180ms
   *  would otherwise clone one that is at opacity 0 — an empty hand. */
  const clearLandings = () => {
    document.querySelectorAll('.note-card-landing')
      .forEach(el => el.classList.remove('note-card-landing'));
  };
  const landClone = (clone: HTMLElement, noteId: string) => {
    const from = clone.getBoundingClientRect();
    requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(
        `.notes-grid .note-card[data-note-id="${CSS.escape(noteId)}"]`,
      );
      // No card to land on (filtered out of the view, or removed), or a
      // browser without the animation API: just remove the clone rather
      // than leaving it stuck on screen.
      if (!card || typeof clone.animate !== 'function') { clone.remove(); return; }
      const to = card.getBoundingClientRect();
      const dx = to.left - from.left;
      const dy = to.top - from.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) { clone.remove(); return; }

      // Two copies of one card would be worse than the jump, so the card gives
      // up its paint until the clone arrives.
      //
      // ⚠️ `opacity`, NOT `visibility`. A `visibility: hidden` element cannot
      // be `:hover`, so the card's select circle and action row — hover
      // reveals, which the CLONE has been painting for the whole drag — would
      // only begin their 150ms fade at the moment the card came back: gone at
      // the hand-off frame, faint one frame later, back two frames after that,
      // blinking out and in at the exact instant the user releases. At opacity
      // 0 the card stays hoverable, so the reveal runs while it is invisible
      // and the controls are already there when it is painted.
      //
      // Restored on cancel as well as finish, so an interrupted landing can
      // never leave a permanently invisible card.
      card.classList.add('note-card-landing');
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        card.classList.remove('note-card-landing');
        // No fade on the controls the clone was already painting — see
        // `.note-card-handoff` in index.css. Long enough to cover Chromium
        // noticing the card is hovered, short enough that an ordinary hover a
        // moment later still animates normally.
        card.classList.add('note-card-handoff');
        setTimeout(() => card.classList.remove('note-card-handoff'), HANDOFF_MS);
        clone.remove();
      };
      // ⚠️ A FLOOR, not a nicety. finish/cancel is the normal path, but an
      // animation in a backgrounded tab fires neither, and a card left at
      // opacity 0 is indistinguishable from a note that has vanished. Every
      // path that hides a card needs a way back that does not depend on one
      // event arriving. `clearLandings` at the start of the next drag is the
      // other half.
      setTimeout(settle, LAND_MS + 400);
      const anim = clone.animate(
        [{ transform: 'translate(0, 0)' }, { transform: `translate(${dx}px, ${dy}px)` }],
        { duration: LAND_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' },
      );
      anim.onfinish = settle;
      anim.oncancel = settle;
    });
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragIntent) return;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    if (!dragActive) {
      const dx = e.clientX - dragIntent.startX;
      const dy = e.clientY - dragIntent.startY;
      const distSq = dx * dx + dy * dy;
      if (dragIntent.pointerType === 'mouse') {
        if (distSq < DRAG_THRESHOLD_SQ) return;
        activateDrag(e.clientX, e.clientY);
        if (!dragActive) return;
        // Prevent text-selection that started on pointerdown.
        e.preventDefault();
      } else {
        // Touch/pen before the long-press fires: real movement means the
        // user is SCROLLING — drop the intent and get out of the way. The
        // pick-up only ever comes from the timer.
        if (distSq > TOUCH_SCROLL_SLOP_SQ) abandonIntent();
        return;
      }
    }

    if (dragClone) {
      dragClone.style.left = `${e.clientX - grabOffsetX}px`;
      dragClone.style.top = `${e.clientY - grabOffsetY}px`;
    }

    // ONCE THE CARD IS ACTUALLY MOVING, IT IS NOT A SELECTION.
    //
    // On touch two long presses race on the same finger: this file picks the
    // card up at 350ms, and NoteCard selects it at 500ms. Hold still and you
    // get both, which is the feedback the user wants — the card lifts, its
    // tick and the selection bar appear. But start dragging and those two
    // states are contradictory: `isDraggable` is false in selection mode
    // precisely because a selected card and a dragged one are different
    // gestures, and the bar offers bulk actions for a card that is in the air.
    //
    // So the tick and the bar survive the hold and go the moment the card
    // travels. The threshold is the same slop NoteCard uses to abandon its own
    // press, so the two agree on what counts as "moved".
    if (!selectionClearedByDrag && selectionStore.isSelectionMode()
        && Math.hypot(e.clientX - dragIntent.startX, e.clientY - dragIntent.startY) > 10) {
      selectionClearedByDrag = true;
      selectionStore.clear();
    }

    // Resolve what the cursor is over for the reorder. The clone
    // has pointer-events:none so it doesn't interfere with
    // elementFromPoint. If the cursor isn't directly over a card
    // (it's in a gutter, past the last card, or hugging an edge),
    // fall back to the nearest card — otherwise the reorder can't
    // fire at all for drops into corners and trailing positions.
    let card = (document.elementFromPoint(e.clientX, e.clientY))?.closest(
      '.note-card[data-note-id]',
    ) as HTMLElement | null;
    if (!card) {
      const NEAREST_MAX_DIST_SQ = 250 * 250;
      let best: HTMLElement | null = null;
      let bestDist = NEAREST_MAX_DIST_SQ;
      // `:not(.note-card-settling)` — a card mid-FLIP is sliding to a new slot
      // and passes under the cursor on the way; index.css stops it winning the
      // HIT TEST, but pointer-events means nothing to querySelectorAll, so it
      // has to be excluded here too or the fallback picks the very card the
      // hit test just refused. Aiming at one is meaningless anyway: with
      // `fill: 'none'` its layout slot is already its destination, so where it
      // appears mid-flight is not where a drop would put it.
      const candidates = document.querySelectorAll<HTMLElement>(
        '.note-card[data-note-id]:not(.dragging):not(.note-card-settling)',
      );
      candidates.forEach((c) => {
        const r = c.getBoundingClientRect();
        // Distance from cursor to the rect — zero inside the rect,
        // otherwise to the nearest edge.
        const px = Math.max(r.left, Math.min(e.clientX, r.right));
        const py = Math.max(r.top, Math.min(e.clientY, r.bottom));
        const dx = e.clientX - px;
        const dy = e.clientY - py;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      });
      card = best;
    }
    // THE CLONE IS NOT A DROP TARGET. It is a `cloneNode(true)` of the card
    // being dragged, so it carries the same `data-note-id`, does NOT carry
    // `.dragging` (that class is removed from the copy), and it sits under the
    // cursor on every move — which means both the hit test and the nearest-card
    // search below can land on it, 0px away.
    //
    // Left in, it makes the grid jitter. `cardId` becomes the dragged note's
    // OWN id on those moves, so the next real card fires
    // `dragLeave(previousTarget)` and clears `lastSwapLatch` — and coming back
    // onto that card swaps again, the other way. The cards start to move and
    // then slide back.
    if (card?.classList.contains('note-card-drag-clone')) card = null;

    const cardId = card?.dataset.noteId ?? null;

    // ONLY A DIFFERENT CARD CLEARS THE LATCH. Moving onto nothing — a gutter,
    // the hole the dragged card left, the clone — is not "leaving the target"
    // in any sense the reorder cares about, and treating it as one is the
    // other half of the jitter. The preview simply stands until the pointer
    // reaches a different card.
    if (cardId && cardId !== lastHoveredCardId) {
      if (lastHoveredCardId) notesStore.dragLeave(lastHoveredCardId);
      lastHoveredCardId = cardId;
    }

    if (!card || card.classList.contains('dragging')) return;
    const targetId = cardId!;
    const targetIndex = notesStore.activeNotes().findIndex(n => n.id === targetId);
    if (targetIndex < 0) return;
    const oldRects = captureCardRects();
    notesStore.dragMove(targetIndex, targetId, { x: e.clientX, y: e.clientY });
    requestAnimationFrame(() => playSlide(oldRects));
  };

  // The browser reclaimed the gesture (system edge swipe, notification
  // shade, palm rejection). Nothing was dropped, so revert rather than
  // commit — dragEnd(false) discards the preview.
  const onPointerCancel = () => {
    clearLongPress();
    if (dragActive) {
      document.body.classList.remove('notes-dragging');
      const landing = dragClone;
      const landingId = dragIntent?.id ?? null;
      dragClone = null;
      // The preview is DISCARDED here, so the card lands back where it began —
      // which is exactly why it should still be seen to travel rather than
      // vanish from the hand.
      notesStore.dragEnd(false);
      if (landing && landingId) landClone(landing, landingId);
      else landing?.remove();
    }
    abandonIntent();
    dragActive = false;
    lastHoveredCardId = null;
  };

  const onPointerUp = () => {
    clearLongPress();
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('touchmove', touchScrollBlocker);
    if (dragActive) {
      document.body.classList.remove('notes-dragging');
      const landing = dragClone;
      const landingId = dragIntent?.id ?? null;
      dragClone = null;
      notesStore.dragEnd(true);
      // AFTER dragEnd, so the destination slot is the committed one.
      if (landing && landingId) landClone(landing, landingId);
      else landing?.remove();
      // SWALLOW THE CLICK THE DRAG IS ABOUT TO PRODUCE.
      //
      // The browser dispatches a click after mouseup, on whatever sits under
      // the cursor. At the end of a drag that is a different card than the one
      // picked up (the grid rearranged under the cursor), or the composer, so
      // releasing a drag would open a note the user never tapped — and landing
      // on "Take a note..." expands the composer, which reads as the drag
      // having created a note.
      //
      // Capture phase so it is intercepted before any card's own handler, and
      // cleared on a macrotask in case no click follows at all (drags that end
      // outside the window produce none, and a stale swallower would eat the
      // user's next real click).
      const swallowClick = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        document.removeEventListener('click', swallowClick, true);
      };
      document.addEventListener('click', swallowClick, true);
      setTimeout(() => document.removeEventListener('click', swallowClick, true), 0);
    }
    dragIntent = null;
    dragActive = false;
    lastHoveredCardId = null;
  };

  const renderCard = (note: NoteItem) => {
    const idx = () => notesStore.activeNotes().indexOf(note);

    if (view() === 'trash') {
      return (
        <NoteCard
          note={note}
          index={0}
          viewMode="trash"
          onClick={() => {}}
          onRestore={(e) => { e.stopPropagation(); handleRestore(note); }}
          onDelete={(e) => { e.stopPropagation(); handlePermanentDelete(note); }}
        />
      );
    }

    if (view() === 'inbox') {
      return (
        <NoteCard
          note={note}
          index={0}
          viewMode="inbox"
          onClick={() => handleCardClick(note)}
          onDelete={() => {}}
          onDismiss={(e) => { e.stopPropagation(); handleDismiss(note); }}
          onBlock={(e) => { e.stopPropagation(); handleBlock(note); }}
        />
      );
    }

    return (
      <NoteCard
        note={note}
        index={idx()}
        viewMode={view()}
        onClick={() => handleCardClick(note)}
        onPin={(e) => { e.stopPropagation(); handlePin(note); }}
        onCopy={(e) => { e.stopPropagation(); handleCopy(note); }}
        onShare={(e) => { e.stopPropagation(); handleShare(note); }}
        onArchive={(e) => { e.stopPropagation(); handleArchive(note); }}
        onDelete={(e) => { e.stopPropagation(); handleDelete(note); }}
        onDragIntent={handleDragIntent}
      />
    );
  };

  /**
   * Opening ONE note, and it is not on screen yet.
   *
   * The Android shell opens every note by navigating here, so this is the
   * common path on a phone — and rendering the full grid, sidebar and header
   * while the list loads would make the user watch the entire app assemble
   * itself before their note appeared. It would also look like the app
   * changing layout underneath them, because the web list is one column at
   * phone width while the native list is two.
   *
   * Nothing is skipped, only deferred: the list still loads, and the moment the
   * note is in it the effect above opens it.
   */
  const openingDeepLink = () =>
    !!params.id && !editingNote() && !deepLinkMissing();

  /**
   * Arrived on a single note — the phones' "tap a note" path, which loads
   * `/note/:id` in a WebView.
   *
   * Then the note is the whole screen and the grid behind it is not just
   * wasted work, it is WRONG: on a phone the web grid is one column while the
   * native list the person just tapped is two, so opening a note would
   * visibly throw away their layout and replace the app around them. It would
   * also put a second search bar and header on screen — the one that renders
   * under the status bar. Rendering only the note removes all of that.
   *
   * Closing navigates to `/`, which clears params.id and brings the grid back
   * the normal way.
   */
  const noteIsTheWholeScreen = () => !!params.id && !!editingNote();

  return (
    <Show when={!openingDeepLink()} fallback={
      <div class="keep-page deep-link-loading">
        <div class="loading-spinner" />
        <p>Opening…</p>
      </div>
    }>
    <Show when={!noteIsTheWholeScreen()} fallback={
      // keep-page for the background only — no header, no grid, no composer.
      <div class="keep-page">
        <Show when={editingNote()} keyed>
          {(note) => <NoteModal note={note} onClose={handleCloseModal} initialTool={attachNewNote() ? 'attachments' : null} />}
        </Show>
      </div>
    }>
    <div class="keep-page">
      <header class="keep-header">
        <div class="keep-header-left">
          <button
            class="btn-icon"
            onClick={() => setSidebarOpen(!showSidebar())}
            title={showSidebar() ? 'Hide notebooks' : 'Notebooks'}
            aria-label={showSidebar() ? 'Hide notebooks' : 'Show notebooks'}
            aria-expanded={showSidebar()}
            aria-controls={sidebarId}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          {/* No tier badge here. Only the Plan row in Settings can act on the
              plan: it carries the Upgrade/Manage control and the sentence saying
              what the tier buys. A badge that repeats a fact next to no action is
              noise, and a permanent one in the header spends the app's most
              valuable strip on it. */}
          <h1>Pingolin Note</h1>
        </div>
        <div class="keep-header-center">
          <SearchBar onSearch={handleSearch} />
          {/* Standing disclosure for an account somebody else set up and still
              holds the password to. It sits here, under the search bar, rather
              than in settings, because the person who needs it is the one who
              does not already suspect — and they will never open a settings
              panel to find out. Deliberately states the CONSEQUENCE rather than
              the arrangement: "managed by a guardian" reads as an
              administrative fact about who pays. */}
          <Show when={authStore.user()?.guardian_managed}>
            <p class="guardian-managed-line" role="note">Notes readable by guardian</p>
          </Show>
        </div>
        <div class="keep-header-right">
          <Show when={notesStore.syncing()}>
            <span class="sync-indicator">Syncing...</span>
          </Show>
          <button class="btn-icon" onClick={() => notesStore.sync()} title="Refresh">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
          <button class="btn-icon" onClick={() => setShowSettings(true)} title="Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button
            class="btn-icon"
            onClick={async () => {
              // In the shell, hand sign-out to the NATIVE flow (confirm
              // dialog + flush + push teardown + revoke + wipe) — the page's
              // own logout would strand the shell on the in-WebView portal
              // with the native session still alive.
              const scheme = (window as { __pingolinShellSignOut?: string }).__pingolinShellSignOut;
              if (scheme) {
                window.location.href = `${scheme}://go`;
                return;
              }
              // Both native shells ask first (that is the "confirm dialog" in
              // the flow named above), so the web path asks too: this icon is
              // 4px from Settings in a row of four identical 18px glyphs. The
              // consequence of a mis-tap is not just "log in again":
              // authStore.logout() runs clearLocalCache(), which clears
              // STORE_PENDING — the offline queue — so an edit made without a
              // connection is gone.
              if (!(await confirmAction({
                message: 'Sign out?',
                detail: "Your notes stay on the server. This device clears its cached copies and anything still waiting to sync, and you'll need your password to unlock them here again.",
                confirmLabel: 'Sign out',
              }))) return;
              // What is waiting to sync is sent first (ten seconds at most), and
              // anything still left is asked about once more (lib/signOut).
              await signOutAfterSending({
                flush: () => notesStore.flushPending(),
                waiting: () => notesStore.waitingCount(),
                confirm: confirmAction,
                logout: () => authStore.logout(),
              });
            }}
            title="Sign out"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </header>

      <div class="keep-body">
      <Show when={showSidebar()}>
        <Sidebar
          selectedNotebook={selectedNotebook()}
          selectedLabels={filters().labels}
          onLabelRenamed={(from, to) => setFilters(f => ({ ...f, labels: renameSelected(f.labels, from, to) }))}
          showReminders={view() === 'reminders'}
          showInbox={view() === 'inbox'}
          onSelect={(id) => { setSelectedNotebook(id); setFilters(f => ({ ...f, labels: [] })); setView('active'); setSearchResults(null); closeSidebarOnPhone(); }}
          onSelectLabel={(l) => { setFilters(f => ({ ...f, labels: l === null ? [] : [l] })); setSelectedNotebook(null); setView('active'); setSearchResults(null); closeSidebarOnPhone(); }}
          onSelectReminders={() => { setView('reminders'); setSelectedNotebook(null); setFilters(f => ({ ...f, labels: [] })); setSearchResults(null); closeSidebarOnPhone(); }}
          onSelectInbox={() => {
            setView('inbox'); setSelectedNotebook(null); setFilters(f => ({ ...f, labels: [] })); setSearchResults(null);
            sharesInboxStore.load().then(() => sharesInboxStore.markSeen());
            closeSidebarOnPhone();
          }}
          onShareNotebook={(id) => setSharingNotebookId(id)}
        />
      </Show>

      <main class="keep-main">
        {/* Sender key-change security alerts (rotated / substituted signing
            keys drop that sender's shares until the user approves the new key). */}
        <KeyChangeAlarms />
        {/* Incoming shares this client would not open — dropping one is a
            security verdict; hiding it would leave the recipient nothing to act on. */}
        <BlockedShares />
        {/* Signed in but holding no E2EE keys: everything is locked, and this
            says why and where to unlock. */}
        <KeysUnavailableNotice />
        {/* Our own notes a password reset locked — they exist, and the
            recovery key restores them. */}
        <LockedNotesNotice />

        {/* Running on a session resumed from cache. Worth saying plainly: the
            notes are real but nothing here has reached the server on this load,
            and edits are queued rather than saved. Silence would let someone
            believe their work is safely stored. */}
        <Show when={authStore.isOffline()}>
          <div
            style={{
              margin: '8px 12px',
              border: '1px solid #6b7280',
              background: 'var(--bg-secondary, #f3f4f6)',
              color: 'var(--text-primary, #374151)',
              'border-radius': '8px',
              padding: '10px 14px',
              'font-size': '0.9rem',
            }}
            role="status"
          >
            Offline — showing your saved notes. Changes are queued and will sync
            when you're back online.
          </div>
        </Show>

        {/* A deep link that resolved to nothing. Says so rather than dumping
            the user on the grid with no explanation — the usual cause is a
            push tap for a note that has since been deleted, or one whose
            share was revoked before the tap. */}
        <Show when={deepLinkMissing()}>
          <div
            style={{
              margin: '8px 12px',
              border: '1px solid #d0771a',
              background: '#fff4e5',
              color: '#5c3b00',
              'border-radius': '8px',
              padding: '12px 14px',
              'font-size': '0.9rem',
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
            }}
            role="status"
          >
            <span style={{ flex: '1' }}>
              That note isn't available. It may have been deleted, or no longer shared with you.
            </span>
            <button
              class="btn"
              style={{ 'flex-shrink': '0' }}
              onClick={() => { setDeepLinkMissing(false); navigate('/', { replace: true }); }}
            >
              Dismiss
            </button>
          </div>
        </Show>

        <Show when={view() === 'active' && !selectionStore.isSelectionMode() && mayWriteHere()}>
          <NoteComposer
            onCreate={handleCreate}
            onCreateList={handleCreateList}
            onAttachToNew={(note) => { setAttachNewNote(true); setEditingNote(note); }}
            initial={initialNewNote}
            bind={(api) => {
              setComposerApi(api);
              // A `/new` that landed while this was unmounted — a note open over
              // the grid, or any view but Notes. The fragment is already
              // stripped from the URL, so `pendingNewNote` is the only copy of
              // the user's shared text; dropping it here would lose it.
              if (api) {
                const req = takeNewNoteRequest();
                if (req) void api.openWith(req);
              }
            }}
          />
        </Show>

        {/* Current notebook indicator — the selection bar takes this line
            over while notes are selected, rather than stacking above it. */}
        <Show when={selectionStore.isSelectionMode()} fallback={
        <div class="notebook-indicator">
          <div class="notebook-menu-wrap">
            <button
              class="notebook-indicator-text"
              onClick={() => setShowNotebookMenu(v => !v)}
              aria-haspopup="listbox"
              aria-expanded={showNotebookMenu()}
              title="Choose notebook"
            >
              <Show when={selectedNotebook()} fallback={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              }>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              </Show>
              {/* The heading names the view you are actually in, so the cue to
                  where you are is never left behind in the sidebar. */}
              <span>{
                view() === 'reminders' ? 'Reminders'
                  : view() === 'inbox' ? 'Shared with me'
                  : selectedNotebook() ? (notebookNameById(selectedNotebook()!) || 'Notebook')
                  : 'All Notes'
              }</span>
              <svg class="notebook-indicator-caret" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>
            <Show when={showNotebookMenu()}>
              <div class="notebook-menu" role="listbox">
                <button
                  class="notebook-menu-item"
                  classList={{ active: !selectedNotebook() }}
                  role="option"
                  aria-selected={!selectedNotebook()}
                  onClick={() => pickNotebook(null)}
                >
                  All Notes
                </button>
                <For each={notebooksStore.notebooks()}>
                  {(nb) => (
                    <button
                      class="notebook-menu-item"
                      classList={{ active: selectedNotebook() === nb.id }}
                      role="option"
                      aria-selected={selectedNotebook() === nb.id}
                      onClick={() => pickNotebook(nb.id)}
                    >
                      {nb.name}
                    </button>
                  )}
                </For>
                <Show when={notebooksStore.notebooks().length === 0}>
                  <span class="notebook-menu-hint">No notebooks yet</span>
                </Show>
              </div>
            </Show>
          </div>
          <Show when={selectedNotebook()}>
            <button class="notebook-clear" onClick={() => setSelectedNotebook(null)} title="Show all notes">&times;</button>
          </Show>
          {/* Phone-only (CSS): compose entry points live on this line, where
              the collapsed "Take a note..." row is hidden. Only where a note
              may be written, like the composer they open. */}
          <Show when={view() === 'active' && !selectionStore.isSelectionMode() && mayWriteHere()}>
            <div class="notebook-actions">
              <button
                class="notebook-action-btn"
                title="Take a note"
                aria-label="Take a note"
                onClick={() => composerApi()?.expandText()}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              <button
                class="notebook-action-btn"
                title="New list"
                aria-label="New list"
                onClick={() => composerApi()?.expandList()}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="5" width="6" height="6" rx="1"/>
                  <path d="M5 8l1.5 1.5L9 6"/>
                  <line x1="13" y1="8" x2="21" y2="8"/>
                  <rect x="3" y="13" width="6" height="6" rx="1"/>
                  <line x1="13" y1="16" x2="21" y2="16"/>
                </svg>
              </button>
            </div>
          </Show>
        </div>
        }>
          <SelectionBar viewMode={view()} />
        </Show>

        <nav class="view-tabs">
          <button class={view() === 'active' ? 'tab active' : 'tab'} onClick={() => { setView('active'); setSearchResults(null); }}>Notes</button>
          <button class={view() === 'archived' ? 'tab active' : 'tab'} onClick={() => { setView('archived'); setSearchResults(null); }}>Archive</button>
          <button class={view() === 'trash' ? 'tab active' : 'tab'} onClick={() => { setView('trash'); setSearchResults(null); }}>Trash</button>
          {/* Reminders and Shared with me are sidebar destinations, but while
              you are in one the strip must still show which; otherwise it
              highlights nothing and looks like a rendering fault. */}
          <Show when={view() === 'reminders'}>
            <button class="tab active">Reminders</button>
          </Show>
          <Show when={view() === 'inbox'}>
            <button class="tab active">Shared with me</button>
          </Show>
          <button
            class="filter-collapse-caret"
            classList={{ collapsed: filtersCollapsed(), 'has-active': filtersHiddenButOn() }}
            onClick={toggleFilters}
            title={filtersCollapsed() ? (filtersHiddenButOn() ? 'Show filters (some are on)' : 'Show filters') : 'Hide filters'}
            aria-label={filtersCollapsed() ? (filtersHiddenButOn() ? 'Show filters (some are on)' : 'Show filters') : 'Hide filters'}
            aria-expanded={!filtersCollapsed()}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </nav>

        {/* One row, matching Android: All, the four built-in filters as icons,
            then the user's labels, every filter reachable from the grid. The
            filter helpers live in lib/filters.ts.

            The colour filter has no Android equivalent and no control
            anywhere: nothing writes `filters.color`. `applyFilters` still
            honours the field, so a colour control needs nothing beyond the
            control itself; without one, filtering by colour is unreachable. */}
        <Show when={!filtersCollapsed()}>
          <FilterBar
            filters={filtersHere()}
            onChange={changeFilters}
            labels={labelChips()}
            showOnlyMine={onlyMineHere()}
          />
        </Show>

        {/* Inbox: grouped-by-sharer layout so recipients see a clear
            "Notes shared by Alice" / "Notes shared by Bob" structure. */}
        <Show when={view() === 'inbox'} fallback={
          <>
            <Show when={pinnedNotes().length > 0}>
              <div class="section-label">Pinned</div>
              <div class={notesStore.draggedId() ? 'notes-grid is-dragging' : 'notes-grid'}>
                <For each={pinnedNotes()}>
                  {(note) => renderCard(note)}
                </For>
              </div>
            </Show>
            {/* "Others" read as a leftover bucket; this row only ever appears
                opposite "Pinned", so name what it holds. */}
            <Show when={pinnedNotes().length > 0 && unpinnedNotes().length > 0}>
              <div class="section-label">Other notes</div>
            </Show>
            <div class={notesStore.draggedId() ? 'notes-grid is-dragging' : 'notes-grid'}>
              <For each={unpinnedNotes()}>
                {(note) => renderCard(note)}
              </For>
            </div>
          </>
        }>
          <For each={inboxGroups()}>
            {(group) => (
              <>
                <div class="section-label inbox-group-label">Shared by {group.sharer}</div>
                <div class="notes-grid">
                  <For each={group.notes}>
                    {(note) => renderCard(note)}
                  </For>
                </div>
              </>
            )}
          </For>
        </Show>

        {/* Empty state. The message must say WHY the grid is empty, and the
            icon must match: an account with notes that a filter happens to
            exclude is not a new account, and told "Notes you add appear here"
            the reader looks for a fault in their notes rather than at the chip
            they just pressed. The pencil is not for "nothing in trash" or "no
            search matches" either: both would read as an invitation to write. */}
        {/* NOT YET KNOWN is not the same as NONE.

            Ungated, a cold start for an account with notes is blank for a while,
            then shows "Notes you add appear here" for a moment, then the notes.
            A flash of "you have nothing" reads as data loss in a way that a flash
            of nothing does not.

            The gate is `notesLoaded()`, the signal that exists for exactly
            this reason one screen over — its own comment says "without it we
            cannot tell 'this note hasn't arrived yet' from 'this note doesn't
            exist', and a deep link would flash 'not found' every time on a
            cold start". The empty state is the same claim about the whole grid.

            A cache with notes paints them before this matters, so the
            skeletons are only ever seen by an account that genuinely has
            nothing local yet — a new account, or a new device. */}
        <Show when={!notesLoaded() && displayedNotes().length === 0}>
          <div class="notes-grid" aria-hidden="true">
            <For each={[0, 1, 2, 3, 4, 5]}>
              {() => <div class="note-card note-card-skeleton" />}
            </For>
          </div>
        </Show>
        <Show when={notesLoaded() && displayedNotes().length === 0}>
          <div class="empty-state">
            <Switch fallback={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            }>
              {/* First: where a chip hid every note of a place that has
                  some, that is the reason whatever the place is (a trash of
                  five notes under a grey label is not an emptied trash). */}
              <Match when={narrowedByFilter()}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
              </Match>
              <Match when={view() === 'reminders'}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M12 2a7 7 0 0 1 7 7c0 2.6.8 5.1 2.3 7.3.4.6-.1 1.4-.9 1.4H3.6c-.8 0-1.3-.8-.9-1.4C4.2 14.1 5 11.6 5 9a7 7 0 0 1 7-7z"/><path d="M9 21a3 3 0 0 0 6 0"/></svg>
              </Match>
              <Match when={searchQuery()}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><circle cx="11" cy="11" r="7"/><line x1="16.2" y1="16.2" x2="21" y2="21"/></svg>
              </Match>
              <Match when={view() === 'trash'}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </Match>
              <Match when={view() === 'inbox'}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
              </Match>
            </Switch>
            <p>{emptyStateMessage()}</p>
            {/* A filter the user can undo from where they are looking: the
                label lit last first, then the whole row (lib/emptyStateMessage).
                One button per KIND of step, kept while that kind is on
                offer. The list is made anew on every change: keyed by its
                items (objects) each press would rebuild all three buttons and
                the keyboard's focus would fall to the page; keyed by position
                the focused button would stay and change MEANING, the second
                one going from "Show only" to "Clear filters" under a second
                press of Enter. By kind, "Remove" stays "Remove" for the label
                before, and a kind no longer offered goes. */}
            <Show when={narrowedByFilter()}>
              <div class="empty-state-actions">
                <For each={emptyStateActions(filtersHere()).map(a => a.kind)}>
                  {(kind) => {
                    const action = () => emptyStateActions(filtersHere()).find(a => a.kind === kind);
                    return (
                      <button
                        class="btn btn-sm btn-secondary empty-state-action"
                        onClick={() => { const a = action(); if (a) changeFilters(applyEmptyStateAction(filtersHere(), a, emptyFilters)); }}
                      >{action() ? emptyStateActionLabel(action()!) : ''}</button>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </main>

      </div> {/* close keep-body */}

      {/* Capture, within reach of a thumb.
          On touch the composer row is display:none, and the two unlabelled
          44px icons at the top-right of the notebook line sit well beyond a
          thumb's comfortable arc at rest and outside even the stretch arc,
          and they scroll away with the content while Settings
          and Sign out stay pinned. A FAB is where a phone puts its primary
          action for exactly this reason.

          "New list" is a SEPARATE, smaller button rather than a long-press on
          the main one: this app already spends long-press on card selection,
          so a second meaning for the same gesture would be a coin toss, and a
          hidden gesture is not an entry point. It is 40px to the main button's
          56px because it does not earn parity with "New note".

          The pair at the top-right stays in the markup and is hidden by CSS on
          touch only — it is still the route in a narrow MOUSE window, where
          the composer row is hidden by width but no FAB appears. */}
      <Show when={
        view() === 'active'
        && !selectionStore.isSelectionMode()
        // Not in a shared notebook the reader may not add to: there is no
        // composer there for these to open (lib/notebookRights).
        && mayWriteHere()
        // The composer goes fullscreen on a phone; a button floating over the
        // note being written is not an entry point, it is an obstacle.
        && !composerApi()?.expanded()
      }>
        <div class="notes-fab-stack">
          <button
            class="notes-fab notes-fab-mini"
            title="New list"
            aria-label="New list"
            onClick={() => composerApi()?.expandList()}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="5" width="6" height="6" rx="1"/>
              <path d="M5 8l1.5 1.5L9 6"/>
              <line x1="13" y1="8" x2="21" y2="8"/>
              <rect x="3" y="13" width="6" height="6" rx="1"/>
              <line x1="13" y1="16" x2="21" y2="16"/>
            </svg>
          </button>
          <button
            class="notes-fab notes-fab-main"
            title="New note"
            aria-label="New note"
            onClick={() => composerApi()?.expandText()}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
      </Show>

      {/* keyed: the callback receives a non-null snapshot, so the
          modal's internal computations (e.g. isChecklist reading
          props.note.noteType) can't observe the editingNote→null
          transition on close — the non-keyed form would let them re-run
          against null before <Show> disposes the subtree, throwing
          an uncaught TypeError on every close. */}
      <Show when={editingNote()} keyed>
        {(note) => <NoteModal note={note} onClose={handleCloseModal} initialTool={attachNewNote() ? 'attachments' : null} />}
      </Show>

      <Show when={showSettings()}>
        <SettingsPanel onClose={() => setShowSettings(false)} />
      </Show>

      <Show when={notesStore.noteLimitReached()}>
        <div class="note-modal-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains('note-modal-overlay')) notesStore.dismissNoteLimit(); }}>
          <div class="note-modal" style="max-width: 420px">
            <div style="padding: 20px">
              <h2 style="font-size: 18px; margin-bottom: 4px">Note limit reached</h2>
              {/* Free notes are uncapped, so this path is dormant — kept as a
                  safety net for a 402 on create. Copy stays count-free so it
                  can't state a limit that does not apply. */}
              <UpgradePrompt message="You've reached the note limit for your plan. Premium removes the cap." />
              <div style="text-align: center; margin-top: 8px">
                <button class="btn btn-sm btn-secondary" onClick={() => notesStore.dismissNoteLimit()}>Not now</button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={sharingNotebookId()}>
        <div class="note-modal-overlay" onClick={(e) => { if ((e.target as HTMLElement).classList.contains('note-modal-overlay')) setSharingNotebookId(null); }}>
          <div class="note-modal" style="max-width: 480px">
            <div style="padding: 16px">
              <h2 style="font-size: 18px; margin-bottom: 4px">Share notebook: {notebooksStore.getById(sharingNotebookId()!)?.name}</h2>
              <SharePanel noteId={sharingNotebookId()!} onClose={() => setSharingNotebookId(null)} />
            </div>
          </div>
        </div>
      </Show>

      <Show when={sharingNote()}>
        <div class="note-modal-overlay" onMouseDown={(e) => { if ((e.target as HTMLElement).classList.contains('note-modal-overlay')) setSharingNote(null); }}>
          <div class="note-modal" style="max-width: 480px">
            <div style="padding: 16px">
              <h2 style="font-size: 18px; margin-bottom: 4px">Share note</h2>
              <SharePanel noteId={sharingNote()!.id} onClose={() => setSharingNote(null)} />
            </div>
          </div>
        </div>
      </Show>
    </div>
    </Show>
    </Show>
  );
};

export default NotesView;
