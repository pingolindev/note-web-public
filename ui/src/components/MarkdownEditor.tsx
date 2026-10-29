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

import { Component, createMemo, Show } from 'solid-js';
import { mathReady, renderMarkdown } from '../lib/markdown';
import { sanitizeHtml } from '../lib/sanitizeHtml';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/**
 * Markdown editor with live preview below the textarea.
 * Type raw markdown, see rendered output in real time.
 */
const MarkdownEditor: Component<Props> = (props) => {
  // mathReady(): re-render once the KaTeX chunk lands, so math typed before it
  // arrived stops showing as source text. See lib/markdown.
  const rendered = createMemo(() => {
    mathReady();
    return props.value ? sanitizeHtml(renderMarkdown(props.value)) : '';
  });

  return (
    <div class="md-split-editor">
      <textarea
        class="md-textarea"
        value={props.value}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        placeholder={props.placeholder || 'Write markdown...'}
        rows={6}
      />
      <Show when={props.value.trim()}>
        <div class="md-live-preview" innerHTML={rendered()} />
      </Show>
    </div>
  );
};

export default MarkdownEditor;
