// P7 clauses 10 through 17: harvest, the only step that puts anything back into the brain.
//
// Registered acceptance: docs/verification/p7-grading-harvest-acceptance.md (commit 1cdc2b8).
// Every clause is driven against scripted answers; nothing calls a provider, and nothing here
// writes into a real logs or harvest directory (clause 19).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANSWER_KINDS, CURATION_GATES, HarvestRefused, answersToProposals, applyProposals, buildHarvestQuestions,
  curateProposals, harvestBatch, validateCitationsAgainstCurrentCode,
} from '../src/gym/harvest.js';
import { NO_WRITE_TAGS } from '../src/gym/grading.js';

const EXAMS = {
  1: { examId: 'exam-0001', heldOut: false },
  2: { examId: 'exam-0002', heldOut: false },
};

function rubric(runId, gaps) {
  return { runId, examId: EXAMS[runId].examId, verdict: 'fail', gaps };
}

const PACKETS = {
  1: { shownDocumentIds: ['brain.conventions'], absentDocumentIds: ['brain.sync-lesson'] },
  2: { shownDocumentIds: [], absentDocumentIds: ['brain.sync-lesson'] },
};

const DOCUMENT_IDS = ['brain.conventions', 'brain.sync-lesson', 'brain.architecture'];

test('clause 11: the gap TAG decides whether a question is asked at all', () => {
  const { questions, skipped } = buildHarvestQuestions({
    rubrics: [rubric(1, [
      { tag: 'retrieval-miss', note: 'the seam lesson existed and was not retrieved', targetDocumentId: 'brain.sync-lesson' },
      { tag: 'knowledge-gap', note: 'nothing covers the wiring convention' },
      { tag: 'model-limit', note: 'it was shown and ignored' },
      { tag: 'harness-defect', note: 'the gate could not fail' },
      { tag: 'stale-gold', note: 'the reference is outdated' },
    ])],
    examsByRunId: EXAMS,
  });

  assert.deepEqual(questions.map((question) => question.tag), ['retrieval-miss', 'knowledge-gap']);
  assert.equal(questions[0].question, 'What knowledge, had it been retrieved, would have prevented this?');
  // The three no-write tags are MEASURED and skipped, with the reason recorded rather than
  // the gap silently vanishing: inventing a lesson for a model-limit pollutes the brain.
  assert.deepEqual(skipped.map((entry) => entry.tag), [...NO_WRITE_TAGS]);
  for (const entry of skipped) assert.equal(entry.reason, 'tag produces no brain write');
});

test('clause 12: a held-out run is refused BEFORE any question is asked', () => {
  // The boundary that keeps the reserved exams an honest yardstick. A lesson harvested from
  // a held-out failure teaches the brain the answer to the exam that measures it.
  assert.throws(
    () => buildHarvestQuestions({
      rubrics: [rubric(1, [{ tag: 'knowledge-gap', note: 'x' }])],
      examsByRunId: { 1: { examId: 'exam-0001', heldOut: true } },
    }),
    /is a HELD-OUT exam \(exam-0001\); harvest is refused before any question is asked/,
  );
});

test('clause 13: every answer carries a non-empty single-line concern, none answers included', () => {
  const { questions } = buildHarvestQuestions({
    rubrics: [rubric(1, [{ tag: 'knowledge-gap', note: 'nothing covers the wiring convention' }])],
    examsByRunId: EXAMS,
  });
  const answer = (patch) => answersToProposals([{ runId: 1, gapIndex: 0, kind: 'new-lesson', body: 'wire the seam first', ...patch }], questions, { documentIds: DOCUMENT_IDS, packetsByRunId: PACKETS });

  assert.equal(answer({ concern: 'wiring order' })[0].concern, 'wiring order');
  assert.throws(() => answer({ concern: '' }), /carries no concern/);
  assert.throws(() => answer({ concern: '   ' }), /carries no concern/);
  assert.throws(() => answer({ concern: 'two\nlines' }), /one line, so a round reads as a list/);

  // A `none` answer needs one too: without it, a none is indistinguishable from an
  // unanswered question, and six answers were rejected in one platform round for exactly this.
  assert.throws(
    () => answersToProposals([{ runId: 1, gapIndex: 0, kind: 'none' }], questions, { documentIds: DOCUMENT_IDS }),
    /a none answer needs one too/,
  );
  const none = answersToProposals([{ runId: 1, gapIndex: 0, kind: 'none', concern: 'the student had what it needed' }], questions, { documentIds: DOCUMENT_IDS });
  assert.equal(none[0].accepted, false);
  assert.equal(none[0].reason, 'teacher answered none');
});

test('clause 14: a targeted answer names a document that exists and was in the packet', () => {
  const { questions } = buildHarvestQuestions({
    rubrics: [rubric(1, [{ tag: 'retrieval-miss', note: 'the seam lesson was not retrieved', targetDocumentId: 'brain.sync-lesson' }])],
    examsByRunId: EXAMS,
  });
  const answer = (patch) => answersToProposals(
    [{ runId: 1, gapIndex: 0, kind: 'retrieval-fix', concern: 'retrieval', body: 'raise the budget', ...patch }],
    questions, { documentIds: DOCUMENT_IDS, packetsByRunId: PACKETS },
  );

  assert.equal(answer({ targetDocumentId: 'brain.sync-lesson' })[0].targetDocumentId, 'brain.sync-lesson');
  assert.throws(() => answer({}), /needs a targetDocumentId/);
  // Invented from memory: the document does not exist at all.
  assert.throws(() => answer({ targetDocumentId: 'brain.imagined' }), /which does not exist/);
  // Exists, but was not in THAT packet's retrieved or absent lists, so the answer is about a
  // document this run never had an opinion about.
  assert.throws(() => answer({ targetDocumentId: 'brain.architecture' }),
    /was not in that packet's retrieved or absent lists/);

  assert.deepEqual([...ANSWER_KINDS], ['new-lesson', 'retrieval-fix', 'sharpen-convention', 'none']);
  assert.throws(() => answer({ kind: 'vibes', targetDocumentId: 'brain.sync-lesson' }), /has kind "vibes"/);
});

test('answers are filed by (runId, gapIndex), and a round cannot be half answered', () => {
  const { questions } = buildHarvestQuestions({
    rubrics: [
      rubric(1, [{ tag: 'knowledge-gap', note: 'first gap' }]),
      rubric(2, [{ tag: 'knowledge-gap', note: 'second gap' }]),
    ],
    examsByRunId: EXAMS,
  });
  const good = [
    { runId: 1, gapIndex: 0, kind: 'new-lesson', concern: 'a', body: 'first lesson' },
    { runId: 2, gapIndex: 0, kind: 'new-lesson', concern: 'b', body: 'second lesson' },
  ];
  // Arrival order is irrelevant; the pair is filed by the ids it carries.
  assert.equal(answersToProposals([...good].reverse(), questions, { documentIds: DOCUMENT_IDS }).length, 2);
  assert.throws(() => answersToProposals([good[0], good[0]], questions, { documentIds: DOCUMENT_IDS }), /Two answers for gap 1:0/);
  assert.throws(() => answersToProposals([{ ...good[0], gapIndex: 9 }, good[1]], questions, { documentIds: DOCUMENT_IDS }),
    /which is not a gap in this round/);
  // A partially answered round would silently shrink the evidence a cycle produced.
  assert.throws(() => answersToProposals([good[0]], questions, { documentIds: DOCUMENT_IDS }),
    /1 gap question\(s\) went unanswered/);
});

test('clause 15: each curation gate fires on its own, and each can be shown to fire', async () => {
  const base = {
    runId: 1, examId: 'exam-0001', gapIndex: 0, kind: 'new-lesson',
    concern: 'wiring', body: 'wire the seam before deepening a component', citations: [],
  };

  // Every gate is exercised in isolation, because a gate that cannot fail is dead coverage.
  assert.match(CURATION_GATES.contradiction(
    { ...base, targetDocumentId: 'brain.x', stance: 'always' },
    { existingDocuments: [{ id: 'brain.x', stance: 'never' }] },
  ), /contradicts brain.x/);
  assert.equal(CURATION_GATES.contradiction(base, { existingDocuments: [] }), null);

  assert.match(CURATION_GATES.duplicate(base, {
    existingDocuments: [{ id: 'brain.dup', content: 'Wire the seam   before deepening a component' }],
  }), /duplicates brain.dup/);
  const twin = { ...base, runId: 2, gapIndex: 1 };
  assert.match(CURATION_GATES.duplicate(base, { batch: [base, twin] }), /duplicates the proposal for gap 2:1/);
  assert.equal(CURATION_GATES.duplicate(base, { existingDocuments: [], batch: [base] }), null);

  assert.match(CURATION_GATES.provenance({ ...base, runId: null }), /carries no provenance/);
  assert.equal(CURATION_GATES.provenance(base), null);

  assert.match(CURATION_GATES.oneConcern({ ...base, concern: 'wiring; budgets; retrieval' }), /more than one concern/);
  assert.equal(CURATION_GATES.oneConcern(base), null);

  // And through the curator, where a dropped proposal records WHY.
  const curated = await curateProposals([{ ...base, runId: null }]);
  assert.equal(curated[0].accepted, false);
  assert.match(curated[0].droppedFor, /provenance: carries no provenance/);
});

test('clause 16: the backstop validates citations against CURRENT code, path and line', async () => {
  const currentCode = { 'src/sync.js': 40 };
  const readFileLines = async (path) => currentCode[path] ?? null;

  assert.deepEqual(await validateCitationsAgainstCurrentCode({ citations: ['src/sync.js:12'] }, { readFileLines }), []);
  assert.deepEqual(await validateCitationsAgainstCurrentCode({ citations: ['src/gone.js:3'] }, { readFileLines }),
    ['src/gone.js no longer exists']);
  assert.deepEqual(await validateCitationsAgainstCurrentCode({ citations: ['src/sync.js:900'] }, { readFileLines }),
    ['src/sync.js:900 is past the end of the file (40 lines)']);
  assert.deepEqual(await validateCitationsAgainstCurrentCode({ citations: ['not-a-citation'] }, { readFileLines }),
    ['not-a-citation is not a path:line citation']);

  // Through the curator: a lesson citing code that has since been deleted is DROPPED, with
  // the reason recorded. This is the last thing standing between a stale gold and a brain
  // that believes it.
  const proposals = await curateProposals([
    { runId: 1, examId: 'exam-0001', gapIndex: 0, kind: 'new-lesson', concern: 'wiring', body: 'a', citations: ['src/sync.js:12'] },
    { runId: 2, examId: 'exam-0002', gapIndex: 0, kind: 'new-lesson', concern: 'wiring', body: 'b', citations: ['src/gone.js:3'] },
  ], { readFileLines });
  assert.equal(proposals[0].accepted, true);
  assert.equal(proposals[1].accepted, false);
  assert.match(proposals[1].droppedFor, /citation-validation: src\/gone.js no longer exists/);
});

test('clause 10 and 17: harvest proposes, apply teaches, and a measured zero is recorded', async () => {
  const proposals = await curateProposals([
    { runId: 1, examId: 'exam-0001', gapIndex: 0, kind: 'none', concern: 'the student had what it needed' },
  ]);
  const batch = harvestBatch({ cycleId: 4, mode: 'evaluation', proposals, at: '2026-08-16T00:00:00.000Z' });

  // A round where every gap was a model-limit accepts nothing, and the ZERO IS WRITTEN. A
  // missing record cannot tell "we accepted nothing" from "nobody ran harvest".
  assert.equal(batch.accepted, 0);
  assert.equal(batch.rejected, 1);
  assert.equal(batch.questionsAsked, 1);
  assert.equal(batch.applied, false, 'a batch says on its face that it taught nothing yet');

  // Applying is a SEPARATE act with a separate name, which is what the platform's seven
  // silent cycles are for: the harvest ran, the apply never did, and nothing said so.
  const written = [];
  const applied = await applyProposals(
    harvestBatch({
      cycleId: 4,
      mode: 'evaluation',
      proposals: await curateProposals([
        { runId: 1, examId: 'exam-0001', gapIndex: 0, kind: 'new-lesson', concern: 'wiring', body: 'wire the seam first', citations: [] },
      ]),
    }),
    { writeDocument: async (document) => { written.push(document); return `brain.new-${written.length}`; }, mode: 'evaluation' },
  );
  assert.equal(applied.applied, true);
  assert.equal(applied.written, 1);
  assert.deepEqual(applied.documents, ['brain.new-1']);
  assert.equal(written[0].provenance.runId, 1, 'every written document carries the run that produced it');

  await assert.rejects(applyProposals(applied, { writeDocument: async () => 'x', mode: 'evaluation' }),
    /already been applied/);
});

test('clause 21: a harvest batch from a non-evaluation cycle never teaches the brain', async () => {
  // Mode quarantine reaching the new surface: an experiment or a harness-debug cycle may be
  // graded and harvested for its own analysis, and it may not write to the brain.
  const batch = harvestBatch({
    cycleId: 9,
    mode: 'harness-debug',
    proposals: await curateProposals([
      { runId: 1, examId: 'exam-0001', gapIndex: 0, kind: 'new-lesson', concern: 'wiring', body: 'a lesson', citations: [] },
    ]),
  });
  assert.equal(batch.accepted, 1, 'the proposal is fine; the mode is what refuses');
  for (const mode of ['harness-debug', 'experiment']) {
    await assert.rejects(applyProposals(batch, { writeDocument: async () => 'x', mode }),
      new RegExp(`Refusing to apply a harvest batch from mode ${mode}`));
  }
});

test('HarvestRefused carries the run, the gap and the field', () => {
  try {
    answersToProposals([{ runId: 1, gapIndex: 0, kind: 'new-lesson', body: 'x' }], [{ runId: 1, gapIndex: 0 }], { documentIds: [] });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof HarvestRefused);
    assert.equal(error.runId, 1);
    assert.equal(error.gapIndex, 0);
    assert.equal(error.field, 'concern');
  }
});
