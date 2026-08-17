// The owner field test, engine half. Each test names the finding it pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { inspectAttachTarget } from '../src/rpc/methods.js';
import { ollamaDown, OLLAMA_DOWN } from '../src/rag/embed.js';

const run = promisify(execFile);

async function gitRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'ft-repo-'));
  await run('git', ['init', '-q'], { cwd: root });
  return root;
}

// ---- F2: the attach footgun ---------------------------------------------------------

test('F2 attach refuses a path that does not exist, naming it', async () => {
  const missing = path.join(tmpdir(), 'ft-definitely-absent-9d3a1');
  const { refusal, warning } = await inspectAttachTarget(missing);
  assert.equal(warning, null);
  assert.equal(refusal.summary, 'no such directory');
  // The literal `cd` the owner typed is this case, and the hint must show the RESOLVED
  // path: "cd does not exist" is baffling until you see it resolved against the cwd.
  assert.match(refusal.hint, /ft-definitely-absent-9d3a1/);
  assert.ok(path.isAbsolute(refusal.hint.split(' ')[0]));
});

test('F2 attach refuses a file', async () => {
  const root = await gitRepo();
  const file = path.join(root, 'README.md');
  await writeFile(file, '# hi\n');
  const { refusal, warning } = await inspectAttachTarget(file);
  assert.equal(warning, null);
  assert.equal(refusal.summary, 'not a directory');
});

test('F2 attach WARNS on a subdirectory of a repo and names the root', async () => {
  const root = await gitRepo();
  const nested = path.join(root, 'docs', 'notes');
  await mkdir(nested, { recursive: true });
  const { refusal, warning } = await inspectAttachTarget(nested);
  assert.equal(refusal, null);
  assert.equal(warning.code, 'nested-in-repository');
  assert.equal(warning.attached, nested);
  // The repository root is CARRIED, not merely described, so a client can offer to attach
  // it instead. A message the user has to retype by hand is where the field test stalled.
  // Compared through realpath on BOTH sides: on macOS the tmpdir is reached via a /var
  // symlink, and comparing spellings rather than canonical paths is the exact bug this
  // suite caught in the first version of inspectAttachTarget.
  assert.equal(warning.repositoryRoot, await realpath(root));
  // What the user typed is echoed back unresolved, so the message quotes their own words.
  assert.equal(warning.attached, nested);
});

test('F2 attach is clean at the repository root', async () => {
  const root = await gitRepo();
  const { refusal, warning } = await inspectAttachTarget(root);
  assert.equal(refusal, null);
  assert.equal(warning, null);
});

test('F2 a directory with no git WARNS rather than refusing, because init still completes', async () => {
  const plain = await mkdtemp(path.join(tmpdir(), 'ft-nogit-'));
  const { refusal, warning } = await inspectAttachTarget(plain);
  // Measured before this was decided: init on a non-git directory reaches the gold-set
  // gate and blocks there, which is the same block a thin repo gets. It produces LESS,
  // it does not fail to work, and this function's whole distinction is refuse-what-cannot
  // -work versus warn-about-what-surprises.
  assert.equal(refusal, null);
  assert.equal(warning.code, 'not-a-git-repository');
  assert.equal(warning.repositoryRoot, null);
  assert.match(warning.detail, /thinner/);
});

test('F2 the two warning codes are the only ones, and every warning carries the full key set', async () => {
  const root = await gitRepo();
  const nested = path.join(root, 'sub');
  await mkdir(nested);
  const plain = await mkdtemp(path.join(tmpdir(), 'ft-nogit2-'));
  for (const dir of [nested, plain]) {
    const { warning } = await inspectAttachTarget(dir);
    assert.deepEqual(
      Object.keys(warning).sort(),
      ['attached', 'code', 'detail', 'repositoryRoot'],
      'a client reads one shape regardless of which warning it got',
    );
    assert.ok(['nested-in-repository', 'not-a-git-repository'].includes(warning.code));
  }
});

// ---- F5: the unreachable-host message must name the host it tried --------------------

test('F5 the ollama-down message names the endpoint it actually tried', () => {
  const remote = ollamaDown('http://gpu-box.local:11434');
  assert.match(remote, /gpu-box\.local:11434/);
  assert.ok(remote.startsWith(OLLAMA_DOWN));
  // brew is macOS-local advice and cannot help someone whose ollama is on another host.
  assert.doesNotMatch(remote, /brew/);
});

test('F5 brew advice survives for a local endpoint, including the default', () => {
  for (const local of [undefined, 'http://localhost:11434', 'http://127.0.0.1:11434']) {
    assert.match(ollamaDown(local), /brew services start ollama/);
  }
});

test('F5 the LOCAL message also names its endpoint', () => {
  // Added because a mutation that stripped the endpoint from the local branch SURVIVED:
  // the endpoint assertion above used a remote host, so the branch that runs on almost
  // every machine was the one nothing checked. A port is the useful half here, since a
  // second ollama on 11435 is exactly the confusion this field is meant to end.
  assert.match(ollamaDown('http://127.0.0.1:11435'), /127\.0\.0\.1:11435/);
  assert.match(ollamaDown(undefined), /localhost:11434/);
});

test('F5 the message never names a host other than the one tried', () => {
  // The defect this pins: the old constant hardcoded localhost:11434, so the hint
  // contradicted the endpoint on its own row the moment the endpoint became visible.
  assert.doesNotMatch(ollamaDown('http://gpu-box.local:11434'), /localhost|127\.0\.0\.1/);
});
