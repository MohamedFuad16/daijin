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
    const record = { jobId, cancelled: false, done: false };
    this.#jobs.set(jobId, record);

    const emit = (phase, step, detail, extra = {}) => {
      // A cancelled job stops emitting: a feed that keeps scrolling after the user
      // cancelled reads as an engine that ignored them.
      if (record.cancelled) return;
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
        }
      } catch (error) {
        // A job failure is a step event, not a dropped connection. The request that
        // started it has long since returned its jobId, so this is the only channel the
        // user can learn about it on.
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

  /// Await every running job. Used on shutdown and by tests, so a job cannot outlive the
  /// process that owns its output stream.
  async drain() {
    await Promise.allSettled([...this.#jobs.values()].map((record) => record.promise));
  }
}
