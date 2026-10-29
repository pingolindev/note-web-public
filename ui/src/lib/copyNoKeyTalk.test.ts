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
 * The copy rule: what a person reads never talks about keys — nobody knows
 * what that means — and "recovery key" and "passkey" are the only
 * exceptions, because people hold those. This pins the pure copy helpers to
 * the rule, so a new sentence saying "encryption key", "safety number",
 * "signature" or "rotate" fails here instead of reaching a reader. Internal
 * errors and console output are not copy and are not checked.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn() }));

import {
  keysUnavailableCopy, lockedNotesHeadline, LOCKED_NOTES_HOW_TO, type KeysUnavailableReason,
} from './lockedCopy';
import { keyChangedMessage } from './recipientKeys';
import { plainAdvice, plainReason } from './blockedShareSummary';
import { inviteGrantText, type NotebookInvite } from './notebookInvites';
import {
  UNCONFIRMED_ATTACHMENT_TITLE, UNCONFIRMED_ATTACHMENT_BODY, KEEP_ATTACHMENT_LABEL,
  DELETE_UNCONFIRMED_LABEL, KEEP_ATTACHMENT_FAILED,
} from './attachmentTrust';
import type { WrapTrust } from '../stores/sharesInbox';

const BANNED = /\b(keys?|wrap\w*|unwrap\w*|pinned|fingerprints?|safety numbers?|rotat\w*|re-?key\w*|signatures?|signing|sealed)\b/i;
const ALLOWED = /\b(recovery key|passkeys?)\b/gi;

function expectPlain(text: string): void {
  expect(text.replace(ALLOWED, ''), text).not.toMatch(BANNED);
}

const REASONS: KeysUnavailableReason[] = ['not-federated', 'no-server-key', 'unreachable', 'app'];
const VERDICTS: WrapTrust[] = ['verified', 'unverified', 'unsigned-stripped', 'no-key', 'invalid'];

describe('no key talk in what Note says', () => {
  it('the locked-notes notices', () => {
    for (const reason of REASONS) {
      const { title, body } = keysUnavailableCopy(reason);
      expectPlain(title);
      expectPlain(body);
    }
    expectPlain(lockedNotesHeadline(1));
    expectPlain(lockedNotesHeadline(3));
    // The one allowed noun is what makes this sentence useful.
    expect(LOCKED_NOTES_HOW_TO).toMatch(/recovery key/);
    expectPlain(LOCKED_NOTES_HOW_TO);
  });

  it('confirming someone who may have reset their password', () => {
    expectPlain(keyChangedMessage('ben@example.test'));
  });

  it('shares that were not opened', () => {
    for (const verdict of VERDICTS) {
      expectPlain(plainReason(verdict));
      expectPlain(plainAdvice(verdict));
    }
  });

  it('a file that could not be confirmed', () => {
    for (const text of [
      UNCONFIRMED_ATTACHMENT_TITLE, UNCONFIRMED_ATTACHMENT_BODY, KEEP_ATTACHMENT_LABEL,
      DELETE_UNCONFIRMED_LABEL, KEEP_ATTACHMENT_FAILED,
    ]) expectPlain(text);
  });

  it('a notebook invitation that cannot be opened', () => {
    const invite: NotebookInvite = {
      notebookId: 'n1', shareId: 's1', shareIds: ['s1'], name: null, sharer: 'alice@example.test',
      sharerEmail: 'alice@example.test', permission: 'read', accepted: false, unreadable: true,
    };
    expectPlain(inviteGrantText(invite));
  });

  describe('sharing from a browser that cannot share', () => {
    let crypto: typeof import('./crypto');
    beforeAll(async () => {
      const store = () => {
        const m = new Map<string, string>();
        return {
          getItem: (k: string) => m.get(k) ?? null,
          setItem: (k: string, v: string) => void m.set(k, v),
          removeItem: (k: string) => void m.delete(k),
          clear: () => m.clear(),
          key: (i: number) => [...m.keys()][i] ?? null,
          get length() { return m.size; },
        };
      };
      vi.stubGlobal('sessionStorage', store());
      vi.stubGlobal('localStorage', store());
      crypto = await import('./crypto');
    });

    it('says what to do, not which key is missing', () => {
      expectPlain(crypto.SIGNING_KEY_MISMATCH_MESSAGE);
      expectPlain(crypto.SIGNING_UNAVAILABLE_MESSAGE);
    });
  });

  it('the checker itself catches key talk (positive control)', () => {
    expect(() => expectPlain("their encryption key changed")).toThrow();
    expect(() => expectPlain('Compare safety numbers')).toThrow();
    expect(() => expectPlain('This share has no signature')).toThrow();
    expect(() => expectPlain('If you still have your recovery key, restore them')).not.toThrow();
  });
});
