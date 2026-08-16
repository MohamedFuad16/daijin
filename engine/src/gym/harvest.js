// Harvest: the only step that puts anything back into the brain. P7 clauses 10 through 17.
//
// Lineage: platform harvest.js, harvest-import.js, harvest-offline.js, curate.js,
// apply-proposals.js, and TEACHER.md's section titled "Harvesting, the step that teaches".
//
// The platform's record is the argument for every rule below. Cycle 29 is the last one that
// completed a harvest and applied it; cycles 30 and 32 through 37 harvested or skipped and
// then never applied, so seven cycles of graded evidence taught the project nothing. Grading
// measures the student. This is the only step that changes anything.
//
// The shape that prevents the failure: harvest is PROPOSAL-ONLY and apply is a separate act
// with a different name in a different function, so "we harvested" can never be mistaken for
// "the brain learned something". A round that accepts zero proposals is a measured zero and
// is recorded as one.

import { NO_WRITE_TAGS } from './grading.js';

/** Answer kinds a teacher may give to a gap question. */
export const ANSWER_KINDS = Object.freeze(['new-lesson', 'retrieval-fix', 'sharpen-convention', 'none']);

/** Kinds that must name an existing document, because they claim something about one. */
export const TARGETED_KINDS = Object.freeze(['retrieval-fix', 'sharpen-convention']);

export class HarvestRefused extends Error {
  constructor(message, { runId = null, gapIndex = null, field = null } = {}) {
    super(message);
    this.name = 'HarvestRefused';
    this.runId = runId;
    this.gapIndex = gapIndex;
    this.field = field;
  }
}

/**
 * Build the question set for a graded round (clauses 11 and 12).
 *
 * One question per gap, and THE TAG DECIDES whether a question is asked at all: a
 * `model-limit`, `harness-defect` or `stale-gold` gap is measured and produces no brain
 * write, because the student had what it needed and ignored it, or the harness broke, or the
 * reference itself was stale. Inventing a lesson for those pollutes the brain rather than
 * growing it.
 *
 * Held-out runs are refused BEFORE any question is asked. That boundary is what keeps the
 * reserved exams an honest yardstick: a lesson harvested from a held-out failure teaches the
 * brain the answer to the exam that was supposed to measure it.
 */
export function buildHarvestQuestions({ rubrics, examsByRunId }) {
  const questions = [];
  const skipped = [];
  for (const rubric of rubrics) {
    const exam = examsByRunId[rubric.runId];
    if (exam?.heldOut) {
      throw new HarvestRefused(
        `Run ${rubric.runId} is a HELD-OUT exam (${exam.examId}); harvest is refused before any question is asked. `
        + 'A lesson harvested from a held-out failure teaches the brain the answer to the exam that measures it.',
        { runId: rubric.runId, field: 'heldOut' },
      );
    }
    for (const [gapIndex, gap] of (rubric.gaps ?? []).entries()) {
      if (NO_WRITE_TAGS.includes(gap.tag)) {
        skipped.push({ runId: rubric.runId, gapIndex, tag: gap.tag, reason: 'tag produces no brain write' });
        continue;
      }
      questions.push({
        runId: rubric.runId,
        gapIndex,
        examId: rubric.examId,
        tag: gap.tag,
        gap: gap.note,
        targetDocumentId: gap.targetDocumentId ?? null,
        question: 'What knowledge, had it been retrieved, would have prevented this?',
      });
    }
  }
  return { questions, skipped };
}

/**
 * Validate the teacher's answers and turn them into PROPOSALS (clauses 10, 13, 14).
 *
 * Answers are filed by the `(runId, gapIndex)` they carry, never by arrival order, so a
 * transposed pair is refused rather than attached to the wrong gap.
 *
 * Nothing here writes a brain document. It returns a batch.
 */
export function answersToProposals(answers, questions, { documentIds = [], packetsByRunId = {} } = {}) {
  if (!Array.isArray(answers)) throw new HarvestRefused('A harvest answer set must be an array.');
  const index = new Map(questions.map((question) => [`${question.runId}:${question.gapIndex}`, question]));
  const seen = new Set();
  const proposals = [];

  for (const answer of answers) {
    const key = `${answer?.runId}:${answer?.gapIndex}`;
    const question = index.get(key);
    if (!question) {
      throw new HarvestRefused(
        `An answer names (${answer?.runId}, ${answer?.gapIndex}), which is not a gap in this round.`,
        { runId: answer?.runId ?? null, gapIndex: answer?.gapIndex ?? null, field: 'runId' },
      );
    }
    if (seen.has(key)) throw new HarvestRefused(`Two answers for gap ${key}.`, { runId: answer.runId, gapIndex: answer.gapIndex });
    seen.add(key);

    if (!ANSWER_KINDS.includes(answer.kind)) {
      throw new HarvestRefused(`Answer for ${key} has kind ${JSON.stringify(answer.kind ?? null)}.`, { runId: answer.runId, gapIndex: answer.gapIndex, field: 'kind' });
    }

    // Clause 13: EVERY answer carries a non-empty, single-line concern, INCLUDING `none`.
    // Six answers were rejected in one platform round for empty concerns. A `none` with no
    // concern is indistinguishable from an unanswered question.
    const concern = String(answer.concern ?? '').trim();
    if (!concern) {
      throw new HarvestRefused(`Answer for ${key} carries no concern; a none answer needs one too.`, { runId: answer.runId, gapIndex: answer.gapIndex, field: 'concern' });
    }
    if (concern.includes('\n')) {
      throw new HarvestRefused(`Answer for ${key} has a multi-line concern; one line, so a round reads as a list.`, { runId: answer.runId, gapIndex: answer.gapIndex, field: 'concern' });
    }

    if (answer.kind === 'none') {
      proposals.push({ ...question, kind: 'none', concern, accepted: false, reason: 'teacher answered none' });
      continue;
    }

    // Clause 14: a kind that claims something ABOUT a document must name one that exists,
    // and every cited id must have appeared in that packet's retrieved or absent lists. An
    // id recalled from memory is refused, because a proposal pointing at nothing writes a
    // lesson nobody can check.
    if (TARGETED_KINDS.includes(answer.kind)) {
      const target = answer.targetDocumentId;
      if (!target) {
        throw new HarvestRefused(`A ${answer.kind} answer for ${key} needs a targetDocumentId.`, { runId: answer.runId, gapIndex: answer.gapIndex, field: 'targetDocumentId' });
      }
      if (!documentIds.includes(target)) {
        throw new HarvestRefused(`A ${answer.kind} answer for ${key} names ${target}, which does not exist.`, { runId: answer.runId, gapIndex: answer.gapIndex, field: 'targetDocumentId' });
      }
      const packet = packetsByRunId[answer.runId];
      const listed = packet ? [...(packet.shownDocumentIds || []), ...(packet.absentDocumentIds || [])] : null;
      if (listed && !listed.includes(target)) {
        throw new HarvestRefused(
          `A ${answer.kind} answer for ${key} names ${target}, which was not in that packet's retrieved or absent lists.`,
          { runId: answer.runId, gapIndex: answer.gapIndex, field: 'targetDocumentId' },
        );
      }
    }

    const body = String(answer.body ?? '').trim();
    if (!body) throw new HarvestRefused(`Answer for ${key} has no body to propose.`, { runId: answer.runId, gapIndex: answer.gapIndex, field: 'body' });

    proposals.push({
      ...question,
      kind: answer.kind,
      concern,
      body,
      targetDocumentId: answer.targetDocumentId ?? null,
      citations: Array.isArray(answer.citations) ? [...answer.citations] : [],
      accepted: false,
    });
  }

  const unanswered = questions.filter((question) => !seen.has(`${question.runId}:${question.gapIndex}`));
  if (unanswered.length) {
    throw new HarvestRefused(
      `${unanswered.length} gap question(s) went unanswered: ${unanswered.map((q) => `${q.runId}:${q.gapIndex}`).join(', ')}. `
      + 'A partially answered round would silently shrink the evidence a cycle produced.',
      { field: 'answers' },
    );
  }
  return proposals;
}

/**
 * The curation gates (clause 15). Each returns a reason to drop, or null to keep, and each is
 * separately testable so none of them can quietly stop firing.
 */
export const CURATION_GATES = Object.freeze({
  /** A proposal that contradicts an existing document is a decision, not a lesson, and it
   *  goes to a person rather than into the brain behind one. */
  contradiction: (proposal, context) => {
    const contradicted = (context.existingDocuments || []).find((document) => (
      proposal.targetDocumentId && document.id === proposal.targetDocumentId
      && document.stance && proposal.stance && document.stance !== proposal.stance
    ));
    return contradicted ? `contradicts ${contradicted.id}` : null;
  },
  /** The same lesson proposed twice teaches nothing twice and inflates the growth number. */
  duplicate: (proposal, context) => {
    const normalized = proposal.body.replace(/\s+/g, ' ').trim().toLowerCase();
    const existing = (context.existingDocuments || []).find((document) => (
      String(document.content || '').replace(/\s+/g, ' ').trim().toLowerCase() === normalized
    ));
    if (existing) return `duplicates ${existing.id}`;
    const twin = (context.batch || []).find((other) => (
      other !== proposal && String(other.body || '').replace(/\s+/g, ' ').trim().toLowerCase() === normalized
    ));
    return twin ? `duplicates the proposal for gap ${twin.runId}:${twin.gapIndex}` : null;
  },
  /** A proposal with no evidence behind it is an opinion. Provenance is the run it came from. */
  provenance: (proposal) => (
    proposal.runId === null || proposal.runId === undefined || !proposal.examId
      ? 'carries no provenance back to the run that produced it'
      : null
  ),
  /** One concern per proposal: a lesson about three things is retrieved for none of them. */
  oneConcern: (proposal) => (
    proposal.concern.split(/[;.]| and /).filter((part) => part.trim().length > 3).length > 2
      ? 'states more than one concern'
      : null
  ),
});

/**
 * THE BACKSTOP (clause 16): every lesson is validated against CURRENT code before it enters
 * the brain. A proposal citing a path or line that no longer resolves is dropped with its
 * reason recorded.
 *
 * NAMED GAP, registered in the acceptance rather than discovered later: this validates PATH
 * AND LINE only. Whether a cited SYMBOL still exists and still means what the proposal claims
 * needs a symbol resolver, which is a separate future item and is NOT part of this phase. Any
 * report on this phase states that gap in the same breath as the pass.
 */
export async function validateCitationsAgainstCurrentCode(proposal, { readFileLines }) {
  const failures = [];
  for (const citation of proposal.citations || []) {
    const match = String(citation).match(/^(.+):(\d+)$/);
    if (!match) {
      failures.push(`${citation} is not a path:line citation`);
      continue;
    }
    const [, path, line] = match;
    const lines = await readFileLines(path);
    if (lines === null) {
      failures.push(`${path} no longer exists`);
      continue;
    }
    if (Number(line) > lines) failures.push(`${path}:${line} is past the end of the file (${lines} lines)`);
  }
  return failures;
}

/**
 * Curate a batch: run every gate, run the citation backstop, and mark what survives.
 *
 * Returns the batch with `accepted` and `droppedFor` set on each proposal. It writes nothing:
 * turning survivors into brain documents is `applyProposals`, a separate act.
 */
export async function curateProposals(proposals, context = {}) {
  const batch = proposals.map((proposal) => ({ ...proposal }));
  for (const proposal of batch) {
    if (proposal.kind === 'none') {
      proposal.droppedFor = 'teacher answered none';
      continue;
    }
    const reasons = [];
    for (const [name, gate] of Object.entries(CURATION_GATES)) {
      const reason = gate(proposal, { ...context, batch });
      if (reason) reasons.push(`${name}: ${reason}`);
    }
    if (context.readFileLines) {
      const citationFailures = await validateCitationsAgainstCurrentCode(proposal, context);
      for (const failure of citationFailures) reasons.push(`citation-validation: ${failure}`);
    }
    proposal.accepted = reasons.length === 0;
    proposal.droppedFor = reasons.length ? reasons.join('; ') : null;
  }
  return batch;
}

/**
 * The batch record a harvest round writes (clause 17).
 *
 * ZERO ACCEPTED IS A LEGITIMATE, RECORDED OUTCOME. A round in which every gap was a
 * model-limit produces a measured zero, and the zero is written rather than inferred from an
 * absent file, because "we harvested and accepted nothing" and "nobody ran harvest" are
 * different facts that a missing record cannot tell apart.
 */
export function harvestBatch({ cycleId, mode, proposals, skipped = [], at }) {
  const accepted = proposals.filter((proposal) => proposal.accepted);
  return {
    cycleId: cycleId ?? null,
    mode,
    at: at ?? new Date().toISOString(),
    questionsAsked: proposals.length,
    skippedGaps: skipped,
    accepted: accepted.length,
    rejected: proposals.length - accepted.length,
    proposals,
    // Proposal-only, stated in the record itself so a reader of the batch cannot mistake it
    // for a write to the brain.
    applied: false,
  };
}

/**
 * Apply accepted proposals: THE SEPARATE ACT (clause 10).
 *
 * A different function with a different name, taking an explicit writer, so a caller cannot
 * reach it by accident and a reader can see that harvesting and teaching are two steps. The
 * platform's seven silent cycles are what this separation is for: the harvest ran, and the
 * apply never did, and nothing in the record said so.
 */
export async function applyProposals(batch, { writeDocument, mode }) {
  if (batch.applied) throw new Error('This batch has already been applied.');
  if (mode !== 'evaluation') {
    throw new Error(`Refusing to apply a harvest batch from mode ${mode}; only an evaluation cycle teaches the brain.`);
  }
  const written = [];
  for (const proposal of batch.proposals.filter((entry) => entry.accepted)) {
    written.push(await writeDocument({
      kind: proposal.kind,
      body: proposal.body,
      targetDocumentId: proposal.targetDocumentId,
      provenance: { runId: proposal.runId, examId: proposal.examId, gapIndex: proposal.gapIndex, concern: proposal.concern },
    }));
  }
  return { ...batch, applied: true, written: written.length, documents: written };
}
