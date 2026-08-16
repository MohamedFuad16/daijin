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

test('MUTATION: a core cut by the per-candidate cap FAILS the gate and names the raise signal', () => {
  // The delivered text is the source trimmed the way the ranker trims it: cut at a token
  // boundary with the marker appended. The core is no longer present verbatim.
  const truncated = `Breadcrumb: Module: src/store\n\n${CORE.slice(0, 60)}\n[truncated]`;
  const survival = checkContentSurvival(
    [{ caseId: 'g001', entries: [{ id: UNIT.id, ordinal: 0, content: truncated }] }],
    { units: [UNIT], tokenBudget: 3000 },
  );
  assert.equal(survival.status, 'fail', 'this is the mechanical raise signal, and a gate that cannot report it is dead coverage');
  assert.equal(survival.truncatedAway.length, 1);
  assert.equal(survival.windowMissed.length, 0, 'the source HELD the core, so this is a budget outcome, not a chunking one');
  assert.match(survival.raiseSignal, /lost their type core to the per-candidate cap of 660 tokens at a 3000 token budget/);
  assert.equal(survival.truncatedAway[0].coreTokens, tokens(CORE).length);
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
