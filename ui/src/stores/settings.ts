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

/**
 * Settings store — theme, preferences, persisted to localStorage.
 */
import { createSignal } from 'solid-js';

export type Theme = 'system' | 'light' | 'dark';
export type EditorMode = 'hybrid' | 'markdown' | 'preview';

const STORAGE_KEY = 'pingolin_note_settings';

interface Settings {
  theme: Theme;
  editorMode: EditorMode;
  alwaysMaximize: boolean;
  /**
   * Whether markdown you TYPE turns into formatting.
   *
   * Off makes Preview a plain rich-text editor: the toolbar still applies
   * formatting, existing markdown in a note still renders, but typing `#` at
   * the start of a line leaves a `#` instead of making a heading. It only
   * affects input — nothing about how a note is displayed changes, so two
   * people with different settings never see the same note differently.
   *
   * Preview-only. Hybrid and Markdown exist to show you the syntax, so
   * suppressing it there would be incoherent.
   */
  interpretMarkdown: boolean;
}

const defaults: Settings = {
  theme: 'system',
  // Preview is the friendlier default for a note app — raw markdown
  // symbols are hidden and formatting is rendered. Users who want
  // the live-preview cursor-line behavior pick Hybrid, and power
  // users pick Markdown.
  editorMode: 'preview',
  alwaysMaximize: false,
  // Defaults OFF, matching android and iOS. Typing markdown and having it
  // silently become formatting surprises people who just wanted the
  // characters; the toolbar is the discoverable way to format, and this
  // toggle turns interpretation back on.
  //
  // Anyone with no stored value gets this default; anyone who explicitly
  // chose keeps their choice, since load() merges stored settings over
  // these defaults.
  interpretMarkdown: false,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate old markdownPlaintext boolean
      if (parsed.markdownPlaintext === true && !parsed.editorMode) {
        parsed.editorMode = 'markdown';
      }
      // Rename 'regular' → 'hybrid' (the live-preview cursor-line
      // mode). Preserves existing users' actual preference rather
      // than dropping them onto the Preview default.
      if (parsed.editorMode === 'regular') parsed.editorMode = 'hybrid';
      return { ...defaults, ...parsed };
    }
  } catch {}
  return { ...defaults };
}

function save(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

const [settings, setSettings] = createSignal<Settings>(load());

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  // Aligns with generated note.css: .dark / .light force-mode,
  // no class = auto-follow prefers-color-scheme.
  if (theme === 'light') root.classList.add('light');
  else if (theme === 'dark') root.classList.add('dark');
}

applyTheme(settings().theme);

export const settingsStore = {
  settings,

  setTheme(theme: Theme) {
    const s = { ...settings(), theme };
    setSettings(s);
    save(s);
    applyTheme(theme);
  },

  setEditorMode(mode: EditorMode) {
    const s = { ...settings(), editorMode: mode };
    setSettings(s);
    save(s);
  },

  cycleEditorMode() {
    const modes: EditorMode[] = ['hybrid', 'markdown', 'preview'];
    const current = settings().editorMode;
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    settingsStore.setEditorMode(next);
  },

  setInterpretMarkdown(enabled: boolean) {
    const s = { ...settings(), interpretMarkdown: enabled };
    setSettings(s);
    save(s);
  },

  setAlwaysMaximize(enabled: boolean) {
    const s = { ...settings(), alwaysMaximize: enabled };
    setSettings(s);
    save(s);
  },
};
