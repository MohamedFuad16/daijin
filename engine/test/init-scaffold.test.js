// Layer 1 generation and the Layer 2 spend boundary.
//
// The properties under test are the four the scaffold claims: cited, reproducible, marked
// generated, and silent about what it cannot know. Each has a mutation that kills it,
// named in the test title.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkDocument } from '../src/rag/chunk.js';
import { buildEvidence } from '../src/init/evidence.js';
import { acceptNarration, narrate, narrationInputs, SPEND_REFUSED_CODE, SpendRefusedError } from '../src/init/narrate.js';
import { scaffoldLayer1, validateCitations } from '../src/init/scaffold.js';

const SOURCES = new Map([
  ['src/util/tokens.js', "export function countTokens(text) {\n  return text.split(' ').length;\n}\n"],
  ['src/store/sqlite.js', "import { countTokens } from '../util/tokens.js';\nimport lodash from 'lodash';\n\nexport class SqliteStore {}\n\nexport function createSqliteStore() {\n  return new SqliteStore();\n}\n"],
  ['src/rag/rank.js', "import { countTokens } from '../util/tokens.js';\n\nexport function rankRetrieval(rows) {\n  return rows;\n}\n"],
  ['test/rank.test.js', "import { rankRetrieval } from '../src/rag/rank.js';\n\nexport function exercise() {\n  return rankRetrieval([]);\n}\n"],
]);

const FILES = [...SOURCES.keys(), 'package.json', 'README.md'];

const HISTORY = {
  available: true,
  reason: null,
  cap: 2000,
  capped: false,
  total: 2,
  commits: [
    {
      sha: 'a'.repeat(40), shortSha: 'a'.repeat(12), author: 'Ada', authorEmail: 'ada@example.test',
      date: '2026-01-01T00:00:00Z', subject: 'fix: guard the empty candidate list', body: '',
      files: [{ path: 'src/rag/rank.js', added: 3, deleted: 1, binary: false, renamed: false }],
    },
    {
      sha: 'b'.repeat(40), shortSha: 'b'.repeat(12), author: 'Grace', authorEmail: 'grace@example.test',
      date: '2026-01-02T00:00:00Z', subject: 'add the sqlite store', body: '',
      files: [{ path: 'src/store/sqlite.js', added: 9, deleted: 0, binary: false, renamed: false }],
    },
  ],
};

function evidenceFor({ history = HISTORY } = {}) {
  return buildEvidence({
    analysis: {
      repoPath: '/fixture', name: 'fixture', files: { count: FILES.length, source: 'git-ls-files' },
      languages: [], structure: { areas: [] },
    },
    sources: SOURCES,
    files: FILES,
    manifests: { 'package.json': { dependencies: { lodash: '^4.0.0' } } },
    history,
  });
}

test('Layer 1 emits area cards, conventions, dependencies and a history card', () => {
  const { units } = scaffoldLayer1(evidenceFor());
  const ids = units.map((unit) => unit.id);
  assert.ok(ids.includes('daijin.architecture.src-store'));
  assert.ok(ids.includes('daijin.architecture.src-rag'));
  assert.ok(ids.includes('daijin.architecture.dependencies'));
  assert.ok(ids.includes('daijin.convention.indentation'));
  assert.ok(ids.includes('daijin.workflow.history'));
  assert.ok(units.every((unit) => unit.meta.generated === true && unit.meta.layer === 1));
  assert.ok(units.every((unit) => unit.content.includes('## Provenance')), 'a reader who sees only the text must know a machine wrote it');
});

test('every generated unit cites files that exist, and one that does not is DROPPED', () => {
  const { units } = scaffoldLayer1(evidenceFor());
  const clean = validateCitations(units, { files: FILES, commits: new Set() });
  assert.equal(clean.dropped.length, 0);
  assert.equal(clean.accepted.length, units.length);

  // Mutation: remove one cited file from the tree. The unit that cited it must not survive.
  const scrambled = validateCitations(units, { files: FILES.filter((file) => file !== 'src/store/sqlite.js'), commits: new Set() });
  assert.ok(scrambled.dropped.length > 0, 'a citation nobody checks is indistinguishable from one nobody can check');
  assert.ok(scrambled.dropped.some((entry) => entry.missing.includes('src/store/sqlite.js')));
  assert.ok(scrambled.accepted.length < units.length);
});

test('generation is reproducible: two runs produce identical bytes and identical digests', () => {
  const first = scaffoldLayer1(evidenceFor());
  const second = scaffoldLayer1(evidenceFor());
  assert.deepEqual(
    first.units.map((unit) => [unit.id, unit.contentHash, unit.meta.evidenceDigest]),
    second.units.map((unit) => [unit.id, unit.contentHash, unit.meta.evidenceDigest]),
  );
  assert.deepEqual(first.units.map((unit) => unit.content), second.units.map((unit) => unit.content));
});

test('errors.md starts empty, and a history full of fix commits does not change that', () => {
  const { units, errors } = scaffoldLayer1(evidenceFor());
  assert.deepEqual(errors.units, [], 'Layer 1 writes no error records, ever');
  assert.equal(errors.candidates.fixCommits.length, 1, 'the fix commit is kept as EVIDENCE');
  assert.equal(units.filter((unit) => unit.type === 'lesson').length, 0);
  assert.equal(units.filter((unit) => unit.type === 'decision').length, 0);
  assert.match(errors.reason, /narration validates it against the real commit/);
});

test('with no history at all the reason says so and no history card is generated', () => {
  const { units, errors, notes } = scaffoldLayer1(evidenceFor({
    history: { available: false, reason: 'no git history', cap: 2000, commits: [] },
  }));
  assert.equal(units.filter((unit) => unit.id === 'daijin.workflow.history').length, 0);
  assert.match(errors.reason, /errors\.md starts empty/);
  assert.ok(notes.some((note) => note.startsWith('No history card')));
});

test("an architecture card's core lives in ONE chunk, so a window cannot split claim from evidence", () => {
  const { units } = scaffoldLayer1(evidenceFor());
  const card = units.find((unit) => unit.id === 'daijin.architecture.src-store');
  const chunks = chunkDocument({ type: card.type, path: card.path, title: card.title, tags: card.tags, content: card.content, body: card.body });
  const holding = chunks.filter((chunk) => chunk.content.includes(card.core));
  assert.equal(holding.length, 1, 'exactly one chunk must carry the whole core');
  assert.equal(holding[0].ordinal, 0);
  assert.ok(card.core.includes('Claim:'));
  assert.ok(card.core.includes('src/store/sqlite.js'), 'the citations are part of the core, not a separate section');
});

test('a convention with no denominator produces a note instead of a card', () => {
  const evidence = evidenceFor();
  evidence.conventions.quotes = { dominant: null, counts: { single: 0, double: 0 }, measured: { count: 0, total: 0, exact: 0, display: '0 of 0' }, exceptions: [] };
  const { units, notes } = scaffoldLayer1(evidence);
  assert.equal(units.filter((unit) => unit.id === 'daijin.convention.quotes').length, 0);
  assert.ok(notes.some((note) => note.includes('quotes convention card')), 'a claim no measurement supports must not enter the brain');
});

test('the area card cap is displayed rather than applied silently', () => {
  const evidence = evidenceFor();
  const { notes } = scaffoldLayer1(evidence, { areaCardLimit: 1 });
  assert.ok(notes.some((note) => note.includes('the cap is displayed rather than applied silently')));
});

// --- the Layer 2 spend boundary --------------------------------------------------

test('narration refuses when the spend gate is closed, and for THAT reason', async () => {
  // Everything else is supplied, so the closed gate is the only thing left to refuse on.
  // Written this way after the mutation sweep: with a budget and a narrator missing too,
  // deleting the gate check left the test green because the NEXT refusal also threw a
  // SpendRefusedError with the same code. Asserting the class alone was dead coverage.
  let narratorCalls = 0;
  await assert.rejects(
    () => narrate({
      evidence: evidenceFor(),
      spendGate: { open: false, path: '/gate' },
      confirmedBudget: 1000,
      narrator: async () => { narratorCalls += 1; return []; },
    }),
    (error) => {
      assert.ok(error instanceof SpendRefusedError);
      assert.equal(error.code, SPEND_REFUSED_CODE);
      assert.equal(error.data.gate, '/gate');
      assert.match(error.message, /spend gate is closed/);
      assert.match(error.message, /opened by the owner, never by the engine/);
      return true;
    },
  );
  assert.equal(narratorCalls, 0, 'the refusal happens before anything could spend');
});

test('an open gate is not enough: the per-call budget must be confirmed', async () => {
  await assert.rejects(
    () => narrate({ evidence: evidenceFor(), spendGate: { open: true, path: '/gate' }, narrator: async () => [] }),
    /per-call budget confirmed by an explicit user action/,
  );
});

test('with the gate open and a budget confirmed, the refusal names the missing narrator', async () => {
  await assert.rejects(
    () => narrate({ evidence: evidenceFor(), spendGate: { open: true, path: '/gate' }, confirmedBudget: 1000 }),
    /No narrator is wired in this build/,
  );
});

test('the narrator proposes and the mechanics accept: uncited and miscited units are dropped', async () => {
  const proposed = [
    { id: 'why-sqlite', type: 'decision', title: 'Why SQLite', content: 'The store is SQLite.', citations: ['src/store/sqlite.js'] },
    { id: 'invented', type: 'decision', title: 'Invented', content: 'A claim about a file that is not there.', citations: ['src/store/nowhere.js'] },
    { id: 'uncited', type: 'lesson', title: 'Uncited', content: 'Prose with no evidence.', citations: [] },
    { id: 'wrong-type', type: 'architecture', title: 'Not narratable', content: 'Layer 1 owns this type.', citations: ['src/store/sqlite.js'] },
  ];
  const result = await narrate({
    evidence: evidenceFor(),
    spendGate: { open: true, path: '/gate' },
    confirmedBudget: 1000,
    narrator: async () => proposed,
    files: FILES,
    commits: new Set(),
  });
  assert.deepEqual(result.accepted.map((unit) => unit.id), ['daijin.decision.why-sqlite']);
  // The citation failure is reported under the namespaced id, because namespacing happens
  // before validation; the shape failures never got that far and keep the proposed id.
  assert.deepEqual(result.dropped.map((entry) => entry.id).sort(), ['daijin.decision.invented', 'uncited', 'wrong-type']);
  assert.equal(result.accepted[0].meta.layer, 2);
});

test('acceptNarration validates a cited commit against the walked history', () => {
  const sha = 'a'.repeat(12);
  const accepted = acceptNarration(
    [{ id: 'lesson-1', type: 'lesson', title: 'A lesson', content: 'text', citations: [sha] }],
    { files: [], commits: new Set([sha]) },
  );
  assert.equal(accepted.accepted.length, 1);
  const rejected = acceptNarration(
    [{ id: 'lesson-1', type: 'lesson', title: 'A lesson', content: 'text', citations: ['deadbeefdead'] }],
    { files: [], commits: new Set([sha]) },
  );
  assert.equal(rejected.accepted.length, 0);
  assert.match(rejected.dropped[0].reason, /citations not found/);
});

test('the narrator only ever sees measured tables, never the repo', () => {
  const inputs = narrationInputs(evidenceFor());
  assert.deepEqual(Object.keys(inputs).sort(), ['areas', 'conventions', 'coChange', 'dependencies', 'repairCandidates', 'repo'].sort());
  assert.ok(inputs.repairCandidates.fixCommits.every((entry) => typeof entry.sha === 'string'), 'every candidate carries the sha it must be validated against');
  assert.equal(JSON.stringify(inputs).includes('export function countTokens'), false, 'source text is not part of the narration input');
});
