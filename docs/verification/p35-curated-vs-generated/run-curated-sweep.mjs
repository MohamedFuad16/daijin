// The curated arm's OWN budget sweep, with the discriminating range beside each point.
//
// D-0003 sharpened: the sweep is per CORPUS, not per repo. P3's chosen 3000 came from an
// 11-unit corpus where everything fit; the adopted brain is a different corpus on the same
// repo. A chosen budget is measured on the brain it will serve, never inherited from a
// sibling.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import YAML from '/Users/mfuad16/Documents/daijin/engine/node_modules/yaml/dist/index.js';

import { retrieve } from '/Users/mfuad16/Documents/daijin/engine/src/rag/retrieve.js';
import { createSqliteStore } from '/Users/mfuad16/Documents/daijin/engine/src/store/sqlite.js';
import {
  checkContentSurvival, collectDeliveries, localCorpus, scoreAtBudget,
} from '/Users/mfuad16/Documents/daijin/engine/src/init/floor.js';
import { readBrainArtifacts } from '/Users/mfuad16/Documents/daijin/engine/src/init/brain-artifacts.js';
import { servedIndexIdentity } from '/Users/mfuad16/Documents/daijin/engine/src/init/ingest.js';
import { permuteAnswers } from '/Users/mfuad16/Documents/daijin/engine/src/init/rerank-ab.js';

const RUN = process.argv[2];
const LABEL = process.argv[3] || 'adopted';
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

const goldsetPath = path.join(RUN, 'artifacts', '.daijin', 'goldset.yaml');
const cases = YAML.parse(readFileSync(goldsetPath, 'utf8'));
const controlPath = path.join(RUN, 'artifacts', '.daijin', 'goldset-sweep-control.yaml');
writeFileSync(controlPath, YAML.stringify(permuteAnswers(cases), { lineWidth: 0 }));

const corpus = localCorpus({ id: LABEL, project: 'default', goldsetPath });
const control = localCorpus({ id: `${LABEL}-permuted`, project: 'default', goldsetPath: controlPath });
const brain = await readBrainArtifacts(path.join(RUN, 'artifacts', '.daijin', 'brain'));
// `core` is a measurement annotation, not brain content, so it is not in the artifacts. The
// adopt producer defines it as the record's first three lines; reconstructed here by that
// same rule. Without this every unit has no core, checkContentSurvival skips all of them,
// and the gate reports a VACUOUS PASS that looks exactly like a real one.
const units = brain.units.map((unit) => ({ ...unit, core: unit.content.split('\n').slice(0, 3).join('\n') }));
if (units.some((unit) => !unit.core)) throw new Error('a unit has no core; the survival check would be vacuous.');

const retrieveFn = async ({ query, tokenBudget }) => retrieve(
  { query, project: 'default', k: 8, tokenBudget },
  { store, environment: EMBEDDING },
);

const curve = [];
try {
  for (const tokenBudget of [3000, 4000, 6000, 8000]) {
    const candidate = await scoreAtBudget({ corpus, store, tokenBudget, k: 8, environment: EMBEDDING });
    const permuted = await scoreAtBudget({ corpus: control, store, tokenBudget, k: 8, environment: EMBEDDING });
    const deliveries = await collectDeliveries({ cases, retrieveFn, tokenBudget });
    const survival = checkContentSurvival(deliveries, { units, tokenBudget });
    const point = {
      tokenBudget,
      caseRate: candidate.caseRate,
      mrr: candidate.mrr,
      violations: candidate.violations,
      control: permuted.caseRate,
      rangeCases: candidate.caseRate.hits - permuted.caseRate.hits,
      rangeExact: candidate.caseRate.exact - permuted.caseRate.exact,
      mrrRange: candidate.mrr - permuted.mrr,
      meanTokensConsumed: survival.meanTokensConsumed,
      survivalChecked: survival.checked,
      survival: survival.status,
      survivalEvents: survival.events,
    };
    curve.push(point);
    console.log(
      `${String(tokenBudget).padStart(5)}  ${point.caseRate.cases.padEnd(9)} MRR ${point.mrr.toFixed(4)}  `
      + `control ${point.control.cases.padEnd(9)} RANGE ${String(point.rangeCases).padStart(2)} cases (${point.rangeExact.toFixed(4)})  `
      + `spent ${point.meanTokensConsumed}/${tokenBudget}  survival ${point.survival} (${survival.survival})`
      + (point.survivalEvents.total ? ` (${point.survivalEvents.total} events / ${point.survivalEvents.units} units)` : ''),
    );
  }
} finally {
  await store.close();
}

// Smallest budget within one case of the best, on the RANGE as well as the rate.
const bestRate = Math.max(...curve.map((point) => point.caseRate.hits));
const chosen = curve.find((point) => bestRate - point.caseRate.hits <= 1);
const bestRange = Math.max(...curve.map((point) => point.rangeCases));
console.log(`\nchosen by case rate: ${chosen.tokenBudget} (best ${bestRate} of ${curve[0].caseRate.total})`);
console.log(`best discriminating range: ${bestRange} cases, at ${curve.filter((p) => p.rangeCases === bestRange).map((p) => p.tokenBudget).join(', ')}`);
writeFileSync(path.join(RUN, 'budget-sweep.json'), `${JSON.stringify({ corpus: LABEL, units: brain.units.length, curve, chosen: chosen.tokenBudget }, null, 2)}\n`);
console.log('WROTE', path.join(RUN, 'budget-sweep.json'));
