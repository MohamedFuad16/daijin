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

const SIZES = [6, 8, 10, 12, 15, 18, 25, 34];
const REPEATS = Number(process.env.REPEATS || 5);
console.log(`platform corpus, ${all.length} cases, k=${k}, ${REPEATS} subsamples per size\n`);
console.log('       headroom vs control    floor spread     one case    mrr');
console.log('size   min/med/max            across samples   is worth    range');
console.log('-----  --------------------  ---------------  ----------  -------');

for (const size of SIZES) {
  const headrooms = [];
  const mrrs = [];
  const rates = [];
  let skipped = 0;
  for (let r = 0; r < REPEATS; r += 1) {
    const chosen = size >= all.length ? all : sample(all, size, 1000 + size * 97 + r);
    let control;
    try {
      control = permuteAnswers(chosen);
    } catch {
      skipped += 1;
      continue;
    }
    const candidate = await scoreSet(chosen, `real-${size}-${r}`);
    const controlScore = await scoreSet(control, `control-${size}-${r}`);
    const range = discriminatingRange(candidate, controlScore);
    headrooms.push(range.caseRate.casesOfHeadroom);
    mrrs.push(range.mrr.range);
    rates.push(candidate.caseRate.exact);
    if (size >= all.length) break; // the full set has only one composition
  }
  const sorted = [...headrooms].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const mrrSorted = [...mrrs].sort((a, b) => a - b);
  const mrrMedian = mrrSorted.length ? mrrSorted[Math.floor(mrrSorted.length / 2)] : null;
  const rateSorted = [...rates].sort((a, b) => a - b);
  const spread = rateSorted.length ? (rateSorted[rateSorted.length - 1] - rateSorted[0]) : null;
  const perCase = 1 / size;
  console.log(
    String(size).padEnd(6)
    + `${String(sorted[0] ?? '-').padStart(3)} /${String(median ?? '-').padStart(4)} /${String(sorted[sorted.length - 1] ?? '-').padStart(4)}`.padEnd(18)
    + (spread === null ? '     -' : (spread * 100).toFixed(1).padStart(6)) + ' pts'
    + (perCase * 100).toFixed(1).padStart(9) + ' pts'
    + (mrrMedian === null ? '        -' : mrrMedian.toFixed(3).padStart(9))
    + (skipped ? `  (${skipped} unpermutable)` : ''),
  );
}
