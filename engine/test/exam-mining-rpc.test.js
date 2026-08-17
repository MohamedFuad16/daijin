// examMine: the funnel over the wire. Real git walk, real stage-2 selection,
// real record writing and (where cheap) real worktree validation; the ONLY
// fake is the auditor's generate function, because the committee's judgment
// is the one step that costs money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EngineState } from '../src/rpc/state.js';
import { JobRunner } from '../src/rpc/jobs.js';
import { createMethods } from '../src/rpc/methods.js';
import { GymLedger, gymDatabasePath } from '../src/gym/ledger.js';

const exec = promisify(execFile);

async function git(repo, ...args) {
  await exec('git', ['-C', repo, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: '2026-08-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-08-01T00:00:00Z' } });
}

/// A real repository with three commits: an initial one, a REAL code change
/// (the exam candidate), and a docs-only change the deterministic filter
/// must drop.
async function fixtureRepo() {
  const repo = await mkdtemp(path.join(tmpdir(), 'mine-repo-'));
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 't@example.com');
  await git(repo, 'config', 'user.name', 'T');
  await writeFile(path.join(repo, 'app.js'), 'export const answer = 41;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial');
  await writeFile(path.join(repo, 'app.js'), 'export const answer = 42;\nexport function double(x) { return x * 2; }\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'fix: correct the answer and add double()');
  await writeFile(path.join(repo, 'README.md'), 'docs only\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'docs: readme');
  const { stdout } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD~1']);
  return { repo, goldCommit: stdout.trim() };
}

async function fixture({ gate = 'authorized', auditorRole = true, deps = {} } = {}) {
  const { repo, goldCommit } = await fixtureRepo();
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'mine-state-'));
  const state = new EngineState({ stateRoot });
  if (auditorRole) {
    await state.patchSettings({ roles: [{ role: 'auditor', provider: 'zai', model: 'glm-5.3', keyRef: 'env:MINE_TEST_KEY' }] });
  }
  if (gate) {
    await mkdir(path.join(repo, '.daijin'), { recursive: true });
    await writeFile(path.join(repo, '.daijin', 'GATE'),
      JSON.stringify({ status: 'authorized', scope: 'exam-mining', reason: 'Test-run mining authorization.' }));
  }
  const events = [];
  const jobs = new JobRunner({ notify: (method, params) => events.push(params) });
  const methods = createMethods({
    state,
    jobs,
    deps: { resolveKey: async () => 'test-key', ...deps },
  });
  await methods.repoAttach({ repoPath: repo });
  return { repo, goldCommit, state, methods, events };
}

async function waitForDone(events, jobId, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    const done = events.find((event) => event.jobId === jobId && event.phase === 'done');
    if (done) return done;
    if (Date.now() - started > timeoutMs) throw new Error(`job ${jobId} never finished; last: ${JSON.stringify(events.at(-1))}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/// The fake seam: a generate function answering the committee prompt with
/// strict JSON. It selects the first candidate IT READS IN THE PROMPT, so the
/// test needs no back-channel to the fixture's shas and the prompt's content
/// is itself asserted. Everything downstream of this function is real.
function promptReadingGenerate(captured = {}) {
  return () => async ({ prompt }) => {
    captured.prompt = prompt;
    assert.match(prompt, /STRICT JSON/, 'the committee prompt reached the generate function');
    const commit = prompt.match(/commit ([0-9a-f]{40})/)?.[1];
    assert.ok(commit, 'the prompt lists candidate commits');
    return {
      text: JSON.stringify({ chosen: [{
        commit,
        title: 'Correct the answer',
        task: 'Make the module export the correct answer and provide a helper that doubles a number.',
        rationale: 'Single coherent intent with a statable outcome.',
        heldOut: false,
      }] }),
      servedModelId: 'glm-5.3',
    };
  };
}

test('mining is refused while the gate is blocked, before any history is walked', async () => {
  const { methods, repo } = await fixture({ gate: null });
  await assert.rejects(() => methods.examMine({ repoPath: repo, confirm: true }), (error) => {
    assert.match(String(error.data?.hint || error.message), /blocked|gate/i);
    return true;
  });
});

test('mining is refused without consent, past the gate', async () => {
  const { methods, repo } = await fixture();
  await assert.rejects(() => methods.examMine({ repoPath: repo }), (error) => {
    assert.match(String(error.data?.hint || error.message), /go ahead|confirm/i);
    return true;
  });
});

test('mining is refused when the auditor role is not configured', async () => {
  const { methods, repo } = await fixture({ auditorRole: false });
  await assert.rejects(() => methods.examMine({ repoPath: repo, confirm: true }), (error) => {
    assert.match(String(error.data?.hint || error.message), /auditor/i);
    return true;
  });
});

test('the funnel end to end: walk, committee, validation, a validated exam in the ledger', async () => {
  const captured = {};
  const { methods, repo, goldCommit, events } = await fixture({
    deps: { createRoleGenerate: promptReadingGenerate(captured) },
  });
  const { jobId } = await methods.examMine({ repoPath: repo, confirm: true });
  const done = await waitForDone(events, jobId);
  assert.equal(done.step, 'mined', `expected the mined ending, got ${done.step}: ${done.detail}`);
  assert.equal(done.counts.written, 1);
  assert.equal(done.counts.validated, 1, `validation failed: ${events.filter((e) => e.jobId === jobId).map((e) => e.detail).join(' | ')}`);

  // The deterministic filter dropped the docs-only commit BEFORE the
  // committee read anything: the prompt must not contain it.
  assert.doesNotMatch(captured.prompt, /docs: readme/);
  const filtered = events.find((event) => event.jobId === jobId && event.step === 'filtered');
  assert.match(filtered.detail, /1 candidate\(s\) kept/);

  // THE GATE RE-BLOCKED ITSELF when the job ended (D-0060): an authorization
  // lives exactly as long as the run it authorized.
  const gateAfter = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(repo, '.daijin', 'GATE'), 'utf8'));
  assert.equal(gateAfter.status, 'blocked');

  // The ledger row, read back raw: validated, correct commits, the auditor's
  // task verbatim, and provenance naming the model that authored it.
  const ledger = GymLedger.open(gymDatabasePath(repo));
  try {
    const exams = ledger.listExams({});
    assert.equal(exams.length, 1);
    const exam = ledger.getExam(exams[0].examId);
    assert.equal(exam.status, 'validated');
    assert.equal(exam.goldCommit, goldCommit);
    assert.notEqual(exam.baseCommit, exam.goldCommit);
    assert.match(exam.task, /doubles a number/);
    assert.equal(exam.provenance.source, 'auditor-selection');
    assert.match(exam.provenance.authoredBy.model, /glm-5\.3/);
    assert.equal(exam.scopeTier, 'S');
  } finally {
    ledger.close();
  }
});

test('a committee reply naming a filtered commit is refused, and the job fails loudly', async () => {
  const badGenerate = () => async () => ({
    text: JSON.stringify({ chosen: [{
      commit: 'f'.repeat(40),
      title: 'x',
      task: 'A task long enough to pass the parser but naming a commit nobody offered the committee.',
      heldOut: false,
    }] }),
    servedModelId: 'glm-5.3',
  });
  const { methods, repo, events } = await fixture({ deps: { createRoleGenerate: badGenerate } });
  const { jobId } = await methods.examMine({ repoPath: repo, confirm: true });
  const done = await waitForDone(events, jobId);
  assert.equal(done.step, 'failed', 'the auditor proposing an ineligible commit must fail the job, not be reinstated');
  assert.match(String(done.detail), /not an eligible candidate/);
});

test('spendGateSet: blocked always works; authorized needs scope, reason and confirm', async () => {
  const { methods, repo } = await fixture({ gate: null });
  const blocked = await methods.spendGateSet({ repoPath: repo, status: 'blocked' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.open, false);

  await assert.rejects(() => methods.spendGateSet({ repoPath: repo, status: 'authorized', scope: 'nope', reason: 'x'.repeat(30), confirm: true }), (error) => {
    assert.match(String(error.data?.hint || error.message), /scope/);
    return true;
  });
  await assert.rejects(() => methods.spendGateSet({ repoPath: repo, status: 'authorized', scope: 'exam-mining', reason: 'short', confirm: true }), (error) => {
    assert.match(String(error.data?.hint || error.message), /20 characters/);
    return true;
  });
  await assert.rejects(() => methods.spendGateSet({ repoPath: repo, status: 'authorized', scope: 'exam-mining', reason: 'x'.repeat(30) }), (error) => {
    assert.match(String(error.data?.hint || error.message), /confirm/i);
    return true;
  });

  const opened = await methods.spendGateSet({
    repoPath: repo, status: 'authorized', scope: 'exam-mining',
    reason: 'Opened from the TUI by the owner for one exam-mining run.', confirm: true,
  });
  assert.equal(opened.status, 'authorized');
  assert.equal(opened.scope, 'exam-mining');
  assert.equal(opened.open, true);
});
