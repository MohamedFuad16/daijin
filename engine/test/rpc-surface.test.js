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
  const missing = [];
  for (const [method, params] of surface(repoPath)) {
    const envelope = await daemon.request(method, params);
    assert.ok(envelope.result !== undefined || envelope.error, `${method} produced no envelope`);
    if (envelope.error?.code === ERR_METHOD_NOT_FOUND) missing.push(method);
  }
  assert.deepEqual(missing, [], 'a frozen method answering method-not-found is a lie about the contract');
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
  // initBrain mode ingest, and rolePing once confirmed. Both are covered in their own tests.
  for (const method of deferred) assert.ok(method, method);
});

test('the deferrals that remain are reachable, and still name their phase', async () => {
  // A deferral that no test reaches is a deferral nobody notices going stale.
  const ingest = errorOf(await daemon.request('initBrain', { repoPath, mode: 'ingest' }));
  assert.equal(ingest.code, ERR_NOT_IMPLEMENTED);
  assert.match(ingest.data.phase, /^P3/);

  const ping = errorOf(await daemon.request('rolePing', { role: 'engineer', confirm: true }));
  assert.equal(ping.code, ERR_NOT_IMPLEMENTED);
  assert.match(ping.data.phase, /^P3/);
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
  const refusing = [];
  for (const [method, params] of surface(repoPath)) {
    const envelope = await daemon.request(method, params);
    if (envelope.error?.code === ERR_SPEND_REFUSED) refusing.push(method);
  }
  assert.deepEqual(refusing.sort(), ['diagnoseNarrate', 'gymStart', 'rolePing'].sort(),
    'initBrain only spends on layer1+layer2, which this sweep calls with layer1');
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
