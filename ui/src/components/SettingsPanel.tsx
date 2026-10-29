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

import { shellSave, shellSaveAvailable } from '../lib/shellSave';
import { Component, createSignal, onMount, onCleanup, For, Match, Show, Switch } from 'solid-js';
import ExportDialog from './ExportDialog';
import { buildInfo } from '../lib/buildInfo';
import ImportDialog from './ImportDialog';
import { settingsStore, Theme, EditorMode } from '../stores/settings';
import { apiRequest } from '../lib/apiClient';
import { notesStore } from '../stores/notes';
import { notebooksStore } from '../stores/notebooks';
import { remindersStore } from '../stores/reminders';
import { authStore, getBillingUrl, getAccountUrl } from '../stores/auth';
import { sharesInboxStore, type BlockedSender } from '../stores/sharesInbox';
import { BLOCKED_PEOPLE, addressToBlock, blockedListView, inListOrder, listAsKnown, readAfterAction, type BlockedListRead, type Settled } from '../lib/blockedPeople';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, type NoteBackup } from '../lib/backupFormat';
import { sealBackup } from '../lib/backupContainer';
import { decryptWithContentKey, unwrapContentKeyWithVault } from '../lib/crypto';
import { getRetained } from '../lib/retainedKeys';

interface Props {
  onClose: () => void;
}

/** Quota envelope + live usage (GET /api/v1/quota). Mirrors the mobile
 *  clients' usage read; shows free users how close they are to the
 *  note and storage caps. */
interface QuotaUsage {
  tier: string;
  max_notes: number;
  current_notes: number;
  remaining_notes: number;
  max_attachment_bytes: number;
  current_attachment_bytes: number;
  remaining_attachment_bytes: number;
  sharing_enabled: boolean;
  reminders_enabled: boolean;
}

/** Server-side notification preferences (GET/PUT
 *  /api/v1/notifications/preferences). Plain booleans with documented
 *  defaults — push on, email off — so a partial PUT of just the flipped
 *  field is the intended shape. */
interface NotificationPrefs {
  reminders_push: boolean;
  shared_notes_push: boolean;
  email_enabled: boolean;
  reminders_email: boolean;
  shared_notes_email: boolean;
}

const SettingsPanel: Component<Props> = (props) => {
  // Constant for the life of the bundle — read once, not per render.
  const build = buildInfo();
  const [displayName, setDisplayName] = createSignal('');
  const [recoveryEmail, setRecoveryEmail] = createSignal<string | null>(null);
  const [recoveryVerified, setRecoveryVerified] = createSignal(false);
  const [prefs, setPrefs] = createSignal<NotificationPrefs | null>(null);
  const [originalName, setOriginalName] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  // Why a signal and not an alert(): see the shellSave branch in exportData().
  const [exportError, setExportError] = createSignal('');
  // Opt-in: a blank passphrase keeps the readable file, which is what you want
  // when another app has to import it.
  const [backupPassphrase, setBackupPassphrase] = createSignal('');
  // Export and import each open a dialog rather than living inline: a
  // permanent passphrase field in the Data section would ask a question
  // nobody had asked yet, and import would navigate away to a whole page.
  const [exportOpen, setExportOpen] = createSignal(false);
  const [importOpen, setImportOpen] = createSignal(false);
  const [quota, setQuota] = createSignal<QuotaUsage | null>(null);
  // Whether the quota fetch has answered, and how. Until it has, the usage
  // section shows nothing rather than a guess.
  const [quotaState, setQuotaState] = createSignal<'loading' | 'ok' | 'error'>('loading');
  const [blocks, setBlocks] = createSignal<BlockedSender[]>([]);
  const [blocksRead, setBlocksRead] = createSignal<BlockedListRead>('loading');

  /**
   * ONE source for the plan this panel describes: the account's
   * subscriptions, and this is the only place the tier is stated at all.
   * Keying the plan row off the quota fetch's `tier` instead would, while
   * that request is pending or failed, render "Pingolin Note — Free" with
   * an Upgrade button for a paying customer. A missing answer is not a
   * free tier; it is "not loaded yet".
   */
  const isPaid = () => authStore.subscriptionTier() === 'Premium';
  /** The note server caches the tier for up to 30 minutes, so right after a
   *  plan change its quota answer can lag the account. Say so instead of
   *  presenting two tiers at once. */
  const tierSyncing = () => {
    const q = quota();
    if (!q) return false;
    return (q.tier === 'paid') !== isPaid();
  };

  onMount(async () => {
    const result = await apiRequest<any>('/api/v1/auth/me');
    if (result.success) {
      const name = result.data.display_name || '';
      setDisplayName(name);
      setOriginalName(name);
      // Recovery address rides the SAME /auth/me the display name comes from —
      // no extra request — so a browser user, like a phone user, can see
      // whether they have one.
      setRecoveryEmail(result.data.recovery_email ?? null);
      setRecoveryVerified(result.data.recovery_email_verified === true);
    }
    // Notification categories: server-side (they gate pushes to every device),
    // and reachable here as well as from the native screens, so a browser user
    // can turn their own reminder pushes off.
    const np = await apiRequest<NotificationPrefs>('/api/v1/notifications/preferences');
    if (np.success) setPrefs(np.data);
    // Fetch usage for the plan/usage bars, as the Android and iOS apps do.
    const q = await apiRequest<QuotaUsage>('/api/v1/quota');
    if (q.success) { setQuota(q.data); setQuotaState('ok'); } else { setQuotaState('error'); }
    // Blocked senders (for the management section below). A list that could
    // not be read is not an empty one: the section says which it is.
    const listed = await sharesInboxStore.listBlocks();
    if (listed) setBlocks((prev) => listAsKnown(listed, prev, settled));
    setBlocksRead(listed ? 'read' : 'unread');
  });

  /** How many notes are pinned AWAY from the current default. A pin that
   *  happens to equal the default changes nothing the user can see, so
   *  offering to reset it would be offering to fix nothing. */
  const pinnedCount = () => {
    const g = settingsStore.settings().editorMode;
    return Object.values(notebooksStore.editorModes()).filter(m => m !== g).length;
  };

  const resetPins = () => notebooksStore.resetEditorModes();

  /** Device-settings snapshot the shell pushes at document start and
   * re-pushes on resume (the Android app's device-state snapshot). Read
   * into a signal rather than at render, so the `pingolin-device-changed`
   * event that follows a resume updates an OPEN panel: coming back from the
   * native screen is exactly when a value has just changed. Absent in a
   * browser and in shells older than the snapshot; both fall back to the
   * button. */
  interface DeviceRow { id: string; label: string; value: string; section: string }
  const readDeviceRows = (): DeviceRow[] => {
    const d = (window as { __pingolinDevice?: { rows?: DeviceRow[] } }).__pingolinDevice;
    return Array.isArray(d?.rows) ? d!.rows! : [];
  };
  const [deviceRows, setDeviceRows] = createSignal<DeviceRow[]>(readDeviceRows());
  /**
   * The shell tags every row with the native screen it opens, and one of those
   * screens is not about this device at all.
   *
   * `account` rows — account deletion — are about the ACCOUNT, so rendering
   * them under the Device heading would put "delete your account" beneath the
   * sentence "These are set on this device. Changing one opens the app's own
   * settings", which describes app-lock and screenshot preferences. Same rows,
   * same handler, correct heading: `account` goes to the Account section
   * below, everything else stays here.
   */
  const deviceOnlyRows = () => deviceRows().filter(r => r.section !== 'account');
  const accountDeviceRows = () => deviceRows().filter(r => r.section === 'account');
  /** One row, rendered identically wherever its section puts it. */
  const DeviceRowButton = (p: { row: DeviceRow }) => (
    <button class="device-row" onClick={() => openDeviceSettings(p.row.section)}>
      <span class="device-row-label">{p.row.label}</span>
      <span class="device-row-value">{p.row.value}</span>
      <svg class="device-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>
  );
  onMount(() => {
    const onChange = () => setDeviceRows(readDeviceRows());
    window.addEventListener('pingolin-device-changed', onChange);
    onCleanup(() => window.removeEventListener('pingolin-device-changed', onChange));
  });

  /**
   * Flip one notification category.
   *
   * Optimistic, then PUT only the changed field — the server COALESCEs
   * omitted ones, so sending the whole object would write columns the user
   * did not touch. On failure the toggle goes back, because a switch that
   * stays flipped after a failed write is a lie about what the server holds.
   */
  const setPref = async (key: keyof NotificationPrefs, value: boolean) => {
    const before = prefs();
    if (!before) return;
    setPrefs({ ...before, [key]: value });
    const r = await apiRequest('/api/v1/notifications/preferences', {
      method: 'PUT',
      body: { [key]: value },
    });
    if (!r.success) setPrefs(before);
  };

  /** Open the native settings screen, optionally at one section. */
  const openDeviceSettings = (section?: string) => {
    const scheme = (window as { __pingolinShellSettings?: string }).__pingolinShellSettings;
    if (!scheme) return;
    window.location.href = section
      ? `${scheme}://open?section=${encodeURIComponent(section)}`
      : `${scheme}://open`;
  };

  /** The blocks and unblocks the server took on this page: a list read can add
   *  to them and never take one back (lib/blockedPeople `listAsKnown`). */
  const settled = new Map<string, Settled>();
  /** After a block or an unblock the server TOOK: on screen at once, then the list read again. */
  const showTaken = async (address: string, blocked: boolean) => {
    settled.set(address.toLowerCase(), { blocked, address, at: new Date().toISOString() });
    setBlocks((prev) => listAsKnown(null, prev, settled));
    const listed = await sharesInboxStore.listBlocks();
    setBlocks((prev) => listAsKnown(listed, prev, settled));
    setBlocksRead((before) => readAfterAction(before, listed !== null));
  };

  const unblock = async (email: string) => {
    if (await sharesInboxStore.unblockSender(email)) await showTaken(email, false);
  };

  // "Blocked people": an address typed here is blocked like a sender blocked
  // from a note's card. The server keeps the list; it is read again after a
  // block so that the row shown is the row it stored.
  const [blockAddress, setBlockAddress] = createSignal('');
  const [blocking, setBlocking] = createSignal(false);
  const [blockFailed, setBlockFailed] = createSignal(false);
  const addressReady = () => addressToBlock(blockAddress(), blocks());
  const blockTyped = async (e: Event) => {
    e.preventDefault();
    const address = addressReady();
    if (!address || blocking()) return;
    setBlocking(true);
    setBlockFailed(false);
    try {
      // With that person's invitations not answered here: a block declines them.
      if (await sharesInboxStore.blockSender(address, undefined, notesStore.unansweredNotebooksFrom(address))) {
        setBlockAddress('');
        // The server took the block: the address is on the list, whatever the
        // list read back says.
        await showTaken(address, true);
      } else {
        setBlockFailed(true);
      }
    } finally {
      setBlocking(false);
    }
  };

  const formatMb = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
  const pct = (current: number, max: number) =>
    max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;

  const saveDisplayName = async () => {
    if (displayName() === originalName()) return;
    setSaving(true);
    const result = await apiRequest('/api/v1/auth/me', {
      method: 'PATCH',
      body: { display_name: displayName() || null },
    });
    setSaving(false);
    if (result.success) {
      setOriginalName(displayName());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  /**
   * Name the files a backup cannot carry.
   *
   * The bytes stay out (object storage, 100MB a user on the free tier alone),
   * but "3 notes lost their attachments" is not enough to act on — the point of
   * the manifest is to tell someone WHAT to go and find. Filenames live in each
   * attachment's `encrypted_meta`, sealed under the note's content key, so this
   * is a fetch plus a decrypt per note rather than a field we already had.
   *
   * Best-effort per note and per attachment: a note whose list won't load, or a
   * blob whose metadata won't open, contributes `null` rather than failing the
   * export. A backup missing a filename is a smaller loss than no backup.
   */
  const attachmentManifest = async (notes: { id: string }[]) => {
    return Promise.all(notes.map(async (n) => {
      try {
        const res = await apiRequest<any[]>(`/api/v1/items/${n.id}/attachments`);
        if (!res.success || !Array.isArray(res.data)) return { noteId: n.id, filenames: null };

        const key = contentKeyFor(n.id);
        if (!key) return { noteId: n.id, filenames: null };

        // Mirrors AttachmentButton's decrypt, including the owner fallback to
        // retired keys — a blob sealed before a re-key still has its metadata
        // under the old key, and the owner can always open their own.
        let retained: Uint8Array[] | null = null;
        const filenames = res.data.map((att) => {
          try {
            let metaJson = decryptWithContentKey(
              { ciphertext: att.encrypted_meta, nonce: att.meta_nonce }, key, n.id,
            );
            if (!metaJson) {
              if (retained === null) retained = getRetained(n.id);
              for (const rk of retained) {
                metaJson = decryptWithContentKey(
                  { ciphertext: att.encrypted_meta, nonce: att.meta_nonce }, rk, n.id,
                );
                if (metaJson) break;
              }
            }
            if (!metaJson) return null;
            return JSON.parse(metaJson).filename ?? null;
          } catch {
            return null;
          }
        }).filter((f): f is string => typeof f === 'string' && f.length > 0);

        return { noteId: n.id, filenames };
      } catch {
        return { noteId: n.id, filenames: null };
      }
    }));
  };

  /** The note's content key, unwrapped from its vault-wrapped copy. */
  const contentKeyFor = (noteId: string): Uint8Array | null => {
    const note = notesStore.notes().find(n => n.id === noteId);
    if (!note?.wrappedContentKey || !note?.wrappedContentKeyNonce) return null;
    try {
      return unwrapContentKeyWithVault(note.wrappedContentKey, note.wrappedContentKeyNonce);
    } catch {
      return null;
    }
  };

  /**
   * Write a backup this app can read back — see lib/backupFormat.
   *
   * A handful of fields off `NoteItem` is not enough: a checklist note would
   * come out empty (its items live in `checklistItems`, not `body`), every note
   * would come out unfiled (no `notebookId`) and nothing could be matched on
   * re-import (no `id`). This writes the whole note plus the organisation that
   * lives outside notes — notebooks, label colours, editor-mode pins,
   * reminders — and says what it could not bring.
   */
  /** Resolves true when the file reached the user (or the shell took it). */
  const exportData = async (): Promise<boolean> => {
    setExporting(true);
    setExportError('');
    try {
      // `foreignOwner !== true`, not just `!deleted`. The notes store holds the
      // notes somebody has SHARED with you as well as your own — sync returns
      // them, and ingestion stamps `foreignOwner` from the row's user_id — and
      // they must not go into the backup file. That would be another account's
      // note content sitting in a document offered as an export of yours, and
      // restoring it does nothing useful either: the pipeline re-POSTs the
      // original id, and the server leaves an existing id with its real owner.
      //
      // `!== true` rather than `=== false` on purpose: ownership is `undefined`
      // when the app has not yet learned who it is, and dropping YOUR notes on
      // an unknown self would be much worse than keeping a shared one.
      const notes = notesStore.notes().filter(n => !n.deleted && n.foreignOwner !== true);
      const incompleteReasons: string[] = [];

      // Notes this client could not open are not in `notes` at all — the sync
      // loop skips a row it cannot decrypt — so without the count below they
      // would leave the file silently short while `isComplete` covered only
      // attachments. A backup that omits notes without saying so is the one
      // failure this whole envelope exists to prevent.
      const undecryptableNoteIds = [...notesStore.undecryptableIds()].sort();
      const unreadable = undecryptableNoteIds.length;
      if (unreadable > 0) {
        // Says MAY, not WILL. The confident version ("signing in where the key
        // lives … will include them") is wrong whenever no key exists anywhere:
        // notes wrapped under a superseded vault key, with
        // /auth/previous-identities returning an empty list, can never be
        // opened. Telling somebody their notes are retrievable when they are
        // not is worse than saying it is uncertain.
        incompleteReasons.push(
          `${unreadable} note(s) on this account could not be decrypted by this browser and are NOT in this file ` +
          `(their ids are listed under undecryptableNoteIds). The encrypted rows are still on the server. ` +
          `Another device that can still open them, or restoring your data from before a password reset, may be able to export them; ` +
          `if nothing can open them any more, nothing can export them, because only your devices could ever read them.`
        );
      }

      const withAttachments = notes.filter(n => n.hasAttachments);
      if (withAttachments.length > 0) {
        incompleteReasons.push(
          `${withAttachments.length} note(s) have attachments. Backups list attachments but do not contain the files themselves.`
        );
      }

      // Strip the cached recipient keys. They are a wrapping shortcut, and a key
      // that has since rotated wraps future notes for the wrong party — a
      // restore must look recipients up fresh.
      const notebookShares: Record<string, { email: string; permission: 'edit' | 'view' }[]> = {};
      for (const [notebookId, recipients] of Object.entries(notebooksStore.notebookShares())) {
        notebookShares[notebookId] = recipients.map(r => ({ email: r.email, permission: r.permission }));
      }

      const backup: NoteBackup = {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        client: 'web',
        generatedAt: new Date().toISOString(),
        isComplete: incompleteReasons.length === 0,
        ...(incompleteReasons.length > 0 ? { incompleteReasons } : {}),
        ...(undecryptableNoteIds.length > 0 ? { undecryptableNoteIds } : {}),
        counts: {
          notes: notes.length,
          notebooks: notebooksStore.notebooks().length,
          reminders: remindersStore.reminders().length,
          notesWithAttachments: withAttachments.length,
        },
        notebooks: notebooksStore.notebooks().map(nb => ({ id: nb.id, name: nb.name })),
        labelColors: notebooksStore.labelColors(),
        editorModes: notebooksStore.editorModes() as Record<string, string>,
        notebookShares,
        notes: notes.map(n => ({
          id: n.id,
          title: n.title,
          body: n.body,
          noteType: n.noteType,
          color: n.color,
          isPinned: n.isPinned,
          isArchived: n.isArchived,
          labels: n.labels,
          ...(n.checklistItems ? { checklistItems: n.checklistItems } : {}),
          sortOrder: n.sortOrder,
          editMode: n.editMode,
          notebookId: n.notebookId,
          hasAttachments: n.hasAttachments,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
          ...(n.extras ? { extras: n.extras } : {}),
        })),
        reminders: remindersStore.reminders()
          .filter(r => !r.dismissed)
          .map(r => ({ id: r.id, itemId: r.itemId, triggerAt: r.triggerAt, repeatRule: r.repeatRule })),
        attachments: await attachmentManifest(withAttachments),
      };

      // Seal it if the user gave a passphrase. Without one this stays the
      // readable file another app can import.
      const pass = backupPassphrase();
      const body = pass
        ? JSON.stringify(await sealBackup(backup, pass, 'pingolin-note'), null, 2)
        : JSON.stringify(backup, null, 2);
      const exportName = `pingolin-notes-${new Date().toISOString().slice(0, 10)}.json`;
      // In the Android shell, hand the bytes over (blob: anchors are inert in
      // a WebView); in a browser, the anchor download works as usual.
      if (shellSaveAvailable()) {
        const handed = await shellSave(exportName, 'application/json', body);
        if (!handed) {
          // Reported through the dialog that asked for the export, not
          // `alert()`. This branch only runs INSIDE a shell, and a shell is
          // the one place `alert()` cannot work: iOS implements no
          // WKUIDelegate panel method so it is a silent no-op, and Android
          // draws the browser's own `The page at "https://…" says:` box.
          // Returning false keeps the dialog open so the message has
          // somewhere to appear.
          setExportError('This backup is too large to save from the app. Use the web app to export it.');
          return false;
        }
        return true;
      }
      const blob = new Blob([body], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportName;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    } finally {
      setExporting(false);
    }
  };


  const handleBackdrop = (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('settings-overlay')) props.onClose();
  };

  return (
    <div class="settings-overlay" onClick={handleBackdrop}>
      <div class="settings-panel">
        <div class="settings-header">
          <h2>Settings</h2>
          <button class="btn-icon" onClick={props.onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Plan — the subscription lives IN settings on every surface, the
            way track's settings shows it. The CTA follows UpgradePrompt's
            store-policy split exactly: inside a native shell the purchase
            must go through the shell (__pingolinShellUpgrade → the iOS
            StoreKit sheet / Android's read-only explainer — Apple 3.1.1,
            Play anti-steering), while a browser links the web billing page. */}
        <div class="settings-section">
          <h3>Plan</h3>
          <div class="settings-plan-row">
            <span class="settings-plan-name">
              {isPaid() ? 'Pingolin Note — Premium' : 'Pingolin Note — Free'}
            </span>
            <Show
              when={(window as { __pingolinShellUpgrade?: string }).__pingolinShellUpgrade}
              /* Secondary once subscribed: managing an existing plan is
                 housekeeping, and a filled accent button would be the only one in
                 the panel — which reads as "this is the thing to do".
                 Upgrading stays primary, because on the free tier it IS. */
              fallback={
                <a
                  href={getBillingUrl()}
                  class={isPaid() ? 'btn btn-sm btn-secondary' : 'btn btn-sm btn-primary'}
                  target="_blank"
                  rel="noopener"
                >
                  {isPaid() ? 'Manage' : 'Upgrade'}
                </a>
              }
            >
              {/* Paid gets an ⓘ, not a labelled button — the same split Track makes.
                  A labelled "About Premium" button would look like an action on a
                  plan the person already has; an ⓘ reads as "explain this". Free
                  keeps the words, because that IS where someone who has decided to
                  subscribe goes looking. Both open the shell sheet (iOS StoreKit /
                  Android explainer), so the handler is shared. */}
              <button
                class={isPaid() ? 'btn-icon settings-plan-info' : 'btn btn-sm btn-primary'}
                aria-label={isPaid()
                  ? 'About Pingolin Note Premium'
                  : 'Upgrade to Pingolin Note Premium'}
                title={isPaid() ? 'About Pingolin Note Premium' : undefined}
                onClick={() => {
                  const scheme = (window as { __pingolinShellUpgrade?: string }).__pingolinShellUpgrade;
                  if (scheme) window.location.href = `${scheme}://open`;
                }}
              >
                <Show when={isPaid()} fallback={'Upgrade'}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </Show>
              </button>
            </Show>
          </div>
          <p class="settings-check-desc">
            {isPaid()
              ? '10 GB storage, sharing and reminders are active.'
              : 'Premium adds 10 GB storage, sharing and reminders.'}
          </p>
          <Show when={tierSyncing()}>
            <p class="settings-check-desc" data-testid="plan-syncing">
              Your plan changed recently. Note is still catching up, which can take up to 30 minutes; sharing and reminders follow once it has.
            </p>
          </Show>
        </div>

        {/* Account */}
        {/* In the Android shell, device-level settings (app lock, block
            screenshots, theme, push mode) cannot live in this page — the
            shell injects __pingolinShellSettings (a scheme) and intercepts
            a navigation to it by opening the native settings screen. In a
            browser the marker is absent and the row never renders. */}
        <Show when={(window as { __pingolinShellSettings?: string }).__pingolinShellSettings}>
          <div class="settings-section">
            <h3>Device</h3>
            {/* Rows, not one opaque button. The shell pushes each device
                setting with its CURRENT value (window.__pingolinDevice) so
                this reads like settings rather than a door; tapping a row opens
                the native screen AT that section, because every write has to
                stay behind the native prompts — the scheme channel is
                origin-blind and must never be able to switch a protection off.

                Fallback matters: a shell that does not provide the snapshot (an
                older one, or one that failed to inject it) gets the single
                button, rather than an empty section. */}
            <Show
              when={deviceRows().length > 0}
              fallback={
                <>
                  <button class="btn btn-sm btn-secondary" onClick={() => openDeviceSettings()}>
                    App settings
                  </button>
                  <p class="settings-check-desc">App lock, screenshots and notifications for this device.</p>
                </>
              }
            >
              <div class="device-rows">
                <For each={deviceOnlyRows()}>
                  {(r) => <DeviceRowButton row={r} />}
                </For>
              </div>
              <p class="settings-check-desc">
                These are set on this device. Changing one opens the app's own settings.
              </p>
            </Show>
          </div>
        </Show>

        <div class="settings-section">
          <h3>Account</h3>

          {/* Account-scoped native rows (account deletion). Self-gating:
              empty in a browser, because the shell is the only thing that
              pushes them. See deviceOnlyRows/accountDeviceRows above for why
              they are not under Device. */}
          <Show when={accountDeviceRows().length > 0}>
            <div class="device-rows">
              <For each={accountDeviceRows()}>
                {(r) => <DeviceRowButton row={r} />}
              </For>
            </div>
          </Show>

          {/* The long form of the line under the search bar. That one has to
              fit in a header and says only the consequence; this is where the
              rest of it goes — what the password holder can reach, and what
              happens when the account becomes yours. */}
          <Show when={authStore.user()?.guardian_managed}>
            <div class="guardian-managed-notice" role="note">
              <strong>This account is managed by a guardian, who can read these notes.</strong>
              <p>
                Whoever set this account up knows its password, and the password is what
                decrypts your notes — so they can read anything kept here, and nothing tells
                you when they do. The same is true of anything else the account holds.
              </p>
              <p>
                When you turn 18 the account becomes yours. Changing the password does not by
                itself remove their access, because the recovery key and any passkey they
                registered keep working — the steps that do are in Section 6 of the{' '}
                <a href="https://pingolin.com/terms" target="_blank" rel="noopener noreferrer">Terms</a>.
                If asking them is not safe, write to{' '}
                <a href="mailto:abuse@mail.pingolin.com">abuse@mail.pingolin.com</a>.
              </p>
            </div>
          </Show>

          {/* No tier badge beside the address: the Plan section below states the
              tier AND is the only place that can change it, and two statements of
              one fact in one panel, one of them inert, would only compete. */}
          <div class="account-row">
            <div class="account-email-block">
              <label>Email</label>
              <div class="account-email">{authStore.user()?.email ?? '—'}</div>
            </div>
          </div>
          {/* Recovery address: shows a browser user whether they have one — the
              fact that matters most on the day they are locked out. Managing it
              lives on the account portal (this app must never write it: the
              recovery key and the address are one flow, and a half-completed
              change bricks the account), so this states the status and links
              there. */}
          <div class="form-group">
            <label>Recovery email</label>
            <div class="input-row">
              <span class="account-email">
                {recoveryEmail()
                  ? `${recoveryEmail()}${recoveryVerified() ? '' : ' — unverified'}`
                  : 'Not set'}
              </span>
              <a
                class="btn btn-sm btn-secondary"
                href={`${getAccountUrl()}/settings`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {recoveryEmail() ? 'Manage' : 'Add'}
              </a>
            </div>
            <p class="settings-check-desc">
              Where a password reset can reach you if you lose access to {authStore.user()?.email ?? 'your address'}.
            </p>
          </div>
          <div class="form-group">
            <label for="display-name">Display name</label>
            <div class="input-row">
              <input
                id="display-name"
                type="text"
                value={displayName()}
                onInput={(e) => setDisplayName(e.currentTarget.value)}
                placeholder="Your name"
                onBlur={saveDisplayName}
              />
              <Show when={saving()}><span class="save-indicator">Saving...</span></Show>
              <Show when={saved()}><span class="save-indicator" style="color: #27ae60">Saved</span></Show>
            </div>
            <p class="hint-text">Visible to others when sharing. Synced across account, track, and note.</p>
          </div>
        </div>

        {/* Usage — free plan only. Gate on the TIER, not on max_notes: notes are
            uncapped (-1) on both tiers, so a max_notes test would hide the
            storage meter — the one number a free user actually needs. */}
        <Show when={quotaState() === 'error' && !isPaid()}>
          <div class="settings-section">
            <h3>Plan usage</h3>
            <p class="settings-check-desc">Couldn't load your usage. Pull to refresh or try again later.</p>
          </div>
        </Show>
        <Show when={quota() && !isPaid()}>
          <div class="settings-section">
            <h3>Plan usage</h3>
            {/* Only rendered when notes are capped; -1 would read as "3 / -1". */}
            <Show when={quota()!.max_notes >= 0}>
              <div class="usage-item">
                <div class="usage-head">
                  <span class="usage-label">Notes</span>
                  <span class="usage-count">{quota()!.current_notes} / {quota()!.max_notes}</span>
                </div>
                <div class="usage-bar">
                  <div class="usage-bar-fill" style={{ width: `${pct(quota()!.current_notes, quota()!.max_notes)}%` }} />
                </div>
              </div>
            </Show>
            <div class="usage-item">
              <div class="usage-head">
                <span class="usage-label">Storage</span>
                <span class="usage-count">{formatMb(quota()!.current_attachment_bytes)} / {formatMb(quota()!.max_attachment_bytes)}</span>
              </div>
              <div class="usage-bar">
                <div class="usage-bar-fill" style={{ width: `${pct(quota()!.current_attachment_bytes, quota()!.max_attachment_bytes)}%` }} />
              </div>
            </div>
            <p class="hint-text">
              You're on the Free plan — unlimited notes and 100 MB of attachment
              storage. Premium raises storage to 10 GB and adds sharing and reminders.
            </p>
          </div>
        </Show>

        {/* Theme */}
        <div class="settings-section">
          <h3>Appearance</h3>
          <div class="form-group">
            <label>Theme</label>
            <div class="theme-options">
              {(['system', 'light', 'dark'] as Theme[]).map(t => (
                <button
                  class={settingsStore.settings().theme === t ? 'theme-btn active' : 'theme-btn'}
                  onClick={() => settingsStore.setTheme(t)}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Notifications — SERVER-side, so these gate pushes to every device
            the account has, and setting them here is the same as setting them
            on a phone.

            Only the two PUSH categories are here. The API also carries
            email_enabled / reminders_email / shared_notes_email, but the note
            server stores those without sending any email, and a switch that
            changes nothing is worse than an absent one. */}
        <Show when={prefs()}>
          <div class="settings-section">
            <h3>Notifications</h3>
            <label class="settings-check">
              <input
                type="checkbox"
                checked={prefs()!.reminders_push}
                onChange={(e) => setPref('reminders_push', e.currentTarget.checked)}
              />
              <span>
                <span class="settings-check-name">Reminders</span>
                <span class="settings-check-desc">Notify me when a note's reminder is due.</span>
              </span>
            </label>
            <label class="settings-check">
              <input
                type="checkbox"
                checked={prefs()!.shared_notes_push}
                onChange={(e) => setPref('shared_notes_push', e.currentTarget.checked)}
              />
              <span>
                <span class="settings-check-name">Shared notes</span>
                <span class="settings-check-desc">Notify me when someone shares a note with me.</span>
              </span>
            </label>
            <p class="hint-text">These apply to every device signed in to this account.</p>
          </div>
        </Show>

        {/* Editor */}
        <div class="settings-section">
          <h3>Editor</h3>
          <div class="form-group">
            <label>Default edit mode</label>
            <div class="editor-mode-options">
              <button
                class={settingsStore.settings().editorMode === 'hybrid' ? 'mode-option active' : 'mode-option'}
                onClick={() => settingsStore.setEditorMode('hybrid')}
              >
                <span class="mode-option-icon">👁</span>
                <span class="mode-option-name">Hybrid</span>
                <span class="mode-option-desc">Markdown visible on active line, hidden elsewhere</span>
              </button>
              <button
                class={settingsStore.settings().editorMode === 'markdown' ? 'mode-option active' : 'mode-option'}
                onClick={() => settingsStore.setEditorMode('markdown')}
              >
                <span class="mode-option-icon">MD</span>
                <span class="mode-option-name">Markdown</span>
                <span class="mode-option-desc">Raw markdown syntax always visible</span>
              </button>
              <button
                class={settingsStore.settings().editorMode === 'preview' ? 'mode-option active' : 'mode-option'}
                onClick={() => settingsStore.setEditorMode('preview')}
              >
                <span class="mode-option-icon">✦</span>
                <span class="mode-option-name">Preview</span>
                <span class="mode-option-desc">Formatting always rendered, syntax never shown</span>
              </button>
            </div>
            {/* Never says "pin" — Note already has pinned notes (the badge and
                the Pinned grid section), and reusing the word for a per-note
                editor mode would make the reset button below read as if it
                unpinned the user's actual notes. */}
            <p class="hint-text">
              The default for every note. Change the mode while a note is open and
              only that note keeps it; set it back to the default to follow this
              setting again.
            </p>
          </div>
          {/* Sits directly under the mode picker because it QUALIFIES it —
              it only does anything in Preview, and its description refers to
              Preview by name. Below the reset-pinned-notes button, an unrelated
              maintenance action, the mode picker and the toggle that modifies
              it would be separated by something that sometimes is not even
              rendered.

              Shown regardless of the selected mode rather than only under
              Preview: Hybrid and Markdown exist to SHOW you the syntax, so
              suppressing it there would be incoherent, and hiding the setting
              would make it unfindable for someone who has not worked out which
              mode they are in. */}
          <div class="form-group">
            <label class="settings-check">
              <input
                type="checkbox"
                checked={settingsStore.settings().interpretMarkdown}
                onChange={(e) => settingsStore.setInterpretMarkdown(e.currentTarget.checked)}
              />
              <span>
                <span class="settings-check-name">Interpret markdown</span>
                <span class="settings-check-desc">
                  In Preview, turn markdown you type into formatting. Turn this off to
                  write plain text and format with the toolbar instead — a typed
                  <code> # </code> stays a <code>#</code>. Existing formatting still shows either way.
                </span>
              </span>
            </label>
          </div>
          {/* Once a note is pinned there is otherwise no way to FIND it — the
              pin is only visible with that note open — so a user who pinned a
              few and forgot which needs one way back. */}
          <Show when={pinnedCount() > 0}>
            <div class="form-group">
              <button class="btn btn-sm btn-secondary" onClick={resetPins}>
                Reset {pinnedCount()} {pinnedCount() === 1 ? 'note' : 'notes'} to the default mode
              </button>
            </div>
          </Show>
          <div class="form-group">
            <label>Default note size</label>
            <div class="editor-mode-options">
              <button
                class={!settingsStore.settings().alwaysMaximize ? 'mode-option active' : 'mode-option'}
                onClick={() => settingsStore.setAlwaysMaximize(false)}
              >
                <span class="mode-option-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="6" y="6" width="12" height="12" rx="1.5"/>
                  </svg>
                </span>
                <span class="mode-option-name">Compact</span>
                <span class="mode-option-desc">Open as a centered modal with the grid visible behind</span>
              </button>
              <button
                class={settingsStore.settings().alwaysMaximize ? 'mode-option active' : 'mode-option'}
                onClick={() => settingsStore.setAlwaysMaximize(true)}
              >
                <span class="mode-option-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <path d="M9 9h6v6H9z" opacity="0.35"/>
                  </svg>
                </span>
                <span class="mode-option-name">Maximized</span>
                <span class="mode-option-desc">Open full-screen for more room on long notes and lists</span>
              </button>
            </div>
          </div>
        </div>

        {/* Data */}
        <div class="settings-section">
          <h3>Data</h3>
          <div class="settings-buttons">
            <button class="btn btn-sm btn-secondary" onClick={() => setExportOpen(true)}>
              Export my data
            </button>
            {/* A real <button>, not an <a class="btn"> pointing at /import.
                An anchor does not pick up the button box model, so the pair
                would render as two visibly different controls. */}
            <button class="btn btn-sm btn-secondary" onClick={() => setImportOpen(true)}>
              Import notes
            </button>
          </div>
          <p class="hint-text">
            Export writes a backup of your notes, notebooks, labels and reminders.
            Import brings notes in from Google Keep, Evernote, Standard Notes,
            OneNote, Notion, or plain text/Markdown files, and restores a Pingolin
            backup.
          </p>
        </div>

        {/* Blocked people. ALWAYS shown, with a field to add an address, so
            there is somewhere to say "not from this person" before they have
            shared a note. The wording lives in lib/blockedPeople. */}
        <div class="settings-section">
          <h3>{BLOCKED_PEOPLE.title}</h3>
          <p class="hint-text">{BLOCKED_PEOPLE.description}</p>
          <form class="form-group" onSubmit={blockTyped}>
            <label for="block-address">{BLOCKED_PEOPLE.fieldLabel}</label>
            <div class="input-row">
              <input
                id="block-address"
                type="email"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                value={blockAddress()}
                onInput={(e) => { setBlockAddress(e.currentTarget.value); setBlockFailed(false); }}
              />
              <button type="submit" class="btn btn-sm btn-secondary" disabled={!addressReady() || blocking()}>
                {BLOCKED_PEOPLE.block}
              </button>
            </div>
            <Show when={blockFailed()}>
              <p class="hint-text" role="alert">That didn't go through. Check your connection and try again.</p>
            </Show>
          </form>
          <Show when={blocks().length > 0} fallback={
            <Switch>
              <Match when={blockedListView(blocks().length, blocksRead()) === 'nobody'}>
                <p class="hint-text">{BLOCKED_PEOPLE.empty}</p>
              </Match>
              <Match when={blockedListView(blocks().length, blocksRead()) === 'unread'}>
                <p class="hint-text" role="alert">That didn't go through. Check your connection and try again.</p>
              </Match>
            </Switch>
          }>
            <For each={inListOrder(blocks())}>
              {(b) => (
                <div class="blocked-sender-row">
                  <span class="blocked-sender-email" title={b.blocked_email}>{b.blocked_email}</span>
                  <button
                    class="btn btn-sm btn-secondary"
                    aria-label={`${BLOCKED_PEOPLE.unblock} ${b.blocked_email}`}
                    onClick={() => unblock(b.blocked_email)}
                  >
                    {BLOCKED_PEOPLE.unblock}
                  </button>
                </div>
              )}
            </For>
            <p class="hint-text">
              Unblocking lets them share again; it doesn't restore notes you've already dismissed.
            </p>
          </Show>
        </div>

        {/* About — a "Version" and a "Build" row, the same pattern as the
            Track iOS app's settings. Both halves are baked
            into the JavaScript that is actually running, so this row reports
            what you are looking at rather than what the server would hand out
            — the service worker can be serving a bundle several deploys old.
            The full sha is on the `title`, for quoting into git. */}
        <div class="settings-section">
          <h3>About</h3>
          <div class="settings-about-row">
            <span class="settings-about-label">Build</span>
            <span class="settings-about-value" title={build.commit ?? 'not built by CI'}>{build.label}</span>
          </div>
        </div>
      </div>

      <Show when={exportOpen()}>
        <ExportDialog
          exporting={exporting()}
          passphrase={backupPassphrase()}
          onPassphrase={setBackupPassphrase}
          error={exportError()}
          onCancel={() => { setExportError(''); setExportOpen(false); }}
          onExport={async () => {
            // Only close on success — a failure has a message to show, and
            // closing over it would make the shell's export fail silently.
            if (await exportData()) setExportOpen(false);
          }}
        />
      </Show>

      <Show when={importOpen()}>
        <ImportDialog onClose={() => setImportOpen(false)} />
      </Show>
    </div>
  );
};

export default SettingsPanel;
