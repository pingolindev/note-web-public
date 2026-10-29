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
 * Central HTML sanitizer for renderMarkdown() output before it is
 * assigned via innerHTML.
 *
 * A note body is attacker-controlled once decrypted: any share/collab
 * peer (or, for public links, the note's own author) authors it, so the
 * rendered HTML is untrusted. Without sanitizing, a crafted body is
 * stored/shared XSS that runs in the viewer's origin — which defeats
 * E2EE, since script in-origin can read the decrypted vault out of
 * memory/storage. DOMPurify strips scriptable markup; the hook below
 * additionally neutralizes dangerous URL schemes.
 */
import DOMPurify from 'dompurify';

const DANGEROUS_SCHEME = /^\s*(?:javascript|data|vbscript):/i;
const URL_ATTRS = ['href', 'src', 'xlink:href'] as const;

/**
 * Whether DOMPurify has a DOM to work with.
 *
 * Without one it exports an inert stub — `addHook` is not even a function — so
 * an unguarded registration would make importing this module throw in a `node`
 * test environment, and nothing that transitively reached it could be unit
 * tested.
 *
 * Guarding the hook registration is safe ONLY because [sanitizeHtml] refuses to
 * run in the same condition (see below). A hook that silently failed to
 * register while sanitizing continued would be the dangerous version: markup
 * would be sanitized by DOMPurify's defaults with our scheme-stripping and
 * rel-pinning quietly absent.
 */
const HAS_DOM = typeof window !== 'undefined' && typeof window.document !== 'undefined';

// Belt-and-suspenders on top of DOMPurify's built-in URI filtering: drop
// any href/src/xlink:href carrying a javascript:/data:/vbscript: scheme,
// and pin rel on new-tab links to block reverse-tabnabbing.
if (HAS_DOM) DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  for (const attr of URL_ATTRS) {
    if (node.hasAttribute(attr) && DANGEROUS_SCHEME.test(node.getAttribute(attr) ?? '')) {
      node.removeAttribute(attr);
    }
  }
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Sanitize renderMarkdown() output for safe innerHTML assignment. */
export function sanitizeHtml(html: string): string {
  // Refuse rather than degrade. If there is no DOM the hook above never
  // registered, so anything we returned here would be missing the URL-scheme
  // and rel protections while looking sanitized. Throwing keeps "the hook is
  // installed" and "output is sanitized" as one condition instead of two that
  // can drift apart. There is no legitimate caller without a DOM — this output
  // exists to be assigned to innerHTML.
  if (!HAS_DOM) {
    throw new Error('sanitizeHtml called without a DOM — output would be unprotected');
  }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
