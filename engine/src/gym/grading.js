// Grading and rubric import, P7 clauses 1 through 9 (registered at 1cdc2b8).
//
// Lineage: platform grade.js, grade-export.js, grade-import.js and TEACHER.md. The platform's
// refusal list is not a style guide; it is the compressed record of what went wrong, and each
// refusal below names the incident that bought it.
//
// The shape of this module is refusal-first on purpose. Grading is where a measurement becomes
// a number, and every one of these rules exists because a number once came out wrong in a way
// nobody noticed until an audit: a rubric graded the wrong attempt, a citation pointed at a
// file the student never touched, a grader graded its own exam, a cycle counted five results
// when four had been produced.
//
// The teacher is INJECTED. Nothing here calls a provider; a rubric arrives as data and is
// accepted or refused on its contents.

import { createHash } from 'node:crypto';

import { graderIndependenceRefusal, agentIdentity } from './exams.js';

/** The five fixed axes. Fixed because a grader that can choose its axes can choose the ones
 *  its answer scores well on. */
export const AXES = Object.freeze([
  'correctness_vs_gold',
  'convention_adherence',
  'decision_awareness',
  'reasoning_quality',
  'blast_radius_awareness',
]);

/** Verdicts a rubric may carry. `unsubmitted` is not a grade: it records that the student
 *  never answered, and so cannot have answered badly. */
export const VERDICTS = Object.freeze(['pass', 'partial', 'fail', 'unsubmitted']);

/** Gap tags. The last three are MEASURED and produce no brain write, which is what keeps
 *  harvest from inventing lessons for failures that had nothing to teach. */
export const GAP_TAGS = Object.freeze(['retrieval-miss', 'model-limit', 'knowledge-gap', 'harness-defect', 'stale-gold']);
export const NO_WRITE_TAGS = Object.freeze(['model-limit', 'harness-defect', 'stale-gold']);

export function digestOf(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export class RubricRefused extends Error {
  constructor(message, { runId = null, field = null } = {}) {
    super(message);
    this.name = 'RubricRefused';
    this.runId = runId;
    this.field = field;
  }
}

/** Files the submission diff actually touched, read from the diff rather than from anything
 *  the teacher says. A citation is checked against THIS, so an invented path cannot pass by
 *  being plausible. */
export function citableFilesFromDiff(diff) {
  const files = new Set();
  for (const match of String(diff || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.add(match[2]);
  }
  return [...files].sort();
}

/**
 * The packet: everything a rubric is checked against, derived from the run artifact.
 *
 * Derived rather than supplied, because a packet the teacher hands back could be shaped to
 * fit the rubric. The digests bind the rubric to one attempt of one task.
 */
export function buildGradingPacket({ artifact, exam }) {
  if (!artifact?.exam?.id) throw new Error('A grading packet needs a run artifact.');
  const diff = artifact.student?.diff ?? '';
  const shown = artifact.provenance?.shownDocumentIds ?? [];
  const excluded = artifact.provenance?.goldExclusion?.ids ?? [];
  return {
    examId: artifact.exam.id,
    mode: artifact.mode,
    status: artifact.status,
    applied: Boolean(artifact.apply?.applied),
    taskDigest: digestOf(artifact.exam.task ?? exam?.task ?? ''),
    submissionDigest: digestOf(diff),
    citableFiles: citableFilesFromDiff(diff),
    shownDocumentIds: [...shown],
    // Withheld from the student and therefore NOT citable by the teacher either: a rubric
    // citing a document the student was denied would be grading against the gold.
    excludedDocumentIds: [...excluded],
    candidate: artifact.candidate ?? [],
    resultFile: artifact.resultFile ?? null,
  };
}

/**
 * The mechanical CAP on a verdict (clause 5).
 *
 * The teacher proposes a verdict; these rules bound it. A run whose only gate damage is a
 * measured-metric regression caps at `partial`, because exp4's exam-0015 compiled clean on
 * every raw gate and was labelled as though it had failed to build. A run with no applied
 * diff is `unsubmitted` outright, because there is nothing to grade.
 */
export function capVerdict(proposed, packet) {
  if (!VERDICTS.includes(proposed)) throw new RubricRefused(`Unknown verdict: ${proposed}`, { field: 'verdict' });
  if (!packet.applied) return 'unsubmitted';
  const regressions = (packet.candidate || []).filter((gate) => gate.classification === 'regressed');
  const metricOnly = regressions.length > 0 && regressions.every((gate) => gate.metric && gate.status === 'pass');
  if (metricOnly && proposed === 'fail') return 'partial';
  return proposed;
}

function assertCitation(citation, packet, axis) {
  const text = String(citation || '').trim();
  if (!text) throw new RubricRefused(`Axis ${axis} carries an empty citation.`, { field: axis });
  // A brain document id, which must be one the student was actually shown.
  if (!text.includes(':') || /^[a-z0-9][\w.-]*$/i.test(text)) {
    if (packet.shownDocumentIds.includes(text)) return;
    if (packet.excludedDocumentIds.includes(text)) {
      throw new RubricRefused(
        `Axis ${axis} cites ${text}, which was WITHHELD from the student by the gold-provenance exclusion; `
        + 'grading against a document the student was denied is grading against the gold.',
        { field: axis },
      );
    }
    throw new RubricRefused(`Axis ${axis} cites ${text}, which the student was never shown.`, { field: axis });
  }
  const match = text.match(/^(.+):(\d+)$/);
  if (!match) throw new RubricRefused(`Axis ${axis} citation ${text} is neither path:line nor a document id.`, { field: axis });
  const [, path, line] = match;
  if (!packet.citableFiles.includes(path)) {
    throw new RubricRefused(
      `Axis ${axis} cites ${path}, which the submission diff never touched. Citable files: ${packet.citableFiles.join(', ') || '(none)'}.`,
      { field: axis },
    );
  }
  if (Number(line) < 1) throw new RubricRefused(`Axis ${axis} citation ${text} has no real line number.`, { field: axis });
}

/**
 * Validate one rubric against its packet. Throws RubricRefused, naming the field.
 *
 * Clause order matters for the message a person reads: identity and binding first (this
 * rubric is not about this run at all), then structure, then contents.
 */
export function validateRubric(rubric, packet, { grader, exam } = {}) {
  if (!rubric || typeof rubric !== 'object') throw new RubricRefused('A rubric must be an object.');
  const runId = rubric.runId ?? null;

  // Clause 5: a run with no applied diff has nothing to cite and gets NO rubric at all.
  if (!packet.applied) {
    throw new RubricRefused(
      `Run ${runId} produced no applied diff and is unsubmitted; no rubric may be written for it. `
      + 'There is no submission to cite, and counting it as a failure overstates both the spend and the failure rate.',
      { runId, field: 'verdict' },
    );
  }

  // Clause 4: author-grader independence, checked before anything else is read, because a
  // rubric from the wrong grader is void whatever it says.
  if (exam && grader) {
    const refusal = graderIndependenceRefusal(exam, grader);
    if (refusal) throw new RubricRefused(refusal, { runId, field: 'author' });
  }

  // Clause 3: bound to BOTH digests. Re-running an exam produces identical task text and a
  // different diff, so a task-only binding lets one attempt's rubric grade another.
  if (rubric.taskDigest !== packet.taskDigest) {
    throw new RubricRefused(`Rubric for ${runId} carries a task digest that does not match the run; the task was reworded.`, { runId, field: 'taskDigest' });
  }
  if (rubric.submissionDigest !== packet.submissionDigest) {
    throw new RubricRefused(
      `Rubric for ${runId} carries a submission digest that does not match the run; this rubric grades a different attempt.`,
      { runId, field: 'submissionDigest' },
    );
  }

  // Clause 1: five axes, each 1 to 5, each cited.
  const axes = rubric.axes ?? {};
  for (const axis of AXES) {
    const entry = axes[axis];
    if (!entry) throw new RubricRefused(`Rubric for ${runId} is missing axis ${axis}.`, { runId, field: axis });
    const score = entry.score;
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new RubricRefused(`Axis ${axis} scores ${score}, outside 1 to 5.`, { runId, field: axis });
    }
    const citations = Array.isArray(entry.citations) ? entry.citations : [];
    if (citations.length === 0) throw new RubricRefused(`Axis ${axis} carries no citation.`, { runId, field: axis });
    for (const citation of citations) assertCitation(citation, packet, axis);
  }
  const unknown = Object.keys(axes).filter((axis) => !AXES.includes(axis));
  if (unknown.length) throw new RubricRefused(`Rubric for ${runId} carries unknown axes: ${unknown.join(', ')}.`, { runId, field: 'axes' });

  // Gaps: the only field the learning loop reads. The tag decides whether harvest asks a
  // question at all, so an unknown tag cannot be stored.
  for (const [index, gap] of (rubric.gaps ?? []).entries()) {
    if (!GAP_TAGS.includes(gap?.tag)) {
      throw new RubricRefused(`Gap ${index} on run ${runId} has tag ${JSON.stringify(gap?.tag ?? null)}.`, { runId, field: `gaps[${index}]` });
    }
    if (!String(gap.note || '').trim()) {
      throw new RubricRefused(`Gap ${index} on run ${runId} has no note; a gap with no statement teaches nothing.`, { runId, field: `gaps[${index}]` });
    }
    // A retrieval-miss names a document that EXISTS and was NOT shown; that is what the tag
    // means, and the platform's importer refuses the alternative.
    if (gap.tag === 'retrieval-miss') {
      if (!gap.targetDocumentId) {
        throw new RubricRefused(`Gap ${index} is a retrieval-miss without a targetDocumentId.`, { runId, field: `gaps[${index}]` });
      }
      if (packet.shownDocumentIds.includes(gap.targetDocumentId)) {
        throw new RubricRefused(
          `Gap ${index} tags ${gap.targetDocumentId} as a retrieval-miss, but the student WAS shown it; that is a model-limit.`,
          { runId, field: `gaps[${index}]` },
        );
      }
    }
  }

  // A sub-passing verdict must be ATTRIBUTED: at least one gap saying what went wrong.
  // This is the platform's cycle 32 verbatim - empty gaps on failed exams, teaching
  // nothing while looking complete. Attribution never forces invention: model-limit and
  // harness-defect are measured and write nothing to the brain. The check reads the
  // verdict the teacher AUTHORED, not the capped one below - a partial manufactured by
  // the metric-regression cap carries the cap itself as its reason, and the teacher
  // cannot be refused for a mechanical downgrade it never saw.
  if (rubric.verdict !== 'pass' && (rubric.gaps ?? []).length === 0) {
    throw new RubricRefused(
      `Run ${runId} is graded ${rubric.verdict} with no gap recorded; a sub-passing verdict with empty gaps teaches nothing while looking complete.`,
      { runId, field: 'gaps' },
    );
  }

  return {
    ...rubric,
    verdict: capVerdict(rubric.verdict, packet),
    // Clause 6: canonical author, differing self-report PRESERVED rather than overwritten.
    ...(grader ? stampAuthor(rubric, grader) : {}),
  };
}

/**
 * Canonical author stamping (clause 6).
 *
 * The author is the CONFIGURED identity, taken from the same settings surface the daemon
 * serves (settingsGet().roles). A differing self-report is kept as `reportedAuthor` rather
 * than destroyed: the platform filed three cycles of rubrics under "Codex teacher" while the
 * batches said "openai/gpt-5.6-sol", one grader split across two names, and the disagreement
 * was the evidence that something was misconfigured.
 */
export function stampAuthor(rubric, grader) {
  const identity = agentIdentity(grader);
  const reported = typeof rubric.author === 'string' ? rubric.author.trim() : null;
  return {
    author: identity.key,
    authorRole: identity.role,
    ...(reported && reported !== identity.key ? { reportedAuthor: reported } : {}),
  };
}

/**
 * Import a batch of rubrics.
 *
 * FILED BY (runId, index), NEVER BY ARRIVAL ORDER (clause 7). A transposed pair is refused
 * rather than attached to the wrong run, which is a silent corruption the platform hit and
 * fixed the same way.
 *
 * ALL OR NOTHING (clause 9). Every rubric is validated before any is written, and the writer
 * is called once with the whole set, so a refused batch leaves the store exactly as it was.
 * Partial application of a bad batch is worse than rejecting it, because half a graded cohort
 * looks like a graded cohort.
 */
export function importRubrics(batch, packetsByRunId, { grader, examsByRunId = {} } = {}) {
  if (!Array.isArray(batch)) throw new RubricRefused('A rubric batch must be an array.');
  const seen = new Set();
  const accepted = [];
  for (const rubric of batch) {
    const runId = rubric?.runId ?? null;
    if (runId === null || runId === undefined) throw new RubricRefused('Every rubric names the run it grades.', { field: 'runId' });
    if (seen.has(runId)) throw new RubricRefused(`Batch carries two rubrics for run ${runId}.`, { runId, field: 'runId' });
    seen.add(runId);
    const packet = packetsByRunId[runId];
    if (!packet) throw new RubricRefused(`Batch carries a rubric for run ${runId}, which is not in this round.`, { runId, field: 'runId' });
    accepted.push(validateRubric(rubric, packet, { grader, exam: examsByRunId[runId] }));
  }
  return accepted;
}

/**
 * A cycle's grade summary (clause 5).
 *
 * The pass rate counts ONLY the runs that produced a diff, and the drawn count travels beside
 * it. A cycle of five that graded four is a four-exam cycle; reporting it as five with one
 * failure overstates both the spend and the failure rate, and the platform did exactly that
 * for sixteen historical rows before they were reclassified.
 */
export function cycleGradeSummary({ rubrics, drawn }) {
  const graded = rubrics.filter((rubric) => rubric.verdict !== 'unsubmitted');
  const counts = { pass: 0, partial: 0, fail: 0 };
  for (const rubric of graded) counts[rubric.verdict] += 1;
  return {
    drawn: drawn ?? null,
    graded: graded.length,
    unsubmitted: rubrics.length - graded.length,
    counts,
    // Exact rationals, never a rounded display: the denominator is stated so a reader can
    // recompute, and it is null rather than a guess when the drawn cohort is not derivable.
    usefulRate: graded.length === 0 ? null : (counts.pass + counts.partial) / graded.length,
    cohortUsefulRate: drawn ? (counts.pass + counts.partial) / drawn : null,
    denominator: { gradedBasis: graded.length, drawnBasis: drawn ?? null },
  };
}
