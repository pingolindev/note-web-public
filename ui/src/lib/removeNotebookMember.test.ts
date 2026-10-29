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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A notebook removal takes the person off the owner's standing share list
 * BEFORE anything else, so a stop at any later step leaves them off it.
 *
 * WHY THESE EXIST
 *   The list seals every NEW note in the notebook to its people. Written last,
 *   after the re-keying loop — which can stop halfway: tab closed, network
 *   dropped, rate limit — any stop in that loop would leave the removed person
 *   on the list for good, and every later note in the notebook would go to
 *   them.
 */

const removeNotebookShare = vi.fn();
vi.mock('../stores/notebooks', () => ({
  notebooksStore: { removeNotebookShare: (...a: unknown[]) => removeNotebookShare(...a) },
}));
const revokeNotebookAccess = vi.fn();
vi.mock('./notebookRemoval', () => ({ revokeNotebookAccess: (...a: unknown[]) => revokeNotebookAccess(...a) }));
/** The notes in memory: two of the notebook's (one in the trash) and one of another notebook. */
vi.mock('../stores/notes', () => ({
  notesStore: {
    notes: () => [
      { id: 'n1', notebookId: '11111111-1111-4111-8111-111111111111', deleted: false },
      { id: 'n2', notebookId: '11111111-1111-4111-8111-111111111111', deleted: true },
      { id: 'n3', notebookId: 'another', deleted: false },
    ],
  },
}));
const beginRemoval = vi.fn();
const drainJob = vi.fn();
const forgetRemoval = vi.fn();
vi.mock('./rekeyDrain', () => ({
  beginRemoval: (...a: unknown[]) => beginRemoval(...a),
  drainJob: (...a: unknown[]) => drainJob(...a),
  forgetRemoval: (...a: unknown[]) => forgetRemoval(...a),
}));
const { rekeyDeps, memDeps } = vi.hoisted(() => ({
  rekeyDeps: { listJobs: async (): Promise<unknown[]> => [] },
  memDeps: { listJobs: async (): Promise<unknown[]> => [] },
}));
const drainAgainAfterFullPull = vi.fn();
vi.mock('./rekeyDepsLive', () => ({
  rekeyDeps,
  jobsInMemory: () => memDeps,
  drainAgainAfterFullPull: (...a: unknown[]) => drainAgainAfterFullPull(...a),
}));

const { cancelNotebookRemoval, removeNotebookMember } = await import('./removeNotebookMember');
const { createJob } = await import('./rekeyQueue');

const NB = '11111111-1111-4111-8111-111111111111';
const X = 'removed@example.test';
const JOB = createJob({ notebookId: NB, removedRecipient: X, noteIds: ['n1', 'n2'], nowMs: 1 });
/** A promise that never settles: the step stops there, as a closed tab does. */
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  removeNotebookShare.mockResolvedValue(true);
  beginRemoval.mockResolvedValue(JOB);
  revokeNotebookAccess.mockResolvedValue({ rosterUpdated: true, objectRevoked: true, objectRotated: true, removedUserId: 'x-id' });
  drainJob.mockResolvedValue({ ...JOB, pendingNoteIds: [] });
  forgetRemoval.mockResolvedValue(false);
  drainAgainAfterFullPull.mockResolvedValue(undefined);
});

const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0];

describe('removing someone from a notebook', () => {
  it('takes them off the standing list first, then writes the job, then drains it (roster and object, then the notes)', async () => {
    await removeNotebookMember(NB, X);

    expect(removeNotebookShare).toHaveBeenCalledWith(NB, X);
    expect(order(removeNotebookShare)).toBeLessThan(order(beginRemoval));
    expect(order(beginRemoval)).toBeLessThan(order(drainJob));
    // The notebook's notes in memory, the trash included: the
    // panel's own list leaves the trash out.
    expect(beginRemoval.mock.calls[0][1]).toEqual({ notebookId: NB, removedRecipient: X, noteIds: ['n1', 'n2'] });
    // The drain of the job just written, through the one job store, which does
    // the roster and the object itself, in turn with any re-add.
    expect(drainJob.mock.calls[0]).toEqual([rekeyDeps, JOB]);
    expect(revokeNotebookAccess).not.toHaveBeenCalled();
    // And what waits for a full pull, after it, through the same store.
    expect(drainAgainAfterFullPull.mock.calls[0][0]).toBe(rekeyDeps);
    expect(order(drainJob)).toBeLessThan(order(drainAgainAfterFullPull));
  });

  it('leaves them off the list when the re-keying stops halfway', async () => {
    drainJob.mockImplementation(never);

    void removeNotebookMember(NB, X);
    await vi.waitFor(() => expect(drainJob).toHaveBeenCalled());

    expect(removeNotebookShare).toHaveBeenCalledWith(NB, X);
  });

  it('leaves them off the list when the job never finishes being written', async () => {
    beginRemoval.mockImplementation(never);

    void removeNotebookMember(NB, X);
    await vi.waitFor(() => expect(beginRemoval).toHaveBeenCalled());

    expect(removeNotebookShare).toHaveBeenCalledWith(NB, X);
    expect(drainJob).not.toHaveBeenCalled();
  });

  /**
   * With no job store, this path must not call revokeNotebookAccess on the
   * roster in memory — which an empty memory reads as "nobody to take out"
   * and reports as done — and re-key no note. The same drain runs once, over
   * a job held in memory: the roster read from the server first, every note
   * done.
   */
  it('with no job store, runs the same drain once over a job held in memory', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    beginRemoval.mockRejectedValueOnce(new Error('no idb'));

    await removeNotebookMember(NB, X);

    expect(beginRemoval.mock.calls.map(c => c[0])).toEqual([rekeyDeps, memDeps]);
    expect(beginRemoval.mock.calls[1][1]).toEqual({ notebookId: NB, removedRecipient: X, noteIds: ['n1', 'n2'] });
    expect(drainJob.mock.calls).toEqual([[memDeps, JOB]]);
    expect(revokeNotebookAccess).not.toHaveBeenCalled();
    expect(drainAgainAfterFullPull.mock.calls[0][0]).toBe(memDeps);
    warn.mockRestore();
  });

  it('with no job store, says so when the removal is still not finished', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    beginRemoval.mockRejectedValueOnce(new Error('no idb'));
    const listJobs = vi.spyOn(memDeps, 'listJobs').mockResolvedValue([JOB]);

    await removeNotebookMember(NB, X);

    await vi.waitFor(() => expect(warn.mock.calls.some(c => String(c[0]).includes('is not finished, and with no job store nothing will finish it'))).toBe(true));
    listJobs.mockRestore();
    warn.mockRestore();
  });
});

describe('sharing a notebook with someone again', () => {
  it('takes them out of its removal job, through the same job store', async () => {
    await cancelNotebookRemoval(NB, X);

    expect(forgetRemoval).toHaveBeenCalledWith(rekeyDeps, NB, X);
  });

  /** The caller starts the removal again when its share then fails (lib/notebookFirst). */
  it('says whether a removal of them was under way', async () => {
    forgetRemoval.mockResolvedValue(true);
    await expect(cancelNotebookRemoval(NB, X)).resolves.toBe(true);
    forgetRemoval.mockResolvedValue(false);
    await expect(cancelNotebookRemoval(NB, X)).resolves.toBe(false);
  });

  it('goes on with the share when the job cannot be changed, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    forgetRemoval.mockRejectedValue(new Error('no idb'));

    // "Not ended": they are still in the job, which goes on by itself.
    await expect(cancelNotebookRemoval(NB, X)).resolves.toBe(false);
    expect(warn.mock.calls.some(c => String(c[0]).includes('could not take them out of the removal job'))).toBe(true);
    warn.mockRestore();
  });
});

describe("the Share panel's notebook shares (read from the source: the repo has no DOM tests)", () => {
  const PANEL = readFileSync(join(__dirname, '..', 'components', 'SharePanel.tsx'), 'utf8');
  /** From `start` up to `end` (both must be there). */
  const between = (start: string, end: string) => {
    const from = PANEL.indexOf(start);
    const to = PANEL.indexOf(end, from + 1);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return PANEL.slice(from, to);
  };
  /** `call` comes before every one of `writes` in `body`. */
  const firstIn = (body: string, call: string, writes: string[]) => {
    const at = body.indexOf(call);
    expect(at).toBeGreaterThan(-1);
    for (const w of writes) {
      expect(body.indexOf(w)).toBeGreaterThan(at);
    }
  };
  const WRITES = ['shareOneNote(', 'addNotebookShare('];
  /** The notebook's own share and the end of a removal go through lib/notebookFirst,
   *  which orders them (its own test): the panel hands it these two, and nothing else of
   *  the panel ends a removal or shares a notebook as an object. */
  const HANDED_OVER = (id: string) => [
    `endRemoval: () => cancelNotebookRemoval(${id}, addr),`,
    'shareNotebook: () => shareNotebookWithRecipientResult(',
    `resumeRemoval: () => { void removeNotebookMember(${id}, addr)`,
  ];

  it('let the removal take the notebook\'s notes itself, the trash included', () => {
    expect(PANEL).toContain('await removeNotebookMember(props.noteId, share.recipient_email);');
  });

  it('end a removal still being finished before their first write, when inviting', () => {
    const notebookBranch = between('  const handleShare = async () => {', '// Single-note target.');
    const branch = notebookBranch.slice(notebookBranch.indexOf('if (isNotebook()) {'));
    firstIn(branch, 'const first = await notebookBeforeItsNotes({', WRITES);
    for (const handed of HANDED_OVER('nbId')) expect(branch).toContain(handed);
    // And it stops there when the notebook did not go through: before any note, and saying WHY
    // (lib/notebookFirst `sayStop`: the upgrade prompt for a free account).
    firstIn(branch, "if (!first.go) {", WRITES);
    const stop = branch.slice(branch.indexOf('if (!first.go) {'), branch.indexOf('setProgress({ done: 0, total: children.length });'));
    expect(stop).toContain("const say = sayStop(first.why, addr);\n          if (say.upgrade) { setStatus('upgrade'); return; }\n          setStatus('error');\n          setErrorMsg(say.error);\n          return;\n        }");
  });

  /**
   * A key lookup that FAILED must not be read as an address with no
   * account: the notes would go out with nothing sealed and no invitation.
   * It stops the share, before the first write of any kind (the reading of
   * the answer is lib/recipientKeys `readRecipientLookup`, tested there).
   */
  it('stop before anything is written when the key lookup got no answer', () => {
    const share = between('  const handleShare = async () => {', '  /** For a note shared WITH us');
    const stop = "if (!looked.answered) {\n      setStatus('error');\n      setErrorMsg(DID_NOT_GO_THROUGH);\n      return;\n    }";
    firstIn(share, 'const looked = readRecipientLookup(', [stop]);
    firstIn(share, stop, ['notebookBeforeItsNotes({', 'shareOneNote(', 'addNotebookShare(', 'setInviteKeyChange({']);
    // Nothing of the share reads the lookup's answer any other way.
    expect(PANEL).not.toContain('keyLookup.success ? (keyLookup.data.users ?? []) : []');
    expect(share).not.toContain('lookupEntry');
  });

  it('and when re-sealing (a change of right, or a new key approved)', () => {
    const reseal = between('  const resealAt = async (', "const note = notesStore.notes().find(n => n.id === props.noteId);");
    firstIn(reseal, 'const first = await notebookBeforeItsNotes({', WRITES);
    for (const handed of HANDED_OVER('nbId')) expect(reseal).toContain(handed);
    // The stop returns before anything of the notes is shared, with ONE exception: a right
    // being taken away is taken from the notes all the same (otherwise the notebook's own
    // row says "view" while every note in it stays writable).
    const stop = reseal.slice(reseal.indexOf('if (!first.go) {'), reseal.indexOf('for (const child of notebookChildren()) {\n          await shareOneNote(child, addr, entry.sharing_public_key, entry.user_id, entry.signing_public_key, notePerm);'));
    expect(stop).toContain("if (opts.lowering) {\n            for (const child of notebookChildren()) {\n              await shareOneNote(child, addr, entry.sharing_public_key, entry.user_id, entry.signing_public_key, 'view');\n            }\n          }");
    expect(stop).toContain("const say = sayStop(first.why, addr);\n          return say.upgrade ? { ok: false, error: '', upgrade: true } : { ok: false, error: say.error };\n        }");
    // Nothing else of the notes before the stop, and never at the right being GIVEN.
    expect(stop.match(/shareOneNote\(/g)).toHaveLength(1);
    expect(stop).not.toContain('notePerm);');
    // Only a change to "Can view" of someone who held more says so.
    expect(PANEL).toContain("}, { lowering: next === 'view' && share.permission !== 'view' });");
    expect(PANEL.match(/lowering:/g)).toHaveLength(1);
    // A single note's change shows the upgrade prompt for a 402, like a notebook's.
    expect(reseal + PANEL.slice(PANEL.indexOf("const note = notesStore.notes().find(n => n.id === props.noteId);"))).toContain(
      "return r.status === 402 ? { ok: false, error: '', upgrade: true } : { ok: false, error: r.error };");
    // Each of its four callers shows that through the one helper: the upgrade prompt, or the words.
    expect(PANEL).toContain("const showWhyNot = (r: { error: string; upgrade?: true }) => {\n    if (r.upgrade) { setStatus('upgrade'); return; }\n    setStatus('error');\n    setErrorMsg(r.error);\n  };");
    expect(PANEL.match(/showWhyNot\(r\);/g)).toHaveLength(4);
    expect(PANEL.match(/await resealAt\(/g)).toHaveLength(4);
  });

  /** This path reads the directory's answer as every other path does, not by hand (which
   * throws on one in no known shape).
   */
  it('a change of right reads the directory as every other path does', () => {
    const change = between('  const handleChangePermission = async (', '  // --- Changed keys: the SENDER side');
    expect(change).toContain('const looked = readRecipientLookup(');
    expect(change).toContain("if (!looked.answered) {\n        setStatus('error');\n        setErrorMsg(DID_NOT_GO_THROUGH);\n        return;\n      }");
    expect(change).not.toContain('keyLookup.data.users');
    // Both lookups of the panel name this account, so that its own entry is never taken for the recipient's.
    expect(PANEL.match(/me\?\.id \?\? null,/g)).toHaveLength(2);
  });

  it('and nowhere else does the panel end a removal or share a notebook as an object', () => {
    expect(PANEL.match(/cancelNotebookRemoval\(/g)).toHaveLength(2);
    expect(PANEL.match(/shareNotebookWithRecipientResult\(/g)).toHaveLength(2);
    expect(PANEL).not.toContain('shareNotebookWithRecipient(');
    expect(PANEL.match(/notebookBeforeItsNotes\(\{/g)).toHaveLength(2);
  });
});
