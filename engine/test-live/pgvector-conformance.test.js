// The pgvector backend against a real Postgres.
//
// Two parts:
//  1. The SHARED store conformance suite, if it is present. The point of one parameterized
//     suite is that a divergence between the two backends shows up as a failing assertion
//     rather than as a retrieval number nobody can explain. This file supplies only
//     createStore; every expectation lives in the shared suite and is written once for both.
//  2. pgvector specific tests for the parts the shared suite does not cover: the migration
//     ledger, the refusal to touch a database another tool owns, and the three v3 write
//     operations that DELETE, which are the ones a bug is expensive in.
//
// It creates and drops its OWN scratch databases and never touches the platform corpus. If
// Postgres is unreachable the tests skip with the reason named: a run that quietly passes
// on a machine with no database is dead coverage.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { createPgVectorStore } from '../src/store/pgvector.js';
import { loadCorpusByName, loadCorpusEnvironment } from '../src/init/corpus.js';
import {
  FIXTURE_DIMENSION as FIXTURE_DIMENSION_SHARED,
  FIXTURE_PROJECT as FIXTURE_PROJECT_SHARED,
  runStoreConformance,
} from '../test/store-conformance.test.js';

const { Client } = pg;

const DIMENSION = 8;
const PROJECT = 'fixture';

const vector = (weights) => {
  const row = new Array(DIMENSION).fill(0);
  for (const [index, weight] of Object.entries(weights)) row[Number(index)] = weight;
  return row;
};

// A local fixture, deliberately independent of the shared suite's, so these tests keep
// running while that file is being restructured.
const DOCUMENTS = [
  { id: 'store.adr-0040', project: PROJECT, type: 'adr', path: 'a.md', title: 'Storage', tags: ['storage'], meta: { area: 'store' }, content: 'The storage layer was redesigned.' },
  { id: 'rag.rank', project: PROJECT, type: 'card', path: 'b.md', title: 'Ranker', tags: ['rag'], meta: { area: 'rag' }, content: 'The ranker caps how much any one candidate may take.' },
  { id: 'rag.retrieve', project: PROJECT, type: 'card', path: 'c.md', title: 'Retrieval', tags: ['rag'], meta: { area: 'rag' }, content: 'fuseRankings merges the two rankings.' },
  { id: 'ops.notes', project: PROJECT, type: 'lesson', path: 'd.md', title: null, tags: [], meta: {}, content: 'Operational notes.' },
];
const CHUNKS = [
  { id: 'store.adr-0040#0', documentId: 'store.adr-0040', ordinal: 0, content: 'The storage layer was redesigned.', vector: vector({ 0: 1 }) },
  { id: 'rag.rank#0', documentId: 'rag.rank', ordinal: 0, content: 'The ranker caps how much any one candidate may take.', vector: vector({ 1: 1 }) },
  { id: 'rag.retrieve#0', documentId: 'rag.retrieve', ordinal: 0, content: 'fuseRankings merges the two rankings.', vector: vector({ 2: 1 }) },
  { id: 'ops.notes#0', documentId: 'ops.notes', ordinal: 0, content: 'Operational notes.', vector: vector({ 3: 1 }) },
];
const RELATIONSHIPS = [
  { src: 'store.adr-0040', dst: 'rag.rank', kind: 'refs' },
  { src: 'rag.retrieve', dst: 'rag.rank', kind: 'imports' },
  { src: 'store.adr-0040', dst: 'ops.notes', kind: 'supersedes' },
];

function adminUrl(databaseUrl, database) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function probe() {
  let base = process.env.DAIJIN_TEST_DATABASE_URL?.trim() || null;
  if (!base) {
    // Borrow only the SERVER the platform corpus is configured against. Every database this
    // file touches is one it created itself.
    try {
      const corpus = await loadCorpusByName('platform');
      base = loadCorpusEnvironment(corpus).databaseUrl;
    } catch (error) {
      return { ready: false, reason: `no Postgres configured (${error.message}); set DAIJIN_TEST_DATABASE_URL` };
    }
  }
  const client = new Client({ connectionString: adminUrl(base, 'postgres'), connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
    if (rows.length === 0) return { ready: false, reason: 'the pgvector extension is not available on this server' };
    return { ready: true, base };
  } catch (error) {
    return { ready: false, reason: `Postgres unreachable: ${error.message}` };
  } finally {
    await client.end().catch(() => {});
  }
}

const readiness = await probe();
const created = [];

async function createDatabase() {
  const name = `daijin_conformance_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: adminUrl(readiness.base, 'postgres') });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  created.push(name);
  return adminUrl(readiness.base, name);
}

async function freshStore() {
  const store = createPgVectorStore({
    connectionString: await createDatabase(),
    project: PROJECT,
    dimension: DIMENSION,
    embedderId: 'fixture:hand-written@v1',
    applicationName: 'daijin-conformance',
  });
  await store.init();
  return store;
}

async function seeded() {
  const store = await freshStore();
  await store.transaction(async () => {
    for (const document of DOCUMENTS) await store.upsertDocument(document);
    for (const document of DOCUMENTS) {
      await store.replaceChunks(document.id, CHUNKS.filter((chunk) => chunk.documentId === document.id));
    }
    await store.replaceAllRelationships(RELATIONSHIPS);
  });
  return store;
}

async function dropCreatedDatabases() {
  for (const name of created.splice(0)) {
    const admin = new Client({ connectionString: adminUrl(readiness.base, 'postgres') });
    try {
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } catch {
      // A scratch database that outlives the run is visible and harmless; failing over
      // cleanup would discard a result that was already paid for.
    } finally {
      await admin.end().catch(() => {});
    }
  }
}

// ---- the shared suite ---------------------------------------------------------------
//
// Imported statically, and a missing suite is a BROKEN BUILD rather than a named skip
// (leader ruling): a skip here is dead coverage waiting to happen, because the whole point
// of one parameterized suite is that a divergence between the two backends fails an
// assertion instead of surfacing later as a retrieval number nobody can explain.
// Two DIFFERENT conditions, deliberately handled differently. A missing suite FILE is a
// broken build: the static import above already guarantees that. An unreachable DATABASE
// is a named skip, because the live suite is local by design and its absence must read as
// "not run here", never as coverage.
if (readiness.ready) {
  runStoreConformance({
    label: 'pgvector',
    createStore: async () => {
      const store = createPgVectorStore({
        connectionString: await createDatabase(),
        project: FIXTURE_PROJECT_SHARED,
        dimension: FIXTURE_DIMENSION_SHARED,
        embedderId: 'fixture:hand-written@v1',
        applicationName: 'daijin-conformance',
      });
      await store.init();
      return store;
    },
  });
} else {
  test('pgvector: shared store conformance suite', { skip: readiness.reason }, () => {});
}

// ---- pgvector specific ---------------------------------------------------------------

const pgTest = (name, body) => test(name, { skip: readiness.ready ? false : readiness.reason }, body);

pgTest('pgvector: migrate refuses a database another tool owns', async () => {
  const connectionString = await createDatabase();
  // Stand up the shape the platform's database has: its own migration ledger. Running DDL
  // there would mutate the corpus the parity measurement is supposed to observe.
  const seeder = new Client({ connectionString });
  await seeder.connect();
  try {
    await seeder.query('CREATE TABLE schema_migration (version integer PRIMARY KEY, name text, checksum text)');
  } finally {
    await seeder.end();
  }
  const store = createPgVectorStore({ connectionString, project: PROJECT, dimension: DIMENSION });
  try {
    await assert.rejects(store.migrate(), /refusing to migrate it/);
  } finally {
    await store.close();
  }
});

pgTest('pgvector: init and migrate are idempotent', async () => {
  const store = await freshStore();
  try {
    await store.migrate();
    await store.migrate();
    assert.deepEqual(await store.allDocuments({}), []);
  } finally {
    await store.close();
  }
});

pgTest('pgvector: a migration whose recorded checksum no longer matches is refused', async () => {
  const connectionString = await createDatabase();
  const store = createPgVectorStore({ connectionString, project: PROJECT, dimension: DIMENSION });
  try {
    await store.migrate();
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query("UPDATE daijin_schema_migration SET checksum = 'tampered' WHERE version = 1");
    } finally {
      await client.end();
    }
    await assert.rejects(store.migrate(), /changed after it was applied/);
  } finally {
    await store.close();
  }
});

pgTest('pgvector: migrate refuses to guess the embedding dimension', async () => {
  const store = createPgVectorStore({ connectionString: await createDatabase(), project: PROJECT });
  try {
    await assert.rejects(store.migrate(), /requires the embedding dimension/);
  } finally {
    await store.close();
  }
});

pgTest('pgvector: the arms read what the write side wrote', async () => {
  const store = await seeded();
  try {
    const semantic = await store.semanticCandidates(vector({ 1: 1 }), { project: PROJECT }, 4);
    assert.equal(semantic[0].id, 'rag.rank');
    assert.ok(semantic[0].score > 0.99, 'an exact axis match is cosine 1');
    assert.equal(semantic[0].chunk_id, 'rag.rank#0');

    const lexical = await store.lexicalCandidates('fuseRankings', vector({ 2: 1 }), { project: PROJECT }, 40);
    assert.deepEqual(lexical.map((row) => row.id), ['rag.retrieve']);
    assert.ok(typeof lexical[0].score === 'number', 'a lexical hit still carries a real cosine');

    assert.deepEqual((await store.relationshipEdges(['imports'])).map((row) => `${row.src}->${row.dst}`), ['rag.retrieve->rag.rank']);
    assert.equal((await store.indexedEmbeddingIdentity()).dimension, DIMENSION);
  } finally {
    await store.close();
  }
});

pgTest('pgvector: deleteDocuments evicts the chunks and the edges with the document', async () => {
  const store = await seeded();
  try {
    assert.equal((await store.relationshipEdges(['imports'])).length, 1);
    await store.deleteDocuments(['rag.rank']);
    assert.deepEqual(await store.existingDocumentIds(['rag.rank']), []);
    assert.equal((await store.relationshipEdges(['imports'])).length, 0, 'an edge pointing at a deleted document goes too');
    const remaining = await store.semanticCandidates(vector({ 1: 1 }), { project: PROJECT }, 50);
    assert.deepEqual(remaining.filter((row) => row.id === 'rag.rank'), [], 'its chunks left the index with it');
  } finally {
    await store.close();
  }
});

pgTest('pgvector: pruneDocumentsExcept makes a rebuild authoritative rather than additive', async () => {
  const store = await seeded();
  try {
    await store.pruneDocumentsExcept(['rag.rank', 'rag.retrieve'], PROJECT);
    assert.deepEqual((await store.allDocuments({})).map((row) => row.id).sort(), ['rag.rank', 'rag.retrieve']);
    // The orphan a deleted source file would otherwise leave behind, which the gold-set
    // existence gate would keep certifying, is gone.
    assert.deepEqual(await store.existingDocumentIds(['ops.notes']), []);
  } finally {
    await store.close();
  }
});

pgTest('pgvector: replaceAllRelationships validates every kind before deleting anything', async () => {
  const store = await seeded();
  try {
    await assert.rejects(
      store.replaceAllRelationships([{ src: 'a', dst: 'b', kind: 'NOT A KIND' }]),
      /Unsupported relationship kind/,
    );
    assert.equal((await store.relationshipEdges(['imports', 'supersedes', 'refs'])).length, 3, 'the existing graph survived the refusal');
  } finally {
    await store.close();
  }
});

pgTest('pgvector: a draft unit is never a candidate on any arm', async () => {
  const store = await seeded();
  try {
    await store.transaction(async () => {
      await store.upsertDocument({
        id: 'draft.wip', project: PROJECT, type: 'adr', path: 'e.md', title: 'Draft', tags: [],
        meta: { area: 'store', draft: 'true' }, content: 'A draft about the storage layer.',
      });
      await store.replaceChunks('draft.wip', [{ id: 'draft.wip#0', ordinal: 0, content: 'A draft about the storage layer.', vector: vector({ 0: 1 }) }]);
    });
    const ids = (rows) => rows.map((row) => row.id);
    assert.ok(!ids(await store.semanticCandidates(vector({ 0: 1 }), { project: PROJECT }, 50)).includes('draft.wip'));
    assert.ok(!ids(await store.lexicalCandidates('draft storage layer', null, { project: PROJECT }, 40)).includes('draft.wip'));
    assert.ok(!ids(await store.allDocuments({ project: PROJECT })).includes('draft.wip'));
    assert.deepEqual(await store.allDocuments({ project: PROJECT, documentIds: ['draft.wip'], types: ['adr'] }), []);
  } finally {
    await store.close();
  }
});

pgTest('pgvector: scratch databases are dropped', async () => {
  await dropCreatedDatabases();
  assert.equal(created.length, 0);
});
