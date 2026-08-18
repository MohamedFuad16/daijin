// The tool-wide watch: mechanical findings, and the closed fix catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EngineState } from '../src/rpc/state.js';
import { JobRunner } from '../src/rpc/jobs.js';
import { createMethods } from '../src/rpc/methods.js';
import { FIX_CATALOG, ZAI_CODING_URL, ZAI_PAYG_URL, examBankFindings, gateFindings, gateRunFindings, goalStopDecision, parseTriageReply, roleFindings, statusFindings } from '../src/rpc/watch.js';

const AT = '2026-08-17T12:00:00.000Z';

test('an unavailable gate whose runtime is pnpm carries the install-pnpm fix', () => {
  const parsed = {
    parseError: null,
    discovered: {
      summary: { total: 1, live: 0, measured: 0, preBroken: 0, unavailable: 1, carryingSignal: 0 },
      gates: [{
        id: 'build',
        classification: 'unavailable',
        availabilityCommand: 'pnpm --version && test -d node_modules',
        unavailableHint: 'Install pnpm and run its install step in the repo root.',
      }],
    },
  };
  const rows = gateFindings('/repo', parsed, { at: AT });
  const unavailable = rows.find((row) => row.id.startsWith('gate-unavailable'));
  assert.equal(unavailable.action.fixId, 'install-pnpm');
  assert.equal(unavailable.source, 'watcher');
  // Zero signal is its OWN finding: no gate can pass or fail, which is a
  // different fact from one gate being broken.
  assert.ok(rows.some((row) => row.id.startsWith('gates-no-signal')));
});

test('the zai realm trap offers the OTHER realm, whichever one the 429 landed on', () => {
  const base = {
    role: 'engineer',
    provider: 'zai',
    model: 'glm-5.3',
    ping: { ok: false, httpStatus: 429, hint: 'The provider answered 429. Insufficient balance or no resource package.' },
  };
  // 429 on pay-as-you-go: offer the coding realm.
  const payg = roleFindings([{ ...base, endpoint: ZAI_PAYG_URL }], { at: AT });
  assert.equal(payg[0].action.fixId, 'zai-coding-endpoint');
  assert.match(payg[0].detail, /Coding Plan/);
  // 429 on the coding realm (the catalog default since the owner's override,
  // D-0056): offer pay-as-you-go.
  const coding = roleFindings([{ ...base, endpoint: null }], { at: AT, zaiDefault: ZAI_CODING_URL });
  assert.equal(coding[0].action.fixId, 'zai-payg-endpoint');
  // A 429 on a CUSTOM endpoint is not the trap: the user aimed it themselves.
  const custom = roleFindings([{ ...base, endpoint: 'https://proxy.example.com/v4' }], { at: AT });
  assert.equal(custom[0].action, null);
});

test('an unreachable embedder is critical; an open spend gate and a brainless repo are findings', () => {
  const rows = statusFindings({
    ollama: { reachable: false, endpoint: 'http://127.0.0.1:11434', hint: 'not reachable' },
    spendGate: { open: true, path: '/g/GATE' },
    repos: [{ path: '/repo-a', health: 'no-brain' }, { path: '/repo-b', health: 'ok' }],
  }, { at: AT });
  assert.equal(rows.find((row) => row.id === 'ollama-unreachable').severity, 'critical');
  assert.ok(rows.some((row) => row.id === 'spend-gate-open'));
  assert.deepEqual(rows.filter((row) => row.id.startsWith('no-brain')).map((row) => row.target), ['/repo-a']);
});

async function fixture(deps = {}, onEvent = null) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'watch-'));
  const state = new EngineState({ stateRoot });
  const jobs = new JobRunner({ notify: (method, params) => { if (onEvent) onEvent(params, method); } });
  const methods = createMethods({ state, jobs, deps });
  // The loop is a JOB, so a test that asserts its effects must be able to
  // wait for it; the runner's own drain is that wait.
  methods.__jobs = jobs;
  return { state, methods, jobs };
}

test('systemFix refuses outside the closed catalog, and refuses without confirmation', async () => {
  const { methods } = await fixture();
  await assert.rejects(() => methods.systemFix({ fixId: 'rm-rf', confirm: true }), (error) => {
    assert.match(String(error.data?.hint || error.message), /closed/);
    return true;
  });
  await assert.rejects(() => methods.systemFix({ fixId: 'install-pnpm' }), (error) => {
    assert.match(String(error.data?.hint || error.message), /confirm/);
    return true;
  });
});

test('install fixes run THIS FILE\'s command, never anything from a hint', async () => {
  const ran = [];
  const { methods } = await fixture({
    execFix: async (command, args) => {
      ran.push([command, ...args]);
      return { error: null, stdout: 'added 1 package', stderr: '' };
    },
  });
  const result = await methods.systemFix({ fixId: 'install-pnpm', confirm: true });
  assert.equal(result.ok, true);
  assert.deepEqual(ran, [[FIX_CATALOG['install-pnpm'].command, ...FIX_CATALOG['install-pnpm'].args]]);
});

test('the endpoint fix patches exactly one role to the catalog value and reports it', async () => {
  const { state, methods } = await fixture();
  await state.patchSettings({ roles: [{ role: 'engineer', provider: 'zai', model: 'glm-5.3' }] });
  const result = await methods.systemFix({ fixId: 'zai-coding-endpoint', role: 'engineer', confirm: true });
  assert.equal(result.ok, true);
  const settings = await state.settings();
  assert.equal(settings.roles.find((row) => row.role === 'engineer').endpoint, ZAI_CODING_URL);
  // The fix without a role is a parameter error, not a guess.
  await assert.rejects(() => methods.systemFix({ fixId: 'zai-coding-endpoint', confirm: true }));
});

test('systemCheck sweeps the whole tool and returns board-shaped rows', async () => {
  const { state, methods } = await fixture();
  // A configured-but-never-verified role guarantees at least one finding
  // whatever this machine's ollama is doing.
  await state.patchSettings({ roles: [{ role: 'engineer', provider: 'zai', model: 'glm-5.3' }] });
  const result = await methods.systemCheck({});
  assert.ok(result.at);
  assert.ok(result.findings.length >= 1);
  for (const row of result.findings) {
    for (const key of ['id', 'ts', 'source', 'severity', 'category', 'target', 'evidence', 'status', 'summary']) {
      assert.ok(key in row, `${row.id || '?'} is missing ${key}`);
    }
    assert.equal(row.source, 'watcher');
  }
  assert.ok(result.findings.some((row) => row.id === 'role-unverified:engineer'));
});

test('gate RUN findings: a failing gate is critical, an unavailable one carries its install fix', () => {
  const rows = gateRunFindings('/repo', [
    { id: 'test', status: 'pass' },
    { id: 'build', status: 'fail', exitCode: 1, stderr: 'TypeError: nope' },
    { id: 'lint', status: 'unavailable', command: 'pnpm run lint', unavailableReason: 'Install pnpm and run its install step.' },
  ], { at: AT });
  const failing = rows.find((row) => row.id.startsWith('gate-failing'));
  assert.equal(failing.severity, 'critical', 'a gate failing on the repo as it stands is not a warning');
  assert.match(failing.detail, /TypeError/);
  const unavailable = rows.find((row) => row.id.startsWith('gate-unavailable'));
  assert.equal(unavailable.action.fixId, 'install-pnpm');
  assert.equal(rows.length, 2, 'a passing gate is not a finding');
});

test('exam-bank findings name what stands between the owner and a runnable gym', () => {
  assert.equal(examBankFindings('/repo', [], { at: AT })[0].id, 'exams-empty:/repo');

  const unpromoted = examBankFindings('/repo', [
    { examId: 'exam-0001', status: 'validated', benchmarkStatus: 'active', heldOut: false },
  ], { at: AT });
  assert.match(unpromoted[0].summary, /only a promoted exam can be drawn/);

  // The owner's round-11 wall: one promoted exam, held out, nothing drawable.
  const allHeld = examBankFindings('/repo', [
    { examId: 'exam-0001', status: 'promoted', benchmarkStatus: 'active', heldOut: true },
  ], { at: AT });
  assert.ok(allHeld.some((row) => row.id === 'exams-all-held-out:/repo'));

  // A healthy bank is silent.
  assert.deepEqual(examBankFindings('/repo', [
    { examId: 'exam-0001', status: 'promoted', benchmarkStatus: 'active', heldOut: false },
  ], { at: AT }), []);
});

test('the auditor may decline a fix, and may not invent one', () => {
  const offered = { reasoning: 'pnpm is genuinely missing here.', applyFixId: 'install-pnpm' };
  assert.deepEqual(parseTriageReply(JSON.stringify(offered)), offered);
  // Declining is a first-class answer.
  assert.equal(parseTriageReply('{"reasoning":"Leave it; the owner uses npm here.","applyFixId":null}').applyFixId, null);
  // A fix id outside the closed catalog is dropped, not obeyed.
  assert.equal(parseTriageReply('{"reasoning":"I will just remove the repo.","applyFixId":"rm-rf"}').applyFixId, null);
  // Reasoning is mandatory: a verdict with no statement teaches nothing.
  assert.throws(() => parseTriageReply('{"applyFixId":null}'), /no reasoning/);
});

test('the goal stop rule: clean sweeps end it, a dirty sweep resets the count, cancel wins', () => {
  const base = { cleanSweepsToStop: 2, maxSweeps: 100, sweep: 1 };
  // A dirty sweep never stops and RESETS the streak: two clean sweeps must be
  // consecutive, or a loop that alternates reports clean on a broken tool.
  assert.deepEqual(goalStopDecision({ ...base, findingCount: 3, clean: 1 }), { clean: 0, stop: false, reason: null });
  // One clean sweep is not enough at a threshold of two.
  assert.deepEqual(goalStopDecision({ ...base, findingCount: 0, clean: 0 }), { clean: 1, stop: false, reason: null });
  assert.deepEqual(goalStopDecision({ ...base, findingCount: 0, clean: 1 }), { clean: 2, stop: true, reason: 'clean' });
  // The backstop stops a loop that never comes clean, and says which reason.
  assert.deepEqual(goalStopDecision({ ...base, findingCount: 5, clean: 0, sweep: 100 }), { clean: 0, stop: true, reason: 'max-sweeps' });
  // Cancel beats everything, including a clean sweep that would have ended it.
  assert.equal(goalStopDecision({ ...base, findingCount: 0, clean: 1, cancelled: true }).reason, 'cancelled');
});

test('the goal loop sweeps a real repo, persists what it finds, and ends with a done event', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'goal-repo-'));
  await mkdir(path.join(repo, '.daijin'), { recursive: true });
  const events = [];
  const { methods, state } = await fixture({}, (params) => events.push(params));
  await methods.repoAttach({ repoPath: repo });
  // maxSweeps 1: one real sweep, no waiting, deterministic.
  const { jobId } = await methods.goalStart({ repoPath: repo, intervalMs: 5_000, cleanSweepsToStop: 5, maxSweeps: 1 });
  assert.match(jobId, /^job-goal-/);
  await methods.__jobs.drain();

  // A repo with no brain and no exams has two things worth saying, and the
  // board is where the loop says them.
  const board = await state.board();
  assert.ok(board.some((row) => row.id === `exams-empty:${repo}`), 'the empty bank reached the board');
  assert.ok(board.some((row) => row.id === `no-brain:${repo}`), 'the brainless repo reached the board');

  const done = events.find((row) => row.jobId === jobId && row.phase === 'done');
  assert.equal(done.step, 'goal');
  assert.match(done.detail, /still open/, 'a loop that stopped dirty says so rather than reporting clean');
  assert.ok(done.counts.open >= 2);
});

test('the board upserts a finding by id, so a loop cannot grow a row per sweep', async () => {
  const { state } = await fixture();
  const row = { id: 'gate-failing:/repo:test', severity: 'critical', summary: 'The test gate FAILS', status: 'open' };
  await state.addBoardFinding(row);
  await state.addBoardFinding(row);
  // The auditor's verdict arrives as the SAME finding, triaged.
  await state.addBoardFinding({ ...row, status: 'triaged', thread: [{ by: 'auditor', text: 'Real break; fix the test.' }] });
  const board = await state.board();
  const mine = board.filter((entry) => entry.id === row.id);
  assert.equal(mine.length, 1, 'one finding, one row, however many times it is raised');
  assert.equal(mine[0].status, 'triaged', 'the latest state wins');
  assert.equal(mine[0].thread[0].by, 'auditor', 'and the verdict rides on it');

  // A row with no id is a one-shot gym event and still lands.
  await state.addBoardFinding({ source: 'engine', severity: 'info', evidence: 'prompt-scaffold' });
  assert.equal((await state.board()).length, 2);
});
