// EXPERIMENT, not shipped code. How small can a gold set be and still discriminate?
//
// The owner's repo mined 18 cases and was refused by a bare count gate at 25. The question
// is not "is 18 below 25" but "can an 18-case gauge tell a working retriever from a broken
// one". D-0030's tool answers that directly: score the real set, score a PERMUTED control
// whose answers are deliberately wrong, and read the gap. A set that cannot separate those
// two measures nothing, whatever its size.
//
// Subsamples the platform corpus (34 cases), the only gold set here with a committed
// baseline. Zero spend: local ollama embeddings only.
// NO BARE IMPORTS. node_modules lives under engine/, and a bare specifier resolves from
// THIS file's directory rather than the working directory, so `import YAML from 'yaml'`
// cannot resolve here. The goldset is written as JSON, which the reader parses unchanged
// because YAML is a superset of it. Found by running the script from its new home rather
// than assuming the move worked.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadCorpusByName, loadGoldset } from '../../../engine/src/init/corpus.js';
import { permuteAnswers, discriminatingRange } from '../../../engine/src/init/rerank-ab.js';
import { scoreGoldset } from '../../../engine/src/init/retrieval-score.js';

/// Deterministic, so the sweep is re-runnable and a claim about it can be checked.
function lcg(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
}

function sample(cases, n, seed) {
  const pool = [...cases];
  const random = lcg(seed);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

const corpus = await loadCorpusByName('platform');
const all = await loadGoldset(corpus);
const k = 8;

async function scoreSet(cases, label) {
  const dir = await mkdtemp(path.join(tmpdir(), 'floor-sweep-'));
  const file = path.join(dir, 'goldset.yaml');
  try {
    await writeFile(file, JSON.stringify(cases, null, 2), 'utf8');
    const { summary, results } = await scoreGoldset({
      corpus: { ...corpus, goldsetPath: file }, k, label,
    });
    const hits = results.filter((row) => row.complete).length;
    return { caseRate: { exact: summary.caseRate, cases: `${hits} of ${results.length}`, hits }, mrr: summary.mrr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}


// A PROPER spread estimate. The earlier number (max minus min over 6-10 draws) moved by a
// factor of three between runs, so it cannot support a figure in user-facing copy. This
// uses many more draws and reports a DISPERSION rather than a range.
const DRAWS = Number(process.env.DRAWS || 30);
console.log(`platform corpus, ${all.length} cases, ${DRAWS} independent draws per size\n`);
console.log('size   n   mean    sd     p10    p90    p90-p10   one case');
console.log('----  ---  -----  -----  -----  -----  -------   --------');

for (const size of [12, 15, 18, 25]) {
  const rates = [];
  for (let r = 0; r < DRAWS; r += 1) {
    const chosen = sample(all, size, 20000 + size * 7919 + r * 104729);
    const cand = await scoreSet(chosen, `s-${size}-${r}`);
    rates.push(cand.caseRate.exact * 100);
  }
  rates.sort((a, b) => a - b);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / (rates.length - 1));
  const at = (q) => rates[Math.min(rates.length - 1, Math.floor(q * rates.length))];
  const p10 = at(0.10);
  const p90 = at(0.90);
  console.log(
    String(size).padEnd(6) + String(rates.length).padStart(3)
    + mean.toFixed(1).padStart(7) + sd.toFixed(1).padStart(7)
    + p10.toFixed(1).padStart(7) + p90.toFixed(1).padStart(7)
    + (p90 - p10).toFixed(1).padStart(9) + '   ' + (100 / size).toFixed(1) + ' pts',
  );
}
