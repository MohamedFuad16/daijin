// The headless init pipeline, end to end, over a real repo and a real SQLite brain.
//
// Hermetic (D-0015): the repository is created here in a temp directory, the store is a
// temp SQLite file, and the embedder is a deterministic hash of the text. globalThis.fetch
// is replaced for the duration so the retrieval path's Ollama preflight is answered
// locally; nothing reaches the network and nothing calls a paid API.
//
// This file carries the acceptance shape of P3 in miniature: a full init runs headlessly
// and reports whatever floor number appears. The number asserted below is the fixture's
// own, produced by a hash embedder rather than a real one, so it is a MECHANISM check and
// not a quality claim. The constants-generalization number comes from the live run on the
// repo the owner designates.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

import { retrieve } from '../src/rag/retrieve.js';
import { tokens } from '../src/rag/tokens.js';
import { createSqliteStore } from '../src/store/sqlite.js';
import { checkContentSurvival, collectDeliveries } from '../src/init/floor.js';
import { chunkUnits, importRelationships, ingestUnits, servedIndexIdentity } from '../src/init/ingest.js';
import { caseKey } from '../src/init/goldset.js';
import { initBrain, mergeGoldset, writeGoldset, writeRetiredGoldset } from '../src/init/pipeline.js';

const DIMENSION = 64;
const EMBEDDER = { provider: 'ollama', model: 'fixture-embed', digest: 'sha256-fixture', dimension: DIMENSION };

const ENVIRONMENT = {
  EMBEDDING_PROVIDER: 'ollama',
  EMBEDDING_MODEL: EMBEDDER.model,
  EMBEDDING_MODEL_DIGEST: EMBEDDER.digest,
  EMBEDDING_DIM: String(DIMENSION),
  OLLAMA_BASE_URL: 'http://localhost:11434',
};

/** A deterministic stand-in for an embedding model: hashed bag of tokens, normalised. */
function hashEmbed(text, dimension = DIMENSION) {
  const vector = new Array(dimension).fill(0);
  for (const token of tokens(String(text).toLowerCase())) {
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

/** Answers the three Ollama endpoints retrieval touches, and records every URL. */
function fakeOllama() {
  const urls = [];
  return {
    urls,
    fetchImpl: async (url, options) => {
      urls.push(String(url));
      const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      const target = String(url);
      if (target.endsWith('/api/version')) return json({ version: '0.0.0-fixture' });
      if (target.endsWith('/api/tags')) return json({ models: [{ name: EMBEDDER.model, model: EMBEDDER.model, digest: EMBEDDER.digest }] });
      if (target.endsWith('/api/embed')) {
        const { input } = JSON.parse(options.body);
        const inputs = Array.isArray(input) ? input : [input];
        return json({ embeddings: inputs.map((text) => hashEmbed(text)), prompt_eval_count: 1 });
      }
      throw new Error(`unexpected fetch to ${target}`);
    },
  };
}

const GIT_ENVIRONMENT = {
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'author@example.test',
};

const APP_FILES = {
  'package.json': JSON.stringify({
    name: 'fixture-app',
    type: 'module',
    scripts: { test: 'node --test', lint: 'echo lint', build: 'echo build' },
    dependencies: { lodash: '^4.17.21', 'node-fetch': '^3.0.0' },
    devDependencies: { unusedpkg: '^1.0.0' },
  }, null, 2),
  'Makefile': 'test:\n\techo make test\n',
  'README.md': '# Fixture app\n',
  'src/util/tokens.js': "export function countTokens(text) {\n  return text.split(' ').length;\n}\n\nexport function normalizeWhitespace(text) {\n  return text.trim();\n}\n",
  'src/store/sqlite.js': "import { countTokens } from '../util/tokens.js';\nimport lodash from 'lodash';\n\nexport class SqliteStore {}\n\nexport function createSqliteStore() {\n  return new SqliteStore();\n}\n\nexport function measureDocument(text) {\n  return countTokens(text);\n}\n",
  'src/store/memory.js': "import { countTokens } from '../util/tokens.js';\n\nexport function createMemoryStore() {\n  return { rows: [], count: countTokens };\n}\n",
  'src/rag/rank.js': "import { countTokens } from '../util/tokens.js';\n\nexport function rankRetrieval(rows) {\n  return rows;\n}\n\nexport function fuseRankings(left, right) {\n  return [...left, ...right];\n}\n",
  'src/rag/chunk.js': "import { normalizeWhitespace } from '../util/tokens.js';\n\nexport function chunkDocument(document) {\n  return [{ ordinal: 0, content: normalizeWhitespace(document.content) }];\n}\n",
  'src/api/server.js': "import { createSqliteStore } from '../store/sqlite.js';\nimport { rankRetrieval } from '../rag/rank.js';\nimport fetch from 'node-fetch';\n\nexport function startServer(options) {\n  return { store: createSqliteStore(options), rank: rankRetrieval, fetch };\n}\n",
  'src/api/routes.js': "import { startServer } from './server.js';\n\nexport function registerRoutes(app) {\n  return app.get('/health', () => startServer({}));\n}\n",
  'test/rank.test.js': "import { rankRetrieval } from '../src/rag/rank.js';\n\nexport function exerciseRanking() {\n  return rankRetrieval([]);\n}\n",
};

const COMMITS = [
  ['src/store/sqlite.js', 'add document measurement to the sqlite store'],
  ['src/store/memory.js', 'introduce the memory store for tests'],
  ['src/rag/rank.js', 'sort ranking candidates by score descending'],
  ['src/rag/chunk.js', 'normalize whitespace before chunking documents'],
  ['src/api/server.js', 'start the api server with an injected store'],
  ['src/api/routes.js', 'register the health route on the api'],
  ['src/util/tokens.js', 'count tokens by splitting on whitespace'],
  ['test/rank.test.js', 'exercise the ranking function from tests'],
  ['src/rag/rank.js', 'fuse two ranking lists into one result'],
  ['src/store/sqlite.js', 'document the sqlite store constructor arguments'],
];

function makeRepo(extraFiles = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-init-repo-'));
  for (const [file, content] of Object.entries({ ...APP_FILES, ...extraFiles })) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const git = (args, environment = {}) => execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, ...GIT_ENVIRONMENT, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', ...environment },
    stdio: 'pipe',
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Fixture Author']);
  git(['config', 'user.email', 'author@example.test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-m', 'initial import of the fixture application']);
  let day = 2;
  for (const [file, subject] of COMMITS) {
    writeFileSync(path.join(root, file), `\n// touched: ${subject}\n`, { flag: 'a' });
    git(['add', '-A']);
    const date = `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
    git(['commit', '-m', subject], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    day += 1;
  }
  return root;
}

function makeStore() {
  const directory = mkdtempSync(path.join(tmpdir(), 'daijin-init-db-'));
  return { directory, file: path.join(directory, 'brain.sqlite') };
}

/** Every gate candidate reported live, without paying npm's start-up on every run. */
const liveRunner = async () => ({ status: 'pass', exitCode: 0, duration_ms: 1, stdout: '', stderr: '' });

async function runInit(root, overrides = {}) {
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  const ollama = fakeOllama();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ollama.fetchImpl;
  const steps = [];
  try {
    const report = await initBrain({
      repoPath: root,
      mode: 'layer1',
      store,
      embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
      environment: ENVIRONMENT,
      fetchImpl: ollama.fetchImpl,
      gateRunner: liveRunner,
      onStep: async (event) => steps.push(event),
      clock: () => 1_770_000_000_000,
      ...overrides,
    });
    return { report, steps, store, directory, ollama };
  } catch (error) {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('a full init runs headlessly and reports the floor it measured, whatever it is', async () => {
  const root = makeRepo();
  const { report, steps, store, directory } = await runInit(root);
  try {
    // Phases, in the plan's order.
    assert.deepEqual(
      [...new Set(steps.map((step) => step.phase))],
      ['identify', 'evidence', 'scaffold', 'ingest', 'gates', 'goldset', 'floor'],
    );
    assert.ok(steps.every((step) => typeof step.ts === 'number' && step.jobId === 'init'), 'RPC v4 step shape');

    assert.equal(report.analysis.commitCount, 11);
    assert.ok(report.phases.scaffold.accepted >= 10);
    assert.equal(report.phases.scaffold.errors.units, 0, 'errors.md starts empty');
    assert.ok(report.phases.scaffold.errors.candidates.fixCommits >= 0);
    assert.equal(report.phases.ingest.documents, report.phases.scaffold.accepted);
    assert.ok(report.phases.ingest.chunks > report.phases.ingest.documents);
    assert.equal(report.phases.gates.carryingSignal, report.phases.gates.total);

    // The gold set passed its own gates BEFORE it measured.
    assert.equal(report.phases.goldset.passed, true);
    assert.ok(report.phases.goldset.active >= 25, 'the diversity floor is 25 cases');
    assert.deepEqual(
      report.phases.goldset.gates.map((gate) => gate.id),
      ['existence', 'leakage', 'staleness', 'provenance', 'diversity'],
    );

    // The floor, recorded honestly with its counts, its curve and its rationale.
    assert.ok(report.floor, 'the floor is measured once the gauge is certified');
    assert.equal(report.floor.caseRate.total, report.phases.goldset.active);
    assert.equal(report.floor.caseRate.exact, report.floor.caseRate.hits / report.floor.caseRate.total);
    assert.match(report.floor.caseRate.cases, /^\d+ of \d+$/);
    assert.deepEqual(report.floor.budgetSweep.map((entry) => entry.tokenBudget), [3000, 4000, 6000, 8000]);
    assert.ok([3000, 4000, 6000, 8000].includes(report.floor.chosenBudget));
    assert.ok(report.floor.rationale.length > 0);
    assert.equal(report.floor.violations, 0);
    assert.equal(report.floor.perCase.length, report.floor.caseRate.total);
    assert.equal(
      report.floor.mcp.unlocked,
      report.floor.caseRate.exact >= 0.75,
      'MCP unlocks strictly on the measured floor, never on anything else',
    );

    // Artifacts a human edits.
    const gatesYaml = YAML.parse(readFileSync(path.join(root, '.daijin/gates.yaml'), 'utf8'));
    assert.equal(gatesYaml.version, 1);
    const goldset = YAML.parse(readFileSync(path.join(root, '.daijin/goldset.yaml'), 'utf8'));
    assert.equal(
      goldset.length,
      report.phases.goldset.active,
      'the file the scorer loads holds ACTIVE cases only; a retired case in here would score as a permanent miss',
    );
    assert.ok(goldset.every((entry) => !entry.retired));
    assert.ok(goldset.every((entry) => entry.provenance && entry.why));
    assert.ok(existsSync(path.join(root, '.daijin/init-report.json')));

    // The brain is queryable: every answer the gold set names is in the live index.
    const referenced = [...new Set(goldset.flatMap((entry) => entry.must_return))];
    assert.deepEqual((await store.existingDocumentIds(referenced)).sort(), referenced.sort());
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('the run is zero-spend: the only host contacted is the local embedder', async () => {
  const root = makeRepo();
  const { store, directory, ollama } = await runInit(root);
  try {
    assert.ok(ollama.urls.length > 0, 'the embedder was actually exercised');
    assert.ok(
      ollama.urls.every((url) => url.startsWith('http://localhost:11434/')),
      `a provider call would appear here: ${[...new Set(ollama.urls)].join(', ')}`,
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a gold set that fails its own gates BLOCKS the measurement instead of scoring anyway', async () => {
  // A repo too small to reach the diversity floor. The number that would come out of it
  // reads exactly like a real one, which is worse than no number at all.
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-init-tiny-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/only.js'), 'export function onlyThing() {\n  return 1;\n}\n');
  writeFileSync(path.join(root, 'package.json'), '{"name":"tiny"}');
  const { report, steps, store, directory } = await runInit(root, { discoverRepoGates: false });
  try {
    assert.equal(report.phases.goldset.passed, false);
    assert.equal(report.floor, null, 'a failing gauge must not produce a floor');
    assert.equal(report.blocked.at, 'goldset-gates');
    assert.ok(report.blocked.failed.some((entry) => entry.startsWith('diversity:')));
    assert.ok(steps.some((step) => step.step === 'blocked' && step.level === 'warn'));
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('MUTATION: a 45-file module loses its cited core to the real budget trim at 3000 tokens', async () => {
  // A real repo shape, not a contrived string: the card lists its 45 files, so its claim
  // section is 785 tokens, and the per-candidate cap at a 3000 token budget is 660. The
  // trim that cuts it is rag/rank.js applyBudget, reached through retrieve(), so this is
  // the instrument firing on the shipped path rather than on a hand-built example.
  const bulk = {};
  for (let index = 0; index < 45; index += 1) {
    bulk[`src/bulk/module${String(index).padStart(4, '0')}.js`] = `export function bulkThing${index}() {\n  return ${index};\n}\n`;
  }
  const root = makeRepo(bulk);
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  const ollama = fakeOllama();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ollama.fetchImpl;
  try {
    const report = await initBrain({
      repoPath: root,
      store,
      embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
      environment: ENVIRONMENT,
      fetchImpl: ollama.fetchImpl,
      scaffoldOptions: { filesPerCard: 45 },
      budgets: [3000],
      discoverRepoGates: false,
      writeArtifacts: true,
      clock: () => 1_770_000_000_000,
    });
    const card = report.units.find((unit) => unit.id === 'daijin.architecture.src-bulk');
    assert.ok(card, 'the bulk module must have produced a card');
    assert.ok(tokens(card.core).length > 660, `the core is ${tokens(card.core).length} tokens, which must exceed the 660 cap`);

    const retrieveFn = async ({ query, tokenBudget }) => retrieve(
      { query, project: 'default', k: 8, tokenBudget },
      { store, environment: ENVIRONMENT, fetchImpl: ollama.fetchImpl },
    );
    // A query written to reach the card's own claim chunk, so the entry under test is the
    // one that carries the core.
    const probe = [{ id: 'survival-probe', query: 'src/bulk module0001.js imported by imports files in this module' }];
    const trimmed = checkContentSurvival(
      await collectDeliveries({ cases: probe, retrieveFn, tokenBudget: 3000 }),
      { units: report.units, tokenBudget: 3000 },
    );
    assert.equal(trimmed.perCandidateCap, 660);
    assert.equal(trimmed.status, 'fail', JSON.stringify({ checked: trimmed.checked, windowMissed: trimmed.windowMissed.length }));
    assert.ok(trimmed.truncatedAway.some((entry) => entry.id === 'daijin.architecture.src-bulk'));
    assert.match(trimmed.raiseSignal, /mechanical signal to raise the budget or shorten the cards/);

    // The same delivery at a budget whose cap fits the core survives, which is what makes
    // the failure above a BUDGET finding rather than a broken instrument.
    const roomy = checkContentSurvival(
      await collectDeliveries({ cases: probe, retrieveFn, tokenBudget: 8000 }),
      { units: report.units, tokenBudget: 8000 },
    );
    assert.ok(roomy.truncatedAway.length === 0, 'at 8000 tokens the cap is 1760 and the core fits');
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('ingest is an atomic full-mirror replace: a deleted module leaves no orphan behind', async () => {
  const root = makeRepo();
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  const ollama = fakeOllama();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ollama.fetchImpl;
  try {
    const options = {
      repoPath: root,
      store,
      embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
      environment: ENVIRONMENT,
      fetchImpl: ollama.fetchImpl,
      discoverRepoGates: false,
      clock: () => 1_770_000_000_000,
    };
    await initBrain(options);
    assert.deepEqual(await store.existingDocumentIds(['daijin.architecture.src-api']), ['daijin.architecture.src-api']);

    // Delete the whole api module and re-init. Its card must be GONE, not stale: an orphan
    // the existence gate keeps certifying is a brain that no longer matches the repo.
    rmSync(path.join(root, 'src/api'), { recursive: true, force: true });
    execFileSync('git', ['-C', root, 'add', '-A'], { env: { ...process.env, ...GIT_ENVIRONMENT }, stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'commit', '-m', 'remove the api module entirely'], {
      env: { ...process.env, ...GIT_ENVIRONMENT, GIT_AUTHOR_DATE: '2026-02-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z' },
      stdio: 'pipe',
    });
    await initBrain(options);
    assert.deepEqual(await store.existingDocumentIds(['daijin.architecture.src-api']), []);
    assert.deepEqual(await store.existingDocumentIds(['daijin.architecture.src-store']), ['daijin.architecture.src-store']);
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('MUTATION: an embedder that returns one vector short is refused, never written', async () => {
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  try {
    const units = [{
      id: 'daijin.convention.indentation', type: 'convention', path: '.daijin/brain/convention/indentation.md',
      title: 'Convention: Indentation', tags: [], meta: { area: 'conventions' },
      content: 'Rule: spaces.', body: 'Rule: spaces.', contentHash: null, core: 'Rule: spaces.',
    }];
    await assert.rejects(
      () => ingestUnits({ store, units, embedder: { embed: async () => [] }, project: 'default' }),
      /returned 0 vectors for 1 chunk\(s\); refusing to write misaligned embeddings/,
    );
    assert.deepEqual(await store.existingDocumentIds([units[0].id]), [], 'nothing was written');
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('import edges become module-node relationships, deduped and self-edge free', () => {
  const graph = {
    edges: [
      { src: 'src/api/server.js', dst: 'src/store/sqlite.js' },
      { src: 'src/api/server.js', dst: 'src/store/sqlite.js' },
      { src: 'src/a.js', dst: 'src/a.js' },
    ],
  };
  assert.deepEqual(importRelationships(graph), [
    { src: 'src/api/server.js', dst: 'src/store/sqlite.js', kind: 'imports' },
  ]);
});

test('chunkUnits keeps the flat order the embedder is called with', () => {
  const units = [
    { id: 'a', type: 'convention', path: 'a.md', title: 'A', tags: [], content: 'Rule: one.', body: 'Rule: one.' },
    { id: 'b', type: 'convention', path: 'b.md', title: 'B', tags: [], content: 'Rule: two.', body: 'Rule: two.' },
  ];
  const plans = chunkUnits(units);
  assert.deepEqual(plans.map((plan) => plan.unit.id), ['a', 'b']);
  assert.deepEqual(plans.flatMap((plan) => plan.chunks.map((chunk) => chunk.content)), ['Rule: one.', 'Rule: two.']);
});

test('a store whose project does not match the query scope is refused loudly', async () => {
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: null, embedder: EMBEDDER });
  try {
    await assert.rejects(
      () => initBrain({ repoPath: '/tmp', store, embedder: { embed: async () => [] } }),
      /needs a concrete project scope/,
    );
    const mismatched = await createSqliteStore({ path: path.join(directory, 'other.sqlite'), project: 'alpha', embedder: EMBEDDER });
    await assert.rejects(
      () => initBrain({ repoPath: '/tmp', store: mismatched, embedder: { embed: async () => [] }, project: 'beta' }),
      /but the store writes documents with project "alpha"/,
    );
    await mismatched.close();
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mode "ingest" refuses by name rather than overwriting a curated knowledge folder', async () => {
  const root = makeRepo({ 'agent/agent.md': '# Agent router\n' });
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  try {
    await assert.rejects(
      () => initBrain({ repoPath: root, mode: 'ingest', store, embedder: { embed: async () => [] }, environment: ENVIRONMENT }),
      /not implemented in this build.*Detected folder: agent/s,
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('layer1+layer2 records the spend refusal and still finishes Layer 1', async () => {
  const root = makeRepo();
  const { report, steps, store, directory } = await runInit(root, { mode: 'layer1+layer2', discoverRepoGates: false });
  try {
    assert.equal(report.phases.narrate.refused, true);
    assert.equal(report.phases.narrate.code, -32050);
    assert.ok(steps.some((step) => step.step === 'narration-refused' && step.level === 'warn'));
    assert.ok(report.floor, 'the zero-spend half of the pipeline completes regardless');
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('the gold-set files split what measures from what is only remembered', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-goldset-files-'));
  try {
    const active = [{ id: 'g001', query: 'a question', must_return: ['x'], provenance: 'structural:a', why: 'w' }];
    const retired = [{ id: 'g002', query: 'an old question', must_return: ['y'], provenance: 'identifier:gone', why: 'w', retired: { date: '2026-08-16', reason: 'the defining file src/gone.js is gone' } }];
    await writeGoldset(root, active);
    await writeRetiredGoldset(root, retired);

    const measured = YAML.parse(readFileSync(path.join(root, '.daijin/goldset.yaml'), 'utf8'));
    assert.deepEqual(measured.map((entry) => entry.id), ['g001']);
    const record = YAML.parse(readFileSync(path.join(root, '.daijin/goldset-retired.yaml'), 'utf8'));
    assert.equal(record.length, 1);
    assert.equal(record[0].retired.reason, 'the defining file src/gone.js is gone');

    // A later run must APPEND to the record, not replace it: a retirement is history.
    await writeRetiredGoldset(root, [{ id: 'g003', query: 'another old question', must_return: ['z'], provenance: 'identifier:alsoGone', why: 'w', retired: { date: '2026-09-01', reason: 'gone too' } }]);
    const grown = YAML.parse(readFileSync(path.join(root, '.daijin/goldset-retired.yaml'), 'utf8'));
    assert.deepEqual(grown.map((entry) => entry.query).sort(), ['an old question', 'another old question']);

    // And re-writing the same retirement must not duplicate it.
    await writeRetiredGoldset(root, retired);
    assert.equal(YAML.parse(readFileSync(path.join(root, '.daijin/goldset-retired.yaml'), 'utf8')).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with nothing retired, no retirement file is created at all', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-goldset-empty-'));
  try {
    assert.equal(await writeRetiredGoldset(root, []), null);
    assert.equal(existsSync(path.join(root, '.daijin/goldset-retired.yaml')), false, 'an empty record file reads as a record that was lost');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a carried-forward case whose module was deleted is RETIRED, not scored forever', async () => {
  // The staleness gate only has anything to judge because the previous run's gold set is
  // carried forward: re-mining alone regenerates from the current tree, so nothing it
  // produces can ever be stale. This is the whole path, end to end.
  const root = makeRepo();
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  const ollama = fakeOllama();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ollama.fetchImpl;
  try {
    const options = {
      repoPath: root,
      store,
      embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
      environment: ENVIRONMENT,
      fetchImpl: ollama.fetchImpl,
      discoverRepoGates: false,
      clock: () => 1_770_000_000_000,
    };
    await initBrain(options);
    const before = YAML.parse(readFileSync(path.join(root, '.daijin/goldset.yaml'), 'utf8'));
    const doomed = before.filter((entry) => entry.must_return.includes('daijin.architecture.src-api'));
    assert.ok(doomed.length > 0, 'the first run must have written cases pointing at the api card');

    rmSync(path.join(root, 'src/api'), { recursive: true, force: true });
    execFileSync('git', ['-C', root, 'add', '-A'], { env: { ...process.env, ...GIT_ENVIRONMENT }, stdio: 'pipe' });
    execFileSync('git', ['-C', root, 'commit', '-m', 'remove the api module entirely'], {
      env: { ...process.env, ...GIT_ENVIRONMENT, GIT_AUTHOR_DATE: '2026-02-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z' },
      stdio: 'pipe',
    });
    const second = await initBrain(options);

    const active = YAML.parse(readFileSync(path.join(root, '.daijin/goldset.yaml'), 'utf8'));
    assert.equal(
      active.some((entry) => entry.must_return.includes('daijin.architecture.src-api')),
      false,
      'a case pointing at a card that no longer exists must not keep scoring as a miss forever',
    );
    assert.ok(second.phases.goldset.retired > 0);
    const retiredRecord = YAML.parse(readFileSync(path.join(root, '.daijin/goldset-retired.yaml'), 'utf8'));
    assert.ok(retiredRecord.some((entry) => entry.must_return.includes('daijin.architecture.src-api')));
    assert.ok(retiredRecord.every((entry) => entry.retired.date && entry.retired.reason));
    assert.ok(second.phases.goldset.passed, 'once the dead cases are retired the gauge is fit again');
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeGoldset keys on the STABLE key, so a reworded case is not a duplicate', () => {
  const key = caseKey('structural:a', 'a question');
  const mined = [{ id: 'g001', key, query: 'a question', must_return: ['new'], provenance: 'structural:a' }];
  const carried = [
    // Same case, reworded by a user. The stable key says it is the same case.
    { id: 'g001', key, query: 'a question, but how I would ask it', must_return: ['old'], provenance: 'structural:a', must_not_outrank: ['other'] },
    { id: 'g002', key: 'paraphrase:auditor#11111111', query: 'a hand written question', must_return: ['x'], provenance: 'paraphrase:auditor' },
    { id: 'g003', key: 'structural:z#22222222', query: 'already retired', must_return: ['y'], provenance: 'structural:z', retired: { date: '2026-01-01', reason: 'gone' } },
  ];
  const merged = mergeGoldset(mined, carried);
  assert.equal(merged.length, 2, 'the reworded case is ONE case, not two');
  assert.equal(merged[0].query, 'a question, but how I would ask it', 'the user owns the wording');
  assert.deepEqual(merged[0].must_return, ['new'], 'mechanics own the answer: it is a fact about the tree as it is now');
  assert.deepEqual(merged[0].must_not_outrank, ['other'], 'and the user edit to the ranking constraint survives');
  assert.equal(merged[0].userEdited, true, 'the report can say how much of the gauge is user-worded');
  assert.equal(merged[1].carried, true, 'a user-authored case survives re-mining');
  assert.deepEqual(merged.map((entry) => entry.id), ['g001', 'g002'], 'ids are reassigned deterministically');
});

test('a legacy gold set with no keys still merges on what that format had', () => {
  const mined = [{ id: 'g001', key: caseKey('structural:a', 'a question'), query: 'a question', must_return: ['new'], provenance: 'structural:a' }];
  const legacy = [{ id: 'g001', query: 'a question', must_return: ['old'], provenance: 'structural:a' }];
  const merged = mergeGoldset(mined, legacy);
  assert.equal(merged.length, 1, 'provenance plus query is the identity that generation of the file had');
});

test('the miner writes a stable key that survives a re-mine and a rewording', () => {
  assert.equal(caseKey('identifier:foo', 'foo'), caseKey('identifier:foo', 'foo'), 'deterministic');
  assert.notEqual(caseKey('structural:history', 'which files change most often in this repo'), caseKey('structural:history', 'who has been changing this codebase'),
    'two cases sharing a provenance are told apart by their canonical query');
});
