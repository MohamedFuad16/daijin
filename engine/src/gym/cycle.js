// The cycle runner: one attempt, and the cycle that draws them.
//
// Lineage: platform/exam/run.js executeExam, with three changes that are the point of the
// port rather than incidental to it.
//
//  1. The provider is INJECTED (student-loop.js), so a full cycle runs end to end against a
//     scripted fake engineer at zero spend. Every test in this repo does exactly that.
//  2. Gate commands are DATA from the discovered gates.yaml (gates.js), not a hardcoded
//     surface list, so an arbitrary repo's gates work.
//  3. The mode travels with the run into the result artifact and into the ledger, and the
//     ledger refuses a row for a run with no applied diff. A cap-death therefore leaves a
//     result file and no row, which is what makes the drawn-cohort denominator honest.
//
// Order of operations is the platform's, and each step is where it is for a measured reason:
// the sandbox-leak check runs BEFORE any spend (checked only at cleanup, it surfaced after
// the whole engineer spend and threw the result away); the baseline gate run happens before
// the student touches anything and is followed by a restore; and the final diff is reapplied
// from a clean base so evaluation never depends on hidden workspace state.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildGateCommand, classifyGateResults, expandGates, runCommand, runGateSet } from './gates.js';
import { applyEngineerDiff, assertOwnSandboxRemoved, assertSandboxRootEmpty, createSandbox, foreignSandboxEntries } from './sandbox.js';
import { assertSpendGate, autoBlockSpendGate } from './spend-gate.js';
import { assertRunMode } from './run-mode.js';
import { isGradableRun } from './run-mode.js';
import { buildGradingPacket } from './grading.js';
import { gradeAttemptWithTeacher } from './teacher-driver.js';
import { examDrawRefusal } from './exams.js';
import { buildStudentPrompt } from './prompt.js';
import { resolveBudgetPolicy, tokenCapForExam } from './budget.js';
import { isBoundedStudentFailure, runStudentLoop } from './student-loop.js';
import { writeResultFile } from './result-files.js';
import { computeGoldProvenanceExclusions, exclusionRecord } from './provenance.js';

const execFileAsync = promisify(execFile);
const DEFAULT_GATE_TIMEOUT_MS = 900_000;

/**
 * The worktree's own unified diff, including files the student created.
 *
 * `--intent-to-add` on created paths is load bearing: an untracked new file is invisible to
 * `git diff`, so a run whose whole contribution is a new module would seal an empty diff and
 * grade as unsubmitted. `--binary` keeps the patch replayable.
 */
export async function sandboxDiff(directory, createdPaths = []) {
  if (createdPaths.length) {
    await execFileAsync('git', ['add', '--intent-to-add', '--', ...createdPaths], {
      cwd: directory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
    });
  }
  const { stdout } = await execFileAsync('git', ['diff', '--binary', '--no-ext-diff'], {
    cwd: directory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
  });
  return stdout;
}

/**
 * Adapt a git worktree sandbox to the opaque state seam the student loop uses.
 *
 * The state token is the worktree's own unified diff, exactly as the platform seals it, so
 * a rollback is "restore to base, reapply the verified diff" rather than a file-level undo
 * the harness would have to model.
 */
export function createSandboxWorktree(sandbox, {
  diffReader = sandboxDiff, applyDiff = applyEngineerDiff, timeoutMs = 30_000,
} = {}) {
  if (typeof diffReader !== 'function') throw new Error('createSandboxWorktree requires a diffReader.');
  return {
    directory: sandbox.directory,
    async snapshot({ createdPaths = [] } = {}) {
      return diffReader(sandbox.directory, createdPaths);
    },
    async restore(state) {
      await sandbox.restore();
      if (state && String(state).trim()) {
        const applied = await applyDiff(sandbox.directory, state, timeoutMs);
        if (!applied.applied) throw new Error(`Could not restore the verified state: ${applied.error}`);
      }
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Run ONE exam attempt end to end.
 *
 * Returns the result artifact. Throws only for defects; every bounded outcome (a cap-death,
 * a refused apply, a regressed gate) is a result with a status.
 */
export async function runExamAttempt({
  exam,
  mode,
  cohort = 'training',
  gates,
  engineer,
  rules,
  context = '',
  /** Injected retrieval, called with the gold-provenance exclusion. Optional: a repo with no
   *  brain runs with whatever `context` the caller assembled. When supplied it is called as
   *  retrieveContext({ query, excludeDocumentIds }) and its return replaces `context`. */
  retrieveContext = null,
  /** Brain documents for the exclusion computation. Required whenever the exclusion is
   *  computed, which is required for any run that may be certified. */
  documents = null,
  policy: policyConfig = {},
  repoPath,
  sourceRepo,
  engineRoot,
  sandboxesRoot,
  resultDir,
  hypothesis = null,
  logger = { async step() {} },
  emitFinding = null,
  abortSignal = null,
}, dependencies = {}) {
  assertRunMode(mode);
  const refusal = examDrawRefusal(exam, { mode, cohort });
  if (refusal) throw new Error(refusal);

  // The gate is asserted for EVERY student run, whoever the student is. A harness-debug run
  // still executes the same code path a paid run does, and a mode-shaped exemption is how a
  // gate stops meaning anything. Tests open a gate in their own temp directory.
  const gate = await (dependencies.assertSpendGate || assertSpendGate)('gym-cycle', {
    repoPath, file: dependencies.gateFile,
  });

  const policy = resolveBudgetPolicy(policyConfig);
  const tokenCap = tokenCapForExam(exam, policy, policyConfig.runTokenCapOverride ?? null);

  const sandboxFactory = dependencies.createSandbox || createSandbox;
  const gateRunner = dependencies.runGateSet || runGateSet;
  const commandRunner = dependencies.runCommand || runCommand;
  const rootEmptyCheck = dependencies.assertSandboxRootEmpty || assertSandboxRootEmpty;
  const ownRemovedCheck = dependencies.assertOwnSandboxRemoved || assertOwnSandboxRemoved;
  const foreignEntries = dependencies.foreignSandboxEntries || foreignSandboxEntries;
  const applyDiff = dependencies.applyEngineerDiff || applyEngineerDiff;
  const worktreeFactory = dependencies.createWorktree || createSandboxWorktree;
  const gateTimeoutMs = dependencies.gateTimeoutMs || DEFAULT_GATE_TIMEOUT_MS;

  const started = performance.now();
  let sandbox = null;
  let worktree = null;
  let cleanupError = null;
  let foreignSandboxes = [];
  let result = null;

  // Stopping is free before a sandbox exists and expensive after the student has run.
  await rootEmptyCheck(sandboxesRoot);

  // The gold-provenance exclusion, BEFORE retrieval, because its whole purpose is to shape
  // what retrieval may return. Computed whenever documents are supplied; a run without it
  // is runnable (a repo may have no brain yet) and is NOT certifiable, which is the
  // structural half of "the student never sees gold".
  let goldExclusion = null;
  if (documents) {
    goldExclusion = await (dependencies.computeGoldProvenanceExclusions || computeGoldProvenanceExclusions)(
      { exam, documents, sourceRepo }, dependencies,
    );
    await logger.step('gym-provenance-filter', { exam: exam.examId }, {
      excluded_ids: goldExclusion.ids, reasons: goldExclusion.reasons,
    });
  }

  // What the student was SHOWN, recorded for the grading packet: the teacher may cite only
  // these ids, and a retrieval-miss gap is checked against them. A retrieveContext that
  // returns a bare string (the older seam, and every scripted test) records an empty list,
  // which is honest for a caller that never said what it showed.
  let shownDocumentIds = [];
  if (retrieveContext) {
    const retrieved = await retrieveContext({
      query: exam.task,
      // Store v3 CandidateFilters.excludeDocumentIds. An empty array is a real answer
      // (nothing to withhold) and is passed as such rather than as undefined.
      excludeDocumentIds: goldExclusion ? goldExclusion.ids : [],
    });
    if (retrieved && typeof retrieved === 'object') {
      context = retrieved.context ?? '';
      shownDocumentIds = Array.isArray(retrieved.shownDocumentIds) ? [...retrieved.shownDocumentIds] : [];
    } else {
      context = retrieved;
    }
  }

  const { prompt, audit, mode: promptMode } = buildStudentPrompt({ rules, task: exam.task, context });
  await logger.step('gym-prompt-scaffold', { exam: exam.examId, mode }, {
    prompt_mode: promptMode, sections: audit.sections, missing: audit.missing,
  });
  if (!audit.complete && emitFinding) {
    // The instruction files are user-editable, so the harness records rather than
    // re-injects. A scored run measured under a prompt missing an ADR-0167 section is a
    // different experiment wearing the same name, and that belongs on the board.
    await emitFinding({
      ts: Date.now(),
      source: 'engine',
      severity: mode === 'evaluation' ? 'warn' : 'info',
      category: 'prompt-scaffold',
      target: exam.examId,
      evidence: `ADR-0167 sections missing from the student instruction file: ${audit.missing.join(', ')}`,
      status: 'open',
    });
  }

  try {
    sandbox = await sandboxFactory({
      sourceRepo, baseCommit: exam.baseCommit, examId: exam.examId, sandboxesRoot,
    });
    await logger.step('gym-sandbox', { exam: exam.examId, base: exam.baseCommit, mode, hypothesis }, 'created', started);

    const expanded = expandGates(gates, { engineRoot, sandbox: sandbox.directory });
    const baselineStarted = performance.now();
    const baseline = await gateRunner(expanded, { cwd: sandbox.directory, timeoutMs: gateTimeoutMs });
    await logger.step('gym-baseline-gates', { exam: exam.examId }, baseline.map(({ id, status }) => ({ id, status })), baselineStarted);
    await sandbox.restore();

    worktree = worktreeFactory(sandbox, dependencies);
    const buildCommand = buildGateCommand(expanded);
    const checkBuild = buildCommand
      ? async () => {
        const outcome = await commandRunner(buildCommand, { cwd: sandbox.directory, timeoutMs: gateTimeoutMs });
        return { status: outcome.status === 'pass' ? 'pass' : 'fail', exitCode: outcome.exitCode, diagnostics: [] };
      }
      : null;
    const submitRehearsal = policy.submitRehearsal
      ? async () => gateRunner(expanded, { cwd: sandbox.directory, timeoutMs: gateTimeoutMs })
      : null;

    let student = null;
    let bounded = null;
    try {
      student = await runStudentLoop({
        engineer, checkBuild, submitRehearsal, policy, tokenCap, logger, abortSignal,
        // What does not change between rounds: the student needs its prompt and the
        // directory it may touch, and a live driver needs both on every round to rebuild
        // its transcript after a resume.
        session: { prompt, sandbox: sandbox.directory, examId: exam.examId, mode },
        snapshotState: (options) => worktree.snapshot(options),
        restoreState: (state) => worktree.restore(state),
      });
    } catch (error) {
      if (!isBoundedStudentFailure(error)) throw error;
      bounded = error;
      await logger.step('gym-student-bounded-failure', { exam: exam.examId }, {
        error: error.message, work_tokens: error.studentResult?.usage?.workTokens ?? null,
      });
    }

    const provenance = {
      policy: {
        baseTokenCap: tokenCap,
        extensionStep: policy.extensionStep,
        extensionLimit: policy.extensionLimit,
        boundaryCheck: policy.boundaryCheck,
        submitRehearsal: policy.submitRehearsal,
        maxRounds: policy.maxRounds,
      },
      promptAudit: audit,
      // The ids the student's context actually carried. buildGradingPacket reads this;
      // before it was recorded the packet's shown list was permanently empty, so a teacher
      // could never cite a document and a retrieval-miss check had nothing to check.
      shownDocumentIds,
      // The exclusion record, or null when no brain was supplied. Certification refuses a
      // scored run whose artifact carries no record, so this field is load bearing rather
      // than informational.
      goldExclusion: goldExclusion ? exclusionRecord(goldExclusion, exam) : null,
      gate: { path: gate.file, status: gate.status, reason: gate.reason },
      buildGate: buildCommand ? 'present' : 'absent',
    };

    if (bounded) {
      // A cap-death or a no-submission run: no diff, so no gates, no row, and the result
      // file is the only durable record that this exam was drawn.
      result = {
        timestamp: nowIso(),
        mode,
        hypothesis,
        exam: resultExam(exam),
        status: 'unsubmitted',
        boundedFailure: bounded.message,
        baseline,
        candidate: [],
        apply: { applied: false, error: bounded.message },
        student: bounded.studentResult,
        provenance,
        duration_ms: Math.round(performance.now() - started),
      };
    } else {
      // Reapply from a clean base so evaluation never depends on hidden workspace state.
      await sandbox.restore();
      const apply = student.state && String(student.state).trim()
        ? await applyDiff(sandbox.directory, student.state)
        : { applied: false, error: 'Student produced an empty diff.' };
      await logger.step('gym-apply-diff', { exam: exam.examId }, apply);

      let candidate = [];
      if (apply.applied) {
        const candidateRaw = await gateRunner(expanded, { cwd: sandbox.directory, timeoutMs: gateTimeoutMs });
        candidate = classifyGateResults(baseline, candidateRaw);
        await logger.step('gym-candidate-gates', { exam: exam.examId }, candidate.map(({ id, classification }) => ({ id, classification })));
      }

      // A regression on a MEASURED gate (every raw command passed; only a counted metric
      // moved the wrong way) is real signal at a different severity than a gate that fails
      // outright, and one label for both reads as a compile failure in a summary line.
      const regressions = candidate.filter((entry) => entry.classification === 'regressed');
      const status = !apply.applied
        ? (student.state && String(student.state).trim() ? 'apply-error' : 'unsubmitted')
        : regressions.length > 0
          ? regressions.every((entry) => entry.metric && entry.status === 'pass')
            ? 'metric-regressed'
            : 'gates-regressed'
          : 'completed';

      result = {
        timestamp: nowIso(),
        mode,
        hypothesis,
        exam: resultExam(exam),
        status,
        baseline,
        candidate,
        apply,
        student: {
          ...student,
          explanation: student.explanation,
          diff: student.state,
        },
        provenance,
        duration_ms: Math.round(performance.now() - started),
      };
    }
    return result;
  } finally {
    if (sandbox) {
      try {
        await sandbox.cleanup();
        // Only this run's own worktree is its responsibility. Anything else in the root
        // arrived from another process and is recorded for the operator rather than failing
        // a run that has already been paid for.
        await ownRemovedCheck(sandbox.directory);
        foreignSandboxes = await foreignEntries(sandboxesRoot, sandbox.directory);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (result) {
      result.sandboxClean = cleanupError === null;
      result.foreignSandboxes = foreignSandboxes;
      if (resultDir) {
        const written = await writeResultFile(resultDir, result, dependencies);
        result.resultFile = written.name;
      }
    }
    await logger.step('gym-cleanup', { exam: exam.examId }, cleanupError
      ? { error: cleanupError.message }
      : foreignSandboxes.length > 0
        ? { own_sandbox: 'removed', foreign_sandboxes: foreignSandboxes }
        : 'sandbox empty');
    if (cleanupError) throw cleanupError;
  }
}

function resultExam(exam) {
  return {
    id: exam.examId,
    tier: exam.scopeTier,
    heldOut: exam.heldOut,
    baseCommit: exam.baseCommit,
    // Recorded so grading binds to the reference that existed AT RUN TIME: a re-gold between
    // the run and the grade would otherwise grade against a reference the student never
    // faced. Safe to record here because result files are not an MCP-exposed surface.
    goldCommit: exam.goldCommit,
    task: exam.task,
    status: exam.status,
    benchmarkStatus: exam.benchmarkStatus,
  };
}

/**
 * Run a cohort of exams as one cycle, writing the ledger as it goes.
 *
 * The ledger row is written ONLY for a run that produced an applied diff; a cap-death writes
 * its result file and nothing else. `drawn` is therefore never derived from the rows this
 * loop wrote, and the summary reports it from the files.
 */
export async function runGymCycle({
  exams, mode, cohort = 'training', ledger, resultDir, closeGateAfter = true, teacher = null, ...attemptOptions
}, dependencies = {}) {
  assertRunMode(mode);
  const cycleId = ledger ? ledger.startCycle({ mode, trigger: attemptOptions.trigger || 'manual', config: { cohort } }) : null;
  const attempts = [];
  try {
    for (const exam of exams) {
      const result = await runExamAttempt({ ...attemptOptions, exam, mode, cohort, resultDir }, dependencies);
      attempts.push(result);
      if (ledger && result.apply.applied) {
        const runId = ledger.recordRun({
          cycleId,
          examId: exam.examId,
          mode,
          status: result.status,
          resultFile: result.resultFile,
          applied: true,
          workTokens: result.student?.usage?.workTokens ?? null,
          tokenCap: result.student?.usage?.workTokenCap ?? null,
          extensionsGranted: result.student?.usage?.extensionsGranted ?? null,
          sealedState: result.student?.sealedState ?? null,
          at: result.timestamp,
        });
        // INLINE GRADING, when a teacher rides the cycle and the mode is
        // gradable (the ledger refuses rubrics for harness-debug, and this
        // respects that boundary rather than testing it). A grading failure
        // is logged and the attempt stays pending - a rubric can be written
        // later, an attempt cannot be re-run - and it never fails the cycle.
        if (teacher && isGradableRun(mode)) {
          try {
            const diff = String(result.student?.state ?? '');
            const packet = buildGradingPacket({
              artifact: { ...result, exam: { id: exam.examId, task: exam.task }, student: { diff } },
              exam,
            });
            const rubric = await (dependencies.gradeAttempt || gradeAttemptWithTeacher)({
              runId, packet, exam, diff, candidate: result.candidate,
              generate: teacher.generate, grader: teacher.grader,
            });
            ledger.importRubricBatch({ rubrics: [rubric], mode, source: 'inline-teacher', at: result.timestamp });
            await attemptOptions.logger?.step?.('gym-graded', { exam: exam.examId, run: runId }, { verdict: rubric.verdict });
          } catch (error) {
            await attemptOptions.logger?.step?.('gym-grading-refused', { exam: exam.examId, run: runId }, { error: String(error.message).slice(0, 300) });
          }
        }
      }
    }
    if (ledger) ledger.finishCycle(cycleId, { status: 'completed' });
  } catch (error) {
    if (ledger) ledger.finishCycle(cycleId, { status: 'aborted' });
    throw error;
  } finally {
    if (closeGateAfter) {
      // The platform's automatic safety closure: an authorization spends once. The writer it
      // calls can only ever write `blocked`.
      const close = dependencies.autoBlockSpendGate || autoBlockSpendGate;
      await close({ repoPath: attemptOptions.repoPath, file: dependencies.gateFile });
    }
  }
  return { cycleId, attempts };
}
