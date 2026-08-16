// The adapter under its real consumer.
//
// A conformance suite proves the store answers its own contract. It does not prove the
// ranker can be served by it: the arms could each be individually correct and still hand
// rag/retrieve.js a row shape, an identity, or an ordering it refuses. This file runs the
// actual retrieve() over the SQLite backend with a fake Ollama, so the seam is exercised
// rather than assumed. It found one defect already: indexedEmbeddingIdentity returned a
// shape assertRetrievalIdentity rejects, which would have failed every query on this
// backend while every store test stayed green.
//
// Zero spend and no network: the embedder is an injected fetch.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { retrieve } from '../src/rag/retrieve.js';
import { createSqliteStore } from '../src/store/sqlite.js';
import { ALLOWED_TYPES } from '../src/rag/types.js';

const DIMENSION = 8;
const PROJECT = 'fixture';
const EMBEDDER = { provider: 'ollama', model: 'fixture-embed', digest: 'sha256-fixture', dimension: DIMENSION };

const ENVIRONMENT = {
  EMBEDDING_PROVIDER: EMBEDDER.provider,
  EMBEDDING_MODEL: EMBEDDER.model,
  EMBEDDING_MODEL_DIGEST: EMBEDDER.digest,
  EMBEDDING_DIM: String(DIMENSION),
  OLLAMA_BASE_URL: 'http://localhost:11434',
};

function topic(weights) {
  const vector = new Array(DIMENSION).fill(0);
  for (const [index, weight] of Object.entries(weights)) vector[Number(index)] = weight;
  return vector;
}

// A deterministic stand in for an embedding model: each known phrase owns an axis, so the
// expected neighbour of a query is arithmetic rather than a model's opinion.
const QUERY_VECTORS = {
  'why was the storage layer redesigned': topic({ 0: 1, 1: 0.2 }),
  'what does fuseRankings do': topic({ 3: 1 }),
};

function fakeOllama() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push(url);
      const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
      if (url.endsWith('/api/version')) return json({ version: '0.5.7' });
      if (url.endsWith('/api/tags')) {
        return json({ models: [{ name: EMBEDDER.model, model: EMBEDDER.model, digest: EMBEDDER.digest }] });
      }
      if (url.endsWith('/api/embed')) {
        const { input } = JSON.parse(options.body);
        return json({
          embeddings: input.map((text) => QUERY_VECTORS[text] ?? topic({ 7: 1 })),
          prompt_eval_count: input.length * 4,
        });
      }
      throw new Error(`unexpected url ${url}`);
    },
  };
}

function documentOf(id, type, meta, content, path) {
  return { id, project: PROJECT, type, path, title: null, tags: [], meta, content, contentHash: null };
}

const DOCUMENTS = [
  documentOf('store.adr-0040', 'decision', { area: 'store' },
    'ADR-0040 records why the storage layer was redesigned around one file per repository.',
    'agent/decisions.md'),
  documentOf('rag.retrieve', 'convention', { area: 'rag' },
    'fuseRankings merges the semantic and the lexical rankings with reciprocal rank fusion.',
    'engine/src/rag/retrieve.js'),
  documentOf('global.lesson.helper-call-sites', 'lesson', {},
    'A declared helper that nothing calls is not a finished implementation.',
    'agent/lessons/helper-call-sites.md'),
  documentOf('draft.wip', 'decision', { area: 'store', draft: 'true' },
    'A draft about the storage layer redesign that must never be retrieved.',
    'agent/decisions.md'),
  documentOf('eval.run-77', 'evaluation', { area: 'store' },
    'Evaluation 77 scored the storage layer redesign and would crowd the pool with its siblings.',
    'agent/evaluations/run-77.md'),
];

const CHUNKS = {
  'store.adr-0040': [{ ordinal: 0, content: DOCUMENTS[0].content, vector: topic({ 0: 1, 1: 0.2 }) }],
  'rag.retrieve': [{ ordinal: 0, content: DOCUMENTS[1].content, vector: topic({ 3: 1 }) }],
  'global.lesson.helper-call-sites': [{ ordinal: 0, content: DOCUMENTS[2].content, vector: topic({ 6: 1 }) }],
  'draft.wip': [{ ordinal: 0, content: DOCUMENTS[3].content, vector: topic({ 0: 1, 1: 0.2 }) }],
  // Deliberately sitting on the same axis as the answer document, so it would reach the
  // pool on merit if nothing excluded it.
  'eval.run-77': [{ ordinal: 0, content: DOCUMENTS[4].content, vector: topic({ 0: 1, 1: 0.2 }) }],
};

const roots = [];
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function storeWith(documents = DOCUMENTS, embedder = EMBEDDER) {
  const root = mkdtempSync(join(tmpdir(), 'daijin-retrieval-'));
  roots.push(root);
  const store = await createSqliteStore({ repoPath: root, project: PROJECT, embedder });
  // One transaction around upserts plus the prune: the atomic full mirror replace.
  await store.transaction(async () => {
    for (const document of documents) {
      await store.upsertDocument(document);
      await store.replaceChunks(document.id, CHUNKS[document.id]);
    }
    await store.replaceAllRelationships([{ src: 'rag.retrieve', dst: 'store.adr-0040', kind: 'refs' }]);
    await store.pruneDocumentsExcept(documents.map((document) => document.id), PROJECT);
  });
  return store;
}

test('retrieve() serves a real query from the SQLite backend', async () => {
  const store = await storeWith();
  const ollama = fakeOllama();
  try {
    const result = await retrieve(
      { query: 'why was the storage layer redesigned', project: PROJECT, k: 5, tokenBudget: 4_000 },
      { store, environment: ENVIRONMENT, fetchImpl: ollama.fetchImpl },
    );

    assert.ok(result.meta.retrievedIds.includes('store.adr-0040'), 'the answer document is retrieved');
    assert.ok(!result.meta.rankedIds.includes('draft.wip'), 'a draft never reaches the ranker');
    assert.deepEqual(result.meta.standingIds, ['global.lesson.helper-call-sites']);
    assert.equal(result.meta.embedding.model, EMBEDDER.model);
    assert.ok(result.meta.tokenCount > 0);
    assert.ok(ollama.calls.some((url) => url.endsWith('/api/embed')), 'the query was embedded locally');
  } finally {
    await store.close();
  }
});

test('retrieve() finds an identifier query through the lexical arm', async () => {
  const store = await storeWith();
  const ollama = fakeOllama();
  try {
    const result = await retrieve(
      { query: 'what does fuseRankings do', project: PROJECT, k: 5, tokenBudget: 4_000 },
      { store, environment: ENVIRONMENT, fetchImpl: ollama.fetchImpl },
    );
    assert.ok(result.meta.retrievedIds.includes('rag.retrieve'));
  } finally {
    await store.close();
  }
});

test('retrieve() refuses an index built by a different embedder', async () => {
  const store = await storeWith(DOCUMENTS, { ...EMBEDDER, digest: 'sha256-something-else' });
  const ollama = fakeOllama();
  try {
    await assert.rejects(
      () => retrieve(
        { query: 'why was the storage layer redesigned', project: PROJECT, k: 5, tokenBudget: 4_000 },
        { store, environment: ENVIRONMENT, fetchImpl: ollama.fetchImpl },
      ),
      /identity differs from the currently served model/,
    );
  } finally {
    await store.close();
  }
});

test('retrieve() honours the gold-provenance exclusion end to end', async () => {
  const store = await storeWith();
  const ollama = fakeOllama();
  try {
    const result = await retrieve(
      {
        query: 'why was the storage layer redesigned',
        project: PROJECT,
        k: 5,
        tokenBudget: 4_000,
        excludeDocumentIds: ['store.adr-0040', 'global.lesson.helper-call-sites'],
      },
      { store, environment: ENVIRONMENT, fetchImpl: ollama.fetchImpl },
    );
    assert.ok(!result.meta.retrievedIds.includes('store.adr-0040'), 'the excluded answer never returns');
    assert.deepEqual(result.meta.standingIds, [], 'a standing unit that is the answer is dropped too');
    assert.equal(result.meta.excludedDocumentCount, 2);
  } finally {
    await store.close();
  }
});

test('the evaluation default lives in retrieve(), not in the store', async () => {
  const store = await storeWith();
  const ollama = fakeOllama();
  const query = { query: 'why was the storage layer redesigned', project: PROJECT, k: 5, tokenBudget: 4_000 };
  const dependencies = { store, environment: ENVIRONMENT, fetchImpl: ollama.fetchImpl };
  try {
    // The store honors filters exactly as given, so a silent caller gets the evaluation.
    // That is the behaviour D-0013 preserves for brain.record_evaluation reads.
    const direct = await store.semanticCandidates(topic({ 0: 1, 1: 0.2 }), { project: PROJECT }, 20);
    assert.ok(direct.some((row) => row.id === 'eval.run-77'),
      'the store applies no default of its own; silence about types means silence');

    // retrieve.js computes DEFAULT_EXCLUDED_TYPES above the store and hands it down as an
    // explicit excludeTypes, which is where the crowding-out fix belongs.
    const shipped = await retrieve(query, dependencies);
    assert.ok(!shipped.meta.retrievedIds.includes('eval.run-77'),
      'the shipped path still keeps evaluations from crowding the pool');
    assert.ok(shipped.meta.retrievedIds.includes('store.adr-0040'), 'and the answer still lands');

    // A caller who asks for evaluations gets them, all the way through.
    const asked = await retrieve({ ...query, types: ['evaluation'] }, dependencies);
    assert.ok(asked.meta.retrievedIds.includes('eval.run-77'));

    // Control, so the assertion above is not vacuous: naming every allowed type is an
    // opinion, so no default applies, and the evaluation reaches retrievedIds while
    // competing against the same documents the silent call ranked. Without this, a
    // ranking that would have dropped the evaluation anyway would look like exclusion.
    const everything = await retrieve({ ...query, types: [...ALLOWED_TYPES] }, dependencies);
    assert.ok(everything.meta.retrievedIds.includes('eval.run-77'),
      'absent the default the evaluation does reach the caller, so its absence above is the default at work');
    assert.ok(everything.meta.retrievedIds.includes('store.adr-0040'));
  } finally {
    await store.close();
  }
});

test('a rebuild that drops a source file removes it from retrieval', async () => {
  const store = await storeWith();
  const ollama = fakeOllama();
  try {
    const query = { query: 'why was the storage layer redesigned', project: PROJECT, k: 5, tokenBudget: 4_000 };
    const dependencies = { store, environment: ENVIRONMENT, fetchImpl: ollama.fetchImpl };
    assert.ok((await retrieve(query, dependencies)).meta.retrievedIds.includes('store.adr-0040'));

    // The source file is gone on the next ingest run, so the rebuild does not keep it.
    const kept = DOCUMENTS.filter((document) => document.id !== 'store.adr-0040');
    await store.transaction(async () => {
      for (const document of kept) {
        await store.upsertDocument(document);
        await store.replaceChunks(document.id, CHUNKS[document.id]);
      }
      await store.pruneDocumentsExcept(kept.map((document) => document.id), PROJECT);
    });

    const after = await retrieve(query, dependencies);
    assert.ok(!after.meta.retrievedIds.includes('store.adr-0040'),
      'an orphan the rebuild dropped must not keep answering queries');
  } finally {
    await store.close();
  }
});
