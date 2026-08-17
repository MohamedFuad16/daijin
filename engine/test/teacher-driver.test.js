// The inline teacher: rubric authored by the teacher role, bound by the
// driver, refused by grading.js exactly like an external batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGradingPacket, digestOf, RubricRefused } from '../src/gym/grading.js';
import { gradeAttemptWithTeacher, parseTeacherReply, teacherPrompt } from '../src/gym/teacher-driver.js';
import { agentIdentity } from '../src/gym/exams.js';

const DIFF = 'diff --git a/stack.js b/stack.js\nindex 1..2 100644\n--- a/stack.js\n+++ b/stack.js\n@@ -1 +1,2 @@\n+export function isEmpty() {}\n';

function fixture() {
  const exam = {
    examId: 'exam-0001',
    task: 'Expose an emptiness check on the stack API so callers can ask without reading size.',
    // The STORED shape: parseExamRecord normalizes authoredBy through
    // agentIdentity at mine time, so independence compares keys, not raw
    // fields. A fixture with the raw object would never trip the check.
    provenance: { source: 'auditor-selection', authoredBy: agentIdentity({ role: 'auditor', model: 'claude-fable-5', endpoint: 'default' }) },
  };
  const artifact = {
    exam: { id: 'exam-0001', task: exam.task },
    mode: 'experiment',
    status: 'completed',
    apply: { applied: true },
    student: { diff: DIFF },
    provenance: { shownDocumentIds: ['brain.conventions'], goldExclusion: { ids: [] } },
    candidate: [{ id: 'test', classification: 'clean', status: 'pass' }],
    resultFile: '/tmp/result.json',
  };
  const packet = buildGradingPacket({ artifact, exam });
  return { exam, artifact, packet };
}

function goodReply() {
  const axes = {};
  for (const axis of ['correctness_vs_gold', 'convention_adherence', 'decision_awareness', 'reasoning_quality', 'blast_radius_awareness']) {
    axes[axis] = { score: 4, citations: ['stack.js:2'] };
  }
  return JSON.stringify({ verdict: 'pass', axes, gaps: [] });
}

test('the prompt carries the task, the diff, the shown ids and the citation rules, never the gold', () => {
  const { exam, packet } = fixture();
  const prompt = teacherPrompt({ packet, exam, diff: DIFF, candidate: [] });
  assert.match(prompt, /emptiness check/);
  assert.match(prompt, /isEmpty/);
  assert.match(prompt, /brain\.conventions/);
  assert.match(prompt, /STRICT JSON/);
  assert.doesNotMatch(prompt, /goldCommit|gold commit/i, 'the teacher never reads the reference');
});

test('a valid teacher reply becomes a stored-ready rubric, bound and author-stamped by the driver', async () => {
  const { exam, packet } = fixture();
  const rubric = await gradeAttemptWithTeacher({
    runId: 7, packet, exam, diff: DIFF, candidate: [],
    generate: async () => ({ text: goodReply(), tokens: 500 }),
    grader: { role: 'teacher', model: 'claude-opus-5', endpoint: 'default' },
  });
  assert.equal(rubric.runId, 7);
  assert.equal(rubric.verdict, 'pass');
  assert.equal(rubric.taskDigest, digestOf(exam.task), 'the DRIVER binds the digests, never the model');
  assert.match(rubric.author, /claude-opus-5/);
});

test('an invented citation from the teacher is refused, exactly like an external batch', async () => {
  const { exam, packet } = fixture();
  const axes = JSON.parse(goodReply()).axes;
  axes.correctness_vs_gold.citations = ['secret-notes.md:3'];
  await assert.rejects(
    () => gradeAttemptWithTeacher({
      runId: 7, packet, exam, diff: DIFF, candidate: [],
      generate: async () => ({ text: JSON.stringify({ verdict: 'pass', axes, gaps: [] }) }),
      grader: { role: 'teacher', model: 'claude-opus-5' },
    }),
    (error) => error instanceof RubricRefused && /never touched/.test(error.message),
  );
});

test('grader independence holds: the exam author cannot grade its own exam', async () => {
  const { exam, packet } = fixture();
  await assert.rejects(
    () => gradeAttemptWithTeacher({
      runId: 7, packet, exam, diff: DIFF, candidate: [],
      generate: async () => ({ text: goodReply() }),
      grader: { role: 'teacher', model: 'claude-fable-5', endpoint: 'default' },
    }),
    (error) => error instanceof RubricRefused,
  );
});

test('the reply parser tolerates fences and prose wrapping, never repairs', () => {
  assert.equal(parseTeacherReply('```json\n{"verdict":"pass"}\n```').verdict, 'pass');
  assert.equal(parseTeacherReply('Here you go: {"verdict":"fail"} regards').verdict, 'fail');
  assert.throws(() => parseTeacherReply('no json at all'), /not JSON/);
});
