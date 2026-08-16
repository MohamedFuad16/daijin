import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildGateCommand, classifyGateResults, expandGates, gateEnvironment, parseGateMetric, runCommand, runGateSet,
} from '../src/gym/gates.js';
import {
  applyEngineerDiff, assertOwnSandboxRemoved, assertSandboxRootEmpty, foreignSandboxEntries, validateUnifiedDiff,
} from '../src/gym/sandbox.js';

test('a gate sees an allowlisted environment, never the engine secrets', () => {
  const environment = gateEnvironment({ PATH: '/bin', HOME: '/home/x', DATABASE_URL: 'postgres://secret', OPENAI_API_KEY: 'sk-secret' });
  assert.deepEqual(Object.keys(environment).sort(), ['CI', 'HOME', 'PATH']);
  assert.equal(environment.CI, '1');
  assert.equal(gateEnvironment({ DEVELOPER_DIR: '/x' }, ['DEVELOPER_DIR']).DEVELOPER_DIR, '/x');
});

test('gate placeholders expand and every gate must declare an id and a command', () => {
  const gates = expandGates(
    [{ id: 'lint', role: 'lint', command: '{{node}} {{engineRoot}}/gates/lint.js --repo {{sandbox}}', availabilityCommand: '{{node}} --version' }],
    { engineRoot: '/engine', sandbox: '/sandbox', node: '/usr/bin/node' },
  );
  assert.equal(gates[0].command, '/usr/bin/node /engine/gates/lint.js --repo /sandbox');
  assert.equal(gates[0].availabilityCommand, '/usr/bin/node --version');
  assert.throws(() => expandGates([{ command: 'x' }], { engineRoot: '/e', sandbox: '/s' }), /needs an id and a command/);
  assert.throws(() => expandGates([], { engineRoot: '/e', sandbox: '/s' }), /No gates configured/);
});

test('the build gate is found by declared role, not by matching the command text', () => {
  const gates = [
    { id: 'lint', role: 'lint', command: 'npm run lint' },
    { id: 'compile', role: 'build', command: 'cargo build --release' },
  ];
  assert.equal(buildGateCommand(gates), 'cargo build --release');
  // Reordering must not change the answer, which is the failure a positional pick has.
  assert.equal(buildGateCommand([...gates].reverse()), 'cargo build --release');
  assert.equal(buildGateCommand([{ id: 'lint', role: 'lint', command: 'x' }]), null, 'no build gate means the tool is simply not offered');
});

test('GATE_METRIC is parsed out of noisy output', () => {
  assert.deepEqual(parseGateMetric('noise\nGATE_METRIC:lower-better:17\nmore'), { direction: 'lower-better', value: 17 });
  assert.deepEqual(parseGateMetric('GATE_METRIC:higher-better:-3.5'), { direction: 'higher-better', value: -3.5 });
  assert.equal(parseGateMetric('GATE_METRIC:sideways:1'), null);
  assert.equal(parseGateMetric(undefined), null);
});

test('classification precedence: unavailable, then measured movement, then pass and fail', () => {
  const classify = (baseline, candidate) => classifyGateResults(baseline, candidate)[0];

  assert.equal(classify([{ id: 'g', status: 'unavailable' }], [{ id: 'g', status: 'pass' }]).classification, 'unavailable');
  assert.equal(classify([{ id: 'g', status: 'pass' }], [{ id: 'g', status: 'unavailable' }]).classification, 'unavailable');

  // A measured gate is judged on DIRECTION, so a failing exit code with an improving
  // number is a pass. This is the whole point of converting a pre-broken gate.
  const improved = classify(
    [{ id: 'g', status: 'fail', stdout: 'GATE_METRIC:lower-better:17' }],
    [{ id: 'g', status: 'fail', stdout: 'GATE_METRIC:lower-better:12' }],
  );
  assert.equal(improved.classification, 'pass');
  assert.deepEqual(improved.metric, { direction: 'lower-better', value: 12, baselineValue: 17 });

  const worsened = classify(
    [{ id: 'g', status: 'fail', stdout: 'GATE_METRIC:lower-better:17' }],
    [{ id: 'g', status: 'fail', stdout: 'GATE_METRIC:lower-better:18' }],
  );
  assert.equal(worsened.classification, 'regressed');

  assert.equal(classify([{ id: 'g', status: 'pass' }], [{ id: 'g', status: 'fail' }]).classification, 'regressed');
  assert.equal(classify([{ id: 'g', status: 'pass' }], [{ id: 'g', status: 'pass' }]).classification, 'pass');
});

test('a gate that fails on baseline and candidate alike is labelled pre-broken, not passed', () => {
  const result = classifyGateResults([{ id: 'g', status: 'fail' }], [{ id: 'g', status: 'fail' }])[0];
  assert.equal(result.classification, 'pre-broken');
  assert.equal(result.baselineStatus, 'fail');
  // With no baseline at all there is nothing to compare against, so it cannot read as a pass.
  assert.equal(classifyGateResults([], [{ id: 'g', status: 'fail' }])[0].classification, 'pre-broken');
  assert.equal(classifyGateResults([], [{ id: 'g', status: 'fail' }])[0].baselineStatus, 'not-run');
});

test('runCommand reports exit status and a timeout distinctly', async () => {
  const passing = await runCommand('exit 0', { timeoutMs: 10_000 });
  assert.equal(passing.status, 'pass');
  const failing = await runCommand('exit 3', { timeoutMs: 10_000 });
  assert.equal(failing.status, 'fail');
  assert.equal(failing.exitCode, 3);
  const timing = await runCommand('sleep 5', { timeoutMs: 300 });
  assert.equal(timing.status, 'timeout', 'a hung gate must not read as a failed gate');
});

test('a gate whose runtime is missing is unavailable, with the reason named', async () => {
  const results = await runGateSet(
    [{ id: 'ios', command: 'echo ran', availabilityCommand: 'exit 1', unavailableHint: 'DEVELOPER_DIR is unset.' }],
    { timeoutMs: 10_000 },
  );
  assert.equal(results[0].status, 'unavailable');
  assert.match(results[0].unavailableReason, /failed preflight: exit 1\. DEVELOPER_DIR is unset\./);
  assert.ok(!results[0].stdout.includes('ran'), 'an unavailable gate does not run');
});

test('a diff touching forbidden paths is refused before git ever sees it', () => {
  const header = (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.doesNotThrow(() => validateUnifiedDiff(header('src/app.js')));
  assert.throws(() => validateUnifiedDiff(header('../outside.js')), /forbidden path/);
  assert.throws(() => validateUnifiedDiff(header('.git/config')), /forbidden path/);
  assert.throws(() => validateUnifiedDiff(header('.env.local')), /forbidden path/);
  assert.throws(() => validateUnifiedDiff(header('/etc/passwd')), /forbidden path/);
  assert.throws(() => validateUnifiedDiff(''), /empty diff/);
  assert.throws(() => validateUnifiedDiff('not a diff at all'), /not a git-compatible unified diff/);
});

test('applyEngineerDiff returns the refusal rather than throwing', async () => {
  const result = await applyEngineerDiff('/tmp', 'diff --git a/../x b/../x\n');
  assert.deepEqual(result, { applied: false, error: 'Engineer diff contains a forbidden path.' });
});

test('sandbox leak detection distinguishes this run from a foreign leftover', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-sandbox-'));
  try {
    assert.equal(await assertSandboxRootEmpty(root), true);
    await writeFile(path.join(root, 'exam-0001-abc'), '');
    await assert.rejects(assertSandboxRootEmpty(root), /Sandbox leak detected/);

    // A run owns exactly one invariant: its OWN worktree is gone.
    assert.equal(await assertOwnSandboxRemoved(path.join(root, 'exam-0002-def')), true);
    await assert.rejects(assertOwnSandboxRemoved(path.join(root, 'exam-0001-abc')), /Sandbox leak detected/);

    // A foreign leftover is reported, never thrown, so it cannot discard a paid-for result.
    assert.deepEqual(await foreignSandboxEntries(root, path.join(root, 'exam-0002-def')), ['exam-0001-abc']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
