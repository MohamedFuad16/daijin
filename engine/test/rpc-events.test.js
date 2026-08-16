// The notification stream, end to end, with a real subscriber on the other end of a pipe.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRpcServer } from '../src/rpc/server.js';
import { JobRunner, stepEvent } from '../src/rpc/jobs.js';
import { resultOf, startDaemon } from './helpers/rpc-pipe.js';

async function fixtureRepo() {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-gates-'));
  await mkdir(path.join(repoPath, '.daijin'), { recursive: true });
  return repoPath;
}

test('a job streams step notifications to a subscriber and writes its result', async () => {
  const repoPath = await fixtureRepo();
  // One trivially fast gate so classification runs for real without a toolchain.
  await writeFile(path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { lint: 'exit 0' } }), 'utf8');
  const daemon = await startDaemon();
  try {
    await daemon.request('repoAttach', { repoPath });
    const { jobId } = resultOf(await daemon.request('gatesDiscover', { repoPath }));
    assert.match(jobId, /^job-gates-/, 'the job id is returned immediately, before the work finishes');

    const done = await daemon.waitForNotification(
      (row) => row.method === 'step' && row.params.jobId === jobId && row.params.phase === 'done',
    );
    const steps = daemon.notifications.filter((row) => row.method === 'step' && row.params.jobId === jobId);

    // The contract's step shape, on every event.
    for (const row of steps) {
      const event = row.params;
      assert.equal(typeof event.ts, 'number', 'ts is epoch milliseconds');
      assert.ok(event.ts > 1_600_000_000_000, 'ts looks like epoch milliseconds, not a relative offset');
      for (const field of ['jobId', 'phase', 'step', 'detail', 'level']) {
        assert.ok(Object.hasOwn(event, field), `step event is missing ${field}`);
      }
    }
    assert.deepEqual([...new Set(steps.map((row) => row.params.phase))], ['probe', 'classify', 'done'],
      'the feed reports progress as it goes, not one event at the end');
    assert.ok(done.params.counts, 'the closing event carries counts for the summary line');

    // The job actually did the work, not just narrated it.
    const gatesYaml = await readFile(path.join(repoPath, '.daijin', 'gates.yaml'), 'utf8');
    assert.match(gatesYaml, /gates:/);
  } finally {
    await daemon.stop();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('a job with nothing to do still reports, rather than going silent', async () => {
  // A repo with no manifests yields no candidates. The feed must still open and close, or
  // the TUI shows a spinner that never resolves.
  const repoPath = await fixtureRepo();
  const daemon = await startDaemon();
  try {
    await daemon.request('repoAttach', { repoPath });
    const { jobId } = resultOf(await daemon.request('gatesDiscover', { repoPath }));
    const done = await daemon.waitForNotification(
      (row) => row.method === 'step' && row.params.jobId === jobId && row.params.phase === 'done',
    );
    assert.equal(done.params.counts.total, 0);
    assert.equal(done.params.counts.carryingSignal, 0, 'zero gates carrying signal is reported, never rounded up');
  } finally {
    await daemon.stop();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('board findings ride their own channel and are not job scoped', async () => {
  // Driven through the server directly because the watcher that pushes these ships in P4;
  // the CHANNEL is contract now, so it is wired and tested now.
  const messages = [];
  const server = createRpcServer({ stateRoot: await mkdtemp(path.join(tmpdir(), 'daijin-board-')), write: (m) => messages.push(m) });
  server.pushBoardFinding({
    ts: 1_760_000_000_000,
    source: 'watcher',
    severity: 'critical',
    category: 'dead-gate',
    target: 'eslint',
    evidence: 'logs/gates/2026-08-16.jsonl#L42',
    status: 'open',
  });
  const finding = messages.find((row) => row.method === 'boardFinding');
  assert.ok(finding, 'board findings use the boardFinding notification method');
  assert.equal(finding.params.jobId, undefined, 'not job scoped: they arrive with nothing running');
  for (const field of ['ts', 'source', 'severity', 'category', 'target', 'evidence', 'status']) {
    assert.ok(Object.hasOwn(finding.params, field), `boardFinding is missing ${field}`);
  }
  await server.close();
});

test('a cancelled job stops emitting and says it was cancelled', async () => {
  const emitted = [];
  const jobs = new JobRunner({ notify: (method, params) => emitted.push({ method, params }) });
  let released;
  const gate = new Promise((resolve) => { released = resolve; });
  const jobId = jobs.start('test', async ({ emit, cancelled }) => {
    emit('phase', 'first', 'before the cancel');
    await gate;
    if (cancelled()) return;
    emit('phase', 'second', 'this must never be emitted');
  });
  assert.deepEqual(jobs.cancel(jobId), { cancelled: true });
  released();
  await jobs.drain();

  const steps = emitted.map((row) => row.params.step);
  assert.ok(steps.includes('first'));
  assert.ok(!steps.includes('second'), 'a feed that keeps scrolling after a cancel reads as an engine ignoring the user');
  assert.ok(steps.includes('cancelled'));
  assert.deepEqual(jobs.cancel(jobId), { cancelled: false }, 'cancelling a finished job is an answer, not an error');
});

test('a job that throws reports a failure on the stream rather than dying silently', async () => {
  // The request that started it returned its jobId long ago, so this stream is the only
  // channel a user can learn about the failure on.
  const emitted = [];
  const jobs = new JobRunner({ notify: (method, params) => emitted.push({ method, params }) });
  jobs.start('boom', async () => { throw new Error('the gate runner exploded'); });
  await jobs.drain();
  const failure = emitted.find((row) => row.params.step === 'failed');
  assert.ok(failure, 'a job failure must reach the user');
  assert.equal(failure.params.level, 'error');
  assert.match(failure.params.detail, /exploded/);
});

test('stepEvent omits counts rather than sending an empty object', () => {
  // A client cannot tell "no counts for this step" from "zero of everything" if the key is
  // always present, and the init feed renders per-phase counts from exactly this.
  const withoutCounts = stepEvent({ jobId: 'j', phase: 'p', step: 's', detail: 'd', now: () => 1 });
  assert.equal(Object.hasOwn(withoutCounts, 'counts'), false);
  const withCounts = stepEvent({ jobId: 'j', phase: 'p', step: 's', detail: 'd', counts: { files: 0 }, now: () => 1 });
  assert.deepEqual(withCounts.counts, { files: 0 });
});
