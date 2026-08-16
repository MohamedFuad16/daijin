// The job runner's terminal-event invariant.
//
// EVERY JOB EMITS EXACTLY ONE done-PHASE EVENT. That is what makes a client's
// finished-versus-stalled inference unnecessary rather than merely usually-correct.
//
// The defect it closes, measured before it was designed (tui-builder found it during the
// P8 live half, both of us then measured it independently): the runner emitted a done
// event when work THREW and when it was CANCELLED, and nothing when it SUCCEEDED. So a
// client could observe a job ending exactly when it went wrong and had to guess when it
// went right. Every client then invents its own idle threshold, and the largest real
// inter-event gap measured here was 9.6s and 9.7s on two machines inside the floor phase,
// so an eight second guess declares a live run finished in the middle of one.
//
// The naive fix, always emitting done/finished on success, was measured and rejected:
// gatesDiscover announces its own completion, so it would have received two done events
// and a client would have to ask which one was terminal. That is a worse contract than the
// one it replaces.
import assert from 'node:assert/strict';
import test from 'node:test';

import { JobRunner } from '../src/rpc/jobs.js';

/// A runner whose notifications are collected, with a fixed clock so ts is not noise.
function runner() {
  const events = [];
  const jobs = new JobRunner({ notify: (method, params) => events.push({ method, params }), now: () => 1_770_000_000_000 });
  return {
    jobs,
    events,
    steps: (jobId) => events.filter((row) => row.params.jobId === jobId).map((row) => row.params),
    done: (jobId) => events.filter((row) => row.params.jobId === jobId && row.params.phase === 'done').map((row) => row.params),
  };
}

test('a job that says nothing still reports that it finished', async () => {
  const kit = runner();
  const jobId = kit.jobs.start('quiet', async ({ emit }) => {
    emit('work', 'step-one', 'doing the thing');
  });
  await kit.jobs.drain();

  const done = kit.done(jobId);
  assert.equal(done.length, 1, 'exactly one done event');
  assert.equal(done[0].step, 'finished');
  assert.equal(done[0].level, 'info', 'finishing is not a warning');
  assert.equal(kit.steps(jobId).at(-1).step, 'finished', 'and it is LAST, so a client can stop reading');
});

test('a job that announces its own completion is not given a second ending', async () => {
  // gatesDiscover does exactly this. Two done events would leave a client asking which one
  // is terminal, which is the worse contract the naive fix would have shipped.
  const kit = runner();
  const jobId = kit.jobs.start('gates', async ({ emit }) => {
    emit('probe', 'scan', 'probing');
    emit('done', 'written', '3 of 4 gates carry signal', { counts: { total: 4 } });
  });
  await kit.jobs.drain();

  const done = kit.done(jobId);
  assert.equal(done.length, 1, 'still exactly one');
  assert.equal(done[0].step, 'written', "and it is the JOB'S event, not a synthesized one");
  assert.deepEqual(done[0].counts, { total: 4 }, 'with the counts the job attached');
});

test('a job that KEEPS TALKING after saying it finished is refused', async () => {
  // The rule the invariant rests on, enforced rather than trusted of every job author. A
  // client has already rendered the ending; events arriving after it have nowhere to go.
  const kit = runner();
  const jobId = kit.jobs.start('chatty', async ({ emit }) => {
    emit('done', 'written', 'finished properly');
    emit('work', 'oops', 'still going somehow');
    emit('done', 'written-again', 'and again');
  });
  await kit.jobs.drain();

  const steps = kit.steps(jobId);
  assert.equal(steps.length, 1, 'everything after the ending is dropped');
  assert.equal(steps[0].step, 'written');
  assert.equal(kit.done(jobId).length, 1);
});

test('a thrown job reports the failure', async () => {
  const kit = runner();
  const jobId = kit.jobs.start('broken', async () => {
    throw new Error('the embedder is down');
  });
  await kit.jobs.drain();

  const done = kit.done(jobId);
  assert.equal(done.length, 1);
  assert.equal(done[0].step, 'failed');
  assert.equal(done[0].level, 'error');
  assert.match(done[0].detail, /the embedder is down/);
});

test('a cancelled job reports the cancellation, and nothing after it', async () => {
  const kit = runner();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const jobId = kit.jobs.start('slow', async ({ emit, cancelled }) => {
    emit('work', 'started', 'working');
    await gate;
    if (cancelled()) return;
    emit('done', 'written', 'should never be seen');
  });
  kit.jobs.cancel(jobId);
  release();
  await kit.jobs.drain();

  const done = kit.done(jobId);
  assert.equal(done.length, 1);
  assert.equal(done[0].step, 'cancelled');
  assert.equal(done[0].level, 'warn', 'a cancellation is worth marking; the user asked and the work stopped');
});

test('a job that announces done and THEN throws reports both, and that is deliberate', async () => {
  // The one case where the exactly-one invariant yields. A job that announced completion
  // and then threw is a defect in that job, and a stream that hid the failure to keep a
  // count tidy would be choosing its own invariant over the user's ability to learn what
  // happened. Two done events is the honest report of a job that did two things.
  const kit = runner();
  const jobId = kit.jobs.start('liar', async ({ emit }) => {
    emit('done', 'written', 'all good');
    throw new Error('actually the write failed');
  });
  await kit.jobs.drain();

  const done = kit.done(jobId);
  assert.equal(done.length, 2, 'the failure is NOT suppressed to protect the invariant');
  assert.deepEqual(done.map((row) => row.step), ['written', 'failed']);
  assert.match(done[1].detail, /actually the write failed/);
});

test('THE INVARIANT, over every ending: exactly one done event unless the job lied', async () => {
  // Stated once, over all of them, so a new ending added later has to face it.
  const kit = runner();
  const quiet = kit.jobs.start('a', async ({ emit }) => { emit('work', 'x', 'x'); });
  const announcing = kit.jobs.start('b', async ({ emit }) => { emit('done', 'written', 'x'); });
  const failing = kit.jobs.start('c', async () => { throw new Error('x'); });
  await kit.jobs.drain();

  for (const jobId of [quiet, announcing, failing]) {
    assert.equal(kit.done(jobId).length, 1, `${jobId} must emit exactly one done event`);
    const steps = kit.steps(jobId);
    assert.equal(steps.at(-1).phase, 'done', `${jobId}'s last event must be its ending`);
  }
});

test('the ending says HOW it ended, not only that it did', async () => {
  // The correction a client earned the hard way. Told to key on the phase and never on the
  // step, it read a FAILED init as a completion, then reported the brain missing afterwards
  // without connecting the two: the failure was real and the guidance had removed the only
  // field that distinguished it.
  //
  // `level` is the discriminator rather than the step, because it is a small closed set that
  // is the same for every job, where the step is job-specific and open: a client cannot
  // enumerate `written` and `kept-yours` and whatever the next job names its ending.
  const kit = runner();
  const quiet = kit.jobs.start('a', async ({ emit }) => { emit('work', 'x', 'x'); });
  const announcing = kit.jobs.start('b', async ({ emit }) => { emit('done', 'written', 'x'); });
  const failing = kit.jobs.start('c', async () => { throw new Error('the embedder is down'); });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cancelling = kit.jobs.start('d', async ({ cancelled }) => { await gate; if (cancelled()) return; });
  kit.jobs.cancel(cancelling);
  release();
  await kit.jobs.drain();

  const levelOf = (jobId) => kit.done(jobId)[0].level;
  assert.equal(levelOf(quiet), 'info', 'stopped well');
  assert.equal(levelOf(announcing), 'info', 'a job announcing its own ending is still a good ending');
  assert.equal(levelOf(failing), 'error', 'broke');
  assert.equal(levelOf(cancelling), 'warn', 'was stopped');

  // The closed set: three levels, and a client can branch on all of them without knowing
  // which job it is watching.
  const levels = new Set([quiet, announcing, failing, cancelling].map(levelOf));
  assert.deepEqual([...levels].sort(), ['error', 'info', 'warn']);
});

test('a job cannot FORGE one of the runner\'s endings', async () => {
  // tui-builder raised this as an assumption it was making and could not check from its
  // side: that a done event with level `info` means success even when its step says
  // `failed`. It was assuming correctly and the engine could not honour it, because nothing
  // stopped a job emitting exactly that pair. A client told to trust `level` would have
  // believed a forged success.
  const { RESERVED_DONE_STEPS } = await import('../src/rpc/jobs.js');
  assert.deepEqual([...RESERVED_DONE_STEPS], ['finished', 'failed', 'cancelled']);

  for (const step of RESERVED_DONE_STEPS) {
    const kit = runner();
    const jobId = kit.jobs.start('forger', async ({ emit }) => {
      emit('done', step, 'pretending', { level: 'info' });
    });
    await kit.jobs.drain();

    const done = kit.done(jobId);
    assert.equal(done.length, 1, `${step}: still exactly one ending`);
    // The attempt FAILS the job rather than being dropped: a job doing this has a bug, and a
    // silent drop would leave it believing it had reported something.
    assert.equal(done[0].step, 'failed');
    assert.equal(done[0].level, 'error', 'and the ending a client sees is the truthful one');
    assert.match(done[0].detail, new RegExp(`may not emit the reserved done step '${step}'`));
  }

  // A job announcing its OWN ending is still normal, which is what gatesDiscover does.
  const kit = runner();
  const honest = kit.jobs.start('gates', async ({ emit }) => { emit('done', 'written', '3 of 4 carry signal'); });
  await kit.jobs.drain();
  assert.equal(kit.done(honest)[0].step, 'written');
  assert.equal(kit.done(honest)[0].level, 'info');
});

test('a failure ALWAYS carries a reason, whatever was thrown', async () => {
  // tui-builder's other assumption: `detail` carries the failure message. It does, and the
  // fallbacks matter, because a banner that states a consequence with no cause is the shape
  // it was fixing. An Error with an empty message and a bare string throw both still
  // produce a detail rather than an empty one.
  for (const [label, thrown] of [
    ['a real message', new Error('the embedder is down')],
    ['an empty message', new Error('')],
    ['a bare string', 'not an Error at all'],
    ['undefined', undefined],
  ]) {
    const kit = runner();
    const jobId = kit.jobs.start('broken', async () => { throw thrown; });
    await kit.jobs.drain();
    const done = kit.done(jobId)[0];
    assert.equal(done.level, 'error', `${label}: level says it broke`);
    assert.ok(done.detail && done.detail.length > 0, `${label}: detail is never empty`);
  }
});
