// The tool-wide watch: mechanical findings, and the closed fix catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EngineState } from '../src/rpc/state.js';
import { JobRunner } from '../src/rpc/jobs.js';
import { createMethods } from '../src/rpc/methods.js';
import { FIX_CATALOG, ZAI_CODING_URL, gateFindings, roleFindings, statusFindings } from '../src/rpc/watch.js';

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

test('the zai realm trap is detected: 429 on the pay-as-you-go realm offers the coding realm', () => {
  const roles = [{
    role: 'engineer',
    provider: 'zai',
    model: 'glm-5.3',
    endpoint: null,
    ping: { ok: false, httpStatus: 429, hint: 'The provider answered 429. Insufficient balance or no resource package.' },
  }];
  const rows = roleFindings(roles, { at: AT });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action.fixId, 'zai-coding-endpoint');
  assert.match(rows[0].detail, /Coding Plan/);
  // A 429 on a CUSTOM endpoint is not the trap: the user aimed it themselves.
  const custom = roleFindings([{ ...roles[0], endpoint: 'https://proxy.example.com/v4' }], { at: AT });
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

async function fixture(deps = {}) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'watch-'));
  const state = new EngineState({ stateRoot });
  const methods = createMethods({ state, jobs: new JobRunner({ notify: () => {} }), deps });
  return { state, methods };
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
