import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SEMANTIC_THRESHOLD, DEFAULT_STRUCTURAL_PIN_FLOOR, rankRetrieval, semanticByDocument, supersessionComponent,
} from '../src/rag/rank.js';

const document = (overrides) => ({
  id: 'd', type: 'decision', path: 'p', title: 'T', tags: [], meta: {}, content: 'content', ...overrides,
});

test('the measured constants are the shipped ones', () => {
  assert.equal(DEFAULT_SEMANTIC_THRESHOLD, 0.35);
  assert.equal(DEFAULT_STRUCTURAL_PIN_FLOOR, 0.35);
});

test('semanticByDocument keeps the best chunk and tracks raw cosine separately', () => {
  const byDocument = semanticByDocument([
    { id: 'a', chunk_id: 1, ordinal: 0, chunk_content: 'weak', score: 0.4, semanticSimilarity: 0.9 },
    { id: 'a', chunk_id: 2, ordinal: 1, chunk_content: 'strong', score: 0.8, semanticSimilarity: 0.2 },
  ]);
  const entry = byDocument.get('a');
  assert.equal(entry.semanticScore, 0.8, 'rescaled score picks the winning chunk');
  assert.equal(entry.chunkContent, 'strong');
  assert.equal(entry.rawSemanticScore, 0.9, 'raw cosine is the max across chunks, not the winner chunk value');
});

test('max-support adds a bounded bonus that a many-chunk document cannot run away with', () => {
  const rows = Array.from({ length: 50 }, (unused, index) => ({ id: 'a', chunk_id: index, ordinal: index, chunk_content: 'c', score: 0.5 }));
  const plain = semanticByDocument(rows).get('a').semanticScore;
  const supported = semanticByDocument(rows, { mode: 'max-support' }).get('a').semanticScore;
  assert.equal(plain, 0.5);
  assert.equal(Number(supported.toFixed(4)), 0.56, 'capped at maxBonus 0.06 despite 49 supporters');
});

test('supersessionComponent resolves a chain to its current head', () => {
  const relationships = [
    { src: 'doc:b', dst: 'doc:a', kind: 'supersedes' },
    { src: 'doc:c', dst: 'doc:b', kind: 'supersedes' },
  ];
  const component = supersessionComponent('a', relationships);
  assert.deepEqual(component.currentIds, ['c']);
  assert.deepEqual(component.supersededIds.sort(), ['a', 'b']);
});

test('a structural hit below the pin floor is not pin eligible', () => {
  const documents = [document({ id: 'd1', tags: ['storage'] })];
  const belowFloor = rankRetrieval({
    query: 'storage',
    documents,
    semanticRows: [{ id: 'd1', chunk_id: 1, ordinal: 0, chunk_content: 'c', score: 0.2 }],
    relationships: [],
  });
  // The tag matched, but 0.2 is under the 0.35 pin floor, so the candidate carries only its
  // semantic score rather than the 2-plus pinned score.
  assert.deepEqual(belowFloor.meta.retrievedIds, ['d1']);
  assert.equal(belowFloor.decisions[0].pinEligible, false);
  assert.ok(belowFloor.decisions[0].score < 1);

  const aboveFloor = rankRetrieval({
    query: 'storage',
    documents,
    semanticRows: [{ id: 'd1', chunk_id: 1, ordinal: 0, chunk_content: 'c', score: 0.5 }],
    relationships: [],
  });
  assert.equal(aboveFloor.decisions[0].pinEligible, true);
  assert.ok(aboveFloor.decisions[0].score > 2);
});

test('a superseded decision is replaced by its current successor', () => {
  const documents = [
    document({ id: 'old', tags: ['storage'], title: 'Old storage' }),
    document({ id: 'new', tags: ['storage'], title: 'New storage' }),
  ];
  const result = rankRetrieval({
    query: 'storage',
    documents,
    semanticRows: [
      { id: 'old', chunk_id: 1, ordinal: 0, chunk_content: 'c', score: 0.6 },
      { id: 'new', chunk_id: 2, ordinal: 0, chunk_content: 'c', score: 0.5 },
    ],
    relationships: [{ src: 'doc:new', dst: 'doc:old', kind: 'supersedes' }],
  });
  assert.deepEqual(result.meta.retrievedIds, ['new']);
  assert.equal(result.decisions[0].current, true);
  assert.deepEqual(result.decisions[0].superseded.map((item) => item.id), ['old']);
});

test('the replacement boost survives the order the documents arrive in', () => {
  // THE BOOST WAS ORDER-DEPENDENT, and the shipped order was the losing one. The
  // supersession pass walked a SNAPSHOT of the candidates while deleting from and merging
  // into the live map, so when the superseded decision resolved onto a current decision
  // that was itself in the snapshot, the current decision's own iteration deleted the
  // freshly merged entry and rebuilt it from the stale pre-merge object. The replacement
  // boost and the merged reasons went with it.
  //
  // allDocuments sorts by id and a superseded ADR almost always carries the LOWER number,
  // so the superseded document is visited first on every real query: the boost was
  // effectively dead for normal ADR numbering.
  //
  // Both orders are asserted, and asserted EQUAL rather than against a literal, because
  // the defect is precisely that the two disagree - a test pinning only one order passes
  // against the bug half the time depending on which one it picked.
  const older = document({ id: 'd-0010', tags: ['caching', 'redis'], title: 'Caching policy redis' });
  const current = document({ id: 'd-0065', tags: ['caching'], title: 'Something else entirely' });
  const semanticRows = [
    { id: 'd-0010', chunk_id: 1, ordinal: 0, chunk_content: 'c', score: 0.9 },
    { id: 'd-0065', chunk_id: 2, ordinal: 0, chunk_content: 'c', score: 0.6 },
  ];
  const relationships = [{ src: 'doc:d-0065', dst: 'doc:d-0010', kind: 'supersedes' }];
  const scoreOf = (documents) => {
    const result = rankRetrieval({ query: 'caching policy redis', documents, semanticRows, relationships });
    return result.decisions.find((row) => row.id === 'd-0065')?.score ?? null;
  };

  const byId = scoreOf([older, current]);      // the order a store actually returns
  const reversed = scoreOf([current, older]);
  assert.equal(byId, reversed, 'the same corpus and query must score the same either way');
  // And the surviving value is the BOOSTED one, not the unboosted one the id order used to
  // produce: equality alone would also be satisfied by losing the boost in both orders.
  assert.ok(byId > 5, `the replacement boost is applied, got ${byId}`);
});

test('the token budget caps each candidate and stops at k', () => {
  const long = 'word '.repeat(5_000);
  const documents = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => document({ id, content: long }));
  const semanticRows = documents.map((item, index) => ({ id: item.id, chunk_id: index, ordinal: 0, chunk_content: 'c', score: 0.9 - index / 100 }));
  const result = rankRetrieval({ query: 'anything', documents, semanticRows, relationships: [], k: 8, tokenBudget: 4000 });
  assert.equal(result.meta.tokenCount <= 4000, true);
  assert.equal(result.meta.truncated, true);
  // 0.22 of 4000 is 880 tokens per candidate, so the fixed budget funds several documents
  // rather than being eaten by the first one.
  assert.ok(result.meta.retrievedIds.length >= 4, `expected breadth, got ${result.meta.retrievedIds.length}`);
  for (const candidate of result.decisions) assert.ok(candidate.tokenCount <= 880);
});

test('the reserved semantic slot funds the corpus champion the budget would have dropped', () => {
  const filler = 'word '.repeat(900);
  const pins = [1, 2, 3, 4, 5, 6].map((index) => document({ id: `pin${index}`, tags: ['storage'], content: filler }));
  const documents = [
    ...pins,
    document({ id: 'champion', type: 'architecture', tags: [], title: 'unrelated title', content: filler, meta: { area: 'other' } }),
  ];
  const semanticRows = [
    ...pins.map((pin, index) => ({ id: pin.id, chunk_id: index + 1, ordinal: 0, chunk_content: 'c', score: 0.5, semanticSimilarity: 0.5 })),
    { id: 'champion', chunk_id: 99, ordinal: 0, chunk_content: filler, score: 0.4, semanticSimilarity: 0.68 },
  ];
  const base = { query: 'storage', documents, semanticRows, relationships: [], k: 8, tokenBudget: 2_000 };

  const governed = rankRetrieval({ ...base, slotAllocation: { mode: 'governed' } });
  assert.equal(governed.meta.retrievedIds.includes('champion'), false, 'pins crowd the champion out');

  const reserved = rankRetrieval({ ...base });
  assert.equal(reserved.meta.retrievedIds.includes('champion'), true, 'the reserved slot funds it');
});

test("championMetric 'raw' ignores a lexically boosted candidate with no cosine evidence", () => {
  const filler = 'word '.repeat(900);
  const pins = [1, 2, 3, 4, 5, 6].map((index) => document({ id: `pin${index}`, tags: ['storage'], content: filler }));
  const documents = [
    ...pins,
    document({ id: 'lexical', type: 'architecture', title: 'z', content: filler, meta: { area: 'other' } }),
  ];
  const semanticRows = [
    ...pins.map((pin, index) => ({ id: pin.id, chunk_id: index + 1, ordinal: 0, chunk_content: 'c', score: 0.5, semanticSimilarity: 0.5 })),
    // Rescaled high by fusion, but its own cosine is near zero: exactly the g014 defect.
    { id: 'lexical', chunk_id: 99, ordinal: 0, chunk_content: filler, score: 0.67, semanticSimilarity: 0.05 },
  ];
  const base = { query: 'storage', documents, semanticRows, relationships: [], k: 8, tokenBudget: 2_000 };
  const raw = rankRetrieval({ ...base, slotAllocation: { mode: 'reserved-semantic', floor: 0.55, slots: 1, championMetric: 'raw' } });
  const fused = rankRetrieval({ ...base, slotAllocation: { mode: 'reserved-semantic', floor: 0.55, slots: 1, championMetric: 'fused' } });
  assert.equal(raw.meta.retrievedIds.includes('lexical'), false);
  assert.equal(fused.meta.retrievedIds.includes('lexical'), true, 'the fused metric is what ADR-0158 replaced');
});

test('a curated fix needs three overlapping terms, or a single-token query', () => {
  const documents = [document({ id: 'target', type: 'lesson', tags: [], title: 'z' })];
  const semanticRows = [{ id: 'target', chunk_id: 1, ordinal: 0, chunk_content: 'c', score: 0.5 }];
  const fixes = [{ targetId: 'target', trigger: 'gmail api key rotation policy', sourceRunIds: [1] }];
  const rank = (query) => rankRetrieval({ query, documents, semanticRows, relationships: [], retrievalFixes: fixes }).lessons[0];

  const twoTermOverlap = rank('gmail key');
  assert.ok(twoTermOverlap.score < 4, 'two incidental words must not fire a pin');
  const threeTermOverlap = rank('gmail api key handling');
  assert.ok(threeTermOverlap.score >= 4, 'three overlapping terms fire it');
  const singleToken = rank('gmail');
  assert.ok(singleToken.score >= 4, 'a one-word query can only ever fire through the single-token branch');
});

// ---- order sensitivity of the relationship stream ------------------------------------
//
// Asked by the leader for the P2 A/B: the platform's relationship query has no ORDER BY,
// so Postgres returns arbitrary order while SQLite returns rowid order. If the ranker were
// order sensitive the platform baseline itself would be nondeterministic. The answer is
// split, and these two tests pin both halves so a later change cannot quietly move it.

test('candidate membership and order survive a reversed relationship stream', () => {
  const document = (overrides) => ({
    id: 'd', type: 'decision', path: 'p', title: 'T', tags: ['storage'], meta: {}, content: 'c', ...overrides,
  });
  const documents = [document({ id: 'oldA' }), document({ id: 'oldB' }), document({ id: 'new' })];
  const semanticRows = documents.map((item, index) => ({ id: item.id, chunk_id: index, ordinal: 0, chunk_content: 'c', score: 0.6 }));
  const edges = [
    { src: 'doc:new', dst: 'doc:oldA', kind: 'supersedes' },
    { src: 'doc:new', dst: 'doc:oldB', kind: 'supersedes' },
  ];
  const run = (relationships) => rankRetrieval({ query: 'storage', documents, semanticRows, relationships });

  // WHICH documents come back, and in WHAT order, is stable: diversifiedOrder sorts on
  // (score descending, id ascending), a total order, so arrival order cannot survive it.
  assert.deepEqual(run(edges).meta.retrievedIds, run([...edges].reverse()).meta.retrievedIds);
  assert.deepEqual(run(edges).meta.retrievedIds, ['new']);
});

test('the superseded metadata list IS ordered by the relationship stream', () => {
  const document = (overrides) => ({
    id: 'd', type: 'decision', path: 'p', title: 'T', tags: ['storage'], meta: {}, content: 'c', ...overrides,
  });
  const documents = [document({ id: 'oldA' }), document({ id: 'oldB' }), document({ id: 'new' })];
  const semanticRows = documents.map((item, index) => ({ id: item.id, chunk_id: index, ordinal: 0, chunk_content: 'c', score: 0.6 }));
  const edges = [
    { src: 'doc:new', dst: 'doc:oldA', kind: 'supersedes' },
    { src: 'doc:new', dst: 'doc:oldB', kind: 'supersedes' },
  ];
  const supersededOf = (relationships) => rankRetrieval({ query: 'storage', documents, semanticRows, relationships })
    .decisions[0].superseded.map((item) => item.id);

  // This is the order dependence, and it is real: context.js renders the list verbatim as
  // the `superseded:` line, so a different arrival order gives an engineer different bytes.
  // It does not change WHICH documents are retrieved, which is why the measured floor is
  // safe, and measured on the platform corpus a fully reversed relationship stream changes
  // nothing at all (no document there is superseded by two others).
  assert.deepEqual(supersededOf(edges), ['oldA', 'oldB']);
  assert.deepEqual(supersededOf([...edges].reverse()), ['oldB', 'oldA']);
});
