// The live student drivers: the JSON-action API student and the agentic CLI
// student, both against the loop's frozen contract, both at zero spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { confinePath, createApiEngineer, createCliEngineer } from '../src/gym/engineer-driver.js';
import { runStudentLoop } from '../src/gym/student-loop.js';

const exec = promisify(execFile);

test('confinePath keeps every proposed path inside the sandbox', () => {
  const sandbox = '/tmp/sandbox-x';
  assert.equal(confinePath(sandbox, 'src/a.js'), path.join(sandbox, 'src/a.js'));
  assert.throws(() => confinePath(sandbox, '../outside.js'), /outside its sandbox/);
  assert.throws(() => confinePath(sandbox, '/etc/passwd'), /outside its sandbox/);
  assert.throws(() => confinePath(sandbox, 'a/../../b'), /outside its sandbox/);
});

/// A scripted generate: replies in order, recording every prompt it saw.
function scriptedGenerate(replies, seen = []) {
  let index = 0;
  return async ({ prompt, system }) => {
    seen.push({ prompt, system });
    const text = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return { text, servedModelId: 'glm-5.3', tokens: 100 };
  };
}

test('the API student reads, edits inside the sandbox, and submits through the real loop', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'api-student-'));
  await writeFile(path.join(sandbox, 'app.js'), 'export const answer = 41;\n');
  const seen = [];
  const engineer = createApiEngineer({ role: { provider: 'zai', model: 'glm-5.3' } }, {
    generate: scriptedGenerate([
      JSON.stringify({ action: 'read', file: 'app.js' }),
      JSON.stringify({ action: 'edit', file: 'app.js', content: 'export const answer = 42;\n' }),
      JSON.stringify({ action: 'check' }),
      JSON.stringify({ action: 'submit', explanation: 'Corrected the answer constant.' }),
    ], seen),
  });

  const snapshots = [];
  const result = await runStudentLoop({
    engineer,
    checkBuild: async () => ({ status: 'pass', exitCode: 0, diagnostics: [] }),
    snapshotState: async () => { snapshots.push('snap'); return 'diff-state'; },
    restoreState: async () => {},
    policy: {
      maxRounds: 10, extensionStep: 0, extensionLimit: 0, boundaryCheck: false,
      submitRehearsal: false, preSealFraction: null, preSealMaxDeliveries: 0,
    },
    tokenCap: 100_000,
    session: { prompt: 'Fix the answer constant.', sandbox, examId: 'exam-0001', mode: 'harness-debug' },
  });

  assert.equal(result.status, 'submitted');
  assert.match(result.explanation, /Corrected the answer/);
  assert.equal(result.state, 'diff-state', 'the diff comes from the worktree snapshot, never the model');
  assert.equal(await readFile(path.join(sandbox, 'app.js'), 'utf8'), 'export const answer = 42;\n');
  // Round 2's prompt carries round 1's read: the transcript accumulates.
  assert.match(seen[1].prompt, /export const answer = 41/);
});

test('a malformed API reply is a nudge, not a crash, and its tokens still count', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'api-nudge-'));
  const seen = [];
  const engineer = createApiEngineer({ role: { provider: 'zai', model: 'glm-5.3' } }, {
    generate: scriptedGenerate(['I think I will edit some files now!', JSON.stringify({ action: 'check' })], seen),
  });
  const first = await engineer.next({ prompt: 'task', sandbox, round: 1, workTokens: 0, tokenCap: 1000, forced: null, message: null });
  assert.equal(first.kind, 'read');
  assert.equal(first.tokens, 100, 'spent tokens are counted even when the reply is unusable');
  await engineer.next({ prompt: 'task', sandbox, round: 2, workTokens: 100, tokenCap: 1000, forced: null, message: null });
  assert.match(seen[1].prompt, /rejected/, 'the student reads its own mistake next round');
});

test('a path outside the sandbox fails the round loudly', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'api-escape-'));
  const engineer = createApiEngineer({ role: { provider: 'zai', model: 'glm-5.3' } }, {
    generate: scriptedGenerate([JSON.stringify({ action: 'edit', file: '../escape.js', content: 'x' })]),
  });
  await assert.rejects(
    () => engineer.next({ prompt: 'task', sandbox, round: 1, workTokens: 0, tokenCap: 1000, forced: null, message: null }),
    /outside its sandbox/,
  );
});

test('forced submit overrides whatever the model wanted to do', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'api-forced-'));
  const engineer = createApiEngineer({ role: { provider: 'zai', model: 'glm-5.3' } }, {
    generate: scriptedGenerate([JSON.stringify({ action: 'read', file: 'a.js' })]),
  });
  const action = await engineer.next({ prompt: 'task', sandbox, round: 9, workTokens: 2000, tokenCap: 1000, forced: 'submit', message: null });
  assert.equal(action.kind, 'submit');
});

test('the CLI student runs one confined agentic attempt, then check, then submit', async () => {
  // A real git repo, so the untracked scan is the real git answer.
  const sandbox = await mkdtemp(path.join(tmpdir(), 'cli-student-'));
  await exec('git', ['-C', sandbox, 'init', '-q']);
  await writeFile(path.join(sandbox, 'app.js'), 'old\n');
  await exec('git', ['-C', sandbox, 'add', '.']);
  await exec('git', ['-C', sandbox, '-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);

  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    if (command === 'claude') {
      calls.push({ command, args, cwd: options.cwd });
      // The "attempt" edits a tracked file and creates a new one, exactly
      // what a real agentic turn does.
      Promise.all([
        writeFile(path.join(sandbox, 'app.js'), 'new\n'),
        writeFile(path.join(sandbox, 'helper.js'), 'created\n'),
      ]).then(() => callback(null, JSON.stringify({
        type: 'result',
        result: 'Fixed the module and added a helper.',
        modelUsage: { 'claude-fable-5': { inputTokens: 900, outputTokens: 200 } },
      }), ''));
      return;
    }
    // git falls through to the real binary for the untracked scan.
    execFile(command, args, options, callback);
  };

  const agentDir = await mkdtemp(path.join(tmpdir(), 'agent-'));
  const agentPath = path.join(agentDir, 'daijin-engineer.md');
  await writeFile(agentPath, '---\nname: daijin-engineer\n---\n\nYou are the engineer.\n');

  const engineer = createCliEngineer({ role: { provider: 'claude-code', model: 'claude-fable-5' }, agentPath }, { execFileImpl });
  const context = { prompt: 'Fix it.', sandbox, round: 1, workTokens: 0, tokenCap: 100_000, forced: null, message: null };

  const edit = await engineer.next(context);
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.tokens, 1100, 'tokens come from the CLI usage report');
  assert.deepEqual(edit.created, ['helper.js'], 'the untracked scan declares the created file');
  const args = calls[0].args;
  assert.equal(calls[0].cwd, sandbox, 'the CLI runs inside the sandbox');
  assert.ok(!args.includes('Bash'), 'no shell for the student; the harness owns running gates');
  assert.ok(args.includes('--permission-mode') && args.includes('acceptEdits'));
  const appended = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(appended, /You are the engineer/);
  assert.doesNotMatch(appended, /name: daijin-engineer/);

  assert.equal((await engineer.next({ ...context, round: 2 })).kind, 'check');
  const submit = await engineer.next({ ...context, round: 3 });
  assert.equal(submit.kind, 'submit');
  assert.match(submit.explanation, /Fixed the module/);
});

test('a rehearsal refusal sends the CLI student back to work with the failure text', async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'cli-rehearsal-'));
  await exec('git', ['-C', sandbox, 'init', '-q']);
  const prompts = [];
  const execFileImpl = (command, args, options, callback) => {
    if (command === 'claude') {
      prompts.push(args[args.indexOf('-p') + 1]);
      callback(null, JSON.stringify({ type: 'result', result: 'done', modelUsage: {} }), '');
      return;
    }
    execFile(command, args, options, callback);
  };
  const engineer = createCliEngineer({ role: { provider: 'claude-code', model: 'claude-fable-5' } }, { execFileImpl });
  const context = { prompt: 'Fix it.', sandbox, round: 1, workTokens: 0, tokenCap: 100_000, forced: null, message: null };
  await engineer.next(context);
  await engineer.next({ ...context, round: 2 });
  await engineer.next({ ...context, round: 3 });
  const retry = await engineer.next({ ...context, round: 4, message: 'SUBMIT REHEARSAL: gates failed: build.' });
  assert.equal(retry.kind, 'edit');
  assert.match(prompts[1], /SUBMIT REHEARSAL: gates failed/, 'the harness feedback rides in front of the task');
});
