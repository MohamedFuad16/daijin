// Jobs and the step-event stream.
//
// A long operation returns a jobId immediately and reports through `step` notifications.
// That shape is the whole reason the init feed and the gym live view can be a live
// activity feed rather than a frozen wait (plan: "Claude Code style live activity feed,
// never a frozen wait").
//
// `ts` is epoch milliseconds, per the v4 clock convention. Clients display offsets.

import { randomUUID } from 'node:crypto';

export const STEP_NOTIFICATION = 'step';

/**
 * Step names the RUNNER owns on a done-phase event. A job may not emit these.
 *
 * A client is told to trust `level` to learn HOW a job ended, which is only sound if the
 * runner is the sole author of the endings whose level carries meaning. Nothing stopped a
 * job emitting `done`/`failed` with `level: "info"` until this, and that pair is exactly
 * what a client following the guidance would believe: a failure rendered as a success,
 * forged by the job rather than reported by the runner.
 *
 * Raised by tui-builder as an assumption it was making and could not check from its side.
 * It was making it correctly, and the engine could not honour it, so the engine changed.
 */
export const RESERVED_DONE_STEPS = Object.freeze(['finished', 'failed', 'cancelled']);
export const BOARD_FINDING_NOTIFICATION = 'boardFinding';

/// One step event. The shape is the contract's, and `counts` is omitted rather than sent
/// empty so a client can distinguish "no counts for this step" from "zero of everything".
export function stepEvent({ jobId, phase, step, detail, counts = null, level = 'info', now = Date.now }) {
  const event = { ts: now(), jobId, phase, step, detail, level };
  if (counts) event.counts = counts;
  return event;
}

export class JobRunner {
  #jobs = new Map();
  #notify;
  #now;
  #sequence = 0;

  constructor({ notify, now = Date.now } = {}) {
    if (typeof notify !== 'function') throw new Error('JobRunner requires a notify function.');
    this.#notify = notify;
    this.#now = now;
  }

  get active() {
    return [...this.#jobs.keys()];
  }

  #nextId(prefix) {
    this.#sequence += 1;
    // The counter makes ids readable in a log; the uuid makes them unique across restarts.
    return `job-${prefix}-${String(this.#sequence).padStart(4, '0')}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Start a job. `work` receives an emitter and a cancellation probe.
   *
   * The work runs detached from the request: the caller gets its jobId back immediately,
   * which is what keeps a slow scan from blocking the whole stdio pipe behind it.
   */
  start(prefix, work) {
    const jobId = this.#nextId(prefix);
    const record = { jobId, cancelled: false, done: false, announced: false };
    this.#jobs.set(jobId, record);

    const emit = (phase, step, detail, extra = {}) => {
      // A cancelled job stops emitting: a feed that keeps scrolling after the user
      // cancelled reads as an engine that ignored them.
      if (record.cancelled) return;
      // AND A FINISHED JOB STOPS EMITTING. A job that keeps talking after it said it was
      // finished is the shape a client cannot recover from: it has already rendered the
      // ending, and the events arriving after it have no place to go. The rule is enforced
      // here rather than trusted of every job author, which is what turns the invariant
      // below from a convention into a property.
      if (record.announced) return;
      if (phase === 'done') {
        // A job announcing its own ending is normal (gatesDiscover does it). Announcing one
        // of the RUNNER'S endings is not: those three names are what a client reads to
        // learn how a job ended, and their level is only trustworthy while the runner is
        // the only author. Thrown rather than dropped, because a job doing this has a bug
        // and a silent drop would leave it believing it had reported something.
        if (RESERVED_DONE_STEPS.includes(step)) {
          throw new Error(`A job may not emit the reserved done step '${step}'; those are the runner's endings and a client reads their level to learn how the job ended.`);
        }
        record.announced = true;
      }
      this.#notify(STEP_NOTIFICATION, stepEvent({ jobId, phase, step, detail, now: this.#now, ...extra }));
    };
    const cancelled = () => record.cancelled;

    record.promise = (async () => {
      try {
        await work({ jobId, emit, cancelled });
        if (record.cancelled) {
          this.#notify(STEP_NOTIFICATION, stepEvent({
            jobId, phase: 'done', step: 'cancelled', detail: 'job cancelled by the user', level: 'warn', now: this.#now,
          }));
        } else if (!record.announced) {
          // THE INVARIANT: every job emits exactly one done-phase event. Filled in only
          // when the work did not announce its own, because a runner that always emitted
          // one would give gatesDiscover two and leave a client asking which is terminal,
          // which is a worse contract than none.
          //
          // Measured before it was designed: gatesDiscover ends with done/written, and a
          // successful initBrain ended with floor/floor-measured, a phase name rather than
          // an ending. So a client could observe a job ending exactly when it went wrong,
          // by failure or cancellation, and had to GUESS when it went right. Every client
          // then invents its own idle threshold; the two measured independently here were
          // 9.6s and 9.7s of real inter-event gap inside the floor phase, so an eight
          // second guess declares a live run finished mid-phase.
          this.#notify(STEP_NOTIFICATION, stepEvent({
            jobId, phase: 'done', step: 'finished', detail: 'job finished', now: this.#now,
          }));
        }
      } catch (error) {
        // A job failure is a step event, not a dropped connection. The request that
        // started it has long since returned its jobId, so this is the only channel the
        // user can learn about it on.
        //
        // EMITTED EVEN IF THE JOB ALREADY ANNOUNCED DONE, which is the one case where the
        // exactly-one invariant yields. A job that announced completion and then threw is
        // a defect in that job, and a stream that hid the failure to keep a count tidy
        // would be choosing its own invariant over the user's ability to learn what
        // happened. Two done events is the honest report of a job that did two things.
        this.#notify(STEP_NOTIFICATION, stepEvent({
          jobId, phase: 'done', step: 'failed', detail: error?.message || 'job failed', level: 'error', now: this.#now,
        }));
      } finally {
        record.done = true;
        this.#jobs.delete(jobId);
      }
    })();

    return jobId;
  }

  /// Cooperative cancellation: the job stops at its next checkpoint. `cancelled: false`
  /// for an unknown or finished job is an answer, not an error, because a user cancelling
  /// a job that just finished has not done anything wrong.
  cancel(jobId) {
    const record = this.#jobs.get(jobId);
    if (!record || record.done) return { cancelled: false };
    record.cancelled = true;
    return { cancelled: true };
  }

  /**
   * Push one board finding onto the notification channel.
   *
   * THIS METHOD DID NOT EXIST and was being called as `jobs.notifyFinding?.(finding)`, so
   * every finding a gym cycle raised was silently discarded, including the ADR-0167
   * scaffold warning on SCORED runs. The optional chaining is what hid it: a missing method
   * and a method that returns nothing look identical through `?.`, so the call site read as
   * defensive when it was inert.
   *
   * Not job scoped, matching the server's own pushBoardFinding: the watcher raises these
   * with nothing running.
   */
  notifyFinding(row) {
    this.#notify(BOARD_FINDING_NOTIFICATION, row);
  }

  /// Await every running job. Used on shutdown and by tests, so a job cannot outlive the
  /// process that owns its output stream.
  async drain() {
    await Promise.allSettled([...this.#jobs.values()].map((record) => record.promise));
  }
}
