// D-0025 plumbing proof: the rerank option reaches the stage, through the real harness
// seam, over the real portfolio-mine brain. NOT a measurement: the backends here are
// deterministic stubs, so the numbers say only whether the wiring is live.
//
// Two stubs, because one of them proves the opposite thing:
//   identity  returns the fused order unchanged. The treatment must equal the control.
//   reversed  returns the fused order inverted. The treatment must DIFFER, or the option
//             is being accepted and dropped somewhere between the flag and the ranker.
import path from 'node:path';

import { createSqliteStore } from '/Users/mfuad16/Documents/daijin/engine/src/store/sqlite.js';
import { localCorpus } from '/Users/mfuad16/Documents/daijin/engine/src/init/floor.js';
import { servedIndexIdentity } from '/Users/mfuad16/Documents/daijin/engine/src/init/ingest.js';
import { rerankAB } from '/Users/mfuad16/Documents/daijin/engine/src/init/rerank-ab.js';

const RUN = process.argv[2];
const EMBEDDING = {
  EMBEDDING_PROVIDER: 'ollama',
  EMBEDDING_MODEL: 'bge-m3',
  EMBEDDING_DIM: '1024',
  EMBEDDING_MODEL_DIGEST: '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab',
  OLLAMA_BASE_URL: 'http://localhost:11434',
};

const identity = await servedIndexIdentity({ environment: EMBEDDING });
const store = await createSqliteStore({
  path: path.join(RUN, 'db', 'brain.sqlite'), project: 'default', embedder: identity,
});
const corpus = localCorpus({
  id: 'portfolio-mine', project: 'default',
  goldsetPath: path.join(RUN, 'artifacts', '.daijin', 'goldset.yaml'),
});

const stubs = {
  identity: { id: 'stub:identity', async rerank(query, documents) { return documents.map((unused, index) => -index); } },
  reversed: { id: 'stub:reversed', async rerank(query, documents) { return documents.map((unused, index) => index); } },
};

try {
  for (const [name, reranker] of Object.entries(stubs)) {
    const result = await rerankAB({
      corpus, store, reranker, environment: EMBEDDING, budgets: [3000], topKs: [40], k: 8,
    });
    const pair = result.pairs[0];
    console.log(`\n${name.toUpperCase()} stub (backend ${result.backend})`);
    console.log(`  control    ${pair.control.caseRate.cases}  MRR ${pair.control.mrr.toFixed(4)}  arm ${JSON.stringify(pair.control.arm)}`);
    console.log(`  treatment  ${pair.treatment.caseRate.cases}  MRR ${pair.treatment.mrr.toFixed(4)}  arm ${JSON.stringify(pair.treatment.arm)}`);
    console.log(`  verdict    ${result.verdict}  (caseDelta ${pair.judgment.caseDelta}, mrrDelta ${pair.judgment.mrrDelta.toFixed(4)})`);
    const moved = pair.treatment.mrr !== pair.control.mrr || pair.treatment.caseRate.hits !== pair.control.caseRate.hits;
    if (name === 'identity' && moved) console.log('  UNEXPECTED: an order-preserving rerank moved the numbers.');
    if (name === 'reversed' && !moved) console.log('  PLUMBING DEAD: an order-inverting rerank moved nothing; the option is not reaching the ranker.');
    if (name === 'reversed' && moved) console.log('  PLUMBING LIVE: inverting the order moved the measurement, so the flag reaches the stage.');
  }
} finally {
  await store.close();
}
