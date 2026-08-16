#!/usr/bin/env node
// Seed the P8 fixture's gym ledger with ONE exam, ONE attempt and ONE rubric.
//
//   node engine/test-live/p8-seed-rubric.mjs /path/to/fixture-repo
//
// WHAT THIS IS AND IS NOT, because clause (e) turns on the distinction and the honest
// label has to travel with the artifact rather than live in a message someone read once.
//
// IT IS: a real ledger, written through the real API. The exam goes in through putExam and
// meets its validator, the attempt goes in through recordRun and meets the refusal that a
// run with no applied diff has no row, and the rubric goes in through importRubricBatch
// and meets the batch rules (gradable mode, one rubric per run, foreign key to a real run).
// So the STORAGE and RENDER seam is exercised end to end: examDetail reads it back through
// the ledger accessor and maps it to the canonical five-axis list at the daemon boundary.
//
// IT IS NOT: evidence that grading works. The axis scores below were written by hand, not
// produced by a teacher model grading a real submission. Nothing in this build has graded
// anything: there is no production caller of importRubricBatch, because grading needs the
// teacher role and the student driver, and both are paid and unbuilt. A demonstration
// using this seed can honestly claim "graded axes render from real storage" and cannot
// claim "the gym grades".
//
// The scores are deliberately MIXED and the verdict is `partial`, so a radar drawn from
// them has a shape. Five 5s would render as a circle and would hide an axis-ordering bug,
// which is exactly the defect finding 79 was about.

import path from 'node:path';

import { GymLedger, gymDatabasePath } from '../src/gym/ledger.js';

export const SEED_EXAM = Object.freeze({
  examId: 'exam-0001',
  title: 'Apply tax after the discount, not before',
  status: 'promoted',
  benchmarkStatus: 'active',
  heldOut: false,
  scopeTier: 'S',
  baseCommit: 'a'.repeat(40),
  goldCommit: 'b'.repeat(40),
  task: 'Bulk orders are overcharged because tax is computed before the discount is applied. Fix the order of operations in the pricing path and keep the existing tests passing.',
  scopeFiles: 1,
  scopeInsertions: 6,
  provenance: { source: 'commit-mining', commit: 'c'.repeat(40) },
});

// Hand-authored, and labelled as such wherever it is used. Mixed on purpose: a radar of
// five identical scores is a circle, and a circle hides an axis-ordering defect.
export const SEED_AXES = Object.freeze({
  correctness_vs_gold: { score: 4, citations: ['src/pricing/tax.js:5'] },
  convention_adherence: { score: 5, citations: ['docs/decisions.md:11'] },
  decision_awareness: { score: 2, citations: ['docs/decisions.md:9'] },
  reasoning_quality: { score: 3, citations: ['src/pricing/tax.js:3'] },
  blast_radius_awareness: { score: 2, citations: ['test/pricing.test.js:7'] },
});

export function seedRubric(repoPath) {
  const ledger = GymLedger.open(gymDatabasePath(repoPath));
  try {
    if (!ledger.getExam(SEED_EXAM.examId)) ledger.putExam(SEED_EXAM);

    // Already seeded? One rubric per run is enforced by a unique index, so a second run of
    // this script would throw rather than quietly double-grade. Idempotent instead.
    const existing = ledger.attemptsForExam(SEED_EXAM.examId).find((row) => row.rubric);
    if (existing) return { examId: SEED_EXAM.examId, runId: existing.id, created: false };

    const cycleId = ledger.startCycle({ mode: 'evaluation', trigger: 'manual' });
    const runId = ledger.recordRun({
      cycleId,
      examId: SEED_EXAM.examId,
      mode: 'evaluation',
      status: 'completed',
      verdict: 'partial',
      resultFile: path.join('.daijin', 'gym', 'results', 'exam-0001-seed.json'),
      applied: true,
      workTokens: 41_200,
      tokenCap: 450_000,
      extensionsGranted: 0,
    });
    ledger.importRubricBatch({
      mode: 'evaluation',
      source: 'p8-seed (hand authored, not a grader run)',
      rubrics: [{
        runId,
        examId: SEED_EXAM.examId,
        verdict: 'partial',
        axes: { ...SEED_AXES },
        gaps: [],
        author: 'p8-seed',
        authorRole: 'teacher',
        taskDigest: `sha256:${'1'.repeat(64)}`,
        submissionDigest: `sha256:${'2'.repeat(64)}`,
      }],
    });
    ledger.finishCycle(cycleId, { status: 'completed' });
    return { examId: SEED_EXAM.examId, runId, created: true };
  } finally {
    ledger.close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node engine/test-live/p8-seed-rubric.mjs /path/to/fixture-repo');
    process.exitCode = 1;
  } else {
    try {
      const result = seedRubric(path.resolve(target));
      console.log(result.created
        ? `seeded ${result.examId} run ${result.runId} with a hand-authored rubric (NOT a grader run)`
        : `${result.examId} run ${result.runId} already carries a rubric; nothing written`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
