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

import { Component, Show, createSignal, createEffect, onCleanup, onMount } from 'solid-js';
import { registerBackHandler } from '../lib/backHandlers';

/**
 * The app's own text-entry dialog, used instead of `window.prompt()`.
 *
 * WHY
 *   The one question that needs typed input is the passphrase for a SEALED
 *   backup (`pages/ImportView.tsx`), asked in a retry loop with
 *   `entered === null` read as "cancelled". In a WebView the native prompt is
 *   not a dialog with a rough edge, it is a dead end:
 *
 *   - On iOS the shell implements no `WKUIDelegate` text-input panel, and
 *     WKWebView's documented behaviour with no delegate method is to return
 *     null immediately. So `prompt()` answers null, the loop reads null as
 *     "the user cancelled", and restoring a sealed backup is impossible AND
 *     SILENT — no error, no dialog, the view just goes back to the list.
 *   - On Android it renders as a stock system dialog headed
 *     `The page at "https://…" says:` — the browser's chrome announcing itself
 *     inside the app — and with `password=false`: the
 *     PASSPHRASE IS TYPED IN CLEARTEXT on an ordinary keyboard, legible to
 *     anyone near the screen, which for the key to an encrypted backup is the
 *     one property it must not have.
 *
 *   So this asks the same question in the app's own chrome, with a MASKED
 *   field and a reveal toggle — the pattern the export dialog next door
 *   uses for the same secret.
 *
 * THE SHAPE is `ConfirmDialog`'s, deliberately: a promise, one module-level
 * host mounted in App, and a call site that reads almost exactly like
 * `prompt()` —
 *     const entered = await promptAction({ … });
 *     if (entered === null) …            // cancelled, same as prompt()
 * — so a retry loop around it keeps the shape it would have with `prompt()`.
 * Cancel resolves null rather than never settling, for the same reason as
 * over there: a promise that never resolves strands its caller mid-action
 * forever.
 */
export interface PromptOptions {
  /** The question. */
  message: string;
  /** One line of context: what this is for, and what happens next. */
  detail?: string;
  /** Label for the submitting button. A verb, not "OK". */
  confirmLabel: string;
  /** Placeholder for the empty field. */
  placeholder?: string;
  /**
   * Mask the field and offer a reveal toggle. For anything that is a secret
   * on screen — which is the only reason this component exists.
   */
  secret?: boolean;
}

interface Pending extends PromptOptions {
  resolve: (value: string | null) => void;
  /** What had the keyboard when the question was asked. */
  restoreFocus: HTMLElement | null;
}

const [pending, setPending] = createSignal<Pending | null>(null);

/**
 * Ask for a line of text, and resolve to it — or to null if they cancelled.
 *
 * Resolves null for a cancel, an Escape, a click on the backdrop, and for a
 * request that a second one supersedes.
 */
export function promptAction(opts: PromptOptions): Promise<string | null> {
  const current = pending();
  if (current) current.resolve(null);
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  return new Promise<string | null>((resolve) => {
    setPending({
      ...opts,
      resolve,
      restoreFocus: active instanceof HTMLElement ? active : null,
    });
  });
}

/** Test seam: settle any open request. Not used by the app. */
export function __resetPrompt(): void {
  const current = pending();
  if (current) current.resolve(null);
  setPending(null);
}

export const PromptHost: Component = () => {
  const [value, setValue] = createSignal('');
  const [revealed, setRevealed] = createSignal(false);

  const answer = (result: string | null) => {
    const p = pending();
    if (!p) return;
    setPending(null);
    // Do not leave the secret sitting in a module signal after the dialog is
    // gone — and do not let the next question open pre-filled with it.
    setValue('');
    setRevealed(false);
    p.resolve(result);
    p.restoreFocus?.focus();
  };

  /**
   * Escape cancels, in CAPTURE phase, for exactly the reason ConfirmDialog
   * documents: NotesView and NoteModal both bind Escape on `document`, and
   * `stopPropagation` does nothing between listeners on the same node, so a
   * bubble-phase handler here would cancel the dialog AND close whatever is
   * behind it with one keypress.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!pending()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      answer(null);
    }
  };

  onMount(() => document.addEventListener('keydown', onKeyDown, true));
  onCleanup(() => document.removeEventListener('keydown', onKeyDown, true));

  /** Android hardware back, newest-handler-first, only while open. */
  createEffect(() => {
    if (!pending()) return;
    const unregister = registerBackHandler(() => {
      if (!pending()) return false;
      answer(null);
      return true;
    });
    onCleanup(unregister);
  });

  return (
    <Show when={pending()}>
      {(p) => (
        <div
          class="modal-overlay prompt-overlay"
          onClick={(e) => {
            if ((e.target as HTMLElement).classList.contains('modal-overlay')) answer(null);
          }}
        >
          <div
            class="modal-card prompt-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prompt-dialog-message"
            aria-describedby={p().detail ? 'prompt-dialog-detail' : undefined}
          >
            <div class="modal-header">
              <h2 id="prompt-dialog-message">{p().message}</h2>
              <Show when={p().detail}>
                <p id="prompt-dialog-detail">{p().detail}</p>
              </Show>
            </div>

            <div class="modal-content">
              {/* `dialog-field` for the field's own paint (it is the same
                  input as the export dialog's passphrase box, and the same
                  secret); `prompt-field` only positions the reveal toggle. */}
              <div class="dialog-field prompt-field">
                <input
                  /* Masked unless the person asks to see it. `new-password`
                     rather than `current-password` so a manager does not
                     volunteer the account password for a backup's passphrase,
                     which is a different secret. */
                  type={p().secret && !revealed() ? 'password' : 'text'}
                  autocomplete={p().secret ? 'new-password' : 'off'}
                  placeholder={p().placeholder}
                  value={value()}
                  ref={(el) => queueMicrotask(() => el.focus())}
                  onInput={(e) => setValue(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); answer(value()); } }}
                />
                <Show when={p().secret}>
                  <button
                    type="button"
                    class="prompt-reveal"
                    aria-pressed={revealed()}
                    aria-label={revealed() ? 'Hide passphrase' : 'Show passphrase'}
                    title={revealed() ? 'Hide' : 'Show'}
                    onClick={() => setRevealed(v => !v)}
                  >
                    {revealed() ? 'Hide' : 'Show'}
                  </button>
                </Show>
              </div>
            </div>

            <div class="modal-actions prompt-actions">
              <button
                class="btn btn-sm btn-secondary"
                data-testid="prompt-cancel"
                onClick={() => answer(null)}
              >
                Cancel
              </button>
              <button
                class="btn btn-sm"
                data-testid="prompt-accept"
                onClick={() => answer(value())}
              >
                {p().confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
};

export default PromptHost;
