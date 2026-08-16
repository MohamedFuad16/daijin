import assert from 'node:assert/strict';
import test from 'node:test';

import { candidateFilterSql, createPgVectorStore, RETRIEVAL_RELATIONSHIP_KINDS } from '../src/store/pgvector.js';

// A pg client double: records every statement so the SQL seam can be asserted without a
// database. The live database is exercised by the parity acceptance test instead.
function recordingClient(responses = {}) {
  const calls = [];
  return {
    calls,
    async connect() {},
    async end() {},
    async query(text, values) {
      calls.push({ text, values });
      for (const [pattern, rows] of Object.entries(responses)) {
        if (text.includes(pattern)) return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('every arm scopes to the project and refuses draft units', () => {
  const filter = candidateFilterSql({ project: 'demo' });
  assert.equal(filter.sql, "d.project = $1 AND coalesce(d.meta->>'draft', 'false') <> 'true'");
  assert.deepEqual(filter.values, ['demo']);
});

test('bind positions shift with the offset each arm reserves', () => {
  // The semantic arm binds the vector at $1, so its filters start at $2.
  const semantic = candidateFilterSql({ project: 'demo', types: ['decision'], area: 'storage' }, 2);
  assert.ok(semantic.sql.includes('d.project = $2'));
  assert.ok(semantic.sql.includes('d.type = ANY($3::text[])'));
  assert.ok(semantic.sql.includes("d.meta->>'area' = $4"));
  assert.deepEqual(semantic.values, ['demo', ['decision'], 'storage']);

  // The lexical arm binds vector and query text, so its filters start at $3.
  const lexical = candidateFilterSql({ project: 'demo', excludeTypes: ['evaluation'], excludeDocumentIds: ['x'] }, 3);
  assert.ok(lexical.sql.includes('d.project = $3'));
  assert.ok(lexical.sql.includes('d.type <> ALL($4::text[])'));
  assert.ok(lexical.sql.includes('NOT (d.id = ANY($5::text[]))'));
  assert.deepEqual(lexical.values, ['demo', ['evaluation'], ['x']]);
});

test('the semantic arm pins ef_search to the candidate limit and enables iterative scan', async () => {
  const client = recordingClient();
  const store = createPgVectorStore({ client });
  await store.semanticCandidates([1, 0], { project: 'demo' }, 256);
  const statements = client.calls.map((call) => call.text);
  assert.ok(statements.some((text) => text === 'SET hnsw.ef_search = 256'));
  assert.ok(statements.some((text) => text.includes("SET hnsw.iterative_scan = 'relaxed_order'")));
  const search = client.calls.at(-1);
  assert.ok(search.text.includes('ORDER BY c.embedding <=> $1::vector'));
  assert.ok(search.text.includes('LIMIT 256'));
  assert.equal(search.values[0], '[1,0]', 'the vector is bound as a JSON array cast to vector');

  // A second call at the same limit does not re-issue the session settings.
  const before = client.calls.length;
  await store.semanticCandidates([1, 0], { project: 'demo' }, 256);
  assert.equal(client.calls.length, before + 1);
});

test('ef_search never drops below 256 nor exceeds the pgvector maximum', async () => {
  const low = recordingClient();
  await createPgVectorStore({ client: low }).semanticCandidates([1], { project: 'demo' }, 10);
  assert.ok(low.calls.some((call) => call.text === 'SET hnsw.ef_search = 256'));

  const high = recordingClient();
  await createPgVectorStore({ client: high }).semanticCandidates([1], { project: 'demo' }, 5_000);
  assert.ok(high.calls.some((call) => call.text === 'SET hnsw.ef_search = 1000'));
});

test('the lexical arm selects cosine as well as the text rank', async () => {
  const client = recordingClient();
  await createPgVectorStore({ client }).lexicalCandidates('statusPinned', [1, 0], { project: 'demo' }, 40);
  const statement = client.calls.at(-1);
  assert.ok(statement.text.includes("websearch_to_tsquery('english', $2)"));
  assert.ok(statement.text.includes('1 - (c.embedding <=> $1::vector)'), 'a lexical-only hit still needs a real cosine for the pin floor');
  assert.ok(statement.text.includes('ORDER BY lex_rank DESC, c.id'));
  assert.ok(statement.text.includes('LIMIT 40'));
});

test('the lexical arm tolerates being called with no vector', async () => {
  const client = recordingClient();
  await createPgVectorStore({ client }).lexicalCandidates('statusPinned', null, { project: 'demo' }, 40);
  const statement = client.calls.at(-1);
  assert.equal(statement.values[0], null);
  assert.ok(statement.text.includes('CASE WHEN $1::text IS NULL THEN NULL'), 'no vector means no cosine, not a crash');
});

test('an oversized exclusion list is refused rather than sent', () => {
  const tooMany = Array.from({ length: 1_001 }, (unused, index) => `doc.${index}`);
  assert.throws(() => candidateFilterSql({ project: 'demo', excludeDocumentIds: tooMany }), /at most 1000 document ids/);
  assert.doesNotThrow(() => candidateFilterSql({ project: 'demo', excludeDocumentIds: tooMany.slice(0, 1_000) }));
});

test('a null project scopes the whole store, which is the one-store-per-repo case', () => {
  const filter = candidateFilterSql({ project: null }, 2);
  assert.equal(filter.sql, "coalesce(d.meta->>'draft', 'false') <> 'true'");
  assert.deepEqual(filter.values, []);
});

test('parity mode leaves the document inventory unordered, the shipped default orders it', async () => {
  const parity = recordingClient();
  await createPgVectorStore({ client: parity, parityMode: true }).allDocuments({ project: 'demo' });
  assert.ok(!parity.calls.at(-1).text.includes('ORDER BY'), 'the platform statement has no ORDER BY');

  const shipped = recordingClient();
  await createPgVectorStore({ client: shipped }).allDocuments({ project: 'demo' });
  assert.ok(shipped.calls.at(-1).text.includes('ORDER BY d.id'), 'two backends cannot be compared on an order neither defines');
});

test('the identity beacon resolves to real chunk content in every arm', async () => {
  const client = recordingClient();
  const store = createPgVectorStore({ client });
  await store.semanticCandidates([1], { project: 'demo' }, 256);
  await store.architectureCandidates([1], { project: 'demo' });
  await store.lexicalCandidates('q', [1], { project: 'demo' }, 40);
  await store.provenanceCandidates([1], { project: 'demo' });
  const projections = client.calls.filter((call) => call.text.includes('chunk_content'));
  assert.equal(projections.length, 4);
  for (const call of projections) assert.ok(call.text.includes('WHEN c.ordinal = -1'));
});

test('the architecture arm forces its own type filter', async () => {
  const client = recordingClient();
  await createPgVectorStore({ client }).architectureCandidates([1], { project: 'demo', types: ['decision'] });
  assert.deepEqual(client.calls.at(-1).values[1], 'demo');
  assert.deepEqual(client.calls.at(-1).values[2], ['architecture']);
});

test('the provenance arm requires a non-empty provenance array', async () => {
  const client = recordingClient();
  await createPgVectorStore({ client }).provenanceCandidates([1], { project: 'demo' });
  const statement = client.calls.at(-1).text;
  assert.ok(statement.includes("jsonb_typeof(d.meta->'retrieval_provenance') = 'array'"));
  assert.ok(statement.includes("jsonb_array_length(d.meta->'retrieval_provenance') > 0"));
});

test('relationship kinds are inlined so the plan, and therefore the row order, is stable', async () => {
  const client = recordingClient();
  await createPgVectorStore({ client }).relationshipEdges(RETRIEVAL_RELATIONSHIP_KINDS);
  assert.equal(
    client.calls.at(-1).text,
    "SELECT src, dst, kind FROM relationship WHERE kind IN ('imports', 'supersedes', 'fixes', 'refs')",
  );
  await assert.rejects(
    createPgVectorStore({ client }).relationshipEdges(["x'; DROP TABLE document; --"]),
    /Unsupported relationship kind/,
  );
  // No kinds means no edges. Falling through would emit `kind IN ()`, a syntax error.
  const empty = recordingClient();
  assert.deepEqual(await createPgVectorStore({ client: empty }).relationshipEdges([]), []);
  assert.equal(empty.calls.length, 0);
});

test('standing units are fetched by namespace, ordered, and honour exclusions', async () => {
  const client = recordingClient();
  await createPgVectorStore({ client }).standingDocuments({ excludeDocumentIds: ['global.a'] });
  const statement = client.calls.at(-1);
  assert.ok(statement.text.includes('WHERE id LIKE $1'));
  assert.ok(statement.text.includes('ORDER BY type, id'));
  assert.deepEqual(statement.values, ['global.%', ['global.a']]);
});

test('a nested transaction joins the outer one through a savepoint', async () => {
  const client = recordingClient();
  const store = createPgVectorStore({ client });
  await store.transaction(async () => {
    await store.transaction(async () => {});
  });
  assert.deepEqual(client.calls.map((call) => call.text), [
    'BEGIN', 'SAVEPOINT daijin_sp_1', 'RELEASE SAVEPOINT daijin_sp_1', 'COMMIT',
  ]);
});

test('a failed transaction rolls back and rethrows', async () => {
  const client = recordingClient();
  const store = createPgVectorStore({ client });
  await assert.rejects(store.transaction(async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(client.calls.map((call) => call.text), ['BEGIN', 'ROLLBACK']);
  // The depth counter must reset, or every later write silently runs outside a transaction.
  await store.transaction(async () => {});
  assert.deepEqual(client.calls.map((call) => call.text).slice(2), ['BEGIN', 'COMMIT']);
});

test('replaceChunks preserves the identity beacon ordinal and writes in one transaction', async () => {
  const client = recordingClient({ 'SELECT 1 FROM document': [{ '?column?': 1 }] });
  const store = createPgVectorStore({ client, project: 'demo', dimension: 2 });
  await store.replaceChunks('doc', [
    { ordinal: 0, content: 'first', vector: [1, 0] },
    { ordinal: -1, content: 'beacon', vector: [0, 1] },
  ]);
  const statements = client.calls.map((call) => call.text);
  assert.equal(statements[0], 'BEGIN');
  assert.equal(statements.at(-1), 'COMMIT');
  assert.ok(statements.some((text) => text.startsWith('DELETE FROM chunk')), 'a wholesale replace cannot leave a stale window behind');
  const inserts = client.calls.filter((call) => call.text.includes('INSERT INTO chunk'));
  assert.deepEqual(inserts.map((call) => call.values[2]), [0, -1], 'the beacon ordinal must round trip');
  assert.deepEqual(inserts.map((call) => call.values[0]), ['doc#0', 'doc#-1'], 'chunk ids are store assigned');
});

test('replaceChunks never infers an ordinal or a content field, and validates before deleting', async () => {
  const client = recordingClient({ 'SELECT 1 FROM document': [{ '?column?': 1 }] });
  const store = createPgVectorStore({ client, project: 'demo', dimension: 2 });
  // An ordinal guessed from an array index would put the identity beacon, which must never
  // be read, where a chunk that must be read belongs.
  await assert.rejects(store.replaceChunks('doc', [{ content: 'no ordinal', vector: null }]), /requires an integer ordinal/);
  await assert.rejects(store.replaceChunks('doc', [{ ordinal: 0, text: 'the old field name', vector: null }]), /requires content as a string/);
  assert.equal(client.calls.length, 0, 'a rejected write must not have deleted the existing chunks first');
});

test('replaceChunks refuses a chunk for a document nobody declared', async () => {
  const client = recordingClient();
  const store = createPgVectorStore({ client, project: 'demo', dimension: 2 });
  await assert.rejects(
    store.replaceChunks('never.declared', [{ ordinal: 0, content: 'orphan chunk', vector: null }]),
    /document never\.declared does not exist/,
  );
  assert.ok(!client.calls.some((call) => call.text.startsWith('DELETE FROM chunk')), 'and it deleted nothing on the way out');
});

test('replaceRelationships validates kinds BEFORE it deletes anything', async () => {
  const client = recordingClient();
  const store = createPgVectorStore({ client });
  await assert.rejects(store.replaceRelationships('a', [{ dst: 'b', kind: 'NOT A KIND' }]), /Unsupported relationship kind/);
  assert.equal(client.calls.length, 0, 'an invalid kind must not delete the existing edges on its way to failing');
});

test('migrate refuses a database another tool owns, and refuses to guess the dimension', async () => {
  const foreign = recordingClient({ 'to_regclass': [{ foreign_ledger: true, own_ledger: false }] });
  await assert.rejects(
    createPgVectorStore({ client: foreign, dimension: 4 }).migrate(),
    /refusing to migrate it/,
  );
  await assert.rejects(createPgVectorStore({ client: recordingClient() }).migrate(), /requires the embedding dimension/);
});

test('meta round trips as a JSON string', async () => {
  const client = recordingClient({ 'SELECT value FROM system_meta': [{ value: { indexed: true, dimension: 4 } }] });
  const store = createPgVectorStore({ client });
  assert.equal(await store.getMeta('embedding_index'), '{"indexed":true,"dimension":4}');
  assert.deepEqual(await store.indexedEmbeddingIdentity(), { indexed: true, dimension: 4 });
  await store.setMeta('k', { a: 1 });
  assert.deepEqual(client.calls.at(-1).values, ['k', '{"a":1}']);
});

test('a store with neither a client nor a connection string refuses to guess', async () => {
  await assert.rejects(createPgVectorStore({}).allDocuments({ project: 'demo' }), /connectionString or an injected client/);
});
