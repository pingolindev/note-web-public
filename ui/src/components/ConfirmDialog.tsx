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
 * The app's own confirmation dialog, used instead of `window.confirm()`.
 *
 * WHY
 *   Eight destructive actions ask their question through it: moving a
 *   selection to Trash, deleting a selection forever, deleting one note
 *   forever, moving the open note to trash, deleting a notebook, removing a
 *   label from every note, deleting an attachment, and blocking a sender. A
 *   native dialog cannot be themed (it renders in the OS's light chrome over
 *   a dark app), cannot say anything beyond one line, and cannot distinguish
 *   "this is reversible" from "this is not" — which is exactly the
 *   distinction that matters when the button destroys data.
 *
 * THE SHAPE
 *   A promise, so a call site reads
 *       if (!(await confirmAction({ … }))) return;
 *   exactly where a native dialog would read
 *       if (!confirm('…')) return;
 *   Every one of the eight has the confirm as its first statement, so there
 *   is no window in which a cancel can leave half-finished work: the early
 *   return happens before anything is written.
 *
 *   `<ConfirmHost />` mounts once, in App. Rendering the dialog from a module
 *   signal rather than from each caller is what keeps the call sites to one
 *   line and means a dialog opened from inside the note modal is not trapped
 *   inside it.
 *
 * THE WORDING is the caller's. `detail` is the sentence a native dialog has
 * no room for: what happens next and whether it can be undone.
 */
export interface ConfirmOptions {
  /** The question. */
  message: string;
  /** One line on the consequence — above all, whether it is reversible. */
  detail?: string;
  /** Label for the confirming button. A verb, not "OK". */
  confirmLabel: string;
  /** Label for the cancelling button; "Cancel" when absent. */
  cancelLabel?: string;
  /** Paints the confirm button as destructive and focuses Cancel instead. */
  destructive?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
  /** What had the keyboard when the question was asked. */
  restoreFocus: HTMLElement | null;
}

const [pending, setPending] = createSignal<Pending | null>(null);

/**
 * Ask, and resolve to whether the person said yes.
 *
 * Resolves `false` for a cancel, an Escape, a click on the backdrop — and for
 * a request that a second one supersedes. A promise that never settles would
 * strand its caller mid-action forever, so a displaced request is answered
 * rather than dropped.
 */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  const current = pending();
  if (current) current.resolve(false);
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  return new Promise<boolean>((resolve) => {
    setPending({
      ...opts,
      resolve,
      restoreFocus: active instanceof HTMLElement ? active : null,
    });
  });
}

/** Test seam: settle any open request. Not used by the app. */
export function __resetConfirm(): void {
  const current = pending();
  if (current) current.resolve(false);
  setPending(null);
}

export const ConfirmHost: Component = () => {
  const answer = (ok: boolean) => {
    const p = pending();
    if (!p) return;
    setPending(null);
    p.resolve(ok);
    // Put the keyboard back where it was. Without this, dismissing the dialog
    // drops focus to <body> and the next Tab starts from the top of the page.
    p.restoreFocus?.focus();
  };

  /**
   * Escape cancels — and MUST NOT reach anything behind the dialog.
   *
   * NoteModal and NotesView both bind their own Escape to `document`
   * (NoteModal.tsx closes the note, NotesView.tsx clears the selection). A
   * bubble-phase listener here could not stop them: `stopPropagation` does
   * nothing between listeners on the same node, so one Escape over an
   * attachment-delete confirm would have cancelled the dialog AND closed the
   * note underneath it.
   *
   * Capture phase runs on the way DOWN, before every bubble listener on
   * document, and `stopImmediatePropagation` there ends the dispatch. Only
   * Escape is swallowed, so Enter still activates the focused button.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!pending()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      answer(false);
    }
  };

  onMount(() => document.addEventListener('keydown', onKeyDown, true));
  onCleanup(() => document.removeEventListener('keydown', onKeyDown, true));

  /**
   * Android hardware back, for the same reason. The shell walks
   * `backHandlers` newest-first, so a handler registered while the dialog is
   * open is reached before the note modal's — but only while it is open, or
   * every back press in the app would be swallowed by a dialog that is not
   * there.
   */
  createEffect(() => {
    if (!pending()) return;
    const unregister = registerBackHandler(() => {
      if (!pending()) return false;
      answer(false);
      return true;
    });
    onCleanup(unregister);
  });

  return (
    <Show when={pending()}>
      {(p) => (
        <div
          class="modal-overlay confirm-overlay"
          onClick={(e) => {
            if ((e.target as HTMLElement).classList.contains('modal-overlay')) answer(false);
          }}
        >
          <div
            class="modal-card confirm-dialog"
            /* alertdialog, not dialog: this interrupts to ask about something
               destructive, and the role is what makes a screen reader announce
               the question rather than waiting to be asked for it. */
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-message"
            aria-describedby={p().detail ? 'confirm-dialog-detail' : undefined}
          >
            <div class="modal-header">
              <h2 id="confirm-dialog-message">{p().message}</h2>
              <Show when={p().detail}>
                <p id="confirm-dialog-detail">{p().detail}</p>
              </Show>
            </div>
            <div class="modal-actions confirm-actions">
              <button
                class="btn btn-sm btn-secondary"
                data-testid="confirm-cancel"
                ref={(el) => {
                  // Cancel takes focus on a destructive question. A native
                  // confirm() focuses OK, which on a "delete forever" means one
                  // stray Enter is enough — the one keystroke this dialog most
                  // needs not to be.
                  if (p().destructive) queueMicrotask(() => el.focus());
                }}
                onClick={() => answer(false)}
              >
                {p().cancelLabel ?? 'Cancel'}
              </button>
              <button
                class={p().destructive ? 'btn btn-sm btn-danger' : 'btn btn-sm'}
                data-testid="confirm-accept"
                ref={(el) => {
                  if (!p().destructive) queueMicrotask(() => el.focus());
                }}
                onClick={() => answer(true)}
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

export default ConfirmHost;
