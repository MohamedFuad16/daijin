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
//   DIVERGENT   known, named disagreements, each PINNED to its exact key delta with an
//               owner-visible reason; the list may only SHRINK
//
// The last one is the ratchet, and it PINS THE DELTA rather than skipping the check. The
// first version skipped, and two mutations proved what that costs: removing the envelope
// check entirely, and deleting a documented key from the engine, both left the suite green,
// because an exempted comparison is not a comparison. A known gap must not buy silence for
// the gap next to it. So each entry names exactly which keys are extra or missing today,
// and anything beyond that still fails.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GymLedger, gymDatabasePath } from '../src/gym/ledger.js';
import { createRpcServer } from '../src/rpc/server.js';
import { repoLayout } from '../src/state/layout.js';
import { createSqliteStore } from '../src/store/sqlite.js';
import { documentedKeys, documentedShape } from './helpers/contract-shape.js';

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
  // Its read path returns the file verbatim, so the shape is set by the WRITER, and the
  // writer runs a measurement. Checking it against a hand-written fixture would assert the
  // fixture: the gate's own staleness check caught exactly that here, reporting a pinned
  // divergence as stale because the fixture row lacked the stamps the engine writes.
  scoreHistory: 'the row shape comes from the writer, and the writer measures a floor',
});

// Prose STAYS for these, ruled rather than defaulted: their returns really are "the file,
// plus classification", and seven speculative shapes would be documentation nobody asked
// for pretending to be coverage. The gate printing them every run is the honest bound.
const PROSE = Object.freeze({
  gatesGet: 'returns file content plus classification; the row describes it in English',
  gatesSet: 'returns the updated gates.yaml; described, not declared',
  settingsGet: 'described as "full settings object, secrets masked"',
  settingsSet: 'described as "updated settings"',
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
    serveStatus: { params: {} },
    mcpSnippet: { params: { repoPath } },
    budgetEstimate: { params: { repoPath, mode: 'gym' } },
    gymStatus: { params: { repoPath } },
    // A BARE LIST, like documents: the contract's cell is `[{ ... }]`, so the parsed
    // top-level keys ARE the row's keys and the subject is the first row. The earlier
    // recipe asked for a field named `exams` that does not exist, so documentedKeys
    // returned null and the check quietly did nothing. Found by the envelope rule below,
    // which is the point of having a rule rather than a count.
    examList: { params: { repoPath }, pick: (result) => result[0] },
    // Moved out of prose by the D-0035 batch: their rows now reference the examList row
    // shape by name, which the reader follows, so one clause apiece turned two described
    // returns into two checked ones.
    examVeto: { params: { repoPath, examId: 'exam-0001', reason: 'Superseded by a later commit that reverts this one entirely.' } },
    examUpdate: { params: { repoPath, examId: 'exam-0001', patch: { title: 'A retitled exam' } } },
    board: { params: {} },
    agentFileGet: { params: { repoPath, role: 'student' } },
    initBrain: { params: { repoPath, mode: 'layer1' }, skipCall: true },
    gatesDiscover: { params: { repoPath }, skipCall: true },
    analyze: { params: { repoPath } },
    repoAttach: { params: { repoPath } },
    repoDetach: { params: { repoPath: '/definitely/not/attached' }, expectError: true },
    // TWO checks: the envelope and the row inside it. The envelope only became comparable
    // when the leader applied the notes-after-the-brace convention, and comparing it
    // immediately found `exam` on the wire and not in the row, so the convention paid for
    // itself in the first run after it landed.
    examDetail: {
      params: { repoPath, examId: 'exam-0001' },
      checks: [
        { label: 'envelope' },
        { label: 'attempts row', field: 'attempts', pick: (result) => result.attempts[0] },
      ],
    },
  };
}

// Known, named disagreements. THIS LIST MAY ONLY SHRINK. Each entry is a decision someone
// has to make (fix the engine or amend the contract), not a permission to ignore.
// EMPTY, and that is the ratchet having been turned rather than the gate having been
// loosened. Every entry was resolved by the D-0035 batch: three field additions documented
// because a client reads them, board's row corrected to the noun it returns, and two
// removals (analyze's five extras and examDetail's exam) taken OFF the wire after
// readership was verified in the client rather than assumed.
const DIVERGENT = Object.freeze({});

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
      if (recipe.skipCall) continue;

      let result;
      try {
        result = await server.methods[method](recipe.params);
      } catch (error) {
        if (recipe.expectError) continue;
        mismatches.push(`${method}: threw ${error.message}`);
        continue;
      }

      for (const check of recipe.checks ?? [{ field: recipe.field, pick: recipe.pick }]) {
        const where = check.label ? `${method} (${check.label})` : method;
        const shape = await documentedShape(method, check.field ? { field: check.field } : {});
        if (!shape) continue;
        const subject = check.pick ? check.pick(result) : result;
        if (!subject || typeof subject !== 'object') continue;

        // OPTIONAL KEYS MAY BE ABSENT and may not be unknown. `quarantineReason?` is a real
        // thing the contract says, and a gate that could not express it would push every
        // optional field into the exemption list, which is how an exemption list stops
        // meaning anything.
        const documented = [...shape.required, ...shape.optional];
        // The known delta is SUBTRACTED, not used to skip. A pinned gap buys silence for
        // itself and for nothing else, so a new difference in the same row still fails.
        const known = DIVERGENT[where] ?? DIVERGENT[method] ?? { extra: [], missing: [] };
        const emitted = Object.keys(subject).sort();
        const missing = shape.required.filter((key) => !emitted.includes(key) && !known.missing.includes(key));
        const extra = emitted.filter((key) => !documented.includes(key) && !known.extra.includes(key));
        if (missing.length || extra.length) {
          mismatches.push(`${where}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
        }
        // A pin that no longer describes reality is itself a defect: the gap was closed and
        // the exemption outlived it, which is how an exemption list stops meaning anything.
        const staleExtra = known.extra.filter((key) => !emitted.includes(key));
        const staleMissing = known.missing.filter((key) => emitted.includes(key));
        if (staleExtra.length || staleMissing.length) {
          mismatches.push(`${where}: DIVERGENT is stale, remove [${[...staleExtra, ...staleMissing].join(', ')}]`);
        }
      }
    }
  } finally {
    await server.close();
    await kit.cleanup();
  }

  assert.deepEqual(mismatches, [],
    'the engine and the contract disagree; fix the engine or amend the contract, then remove the entry from DIVERGENT if it is listed');
});

test('a covered method checks its ENVELOPE whenever the contract declares one', async () => {
  // Coverage of the coverage. A check can be deleted from a recipe and nothing else
  // notices: removing examDetail's envelope check left the suite green, which is the same
  // dead-gate shape one level up. This is a RULE rather than a count of checks, so it
  // keeps meaning something as recipes change: if the contract declares a top-level shape
  // for a covered method, a check without a `field` has to exist to compare against it.
  const entries = Object.entries(recipes('/x'));
  const missing = [];
  for (const [method, recipe] of entries) {
    if (recipe.skipCall) continue;
    if (!await documentedKeys(method)) continue;
    const checks = recipe.checks ?? [{ field: recipe.field, pick: recipe.pick }];
    if (!checks.some((check) => !check.field)) missing.push(method);
  }
  assert.deepEqual(missing, [],
    'the contract declares a top-level shape for these and no check compares against it');
});

test('the divergent list may only shrink, so a known gap cannot quietly grow', async () => {
  // The ratchet. A new disagreement must be fixed or added here deliberately, and adding
  // one is a visible act rather than a test that quietly keeps passing.
  assert.deepEqual(Object.keys(DIVERGENT).sort(), [],
    'the known-divergent set changed; that is a decision, not a detail');
  for (const [method, entry] of Object.entries(DIVERGENT)) {
    assert.ok(entry.why.length > 30, `${method} needs a real reason, not a label`);
    assert.ok(entry.extra.length || entry.missing.length,
      `${method} pins no keys, so it exempts everything, which is the mute button this design replaced`);
  }
});
