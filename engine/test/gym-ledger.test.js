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
    provenance: { source: 'auditor-selection', commit: SHA_GOLD },
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
  assert.throws(() => store.certify({ runId, verdict: 'partial', harness: { x: 1 }, artifact }), /a certification records a pass/);
  assert.throws(() => store.certify({ runId, verdict: 'pass', harness: {}, artifact }), /must carry the harness provenance/);
  assert.throws(() => store.certify({ runId: 999, verdict: 'pass', harness: { x: 1 }, artifact }), /unknown run 999/);

  // Quarantine is checked AT certification time, because an exam can be quarantined between
  // the run and the grade, and a certification is a claim made now.
  store.putExam(exam('exam-0001', {
    benchmarkStatus: 'quarantined', quarantineReason: 'Gold defect found after the run was graded.',
  }));
  assert.throws(() => store.certify({ runId, verdict: 'pass', harness: { x: 1 }, artifact }), /Refusing to certify exam-0001: it is quarantined/);
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
  assert.equal(typeof store.certify({ runId, verdict: 'pass', harness, artifact: certifiableArtifact([]) }), 'number');
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
