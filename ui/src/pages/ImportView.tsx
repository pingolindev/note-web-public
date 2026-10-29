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

import { Component, createSignal, For, Show } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { providerSpecs, sourceForSpec, type ProviderSpec, type AuthMethod } from '../lib/importers/providerSpecs';
import { fileParserFor } from '../lib/importers/parserFactory';
import { ingestProgress } from '../lib/importers/pipeline';
import { readBackupFile, runRestore } from '../lib/importers/restoreBackup';
import { notesStore } from '../stores/notes';
import { renderMarkdown } from '../lib/markdown';
import { sanitizeHtml } from '../lib/sanitizeHtml';
import type { ImportState } from '../lib/importers/types';
import { promptAction } from '../components/PromptDialog';

type View =
  | { kind: 'list' }
  | { kind: 'walkthrough'; spec: ProviderSpec }
  | { kind: 'progress'; state: ImportState }
  | { kind: 'restored'; summary: string; warnings: string[] };

interface ImportViewProps {
  /** Rendered inside a dialog rather than as a route. Suppresses the page
   *  header (the dialog supplies its own title + close) and routes "done"
   *  back to the caller instead of navigating away. */
  embedded?: boolean;
  onClose?: () => void;
}

const ImportView: Component<ImportViewProps> = (props = {}) => {
  const navigate = useNavigate();
  /** Leave the import surface: close the dialog when embedded, otherwise go
   *  back to the notes route. */
  const leave = () => (props.onClose ? props.onClose() : navigate('/'));
  const [view, setView] = createSignal<View>({ kind: 'list' });
  let fileInput: HTMLInputElement | undefined;
  let backupInput: HTMLInputElement | undefined;
  /** Kept only for the duration of one restore, so a re-read after the prompt
   *  does not ask again. Never persisted. */
  let backupPassphrase = '';

  const pickProvider = (spec: ProviderSpec) => setView({ kind: 'walkthrough', spec });
  const cancel = () => setView({ kind: 'list' });

  const pickFile = (spec: ProviderSpec) => {
    const m = spec.auth_method;
    if (m.kind !== 'file_upload' && m.kind !== 'takeout_link') return;
    fileInput!.accept = m.mime_types.join(',');
    fileInput!.click();
  };

  const startImport = async (spec: ProviderSpec) => {
    const m = spec.auth_method;
    if (m.kind === 'file_upload') {
      pickFile(spec);
    } else if (m.kind === 'takeout_link') {
      // ONLY the link. window.open consumes the click's user activation, and
      // Chromium then ignores a programmatic fileInput.click() after it — the
      // picker would silently never appear, and with no other control in the
      // walkthrough the Keep import would be a dead end. The file handoff is its
      // own button (its own activation) below.
      window.open(m.external_url, '_blank', 'noopener,noreferrer');
    } else {
      setView({
        kind: 'progress',
        state: {
          kind: 'error',
          message: `${spec.display_name} import isn't wired up yet — connected-account flows are still pending.`,
        },
      });
    }
  };

  const onFileChosen = async (e: Event) => {
    const target = e.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    const v = view();
    if (v.kind !== 'walkthrough') return;
    const source = sourceForSpec(v.spec);
    if (!source) {
      setView({ kind: 'progress', state: { kind: 'error', message: `No parser for ${v.spec.display_name}` } });
      return;
    }
    const parser = fileParserFor(source);
    if (!parser) {
      setView({ kind: 'progress', state: { kind: 'error', message: `No file parser for ${v.spec.display_name}` } });
      return;
    }
    setView({ kind: 'progress', state: { kind: 'idle' } });
    await ingestProgress(parser(file), (s) => setView({ kind: 'progress', state: s }));
  };

  /**
   * Restore a Pingolin backup. Deliberately NOT one of the providers above:
   * those describe other apps' formats, they are generated from a Rust spec
   * shared with Android, and a restore is a different action anyway — it brings
   * back notebooks, label colours, editor pins and reminders, none of which a
   * foreign import has.
   *
   * Order is metadata → notes → reminders. Notebooks must exist before the notes
   * that reference them or every note lands unfiled, and reminders point at item
   * ids that have to exist first.
   */
  const onBackupChosen = async (e: Event) => {
    const target = e.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    target.value = ''; // let the same file be picked again after a failure
    if (!file) return;

    setView({ kind: 'progress', state: { kind: 'idle' } });

    // A sealed backup needs its passphrase before anything can be read, and the
    // first prompt is not a failure — only report an error once they have tried.
    //
    // Asked through the app's own dialog, not `window.prompt()`. In a WebView
    // the native prompt is not merely ugly: on iOS the shell implements no
    // WKUIDelegate text-input panel, so it returns null immediately, the
    // `=== null` branch below reads that as a cancel, and restoring a sealed
    // backup is impossible and silent. On Android it draws a system box
    // headed `The page at "https://…" says:` with the field UNMASKED (it is not
    // a password field) — the key to an encrypted backup, typed in the clear.
    // See components/PromptDialog.tsx.
    let read = await readBackupFile(file);
    while (!read.ok && read.needsPassphrase) {
      const retry = read.error.includes('did not open');
      const entered = await promptAction({
        message: retry
          ? 'That passphrase did not open the backup. Try again:'
          : 'This backup is encrypted. Enter its passphrase:',
        detail: retry
          ? undefined
          : 'The passphrase you chose when the backup was exported. Nothing in it can be read without it.',
        confirmLabel: 'Open backup',
        placeholder: 'Passphrase',
        secret: true,
      });
      if (entered === null) {
        setView({ kind: 'list' }); // cancelled
        return;
      }
      read = await readBackupFile(file, entered);
      backupPassphrase = entered;
    }
    if (!read.ok) {
      setView({ kind: 'progress', state: { kind: 'error', message: read.error } });
      return;
    }
    const backup = read.backup;

    // Notebooks with their items, the metadata, the notes, then what the file
    // keys by note: see runRestore.
    const result = await runRestore(backup, (state) => setView({ kind: 'progress', state }));
    if (!result) return; // ingestProgress already reported it
    setView({ kind: 'restored', summary: result.summary, warnings: result.warnings });
  };

  const fileProviders = () => providerSpecs.filter((p) => p.section === 'file');
  const connectProviders = () => providerSpecs.filter((p) => p.section === 'connect');

  return (
    <div class={props.embedded ? "import-view import-view-embedded" : "import-view"}>
      <Show when={!props.embedded}>
        <header class="import-header">
          <button class="btn btn-link" onClick={leave}>&larr; Notes</button>
          {/* Sentence case, matching the Settings button that opens it and the
              dialog heading: "Import notes". */}
          <h1>Import notes</h1>
        </header>
      </Show>

      <Show when={view().kind === 'list'}>
        <section class="import-section">
          <h2>From a file</h2>
          <p class="muted">Import notes you&rsquo;ve already exported</p>
          <For each={fileProviders()}>{(spec) =>
            <ProviderCard spec={spec} onSelect={() => pickProvider(spec)} />
          }</For>
        </section>

        {/* Connected-account section for OAuth-backed providers. The header
            is suppressed when there are no providers so users don't see a
            stranded "Connect" header. */}
        <Show when={connectProviders().length > 0}>
          <section class="import-section">
            <h2>Connect an account</h2>
            <p class="muted">Sign in and import directly from the provider</p>
            <For each={connectProviders()}>{(spec) =>
              <ProviderCard spec={spec} onSelect={() => pickProvider(spec)} />
            }</For>
          </section>
        </Show>

        <section class="import-section">
          <h2>Restore a backup</h2>
          <p class="muted">
            Bring back a backup you made from Pingolin, with your notebooks, labels
            and reminders. Restoring only adds — nothing already here is changed or
            removed, and restoring the same file twice is safe.
          </p>
          <button class="btn btn-secondary" onClick={() => backupInput!.click()}>
            Choose a backup file
          </button>
        </section>
      </Show>

      <Show when={view().kind === 'restored' ? (view() as Extract<View, { kind: 'restored' }>) : null}>
        {(done) => (
          <section class="import-progress">
            <h2>Restored</h2>
            <p>{done().summary}</p>
            <Show when={done().warnings.length > 0}>
              <ul class="muted">
                <For each={done().warnings}>{(w) => <li>{w}</li>}</For>
              </ul>
            </Show>
            <button class="btn btn-primary" onClick={leave}>
              {props.embedded ? 'Done' : 'Back to notes'}
            </button>
          </section>
        )}
      </Show>

      <Show when={view().kind === 'walkthrough' ? (view() as Extract<View, { kind: 'walkthrough' }>) : null}>
        {(walk) => {
          const spec = walk().spec;
          return (
            <section class="import-walkthrough">
              <div class="walkthrough-header">
                <span class="walkthrough-icon" style={{ background: spec.brand_color }} />
                <h2>{spec.display_name}</h2>
              </div>
              <div class="walkthrough-instructions" innerHTML={sanitizeHtml(renderMarkdown(spec.instructions_markdown))} />
              <Show when={spec.caveats.length > 0}>
                <div class="walkthrough-caveats">
                  <strong>Things to know</strong>
                  <ul>
                    <For each={spec.caveats}>{(c) => <li>{c}</li>}</For>
                  </ul>
                </div>
              </Show>
              <div class="walkthrough-actions">
                <button class="btn btn-primary" onClick={() => startImport(spec)}>
                  {ctaLabel(spec.auth_method, spec.display_name)}
                </button>
                <Show when={spec.auth_method.kind === 'takeout_link'}>
                  <button class="btn btn-secondary" onClick={() => pickFile(spec)}>
                    Pick the downloaded file…
                  </button>
                </Show>
                <button class="btn btn-link" onClick={cancel}>Cancel</button>
              </div>
            </section>
          );
        }}
      </Show>

      {/* `keyed` is load-bearing: a non-keyed Show re-runs its function child
          only when `when` FLIPS truthiness, and after the first 'idle' every
          state transition keeps it truthy — so the child's snapshot would freeze
          at "Starting…" while the pipeline imports everything behind it, and users
          would retry "stuck" imports and stack duplicates. (Restore is not
          affected: it moves to kind 'restored', which flips the Show.) */}
      <Show keyed when={view().kind === 'progress' ? (view() as Extract<View, { kind: 'progress' }>) : null}>
        {(prog) => {
          const s = prog.state;
          return (
            <section class="import-progress">
              {s.kind === 'idle' && <p>Starting…</p>}
              {s.kind === 'importing' && (
                <>
                  <p><strong>Importing {s.current} notes…</strong></p>
                  {s.currentTitle && <p class="muted">{s.currentTitle}</p>}
                </>
              )}
              {s.kind === 'complete' && (
                <>
                  <p>Imported {s.count} notes.</p>
                  <button class="btn btn-primary" onClick={cancel}>Done</button>
                </>
              )}
              {s.kind === 'error' && (
                <>
                  <p class="error">{s.message}</p>
                  <button class="btn" onClick={cancel}>Back</button>
                </>
              )}
            </section>
          );
        }}
      </Show>

      <input
        ref={fileInput}
        type="file"
        style={{ display: 'none' }}
        onChange={onFileChosen}
      />
      {/* Separate input from the provider one: that one's `accept` is rewritten
          per provider, and a restore always wants JSON. */}
      <input
        ref={backupInput}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={onBackupChosen}
      />
    </div>
  );
};

const ProviderCard: Component<{ spec: ProviderSpec; onSelect: () => void }> = (props) => (
  <button
    class="provider-card"
    style={{ '--brand': props.spec.brand_color }}
    onClick={props.onSelect}
  >
    <span class="provider-card-icon" />
    <span class="provider-card-text">
      <strong>{props.spec.display_name}</strong>
      <small>{authLabel(props.spec.auth_method)}</small>
    </span>
    <span class="provider-card-chevron">&rsaquo;</span>
  </button>
);

function authLabel(m: AuthMethod): string {
  switch (m.kind) {
    case 'file_upload':   return 'Pick a file';
    case 'takeout_link':  return 'Via Google Takeout';
    case 'o_auth2_pkce':  return 'Sign in to connect';
    case 'credentials':   return 'Sign in to connect';
  }
}

function ctaLabel(m: AuthMethod, displayName: string): string {
  switch (m.kind) {
    case 'file_upload':   return 'Pick a file';
    case 'takeout_link':  return 'Open Google Takeout';
    case 'o_auth2_pkce':  return `Sign in to ${displayName}`;
    case 'credentials':   return 'Connect';
  }
}

export default ImportView;
