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
import { remindersStore, Reminder } from '../stores/reminders';
import { presets, requestNotificationPermission, fireLocal, formatReminder } from '../lib/reminderSchedule';
import { notesStore } from '../stores/notes';
import { ensurePushSubscription } from '../lib/webPush';
import UpgradePrompt from './UpgradePrompt';

interface Props {
  noteId: string;
  existing: Reminder | undefined;
  onClose: () => void;
}

/** Format a Date for a <input type="datetime-local"> default value. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ReminderPicker: Component<Props> = (props) => {
  const [customOpen, setCustomOpen] = createSignal(false);
  const defaultDate = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30);
    d.setSeconds(0, 0);
    return d;
  };
  const [customValue, setCustomValue] = createSignal(toLocalInputValue(defaultDate()));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Reminders are Premium-gated (402) — show the upgrade prompt (with the
  // shared privacy line) rather than a bare error string.
  const [upgrade, setUpgrade] = createSignal(false);

  const handleFire = (r: Reminder) => {
    const n = notesStore.notes().find(x => x.id === r.itemId);
    fireLocal(r, n, () => {
      // Clicking the notification just focuses the window — opening the note
      // from the service worker context isn't wired; users can find it in the
      // Reminders view. Mark as fired locally so it doesn't replay.
      remindersStore.markFiredLocal(r.id);
    });
    remindersStore.markFiredLocal(r.id);
  };

  const setReminder = async (date: Date) => {
    if (date.getTime() <= Date.now()) {
      setError('Pick a time in the future');
      return;
    }
    setBusy(true);
    setError(null);
    // Request notification permission on first use so the eventual firing isn't silent.
    await requestNotificationPermission();
    // Opportunistically register a Web Push subscription so the reminder
    // fires even when this tab isn't open. Non-fatal if it fails.
    ensurePushSubscription().catch(() => {});
    // If there's an existing reminder, delete it first (server has no upsert).
    if (props.existing) {
      await remindersStore.delete(props.existing.id);
    }
    const result = await remindersStore.create(props.noteId, date, handleFire);
    setBusy(false);
    if (result && 'error' in result) {
      if (result.status === 402) {
        setUpgrade(true);
      } else {
        setError(result.error);
      }
      return;
    }
    props.onClose();
  };

  const clearReminder = async () => {
    if (!props.existing) return;
    setBusy(true);
    await remindersStore.delete(props.existing.id);
    setBusy(false);
    props.onClose();
  };

  return (
    <div class="reminder-picker" onClick={(e) => e.stopPropagation()}>
      <div class="reminder-picker-header">
        <span>Remind me</span>
        <button class="btn-icon" onClick={props.onClose} title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <Show when={props.existing}>
        <div class="reminder-picker-current">
          Currently: {formatReminder(props.existing!.triggerAt)}
        </div>
      </Show>

      <Show when={upgrade()}>
        <UpgradePrompt message="Reminders are a Premium feature — a Track-only plan doesn't include them." />
      </Show>

      <Show when={!upgrade()}>
      <For each={presets}>
        {(preset) => {
          const date = preset.compute();
          return (
            <Show when={date}>
              <button
                class="reminder-preset"
                disabled={busy()}
                onClick={() => setReminder(date!)}
              >
                <span class="reminder-preset-label">{preset.label}</span>
                <span class="reminder-preset-time">{formatReminder(date!.toISOString())}</span>
              </button>
            </Show>
          );
        }}
      </For>

      <Show when={!customOpen()}>
        <button class="reminder-preset" disabled={busy()} onClick={() => setCustomOpen(true)}>
          Pick date & time…
        </button>
      </Show>

      <Show when={customOpen()}>
        <div class="reminder-custom">
          <input
            type="datetime-local"
            value={customValue()}
            onInput={(e) => setCustomValue(e.currentTarget.value)}
          />
          <button
            class="btn btn-sm"
            disabled={busy() || !customValue()}
            onClick={() => {
              const d = new Date(customValue());
              if (isNaN(d.getTime())) { setError('Invalid date'); return; }
              setReminder(d);
            }}
          >Set</button>
        </div>
      </Show>

      <Show when={props.existing}>
        <button class="reminder-preset reminder-preset-danger" disabled={busy()} onClick={clearReminder}>
          Remove reminder
        </button>
      </Show>
      </Show>

      <Show when={error()}>
        <div class="reminder-error">{error()}</div>
      </Show>
    </div>
  );
};

export default ReminderPicker;
