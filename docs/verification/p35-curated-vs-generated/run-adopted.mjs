// P3 constants-generalization run. Layer 1 only, zero spend, target READ-ONLY.
//
// Target repo is read from and never written to: artifacts go to artifactRoot, the brain
// database lives in the run directory, and gate commands execute in a sandbox exported
// from the pinned commit.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { createOllamaClient } from '/Users/mfuad16/Documents/daijin/adapters/ollama/client.js';
import { createSqliteStore } from '/Users/mfuad16/Documents/daijin/engine/src/store/sqlite.js';
import { embedderFromOllama, servedIndexIdentity } from '/Users/mfuad16/Documents/daijin/engine/src/init/ingest.js';
import { initBrain } from '/Users/mfuad16/Documents/daijin/engine/src/init/pipeline.js';

const TARGET = '/Users/mfuad16/Documents/GitHub/portfolio-mine';
const RUN = process.argv[2];
const PINNED = '81d453aaf200ecc1c27dfdca6f8b201bb976736a';

const EMBEDDING = {
  EMBEDDING_PROVIDER: 'ollama',
  EMBEDDING_MODEL: 'bge-m3',
  EMBEDDING_DIM: '1024',
  EMBEDDING_MODEL_DIGEST: '7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  PATH: process.env.PATH,
  HOME: process.env.HOME,
};

const git = (args) => execFileSync('git', ['-C', TARGET, ...args], { encoding: 'utf8' }).trim();

// Re-verify the pin at run time. If HEAD moved, pin whatever is there and record it.
const head = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain']);
console.log(`PIN         ${head}${head === PINNED ? ' (matches the designated commit)' : ' (MOVED from the designated ' + PINNED + ')'}`);
console.log(`TREE        ${dirty === '' ? 'clean' : 'DIRTY:\n' + dirty}`);

const client = createOllamaClient({ model: 'bge-m3', dimension: 1024, baseUrl: 'http://localhost:11434' });
const served = await client.servedIdentity();
console.log(`EMBEDDER    served ${served.model} digest ${served.digest} dim ${served.dimension} (ollama ${served.serverVersion})`);
if (served.digest !== EMBEDDING.EMBEDDING_MODEL_DIGEST) {
  throw new Error(`served digest ${served.digest} does not match the configured one; refusing to index against an unidentified embedder.`);
}

// The identity the index is built with is derived by the same function retrieval uses,
// so the two cannot disagree on the model string.
const indexIdentity = await servedIndexIdentity({ environment: EMBEDDING });
console.log(`INDEX AS    ${indexIdentity.provider}/${indexIdentity.model} digest ${indexIdentity.digest} dim ${indexIdentity.dimension}`);
const store = await createSqliteStore({
  path: path.join(RUN, 'db', 'brain.sqlite'),
  project: 'default',
  embedder: indexIdentity,
});

const steps = [];
const started = Date.now();
try {
  const report = await initBrain({
    repoPath: TARGET,
    artifactRoot: path.join(RUN, 'artifacts'),
    gateRepoPath: path.join(RUN, 'export'),
    mode: 'ingest',
    store,
    embedder: embedderFromOllama(client),
    environment: EMBEDDING,
    k: 8,
    gateTimeoutMs: 120_000,
    onStep: async (event) => {
      steps.push(event);
      const elapsed = ((event.ts - started) / 1000).toFixed(1).padStart(6);
      console.log(`${elapsed}s  [${event.phase}] ${event.step}${event.detail ? ': ' + event.detail : ''}`);
    },
  });
  report.pin = { designated: PINNED, ranAgainst: head, treeCleanAtRunTime: dirty === '' };
  report.embedder = served;
  writeFileSync(path.join(RUN, 'p3-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log('\nWROTE', path.join(RUN, 'p3-report.json'));
} finally {
  await store.close();
}

// The read-only guarantee, re-checked by the same instrument the leader used.
const after = git(['status', '--porcelain']);
const headAfter = git(['rev-parse', 'HEAD']);
console.log(`\nPOST-RUN    tree ${after === '' ? 'clean' : 'DIRTY: ' + after} | HEAD ${headAfter} ${headAfter === head ? '(unchanged)' : '(MOVED)'}`);
