// Reproduce the chunk-count drift in isolation and catch the divergence in the act.
//
// Runs the REAL init pipeline N times over N fresh copies of one fixed-content fixture,
// with a deterministic hash embedder, and records everything that could differ: the unit
// ids generated, each unit's chunk count, and the total. Anything that moves between runs
// on identical input is the defect.
//
//   node drift-harness.mjs <fixtureRepo> <runs> [--lever]
//
// --lever adds one async hop to every fetch, which is the perturbation that moved the
// observed failure rate from about 1-in-3 to about 5-in-6.

import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENGINE = '/Users/mfuad16/Documents/daijin/engine';
const { initBrain } = await import(`${ENGINE}/src/init/pipeline.js`);
const { createSqliteStore } = await import(`${ENGINE}/src/store/sqlite.js`);

const DIMENSION = 64;
const EMBEDDER = { provider: 'ollama', model: 'fixture-embed', digest: 'sha256-fixture', dimension: DIMENSION };
const ENVIRONMENT = {
  EMBEDDING_PROVIDER: 'ollama',
  EMBEDDING_MODEL: EMBEDDER.model,
  EMBEDDING_MODEL_DIGEST: EMBEDDER.digest,
  EMBEDDING_DIM: String(DIMENSION),
  OLLAMA_BASE_URL: 'http://localhost:11434',
};

function tokens(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

function hashEmbed(text, dimension = DIMENSION) {
  const vector = new Array(dimension).fill(0);
  for (const token of tokens(text)) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % dimension] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

const lever = process.argv.includes('--lever');

function fakeOllama() {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const impl = async (input) => {
    const target = String(input?.url ?? input);
    if (lever) await Promise.resolve();
    if (target.endsWith('/api/embed')) {
      const inputs = [''];
      return json({ embeddings: inputs.map((text) => hashEmbed(text)), prompt_eval_count: 1 });
    }
    if (target.endsWith('/api/tags')) return json({ models: [{ name: EMBEDDER.model, digest: EMBEDDER.digest }] });
    if (target.endsWith('/api/show')) return json({ details: { family: 'bert', parameter_size: '1B' }, digest: EMBEDDER.digest });
    return json({});
  };
  return impl;
}

async function oneRun(fixture, index) {
  const root = await mkdtemp(path.join(tmpdir(), `drift-repo-${index}-`));
  await rm(root, { recursive: true, force: true });
  await cp(fixture, root, { recursive: true });
  // A copied .git is fine; the pipeline reads history rather than writing it.
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), `drift-db-${index}-`));
  const store = await createSqliteStore({
    path: path.join(databaseDirectory, 'brain.sqlite'), project: 'default', embedder: EMBEDDER,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeOllama();
  const chunkCounts = [];
  try {
    await initBrain({
      repoPath: root,
      mode: 'layer1',
      // A Proxy, not a spread: the store is a class instance and spreading drops its
      // prototype methods. Wrapping the ONE call that decides the number, so whatever
      // ingest hands to replaceChunks is captured as the decision is made.
      store: new Proxy(store, {
        get(target, property, receiver) {
          if (property === 'replaceChunks') {
            return async (id, chunks) => {
              chunkCounts.push({ id, chunks: chunks.length });
              return target.replaceChunks(id, chunks);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
      embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
      environment: ENVIRONMENT,
      fetchImpl: globalThis.fetch,
      gateRunner: async () => ({ status: 'pass', exitCode: 0, duration_ms: 1, stdout: '', stderr: '' }),
      onStep: async () => {},
      clock: () => 1_770_000_000_000,
    });
  } catch (error) {
    return { index, error: error.message, chunkCounts };
  } finally {
    globalThis.fetch = originalFetch;
    await store.close?.();
    await rm(databaseDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
  const total = chunkCounts.reduce((sum, row) => sum + row.chunks, 0);
  return { index, total, units: chunkCounts.length, chunkCounts };
}

const fixture = process.argv[2];
const runs = Number(process.argv[3] || 6);
const results = [];
for (let index = 0; index < runs; index += 1) {
  results.push(await oneRun(fixture, index));
}

const signature = (run) => JSON.stringify(run.chunkCounts);
const groups = new Map();
for (const run of results) {
  const key = run.error ? `ERROR: ${run.error}` : signature(run);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(run.index);
}

console.log(`${runs} runs, lever=${lever}`);
for (const run of results) {
  console.log(`  run ${run.index}: ${run.error ? `ERROR ${run.error}` : `${run.units} units, ${run.total} chunks`}`);
}
console.log(`DISTINCT OUTCOMES: ${groups.size}`);
if (groups.size > 1) {
  const keys = [...groups.keys()];
  await writeFile(path.join(path.dirname(process.argv[1]), 'drift-outcomes.json'),
    JSON.stringify(keys.map((key, i) => ({ runs: groups.get(key), outcome: key })), null, 2), 'utf8');
  // Name the first difference rather than dumping both sides.
  const [a, b] = keys.map((key) => { try { return JSON.parse(key); } catch { return null; } });
  if (a && b) {
    const ids = new Set([...a.map((r) => r.id), ...b.map((r) => r.id)]);
    for (const id of ids) {
      const left = a.find((r) => r.id === id);
      const right = b.find((r) => r.id === id);
      if (!left || !right) console.log(`  UNIT PRESENT IN ONLY ONE OUTCOME: ${id} (${left ? 'A' : 'B'} only)`);
      else if (left.chunks !== right.chunks) console.log(`  CHUNK COUNT DIFFERS: ${id} ${left.chunks} vs ${right.chunks}`);
    }
  }
}
