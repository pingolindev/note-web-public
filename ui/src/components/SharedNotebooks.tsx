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

import { Component, For, Show, createMemo, createSignal } from 'solid-js';
import { apiRequest } from '../lib/apiClient';
import { sharesInboxStore } from '../stores/sharesInbox';
import { notebooksStore } from '../stores/notebooks';
import { notesStore } from '../stores/notes';
import { blockFromInvitation, declineNotebook, type DeclineSteps } from '../lib/declineInvitation';
import { confirmAction } from './ConfirmDialog';
import { BLOCKED_PEOPLE, isFrom } from '../lib/blockedPeople';
import { ITEM_TYPE_NOTEBOOK } from '../lib/notebookItem';
import {
  displayName, inviteGrantText, invitesFrom, type NotebookInvite,
} from '../lib/notebookInvites';
import { noteIsInNotebook } from '../lib/notebookId';

interface Props {
  selectedNotebook: string | null;
  onSelect: (notebookId: string) => void;
}

/**
 * The "Shared Notebooks" section: notebooks other people have shared with this
 * user.
 *
 * A shared notebook arrives as an INVITATION rather than simply appearing.
 * Being added to one is being enrolled in a place its owner keeps putting
 * notes in — and that you may later be able to add notes to yourself — which
 * is not something to happen silently because somebody typed an address.
 *
 * So a pending notebook shows its name and who sent it, and clicking it asks.
 * Accepting files it under this section like any other notebook. Declining
 * is one request the server carries out whole: the notebook's share and every
 * note in it are dismissed together, and a note its owner adds later never
 * arrives — after a decline, nothing from that share shows up. The owner is
 * not told, and can invite again by removing the reader and adding them back.
 */
const SharedNotebooks: Component<Props> = (props) => {
  const [deciding, setDeciding] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);

  // ---- Article 16 DSA: notice and action ---------------------------------
  // The control lives beside Accept and Decline because this is the moment a
  // recipient is deciding about a share, and reporting is the third thing they
  // might want to do with it. Article 16 attaches to being a hosting service
  // rather than to publishing, so it applies although notes are shared only
  // with named people: the person a note was shared with is the only one who
  // can encounter a note they did not write.
  const [reporting, setReporting] = createSignal<string | null>(null);
  const [reason, setReason] = createSignal('');
  const [reportEmail, setReportEmail] = createSignal('');
  const [goodFaith, setGoodFaith] = createSignal(false);
  const [reportError, setReportError] = createSignal<string | null>(null);
  const [reference, setReference] = createSignal<string | null>(null);

  // Article 16(2)(a) wants a substantiated explanation and 16(2)(d) the
  // good-faith statement. Both are gated here as well as on the server so the
  // reporter learns what is missing while they are still looking at the form.
  const canReport = () => reason().trim().length >= 20 && goodFaith() && !busy();

  const resetReport = () => {
    setReporting(null);
    setReason('');
    setReportEmail('');
    setGoodFaith(false);
    setReportError(null);
  };

  const submitReport = async (invite: NotebookInvite) => {
    if (!canReport()) return;
    setBusy(true);
    setReportError(null);
    const res = await apiRequest<{ reference: string }>(
      `/api/v1/shares/inbox/${invite.shareId}/report`,
      {
        method: 'POST',
        body: {
          reason: reason().trim(),
          reporter_email: reportEmail().trim() || null,
          good_faith: goodFaith(),
        },
      },
    );
    setBusy(false);
    if (res.success) {
      setReference(res.data.reference);
      setReporting(null);
    } else {
      setReportError(res.error || 'Could not send the report. Please email abuse@mail.pingolin.com.');
    }
  };

  const invites = createMemo<NotebookInvite[]>(() =>
    invitesFrom(
      // `permission` on IncomingShare is narrowed to edit|view; the collection
      // right lives in the verbatim value.
      sharesInboxStore.sharedNotebooks().map(s => ({ ...s, permission: s.sharePermission })),
      notebooksStore.acceptedNotebooks(),
    ));

  /** Notes that came with a notebook, so declining takes them too. */
  const notesIn = (notebookId: string) =>
    sharesInboxStore.sharedNotes()
      .filter(s => s.note && noteIsInNotebook(s.note, notebookId));

  const accept = async (invite: NotebookInvite) => {
    setBusy(true);
    setFailed(null);
    try {
      await notebooksStore.setNotebookAccepted(invite.notebookId, true);
      // A "no" pressed here earlier that the server did not take no longer
      // stands: its mark outranks an acceptance, and left in place the
      // notebook just accepted would open empty.
      sharesInboxStore.clearDeclined(invite.notebookId);
      setDeciding(null);
    } catch {
      setFailed(invite.notebookId);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Block the person who sent this invitation: everything they shared with
   * the reader goes, and nothing more of theirs arrives (the server dismisses
   * it all and writes their later shares dismissed; they are not told).
   *
   * This is the way to say "not from this person" about an invitation:
   * declining alone would let its owner remove and invite the reader again,
   * and they would be asked again.
   */
  const block = async (invite: NotebookInvite) => {
    const email = invite.sharerEmail;
    if (!email) return;
    // The same question a note's card asks before a block, word for word
    // (NotesView `handleBlock`; kept the same by lib/blockedPeople.test).
    if (!(await confirmAction({
      message: `Block ${email}?`,
      detail: "Their shared notes will be removed from your inbox and you won't receive future shares from them. You can unblock them later in Settings.",
      confirmLabel: 'Block sender',
      destructive: true,
    }))) return;
    setBusy(true);
    setFailed(null);
    try {
      // A block pressed on an invitation is a "no" to the invitation too: the
      // notebook is DECLINED with it, in the same request. Every step and its
      // order is lib/declineInvitation (`blockFromInvitation`), where each has
      // a test.
      await blockFromInvitation(declined(invite), notesOf(invite.notebookId), email, {
        ...declineSteps(),
        // With the sender's OTHER invitations not answered here: declined too.
        block: (address, declining) => sharesInboxStore.blockSender(address, declining, notesStore.unansweredNotebooksFrom(address)),
        blockOnly: (address) => sharesInboxStore.blockSender(address, undefined, notesStore.unansweredNotebooksFrom(address)),
        theirNotes: () => sharesInboxStore.sharedNotes().filter(s => isFrom(s.sharerEmail, email)).map(s => s.itemId),
      });
      setDeciding(null);
    } catch {
      setFailed(invite.notebookId);
    } finally {
      setBusy(false);
    }
  };

  /** What a decline of this invitation covers: the notebook and its own shares. */
  const declined = (invite: NotebookInvite) => {
    // The notebook's rows this page REFUSES to open are its rows too (a
    // sender's key change not yet approved). The server dismisses every row
    // of the notebook that is addressed to this account; they are named so
    // that the mark below knows them for dismissed, and an older answer
    // still carrying one does not read as a new offer.
    const refused = sharesInboxStore.blockedShares()
      .filter(b => b.itemType === ITEM_TYPE_NOTEBOOK && b.itemId === invite.notebookId)
      .map(b => b.shareId);
    return { notebookId: invite.notebookId, shareIds: [...new Set([...invite.shareIds, ...refused])] };
  };

  const notesOf = (notebookId: string) => notesIn(notebookId).map(s => ({ shareId: s.shareId, noteId: s.itemId }));

  /** The steps of a decline (lib/declineInvitation), as this page takes them. */
  const declineSteps = (): DeclineSteps => ({
    markDeclined: (id, shareIds) => sharesInboxStore.markDeclined(id, shareIds),
    unmarkDeclined: (id) => sharesInboxStore.clearDeclined(id),
    decline: (id, shareIds) => sharesInboxStore.declineNotebook(id, shareIds),
    forgetAcceptance: (id) => notebooksStore.setNotebookAccepted(id, false),
    forgetNotes: (ids) => notesStore.dropReceived(ids),
    // True when the store holds a list read to its end: from this
    // reading, or from a later one that overtook it (which answers
    // false itself, and whose list is the newer). A list from BEFORE
    // the decline still offers the notebook, so it can only say
    // "not done".
    reloadInbox: async () => (await sharesInboxStore.load()) || sharesInboxStore.listedNotebookIds() !== null,
    // No list is "still on offer": only a list can say the decline went through.
    isOffered: (id) => sharesInboxStore.listedNotebookIds()?.has(id) ?? true,
    notesNow: (id) => notesOf(id),
    syncNotes: () => { void notesStore.sync(); },
  });

  /**
   * Decline: the notebook's own share AND the shares of the notes that came
   * inside it, in one request.
   *
   * Dismissing only the collection object would leave its notes sitting in
   * "Shared with me" — the recipient would have said no to the notebook and
   * kept its contents, which is not what declining means. Dismissal is the
   * recipient's own view; it does not touch the owner's copy, and the owner
   * can invite again.
   */
  const decline = async (invite: NotebookInvite) => {
    setBusy(true);
    setFailed(null);
    try {
      // Every step and its order is lib/declineInvitation, where each has a
      // test: marked first, ONE request the server carries out whole, and the
      // acceptance forgotten only once the server has taken the "no".
      await declineNotebook(declined(invite), notesOf(invite.notebookId), declineSteps());
      setDeciding(null);
    } catch {
      setFailed(invite.notebookId);
    } finally {
      setBusy(false);
    }
  };

  const noteCount = (notebookId: string) =>
    notesStore.notes().filter(n => !n.deleted && noteIsInNotebook(n, notebookId)).length;

  return (
    <Show when={invites().length > 0}>
      <div class="sidebar-section">
        <div class="sidebar-section-header">
          <span>Shared Notebooks</span>
        </div>

        <For each={invites()}>
          {(invite) => (
            <>
              <div
                class={props.selectedNotebook === invite.notebookId
                  ? 'sidebar-item active' : 'sidebar-item'}
                onClick={() => {
                  if (invite.accepted) props.onSelect(invite.notebookId);
                  else setDeciding(deciding() === invite.notebookId ? null : invite.notebookId);
                }}
                title={invite.accepted
                  ? `Shared by ${invite.sharer}`
                  : `${invite.sharer} wants to share this notebook with you`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
                <span class="sidebar-item-name">{displayName(invite)}</span>
                <div class="sidebar-item-right">
                  <Show when={invite.accepted} fallback={
                    <span class="sidebar-item-count sidebar-item-unread" title="Awaiting your answer">
                      new
                    </span>
                  }>
                    <span class="sidebar-item-count">{noteCount(invite.notebookId)}</span>
                  </Show>
                </div>
              </div>

              <Show when={deciding() === invite.notebookId}>
                <div class="notebook-invite">
                  <p class="notebook-invite-text">
                    <strong>{invite.sharer}</strong> shared{' '}
                    <strong>{displayName(invite)}</strong> with you.
                  </p>
                  <Show when={invite.unreadable} fallback={
                    <p class="notebook-invite-text">{inviteGrantText(invite)}</p>
                  }>
                    <p class="notebook-invite-warning">{inviteGrantText(invite)}</p>
                  </Show>
                  <Show when={failed() === invite.notebookId}>
                    <p class="notebook-invite-warning">
                      That didn't go through. Check your connection and try again.
                    </p>
                  </Show>
                  <div class="notebook-invite-actions">
                    <button
                      class="btn-primary"
                      disabled={busy() || invite.unreadable}
                      onClick={() => void accept(invite)}
                    >
                      Accept
                    </button>
                    <button
                      class="btn-secondary"
                      disabled={busy()}
                      onClick={() => void decline(invite)}
                    >
                      Decline
                    </button>
                    <Show when={invite.sharerEmail}>
                      <button
                        class="btn-secondary"
                        disabled={busy()}
                        title={`${BLOCKED_PEOPLE.block} ${invite.sharerEmail}`}
                        aria-label={`${BLOCKED_PEOPLE.block} ${invite.sharerEmail}`}
                        onClick={() => void block(invite)}
                      >
                        {BLOCKED_PEOPLE.block}
                      </button>
                    </Show>
                  </div>

                  <section class="share-report">
                    <Show when={reference()}>
                      {(ref) => (
                        <div class="share-report-done" role="status">
                          <p><strong>Report received.</strong> Your reference is <code>{ref()}</code>.</p>
                          <p>
                            We cannot read what was shared with you, so we are not judging its
                            contents - we decide what to do about the account. If you gave us an
                            email address we will tell you what we decided and how to challenge it.
                          </p>
                        </div>
                      )}
                    </Show>

                    <Show when={!reference() && reporting() !== invite.notebookId}>
                      <button
                        type="button"
                        class="share-report-open"
                        onClick={() => setReporting(invite.notebookId)}
                      >
                        Report this as unlawful
                      </button>
                    </Show>

                    <Show when={reporting() === invite.notebookId}>
                      <form
                        class="share-report-form"
                        onSubmit={(e) => { e.preventDefault(); void submitReport(invite); }}
                      >
                        <label>
                          <span>Why do you believe this is unlawful?</span>
                          <textarea
                            rows="3"
                            value={reason()}
                            onInput={(e) => setReason(e.currentTarget.value)}
                            placeholder="Tell us what is wrong with it, in enough detail that we can weigh it."
                            required
                          />
                        </label>

                        {/* Article 16(2)(c) exempts reports concerning offences
                            against a child from naming the reporter. We know who
                            you are because you are signed in, but the address is
                            how we write back, and somebody in that position must
                            be able to withhold it without withholding the
                            report. */}
                        <p class="share-report-note">
                          An email address is how we write back. You may leave it out - your report
                          still counts - and you should leave it out if this concerns an offence
                          against a child. Without it we cannot tell you what we decided.
                        </p>

                        <label>
                          <span>Email for our reply (optional)</span>
                          <input
                            type="email"
                            value={reportEmail()}
                            onInput={(e) => setReportEmail(e.currentTarget.value)}
                            autocomplete="email"
                          />
                        </label>

                        <label class="share-report-check">
                          <input
                            type="checkbox"
                            checked={goodFaith()}
                            onChange={(e) => setGoodFaith(e.currentTarget.checked)}
                          />
                          <span>
                            I believe in good faith that what I have told you here is accurate and
                            complete.
                          </span>
                        </label>

                        <Show when={reportError()}>
                          <p class="share-report-error" role="alert">{reportError()}</p>
                        </Show>

                        <div class="share-report-actions">
                          <button type="button" onClick={resetReport} disabled={busy()}>
                            Cancel
                          </button>
                          <button type="submit" disabled={!canReport()}>
                            {busy() ? 'Sending…' : 'Send report'}
                          </button>
                        </div>
                      </form>
                    </Show>
                  </section>
                </div>
              </Show>
            </>
          )}
        </For>
      </div>
    </Show>
  );
};

export default SharedNotebooks;
