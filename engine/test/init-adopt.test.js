// The deterministic adopt path (P3.5) and the gold-set sources that reach a curated brain.
//
// The properties under test are the ones the P3.5 measurement depends on: a curated folder
// is split on its own record boundaries rather than indexed whole, nothing before the first
// record is dropped, adopted units are distinguishable from generated ones, and the mined
// cases are sound on a brain that cross-references itself constantly.
import assert from 'node:assert/strict';
import test from 'node:test';

import { adoptDocument, splitRecords, typeForDocument } from '../src/init/adopt.js';
import { adoptedCases, mineAdoptedGoldset } from '../src/init/goldset.js';
import { leakageGate, provenanceGate } from '../src/init/goldset-gates.js';

const DECISIONS = [
  '# Decisions',
  '',
  '| ADR | Title |',
  '| --- | --- |',
  '| ADR-001 | Use the sqlite store |',
  '| ADR-002 | Rank by descending score |',
  '| ADR-003 | Normalize whitespace |',
  '',
  '## ADR-001 Use the sqlite store',
  'One file per repo is simpler to ship than a server. See src/store/sqlite.js.',
  '',
  '## ADR-002 Rank by descending score',
  'Ranking sorts on score so the strongest candidate is funded first. Supersedes ADR-001 partly.',
  '',
  '## ADR-003 Normalize whitespace',
  'Chunk text is normalized before embedding.',
  '',
].join('\n');

const ERRORS = [
  '# Errors',
  '',
  '- The memory store dropped rows when a cursor was reused across calls.',
  '- Token counting split on whitespace and undercounted CJK text.',
  '- The health route started the server twice under concurrency.',
  '',
].join('\n');

test('a record file splits on its own boundaries rather than indexing whole', () => {
  const headings = splitRecords(DECISIONS);
  assert.equal(headings.rule, 'headings');
  // Three ADRs plus the preamble: the index is a record too.
  assert.equal(headings.records.length, 4);
  assert.equal(headings.records[0].preamble, true);
  assert.match(headings.records[0].title, /overview/i);
  assert.deepEqual(headings.records.slice(1).map((record) => record.title), [
    'ADR-001 Use the sqlite store', 'ADR-002 Rank by descending score', 'ADR-003 Normalize whitespace',
  ]);

  const bullets = splitRecords(ERRORS);
  assert.equal(bullets.rule, 'bullets');
  assert.equal(bullets.records.length, 4, 'three lessons plus the heading preamble');

  assert.equal(splitRecords('# Conventions\n\nTwo spaces, single quotes.\n').rule, 'whole');
});

test('MUTATION: dropping the preamble loses content no other record carries', () => {
  const { records } = splitRecords(DECISIONS);
  const preamble = records.find((record) => record.preamble);
  assert.ok(preamble.body.includes('| ADR-001 | Use the sqlite store |'), 'the index table survives');
  const withoutPreamble = records.filter((record) => !record.preamble);
  assert.ok(
    !withoutPreamble.some((record) => record.body.includes('| ADR | Title |')),
    'and no other record holds it, which is why dropping it was silent data loss',
  );
});

test('types follow the folder convention, and an unknown file adopts rather than vanishing', () => {
  assert.equal(typeForDocument('agent/decisions.md'), 'decision');
  assert.equal(typeForDocument('agent/errors.md'), 'lesson');
  assert.equal(typeForDocument('agent/conventions.md'), 'convention');
  assert.equal(typeForDocument('agent/state.md'), 'workflow');
  assert.equal(
    typeForDocument('agent/something-nobody-anticipated.md'),
    'architecture',
    'dropping a human document because it was named unexpectedly is the worst available outcome',
  );
});

test('adopted units are marked as human-written, and cite the file they came from', () => {
  const { units } = adoptDocument({ file: 'agent/decisions.md', content: DECISIONS });
  assert.ok(units.every((unit) => unit.meta.generated === false), 'a human wrote these');
  assert.ok(units.every((unit) => unit.meta.adopted === true && unit.meta.layer === 0));
  assert.ok(units.every((unit) => unit.meta.sourceFile === 'agent/decisions.md'));
  assert.ok(units.every((unit) => unit.citations.includes('agent/decisions.md')));
  assert.ok(units.every((unit) => unit.id.startsWith('adopted.decision.decisions.')));
  assert.equal(new Set(units.map((unit) => unit.id)).size, units.length, 'ids are unique');
});

// --- the gold-set sources for a curated brain -------------------------------------

function adoptedUnits() {
  return [
    ...adoptDocument({ file: 'agent/decisions.md', content: DECISIONS }).units,
    ...adoptDocument({ file: 'agent/errors.md', content: ERRORS }).units,
  ];
}

test('a record label resolves to the record whose TITLE carries it, not to every mention', () => {
  const units = adoptedUnits();
  // ADR-001 appears in three units: the index, its own record, and ADR-002 citing it.
  const mentioning = units.filter((unit) => unit.content.includes('ADR-001'));
  assert.equal(mentioning.length, 3, 'a curated brain cross-references itself constantly');

  const cases = adoptedCases({ units });
  const label = cases.find((entry) => entry.query === 'ADR-001');
  assert.ok(label, 'the label is still askable despite three mentions');
  assert.deepEqual(label.must_return, ['adopted.decision.decisions.adr-001-use-the-sqlite-store']);
  assert.ok(
    label.must_not_outrank.length > 0,
    'the units that merely reference it are distractors, which is what must_not_outrank is for',
  );
  assert.ok(!label.must_not_outrank.includes(label.must_return[0]));
});

test('path self-reference reaches the documents labels never touch', () => {
  const units = adoptedUnits();
  const cases = adoptedCases({ units, repoFiles: ['src/store/sqlite.js', 'src/rag/rank.js'] });
  const path = cases.find((entry) => entry.query.includes('src/store/sqlite.js'));
  assert.ok(path, 'a file named by exactly one record is answerable');
  assert.equal(path.source, 'structural');
  assert.ok(!cases.some((entry) => entry.query.includes('src/rag/rank.js')), 'a file no record names has no answer');
});

test('every mined case survives the leakage gate that rejected the invented ones', () => {
  const units = adoptedUnits();
  const cases = adoptedCases({ units, repoFiles: ['src/store/sqlite.js'] })
    .map((entry, index) => ({ ...entry, id: `g${index}` }));
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const gate = leakageGate(cases, { unitsById });
  assert.equal(gate.status, 'pass', JSON.stringify(gate.failures));
  assert.ok(cases.length > 0, 'and the pass is not vacuous');
});

test('a bullet record never becomes a query, because nobody wrote its title', () => {
  // The splitter labels a bullet with its first sentence for display. Using that as a query
  // asks a question in words the miner invented, and on the P3.5 target it produced
  // unaskable leaky fragments. Heading records have human-authored titles; bullets do not.
  const units = adoptDocument({ file: 'agent/errors.md', content: ERRORS }).units;
  const cases = adoptedCases({ units });
  const bulletTitles = new Set(units.map((unit) => unit.title));
  assert.ok(!cases.some((entry) => bulletTitles.has(entry.query)), 'no bullet label is used as a question');
});

test('a record-label origin resolves against title ownership, not the code symbol index', () => {
  const units = adoptedUnits();
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const cases = adoptedCases({ units }).map((entry, index) => ({ ...entry, id: `g${index}` }));
  const clean = provenanceGate(cases, { unitsById, symbols: { byName: new Map() }, cardByArea: new Map() });
  assert.equal(clean.status, 'pass', 'a label is not a code symbol and must not be resolved as one');

  const invented = provenanceGate(
    [{ id: 'g1', query: 'ADR-999', must_return: ['x'], provenance: 'record-label:ADR-999', target: { kind: 'unit', id: 'x' } }],
    { unitsById, symbols: null, cardByArea: new Map() },
  );
  assert.equal(invented.status, 'fail');
  assert.match(invented.failures[0].reason, /no unit carries ADR-999 in its title/);
});

test('mineAdoptedGoldset reports its pool and its shortfall rather than padding', () => {
  const units = adoptedUnits();
  const mined = mineAdoptedGoldset({ units, repoFiles: ['src/store/sqlite.js'], chunkCount: 40 });
  assert.ok(mined.cases.length > 0);
  assert.ok(mined.cases.every((entry) => entry.key && entry.why && entry.provenance));
  assert.equal(mined.target.target, 25, 'the floor binds on a small corpus');
  assert.ok(mined.notes.some((note) => note.includes('reported rather than padded')));
});

test('a label two records both claim in their titles is DROPPED, not guessed at', () => {
  // The title-ownership rule is only sound while exactly one record claims the label. A
  // folder that numbers two records the same has an authoring problem, and answering it
  // anyway would report that authoring problem as a retrieval failure.
  const ambiguous = [
    '# Decisions',
    '',
    'Index line one, index line two, index line three.',
    '',
    '## ADR-007 First claimant',
    'One record says it owns this number.',
    '',
    '## ADR-007 Second claimant',
    'Another record says the same thing, which is the authoring problem.',
    '',
    '## ADR-008 The unambiguous one',
    'Exactly one record carries this label in its title.',
    '',
  ].join('\n');
  const units = adoptDocument({ file: 'agent/decisions.md', content: ambiguous }).units;
  const titles = units.filter((unit) => String(unit.title).includes('ADR-007'));
  assert.equal(titles.length, 2, 'the fixture really does have two claimants');

  const cases = adoptedCases({ units });
  assert.ok(!cases.some((entry) => entry.query === 'ADR-007'), 'a contested label has no single correct answer');
  assert.ok(cases.some((entry) => entry.query === 'ADR-008'), 'and the uncontested one is unaffected');
});
