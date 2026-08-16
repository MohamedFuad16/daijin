// Mode quarantine and the two orthogonal exam status axes: the rules that decide what may
// be drawn and what may be counted.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RUN_MODE, RUN_MODES, assertRunMode, assertScoredWrite, isGradableRun, isScoreableRun,
} from '../src/gym/run-mode.js';
import {
  MIN_QUARANTINE_REASON, examDrawRefusal, examListRow, graderIndependenceRefusal, parseExamRecord,
  quarantineExam, vetoExam,
} from '../src/gym/exams.js';

const SHA_BASE = 'a'.repeat(40);
const SHA_GOLD = 'b'.repeat(40);

function exam(overrides = {}) {
  return parseExamRecord({
    examId: 'exam-0001',
    status: 'promoted',
    benchmarkStatus: 'active',
    heldOut: false,
    scopeTier: 'M',
    scopeFiles: 3,
    scopeInsertions: 40,
    baseCommit: SHA_BASE,
    goldCommit: SHA_GOLD,
    task: 'Add the missing route registration so the sync endpoint is reachable end to end.',
    provenance: {
      source: 'auditor-selection',
      commit: SHA_GOLD,
      // P7 clause 4: an exam a model authored records which model.
      authoredBy: { role: 'auditor', model: 'auditor-model', endpoint: 'https://provider.invalid' },
    },
    ...overrides,
  });
}

test('three modes, and only evaluation is scoreable', () => {
  assert.deepEqual([...RUN_MODES], ['evaluation', 'experiment', 'harness-debug']);
  assert.equal(isScoreableRun('evaluation'), true);
  assert.equal(isScoreableRun('experiment'), false);
  assert.equal(isScoreableRun('harness-debug'), false);
  // An experiment is GRADED so its arm can be compared, and is still never scored. The two
  // questions are separate, so the two predicates are separate.
  assert.equal(isGradableRun('experiment'), true);
  assert.equal(isGradableRun('harness-debug'), false);
  assert.throws(() => assertRunMode('harness-smoke'), /Unsupported gym run mode/);
  assert.throws(() => assertRunMode(undefined), /Unsupported gym run mode: <missing>/);
});

test('the default mode is the one that cannot reach the scored record', () => {
  assert.equal(DEFAULT_RUN_MODE, 'harness-debug');
  assert.equal(isScoreableRun(DEFAULT_RUN_MODE), false);
  assert.throws(() => assertScoredWrite('harness-debug', 'a certification'), /may not write a certification/);
  assert.equal(assertScoredWrite('evaluation'), 'evaluation');
});

test('the two axes are orthogonal: a promoted exam can be quarantined, and the reason is required', () => {
  const promoted = exam();
  assert.equal(promoted.status, 'promoted');
  assert.equal(promoted.benchmarkStatus, 'active');

  const held = quarantineExam(promoted, 'Cap death in cycles 53 and 60 with no gradeable diff.');
  assert.equal(held.status, 'promoted', 'quarantine does not un-promote; the axes do not talk to each other');
  assert.equal(held.benchmarkStatus, 'quarantined');
  assert.equal(examListRow(held).quarantineReason, held.quarantineReason);

  assert.throws(() => quarantineExam(promoted, 'broken'), new RegExp(`at least ${MIN_QUARANTINE_REASON} characters`));
  assert.throws(
    () => parseExamRecord({ ...promoted, benchmarkStatus: 'quarantined' }, 'x'),
    /requires quarantineReason/,
  );
  // The PARSER enforces the minimum too, not only the quarantineExam helper. A record that
  // reached the store by any other path (an RPC patch, a YAML import, a restored row) would
  // otherwise carry "broken" as its whole audit trail. Found by mutation: replacing the
  // parser's length test with `false` left every other assertion here green.
  assert.throws(
    () => parseExamRecord({ ...promoted, benchmarkStatus: 'quarantined', quarantineReason: 'broken' }, 'x'),
    new RegExp(`at least ${MIN_QUARANTINE_REASON} characters`),
  );
  assert.throws(
    () => parseExamRecord({ ...promoted, quarantineReason: 'a reason with no quarantine at all' }, 'x'),
    /active exam cannot carry quarantineReason/,
  );
});

test('every bank row carries a readable title, derived from the task when none is given', () => {
  // RPC v5, D-0018: the bank was unreadable by id alone. Derivation never invents words.
  assert.equal(
    exam().title,
    'Add the missing route registration so the sync endpoint is reachable end to end',
  );
  assert.equal(examListRow(exam({ title: 'Wire the sync route' })).title, 'Wire the sync route');
  assert.equal(
    exam({ task: 'Short first clause. Then a much longer second sentence nobody needs in a list.' }).title,
    'Short first clause',
  );
  const long = exam({ task: `Do the thing ${'and then some more of it '.repeat(6)}until it is done.` });
  assert.ok(long.title.length <= 83, `derived titles are cut, not wrapped: ${long.title.length}`);
  assert.match(long.title, /\.\.\.$/);
});

test('heldOut is a third, independent flag', () => {
  const heldOut = exam({ heldOut: true });
  assert.equal(heldOut.status, 'promoted');
  assert.equal(heldOut.benchmarkStatus, 'active');
  assert.equal(examListRow(heldOut).heldOut, true);
  assert.throws(() => parseExamRecord({ ...heldOut, heldOut: 'yes' }, 'x'), /heldOut must be a boolean/);
});

test('draw refusals: each axis refuses on its own terms', () => {
  assert.equal(examDrawRefusal(exam(), { mode: 'evaluation' }), null);

  // Quarantine refuses in EVERY mode: a harness-debug run against a broken exam still burns
  // a slot and confuses whoever reads the artifact later.
  const quarantined = quarantineExam(exam(), 'Gold defect found in the 2026-08 audit.');
  for (const mode of RUN_MODES) {
    assert.match(examDrawRefusal(quarantined, { mode }), /is quarantined from execution: Gold defect/);
  }

  // A draft exam is exercisable in harness-debug and can never produce a scored row.
  const draft = exam({ status: 'draft' });
  assert.match(examDrawRefusal(draft, { mode: 'evaluation' }), /is draft, not promoted/);
  assert.equal(examDrawRefusal(draft, { mode: 'harness-debug' }), null);

  // A veto is the user's, and the modes are ours.
  const vetoed = vetoExam(exam(), 'User vetoed: the task statement leaks the solution.');
  for (const mode of RUN_MODES) assert.match(examDrawRefusal(vetoed, { mode }), /is vetoed/);

  // The held-out split is what keeps the reserved exams an honest yardstick, so it refuses
  // in both directions rather than only the obvious one.
  const heldOut = exam({ heldOut: true });
  assert.match(examDrawRefusal(heldOut, { mode: 'evaluation', cohort: 'training' }), /is held out/);
  assert.equal(examDrawRefusal(heldOut, { mode: 'evaluation', cohort: 'held-out' }), null);
  assert.match(examDrawRefusal(exam(), { mode: 'evaluation', cohort: 'held-out' }), /cannot fill a held-out cohort slot/);
});

test('an exam record without provenance, a real base and gold, or an actionable task is refused', () => {
  assert.throws(() => parseExamRecord({ ...exam(), provenance: undefined }, 'x'), /provenance is required/);
  assert.throws(() => parseExamRecord({ ...exam(), provenance: { source: 'vibes' } }, 'x'), /provenance.source must be one of/);
  assert.throws(() => parseExamRecord({ ...exam(), baseCommit: 'abc' }, 'x'), /must be full 40-character SHAs/);
  assert.throws(() => parseExamRecord({ ...exam(), goldCommit: SHA_BASE }, 'x'), /must differ/);
  assert.throws(() => parseExamRecord({ ...exam(), task: 'fix it' }, 'x'), /task is required/);
  assert.throws(() => parseExamRecord({ ...exam(), examId: 'exam-1' }, 'x'), /invalid exam id/);
  assert.throws(() => parseExamRecord({ ...exam(), scopeTier: 'XL' }, 'x'), /invalid scopeTier/);
});

test('P7 clause 4: an exam a model authored records WHICH model, at write time', () => {
  // Refusing at write time rather than at grading time means the unusable record never
  // enters the bank, so the grading refusal is never the first thing to notice the gap.
  assert.throws(
    () => parseExamRecord({ ...exam(), provenance: { source: 'auditor-selection', commit: SHA_GOLD } }, 'x'),
    /provenance.authoredBy is required when the source is auditor-selection/,
  );
  assert.throws(
    () => parseExamRecord({ ...exam(), provenance: { source: 'auditor-override', commit: SHA_GOLD } }, 'x'),
    /provenance.authoredBy is required when the source is auditor-override/,
  );
  // A DETERMINISTICALLY mined exam has no model author, so there is no independence question
  // to answer and no field to demand.
  const mined = parseExamRecord({ ...exam(), provenance: { source: 'commit-mining', commit: SHA_GOLD } }, 'x');
  assert.equal(mined.provenance.authoredBy, null);
  // An identity needs a model: a role alone cannot establish independence, because the roles
  // differ by construction and would make the check unfalsifiable.
  assert.throws(
    () => parseExamRecord({ ...exam(), provenance: { source: 'auditor-selection', authoredBy: { role: 'auditor' } } }, 'x'),
    /needs a model id/,
  );
  assert.equal(exam().provenance.authoredBy.key, 'auditor-model@https://provider.invalid');
});

test('P7 clause 4: the author cannot grade its own exam, and the check can fire', () => {
  const authored = exam();
  const auditor = { role: 'auditor', model: 'auditor-model', endpoint: 'https://provider.invalid' };
  const teacher = { role: 'teacher', model: 'teacher-model', endpoint: 'https://provider.invalid' };

  assert.equal(graderIndependenceRefusal(authored, teacher), null, 'a different model may grade');
  assert.match(
    graderIndependenceRefusal(authored, auditor),
    /was authored by auditor-model@https:\/\/provider.invalid and cannot be graded by the same identity/,
  );
  // THE REALISTIC FAILURE, and the reason identity is keyed on model rather than role: a user
  // with one API key configures both roles to the same model. Role separation is then a
  // diagram, and the refusal is what makes it a fact.
  assert.match(
    graderIndependenceRefusal(authored, { role: 'teacher', model: 'auditor-model', endpoint: 'https://provider.invalid' }),
    /cannot be graded by the same identity/,
  );
  // The same model at a different endpoint is a different deployment and is allowed; keying
  // on the pair is what makes that distinction expressible.
  assert.equal(
    graderIndependenceRefusal(authored, { role: 'teacher', model: 'auditor-model', endpoint: 'https://other.invalid' }),
    null,
  );

  // A deterministically mined exam has no author, so independence holds by construction.
  const mined = parseExamRecord({ ...exam(), provenance: { source: 'commit-mining', commit: SHA_GOLD } }, 'x');
  assert.equal(graderIndependenceRefusal(mined, auditor), null);

  // ABSENT IS NOT EMPTY: a record claiming a model author while recording none is refused,
  // even though parseExamRecord would never have stored it. Reaching this branch means the
  // record arrived from somewhere else, and that is exactly when a check should be loudest.
  const smuggled = { examId: 'exam-0002', provenance: { source: 'auditor-selection', authoredBy: null } };
  assert.match(graderIndependenceRefusal(smuggled, teacher), /records no authoring identity, so independence cannot be shown/);
});

test('a raised per-exam cap carries its reason, exactly like a quarantine', () => {
  const raised = exam({ workTokenCap: 900_000, workTokenCapReason: 'Died at 618k and 645k in cycles 53 and 60.' });
  assert.equal(raised.workTokenCap, 900_000);
  assert.throws(() => parseExamRecord({ ...exam(), workTokenCap: 900_000 }, 'x'), /workTokenCapReason is required/);
  assert.throws(() => parseExamRecord({ ...exam(), workTokenCap: 50_000, workTokenCapReason: 'twenty characters here' }, 'x'), /from 100000 to 1000000/);
  assert.throws(() => parseExamRecord({ ...exam(), workTokenCapReason: 'orphaned reason with no cap at all' }, 'x'), /without workTokenCap/);
});
