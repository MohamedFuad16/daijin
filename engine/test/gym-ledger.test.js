// The certification ledger and the drawn-cohort denominator rule.
//
// The two claims under test that cost the platform real numbers: a row is evidence of a
// graded attempt and never of a drawn one, and only evaluation rows touch the scored record.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { GymLedger, gymDatabasePath, openGymStore } from '../src/gym/ledger.js';
import { drawnExamCount, loadResultFiles, writeResultFile } from '../src/gym/result-files.js';
import { parseExamRecord } from '../src/gym/exams.js';
import { AXES } from '../src/gym/grading.js';

const SHA_BASE = 'a'.repeat(40);
const SHA_GOLD = 'b'.repeat(40);

function ledger() {
  return GymLedger.open(':memory:');
}

function exam(id, overrides = {}) {
  return parseExamRecord({
    examId: id,
    status: 'promoted',
    benchmarkStatus: 'active',
    heldOut: false,
    scopeTier: 'M',
    scopeFiles: 2,
    scopeInsertions: 20,
    baseCommit: SHA_BASE,
    goldCommit: SHA_GOLD,
    task: 'Wire the sync endpoint through to the client so one real datum crosses the seam.',
    provenance: {
      source: 'auditor-selection',
      commit: SHA_GOLD,
      // P7 clause 4: an exam a model authored records which model.
      authoredBy: { role: 'auditor', model: 'auditor-model', endpoint: 'https://provider.invalid' },
    },
    ...overrides,
  });
}

/** An artifact carrying a computed gold-provenance exclusion, which certification requires
 *  (D-0020). An EMPTY exclusion is a legitimate result and certifies fine; an ABSENT one is
 *  the refusal case, tested on its own below. */
function certifiableArtifact(ids = []) {
  return {
    provenance: {
      goldExclusion: {
        goldCommit: SHA_GOLD, baseCommit: SHA_BASE, count: ids.length, ids, reasons: {}, computed: true,
      },
    },
  };
}

async function withTemp(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-ledger-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('the gym ledger lives beside the brain and refuses to be one', async () => {
  assert.equal(gymDatabasePath('/repo'), path.join('/repo', '.daijin', 'gym.sqlite'));
  await withTemp(async (root) => {
    // A database carrying the brain's tables is refused on OPEN, before anything can write
    // gym tables into a user's brain (the D-0012 hazard in the other direction).
    const brainFile = path.join(root, 'brain.sqlite');
    const brain = new Database(brainFile);
    brain.exec('CREATE TABLE document (id TEXT PRIMARY KEY); CREATE TABLE chunks (id TEXT PRIMARY KEY)');
    brain.close();
    assert.throws(() => openGymStore(brainFile), /carries brain tables \(document, chunks\)/);

    // And a gym ledger is marked, so a foreign ledger is refused too.
    const gymFile = path.join(root, 'gym.sqlite');
    const gym = GymLedger.open(gymFile);
    gym.close();
    assert.doesNotThrow(() => openGymStore(gymFile).close());
    const foreign = new Database(gymFile);
    foreign.prepare('UPDATE gym_meta SET value = ? WHERE key = ?').run('someone-elses-tool', 'ledger.kind');
    foreign.close();
    assert.throws(() => openGymStore(gymFile), /is marked someone-elses-tool/);
  });
});

test('an edited migration is refused rather than silently skipped', async () => {
  await withTemp(async (root) => {
    const file = path.join(root, 'gym.sqlite');
    const first = GymLedger.open(file);
    first.close();
    const tampered = new Database(file);
    tampered.prepare('UPDATE schema_migration SET checksum = ? WHERE id = ?').run('not-the-checksum', '001-gym-base');
    tampered.close();
    assert.throws(() => GymLedger.open(file), /was edited after it was applied/);
  });
});

test('a run with no applied diff cannot have a row, whatever the caller wants', () => {
  const store = ledger();
  store.putExam(exam('exam-0001'));
  const cycleId = store.startCycle({ mode: 'evaluation' });
  assert.throws(
    () => store.recordRun({
      cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'unsubmitted',
      resultFile: '2026-08-16T00-00-00.000Z-exam-0001-result.json', applied: false,
    }),
    /A row is evidence of a graded attempt, never of a drawn one/,
  );
  // And a row must point at the artifact it came from, or the denominator join has nothing
  // to join on.
  assert.throws(
    () => store.recordRun({ cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed', applied: true, resultFile: null }),
    /must point at its result file/,
  );
  assert.equal(store.summary().rowsWritten, 0);
  store.close();
});

test('only evaluation rows are scored, and a certification refuses every other mode', () => {
  const store = ledger();
  store.putExam(exam('exam-0001'));
  const debugCycle = store.startCycle({ mode: 'harness-debug' });
  const debugRun = store.recordRun({
    cycleId: debugCycle, examId: 'exam-0001', mode: 'harness-debug', status: 'completed',
    applied: true, resultFile: 'debug-result.json',
  });
  const scoredCycle = store.startCycle({ mode: 'evaluation' });
  const scoredRun = store.recordRun({
    cycleId: scoredCycle, examId: 'exam-0001', mode: 'evaluation', status: 'completed',
    applied: true, resultFile: 'scored-result.json',
  });

  const summary = store.summary();
  assert.equal(summary.rowsWritten, 2, 'every mode is recorded');
  assert.equal(summary.scoredWrites, 1, 'and only one of them is scored');
  assert.deepEqual(store.cycleRuns(debugCycle).map((row) => row.id), [], 'the scored view of a debug cycle is empty');
  assert.deepEqual(store.cycleRuns(debugCycle, { scoredOnly: false }).map((row) => row.id), [debugRun]);

  assert.throws(() => store.certify({ runId: debugRun, verdict: 'pass', harness: { policy: 'adr-0167' }, artifact: certifiableArtifact() }), /may not write a certification/);
  store.importRubricBatch({ rubrics: [rubricFor(scoredRun)], mode: 'evaluation' });
  const certification = store.certify({
    runId: scoredRun, verdict: 'pass', harness: { policy: 'adr-0167', extensionsGranted: 1 }, artifact: certifiableArtifact(),
  });
  assert.equal(store.certifications().length, 1);
  assert.equal(store.certifications()[0].id, certification);
  assert.equal(store.summary().certifications, 1);
  store.close();
});

test('a certification needs a pass, an unquarantined exam, and its harness provenance', () => {
  const store = ledger();
  store.putExam(exam('exam-0001'));
  const cycleId = store.startCycle({ mode: 'evaluation' });
  const runId = store.recordRun({
    cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed', applied: true, resultFile: 'r.json',
  });
  const artifact = certifiableArtifact();
  // A pass claim with no grading record behind it has nothing to show.
  assert.throws(() => store.certify({ runId, verdict: 'pass', harness: { x: 1 }, artifact }), /no rubric is stored for it/);
  store.importRubricBatch({ rubrics: [rubricFor(runId, { verdict: 'partial' })], mode: 'evaluation' });
  assert.throws(() => store.certify({ runId, harness: { x: 1 }, artifact }), /with verdict partial; a certification records a pass/);
  assert.throws(() => store.certify({ runId, verdict: 'pass', harness: { x: 1 }, artifact }),
    /the caller asserts pass and the stored rubric says partial/);
  assert.throws(() => store.certify({ runId: 999, verdict: 'pass', harness: { x: 1 }, artifact }), /unknown run 999/);

  store.close();

  // The remaining refusals need a PASSING rubric, and one rubric per run means a fresh run
  // for each: the store refuses a second rubric for a run that already has one.
  const provenanceCase = ledgerWithRun();
  provenanceCase.store.importRubricBatch({ rubrics: [rubricFor(provenanceCase.runId)], mode: 'evaluation' });
  assert.throws(() => provenanceCase.store.certify({ runId: provenanceCase.runId, harness: {}, artifact }),
    /must carry the harness provenance/);
  provenanceCase.store.close();

  // Quarantine is checked AT certification time, because an exam can be quarantined between
  // the run and the grade, and a certification is a claim made now.
  const quarantineCase = ledgerWithRun();
  quarantineCase.store.importRubricBatch({ rubrics: [rubricFor(quarantineCase.runId)], mode: 'evaluation' });
  quarantineCase.store.putExam(exam('exam-0001', {
    benchmarkStatus: 'quarantined', quarantineReason: 'Gold defect found after the run was graded.',
  }));
  assert.throws(() => quarantineCase.store.certify({ runId: quarantineCase.runId, harness: { x: 1 }, artifact }),
    /Refusing to certify exam-0001: it is quarantined/);
  quarantineCase.store.close();
});

test('a certification COPIES its axes from the rubric, and names which rubric', () => {
  // The defect this replaces, found by the extractor reading ledger.js: certify() took
  // `axes` from its caller and DEFAULTED IT TO {}, so a certification could persist finding
  // 79's forbidden value into the strictest record in the ledger, where an empty axes set
  // renders on a radar exactly like a set of measured zeros.
  //
  // The fix deletes the parameter rather than validating it. Two records holding the same
  // five numbers can disagree; one derived from the other cannot.
  const { store, runId } = ledgerWithRun();
  store.importRubricBatch({ rubrics: [rubricFor(runId)], mode: 'evaluation' });
  const rubric = store.rubricFor(runId);
  store.certify({ runId, verdict: 'pass', harness: { policy: 'adr-0167' }, artifact: certifiableArtifact() });

  const [certification] = store.certifications();
  assert.deepEqual(certification.axes, rubric.axes, 'the snapshot IS the rubric, not a parameter');
  assert.equal(certification.verdict, rubric.verdict, 'and so is the verdict');
  assert.equal(certification.rubric_id, rubric.id, 'and it names which rubric, so the agreement is checkable');
  assert.notDeepEqual(certification.axes, {}, 'never the forbidden empty value');
  assert.equal(Object.keys(certification.axes).length, 5);

  // There is no parameter to pass, which is what makes the defect unreachable rather than
  // merely unlikely.
  assert.ok(!/axes\s*=/.test(String(store.certify)), 'certify takes no axes parameter');
  store.close();
});

test('a scored run with no gold-provenance exclusion record cannot be certified', () => {
  // D-0020, the structural half of "the student never sees gold": a certification asserts
  // the student never saw the reference, and that assertion needs the computed exclusion
  // behind it rather than the absence of evidence that it was seen.
  const store = ledger();
  store.putExam(exam('exam-0001'));
  const cycleId = store.startCycle({ mode: 'evaluation' });
  const runId = store.recordRun({
    cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed', applied: true, resultFile: 'r.json',
  });
  const harness = { policy: 'adr-0167' };
  store.importRubricBatch({ rubrics: [rubricFor(runId)], mode: 'evaluation' });

  for (const [label, artifact] of [
    ['no artifact at all', null],
    ['artifact with no provenance', {}],
    ['provenance with no exclusion', { provenance: {} }],
    ['exclusion present but never computed', { provenance: { goldExclusion: { ids: [], computed: false } } }],
    ['exclusion computed but carrying no id list', { provenance: { goldExclusion: { computed: true } } }],
  ]) {
    assert.throws(
      () => store.certify({ runId, verdict: 'pass', harness, artifact }),
      /carries no gold-provenance exclusion record/,
      `expected a refusal for: ${label}`,
    );
  }

  // An EMPTY exclusion is a legitimate and common result (a brain with nothing downstream of
  // that commit) and certifies fine. Only an ABSENT record refuses, because the two mean
  // opposite things: "we checked and there was nothing" against "we never checked".
  assert.equal(typeof store.certify({ runId, harness, artifact: certifiableArtifact([]) }), 'number');
  assert.equal(store.certifications().length, 1);
  store.close();
});

test('the exam bank round-trips through the ledger and filters on either axis', () => {
  const store = ledger();
  store.putExam(exam('exam-0001'));
  store.putExam(exam('exam-0002', { heldOut: true }));
  store.putExam(exam('exam-0003', {
    benchmarkStatus: 'quarantined', quarantineReason: 'Cap death in every cycle that drew it.',
  }));
  store.putExam(exam('exam-0004', { status: 'draft' }));

  assert.deepEqual(store.listExams().map((row) => row.examId), ['exam-0001', 'exam-0002', 'exam-0003', 'exam-0004']);
  assert.deepEqual(store.listExams({ benchmarkStatus: 'active' }).map((row) => row.examId), ['exam-0001', 'exam-0002', 'exam-0004']);
  assert.deepEqual(store.listExams({ heldOut: true }).map((row) => row.examId), ['exam-0002']);
  assert.deepEqual(store.listExams({ status: 'draft' }).map((row) => row.examId), ['exam-0004']);
  const row = store.listExams({ benchmarkStatus: 'quarantined' })[0];
  assert.equal(row.quarantineReason, 'Cap death in every cycle that drew it.');
  assert.equal(store.getExam('exam-0002').heldOut, true);
  store.close();
});

/** A validated rubric, the shape grading.js hands the ledger. */
function rubricFor(runId, overrides = {}) {
  const axes = {};
  for (const axis of AXES) axes[axis] = { score: 4, citations: ['src/sync.js:2'] };
  return {
    runId,
    examId: 'exam-0001',
    verdict: 'pass',
    axes,
    gaps: [{ tag: 'model-limit', note: 'shown and ignored' }],
    author: 'teacher-model@https://provider.invalid',
    authorRole: 'teacher',
    taskDigest: 'task-digest',
    submissionDigest: `submission-${runId}`,
    ...overrides,
  };
}

function ledgerWithRun(mode = 'evaluation') {
  const store = ledger();
  store.putExam(exam('exam-0001'));
  const cycleId = store.startCycle({ mode });
  const runId = store.recordRun({
    cycleId, examId: 'exam-0001', mode, status: 'completed', applied: true, resultFile: `${mode}-r.json`,
  });
  return { store, cycleId, runId };
}

test('rubrics persist, and come back keyed by name for the daemon boundary to order', () => {
  const { store, runId } = ledgerWithRun();
  const batchId = store.importRubricBatch({ rubrics: [rubricFor(runId)], mode: 'evaluation', source: 'reply.json' });

  const stored = store.rubricFor(runId);
  assert.equal(stored.runId, runId);
  assert.equal(stored.verdict, 'pass');
  assert.equal(stored.batchId, batchId);
  // BY NAME, because that is how grading.js authors and validates a rubric. The ordered wire
  // list is the daemon's axesFor at the boundary (methods.md finding 79), not the store's.
  assert.deepEqual(Object.keys(stored.axes).sort(), [...AXES].sort());
  assert.equal(stored.axes.correctness_vs_gold.score, 4);
  assert.deepEqual(stored.gaps, [{ tag: 'model-limit', note: 'shown and ignored' }]);
  assert.equal(store.rubricFor(9_999), null, 'an ungraded run reads as null, never as empty axes');

  const [batch] = store.gradeBatches();
  assert.equal(batch.rubric_count, 1);
  assert.equal(batch.source, 'reply.json');
  store.close();
});

test('attemptsForExam attaches each rubric, so no caller needs its own SQL', () => {
  const { store, cycleId, runId } = ledgerWithRun();
  const second = store.recordRun({
    cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed', applied: true, resultFile: 'r2.json',
  });
  store.importRubricBatch({ rubrics: [rubricFor(runId)], mode: 'evaluation' });

  const attempts = store.attemptsForExam('exam-0001');
  assert.deepEqual(attempts.map((attempt) => attempt.id), [second, runId], 'newest first');
  assert.equal(attempts[0].rubric, null, 'the ungraded attempt carries null, not an empty object');
  assert.equal(attempts[1].rubric.verdict, 'pass');
  assert.equal(attempts[1].rubric.axes.reasoning_quality.score, 4);
  assert.deepEqual(store.attemptsForExam('exam-0404'), []);
  store.close();
});

test('P7 clause 5 is STRUCTURAL in the schema: an unsubmitted run cannot be graded', () => {
  // The property the rubric TABLE buys over a JSON column on run. `recordRun` refuses a row
  // for a run with no applied diff, so the run table holds only gradeable attempts, and the
  // foreign key makes a rubric for a cap-death impossible even if the validator were never
  // called. Two independent mechanisms, and this one cannot be bypassed by a caller.
  const { store } = ledgerWithRun();
  assert.throws(
    () => store.importRubricBatch({ rubrics: [rubricFor(4_242)], mode: 'evaluation' }),
    /no such run row.*has no row by design/s,
  );
  assert.equal(store.gradeBatches().length, 0, 'and the batch row is rolled back with it');
  store.close();
});

test('clause 9 on disk: a batch that fails partway writes NOTHING', () => {
  const { store, cycleId, runId } = ledgerWithRun();
  const second = store.recordRun({
    cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed', applied: true, resultFile: 'r2.json',
  });

  // Three rubrics, the third naming a run that does not exist. The first two are perfect.
  assert.throws(() => store.importRubricBatch({
    rubrics: [rubricFor(runId), rubricFor(second), rubricFor(7_777)],
    mode: 'evaluation',
  }), /no such run row/);

  // The transaction is what makes half a graded cohort impossible, and half a graded cohort
  // looks exactly like a graded cohort.
  assert.equal(store.rubricFor(runId), null);
  assert.equal(store.rubricFor(second), null);
  assert.equal(store.gradeBatches().length, 0);

  // The same batch minus the bad rubric lands whole.
  store.importRubricBatch({ rubrics: [rubricFor(runId), rubricFor(second)], mode: 'evaluation' });
  assert.ok(store.rubricFor(runId) && store.rubricFor(second));
  assert.equal(store.gradeBatches()[0].rubric_count, 2);
  store.close();
});

test('one rubric per run, and mode quarantine reaches the rubric store', () => {
  const { store, runId } = ledgerWithRun();
  store.importRubricBatch({ rubrics: [rubricFor(runId)], mode: 'evaluation' });
  // A re-import cannot quietly double-grade an attempt.
  assert.throws(() => store.importRubricBatch({ rubrics: [rubricFor(runId)], mode: 'evaluation' }), /UNIQUE/i);
  assert.equal(store.gradeBatches().length, 1, 'and the second batch row rolls back too');

  // Clause 21 at the storage layer: a harness-debug cohort is recorded and never graded.
  const debug = ledgerWithRun('harness-debug');
  assert.throws(
    () => debug.store.importRubricBatch({ rubrics: [rubricFor(debug.runId)], mode: 'harness-debug' }),
    /only evaluation and experiment runs are graded/,
  );
  // An experiment IS gradable, because its arm has to be comparable; it is still never scored.
  const experiment = ledgerWithRun('experiment');
  assert.ok(experiment.store.importRubricBatch({ rubrics: [rubricFor(experiment.runId)], mode: 'experiment' }));
  assert.equal(experiment.store.summary().scoredWrites, 0);

  // A rubric cannot cross modes: an evaluation batch may not carry an experiment run.
  const mixed = ledgerWithRun('experiment');
  assert.throws(
    () => mixed.store.importRubricBatch({ rubrics: [rubricFor(mixed.runId)], mode: 'evaluation' }),
    /arrived in a evaluation batch, but that run is experiment/,
  );

  store.close();
  debug.store.close();
  experiment.store.close();
  mixed.store.close();
});

test('the rubric migration is appended, not edited, and the ledger refuses an edited one', async () => {
  await withTemp(async (root) => {
    const file = path.join(root, 'gym.sqlite');
    const first = GymLedger.open(file);
    assert.deepEqual(
      first.database.prepare('SELECT id FROM schema_migration ORDER BY id').all().map((row) => row.id),
      ['001-gym-base', '002-rubrics', '003-certification-rubric'],
      'appended, so an existing ledger gains the tables without 001 being touched',
    );
    first.close();
    // Re-opening applies nothing and refuses nothing: the checksums match.
    assert.doesNotThrow(() => GymLedger.open(file).close());

    const tampered = new Database(file);
    tampered.prepare('UPDATE schema_migration SET checksum = ? WHERE id = ?').run('edited-after-the-fact', '002-rubrics');
    tampered.close();
    assert.throws(() => GymLedger.open(file), /Gym migration 002-rubrics was edited after it was applied/);
  });
});

test('the drawn cohort is counted from result files, and a cap-death is inside the window', async () => {
  // The platform's cycle 65 in miniature: three exams drawn, the FIRST one cap-dies (so it
  // has a file and no row), two produce rows. Rows say two; the files say three.
  const files = [
    { path: 'p-result.json', exam: 'exam-0000', at: '2026-08-15T00:00:00.000Z' },
    { path: 'a-result.json', exam: 'exam-0001', at: '2026-08-16T10:00:00.000Z' },
    { path: 'b-result.json', exam: 'exam-0002', at: '2026-08-16T10:10:00.000Z' },
    { path: 'c-result.json', exam: 'exam-0003', at: '2026-08-16T10:20:00.000Z' },
  ];
  const rows = [{ resultFile: 'b-result.json' }, { resultFile: 'c-result.json' }];
  assert.equal(rows.length, 2);
  assert.equal(
    drawnExamCount(rows, files, { previousCycleLastFileAt: '2026-08-15T00:00:00.000Z' }),
    3,
    'the leading cap-death is inside the window, which is the whole reason the lower bound comes from the previous cycle',
  );
  // A lower bound placed AFTER the casualty loses it silently, and this is the number a
  // row-anchored window would publish: cycle 65's 13 instead of 14. Shown rather than
  // described, so the difference between the two windows is visible.
  assert.equal(drawnExamCount(rows, files, { previousCycleLastFileAt: '2026-08-16T10:00:00.000Z' }), 2);
  // Narrower still, and the count would fall below the rows it must explain. That is caught
  // rather than published: fewer drawn than graded is impossible, so the answer is null.
  assert.equal(drawnExamCount(rows, files, { previousCycleLastFileAt: '2026-08-16T10:10:00.000Z' }), null);

  // Fail closed rather than short: no predecessor, no principled lower bound.
  assert.equal(drawnExamCount(rows, files, {}), null);
  // A row pointing at a file the set does not contain means the set does not describe these
  // runs, so the count is refused instead of being quietly short.
  assert.equal(drawnExamCount([...rows, { resultFile: 'missing.json' }], files, { previousCycleLastFileAt: files[0].at }), null);
  assert.equal(drawnExamCount([], files, { previousCycleLastFileAt: files[0].at }), null);
  assert.equal(drawnExamCount(rows, [], { previousCycleLastFileAt: files[0].at }), null);
});

test('result files are read from inside the artifact, and a moved artifact fails the whole set closed', async () => {
  await withTemp(async (root) => {
    const written = await writeResultFile(root, {
      timestamp: '2026-08-16T10:00:00.000Z', mode: 'evaluation', exam: { id: 'exam-0001' }, status: 'completed',
    });
    assert.equal(written.name, '2026-08-16T10-00-00.000Z-exam-0001-result.json');
    await writeResultFile(root, {
      timestamp: '2026-08-16T10:05:00.000Z', mode: 'harness-debug', exam: { id: 'exam-0002' }, status: 'completed',
    });

    const files = await loadResultFiles(root);
    assert.deepEqual(files.map((file) => file.exam), ['exam-0001'], 'a harness-debug artifact is recorded and never counted');
    assert.equal(files[0].at, '2026-08-16T10:00:00.000Z');

    // A copied artifact still names where it wrote itself, so the set is refused whole.
    await writeFile(path.join(root, 'copied-result.json'), JSON.stringify({
      ...written.result, timestamp: '2026-08-16T11:00:00.000Z',
    }), 'utf8');
    assert.equal(await loadResultFiles(root), null);

    assert.equal(await loadResultFiles(path.join(root, 'does-not-exist')), null);
    await assert.rejects(writeResultFile(root, { mode: 'evaluation', exam: {} }), /must carry exam.id, timestamp, and mode/);
  });
});

test('drawnForCycle joins the previous cycle, and reports null when there is no predecessor', async () => {
  const store = ledger();
  store.putExam(exam('exam-0001'));
  store.putExam(exam('exam-0002'));
  store.putExam(exam('exam-0003'));
  const first = store.startCycle({ mode: 'evaluation' });
  store.recordRun({ cycleId: first, examId: 'exam-0001', mode: 'evaluation', status: 'completed', applied: true, resultFile: 'p-result.json' });
  const second = store.startCycle({ mode: 'evaluation' });
  store.recordRun({ cycleId: second, examId: 'exam-0002', mode: 'evaluation', status: 'completed', applied: true, resultFile: 'b-result.json' });
  store.recordRun({ cycleId: second, examId: 'exam-0003', mode: 'evaluation', status: 'completed', applied: true, resultFile: 'c-result.json' });

  const files = [
    { path: 'p-result.json', exam: 'exam-0001', at: '2026-08-15T00:00:00.000Z' },
    // A cap-death: a file with no row, drawn between the two cycles.
    { path: 'a-result.json', exam: 'exam-0009', at: '2026-08-16T10:00:00.000Z' },
    { path: 'b-result.json', exam: 'exam-0002', at: '2026-08-16T10:10:00.000Z' },
    { path: 'c-result.json', exam: 'exam-0003', at: '2026-08-16T10:20:00.000Z' },
  ];
  assert.equal(store.drawnForCycle(second, files), 3, 'two rows, three drawn');
  assert.equal(store.drawnForCycle(first, files), null, 'the first cycle has no predecessor and says so');
  assert.equal(store.summary({ cycleId: second, resultFiles: files }).drawnFromResultFiles, 3);
  assert.equal(store.summary({ cycleId: second }).drawnFromResultFiles, null, 'no files, no number, and never a zero');
  assert.equal(store.summary({ cycleId: second }).mode, 'evaluation');
  store.close();
});
