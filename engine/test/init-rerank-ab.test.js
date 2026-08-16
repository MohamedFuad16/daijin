// The D-0025 rerank A/B, judged per D-0017.
//
// Hermetic: the score function is injected, so these tests exercise the A/B's own logic
// (arm separation, judgment, resolution) without a model, a store or a backend. The
// plumbing test at the end uses a deterministic stub reranker through the REAL harness
// seam, which is the most that can be run until a llama-server exists on this machine.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TOP_KS, discriminatingRange, judgeRerank, permuteAnswers, rerankAB,
} from '../src/init/rerank-ab.js';

const rate = (hits, total) => ({ exact: hits / total, cases: `${hits} of ${total}`, hits, total });

/** A score double that answers from a table keyed by arm, so a test states its own result. */
function scoreDouble(table) {
  const calls = [];
  const score = async ({ retrieveOptions, reranker, label }) => {
    const enabled = retrieveOptions?.rerank?.enabled === true;
    const topK = retrieveOptions?.rerank?.topK ?? null;
    calls.push({ enabled, topK, tokenBudget: retrieveOptions.tokenBudget, backend: reranker?.id ?? null, label });
    const key = `${retrieveOptions.tokenBudget}:${enabled ? topK : 'off'}`;
    const row = table[key];
    if (!row) throw new Error(`no result configured for ${key}`);
    return {
      summary: { cases: row.total, caseRate: row.hits / row.total, mrr: row.mrr, violations: row.violations ?? 0, identifierCaseRate: 1, identifierCases: 1 },
      results: Array.from({ length: row.total }, (unused, index) => ({ id: `g${index}`, complete: index < row.hits })),
      // The harness's own arm disclosure, which the A/B verifies rather than assumes.
      record: {
        rerank: enabled ? { enabled: true, topK, backend: reranker?.id ?? null } : { enabled: false },
        results: Array.from({ length: row.total }, (unused, index) => ({
          id: `g${index}`,
          hits: index < row.hits ? 1 : 0,
          required: 1,
          complete: index < row.hits,
          // The rank moves under the treatment even where the outcome does not.
          reciprocalRank: index < row.hits ? (enabled ? (row.rr ?? 1) : 1) : 0,
          misses: index < row.hits ? [] : ['x'],
          violations: [],
        })),
      },
    };
  };
  return { score, calls };
}

const stubReranker = { id: 'stub:deterministic', async rerank(query, documents) { return documents.map((unused, index) => -index); } };

test('the arms differ by ONE option: both receive the backend, only one enables it', async () => {
  const { score, calls } = scoreDouble({
    '3000:off': { hits: 10, total: 20, mrr: 0.5 },
    '3000:10': { hits: 10, total: 20, mrr: 0.5 },
    '3000:20': { hits: 10, total: 20, mrr: 0.5 },
  });
  await rerankAB({ corpus: { retrieveOptions: {} }, store: {}, reranker: stubReranker, budgets: [3000], score });
  assert.equal(calls.length, 3, 'one control plus one treatment per topK');
  assert.ok(
    calls.every((call) => call.backend === 'stub:deterministic'),
    'the control receives the backend too; an A/B whose arms differ by which dependencies were wired compares two programs',
  );
  assert.deepEqual(calls.map((call) => call.enabled), [false, true, true]);
  assert.deepEqual(calls.map((call) => call.topK), [null, 10, 20]);
});

test('a control arm that reranked anyway is refused rather than reported', async () => {
  const score = async ({ retrieveOptions }) => ({
    summary: { cases: 4, caseRate: 1, mrr: 1, violations: 0, identifierCaseRate: 1, identifierCases: 1 },
    results: [{ complete: true }, { complete: true }, { complete: true }, { complete: true }],
    // The harness says this arm reranked, whatever the caller asked for.
    record: { rerank: { enabled: true, topK: 40, backend: 'x' } },
  });
  await assert.rejects(
    () => rerankAB({ corpus: {}, store: {}, reranker: stubReranker, budgets: [3000], score }),
    /control arm reported rerank enabled/,
  );
});

test('a treatment arm whose option never reached the stage is refused', async () => {
  const score = async ({ retrieveOptions }) => ({
    summary: { cases: 4, caseRate: 1, mrr: 1, violations: 0, identifierCaseRate: 1, identifierCases: 1 },
    results: [{ complete: true }, { complete: true }, { complete: true }, { complete: true }],
    record: { rerank: { enabled: false } },
  });
  await assert.rejects(
    () => rerankAB({ corpus: {}, store: {}, reranker: stubReranker, budgets: [3000], topKs: [40], score }),
    /did not report reranking; the option did not reach the stage/,
  );
});

test('judgment is D-0017: case rate and violations decide, MRR never promotes', () => {
  const control = { caseRate: rate(20, 34), mrr: 0.5, violations: 0 };

  const win = judgeRerank(control, { caseRate: rate(22, 34), mrr: 0.4, violations: 0 });
  assert.equal(win.verdict, 'win');
  assert.equal(win.caseDelta, 2);
  assert.ok(win.mrrDelta < 0, 'MRR fell and the win still stands, because MRR is not a criterion');

  // The 2026-08-09 shape, inverted into an A/B: case rate falls one case while MRR rises.
  const regression = judgeRerank(control, { caseRate: rate(19, 34), mrr: 0.9, violations: 0 });
  assert.equal(regression.verdict, 'regression', 'an MRR-led judgment would have promoted this');
  assert.match(regression.summary, /LOSES/);

  const violation = judgeRerank(control, { caseRate: rate(21, 34), mrr: 0.9, violations: 1 });
  assert.equal(violation.verdict, 'regression', 'a new must-not violation is a loss whatever the case rate did');

  const neutral = judgeRerank(control, { caseRate: rate(20, 34), mrr: 0.7, violations: 0 });
  assert.equal(neutral.verdict, 'neutral', 'holding the enforced metric is what the knob does when it does nothing');
  assert.match(neutral.mrrMovement, /never a promotion criterion/);
});

test('the A/B can report a LOSS and a NEUTRAL, not only a win', async () => {
  const loss = scoreDouble({
    '3000:off': { hits: 20, total: 25, mrr: 0.6 },
    '3000:40': { hits: 18, total: 25, mrr: 0.9 },
  });
  const lost = await rerankAB({ corpus: {}, store: {}, reranker: stubReranker, budgets: [3000], topKs: [40], score: loss.score });
  assert.equal(lost.verdict, 'regression');
  assert.match(lost.conclusion, /REGRESSES.*stays off and the number is the deliverable/);

  const flat = scoreDouble({
    '3000:off': { hits: 20, total: 25, mrr: 0.6 },
    '3000:40': { hits: 20, total: 25, mrr: 0.61 },
  });
  const neutral = await rerankAB({ corpus: {}, store: {}, reranker: stubReranker, budgets: [3000], topKs: [40], score: flat.score });
  assert.equal(neutral.verdict, 'neutral');
  assert.match(neutral.conclusion, /measured-neutral.*knob ships off and documented as neutral here, per D-0025/);
});

test('permuteAnswers builds a deterministic control where every answer is wrong', () => {
  const cases = [
    { id: 'g001', query: 'a', must_return: ['u1'], must_not_outrank: ['u2'], provenance: 'structural:a' },
    { id: 'g002', query: 'b', must_return: ['u2'], provenance: 'structural:b' },
    { id: 'g003', query: 'c', must_return: ['u3'], provenance: 'structural:c' },
  ];
  const permuted = permuteAnswers(cases);
  assert.equal(permuted.length, 3);
  for (const [index, entry] of permuted.entries()) {
    assert.notDeepEqual(entry.must_return, cases[index].must_return, 'every answer is deliberately wrong');
    assert.equal(entry.query, cases[index].query, 'the queries are untouched: only the answers move');
    assert.equal(entry.must_not_outrank, undefined, 'a ranking constraint against a now-wrong answer means nothing');
  }
  assert.deepEqual(permuteAnswers(cases), permuted, 'deterministic, so the control is re-derivable');
  assert.throws(() => permuteAnswers([{ id: 'g1', query: 'q', must_return: ['only'] }]), /at least two distinct answers/);
});

test('the discriminating range says how large an effect the gauge could have seen', () => {
  // The portfolio-mine measurement, as numbers: a permuted gold set still scored 18 of 25.
  const range = discriminatingRange(
    { caseRate: rate(25, 25), mrr: 0.96 },
    { caseRate: rate(18, 25), mrr: 0.1365 },
  );
  assert.equal(range.caseRate.range, 0.28);
  assert.equal(range.caseRate.casesOfHeadroom, 7, 'seven cases is the whole room a rerank had to move in');
  assert.ok(range.mrr.range > 0.8, 'order still separates cleanly where presence does not');
});

test('the resolution measurement runs on the same store and rides with the result', async () => {
  const { score } = scoreDouble({
    '3000:off': { hits: 25, total: 25, mrr: 0.96 },
    '3000:40': { hits: 25, total: 25, mrr: 0.97 },
  });
  // The control corpus points at the permuted gold set; the double keys only on budget and
  // arm, so it returns the same row, which is enough to prove the wiring and the shape.
  const result = await rerankAB({
    corpus: { retrieveOptions: {} },
    controlCorpus: { retrieveOptions: {} },
    store: {},
    reranker: stubReranker,
    budgets: [3000],
    topKs: [40],
    score,
  });
  assert.ok(result.resolution, 'the range is reported alongside the verdict, never separately');
  assert.equal(result.resolution.caseRate.candidate, '25 of 25');
  assert.equal(result.verdict, 'neutral');
});

test('topK sweeps because it decides how much of the ranking the rerank can touch', async () => {
  assert.deepEqual([...DEFAULT_TOP_KS], [10, 20]);
  const { score, calls } = scoreDouble({
    '3000:off': { hits: 10, total: 20, mrr: 0.5 },
    '3000:20': { hits: 11, total: 20, mrr: 0.5 },
    '3000:40': { hits: 10, total: 20, mrr: 0.5 },
    '4000:off': { hits: 10, total: 20, mrr: 0.5 },
    '4000:20': { hits: 10, total: 20, mrr: 0.5 },
    '4000:40': { hits: 10, total: 20, mrr: 0.5 },
  });
  const result = await rerankAB({ corpus: {}, store: {}, reranker: stubReranker, budgets: [4000, 3000], topKs: [20, 40], score });
  assert.deepEqual(result.pairs.map((pair) => [pair.tokenBudget, pair.topK]), [[3000, 20], [3000, 40], [4000, 20], [4000, 40]]);
  assert.equal(result.pairs[0].judgment.verdict, 'win', 'topK 20 gained a case where topK 40 did not');
  assert.equal(result.pairs[1].judgment.verdict, 'neutral');
  assert.equal(result.verdict, 'win');
  assert.deepEqual(calls.map((call) => call.tokenBudget), [3000, 3000, 3000, 4000, 4000, 4000], 'ascending, like the floor sweep');
});

test('a missing backend is refused rather than measured as an off/off pair', async () => {
  await assert.rejects(
    () => rerankAB({ corpus: {}, store: {}, reranker: null, score: async () => ({}) }),
    /requires a reranker with a rerank\(query, documents\) method/,
  );
});

test('the knob reports its COST per query, which D-0025 requires displayed beside it', async () => {
  const { score } = scoreDouble({
    '3000:off': { hits: 10, total: 20, mrr: 0.5 },
    '3000:40': { hits: 11, total: 20, mrr: 0.5 },
  });
  const slow = async (options) => {
    if (options.retrieveOptions?.rerank?.enabled) await new Promise((resolve) => setTimeout(resolve, 40));
    return score(options);
  };
  const result = await rerankAB({ corpus: {}, store: {}, reranker: stubReranker, budgets: [3000], topKs: [40], score: slow });
  const pair = result.pairs[0];
  assert.equal(typeof pair.cost.msPerQuery, 'number');
  assert.ok(pair.cost.addedMsPerQuery >= 1, 'the reranked arm is measurably slower, and the number rides with the verdict');
  assert.ok(pair.treatment.msPerQuery >= pair.control.msPerQuery);
});

test('only the arm that actually paid the price reports one; the rest carry the caveat', async () => {
  // Live anomaly this encodes: topK 40 measured 15087 ms per query on its first arm and
  // 1491 on a later one. Identical work, tenfold difference, because the backend caches.
  const { score } = scoreDouble({
    '3000:off': { hits: 10, total: 20, mrr: 0.5 },
    '3000:40': { hits: 10, total: 20, mrr: 0.5 },
    '4000:off': { hits: 10, total: 20, mrr: 0.5 },
    '4000:40': { hits: 10, total: 20, mrr: 0.5 },
  });
  let seen = 0;
  const caching = async (options) => {
    if (options.retrieveOptions?.rerank?.enabled) {
      seen += 1;
      await new Promise((resolve) => setTimeout(resolve, seen === 1 ? 60 : 1));
    }
    return score(options);
  };
  const result = await rerankAB({ corpus: {}, store: {}, reranker: stubReranker, budgets: [3000, 4000], topKs: [40], score: caching });
  const [first, second] = result.pairs;
  assert.equal(first.cost.cold, true, 'the first arm to score this topK paid full price');
  assert.equal(first.cost.caveat, null);
  assert.equal(second.cost.cold, false);
  assert.match(second.cost.caveat, /understates the knob/);
  assert.ok(second.cost.msPerQuery < first.cost.msPerQuery, 'the warm arm is cheaper, which is the confound');
  // The headline price comes from the cold arm only.
  assert.equal(result.cost.topK40.msPerQuery, first.treatment.msPerQuery);
});

test('identical SUMMARIES do not pass as identical RUNS', () => {
  assert.deepEqual([...DEFAULT_TOP_KS], [10, 20], 'swept downward on the platform arm evidence');
});

test('a neutral verdict over arms that retrieved differently is reported as such', async () => {
  // The extractor measured this on the platform corpus: every summary field matched while
  // the retrieval-level differ found eighteen differences across seven cases. A runner
  // comparing only the headline would have called topK inert.
  const { score } = scoreDouble({
    '3000:off': { hits: 10, total: 20, mrr: 0.5 },
    '3000:20': { hits: 10, total: 20, mrr: 0.5, rr: 0.5 },
  });
  const result = await rerankAB({ corpus: {}, store: {}, reranker: stubReranker, budgets: [3000], topKs: [20], score });
  const pair = result.pairs[0];
  assert.equal(pair.judgment.verdict, 'neutral', 'the enforced metric did not move');
  assert.equal(pair.perCase.identical, false, 'but the runs were not the same');
  assert.ok(pair.perCase.differences > 0);
  assert.equal(result.movedWithoutScoring, 1, 'the report distinguishes "changed nothing" from "changed nothing that scored"');
});
