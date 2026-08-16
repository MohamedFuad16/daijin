import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { compareRecords } from '../src/init/compare-runs.js';
import { loadCorpus } from '../src/init/corpus.js';
import {
  assertIdsExist, floorBreaches, scoreCase, scoreGoldset, summarise, validateGoldset,
} from '../src/init/retrieval-score.js';
import { fakeEnvironment, fakeOllama, fakeStore, makeDocument } from './helpers/fixtures.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
process.env.DAIJIN_DEMO_ROOT = fixtures;
process.env.DAIJIN_DEMO_DATABASE_URL = 'postgres://unused';

function demoStore() {
  const documents = [
    makeDocument({ id: 'web.decision.adr-0001', project: 'demo', tags: ['storage', 'locking'], title: 'Storage locking' }),
    makeDocument({ id: 'web.decision.adr-0002', project: 'demo', tags: ['unrelated'], title: 'Unrelated' }),
    makeDocument({
      id: 'global.lesson.house-rule', project: 'demo', type: 'lesson', tags: ['procedure'], title: 'House rule',
      content: 'always call the helper you declared',
    }),
  ];
  const chunks = [{ id: 1, documentId: 'web.decision.adr-0001', ordinal: 0, content: 'storage locking text', score: 0.8 }];
  return fakeStore({ documents, chunks });
}

test('a gold-set case without a reason is refused', () => {
  assert.throws(() => validateGoldset([{ id: 'a', query: 'q', must_return: ['x'] }]), /why is required/);
  assert.throws(() => validateGoldset([{ id: 'a', query: 'q', must_return: [], why: 'w' }]), /must_return needs/);
  assert.throws(() => validateGoldset([{ id: 'a', query: 'q', must_return: ['x'], why: 'w' }, { id: 'a', query: 'q', must_return: ['x'], why: 'w' }]), /duplicate/);
  assert.throws(() => validateGoldset([]), /gold set is empty/);
});

test('a gold set naming an unindexed document fails loudly rather than scoring a miss', async () => {
  const store = demoStore();
  await assert.rejects(
    assertIdsExist(store, [{ id: 'a', query: 'q', must_return: ['web.decision.adr-9999'], why: 'w' }]),
    /references 1 document\(s\) that are not indexed/,
  );
});

test('scoreCase reports rank, misses, and must-not violations', () => {
  const entry = { id: 'c1', query: 'q', must_return: ['a', 'b'], must_not_outrank: ['bad'], why: 'w' };
  const partial = scoreCase(entry, ['bad', 'a'], 'global.');
  assert.equal(partial.hits, 1);
  assert.equal(partial.complete, false, 'a case that returns one of two documents is not half useful');
  assert.deepEqual(partial.misses, ['b']);
  assert.deepEqual(partial.violations, [{ id: 'bad', rank: 1 }]);
  assert.equal(partial.reciprocalRank, 0.5);

  const clean = scoreCase(entry, ['a', 'b', 'bad'], 'global.');
  assert.equal(clean.complete, true);
  assert.deepEqual(clean.violations, [], 'a must-not document that ranks BELOW the answer is not a violation');
  assert.equal(clean.standingAssisted, false);

  assert.equal(scoreCase({ id: 'c2', query: 'q', must_return: ['global.x'], why: 'w' }, ['global.x'], 'global.').standingAssisted, true);
});

test('summarise separates hit rate, case rate and the ranking-only rate', () => {
  const summary = summarise([
    { hits: 2, required: 2, complete: true, reciprocalRank: 1, identifier: true, standingAssisted: false, violations: [] },
    { hits: 1, required: 2, complete: false, reciprocalRank: 0.5, identifier: false, standingAssisted: true, violations: [{ id: 'x', rank: 1 }] },
  ]);
  assert.equal(summary.cases, 2);
  assert.equal(summary.hitRate, 0.75);
  assert.equal(summary.caseRate, 0.5);
  assert.equal(summary.mrr, 0.75);
  assert.equal(summary.identifierCaseRate, 1);
  assert.equal(summary.rankedOnlyCaseRate, 1, 'the standing-assisted case is excluded from the ranking-only rate');
  assert.equal(summary.violations, 1);
});

test('the floor enforces case rate and violations, and never MRR', () => {
  const baseline = { caseRate: 0.9117647058823529, violations: 0, mrr: 0.6588935574229692 };
  assert.deepEqual(floorBreaches({ caseRate: 0.9117647058823529, violations: 0, mrr: 0.1 }, baseline), []);
  // The 2026-08-09 shape: case rate fell one case while MRR rose. An MRR floor passes it.
  const regression = floorBreaches({ caseRate: 0.8823529411764706, violations: 0, mrr: 0.7 }, baseline);
  assert.equal(regression.length, 1);
  assert.match(regression[0], /below the floor/);
  assert.equal(floorBreaches({ caseRate: 0.9117647058823529, violations: 1, mrr: 0.9 }, baseline).length, 1);
});

test('zero slack is safe because the baseline holds the exact measured fraction', () => {
  // 31/34 typed from its own display would be 0.912, which sits ABOVE the measurement and
  // fails on a healthy tree. The stored value is the fraction itself.
  const baseline = { caseRate: 31 / 34, violations: 0 };
  assert.deepEqual(floorBreaches({ caseRate: 31 / 34, violations: 0 }, baseline), []);
  assert.equal(floorBreaches({ caseRate: 0.912, violations: 0 }, baseline).length, 0);
  assert.equal(floorBreaches({ caseRate: 30 / 34, violations: 0 }, baseline).length, 1, 'one case is the smallest real regression');
});

test('scoreGoldset measures the default retrieval path end to end', async () => {
  const corpus = await loadCorpus(path.join(fixtures, 'demo-corpus.json'));
  const store = demoStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeOllama();
  Object.assign(process.env, fakeEnvironment());
  try {
    const { summary, results, record } = await scoreGoldset({ corpus, store });
    assert.equal(record.engine, 'daijin');
    assert.equal(record.corpus, 'demo');
    assert.deepEqual(results.map((item) => [item.id, item.complete]), [['t001', true], ['t002', true], ['t003', false]]);
    assert.equal(results[1].standingAssisted, true);
    assert.equal(summary.caseRate, 2 / 3);
    assert.equal(summary.violations, 0);

    const baseline = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(fixtures, 'demo-baseline.json'), 'utf8'));
    assert.deepEqual(floorBreaches(summary, baseline), [], 'the fixture corpus sits exactly on its fixture floor');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('compareRecords calls identical runs identical and names every divergence', () => {
  const record = (caseRate, complete) => ({
    summary: { cases: 1, caseRate, mrr: 0.5, violations: 0 },
    results: [{ id: 'g001', hits: complete ? 1 : 0, required: 1, complete, reciprocalRank: complete ? 1 : 0, identifier: false, standingAssisted: false, misses: complete ? [] : ['x'], violations: [] }],
  });
  assert.equal(compareRecords(record(1, true), record(1, true)).identical, true);

  const report = compareRecords(record(1, true), record(0, false));
  assert.equal(report.identical, false);
  assert.deepEqual(report.summaryDifferences.map((item) => item.field), ['caseRate']);
  assert.deepEqual(report.differences.map((item) => item.field || item.kind).sort(), ['complete', 'hits', 'misses', 'reciprocalRank']);
});

test('compareRecords catches a case swap that leaves the headline unchanged', () => {
  // Two runs, same case rate, different cases passing. This is the divergence a summary
  // comparison cannot see, and the reason parity is judged per case.
  const results = (passing) => ({
    summary: { cases: 2, caseRate: 0.5, mrr: 0.5, violations: 0 },
    results: ['a', 'b'].map((id) => ({
      id, hits: id === passing ? 1 : 0, required: 1, complete: id === passing, reciprocalRank: id === passing ? 1 : 0,
      identifier: false, standingAssisted: false, misses: id === passing ? [] : ['x'], violations: [],
    })),
  });
  const report = compareRecords(results('a'), results('b'));
  assert.equal(report.identical, false);
  assert.equal(report.summaryDifferences.length, 0, 'the headline agrees');
  assert.ok(report.differences.length > 0, 'the cases do not');
});

test('a missing case on either side is reported rather than ignored', () => {
  const left = { summary: {}, results: [{ id: 'a', hits: 1, required: 1, complete: true, reciprocalRank: 1, misses: [], violations: [] }] };
  const right = { summary: {}, results: [] };
  const report = compareRecords(left, right);
  assert.deepEqual(report.differences, [{ id: 'a', kind: 'missing-case', inLeft: true, inRight: false }]);
});

test('the differ reports a retrieval change that every SCORE agrees on', () => {
  // The exact shape the verifier flagged: two runs where scoring cannot tell them apart.
  // g011 returns a different document set, but the required document is present at the same
  // rank in both, so hits, complete and reciprocalRank are all equal.
  const scored = { id: 'g011', hits: 1, required: 1, complete: true, reciprocalRank: 0.5, identifier: false, standingAssisted: false, misses: [], violations: [] };
  const record = (extra) => ({
    summary: { cases: 1, caseRate: 1, mrr: 0.5, violations: 0 },
    results: [scored],
    diagnostics: [{ id: 'g011', inferredArea: extra.area, tokenCount: 3900, truncated: true, retrievedIds: extra.ids }],
  });
  const left = record({ area: 'catalog', ids: ['a', 'want', 'b'] });
  const right = record({ area: 'gmail', ids: ['a', 'want', 'c'] });

  const report = compareRecords(left, right);
  assert.equal(report.identical, true, 'every scored field agrees, which is exactly the trap');
  assert.deepEqual(report.differences, []);
  assert.deepEqual(report.summaryDifferences, []);

  assert.equal(report.retrievalDifferences.comparable, true);
  const kinds = report.retrievalDifferences.differences.map((item) => item.field || item.kind).sort();
  assert.deepEqual(kinds, ['inferredArea', 'retrievedIds'], 'and the retrieval-level pass catches both');
});

test('retrieved id ORDER is a difference even when the set is equal', () => {
  const scored = { id: 'g001', hits: 1, required: 1, complete: true, reciprocalRank: 1, identifier: false, standingAssisted: false, misses: [], violations: [] };
  const record = (ids) => ({
    summary: { cases: 1, caseRate: 1, mrr: 1, violations: 0 },
    results: [scored],
    diagnostics: [{ id: 'g001', inferredArea: 'store', tokenCount: 100, truncated: false, retrievedIds: ids }],
  });
  const report = compareRecords(record(['a', 'b']), record(['b', 'a']));
  assert.deepEqual(report.retrievalDifferences.differences.map((item) => item.kind), ['retrievedIds'],
    'an engineer receives these in order, so a reordering is a real difference');
});

test('a record predating diagnostics is still comparable, and says so', () => {
  // The platform's own records carry no diagnostics block. Cross-engine comparison must
  // keep working, and must not silently imply it checked more than it did.
  const scored = { id: 'g001', hits: 1, required: 1, complete: true, reciprocalRank: 1, identifier: false, standingAssisted: false, misses: [], violations: [] };
  const legacy = { summary: { cases: 1, caseRate: 1, mrr: 1, violations: 0 }, results: [scored] };
  const modern = { ...legacy, diagnostics: [{ id: 'g001', inferredArea: 'store', tokenCount: 1, truncated: false, retrievedIds: ['a'] }] };
  const report = compareRecords(legacy, modern);
  assert.equal(report.identical, true);
  assert.equal(report.retrievalDifferences.comparable, false);
  assert.match(report.retrievalDifferences.reason, /no diagnostics block/);
});

// ---- misses and violations are compared per case -------------------------------------
//
// These exist because the comparison of `misses` and `violations` does NOT live in the
// FIELDS list a reader meets first: they are arrays, so `!==` would compare identity
// rather than contents and report every case as different. They are compared just below,
// by value, via listDiff. Reading FIELDS alone suggests a gap that is not there, which is
// exactly the misread that produced verifier finding "compare-runs is one field short".
// Tests, not a comment, are what make that checkable.

test('a violation migrating between cases is caught, though the summary total holds', () => {
  const row = (id, violations) => ({
    id, hits: 1, required: 1, complete: true, reciprocalRank: 1, identifier: false, standingAssisted: false,
    misses: [], violations,
  });
  const summary = { cases: 2, caseRate: 1, mrr: 1, violations: 1 };
  const left = { summary, results: [row('a', [{ id: 'bad', rank: 1 }]), row('b', [])] };
  const right = { summary, results: [row('a', []), row('b', [{ id: 'bad', rank: 1 }])] };

  const report = compareRecords(left, right);
  assert.deepEqual(report.summaryDifferences, [], 'the headline agrees: one violation on both sides');
  assert.deepEqual(report.differences.map((item) => `${item.id}:${item.kind}`), ['a:violations', 'b:violations']);
  assert.equal(report.identical, false);
});

test('a violation that keeps its case but changes its rank is caught', () => {
  const row = (violations) => ({
    id: 'a', hits: 1, required: 1, complete: true, reciprocalRank: 1, identifier: false, standingAssisted: false,
    misses: [], violations,
  });
  const summary = { cases: 1, caseRate: 1, mrr: 1, violations: 1 };
  const report = compareRecords(
    { summary, results: [row([{ id: 'bad', rank: 1 }])] },
    { summary, results: [row([{ id: 'bad', rank: 3 }])] },
  );
  assert.deepEqual(report.differences.map((item) => item.kind), ['violations'], 'rank is part of the violation, not decoration');
});

test('a miss migrating between cases is caught, though hit rate holds', () => {
  const row = (id, misses) => ({
    id, hits: 1, required: 1, complete: true, reciprocalRank: 1, identifier: false, standingAssisted: false,
    misses, violations: [],
  });
  const summary = { cases: 2, caseRate: 1, mrr: 1, violations: 0 };
  const report = compareRecords(
    { summary, results: [row('a', ['x']), row('b', [])] },
    { summary, results: [row('a', []), row('b', ['x'])] },
  );
  assert.deepEqual(report.differences.map((item) => `${item.id}:${item.kind}`), ['a:misses', 'b:misses']);
});

test('two identical cases report no difference, including on the array fields', () => {
  // The control for the three tests above. Without it they would pass even if the
  // comparison reported every case as different, which is precisely what moving `misses`
  // and `violations` into the FIELDS identity check would cause: [] !== [] is true.
  const row = () => ({
    id: 'a', hits: 1, required: 1, complete: true, reciprocalRank: 1, identifier: false, standingAssisted: false,
    misses: [], violations: [],
  });
  const summary = { cases: 1, caseRate: 1, mrr: 1, violations: 0 };
  const report = compareRecords({ summary, results: [row()] }, { summary, results: [row()] });
  assert.deepEqual(report.differences, []);
  assert.equal(report.identical, true);
});

test('an injected environment is believed, and nothing global is touched', async () => {
  // init-miner was carrying a sentinel variable and a lend-and-restore of the EMBEDDING_
  // keys because this function reached for globals. A lend-and-restore is a race the moment
  // two measurements overlap, so the fix is to thread the environment rather than to
  // borrow the process's.
  const corpus = await loadCorpus(path.join(fixtures, 'demo-corpus.json'));
  const store = demoStore();

  // Deliberately hostile globals: if the harness reads process.env for ANY of this, the
  // embedding identity assert fails and the run throws rather than quietly measuring.
  const saved = { ...process.env };
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_MODEL_DIGEST;
  delete process.env.EMBEDDING_DIM;
  delete process.env.DAIJIN_DEMO_DATABASE_URL;
  process.env.EMBEDDING_MODEL = 'a-completely-different-model';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the harness reached for the global fetch'); };
  try {
    const { summary } = await scoreGoldset({
      corpus,
      store,
      environment: fakeEnvironment(),
      fetchImpl: fakeOllama(),
    });
    assert.equal(summary.caseRate, 2 / 3, 'the measurement ran on the injected environment');

    // And the globals are exactly as they were: no lend, no restore, nothing to race on.
    assert.equal(process.env.EMBEDDING_MODEL, 'a-completely-different-model',
      'the harness must not write the environment it was handed into the process');
    assert.equal(process.env.EMBEDDING_PROVIDER, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('an injected environment removes the connection-string requirement entirely', async () => {
  // Measuring a repo's own sqlite brain has no DATABASE_URL and never will.
  const corpus = await loadCorpus(path.join(fixtures, 'demo-corpus.json'));
  const saved = process.env.DAIJIN_DEMO_DATABASE_URL;
  delete process.env.DAIJIN_DEMO_DATABASE_URL;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeOllama();
  try {
    const { summary } = await scoreGoldset({
      corpus, store: demoStore(), environment: fakeEnvironment(), fetchImpl: fakeOllama(),
    });
    assert.equal(summary.cases, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (saved !== undefined) process.env.DAIJIN_DEMO_DATABASE_URL = saved;
  }
});
