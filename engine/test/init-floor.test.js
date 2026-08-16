// The budget sweep, the choice rule, and the content-survival instrument.
//
// The choice rule is D-0003's and it is a COUNT comparison, so the tests below are written
// in cases rather than rates: at 25 cases one case is 0.04, and a rate tolerance sized to
// absorb one case is blind to the only regression class this project has on record.
import assert from 'node:assert/strict';
import test from 'node:test';

import { tokens } from '../src/rag/tokens.js';
import {
  BUDGET_SWEEP, MCP_UNLOCK_THRESHOLD, caseRateOf, checkContentSurvival, chooseBudget,
  localCorpus, mcpUnlock, sourceContentFor, sweepBudgets,
} from '../src/init/floor.js';

const point = (tokenBudget, hits, total = 25) => ({
  tokenBudget,
  caseRate: { exact: hits / total, cases: `${hits} of ${total}`, hits, total },
});

test('the sweep points are the four D-0003 named, with 4000 among them', () => {
  assert.deepEqual([...BUDGET_SWEEP], [3000, 4000, 6000, 8000]);
});

test('a case rate is stored as an exact rational WITH its counts', () => {
  const rate = caseRateOf({ cases: 34, caseRate: 31 / 34 }, Array.from({ length: 34 }, (unused, index) => ({ complete: index < 31 })));
  assert.equal(rate.exact, 0.9117647058823529);
  assert.equal(rate.cases, '31 of 34');
  assert.equal(rate.hits, 31);
  assert.equal(rate.total, 34);
});

test('the smallest budget within ONE CASE of the best wins', () => {
  const curve = [point(3000, 20), point(4000, 21), point(6000, 21), point(8000, 21)];
  const { chosen, best, rationale } = chooseBudget(curve);
  assert.equal(chosen.tokenBudget, 3000, '20 is within one case of 21, and the smaller budget is paid every round');
  assert.equal(best.tokenBudget, 4000);
  assert.match(rationale, /within one case of the best \(21 of 25 at 4000\)/);
});

test('two cases behind is NOT within one case', () => {
  const curve = [point(3000, 19), point(4000, 21), point(6000, 21), point(8000, 21)];
  const { chosen, rationale } = chooseBudget(curve);
  assert.equal(chosen.tokenBudget, 4000);
  assert.match(rationale, /the best measured score on this repo \(21 of 25\)/);
});

test('a flat curve chooses the smallest budget, and a curve that peaks late says so', () => {
  assert.equal(chooseBudget([point(3000, 9), point(4000, 9), point(6000, 9), point(8000, 9)]).chosen.tokenBudget, 3000);
  const late = chooseBudget([point(3000, 10), point(4000, 12), point(6000, 15), point(8000, 15)]);
  assert.equal(late.chosen.tokenBudget, 6000);
  assert.equal(late.best.tokenBudget, 6000, 'ties break toward the smaller budget because the curve is scanned ascending');
});

test('chooseBudget refuses an empty curve rather than inventing a default', () => {
  assert.throws(() => chooseBudget([]), /at least one measured point/);
});

test('sweepBudgets measures every point and reports the curve with counts', async () => {
  const measured = [];
  const score = async ({ retrieveOptions }) => {
    measured.push(retrieveOptions.tokenBudget);
    const hits = retrieveOptions.tokenBudget >= 6000 ? 3 : 2;
    return {
      summary: { cases: 4, caseRate: hits / 4, mrr: 0.5, violations: 0, hitRate: 0.6, identifierCases: 1, identifierCaseRate: 1 },
      results: Array.from({ length: 4 }, (unused, index) => ({ id: `g${index}`, complete: index < hits })),
      record: {},
    };
  };
  const sweep = await sweepBudgets({ corpus: { retrieveOptions: {} }, store: {}, score, budgets: [8000, 3000, 4000, 6000] });
  assert.deepEqual(measured, [3000, 4000, 6000, 8000], 'the sweep runs in ascending order so ties break small');
  assert.deepEqual(sweep.curve.map((entry) => [entry.tokenBudget, entry.caseRate.cases]), [
    [3000, '2 of 4'], [4000, '2 of 4'], [6000, '3 of 4'], [8000, '3 of 4'],
  ]);
  assert.equal(sweep.chosen, 3000, '2 of 4 is within one case of 3 of 4');
  assert.equal(sweep.best, 6000);
});

test('the MCP unlock threshold is 0.75 and the reason names the measurement', () => {
  assert.equal(MCP_UNLOCK_THRESHOLD, 0.75);
  const locked = mcpUnlock({ exact: 0.74, cases: '74 of 100', hits: 74, total: 100 });
  assert.equal(locked.unlocked, false);
  assert.match(locked.reason, /74 of 100 is below the 0.75 threshold/);
  const unlocked = mcpUnlock({ exact: 0.75, cases: '3 of 4', hits: 3, total: 4 });
  assert.equal(unlocked.unlocked, true, 'exactly at the threshold unlocks');
  assert.equal(unlocked.saturation, null, 'with no range measured there is nothing to warn about');
});

test('finding 80: the unlock carries the range, and the THRESHOLD is untouched', () => {
  const caseRate = { exact: 1, cases: '25 of 25', hits: 25, total: 25 };

  // A scrambled gold set that ALSO clears the bar: the decision carries no information.
  const worthless = mcpUnlock(caseRate, {
    resolution: { caseRate: { control: { exact: 0.76, cases: '19 of 25', hits: 19, total: 25 }, casesOfHeadroom: 6 } },
  });
  assert.equal(worthless.unlocked, true, 'the threshold stands; only what the reader is told changes');
  assert.match(worthless.saturation, /also clears the 0.75 threshold/);
  assert.match(worthless.saturation, /cannot tell this brain from a scrambled one/);

  // The portfolio-mine shape: control at 18 of 25 = 0.72, one case short of the threshold.
  const narrow = mcpUnlock(caseRate, {
    resolution: { caseRate: { control: { exact: 0.72, cases: '18 of 25', hits: 18, total: 25 }, casesOfHeadroom: 7 } },
  });
  assert.equal(narrow.unlocked, true);
  assert.match(narrow.saturation, /within one case of the 0.75 threshold/);
  assert.match(narrow.saturation, /7 case\(s\) of discriminating room, not the distance from zero/);

  // A gauge with real range says nothing extra: the warning is not decoration.
  const healthy = mcpUnlock(caseRate, {
    resolution: { caseRate: { control: { exact: 0.1, cases: '2 of 25', hits: 2, total: 25 }, casesOfHeadroom: 23 } },
  });
  assert.equal(healthy.saturation, null);
});

// --- content survival --------------------------------------------------------------

const CORE = 'Claim: the store area holds 3 source files.\nEvidence: import graph.\n\nFiles in this module:\n- src/store/a.js\n- src/store/b.js';
const UNIT = {
  id: 'daijin.architecture.src-store',
  type: 'architecture',
  core: CORE,
  content: `# Module: src/store\n\n${CORE}\n\n## Imports from\n\n- src/util (2 references)`,
  body: `${CORE}\n\n## Imports from\n\n- src/util (2 references)`,
  tags: [],
  path: '.daijin/brain/architecture/src-store.md',
  title: 'Module: src/store',
};

test('an intact delivery passes the survival check', () => {
  const survival = checkContentSurvival(
    [{ caseId: 'g001', entries: [{ id: UNIT.id, ordinal: 0, content: `Breadcrumb: Module: src/store\n\n${CORE}` }] }],
    { units: [UNIT], tokenBudget: 4000 },
  );
  assert.equal(survival.status, 'pass');
  assert.equal(survival.survival, '1 of 1');
  assert.equal(survival.raiseSignal, null);
});

test('MUTATION: a core cut short FAILS the gate, and the gate names WHICH constraint bit', () => {
  // Finding 82: the two causes imply opposite fixes. A unit truncated at the per-candidate
  // cap is too big and should be shortened; a unit truncated with the total budget spent was
  // already under the cap, and shortening it changes nothing. Reporting the cap as the cause
  // of a budget failure sends a user to do work that cannot help.
  const truncated = `Breadcrumb: Module: src/store\n\n${CORE.slice(0, 60)}\n[truncated]`;

  // Budget-bound: the delivered text is far under the 660 cap, so the cap did not bite.
  const budgetBound = checkContentSurvival(
    [{ caseId: 'g001', entries: [{ id: UNIT.id, ordinal: 0, content: truncated }], tokenCount: 2670, tokenBudget: 3000 }],
    { units: [UNIT], tokenBudget: 3000 },
  );
  assert.equal(budgetBound.status, 'fail');
  assert.equal(budgetBound.truncatedAway[0].boundBy, 'budget-exhausted');
  assert.match(budgetBound.raiseSignal, /TOTAL BUDGET exhausted, not by the per-candidate cap/);
  assert.match(budgetBound.raiseSignal, /a mean of 2670 of 3000 tokens was already spent/);
  assert.match(budgetBound.raiseSignal, /splitting these units is not/);
  assert.equal(budgetBound.truncatedAway[0].coreTokens, tokens(CORE).length);
  assert.equal(budgetBound.truncatedAway[0].nominalCap, 660, 'reported as NOMINAL: the applied allowance is min(remaining, cap)');

  // Cap-bound: a unit whose core genuinely exceeds one candidate slot. The source must
  // CONTAIN the core, or the event is a chunking miss rather than a trim.
  const bigCore = `Claim: oversized.\n${'alpha beta gamma delta '.repeat(200).trim()}`;
  const big = {
    ...UNIT,
    core: bigCore,
    content: `# Module: big\n\n${bigCore}`,
    body: bigCore,
    type: 'convention',
  };
  const capBound = checkContentSurvival(
    // Delivered text at the cap: 700 word tokens, above the 660 allowance, which is what
    // "the cap bit" looks like from outside the ranker.
    [{ caseId: 'g001', entries: [{ id: big.id, ordinal: 0, content: `${bigCore.split(/\s+/).slice(0, 700).join(' ')}\n[truncated]` }], tokenCount: 700, tokenBudget: 3000 }],
    { units: [big], tokenBudget: 3000 },
  );
  assert.equal(capBound.truncatedAway[0].boundBy, 'core-larger-than-slot', 'the core exceeds a slot at any budget');
  assert.match(capBound.raiseSignal, /core LARGER THAN ONE CANDIDATE SLOT/);
  assert.match(capBound.raiseSignal, /shortening the unit or raising the budget is the fix/);
});

test('events and distinct units are counted separately', () => {
  // One unit truncated on three queries is one thing to fix, not three. Reporting events as
  // units overstates the surface a user has to act on.
  const truncated = `Breadcrumb: Module: src/store\n\n${CORE.slice(0, 60)}\n[truncated]`;
  const survival = checkContentSurvival(
    ['g001', 'g002', 'g003'].map((caseId) => ({
      caseId, entries: [{ id: UNIT.id, ordinal: 0, content: truncated }], tokenCount: 2670, tokenBudget: 3000,
    })),
    { units: [UNIT], tokenBudget: 3000 },
  );
  assert.equal(survival.events.total, 3, 'three events');
  assert.equal(survival.events.units, 1, 'one unit');
  assert.deepEqual(survival.truncatedUnits, [UNIT.id]);
  assert.match(survival.raiseSignal, /3 event\(s\) across 1 unit\(s\)/);
});

test('a window that never held the core is reported as CHUNKING, not as a budget failure', () => {
  const otherWindow = 'Breadcrumb: Module: src/store > Imports from\n\n## Imports from\n\n- src/util (2 references)';
  const survival = checkContentSurvival(
    [{ caseId: 'g001', entries: [{ id: UNIT.id, ordinal: 1, content: otherWindow }] }],
    { units: [UNIT], tokenBudget: 3000 },
  );
  assert.equal(survival.status, 'pass', 'raising the budget would not fix this, so it must not fail the budget gate');
  assert.equal(survival.windowMissed.length, 1);
  assert.equal(survival.truncatedAway.length, 0);
});

test('the untrimmed source is the winning chunk for architecture and the document for everything else', () => {
  const chunks = new Map([[UNIT.id, [{ ordinal: 0, content: `Breadcrumb: x\n\n${CORE}` }, { ordinal: 1, content: 'other window' }]]]);
  assert.match(sourceContentFor(UNIT, { ordinal: 1 }, chunks), /other window/);
  assert.match(sourceContentFor(UNIT, { ordinal: -1 }, chunks), /Files in this module/, 'the identity beacon resolves to ordinal 0 content');
  const convention = { ...UNIT, type: 'convention' };
  assert.equal(sourceContentFor(convention, { ordinal: 0 }, chunks), convention.content);
});

test('a unit with no registered core is skipped rather than counted as surviving', () => {
  const survival = checkContentSurvival(
    [{ caseId: 'g001', entries: [{ id: 'unknown.unit', ordinal: 0, content: 'anything' }] }],
    { units: [UNIT], tokenBudget: 4000 },
  );
  assert.equal(survival.checked, 0);
  assert.equal(survival.survival, '0 of 0', 'inflating the denominator with unmeasurable entries would hide real losses');
});

// --- the harness seam ---------------------------------------------------------------

test('localCorpus carries no connection string at all', () => {
  const before = { ...process.env };
  const corpus = localCorpus({ id: 'fixture', project: 'default', goldsetPath: '/tmp/g.yaml' });
  assert.equal(corpus.databaseUrlEnv, undefined, 'a SQLite corpus has no database URL to name');
  assert.equal(corpus.retrievalFixesPath, null, 'curated fixes are per-corpus data a fresh repo has none of');
  assert.deepEqual({ ...process.env }, before, 'building a corpus descriptor touches nothing global');
});

test('the sweep hands the environment to the harness instead of lending process.env', async () => {
  // The earlier lend-and-restore was a race the moment two measurements overlap, and the
  // sweep runs four in a row. The environment now travels as an argument.
  const seen = [];
  const before = { ...process.env };
  const score = async ({ environment, retrieveOptions }) => {
    seen.push({ environment, tokenBudget: retrieveOptions.tokenBudget, envDuring: process.env.EMBEDDING_MODEL });
    return {
      summary: { cases: 2, caseRate: 1, mrr: 1, violations: 0, hitRate: 1, identifierCases: 1, identifierCaseRate: 1 },
      results: [{ id: 'g1', complete: true }, { id: 'g2', complete: true }],
      record: {},
    };
  };
  const environment = { EMBEDDING_MODEL: 'injected-only', EMBEDDING_DIM: '8' };
  await sweepBudgets({ corpus: { retrieveOptions: {} }, store: {}, score, budgets: [3000, 4000], environment });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((call) => call.environment.EMBEDDING_MODEL === 'injected-only'), 'every point receives it');
  assert.ok(seen.every((call) => call.envDuring === before.EMBEDDING_MODEL), 'and process.env is never written');
  assert.deepEqual({ ...process.env }, before);
});
