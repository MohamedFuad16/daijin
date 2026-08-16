// D-0025 REAL A/B on portfolio-mine: the falsification arm, per the dated amendment.
// A win is impossible here by construction (the control arm sits at the ceiling); a
// regression would be real and disqualifying.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import YAML from '/Users/mfuad16/Documents/daijin/engine/node_modules/yaml/dist/index.js';
import { readFileSync } from 'node:fs';

import { createLlamaServerReranker } from '/Users/mfuad16/Documents/daijin/engine/src/rag/rerank-backends.js';
import { createSqliteStore } from '/Users/mfuad16/Documents/daijin/engine/src/store/sqlite.js';
import { localCorpus } from '/Users/mfuad16/Documents/daijin/engine/src/init/floor.js';
import { servedIndexIdentity } from '/Users/mfuad16/Documents/daijin/engine/src/init/ingest.js';
import { permuteAnswers, rerankAB } from '/Users/mfuad16/Documents/daijin/engine/src/init/rerank-ab.js';

const RUN = process.argv[2];
const EMBEDDING = {
  EMBEDDING_PROVIDER: 'ollama',
  EMBEDDING_MODEL: 'bge-m3',
  EMBEDDING_DIM: '1024',
  EMBEDDING_MODEL_DIGEST: '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab',
  OLLAMA_BASE_URL: 'http://localhost:11434',
};

const reranker = createLlamaServerReranker({ baseUrl: 'http://localhost:8012', timeoutMs: 180_000 });
const health = await reranker.available();
if (!health.ok) throw new Error(`Rerank backend not available: ${health.hint}`);
console.log(`BACKEND     ${reranker.id} at ${reranker.baseUrl}, probe ok`);

const identity = await servedIndexIdentity({ environment: EMBEDDING });
console.log(`EMBEDDER    ${identity.provider}/${identity.model} dim ${identity.dimension} digest ${identity.digest}`);

const store = await createSqliteStore({
  path: path.join(RUN, 'db', 'brain.sqlite'), project: 'default', embedder: identity,
});

const goldsetPath = path.join(RUN, 'artifacts', '.daijin', 'goldset.yaml');
const cases = YAML.parse(readFileSync(goldsetPath, 'utf8'));
const controlPath = path.join(RUN, 'artifacts', '.daijin', 'goldset-permuted-control.yaml');
writeFileSync(controlPath, YAML.stringify(permuteAnswers(cases), { lineWidth: 0 }));

const corpus = localCorpus({ id: 'portfolio-mine', project: 'default', goldsetPath });
const controlCorpus = localCorpus({ id: 'portfolio-mine-permuted', project: 'default', goldsetPath: controlPath });

try {
  const result = await rerankAB({
    corpus, controlCorpus, store, reranker, environment: EMBEDDING,
    budgets: [3000, 4000], topKs: [20, 40], k: 8,
    onStep: async (event) => console.log(`  ${event.detail}`),
  });

  console.log('\nPAIRS');
  for (const pair of result.pairs) {
    console.log(`  budget ${pair.tokenBudget} topK ${pair.topK}`);
    console.log(`    control    ${pair.control.caseRate.cases} = ${pair.control.caseRate.exact}  MRR ${pair.control.mrr.toFixed(6)}  violations ${pair.control.violations}  arm ${JSON.stringify(pair.control.arm)}`);
    console.log(`    treatment  ${pair.treatment.caseRate.cases} = ${pair.treatment.caseRate.exact}  MRR ${pair.treatment.mrr.toFixed(6)}  violations ${pair.treatment.violations}  arm ${JSON.stringify(pair.treatment.arm)}`);
    console.log(`    verdict    ${pair.judgment.verdict}  caseDelta ${pair.judgment.caseDelta}  violationDelta ${pair.judgment.violationDelta}  mrrDelta ${pair.judgment.mrrDelta.toFixed(6)}`);
  }
  console.log(`\nVERDICT     ${result.verdict}`);
  console.log(`CONCLUSION  ${result.conclusion}`);
  if (result.resolution) {
    console.log('RESOLUTION  case rate '
      + `${result.resolution.caseRate.candidate} vs permuted ${result.resolution.caseRate.control} `
      + `(range ${result.resolution.caseRate.range.toFixed(4)}, ${result.resolution.caseRate.casesOfHeadroom} cases), `
      + `MRR ${result.resolution.mrr.candidate.toFixed(4)} vs ${result.resolution.mrr.control.toFixed(4)} (range ${result.resolution.mrr.range.toFixed(4)})`);
  }
  writeFileSync(path.join(RUN, 'rerank-ab-report.json'), `${JSON.stringify({ ...result, embedder: identity, backend: reranker.id }, null, 2)}\n`);
  console.log('\nWROTE', path.join(RUN, 'rerank-ab-report.json'));
} finally {
  await store.close();
}
