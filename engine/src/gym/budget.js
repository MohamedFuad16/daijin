// The ADR-0167 harness defaults, as pure functions.
//
// Lineage: platform ADR-0167 (2026-08-16, owner-directed), measured by the five-iteration
// natural-stop loop. What that loop measured, and why each rule below is shaped the way it
// is rather than a knob someone liked:
//
//  - Eighteen of nineteen prior graded runs of the never-passed control exams ended ON the
//    work-token cap, mid-thought. Raising flat caps 2x to 4x always got consumed without
//    converting a single fail. So the extension is PROGRESS-GATED rather than larger: the
//    budget is not the reward for spending it.
//  - A grant requires at least two validated edits AND a passing build check since the last
//    boundary. Run 480's twenty-one-reads-two-edits loop is the shape that earns nothing.
//  - The boundary check exists because iteration 3 elicited the first route wiring exam-0058
//    had ever seen, in an UNCHECKED sprint, and the extension refusal sealed over it: real
//    work died for hygiene. At the crossing, when there are edits but no verdict, the
//    harness runs the check ITSELF. A pass grants and snapshots; a fail leaves the refusal
//    standing over condemned work, honestly.
//
// Every function here is pure so the whole policy can be held by a test without a provider
// loop, which is how the platform's own policy is tested (engineer.test.js, the
// budgetExtensionDecision table).

/** The campaign defaults ADR-0167 made standard. Deviating from them in a scored run is a
 *  recorded configuration, never a default. */
export const ADR_0167_DEFAULTS = Object.freeze({
  /** Base work-token cap. The assignment's number, and the platform's M/L tier value. */
  baseTokenCap: 800_000,
  /** Per-exam caps by scope tier. The S split is the platform's ADR-0149 value, kept
   *  because a small task needing 800k is a runaway loop rather than a hard task, and that
   *  is exactly what a cap is for. Set every tier to baseTokenCap to disable the split. */
  tierTokenCaps: Object.freeze({ S: 450_000, M: 800_000, L: 800_000 }),
  extensionStep: 400_000,
  extensionLimit: 8,
  /** Hard outer bound on base + all extensions. The platform throws at configuration time
   *  rather than at the eighth grant, so an impossible policy cannot start a paid run. */
  hardOuterBound: 5_000_000,
  /** The harness verifies an unchecked sprint itself at the crossing instead of refusing. */
  boundaryCheck: true,
  /** OPT-IN, and this is the ADR's own wording. The rehearsal is proven by a loop-harness
   *  test but has never fired in a live run, and a gate-set rehearsal changes cycle
   *  wall-clock materially. It is promoted when a live firing validates it. */
  submitRehearsal: false,
  /** Edits since the boundary that count as forward motion. */
  progressEdits: 2,
  maxRounds: 30,
  /** ADR-0147's pre-seal check: the fraction of the cap at which unverified edits get one
   *  last verdict while the student can still act on it. null disables. Distinct from the
   *  boundary check in both trigger and audience: the boundary check fires at the CROSSING
   *  and its verdict is never delivered; this one fires BEFORE the crossing and its whole
   *  purpose is delivery. exp4's twice-observed failure was a run sealing over edits nobody
   *  had checked, with budget still on the clock to fix them. */
  preSealFraction: 0.85,
  /** How many times the pre-seal check may re-arm. A delivery commissions new edits ("fix
   *  these errors"), and those edits themselves need verifying; unbounded, a student that
   *  edits after every delivery would spend its remaining budget on checks. */
  preSealMaxDeliveries: 2,
});

function integer(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function fraction(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  // Bounded away from both ends: at 0 the check fires on the first token, and at 1 it fires
  // at the cap, where the seal has already taken the decision away from the student.
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 0.95) {
    throw new Error(`${name} must be a number from 0.1 to 0.95, or null to disable.`);
  }
  return parsed;
}

/**
 * Should the pre-seal check fire now?
 *
 * ADR-0147. Three conditions, and the middle one is the whole point: there must be edits NO
 * check has assessed. A run whose recent work is already verified needs no last verdict, and
 * firing anyway would spend gate time to tell the student what it already knows.
 */
export function preSealDecision({
  fraction: preSealFraction, workTokens, tokenCap, editsSinceAssessedCheck, deliveries, maxDeliveries, canCheck, solved,
}) {
  if (preSealFraction === null || preSealFraction === undefined) return false;
  if (!canCheck || solved) return false;
  if (deliveries >= maxDeliveries) return false;
  if (editsSinceAssessedCheck <= 0) return false;
  return workTokens >= tokenCap * preSealFraction;
}

/**
 * The whole extension policy in one predicate.
 *
 * Grant iff: the feature is on, the cap was just crossed, steps remain, and the span since
 * the last boundary shows real progress, meaning at least `progressEdits` validated edits
 * AND a passing build check. Reading loops earn nothing; unverified motion is not progress.
 */
export function budgetExtensionDecision({
  workTokens, tokenCap, step, limit, granted, editsSinceBoundary, checkPassedSinceBoundary,
  progressEdits = ADR_0167_DEFAULTS.progressEdits,
}) {
  if (!step || step <= 0) return false;
  if (workTokens <= tokenCap) return false;
  if (granted >= limit) return false;
  return editsSinceBoundary >= progressEdits && checkPassedSinceBoundary === true;
}

/**
 * Whether the harness should run the boundary check itself at this crossing.
 *
 * The condition is the extension decision's own gap: everything a grant needs is present
 * EXCEPT the passing verdict, and a check is available to produce one. Note the asymmetry
 * with `budgetExtensionDecision`: this one fires when `checkPassedSinceBoundary` is false,
 * because its whole purpose is to find out whether that false is a fact about the work or
 * only a fact about the record.
 */
export function boundaryCheckDecision({
  enabled, workTokens, tokenCap, step, limit, granted, solved, editsSinceBoundary,
  checkPassedSinceBoundary, canCheck, progressEdits = ADR_0167_DEFAULTS.progressEdits,
}) {
  if (!enabled) return false;
  if (!canCheck) return false;
  if (!step || step <= 0) return false;
  if (workTokens <= tokenCap) return false;
  if (granted >= limit) return false;
  if (solved) return false;
  return editsSinceBoundary >= progressEdits && checkPassedSinceBoundary !== true;
}

/**
 * Resolve and VALIDATE a budget policy. Throws when the configuration could exceed the hard
 * outer bound, at configuration time rather than at the eighth grant: a policy that cannot
 * be run is refused before the first token is spent, which is the platform's behavior
 * (engineer.js: "Budget extensions must not be able to exceed 5,000,000 total work tokens").
 */
export function resolveBudgetPolicy(config = {}) {
  const defaults = ADR_0167_DEFAULTS;
  const policy = {
    baseTokenCap: integer(config.baseTokenCap, defaults.baseTokenCap, 1_000, 5_000_000, 'baseTokenCap'),
    tierTokenCaps: { ...defaults.tierTokenCaps, ...(config.tierTokenCaps || {}) },
    extensionStep: integer(config.extensionStep, defaults.extensionStep, 0, 500_000, 'extensionStep'),
    extensionLimit: integer(config.extensionLimit, defaults.extensionLimit, 0, 10, 'extensionLimit'),
    hardOuterBound: integer(config.hardOuterBound, defaults.hardOuterBound, 1_000, 5_000_000, 'hardOuterBound'),
    boundaryCheck: config.boundaryCheck === undefined ? defaults.boundaryCheck : Boolean(config.boundaryCheck),
    submitRehearsal: config.submitRehearsal === undefined ? defaults.submitRehearsal : Boolean(config.submitRehearsal),
    progressEdits: integer(config.progressEdits, defaults.progressEdits, 1, 20, 'progressEdits'),
    maxRounds: integer(config.maxRounds, defaults.maxRounds, 1, 100, 'maxRounds'),
    preSealFraction: config.preSealFraction === null ? null : fraction(
      config.preSealFraction, defaults.preSealFraction, 'preSealFraction',
    ),
    preSealMaxDeliveries: integer(config.preSealMaxDeliveries, defaults.preSealMaxDeliveries, 0, 10, 'preSealMaxDeliveries'),
  };
  for (const [tier, cap] of Object.entries(policy.tierTokenCaps)) {
    if (!Number.isInteger(cap) || cap < 1_000 || cap > 5_000_000) {
      throw new Error(`tierTokenCaps.${tier} must be an integer from 1000 to 5000000.`);
    }
  }
  const worstCap = Math.max(policy.baseTokenCap, ...Object.values(policy.tierTokenCaps));
  if (policy.extensionStep > 0 && worstCap + policy.extensionStep * policy.extensionLimit > policy.hardOuterBound) {
    throw new Error(
      `Budget extensions must not be able to exceed ${policy.hardOuterBound} total work tokens `
      + `(cap ${worstCap} plus ${policy.extensionLimit} steps of ${policy.extensionStep}).`,
    );
  }
  return policy;
}

/**
 * The starting cap for one exam. Precedence, outermost first, matching the platform:
 * an explicit run override (an experiment forcing a uniform cohort cap) beats the exam's own
 * documented `workTokenCap` override, which beats the tier cap, which beats the base cap.
 *
 * The exam-level override is the ADR-0148 mechanism, and exams.js is what enforces its
 * required reason: a raised cap is a documented decision, not drift.
 */
export function tokenCapForExam(exam = {}, policy = ADR_0167_DEFAULTS, runOverride = null) {
  if (runOverride !== null && runOverride !== undefined) {
    return integer(runOverride, policy.baseTokenCap, 1_000, 5_000_000, 'runTokenCapOverride');
  }
  if (Number.isInteger(exam.workTokenCap)) return exam.workTokenCap;
  const tierCaps = policy.tierTokenCaps || ADR_0167_DEFAULTS.tierTokenCaps;
  return tierCaps[exam.scopeTier] ?? policy.baseTokenCap ?? ADR_0167_DEFAULTS.baseTokenCap;
}
