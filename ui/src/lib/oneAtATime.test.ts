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

import { describe, it, expect } from 'vitest';
import { oneAtATime, type RunControl } from './oneAtATime';

/** A task the test ends by hand, and a record of what ran when. */
function harness(patienceMs?: number) {
  const clock = { t: 1_000 };
  const runs: { end: () => void; fail: (e: unknown) => void; ended: boolean; inCharge: () => boolean; alive: () => void }[] = [];
  /** What was set to run later, and when: nothing runs until a test says the time has come (`timeIs`). */
  const timers: { at: number; run: () => void; ms: number }[] = [];
  let together = 0;
  let mostTogether = 0;
  const task = (ctl: RunControl) => {
    together++;
    mostTogether = Math.max(mostTogether, together);
    return new Promise<void>((resolve, reject) => {
      const run = {
        ended: false,
        inCharge: ctl.inCharge,
        alive: ctl.alive,
        end: () => { run.ended = true; together--; resolve(); },
        fail: (e: unknown) => { run.ended = true; together--; reject(e); },
      };
      runs.push(run);
    });
  };
  const later = (run: () => void, ms: number) => { timers.push({ at: clock.t + ms, run, ms }); };
  const ask = patienceMs === undefined ? oneAtATime(task, undefined, undefined, later) : oneAtATime(task, patienceMs, () => clock.t, later);
  /** Move the clock on, and run what was set for a time that has come (and what THAT sets, if its time has come too). */
  const timeIs = (t: number) => {
    clock.t = t;
    for (;;) {
      const due = timers.find(x => x.at <= t);
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.run();
    }
  };
  return { ask, runs, clock, timers, timeIs, mostTogether: () => mostTogether };
}
/** Let everything already settled reach whoever waits for it. */
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** What became of a promise so far. */
function watch(p: Promise<void>) {
  const state = { done: false, failed: null as unknown };
  p.then(() => { state.done = true; }, (e) => { state.done = true; state.failed = e; });
  return state;
}

describe('one at a time', () => {
  it('starts at once when nothing is running, before the call returns', () => {
    const { ask, runs } = harness();
    void ask();
    expect(runs).toHaveLength(1);
  });

  it('a call during a run starts nothing: it waits for a follow-up that starts when the run ends', async () => {
    const { ask, runs } = harness();
    const first = watch(ask());
    const second = watch(ask());
    await settle();
    expect(runs).toHaveLength(1);
    expect(second.done).toBe(false);

    runs[0].end();
    await settle();
    expect(first.done).toBe(true);
    // The follow-up has started, and the caller who asked during the first run
    // is NOT answered by the first run's end: that run may have read the
    // server before they wrote what they want synced.
    expect(runs).toHaveLength(2);
    expect(second.done).toBe(false);

    runs[1].end();
    await settle();
    expect(second.done).toBe(true);
    expect(runs).toHaveLength(2);
  });

  it('however many ask during a run, ONE follow-up serves them all', async () => {
    const { ask, runs, mostTogether } = harness();
    void ask();
    const waiting = [ask(), ask(), ask(), ask(), ask()].map(watch);
    runs[0].end();
    await settle();
    expect(runs).toHaveLength(2);
    expect(waiting.every(w => !w.done)).toBe(true);
    runs[1].end();
    await settle();
    expect(waiting.every(w => w.done && w.failed === null)).toBe(true);
    expect(runs).toHaveLength(2);
    expect(mostTogether()).toBe(1);
  });

  it('a call during the follow-up waits for another one', async () => {
    const { ask, runs, mostTogether } = harness();
    void ask();
    void ask();
    runs[0].end();
    await settle();
    const third = watch(ask());
    await settle();
    expect(runs).toHaveLength(2);
    runs[1].end();
    await settle();
    expect(runs).toHaveLength(3);
    expect(third.done).toBe(false);
    runs[2].end();
    await settle();
    expect(third.done).toBe(true);
    expect(mostTogether()).toBe(1);
  });

  /**
   * The moment that matters: the run has ended and the follow-up is about to
   * start. A call that lands there must not find "nothing running" and start a
   * run of its own beside the follow-up. Tried at every step after the end.
   */
  it('never two at once, whenever the next call lands after a run ends', async () => {
    for (let steps = 0; steps <= 12; steps++) {
      const { ask, runs, mostTogether } = harness();
      void ask();
      void ask();
      runs[0].end();
      for (let i = 0; i < steps; i++) await Promise.resolve();
      void ask();
      await settle();
      expect(mostTogether(), `a call ${steps} step(s) after the end`).toBe(1);
      // End whatever is running until nothing is: every run was needed, none overlapped.
      for (let guard = 0; guard < 5; guard++) {
        const open = runs.filter(r => !r.ended);
        if (open.length === 0) break;
        expect(open, `a call ${steps} step(s) after the end`).toHaveLength(1);
        open[0].end();
        await settle();
      }
      expect(runs.every(r => r.ended)).toBe(true);
      expect(runs.length, `a call ${steps} step(s) after the end`).toBeLessThanOrEqual(3);
    }
  });

  it('once everything has ended, the next call starts at once', async () => {
    const { ask, runs } = harness();
    void ask();
    void ask();
    runs[0].end();
    await settle();
    runs[1].end();
    await settle();
    void ask();
    expect(runs).toHaveLength(3);
  });

  it('a run that fails tells its own caller, and the follow-up still runs', async () => {
    const { ask, runs } = harness();
    const first = watch(ask());
    const second = watch(ask());
    runs[0].fail(new Error('first'));
    await settle();
    expect((first.failed as Error).message).toBe('first');
    expect(runs).toHaveLength(2);
    expect(second.done).toBe(false);
    runs[1].end();
    await settle();
    expect(second.done).toBe(true);
    expect(second.failed).toBeNull();
  });

  it('a follow-up that fails tells those who waited for it, and the next call starts afresh', async () => {
    const { ask, runs } = harness();
    const first = watch(ask());
    const second = watch(ask());
    const third = watch(ask());
    runs[0].end();
    await settle();
    runs[1].fail(new Error('follow-up'));
    await settle();
    expect(first.failed).toBeNull();
    expect((second.failed as Error).message).toBe('follow-up');
    expect((third.failed as Error).message).toBe('follow-up');
    void ask();
    expect(runs).toHaveLength(3);
  });

  it('a task that throws before its first await is a failure like any other, and does not block the next', async () => {
    let calls = 0;
    const ask = oneAtATime(() => {
      calls++;
      if (calls === 1) throw new Error('at once');
      return Promise.resolve();
    });
    const first = watch(ask());
    await settle();
    expect((first.failed as Error).message).toBe('at once');
    const second = watch(ask());
    await settle();
    expect(calls).toBe(2);
    expect(second.done).toBe(true);
    expect(second.failed).toBeNull();
  });
});

/**
 * A run that has gone QUIET is given up on: whoever waits for a sync before
 * going on (an import, the page's first load) would otherwise wait for as long
 * as it takes. Quiet, not long: see the next block.
 */
const T0 = 1_000;
const MIN = 60_000;

describe('a run that shows no sign of life is given up on', () => {
  it('just under the limit a call still waits behind it', async () => {
    const { ask, runs, clock } = harness(MIN);
    void ask();
    clock.t += MIN - 1;
    void ask();
    await settle();
    expect(runs).toHaveLength(1);
  });

  it('at the limit the next call starts a run in its place, and those already waiting are answered by that run', async () => {
    const { ask, runs, clock } = harness(MIN);
    void ask();
    const waited = watch(ask());
    clock.t += MIN;
    const late = watch(ask());
    expect(runs).toHaveLength(2);
    await settle();
    expect(waited.done).toBe(false);
    runs[1].end();
    await settle();
    expect(late.done).toBe(true);
    expect(waited.done).toBe(true);
    expect(waited.failed).toBeNull();
  });

  /**
   * A run in place of a quiet one starts by itself: if only a new CALL
   * started it, a sync with one caller and nobody else asking (the page's
   * first load) would stay stuck for good.
   */
  it('when its time is up a run starts in its place by itself, with nobody else asking', async () => {
    const { ask, runs, timeIs } = harness(MIN);
    const first = watch(ask());
    timeIs(T0 + MIN - 1);
    expect(runs).toHaveLength(1);
    timeIs(T0 + MIN);
    expect(runs).toHaveLength(2);
    runs[1].end();
    await settle();
    expect(first.done).toBe(true);
    expect(first.failed).toBeNull();
  });

  /**
   * The run that was given up on can end by itself a moment later, having
   * applied nothing (it was told it is no longer in charge): its own callers
   * must not be told "synced" by that end.
   */
  it("its own callers are answered by the run that took over, never by its own end", async () => {
    const { ask, runs, timeIs } = harness(MIN);
    const first = watch(ask());
    const behind = watch(ask());
    timeIs(T0 + MIN);
    expect(runs).toHaveLength(2);
    // The quiet run comes to an end at last: nobody is freed by that, and nothing starts.
    runs[0].end();
    await settle();
    expect(first.done).toBe(false);
    expect(behind.done).toBe(false);
    expect(runs).toHaveLength(2);
    runs[1].end();
    await settle();
    expect(first.done).toBe(true);
    expect(behind.done).toBe(true);
  });

  it('a quiet run that FAILS later fails nobody either', async () => {
    const { ask, runs, timeIs } = harness(MIN);
    const first = watch(ask());
    timeIs(T0 + MIN);
    runs[0].fail(new Error('the connection gave up'));
    await settle();
    expect(first.done).toBe(false);
    runs[1].end();
    await settle();
    expect(first.done).toBe(true);
    expect(first.failed).toBeNull();
  });

  it('when the run that took over fails, everybody it answers for is told', async () => {
    const { ask, runs, timeIs } = harness(MIN);
    const first = watch(ask());
    const behind = watch(ask());
    timeIs(T0 + MIN);
    runs[1].fail(new Error('offline'));
    await settle();
    expect(String(first.failed)).toContain('offline');
    expect(String(behind.failed)).toContain('offline');
  });

  it('a call during the run that took over waits for ITS follow-up, as ever', async () => {
    const { ask, runs, clock } = harness(MIN);
    void ask();
    clock.t += MIN;
    void ask();
    const third = watch(ask());
    runs[0].end();
    await settle();
    expect(runs).toHaveLength(2);
    runs[1].end();
    await settle();
    expect(runs).toHaveLength(3);
    expect(third.done).toBe(false);
    runs[2].end();
    await settle();
    expect(third.done).toBe(true);
  });

  /** A follow-up serves the callers who waited for it; left without a timer it could keep them for good. */
  it('a follow-up that goes quiet is given up on like any run', async () => {
    const { ask, runs, clock, timeIs } = harness(MIN);
    void ask();
    const waited = watch(ask());
    clock.t += 10_000;
    runs[0].end();
    await settle();
    expect(runs).toHaveLength(2);
    timeIs(T0 + 10_000 + MIN - 1);
    expect(runs).toHaveLength(2);
    timeIs(T0 + 10_000 + MIN);
    expect(runs).toHaveLength(3);
    runs[2].end();
    await settle();
    expect(waited.done).toBe(true);
  });

  it('a run that ended in time is not looked at again', async () => {
    const { ask, runs, timeIs } = harness(MIN);
    void ask();
    runs[0].end();
    await settle();
    timeIs(T0 + 10 * MIN);
    expect(runs).toHaveLength(1);
  });

  it('never more than two at once: the quiet one and the one in its place', async () => {
    const { ask, runs, timeIs, mostTogether } = harness(MIN);
    void ask();
    timeIs(T0 + MIN);
    void ask();
    void ask();
    await settle();
    expect(runs).toHaveLength(2);
    expect(mostTogether()).toBe(2);
  });

  it('waits a minute unless told otherwise, and its timer is a real one', async () => {
    // The defaults, read from the source: the number is a decision, not a detail.
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const text = readFileSync(join(__dirname, 'oneAtATime.ts'), 'utf8');
    expect(text).toContain('  patienceMs = 60_000,');
    expect(text).toContain('later: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),');
  });
});

/**
 * QUIET, not long. Counting from the run's start, together with a run that
 * was given up on applying nothing more, would cut off every sync that
 * honestly needs longer than the limit (a first sync of a large account),
 * again and again, with nothing kept.
 */
describe('a run that keeps showing signs of life is never given up on', () => {
  it('however long it runs, and however many ask meanwhile', async () => {
    const { ask, runs, timeIs } = harness(MIN);
    const first = watch(ask());
    const behind = watch(ask());
    // Ten minutes, with something back from the server every 45 seconds.
    for (let t = T0 + 45_000; t <= T0 + 10 * MIN; t += 45_000) {
      timeIs(t);
      void ask();
      runs[0].alive();
    }
    await settle();
    expect(runs).toHaveLength(1);
    expect(runs[0].inCharge()).toBe(true);
    expect(first.done).toBe(false);
    runs[0].end();
    await settle();
    expect(first.done).toBe(true);
    // And then the ONE follow-up, for everybody who asked.
    expect(runs).toHaveLength(2);
    runs[1].end();
    await settle();
    expect(behind.done).toBe(true);
  });

  it('the limit is counted from the last sign of life, for a call', () => {
    const { ask, runs, clock } = harness(MIN);
    void ask();
    clock.t = T0 + 50_000;
    runs[0].alive();
    clock.t = T0 + 50_000 + MIN - 1;
    void ask();
    expect(runs).toHaveLength(1);
    clock.t = T0 + 50_000 + MIN;
    void ask();
    expect(runs).toHaveLength(2);
  });

  it('and for the timer, which looks again when the patience since that sign would be up', () => {
    const { ask, runs, clock, timers, timeIs } = harness(MIN);
    void ask();
    expect(timers.map(t => t.at)).toEqual([T0 + MIN]);
    clock.t = T0 + 30_000;
    runs[0].alive();
    timeIs(T0 + MIN);
    // Quiet for 30 s only: nothing starts, and it looks again 30 s later.
    expect(runs).toHaveLength(1);
    expect(timers.map(t => t.at)).toEqual([T0 + 30_000 + MIN]);
    clock.t = T0 + 80_000;
    runs[0].alive();
    timeIs(T0 + 30_000 + MIN);
    expect(runs).toHaveLength(1);
    expect(timers.map(t => t.at)).toEqual([T0 + 80_000 + MIN]);
    // And now nothing more comes.
    timeIs(T0 + 80_000 + MIN);
    expect(runs).toHaveLength(2);
  });

  it('one timer for a run at a time, however many ask', () => {
    const { ask, timers } = harness(MIN);
    void ask();
    void ask();
    void ask();
    expect(timers).toHaveLength(1);
  });

  it("a sign of life from a run that was given up on does not keep it, or the new one, alive", () => {
    const { ask, runs, clock, timeIs } = harness(MIN);
    void ask();
    timeIs(T0 + MIN);
    expect(runs).toHaveLength(2);
    // The old run wakes and says so; the run in charge has said nothing for a minute.
    clock.t = T0 + 2 * MIN - 1;
    runs[0].alive();
    timeIs(T0 + 2 * MIN);
    expect(runs).toHaveLength(3);
    expect(runs[0].inCharge()).toBe(false);
  });
});

/**
 * The run that was given up on is still going. Asked, it learns
 * that it is no longer in charge and applies nothing more (stores/notes.ts
 * `syncOnce`).
 */
describe('a run knows whether it is still the one in charge', () => {
  it('it is, for as long as it has not been given up on', () => {
    const { ask, runs, clock } = harness(MIN);
    void ask();
    expect(runs[0].inCharge()).toBe(true);
    clock.t += MIN - 1;
    void ask();
    expect(runs[0].inCharge()).toBe(true);
  });

  it('it is not once a run was started in its place, by a call or by the timer; the new one is', () => {
    const byCall = harness(MIN);
    void byCall.ask();
    byCall.clock.t += MIN;
    void byCall.ask();
    expect(byCall.runs[0].inCharge()).toBe(false);
    expect(byCall.runs[1].inCharge()).toBe(true);

    const byTimer = harness(MIN);
    void byTimer.ask();
    byTimer.timeIs(T0 + MIN);
    expect(byTimer.runs[0].inCharge()).toBe(false);
    expect(byTimer.runs[1].inCharge()).toBe(true);
  });

  it('a follow-up is in charge in its turn', async () => {
    const { ask, runs } = harness(MIN);
    void ask();
    void ask();
    runs[0].end();
    await settle();
    expect(runs[1].inCharge()).toBe(true);
  });
});
