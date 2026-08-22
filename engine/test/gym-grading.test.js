// P7 clauses 1 through 9: grading and rubric import, refusal-first.
//
// Registered acceptance: docs/verification/p7-grading-harvest-acceptance.md (commit 1cdc2b8).
// Every clause here is driven against a scripted fake teacher; nothing calls a provider.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AXES, GAP_TAGS, NO_WRITE_TAGS, RubricRefused, buildGradingPacket, capVerdict, citableFilesFromDiff,
  cycleGradeSummary, digestOf, importRubrics, stampAuthor, validateRubric,
} from '../src/gym/grading.js';
import { parseExamRecord } from '../src/gym/exams.js';

const SHA_BASE = 'a'.repeat(40);
const SHA_GOLD = 'b'.repeat(40);
const AUDITOR = { role: 'auditor', model: 'auditor-model', endpoint: 'https://provider.invalid' };
const TEACHER = { role: 'teacher', model: 'teacher-model', endpoint: 'https://provider.invalid' };

const DIFF = [
  'diff --git a/src/sync.js b/src/sync.js',
  '--- a/src/sync.js',
  '+++ b/src/sync.js',
  '@@ -1 +1,2 @@',
  ' const value = 1;',
  '+export const wired = true;',
  'diff --git a/src/route.js b/src/route.js',
  '--- a/src/route.js',
  '+++ b/src/route.js',
  '@@ -1 +1,2 @@',
  ' const routes = [];',
  '+routes.push(sync);',
  '',
].join('\n');

function exam(overrides = {}) {
  return parseExamRecord({
    examId: 'exam-0001',
    status: 'promoted',
    benchmarkStatus: 'active',
    heldOut: false,
    scopeTier: 'M',
    scopeFiles: 2,
    scopeInsertions: 20,
    baseCommit: SHA_BASE,
    goldCommit: SHA_GOLD,
    task: 'Wire the sync endpoint through to the client so one real datum crosses the seam.',
    provenance: { source: 'auditor-selection', commit: SHA_GOLD, authoredBy: AUDITOR },
    ...overrides,
  });
}

function artifact(overrides = {}) {
  return {
    exam: { id: 'exam-0001', task: exam().task },
    mode: 'evaluation',
    status: 'completed',
    apply: { applied: true },
    candidate: [{ id: 'lint', classification: 'pass' }],
    student: { diff: DIFF },
    provenance: {
      shownDocumentIds: ['brain.conventions', 'brain.architecture'],
      goldExclusion: { computed: true, ids: ['brain.decision-0007'], reasons: {} },
    },
    resultFile: 'r.json',
    ...overrides,
  };
}

function rubric(packet, overrides = {}) {
  const axes = {};
  for (const axis of AXES) axes[axis] = { score: 4, citations: ['src/sync.js:2'] };
  return {
    runId: 1,
    examId: 'exam-0001',
    taskDigest: packet.taskDigest,
    submissionDigest: packet.submissionDigest,
    axes,
    verdict: 'pass',
    gaps: [],
    ...overrides,
  };
}

test('the packet is DERIVED from the run artifact, never supplied by the grader', () => {
  const packet = buildGradingPacket({ artifact: artifact() });
  assert.deepEqual(packet.citableFiles, ['src/route.js', 'src/sync.js']);
  assert.equal(packet.taskDigest, digestOf(exam().task));
  assert.equal(packet.submissionDigest, digestOf(DIFF));
  assert.deepEqual(packet.shownDocumentIds, ['brain.conventions', 'brain.architecture']);
  assert.deepEqual(packet.excludedDocumentIds, ['brain.decision-0007']);
  assert.deepEqual(citableFilesFromDiff(''), []);
});

test('clause 1: five axes, each scored 1 to 5, each cited', () => {
  const packet = buildGradingPacket({ artifact: artifact() });
  assert.doesNotThrow(() => validateRubric(rubric(packet), packet, { grader: TEACHER, exam: exam() }));

  for (const axis of AXES) {
    const missing = rubric(packet);
    delete missing.axes[axis];
    assert.throws(() => validateRubric(missing, packet, { grader: TEACHER, exam: exam() }),
      new RegExp(`missing axis ${axis}`), `a rubric missing ${axis} must be refused`);
  }
  for (const score of [0, 6, 3.5, '4', null]) {
    const bad = rubric(packet);
    bad.axes.reasoning_quality.score = score;
    assert.throws(() => validateRubric(bad, packet, { grader: TEACHER, exam: exam() }), /outside 1 to 5/);
  }
  const uncited = rubric(packet);
  uncited.axes.decision_awareness.citations = [];
  assert.throws(() => validateRubric(uncited, packet, { grader: TEACHER, exam: exam() }), /carries no citation/);

  const invented = rubric(packet);
  invented.axes.correctness_vs_gold.citations = ['src/never-touched.js:3'];
  assert.throws(() => validateRubric(invented, packet, { grader: TEACHER, exam: exam() }),
    /cites src\/never-touched.js, which the submission diff never touched/);

  const extra = rubric(packet);
  extra.axes.vibes = { score: 5, citations: ['src/sync.js:2'] };
  assert.throws(() => validateRubric(extra, packet, { grader: TEACHER, exam: exam() }), /unknown axes: vibes/);
});

test('clause 2: a document citation must be one the student was actually shown', () => {
  const packet = buildGradingPacket({ artifact: artifact() });
  const shown = rubric(packet);
  shown.axes.decision_awareness.citations = ['brain.conventions'];
  assert.doesNotThrow(() => validateRubric(shown, packet, { grader: TEACHER, exam: exam() }));

  const unseen = rubric(packet);
  unseen.axes.decision_awareness.citations = ['brain.invented'];
  assert.throws(() => validateRubric(unseen, packet, { grader: TEACHER, exam: exam() }), /which the student was never shown/);

  // The sharper case, and the one only this port has: a document WITHHELD by the
  // gold-provenance exclusion. Citing it is grading against the gold.
  const withheld = rubric(packet);
  withheld.axes.correctness_vs_gold.citations = ['brain.decision-0007'];
  assert.throws(() => validateRubric(withheld, packet, { grader: TEACHER, exam: exam() }),
    /was WITHHELD from the student by the gold-provenance exclusion/);
});

test('clause 3: a rubric binds to BOTH digests, so it cannot grade another attempt', () => {
  const packet = buildGradingPacket({ artifact: artifact() });
  assert.throws(() => validateRubric(rubric(packet, { taskDigest: digestOf('a different task') }), packet, { grader: TEACHER, exam: exam() }),
    /task digest that does not match the run; the task was reworded/);

  // THE SCENARIO THE CLAUSE EXISTS FOR: the same exam re-run produces IDENTICAL task text and
  // a DIFFERENT diff. A task-only binding would accept attempt one's rubric for attempt two.
  const secondAttempt = buildGradingPacket({
    artifact: artifact({ student: { diff: `${DIFF}diff --git a/src/extra.js b/src/extra.js\n` } }),
  });
  assert.equal(secondAttempt.taskDigest, packet.taskDigest, 'the task is byte-identical across attempts');
  assert.notEqual(secondAttempt.submissionDigest, packet.submissionDigest);
  assert.throws(() => validateRubric(rubric(packet), secondAttempt, { grader: TEACHER, exam: exam() }),
    /this rubric grades a different attempt/);
});

test('clause 4: the exam author cannot grade its own exam, checked before anything else', () => {
  const packet = buildGradingPacket({ artifact: artifact() });
  // The rubric is otherwise perfect; only the grader is wrong.
  assert.throws(() => validateRubric(rubric(packet), packet, { grader: AUDITOR, exam: exam() }),
    /cannot be graded by the same identity/);
  assert.doesNotThrow(() => validateRubric(rubric(packet), packet, { grader: TEACHER, exam: exam() }));
});

test('clause 5: verdict caps, and a run with no diff gets NO rubric at all', () => {
  const packet = buildGradingPacket({ artifact: artifact() });
  assert.equal(capVerdict('fail', packet), 'fail');
  assert.equal(capVerdict('pass', packet), 'pass');

  // A measured-metric regression is real signal at a different severity than a gate that
  // failed outright, and one label for both reads as a compile failure.
  const metric = buildGradingPacket({
    artifact: artifact({ candidate: [{ id: 'lint', classification: 'regressed', status: 'pass', metric: { direction: 'lower-better', value: 19, baselineValue: 17 } }] }),
  });
  assert.equal(capVerdict('fail', metric), 'partial', 'a measured-metric-only regression caps at partial');

  const broken = buildGradingPacket({
    artifact: artifact({ candidate: [{ id: 'build', classification: 'regressed', status: 'fail' }] }),
  });
  assert.equal(capVerdict('fail', broken), 'fail', 'a gate that failed outright is not capped');

  // No diff: unsubmitted, and the importer refuses a rubric for it outright.
  const capDeath = buildGradingPacket({
    artifact: artifact({ status: 'unsubmitted', apply: { applied: false }, student: { diff: '' }, candidate: [] }),
  });
  assert.equal(capVerdict('fail', capDeath), 'unsubmitted');
  assert.throws(() => validateRubric(rubric(capDeath), capDeath, { grader: TEACHER, exam: exam() }),
    /no rubric may be written for it/);
});

test('clause 6: the author is canonical, and a differing self-report is preserved', () => {
  // The platform filed three cycles under one name while the batches said another; the
  // disagreement was the evidence that something was misconfigured, so it is kept.
  assert.deepEqual(stampAuthor({ author: 'openai/gpt-5.6-sol' }, TEACHER), {
    author: 'teacher-model@https://provider.invalid',
    authorRole: 'teacher',
    reportedAuthor: 'openai/gpt-5.6-sol',
  });
  // No disagreement, no noise.
  assert.deepEqual(stampAuthor({ author: 'teacher-model@https://provider.invalid' }, TEACHER), {
    author: 'teacher-model@https://provider.invalid',
    authorRole: 'teacher',
  });
  const packet = buildGradingPacket({ artifact: artifact() });
  const stamped = validateRubric(rubric(packet, { author: 'I am the teacher' }), packet, { grader: TEACHER, exam: exam() });
  assert.equal(stamped.author, 'teacher-model@https://provider.invalid');
  assert.equal(stamped.reportedAuthor, 'I am the teacher');
});

test('gaps are validated: known tags, a real note, and a retrieval-miss that means what it says', () => {
  const packet = buildGradingPacket({ artifact: artifact() });
  assert.deepEqual([...NO_WRITE_TAGS], ['model-limit', 'harness-defect', 'stale-gold']);
  assert.ok(GAP_TAGS.includes('retrieval-miss') && GAP_TAGS.includes('knowledge-gap'));

  const ok = rubric(packet, { gaps: [{ tag: 'model-limit', note: 'the document was shown and ignored' }] });
  assert.doesNotThrow(() => validateRubric(ok, packet, { grader: TEACHER, exam: exam() }));

  assert.throws(() => validateRubric(rubric(packet, { gaps: [{ tag: 'vibes', note: 'x' }] }), packet, { grader: TEACHER, exam: exam() }),
    /has tag "vibes"/);
  assert.throws(() => validateRubric(rubric(packet, { gaps: [{ tag: 'model-limit', note: '  ' }] }), packet, { grader: TEACHER, exam: exam() }),
    /a gap with no statement teaches nothing/);
  assert.throws(() => validateRubric(rubric(packet, { gaps: [{ tag: 'retrieval-miss', note: 'missed it' }] }), packet, { grader: TEACHER, exam: exam() }),
    /retrieval-miss without a targetDocumentId/);
  // A retrieval-miss naming a document the student WAS shown is a model-limit wearing the
  // wrong tag, and the tag decides whether harvest writes to the brain.
  assert.throws(
    () => validateRubric(rubric(packet, { gaps: [{ tag: 'retrieval-miss', note: 'missed it', targetDocumentId: 'brain.conventions' }] }), packet, { grader: TEACHER, exam: exam() }),
    /but the student WAS shown it; that is a model-limit/,
  );
});

test('a sub-passing verdict with empty gaps is refused; attribution never forces invention', () => {
  // The platform's cycle 32: empty gaps on failed exams, teaching nothing while looking
  // complete. A pass may carry empty gaps; partial and fail must say what went wrong, and
  // model-limit or harness-defect satisfy that without writing a word to the brain.
  const packet = buildGradingPacket({ artifact: artifact() });
  for (const verdict of ['partial', 'fail']) {
    assert.throws(
      () => validateRubric(rubric(packet, { verdict, gaps: [] }), packet, { grader: TEACHER, exam: exam() }),
      /teaches nothing while looking complete/,
      `${verdict} with no gaps must be refused`,
    );
    assert.doesNotThrow(() => validateRubric(
      rubric(packet, { verdict, gaps: [{ tag: 'model-limit', note: 'the shown convention was ignored' }] }),
      packet, { grader: TEACHER, exam: exam() },
    ));
  }
  assert.doesNotThrow(() => validateRubric(rubric(packet, { verdict: 'pass', gaps: [] }), packet, { grader: TEACHER, exam: exam() }));
});

test('clause 7: rubrics are filed by runId, and a transposed pair is refused', () => {
  const packetA = buildGradingPacket({ artifact: artifact() });
  const packetB = buildGradingPacket({
    artifact: artifact({ student: { diff: `${DIFF}diff --git a/src/b.js b/src/b.js\n` } }),
  });
  const packets = { 1: packetA, 2: packetB };
  const a = rubric(packetA, { runId: 1 });
  const b = rubric(packetB, { runId: 2 });

  assert.equal(importRubrics([a, b], packets, { grader: TEACHER }).length, 2);
  // Arrival order is irrelevant: filed by the id they carry.
  assert.equal(importRubrics([b, a], packets, { grader: TEACHER }).length, 2);

  // TRANSPOSED: the two rubrics swap their runIds, which is the silent corruption the rule
  // exists to prevent. The digests are what catch it.
  const transposedA = { ...a, runId: 2 };
  const transposedB = { ...b, runId: 1 };
  assert.throws(() => importRubrics([transposedA, transposedB], packets, { grader: TEACHER }),
    /grades a different attempt/);

  assert.throws(() => importRubrics([a, { ...a }], packets, { grader: TEACHER }), /two rubrics for run 1/);
  assert.throws(() => importRubrics([{ ...a, runId: 99 }], packets, { grader: TEACHER }), /not in this round/);
  assert.throws(() => importRubrics([{ ...a, runId: undefined }], packets, { grader: TEACHER }), /Every rubric names the run it grades/);
  assert.throws(() => importRubrics('nope', packets, { grader: TEACHER }), /must be an array/);
});

test('clause 8: every refusal is reachable through the IMPORT path, not only the validator', () => {
  // The importer is the boundary. A validator nobody calls is not a boundary, and the
  // platform's rule is that what the importer refuses is what cannot land. Each case below
  // is the same refusal as its clause test, driven through import instead.
  const packet = buildGradingPacket({ artifact: artifact() });
  const capDeath = buildGradingPacket({
    artifact: artifact({ status: 'unsubmitted', apply: { applied: false }, student: { diff: '' }, candidate: [] }),
  });
  const packets = { 1: packet, 2: capDeath };
  const through = (patch, packetsOverride = packets) => importRubrics([rubric(packet, patch)], packetsOverride, {
    grader: TEACHER, examsByRunId: { 1: exam(), 2: exam() },
  });

  const missingAxis = rubric(packet);
  delete missingAxis.axes.convention_adherence;
  assert.throws(() => importRubrics([missingAxis], packets, { grader: TEACHER }), /missing axis convention_adherence/);

  const badScore = rubric(packet);
  badScore.axes.reasoning_quality.score = 0;
  assert.throws(() => importRubrics([badScore], packets, { grader: TEACHER }), /outside 1 to 5/);

  const inventedPath = rubric(packet);
  inventedPath.axes.correctness_vs_gold.citations = ['src/nowhere.js:1'];
  assert.throws(() => importRubrics([inventedPath], packets, { grader: TEACHER }), /the submission diff never touched/);

  const inventedDocument = rubric(packet);
  inventedDocument.axes.decision_awareness.citations = ['brain.invented'];
  assert.throws(() => importRubrics([inventedDocument], packets, { grader: TEACHER }), /never shown/);

  assert.throws(() => through({ taskDigest: 'wrong' }), /task was reworded/);
  assert.throws(() => through({ submissionDigest: 'wrong' }), /grades a different attempt/);

  // Clause 4 through the importer, which needs the exam to be in the round.
  assert.throws(
    () => importRubrics([rubric(packet)], packets, { grader: AUDITOR, examsByRunId: { 1: exam() } }),
    /cannot be graded by the same identity/,
  );

  // Clause 5 through the importer: a rubric for a run that produced no diff.
  assert.throws(
    () => importRubrics([rubric(capDeath, { runId: 2 })], packets, { grader: TEACHER }),
    /no rubric may be written for it/,
  );
});

test('clause 9: a refused batch accepts NOTHING, not even the rubrics that were fine', () => {
  const packetA = buildGradingPacket({ artifact: artifact() });
  const packetB = buildGradingPacket({
    artifact: artifact({ student: { diff: `${DIFF}diff --git a/src/b.js b/src/b.js\n` } }),
  });
  const packets = { 1: packetA, 2: packetB };
  const good = rubric(packetA, { runId: 1 });
  const bad = rubric(packetB, { runId: 2 });
  bad.axes.reasoning_quality.score = 9;

  // importRubrics returns the accepted set or throws; it never returns a partial set, so the
  // caller cannot write half a batch. Half a graded cohort looks like a graded cohort.
  assert.throws(() => importRubrics([good, bad], packets, { grader: TEACHER }), /outside 1 to 5/);
  assert.throws(() => importRubrics([bad, good], packets, { grader: TEACHER }), /outside 1 to 5/);
  assert.equal(importRubrics([good], packets, { grader: TEACHER }).length, 1);
});

test('the cycle summary counts only runs that produced a diff, and states the drawn cohort', () => {
  // A cycle of five that graded four is a FOUR-exam cycle. Reporting it as five with one
  // failure overstates both the spend and the failure rate; sixteen platform rows were
  // reclassified when this was found.
  const rubrics = [
    { verdict: 'pass' }, { verdict: 'partial' }, { verdict: 'fail' }, { verdict: 'unsubmitted' },
  ];
  const summary = cycleGradeSummary({ rubrics, drawn: 5 });
  assert.equal(summary.graded, 3);
  assert.equal(summary.unsubmitted, 1);
  assert.deepEqual(summary.counts, { pass: 1, partial: 1, fail: 1 });
  // Exact rationals, never a rounded display, and both denominators stated.
  assert.equal(summary.usefulRate, 2 / 3);
  assert.equal(summary.cohortUsefulRate, 2 / 5);
  assert.deepEqual(summary.denominator, { gradedBasis: 3, drawnBasis: 5 });

  // A drawn cohort that is not derivable produces null, never a guess.
  assert.equal(cycleGradeSummary({ rubrics, drawn: null }).cohortUsefulRate, null);
  assert.equal(cycleGradeSummary({ rubrics: [{ verdict: 'unsubmitted' }], drawn: 2 }).usefulRate, null);
});

test('RubricRefused carries the run and the field, so a refusal is actionable', () => {
  const packet = buildGradingPacket({ artifact: artifact() });
  try {
    validateRubric(rubric(packet, { runId: 7, taskDigest: 'wrong' }), packet, { grader: TEACHER, exam: exam() });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof RubricRefused);
    assert.equal(error.runId, 7);
    assert.equal(error.field, 'taskDigest');
  }
});
