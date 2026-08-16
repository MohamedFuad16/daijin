// The student loop: the harness half of a run, with the provider half injected.
//
// Lineage: platform/exam/engineer.js, which is 3,000 lines because it also owns an
// OpenAI-compatible transport, a tool schema, a sandbox-confined editor, retry and quota
// handling, and reasoning capture. None of that is policy. What IS policy, and what lives
// here, is the ADR-0167 stopping mechanics:
//
//   base cap -> progress-gated extension -> boundary check at the crossing -> seal.
//
// The provider is an injected `engineer` object with ONE method, `next(context)`, returning
// one action per round. That is the whole seam, and it is why every test in this repo drives
// a real cycle with a scripted fake engineer at zero spend. The pattern is the platform's own
// loop-harness test discipline (commit 4d251c9: "proven by a loop test where the only passing
// verdict is the boundary's own").
//
// ENGINEER CONTRACT
//   engineer.next({ ...session, round, workTokens, tokenCap, extensionsGranted, forced, message })
//     -> { kind: 'edit' | 'read' | 'check' | 'submit', tokens, file?, explanation? }
//   `session` is what does not change between rounds and is supplied by the caller: the
//   prompt, the sandbox directory, the exam id. `tokens` is the work tokens this round
//   consumed, which a live driver reads from provider usage. `message` is harness feedback
//   from the previous round (a rehearsal refusal, a refused submit); a live driver appends it
//   to the transcript.
//
// ONE DELIBERATE DIVERGENCE from the platform, stated because it changes a boundary case:
// the platform evaluates the crossing BEFORE executing the round's tool calls, so an edit in
// the crossing round counts toward the NEXT boundary. This loop applies the action first, so
// the round's own edits count toward the crossing that its own tokens caused. The platform's
// order is an artifact of where usage lands in a chat-completions round trip; discarding the
// evidence produced by the very tokens that crossed the cap is not a property worth porting.

import { boundaryCheckDecision, budgetExtensionDecision } from './budget.js';

export const STUDENT_ACTIONS = Object.freeze(['edit', 'read', 'check', 'submit']);

export class BoundedStudentFailure extends Error {
  constructor(message, studentResult) {
    super(message);
    this.name = 'BoundedStudentFailure';
    // The partial result travels with the error so a cap-death still produces a full,
    // honest artifact: the platform's error.engineerResult pattern. A cap-death that
    // produced no diff is the case the drawn-cohort denominator rule exists for.
    this.studentResult = studentResult;
  }
}

/** A bounded failure is a measurement, not a crash: the run ended on a rule the harness
 *  owns. Anything else is a defect and must propagate. */
export function isBoundedStudentFailure(error) {
  return error instanceof BoundedStudentFailure;
}

function assertAction(action, round) {
  if (!action || typeof action !== 'object') throw new Error(`Student returned no action in round ${round}.`);
  if (!STUDENT_ACTIONS.includes(action.kind)) {
    throw new Error(`Unknown student action in round ${round}: ${JSON.stringify(action.kind ?? null)}.`);
  }
  const tokens = action.tokens ?? 0;
  if (!Number.isFinite(tokens) || tokens < 0) throw new Error(`Student action in round ${round} reported invalid tokens: ${tokens}.`);
  return { ...action, tokens };
}

/**
 * Run one student against one sandbox under the ADR-0167 policy.
 *
 * @param {object} options
 * @param {{next: Function}} options.engineer   injected provider loop, one action per round
 * @param {Function|null} options.checkBuild    async () => { status, exitCode?, diagnostics? }
 * @param {Function} options.snapshotState      async ({ createdPaths }) => opaque state token
 *        (the worktree diff). createdPaths carries what the student declared it created, so
 *        a new file is inside the diff rather than invisible to it.
 * @param {Function} options.restoreState       async (token) => void
 * @param {Function|null} options.submitRehearsal async () => gate results. Opt-in TWICE, by
 *        `policy.submitRehearsal` and by supplying the function: the caller that builds the
 *        rehearsal from a gate set and the policy that turns the mechanism on are different
 *        decisions, and ADR-0167 keeps this one off until a live firing validates it.
 * @param {object} options.policy               resolveBudgetPolicy output
 * @param {number} options.tokenCap             starting cap for THIS exam
 */
export async function runStudentLoop({
  engineer,
  checkBuild = null,
  snapshotState,
  restoreState,
  submitRehearsal = null,
  policy,
  tokenCap,
  session = {},
  logger = { async step() {} },
  abortSignal = null,
  sealVerified = true,
  forcedFirstEditCheck = true,
}) {
  if (typeof engineer?.next !== 'function') throw new Error('runStudentLoop requires an engineer with a next() method.');
  if (typeof snapshotState !== 'function' || typeof restoreState !== 'function') {
    throw new Error('runStudentLoop requires snapshotState and restoreState.');
  }
  if (!Number.isInteger(tokenCap) || tokenCap <= 0) throw new Error('runStudentLoop requires a positive integer tokenCap.');

  let cap = tokenCap;
  let workTokens = 0;
  let round = 0;
  let solution = null;
  let message = null;
  let hasValidatedEdit = false;

  // Extension boundary state. The boundary is the run start or the last grant; earning the
  // next step requires visible forward motion since then.
  let extensionsGranted = 0;
  let editsSinceBoundary = 0;
  let checkPassedSinceBoundary = false;

  // Seal state. `editsSinceAssessedCheck` counts edits NO check has looked at and is what
  // triggers a rollback; `editsSinceVerified` counts edits since the last PASSING check and
  // is what the provenance reports as discarded. A checked-and-failed final state is the
  // student's own and never rolls back, which is why the two counters are not one.
  let editsSinceAssessedCheck = 0;
  let editsSinceVerified = 0;
  let checksFailedSinceVerified = 0;
  let lastVerifiedState = null;
  let lastVerifiedRound = null;
  let firstEditChecked = false;

  // Paths the student says it CREATED, declared per action. An untracked new file is
  // invisible to a worktree diff, so a run whose whole contribution is a new module would
  // otherwise seal an empty diff and grade as unsubmitted. The declaration is the engineer's
  // because a live driver's create-file tool is the only thing that knows, and scanning for
  // untracked files instead would sweep in whatever the build wrote.
  const createdPaths = new Set();

  const buildChecks = [];
  const extensions = [];
  const rehearsals = [];
  let rehearsalsUsed = 0;
  let capEvents = 0;

  const assertRunning = () => {
    if (abortSignal?.aborted) throw new Error('Gym run cancelled.');
  };

  const snapshot = () => snapshotState({ createdPaths: [...createdPaths] });

  /**
   * `delivered` says whether the STUDENT was shown this verdict, and it is not cosmetic.
   *
   * The seal's rollback trigger is "edits no check has assessed", and a state the student
   * saw a verdict on is the student's own and ships as it stands. The boundary check's
   * verdict is deliberately NOT delivered (platform engineer.js: "The verdict is not
   * delivered to the model, so every delivery label keeps its meaning"), so it must not
   * reset that counter. Resetting it made a FAILING boundary check mark the condemned
   * sprint as student-owned, which shipped exactly the broken state the refusal was
   * standing over. Found by the boundary-fails test below.
   */
  const runCheck = async (trigger, forced, delivered = true) => {
    if (!checkBuild) return null;
    const started = performance.now();
    const result = await checkBuild({ round, trigger });
    const record = {
      round,
      trigger,
      forced,
      status: result?.status === 'pass' ? 'pass' : 'fail',
      exitCode: result?.exitCode ?? null,
      diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics.length : 0,
    };
    buildChecks.push(record);
    if (record.status === 'pass') {
      checkPassedSinceBoundary = true;
      lastVerifiedState = await snapshot();
      lastVerifiedRound = round;
      editsSinceVerified = 0;
      checksFailedSinceVerified = 0;
    } else {
      checksFailedSinceVerified += 1;
    }
    // A DELIVERED verdict, passing or failing, means the student was shown what its edits
    // did and chose what came next. That, and only that, is what the seal reads.
    if (delivered) editsSinceAssessedCheck = 0;
    await logger.step('gym-check-build', { round, trigger, forced }, {
      status: record.status, exit_code: record.exitCode, diagnostics: record.diagnostics,
    }, started);
    return record;
  };

  while (!solution && round < policy.maxRounds) {
    round += 1;
    assertRunning();
    const action = assertAction(await engineer.next({
      ...session,
      round, workTokens, tokenCap: cap, extensionsGranted, message,
      forced: workTokens >= cap ? 'submit' : null,
    }), round);
    message = null;
    workTokens += action.tokens;

    if (action.kind === 'edit') {
      hasValidatedEdit = true;
      for (const created of action.created || []) createdPaths.add(created);
      editsSinceBoundary += 1;
      editsSinceVerified += 1;
      editsSinceAssessedCheck += 1;
      await logger.step('gym-student-edit', { round }, { file: action.file ?? null });
      // The forced first-edit check: the platform's default-on check stack (ADR-0147). It
      // is here because the boundary check's whole premise is that an UNCHECKED sprint is
      // distinguishable from a checked one, and without a first-edit check every run's
      // first sprint is unchecked by construction.
      if (forcedFirstEditCheck && !firstEditChecked && checkBuild) {
        firstEditChecked = true;
        await runCheck('first-edit', true);
      }
    } else if (action.kind === 'check') {
      await runCheck('voluntary', false);
    } else if (action.kind === 'submit') {
      if (!hasValidatedEdit) {
        message = 'No validated edit exists; edit or create a file before submitting.';
        await logger.step('gym-student-submit-refused', { round }, 'no validated edit');
      } else if (policy.submitRehearsal && submitRehearsal && rehearsalsUsed === 0 && workTokens <= cap) {
        // The submit rehearsal, ADR-0167 opt-in. On a VOLUNTARY submit, once, the harness
        // runs the real gate set and hands any failure back instead of accepting: the
        // student meets its judge while it can still act. A budget-forced seal never
        // rehearses, and the second submission stands whatever the gates say.
        rehearsalsUsed += 1;
        const started = performance.now();
        const gates = await submitRehearsal();
        const failures = (gates || []).filter((gate) => gate.status === 'fail');
        rehearsals.push({ round, gates: (gates || []).map(({ id, status }) => ({ id, status })), failures: failures.map((gate) => gate.id) });
        await logger.step('gym-submit-rehearsal', { round }, {
          gates: (gates || []).map(({ id, status }) => ({ id, status })), failures: failures.map((gate) => gate.id),
        }, started);
        if (failures.length) {
          message = 'SUBMIT REHEARSAL: the real gate set ran against your current state and failed. '
            + `Your submission was NOT accepted. Failed gates: ${failures.map((gate) => gate.id).join(', ')}. `
            + 'Fix the failures and submit again. This rehearsal happens once; the next submission is final.';
        } else {
          solution = { state: await snapshot(), explanation: String(action.explanation || '').trim(), sealed: false };
        }
      } else {
        solution = { state: await snapshot(), explanation: String(action.explanation || '').trim(), sealed: false };
      }
    } else {
      await logger.step('gym-student-read', { round }, 'no forward motion recorded');
    }

    // The boundary check. The crossing found edits with no verdict, so the harness produces
    // the verdict itself rather than refusing on hygiene. The result is NOT delivered to the
    // student, so every delivery label keeps its meaning.
    if (boundaryCheckDecision({
      enabled: policy.boundaryCheck,
      workTokens,
      tokenCap: cap,
      step: policy.extensionStep,
      limit: policy.extensionLimit,
      granted: extensionsGranted,
      solved: Boolean(solution),
      editsSinceBoundary,
      checkPassedSinceBoundary,
      canCheck: Boolean(checkBuild),
      progressEdits: policy.progressEdits,
    })) {
      await runCheck('extension-boundary', true, false);
    }

    if (!solution && budgetExtensionDecision({
      workTokens,
      tokenCap: cap,
      step: policy.extensionStep,
      limit: policy.extensionLimit,
      granted: extensionsGranted,
      editsSinceBoundary,
      checkPassedSinceBoundary,
      progressEdits: policy.progressEdits,
    })) {
      extensionsGranted += 1;
      cap += policy.extensionStep;
      extensions.push({ round, extension: extensionsGranted, newCap: cap, workTokens });
      editsSinceBoundary = 0;
      checkPassedSinceBoundary = false;
      await logger.step('gym-budget-extension', { round }, {
        extension: extensionsGranted, new_cap: cap, work_tokens: workTokens,
      });
    }

    if (workTokens > cap) {
      capEvents += 1;
      if (!solution && hasValidatedEdit) {
        solution = await seal();
      } else if (!solution) {
        // A cap-death: no validated edit, so there is nothing to grade and no row to write.
        // The result file is the only durable record that this exam was drawn at all.
        throw new BoundedStudentFailure(
          `Student work token cap exceeded (${workTokens}/${cap}).`,
          summary({ status: 'cap-death' }),
        );
      }
      break;
    }
  }

  async function seal() {
    const reason = 'work-token-cap';
    let state = await snapshot();
    let sealedState = 'current';
    let discardedEdits = 0;
    let explanation = `Budget-bound automatic submission after a validated edit (${reason}).`;
    if (sealVerified && editsSinceAssessedCheck > 0 && lastVerifiedState !== null) {
      if (lastVerifiedState === state) {
        // The trailing edits reverted to the verified state exactly: nothing to roll back,
        // and the sealed state IS verified. Recording a rollback that changed nothing would
        // be a false provenance line.
        sealedState = 'current';
      } else {
        discardedEdits = editsSinceVerified;
        state = lastVerifiedState;
        await restoreState(lastVerifiedState);
        sealedState = 'rolled-back-to-verified';
        explanation = `Budget-bound automatic submission (${reason}); sealed the last build-verified state from round ${lastVerifiedRound}, `
          + `discarding ${discardedEdits} unverified edit(s)`
          + `${checksFailedSinceVerified > 0 ? ` (including work past ${checksFailedSinceVerified} failed check(s))` : ''}.`;
        await logger.step('gym-seal-verified-rollback', {
          round, last_verified_round: lastVerifiedRound, discarded_edits: discardedEdits,
          rolled_past_failed_check: checksFailedSinceVerified > 0,
        }, 'rolled-back');
      }
    }
    await logger.step('gym-budget-auto-submit', { reason, work_token_cap: cap }, {
      work_tokens: workTokens, sealed_state: sealedState, discarded_edits: discardedEdits,
    });
    return { state, explanation, sealed: true, sealedState, discardedEdits };
  }

  function summary(extra = {}) {
    return {
      rounds: round,
      usage: {
        workTokens,
        workTokenCap: cap,
        baseTokenCap: tokenCap,
        extensionsGranted,
        capEvents,
      },
      buildChecks,
      extensions,
      rehearsals,
      sealedState: solution?.sealed ? solution.sealedState : null,
      sealedStateChecked: solution?.sealed ? editsSinceAssessedCheck === 0 : null,
      discardedEdits: solution?.discardedEdits ?? 0,
      lastVerifiedRound,
      ...extra,
    };
  }

  if (!solution) {
    throw new BoundedStudentFailure(
      `Student did not submit a solution within ${policy.maxRounds} rounds.`,
      summary({ status: 'no-submission' }),
    );
  }
  return {
    ...summary({ status: solution.sealed ? 'sealed' : 'submitted' }),
    state: solution.state,
    explanation: solution.explanation,
  };
}
