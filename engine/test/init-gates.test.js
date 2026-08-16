// Gate discovery: probe, run against the baseline, classify, write DATA.
//
// The mutation discipline applies to the classifier itself. A discovery step that reported
// every command as live would look identical to a working one on a healthy repo, so each
// classification below is proved by a command that produces it: `true` is live, `false` is
// pre-broken, a GATE_METRIC line is measured, and a failing availability probe is
// unavailable. The decisive assertion is that pre-broken and unavailable are EXCLUDED from
// the coverage count, because that is the number a user reads as "checks I have".
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

import { gateEnvironment, runCommand } from '../src/gym/gates.js';
import {
  classifyBaselineRun, discoverGates, packageManagerOf, probeGateCandidates,
  renderGatesYaml, summariseGates,
} from '../src/init/gate-discovery.js';

const MANIFEST = {
  'package.json': {
    name: 'fixture',
    scripts: { test: 'node --test', lint: 'eslint .', build: 'tsc -p .', start: 'node server.js', 'format:check': 'prettier -c .' },
  },
};

test('probing reads package.json scripts by NAME and assigns the declared role', () => {
  const candidates = probeGateCandidates({ files: ['package.json'], manifests: MANIFEST });
  const byId = new Map(candidates.map((gate) => [gate.id, gate]));
  assert.equal(byId.get('test').command, 'npm run test');
  assert.equal(byId.get('build').role, 'build', 'the gym selects the compile gate by declared role, never by list position');
  assert.equal(byId.get('lint').role, 'lint');
  assert.equal(byId.has('start'), false, 'a long-running script is not a gate');
  assert.equal(byId.get('format:check').role, 'format');
  assert.ok(candidates.every((gate) => gate.source.startsWith('package.json#scripts.')));
  assert.match(
    byId.get('test').availabilityCommand,
    /test -d node_modules/,
    'a script that fails only because dependencies are absent is UNAVAILABLE, not pre-broken; pre-broken is a claim about the repo',
  );
});

test('the package manager comes from the lockfile', () => {
  assert.equal(packageManagerOf(['package.json']), 'npm');
  assert.equal(packageManagerOf(['pnpm-lock.yaml']), 'pnpm');
  assert.equal(packageManagerOf(['yarn.lock']), 'yarn');
});

test('CI run steps become candidates, but templated and block-scalar ones do not', () => {
  const workflow = [
    'jobs:', '  build:', '    steps:',
    '      - run: npm ci',
    '      - run: make lint',
    '      - run: echo ${{ secrets.TOKEN }}',
    '      - run: |',
    '          multi line',
  ].join('\n');
  const candidates = probeGateCandidates({ files: [], texts: { '.github/workflows/ci.yml': workflow } });
  const commands = candidates.map((gate) => gate.command);
  assert.deepEqual(commands, ['npm ci', 'make lint']);
  assert.ok(!commands.some((command) => command.includes('${{')), 'a candidate the discovery step cannot execute verbatim is not a candidate');
});

test('Makefile targets and language conventions are probed, and inferred sources say so', () => {
  const candidates = probeGateCandidates({
    files: ['Makefile', 'Cargo.toml'],
    texts: { Makefile: 'test:\n\tcargo test\n\nlint:\n\tcargo clippy\n\n.PHONY: test\n' },
  });
  const byCommand = new Map(candidates.map((gate) => [gate.command, gate]));
  assert.equal(byCommand.get('make test').source, 'Makefile#test');
  assert.equal(byCommand.get('cargo test').source, 'convention:Cargo.toml', 'a guess from file presence must be labelled a guess');
  assert.equal(byCommand.get('cargo build').role, 'build');
});

test('classification: live, measured, pre-broken and unavailable each from a real run', async () => {
  const live = classifyBaselineRun(await runCommand('exit 0', { cwd: process.cwd(), timeoutMs: 10_000 }));
  assert.equal(live.classification, 'live');
  assert.equal(live.enabled, true);

  const broken = classifyBaselineRun(await runCommand('exit 3', { cwd: process.cwd(), timeoutMs: 10_000 }));
  assert.equal(broken.classification, 'pre-broken');
  assert.equal(broken.enabled, false, 'a gate that fails either way cannot tell a good edit from a bad one');
  assert.match(broken.reason, /already fails on the untouched baseline \(exit 3\)/);

  // A measured gate reports a NUMBER and stays enabled even while failing: it is judged on
  // movement, which is the platform's answer to a tool with pre-existing violations.
  const measured = classifyBaselineRun(await runCommand('echo GATE_METRIC:lower-better:17; exit 1', { cwd: process.cwd(), timeoutMs: 10_000 }));
  assert.equal(measured.classification, 'measured');
  assert.equal(measured.enabled, true);
  assert.deepEqual(measured.metric, { direction: 'lower-better', value: 17, baselineValue: 17 });

  const unavailable = classifyBaselineRun({ status: 'unavailable', stdout: '', stderr: '' });
  assert.equal(unavailable.classification, 'unavailable');
  assert.equal(unavailable.enabled, false);
});

test('discovery runs every candidate and excludes pre-broken and unavailable from coverage', async () => {
  const candidates = [
    { id: 'ok', command: 'exit 0', role: 'test', source: 'x', availabilityCommand: null, cwd: null },
    { id: 'broken', command: 'exit 1', role: 'lint', source: 'x', availabilityCommand: null, cwd: null },
    { id: 'metric', command: 'echo GATE_METRIC:lower-better:5', role: 'lint', source: 'x', availabilityCommand: null, cwd: null },
    { id: 'missing-tool', command: 'exit 0', role: 'build', source: 'x', availabilityCommand: 'exit 7', unavailableHint: 'Install it.', cwd: null },
  ];
  const { gates, summary } = await discoverGates({ repoPath: process.cwd(), candidates, timeoutMs: 10_000 });
  assert.deepEqual(gates.map((gate) => [gate.id, gate.classification]), [
    ['ok', 'live'], ['broken', 'pre-broken'], ['metric', 'measured'], ['missing-tool', 'unavailable'],
  ]);
  assert.equal(summary.total, 4);
  assert.equal(
    summary.carryingSignal,
    2,
    'coverage counts only gates that can fail on a bad edit; counting the other two is how a repo reports checks it does not have',
  );
  assert.equal(summary.preBroken, 1);
  assert.equal(summary.unavailable, 1);
  assert.match(gates[3].baseline.unavailableReason, /failed preflight.*Install it\./s);
});

test('the unavailable gate never runs its own command', async () => {
  const attempted = [];
  const run = async (command, options) => {
    attempted.push(command);
    return command === 'availability-probe'
      ? { status: 'fail', exitCode: 1, duration_ms: 1, stdout: '', stderr: '' }
      : { status: 'pass', exitCode: 0, duration_ms: 1, stdout: '', stderr: '' };
  };
  await discoverGates({
    repoPath: '/x',
    candidates: [{ id: 'g', command: 'rm -rf everything', availabilityCommand: 'availability-probe', cwd: null }],
    run,
  });
  assert.deepEqual(attempted, ['availability-probe'], 'a gate whose runtime is missing must not have its command executed anyway');
});

test('a gate sees an allowlisted environment, never the engine keys', () => {
  const environment = gateEnvironment({
    PATH: '/bin', HOME: '/home/x', DATABASE_URL: 'postgres://secret', OPENAI_API_KEY: 'sk-secret',
  });
  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.DATABASE_URL, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined, 'a gate is arbitrary repo code');
});

test('gates.yaml is data a human can read, and it says why a gate is disabled', () => {
  const gates = [
    { id: 'test', command: 'npm run test', role: 'test', cwd: null, availabilityCommand: null, unavailableHint: null, source: 'package.json#scripts.test', classification: 'live', enabled: true, baseline: { status: 'pass', exitCode: 0, durationMs: 12, timeoutMs: 1000, stdoutTail: '', stderrTail: '', unavailableReason: null } },
    { id: 'lint', command: 'npm run lint', role: 'lint', cwd: null, availabilityCommand: null, unavailableHint: null, source: 'package.json#scripts.lint', classification: 'pre-broken', enabled: false, reason: 'The command already fails on the untouched baseline (exit 1).', baseline: { status: 'fail', exitCode: 1, durationMs: 9, timeoutMs: 1000, stdoutTail: '', stderrTail: '', unavailableReason: null } },
  ];
  const rendered = renderGatesYaml({ gates, summary: summariseGates(gates), timeoutMs: 1000, discoveredAt: '2026-08-16T00:00:00.000Z' });
  assert.match(rendered, /^# Daijin discovered gates/);
  assert.match(rendered, /pre-broken {2}already failed on the untouched repo/);
  const parsed = YAML.parse(rendered);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.summary.carryingSignal, 1);
  assert.equal(parsed.gates[1].enabled, false);
  assert.match(parsed.gates[1].reason, /already fails on the untouched baseline/);
  assert.equal(parsed.gates[0].baseline.exitCode, 0, 'the liveness evidence rides with the classification');
});

test('summariseGates never counts a pre-broken or unavailable gate as coverage', () => {
  const summary = summariseGates([
    { classification: 'live' }, { classification: 'measured' },
    { classification: 'pre-broken' }, { classification: 'unavailable' }, { classification: 'pre-broken' },
  ]);
  assert.deepEqual(summary, { total: 5, live: 1, measured: 1, preBroken: 2, unavailable: 1, carryingSignal: 2 });
});

test('a repo whose dependencies are not installed reports UNAVAILABLE, never pre-broken', async () => {
  // The distinction is the whole point of the label: pre-broken says the repo is failing
  // its own checks, which a user acts on. A missing node_modules says nothing about the
  // repo and everything about the machine the probe ran on.
  const bare = mkdtempSync(path.join(tmpdir(), 'daijin-gates-bare-'));
  try {
    writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'bare', scripts: { build: 'vite build' } }));
    const candidates = probeGateCandidates({ files: ['package.json'], manifests: { 'package.json': { scripts: { build: 'vite build' } } } });
    const { gates, summary } = await discoverGates({ repoPath: bare, candidates, timeoutMs: 20_000 });
    assert.equal(gates[0].classification, 'unavailable');
    assert.equal(gates[0].enabled, false);
    assert.match(gates[0].baseline.unavailableReason, /dependencies are not present/);
    assert.equal(summary.carryingSignal, 0);
    assert.equal(summary.preBroken, 0, 'blaming the repo for the machine is the wrong label, not a harmless one');

    // With dependencies present the same candidate reaches its command and is judged on it.
    mkdirSync(path.join(bare, 'node_modules'), { recursive: true });
    const installed = await discoverGates({
      repoPath: bare,
      candidates: [{ ...candidates[0], command: 'exit 0' }],
      timeoutMs: 20_000,
    });
    assert.equal(installed.gates[0].classification, 'live');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
