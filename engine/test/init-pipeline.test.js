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
import { readBrainArtifacts, writeBrainArtifacts } from '../src/init/brain-artifacts.js';
import { caseKey } from '../src/init/goldset.js';
import { initBrain, mergeGoldset, reindexFromBrain, writeGoldset, writeRetiredGoldset } from '../src/init/pipeline.js';

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
      ['identify', 'evidence', 'scaffold', 'brain', 'ingest', 'gates', 'goldset', 'floor'],
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

    // D-0031: the indexed unit came from the FILE, not from the generator's memory.
    // sourceArtifact is written only by the artifact reader, so its presence in the store is
    // proof the index was derived from the brain rather than handed the in-memory units.
    const indexed = await store.allDocuments({ project: 'default' });
    assert.ok(indexed.length > 0);
    assert.ok(
      indexed.every((entry) => typeof entry.meta?.sourceArtifact === 'string' && entry.meta.sourceArtifact.endsWith('.md')),
      'every indexed unit names the brain file it was read from',
    );
    assert.ok(indexed.every((entry) => entry.meta.schema === 1), 'and the schema it was read under');

    // D-0030: the floor never ships without the range it was measured inside.
    assert.ok(report.floor.resolution, 'a floor with no resolution reads as certainty it does not have');
    assert.ok(report.floor.resolution.caseRate.control.total > 0);
    assert.equal(
      report.floor.resolution.caseRate.casesOfHeadroom,
      report.floor.resolution.caseRate.candidate.hits - report.floor.resolution.caseRate.control.hits,
    );
    assert.match(report.floor.resolution.reading, /deliberately wrong answers/);
    // Finding 80: the unlock decision carries the range it was made against.
    assert.ok('saturation' in report.floor.mcp, 'the unlock reports the range or explicitly nothing');
    assert.equal(report.floor.mcp.resolution, report.floor.resolution);

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
    const blocked = steps.find((step) => step.step === 'blocked' && step.level === 'warn');
    assert.ok(blocked);

    // F1, owner field test. The old message said only that the gold set failed its gates,
    // which is a conclusion with neither its evidence nor a next move. Three properties,
    // because the owner needed all three and had none:
    //
    // 1. an ACTION, not just a diagnosis
    assert.ok(report.blocked.action, 'a blocked report must say what to do next');
    // 2. the action reaches the WIRE. The report is an in-process object; the owner reads
    //    the emitted step, and a fix that lands only on the report is invisible to them.
    assert.ok(blocked.detail.includes(report.blocked.action),
      'the action must reach the emitted step, not just the report object');
    // 3. the EVIDENCE travels with it: every failed check named in the detail, each with
    //    its own floor from the gate below.
    for (const entry of report.blocked.failed) {
      assert.ok(blocked.detail.includes(entry), `the detail must name the ${entry} failure`);
    }
    assert.match(blocked.detail, /minimum \d+/);

    // This fixture is a ONE FILE repo, which is the shape the owner actually hit: too few
    // cases to mine at all. That case gets the attach-the-root advice rather than the
    // generic "mine more material", because a subdirectory attach is the likeliest cause
    // and the generic line sends someone off to write code they already have.
    assert.match(report.blocked.action, /repository root rather than a subdirectory/);

    // The CODE beside the prose, so the TUI can offer "attach the root instead" without
    // branching on a sentence. Wording written for a human must stay free to change; a
    // control wired to a comma is a control that breaks on an edit nobody thought was
    // behavioural. Closed set, and this fixture is the tiny case.
    assert.equal(report.blocked.actionCode, 'too-little-material');
    assert.ok(['too-little-material', 'gold-set-too-thin'].includes(report.blocked.actionCode));
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
    // Finding 82: the diagnosis names WHICH constraint bit, because the fixes differ. This
    // card's core is 785 tokens against a 660 token slot, so it cannot survive at this budget
    // however much of it is free; that is a different instruction from "the budget ran out",
    // which is what the curated arm actually hit.
    assert.match(trimmed.raiseSignal, /core LARGER THAN ONE CANDIDATE SLOT/);
    assert.equal(trimmed.truncatedAway[0].boundBy, 'core-larger-than-slot');
    assert.equal(trimmed.events.units, 1, 'distinct units, not events');

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

test('mode "ingest" refuses by name when there is no folder to adopt', async () => {
  const root = makeRepo();
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  try {
    await assert.rejects(
      () => initBrain({ repoPath: root, mode: 'ingest', store, embedder: { embed: async () => [] }, environment: ENVIRONMENT }),
      /adopts an existing knowledge folder and this repo has none that qualifies/,
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('mode "ingest" adopts a curated folder as-is and measures it on the same gauge', async () => {
  // The units a human wrote must be distinguishable from machine output in the brain
  // itself, not only in the report: that distinction is the whole value of adopting.
  const curated = {
    'agent/agent.md': '# Agent router\n\nRead this first for the fixture app.\n',
    'agent/decisions.md': [
      '# Decisions',
      '',
      '## ADR-001 Use the sqlite store for the fixture',
      'The sqlite backend was chosen because one file per repo is simpler to ship.',
      '',
      '## ADR-002 Rank candidates by descending score',
      'Ranking sorts on score so the strongest candidate is funded first.',
      '',
      '## ADR-003 Keep whitespace normalization in chunking',
      'Chunk text is normalized before embedding so identical prose hashes identically.',
      '',
      '## ADR-004 Serve the api from an injected store',
      'The server takes its store as a parameter so tests can supply a double.',
      '',
    ].join('\n'),
    'agent/errors.md': [
      '# Errors',
      '',
      '- The memory store dropped rows when the caller reused a cursor across calls.',
      '- Token counting split on whitespace and undercounted CJK text badly.',
      '- The health route started the server twice under concurrent requests.',
      '',
    ].join('\n'),
    'agent/conventions.md': '# Conventions\n\nSource files use two-space indentation and single quotes.\n',
  };
  const root = makeRepo(curated);
  const { report, steps, store, directory } = await runInit(root, { mode: 'ingest', discoverRepoGates: false });
  try {
    assert.ok(report.phases.adopt, 'the adopt phase ran');
    assert.equal(report.phases.adopt.documents, 4);
    assert.ok(steps.some((step) => step.phase === 'adopt' && step.step === 'adopted'));

    // The split rule per file is reported, because a silent granularity decision is
    // indistinguishable from a bug when the numbers come out.
    const byFile = new Map(report.phases.adopt.files.map((entry) => [entry.file, entry]));
    assert.equal(byFile.get('agent/decisions.md').rule, 'headings');
    assert.equal(
      byFile.get('agent/decisions.md').units,
      5,
      'one unit per ADR (4) plus the preamble, which is a record too: dropping the text before the first heading silently loses content',
    );
    assert.ok(
      report.units.some((unit) => unit.meta.preamble === true),
      'the preamble is marked, so a gold-set miner can tell an index from a record',
    );
    assert.equal(byFile.get('agent/errors.md').rule, 'bullets');
    assert.equal(byFile.get('agent/errors.md').units, 4, 'one unit per hand-written lesson, plus its heading preamble');
    assert.equal(byFile.get('agent/conventions.md').rule, 'whole');

    // Types follow the folder's own convention.
    const adoptedUnits = report.units;
    const byId = new Map(adoptedUnits.map((unit) => [unit.id, unit]));
    assert.ok([...byId.keys()].some((id) => id.startsWith('adopted.decision.decisions.')));
    assert.ok([...byId.keys()].some((id) => id.startsWith('adopted.lesson.errors.')));
    assert.ok([...byId.keys()].some((id) => id.startsWith('adopted.convention.conventions')));

    // The distinction that matters: a human wrote these.
    assert.ok(adoptedUnits.every((unit) => unit.meta.generated === false), 'adopted units are NOT machine-generated');
    assert.ok(adoptedUnits.every((unit) => unit.meta.adopted === true && unit.meta.layer === 0));
    assert.ok(adoptedUnits.every((unit) => unit.meta.sourceFile.startsWith('agent/')), 'every unit cites the file it came from');

    // And it is measured on exactly the same gauge, so the two brains are comparable.
    assert.ok(report.phases.goldset, 'a gold set was mined from the curated brain');
    assert.ok(report.phases.goldset.gates.length === 5);
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

test('a floor whose gauge cannot be permuted says so instead of taking the floor down', async () => {
  // One distinct answer means no wrong answer exists to swap in. The range is unavailable
  // and that is reportable; it must not fail the run or be silently omitted.
  const { measureResolution } = await import('../src/init/floor.js');
  const { permuteAnswers } = await import('../src/init/rerank-ab.js');
  assert.throws(
    () => permuteAnswers([{ id: 'g1', query: 'q', must_return: ['only'] }]),
    /at least two distinct answers/,
  );
  assert.equal(typeof measureResolution, 'function');
});

// --- D-0031 -----------------------------------------------------------------------

test('THE CONTRACT CANNOT ENTER THE STORE, whichever producer made the unit', async () => {
  // Asserted at the ingest boundary with a PLANT, not on any producer's filter. The
  // invariant currently survives by accident: the generate path constructs its units rather
  // than collecting files, and the adopt filter cannot reach .daijin/agents only because
  // agents/ is a SIBLING of .daijin/brain. Three one-line edits break that, and none of
  // them would touch this test.
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  try {
    const plants = [
      { id: 'plant.a', type: 'convention', path: '.daijin/agents/student.md', title: 'Student rules', tags: [], meta: { area: 'contract' }, content: 'Rule text.', body: 'Rule text.' },
      // plant.b was `agent/agents/teacher.md`, which the old pattern refused because it
      // matched ANY `agents/` segment. Ultrareview finding 2: that overreach failed the
      // whole ingest for a host repo with `src/agents/`, the standard layout for LangGraph,
      // CrewAI and AutoGen, which is the population this tool is for. The contract is a
      // LOCATION and not a naming convention, so a host's agents directory is ordinary
      // source and is now allowed; the control below asserts that positively.
      //
      // The plant it becomes is the contract IN DISGUISE, which is what this test was
      // reaching for: same location, spelled so a naive matcher misses it.
      { id: 'plant.b', type: 'convention', path: '.daijin/brain/conventions.md', title: 'Sneaky', tags: [], meta: { area: 'x', sourceFile: './.daijin/agents/teacher.md' }, content: 'Rule text.', body: 'Rule text.' },
      { id: 'plant.e', type: 'convention', path: '.daijin/brain/conventions.md', title: 'Windows spelling', tags: [], meta: { area: 'x', sourceFile: '.daijin\\agents\\auditor.md' }, content: 'Rule text.', body: 'Rule text.' },
      { id: 'plant.f', type: 'convention', path: '.daijin/brain/conventions.md', title: 'Absolute', tags: [], meta: { area: 'x', sourceFile: '/home/me/repo/.daijin/agents/watcher.md' }, content: 'Rule text.', body: 'Rule text.' },
      { id: 'plant.c', type: 'convention', path: '.daijin/manifest.json', title: 'Manifest', tags: [], meta: { area: 'x' }, content: 'Schema.', body: 'Schema.' },
      { id: 'plant.d', type: 'convention', path: '.daijin/brain/conventions.md', title: 'Cited contract', tags: [], meta: { area: 'x' }, citations: ['.daijin/agents/watcher.md'], content: 'Rule text.', body: 'Rule text.' },
    ];
    for (const plant of plants) {
      await assert.rejects(
        () => ingestUnits({ store, units: [plant], embedder: { embed: async (texts) => texts.map(() => new Array(DIMENSION).fill(0.1)) }, project: 'default' }),
        /Refusing to ingest .* sourced from the CONTRACT/,
        `${plant.id} reached the store through ${plant.path}`,
      );
      assert.deepEqual(await store.existingDocumentIds([plant.id]), [], 'and nothing was written');
    }

    // THE HOST REPO'S OWN AGENTS, which must now pass. Finding 2's population: a unit about
    // a repo that keeps its agent code in `src/agents/`, and a unit that merely CITES such a
    // file. The old pattern refused both and took the entire ingest with them.
    await ingestUnits({
      store,
      units: [
        { id: 'host.agents', type: 'convention', path: '.daijin/brain/conventions.md', title: 'Host agents', tags: [], meta: { area: 'x', sourceFile: 'src/agents/planner.py' }, content: 'Rule: planner.', body: 'Rule: planner.' },
        { id: 'host.cite', type: 'convention', path: '.daijin/brain/conventions.md', title: 'Cites host agents', tags: [], meta: { area: 'x' }, citations: ['src/agents/crew.ts', 'extension/manifest.json'], content: 'Rule: cites.', body: 'Rule: cites.' },
      ],
      embedder: { embed: async (texts) => texts.map(() => new Array(DIMENSION).fill(0.1)) },
      project: 'default',
    });
    assert.deepEqual(
      (await store.existingDocumentIds(['host.agents', 'host.cite'])).sort(),
      ['host.agents', 'host.cite'],
      'a host repo with src/agents/ or a PWA manifest must ingest; refusing it fails the whole run for the target population',
    );

    // The control: an ordinary brain unit passes, so the refusal is not refusing everything.
    await ingestUnits({
      store,
      units: [{ id: 'ok.unit', type: 'convention', path: '.daijin/brain/conventions.md', title: 'Real', tags: [], meta: { area: 'x' }, citations: ['src/a.js'], content: 'Rule: real.', body: 'Rule: real.' }],
      embedder: { embed: async (texts) => texts.map(() => new Array(DIMENSION).fill(0.1)) },
      project: 'default',
    });
    assert.deepEqual(await store.existingDocumentIds(['ok.unit']), ['ok.unit']);
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the index is DERIVED: delete it, regenerate, and the gauge is unchanged', async () => {
  // Both halves are asserted. Case-rate equality alone would pass a regeneration that
  // changed retrieval materially, because on a saturated corpus the rate can hold at its
  // ceiling while what the gauge can discriminate moves underneath it. The permuted control
  // is the instrument that shows that, which is why it is checked too.
  const root = makeRepo();
  const scratch = mkdtempSync(path.join(tmpdir(), 'daijin-regen-'));
  const first = makeStore();
  const ollama = fakeOllama();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ollama.fetchImpl;
  const options = (store) => ({
    repoPath: root,
    artifactRoot: scratch,
    store,
    embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
    environment: ENVIRONMENT,
    fetchImpl: ollama.fetchImpl,
    discoverRepoGates: false,
    clock: () => 1_770_000_000_000,
  });
  try {
    const storeA = await createSqliteStore({ path: first.file, project: 'default', embedder: EMBEDDER });
    const before = await initBrain(options(storeA));
    await storeA.close();
    assert.ok(before.floor, 'the first run measured');
    assert.ok(existsSync(path.join(scratch, '.daijin/brain/architecture.md')), 'the brain is durable markdown');

    // Delete the INDEX entirely. The brain files stay where they are.
    rmSync(first.directory, { recursive: true, force: true });
    const second = makeStore();
    const storeB = await createSqliteStore({ path: second.file, project: 'default', embedder: EMBEDDER });
    const after = await initBrain(options(storeB));
    await storeB.close();

    assert.deepEqual(
      after.floor.caseRate,
      before.floor.caseRate,
      'the gold set scores identically after the index was destroyed and rebuilt',
    );
    assert.equal(after.floor.mrr, before.floor.mrr);
    assert.equal(after.floor.violations, before.floor.violations);
    assert.deepEqual(
      after.floor.resolution.caseRate.control,
      before.floor.resolution.caseRate.control,
      'and so does the permuted control, which is the half that catches a subtle retrieval change',
    );
    assert.equal(after.floor.resolution.caseRate.casesOfHeadroom, before.floor.resolution.caseRate.casesOfHeadroom);
    rmSync(second.directory, { recursive: true, force: true });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a unit with sub-headings survives the brain round trip byte for byte', () => {
  // The failure this catches is invisible to an id check: written without demotion, a unit's
  // own "## Imports from" reads back as a NEW record, the unit is truncated to its first
  // section, and the surviving fragment keeps the id.
  const unit = {
    id: 'daijin.architecture.src-store',
    type: 'architecture',
    title: 'Module: src/store',
    tags: [],
    citations: ['src/store/sqlite.js'],
    meta: { area: 'src/store', layer: 1, generated: true },
    content: '# Module: src/store\n\nClaim: two files.\n\n## Imports from\n\n- src/util\n\n## Imported by\n\n- src/api',
  };
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-brain-rt-'));
  try {
    return (async () => {
      await writeBrainArtifacts(root, [unit]);
      const back = await readBrainArtifacts(root);
      assert.equal(back.units.length, 1, 'one unit in, one unit out, not one plus orphan fragments');
      assert.equal(back.units[0].content.trim(), unit.content.trim(), 'content survives byte for byte');
      assert.ok(back.units[0].content.includes('## Imports from'), 'and its sub-headings come back at their own level');
      assert.deepEqual(back.units[0].citations, unit.citations);
      assert.equal(back.units[0].meta.area, 'src/store');
    })();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the brain files are CANONICAL: edit one and the rebuilt index says what the file says', async () => {
  // The falsifiable form of "the index is derived from the brain". An init that ingested
  // from memory would pass every other test in this file and fail this one.
  const root = makeRepo();
  const scratch = mkdtempSync(path.join(tmpdir(), 'daijin-canon-'));
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  const ollama = fakeOllama();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ollama.fetchImpl;
  try {
    await initBrain({
      repoPath: root,
      artifactRoot: scratch,
      store,
      embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
      environment: ENVIRONMENT,
      fetchImpl: ollama.fetchImpl,
      discoverRepoGates: false,
      clock: () => 1_770_000_000_000,
    });

    // A human edits the brain by hand, which is the whole point of durable markdown.
    const conventions = path.join(scratch, '.daijin/brain/conventions.md');
    const edited = readFileSync(conventions, 'utf8').replace(
      /Rule: source files indent with/,
      'Rule: HAND EDITED, source files indent with',
    );
    assert.notEqual(edited, readFileSync(conventions, 'utf8'), 'the fixture edit applied');
    writeFileSync(conventions, edited);

    const result = await reindexFromBrain({
      repoPath: root,
      artifactRoot: scratch,
      store,
      embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
    });
    assert.ok(result.documents > 0);

    const documents = await store.allDocuments({ project: 'default' });
    const indentation = documents.find((entry) => entry.id === 'daijin.convention.indentation');
    assert.ok(indentation, 'the edited unit is in the index');
    assert.match(indentation.content, /HAND EDITED/, 'the index says what the FILE says, not what the generator said');
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a reindex with no brain refuses rather than quietly producing an empty index', async () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'daijin-nobrain-'));
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  try {
    await assert.rejects(
      () => reindexFromBrain({ repoPath: empty, artifactRoot: empty, store, embedder: { embed: async () => [] } }),
      /No brain to reindex/,
    );
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a unit that quotes a daijin marker is REFUSED rather than silently mangled', async () => {
  // The reader strips marker lines, so a unit whose body quotes one comes back without it
  // and the index would hold something the brain does not say. The round-trip check is what
  // catches it, and this is the case that proves the check is not decoration.
  const root = makeRepo({
    'src/util/marker.js': 'export function markerDoc() {\n  return 1;\n}\n',
  });
  const scratch = mkdtempSync(path.join(tmpdir(), 'daijin-marker-'));
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  const ollama = fakeOllama();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ollama.fetchImpl;
  try {
    await assert.rejects(
      () => initBrain({
        repoPath: root,
        artifactRoot: scratch,
        store,
        embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
        environment: ENVIRONMENT,
        fetchImpl: ollama.fetchImpl,
        discoverRepoGates: false,
        clock: () => 1_770_000_000_000,
        // A producer that emits a unit quoting the format's own marker.
        scaffoldOptions: { injectUnit: true },
      }),
      /round trip changed/,
      'a unit the format cannot represent must stop the run, not enter the index half-written',
    );
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('when survival fails, the raise signal names the smallest budget that works', async () => {
  // D-0003 calls content survival the mechanical raise signal. A signal that only says
  // "something is wrong" is half an instrument, so the sweep is walked upward until cores
  // survive. Measured on the P3.5 curated arm: the case rate is FLAT across 3k to 8k so the
  // rate rule picks 3000, while survival fails at 3000 and 4000 and passes at 6000.
  const bulk = {};
  for (let index = 0; index < 45; index += 1) {
    bulk[`src/bulk/module${String(index).padStart(4, '0')}.js`] = `export function bulkThing${index}() {\n  return ${index};\n}\n`;
  }
  const root = makeRepo(bulk);
  const scratch = mkdtempSync(path.join(tmpdir(), 'daijin-raise-'));
  const { directory, file } = makeStore();
  const store = await createSqliteStore({ path: file, project: 'default', embedder: EMBEDDER });
  const ollama = fakeOllama();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ollama.fetchImpl;
  try {
    const report = await initBrain({
      repoPath: root,
      artifactRoot: scratch,
      store,
      embedder: { embed: async (texts) => texts.map((text) => hashEmbed(text)) },
      environment: ENVIRONMENT,
      fetchImpl: ollama.fetchImpl,
      scaffoldOptions: { filesPerCard: 45 },
      budgets: [3000, 8000],
      discoverRepoGates: false,
      clock: () => 1_770_000_000_000,
    });
    const survival = report.floor.contentSurvival;
    assert.equal(survival.status, 'fail', 'the 785-token core cannot fit a 660-token slot at 3000');
    assert.equal(survival.raisedBudget, 8000, 'and the report names the budget at which it can');
    assert.match(survival.recommendation, /mechanical raise signal/);
    assert.match(survival.recommendation, /smallest budget this corpus can be served at/);
  } finally {
    globalThis.fetch = originalFetch;
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('every key the pipeline EMITS is either forwarded to the wire or named internal', async () => {
  // THE GATE FOR THE NEXT DROPPED FIELD. methods.js forwards a fixed set of keys from the
  // pipeline's step events, which is right - the event carries in-process detail a client
  // has no business seeing - but an unlisted key is dropped IN SILENCE. That is how
  // actionCode came to be real engine-side and unreachable client-side: added to the emit,
  // killed at the forwarder, and nothing said so.
  //
  // Driven from a REAL RUN rather than harvested from source. A regex sweep over emit
  // calls is the technique that under-read the health states in this repo and produced a
  // false finding; what a run actually emits cannot be under-read the same way.
  const root = mkdtempSync(path.join(tmpdir(), 'daijin-init-keys-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/only.js'), 'export function onlyThing() {\n  return 1;\n}\n');
  writeFileSync(path.join(root, 'package.json'), '{"name":"tiny"}');
  const { steps, store, directory } = await runInit(root, { discoverRepoGates: false });
  try {
    const seen = new Set();
    for (const event of steps) for (const key of Object.keys(event)) seen.add(key);

    // What the forwarder in methods.js passes through, plus what the runner stamps itself.
    const FORWARDED = new Set(['phase', 'step', 'detail', 'counts', 'level', 'actionCode']);
    // Deliberately NOT on the wire, each with the reason it stays in process.
    const INTERNAL = new Set([
      'ts',      // the runner restamps every event so the stream has one clock
      'jobId',   // added by the runner, not by the pipeline
    ]);

    const dropped = [...seen].filter((key) => !FORWARDED.has(key) && !INTERNAL.has(key));
    assert.deepEqual(dropped, [],
      'the pipeline emits a key that methods.js silently drops: forward it, or add it to INTERNAL with a reason');

    // Non-vacuity: if the run emitted nothing, or the shape collapsed, every filter above
    // passes trivially. A blocked run must have produced the interesting keys.
    assert.ok(seen.has('step') && seen.has('detail'), 'the run emitted no recognisable events');
    assert.ok(seen.has('actionCode'), 'the blocked event did not carry actionCode');
  } finally {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
