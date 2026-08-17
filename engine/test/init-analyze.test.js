// analyze(), the file walk, and the git reader.
//
// Hermetic: the only external process is the local `git` binary against a repository this
// test creates in a temp directory. No network, no live services (D-0015).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyze, detectBrainFolder, describeStructure } from '../src/init/analyze.js';
import { classifyCommit, parseLog, readHistory, shaIndex } from '../src/init/git.js';
import { areaOf, languageCensus, listRepoFiles } from '../src/init/walk.js';


const GIT_ENVIRONMENT = {
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'author@example.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function writeFiles(root, files) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function makeRepo(files, { commits = [], gitInit = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-analyze-'));
  writeFiles(root, files);
  if (!gitInit) return root;
  const git = (args, environment = {}) => execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, ...GIT_ENVIRONMENT, ...environment }, stdio: 'pipe',
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Fixture Author']);
  git(['config', 'user.email', 'author@example.test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial import of the fixture']);
  let day = 2;
  for (const [file, subject] of commits) {
    writeFileSync(path.join(root, file), `// ${subject}\n`, { flag: 'a' });
    git(['add', '-A']);
    git(['commit', '-m', subject], { GIT_AUTHOR_DATE: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`, GIT_COMMITTER_DATE: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z` });
    day += 1;
  }
  return root;
}

const SMALL_REPO = {
  'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node --test', lint: 'echo lint' } }),
  'src/store/sqlite.js': 'export function createStore() { return {}; }\n',
  'src/rag/rank.js': "import { createStore } from '../store/sqlite.js';\nexport function rank() { return createStore(); }\n",
  'README.md': '# fixture\n',
};

test('git is available; every history-derived measurement below depends on it', () => {
  // Stated as a test rather than assumed, because a missing git turns every history number
  // into a silent zero and the report would read as "this repo has no history".
  const version = execFileSync('git', ['--version'], { encoding: 'utf8' });
  assert.match(version, /^git version/);
});

test('the file list prefers git ls-files and records which source it used', async () => {
  const root = makeRepo(SMALL_REPO);
  try {
    const listing = await listRepoFiles(root);
    assert.equal(listing.source, 'git-ls-files');
    assert.deepEqual(listing.files, ['README.md', 'package.json', 'src/rag/rank.js', 'src/store/sqlite.js']);
    assert.equal(listing.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory with no git falls back to a filtered walk and says so', async () => {
  const root = makeRepo({ ...SMALL_REPO, 'node_modules/junk/index.js': 'module.exports = 1;\n' }, { gitInit: false });
  try {
    const listing = await listRepoFiles(root);
    assert.equal(listing.source, 'walk');
    assert.ok(!listing.files.some((file) => file.startsWith('node_modules/')), 'the walk must not descend into node_modules');
    assert.ok(listing.files.includes('src/store/sqlite.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the file cap is reported rather than applied silently', async () => {
  const root = makeRepo(SMALL_REPO);
  try {
    const listing = await listRepoFiles(root, { limit: 2 });
    assert.equal(listing.files.length, 2);
    assert.equal(listing.truncated, true, 'a silent cap makes every downstream count a lie of unknown size');
    assert.equal(listing.limit, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyze returns the five frozen contract fields and is deterministic', async () => {
  const root = makeRepo(SMALL_REPO, { commits: [['src/rag/rank.js', 'sort the ranking candidates']] });
  try {
    const first = await analyze(root);
    const second = await analyze(root);
    for (const field of ['languages', 'commitCount', 'structure', 'gateCandidates', 'hasBrainFolder']) {
      assert.ok(field in first, `analyze must return ${field} (RPC v4)`);
    }
    assert.equal(first.commitCount, 2);
    assert.equal(first.hasBrainFolder, false);
    assert.deepEqual(
      JSON.parse(JSON.stringify(first)),
      JSON.parse(JSON.stringify(second)),
      'two runs over an unchanged tree must produce identical bytes',
    );
    assert.ok(first.gateCandidates.some((gate) => gate.command === 'npm run test' && gate.role === 'test'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commitCount is null rather than 0 when there is no history', async () => {
  const root = makeRepo(SMALL_REPO, { gitInit: false });
  try {
    const analysis = await analyze(root);
    assert.equal(analysis.commitCount, null, 'null is "not a repository with commits"; 0 would read as a measured emptiness');
    assert.equal(analysis.git.repository, false);
    const history = await readHistory(root);
    assert.equal(history.available, false);
    assert.match(history.reason, /no git history/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a knowledge folder only counts when it holds markdown', () => {
  assert.equal(detectBrainFolder(['agent/agent.md', 'agent/state.md']).present, true);
  assert.equal(detectBrainFolder(['agent/agent.md']).kind, 'agent-folder');
  assert.equal(
    detectBrainFolder(['agent/.gitkeep', 'src/a.js']).present,
    false,
    'an empty folder is not a brain, and adopting one would divert the whole pipeline',
  );
});

test('areas descend one level through container directories and no further', () => {
  assert.equal(areaOf('src/store/sqlite.js'), 'src/store');
  assert.equal(areaOf('src/store/deep/nested/file.js'), 'src/store');
  assert.equal(areaOf('test/rank.test.js'), 'test');
  assert.equal(areaOf('index.js'), '(root)');
});

test('the language census counts files and bytes with exact integers', () => {
  const census = languageCensus(['a.js', 'b.js', 'c.py'], new Map([['a.js', 10], ['b.js', 20], ['c.py', 5]]));
  assert.deepEqual(census, [
    { language: 'JavaScript', files: 2, bytes: 30 },
    { language: 'Python', files: 1, bytes: 5 },
  ]);
});

test('describeStructure reports depth, manifests and the derived areas', () => {
  const files = ['package.json', 'src/store/a.js', 'src/store/b.js', 'src/rag/c.js'];
  const structure = describeStructure(files, new Map(files.map((file) => [file, 1])));
  assert.equal(structure.totalFiles, 4);
  assert.equal(structure.sourceFiles, 3);
  assert.equal(structure.maxDepth, 3);
  assert.deepEqual(structure.manifests, ['package.json']);
  assert.deepEqual(structure.areas, [{ area: 'src/store', fileCount: 2 }, { area: 'src/rag', fileCount: 1 }]);
});

test('parseLog survives the numstat forms that a live-only test passes by accident', () => {
  const log = [
    '\u001eabc123def456\u001fAda\u001fada@example.test\u001f2026-01-01T00:00:00Z\u001ffix: handle the empty case',
    'This reverts commit 0123456789abcdef',
    '',
    '3\t1\tsrc/a.js',
    '-\t-\tassets/logo.png',
    '5\t0\tsrc/{old => new}/b.js',
    '',
  ].join('\n');
  const [commit] = parseLog(log);
  assert.equal(commit.sha, 'abc123def456');
  assert.equal(commit.author, 'Ada');
  assert.equal(commit.subject, 'fix: handle the empty case');
  assert.deepEqual(commit.files.map((file) => file.path), ['src/a.js', 'assets/logo.png', 'src/new/b.js']);
  assert.equal(commit.files[1].binary, true, "a binary file reports '-' and must not become NaN");
  assert.equal(commit.files[2].renamed, true);
  const kind = classifyCommit(commit);
  assert.equal(kind.revert, true, 'the revert marker lives in the BODY, never the subject');
  assert.equal(kind.revertsSha, '0123456789abcdef');
  assert.equal(kind.fix, false, 'a revert is not classified as a fix as well');
});

test('classifyCommit names the classes the deterministic filter drops', () => {
  const commit = (files, subject = 'chore: touch') => ({ subject, body: '', files: files.map((path_) => ({ path: path_, added: 1, deleted: 0, binary: false, renamed: false })) });
  assert.equal(classifyCommit(commit(['docs/a.md', 'README.md'])).docsOnly, true);
  assert.equal(classifyCommit(commit(['package-lock.json'])).lockfileOnly, true);
  assert.equal(classifyCommit(commit(['src/a.js'])).docsOnly, false);
  assert.equal(classifyCommit(commit(['src/a.js'], 'fix: null guard')).fix, true);
  assert.equal(classifyCommit(commit([])).empty, true);
});

test('the history cap is reported, and the walk stops at it', async () => {
  const root = makeRepo(SMALL_REPO, {
    commits: [
      ['src/rag/rank.js', 'first change to the ranking module'],
      ['src/rag/rank.js', 'second change to the ranking module'],
      ['src/rag/rank.js', 'third change to the ranking module'],
    ],
  });
  try {
    const capped = await readHistory(root, { cap: 2 });
    assert.equal(capped.commits.length, 2);
    assert.equal(capped.capped, true, 'a cap that is not reported makes the ownership stats wrong by an unknown amount');
    assert.equal(capped.cap, 2);
    assert.equal(capped.total, 4);

    const full = await readHistory(root);
    assert.equal(full.capped, false);
    assert.equal(full.commits.length, 4);
    assert.equal(shaIndex(full.commits).has(full.commits[0].shortSha), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the walk is BOUNDED, which is the owner's hang -------------------------------------

/// A tree with more files than any cap under test, and a root manifest that a
/// lexicographic slice would discard in favour of files under `aaa/`.
function crowdedTree(fileCount) {
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-walk-'));
  mkdirSync(path.join(root, 'aaa', 'nested'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"crowded"}');
  writeFileSync(path.join(root, 'index.js'), 'export const x = 1;\n');
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(path.join(root, 'aaa', 'nested', `f${String(i).padStart(4, '0')}.js`), 'export const y = 1;\n');
  }
  return root;
}

test('the walk STOPS at the file cap rather than finishing and being trimmed', async () => {
  // The owner's home screen hung on an attached `/`: the walk crossed the entire disk and
  // the cap was applied afterwards, so it bounded the ANSWER and not the WORK. Proven
  // without timing, which would be flaky, by what the result CONTAINS.
  const root = crowdedTree(400);
  try {
    const listing = await listRepoFiles(root, { limit: 50 });
    assert.equal(listing.files.length, 50);
    assert.equal(listing.truncated, true);
    assert.equal(listing.stopped, 'file-limit');

    // THE PROOF THAT NO FULL WALK HAPPENED. Breadth-first stops at the root level, so the
    // root files are present. A walk that completed and then sorted-and-sliced would have
    // returned 50 files all under `aaa/`, because `aaa/nested/f0000.js` sorts before
    // `package.json`, and the repo would have lost its own manifest.
    assert.ok(listing.files.includes('package.json'), 'a truncated walk kept the root manifest');
    assert.ok(listing.files.includes('index.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the walk also stops on TIME, which a file cap cannot bound', async () => {
  // Two bounds because they stop different things. A cap stops a tree that is too large; a
  // deadline stops one that is too SLOW - a network mount, a fuse filesystem, a directory
  // that blocks. A count cap alone still hangs on ten slow directories, which is the case
  // a laptop actually meets when a volume goes away.
  const root = crowdedTree(400);
  try {
    const listing = await listRepoFiles(root, { limit: 1e9, timeBudgetMs: 0 });
    assert.equal(listing.stopped, 'deadline');
    assert.equal(listing.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ordinary repo is NOT capped, or the flag would mean nothing', async () => {
  // The positive control. Every assertion above would pass against a walk that returned
  // nothing at all, and a `capped` flag that is always true tells a client no more than a
  // flag that is always false.
  const root = crowdedTree(5);
  try {
    const listing = await listRepoFiles(root, { limit: 50_000 });
    assert.equal(listing.truncated, false);
    assert.equal(listing.stopped, null);
    assert.equal(listing.files.length, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('analyze carries the cap ON THE WIRE, not just in its own head', async () => {
  // analyze already knew it had truncated: the flag lived on `files`, which D-0035 removed
  // from the wire. So the engine held the caveat and no client could receive it, and a
  // capped census read as the whole repository. Documented and reachable, again.
  const root = crowdedTree(200);
  try {
    const capped = await analyze(root, { fileLimit: 40 });
    assert.deepEqual(capped.walk, { filesSeen: 40, capped: true, stoppedBy: 'file-limit', limit: 40 });

    const whole = await analyze(root, { fileLimit: 50_000 });
    assert.equal(whole.walk.capped, false);
    assert.equal(whole.walk.stoppedBy, null);
    assert.equal(whole.walk.filesSeen, 202);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the walk stops when the cap lands exactly on a directory boundary', async () => {
  // BOTH bounds checks are load-bearing and this is the case that needs the outer one.
  // The inner check fires while entries are being added; it cannot fire for a directory
  // with NO entries. So if the cap is reached exactly as a directory's entries run out,
  // and the queue still holds empty directories, only the check at the top of the loop
  // stops the walk. Without it the walker keeps calling readdir over every remaining
  // directory - unbounded work again, on a tree of empty directories.
  //
  // A mutation removing the outer check SURVIVED until this existed, because every other
  // fixture here reaches the cap mid-directory where the inner check catches it.
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-walk-edge-'));
  try {
    mkdirSync(path.join(root, 'a'), { recursive: true });
    for (let i = 0; i < 3; i += 1) writeFileSync(path.join(root, 'a', `f${i}.js`), 'export const x = 1;\n');
    // Sorted after `a`, so they are still queued when the cap is reached, and empty so the
    // inner check never runs for them.
    for (let i = 0; i < 12; i += 1) mkdirSync(path.join(root, `b${String(i).padStart(2, '0')}`), { recursive: true });

    const listing = await listRepoFiles(root, { limit: 3 });
    assert.equal(listing.files.length, 3);
    assert.equal(listing.stopped, 'file-limit',
      'the walk continued through the empty directories instead of stopping at the cap');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
