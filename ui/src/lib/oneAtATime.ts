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
 * Run a task one at a time, however often it is asked for.
 *
 * Made for the notes sync. A sync is started by the page loading, by focus,
 * by coming back online, by a push, by opening "Shared with me" and by
 * closing a note, and two could otherwise run together. Each reads the whole
 * shares inbox and opens every share in it, and the page would keep one
 * answer and throw the other away: with a large inbox that is seconds of
 * work, on the page's only thread, for nothing.
 *
 * The rule a caller can rely on: **the promise it gets settles with a run that
 * STARTED at or after its call, and that was not given up on.** A run already
 * under way may have read the server before the caller wrote what it wants
 * synced (an import, a decline), so joining it would hand back an answer from
 * before the question. Whoever asks during a run therefore waits for ONE
 * follow-up, which starts the moment the run ends and serves everybody who
 * asked meanwhile.
 *
 * ## A run that has gone quiet
 *
 * A run that has shown no sign of life for `patienceMs` is given up on: a new
 * one starts in its place, for its own callers and for those waiting behind
 * it. Whoever waits for a sync before going on (an import, the page's first
 * load) would otherwise wait for as long as the quiet run takes.
 *
 * "No sign of life", not "running for long". The task says it is alive
 * (`run.alive()`) each time it gets something from the server. Counting from
 * the run's START, together with telling a run that was given up on to apply
 * nothing more, would cut off every sync that honestly needs longer than the
 * limit, a first sync of a large account for one, again and again, with
 * nothing kept.
 *
 * Quiet runs are rare since the request's own time limit covers its body
 * (lib/apiClient): this is the backstop for whatever else can hang.
 *
 * - It starts at the next call, or by itself when the quiet run's time is up
 *   (`later`).
 * - The run that was given up on is still going. If its answer arrives at
 *   last, it holds rows read long ago, and merged then they would go back over
 *   what the newer run has written. So the task can ask whether it is still
 *   the one in charge (`run.inCharge()`), and one that is not applies nothing
 *   more.
 * - Its callers are answered by the run that took over, never by its own end:
 *   that end has applied nothing, and "synced" would be false.
 */
export interface RunControl {
  /** False once this run has been given up on: it applies nothing more. */
  inCharge(): boolean;
  /** Something came back from the server: this run is not stuck. */
  alive(): void;
}

export function oneAtATime(
  task: (run: RunControl) => Promise<void>,
  patienceMs = 60_000,
  now: () => number = Date.now,
  later: (run: () => void, ms: number) => unknown = (run, ms) => setTimeout(run, ms),
): () => Promise<void> {
  interface Callers { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void }
  interface Run { alive: number; callers: Callers }
  /** The run in charge. */
  let running: Run | null = null;
  /** Everybody who asked during it: served by one follow-up. */
  let waiting: Callers | null = null;

  const callers = (): Callers => {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    // Whoever holds this promise handles its failure. A run started by the
    // timer may have nobody left holding it, and that is not an error to raise.
    promise.catch(() => {});
    return { promise, resolve, reject };
  };

  const start = (mine: Callers): void => {
    const me: Run = { alive: now(), callers: mine };
    running = me;
    watch(me);
    // An async wrapper, so that a task which throws before its first await is
    // a rejection like any other and cannot leave `running` set for good.
    (async () => task({ inCharge: () => running === me, alive: () => { me.alive = now(); } }))()
      .then(() => end(me, null), (reason) => end(me, { reason }));
  };

  const end = (me: Run, failure: { reason: unknown } | null): void => {
    // A run that was given up on: its callers went to the run that took over,
    // and the follow-up is that run's to start.
    if (running !== me) return;
    running = null;
    if (failure) me.callers.reject(failure.reason); else me.callers.resolve();
    if (waiting) {
      const next = waiting;
      waiting = null;
      // Started here, in the same step that ended the run: there is no
      // moment in between at which a call could find nothing running.
      start(next);
    }
  };

  /** Give up on the run in charge and start one in its place, for everybody. */
  const takeOver = (): Promise<void> => {
    const quiet = running!;
    const behind = waiting;
    waiting = null;
    const all = callers();
    all.promise.then(quiet.callers.resolve, quiet.callers.reject);
    if (behind) all.promise.then(behind.resolve, behind.reject);
    start(all);
    return all.promise;
  };

  /** Look at a run when its patience would be up, and again for as long as it shows life. */
  const watch = (me: Run): void => {
    const look = (): void => {
      if (running !== me) return;
      const quietFor = now() - me.alive;
      if (quietFor >= patienceMs) {
        void takeOver();
        return;
      }
      later(look, patienceMs - quietFor);
    };
    later(look, patienceMs);
  };

  return () => {
    if (!running) {
      const mine = callers();
      start(mine);
      return mine.promise;
    }
    if (now() - running.alive >= patienceMs) return takeOver();
    if (!waiting) waiting = callers();
    return waiting.promise;
  };
}
