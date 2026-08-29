// Store v3 conformance suite: the contract, exercised method by method.
//
// Both backends must pass this file. It is parameterized so the pgvector implementation
// runs the identical suite:
//
//   import { runStoreConformance } from './store-conformance.test.js';
//   runStoreConformance({ label: 'pgvector', createStore: async () => ... });
//
// Only createStore may reference a backend specific module. Nothing here assumes an
// embedder either: the fixture vectors are written by hand so the expected neighbour
// ordering is arithmetic rather than a model's opinion.
//
// Several cases are shaped to fail against a plausible WRONG implementation, not just to
// pass against a right one, because that is the only version of a conformance test that
// is worth running:
//   - the rebuild case fails against an implementation that keeps orphans
//   - the relationship case fails against a per-source replace
//   - the prune case fails against an unscoped delete
//   - the standing case fails against an empty default prefix
// D-0009, D-0011, and verifier findings 39, 44, 55, 58, 59.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '../src/store/sqlite.js';

export const FIXTURE_DIMENSION = 8;
export const FIXTURE_PROJECT = 'fixture';
const OTHER_PROJECT = 'other-repo';

/** Topic axes, one per dimension slot, so a nearest neighbour is checkable by hand. */
function topic(weights) {
  const vector = new Array(FIXTURE_DIMENSION).fill(0);
  for (const [index, weight] of Object.entries(weights)) vector[Number(index)] = weight;
  return vector;
}

function documentOf(id, type, meta, content, extra = {}) {
  return {
    id,
    project: FIXTURE_PROJECT,
    type,
    path: extra.path ?? `agent/${id.replace(/\./g, '/')}.md`,
    title: extra.title ?? null,
    tags: extra.tags ?? [],
    meta,
    content,
    contentHash: extra.contentHash ?? null,
  };
}

export const FIXTURE_DOCUMENTS = [
  documentOf('store.adr-0040', 'adr', { area: 'store' },
    'ADR-0040 records why the storage layer was redesigned around one file per repository.',
    { title: 'Storage layer redesign', tags: ['storage', 'sqlite'], path: 'agent/decisions.md' }),
  documentOf('rag.retrieve', 'card', { area: 'rag', symbol: 'fuseRankings' },
    'fuseRankings merges the semantic and the lexical rankings with reciprocal rank fusion.',
    { title: 'Retrieval entry point', tags: ['rag'], path: 'engine/src/rag/retrieve.js' }),
  documentOf('rag.rank', 'card', { area: 'rag' },
    'The ranking function ranks candidates by score and caps how much any one candidate may take.',
    { title: 'Ranker', path: 'engine/src/rag/rank.js' }),
  documentOf('ops.notes', 'lesson', {},
    'Operational notes with no area at all.', { path: 'agent/errors.md' }),
  documentOf('arch.overview', 'architecture', { area: 'rag' },
    'The engine is a daemon over a per repo store, an MCP server and a certification gym.',
    { title: 'Engine overview' }),
  documentOf('curated.provenance', 'lesson', { area: 'store', retrieval_provenance: ['commit:9f2c1a', 'gold:g004'] },
    'A unit with a curated provenance array is a candidate wherever it lands in the pool.'),
  documentOf('eval.run-77', 'evaluation', { area: 'store' },
    'Evaluation 77 scored the storage layer redesign and crowded the pool with its siblings.'),
  documentOf('global.lesson.helper-call-sites', 'lesson', { standing: true },
    'A declared helper that nothing calls is not a finished implementation.',
    { title: 'Helper call sites', tags: ['standing'] }),
  documentOf('global.lesson.draft-standing', 'lesson', { standing: true, draft: 'true' },
    'A standing unit still marked draft. The platform standing query has no draft predicate.'),
  documentOf('draft.wip', 'adr', { area: 'store', draft: 'true' },
    'A draft unit about the storage layer redesign that must never be retrievable.',
    { path: 'agent/decisions.md' }),
];

/** ChunkWriteRow: ordinal, content, vector. The store assigns chunk ids. */
export const FIXTURE_CHUNKS = {
  'store.adr-0040': [
    // The identity beacon: it ranks, but its content must never reach a reader, so every
    // arm substitutes ordinal 0 in its place.
    { ordinal: -1, content: 'IDENTITY BEACON, MUST NOT BE READ: storage layer redesign adr-0040', vector: topic({ 0: 1, 1: 0.25 }) },
    { ordinal: 0, content: 'ADR-0040 records why the storage layer was redesigned around one file per repository.', vector: topic({ 0: 1, 1: 0.2 }) },
    { ordinal: 1, content: 'A rebuild must handle deleting tracker rows before it writes, so no partial index survives.', vector: topic({ 0: 0.9, 2: 0.3 }) },
  ],
  'rag.retrieve': [
    { ordinal: 0, content: 'fuseRankings merges the semantic and the lexical rankings with reciprocal rank fusion.', vector: topic({ 3: 1 }) },
  ],
  'rag.rank': [
    { ordinal: 0, content: 'The ranking function ranks candidates by score and caps how much any one candidate may take.', vector: topic({ 3: 0.8, 4: 0.4 }) },
  ],
  'ops.notes': [
    { ordinal: 0, content: 'Ollama must be reachable before an ingest starts, otherwise the run stops at the first batch.', vector: topic({ 5: 1 }) },
    { ordinal: 1, content: 'A gate that fails on the baseline and on the candidate alike is dead coverage, not a gate.', vector: topic({ 5: 0.7, 6: 0.2 }) },
  ],
  'arch.overview': [
    { ordinal: 0, content: 'The engine is a daemon over a per repo store, an MCP server and a certification gym.', vector: topic({ 7: 1 }) },
  ],
  'curated.provenance': [
    { ordinal: 0, content: 'A unit with a curated provenance array is a candidate wherever it lands in the pool.', vector: topic({ 6: 1 }) },
  ],
  'eval.run-77': [
    { ordinal: 0, content: 'Evaluation 77 scored the storage layer redesign and crowded the pool with its siblings.', vector: topic({ 0: 1, 1: 0.2 }) },
  ],
  'global.lesson.helper-call-sites': [
    { ordinal: 0, content: 'A declared helper that nothing calls is not a finished implementation.', vector: topic({ 6: 0.5, 7: 0.5 }) },
  ],
  'global.lesson.draft-standing': [
    { ordinal: 0, content: 'A standing unit still marked draft.', vector: topic({ 4: 1 }) },
  ],
  'draft.wip': [
    { ordinal: 0, content: 'A draft unit about the storage layer redesign that must never be retrievable.', vector: topic({ 0: 1, 1: 0.2 }) },
  ],
};

export const FIXTURE_RELATIONSHIPS = [
  { src: 'store.adr-0040', dst: 'draft.wip', kind: 'supersedes' },
  { src: 'store.adr-0040', dst: 'rag.rank', kind: 'refs' },
  { src: 'rag.retrieve', dst: 'rag.rank', kind: 'imports' },
  { src: 'ops.notes', dst: 'rag.retrieve', kind: 'refs' },
];

export const FIXTURE = {
  documents: FIXTURE_DOCUMENTS,
  chunks: FIXTURE_CHUNKS,
  relationships: FIXTURE_RELATIONSHIPS,
  dimension: FIXTURE_DIMENSION,
  project: FIXTURE_PROJECT,
};

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

const ids = (rows) => rows.map((row) => row.id);
const chunkIds = (rows) => rows.map((row) => String(row.chunk_id));
const edgeOf = (row) => `${row.src} ${row.kind} ${row.dst}`;
const scope = { project: FIXTURE_PROJECT };
const ALL_KINDS = ['imports', 'supersedes', 'fixes', 'refs'];

/** The write side of the contract, which is also the ingest path. */
async function loadFixture(store, fixture) {
  await store.transaction(async () => {
    for (const document of fixture.documents) {
      await store.upsertDocument(document);
      await store.replaceChunks(document.id, fixture.chunks[document.id] ?? []);
    }
    await store.replaceAllRelationships(fixture.relationships);
  });
}

/**
 * @param {object} options
 * @param {string} options.label          Backend name, used in the test titles.
 * @param {Function} options.createStore  async () => Store, empty and initialized.
 * @param {Function} [options.seed]       async (store, fixture) => void.
 */
export function runStoreConformance({ label, createStore, seed = loadFixture }) {
  const withStore = async (body) => {
    const store = await createStore();
    try {
      await body(store);
    } finally {
      await store.close();
    }
  };

  const seeded = async (body) => withStore(async (store) => {
    await seed(store, FIXTURE);
    await body(store);
  });

  test(`${label}: init and migrate are idempotent`, async () => {
    await withStore(async (store) => {
      await store.init();
      await store.migrate();
      await store.migrate();
      assert.deepEqual(await store.allDocuments({ project: null }), []);
    });
  });

  // ---- write side -------------------------------------------------------------------

  test(`${label}: upsertDocument round trips every field, contentHash included`, async () => {
    await seeded(async (store) => {
      const [document] = (await store.allDocuments(scope)).filter((row) => row.id === 'store.adr-0040');
      assert.equal(document.type, 'adr');
      assert.equal(document.path, 'agent/decisions.md');
      assert.equal(document.title, 'Storage layer redesign');
      assert.deepEqual(document.tags, ['storage', 'sqlite']);
      assert.equal(document.meta.area, 'store');
      assert.match(document.content, /^ADR-0040 records/);
      assert.ok(document.contentHash, 'contentHash is written at ingest, so an incremental run can diff');

      const before = document.contentHash;
      await store.upsertDocument({ ...FIXTURE_DOCUMENTS[0], content: 'rewritten', contentHash: null });
      const [updated] = (await store.allDocuments(scope)).filter((row) => row.id === 'store.adr-0040');
      assert.equal(updated.content, 'rewritten');
      assert.notEqual(updated.contentHash, before, 'a changed document changes its hash');

      // content is non-optional in v3. Defaulting a missing one to '' would hash the empty
      // string as though it were real content, and that hash is what incremental ingest
      // diffs to decide docs_changed and deletedIds.
      const { content, ...withoutContent } = FIXTURE_DOCUMENTS[1];
      await assert.rejects(() => store.upsertDocument(withoutContent), /requires content/);
      await assert.rejects(() => store.upsertDocument({ ...FIXTURE_DOCUMENTS[1], content: null }), /requires content/);
    });
  });

  test(`${label}: the store assigns chunk ids and replaceChunks clears every index`, async () => {
    await seeded(async (store) => {
      const before = await store.lexicalCandidates('tracker rows', null, scope, 10);
      assert.equal(before.length, 1);
      assert.equal(String(before[0].chunk_id), 'store.adr-0040#1', 'chunk ids are derived, not supplied');

      await store.replaceChunks('store.adr-0040', [
        { ordinal: 0, content: 'a completely new chunk about caching', vector: topic({ 1: 1 }) },
      ]);

      assert.deepEqual(await store.lexicalCandidates('tracker rows', null, scope, 10), [],
        'the replaced chunk leaves the lexical index');
      const semantic = await store.semanticCandidates(topic({ 0: 1, 1: 0.25 }), scope, 20);
      assert.ok(!chunkIds(semantic).includes('store.adr-0040#-1'), 'the replaced chunk leaves the vector index');
      assert.deepEqual(chunkIds(await store.lexicalCandidates('caching', null, scope, 10)), ['store.adr-0040#0']);
    });
  });

  test(`${label}: a chunk write is strict about its shape and about its document`, async () => {
    await seeded(async (store) => {
      // ChunkWriteRow is { ordinal, content, vector }. Ordinal is never inferred from an
      // array index: -1 is the identity beacon, and guessing it would put a chunk that
      // must not be read where a chunk that must be read belongs.
      await assert.rejects(
        () => store.replaceChunks('rag.rank', [{ content: 'no ordinal at all', vector: null }]),
        /requires an integer ordinal/,
      );
      await assert.rejects(
        () => store.replaceChunks('rag.rank', [{ ordinal: 0, text: 'the old field name', vector: null }]),
        /requires content as a string/,
      );
      // v3 has upsertDocument, so a chunk for a document nobody declared is an error
      // rather than an invented stub whose type, area and path nothing ever recorded.
      await assert.rejects(
        () => store.replaceChunks('never.declared', [{ ordinal: 0, content: 'orphan chunk', vector: null }]),
        /document never\.declared does not exist/,
      );
      assert.equal((await store.lexicalCandidates('caps how much any one candidate', null, scope, 10)).length, 1,
        'and the rejected writes left the existing chunks alone');
    });
  });

  test(`${label}: replaceAllRelationships is GLOBAL, so an unmentioned source is evicted`, async () => {
    await seeded(async (store) => {
      assert.equal((await store.relationshipEdges(ALL_KINDS)).length, 4);

      // The new set mentions only store.adr-0040. A per-source replace would delete that
      // source's edges and leave rag.retrieve's and ops.notes's behind, which is exactly
      // how brain.impact_of ends up reporting dependents that no longer exist.
      await store.replaceAllRelationships([{ src: 'store.adr-0040', dst: 'ops.notes', kind: 'fixes' }]);
      assert.deepEqual(
        (await store.relationshipEdges(ALL_KINDS)).map(edgeOf),
        ['store.adr-0040 fixes ops.notes'],
        'every edge the rebuild did not mention is gone',
      );

      await assert.rejects(
        () => store.replaceAllRelationships([{ src: 'a', dst: 'b', kind: 'NOT A KIND' }]),
        /Unsupported relationship kind/,
      );
    });
  });

  test(`${label}: deleteDocuments cascades to chunks and to edges on both sides`, async () => {
    await seeded(async (store) => {
      await store.deleteDocuments(['rag.rank']);

      assert.ok(!ids(await store.allDocuments(scope)).includes('rag.rank'));
      assert.deepEqual(await store.lexicalCandidates('caps how much any one candidate', null, scope, 10), [],
        'the deleted document takes its chunks out of the lexical index');
      assert.ok(!ids(await store.semanticCandidates(topic({ 3: 0.8, 4: 0.4 }), scope, 20)).includes('rag.rank'),
        'and out of the vector index');

      const edges = (await store.relationshipEdges(ALL_KINDS)).map(edgeOf);
      assert.ok(!edges.some((edge) => edge.includes('rag.rank')),
        'edges go where the document is source OR destination; imports edges are usually the destination case');
      assert.deepEqual(edges.sort(), ['ops.notes refs rag.retrieve', 'store.adr-0040 supersedes draft.wip']);
      assert.deepEqual(await store.existingDocumentIds(['rag.rank']), []);
    });
  });

  test(`${label}: a full rebuild is atomic, and a successful one leaves no orphan`, async () => {
    await seeded(async (store) => {
      const before = ids(await store.allDocuments({ project: null }));
      assert.ok(before.length > 2);

      const rebuilt = documentOf('store.adr-0041', 'adr', { area: 'store' }, 'The rebuilt mirror.');

      // A rebuild that fails must leave the OLD mirror intact, not a half applied one.
      await assert.rejects(() => store.transaction(async () => {
        await store.upsertDocument(rebuilt);
        await store.replaceChunks(rebuilt.id, [{ ordinal: 0, content: 'the rebuilt mirror', vector: topic({ 2: 1 }) }]);
        await store.pruneDocumentsExcept([rebuilt.id], FIXTURE_PROJECT);
        throw new Error('rebuild failed halfway');
      }), /rebuild failed halfway/);

      assert.deepEqual(ids(await store.allDocuments({ project: null })), before,
        'a failed rebuild leaves the previous mirror exactly as it was');
      assert.ok(!ids(await store.allDocuments({ project: null })).includes(rebuilt.id));

      // And a rebuild that succeeds is AUTHORITATIVE rather than additive: this half is
      // what fails against an implementation that only ever upserts.
      await store.transaction(async () => {
        await store.upsertDocument(rebuilt);
        await store.replaceChunks(rebuilt.id, [{ ordinal: 0, content: 'the rebuilt mirror', vector: topic({ 2: 1 }) }]);
        await store.pruneDocumentsExcept([rebuilt.id], FIXTURE_PROJECT);
      });
      assert.deepEqual(ids(await store.allDocuments({ project: null })), [rebuilt.id],
        'every document the rebuild did not keep is gone, orphans included');
      assert.deepEqual(await store.existingDocumentIds(['store.adr-0040']), [],
        'the gold-set existence gate can no longer certify a deleted document');
      assert.deepEqual(await store.lexicalCandidates('tracker rows', null, { project: null }, 10), []);
    });
  });

  test(`${label}: a prune scoped to one project leaves another project intact`, async () => {
    await seeded(async (store) => {
      const neighbour = {
        id: 'other.adr-0001',
        project: OTHER_PROJECT,
        type: 'adr',
        path: 'agent/decisions.md',
        title: 'A neighbouring project',
        tags: [],
        meta: { area: 'store' },
        content: 'A document belonging to a different project entirely.',
        contentHash: null,
      };
      await store.upsertDocument(neighbour);
      await store.replaceChunks(neighbour.id, [{ ordinal: 0, content: 'a neighbouring project document', vector: topic({ 1: 0.5 }) }]);

      await store.pruneDocumentsExcept([], FIXTURE_PROJECT);

      assert.deepEqual(ids(await store.allDocuments({ project: FIXTURE_PROJECT })), [],
        'the scoped project is emptied');
      assert.deepEqual(ids(await store.allDocuments({ project: OTHER_PROJECT })), ['other.adr-0001'],
        'an unscoped prune would have deleted this, which is the data loss hazard');

      // null means the whole store, which is the per repo sqlite case.
      await store.pruneDocumentsExcept([], null);
      assert.deepEqual(await store.allDocuments({ project: null }), []);
    });
  });

  test(`${label}: pruneDocumentsExcept refuses to run without a project scope`, async () => {
    await seeded(async (store) => {
      await assert.rejects(() => store.pruneDocumentsExcept(['store.adr-0040']), /requires a project scope/);
      assert.ok(ids(await store.allDocuments(scope)).includes('store.adr-0040'), 'and nothing was deleted');
    });
  });

  // ---- the four candidate arms --------------------------------------------------------

  test(`${label}: semanticCandidates returns raw cosine, descending, limited`, async () => {
    await seeded(async (store) => {
      const query = topic({ 3: 1, 4: 0.2 });
      const rows = await store.semanticCandidates(query, scope, 3);
      assert.equal(rows.length, 3);
      assert.deepEqual(chunkIds(rows).slice(0, 2), ['rag.retrieve#0', 'rag.rank#0']);
      for (let index = 1; index < rows.length; index += 1) {
        assert.ok(rows[index - 1].score >= rows[index].score, 'scores must be descending');
      }
      const expected = cosine(query, FIXTURE_CHUNKS['rag.retrieve'][0].vector);
      assert.ok(Math.abs(rows[0].score - expected) < 1e-6, `score ${rows[0].score} should be the raw cosine ${expected}`);
    });
  });

  test(`${label}: the identity beacon never leaks its own content`, async () => {
    await seeded(async (store) => {
      const rows = await store.semanticCandidates(topic({ 0: 1, 1: 0.25 }), scope, 5);
      const beacon = rows.find((row) => String(row.chunk_id) === 'store.adr-0040#-1');
      assert.ok(beacon, 'the beacon still ranks');
      assert.equal(beacon.ordinal, -1);
      assert.equal(beacon.chunk_content, FIXTURE_CHUNKS['store.adr-0040'][1].content, 'ordinal 0 content is substituted');
      assert.ok(!beacon.chunk_content.includes('MUST NOT BE READ'));
    });
  });

  test(`${label}: a draft unit is never a candidate and never in allDocuments`, async () => {
    await seeded(async (store) => {
      const storageQuery = topic({ 0: 1, 1: 0.2 });
      assert.ok(!ids(await store.semanticCandidates(storageQuery, scope, 20)).includes('draft.wip'));
      assert.ok(!ids(await store.lexicalCandidates('draft storage layer redesign', null, scope, 40)).includes('draft.wip'));
      assert.ok(!ids(await store.provenanceCandidates(storageQuery, scope)).includes('draft.wip'));
      assert.ok(!ids(await store.allDocuments(scope)).includes('draft.wip'));
      assert.deepEqual(await store.allDocuments({ ...scope, types: ['adr'], excludeDocumentIds: ['store.adr-0040'] }), [],
        'not even when the caller asks for its type directly');
    });
  });

  test(`${label}: draft exclusion does NOT reach standing units or the existence gate`, async () => {
    await seeded(async (store) => {
      // The platform standing query has no draft predicate (standing.js:33-39), and the
      // existence gate must see a document that exists in any state, or a gold case
      // pointing at it looks like a retrieval miss instead of a stale case.
      assert.ok(ids(await store.standingDocuments({})).includes('global.lesson.draft-standing'));
      assert.deepEqual(await store.existingDocumentIds(['draft.wip']), ['draft.wip']);
    });
  });

  test(`${label}: the store applies NO type default; it honors filters exactly as given`, async () => {
    await seeded(async (store) => {
      const query = topic({ 0: 1, 1: 0.2 });

      // The ['evaluation'] exclusion belongs to the retrieval layer (retrieve.js:60), not
      // here. A store that applied it itself would double-apply it and would hide
      // evaluations from brain.record_evaluation reads (D-0013).
      assert.ok(ids(await store.semanticCandidates(query, scope, 20)).includes('eval.run-77'),
        'silence about types means silence, not a hidden default');
      assert.ok(ids(await store.allDocuments(scope)).includes('eval.run-77'));

      // The retrieval layer expresses the default as excludeTypes, and the store obeys it.
      const excluded = await store.semanticCandidates(query, { ...scope, excludeTypes: ['evaluation'] }, 20);
      assert.ok(!ids(excluded).includes('eval.run-77'));
      assert.ok(ids(excluded).includes('store.adr-0040'), 'and drops nothing else');

      const asked = await store.semanticCandidates(query, { ...scope, types: ['evaluation'] }, 20);
      assert.deepEqual(ids(asked), ['eval.run-77'], 'a caller who asks for evaluations gets exactly those');
    });
  });

  test(`${label}: semanticCandidates honours every filter and still fills the limit`, async () => {
    await seeded(async (store) => {
      const query = topic({ 0: 1 });

      const typed = await store.semanticCandidates(query, { ...scope, types: ['card'] }, 2);
      assert.deepEqual(chunkIds(typed).sort(), ['rag.rank#0', 'rag.retrieve#0']);

      const area = await store.semanticCandidates(query, { ...scope, area: 'rag' }, 10);
      assert.ok(area.every((row) => row.meta.area === 'rag'));

      const excluded = await store.semanticCandidates(query, { ...scope, excludeTypes: ['adr'] }, 10);
      assert.ok(excluded.every((row) => row.type !== 'adr'));

      const withoutDocument = await store.semanticCandidates(query, { ...scope, excludeDocumentIds: ['store.adr-0040'] }, 10);
      assert.ok(!ids(withoutDocument).includes('store.adr-0040'));

      assert.deepEqual(await store.semanticCandidates(query, { project: 'somewhere-else' }, 10), []);
    });
  });

  test(`${label}: architectureCandidates scores the whole bounded class, with no limit`, async () => {
    await seeded(async (store) => {
      const rows = await store.architectureCandidates(topic({ 0: 1 }), scope);
      assert.deepEqual(ids(rows), ['arch.overview']);
      assert.ok(rows.every((row) => row.type === 'architecture'));
      const expected = cosine(topic({ 0: 1 }), FIXTURE_CHUNKS['arch.overview'][0].vector);
      assert.ok(Math.abs(rows[0].score - expected) < 1e-6);
    });
  });

  test(`${label}: provenanceCandidates takes only non empty provenance arrays`, async () => {
    await seeded(async (store) => {
      const rows = await store.provenanceCandidates(topic({ 0: 1 }), scope);
      assert.deepEqual(ids(rows), ['curated.provenance']);
      assert.deepEqual(rows[0].meta.retrieval_provenance, ['commit:9f2c1a', 'gold:g004']);

      await store.upsertDocument({ ...FIXTURE_DOCUMENTS[5], meta: { area: 'store', retrieval_provenance: [] } });
      assert.deepEqual(await store.provenanceCandidates(topic({ 0: 1 }), scope), [],
        'an empty array is not a curated provenance');
    });
  });

  test(`${label}: lexicalCandidates reports raw cosine as score, never bm25`, async () => {
    await seeded(async (store) => {
      const query = topic({ 3: 1 });
      const rows = await store.lexicalCandidates('fuseRankings', query, scope, 40);
      assert.deepEqual(chunkIds(rows), ['rag.retrieve#0']);

      const expected = cosine(query, FIXTURE_CHUNKS['rag.retrieve'][0].vector);
      assert.ok(Math.abs(rows[0].score - expected) < 1e-6, 'score is raw cosine, not the lexical rank');
      // sqlite bm25 is negative and lower is better. A leak into score would invert the
      // fusion rescale silently, which is why the contract pins this field.
      assert.ok(rows[0].score > 0);

      const many = await store.lexicalCandidates('the ranking candidates', query, scope, 40);
      for (let index = 1; index < many.length; index += 1) {
        assert.ok(many[index - 1].lex_rank >= many[index].lex_rank, 'lexical rank orders the arm, descending');
      }
      assert.deepEqual(await store.lexicalCandidates('', query, scope, 40), []);
      assert.deepEqual(await store.lexicalCandidates('zzzznotinthecorpus', query, scope, 40), []);
    });
  });

  test(`${label}: a chunk with NO vector still answers the lexical arm, scored null`, async () => {
    // A MIXED CORPUS - some chunks embedded, some not - is not exotic: init's A/B mirror
    // writes exactly that (it counts `embedded` separately from the chunk total), and the
    // mixed store is the corpus the two backends are compared over.
    //
    // sqlite's lexical arm LEFT JOINs the vector table and handed v.embedding straight to
    // vec_distance_cosine, which treats NULL as an INPUT ERROR rather than as NULL. One
    // FTS-matching vectorless chunk therefore aborted the whole query - "Error reading 1st
    // vector ... found NULL" - taking down retrieve() rather than one arm, while pgvector
    // returned NULL for the same row. A backend-specific crash on the axis the two are
    // measured over is the defect; a null score is already the contract (fusion falls back
    // to rank alone when there is no similarity to use).
    await seeded(async (store) => {
      await store.upsertDocument(documentOf('store.unembedded', 'note', { area: 'store' },
        'A note about ranking candidates that was never embedded.'));
      await store.replaceChunks('store.unembedded', [
        { ordinal: 0, content: 'The ranking candidates note has no vector at all.', vector: null },
      ]);

      const query = topic({ 3: 1 });
      const rows = await store.lexicalCandidates('the ranking candidates', query, scope, 40);
      const unembedded = rows.filter((row) => row.id === 'store.unembedded');
      assert.equal(unembedded.length, 1, 'the vectorless chunk is a lexical hit like any other');
      assert.equal(unembedded[0].score, null, 'and carries no similarity, rather than a wrong one');
      // The control: the arm still scores everything that DOES have a vector, so the guard
      // did not simply null the column out.
      assert.ok(rows.some((row) => typeof row.score === 'number' && row.score > 0),
        'embedded chunks in the same result set still carry a real cosine');
    });
  });

  // ---- inventory, graph, standing, identity --------------------------------------------

  test(`${label}: allDocuments filters and caps the gold-provenance exclusion`, async () => {
    await seeded(async (store) => {
      assert.deepEqual(ids(await store.allDocuments({ ...scope, types: ['card'] })), ['rag.rank', 'rag.retrieve']);
      assert.deepEqual(ids(await store.allDocuments({ ...scope, area: 'rag' })), ['arch.overview', 'rag.rank', 'rag.retrieve']);
      assert.ok(!ids(await store.allDocuments({ ...scope, excludeTypes: ['lesson'] })).includes('ops.notes'));
      assert.ok(!ids(await store.allDocuments({ ...scope, excludeDocumentIds: ['rag.rank'] })).includes('rag.rank'));

      const tooMany = Array.from({ length: 1001 }, (_, index) => `doc.${index}`);
      await assert.rejects(() => store.allDocuments({ ...scope, excludeDocumentIds: tooMany }), /at most 1000/);
      await assert.rejects(
        () => store.semanticCandidates(topic({ 0: 1 }), { ...scope, excludeDocumentIds: tooMany }, 10),
        /at most 1000/,
      );
    });
  });

  test(`${label}: relationshipEdges returns only the requested kinds`, async () => {
    await seeded(async (store) => {
      assert.deepEqual((await store.relationshipEdges(['imports'])).map(edgeOf), ['rag.retrieve imports rag.rank']);
      assert.equal((await store.relationshipEdges(ALL_KINDS)).length, 4);
      assert.deepEqual(await store.relationshipEdges([]), []);
    });
  });

  test(`${label}: standingDocuments defaults to the global namespace, not to everything`, async () => {
    await seeded(async (store) => {
      // An empty default prefix matches every document, makes everything standing, and
      // rides the whole corpus outside the token budget with no error at all.
      const units = await store.standingDocuments({});
      assert.deepEqual(ids(units), ['global.lesson.draft-standing', 'global.lesson.helper-call-sites']);
      assert.ok(units.length < FIXTURE_DOCUMENTS.length, 'the default prefix is a filter, not a pass through');
      assert.equal(units[1].content, 'A declared helper that nothing calls is not a finished implementation.');

      assert.deepEqual(
        ids(await store.standingDocuments({ excludeDocumentIds: ['global.lesson.helper-call-sites'] })),
        ['global.lesson.draft-standing'],
        'a standing unit that is the answer to the exam is dropped like any other',
      );
      assert.deepEqual(ids(await store.standingDocuments({ prefix: 'rag.' })), ['rag.rank', 'rag.retrieve']);
    });
  });

  test(`${label}: existingDocumentIds ignores project and draft scope`, async () => {
    await seeded(async (store) => {
      const found = await store.existingDocumentIds(['rag.rank', 'draft.wip', 'renamed.away']);
      assert.deepEqual(found.sort(), ['draft.wip', 'rag.rank']);
      assert.deepEqual(await store.existingDocumentIds([]), []);
    });
  });

  test(`${label}: indexedEmbeddingIdentity is null before an ingest and set after`, async () => {
    await withStore(async (store) => {
      assert.equal(await store.indexedEmbeddingIdentity(), null);
      await seed(store, FIXTURE);
      const identity = await store.indexedEmbeddingIdentity();
      assert.ok(identity, 'an indexed corpus reports an embedding identity');
      assert.equal(Number(identity.dimension), FIXTURE_DIMENSION);
    });
  });

  test(`${label}: meta round trips and returns null for an unknown key`, async () => {
    await withStore(async (store) => {
      assert.equal(await store.getMeta('nothing.here'), null);
      await store.setMeta('gold.version', '3');
      assert.equal(await store.getMeta('gold.version'), '3');
      await store.setMeta('gold.version', '4');
      assert.equal(await store.getMeta('gold.version'), '4');
    });
  });

  test(`${label}: transaction commits, rolls back, and nests through a savepoint`, async () => {
    await withStore(async (store) => {
      const value = await store.transaction(async () => {
        await store.setMeta('committed', 'yes');
        return 42;
      });
      assert.equal(value, 42);
      assert.equal(await store.getMeta('committed'), 'yes');

      await assert.rejects(() => store.transaction(async () => {
        await store.upsertDocument(FIXTURE_DOCUMENTS[0]);
        await store.setMeta('rolled.back', 'written');
        throw new Error('planned failure');
      }), /planned failure/);
      assert.equal(await store.getMeta('rolled.back'), null, 'a failed transaction leaves nothing behind');
      assert.deepEqual(await store.allDocuments({ project: null }), []);

      // A nested failure the outer call catches rolls back only the inner work, which is
      // what a savepoint buys over a shared flag.
      await store.transaction(async () => {
        await store.upsertDocument(FIXTURE_DOCUMENTS[1]);
        await store.transaction(async () => {
          await store.upsertDocument(FIXTURE_DOCUMENTS[2]);
          throw new Error('inner failure');
        }).catch(() => {});
      });
      assert.deepEqual(ids(await store.allDocuments({ project: null })), ['rag.retrieve'],
        'the outer write survived, the inner did not');
    });
  });
}

// The shipped default backend runs the suite here. One SQLite file per store instance,
// created under a temp directory so the one file per repo layout is what is exercised.
const temporaryRoots = [];
process.on('exit', () => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

runStoreConformance({
  label: 'sqlite',
  createStore: async () => {
    const root = mkdtempSync(join(tmpdir(), 'daijin-store-'));
    temporaryRoots.push(root);
    const store = new SqliteStore({
      path: join(root, '.daijin', 'brain.sqlite'),
      project: FIXTURE_PROJECT,
      dimension: FIXTURE_DIMENSION,
      embedderId: 'fixture:hand-written@v1',
    });
    await store.init();
    return store;
  },
});
