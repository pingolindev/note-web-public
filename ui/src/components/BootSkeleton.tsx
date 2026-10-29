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

import { Component, For } from 'solid-js';

/**
 * The same skeleton index.html paints before the bundle runs, as a component.
 *
 * WHY THIS EXISTS RATHER THAN A SPINNER
 *
 * index.html draws a grid skeleton at document paint (~150-250ms measured on an
 * A16) so the first frame carries structure instead of being one flat colour.
 * The instant Solid renders anything into #root, the inline copy hides itself
 * (`#root:not(:empty) ~ #boot-skeleton`). If App.tsx then fell back to
 * `.loading-spinner` the user would watch skeleton -> spinner -> content: three
 * appearances for one wait, which reads worse than either alone. So the loading
 * and Suspense fallbacks render THIS, and the handoff is invisible.
 *
 * STYLES LIVE IN index.html, ON PURPOSE. They are inline there because the app
 * stylesheet is a separate request and anything waiting on it paints no earlier
 * than the spinner already did. Duplicating them into index.css would let the
 * two drift and reintroduce the visible seam this exists to remove — so this
 * component deliberately owns no CSS. If you change `.bs-*` here, change it in
 * index.html.
 *
 * Six cards matches the count the in-grid skeleton in NotesView already uses.
 *
 * aria-hidden: it is decoration standing in for content that has not arrived.
 * Announcing six empty cards to a screen reader would be noise, and the real
 * grid announces itself when it lands.
 */
const BootSkeleton: Component = () => (
  <div class="bs-root" aria-hidden="true">
    <div class="bs-header">
      <span class="bs-block bs-icon" />
      <span class="bs-block bs-search" />
      <span class="bs-spacer">
        <span class="bs-block bs-icon" />
        <span class="bs-block bs-icon" />
      </span>
    </div>
    <div class="bs-main">
      <div class="bs-composer" />
      <div class="bs-notebook"><span class="bs-block" /></div>
      <div class="bs-tabs">
        <For each={[0, 1, 2]}>{() => <span class="bs-block" />}</For>
      </div>
      <div class="bs-chips">
        <For each={[0, 1, 2, 3]}>{() => <span class="bs-block" />}</For>
      </div>
      <div class="bs-grid">
        <For each={[0, 1, 2, 3, 4, 5]}>{() => <div class="bs-card" />}</For>
      </div>
    </div>
  </div>
);

export default BootSkeleton;
