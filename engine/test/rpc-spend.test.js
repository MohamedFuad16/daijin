// Spend discipline on the RPC surface.
//
// The contract enumerates the spend-touching methods EXHAUSTIVELY: gymStart (owner gate),
// rolePing (explicit user action per call), initBrain with mode layer1+layer2 (budget
// confirmed per call), and diagnoseNarrate (explicit user action per call). Everything
// else is zero-spend by construction, and "adding a spend path to any other method is a
// contract change, not an implementation detail".
//
// These tests are the enforcement of that sentence. The named one below is the mutation
// test the acceptance asks for: a daemon that lets gymStart through with the gate closed
// must fail it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { gymSpendGatePath } from '../src/gym/spend-gate.js';
import { errorOf, resultOf, startDaemon } from './helpers/rpc-pipe.js';

const ERR_SPEND_REFUSED = -32050;

let daemon;
let repoPath;

before(async () => {
  repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-spend-'));
  await mkdir(path.join(repoPath, '.daijin'), { recursive: true });
  daemon = await startDaemon();
  await daemon.request('repoAttach', { repoPath });
});

after(async () => {
  await daemon.stop();
  await rm(repoPath, { recursive: true, force: true });
});

async function writeGate(contents) {
  await writeFile(gymSpendGatePath(repoPath), contents, 'utf8');
}

// ---- THE MUTATION TEST -----------------------------------------------------------------

test('MUTATION GUARD: gymStart is refused with -32050 while the gate is closed', async () => {
  // This is the test that must fail if anyone lets gymStart through a closed gate. It is
  // written against the SURFACE, over a real pipe, so it cannot be satisfied by a guard
  // that exists in a helper nobody calls.
  //
  // Three closed-gate shapes, because "closed" is not only "absent": the platform learned
  // that a malformed gate must read as blocked rather than as an error that some caller
  // decides to ignore.
  const closedShapes = [
    ['no gate file at all', null],
    ['a blocked gate', JSON.stringify({ status: 'blocked', reason: 'owner has not authorized this cycle' })],
    ['a malformed gate', '{not json'],
    ['a gate with no reason', JSON.stringify({ status: 'open' })],
    ['a gate naming an unknown scope', JSON.stringify({ status: 'authorized', scope: 'not-a-scope', reason: 'typo in the scope name' })],
  ];

  for (const [label, contents] of closedShapes) {
    if (contents === null) await rm(gymSpendGatePath(repoPath), { force: true });
    else await writeGate(contents);

    const error = errorOf(await daemon.request('gymStart', { repoPath, config: {} }));
    assert.equal(error.code, ERR_SPEND_REFUSED, `gymStart was NOT refused with ${label}`);
    assert.ok(error.data.gate, `the refusal must name the gate path (${label})`);
    assert.equal(error.data.gate, gymSpendGatePath(repoPath));
    assert.ok(error.data.hint.length > 10, `the refusal must carry a displayable hint (${label})`);
  }
});

test('the gate is checked BEFORE anything else can fail', async () => {
  // Ordering matters: if an argument error came first, a user with a closed gate could
  // fix their arguments and only then discover the gate. Worse, a future edit that moves
  // work above the gate check would still pass a test that only asserted "some error".
  await rm(gymSpendGatePath(repoPath), { force: true });
  const error = errorOf(await daemon.request('gymStart', { repoPath, config: null }));
  assert.equal(error.code, ERR_SPEND_REFUSED, 'the gate refusal outranks a bad config');
});

test('MUTATION GUARD: an OPEN gate is not consent; gymStart without confirm is still refused', async () => {
  // v5's second, INDEPENDENT refusal condition. The owner gate says this MACHINE may
  // spend; confirm: true says this PERSON asked for this call. A daemon that treats an open
  // gate as consent would pass every gate test above and still spend the user's money
  // without being asked, which is the failure this test exists to make impossible.
  await writeGate(JSON.stringify({ status: 'open', reason: 'owner authorized this cycle by hand' }));
  const unconfirmed = errorOf(await daemon.request('gymStart', { repoPath, config: {} }));
  assert.equal(unconfirmed.code, ERR_SPEND_REFUSED, 'an open gate must NOT be read as consent');
  assert.match(unconfirmed.data.hint, /confirm: true/, 'the refusal names what the client must send');
  await rm(gymSpendGatePath(repoPath), { force: true });
});

test('an open gate PLUS consent stops being the reason, and the refusal changes shape', async () => {
  // The other half of both guards. If gymStart refused unconditionally, every refusal test
  // would pass while the gate and the consent check did nothing at all.
  await writeGate(JSON.stringify({ status: 'open', reason: 'owner authorized this cycle by hand' }));
  const error = errorOf(await daemon.request('gymStart', { repoPath, config: {}, confirm: true }));
  assert.notEqual(error.code, ERR_SPEND_REFUSED, 'gate open and consent given: spend is no longer the blocker');
  // Past both spend boundaries, the next thing that stops it is a REAL precondition rather
  // than a deferral: this fixture repo has no mined exams, so there is nothing to run. That
  // ordering is the point, and it changed when the gym methods were wired: a user with an
  // empty bank now learns about the bank instead of about a driver they cannot affect.
  assert.equal(error.code, -32602);
  assert.match(error.data.hint, /nothing to run/);
  await rm(gymSpendGatePath(repoPath), { force: true });
});

test('consent is a literal true, never a truthy coincidence', async () => {
  // A client sending confirm: "yes" or confirm: 1 has not collected consent, it has sent
  // something it did not mean. Inferring agreement from a truthy value is the exact move
  // this parameter exists to prevent.
  await writeGate(JSON.stringify({ status: 'open', reason: 'owner authorized this cycle by hand' }));
  for (const confirm of ['true', 1, {}, 'yes']) {
    const error = errorOf(await daemon.request('gymStart', { repoPath, config: {}, confirm }));
    assert.equal(error.code, ERR_SPEND_REFUSED, `confirm: ${JSON.stringify(confirm)} must not count as consent`);
  }
  await rm(gymSpendGatePath(repoPath), { force: true });
});

test('a scoped gate authorizes its own scope and nothing else', async () => {
  await writeGate(JSON.stringify({ status: 'authorized', scope: 'exam-mining', reason: 'mining only, not a full cycle' }));
  const error = errorOf(await daemon.request('gymStart', { repoPath, config: {}, confirm: true }));
  // gym-cycle is not exam-mining. A gate opened for one operation must not fund another.
  assert.equal(error.code, ERR_SPEND_REFUSED);
  await rm(gymSpendGatePath(repoPath), { force: true });
});

// ---- per-call confirmations -------------------------------------------------------------

test('rolePing refuses without an explicit per-call confirmation', async () => {
  const error = errorOf(await daemon.request('rolePing', { role: 'engineer' }));
  assert.equal(error.code, ERR_SPEND_REFUSED);
  assert.match(error.data.hint, /never on a screen opening/,
    'the hint has to say it never runs automatically, because that is the property a user is trusting');
});

test('budgetEstimate is zero-spend and needs no confirmation, because it feeds the dialog', async () => {
  // The estimate the consent dialog DISPLAYS. If it were itself gated or spend-touching,
  // a user could not see the number before agreeing to it, which defeats the dialog.
  const estimate = resultOf(await daemon.request('budgetEstimate', { repoPath, mode: 'layer1+layer2' }));
  assert.equal(typeof estimate.estimatedTokens, 'number');
  assert.ok(estimate.basis.length > 10, 'an unexplained number in a consent dialog is one nobody can argue with');

  const gym = resultOf(await daemon.request('budgetEstimate', { repoPath, mode: 'gym' }));
  assert.ok(gym.estimatedTokens > 0);
  assert.match(gym.basis, /work-token cap/);

  const bad = errorOf(await daemon.request('budgetEstimate', { repoPath, mode: 'not-a-mode' }));
  assert.equal(bad.code, -32602);
});

test('rolePing with confirmation gets past the refusal and reports what is actually missing', async () => {
  // Since the real implementation landed (owner field round 4), an unconfigured role is a
  // PARAMETER refusal naming the missing piece, not a deferral: the method works, this
  // role is not set up, and the hint says which half is absent.
  const error = errorOf(await daemon.request('rolePing', { role: 'engineer', confirm: true }));
  assert.notEqual(error.code, ERR_SPEND_REFUSED);
  assert.equal(error.code, -32602);
  assert.match(error.data.hint, /no provider|no model/i);
});

test('diagnoseNarrate refuses without confirmation, and names the free alternative', async () => {
  const error = errorOf(await daemon.request('diagnoseNarrate', { repoPath }));
  assert.equal(error.code, ERR_SPEND_REFUSED);
  assert.match(error.data.hint, /mechanical|free/i, 'a refusal should point at the zero-spend path that answers most of the question');
});

test('initBrain spends ONLY on layer1+layer2', async () => {
  // ITS OWN REPO, because the two calls below START JOBS and return immediately, and an
  // init job writes the manifest, the brain files, gates.yaml and the score history. Run
  // against this file's shared fixture, that work lands wherever contention puts it, in a
  // repo four later tests read from. Same shape as the CI gates-are-data failure that
  // verifier report 20 traced in rpc-surface (run 31937439737): a fast machine finishes
  // the test before the job lands and a loaded one does not.
  //
  // The sharing is removed rather than sequenced around; awaiting the jobs would turn a
  // spend-boundary check into an init integration test.
  const own = await mkdtemp(path.join(tmpdir(), 'daijin-spend-init-'));
  await mkdir(path.join(own, '.daijin'), { recursive: true });
  await writeFile(path.join(own, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0' } }), 'utf8');
  await daemon.request('repoAttach', { repoPath: own });
  const started = [];
  try {
    // layer1 is DETERMINISTIC and free, so it starts a job rather than being gated. ingest
    // on a repo with nothing to adopt is refused by name, and for a reason that is not spend.
    const layer1 = await daemon.request('initBrain', { repoPath: own, mode: 'layer1' });
    assert.ok(layer1.result?.jobId, 'layer1 is wired and starts a job');
    started.push(layer1.result.jobId);
    const ingest = errorOf(await daemon.request('initBrain', { repoPath: own, mode: 'ingest' }));
    assert.equal(ingest.code, -32602, 'no knowledge folder here, and the refusal is a parameter error, not a deferral');
    assert.notEqual(ingest.code, ERR_SPEND_REFUSED);

    const refused = errorOf(await daemon.request('initBrain', { repoPath: own, mode: 'layer1+layer2' }));
    assert.equal(refused.code, ERR_SPEND_REFUSED);
    assert.match(refused.data.hint, /budget/i, 'the estimated budget is shown and confirmed before the job starts');

    // Confirmed, the spend boundary is behind it and the job starts. Layer 2 itself is
    // still unreachable in this build, which the job reports on the step stream rather
    // than here.
    const confirmed = await daemon.request('initBrain', { repoPath: own, mode: 'layer1+layer2', confirm: true, budget: { estimatedTokens: 1 } });
    assert.ok(confirmed.result?.jobId, 'a confirmed call is no longer refused for spend');
    started.push(confirmed.result.jobId);
  } finally {
    // Cancelled, not abandoned. Un-awaited work that outlives its test is a writer with no
    // owner, and this file's remaining tests share a daemon with it.
    for (const jobId of started) await daemon.request('jobCancel', { jobId });
    await daemon.request('repoDetach', { repoPath: own });
    await rm(own, { recursive: true, force: true });
  }
});

test('the init test left no writer behind in the shared fixture', async () => {
  // The isolation, asserted positively. If the jobs above can still reach this file's
  // shared repo, an init job materialises .daijin/manifest.json in it, and the four tests
  // after this one are sharing a repo with a background writer again.
  const { access } = await import('node:fs/promises');
  await assert.rejects(access(path.join(repoPath, '.daijin', 'manifest.json')),
    'an init job wrote into the shared fixture; give it its own repo');
});

test('an unknown initBrain mode is a parameter error, not a spend refusal', async () => {
  const error = errorOf(await daemon.request('initBrain', { repoPath, mode: 'layer3' }));
  assert.equal(error.code, -32602);
});

// ---- the enumeration itself --------------------------------------------------------------

test('no method outside the contract enumeration spends', async () => {
  // Every zero-spend method, called with no confirmation and no open gate. Any -32050 here
  // means a spend path was added to a method the contract says is free, which is a
  // contract change rather than an implementation detail.
  await rm(gymSpendGatePath(repoPath), { force: true });
  const free = [
    ['hello', {}],
    ['analyze', { repoPath }],
    ['serveStatus', {}],
    ['search', { repoPath, query: 'x' }],
    ['documents', { repoPath }],
    ['scoreHistory', { repoPath }],
    ['retrievalScore', { repoPath }],
    ['mcpSnippet', { repoPath }],
    ['diagnose', { repoPath }],
    ['gatesGet', { repoPath }],
    ['gatesSet', { repoPath, patch: { content: 'gates: []\n' } }],
    ['gymStatus', {}],
    ['examList', {}],
    ['settingsGet', {}],
    ['board', {}],
    ['jobCancel', { jobId: 'none' }],
    ['budgetEstimate', { repoPath, mode: 'gym' }],
  ];
  for (const [method, params] of free) {
    const envelope = await daemon.request(method, params);
    assert.notEqual(envelope.error?.code, ERR_SPEND_REFUSED, `${method} refused for spend but the contract says it is free`);
  }
});

test('the spend gate is observable before anything is attempted', async () => {
  // A user should never learn the gate's state by being refused.
  await writeGate(JSON.stringify({ status: 'open', reason: 'owner authorized this cycle by hand' }));
  const open = resultOf(await daemon.request('serveStatus', {}));
  assert.equal(open.spendGate.open, true);
  assert.equal(open.spendGate.path, gymSpendGatePath(repoPath));

  await writeGate(JSON.stringify({ status: 'blocked', reason: 'auto-blocked after the cycle' }));
  const closed = resultOf(await daemon.request('serveStatus', {}));
  assert.equal(closed.spendGate.open, false);
  await rm(gymSpendGatePath(repoPath), { force: true });
});

// ---- the consent audit trail -------------------------------------------------------------

test('a consented spend call records WHAT THE USER SAW, not just that they agreed', async () => {
  const { readFile } = await import('node:fs/promises');
  const consentFile = path.join(daemon.stateRoot, 'consent.jsonl');
  const before = await readFile(consentFile, 'utf8').catch(() => '');

  // A confirmed call echoing the CANONICAL shape: the whole budgetEstimate result, because
  // `basis` is the derivation the user actually read and a figure without it records a
  // number nobody can re-check.
  const echo = { estimatedTokens: 812_000, basis: '1 exam(s) at the M and L work-token cap of 800,000' };
  await daemon.request('initBrain', { repoPath, mode: 'layer1+layer2', confirm: true, budget: echo });
  const rows = (await readFile(consentFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const recorded = rows.at(-1);

  assert.equal(recorded.method, 'initBrain layer1+layer2');
  assert.equal(recorded.budget.estimatedTokens, 812_000,
    'consent to an estimate of 812,000 is not consent to 8,120,000, and only a record made at the moment can tell them apart');
  assert.equal(recorded.budget.basis, echo.basis, 'the derivation the user read is part of what they consented to');
  assert.equal(recorded.repoPath, repoPath);
  assert.ok(Date.parse(recorded.at) > 0);
  assert.ok(rows.length > before.split('\n').filter(Boolean).length, 'the trail is append-only');
});

test('a REFUSED call records nothing: there was no consent to record', async () => {
  const { readFile } = await import('node:fs/promises');
  const consentFile = path.join(daemon.stateRoot, 'consent.jsonl');
  const before = (await readFile(consentFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

  await daemon.request('initBrain', { repoPath, mode: 'layer1+layer2' });
  await daemon.request('rolePing', { role: 'engineer' });
  await daemon.request('gymStart', { repoPath, config: {} });

  const after = (await readFile(consentFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  assert.equal(after, before, 'a refusal is not an agreement, and an audit trail that logs both is unreadable');
});

test('consent with no echoed budget is recorded as null, which is itself the fact', async () => {
  // budget is OPTIONAL by ruling: inventing a refusal condition on a spend path is worse
  // than a thin record. A null budget says the agreement was made with no displayed figure,
  // which is exactly what a later reader needs to know.
  const { readFile } = await import('node:fs/promises');
  await daemon.request('rolePing', { role: 'engineer', confirm: true });
  const rows = (await readFile(path.join(daemon.stateRoot, 'consent.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const recorded = rows.at(-1);
  assert.equal(recorded.method, 'rolePing');
  assert.equal(recorded.budget, null);
});

test('gymStart records its echoed budget too, closing the asymmetry (v5 addition)', async () => {
  // The gym user saw a number and the call never recorded it, while initBrain's did. Same
  // dialog, same consent, different audit trail, which is the asymmetry this closes.
  const { readFile } = await import('node:fs/promises');
  await writeGate(JSON.stringify({ status: 'open', reason: 'owner authorized this cycle by hand' }));
  const echo = { estimatedTokens: 800_000, basis: '1 exam(s) at the M and L work-token cap of 800,000' };
  await daemon.request('gymStart', { repoPath, config: {}, confirm: true, budget: echo });

  const rows = (await readFile(path.join(daemon.stateRoot, 'consent.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const recorded = rows.at(-1);
  assert.equal(recorded.method, 'gymStart');
  assert.equal(recorded.budget.estimatedTokens, 800_000);
  assert.equal(recorded.budget.basis, echo.basis);
  await rm(gymSpendGatePath(repoPath), { force: true });
});

test('the engine tolerates any echo carrying estimatedTokens, and keeps what it cannot read', async () => {
  // Refusing a malformed echo would invent a refusal condition on a spend path, which is
  // worse than a thin record. But an echo that is silently DROPPED is the audit gap this
  // whole mechanism exists to close, so an unreadable one is kept verbatim under `raw`.
  const { readFile } = await import('node:fs/promises');
  const consentFile = path.join(daemon.stateRoot, 'consent.jsonl');
  const lastRow = async () => {
    const rows = (await readFile(consentFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return rows.at(-1);
  };

  // A bare number, which is not canonical but is unambiguous.
  await daemon.request('rolePing', { role: 'engineer', confirm: true, budget: 1_234 });
  assert.deepEqual(await lastRow().then((row) => row.budget), { estimatedTokens: 1_234, basis: null });

  // An object carrying estimatedTokens plus fields the engine does not know.
  await daemon.request('rolePing', { role: 'engineer', confirm: true, budget: { estimatedTokens: 42, basis: 'b', extra: 'x' } });
  assert.deepEqual(await lastRow().then((row) => row.budget), { estimatedTokens: 42, basis: 'b' });

  // Something it cannot read at all: accepted, and kept rather than discarded.
  await daemon.request('rolePing', { role: 'engineer', confirm: true, budget: 'about a million' });
  const unreadable = await lastRow();
  assert.equal(unreadable.budget.estimatedTokens, null);
  assert.equal(unreadable.budget.raw, 'about a million', 'a record that silently drops what the client sent is the gap this closes');
});
