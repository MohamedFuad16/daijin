// The gold-set miner and its five integrity gates.
//
// Every gate here ships with the mutation that KILLS it, because the plan's soundness rule
// is a merge requirement: "no gate ships without a mutation test demonstrating it CAN
// fail (scrambled index, invented citation, broken baseline). A gate without a
// demonstrated failure mode is dead coverage." The mutation is named in each test title.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEvidence } from '../src/init/evidence.js';
import {
  commitCases, identifierCases, mineGoldset, selectCases, structuralCases, subjectToQuery, targetCaseCount,
} from '../src/init/goldset.js';
import {
  DEFAULT_FLOORS,
  diversityGate,
  existenceGate,
  findStaleCases,
  identifierFloorFor,
  leakageGate,
  longestSharedSpan,
  provenanceGate,
  pruneVanishedConstraints,
  retireCases,
  runGoldsetGates,
  stalenessGate,
} from '../src/init/goldset-gates.js';
import { scaffoldLayer1 } from '../src/init/scaffold.js';

const SOURCES = new Map([
  ['src/util/tokens.js', 'export function countTokens(text) {\n  return text.length;\n}\n\nexport function normalizeWhitespace(text) {\n  return text.trim();\n}\n'],
  ['src/store/sqlite.js', "import { countTokens } from '../util/tokens.js';\nimport lodash from 'lodash';\n\nexport class SqliteStore {}\n\nexport function createSqliteStore() {\n  return new SqliteStore();\n}\n"],
  ['src/store/memory.js', "import { countTokens } from '../util/tokens.js';\n\nexport function createMemoryStore() {\n  return { rows: [] };\n}\n"],
  ['src/rag/rank.js', "import { countTokens } from '../util/tokens.js';\n\nexport function rankRetrieval(rows) {\n  return rows;\n}\n\nexport function fuseRankings(a, b) {\n  return [...a, ...b];\n}\n"],
  ['src/api/server.js', "import { createSqliteStore } from '../store/sqlite.js';\nimport { rankRetrieval } from '../rag/rank.js';\nimport fetch from 'node-fetch';\n\nexport function startServer() {\n  return { createSqliteStore, rankRetrieval, fetch };\n}\n"],
  ['test/rank.test.js', "import { rankRetrieval } from '../src/rag/rank.js';\n\nexport function exerciseRanking() {\n  return rankRetrieval([]);\n}\n"],
]);
const FILES = [...SOURCES.keys(), 'package.json', 'README.md'];

const COMMITS = [
  ['src/store/sqlite.js', 'add the sqlite backed document store'],
  ['src/store/memory.js', 'introduce the memory store for tests'],
  ['src/rag/rank.js', 'sort ranking candidates by score descending'],
  ['src/api/server.js', 'start the api server with an injected store'],
  ['src/util/tokens.js', 'count tokens by splitting on whitespace'],
  ['test/rank.test.js', 'exercise the ranking function from tests'],
  ['src/rag/rank.js', 'fuse two ranking lists into one'],
  ['src/store/sqlite.js', 'document the sqlite store constructor'],
];

function historyFixture(entries = COMMITS) {
  return {
    available: true,
    reason: null,
    cap: 2000,
    capped: false,
    total: entries.length,
    commits: entries.map(([file, subject], index) => ({
      sha: String(index).padStart(40, '0'),
      shortSha: String(index).padStart(12, '0'),
      author: 'Ada',
      authorEmail: 'ada@example.test',
      date: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
      subject,
      body: '',
      files: [{ path: file, added: 3, deleted: 1, binary: false, renamed: false }],
    })),
  };
}

function fixture({ history = historyFixture() } = {}) {
  const evidence = buildEvidence({
    analysis: {
      repoPath: '/fixture', name: 'fixture', files: { count: FILES.length, source: 'git-ls-files' },
      languages: [], structure: { areas: [] },
    },
    sources: SOURCES,
    files: FILES,
    manifests: { 'package.json': { dependencies: { lodash: '^4.0.0' } } },
    history,
  });
  const { units } = scaffoldLayer1(evidence);
  return { evidence, units, history };
}

/** A store double that answers only what the existence gate asks. */
function indexOf(units, { drop = [] } = {}) {
  const known = new Set(units.map((unit) => unit.id).filter((id) => !drop.includes(id)));
  return { async existingDocumentIds(ids) { return ids.filter((id) => known.has(id)); } };
}

const shas = (history) => new Set(history.commits.flatMap((commit) => [commit.sha, commit.shortSha]));

// --- the miner --------------------------------------------------------------------

test('the target count is displayed with the formula that produced it', () => {
  assert.deepEqual(targetCaseCount(53), {
    target: 25, chunkCount: 53, scaled: 3, minimum: 25, maximum: 150,
    formula: 'max(25, ceil(53 chunks / 22)) capped at 150 = 25',
  });
  assert.equal(targetCaseCount(1000).target, 46);
  assert.equal(targetCaseCount(100_000).target, 150, 'the cap holds');
});

test('conventional-commit bookkeeping is stripped from a mined query', () => {
  assert.equal(subjectToQuery('feat(store): add the sqlite backend (#42)'), 'add the sqlite backend');
  assert.equal(subjectToQuery('[JIRA-1] fix the ranking order'), 'fix the ranking order');
});

test('commit archaeology proposes only single-area commits with a real question in them', () => {
  const { evidence, units, history } = fixture();
  const cardByArea = new Map(units.filter((unit) => unit.type === 'architecture' && unit.meta.area).map((unit) => [unit.meta.area, unit]));
  const cases = commitCases(history, { cardByArea });
  assert.equal(cases.length, COMMITS.length);
  assert.ok(cases.every((entry) => entry.provenance.startsWith('commit-archaeology:')));
  assert.ok(cases.every((entry) => entry.must_return.length === 1));

  // A commit touching two areas has no single correct answer, so it must not be proposed.
  const twoAreas = historyFixture();
  twoAreas.commits[0].files.push({ path: 'src/rag/rank.js', added: 1, deleted: 0, binary: false, renamed: false });
  assert.equal(commitCases(twoAreas, { cardByArea }).length, COMMITS.length - 1);

  // A two-word subject is not a question anyone would ask.
  const terse = historyFixture([['src/rag/rank.js', 'wip']]);
  assert.equal(commitCases(terse, { cardByArea }).length, 0);
  assert.ok(evidence.areas.length > 0);
});

test('structural cases require uniqueness, and identifier cases require a sole definition', () => {
  const { evidence, units } = fixture();
  const cardByArea = new Map(units.filter((unit) => unit.type === 'architecture' && unit.meta.area).map((unit) => [unit.meta.area, unit]));
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));

  const structural = structuralCases(evidence, { cardByArea, unitsById });
  assert.ok(structural.some((entry) => entry.provenance.startsWith('structural:sole-consumer:lodash')));
  assert.ok(structural.some((entry) => entry.provenance === 'structural:convention:indentation'));
  assert.ok(structural.every((entry) => entry.must_return.length === 1));

  const identifiers = identifierCases(evidence, { cardByArea, limit: 50 });
  assert.ok(identifiers.every((entry) => entry.identifier === true));
  assert.ok(identifiers.some((entry) => entry.query === 'createSqliteStore'));
  assert.ok(
    identifiers.every((entry) => evidence.symbols.byName.get(entry.query).size === 1),
    'a symbol two files define is not answerable by one card',
  );
});

test('selection keeps the spread: no answer takes the whole set', () => {
  const many = Array.from({ length: 40 }, (unused, index) => ({
    query: `question ${index}`, must_return: ['answer.a'], must_not_outrank: [], identifier: false,
    provenance: `commit-archaeology:${index}`, source: 'commit-archaeology', why: 'w', target: {},
  }));
  const others = ['b', 'c', 'd'].map((letter) => ({
    query: `about ${letter}`, must_return: [`answer.${letter}`], must_not_outrank: [], identifier: false,
    provenance: `structural:${letter}`, source: 'structural', why: 'w', target: {},
  }));
  const chosen = selectCases([...many, ...others], { target: 6, identifierQuota: 0 });
  const perAnswer = new Map();
  for (const entry of chosen) perAnswer.set(entry.must_return[0], (perAnswer.get(entry.must_return[0]) || 0) + 1);
  assert.equal(chosen.length, 6);
  assert.ok(perAnswer.get('answer.a') <= 3, 'round-robin over the ANSWER keeps one hot module from filling the set');
  assert.equal(perAnswer.size, 4);
});

test('a shortfall against the target is reported, never padded', () => {
  const { evidence, units, history } = fixture({ history: { available: false, reason: 'none', cap: 2000, commits: [] } });
  const mined = mineGoldset({ evidence, units, history, chunkCount: 4000 });
  assert.ok(mined.cases.length < mined.target.target);
  assert.ok(mined.notes.some((note) => note.includes('reported rather than padded')));
});

// --- the five gates, each with the mutation that kills it --------------------------

test('EXISTENCE passes on the live index, and a scrambled index kills it', async () => {
  const { evidence, units, history } = fixture();
  const { cases } = mineGoldset({ evidence, units, history, chunkCount: 500 });
  const healthy = await existenceGate(cases, { store: indexOf(units) });
  assert.equal(healthy.status, 'pass');

  // MUTATION: drop one document from the index. The gate must name the id and its cases.
  const dropped = cases[0].must_return[0];
  const scrambled = await existenceGate(cases, { store: indexOf(units, { drop: [dropped] }) });
  assert.equal(scrambled.status, 'fail');
  assert.equal(scrambled.failures[0].id, dropped);
  assert.ok(scrambled.failures[0].cases.length > 0);
});

test('LEAKAGE passes identifier cases and dies on a query copied from the answer', () => {
  const { evidence, units, history } = fixture();
  const { cases } = mineGoldset({ evidence, units, history, chunkCount: 500 });
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  assert.equal(leakageGate(cases, { unitsById }).status, 'pass');
  assert.ok(cases.some((entry) => entry.identifier), 'the pass above must actually include identifier cases');

  // MUTATION: lift a sentence out of the answer and use it as the query.
  const card = units.find((unit) => unit.id === 'daijin.architecture.src-store');
  const stolen = card.core.split('\n')[0];
  const leaked = leakageGate([{ id: 'g999', query: stolen, must_return: [card.id] }], { unitsById });
  assert.equal(leaked.status, 'fail');
  assert.equal(leaked.failures[0].contained, true);
});

test('longestSharedSpan measures a contiguous run of WORDS, not a bag and not punctuation', () => {
  assert.equal(longestSharedSpan('alpha beta gamma', 'the alpha beta gamma delta'), 3);
  assert.equal(longestSharedSpan('alpha gamma', 'alpha beta gamma'), 1, 'two separate single hits are not a quoted phrase');
  assert.equal(longestSharedSpan('createSqliteStore', 'exports createSqliteStore here'), 1, 'a bare identifier is one token, never a quote');
  // Found live on the P3 target, then again on TokaiHub: a scoped package name is ONE
  // identifier however many hyphens and slashes it carries. The first fix stripped
  // punctuation tokens and @aws-sdk/client-cognito-identity-provider still counted six
  // words, blocking a whole gold set on a case that leaks nothing. The unit of prose is
  // the whitespace-delimited word.
  assert.equal(
    longestSharedSpan('where is the @vitejs/plugin-react package used', 'External packages used here: @vitejs/plugin-react (1 files)'),
    1,
    'the package name is one identifier, one token',
  );
  assert.equal(
    longestSharedSpan(
      'where is the @aws-sdk/client-cognito-identity-provider package used',
      'Imported but not declared: @aws-sdk/client-cognito-identity-provider (1 files: lambdas/pre-signup.mjs)',
    ),
    1,
    'a six-word package name is still one identifier',
  );
});

test('a scoped package name in a query is not leakage, and a copied sentence still is', () => {
  const unitsById = new Map([['u1', {
    id: 'u1',
    content: 'External packages used here:\n- @vitejs/plugin-react (1 files)\nClaim: the root area holds one source file and imports nothing.',
  }]]);
  const clean = leakageGate([{ id: 'g1', query: 'where is the @vitejs/plugin-react package used', must_return: ['u1'] }], { unitsById });
  assert.equal(clean.status, 'pass', JSON.stringify(clean.failures));

  const leaked = leakageGate(
    [{ id: 'g2', query: 'the root area holds one source file and imports nothing', must_return: ['u1'] }],
    { unitsById },
  );
  assert.equal(leaked.status, 'fail', 'six real words lifted from the answer is still a quotation');
});

test('STALENESS retires a case whose target is gone, and skipping the retirement kills the gate', async () => {
  const { evidence, units, history } = fixture();
  const { cases } = mineGoldset({ evidence, units, history, chunkCount: 500 });
  const identifier = cases.find((entry) => entry.identifier);
  const withoutFile = FILES.filter((file) => file !== identifier.target.file);
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));

  const stale = findStaleCases(cases, { files: withoutFile, commits: shas(history), unitsById });
  assert.ok(stale.some((entry) => entry.case === identifier.id));

  const retired = retireCases(cases, stale, { date: '2026-08-16' });
  const retiredCase = retired.find((entry) => entry.id === identifier.id);
  assert.equal(retiredCase.retired.date, '2026-08-16');
  assert.match(retiredCase.retired.reason, /is gone/);
  assert.ok(retiredCase.query, 'a retired case keeps its record rather than being deleted');
  assert.equal(
    stalenessGate(retired.filter((entry) => !entry.retired), { files: withoutFile, commits: shas(history), unitsById }).status,
    'pass',
  );

  // MUTATION: skip the retirement. The gate must refuse to let a dead case measure.
  const unretired = await runGoldsetGates(cases, {
    store: indexOf(units), units, files: withoutFile, commits: shas(history),
    symbols: evidence.symbols, date: '2026-08-16', retire: false,
  });
  const gate = unretired.gates.find((entry) => entry.id === 'staleness');
  assert.equal(gate.status, 'fail');
  assert.equal(unretired.passed, false);
});

test('PROVENANCE resolves every origin, and an invented commit kills it', () => {
  const { evidence, units, history } = fixture();
  const { cases } = mineGoldset({ evidence, units, history, chunkCount: 500 });
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const cardByArea = new Map(units.filter((unit) => unit.type === 'architecture' && unit.meta.area).map((unit) => [unit.meta.area, unit]));
  const context = { commits: shas(history), symbols: evidence.symbols, unitsById, cardByArea };
  assert.equal(provenanceGate(cases, context).status, 'pass');

  // MUTATION 1: an invented sha.
  const invented = cases.map((entry) => (entry.source === 'commit-archaeology'
    ? { ...entry, provenance: 'commit-archaeology:deadbeefdead' } : entry));
  const failedSha = provenanceGate(invented, context);
  assert.equal(failedSha.status, 'fail');
  assert.match(failedSha.failures[0].reason, /not in the walked history/);

  // MUTATION 2: an origin that is not even parseable.
  const unparseable = provenanceGate([{ id: 'g1', query: 'q', must_return: ['x'], provenance: 'because I said so' }], context);
  assert.equal(unparseable.status, 'fail');
  assert.match(unparseable.failures[0].reason, /unparseable/);

  // MUTATION 3: an identifier case naming a symbol the scan never found.
  const ghost = provenanceGate(
    [{ id: 'g2', query: 'ghostSymbol', must_return: ['x'], identifier: true, provenance: 'identifier:ghostSymbol' }],
    context,
  );
  assert.equal(ghost.status, 'fail');
  assert.match(ghost.failures[0].reason, /was not found by the deterministic scan/);
});

test('F1 every failing diversity check names its FLOOR beside its count', () => {
  // The owner field test: the message said "2 active cases" and never said what was
  // required, so it stated a conclusion the reader had no way to check. A count without
  // its bar is not evidence. Pinned on the DETAIL STRING because that is the thing the
  // owner reads; the structured `failures` array was already correct and was not what
  // failed them.
  const { evidence, units, history } = fixture();
  const { cases } = mineGoldset({ evidence, units, history, chunkCount: 500 });
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const context = {
    unitsById,
    availableTypes: new Set(units.map((unit) => unit.type)).size,
    availableAreas: new Set(units.map((unit) => unit.meta.area)).size,
  };

  const short = diversityGate(cases.slice(0, 2), context);
  assert.equal(short.status, 'fail');
  // Every failing check appears in the prose with BOTH numbers, derived from the gate's
  // own structured failures rather than from a hardcoded list, so a new check cannot be
  // added to the gate and silently skip its floor in the message.
  assert.ok(short.failures.length > 0);
  for (const { check, got, floor } of short.failures) {
    assert.match(short.detail, new RegExp(`${check}[^;]*\\b${got}\\b[^;]*minimum ${floor}`),
      `the ${check} failure must name its floor in the detail; got: ${short.detail}`);
  }

  // A count that CLEARED its floor stays bare: a bar beside a number that passed is noise.
  const healthy = diversityGate(cases, context);
  assert.equal(healthy.status, 'pass');
  assert.doesNotMatch(healthy.detail, /minimum/);
});

test('DIVERSITY holds the floor, and 24 cases or 4 identifiers kill it', () => {
  const { evidence, units, history } = fixture();
  const { cases } = mineGoldset({ evidence, units, history, chunkCount: 500 });
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const context = {
    unitsById,
    availableTypes: new Set(units.map((unit) => unit.type)).size,
    availableAreas: new Set(units.map((unit) => unit.meta.area)).size,
  };
  const healthy = diversityGate(cases, context);
  assert.equal(healthy.status, 'pass', healthy.detail);
  assert.ok(healthy.counts.cases >= 25 && healthy.counts.identifiers >= 5);

  // MUTATION 1: one case below the floor.
  //
  // RENUMBERED FOR D-0046, and the old numbers are worth recording rather than replacing
  // silently: this used to assert that 24 cases FAIL, which was correct while the floor
  // WAS the 25-case target. The ruling separated them, so 24 now passes and the mutation
  // that has to kill is one case below the MEASURABILITY floor. The property under test is
  // unchanged - the count check has teeth - only the threshold moved.
  const short = diversityGate(cases.slice(0, 11), context);
  assert.equal(short.status, 'fail');
  assert.ok(short.failures.some((entry) => entry.check === 'count' && entry.got === 11 && entry.floor === 12));

  // And 24, which the old floor refused, now measures: that is the owner-facing change.
  assert.equal(diversityGate(cases.slice(0, 24), context).status, 'pass');

  // MUTATION 2: one identifier case below the subset floor. The floor SCALES now, so the
  // target is computed from the set rather than assumed to be 5. The miner may seat more
  // than the quota once the widening pass runs, so the mutation removes down to one below
  // the scaled floor rather than removing a fixed one and assuming the total.
  // The flag is FLIPPED rather than the case removed, so the set size - and therefore the
  // scaled floor - stays put. Removing cases shrinks the set, which lowers the floor, which
  // is why the removal version of this mutation started passing once the floor scaled.
  const wanted = identifierFloorFor(cases.length) - 1;
  let kept = 0;
  const fewIdentifiers = cases.map((entry) => (
    entry.identifier && kept++ >= wanted ? { ...entry, identifier: false } : entry
  ));
  const identifierFail = diversityGate(fewIdentifiers, context);
  assert.equal(identifierFail.status, 'fail');
  assert.ok(identifierFail.failures.some((entry) => entry.check === 'identifier-cases'
    && entry.floor === identifierFloorFor(fewIdentifiers.length)));
});

test('the relaxed type and area floors are visible in the detail line, never silent', () => {
  const cases = Array.from({ length: 25 }, (unused, index) => ({
    id: `g${index}`, query: `q${index}`, must_return: ['only.unit'], identifier: index < 5, provenance: 'structural:x',
  }));
  const unitsById = new Map([['only.unit', { id: 'only.unit', type: 'architecture', meta: { area: 'src' } }]]);
  const gate = diversityGate(cases, { unitsById, availableTypes: 1, availableAreas: 1 });
  assert.equal(gate.status, 'pass');
  assert.match(gate.detail, /type floor relaxed to 1/);
  assert.match(gate.detail, /area floor relaxed to 1/);
});

test('runGoldsetGates passes a healthy set and reports all five gates', async () => {
  const { evidence, units, history } = fixture();
  const { cases } = mineGoldset({ evidence, units, history, chunkCount: 500 });
  const result = await runGoldsetGates(cases, {
    store: indexOf(units), units, files: FILES, commits: shas(history),
    symbols: evidence.symbols, date: '2026-08-16',
  });
  assert.equal(result.passed, true, JSON.stringify(result.gates.filter((gate) => gate.status !== 'pass'), null, 2));
  assert.deepEqual(result.gates.map((gate) => gate.id), ['existence', 'leakage', 'staleness', 'provenance', 'diversity']);
  assert.equal(result.retired.length, 0);
  assert.equal(result.active.length, cases.length);
});

test('mined cases carry the fields the score harness and the contract both require', () => {
  const { evidence, units, history } = fixture();
  const { cases } = mineGoldset({ evidence, units, history, chunkCount: 500 });
  for (const entry of cases) {
    assert.ok(entry.id && entry.query && entry.provenance);
    assert.ok(entry.key && entry.key.startsWith(entry.provenance), 'every case carries its stable key from mining time');
    assert.ok(Array.isArray(entry.must_return) && entry.must_return.length > 0, 'answers are artifacts, never prose');
    assert.ok(entry.why && entry.why.length > 0, 'the harness refuses a case with no reason (retrieval-score.js validateGoldset)');
  }
  const withConstraint = cases.find((entry) => entry.must_not_outrank);
  assert.ok(withConstraint, 'must_not_outrank must be present where confusion exists');
  assert.ok(withConstraint.must_not_outrank.every((id) => !withConstraint.must_return.includes(id)));
});

test('the widening ramp reaches every candidate, even past an answer the quota over-seated', () => {
  // The live P3 shape, minimised: the identifier quota seats four cases on one card, and
  // that card also holds ten more candidates. A ramp that stops at the first pass adding
  // nothing never reaches them, and the gauge silently comes out ten cases short.
  const identifiers = Array.from({ length: 4 }, (unused, index) => ({
    query: `symbol${index}`, must_return: ['card.hot'], must_not_outrank: [], identifier: true,
    provenance: `identifier:symbol${index}`, source: 'identifier', why: 'w', target: {},
  }));
  const hot = Array.from({ length: 10 }, (unused, index) => ({
    query: `hot question ${index}`, must_return: ['card.hot'], must_not_outrank: [], identifier: false,
    provenance: `structural:hot-${index}`, source: 'structural', why: 'w', target: {},
  }));
  const others = Array.from({ length: 5 }, (unused, index) => ({
    query: `other question ${index}`, must_return: [`card.other${index}`], must_not_outrank: [], identifier: false,
    provenance: `structural:other-${index}`, source: 'structural', why: 'w', target: {},
  }));
  const pool = [...identifiers, ...hot, ...others];
  const chosen = selectCases(pool, { target: 25, identifierQuota: 4 });
  assert.equal(chosen.length, pool.length, 'every available candidate is reachable when the target exceeds the pool');

  // The spread rule still holds when the target is the binding constraint.
  const capped = selectCases(pool, { target: 9, identifierQuota: 4 });
  assert.equal(capped.length, 9);
  const perAnswer = new Map();
  for (const entry of capped) perAnswer.set(entry.must_return[0], (perAnswer.get(entry.must_return[0]) || 0) + 1);
  assert.equal(perAnswer.size, 6, 'all six answers are represented before any answer takes a second slot');
});

test('a vacuous ranking constraint is PRUNED, not grounds for retiring a good case', async () => {
  // The deadlock this resolves: existence checks must_return AND must_not_outrank, while
  // staleness judged only the answer. A case whose distractor was deleted was therefore
  // never stale and never existent, and the two gates blocked each other forever.
  const unitsById = new Map([['live.answer', { id: 'live.answer', type: 'architecture', meta: { area: 'a' } }]]);
  const cases = [
    { id: 'g001', query: 'a question', must_return: ['live.answer'], must_not_outrank: ['deleted.card', 'live.answer2'], provenance: 'structural:x' },
    { id: 'g002', query: 'another', must_return: ['live.answer'], provenance: 'structural:y' },
  ];
  const { cases: pruned, pruned: record } = pruneVanishedConstraints(cases, { unitsById });
  assert.equal(pruned[0].must_not_outrank, undefined, 'every constraint was dead, so the field goes');
  assert.deepEqual(record, [{ case: 'g001', dropped: ['deleted.card', 'live.answer2'] }]);
  assert.equal(pruned[1].must_not_outrank, undefined);
  assert.deepEqual(findStaleCases(pruned, { unitsById }), [], 'the case itself is still perfectly askable');

  // MUTATION: skip the pruning and the existence gate rejects a case staleness will never
  // retire, which is the deadlock.
  const store = { async existingDocumentIds(ids) { return ids.filter((id) => unitsById.has(id)); } };
  const unpruned = await existenceGate(cases, { store });
  assert.equal(unpruned.status, 'fail');
  assert.equal((await existenceGate(pruned, { store })).status, 'pass');
});

test('runGoldsetGates reports what it pruned rather than doing it silently', async () => {
  const units = [{ id: 'u1', type: 'architecture', meta: { area: 'a' }, content: 'text' }];
  const store = { async existingDocumentIds(ids) { return ids.filter((id) => id === 'u1'); } };
  const cases = [{ id: 'g001', query: 'q', must_return: ['u1'], must_not_outrank: ['gone'], provenance: 'structural:x', target: { kind: 'unit', id: 'u1' } }];
  const result = await runGoldsetGates(cases, { store, units, files: [], commits: new Set(), date: '2026-08-16', floors: { minimumCases: 1, minimumIdentifierCases: 0, minimumTypes: 1, minimumAreas: 1 } });
  assert.deepEqual(result.constraintsPruned, [{ case: 'g001', dropped: ['gone'] }]);
  assert.equal(result.passed, true);
});

// ---- the target and the floor are different numbers (D-0046) -----------------------------

test('a legitimate modest repo MEASURES instead of being refused on headcount', () => {
  // The owner's re-test: 18 well-diversified cases, refused by a bare count gate at 25.
  // 25 was the platform's TARGET, measured on a large corpus, being used as a floor for
  // every repo. Nothing about measurability fired - identifier, types and areas all passed.
  // BUILT, not sliced. Slicing a mined set changes every proportion at once - count,
  // identifier share, type and area coverage - so a failure names whichever dimension the
  // slice happened to starve rather than the one under test. This varies ONE thing: size.
  const build = (count) => {
    const units = [];
    const cases = [];
    for (let index = 0; index < count; index += 1) {
      const id = `u${index}`;
      units.push({ id, type: ['concept', 'api', 'decision'][index % 3], meta: { area: `area${index % 4}` } });
      cases.push({ id: `c${index}`, must_return: [id], identifier: index % 4 === 0, retired: false });
    }
    return {
      cases,
      context: { unitsById: new Map(units.map((unit) => [unit.id, unit])), availableTypes: 3, availableAreas: 4 },
    };
  };

  const modest = build(18);
  const measured = diversityGate(modest.cases, modest.context);
  assert.equal(measured.status, 'pass', `18 diversified cases must measure, not refuse: ${measured.detail}`);

  // And the floor still refuses what cannot be measured.
  // And the floor still refuses what cannot be measured, same construction, fewer cases.
  const thin = build(11);
  const tooThin = diversityGate(thin.cases, thin.context);
  assert.equal(tooThin.status, 'fail');
  assert.ok(tooThin.failures.some((entry) => entry.check === 'count' && entry.floor === 12));

  // 24 measures now, which is the owner-facing change: it was refused by the old floor.
  const nearTarget = build(24);
  assert.equal(diversityGate(nearTarget.cases, nearTarget.context).status, 'pass');
});

test('the identifier floor SCALES, so lowering the count does not just move the block', () => {
  // A fixed floor of 5 is 20 percent of the 25-case target and 42 percent of a 12-case set.
  // Without scaling, a 12-case set with 3 identifier cases fails identifier-cases instead
  // of count, and the refusal moves rather than lifting.
  assert.equal(identifierFloorFor(25), 5, 'unchanged at the target, which is the proportion the fixed 5 encoded');
  assert.equal(identifierFloorFor(34), 5, 'and does not grow past it');
  assert.equal(identifierFloorFor(18), 4);
  assert.equal(identifierFloorFor(12), 3);
  // Never below 3: the check must not evaporate on a small set.
  assert.equal(identifierFloorFor(5), 3);
  assert.equal(identifierFloorFor(1), 3);
});

test('the target and the floor are separate values, not one number doing two jobs', () => {
  // The defect in one line: DEFAULT_FLOORS.minimumCases WAS the target. A mining goal and a
  // measurability threshold answer different questions and only coincide by accident.
  assert.equal(DEFAULT_FLOORS.targetCases, 25);
  assert.equal(DEFAULT_FLOORS.minimumCases, 12);
  assert.ok(DEFAULT_FLOORS.minimumCases < DEFAULT_FLOORS.targetCases,
    'a floor at the target refuses every repo that does not reach it');
});
