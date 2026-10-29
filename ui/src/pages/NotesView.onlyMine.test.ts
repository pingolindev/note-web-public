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
 * "Only mine", and the notes held for an invitation not yet accepted: the
 * wiring nothing else binds.
 *
 * The rules are pure and tested where they live (lib/onlyMine, lib/filters,
 * lib/notebookInvites). What makes them true on screen is a handful of lines
 * in the view and two stores, and each of them fails silently: read
 * `filters()` instead of `filtersHere()` and an accepted shared notebook opens
 * empty; hand the row `setFilters` and "All" inside a notebook throws the
 * remembered choice away; drop the `inboxFresh` test and one failed request
 * forgets every accepted notebook, whose notes are now held until the reader
 * accepts again. Source-reading, as lib/noteToolsRow.test.ts.
 */
const SRC = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');
const view = read('pages', 'NotesView.tsx');
const bar = read('components', 'FilterBar.tsx');
const notes = read('stores', 'notes.ts');
const inbox = read('stores', 'sharesInbox.ts');

describe('"Only mine" in the notes view', () => {
  /** Under the ACCOUNT, through lib/account's scoped stores, never one key for the browser. */
  it('starts from what this device remembers for this account', () => {
    expect(view).toContain('const [filters, setFilters] = createSignal<Filters>({ ...emptyFilters, onlyMine: storedOnlyMine(() => scopedGetItem(ONLY_MINE_STORE)) });');
    expect(view).not.toMatch(/storedOnlyMine\(localStorage\)|rememberOnlyMine\(localStorage/);
  });

  it('acts only in the plain Notes grid, and the grid, the row and the empty state read the same filters', () => {
    expect(view).toContain("const onlyMineHere = () => onlyMineApplies({\n    view: view(), notebook: selectedNotebook(), searching: searchResults() !== null,\n  });");
    expect(view).toContain('const filtersHere = () => inScope(filters(), onlyMineHere());');
    expect(view).toContain('const displayedNotes = () => applyFilters(scopedNotes(), filtersHere());');
    expect(view).not.toContain('applyFilters(notes, filters())');
    expect(view).not.toContain('applyFilters(scopedNotes(), filters())');
    // The label chips count over the same scoped filters, or a chip's number
    // would leave out shared notes inside a notebook that shows them.
    expect(view).toContain('labelChipsOf(scopedNotes(), filtersHere(), notesStore.allLabels())');
    expect(view).not.toContain('labelChipsOf(scopedNotes(), filters(),');
    expect(view).toContain('const narrowedByFilter = () => chipsEmptiedIt({ filters: filtersHere(), placeHasNotes: scopedNotes().length > 0 });');
    expect(view).toContain('    filters: filtersHere(),\n');
  });

  it('offers the chip only where it acts, and a change made elsewhere leaves the choice alone', () => {
    expect(view).toContain('<FilterBar\n            filters={filtersHere()}\n            onChange={changeFilters}\n            labels={labelChips()}\n            showOnlyMine={onlyMineHere()}\n          />');
    expect(view).not.toContain('onChange={setFilters}');
    expect(view).toContain('const kept = keepOutOfScope(next, filters(), onlyMineHere());');
    // Every way back from an empty grid, "Clear filters" among them, goes
    // through changeFilters too (lib/emptyStateMessage resets to emptyFilters).
    expect(view).toContain('onClick={() => { const a = action(); if (a) changeFilters(applyEmptyStateAction(filtersHere(), a, emptyFilters)); }}');
    expect(view).not.toContain('setFilters(applyEmptyStateAction(');
    expect(view).not.toContain('setFilters({ ...emptyFilters })');
  });

  it('remembers the choice when it changes', () => {
    expect(view).toContain('if (kept.onlyMine !== filters().onlyMine) rememberOnlyMine(v => scopedSetItem(ONLY_MINE_STORE, v), kept.onlyMine);');
  });

  it('the chip toggles one field and spells itself out when on', () => {
    expect(bar).toContain('<Show when={props.showOnlyMine}>\n        <button');
    expect(bar).toContain('onClick={() => props.onChange({ ...props.filters, onlyMine: !props.filters.onlyMine })}');
    expect(bar).toContain('aria-pressed={props.filters.onlyMine}');
    expect(bar).toContain('<Show when={props.filters.onlyMine}><span>Only mine</span></Show>');
  });

  /**
   * lib/onlyMine reads `openedVia` alone. That equals `openedWith(n) === 'share'`
   * only while openedWith never says 'share' on its own.
   */
  it('openedWith never says "share" without openedVia', () => {
    const start = notes.indexOf('export function openedWith(');
    const body = notes.slice(start, notes.indexOf('\n}\n', start));
    expect(start).toBeGreaterThan(0);
    expect(body).toContain('if (n.openedVia) return n.openedVia;');
    expect(body).not.toMatch(/return 'share'/);
  });
});

describe('notes held for an invitation not yet accepted', () => {
  it('stay out of the Notes grid and the Archive, and nowhere else', () => {
    expect(view).toContain("if (searchResults() === null && (view() === 'active' || view() === 'archived')) {\n      notes = notes.filter(n => !notesStore.heldForInvitation(n));\n    }");
  });

  it('are decided from the inbox, the reader\'s own acceptances, and whether the inbox has answered', () => {
    // On offer: the invitations among the rows read, AND every notebook the server says is on
    // offer (an invitation's own row can lie past what was read).
    expect(notes).toContain(
      'pending: pendingNotebookIds(\n'
      + '        [...sharesInboxStore.sharedNotebooks().map(s => s.itemId), ...(sharesInboxStore.offeredNotebooks() ?? [])],\n'
      + '        accepted,\n'
      + '      ),');
    expect(notes).toContain('accepted: new Set(accepted),');
    // Answered, or cannot be asked (no keys in the tab): read live, never latched.
    // "Answered" is an answer that says which notebooks are on offer, or no
    // answer at all: offline nothing is held on a guess.
    expect(notes).toContain(
      'inboxKnown: (sharesInboxStore.answered() && (offersAreKnown() || sharesInboxStore.gotNoAnswer()))\n'
      + '        || authStore.keysUnavailable() !== null,');
    expect(notes).toContain('return sharesInboxStore.offeredNotebooks() !== null || sharesInboxStore.listedNotebookIds() !== null;');
    expect(notes).toContain('heldForInvitation: (n: NoteItem): boolean => awaitsInvitation(n, invitationState()),');
  });

  /**
   * Failed ones included; NOT one that was discarded because a later refresh
   * had already applied: it has answered nothing, and marking it would release
   * the hold with no list on screen.
   */
  it('the inbox says it has answered after every refresh that was not discarded, failed ones included', () => {
    // And it says whether that refresh got NO answer: its first page unread, on a
    // page that has had no answer for this account yet. BEFORE it says it has answered:
    // whoever reads the two reads them together.
    expect(inbox.replace(/\s*\/\/[^\n]*/g, '')).toContain(
      '    } finally {\n      if (thisLoad === newestLoad) setLoading(false);\n'
      + '      if (!discarded) {\n        setGotNoAnswer(firstPageUnread && !answeredHere);\n        setAnswered(true);\n      }\n    }');
    expect(inbox).toContain('      lastApplied = thisLoad;\n      answeredHere = true;\n');
    expect(inbox.match(/answeredHere = true/g)).toHaveLength(1);
    expect(inbox).toContain('  loading,\n  answered,\n');
    // An answer is applied unless a refresh that started later has already applied.
    expect(inbox).toContain('      if (thisLoad < lastApplied) {\n        discarded = true;\n        return false;\n      }\n      lastApplied = thisLoad;');
    // A refresh that FAILS empties the screen only when it is the newest one started and none
    // later has applied: a newer one still reading has its answer on the way.
    expect(inbox).toContain('        if (thisLoad > lastApplied && thisLoad === newestLoad) setShares([]);\n        else discarded = true;');
    expect(inbox).not.toContain('thisLoad !== newestLoad');
  });

  it('their labels are not offered as chips', () => {
    expect(notes).toContain('if (n.deleted || awaitsInvitation(n, state)) continue;');
    expect(notes).toContain('allLabels: (): string[] => shownLabels(),');
  });

  /**
   * A refresh that fails empties the inbox. Pruned against that, every
   * acceptance would be forgotten on every device, and the notes of each
   * accepted notebook would be held until accepted again.
   */
  it('acceptances are pruned only against the authoritative inbox', () => {
    expect(notes).toContain('const listed = inboxFresh ? sharesInboxStore.listedNotebookIds() : null;');
    expect(notes).toContain('if (listed !== null) {\n        void notebooksStore.pruneAcceptances(listed)');
    expect(notes).not.toContain('\n      void notebooksStore.pruneAcceptances(');
  });

  /**
   * Against every notebook the server NAMES, never the rows this page could
   * open: a sender's key change blocks their rows while the refresh succeeds,
   * and the acceptance would be struck on every device.
   */
  it('and against the notebooks the server names, not the rows this page opened', () => {
    expect(notes).not.toMatch(/pruneAcceptances\(\s*new Set\(sharesInboxStore\.sharedNotebooks\(\)/);
    // Of the rows that are applied: a share dismissed while this answer was being opened is not among them.
    expect(inbox).toContain('const applied = out.filter(s => !dismissedHere.has(s.shareId));');
    expect(inbox).toContain('const notebookRows = applied.filter(s => s.itemType === ITEM_TYPE_NOTEBOOK);');
    expect(inbox).toContain('setListedNotebooks(complete ? new Set(notebookRows.map(s => s.itemId)) : null);');
    // Taken from `out`, every row served, before or beside the trust filter, never from `trusted`.
    expect(inbox).not.toContain('new Set(trusted.filter(');
  });

  /** What the device has seen accepted is brought up to date at every sync, with the list only when there is one. */
  it('the device\'s memory of acceptances is brought up to date at every sync', () => {
    expect(notes).toContain('notebooksStore.rememberAcceptances(listed);');
    expect(notes).toContain('void notebooksStore.pruneAcceptances(listed)');
    expect(notes).toContain('seenAccepted: new Set(notebooksStore.seenAcceptedNotebooks()),');
  });

  /**
   * An inbox answer that fills the page may be the newest rows of more. It
   * is applied, and it is not "the list": load() says so, and the prune, the
   * eviction and the memory all hang on what load() says.
   */
  it('a full inbox page is not taken for the whole list', () => {
    expect(inbox).toContain('const complete = served.complete;');
    expect(inbox).toContain('      return complete;\n    } finally {');
    // And the inbox is read to its end, with the server's own cursor, and
    // the end is where the SERVER says it is (lib/inboxPage).
    expect(inbox).toContain("let url = '/api/v1/shares/inbox?page_info=true';");
    expect(inbox).toContain("url = `/api/v1/shares/inbox?page_info=true&before=${encodeURIComponent(last.created_at)}&before_id=${encodeURIComponent(last.share_id)}`;");
    expect(inbox).toContain('const answer = result.success ? readInboxAnswer<ServerShare>(result.data, INBOX_PAGE_LIMIT) : null;');
    expect(inbox).toContain('if (!answer.more) return { rows, complete: true, declined, offered };');
    // What the first page says of the inbox as a whole is read off the FIRST page, and kept
    // whichever way the reading ends.
    expect(inbox).toContain('if (page === 0) { declined = answer.declined; offered = answer.offered; }');
    expect(inbox.match(/return \{ rows, complete: false, declined, offered \};/g)).toHaveLength(2);
    expect(inbox).not.toContain('result.data.length < INBOX_PAGE_LIMIT');
    expect(notes).toContain('const listed = inboxFresh ? sharesInboxStore.listedNotebookIds() : null;');
    expect(notes).toContain('if (inboxFresh && !syncFailed) {');
  });

  /**
   * A tab with no keys runs no sync and holds nothing on a guess; when its
   * keys arrive the view syncs at once, and nothing in between is latched.
   */
  it('a tab with no keys runs no sync, and the view syncs the moment keys arrive', () => {
    expect(notes).toContain('    if (!isCryptoReady()) return;\n    setSyncing(true);');
    expect(notes).not.toContain('cannotAsk');
    expect(inbox).not.toContain('cannotAsk');
    expect(view.replace(/\s+/g, ' ')).toContain("createEffect(on(() => authStore.keysUnavailable(), (now, before) => { if (before != null && now === null) void notesStore.sync(); }, { defer: true }));");
  });

  /**
   * Decline runs the sequence in lib/declineInvitation (where each step and
   * each failure has a test) with the stores' own calls, and sends no
   * dismissal of its own whose answer nobody reads. The decline itself is ONE
   * request the server carries out whole.
   */
  it('declining goes through the checked sequence, with the stores\' own steps', () => {
    const shared = read('components', 'SharedNotebooks.tsx');
    expect(shared).toContain('await declineNotebook(declined(invite), notesOf(invite.notebookId), declineSteps());');
    expect(shared).toContain('const notesOf = (notebookId: string) => notesIn(notebookId).map(s => ({ shareId: s.shareId, noteId: s.itemId }));');
    expect(shared).toContain('markDeclined: (id, shareIds) => sharesInboxStore.markDeclined(id, shareIds),');
    expect(shared).toContain('decline: (id, shareIds) => sharesInboxStore.declineNotebook(id, shareIds),');
    // A decline the server did not take leaves no mark behind, and "the
    // notebook is gone" is only ever read off a list: no list is "still on offer".
    expect(shared).toContain('unmarkDeclined: (id) => sharesInboxStore.clearDeclined(id),');
    expect(shared).toContain('isOffered: (id) => sharesInboxStore.listedNotebookIds()?.has(id) ?? true,');
    // No share of the notebook is dismissed one at a time.
    expect(shared).not.toContain('sharesInboxStore.dismiss(');
    expect(shared).toContain('forgetAcceptance: (id) => notebooksStore.setNotebookAccepted(id, false),');
    expect(shared).toContain('forgetNotes: (ids) => notesStore.dropReceived(ids),');
    // A reading that a later one overtook answers false itself; the later one's list is the
    // newer, and it decides.
    expect(shared).toContain('reloadInbox: async () => (await sharesInboxStore.load()) || sharesInboxStore.listedNotebookIds() !== null,');
    // What the inbox holds of the notebook once it is read again is declined with it.
    expect(shared).toContain('notesNow: (id) => notesOf(id),');
    expect(shared).toContain('syncNotes: () => { void notesStore.sync(); },');
    expect(shared).not.toMatch(/apiRequest\([^)]*\/dismiss/);
    // The page's one single-share dismissal says "this share and nothing more". The server
    // takes a notebook's share dismissed WITHOUT that as the notebook declined, which is
    // how older pages decline.
    expect(inbox).toContain("apiRequest(`/api/v1/shares/inbox/${shareId}/dismiss?share_only=true`, { method: 'POST' })");
    expect(inbox.match(/\/dismiss/g)).toHaveLength(2);       // the request, and its doc comment
    // The hold hears of every decline (this page's and the server's word), and
    // of the notes the inbox still shares in their own right.
    expect(notes).toContain('...declinedAnd(sharesInboxStore.declinedNotebooks()),');
    expect(notes).toContain('return { declined, stillShared: new Set(sharesInboxStore.sharedNotes().map(s => s.itemId)) };');
  });

  /**
   * What the page knows of notebook items comes from sync pages, and after a
   * reload those are a delta: an untouched notebook is not in it. Going by that
   * alone, a note written into it would go up WITHOUT its notebook (so the
   * server could not keep it from a reader who had declined that notebook), and
   * sharing the notebook would share its notes and NOT the notebook itself (no
   * invitation to answer). Every place that names a notebook to the server asks
   * the server first when the syncs have not said.
   */
  it('a note\'s notebook, and a notebook\'s own share, never depend on what this session\'s syncs happened to mention', () => {
    // Nothing that names a notebook to the server goes by `hasNotebookItem` alone.
    expect(notes).not.toContain('notebooksStore.hasNotebookItem(');
    expect(notes).not.toContain('notebooksStore.learnNotebookItem(');
    // A create and an update ask, and ask once more when there was no answer.
    expect(notes).toContain("let notebookItem = await notebooksStore.notebookItemState(content.notebookId);\n      if (notebookItem === 'unknown') notebookItem = await notebooksStore.notebookItemState(content.notebookId);");
    expect(notes).toContain("let notebookItem = await notebooksStore.notebookItemState(merged.notebook_id);\n      if (notebookItem === 'unknown') notebookItem = await notebooksStore.notebookItemState(merged.notebook_id);");
    expect(notes).toContain("const notebookIdForServer = notebookItem === 'item' ? (content.notebookId ?? null) : null;");
    expect(notes).toContain("...(merged.notebook_id && notebookItem !== 'item'");
    // The re-create after a row was lost goes by the same answer.
    expect(notes).toContain("notebook_id: notebookItem === 'item' ? (merged.notebook_id ?? null) : null,");
    const panel = read('components', 'SharePanel.tsx');
    expect(panel).not.toContain('notebooksStore.hasNotebookItem(');
    // The Share panel: both places go through lib/notebookFirst, which asks the server (twice
    // when there is no answer) and stops on NO ANSWER and on a notebook share that failed,
    // before anything of the notes is shared. Its rule is tested there
    // (notebookFirst.test.ts); here, that the panel asks through it and through nothing else.
    expect(panel.match(/const first = await notebookBeforeItsNotes\(\{/g)).toHaveLength(2);
    expect(panel.match(/askItem: \(\) => notebooksStore\.notebookItemState\(nbId\),/g)).toHaveLength(2);
    expect(panel).not.toContain('notebookItemAsked');
    const reseal = panel.slice(panel.indexOf('const resealAt = async ('));
    expect(reseal.indexOf('const first = await notebookBeforeItsNotes({')).toBeLessThan(reseal.indexOf('await shareOneNote(child'));
    const invite = panel.slice(panel.indexOf("setErrorMsg('This notebook has no notes to share yet.');"));
    expect(invite.indexOf('const first = await notebookBeforeItsNotes({')).toBeGreaterThan(-1);
    expect(invite.indexOf('const first = await notebookBeforeItsNotes({')).toBeLessThan(invite.indexOf('shareOneNote(children[i]'));
    // The words are the ones the invitation panel already uses.
    expect(read('lib', 'notebookFirst.ts')).toContain('export const DID_NOT_GO_THROUGH = "That didn\'t go through. Check your connection and try again.";');
    expect(read('components', 'SharedNotebooks.tsx')).toContain("That didn't go through. Check your connection and try again.");
  });

  /**
   * The notebook's rows this page REFUSES are its rows too: one left standing
   * would keep the notebook on offer and lift the decline's mark.
   */
  it('a decline dismisses the notebook\'s refused rows as well', () => {
    const shared = read('components', 'SharedNotebooks.tsx');
    expect(shared.replace(/\s+/g, ' ')).toContain("const refused = sharesInboxStore.blockedShares() .filter(b => b.itemType === ITEM_TYPE_NOTEBOOK && b.itemId === invite.notebookId) .map(b => b.shareId);");
    expect(shared).toContain('return { notebookId: invite.notebookId, shareIds: [...new Set([...invite.shareIds, ...refused])] };');
    // The same notebook and rows for a decline and for a block pressed on the invitation.
    expect(shared.match(/declined\(invite\), notesOf\(invite\.notebookId\)/g)).toHaveLength(2);
  });

  /**
   * Accepting lifts a decline mark set earlier on the page (it outranks an
   * acceptance, and the notebook just accepted would open empty). The server
   * declines a notebook whole, so a decline that failed took nothing away and
   * Accept stays on offer.
   */
  it('accepting lifts the decline mark, and stays on offer after a decline the server did not take', () => {
    const shared = read('components', 'SharedNotebooks.tsx');
    const accepted = shared.indexOf('await notebooksStore.setNotebookAccepted(invite.notebookId, true);');
    const cleared = shared.indexOf('sharesInboxStore.clearDeclined(invite.notebookId);');
    expect(accepted).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(accepted);
    // A decline is all or nothing on the server, so one that failed took
    // nothing away and there is no half-declined notebook to keep Accept off.
    expect(shared).not.toContain('partDeclined');
    expect(shared.replace(/\s+/g, ' ')).toContain('<div class="notebook-invite-actions"> <button class="btn-primary" disabled={busy() || invite.unreadable} onClick={() => void accept(invite)} > Accept </button>');
  });

  /** A held note is not counted against a label in the sidebar either. */
  it('the sidebar\'s label counts leave held notes out', () => {
    expect(read('components', 'Sidebar.tsx')).toContain('if (n.deleted || notesStore.heldForInvitation(n)) continue;');
  });
});
