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

import { Component, createEffect, createMemo, createSignal, on, onMount, Show, For } from 'solid-js';
import { apiRequest } from '../lib/apiClient';
import { notesStore, NoteItem } from '../stores/notes';
import { notebooksStore } from '../stores/notebooks';
import { sharesInboxStore } from '../stores/sharesInbox';
import {
  unwrapContentKeyWithVault,
  wrapContentKeyForRecipient,
  getSharingPublicKeyHex,
  getSigningPublicKeyHex,
  SIGNING_UNAVAILABLE_MESSAGE,
  SIGNING_KEY_MISMATCH_MESSAGE,
  allowSealToRecipient,
  approveUserKeyChange,
  getPinnedUserKeys,
  computeSafetyNumber,
} from '../lib/crypto';
import { rotateContentKey, shareNotebookWithRecipientResult } from '../lib/shareUtils';
import { DID_NOT_GO_THROUGH, notebookBeforeItsNotes, removalDidNotGoThrough, sayStop } from '../lib/notebookFirst';
import { beginOwnerShare } from '../lib/ownerShareInFlight';
import { canSign, signShareWrap } from '../lib/keyOps';
import {
  classifyRecipientKey, keyChangedMessage, lookupDirectoryKeys, readRecipientLookup,
  type DirectoryEntry, type DirectoryKeys, type RecipientKeyStatus,
} from '../lib/recipientKeys';
import { shareHealthStore, type NotReceivingReason } from '../stores/shareHealth';
import { notebookGrantFrom, type NotebookPermission } from '../lib/notebookItem';
import { cancelNotebookRemoval, removeNotebookMember } from '../lib/removeNotebookMember';
import { repairNotebookNow } from '../lib/notebookRepairRun';
import { authStore } from '../stores/auth';
import UpgradePrompt from './UpgradePrompt';

interface ShareInfo {
  id: string;
  recipient_email: string;
  permission: string;
  created_at: string;
  /** Whether the row carries a sealed key. False for a share made before the
   *  recipient had an account. Absent on a server predating the field. */
  has_wrap?: boolean;
}

/** A person's key as the directory publishes it now, and how it compares with
 *  the key pinned for them here. */
interface RowKey {
  status: RecipientKeyStatus;
  dir?: DirectoryKeys;
}

interface Props {
  noteId: string;
  onClose: () => void;
}

const SharePanel: Component<Props> = (props) => {

  // People tab state
  const [email, setEmail] = createSignal('');
  /**
   * What the invitee gets.
   *
   * `contribute` is offered for NOTEBOOKS only — it is a collection-level
   * right ("may add and remove notes"), and there is no collection behind a
   * single note. It implies edit on the notes themselves; a contributor who
   * could add a note but not edit one would be a strange half-member.
   */
  const [permission, setPermission] = createSignal<NotebookPermission>('edit');

  /**
   * What a NOTE share is written with.
   *
   * The server stores a note share's permission as edit-or-view and lets only
   * an exact `'edit'` write, so `contribute` must not reach a note row — it
   * would silently read as "no write". A contributor edits the notes; the
   * collection right rides on the NOTEBOOK's own share.
   */
  /** Share row whose permission is being changed, so its control can disable. */
  const [changingFor, setChangingFor] = createSignal<string | null>(null);

  const notePermission = (): 'edit' | 'view' => permission() === 'view' ? 'view' : 'edit';
  const [shares, setShares] = createSignal<ShareInfo[]>([]);
  const [status, setStatus] = createSignal<'idle' | 'sharing' | 'success' | 'error' | 'upgrade'>('idle');
  const [errorMsg, setErrorMsg] = createSignal('');
  const [progress, setProgress] = createSignal<{ done: number; total: number } | null>(null);

  // Recipients can't share a note further — only the owner can invite
  // more people. `sharesInboxStore.getByItemId` returns an entry when
  // the current user received this note via a share, which means they
  // are NOT the owner.
  const isSharedWithMe = () => sharesInboxStore.getByItemId(props.noteId) !== undefined;

  const notebook = createMemo(() => notebooksStore.getById(props.noteId));
  const notebookChildren = createMemo<NoteItem[]>(() => {
    const nb = notebook();
    if (!nb) return [];
    return notesStore.notes().filter(n => !n.deleted && n.notebookId === nb.id);
  });
  const isNotebook = () => notebook() !== undefined;

  /**
   * Who has access to this NOTEBOOK, and on what terms.
   *
   * Two sources, because a grant is written across two rows in two
   * vocabularies: the child notes carry the item right (`edit`/`view`) and the
   * notebook item carries the collection right (`view`/`contribute`). Reading
   * only the children would make `contribute` display as "Can edit", and
   * because the permission control skips a change that matches what is
   * shown, a contributor could not be demoted.
   *
   * ONE implementation on purpose: this runs on mount and again after every
   * invite, and two copies of it drift.
   */
  const loadNotebookShares = async () => {
    const aggregate = new Map<string, ShareInfo>();
    for (const n of notebookChildren()) {
      const r = await apiRequest<ShareInfo[]>(`/api/v1/items/${n.id}/shares`);
      if (r.success && Array.isArray(r.data)) {
        for (const s of r.data) {
          // Dedupe by recipient_email — show one row per person even if
          // they hold shares on multiple notes in the notebook.
          if (!aggregate.has(s.recipient_email)) aggregate.set(s.recipient_email, s);
        }
      }
    }
    // The notebook item's own rows also carry anyone it was shared with while
    // it held no notes, whom the children alone would never mention.
    const objRes = await apiRequest<ShareInfo[]>(`/api/v1/items/${props.noteId}/shares`);
    const objByEmail = new Map<string, ShareInfo>();
    if (objRes.success && Array.isArray(objRes.data)) {
      for (const s of objRes.data) objByEmail.set(s.recipient_email, s);
    }
    const emails = new Set([...aggregate.keys(), ...objByEmail.keys()]);
    setShares([...emails].map(email => {
      const child = aggregate.get(email);
      const obj = objByEmail.get(email);
      return {
        ...(child ?? obj!),
        permission: notebookGrantFrom(obj?.permission, child?.permission),
      };
    }));
  };

  onMount(async () => {
    // Notebook target: aggregate shares across all child notes so the
    // recipient list shows everyone who has access to ANY note in the set.
    if (isNotebook()) {
      await loadNotebookShares();
      return;
    }
    // Single-note target: existing flow.
    const result = await apiRequest<ShareInfo[]>(`/api/v1/items/${props.noteId}/shares`);
    if (result.success && Array.isArray(result.data)) {
      setShares(result.data);
    }
  });

  /** Wrap the note's per-note content key for the recipient's pubkey and
   *  POST a share row. Returns the error status (undefined on success). */
  const shareOneNote = async (
    note: NoteItem,
    recipientEmail: string,
    recipientPubKey: string | null,
    recipientUserId: string | null,
    recipientSigningKey: string | null,
    perm: 'edit' | 'view',
  ): Promise<{ success: true } | { success: false; status?: number; error: string; keyChanged?: boolean }> => {
    if (!note.wrappedContentKey || !note.wrappedContentKeyNonce) {
      // Legacy note — can't be shared until it's re-saved under a content key.
      return { success: false, error: `"${note.title || 'Untitled'}" needs one save to upgrade before sharing.` };
    }
    let wrappedForRecipient: string | null = null;
    if (recipientPubKey) {
      // Send-side TOFU pin gate: refuse to seal the content key to a
      // directory key that no longer matches the recipient's pinned key — a
      // server key substitution would otherwise let the server read the shared
      // note. The Android app applies the same rule: TOFU-pin on first
      // contact, refuse on an explicit mismatch. Recovery is out-of-band
      // (re-share / safety-number re-approval).
      if (!allowSealToRecipient(recipientUserId, recipientSigningKey, recipientPubKey)) {
        // Not "ask them to re-share": the person whose key changed has nothing
        // to share back. The remedy is here — compare safety numbers, approve
        // the new key.
        return { success: false, keyChanged: true, error: keyChangedMessage(recipientEmail) };
      }
      const contentKey = unwrapContentKeyWithVault(note.wrappedContentKey, note.wrappedContentKeyNonce);
      if (contentKey) {
        wrappedForRecipient = wrapContentKeyForRecipient(contentKey, recipientPubKey);
      }
    }
    // FAIL CLOSED ON THE SEND SIDE. An unsigned wrap is a dead letter: every
    // recipient that already holds a TOFU pin for us drops it (web, android and
    // ios alike), while the sender would be told "Shared" regardless — a share
    // that silently never shows up. So a wrap we cannot sign is not sent at
    // all; the user gets an actionable error instead of a share that never
    // arrives. `ensureSigningKey` first tries to recover a signing key, so this
    // only refuses when the session genuinely has no key material.
    //
    // Only a WRAPPED key needs a signature. A pre-registration invite (the
    // recipient has no account yet, so no key to seal to) carries no wrap,
    // has nothing to sign, and still goes through — the owner re-shares once
    // the recipient signs up and publishes keys.
    let wrapSignature: string | null = null;
    if (wrappedForRecipient) {
      const me = authStore.user();
      if (!recipientUserId || !me?.id || !canSign()) {
        return { success: false, error: SIGNING_UNAVAILABLE_MESSAGE };
      }
      try {
        // lib/keyOps: local key in a browser, the native bridge in the iOS
        // shell (whose signing secret never enters the page).
        wrapSignature = await signShareWrap({
          senderUserId: me.id,
          recipientUserId,
          itemId: note.id,
          // Share-create reuses the note's CURRENT content key, so bind its
          // current generation (base 1 when the field is absent). It must be
          // a real (>=1) generation to keep interactively-shared notes inside
          // the recipient's rollback floor — a hardcoded 0 verifies via the
          // legacy fallback and skips the floor entirely. Must stay in step
          // with shareUtils.ts trySignShareWrap.
          contentKeyVersion: note.contentKeyGeneration ?? 1,
          wrappedKeyBase64: wrappedForRecipient,
        });
      } catch (e) {
        console.warn('[note] signNoteShareWrap failed; refusing to send unsigned:', e);
        return { success: false, error: SIGNING_UNAVAILABLE_MESSAGE };
      }
    }
    const result = await apiRequest(`/api/v1/items/${note.id}/share`, {
      method: 'POST',
      body: {
        email: recipientEmail,
        permission: perm,
        wrapped_key: wrappedForRecipient,
        wrap_signature: wrapSignature,
        sharer_public_key: getSharingPublicKeyHex(),
      },
    });
    if (result.success) return { success: true };
    const err = result as any;
    return { success: false, status: err.status, error: err.error || 'Failed to share' };
  };

  /** Re-read who has access — through the one loader for a notebook (see
   *  loadNotebookShares for why there is only one). */
  const reloadList = async () => {
    // For a notebook `props.noteId` is the notebook item, whose rows carry
    // only the COLLECTION right — reading them alone would report an edit
    // member as "Can view", the same class of mistake in the other
    // direction. Both halves, through the one loader.
    if (isNotebook()) {
      await loadNotebookShares();
    } else {
      const list = await apiRequest<ShareInfo[]>(`/api/v1/items/${props.noteId}/shares`);
      if (list.success) setShares(list.data as ShareInfo[]);
    }
  };

  /** Show why a re-share (`resealAt`) did not happen: the upgrade prompt, or its words. */
  const showWhyNot = (r: { error: string; upgrade?: true }) => {
    if (r.upgrade) { setStatus('upgrade'); return; }
    setStatus('error');
    setErrorMsg(r.error);
  };

  /**
   * Seal this item to `addr` at `next`, under the keys in `entry` — and for a
   * notebook, the notebook object, every note in it, and the standing list
   * that auto-shares FUTURE notes.
   *
   * Re-sharing is how a permission changes (the share upsert overwrites), and
   * it is also how somebody whose key changed gets access back once the owner
   * approved the new key: every row is re-sealed to the key they hold now. ONE
   * implementation for both, so the two cannot drift.
   */
  const resealAt = async (
    addr: string,
    next: NotebookPermission,
    entry: { sharing_public_key: string; user_id: string | null; signing_public_key: string | null },
    /** `lowering`: this takes a right AWAY from someone who holds the notebook (a change to "Can view"). */
    opts: { lowering?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; error: string; upgrade?: true }> => {
    const notePerm: 'edit' | 'view' = next === 'view' ? 'view' : 'edit';

    if (isNotebook()) {
      // Their entry on the standing list is written LAST (below): until then an
      // invitation's finish reads them as gone, and it waits for this share to
      // end before it takes anything back (lib/ownerShareInFlight).
      const endOwnerShare = beginOwnerShare(props.noteId, addr);
      try {
        const nbId = props.noteId;
        // The notebook itself first, and its notes only when that went through:
        // lib/notebookFirst, where the rule and its order are (and are tested).
        const first = await notebookBeforeItsNotes({
          askItem: () => notebooksStore.notebookItemState(nbId),
          endRemoval: () => cancelNotebookRemoval(nbId, addr),
          shareNotebook: () => shareNotebookWithRecipientResult(
            nbId,
            {
              email: addr,
              permission: notePerm,
              publicKey: entry.sharing_public_key,
              userId: entry.user_id,
              signingPublicKey: entry.signing_public_key,
            },
            next,
          ),
          resumeRemoval: () => { void removeNotebookMember(nbId, addr).catch(e => console.warn('[note] could not go on with the removal', e)); },
          repairNotebook: () => repairNotebookNow(nbId),
        });
        if (!first.go) {
          // A right being taken AWAY is taken from the notes all the same.
          // The stop is for a share that would hand out notes with no
          // invitation; this person holds theirs already, and stopping here
          // would leave every note of the notebook writable by someone the
          // owner had just made a reader (the notebook's own row saying
          // "view", its notes "edit").
          if (opts.lowering) {
            for (const child of notebookChildren()) {
              await shareOneNote(child, addr, entry.sharing_public_key, entry.user_id, entry.signing_public_key, 'view');
            }
          }
          const say = sayStop(first.why, addr);
          return say.upgrade ? { ok: false, error: '', upgrade: true } : { ok: false, error: say.error };
        }
        for (const child of notebookChildren()) {
          await shareOneNote(child, addr, entry.sharing_public_key, entry.user_id, entry.signing_public_key, notePerm);
        }
        // The standing list is what auto-shares FUTURE notes, so it has to
        // move with the change. Without this the loop above would re-level
        // every note that exists while the list kept the earlier right, and
        // the next note added to the notebook would go out at it — a demoted
        // viewer would silently keep write access to everything added after
        // the demotion.
        const nb = notebook();
        if (nb) {
          notebooksStore.addNotebookShare(nb.id, {
            email: addr,
            permission: notePerm,
            publicKey: entry.sharing_public_key,
            userId: entry.user_id,
            signingPublicKey: entry.signing_public_key,
          });
        }
        return { ok: true };
      } finally {
        endOwnerShare();
      }
    }

    const note = notesStore.notes().find(n => n.id === props.noteId);
    if (!note) return { ok: false, error: 'Note not found.' };
    const r = await shareOneNote(note, addr, entry.sharing_public_key, entry.user_id, entry.signing_public_key, notePerm);
    if (r.success) return { ok: true };
    // A plan that no longer includes sharing is shown the upgrade prompt here
    // too, as a notebook's change is, and not told to check its connection.
    return r.status === 402 ? { ok: false, error: '', upgrade: true } : { ok: false, error: r.error };
  };

  /**
   * Move somebody between view, edit and (for a notebook) contribute.
   *
   * There is no "change permission" endpoint, and none is needed: the server
   * keys a share on the item and the recipient's address, and sharing again
   * replaces the permission, so re-sharing to the same address with a
   * different right IS the change. Doing it that way also re-seals under the
   * current content key, which keeps a re-share and a permission change from
   * drifting apart.
   *
   * A downgrade is enforced by the server, not by hope: it lets only an exact
   * `edit` permission write, so a demoted editor stops being able to write
   * even though they still hold the content key from before. Taking the KEY
   * away is what removal does, and that is a different action.
   */
  const handleChangePermission = async (share: ShareInfo, next: NotebookPermission) => {
    if (next === share.permission) return;
    setChangingFor(share.id);
    setStatus('sharing');
    setErrorMsg('');
    try {
      const addr = share.recipient_email;
      // Read as every other path reads it (lib/recipientKeys): an answer in no
      // known shape would throw here and leave the row saying "Saving" for good.
      const me = authStore.user();
      const looked = readRecipientLookup(
        await apiRequest<{ users?: DirectoryEntry[] }>('/api/v1/users/public-keys', { method: 'POST', body: { emails: [addr] } }),
        addr,
        me?.email ?? null,
        me?.id ?? null,
      );
      if (!looked.answered) {
        setStatus('error');
        setErrorMsg(DID_NOT_GO_THROUGH);
        return;
      }
      if (!looked.publicKey) {
        setStatus('error');
        setErrorMsg('Couldn\'t look up that person. Try again.');
        return;
      }
      const r = await resealAt(addr, next, {
        sharing_public_key: looked.publicKey,
        user_id: looked.userId,
        signing_public_key: looked.signingPublicKey,
      }, { lowering: next === 'view' && share.permission !== 'view' });
      if (!r.ok) {
        showWhyNot(r);
        return;
      }
      await reloadList();
      setStatus('idle');
    } finally {
      setChangingFor(null);
    }
  };

  // --- Changed keys: the SENDER side ---------------------------------------
  //
  // When the person you share WITH resets their password, every new share to
  // them is refused, and a shared notebook keeps listing them while nothing
  // new reaches them. Each row says when the key the directory publishes
  // differs from the one pinned here, shows the safety number for the NEW
  // key, and approving re-pins and re-seals.

  const [rowKeys, setRowKeys] = createSignal<Record<string, RowKey>>({});
  /** The row (lower-cased email) whose key-change card is open. */
  const [verifying, setVerifying] = createSignal<string | null>(null);
  /** The row whose safety number is showing (any row, changed or not). */
  const [showingNumber, setShowingNumber] = createSignal<string | null>(null);
  const [approving, setApproving] = createSignal(false);
  /** An invite refused because the invitee's key changed — the same card,
   *  shown under the error, so the owner can verify and approve right there. */
  const [inviteKeyChange, setInviteKeyChange] = createSignal<{ email: string; dir: DirectoryKeys } | null>(null);

  const rowKey = (email: string): RowKey | undefined => rowKeys()[email.toLowerCase()];

  const refreshRowKeys = async () => {
    const emails = shares().map(s => s.recipient_email);
    if (emails.length === 0) { setRowKeys({}); return; }
    const dir = await lookupDirectoryKeys(emails);
    // A failed lookup says nothing about anyone's key: keep what we showed.
    if (!dir) return;
    const next: Record<string, RowKey> = {};
    for (const e of emails) {
      const d = dir.get(e.toLowerCase());
      next[e.toLowerCase()] = {
        status: classifyRecipientKey(d ? getPinnedUserKeys(d.userId) : null, d),
        dir: d,
      };
    }
    setRowKeys(next);
  };
  createEffect(on(() => shares().map(s => s.recipient_email).join('\n'), () => { void refreshRowKeys(); }));

  /** 60 digits for `dir`'s keys, or null when this session cannot compute it
   *  (its own public keys are not loaded). */
  const safetyNumberFor = (dir: DirectoryKeys): string | null => {
    const me = authStore.user()?.id;
    if (!me) return null;
    try {
      return computeSafetyNumber(me, dir.userId, dir.sharingPub, dir.signingPub);
    } catch {
      return null;
    }
  };

  /** The person's current grant, for re-sealing at the same right. */
  const grantOf = (email: string): NotebookPermission => {
    const row = shares().find(s => s.recipient_email.toLowerCase() === email.toLowerCase());
    return (row?.permission as NotebookPermission | undefined) ?? permission();
  };

  /**
   * The owner compared safety numbers and trusts the new key: re-pin it, then
   * re-seal everything this person already had to the key they hold NOW —
   * their old key opens nothing for them after a reset. For a notebook that
   * includes the standing list, so notes added later reach them again.
   */
  const approveNewKey = async (email: string, dir: DirectoryKeys, grant: NotebookPermission): Promise<boolean> => {
    setApproving(true);
    setStatus('sharing');
    setErrorMsg('');
    try {
      approveUserKeyChange(dir.userId, dir.sharingPub, dir.signingPub);
      const r = await resealAt(email, grant, {
        sharing_public_key: dir.sharingPub,
        user_id: dir.userId,
        signing_public_key: dir.signingPub,
      });
      if (!r.ok) {
        showWhyNot(r);
        return false;
      }
      if (isNotebook()) shareHealthStore.clear(props.noteId, email);
      setVerifying(null);
      await reloadList();
      await refreshRowKeys();
      // Other notebooks shared with this person were sealed to their old key
      // too; re-derive, so each one says so ("stale-key") instead of looking
      // fixed because the pin now matches.
      void shareHealthStore.refresh().catch(() => {});
      setStatus('idle');
      return true;
    } finally {
      setApproving(false);
    }
  };

  const handleShare = async () => {
    const addr = email().trim();
    if (!addr) return;

    setStatus('sharing');
    setErrorMsg('');
    setProgress(null);
    setInviteKeyChange(null);

    // Look up the recipient's X25519 public key once and reuse it for
    // every note (single note or every child of a notebook). Our OWN entry
    // rides along in the same batch for the signing-key check below.
    const me = authStore.user();
    const myEmail = me?.email ?? null;
    const looked = readRecipientLookup(
      await apiRequest<{ users?: DirectoryEntry[] }>(
        '/api/v1/users/public-keys',
        { method: 'POST', body: { emails: myEmail ? [addr, myEmail] : [addr] } },
      ),
      addr,
      myEmail,
      me?.id ?? null,
    );
    // NO ANSWER is not "no account": stop here, before anything is written.
    // Read as an address with no account, a lookup that merely failed would
    // send the notes with nothing sealed and no invitation.
    if (!looked.answered) {
      setStatus('error');
      setErrorMsg(DID_NOT_GO_THROUGH);
      return;
    }
    const recipientPubKey = looked.publicKey;
    const recipientUserId = looked.userId;
    const recipientSigningKey = looked.signingPublicKey;

    // Will our signature actually verify for the recipient?
    //
    // When the account portal hasn't sealed the real Ed25519 seed into this
    // session, web falls back to deriving one from the X25519 sharing scalar
    // (installSigningKeyFromSharingKey). That derived key only matches the
    // account's PUBLISHED signing key if a mobile login has since POSTed
    // /auth/signing-key/regenerate. Until it does, every wrap we sign is
    // rejected by any recipient who has pinned us: the first share squeaks
    // through on first-use grace, and every one after it is dropped — which
    // looks exactly like the note never being sent.
    //
    // Refuse only on a POSITIVE mismatch. An account with no published key, or
    // no local key yet, falls through. (A lookup that FAILED has stopped the
    // share above: it says nothing about the recipient either.)
    canSign();
    const myLocalSigning = getSigningPublicKeyHex();
    const myPublishedSigning = looked.myPublishedSigning;
    if (
      myLocalSigning && myPublishedSigning &&
      myLocalSigning.toLowerCase() !== myPublishedSigning.toLowerCase()
    ) {
      setStatus('error');
      setErrorMsg(SIGNING_KEY_MISMATCH_MESSAGE);
      return;
    }

    // Somebody whose key changed since this browser pinned it — usually a
    // password reset. Stop BEFORE writing anything (a notebook's roster would
    // otherwise record them under a key nobody approved) and put the verify
    // card right here: the same rule the send gate applies, surfaced where the
    // owner can act on it instead of as "ask them to re-share".
    const pinnedForRecipient = recipientUserId ? getPinnedUserKeys(recipientUserId) : null;
    if (
      pinnedForRecipient && recipientPubKey && recipientUserId && recipientSigningKey &&
      (pinnedForRecipient.conflict ||
        pinnedForRecipient.sharingPubkeyHex.toLowerCase() !== recipientPubKey.toLowerCase())
    ) {
      setStatus('error');
      setErrorMsg(keyChangedMessage(addr));
      setInviteKeyChange({
        email: addr,
        dir: { userId: recipientUserId, sharingPub: recipientPubKey, signingPub: recipientSigningKey },
      });
      return;
    }

    if (isNotebook()) {
      // Their entry on the standing list is written LAST (below): until then an
      // invitation's finish reads them as gone, and it waits for this share to
      // end before it takes anything back (lib/ownerShareInFlight).
      const endOwnerShare = beginOwnerShare(props.noteId, addr);
      try {
        // Notebook target: fan out one share per child note. Children that
        // are still legacy (no wrapped_content_key) are skipped with a
        // per-note error surfaced in the aggregate message.
        const children = notebookChildren();
        if (children.length === 0) {
          setStatus('error');
          setErrorMsg('This notebook has no notes to share yet.');
          return;
        }
        // Share the NOTEBOOK ITSELF first: record the recipient in its roster and
        // seal its content key to them. The roster is what a member reads to seal
        // FUTURE notes to everyone, and the notebook's own share is the invitation
        // the reader answers. Its notes go out only when that went through
        // (lib/notebookFirst, where the rule and its order are, and are tested):
        //
        // - The server is asked whether the notebook exists there as an item (after
        //   a reload this page's syncs are a delta and may not have said). NO
        //   ANSWER is not "no item": the action stops, before anything is shared.
        // - A notebook the server has an item for is shared as an object. When
        //   that was tried and FAILED the action stops too: otherwise every note
        //   would go out and the screen would say "shared", for a reader who then
        //   has loose notes and nothing to answer.
        // - A notebook the server has no item for, or one that cannot be shared as
        //   an object (the address has no account yet), is shared note by note.
        //
        // In this branch props.noteId IS the notebook's id (see `notebook()`).
        const nbId = props.noteId;
        const first = await notebookBeforeItsNotes({
          askItem: () => notebooksStore.notebookItemState(nbId),
          // Someone removed whose removal is still being finished: sharing with
          // them again ends it first, or its next step would undo this share.
          endRemoval: () => cancelNotebookRemoval(nbId, addr),
          shareNotebook: () => shareNotebookWithRecipientResult(
            nbId,
            {
              email: addr,
              // The recipient record drives NOTE auto-sharing, so it carries the
              // note-level right; the collection right is the second argument.
              permission: notePermission(),
              publicKey: recipientPubKey,
              userId: recipientUserId,
              signingPublicKey: recipientSigningKey,
            },
            permission(),
          ),
          resumeRemoval: () => { void removeNotebookMember(nbId, addr).catch(e => console.warn('[note] could not go on with the removal', e)); },
          repairNotebook: () => repairNotebookNow(nbId),
        });
        if (!first.go) {
          // Why, in the words (or the upgrade prompt) a
          // single note's share shows for the same reason.
          const say = sayStop(first.why, addr);
          if (say.upgrade) { setStatus('upgrade'); return; }
          setStatus('error');
          setErrorMsg(say.error);
          return;
        }
        setProgress({ done: 0, total: children.length });
        const failures: string[] = [];
        let upgradeHit = false;
        for (let i = 0; i < children.length; i++) {
          const r = await shareOneNote(children[i], addr, recipientPubKey, recipientUserId, recipientSigningKey, notePermission());
          if (!r.success) {
            if (r.status === 402) { upgradeHit = true; break; }
            failures.push(r.error);
          }
          setProgress({ done: i + 1, total: children.length });
        }
        setProgress(null);
        for (const child of children) notesStore.setLocallyShared(child.id, true);
        if (upgradeHit) { setStatus('upgrade'); return; }
        if (failures.length === children.length) {
          setStatus('error');
          setErrorMsg(failures[0] || 'Failed to share notebook');
          return;
        }
        setStatus('success');
        setEmail('');
        if (failures.length > 0) {
          setErrorMsg(`${failures.length} of ${children.length} notes couldn't be shared (${failures[0]}).`);
        }
        // Record the recipient on the notebook's standing share list so
        // future notes added to this notebook get auto-shared too.
        const nb = notebook();
        if (nb) {
          notebooksStore.addNotebookShare(nb.id, {
            email: addr,
            // Standing recipients are auto-shared FUTURE notes, so this is the
            // note-level right — a contributor edits notes.
            permission: notePermission(),
            publicKey: recipientPubKey,
            userId: recipientUserId,
            signingPublicKey: recipientSigningKey,
          });
        }
        // Refresh the share list — through the same loader as onMount, so what
        // the owner sees a second after inviting matches what they see on
        // reopening, and matches the grant they actually chose.
        await loadNotebookShares();
        setTimeout(() => { setStatus('idle'); setErrorMsg(''); }, 2500);
        return;
      } finally {
        endOwnerShare();
      }
    }

    // Single-note target.
    const note = notesStore.notes().find(n => n.id === props.noteId);
    if (note && !note.wrappedContentKey) {
      setStatus('error');
      setErrorMsg('Edit this note and save once to upgrade it, then share.');
      return;
    }
    if (!note) {
      setStatus('error');
      setErrorMsg('Note not found.');
      return;
    }
    const r = await shareOneNote(note, addr, recipientPubKey, recipientUserId, recipientSigningKey, notePermission());
    if (r.success) {
      setStatus('success');
      setEmail('');
      // `shared_by_me` and `shared_with_count` both ride the sync, and sharing
      // does not bump the note's updated_at — so the incremental pull will not
      // return this note, and neither the badge nor the number behind it would
      // ever move. We just shared it; record that.
      //
      // The count comes from the refreshed roster below rather than the flag
      // alone: "Sharing with N people" has to say the N the server would, and a
      // second recipient leaves `isShared` already true.
      notesStore.setLocallyShared(props.noteId, true);
      const list = await apiRequest<ShareInfo[]>(`/api/v1/items/${props.noteId}/shares`);
      if (list.success) {
        const rows = list.data as ShareInfo[];
        setShares(rows);
        notesStore.setLocallyShared(props.noteId, rows.length > 0, rows.length);
      }
      setTimeout(() => setStatus('idle'), 2000);
    } else if (r.status === 402) {
      setStatus('upgrade');
    } else {
      setStatus('error');
      setErrorMsg(r.error);
    }
  };

  /** For a note shared WITH us: the safety number with its owner, from the
   *  key pinned for them here (what this browser verifies their shares
   *  against). Null when there is no pin to show. */
  const ownerSafetyNumber = createMemo(() => {
    const incoming = sharesInboxStore.getByItemId(props.noteId);
    if (!incoming) return null;
    const pin = getPinnedUserKeys(incoming.ownerId);
    // A conflict holds no keys to show (lib/pinMerge.ts).
    if (!pin || pin.conflict) return null;
    return safetyNumberFor({
      userId: incoming.ownerId,
      sharingPub: pin.sharingPubkeyHex,
      signingPub: pin.signingPubkeyHex,
    });
  });

  /** Is this notebook's standing entry for `email` still on a key the directory
   *  no longer publishes, while the pin already trusts the new one? */
  const staleInThisNotebook = (email: string): boolean =>
    shareHealthStore.notReceiving(props.noteId)
      .some(p => p.email === email.toLowerCase() && p.reason === 'stale-key');

  /** Re-seal this notebook to the (already approved) key they hold now. */
  const updateToNewKey = async (share: ShareInfo) => {
    const dir = rowKey(share.recipient_email)?.dir;
    if (!dir) return;
    setStatus('sharing');
    setErrorMsg('');
    const r = await resealAt(share.recipient_email, share.permission as NotebookPermission, {
      sharing_public_key: dir.sharingPub,
      user_id: dir.userId,
      signing_public_key: dir.signingPub,
    });
    if (!r.ok) {
      showWhyNot(r);
      return;
    }
    shareHealthStore.clear(props.noteId, share.recipient_email);
    await reloadList();
    setStatus('idle');
  };

  /** A row shared before its recipient had an account: seal it to the key they
   *  publish now (first contact, pinned by the send gate as any first share
   *  is), at the permission it already has. */
  const finishSharing = async (share: ShareInfo) => {
    const dir = rowKey(share.recipient_email)?.dir;
    if (!dir) return;
    setStatus('sharing');
    setErrorMsg('');
    const r = await resealAt(share.recipient_email, share.permission as NotebookPermission, {
      sharing_public_key: dir.sharingPub,
      user_id: dir.userId,
      signing_public_key: dir.signingPub,
    });
    if (!r.ok) {
      showWhyNot(r);
      return;
    }
    await reloadList();
    setStatus('idle');
  };

  const handleRemoveShare = async (share: ShareInfo) => {
    if (isNotebook()) {
      // The standing list, the job, the roster and the object, then the
      // re-keying: in that order, see removeNotebookMember.
      await removeNotebookMember(props.noteId, share.recipient_email);
      setShares(prev => prev.filter(s => s.recipient_email !== share.recipient_email));
      return;
    }
    if (status() === 'error') { setStatus('idle'); setErrorMsg(''); }
    const r = await rotateContentKey(props.noteId, [share.id]);
    if (r.rotated) {
      setShares(prev => {
        const left = prev.filter(s => s.id !== share.id);
        // The badge goes when the last recipient does, and the COUNT has to
        // follow every removal in between — the same sync gap means the server
        // will not tell us either way, so "Sharing with 3 people" would survive
        // dropping one of the three.
        notesStore.setLocallyShared(props.noteId, left.length > 0, left.length);
        return left;
      });
    } else {
      // Not taken off: nothing was sent (what the key change needs could not
      // be read, even when asked again; or the new key could not be signed for
      // someone who stays, even tried again), or the server refused it. The
      // person is told — try again later, or contact support — and they stay
      // listed.
      console.warn(`Content-key rotation failed for note ${props.noteId}`);
      setStatus('error');
      setErrorMsg(removalDidNotGoThrough(r));
    }
  };

  return (
    <div class="share-panel">
      <h3>Share</h3>

      <Show when={isSharedWithMe()}>
        <div class="share-readonly-banner">
          This note was shared with you. Only the owner can invite more
          people.
        </div>
        {/* The other half of a safety-number check: the person who shared
            this with you compares these digits with the ones Note shows THEM
            for you. */}
        <Show when={ownerSafetyNumber()}>
          {(num) => (
            <div class="share-security-details">
              <div class="share-list-header">Security details</div>
              <div class="hint-text">
                Your security code with {sharesInboxStore.getByItemId(props.noteId)?.sharerEmail ?? 'the owner'}.
                If they ask, read it to them over a call or in person — it should
                match what they see for you.
              </div>
              <code class="notice-warning-code">{num()}</code>
            </div>
          )}
        </Show>
      </Show>

      <Show when={status() === 'upgrade'}>
        <UpgradePrompt message="Sharing is a Premium feature. Upgrade to invite people." />
      </Show>

      <Show when={status() !== 'upgrade'}>
        <div class="share-invite-section">
          <div class="share-input-row">
            <input
              type="email"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleShare()}
              placeholder="name@example.com"
              disabled={status() === 'sharing'}
            />
            <select
              value={permission()}
              onChange={(e) => setPermission(e.currentTarget.value as NotebookPermission)}
              title={isNotebook()
                ? 'What this person may do in the notebook'
                : 'What this person may do with the note'}
            >
              <Show when={isNotebook()}>
                <option value="contribute">Can add &amp; remove notes</option>
              </Show>
              <option value="edit">Can edit</option>
              <option value="view">Can view</option>
            </select>
            <button
              class="btn btn-sm btn-primary"
              onClick={handleShare}
              disabled={!email().trim() || status() === 'sharing'}
            >
              {status() === 'sharing' ? '...' : 'Invite'}
            </button>
          </div>
          <p class="hint-text">
            <Show when={isNotebook()} fallback={<>They'll need a Pingolin account. If they don't have one yet, share again once they've signed up.</>}>
              Sharing this notebook grants access to {notebookChildren().length} note{notebookChildren().length === 1 ? '' : 's'}, and to notes you add to it later.
            </Show>
          </p>
        </div>

        <Show when={progress()}>
          <div class="share-progress">Sharing {progress()!.done} of {progress()!.total}…</div>
        </Show>
        <Show when={status() === 'error'}>
          <div class="error-message">{errorMsg()}</div>
        </Show>
        <Show when={inviteKeyChange()}>
          {(k) => (
            <VerifyNewKey
              email={k().email}
              number={safetyNumberFor(k().dir)}
              busy={status() === 'sharing'}
              onApprove={() => {
                // Trust the new key, then run the invite again: it now passes
                // the send gate and goes out with the usual progress and
                // bookkeeping.
                approveUserKeyChange(k().dir.userId, k().dir.sharingPub, k().dir.signingPub);
                setInviteKeyChange(null);
                void handleShare();
              }}
              onCancel={() => { setInviteKeyChange(null); setStatus('idle'); setErrorMsg(''); }}
            />
          )}
        </Show>
        {/* Standing recipients a new note in this notebook did not reach. */}
        <Show when={isNotebook() && shareHealthStore.notReceiving(props.noteId).length > 0}>
          <div class="notice-warning notice-warning-static share-not-receiving" role="status">
            <strong>
              {notReceivingHeadline(shareHealthStore.notReceiving(props.noteId).length)}
            </strong>
            <ul>
              <For each={shareHealthStore.notReceiving(props.noteId)}>
                {(p) => <li>{p.email} — {NOT_RECEIVING_WHY[p.reason]}</li>}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={status() === 'success'}>
          <div class="share-success">
            <Show when={isNotebook()} fallback={<>Invite sent</>}>
              Invites sent
            </Show>
          </div>
        </Show>

        {/* Existing shares */}
        <Show when={shares().length > 0}>
          <div class="share-list">
            <div class="share-list-header">People with access</div>
            <For each={shares()}>
              {(share) => {
                const lc = () => share.recipient_email.toLowerCase();
                const key = () => rowKey(share.recipient_email);
                return (
                <div class="share-row-group">
                <div class="share-row">
                  <div class="share-person">
                    <span class="share-avatar">{share.recipient_email[0].toUpperCase()}</span>
                    <div class="share-person-info">
                      <span class="share-email">{share.recipient_email}</span>
                      {/* Changeable, not a label: removing somebody and starting
                          again re-keys the note and makes a demotion look like an
                          eviction. */}
                      <select
                        class="share-perm-select"
                        value={share.permission}
                        disabled={changingFor() !== null}
                        onChange={(e) => void handleChangePermission(
                          share, e.currentTarget.value as NotebookPermission,
                        )}
                        title="Change what this person may do"
                      >
                        <Show when={isNotebook()}>
                          <option value="contribute">Can add &amp; remove notes</option>
                        </Show>
                        <option value="edit">Can edit</option>
                        <option value="view">Can view</option>
                      </select>
                      <div class="share-row-status">
                        <Show when={key()?.status === 'changed'}>
                          <button
                            type="button"
                            class="share-key-flag"
                            aria-expanded={verifying() === lc()}
                            onClick={() => setVerifying(v => (v === lc() ? null : lc()))}
                          >
                            ⚠ Confirm it's them
                          </button>
                        </Show>
                        <Show when={key()?.status === 'no-account'}>
                          <span class="share-key-note">Not signed up yet</span>
                        </Show>
                        {/* Their new key is approved, but THIS notebook's
                            shares were sealed to the old one (approving
                            elsewhere re-seals that notebook only). */}
                        <Show when={isNotebook() && key()?.status === 'matched' && staleInThisNotebook(share.recipient_email)}>
                          <button
                            type="button"
                            class="share-key-flag"
                            disabled={status() === 'sharing'}
                            onClick={() => void updateToNewKey(share)}
                          >
                            Update their access
                          </button>
                        </Show>
                        {/* Shared before they had an account, so the row holds
                            no key; they have one now. */}
                        <Show when={share.has_wrap === false && key()?.dir && key()?.status !== 'changed'}>
                          <button
                            type="button"
                            class="share-key-flag share-key-finish"
                            disabled={status() === 'sharing'}
                            onClick={() => void finishSharing(share)}
                          >
                            Waiting — finish sharing
                          </button>
                        </Show>
                        <Show when={key()?.dir && key()?.status !== 'changed'}>
                          <button
                            type="button"
                            class="share-safety-link"
                            aria-expanded={showingNumber() === lc()}
                            onClick={() => setShowingNumber(v => (v === lc() ? null : lc()))}
                          >
                            Security code
                          </button>
                        </Show>
                      </div>
                    </div>
                  </div>
                  <button class="card-action" onClick={() => handleRemoveShare(share)} title="Remove">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
                <Show when={verifying() === lc() && key()?.dir}>
                  <VerifyNewKey
                    email={share.recipient_email}
                    number={safetyNumberFor(key()!.dir!)}
                    busy={approving()}
                    onApprove={() => void approveNewKey(share.recipient_email, key()!.dir!, grantOf(share.recipient_email))}
                    onCancel={() => setVerifying(null)}
                  />
                </Show>
                <Show when={showingNumber() === lc() && key()?.dir}>
                  <div class="share-safety-number">
                    <code class="notice-warning-code">
                      {safetyNumberFor(key()!.dir!) ?? 'Security code unavailable'}
                    </code>
                    <div class="hint-text">
                      Compare it with the code {share.recipient_email} sees for you,
                      over a call or in person.
                    </div>
                  </div>
                </Show>
                </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      <div class="share-actions">
        <button class="btn btn-sm btn-secondary" onClick={props.onClose}>Done</button>
      </div>
    </div>
  );
};

/** Why a standing recipient is not receiving, in words (see shareHealth). */
const NOT_RECEIVING_WHY: Record<NotReceivingReason, string> = {
  'key-changed': "they may have reset their password. Confirm it's them below.",
  'stale-key': "you confirmed it's them elsewhere, but this notebook hasn't caught up. Choose \"Update their access\" below.",
  'cannot-sign': "this browser can't share right now. Sign in again at the account portal.",
  failed: 'the last attempt failed. It is retried with the next note you add.',
};

function notReceivingHeadline(count: number): string {
  return count === 1
    ? "1 person can't read everything in this notebook."
    : `${count} people can't read everything in this notebook.`;
}

/**
 * The card for approving somebody's changed key: why, the safety number to
 * compare, and the two choices. Approving re-pins the new key and re-seals what
 * they already had to it; "Not now" changes nothing.
 */
function VerifyNewKey(props: {
  email: string;
  number: string | null;
  busy: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <div class="notice-warning notice-warning-static share-verify-card" role="group"
      aria-label={`Confirm it's really ${props.email}`}>
      <div>{keyChangedMessage(props.email)}</div>
      <div class="share-verify-how">
        To be sure, ask {props.email} to read you the security code Note shows them for
        you — over a call or in person, not by message — and check all 60 digits match.
        If you weren't expecting this, don't confirm.
      </div>
      <code class="notice-warning-code">{props.number ?? 'Security code unavailable'}</code>
      <div class="share-verify-actions">
        <button class="btn btn-sm" disabled={props.busy} onClick={props.onApprove}>
          {props.busy ? 'Confirming…' : "It's them"}
        </button>
        <button class="btn btn-sm btn-secondary" disabled={props.busy} onClick={props.onCancel}>
          Not now
        </button>
      </div>
    </div>
  );
}

export default SharePanel;
