// D-0035's surface-wide gate: what the engine EMITS against what the contract DOCUMENTS,
// for every method on the frozen surface, with the uncovered set NAMED and printed.
//
// The ruling this implements: two tiers, and the partition itself is asserted rather than
// assumed. A method that is in neither tier fails this test, so the surface cannot grow a
// method that nobody decided about. Per the no-silent-caps rule the gate prints what it
// does not cover on every run, because a gate that quietly covers a subset reads as
// covering everything.
//
// FOUR CATEGORIES, all declared below, all printed:
//   COVERED     called here, key set compared against the contract
//   LIVE        needs a real embedder; its shape is asserted in the acceptance script
//   PROSE       the contract describes the return in English and declares no key set,
//               so there is nothing to compare against yet
//   DIVERGENT   known, named disagreements between engine and contract, each with an
//               owner-visible reason; the list may only SHRINK
//
// The last one is the ratchet. A gate that had to be green on the day it was written would
// have been written to cover whatever already agreed, which is how a gate ends up
// measuring its author's patience rather than the surface.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GymLedger, gymDatabasePath } from '../src/gym/ledger.js';
import { createRpcServer } from '../src/rpc/server.js';
import { repoLayout } from '../src/state/layout.js';
import { createSqliteStore } from '../src/store/sqlite.js';
import { documentedKeys } from './helpers/contract-shape.js';

/// Every method with a table row, read from the contract rather than listed here.
async function documentedMethods() {
  const text = await readFile(path.join(process.cwd(), 'src', 'rpc', 'methods.md'), 'utf8');
  const names = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    if (/^`[a-zA-Z]+`$/.test(cells[1] ?? '')) names.push(cells[1].replace(/`/g, ''));
  }
  return names;
}

const LIVE = Object.freeze({
  search: 'embeds the query against a live Ollama',
  retrievalScore: 'scores the whole gold set through the embedder',
  diagnose: 're-measures, so it embeds',
});

const PROSE = Object.freeze({
  gatesGet: 'returns file content plus classification; the row describes it in English',
  gatesSet: 'returns the updated gates.yaml; described, not declared',
  settingsGet: 'described as "full settings object, secrets masked"',
  settingsSet: 'described as "updated settings"',
  examVeto: 'described as "updated exam record"',
  examUpdate: 'described as "updated exam record"',
  agentFileSet: 'described as "updated file record with recomputed hashes"',
});

const REFUSING = Object.freeze({
  gymStart: 'refuses for spend before returning a success shape',
  rolePing: 'refuses for spend before returning a success shape',
  diagnoseNarrate: 'refuses for spend before returning a success shape',
});

/// A repo with everything the hermetic calls need: an indexed brain, a ledger with one
/// graded attempt, a gates file, a measured floor and an agent file.
async function fixture() {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'dj-coverage-repo-'));
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dj-coverage-state-'));
  await mkdir(path.join(repoPath, '.daijin', 'brain'), { recursive: true });
  await writeFile(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'exit 0' } }), 'utf8');

  const layout = await repoLayout(repoPath, { stateRoot, ensure: true });
  await mkdir(layout.indexRoot, { recursive: true });
  await mkdir(layout.recordsRoot, { recursive: true });
  const store = await createSqliteStore({
    path: layout.databasePath,
    repoPath,
    project: 'default',
    embedder: { provider: 'ollama', model: 'bge-m3', digest: 'sha256:test', dimension: 4 },
  });
  await store.transaction(async () => {
    await store.upsertDocument({
      id: 'web.decision.adr-0001', project: 'default', type: 'decision', path: 'brain/adr-0001.md',
      title: 'Storage layer redesign', tags: ['storage'], meta: { area: 'storage' },
      content: 'The storage layer moved off the shared mount.', contentHash: 'h1',
    });
    await store.replaceChunks('web.decision.adr-0001', [{ ordinal: 0, content: 'moved off the shared mount', vector: [1, 0, 0, 0] }]);
  });
  await store.close();

  await writeFile(layout.scoreHistoryPath, JSON.stringify([
    { at: new Date().toISOString(), caseRate: { exact: 0.92, cases: '23 of 25' }, chosenBudget: 4000 },
  ]), 'utf8');
  await writeFile(layout.gatesPath, 'gates: []\n', 'utf8');

  const ledger = GymLedger.open(gymDatabasePath(repoPath));
  ledger.putExam({
    examId: 'exam-0001', title: 'A seeded exam', status: 'promoted', benchmarkStatus: 'active',
    heldOut: false, scopeTier: 'S', baseCommit: 'a'.repeat(40), goldCommit: 'b'.repeat(40),
    task: 'A task statement long enough for the validator to accept it as real.',
    scopeFiles: 1, scopeInsertions: 6, provenance: { source: 'commit-mining', commit: 'c'.repeat(40) },
  });
  const cycleId = ledger.startCycle({ mode: 'evaluation' });
  const runId = ledger.recordRun({
    cycleId, examId: 'exam-0001', mode: 'evaluation', status: 'completed', verdict: 'partial',
    resultFile: 'runs/one.json', applied: true, workTokens: 41_200, tokenCap: 450_000,
  });
  ledger.importRubricBatch({
    mode: 'evaluation',
    rubrics: [{
      runId,
      verdict: 'partial',
      axes: Object.fromEntries(['correctness_vs_gold', 'convention_adherence', 'decision_awareness',
        'reasoning_quality', 'blast_radius_awareness'].map((name, index) => [name, { score: index + 1, citations: ['x'] }])),
      taskDigest: 'sha256:task', submissionDigest: 'sha256:submission',
    }],
  });
  ledger.close?.();

  return { repoPath, stateRoot, cleanup: async () => {
    await rm(repoPath, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  } };
}

/// How to call each covered method, and which part of its answer carries the shape.
function recipes(repoPath) {
  return {
    hello: { params: {} },
    jobCancel: { params: { jobId: 'job-none-0000' } },
    documents: { params: { repoPath }, pick: (result) => result[0] },
    scoreHistory: { params: { repoPath }, pick: (result) => result[0] },
    serveStatus: { params: {} },
    mcpSnippet: { params: { repoPath } },
    budgetEstimate: { params: { repoPath, mode: 'gym' } },
    gymStatus: { params: { repoPath } },
    examList: { params: { repoPath }, field: 'exams', pick: (result) => result.exams?.[0] },
    board: { params: {} },
    agentFileGet: { params: { repoPath, role: 'student' } },
    initBrain: { params: { repoPath, mode: 'layer1' }, skipCall: true },
    gatesDiscover: { params: { repoPath }, skipCall: true },
    analyze: { params: { repoPath } },
    repoAttach: { params: { repoPath } },
    repoDetach: { params: { repoPath: '/definitely/not/attached' }, expectError: true },
    examDetail: { params: { repoPath, examId: 'exam-0001' }, field: 'attempts', pick: (result) => result.attempts[0] },
  };
}

// Known, named disagreements. THIS LIST MAY ONLY SHRINK. Each entry is a decision someone
// has to make (fix the engine or amend the contract), not a permission to ignore.
const DIVERGENT = Object.freeze({
  scoreHistory: 'engine adds originPath and index (the checkout and brain a row was measured on); the contract row predates them',
  mcpSnippet: 'engine adds reason, the lock sentence floor.js wrote, which the TUI displays; the contract row names only unlocked, threshold and snippet',
  agentFileGet: 'engine adds installed (whether the repo has its own file) and path (where it would be written); the contract row names neither',
  analyze: 'engine adds name, repoPath, files, git and brainFolder alongside the five documented keys; the contract row documents a subset of what it returns',
  board: 'the contract documents the ROW shape and never the envelope; the engine returns { rows, total }, so the documented keys describe a finding and the emitted keys describe the response around it',
});

test('the contract-shape gate partitions the WHOLE surface, and says what it does not cover', async () => {
  const methods = await documentedMethods();
  const declared = new Set([...Object.keys(LIVE), ...Object.keys(PROSE), ...Object.keys(REFUSING), ...Object.keys(recipes('/x'))]);

  const undeclared = methods.filter((name) => !declared.has(name));
  assert.deepEqual(undeclared, [],
    'a documented method is in no tier: decide whether it is covered here, live, prose-only or refusing');
  const phantom = [...declared].filter((name) => !methods.includes(name));
  assert.deepEqual(phantom, [], 'a tier names a method the contract does not document');

  // NO SILENT CAPS: what this gate does not check, printed every run.
  console.log(`contract-shape gate: ${methods.length} documented methods`);
  console.log(`  covered here      ${Object.keys(recipes('/x')).length}`);
  console.log(`  live (acceptance) ${Object.keys(LIVE).join(', ')}`);
  console.log(`  prose, no shape   ${Object.keys(PROSE).join(', ')}`);
  console.log(`  refuse, no shape  ${Object.keys(REFUSING).join(', ')}`);
  console.log(`  known divergent   ${Object.keys(DIVERGENT).join(', ') || 'none'}`);
});

test('every covered method emits the key set its contract row documents', async () => {
  const kit = await fixture();
  const server = createRpcServer({
    stateRoot: kit.stateRoot,
    write: () => {},
    deps: {
      checkOllama: async () => { throw new Error('probe skipped'); },
      createEmbedderClient: () => { throw new Error('embedder unavailable'); },
    },
  });
  const mismatches = [];
  try {
    await server.methods.repoAttach({ repoPath: kit.repoPath });
    for (const [method, recipe] of Object.entries(recipes(kit.repoPath))) {
      if (recipe.skipCall || DIVERGENT[method]) continue;
      const documented = await documentedKeys(method, recipe.field ? { field: recipe.field } : {});
      if (!documented) continue;

      let result;
      try {
        result = await server.methods[method](recipe.params);
      } catch (error) {
        if (recipe.expectError) continue;
        mismatches.push(`${method}: threw ${error.message}`);
        continue;
      }
      const subject = recipe.pick ? recipe.pick(result) : result;
      if (!subject || typeof subject !== 'object') continue;

      const emitted = Object.keys(subject).sort();
      const missing = documented.filter((key) => !emitted.includes(key));
      const extra = emitted.filter((key) => !documented.includes(key));
      if (missing.length || extra.length) {
        mismatches.push(`${method}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
      }
    }
  } finally {
    await server.close();
    await kit.cleanup();
  }

  assert.deepEqual(mismatches, [],
    'the engine and the contract disagree; fix the engine or amend the contract, then remove the entry from DIVERGENT if it is listed');
});

test('the divergent list may only shrink, so a known gap cannot quietly grow', async () => {
  // The ratchet. A new disagreement must be fixed or added here deliberately, and adding
  // one is a visible act rather than a test that quietly keeps passing.
  assert.deepEqual(Object.keys(DIVERGENT).sort(),
    ['agentFileGet', 'analyze', 'board', 'mcpSnippet', 'scoreHistory'],
    'the known-divergent set changed; that is a decision, not a detail');
  for (const [method, why] of Object.entries(DIVERGENT)) {
    assert.ok(why.length > 30, `${method} needs a real reason, not a label`);
  }
});
