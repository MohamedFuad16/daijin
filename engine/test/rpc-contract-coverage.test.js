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
  // Live AND now shape-declared. It was the method that exposed the tiering hole: listed
  // here because it embeds, described in prose so nothing could compare it, and therefore
  // checked by NO tier while this list claimed it was covered elsewhere. The row now
  // declares a shape and the acceptance script compares it.
  diagnose: 're-measures, so it embeds; its shape is declared and checked in the acceptance script',
  // Its read path returns the file verbatim, so the shape is set by the WRITER, and the
  // writer runs a measurement. Checking it against a hand-written fixture would assert the
  // fixture: the gate's own staleness check caught exactly that here, reporting a pinned
  // divergence as stale because the fixture row lacked the stamps the engine writes.
  scoreHistory: 'the row shape comes from the writer, and the writer measures a floor',
});

// Prose STAYS for these, ruled rather than defaulted: their returns really are "the file,
// plus classification", and seven speculative shapes would be documentation nobody asked
// for pretending to be coverage. The gate printing them every run is the honest bound.
// Prose STAYS for these, and as of the 2026-08-17 claim audit their claims are CHECKED
// rather than assumed: every assertion each row makes was tested against the engine. That
// changes what this bucket means. It was "unchecked claims", which is worse than declaring
// nothing because a client author reasonably builds against a false one; it is now
// "checked once", which is weaker than a running gate and much stronger than prose.
//
// The audit found ONE false claim in the five rows it examined, and it was gatesSet, whose
// "updated gates.yaml" went stale the moment its sibling gained a parsed half. The engine
// moved and that row is now declared and covered, which is why it is absent here.
const PROSE = Object.freeze({
  settingsGet: 'claims verified 2026-08-17: full (every DEFAULT_SETTINGS key present) and masked (a sentinel key never appears)',
  // Prose rather than covered: its row shape is pinned in agent-catalog.test.js against
  // seeded temp directories. Covered here it would read the REAL ~/.claude/agents, whose
  // contents differ per machine and are empty on CI, so the nested-shape subject would be
  // a row that exists only on some machines.
  agentCatalog: 'claims verified 2026-08-17: id/name/description/model/path/scope pinned in agent-catalog.test.js',
  settingsSet: 'claims verified 2026-08-17: the full settings object, same key set as settingsGet, reflecting the patch',
  agentFileSet: 'claims verified 2026-08-17: currentHash recomputed, defaultHash stable, modified flipped, key set matches agentFileGet',
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
    // COVERED rather than prose, deliberately: it is a pure local file read with no
    // fixture cost, so there is no reason for it to buy an exemption. The subject is the
    // top-level envelope; the nested provider and model shapes are pinned in
    // roles-providers.test.js against the committed catalog.
    providerCatalog: { params: {} },
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
    // Moved out of prose by the gatesGet finding: its row promised classification the wire
    // never carried, and prose is where no gate checks.
    gatesGet: { params: { repoPath } },
    gatesSet: { params: { repoPath, patch: { content: 'gates: []\n' } } },
    agentFileGet: { params: { repoPath, role: 'student' } },
    initBrain: { params: { repoPath, mode: 'layer1' }, skipCall: true },
    // skipCall like its siblings: calling it would start a real clone against the network.
    // Its refusals and its step stream are covered offline in init-clone.test.js against a
    // local bare repository, and what that does NOT prove is stated there rather than here.
    repoClone: { params: { url: 'https://example.test/owner/name' }, skipCall: true },
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

test('the NESTED shapes of serveStatus are checked, not merely documented', async () => {
  // Newly possible, and worth taking. The field reader used to match only `field: [{...}]`,
  // a LIST of objects, and returned null for every plain-object field, so `ollama`, `db`
  // and `spendGate` were documented and unreadable: nothing asked for them, so no gate went
  // quietly weak, but the F5 amendment that wrote those key sets down could not be enforced
  // by the gate that exists to enforce key sets. Documented and reachable are different
  // claims, and this makes them the same claim here.
  const kit = await fixture();
  const server = createRpcServer({ stateRoot: kit.stateRoot, write: () => {} });
  try {
    const status = await server.methods.serveStatus({});
    for (const field of ['ollama', 'db', 'spendGate']) {
      const documented = await documentedKeys('serveStatus', { field });
      assert.ok(documented, `serveStatus.${field} must be documented with a shape`);
      assert.deepEqual(Object.keys(status[field]).sort(), documented,
        `serveStatus.${field} and its contract row disagree`);
    }
    // The ollama row is the one F5 closed: the key set must be IDENTICAL whether or not the
    // probe succeeded, which is the property that let a client stop rendering "?".
    assert.equal(Object.hasOwn(status.ollama, 'hint'), true,
      'hint is present on both branches, or no client can rely on a fixed key set');
  } finally {
    await server.close();
    await kit.cleanup?.();
  }
});

test('the shape parser survives a list nested inside a list, and does not drop the key', async () => {
  // THE PARSER ITSELF, gated. The strip that hides nested members used to match to the
  // FIRST closing bracket, so `a: [{ b, c: [{ d }] }]` left a dangling `}]` glued to the
  // next key, which then failed the identifier test and VANISHED from the documented set.
  // The gate would have compared the engine against a contract it had mis-read and blamed
  // the engine for the key it lost itself. No shipped row was deep enough to trip it, which
  // is why it had never been seen: the first row that was, was the one being added.
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'contract-')), 'methods.md');
  await writeFile(file, [
    '| method | params | result |',
    '| --- | --- | --- |',
    '| `deep` | `{}` | `{ alpha, beta: [{ id, gamma: [{ x, y }] }], omega }` a doubly nested shape |',
    '| `flat` | `{}` | `{ one, two: [{ a, b }], three }` one level, the case that always worked |',
  ].join('\n'));

  assert.deepEqual(await documentedKeys('deep', { file }), ['alpha', 'beta', 'omega'],
    'a key AFTER a doubly nested list must survive the strip');
  assert.deepEqual(await documentedKeys('flat', { file }), ['one', 'three', 'two']);
  // The nested reader still reaches into the outer list, which is the other half of the job.
  assert.deepEqual(await documentedKeys('deep', { file, field: 'beta' }), ['gamma', 'id']);
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
  // The prose bucket's residual, said out loud every run rather than assumed away. Ruling
  // a row prose assumes the prose is ACCURATE, and nothing here checks that: gatesGet sat
  // in this bucket promising "per-gate classification and liveness evidence" while the wire
  // carried a path and a string, and the screen built for the promise showed an empty table
  // over a file describing three gates. Prose is not merely unchecked shape, it is unchecked
  // CLAIM.
  console.log('  ^ prose rows are CLAIMS, not merely unchecked shapes. Claims verified 2026-08-17;');
  console.log('    verified once is weaker than a running gate: a prose row can go stale silently,');
  console.log('    which is exactly how gatesSet went wrong an hour after gatesGet was fixed.');
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

// ---- the gates file: parsed, and tolerant of a file the user owns -------------------------

test('a discovery-written gates file comes back parsed, evidence and all', async () => {
  const { parseGatesFile } = await import('../src/rpc/methods.js');
  const parsed = parseGatesFile([
    '# a comment discovery writes',
    'version: 1',
    'discoveredAt: 2026-08-17T00:00:00.000Z',
    'timeoutMs: 300000',
    'summary:',
    '  total: 2',
    '  carryingSignal: 1',
    'gates:',
    '  - id: test',
    '    command: npm test',
    '    classification: live',
    '    enabled: true',
    '    baseline:',
    '      status: pass',
    '      exitCode: 0',
    '  - id: build',
    '    command: npm run build',
    '    classification: unavailable',
    '    enabled: false',
  ].join('\n'));

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.discovered.gates.length, 2);
  assert.equal(parsed.discovered.summary.carryingSignal, 1, 'the number the screen renders');
  assert.equal(parsed.discovered.gates[0].classification, 'live');
  assert.equal(parsed.discovered.gates[0].baseline.exitCode, 0, 'the liveness evidence survives');
  // Rows pass through AS WRITTEN. This document is the user's; a key they added by hand
  // belongs in the answer, which is the opposite of the attempts-row rule and for the
  // opposite reason: that row is the engine's record, this one it only reads.
  const custom = parseGatesFile('gates:\n  - id: mine\n    myOwnKey: kept\n');
  assert.equal(custom.discovered.gates[0].myOwnKey, 'kept');
});

test('a file the user broke still comes back, and says WHY it is not interpreted', async () => {
  // gates.yaml is a file the engine invites the user to edit, so a parse error is a fact
  // about the file rather than a failure of the method. Failing the call would take the
  // user's own text away from them at the moment they most need to see it.
  const { parseGatesFile } = await import('../src/rpc/methods.js');

  const broken = parseGatesFile('gates:\n  - id: test\n   command: bad indent\n');
  assert.equal(broken.discovered, null);
  assert.match(broken.parseError, /not valid YAML/);

  const empty = parseGatesFile('');
  assert.equal(empty.discovered, null);
  assert.match(empty.parseError, /empty or is not a mapping/);

  const noList = parseGatesFile('version: 1\nsummary:\n  total: 0\n');
  assert.equal(noList.discovered, null);
  assert.match(noList.parseError, /no `gates:` list/);

  // NULL IS NOT ZERO GATES, which is the distinction the empty table got wrong: a file that
  // cannot be interpreted and a file describing zero gates are different facts, and the
  // screen said "0 carrying signal" for the first while meaning the second.
  const none = parseGatesFile('gates: []\n');
  assert.notEqual(none.discovered, null);
  assert.deepEqual(none.discovered.gates, []);
  assert.equal(none.parseError, null);
  assert.equal(none.discovered.summary, null, 'a file with no summary is not a summary of nothing');
});

// ---- the gates vocabulary the contract now publishes ---------------------------------------
//
// The client asked what values it can receive, having assumed pass/fail/violations from the
// contract's prose. Two of those three were wrong: `violations` never occurs, and `timeout`
// and `unavailable` both do. A baseline column built on the assumption would have printed a
// string the engine never sends and had no branch for two it does.
//
// These lock the answer to the SOURCE rather than to a list typed here, so a fifth status
// appearing anywhere in the runner fails this test rather than silently reaching a client.

test('baseline.status is exactly the four the runner can emit, checked against its source', async () => {
  const { readFile: read } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gym', 'gates.js');
  const source = await read(runner, 'utf8');

  // Every status literal the runner assigns, harvested from the code.
  const emitted = new Set([...source.matchAll(/status:\s*(?:timedOut\s*\?\s*)?'([a-z-]+)'/g)].map((match) => match[1]));
  for (const branch of source.matchAll(/status:\s*timedOut\s*\?\s*'([a-z-]+)'\s*:\s*code === 0\s*\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) {
    emitted.add(branch[1]); emitted.add(branch[2]); emitted.add(branch[3]);
  }
  assert.deepEqual([...emitted].sort(), ['fail', 'pass', 'timeout', 'unavailable'],
    'the runner emits a status the contract does not document, or stopped emitting one it does');

  // And the contract says the same four, so the two cannot drift.
  const { contractRow } = await import('./helpers/contract-shape.js');
  const row = await contractRow('gatesGet');
  for (const status of ['pass', 'fail', 'timeout', 'unavailable']) {
    assert.ok(row.includes(`\`${status}\``), `the contract row must name ${status}`);
  }
  // NOT asserted: that the word "violations" is absent from the row. It appears there
  // because the row EXPLAINS why a tool with pre-existing violations is a measured gate
  // rather than a status, and asserting on a word's absence from prose tests the prose
  // rather than the vocabulary. The deepEqual against the runner's source above is what
  // establishes that `violations` is not a status; this half only checks the four are named.
});

test('discovered and parseError are mutually exclusive, always', async () => {
  // The client branches on `discovered` alone, which is only safe if there is no partial
  // parse. There is not: the parse is all-or-nothing at the document level, and a malformed
  // row inside a readable document passes through as written rather than being rejected.
  const { parseGatesFile } = await import('../src/rpc/methods.js');
  const cases = [
    'gates:\n  - id: a\n    command: x\n',       // clean
    'gates: []\n',                                // zero gates
    'gates:\n  - id: a\n   bad: indent\n',        // unparseable
    '',                                            // empty
    'version: 1\n',                                // no gates list
    'gates:\n  - id: a\n  - nonsense\n  - 42\n',  // readable document, junk rows
  ];
  for (const content of cases) {
    const { discovered, parseError } = parseGatesFile(content);
    assert.equal(Boolean(discovered) !== Boolean(parseError), true,
      `exactly one of discovered/parseError must be set for ${JSON.stringify(content)}`);
  }
  // The junk-row case specifically: the document is readable, so it is DISCOVERED, and the
  // rows come through untouched. Rejecting the document because one row is odd would refuse
  // a file the user is allowed to write.
  const junk = parseGatesFile('gates:\n  - id: a\n  - nonsense\n  - 42\n');
  assert.equal(junk.parseError, null);
  assert.equal(junk.discovered.gates.length, 3);
});

// ---- the enum sweep: every value a client can receive is named in its row -----------------
//
// The THIRD row failure mode, closed rather than instanced. A row can carry the right shape
// and an accurate claim and still leave a client guessing an ENUM, and nothing else notices,
// because the gate compares key sets and prose describes methods rather than vocabularies.
// It fired twice in one row: the client assumed baseline.status was pass/fail/violations,
// wrong on all three counts, since violations never occurs and timeout and unavailable do.
//
// Each enum is bound to its SOURCE OF TRUTH, not to a list typed here. An imported constant
// cannot drift; a harvested literal fails this test when the code grows a value the row does
// not name. That is what makes the mode closed rather than swept once.

test('every enum a client can receive is named in its contract row', async () => {
  // The WHOLE row, params and returns: initBrain's modes are named in its params cell, and
  // reading only the returns cell reported them missing when a reader would find them at
  // once. A vocabulary check asks whether the contract names the value where someone
  // reading the method would see it.
  const { contractLine, documentedEnum } = await import('./helpers/contract-shape.js');
  const { RUN_MODES } = await import('../src/gym/run-mode.js');
  const { RUN_STATUSES } = await import('../src/gym/ledger.js');
  const { VERDICTS } = await import('../src/gym/grading.js');
  const { AUTHORING_STATUSES, BENCHMARK_STATUSES } = await import('../src/gym/exams.js');
  const { MODES } = await import('../src/init/pipeline.js');
  const { ungradedExplanation } = await import('../src/rpc/methods.js');

  // Harvested from source, so a new literal in the code fails here rather than reaching a
  // client. These two enums live as literals rather than as constants.
  const { readFile: read } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const discovery = await read(path.join(root, 'init', 'gate-discovery.js'), 'utf8');
  const classifications = [...new Set([...discovery.matchAll(/classification:\s*'([a-z-]+)'/g)].map((match) => match[1]))];
  // A KNOWN COUNT, not a floor. This is the last harvest in the gate, and the lesson that
  // retired the others applies to it: a floor against empty is not a floor against
  // incomplete, and the health harvest failed by finding three of four while its floor of
  // two passed. Four classifications exist; a fifth, or a regex that stops seeing one, has
  // to be a deliberate edit here.
  assert.equal(classifications.length, 4,
    `the classification harvest found ${classifications.length} values; it under-reads, or gate-discovery grew one`);
  // HEALTH_STATES is imported rather than harvested, because the harvest could not see it.
  // Two of the four live in a ternary and the regex read `return 'x'` forms, so it found
  // three, and the floor requiring at least two values passed because three is not zero. A
  // harvest that silently under-reads is the shape this gate exists to catch, one level up.
  const { HEALTH_STATES } = await import('../src/rpc/methods.js');

  const ENUMS = [
    { method: 'examDetail', field: 'mode', values: RUN_MODES, source: 'RUN_MODES' },
    { method: 'gatesGet', field: 'baseline.status', values: ['pass', 'fail', 'timeout', 'unavailable'],
      source: 'the runner literals, harvested in its own test' },
    { method: 'examDetail', field: 'status', values: RUN_STATUSES, source: 'RUN_STATUSES' },
    { method: 'examDetail', field: 'verdict', values: VERDICTS, source: 'VERDICTS' },
    { method: 'examDetail', field: 'ungradedCode', source: 'ungradedExplanation over every run status',
      values: [...new Set(RUN_STATUSES.map((status) => ungradedExplanation({ status }).code))] },
    { method: 'examList', field: 'status', values: AUTHORING_STATUSES, source: 'AUTHORING_STATUSES' },
    { method: 'examList', field: 'benchmarkStatus', values: BENCHMARK_STATUSES, source: 'BENCHMARK_STATUSES' },
    { method: 'initBrain', field: 'mode', values: MODES, source: 'MODES' },
    { method: 'gatesGet', field: 'classification', values: classifications, source: 'harvested from classifyBaselineRun' },
    { method: 'serveStatus', field: 'health', values: HEALTH_STATES, source: 'HEALTH_STATES' },
  ];

  const unnamed = [];
  for (const { method, field, values, source } of ENUMS) {
    // A harvest that yields nothing would pass this test vacuously, which is the dead-gate
    // shape one level up: the check would report every row as compliant precisely because it
    // had stopped reading the code.
    // Kept as a backstop for the imported constants, where under-reading is impossible and
    // an empty import would still be a broken test. The harvest above is pinned by count
    // instead, because a floor cannot see incompleteness.
    assert.ok(values.length >= 2, `${method}.${field}: ${source} yielded ${values.length} values, so the source is broken`);
    const row = await contractLine(method);
    assert.ok(row, `${method} has no contract row`);
    for (const value of values) {
      if (!row.includes(value)) unnamed.push(`${method}.${field} does not name ${value} (from ${source})`);
    }

    // THE OTHER DIRECTION, which the first version of this gate could not do. Asserting
    // only that the code's values are named catches a value a client cannot look up, and
    // cannot catch a value the ROW names that the engine can never produce. Subset is half
    // a vocabulary check wearing the name of a whole one: tui-builder found that shape in
    // their gate, and mine had it in the mirror direction, after I had named "documented
    // and reachable are different claims" the day before.
    //
    // A value only the contract knows is worse than a missing one in a specific way: it
    // reads as a state that exists, so a client writes a branch for it, and the branch is
    // dead code that will never fire and can never be proven wrong by use.
    const documented = documentedEnum(row, field);
    assert.ok(documented, `${method}.${field}: the row's vocabulary could not be read, so this check would pass vacuously`);
    const phantom = documented.filter((value) => !values.includes(value));
    if (phantom.length) unnamed.push(`${method}.${field} documents ${phantom.join(', ')}, which ${source} cannot produce`);
  }
  assert.deepEqual(unnamed, [],
    'a client receiving an unnamed value would have to guess it, and a client reading a phantom one would write a branch that never fires');
});
