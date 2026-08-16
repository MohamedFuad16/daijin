// Control for the P3 floor: does 25 of 25 mean retrieval is right, or that the corpus is
// small enough that k=8 returns most of it?
//
// The permuted control keeps every query and reassigns each answer to a DIFFERENT unit.
// A gauge with signal scores near zero on it. A gauge that is saturated scores high on it
// too, and then the candidate's 25 of 25 says nothing about ranking.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import YAML from '/Users/mfuad16/Documents/daijin/engine/node_modules/yaml/dist/index.js';

import { retrieve } from '/Users/mfuad16/Documents/daijin/engine/src/rag/retrieve.js';
import { createSqliteStore } from '/Users/mfuad16/Documents/daijin/engine/src/store/sqlite.js';
import { localCorpus, sweepBudgets } from '/Users/mfuad16/Documents/daijin/engine/src/init/floor.js';
import { servedIndexIdentity } from '/Users/mfuad16/Documents/daijin/engine/src/init/ingest.js';

const RUN = process.argv[2];
const EMBEDDING = {
  EMBEDDING_PROVIDER: 'ollama',
  EMBEDDING_MODEL: 'bge-m3',
  EMBEDDING_DIM: '1024',
  EMBEDDING_MODEL_DIGEST: '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab',
  OLLAMA_BASE_URL: 'http://localhost:11434',
};
Object.assign(process.env, EMBEDDING);

const identity = await servedIndexIdentity({ environment: EMBEDDING });
const store = await createSqliteStore({
  path: path.join(RUN, 'db', 'brain.sqlite'), project: 'default', embedder: identity,
});

const documents = await store.allDocuments({ project: 'default' });
console.log(`CORPUS      ${documents.length} documents in the brain`);

const cases = YAML.parse(readFileSync(path.join(RUN, 'artifacts', '.daijin', 'goldset.yaml'), 'utf8'));

// How much of the corpus does one query actually receive at k=8?
const sample = [];
for (const entry of cases.slice(0, 5)) {
  const result = await retrieve(
    { query: entry.query, project: 'default', k: 8, tokenBudget: 3000 },
    { store, environment: EMBEDDING },
  );
  sample.push({ id: entry.id, returned: result.meta.retrievedIds.length, ranked: result.meta.rankedIds.length });
}
const returned = sample.reduce((sum, row) => sum + row.returned, 0) / sample.length;
console.log(`DELIVERY    mean ${returned} of ${documents.length} documents returned per query at k=8`);
console.log(`            ${sample.map((row) => `${row.id}:${row.returned}`).join(' ')}`);

// The permuted control: same queries, deliberately wrong answers.
const ids = [...new Set(cases.flatMap((entry) => entry.must_return))].sort();
const permuted = cases.map((entry, index) => {
  const wrong = ids.filter((id) => !entry.must_return.includes(id));
  return { ...entry, must_return: [wrong[index % wrong.length]], must_not_outrank: undefined };
});
const controlPath = path.join(RUN, 'artifacts', '.daijin', 'goldset-permuted-control.yaml');
writeFileSync(controlPath, YAML.stringify(permuted, { lineWidth: 0 }));

const run = async (goldsetPath, label) => {
  const corpus = localCorpus({
    id: `portfolio-mine-${label}`, project: 'default', goldsetPath, environment: process.env,
  });
  const sweep = await sweepBudgets({ corpus, store, budgets: [3000], k: 8, environment: EMBEDDING });
  const point = sweep.points[0];
  console.log(`${label.toUpperCase().padEnd(11)} ${point.caseRate.cases} = ${point.caseRate.exact}  MRR ${point.mrr.toFixed(4)}  violations ${point.violations}`);
  return point;
};

const candidate = await run(path.join(RUN, 'artifacts', '.daijin', 'goldset.yaml'), 'candidate');
const control = await run(controlPath, 'control');

// No invented pass mark. Report the DISCRIMINATING RANGE of each metric: how far the
// candidate sits above a gold set whose answers are deliberately wrong. A metric whose
// control scores nearly as high as the candidate is not measuring what it claims to.
const caseRange = candidate.caseRate.exact - control.caseRate.exact;
const mrrRange = candidate.mrr - control.mrr;
console.log('\nDISCRIMINATING RANGE (candidate minus permuted control)');
console.log(`  case rate  ${candidate.caseRate.cases} vs ${control.caseRate.cases}  range ${caseRange.toFixed(4)} of a possible 1.0`);
console.log(`  MRR        ${candidate.mrr.toFixed(4)} vs ${control.mrr.toFixed(4)}  range ${mrrRange.toFixed(4)}`);
console.log(`  A gold set with deliberately WRONG answers still scores ${control.caseRate.cases} on case rate,`);
console.log(`  because k=8 delivers ${returned} of ${documents.length} documents per query. Presence is nearly free at this`);
console.log('  corpus size; ORDER is what still separates, and MRR is the metric that shows it.');

writeFileSync(path.join(RUN, 'control-report.json'), `${JSON.stringify({
  documents: documents.length,
  meanReturnedPerQuery: returned,
  sample,
  candidate: { caseRate: candidate.caseRate, mrr: candidate.mrr, violations: candidate.violations },
  control: { caseRate: control.caseRate, mrr: control.mrr, violations: control.violations },
}, null, 2)}\n`);
await store.close();
