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
 * Which build is this?
 *
 * A web app has no version a person can read, and that is not a cosmetic gap.
 * The offline-shell service worker deliberately has no `skipWaiting`
 * (ui/public/sw.js explains why: claiming a running page would leave it
 * executing build N while the worker serves N+1, and a lazy chunk from N is
 * then in neither cache). So a new build waits for every tab on the origin to
 * close — which can mean hours of "the fix is deployed" against "it still
 * does it", with nothing on screen to reveal a bundle several deploys old.
 *
 * The editor's Dockerfile hands the image build's `BUILD_VERSION` and
 * `BUILD_COMMIT` to Vite as `VITE_*`, which bakes them into the bundle. So what Settings shows
 * is a property of the JAVASCRIPT THAT IS RUNNING, not of the server that
 * answered — which is the distinction that matters when a worker is serving
 * from cache.
 *
 * Two identifiers, because they answer different questions:
 *   - VERSION (`0.1.668`) is the image tag, so it compares directly against
 *     the deployed image and against what mobile reports.
 *   - COMMIT (its first 7 characters) maps to git, so it says exactly what
 *     source this is.
 */

/** `unknown` is the Dockerfile's default; a dev build has no value at all. */
const RAW_COMMIT = import.meta.env.VITE_BUILD_COMMIT ?? '';
const RAW_VERSION = import.meta.env.VITE_BUILD_VERSION ?? '';

/**
 * An unsubstituted `$BUILD_COMMIT` means someone ran docker build without the
 * arg; `unknown` is the ARG default. Neither is a build identity.
 */
const isPlaceholder = (v: string) =>
  !v || v === 'unknown' || v === '$BUILD_COMMIT' || v === '$BUILD_VERSION';

export interface BuildInfo {
  /** Image version, e.g. `0.1.668`, or null when not built as an image. */
  version: string | null;
  /** Full commit sha, or null when this bundle was not built as an image. */
  commit: string | null;
  /** First 7 characters, which is what a person reads and quotes back. */
  shortCommit: string | null;
  /** One line for the Settings row. Never empty. */
  label: string;
}

export function buildInfo(): BuildInfo {
  const version = isPlaceholder(RAW_VERSION) ? null : RAW_VERSION.trim();
  const commit = isPlaceholder(RAW_COMMIT) ? null : RAW_COMMIT.trim();
  const shortCommit = commit ? commit.slice(0, 7) : null;
  // A local `npm run build` and `npm run dev` both land here, and saying so is
  // more useful than a blank row or a fake number. Either half alone still
  // identifies the build, so neither missing one blanks the row.
  const label = [version, shortCommit].filter(Boolean).join(' · ') || 'development build';
  return { version, commit, shortCommit, label };
}
