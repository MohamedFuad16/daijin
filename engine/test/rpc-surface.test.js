// Every v4 method answers over the pipe.
//
// The acceptance property: a method whose capability has not shipped returns a STRUCTURED
// not-implemented naming its phase, never a method-not-found. The TUI must be able to
// connect against today's engine and render honestly, and -32601 on a frozen surface would
// send its reader to the contract hunting for a typo that is not there.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { errorOf, resultOf, startDaemon } from './helpers/rpc-pipe.js';

const ERR_METHOD_NOT_FOUND = -32601;
const ERR_NOT_IMPLEMENTED = -32001;
const ERR_SPEND_REFUSED = -32050;

/// Every method row in methods.md v4, with params good enough to reach the handler.
function surface(repoPath) {
  return [
    ['hello', { clientVersion: '0.1.0' }],
    ['repoAttach', { repoPath }],
    ['repoDetach', { repoPath: '/definitely/not/attached' }],
    ['jobCancel', { jobId: 'job-none-0000' }],
    ['analyze', { repoPath }],
    ['initBrain', { repoPath, mode: 'layer1' }],
    ['diagnose', { repoPath }],
    ['diagnoseNarrate', { repoPath }],
    ['retrievalScore', { repoPath }],
    ['search', { repoPath, query: 'storage' }],
    ['documents', { repoPath }],
    ['scoreHistory', { repoPath }],
    ['serveStatus', {}],
    ['mcpSnippet', { repoPath }],
    ['budgetEstimate', { repoPath, mode: 'layer1+layer2' }],
    ['gatesDiscover', { repoPath }],
    ['gatesGet', { repoPath }],
    ['gatesSet', { repoPath, patch: { content: 'gates: []\n' } }],
    ['gymStart', { repoPath, config: {} }],
    ['gymStatus', {}],
    ['examList', {}],
    ['examMine', { repoPath }],
    ['examDetail', { examId: 'exam-0001' }],
    ['examVeto', { examId: 'exam-0001', reason: 'a reason long enough to be reviewable later' }],
    ['examUpdate', { examId: 'exam-0001', patch: {} }],
    ['settingsGet', {}],
    ['settingsSet', { patch: { retrieval: { tokenBudget: 4000 } } }],
    ['rolePing', { role: 'engineer' }],
    ['board', {}],
    ['agentFileGet', { repoPath, role: 'student' }],
    ['agentFileSet', { repoPath, role: 'student', content: '# rules\n' }],
  ];
}

/**
 * A THROWAWAY repo for one sweep, and the cleanup that stops its jobs outliving it.
 *
 * The sweep calls every method, and two of them (gatesDiscover, initBrain) START JOBS and
 * return a jobId immediately. Run against the file's shared fixture, those jobs kept
 * working while twenty-two later tests used the same repo, and the discovery job's write
 * landed wherever contention put it. That is the CI gates-are-data failure (run
 * 31937439737), traced by verifier report 20: a fast local machine finishes the sweep
 * before the job lands and a loaded CI container does not.
 *
 * The sharing is REMOVED rather than sequenced around. Awaiting the jobs inline would turn
 * a fast contract check into a slow integration test, which is a different thing wearing
 * the same name.
 *
 * And the jobs are CANCELLED rather than left running. Un-awaited work that outlives its
 * test file is a background writer with no owner: it cannot corrupt this file's fixture any
 * more, but it can still hold a temp directory open while the file tries to remove it, and
 * "nobody is looking at it" is not a lifecycle.
 *
 * THE CANCEL CONTRACT THIS RELIES ON, read rather than assumed (JobRunner.cancel):
 * cancellation is COOPERATIVE and never throws. An unknown or already-finished job returns
 * `{ cancelled: false }`, which the runner documents as an answer rather than an error,
 * because a user cancelling a job that just finished has not done anything wrong. So the
 * cleanup below cannot itself become a flake source.
 *
 * What cancellation does NOT give is a hard stop: the job halts at its next checkpoint, so
 * one already past its last checkpoint still completes its write. The isolation therefore
 * rests on the OWN REPO, not on the cancel; the cancel exists so the work stops sooner and
 * nothing keeps running past the file that started it.
 */
async function sweepRepo(daemon, label) {
  const root = await mkdtemp(path.join(tmpdir(), `daijin-sweep-${label}-`));
  await mkdir(path.join(root, '.daijin'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0' } }), 'utf8');
  await daemon.request('repoAttach', { repoPath: root });
  const started = [];
  return {
    root,
    /// Remember any job the sweep kicks off, so it can be stopped afterwards.
    note(envelope) {
      const jobId = envelope?.result?.jobId;
      if (typeof jobId === 'string') started.push(jobId);
      return envelope;
    },
    startedJobs: () => [...started],
    async cleanup() {
      for (const jobId of started) await daemon.request('jobCancel', { jobId });
      await daemon.request('repoDetach', { repoPath: root });
      await rm(root, { recursive: true, force: true });
    },
  };
}

let daemon;
let repoPath;

before(async () => {
  repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-repo-'));
  await mkdir(path.join(repoPath, '.daijin'), { recursive: true });
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0' } }), 'utf8');
  daemon = await startDaemon();
  await daemon.request('repoAttach', { repoPath });
});

after(async () => {
  await daemon.stop();
  await rm(repoPath, { recursive: true, force: true });
});

test('every v4 method answers, and none is a missing method', async () => {
  const sweep = await sweepRepo(daemon, 'answers');
  try {
    const missing = [];
    for (const [method, params] of surface(sweep.root)) {
      const envelope = sweep.note(await daemon.request(method, params));
      assert.ok(envelope.result !== undefined || envelope.error, `${method} produced no envelope`);
      if (envelope.error?.code === ERR_METHOD_NOT_FOUND) missing.push(method);
    }
    assert.deepEqual(missing, [], 'a frozen method answering method-not-found is a lie about the contract');
    // The sweep really does start background work; if it ever stops, this assertion is the
    // thing that notices, and the cleanup below stops being necessary rather than silently
    // stopping being effective.
    assert.ok(sweep.startedJobs().length > 0, 'the sweep starts jobs, which is why it needs its own repo');

    // THE ISOLATION, asserted positively rather than hoped. This is the first test in the
    // file, so nothing else has written to the shared fixture yet: if the sweep's jobs can
    // still reach it, a gates.yaml appears here and the twenty-two tests that follow are
    // sharing a repo with a background writer again.
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(path.join(repoPath, '.daijin', 'gates.yaml')),
      'the sweep must not write into the fixture the rest of the file uses');
  } finally {
    await sweep.cleanup();
  }
});

test('every not-implemented answer names the phase that will implement it', async () => {
  const deferred = [];
  for (const [method, params] of surface(repoPath)) {
    const envelope = await daemon.request(method, params);
    if (envelope.error?.code !== ERR_NOT_IMPLEMENTED) continue;
    deferred.push(method);
    const { data } = envelope.error;
    assert.ok(data.phase, `${method} deferred without naming a phase`);
    assert.match(data.phase, /^P\d/, `${method} phase should read like P3 or P4, got ${data.phase}`);
    assert.ok(data.hint.length > 20, `${method} hint is too thin to display`);
  }
  // The list is ALLOWED to be empty, and as of the gym wiring it is: every method in this
  // sweep either works or refuses for a reason the caller can act on. It was not always,
  // and the guard against the list emptying for the WRONG reason (the code stopping
  // answering rather than starting working) is the first test, not a count here.
  //
  // What remains deferred is reachable only with different params than this sweep sends:
  // initBrain mode ingest, covered in its own test. rolePing left this list when its
  // real implementation landed (owner field round 4).
  for (const method of deferred) assert.ok(method, method);
});

test('the deferrals that remain are reachable, and still name their phase', async () => {
  // A deferral that no test reaches is a deferral nobody notices going stale.
  const ingest = errorOf(await daemon.request('initBrain', { repoPath, mode: 'ingest' }));
  assert.equal(ingest.code, ERR_NOT_IMPLEMENTED);
  assert.match(ingest.data.phase, /^P3/);
});

test('the handshake, repo lifecycle and settings are really wired', async () => {
  const hello = resultOf(await daemon.request('hello', {}));
  assert.equal(hello.contractVersion, '5');

  const second = await mkdtemp(path.join(tmpdir(), 'daijin-repo2-'));
  try {
    const attached = resultOf(await daemon.request('repoAttach', { repoPath: second }));
    assert.equal(attached.repo.path, path.resolve(second));
    assert.equal(attached.repo.health, 'no-brain', 'a repo with no brain says so');

    const status = resultOf(await daemon.request('serveStatus', {}));
    assert.ok(status.repos.some((row) => row.path === path.resolve(second)));
    assert.equal(typeof status.spendGate.open, 'boolean', 'the gate is observable before anything is attempted');
    assert.equal(status.ollama.reachable, false, 'the probe was skipped, and it says so rather than claiming health');

    assert.deepEqual(resultOf(await daemon.request('repoDetach', { repoPath: second })), { ok: true });
    const gone = errorOf(await daemon.request('repoDetach', { repoPath: second }));
    assert.equal(gone.code, -32602, 'detaching twice is a parameter error, not a crash');
  } finally {
    await rm(second, { recursive: true, force: true });
  }
});

test('settings round trip, and a key VALUE is refused', async () => {
  const before_ = resultOf(await daemon.request('settingsGet', {}));
  assert.ok(Array.isArray(before_.roles) && before_.roles.length === 4);
  assert.equal(before_.retrieval.tokenBudget, 4000, 'the anchor budget is the default');

  const updated = resultOf(await daemon.request('settingsSet', {
    patch: { roles: [{ role: 'engineer', model: 'some-model', keyRef: 'DAIJIN_ENGINEER_KEY' }], retrieval: { tokenBudget: 6000 } },
  }));
  const engineer = updated.roles.find((row) => row.role === 'engineer');
  assert.equal(engineer.model, 'some-model');
  assert.equal(engineer.keyRef, 'DAIJIN_ENGINEER_KEY', 'the pointer is stored');
  assert.ok(engineer.keyMasked && !engineer.keyMasked.includes('ENGINEER_KEY'), 'and displayed masked');
  assert.equal(updated.retrieval.tokenBudget, 6000);

  // A secret VALUE must never reach the daemon, and the refusal has to be explicit rather
  // than a silent drop that leaves the user thinking their key was saved.
  const refused = errorOf(await daemon.request('settingsSet', {
    patch: { roles: [{ role: 'engineer', apiKey: 'sk-not-a-real-key' }] },
  }));
  assert.equal(refused.code, -32602);
  assert.match(refused.data.hint, /pointer|keyRef/i);

  // A ping is a measurement, never a setting: a client must not be able to mark its own
  // role ready without a provider ever answering.
  const pinged = resultOf(await daemon.request('settingsSet', {
    patch: { roles: [{ role: 'engineer', ping: { ok: true, httpStatus: 200 } }] },
  }));
  assert.equal(pinged.roles.find((row) => row.role === 'engineer').ping, null,
    'v5: a never-verified role is ping null, and a client cannot patch itself into looking verified');
});

test('methods that need a brain say so, rather than failing obscurely', async () => {
  for (const method of ['search', 'retrievalScore']) {
    const params = method === 'search' ? { repoPath, query: 'anything' } : { repoPath };
    const error = errorOf(await daemon.request(method, params));
    assert.equal(error.code, -32602, `${method} should be a parameter-shaped refusal`);
    assert.match(error.data.hint, /brain/i, `${method} should name the missing brain`);
  }
});

test('a method on an unattached repo is refused before it touches the filesystem', async () => {
  const error = errorOf(await daemon.request('documents', { repoPath: '/definitely/not/attached' }));
  assert.equal(error.code, -32602);
  assert.match(error.data.hint, /not attached/);
});

test('gates are data: set writes the file, get reads it back', async () => {
  const content = 'gates:\n  - name: test\n    command: exit 0\n';
  resultOf(await daemon.request('gatesSet', { repoPath, patch: { content } }));
  const read = resultOf(await daemon.request('gatesGet', { repoPath }));
  assert.equal(read.content, content, 'the engine stores what the user wrote, unedited');

  const refused = errorOf(await daemon.request('gatesSet', { repoPath, patch: { gates: [] } }));
  assert.equal(refused.code, -32602, 'a structural patch is refused: the engine does not author this file');
});

test('scoreHistory and board answer empty rather than erroring when nothing exists', async () => {
  assert.deepEqual(resultOf(await daemon.request('scoreHistory', { repoPath })), [],
    'a repo whose floor was never measured has no trend, which is not an error');
  const board = resultOf(await daemon.request('board', {}));
  assert.deepEqual(board, { rows: [], total: 0 });
});

test('mcpSnippet stays locked below the threshold', async () => {
  const locked = resultOf(await daemon.request('mcpSnippet', { repoPath }));
  assert.equal(locked.unlocked, false);
  assert.equal(locked.threshold, 0.75);
  assert.equal(locked.snippet, null, 'a snippet offered below the floor would recommend a brain that cannot answer');
});

test('analyze reports the five frozen contract fields', async () => {
  const result = resultOf(await daemon.request('analyze', { repoPath }));
  for (const field of ['languages', 'commitCount', 'structure', 'gateCandidates', 'hasBrainFolder']) {
    assert.ok(Object.hasOwn(result, field), `analyze is missing the contract field ${field}`);
  }
});

test('jobCancel on an unknown job answers false rather than erroring', async () => {
  // A user cancelling a job that just finished has not done anything wrong.
  assert.deepEqual(resultOf(await daemon.request('jobCancel', { jobId: 'job-gone-0001' })), { cancelled: false });
});

test('the spend-touching methods are exactly the four the contract enumerates', async () => {
  // Drives every method with NO confirmation and collects which ones refuse with -32050.
  // A fifth spend refusal appearing here means someone added a spend path, which the
  // contract says is a contract change and not an implementation detail.
  const sweep = await sweepRepo(daemon, 'spend');
  try {
    const refusing = [];
    for (const [method, params] of surface(sweep.root)) {
      const envelope = sweep.note(await daemon.request(method, params));
      if (envelope.error?.code === ERR_SPEND_REFUSED) refusing.push(method);
    }
    assert.deepEqual(refusing.sort(), ['diagnoseNarrate', 'examMine', 'gymStart', 'rolePing'].sort(),
      'initBrain only spends on layer1+layer2, which this sweep calls with layer1');
  } finally {
    await sweep.cleanup();
  }
});

// ---- agent instruction files, wired against the shipped defaults -------------------------

test('agentFileGet reads the shipped default when the repo has no file yet', async () => {
  // A fresh repo has no .daijin/agents/, and that must read as the DEFAULT rather than as
  // an error: the gym has to be runnable before anyone has opened settings.
  //
  // Its OWN repo on purpose. The surface sweep above writes a student file, so reusing the
  // shared fixture would test a repo that already has one, which is the opposite case.
  const fresh = await mkdtemp(path.join(tmpdir(), 'daijin-agents-'));
  await daemon.request('repoAttach', { repoPath: fresh });
  try {
  const result = resultOf(await daemon.request('agentFileGet', { repoPath: fresh, role: 'student' }));
  assert.ok(result.content.length > 100, 'the shipped default has real content');
  assert.equal(result.installed, false, 'nothing is written to the repo by reading');
  assert.equal(result.modified, false, 'the default is not a modification of itself');
  assert.equal(result.currentHash, result.defaultHash);
  assert.match(result.path, /\.daijin\/agents\/student\.md$/);
  } finally {
    await daemon.request('repoDetach', { repoPath: fresh });
    await rm(fresh, { recursive: true, force: true });
  }
});

test('agentFileSet round trips and drives the modified badge', async () => {
  const original = resultOf(await daemon.request('agentFileGet', { repoPath, role: 'teacher' }));

  const edited = `${original.content}\n\nAn owner's added rule.\n`;
  const written = resultOf(await daemon.request('agentFileSet', { repoPath, role: 'teacher', content: edited }));
  assert.equal(written.modified, true, 'an edited file is modified from its default');
  assert.equal(written.defaultHash, original.defaultHash, 'the DEFAULT hash does not move when the user edits');
  assert.notEqual(written.currentHash, original.currentHash);
  assert.equal(written.installed, true);

  // And it persists, which is the whole point of the badge surviving a restart.
  const reread = resultOf(await daemon.request('agentFileGet', { repoPath, role: 'teacher' }));
  assert.equal(reread.content, edited);
  assert.equal(reread.modified, true);

  // Restoring the default clears the badge rather than leaving it stuck on.
  const restored = resultOf(await daemon.request('agentFileSet', { repoPath, role: 'teacher', content: original.content }));
  assert.equal(restored.modified, false);
});

test('an empty instruction file is refused, because it silently removes every rule', async () => {
  // The one edit that looks like a small change and is not: an empty rules file is not a
  // permissive rules file, it is an unlogged behaviour change to a measured system.
  for (const content of ['', '   \n']) {
    const error = errorOf(await daemon.request('agentFileSet', { repoPath, role: 'watcher', content }));
    assert.equal(error.code, -32602);
    assert.match(error.data.hint, /empty/i);
  }
  // And the refusal left the previous content alone.
  const after = resultOf(await daemon.request('agentFileGet', { repoPath, role: 'watcher' }));
  assert.ok(after.content.length > 100);
});

test('agent files are per role and per repo', async () => {
  const roles = ['student', 'teacher', 'auditor', 'watcher'];
  const records = [];
  for (const role of roles) records.push(resultOf(await daemon.request('agentFileGet', { repoPath, role })));
  const hashes = new Set(records.map((row) => row.defaultHash));
  assert.equal(hashes.size, roles.length, 'four roles, four distinct shipped defaults');
  for (const [index, role] of roles.entries()) {
    assert.match(records[index].path, new RegExp(`${role}\\.md$`));
  }
  const bad = errorOf(await daemon.request('agentFileGet', { repoPath, role: 'engineer' }));
  assert.equal(bad.code, -32602, 'engineer is a MODEL role, not an instruction-file role');
});

// ---- gates.yaml is the user's file, even while discovery is running ----------------------
//
// Found from CI run 31937439737, where "gates are data" failed on a fresh checkout in a
// single container: gatesSet stored the user's content and gatesGet, milliseconds later,
// read back the generated discovered-gates header. No concurrent lane and no mutation
// battery can exist in that environment, so the race is inside the suite process.
//
// The mechanism, reproduced by construction below: gatesDiscover starts a JOB and returns
// immediately, the job classifies by RUNNING commands, which takes as long as it takes, and
// at the end it wrote gates.yaml unconditionally. Anything the user wrote in between was
// destroyed. The surface sweep starts that job and never drains it, which is why the
// failure landed in a later test rather than in the sweep.
//
// This is a PRODUCT defect and not only a test-isolation one. The file's own header says
// "this file is DATA: edit it, and the engine obeys it", and a job that overwrites at the
// end obeys nothing.

test('discovery does not clobber an edit made while it was running', async () => {
  const { createRpcServer } = await import('../src/rpc/server.js');
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-gates-race-state-'));
  const own = await mkdtemp(path.join(tmpdir(), 'daijin-gates-race-repo-'));
  await mkdir(path.join(own, '.daijin'), { recursive: true });
  await writeFile(path.join(own, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0', lint: 'exit 0' } }), 'utf8');

  const server = createRpcServer({ stateRoot, write: () => {} });
  try {
    await server.methods.repoAttach({ repoPath: own });

    // Start discovery and DO NOT drain, which is exactly the state the sweep leaves behind.
    await server.methods.gatesDiscover({ repoPath: own });

    const mine = 'gates:\n  - name: mine\n    command: exit 0\n';
    await server.methods.gatesSet({ repoPath: own, patch: { content: mine } });
    await server.jobs.drain();

    const read = await server.methods.gatesGet({ repoPath: own });
    assert.equal(read.content, mine,
      'the user edited gates.yaml while discovery ran; discovery must keep their version, not overwrite it');
    assert.ok(!read.content.includes('Daijin discovered gates'),
      'and specifically must not replace it with the generated header');
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(own, { recursive: true, force: true });
  }
});

test('with nothing edited, discovery still writes its result', async () => {
  // The refusal must be narrow. A discovery that never writes because it is afraid of
  // clobbering would be a feature that silently stopped working, which is worse than the
  // defect it replaced.
  const { createRpcServer } = await import('../src/rpc/server.js');
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-gates-write-state-'));
  const own = await mkdtemp(path.join(tmpdir(), 'daijin-gates-write-repo-'));
  await mkdir(path.join(own, '.daijin'), { recursive: true });
  await writeFile(path.join(own, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0', lint: 'exit 0' } }), 'utf8');

  const server = createRpcServer({ stateRoot, write: () => {} });
  try {
    await server.methods.repoAttach({ repoPath: own });
    await server.methods.gatesDiscover({ repoPath: own });
    await server.jobs.drain();
    const read = await server.methods.gatesGet({ repoPath: own });
    assert.match(read.content, /Daijin discovered gates/, 'an undisturbed discovery writes its file');
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(own, { recursive: true, force: true });
  }
});

test('gatesSet and gatesGet return the SAME shape, so a save renders like a read', async () => {
  // The claim audit's one false claim, and it was mine: gatesGet gained its parsed half and
  // gatesSet did not, so a client that SET a file and re-rendered got a different shape from
  // one that GOT it. That is the defect tui-builder had just reported one level up,
  // reintroduced an hour later between two sibling methods.
  const { createRpcServer } = await import('../src/rpc/server.js');
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-gates-siblings-state-'));
  const own = await mkdtemp(path.join(tmpdir(), 'daijin-gates-siblings-repo-'));
  await mkdir(path.join(own, '.daijin'), { recursive: true });

  const server = createRpcServer({ stateRoot, write: () => {} });
  try {
    await server.methods.repoAttach({ repoPath: own });
    const content = 'gates:\n  - id: mine\n    command: exit 0\n    classification: live\n';
    const set = await server.methods.gatesSet({ repoPath: own, patch: { content } });
    const got = await server.methods.gatesGet({ repoPath: own });

    assert.deepEqual(Object.keys(set).sort(), Object.keys(got).sort(), 'siblings must agree on shape');
    assert.deepEqual(set.discovered, got.discovered, 'and on what they parsed');
    assert.equal(set.content, content, 'the engine stores what the user wrote, byte for byte');

    // A save that breaks the file says so IMMEDIATELY, rather than the user discovering it
    // on the next screen.
    const broken = await server.methods.gatesSet({ repoPath: own, patch: { content: 'gates:\n  - id: x\n   bad: indent\n' } });
    assert.equal(broken.discovered, null);
    assert.match(broken.parseError, /not valid YAML/);
    assert.ok(broken.content.includes('bad: indent'), 'and their text comes back regardless');
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(own, { recursive: true, force: true });
  }
});

test('a full-content write is accepted over a BROKEN file, because that is the repair path', async () => {
  // The client's mock refused this, which would have taught the screen a safety the engine
  // does not provide. It is not a leniency: gatesSet is the only way a user can fix the file
  // they broke, so refusing to write because the current content does not parse would lock
  // them out of their own repair.
  const { createRpcServer } = await import('../src/rpc/server.js');
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-gates-repair-state-'));
  const own = await mkdtemp(path.join(tmpdir(), 'daijin-gates-repair-repo-'));
  await mkdir(path.join(own, '.daijin'), { recursive: true });

  const server = createRpcServer({ stateRoot, write: () => {} });
  try {
    await server.methods.repoAttach({ repoPath: own });
    const broken = await server.methods.gatesSet({ repoPath: own, patch: { content: 'gates:\n  - id: x\n   bad: indent\n' } });
    assert.equal(broken.discovered, null, 'the engine wrote it and says it does not parse');

    const repaired = await server.methods.gatesSet({ repoPath: own, patch: { content: 'gates:\n  - id: x\n    command: exit 0\n' } });
    assert.notEqual(repaired.discovered, null, 'and the repair is accepted over the broken file');
    assert.equal(repaired.parseError, null);

    // What IS refused, always and regardless of the file's state: a structural patch. The
    // engine replaces the whole document on the user's instruction and never merges into
    // one, because it treats gates.yaml as data it does not author.
    for (const patch of [{ gates: [] }, { gates: [{ id: 'x' }] }, {}]) {
      const refused = await server.methods.gatesSet({ repoPath: own, patch }).then(() => null).catch((error) => error);
      assert.equal(refused?.code, -32602, `a structural patch must be refused: ${JSON.stringify(patch)}`);
    }
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(own, { recursive: true, force: true });
  }
});

test('a brain that cannot be opened reports critical, and keeps its measured floor', async () => {
  // Found by applying tui-builder's fourth-double lead to my own lane. I verified this
  // branch BY HAND today, answering their question about whether a stale floor survives,
  // and never wrote the test: every double in this suite opens a store successfully, so the
  // one health value that requires a failure was unreachable from the tests.
  //
  // My own enum gate made that harder to notice rather than easier, which is the part worth
  // recording: it asserts `critical` is DOCUMENTED, and a value can be documented, named in
  // the contract, printed in a coverage list, and still be produced by no code path any
  // test reaches. Documented and reachable are different claims.
  const { createRpcServer } = await import('../src/rpc/server.js');
  const { repoLayout } = await import('../src/state/layout.js');
  const { createSqliteStore } = await import('../src/store/sqlite.js');

  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-critical-state-'));
  const own = await mkdtemp(path.join(tmpdir(), 'daijin-critical-repo-'));
  await mkdir(path.join(own, '.daijin'), { recursive: true });

  const server = createRpcServer({ stateRoot, write: () => {} });
  try {
    await server.methods.repoAttach({ repoPath: own });
    assert.equal((await server.methods.serveStatus({})).repos[0].health, 'no-brain',
      'never indexed reads as no-brain, not as broken');

    // A real indexed brain and a real measured floor.
    const layout = await repoLayout(own, { stateRoot, ensure: true });
    await mkdir(layout.indexRoot, { recursive: true });
    await mkdir(layout.recordsRoot, { recursive: true });
    const store = await createSqliteStore({
      path: layout.databasePath, repoPath: own, project: 'default',
      embedder: { provider: 'ollama', model: 'bge-m3', digest: 'sha256:test', dimension: 4 },
    });
    await store.transaction(async () => {
      await store.upsertDocument({
        id: 'web.decision.adr-0001', project: 'default', type: 'decision', path: 'brain/a.md',
        title: 'A', tags: [], meta: {}, content: 'x', contentHash: 'h',
      });
      await store.replaceChunks('web.decision.adr-0001', [{ ordinal: 0, content: 'x', vector: [1, 0, 0, 0] }]);
    });
    await store.close();
    await writeFile(layout.scoreHistoryPath, JSON.stringify([
      { at: new Date().toISOString(), caseRate: { exact: 0.92, cases: '23 of 25' }, chosenBudget: 4000 },
    ]), 'utf8');

    const healthy = (await server.methods.serveStatus({})).repos[0];
    assert.equal(healthy.health, 'ok');
    assert.equal(healthy.floorScore, 0.92);

    // Break it the way deleting or truncating state does.
    await writeFile(layout.databasePath, 'this is not a database', 'utf8');
    const broken = (await server.methods.serveStatus({})).repos[0];
    assert.equal(broken.health, 'critical', 'an unopenable brain is a state to show, not a crash');

    // THE FLOOR SURVIVES. It lives in records/, measured on a date by a particular embedder,
    // and nothing recomputes the past; breaking the index cannot unmake the measurement.
    // A client rendering "no floor can be measured" here would be describing the brain and
    // hiding a number it has.
    assert.equal(broken.floorScore, 0.92,
      'a measured floor is a record, not a property of the index that can be broken');
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(own, { recursive: true, force: true });
  }
});
