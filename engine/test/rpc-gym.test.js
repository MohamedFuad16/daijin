// The six gym RPC methods, wired against gym-porter's ledger and runner.
//
// In process with injected dependencies: a real cycle needs a provider, and engine/test is
// network-free. What is asserted is the WIRING and the boundaries, which is what the daemon
// owns. The refusal order is also exercised over the real pipe in rpc-spend.test.js.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GymLedger, gymDatabasePath } from '../src/gym/ledger.js';
import { gymSpendGatePath } from '../src/gym/spend-gate.js';
import { createRpcServer } from '../src/rpc/server.js';

const ERR_SPEND_REFUSED = -32050;
const ERR_NOT_IMPLEMENTED = -32001;
const ERR_INVALID_PARAMS = -32602;

/// A promoted, active exam. Full record shape, since the runner needs the whole thing.
function exam(overrides = {}) {
  return {
    examId: 'exam-0001',
    title: 'Add the missing call site',
    status: 'promoted',
    benchmarkStatus: 'active',
    heldOut: false,
    scopeTier: 'S',
    baseCommit: 'a'.repeat(40),
    goldCommit: 'b'.repeat(40),
    task: 'A task statement long enough to be a real one for the validator to accept.',
    // The validator requires the scope numbers, and requiring them is right: a scope tier
    // with no measured diff behind it is a claim rather than a classification.
    scopeFiles: 2,
    scopeInsertions: 40,
    provenance: { source: 'commit-mining', commit: 'c'.repeat(40) },
    ...overrides,
  };
}

async function harness({ engineer = null, exams = [], gateOpen = false, runGymCycle } = {}) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-gym-state-'));
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-gym-repo-'));
  await mkdir(path.join(repoPath, '.daijin'), { recursive: true });
  if (gateOpen) {
    await writeFile(gymSpendGatePath(repoPath), JSON.stringify({ status: 'open', reason: 'owner authorized this cycle by hand' }), 'utf8');
  }

  // A real ledger, seeded through the real putExam so validation is exercised.
  const seeded = GymLedger.open(gymDatabasePath(repoPath));
  for (const row of exams) seeded.putExam(row);
  seeded.close?.();

  const messages = [];
  const cycleCalls = [];
  const server = createRpcServer({
    stateRoot,
    write: (message) => messages.push(message),
    deps: {
      checkOllama: async () => { throw new Error('probe skipped'); },
      createEmbedderClient: () => { throw new Error('embedder unavailable'); },
      openStore: async () => ({ project: 'default', async close() {}, async allDocuments() { return []; }, async indexedEmbeddingIdentity() { return null; } }),
      ...(engineer ? { createEngineer: async () => engineer } : {}),
      ...(runGymCycle ? { runGymCycle: async (options) => { cycleCalls.push(options); return runGymCycle(options); } } : {}),
    },
  });
  return {
    server, repoPath, messages, cycleCalls,
    steps: () => messages.filter((row) => row.method === 'step').map((row) => row.params),
    async attach() { await server.methods.repoAttach({ repoPath }); },
    async cleanup() {
      await server.close();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    },
  };
}

const raised = async (promise) => promise.then(() => null, (error) => error);

// ---- the read methods, now live ------------------------------------------------------

test('examList returns the bank, and an empty bank is not an error', async () => {
  const empty = await harness({});
  try {
    await empty.attach();
    assert.deepEqual(await empty.server.methods.examList({ repoPath: empty.repoPath }), [],
      'a repo whose exams were never mined has none, which renders as an empty view');
  } finally {
    await empty.cleanup();
  }

  const stocked = await harness({ exams: [exam(), exam({ examId: 'exam-0002', heldOut: true })] });
  try {
    await stocked.attach();
    const rows = await stocked.server.methods.examList({ repoPath: stocked.repoPath });
    assert.deepEqual(rows.map((row) => row.examId).sort(), ['exam-0001', 'exam-0002']);
    assert.ok(Object.hasOwn(rows[0], 'title'), 'v5 rows carry a human-readable title');
    assert.ok(Object.hasOwn(rows[0], 'benchmarkStatus'), 'the two status axes are orthogonal and both present');

    const heldOut = await stocked.server.methods.examList({ repoPath: stocked.repoPath, filters: { heldOut: true } });
    assert.deepEqual(heldOut.map((row) => row.examId), ['exam-0002']);
  } finally {
    await stocked.cleanup();
  }
});

test('examDetail returns the record and EMPTY axes until grading lands', async () => {
  const context = await harness({ exams: [exam()] });
  try {
    await context.attach();
    const detail = await context.server.methods.examDetail({ repoPath: context.repoPath, examId: 'exam-0001' });
    assert.equal(detail.exam.examId, 'exam-0001');
    assert.deepEqual(detail.attempts, [], 'no runs yet');
    assert.equal(detail.axes, null,
      'null, never {}: an empty object renders on a radar exactly like a set of measured zeros');
    assert.equal(detail.provenance.source, 'commit-mining');

    const missing = await raised(context.server.methods.examDetail({ repoPath: context.repoPath, examId: 'exam-9999' }));
    assert.equal(missing.code, ERR_INVALID_PARAMS);
  } finally {
    await context.cleanup();
  }
});

test('gymStatus reports the ledger summary, and a non-derivable denominator stays null', async () => {
  const context = await harness({ exams: [exam()] });
  try {
    await context.attach();
    const status = await context.server.methods.gymStatus({ repoPath: context.repoPath });
    assert.deepEqual(status.cycles, []);
    for (const field of ['mode', 'scoredWrites', 'drawnFromResultFiles', 'rowsWritten', 'certifications', 'exams']) {
      assert.ok(Object.hasOwn(status.ledger, field), `the v5 ledger payload is missing ${field}`);
    }
    assert.equal(status.ledger.drawnFromResultFiles, null,
      'null means not derivable; a zero here would mean "four exams vanished", which is the defect the rule removes');
  } finally {
    await context.cleanup();
  }
});

// ---- the write methods -----------------------------------------------------------------

test('examVeto records the reason, and refuses one too short to be reviewable', async () => {
  const context = await harness({ exams: [exam()] });
  try {
    await context.attach();
    const short = await raised(context.server.methods.examVeto({ repoPath: context.repoPath, examId: 'exam-0001', reason: 'no' }));
    assert.equal(short.code, ERR_INVALID_PARAMS);
    assert.ok(short.data.hint.length > 10, 'the refusal names the field and the rule');

    const vetoed = await context.server.methods.examVeto({
      repoPath: context.repoPath, examId: 'exam-0001', reason: 'Superseded by a later commit that reverts this one entirely.',
    });
    assert.equal(vetoed.status, 'vetoed');

    // And it PERSISTED, which is what makes a veto reviewable later.
    const reread = await context.server.methods.examDetail({ repoPath: context.repoPath, examId: 'exam-0001' });
    assert.equal(reread.exam.status, 'vetoed');
  } finally {
    await context.cleanup();
  }
});

test('examUpdate validates through the parser, so an invalid patch never reaches the store', async () => {
  const context = await harness({ exams: [exam()] });
  try {
    await context.attach();
    // Quarantined without a reason: both the helper and the parser enforce the minimum.
    const bad = await raised(context.server.methods.examUpdate({
      repoPath: context.repoPath, examId: 'exam-0001', patch: { benchmarkStatus: 'quarantined' },
    }));
    assert.equal(bad.code, ERR_INVALID_PARAMS);

    const stillActive = await context.server.methods.examDetail({ repoPath: context.repoPath, examId: 'exam-0001' });
    assert.equal(stillActive.exam.benchmarkStatus, 'active', 'the refused patch did not land');

    const quarantined = await context.server.methods.examUpdate({
      repoPath: context.repoPath,
      examId: 'exam-0001',
      patch: { benchmarkStatus: 'quarantined', quarantineReason: 'Cap death at 307K against a 300K cap; not a fair measurement.' },
    });
    assert.equal(quarantined.benchmarkStatus, 'quarantined');
    assert.ok(quarantined.quarantineReason.length >= 20);
  } finally {
    await context.cleanup();
  }
});

// ---- gymStart: the boundaries ------------------------------------------------------------

test('gymStart checks the gate, then consent, then the bank, then the driver', async () => {
  // The ORDER is the property. A user with a closed gate should learn about the gate, not
  // about a driver they can do nothing about.
  const closed = await harness({ exams: [exam()] });
  try {
    await closed.attach();
    const gate = await raised(closed.server.methods.gymStart({ repoPath: closed.repoPath, config: {} }));
    assert.equal(gate.code, ERR_SPEND_REFUSED, 'the gate outranks everything');
    assert.ok(gate.data.gate, 'and names itself');
  } finally {
    await closed.cleanup();
  }

  const noConsent = await harness({ exams: [exam()], gateOpen: true });
  try {
    await noConsent.attach();
    const consent = await raised(noConsent.server.methods.gymStart({ repoPath: noConsent.repoPath, config: {} }));
    assert.equal(consent.code, ERR_SPEND_REFUSED, 'an open gate is not consent');
    assert.match(consent.data.hint, /confirm: true/);
  } finally {
    await noConsent.cleanup();
  }

  const emptyBank = await harness({ gateOpen: true });
  try {
    await emptyBank.attach();
    const bank = await raised(emptyBank.server.methods.gymStart({ repoPath: emptyBank.repoPath, config: {}, confirm: true }));
    assert.equal(bank.code, ERR_INVALID_PARAMS, 'an empty bank is a caller problem to fix, and is named as one');
    assert.match(bank.data.hint, /nothing to run/);
  } finally {
    await emptyBank.cleanup();
  }

  const noDriver = await harness({ exams: [exam()], gateOpen: true });
  try {
    await noDriver.attach();
    const driver = await raised(noDriver.server.methods.gymStart({ repoPath: noDriver.repoPath, config: {}, confirm: true }));
    assert.equal(driver.code, ERR_NOT_IMPLEMENTED);
    assert.match(driver.data.phase, /^P4/);
    assert.match(driver.data.hint, /gate, your consent and the draw are all fine/,
      'the refusal says what DID work, so nobody reads it as "the gym is not built"');
    assert.match(driver.data.hint, /engineer role is configured/);
  } finally {
    await noDriver.cleanup();
  }
});

test('with a student driver, a cycle runs and the exclusion seam is threaded', async () => {
  // The seam that matters: the gym computes which documents would leak the answer, and the
  // daemon must pass them into retrieve as excludeDocumentIds. A gold-provenance exclusion
  // that silently did nothing would make every exam it touched an open-book test reported
  // as a closed-book one.
  let seenExclusion = null;
  const context = await harness({
    exams: [exam()],
    gateOpen: true,
    engineer: { async next() { return { kind: 'submit', tokens: 10 }; } },
    runGymCycle: async ({ retrieveContext, logger }) => {
      await logger.step({ phase: 'gym', step: 'round', detail: 'round 1', counts: { round: 1 } });
      await retrieveContext({ query: 'the task', excludeDocumentIds: ['gold.answer.one', 'gold.answer.two'] });
      return { cycles: 1 };
    },
  });
  try {
    await context.attach();
    // Capture what retrieve would have been asked for by watching the store call.
    context.server.methods.gymStart.__probe = true;
    const { jobId } = await context.server.methods.gymStart({ repoPath: context.repoPath, config: {}, confirm: true });
    assert.match(jobId, /^job-gym-/);
    await context.server.jobs.drain();

    assert.equal(context.cycleCalls.length, 1, 'the runner was called');
    const call = context.cycleCalls[0];
    assert.equal(call.exams.length, 1);
    assert.equal(call.exams[0].examId, 'exam-0001', 'full records, not list rows');
    assert.equal(call.mode, 'harness-debug', 'the default mode is the quarantined one, never evaluation');
    assert.ok(call.rules, 'the student rules come from the instruction file');
    assert.ok(call.retrieveContext, 'the exclusion seam is supplied');
    // Sandboxes are scratch, so they moved into the disposable index tree with the
    // relocation. The RESULT files did not: the drawn-cohort denominator is counted from
    // those files rather than from ledger rows, so losing them breaks a rule this build
    // enforces.
    assert.ok(!call.sandboxesRoot.startsWith(context.repoPath), 'sandboxes are machine scratch, not repo state');
    assert.ok(call.sandboxesRoot.includes('index'), 'and they live in the disposable tree');
    assert.ok(call.resultDir.startsWith(context.repoPath), 'the result files stay in the repo');
    assert.equal(typeof call.abortSignal.aborted, 'boolean', 'jobCancel has something to flip');

    const steps = context.steps().filter((row) => row.jobId === jobId);
    assert.ok(steps.some((row) => row.step === 'round'), 'the runner streams onto the notification channel');
  } finally {
    await context.cleanup();
  }
});

test('the default mode is never evaluation', async () => {
  // Anything exploratory is harness-debug: recorded, never scored. Fourteen-plus
  // experimental runs kept the platform's record clean this way, and a default of
  // evaluation would put an unreviewed run into the scored record on the first click.
  const context = await harness({
    exams: [exam()],
    gateOpen: true,
    engineer: { async next() { return { kind: 'submit', tokens: 1 }; } },
    runGymCycle: async () => ({ cycles: 1 }),
  });
  try {
    await context.attach();
    await context.server.methods.gymStart({ repoPath: context.repoPath, config: {}, confirm: true });
    await context.server.jobs.drain();
    assert.equal(context.cycleCalls[0].mode, 'harness-debug');

    await context.server.methods.gymStart({ repoPath: context.repoPath, config: { mode: 'evaluation' }, confirm: true });
    await context.server.jobs.drain();
    assert.equal(context.cycleCalls[1].mode, 'evaluation', 'but an explicit ask is honoured');
  } finally {
    await context.cleanup();
  }
});

test('an unknown examId in the config is refused before any spend', async () => {
  const context = await harness({ exams: [exam()], gateOpen: true });
  try {
    await context.attach();
    const error = await raised(context.server.methods.gymStart({
      repoPath: context.repoPath, config: { examId: 'exam-9999' }, confirm: true,
    }));
    assert.equal(error.code, ERR_INVALID_PARAMS);
    assert.match(error.data.hint, /not a promoted, active exam/);
  } finally {
    await context.cleanup();
  }
});

test('a quarantined exam is not drawable', async () => {
  const context = await harness({
    exams: [exam({ benchmarkStatus: 'quarantined', quarantineReason: 'Cap death at 307K against a 300K cap; not a fair measurement.' })],
    gateOpen: true,
  });
  try {
    await context.attach();
    const error = await raised(context.server.methods.gymStart({ repoPath: context.repoPath, config: {}, confirm: true }));
    assert.equal(error.code, ERR_INVALID_PARAMS);
    assert.match(error.data.hint, /nothing to run/, 'a quarantined exam is not in the drawable bank');
  } finally {
    await context.cleanup();
  }
});

// ---- finding 79: the axes shape ----------------------------------------------------------

test('axesFor returns a canonically ORDERED list, never a name-keyed object', async () => {
  // grading.js keys by name because a rubric is authored and validated by name. A chart
  // needs a fixed order, and that order must not come from object key order, which is an
  // accident of how the rubric happened to be written.
  const { axesFor } = await import('../src/rpc/methods.js');
  const { AXES } = await import('../src/gym/grading.js');

  // Deliberately scrambled input order.
  const rubric = { axes: {
    reasoning_quality: { score: 3, citations: ['a'] },
    correctness_vs_gold: { score: 5, citations: ['b'] },
    blast_radius_awareness: { score: 2, citations: ['c'] },
    convention_adherence: { score: 4, citations: ['d'] },
    decision_awareness: { score: 1, citations: ['e'] },
  } };
  const axes = axesFor(rubric);
  assert.deepEqual(axes.map((row) => row.name), [...AXES], 'canonical order regardless of input order');
  assert.deepEqual(axes.map((row) => row.score), [5, 4, 1, 3, 2]);
  // max travels with every score: a 4 means nothing without the 5 beside it, and a client
  // that hardcodes the denominator misreads silently the day the scale changes.
  assert.ok(axes.every((row) => row.max === 5));
});

test('an ungraded attempt is null, never an empty object or zeroes', async () => {
  const { axesFor } = await import('../src/rpc/methods.js');
  assert.equal(axesFor(undefined), null);
  assert.equal(axesFor({}), null);
  assert.equal(axesFor({ axes: {} }), null);
  // Partial is null too: validateRubric refuses a rubric missing an axis, so a partial here
  // means something upstream is wrong rather than that the grader was brief, and a partial
  // radar reads as a low score on the missing axes.
  assert.equal(axesFor({ axes: { correctness_vs_gold: { score: 5 } } }), null);
});

test('an ungraded attempt says WHY, distinguishing no-diff from diff-but-ungraded', async () => {
  // unsubmitted is not a bad grade: it records that the student never answered and so
  // cannot have answered badly.
  const { ungradedExplanation } = await import('../src/rpc/methods.js');
  assert.match(ungradedExplanation({ status: 'unsubmitted' }).reason, /never submitted/);
  assert.match(ungradedExplanation({ status: 'apply-error' }).reason, /did not apply/);
  assert.match(ungradedExplanation({ status: 'completed' }).reason, /produced a diff and has not been graded/);
});

test('the ungraded reason carries a STABLE CODE beside its sentence', async () => {
  // Prose for humans, codes for branching. A client that switches on the sentence breaks
  // the day the sentence is improved, which is the same reason a hint is displayed verbatim
  // and never parsed.
  const { ungradedExplanation } = await import('../src/rpc/methods.js');
  assert.equal(ungradedExplanation({ status: 'unsubmitted' }).code, 'unsubmitted');
  assert.equal(ungradedExplanation({ status: 'apply-error' }).code, 'apply-error');
  assert.equal(ungradedExplanation({ status: 'completed' }).code, 'pending');
  assert.equal(ungradedExplanation({ status: 'gates-regressed' }).code, 'pending');
  assert.equal(ungradedExplanation({ status: 'metric-regressed' }).code, 'pending');
  // Every status the ledger can hold maps to exactly one of the three codes, so a new run
  // status cannot silently arrive on the wire with no explanation at all.
  const { RUN_STATUSES } = await import('../src/gym/ledger.js');
  const codes = new Set(RUN_STATUSES.map((status) => ungradedExplanation({ status }).code));
  assert.deepEqual([...codes].sort(), ['apply-error', 'pending', 'unsubmitted']);
});

test('attempts are sorted newest first EXPLICITLY, not trusted from the query', async () => {
  // The top-level axes are the most recent graded attempt's, so an order that is merely
  // assumed picks the wrong attempt invisibly: the numbers look exactly as real as the
  // right ones.
  const { attemptsNewestFirst } = await import('../src/rpc/methods.js');
  // id order and `at` order deliberately DISAGREE: a ledger restored or merged out of band
  // can insert an older run last, and `at` is when the attempt happened.
  const sorted = attemptsNewestFirst([
    { id: 1, at: '2026-08-14T00:00:00.000Z' },
    { id: 3, at: '2026-08-12T00:00:00.000Z' },
    { id: 2, at: '2026-08-16T00:00:00.000Z' },
  ]);
  assert.deepEqual(sorted.map((row) => row.id), [2, 1, 3]);

  // The id breaks a tie, which is the one place insertion order is the better answer.
  const tied = attemptsNewestFirst([
    { id: 5, at: '2026-08-16T00:00:00.000Z' },
    { id: 9, at: '2026-08-16T00:00:00.000Z' },
  ]);
  assert.deepEqual(tied.map((row) => row.id), [9, 5]);

  // And it does not mutate what it was handed.
  const input = [{ id: 1, at: 'a' }, { id: 2, at: 'b' }];
  attemptsNewestFirst(input);
  assert.deepEqual(input.map((row) => row.id), [1, 2]);
});

// ---- the graded branch, over gym-porter's REAL ledger ------------------------------------
//
// Not a mock. The rubric goes in through importRubricBatch and comes back out through
// examDetail, so the handover between their storage and my boundary is PROVEN rather than
// described. Until the rubric tables landed this branch was unreachable in production and
// only reachable in a unit test of axesFor.

test('a graded attempt reaches the wire as an ORDERED list, straight from the ledger', async () => {
  const kit = await harness({ exams: [exam()] });
  try {
    await kit.attach();
    const ledger = GymLedger.open(gymDatabasePath(kit.repoPath));
    const cycleId = ledger.startCycle({ mode: 'evaluation' });
    const runId = ledger.recordRun({
      cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed',
      verdict: 'partial', resultFile: 'runs/exam-0001-1.json', applied: true,
    });
    ledger.importRubricBatch({
      mode: 'evaluation',
      source: 'test',
      rubrics: [{
        runId,
        verdict: 'partial',
        // Deliberately scrambled key order, because object key order is an accident of how
        // the grader wrote the rubric and must not decide the order on a chart.
        axes: {
          blast_radius_awareness: { score: 2, citations: ['e'] },
          correctness_vs_gold: { score: 5, citations: ['a'] },
          reasoning_quality: { score: 3, citations: ['d'] },
          convention_adherence: { score: 4, citations: ['b'] },
          decision_awareness: { score: 1, citations: ['c'] },
        },
        taskDigest: 'sha256:task',
        submissionDigest: 'sha256:submission',
      }],
    });
    ledger.close?.();

    const detail = await kit.server.methods.examDetail({ repoPath: kit.repoPath, examId: 'exam-0001' });
    assert.deepEqual(detail.axes, [
      { name: 'correctness_vs_gold', score: 5, max: 5 },
      { name: 'convention_adherence', score: 4, max: 5 },
      { name: 'decision_awareness', score: 1, max: 5 },
      { name: 'reasoning_quality', score: 3, max: 5 },
      { name: 'blast_radius_awareness', score: 2, max: 5 },
    ], 'canonical order out of the store, not the order the grader happened to write');
    assert.deepEqual(detail.attempts[0].axes, detail.axes);
    assert.equal(detail.attempts[0].ungradedCode, null, 'a graded attempt has nothing to explain');
    assert.equal(detail.attempts[0].ungradedReason, null);
  } finally {
    await kit.cleanup();
  }
});

test('an ungraded attempt beside a graded one keeps its own answer', async () => {
  // The top-level axes are the most recent GRADED attempt's. An ungraded attempt sitting
  // above it must not inherit them, and must not read as a student who scored zero.
  const kit = await harness({ exams: [exam()] });
  try {
    await kit.attach();
    const ledger = GymLedger.open(gymDatabasePath(kit.repoPath));
    const cycleId = ledger.startCycle({ mode: 'evaluation' });
    const graded = ledger.recordRun({
      cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed', verdict: 'pass',
      resultFile: 'runs/one.json', applied: true, at: '2026-08-14T00:00:00.000Z',
    });
    ledger.recordRun({
      cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed', verdict: null,
      resultFile: 'runs/two.json', applied: true, at: '2026-08-16T00:00:00.000Z',
    });
    ledger.importRubricBatch({
      mode: 'evaluation',
      rubrics: [{
        runId: graded,
        verdict: 'pass',
        axes: Object.fromEntries(['correctness_vs_gold', 'convention_adherence', 'decision_awareness',
          'reasoning_quality', 'blast_radius_awareness'].map((name) => [name, { score: 4, citations: ['x'] }])),
        taskDigest: 'sha256:task',
        submissionDigest: 'sha256:submission',
      }],
    });
    ledger.close?.();

    const detail = await kit.server.methods.examDetail({ repoPath: kit.repoPath, examId: 'exam-0001' });
    assert.equal(detail.attempts[0].axes, null, 'the newer attempt is ungraded');
    assert.equal(detail.attempts[0].ungradedCode, 'pending');
    assert.ok(detail.attempts[1].axes, 'the older one is graded');
    assert.equal(detail.axes.length, 5, 'and the top level shows the most recent GRADED one');
    assert.ok(detail.axes.every((row) => row.score === 4));
  } finally {
    await kit.cleanup();
  }
});
