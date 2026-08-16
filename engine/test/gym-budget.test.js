// The ADR-0167 stopping mechanics, driven by a scripted fake engineer at zero spend.
//
// The centerpiece is the platform's own loop-harness pattern (commit 4d251c9): a run in
// which THE ONLY PASSING VERDICT IS THE BOUNDARY'S OWN, so the extension cannot be explained
// by anything else. It runs beside its control, the same script with the boundary check off,
// because a mechanism demonstrated without its control demonstrates nothing.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADR_0167_DEFAULTS, boundaryCheckDecision, budgetExtensionDecision, resolveBudgetPolicy, tokenCapForExam,
} from '../src/gym/budget.js';
import { BoundedStudentFailure, isBoundedStudentFailure, runStudentLoop } from '../src/gym/student-loop.js';

/** A worktree the loop can snapshot and restore, with no git and no filesystem. */
function memoryWorktree(initial = '1') {
  const state = { value: initial, restores: [] };
  return {
    state,
    snapshotState: async () => state.value,
    restoreState: async (value) => { state.restores.push(value); state.value = value; },
  };
}

/** A build check that fails the first N times and passes afterwards. */
function checkAfter(failures) {
  let calls = 0;
  const record = [];
  const check = async ({ trigger }) => {
    calls += 1;
    const status = calls > failures ? 'pass' : 'fail';
    record.push({ trigger, status });
    return { status, exitCode: status === 'pass' ? 0 : 65, diagnostics: status === 'pass' ? [] : ['boom'] };
  };
  return { check, record, calls: () => calls };
}

/** A scripted engineer: one action per round, and it applies its own edits to the worktree. */
function scriptedEngineer(script, worktree) {
  const seen = [];
  return {
    seen,
    next: async (context) => {
      seen.push(context);
      const action = script[context.round - 1];
      if (!action) return { kind: 'read', tokens: 0 };
      if (action.kind === 'edit') worktree.state.value = action.value;
      return action;
    },
  };
}

// The crossing tests below ISOLATE the extension mechanism by disabling the pre-seal check
// (ADR-0147), which would otherwise verify the sprint at 0.85 of the cap and leave the
// boundary check nothing to do. That interaction is not swept under the rug: the test named
// "with BOTH campaign defaults on" proves the boundary check still fires in the shipped
// configuration once the pre-seal deliveries are spent, which is what keeps it from being
// dead coverage.
const LOOP_POLICY = {
  baseTokenCap: 1_000, tierTokenCaps: { S: 1_000, M: 1_000, L: 1_000 },
  extensionStep: 500, extensionLimit: 2, maxRounds: 6, preSealFraction: null,
};

test('budgetExtensionDecision: every branch of the policy', () => {
  const base = {
    workTokens: 1_100, tokenCap: 1_000, step: 400_000, limit: 8, granted: 0,
    editsSinceBoundary: 2, checkPassedSinceBoundary: true,
  };
  assert.equal(budgetExtensionDecision(base), true);
  assert.equal(budgetExtensionDecision({ ...base, step: 0 }), false, 'step 0 disables the feature');
  assert.equal(budgetExtensionDecision({ ...base, workTokens: 900 }), false, 'no crossing, no grant');
  assert.equal(budgetExtensionDecision({ ...base, workTokens: 1_000 }), false, 'the crossing is strict');
  assert.equal(budgetExtensionDecision({ ...base, granted: 8 }), false, 'steps run out');
  // Run 480's shape: twenty-one reads and two edits earns nothing, and neither does motion
  // nobody verified.
  assert.equal(budgetExtensionDecision({ ...base, editsSinceBoundary: 1 }), false);
  assert.equal(budgetExtensionDecision({ ...base, checkPassedSinceBoundary: false }), false);
});

test('boundaryCheckDecision fires exactly where the extension decision is one verdict short', () => {
  const base = {
    enabled: true, workTokens: 1_100, tokenCap: 1_000, step: 400_000, limit: 8, granted: 0,
    solved: false, editsSinceBoundary: 2, checkPassedSinceBoundary: false, canCheck: true,
  };
  assert.equal(boundaryCheckDecision(base), true);
  // The asymmetry with the grant predicate is the whole mechanism: the boundary check runs
  // BECAUSE there is no passing verdict, and stays out of the way once there is one.
  assert.equal(boundaryCheckDecision({ ...base, checkPassedSinceBoundary: true }), false);
  assert.equal(boundaryCheckDecision({ ...base, enabled: false }), false);
  assert.equal(boundaryCheckDecision({ ...base, canCheck: false }), false, 'a repo with no build gate cannot self-verify');
  assert.equal(boundaryCheckDecision({ ...base, solved: true }), false, 'a submitted run is not extended');
  assert.equal(boundaryCheckDecision({ ...base, editsSinceBoundary: 1 }), false, 'a reading loop is not verified into a grant');
  assert.equal(boundaryCheckDecision({ ...base, granted: 8 }), false);
  // Step 0 disables the whole mechanism, the boundary check included: with no extension to
  // earn, there is nothing for a verdict at the crossing to decide.
  assert.equal(boundaryCheckDecision({ ...base, step: 0 }), false);
});

test('the policy refuses a configuration that could outrun the hard outer bound', () => {
  const policy = resolveBudgetPolicy({});
  assert.equal(policy.baseTokenCap, 800_000);
  assert.equal(policy.extensionStep, 400_000);
  assert.equal(policy.extensionLimit, 8);
  assert.equal(policy.boundaryCheck, true);
  assert.equal(policy.submitRehearsal, false, 'ADR-0167 keeps the rehearsal opt-in until a live firing validates it');
  assert.equal(ADR_0167_DEFAULTS.hardOuterBound, 5_000_000);
  // 800k base plus eight 400k steps is 4,000,000, inside the bound. Ten 500k steps is not,
  // and it is refused at configuration time rather than at the tenth grant.
  assert.throws(() => resolveBudgetPolicy({ extensionStep: 500_000, extensionLimit: 10 }), /must not be able to exceed 5000000/);
  assert.throws(() => resolveBudgetPolicy({ extensionLimit: 11 }), /extensionLimit must be an integer from 0 to 10/);
});

test('the per-exam cap override outranks the tier, and a run override outranks both', () => {
  const policy = resolveBudgetPolicy({});
  assert.equal(tokenCapForExam({ scopeTier: 'S' }, policy), 450_000);
  assert.equal(tokenCapForExam({ scopeTier: 'M' }, policy), 800_000);
  assert.equal(tokenCapForExam({ scopeTier: 'S', workTokenCap: 600_000 }, policy), 600_000);
  assert.equal(tokenCapForExam({ scopeTier: 'S', workTokenCap: 600_000 }, policy, 900_000), 900_000);
});

test('the boundary check verifies an unchecked sprint itself: pass grants the extension and the work survives', async () => {
  // r1: edit 1 -> 2, the forced first-edit check FAILS (no snapshot, no passed-check flag).
  // r2: edit 2 -> 3, still under the cap: an unchecked two-edit sprint now exists.
  // r3: a read crosses the 1000 cap with two edits and no passing verdict since the
  //     boundary. The old policy refuses on hygiene; the boundary check runs the harness
  //     check itself, PASSES, snapshots value 3, and the extension to 1500 is granted.
  // r4: edit 3 -> 4 crosses 1500 with nothing verified since the new boundary: refused,
  //     sealed, rolled back to the boundary's snapshot. The unchecked sprint survived; the
  //     genuinely unverified tail did not.
  const worktree = memoryWorktree('1');
  const checks = checkAfter(1);
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 10, value: '2' },
    { kind: 'edit', tokens: 200, value: '3' },
    { kind: 'read', tokens: 900 },
    { kind: 'edit', tokens: 600, value: '4' },
  ], worktree);

  const result = await runStudentLoop({
    engineer,
    checkBuild: checks.check,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy(LOOP_POLICY),
    tokenCap: 1_000,
  });

  const boundary = result.buildChecks.find((entry) => entry.trigger === 'extension-boundary');
  assert.ok(boundary, 'the boundary check must be recorded in buildChecks');
  assert.equal(boundary.status, 'pass');
  assert.equal(boundary.round, 3);
  // The ONLY passing verdict in the whole run is the boundary's own.
  assert.deepEqual(
    result.buildChecks.map((entry) => `${entry.trigger}:${entry.status}`),
    ['first-edit:fail', 'extension-boundary:pass'],
  );
  assert.deepEqual(result.extensions, [{ round: 3, extension: 1, newCap: 1_500, workTokens: 1_110 }]);
  assert.equal(result.usage.extensionsGranted, 1);
  assert.equal(result.usage.workTokenCap, 1_500);
  assert.equal(result.status, 'sealed');
  assert.equal(result.sealedState, 'rolled-back-to-verified');
  assert.equal(result.discardedEdits, 1);
  assert.equal(result.lastVerifiedRound, 3);
  // The sprint the boundary check verified survives the seal; the unverified tail dies.
  assert.equal(result.state, '3');
  assert.equal(worktree.state.value, '3');
  assert.deepEqual(worktree.state.restores, ['3']);
});

test('control: the same run with the boundary check off is never extended and seals unverified', async () => {
  const worktree = memoryWorktree('1');
  const checks = checkAfter(1);
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 10, value: '2' },
    { kind: 'edit', tokens: 200, value: '3' },
    { kind: 'read', tokens: 900 },
    { kind: 'edit', tokens: 600, value: '4' },
  ], worktree);

  const result = await runStudentLoop({
    engineer,
    checkBuild: checks.check,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy({ ...LOOP_POLICY, boundaryCheck: false }),
    tokenCap: 1_000,
  });

  assert.equal(result.usage.extensionsGranted, 0, 'no verdict, no grant');
  assert.deepEqual(result.extensions, []);
  assert.equal(result.rounds, 3, 'the run ends at the crossing instead of continuing into round 4');
  assert.equal(result.lastVerifiedRound, null, 'nothing in this run was ever build-verified');
  assert.equal(result.sealedState, 'current', 'so the sealed state is the unverified one');
  assert.equal(result.state, '3');
  assert.deepEqual(worktree.state.restores, [], 'no rollback happened, because there was no verified peak to return to');
});

test('the boundary check that FAILS leaves the refusal standing over condemned work', async () => {
  // The other half of the ADR's branch, observed live in the natural-stop loop: the harness
  // verifies the unchecked sprint itself and it does NOT compile, so no extension is granted
  // and the seal returns to the last verified peak. The refusal stands, honestly, over work
  // that was condemned rather than merely unverified.
  //
  // One run holding BOTH branches, which is how the loop observed them:
  // r1: edit 1 -> 2, forced first-edit check PASSES: verified peak at '2', round 1.
  // r2: edit 2 -> 3. Two edits and a passing verdict since the boundary.
  // r3: a read crosses the 1000 cap. Verified progress exists, so the extension to 1500 is
  //     GRANTED without the boundary check needing to run at all, and the boundary resets.
  // r4, r5: edits 3 -> 4 -> 5, unverified since the new boundary.
  // r6: a read crosses 1500. NOW the boundary check runs, and this time it FAILS: no second
  //     grant, and the seal returns to the verified peak at '2', discarding all three
  //     unverified edits.
  const worktree = memoryWorktree('1');
  let calls = 0;
  const checkBuild = async () => {
    calls += 1;
    const status = calls === 1 ? 'pass' : 'fail';
    return { status, exitCode: status === 'pass' ? 0 : 65, diagnostics: status === 'pass' ? [] : ['boom', 'bang'] };
  };
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 100, value: '2' },
    { kind: 'edit', tokens: 100, value: '3' },
    { kind: 'read', tokens: 900 },
    { kind: 'edit', tokens: 100, value: '4' },
    { kind: 'edit', tokens: 100, value: '5' },
    { kind: 'read', tokens: 300 },
  ], worktree);

  const result = await runStudentLoop({
    engineer,
    checkBuild,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy(LOOP_POLICY),
    tokenCap: 1_000,
  });

  const boundary = result.buildChecks.find((entry) => entry.trigger === 'extension-boundary');
  assert.ok(boundary, 'the boundary check must run before the refusal, or the refusal is on hygiene again');
  assert.equal(boundary.status, 'fail');
  assert.equal(boundary.round, 6);
  assert.equal(boundary.diagnostics, 2, 'the failing verdict carries its diagnostics count');
  // The GRANT and the REFUSAL, in one run: one extension earned by verified progress, and
  // no second one over work the harness checked and found broken.
  assert.deepEqual(result.extensions, [{ round: 3, extension: 1, newCap: 1_500, workTokens: 1_100 }]);
  assert.equal(result.usage.extensionsGranted, 1);
  assert.equal(result.usage.workTokenCap, 1_500, 'the cap moved once and then stopped');
  assert.equal(result.usage.capEvents, 1);
  assert.equal(result.status, 'sealed');
  assert.equal(result.sealedState, 'rolled-back-to-verified');
  assert.equal(result.discardedEdits, 3, 'every unverified edit is discarded, and the count says how many');
  assert.equal(result.lastVerifiedRound, 1);
  assert.equal(result.state, '2');
  assert.deepEqual(worktree.state.restores, ['2']);
});

test('step 0 disables extensions entirely, boundary check included', async () => {
  // The ADR's own off switch, at the ADR's own constant. A port that keeps the branches and
  // loses this has no way to run the pre-ADR-0167 configuration for comparison.
  // The script is the boundary test's own, INCLUDING its failing first-edit check, so the
  // crossing at round 3 satisfies every boundary-check condition except the step. Without
  // that, "no boundary check ran" would be true for a reason unrelated to step 0, and the
  // assertion below would pass on a runner that had lost the switch entirely.
  const worktree = memoryWorktree('1');
  const checks = checkAfter(1);
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 10, value: '2' },
    { kind: 'edit', tokens: 200, value: '3' },
    { kind: 'read', tokens: 900 },
    { kind: 'edit', tokens: 600, value: '4' },
  ], worktree);

  const result = await runStudentLoop({
    engineer,
    checkBuild: checks.check,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy({ ...LOOP_POLICY, extensionStep: 0 }),
    tokenCap: 1_000,
  });

  assert.equal(result.usage.extensionsGranted, 0);
  assert.deepEqual(result.extensions, []);
  assert.equal(result.usage.workTokenCap, 1_000);
  assert.equal(result.buildChecks.filter((entry) => entry.trigger === 'extension-boundary').length, 0,
    'with extensions off there is no crossing to verify, so the boundary check does not run either');
  assert.equal(result.rounds, 3, 'the run ends at the crossing');
});

test('the ADR constants are the shipped defaults, not merely the shipped branches', () => {
  // A runner with the right branches and the wrong constants is not the ADR's defaults.
  assert.equal(ADR_0167_DEFAULTS.extensionStep, 400_000);
  assert.equal(ADR_0167_DEFAULTS.extensionLimit, 8);
  assert.equal(ADR_0167_DEFAULTS.hardOuterBound, 5_000_000);
  assert.equal(ADR_0167_DEFAULTS.baseTokenCap, 800_000);
  assert.equal(ADR_0167_DEFAULTS.boundaryCheck, true);
  assert.equal(ADR_0167_DEFAULTS.submitRehearsal, false);
  assert.equal(ADR_0167_DEFAULTS.progressEdits, 2);
  // ADR-0147's constants, ported with the same discipline: the fraction and the delivery
  // bound are the mechanism, and a port with the right branches and a 0.5 fraction is a
  // different treatment wearing the same name.
  assert.equal(ADR_0167_DEFAULTS.preSealFraction, 0.85);
  assert.equal(ADR_0167_DEFAULTS.preSealMaxDeliveries, 2);
  assert.equal(resolveBudgetPolicy({ preSealFraction: null }).preSealFraction, null, 'null disables it');
  assert.throws(() => resolveBudgetPolicy({ preSealFraction: 0.99 }), /must be a number from 0.1 to 0.95/);
  assert.throws(() => resolveBudgetPolicy({ preSealFraction: 0 }), /must be a number from 0.1 to 0.95/);
  // 800,000 plus eight steps of 400,000 is 4,000,000, which is the headroom the outer bound
  // is meant to leave. One more step at the same size would exceed it and is refused.
  const shipped = resolveBudgetPolicy({});
  assert.equal(shipped.baseTokenCap + shipped.extensionStep * shipped.extensionLimit, 4_000_000);
  assert.throws(() => resolveBudgetPolicy({ extensionLimit: 10, extensionStep: 450_000 }), /must not be able to exceed 5000000/);
  assert.equal(resolveBudgetPolicy({ extensionStep: 0 }).extensionStep, 0, 'step 0 is a legal configuration, not a validation error');
});

test('the pre-seal check delivers a last verdict while the student can still act on it', async () => {
  // ADR-0147, exp4's twice-observed failure: a run sealing over edits nobody checked, with
  // budget still on the clock to fix them. At 0.85 of the cap with unverified edits, the
  // harness runs the check and DELIVERS the failure, which is the whole difference between
  // this check and the boundary check.
  const worktree = memoryWorktree('1');
  let calls = 0;
  const checkBuild = async () => {
    calls += 1;
    // r1's forced first-edit check passes; the pre-seal check at r3 fails; the re-check after
    // the fix passes.
    const status = calls === 2 ? 'fail' : 'pass';
    return { status, exitCode: status === 'pass' ? 0 : 65, diagnostics: status === 'pass' ? [] : ['boom', 'bang'] };
  };
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 100, value: '2' },
    { kind: 'edit', tokens: 760, value: '3' },
    { kind: 'check', tokens: 10 },
    { kind: 'submit', tokens: 10, explanation: 'fixed after the pre-seal warning' },
  ], worktree);

  const result = await runStudentLoop({
    engineer,
    checkBuild,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy({ ...LOOP_POLICY, preSealFraction: 0.85, extensionStep: 0 }),
    tokenCap: 1_000,
  });

  const preSeal = result.buildChecks.find((entry) => entry.trigger === 'pre-seal');
  assert.ok(preSeal, 'the pre-seal check must be recorded');
  assert.equal(preSeal.round, 2, 'it fires at 0.85 of the cap, before the crossing');
  assert.equal(preSeal.status, 'fail');
  assert.equal(result.preSealBuildCheck, 'delivered');
  assert.equal(result.preSealDeliveries, 1);
  // DELIVERED, which is the point: the student was told, in time to act, and did.
  assert.match(engineer.seen[2].message, /PRE-SEAL CHECK/);
  assert.match(engineer.seen[2].message, /unverified edits are discarded when the budget seals/);
  assert.equal(result.status, 'submitted');
});

test('the pre-seal check stays silent when there is nothing unverified to warn about', async () => {
  const worktree = memoryWorktree('1');
  const checks = checkAfter(0);
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 900, value: '2' },
    { kind: 'submit', tokens: 10, explanation: 'all verified' },
  ], worktree);
  const result = await runStudentLoop({
    engineer,
    checkBuild: checks.check,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy({ ...LOOP_POLICY, preSealFraction: 0.85, extensionStep: 0 }),
    tokenCap: 1_000,
  });
  // The first-edit check already assessed the only edit, so a pre-seal check would spend
  // gate time telling the student what it already knows.
  assert.equal(result.buildChecks.filter((entry) => entry.trigger === 'pre-seal').length, 0);
  assert.equal(result.preSealBuildCheck, 'not-reached');

  // And 'not-reached' is a different fact from 'disabled', which is why the field is not a
  // boolean: an artifact that cannot tell those apart cannot say whether a treatment landed.
  const disabled = await runStudentLoop({
    engineer: scriptedEngineer([{ kind: 'edit', tokens: 900, value: '2' }, { kind: 'submit', tokens: 10, explanation: 'x' }], memoryWorktree('1')),
    checkBuild: checkAfter(0).check,
    snapshotState: async () => 'x',
    restoreState: async () => {},
    policy: resolveBudgetPolicy({ ...LOOP_POLICY, preSealFraction: null }),
    tokenCap: 1_000,
  });
  assert.equal(disabled.preSealBuildCheck, null);
});

test('the pre-seal check is bounded, and after it is spent the boundary check still fires', async () => {
  // THE DEAD-COVERAGE QUESTION, asked directly: with BOTH campaign defaults on, does the
  // boundary check ever run, or does the pre-seal check always get there first? If the
  // answer were never, ADR-0167's boundary check would be dead coverage in the shipped
  // configuration, which is the exact condition ground rule 5 forbids.
  //
  // It is not dead. The pre-seal check is bounded to its deliveries; a sprint after they are
  // spent reaches the crossing unchecked, and the boundary check is what verifies it there.
  const worktree = memoryWorktree('1');
  const checkBuild = async () => ({ status: 'fail', exitCode: 65, diagnostics: ['boom'] });
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 100, value: '2' },   // forced first-edit check, fails
    { kind: 'edit', tokens: 760, value: '3' },   // crosses 0.85: pre-seal delivery 1
    { kind: 'edit', tokens: 10, value: '4' },    // re-arms: pre-seal delivery 2
    { kind: 'edit', tokens: 10, value: '5' },    // deliveries spent, nothing checks this
    { kind: 'read', tokens: 200 },               // crosses the cap: the boundary check runs
  ], worktree);

  const result = await runStudentLoop({
    engineer,
    checkBuild,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy({ ...LOOP_POLICY, preSealFraction: 0.85, preSealMaxDeliveries: 2 }),
    tokenCap: 1_000,
  });

  const triggers = result.buildChecks.map((entry) => entry.trigger);
  assert.deepEqual(triggers, ['first-edit', 'pre-seal', 'pre-seal', 'extension-boundary'],
    'both mechanisms fire, in their own conditions, in the shipped configuration');
  assert.equal(result.preSealDeliveries, 2, 'bounded: a third delivery never happens');
  assert.equal(result.buildChecks.filter((entry) => entry.trigger === 'pre-seal').length, 2);
  // Every verdict failed, so no extension is earned and the run seals honestly.
  assert.equal(result.usage.extensionsGranted, 0);
});

test('a reading loop crosses the cap and dies there, with no row-worthy diff', async () => {
  const worktree = memoryWorktree('1');
  const checks = checkAfter(0);
  const engineer = scriptedEngineer([
    { kind: 'read', tokens: 400 },
    { kind: 'read', tokens: 400 },
    { kind: 'read', tokens: 400 },
  ], worktree);

  await assert.rejects(
    runStudentLoop({
      engineer,
      checkBuild: checks.check,
      snapshotState: worktree.snapshotState,
      restoreState: worktree.restoreState,
      policy: resolveBudgetPolicy(LOOP_POLICY),
      tokenCap: 1_000,
    }),
    (error) => {
      assert.ok(isBoundedStudentFailure(error), 'a cap-death is a bounded measurement, not a crash');
      assert.match(error.message, /work token cap exceeded \(1200\/1000\)/);
      assert.equal(error.studentResult.status, 'cap-death');
      assert.equal(error.studentResult.usage.extensionsGranted, 0);
      assert.equal(error.studentResult.buildChecks.length, 0, 'no edit, so no check ever ran');
      return true;
    },
  );
});

test('a checked and failed final state is the student own and never rolls back', async () => {
  // The distinction the two seal counters exist for: the student saw a failing verdict on
  // its last edits and chose to continue, so the harness ships what the student chose.
  const worktree = memoryWorktree('1');
  let call = 0;
  const checkBuild = async () => {
    call += 1;
    // Round 1's forced check passes (snapshot at '2'); round 3's voluntary check fails.
    const status = call === 1 ? 'pass' : 'fail';
    return { status, exitCode: status === 'pass' ? 0 : 1, diagnostics: [] };
  };
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 100, value: '2' },
    { kind: 'edit', tokens: 100, value: '3' },
    { kind: 'check', tokens: 100 },
    { kind: 'read', tokens: 800 },
  ], worktree);

  const result = await runStudentLoop({
    engineer,
    checkBuild,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    // Extensions off (step 0) so the crossing seals rather than being funded: this test is
    // about which state the seal keeps, and a grant would move that question to round 8.
    policy: resolveBudgetPolicy({ ...LOOP_POLICY, boundaryCheck: false, extensionStep: 0 }),
    tokenCap: 1_000,
  });
  assert.equal(result.sealedState, 'current');
  assert.equal(result.state, '3', 'the failed-but-seen state ships');
  assert.equal(result.discardedEdits, 0);
  assert.deepEqual(worktree.state.restores, []);
});

test('the submit rehearsal refuses a failing voluntary submit once, then the fix is accepted', async () => {
  const worktree = memoryWorktree('1');
  const gateRuns = [];
  const submitRehearsal = async () => {
    gateRuns.push(worktree.state.value);
    return worktree.state.value === '3'
      ? [{ id: 'lint', status: 'pass' }, { id: 'test', status: 'pass' }]
      : [{ id: 'lint', status: 'pass' }, { id: 'test', status: 'fail' }];
  };
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 10, value: '2' },
    { kind: 'submit', tokens: 10, explanation: 'first attempt' },
    { kind: 'edit', tokens: 10, value: '3' },
    { kind: 'submit', tokens: 10, explanation: 'fixed the failing gate' },
  ], worktree);

  const result = await runStudentLoop({
    engineer,
    checkBuild: checkAfter(0).check,
    submitRehearsal,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy({ ...LOOP_POLICY, submitRehearsal: true }),
    tokenCap: 1_000,
  });

  assert.equal(gateRuns.length, 1, 'the rehearsal happens once, and the second submission stands');
  assert.equal(result.rehearsals[0].failures[0], 'test');
  // The student was told, in the harness message, what its judge said, while it could still act.
  assert.match(engineer.seen[2].message, /SUBMIT REHEARSAL/);
  assert.match(engineer.seen[2].message, /test/);
  assert.equal(result.status, 'submitted');
  assert.equal(result.state, '3');
  assert.equal(result.explanation, 'fixed the failing gate');
});

test('with the rehearsal off, the same failing submission is accepted immediately', async () => {
  const worktree = memoryWorktree('1');
  let rehearsalRuns = 0;
  const engineer = scriptedEngineer([
    { kind: 'edit', tokens: 10, value: '2' },
    { kind: 'submit', tokens: 10, explanation: 'first attempt' },
  ], worktree);
  const result = await runStudentLoop({
    engineer,
    checkBuild: checkAfter(0).check,
    submitRehearsal: async () => { rehearsalRuns += 1; return [{ id: 'test', status: 'fail' }]; },
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy(LOOP_POLICY),
    tokenCap: 1_000,
  });
  assert.equal(rehearsalRuns, 0, 'opt-in means off by default');
  assert.equal(result.state, '2');
  assert.equal(result.rehearsals.length, 0);
});

test('a submit with no validated edit is refused and told why, rather than sealing an empty diff', async () => {
  const worktree = memoryWorktree('1');
  const engineer = scriptedEngineer([
    { kind: 'submit', tokens: 10, explanation: 'nothing done' },
    { kind: 'edit', tokens: 10, value: '2' },
    { kind: 'submit', tokens: 10, explanation: 'now there is something' },
  ], worktree);
  const result = await runStudentLoop({
    engineer,
    checkBuild: checkAfter(0).check,
    snapshotState: worktree.snapshotState,
    restoreState: worktree.restoreState,
    policy: resolveBudgetPolicy(LOOP_POLICY),
    tokenCap: 1_000,
  });
  assert.match(engineer.seen[1].message, /No validated edit exists/);
  assert.equal(result.state, '2');
  assert.equal(result.rounds, 3);
});

test('a run that never submits ends as a bounded failure naming the round limit', async () => {
  const worktree = memoryWorktree('1');
  const engineer = scriptedEngineer([{ kind: 'edit', tokens: 1, value: '2' }], worktree);
  await assert.rejects(
    runStudentLoop({
      engineer,
      checkBuild: null,
      snapshotState: worktree.snapshotState,
      restoreState: worktree.restoreState,
      policy: resolveBudgetPolicy({ ...LOOP_POLICY, maxRounds: 3 }),
      tokenCap: 1_000,
    }),
    (error) => {
      assert.ok(error instanceof BoundedStudentFailure);
      assert.match(error.message, /did not submit a solution within 3 rounds/);
      assert.equal(error.studentResult.status, 'no-submission');
      return true;
    },
  );
});
