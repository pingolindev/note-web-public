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

import { Component, JSX, onCleanup, onMount } from 'solid-js';
import { registerBackHandler } from '../lib/backHandlers';

/**
 * A titled dialog for one of the note's tools — colour, labels, attachments.
 *
 * An inline panel expanding inside the modal would cost the editor its height
 * whenever it was open, could not grow to hold attachments as well, and would
 * put the note's bottom chrome at three stacked rows. A dialog costs the
 * editor nothing while closed and has room for a real control, which is what
 * keeps the chrome to two rows.
 *
 * Shares `ConfirmDialog`/`PromptDialog`'s shell classes rather than inventing a
 * fourth spelling of "modal": one visual language for asking the user
 * something.
 */
interface Props {
  title: string;
  onClose: () => void;
  children: JSX.Element;
}

const NoteToolDialog: Component<Props> = (props) => {
  const titleId = `note-tool-${Math.random().toString(36).slice(2, 8)}`;
  const restoreFocus = typeof document !== 'undefined'
    ? (document.activeElement as HTMLElement | null)
    : null;

  /**
   * Escape closes, in the CAPTURE phase, for the reason ConfirmDialog and
   * PromptDialog both document: NotesView and NoteModal each bind Escape on
   * `document`, so a bubbling listener here would be reached only after the
   * modal behind us had already closed itself — one key press dismissing two
   * things.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    props.onClose();
  };
  onMount(() => document.addEventListener('keydown', onKeyDown, true));
  onCleanup(() => document.removeEventListener('keydown', onKeyDown, true));

  // Android's Back closes this before it reaches the note, for the same reason.
  onMount(() => {
    const unregister = registerBackHandler(() => { props.onClose(); return true; });
    onCleanup(unregister);
  });

  // Give the focus back to the button that opened us, or a keyboard user is
  // returned to the top of the document every time they close a colour picker.
  onCleanup(() => restoreFocus?.focus());

  return (
    <div
      class="modal-overlay note-tool-overlay"
      onClick={(e) => {
        if ((e.target as HTMLElement).classList.contains('modal-overlay')) props.onClose();
      }}
    >
      <div class="modal-card note-tool-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div class="modal-header">
          <h2 id={titleId}>{props.title}</h2>
        </div>
        <div class="modal-content note-tool-content">{props.children}</div>
        <div class="modal-actions">
          <button
            class="btn btn-sm"
            ref={(el) => queueMicrotask(() => el.focus())}
            onClick={props.onClose}
          >Done</button>
        </div>
      </div>
    </div>
  );
};

export default NoteToolDialog;
