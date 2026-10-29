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

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DID_NOT_GO_THROUGH, notebookBeforeItsNotes, removalDidNotGoThrough, sayStop, TRY_AGAIN_LATER, type NotebookFirstSteps,
} from './notebookFirst';
import { SIGNING_UNAVAILABLE_MESSAGE } from './crypto';
import { keyChangedMessage } from './recipientKeys';
import type { NotebookItemState } from '../stores/notebooks';
import type { NotebookShareOutcome } from './shareUtils';

/**
 * A notebook is shared as ITSELF first, and its notes only when that went
 * through. The notes must never go without the invitation: not when the
 * server could not be asked about the notebook, and not when the notebook's
 * own share failed. These test the behaviour rather than pin the panel's
 * source, so reading "no answer" as "no item" fails here.
 */
const STOP = { go: false, why: 'failed' };

/** The steps, each recording that it ran, in order. */
function steps(over: {
  item?: NotebookItemState | NotebookItemState[];
  wasBeingRemoved?: boolean;
  /** One outcome for every share, or one per share in turn (the last repeats). */
  share?: NotebookShareOutcome | NotebookShareOutcome[];
  repaired?: boolean;
} = {}) {
  const ran: string[] = [];
  const answers = Array.isArray(over.item) ? [...over.item] : [over.item ?? 'item'];
  const shares = Array.isArray(over.share) ? [...over.share] : [over.share ?? 'shared'];
  const s: NotebookFirstSteps = {
    askItem: vi.fn(async () => {
      ran.push('ask');
      return answers.length > 1 ? answers.shift()! : answers[0];
    }),
    endRemoval: vi.fn(async () => {
      ran.push('end removal');
      return over.wasBeingRemoved ?? false;
    }),
    shareNotebook: vi.fn(async () => {
      ran.push('share notebook');
      return shares.length > 1 ? shares.shift()! : shares[0];
    }),
    resumeRemoval: vi.fn(() => { ran.push('resume removal'); }),
    repairNotebook: vi.fn(async () => {
      ran.push('repair');
      return over.repaired ?? false;
    }),
  };
  return { s, ran };
}

describe('the notebook before its notes', () => {
  it('a notebook the server has an item for is shared as an object, and then its notes may go', async () => {
    const { s, ran } = steps();
    expect(await notebookBeforeItsNotes(s)).toEqual({ go: true });
    expect(ran).toEqual(['ask', 'end removal', 'share notebook']);
  });

  it('a removal still being finished is ended BEFORE the notebook is shared', async () => {
    const { s, ran } = steps({ wasBeingRemoved: true });
    expect(await notebookBeforeItsNotes(s)).toEqual({ go: true });
    expect(ran.indexOf('end removal')).toBeLessThan(ran.indexOf('share notebook'));
    expect(s.resumeRemoval).not.toHaveBeenCalled();
  });

  describe('when the server cannot be asked about the notebook', () => {
    it('stops: nothing is ended, nothing is shared', async () => {
      const { s, ran } = steps({ item: 'unknown' });
      expect(await notebookBeforeItsNotes(s)).toEqual(STOP);
      expect(ran).toEqual(['ask', 'ask']);
    });

    it('asks once more first: a blip is not a failure', async () => {
      const { s, ran } = steps({ item: ['unknown', 'item'] });
      expect(await notebookBeforeItsNotes(s)).toEqual({ go: true });
      expect(ran).toEqual(['ask', 'ask', 'end removal', 'share notebook']);
    });

    it('and no more than twice', async () => {
      const { s } = steps({ item: ['unknown', 'unknown', 'item'] });
      expect(await notebookBeforeItsNotes(s)).toEqual(STOP);
      expect(s.askItem).toHaveBeenCalledTimes(2);
    });

    it('an answer is not asked for again', async () => {
      for (const item of ['item', 'none'] as const) {
        const { s } = steps({ item });
        await notebookBeforeItsNotes(s);
        expect(s.askItem).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('when the notebook\'s own share fails', () => {
    it('stops: a request that did not get through', async () => {
      const { s, ran } = steps({ share: 'failed' });
      expect(await notebookBeforeItsNotes(s)).toEqual(STOP);
      expect(ran).toEqual(['ask', 'end removal', 'share notebook']);
    });

    /**
     * Each of these keeps its own reason: as "failed" they would all read
     * "Check your connection", and a free account would be told to try
     * again for ever.
     */
    it('stops for the share\'s own reason, whichever it was', async () => {
      for (const why of ['upgrade', 'cannot-sign', 'key-changed'] as const) {
        const { s, ran } = steps({ share: why });
        expect(await notebookBeforeItsNotes(s)).toEqual({ go: false, why });
        expect(ran).toEqual(['ask', 'end removal', 'share notebook']);
      }
    });

    it('whatever the reason, a removal that was ended for it goes on', async () => {
      for (const why of ['failed', 'upgrade', 'cannot-sign', 'key-changed'] as const) {
        const { s, ran } = steps({ share: why, wasBeingRemoved: true });
        await notebookBeforeItsNotes(s);
        expect(ran).toEqual(['ask', 'end removal', 'share notebook', 'resume removal']);
      }
    });

    /**
     * Ending their removal was the share's first step. Ended and not replaced
     * by a share, the removal would stand half done: they keep whatever it had
     * not come to, and no job is left to finish it.
     */
    it('a removal that was ended for it goes on', async () => {
      const { s, ran } = steps({ share: 'failed', wasBeingRemoved: true });
      expect(await notebookBeforeItsNotes(s)).toEqual(STOP);
      expect(ran).toEqual(['ask', 'end removal', 'share notebook', 'resume removal']);
    });

    it('nobody is removed who was not being removed', async () => {
      const { s } = steps({ share: 'failed', wasBeingRemoved: false });
      await notebookBeforeItsNotes(s);
      expect(s.resumeRemoval).not.toHaveBeenCalled();
    });
  });

  describe('a notebook that is shared note by note, as it always was', () => {
    it('one the server has no item for: it is not shared as an object at all', async () => {
      const { s, ran } = steps({ item: 'none', share: 'failed' });
      expect(await notebookBeforeItsNotes(s)).toEqual({ go: true });
      expect(ran).toEqual(['ask', 'end removal']);
    });

    it('an address with no account yet: there is nobody to seal the notebook to', async () => {
      const { s } = steps({ share: 'no-account', wasBeingRemoved: true });
      expect(await notebookBeforeItsNotes(s)).toEqual({ go: true });
      expect(s.resumeRemoval).not.toHaveBeenCalled();
    });

  });

  /**
   * Every object a user encounters should be usable: a notebook this page
   * cannot open is not shared note by note, with no invitation to answer. It
   * is repaired, and shared as itself; its notes never go without it.
   */
  describe('a notebook this page cannot open', () => {
    it('is repaired, and then shared as itself before its notes', async () => {
      const { s, ran } = steps({ share: ['cannot-open', 'shared'], repaired: true });
      expect(await notebookBeforeItsNotes(s)).toEqual({ go: true });
      expect(ran).toEqual(['ask', 'end removal', 'share notebook', 'repair', 'share notebook']);
    });

    it('that cannot be repaired now: the share stops, and nothing of the notes goes', async () => {
      const { s, ran } = steps({ share: 'cannot-open', repaired: false, wasBeingRemoved: true });
      expect(await notebookBeforeItsNotes(s)).toEqual(STOP);
      expect(ran).toEqual(['ask', 'end removal', 'share notebook', 'repair', 'resume removal']);
      // The words for a stop of that kind are the ones already used.
      expect(sayStop('failed', 'ann@example.com')).toEqual({ upgrade: false, error: DID_NOT_GO_THROUGH });
    });

    it('repaired and still not opening: it stops, and is not repaired again', async () => {
      const { s } = steps({ share: 'cannot-open', repaired: true });
      expect(await notebookBeforeItsNotes(s)).toEqual(STOP);
      expect(s.repairNotebook).toHaveBeenCalledTimes(1);
      expect(s.shareNotebook).toHaveBeenCalledTimes(2);
    });

    it('repaired, and the share then refused for another reason: that reason is the stop', async () => {
      const { s } = steps({ share: ['cannot-open', 'upgrade'], repaired: true });
      expect(await notebookBeforeItsNotes(s)).toEqual({ go: false, why: 'upgrade' });
    });

    it('nothing is repaired for a notebook that opens, nor for one with no item', async () => {
      for (const over of [{}, { share: 'failed' as const }, { item: 'none' as const }, { share: 'no-account' as const }]) {
        const { s } = steps(over);
        await notebookBeforeItsNotes(s);
        expect(s.repairNotebook).not.toHaveBeenCalled();
      }
    });
  });
});

/**
 * What the panel shows for a stop. The words are the ones a single note's
 * share shows for the same reason.
 */
describe('saying why the notebook was not shared', () => {
  it('a request that did not get through: the words the invitation panel and Settings use', () => {
    expect(sayStop('failed', 'ann@example.com')).toEqual({ upgrade: false, error: DID_NOT_GO_THROUGH });
    expect(DID_NOT_GO_THROUGH).toBe("That didn't go through. Check your connection and try again.");
  });

  it('a free account: the upgrade prompt, and no words about a connection', () => {
    expect(sayStop('upgrade', 'ann@example.com')).toEqual({ upgrade: true });
  });

  it('a browser that cannot sign: what a note\'s share says', () => {
    expect(sayStop('cannot-sign', 'ann@example.com')).toEqual({ upgrade: false, error: SIGNING_UNAVAILABLE_MESSAGE });
  });

  it('a key that changed: what a note\'s share says, naming the person', () => {
    const said = sayStop('key-changed', 'ann@example.com');
    expect(said).toEqual({ upgrade: false, error: keyChangedMessage('ann@example.com') });
    expect(said.upgrade === false && said.error).toContain('ann@example.com');
  });

  it('none of them is the same as another', () => {
    const all = (['failed', 'upgrade', 'cannot-sign', 'key-changed'] as const).map(w => JSON.stringify(sayStop(w, 'a@b.c')));
    expect(new Set(all).size).toBe(4);
  });
});

/**
 * A removal from a note that did not go through: nothing was sent, and they
 * stay listed. The words for a lost connection, or, when the new key could not
 * be signed for someone who stays even tried again, the words for that,
 * letter for letter.
 */
describe('a removal from a note that did not go through', () => {
  it('says why in the words for it', () => {
    expect(removalDidNotGoThrough({})).toBe(DID_NOT_GO_THROUGH);
    expect(removalDidNotGoThrough({ couldNotSign: false })).toBe(DID_NOT_GO_THROUGH);
    expect(removalDidNotGoThrough({ couldNotSign: true })).toBe(TRY_AGAIN_LATER);
    // Not the connection either — the note does not open here, or it kept
    // changing elsewhere though tried again each time.
    expect(removalDidNotGoThrough({ notOpenHere: true })).toBe(TRY_AGAIN_LATER);
    expect(removalDidNotGoThrough({ changedElsewhere: true })).toBe(TRY_AGAIN_LATER);
    expect(removalDidNotGoThrough({ notOpenHere: false, changedElsewhere: false })).toBe(DID_NOT_GO_THROUGH);
    // The server answered and refused (a 429, a 5xx, a 403): not the connection.
    expect(removalDidNotGoThrough({ refused: true })).toBe(TRY_AGAIN_LATER);
    expect(removalDidNotGoThrough({ refused: false })).toBe(DID_NOT_GO_THROUGH);
    expect(TRY_AGAIN_LATER).toBe("That didn't go through. Try again later, or contact support if it keeps happening.");
  });

  it('is what the Share panel says (the repository has no DOM tests: read from its source)', () => {
    const panel = readFileSync(join(__dirname, '..', 'components', 'SharePanel.tsx'), 'utf8');
    const removal = panel.slice(panel.indexOf('const handleRemoveShare = async'), panel.indexOf('  return (\n'));
    expect(removal).toContain('const r = await rotateContentKey(props.noteId, [share.id]);');
    expect(removal).toContain('setErrorMsg(removalDidNotGoThrough(r));');
    expect(removal).not.toContain('setErrorMsg(DID_NOT_GO_THROUGH)');
  });
});
