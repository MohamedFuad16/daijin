// repoClone: URL parsing, the managed location, and every refusal.
//
// The clone itself is exercised against a LOCAL BARE REPOSITORY rather than a network
// host, so the suite stays offline and deterministic. The one thing that buys us nothing
// is confidence about real remotes, which is stated rather than implied: what is proven
// here is the path derivation, the refusals and the step stream, not that github answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseCloneUrl, clonePathFor, cloneRepository } from '../src/init/clone.js';

const run = promisify(execFile);

async function bareRemote() {
  const root = await mkdtemp(path.join(tmpdir(), 'clone-src-'));
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  await run('git', ['init', '-q'], { cwd: work });
  await writeFile(path.join(work, 'README.md'), '# fixture\n');
  await run('git', ['add', '.'], { cwd: work });
  await run('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-q', '-m', 'first'], { cwd: work });
  const bare = path.join(root, 'owner', 'name.git');
  await mkdir(path.dirname(bare), { recursive: true });
  await run('git', ['clone', '-q', '--bare', work, bare]);
  return { bare, root };
}

// ---- parsing --------------------------------------------------------------------------

test('every URL form yields the same host, owner and name', () => {
  const expected = { host: 'github.com', owner: 'MohamedFuad16', name: 'daijin' };
  for (const url of [
    'https://github.com/MohamedFuad16/daijin',
    'https://github.com/MohamedFuad16/daijin.git',
    'https://github.com/MohamedFuad16/daijin/',
    'http://github.com/MohamedFuad16/daijin',
    'git@github.com:MohamedFuad16/daijin.git',
    'ssh://git@github.com/MohamedFuad16/daijin.git',
  ]) {
    assert.deepEqual(parseCloneUrl(url), expected, url);
  }
});

test('a self-hosted forge with a path prefix still yields the last two segments', () => {
  assert.deepEqual(parseCloneUrl('https://git.example.com/team/group/project.git'),
    { host: 'git.example.com', owner: 'group', name: 'project' });
});

test('unparseable and non-remote inputs are refused rather than guessed', () => {
  for (const bad of [
    '', '   ', 'cd', 'not a url',
    'https://github.com/onlyowner',          // no repository name
    'file:///Users/me/repo',                 // a local path is repoAttach's job
    '/Users/me/repo',
    'ftp://example.com/owner/name',
    'https:///owner/name',                   // no host
  ]) {
    assert.equal(parseCloneUrl(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('a URL that would climb out of the managed root is refused', () => {
  // The path is built by joining these segments, so `..` in one is a directory traversal.
  //
  // THE SCP FORM IS THE CASE THAT MATTERS and my first version of this test missed it: an
  // http URL normalises `..` away before it is ever split, so those inputs are refused for
  // being too short and prove nothing about the guard. `git@host:path` is not a URL and
  // never normalises, so it is the only form that can deliver a literal `..` as a segment.
  // A mutation removing the guard survived until this line existed.
  assert.equal(parseCloneUrl('git@h:a/../../x'), null, 'a literal .. segment must be refused');

  // Normalised away rather than caught by the guard, and listed here so the distinction is
  // visible: these are refused for having fewer than two segments left.
  assert.equal(parseCloneUrl('https://github.com/../etc'), null);
  assert.equal(parseCloneUrl('https://github.com/owner/..'), null);
});

test('the managed path carries host and owner, so two forges cannot collide', () => {
  const a = clonePathFor(parseCloneUrl('https://github.com/alice/engine'), { stateRoot: '/s' });
  const b = clonePathFor(parseCloneUrl('https://github.com/bob/engine'), { stateRoot: '/s' });
  const c = clonePathFor(parseCloneUrl('https://gitlab.com/alice/engine'), { stateRoot: '/s' });
  assert.equal(a, path.join('/s', 'clones', 'github.com', 'alice', 'engine'));
  assert.equal(new Set([a, b, c]).size, 3, 'a bare name would have collapsed these to one directory');
});

// ---- cloning --------------------------------------------------------------------------

test('a clone lands in the managed location and emits its steps in order', async () => {
  const { bare } = await bareRemote();
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'clone-state-'));
  const steps = [];
  const result = await cloneRepository({
    url: `https://example.test/owner/name`,
    stateRoot,
    emit: async (step, detail, extra) => { steps.push({ step, detail, extra }); },
    // The URL is parsed for its path; the fetch is pointed at the local bare repo, so the
    // derivation is exercised without the network.
    runGit: (args, options) => run('git', args.map((arg) => (arg === 'https://example.test/owner/name' ? bare : arg)), options),
  });

  assert.equal(result.reused, false);
  assert.equal(result.destination, path.join(stateRoot, 'clones', 'example.test', 'owner', 'name'));
  assert.ok((await readdir(result.destination)).includes('README.md'), 'the working tree is there');

  assert.deepEqual(steps.map((entry) => entry.step), ['resolving', 'cloning', 'cloned']);
  // The destination is DISCLOSED before the write, not after: this method writes outside
  // the repository and a user should not learn where by finding the directory later.
  assert.ok(steps[0].extra.destination);
  assert.match(steps[1].detail, /reaches the network and writes outside the repository/);
});

test('cloning the same repository twice REUSES the clone instead of failing or overwriting', async () => {
  const { bare } = await bareRemote();
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'clone-state-'));
  const url = 'https://example.test/owner/name';
  const swap = (args, options) => run('git', args.map((arg) => (arg === url ? bare : arg)), options);
  const first = await cloneRepository({ url, stateRoot, runGit: swap });
  assert.equal(first.reused, false);
  // The swap above points the FETCH at a local bare repo, so git records that local path
  // as origin. A real clone records the URL it was given, which is what the reuse check
  // compares against, so origin is set to the real thing here. Simulating the recorded
  // state rather than weakening the check: comparing a local path to an https URL would
  // never match, and a test that passed because of my own harness trick would be proving
  // nothing about the behaviour it names.
  await run('git', ['remote', 'set-url', 'origin', url], { cwd: first.destination });

  const steps = [];
  const second = await cloneRepository({
    url, stateRoot, runGit: swap, emit: async (step) => steps.push(step),
  });
  assert.equal(second.reused, true, 'the second clone reuses rather than re-fetching');
  assert.equal(second.destination, first.destination);
  assert.deepEqual(steps, ['resolving', 'cloned'], 'and does not emit a cloning step it did not do');
});

test('a destination holding a DIFFERENT repository is refused, never overwritten', async () => {
  const { bare } = await bareRemote();
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'clone-state-'));
  const url = 'https://example.test/owner/name';
  const seeded = await cloneRepository({ url, stateRoot, runGit: (a, o) => run('git', a.map((x) => (x === url ? bare : x)), o) });
  await run('git', ['remote', 'set-url', 'origin', url], { cwd: seeded.destination });

  // A different repository whose URL lands on the same managed path, which happens when
  // the name override is used carelessly.
  const other = 'https://example.test/owner/other';
  await assert.rejects(
    () => cloneRepository({
      url: other, name: 'name', stateRoot,
      runGit: (a, o) => run('git', a.map((x) => (x === other ? bare : x)), o),
    }),
    (error) => {
      assert.equal(error.code, 'destination-occupied');
      // That directory may hold the only copy of work someone did in a clone.
      assert.match(error.hint, /Pass a different name, or remove that directory yourself/);
      return true;
    },
  );
});

test('a failed clone leaves NO directory behind for the next attempt to trip over', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'clone-state-'));
  const url = 'https://example.test/owner/name';
  await assert.rejects(() => cloneRepository({
    url, stateRoot,
    // The mutation that survived my first version threw WITHOUT creating anything, so
    // there was no leftover to clean and the cleanup was never exercised. A real failed
    // clone leaves a partial directory behind, which is the whole point, so this one
    // creates it first.
    runGit: async (args) => {
      await mkdir(args[args.length - 1], { recursive: true });
      await writeFile(path.join(args[args.length - 1], 'partial'), 'x');
      throw Object.assign(new Error('fail'), { stderr: 'fatal: repository not found' });
    },
  }), (error) => {
    assert.equal(error.code, 'not-found');
    return true;
  });
  // Without the cleanup, the partial directory git leaves behind makes the NEXT attempt
  // fail as destination-occupied, blaming the user for git's leftovers.
  const clones = path.join(stateRoot, 'clones', 'example.test', 'owner', 'name');
  await assert.rejects(() => readdir(clones), { code: 'ENOENT' });
});

test('a private repository is refused BY NAME, not by passing git output through', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'clone-state-'));
  await assert.rejects(() => cloneRepository({
    url: 'https://example.test/owner/name', stateRoot,
    runGit: async () => { throw Object.assign(new Error('x'), { stderr: 'fatal: Authentication failed for ...' }); },
  }), (error) => {
    assert.equal(error.code, 'authentication-required');
    // Git's own wording reads as a broken credential to someone who never had one, and
    // the likely case is a private repo the owner can see in a browser because they are
    // logged in there.
    assert.match(error.hint, /private or does not exist/);
    assert.match(error.hint, /gh auth login/);
    return true;
  });
});

test('submodules are NOT recursed, and the flag is passed rather than assumed', async () => {
  const { bare } = await bareRemote();
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'clone-state-'));
  const url = 'https://example.test/owner/name';
  let seen = null;
  await cloneRepository({
    url, stateRoot,
    runGit: (args, options) => { seen = args; return run('git', args.map((a) => (a === url ? bare : a)), options); },
  });
  // A submodule URL is a second remote the owner did not name.
  assert.ok(seen.includes('--no-recurse-submodules'));
});

test('a cancelled job stops before writing anything', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'clone-state-'));
  let ran = false;
  const result = await cloneRepository({
    url: 'https://example.test/owner/name', stateRoot,
    cancelled: () => true,
    runGit: async () => { ran = true; },
  });
  assert.equal(result, null);
  assert.equal(ran, false, 'cancellation must be checked BEFORE the network call, not after');
});
