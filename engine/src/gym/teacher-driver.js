// The live teacher: one rubric per graded attempt, from the teacher role the
// owner configured, validated by grading.js before anything is stored.
//
// The division of labour is the whole design. The TEACHER judges: five axis
// scores with citations, a verdict, gap tags. The DRIVER binds: runId and
// both digests come from the packet, never from the model, because a teacher
// cannot compute a sha256 and asking it to would only manufacture refusals.
// The binding digests exist to stop a rubric grading the wrong attempt in
// BATCH import; an inline teacher is handed exactly one packet, so copying
// them is what binding means here. Everything the teacher CLAIMS - scores,
// citations, gaps, verdict - still walks through validateRubric's full
// refusal list, where an invented citation or a withheld-document reference
// dies exactly as it would from an external batch.
//
// The teacher reads the diff and the task; it does NOT read the gold commit.
// Grader independence from the exam's author is checked by validateRubric
// (P7 clause 4) against the exam's recorded provenance.

import { AXES, GAP_TAGS, VERDICTS, validateRubric } from './grading.js';

const AXIS_MEANINGS = {
  correctness_vs_gold: 'Does the change achieve the task outcome (judged from the task statement and the diff, never from a reference you were shown)?',
  convention_adherence: 'Does the change follow the conventions visible in the code it touches?',
  decision_awareness: 'Does the change respect constraints and decisions the shown context establishes?',
  reasoning_quality: 'Is the approach coherent: minimal, purposeful edits rather than thrash?',
  blast_radius_awareness: 'Does the change stay inside a sensible footprint for the task?',
};

export function teacherPrompt({ packet, exam, diff, candidate }) {
  const gateLines = (candidate || []).map((gate) => `- ${gate.id}: ${gate.classification ?? gate.status}`);
  return [
    'You are grading ONE submission to a coding exam. Judge only what is in front of you.',
    '',
    `TASK the student was given:\n${exam.task}`,
    '',
    `GATE RESULTS after applying the submission:\n${gateLines.join('\n') || '- none run'}`,
    '',
    `DOCUMENTS the student was shown (the ONLY document ids you may cite): ${packet.shownDocumentIds.join(', ') || '(none)'}`,
    '',
    `THE SUBMISSION DIFF:\n${diff}`,
    '',
    'Score the five axes, each 1 to 5, each with at least one citation. A citation is either',
    'path:line pointing INTO THE DIFF above (only files the diff touches are citable), or one',
    'of the shown document ids. Never cite anything else.',
    ...AXES.map((axis) => `- ${axis}: ${AXIS_MEANINGS[axis]}`),
    '',
    `Verdict: one of ${VERDICTS.filter((verdict) => verdict !== 'unsubmitted').join(', ')}.`,
    `Gaps (optional): tag one of ${GAP_TAGS.join(', ')}, each with a note; a retrieval-miss`,
    'additionally names targetDocumentId (a document that EXISTS but was not shown).',
    '',
    'Reply with STRICT JSON only, no prose, no fences, exactly:',
    '{"verdict": "pass|partial|fail",',
    ' "axes": {"correctness_vs_gold": {"score": 1, "citations": ["path:12"]}, ...all five...},',
    ' "gaps": []}',
  ].join('\n');
}

export function parseTeacherReply(text) {
  const stripped = String(text || '').trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The teacher reply is not JSON and contains no object literal.');
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

/**
 * Grade one attempt. Returns the VALIDATED rubric (grading.js has already
 * capped the verdict and stamped the author) ready for importRubricBatch.
 */
export async function gradeAttemptWithTeacher({ runId, packet, exam, diff, candidate, generate, grader }) {
  const { text } = await generate({
    prompt: teacherPrompt({ packet, exam, diff, candidate }),
    maxTokens: 16_384,
  });
  const proposed = parseTeacherReply(text);
  const rubric = {
    runId,
    // Bound by the DRIVER from the packet: see the module comment.
    taskDigest: packet.taskDigest,
    submissionDigest: packet.submissionDigest,
    verdict: proposed.verdict,
    axes: proposed.axes,
    gaps: proposed.gaps ?? [],
  };
  return validateRubric(rubric, packet, { grader, exam });
}
