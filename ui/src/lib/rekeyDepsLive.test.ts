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

/**
 * The notebook's own part of a removal, as every drain retries it: the
 * roster is read from the server first, and the step only counts as landed when
 * the roster and the object both no longer hold the job's people.
 */

const refreshNotebookItem = vi.fn();
/** This session's pulls, and the waiters on them (notebooks.ts nextPullEvent). */
const pulls = { any: false, full: false, waiters: [] as Array<() => void> };
/** A finished pull, or a reset: every waiter wakes. */
function pullEvent(set: Partial<{ any: boolean; full: boolean }> = {}) {
  Object.assign(pulls, set);
  const w = pulls.waiters;
  pulls.waiters = [];
  w.forEach(f => f());
}
vi.mock('../stores/notebooks', () => ({
  notebooksStore: {
    refreshNotebookItem: (...a: unknown[]) => refreshNotebookItem(...a),
    holdRemovals: vi.fn(async () => true),
    hasPulled: (full = false) => (full ? pulls.full : pulls.any),
    nextPullEvent: () => new Promise<void>(r => { pulls.waiters.push(r); }),
  },
}));
const revokeNotebookAccess = vi.fn();
const revokeNotebookObjectShare = vi.fn();
vi.mock('./notebookRemoval', () => ({
  revokeNotebookAccess: (...a: unknown[]) => revokeNotebookAccess(...a),
  revokeNotebookObjectShare: (...a: unknown[]) => revokeNotebookObjectShare(...a),
}));
vi.mock('./noteDb', () => ({ listRekeyJobs: vi.fn(), saveRekeyJob: vi.fn(), deleteRekeyJob: vi.fn() }));
const rotateContentKey = vi.fn();
vi.mock('./shareUtils', () => ({ rotateContentKey: (...a: unknown[]) => rotateContentKey(...a) }));
const apiRequest = vi.fn();
vi.mock('./apiClient', () => ({ apiRequest: (...a: unknown[]) => apiRequest(...a) }));
/** The notes in memory. */
let memory: { id: string }[] = [];
const requestFullPull = vi.fn();
vi.mock('../stores/notes', () => ({
  notesStore: { notes: () => memory, requestFullPull: () => requestFullPull(), notebookNoteIds: () => null },
}));

const { rekeyDeps, pulledFor, drainAgainAfterFullPull, jobsInMemory } = await import('./rekeyDepsLive');
const { createJob, mergeRemoval } = await import('./rekeyQueue');
const { setTabAccount } = await import('./account');

const NB = '11111111-1111-4111-8111-111111111111';
const job = mergeRemoval(createJob({ notebookId: NB, removedRecipient: 'x@example.test', noteIds: [], nowMs: 1 }),
  { removedRecipient: 'z@example.test', noteIds: [] });
const landed = { rosterUpdated: true, objectRevoked: true, objectRotated: true, removedUserId: null };

beforeEach(() => {
  vi.clearAllMocks();
  revokeNotebookAccess.mockResolvedValue(landed);
  revokeNotebookObjectShare.mockResolvedValue({ revoked: true, rotated: false });
  Object.assign(pulls, { any: false, full: false, waiters: [] });
  memory = [];
});

describe("the notebook's own part, retried", () => {
  it('reads the roster from the server before taking anyone out of it', async () => {
    refreshNotebookItem.mockResolvedValue('live');

    expect(await rekeyDeps.revokeObject(job)).toBe(true);

    expect(refreshNotebookItem).toHaveBeenCalledWith(NB);
    expect(refreshNotebookItem.mock.invocationCallOrder[0]).toBeLessThan(revokeNotebookAccess.mock.invocationCallOrder[0]);
    expect(revokeNotebookAccess.mock.calls.map(c => c[1])).toEqual(['x@example.test', 'z@example.test']);
  });

  it('has not landed while the roster or the object still holds anyone', async () => {
    refreshNotebookItem.mockResolvedValue('live');
    revokeNotebookAccess.mockResolvedValueOnce(landed).mockResolvedValueOnce({ ...landed, rosterUpdated: false });
    expect(await rekeyDeps.revokeObject(job)).toBe(false);

    revokeNotebookAccess.mockResolvedValueOnce({ ...landed, objectRevoked: false }).mockResolvedValueOnce(landed);
    expect(await rekeyDeps.revokeObject(job)).toBe(false);
  });

  it('has not landed when the notebook could not be read, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    refreshNotebookItem.mockResolvedValue('failed');

    expect(await rekeyDeps.revokeObject(job)).toBe(false);
    expect(revokeNotebookAccess).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(c => String(c[0]).includes(`notebook ${NB} could not be read`))).toBe(true);
    warn.mockRestore();
  });

  it('is done for a notebook that is gone', async () => {
    refreshNotebookItem.mockResolvedValue('gone');

    expect(await rekeyDeps.revokeObject(job)).toBe(true);
    expect(revokeNotebookAccess).not.toHaveBeenCalled();
  });

  it("revokes a deleted notebook's object rows, and leaves its roster", async () => {
    refreshNotebookItem.mockResolvedValue('deleted');
    revokeNotebookObjectShare.mockResolvedValueOnce({ revoked: true, rotated: false }).mockResolvedValueOnce({ revoked: false, rotated: false });

    expect(await rekeyDeps.revokeObject(job)).toBe(false);
    expect(revokeNotebookObjectShare.mock.calls.map(c => c[1])).toEqual(['x@example.test', 'z@example.test']);
    expect(revokeNotebookAccess).not.toHaveBeenCalled();
  });
});

describe('one note, taken off the removed people', () => {
  const NOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const theirs = [
    { id: 's-x', recipient_email: 'X@Example.test', permission: 'edit' },
    { id: 's-z', recipient_email: 'z@example.test', permission: 'view' },
  ];
  const stays = { id: 's-y', recipient_email: 'y@example.test', permission: 'edit' };
  /** The server, as a test sets it: the share lists in turn (the last repeats), the item, the DELETEs. */
  let lists: unknown[];
  let item: unknown;
  let deleteStatus: (id: string) => { success: boolean; status?: number };
  const calls = () => apiRequest.mock.calls.map(c => `${c[1]?.method ?? 'GET'} ${c[0]}`);
  beforeEach(() => {
    lists = [{ success: true, data: [...theirs, stays] }];
    item = { success: true, data: { id: NOTE, deleted: false } };
    deleteStatus = () => ({ success: true });
    apiRequest.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === `/api/v1/items/${NOTE}/shares`) return lists.length > 1 ? lists.shift() : lists[0];
      if (url === `/api/v1/items/${NOTE}`) return item;
      const del = url.match(/^\/api\/v1\/shares\/([^?]+)\?reason=notebook_removal$/);
      if (del && opts?.method === 'DELETE') return deleteStatus(del[1]);
      return { success: false, status: 404 };
    });
    rotateContentKey.mockResolvedValue({ rotated: true });
  });

  it('is done when the server lists none of their rows on it, with nothing else asked', async () => {
    lists = [{ success: true, data: [stays] }];
    expect(await rekeyDeps.rotate(NOTE, job)).toBe(true);
    expect(calls()).toEqual([`GET /api/v1/items/${NOTE}/shares`]);
  });

  it("stays when the server's list can't be read", async () => {
    lists = [{ success: false, status: 500 }];
    expect(await rekeyDeps.rotate(NOTE, job)).toBe(false);
    expect(calls()).toEqual([`GET /api/v1/items/${NOTE}/shares`]);
  });

  it('rotates a live note that opens here without them: done on the rotation\'s answer only', async () => {
    memory = [{ id: NOTE }];
    expect(await rekeyDeps.rotate(NOTE, job)).toBe(true);
    expect(rotateContentKey).toHaveBeenCalledWith(NOTE, ['s-x', 's-z'], 'notebook_removal');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rotateContentKey.mockResolvedValue({ rotated: false });
    expect(await rekeyDeps.rotate(NOTE, job)).toBe(false);
    warn.mockRestore();
    expect(calls().filter(c => c.startsWith('DELETE'))).toEqual([]);
  });

  /**
   * The new key cannot be signed for someone who stays, or the note's key does
   * not open here. Nothing is sent for such a re-key; once the removal has
   * waited long enough, their rows are revoked without one, as for a note that
   * cannot be re-keyed here, and it is done when the list read again holds
   * none. Before that, it stays.
   */
  it('a re-key that cannot be signed, or whose key does not open here: their rows revoked once the removal has waited, not before', async () => {
    const { REKEY_WAIT_MS } = await import('./rekeyDepsLive');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    memory = [{ id: NOTE }];
    for (const why of [{ couldNotSign: true }, { notOpenHere: true }]) {
      rotateContentKey.mockResolvedValue({ rotated: false, ...why });
      apiRequest.mockClear();
      const fresh = { ...job, startedAt: Date.now() - REKEY_WAIT_MS + 60_000 };
      lists = [{ success: true, data: [...theirs, stays] }];
      expect(await rekeyDeps.rotate(NOTE, fresh)).toBe(false);
      expect(calls().filter(c => c.startsWith('DELETE'))).toEqual([]);

      apiRequest.mockClear();
      const waited = { ...job, startedAt: Date.now() - REKEY_WAIT_MS };
      lists = [{ success: true, data: [...theirs, stays] }, { success: true, data: [stays] }];
      expect(await rekeyDeps.rotate(NOTE, waited)).toBe(true);
      expect(calls().filter(c => c.startsWith('DELETE'))).toEqual([
        'DELETE /api/v1/shares/s-x?reason=notebook_removal', 'DELETE /api/v1/shares/s-z?reason=notebook_removal',
      ]);
    }
    // Any other failure (the connection, a refusal, a change elsewhere) is tried again, however long it has waited.
    for (const why of [{}, { refused: true }, { changedElsewhere: true }]) {
      rotateContentKey.mockResolvedValue({ rotated: false, ...why });
      apiRequest.mockClear();
      lists = [{ success: true, data: [...theirs, stays] }];
      expect(await rekeyDeps.rotate(NOTE, { ...job, startedAt: 1 })).toBe(false);
      expect(calls().filter(c => c.startsWith('DELETE'))).toEqual([]);
    }
    warn.mockRestore();
  });

  /** The item is read from a replica; just after its rows were listed, a 404 is lag, not "gone". */
  it('stays on a 404 for the item, as on any failure: no rotation, no revoke', async () => {
    memory = [{ id: NOTE }];
    for (const status of [404, 500]) {
      item = { success: false, status };
      expect(await rekeyDeps.rotate(NOTE, job)).toBe(false);
    }
    expect(rotateContentKey).not.toHaveBeenCalled();
    expect(calls().filter(c => c.startsWith('DELETE'))).toEqual([]);
  });

  it('revokes their rows on a note in the trash, never rotating it, and is done when the list read again holds none', async () => {
    memory = [{ id: NOTE }];
    item = { success: true, data: { id: NOTE, deleted: true } };
    lists = [{ success: true, data: [...theirs, stays] }, { success: true, data: [stays] }];

    expect(await rekeyDeps.rotate(NOTE, job)).toBe(true);
    expect(rotateContentKey).not.toHaveBeenCalled();
    expect(calls()).toEqual([
      `GET /api/v1/items/${NOTE}/shares`, `GET /api/v1/items/${NOTE}`,
      'DELETE /api/v1/shares/s-x?reason=notebook_removal', 'DELETE /api/v1/shares/s-z?reason=notebook_removal',
      `GET /api/v1/items/${NOTE}/shares`,
    ]);
  });

  /** A DELETE's answer decides nothing; the list read again does. */
  it('stays after the revoke while the list read again still holds one of theirs, or can\'t be read, whatever the DELETEs said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    item = { success: true, data: { id: NOTE, deleted: true } };
    deleteStatus = () => ({ success: false, status: 404 });
    lists = [{ success: true, data: [...theirs] }, { success: true, data: [theirs[1]] }];
    expect(await rekeyDeps.rotate(NOTE, job)).toBe(false);

    deleteStatus = () => ({ success: true });
    lists = [{ success: true, data: [...theirs] }, { success: false, status: 500 }];
    expect(await rekeyDeps.rotate(NOTE, job)).toBe(false);

    deleteStatus = () => ({ success: false, status: 404 });
    lists = [{ success: true, data: [...theirs] }, { success: true, data: [] }];
    expect(await rekeyDeps.rotate(NOTE, job)).toBe(true);
    warn.mockRestore();
  });

  it('waits for a full pull before taking a note memory lacks for one that does not open here', async () => {
    expect(await rekeyDeps.rotate(NOTE, job)).toBe(false);
    expect(requestFullPull).toHaveBeenCalled();
    expect(calls().filter(c => c.startsWith('DELETE'))).toEqual([]);
    expect(rotateContentKey).not.toHaveBeenCalled();
  });

  /** After a full pull, memory holds every note that opens here; one it lacks can't be re-keyed here. */
  it('revokes their rows on a note that does not open here, once a full pull says so', async () => {
    pulls.full = true;
    lists = [{ success: true, data: [...theirs, stays] }, { success: true, data: [stays] }];

    expect(await rekeyDeps.rotate(NOTE, job)).toBe(true);
    expect(rotateContentKey).not.toHaveBeenCalled();
    expect(calls().filter(c => c.startsWith('DELETE'))).toEqual([
      'DELETE /api/v1/shares/s-x?reason=notebook_removal', 'DELETE /api/v1/shares/s-z?reason=notebook_removal',
    ]);
  });
});

describe('waiting for a pull of this session', () => {
  const ME = '0e0e0e0e-0000-4000-8000-0000000000aa';
  const OTHER = '0e0e0e0e-0000-4000-8000-0000000000bb';
  beforeEach(() => setTabAccount(ME));

  it('goes on at the first pull for the same account', async () => {
    const waiting = pulledFor(ME, false);
    pullEvent({ any: true });
    expect(await waiting).toBe(true);
  });

  it('is parked again by a reset for the same account, not stranded: it goes on at the next pull', async () => {
    let done: boolean | null = null;
    void pulledFor(ME, false).then(r => { done = r; });
    pullEvent(); // a reset: no pull
    await new Promise(r => setTimeout(r, 5));
    expect(done).toBeNull();
    expect(pulls.waiters.length).toBe(1);
    pullEvent({ any: true });
    await vi.waitFor(() => expect(done).toBe(true));
  });

  it('stops when the account changed meanwhile, or there is none', async () => {
    const waiting = pulledFor(ME, false);
    setTabAccount(OTHER);
    pullEvent({ any: true });
    expect(await waiting).toBe(false);
    expect(await pulledFor(null, false)).toBe(false);
  });

  it('with `full`, waits past an incremental pull for a full one', async () => {
    let done: boolean | null = null;
    void pulledFor(ME, true).then(r => { done = r; });
    pullEvent({ any: true });
    await new Promise(r => setTimeout(r, 5));
    expect(done).toBeNull();
    pullEvent({ full: true });
    await vi.waitFor(() => expect(done).toBe(true));
  });
});

describe('draining again after a full pull', () => {
  const ME = '0e0e0e0e-0000-4000-8000-0000000000aa';
  beforeEach(() => setTabAccount(ME));
  /** Jobs held in memory, drained through a rotation that answers per note. */
  function deps(rotate: (id: string) => boolean) {
    const d = jobsInMemory({ ...rekeyDeps, rotate: async id => rotate(id), revokeObject: async () => true, dropFromStandingList: async () => true, listNotebookNotes: async () => [] });
    return d;
  }

  it('asks for nothing when this session already has one, or no job is left', async () => {
    pulls.full = true;
    const d = deps(() => true);
    await d.saveJob(createJob({ notebookId: NB, removedRecipient: 'x@example.test', noteIds: ['n1'], nowMs: 1 }));
    await drainAgainAfterFullPull(d, ME);
    pulls.full = false;
    await drainAgainAfterFullPull(deps(() => true), ME);
    expect(requestFullPull).not.toHaveBeenCalled();
  });

  it('asks for one, waits for it, then drains what is left', async () => {
    const rotated: string[] = [];
    const d = deps(id => { rotated.push(id); return true; });
    await d.saveJob(createJob({ notebookId: NB, removedRecipient: 'x@example.test', noteIds: ['n1'], nowMs: 1 }));

    const done = drainAgainAfterFullPull(d, ME);
    await vi.waitFor(() => expect(requestFullPull).toHaveBeenCalled());
    expect(rotated).toEqual([]);
    pullEvent({ any: true, full: true });
    await done;

    expect(rotated).toEqual(['n1']);
    expect(await d.listJobs()).toEqual([]);
  });

  it("drains nothing for an account that is no longer the tab's", async () => {
    const rotated: string[] = [];
    const d = deps(id => { rotated.push(id); return true; });
    await d.saveJob(createJob({ notebookId: NB, removedRecipient: 'x@example.test', noteIds: ['n1'], nowMs: 1 }));

    const done = drainAgainAfterFullPull(d, ME);
    await vi.waitFor(() => expect(requestFullPull).toHaveBeenCalled());
    setTabAccount('0e0e0e0e-0000-4000-8000-0000000000bb');
    pullEvent({ any: true, full: true });
    await done;

    expect(rotated).toEqual([]);
  });
});
