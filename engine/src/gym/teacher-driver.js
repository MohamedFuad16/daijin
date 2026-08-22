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
    `Gaps: tag one of ${GAP_TAGS.join(', ')}, each with a note; a retrieval-miss`,
    'additionally names targetDocumentId (a document that EXISTS but was not shown).',
    'A pass may have empty gaps. Any other verdict MUST record at least one gap saying what',
    'went wrong: use knowledge-gap or retrieval-miss when missing knowledge caused it,',
    'model-limit when the student had what it needed and still failed, harness-defect when',
    'the harness broke. A sub-pass verdict with empty gaps is refused.',
    '',
    'Reply with STRICT JSON only, no prose, no fences, exactly:',
    '{"verdict": "pass|partial|fail",',
    ' "axes": {"correctness_vs_gold": {"score": 1, "citations": ["path:12"]}, ...all five...},',
    // The gap shape is SHOWN, not described: the first live run that needed a gap wrote
    // one with no tag, was refused for it, and left the attempt ungraded - the prose
    // above was read, the template below is what got copied.
    ` "gaps": [{"tag": "${GAP_TAGS.join('|')}", "note": "<one line>", "targetDocumentId": null}]}`,
    'gaps is [] only when there is nothing to record; every gap entry MUST carry a tag from the list above.',
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
 * The harvest round: one question per gap, answered by the teacher in one
 * generation, validated by harvest.js before anything becomes a proposal.
 *
 * The same division of labour as grading: the TEACHER answers (a kind, a
 * one-line concern, a body, citations); the DRIVER binds each answer to the
 * (runId, gapIndex) of the question it answers, and answersToProposals
 * refuses a transposed pair, an invented document id, or an unanswered
 * question exactly as it would from an external batch.
 */
export function harvestPrompt({ questions, packetsByRunId = {} }) {
  const blocks = questions.map((question, index) => {
    const packet = packetsByRunId[question.runId];
    const citable = packet
      ? [...new Set([...(packet.shownDocumentIds || []), ...(packet.absentDocumentIds || [])])]
      : [];
    return [
      `GAP ${index + 1} (runId ${question.runId}, gapIndex ${question.gapIndex}, exam ${question.examId}, tag ${question.tag}):`,
      `  what went wrong: ${question.gap}`,
      question.targetDocumentId ? `  the grader pointed at document: ${question.targetDocumentId}` : '',
      `  document ids you may name for this gap: ${citable.join(', ') || '(none)'}`,
    ].filter(Boolean).join('\n');
  });
  return [
    'You are the teacher closing the learning loop after graded coding-exam attempts.',
    'For EACH gap below, answer the question: what knowledge, had it been retrieved, would',
    'have prevented this failure?',
    '',
    ...blocks,
    '',
    'Answer kinds:',
    '- "new-lesson": a durable lesson the project brain should carry. body is the lesson',
    '  (two to five sentences, written to be retrieved later). citations are "path:line"',
    '  references into the repo\'s CURRENT files when you can give them, else [].',
    '- "retrieval-fix": an EXISTING document (one of the ids listed for that gap) held the',
    '  answer and was not retrieved. Set targetDocumentId to that id; body says what should',
    '  have surfaced.',
    '- "sharpen-convention": an existing document (one of the listed ids) is right but too',
    '  vague to prevent this. Set targetDocumentId; body is the sharpened wording.',
    '- "none": nothing worth teaching. Still give the concern.',
    '',
    'EVERY answer carries "concern": ONE line naming the single concern it addresses.',
    'One concern per answer; an answer about three things is retrieved for none of them.',
    '',
    'Reply with STRICT JSON only, no prose, no fences: an ARRAY with one entry per gap,',
    '[{"runId": <number>, "gapIndex": <number>, "kind": "new-lesson|retrieval-fix|sharpen-convention|none",',
    '  "concern": "<one line>", "body": "<text, empty for none>",',
    '  "targetDocumentId": null, "citations": []}]',
  ].join('\n');
}

export function parseHarvestReply(text) {
  const stripped = String(text || '').trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch {
    const start = stripped.indexOf('[');
    const end = stripped.lastIndexOf(']');
    if (start === -1 || end <= start) throw new Error('The harvest reply is not JSON and contains no array literal.');
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(parsed)) throw new Error('The harvest reply parsed to something other than an array.');
    return parsed;
  }
}

/** Ask the teacher every gap question in one generation. Returns RAW answers;
 *  answersToProposals is the boundary that accepts or refuses them. */
export async function harvestAnswersWithTeacher({ questions, packetsByRunId, generate }) {
  const { text } = await generate({
    prompt: harvestPrompt({ questions, packetsByRunId }),
    maxTokens: 16_384,
  });
  return parseHarvestReply(text);
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
