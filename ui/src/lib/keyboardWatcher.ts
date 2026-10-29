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
 * Watch for the on-screen keyboard on phones (max-width: 600px).
 *
 * The signal is a comparison against the LARGEST viewport height seen, not
 * against window.innerHeight at the same instant, because the two keyboard
 * models resize different things:
 *
 *   - The frame SHRINKS. Android's WebView runs adjustResize, so the IME
 *     shrinks innerHeight and visualViewport TOGETHER (measured 812 -> 486 on
 *     both) and a same-moment ratio between the two never fires. The iOS
 *     shell is very likely here as well — SwiftUI applies keyboard avoidance
 *     to its hosting frame by default and the Note iOS app's web shell view
 *     takes no `.ignoresSafeArea(.keyboard)` opt-out — but that is INFERRED
 *     from the missing opt-out, not measured on a device.
 *   - The keyboard OVERLAYS. Mobile Safari and Chrome as plain browsers leave
 *     innerHeight alone and shrink only visualViewport.
 *
 * The baseline comparison covers both: either way the CURRENT height drops
 * below the tallest one seen. Orientation change resets the baseline; the next
 * resize re-seeds it for the new axis.
 *
 * Returns an unsubscribe function. `onChange` fires only on transitions.
 */
export function watchKeyboard(onChange: (up: boolean) => void): () => void {
  const phone = window.matchMedia('(max-width: 600px)');
  let baseline = 0;
  let was = false;
  const onResize = () => {
    if (!phone.matches) return;
    // PINCH-ZOOM SHRINKS visualViewport.height EXACTLY AS THE KEYBOARD DOES.
    // At scale 1.6 an 891px viewport reads 556.875 — past the 80% gate below —
    // so zooming in to read a note would announce a keyboard that is not there,
    // and un-pinching is not a keyboard closing either. While the page is zoomed
    // the height carries no keyboard information at all, so this says nothing
    // rather than guessing: `was` is frozen and the first un-zoomed resize
    // re-decides. 1.01 rather than 1 because the scale is a float and a pixel
    // of rounding at rest must not read as a zoom.
    if ((window.visualViewport?.scale ?? 1) > 1.01) return;
    const h = window.visualViewport?.height ?? window.innerHeight;
    if (h > baseline) baseline = h;
    const up = h < baseline * 0.8;
    if (up !== was) {
      was = up;
      onChange(up);
    }
  };
  const onOrientation = () => { baseline = 0; };
  window.visualViewport?.addEventListener('resize', onResize);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onOrientation);
  onResize(); // seed the baseline with the current (keyboard-down) height
  return () => {
    window.visualViewport?.removeEventListener('resize', onResize);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onOrientation);
  };
}
