// P1 ACCEPTANCE TEST.
//
// The extraction is only proven if the ported engine reproduces the platform's committed
// floor on the platform corpus. This runs the ported harness against the live platform
// index and asserts the EXACT values in that repository's retrieval-baseline.json, not a
// rounded display of them and not a tolerance band.
//
// It talks to Postgres and to a local Ollama, so it is skipped when either is absent. The
// skip NAMES what was missing: a test that quietly passes on a machine with no database
// is dead coverage, and the reason has to reach the reader.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';

import { loadBaseline, loadCorpusByName, loadCorpusEnvironment, loadGoldset } from '../src/init/corpus.js';
import { floorBreaches, scoreGoldset } from '../src/init/retrieval-score.js';
import { checkOllama } from '../src/rag/embed.js';
import { createPgVectorStore } from '../src/store/pgvector.js';

async function corpusReadiness() {
  let corpus;
  try {
    corpus = await loadCorpusByName('platform');
    await access(corpus.goldsetPath);
    await access(corpus.baselinePath);
  } catch (error) {
    return { ready: false, reason: `platform corpus files unreachable (${error.message}); set DAIJIN_PLATFORM_ROOT` };
  }
  let databaseUrl;
  let environment;
  try {
    ({ databaseUrl, environment } = loadCorpusEnvironment(corpus));
  } catch (error) {
    return { ready: false, reason: error.message };
  }
  const store = createPgVectorStore({ connectionString: databaseUrl, applicationName: 'daijin-parity-probe' });
  try {
    const identity = await store.indexedEmbeddingIdentity();
    if (!identity?.indexed) return { ready: false, reason: 'the platform database has no indexed embedding identity' };
  } catch (error) {
    return { ready: false, reason: `platform database unreachable: ${error.message}` };
  } finally {
    await store.close();
  }
  try {
    await checkOllama({ environment });
  } catch (error) {
    return { ready: false, reason: `local embedder unavailable: ${error.message}` };
  }
  return { ready: true, corpus };
}

const readiness = await corpusReadiness();

test('the ported engine reproduces the platform floor exactly on the platform corpus', { skip: readiness.ready ? false : readiness.reason }, async () => {
  const { corpus } = readiness;
  const baseline = await loadBaseline(corpus);
  const cases = await loadGoldset(corpus);

  // The baseline records the k it was measured at. Measuring at a different k and
  // comparing to it would be a different experiment wearing this one's number.
  const { summary, results } = await scoreGoldset({ corpus, k: baseline.k, label: 'p1-parity' });

  assert.equal(summary.cases, baseline.cases, 'the gold set must be the one the baseline was measured over');
  assert.equal(cases.length, baseline.cases);
  assert.equal(summary.caseRate, baseline.caseRate, 'case rate must be the exact committed fraction');

  // MRR is asserted to all sixteen digits ON PURPOSE, and it is the one assertion here with
  // a known benign failure mode. DIAGNOSE A FAILURE IN THIS ORDER (verifier finding 65):
  //
  //  1. PLANNER ROW ORDER FIRST, before treating it as a port regression. This test runs
  //     the PARITY path, where the document inventory carries no ORDER BY, so its row order
  //     is whatever Postgres returns. rank.js breaks an inferred-area tie on document
  //     arrival order (Array.prototype.sort is stable), so a VACUUM, a REINDEX, or any
  //     physical row rewrite on the platform database can move this number with not one
  //     line of code changing. Measured cost of exactly that perturbation, by running the
  //     shipped ordered path against the same corpus: MRR 0.6588935574229692 becomes
  //     0.6637955182072829, three cases change inferred area (g003, g011, g031), and case
  //     rate does NOT move.
  //  2. So: MRR moved and caseRate did not, suspect row order. Both moved, it is a real
  //     regression and the port is the place to look.
  //
  // The SHIPPED path is immune because it pins ORDER BY d.id. Only this fixture is exposed,
  // which is the price of reproducing the platform's exact statements, and it is worth
  // paying because those statements are what the committed baseline was measured with.
  assert.equal(summary.mrr, baseline.mrr, 'MRR is not floored, but parity means it matches to the last digit');
  assert.equal(summary.violations, baseline.violations);
  assert.deepEqual(floorBreaches(summary, baseline), []);

  const [passing, failing] = [results.filter((item) => item.complete).length, results.filter((item) => !item.complete).length];
  assert.equal(`${passing} of ${passing + failing}`, baseline.caseRateCases);
});
