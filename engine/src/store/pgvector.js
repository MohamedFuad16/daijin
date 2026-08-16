// Postgres + pgvector Store. The P1 backend: it is the one the platform's committed floor
// was measured on (caseRate 0.9117647058823529, 31 of 34, violations 0), so it is the
// control the SQLite adapter (P2) is judged against. New engine code carries the exact
// rational, never the rounded display.
//
// It implements store.d.ts v3: the four candidate arms, the CRUD wrappers, and the write
// side. The SQL for the read arms is the platform's, unchanged in meaning, because P1's
// acceptance is per case parity with that engine. The extraction report enumerates exactly
// what pgvector features are in play (section 3b) and the surface is narrow: cosine
// distance with `<=>`, one HNSW index, one generated tsvector column with
// websearch_to_tsquery, jsonb extraction, text[] filters. No halfvec, no IVFFlat, no
// advisory locks.
//
// TWO SCHEMAS, ONE READER. The read arms run unchanged against the platform's database
// (which this engine never writes to) and against a database Daijin migrated itself. That
// works because the column names are the same; the differences (chunk.id is a bigserial
// there and a caller supplied text id here, system_meta.value is jsonb there and text
// here) are absorbed at the two places they surface. `migrate()` refuses outright to touch
// a database another tool owns.
import { createHash } from 'node:crypto';

import pg from 'pg';

import { STANDING_ID_PREFIX } from '../rag/standing.js';

const { Client } = pg;

export const RELATIONSHIP_KINDS = ['imports', 'depends_on', 'supersedes', 'fixes', 'violates', 'refs'];
export const RETRIEVAL_RELATIONSHIP_KINDS = ['imports', 'supersedes', 'fixes', 'refs'];
const LEDGER_TABLE = 'daijin_schema_migration';

/// The WHERE clause every arm shares.
///
/// Two rules are not optional and are the reason this is one function rather than an
/// inline string per arm: a draft unit is never retrievable, and the project scope is
/// always applied when one is given.
///
/// `offset` is the first bind position available to the filters; the arms that bind a
/// query vector at $1 pass 2, and the lexical arm, which also binds the query text at $2,
/// passes 3.
export function candidateFilterSql({
  project, types, area, documentIds, excludeDocumentIds = [], excludeTypes = [],
} = {}, offset = 1) {
  const values = [];
  const clauses = ["coalesce(d.meta->>'draft', 'false') <> 'true'"];
  const bind = (value) => {
    values.push(value);
    return `$${offset + values.length - 1}`;
  };
  if (project !== null && project !== undefined) clauses.unshift(`d.project = ${bind(project)}`);
  if (types?.length) clauses.push(`d.type = ANY(${bind(types)}::text[])`);
  if (area) clauses.push(`d.meta->>'area' = ${bind(area)}`);
  if (excludeTypes.length > 0) clauses.push(`d.type <> ALL(${bind(excludeTypes)}::text[])`);
  if (documentIds?.length) clauses.push(`d.id = ANY(${bind(documentIds)}::text[])`);
  if (excludeDocumentIds.length > 0) {
    // The gold-provenance exclusion. Capped because it is caller supplied and a query with
    // an unbounded id list is a denial of service dressed as a filter.
    if (excludeDocumentIds.length > 1_000) throw new Error('excludeDocumentIds accepts at most 1000 document ids.');
    clauses.push(`NOT (d.id = ANY(${bind(excludeDocumentIds)}::text[]))`);
  }
  return { values, sql: clauses.join(' AND ') };
}

// The identity chunk (ordinal -1) is a ranking beacon and must never reach an engineer's
// context, so the query substitutes the document's first real chunk for it. Doing the
// substitution here, in the projection, is what keeps chunk.js free of retrieval concerns.
const CANDIDATE_PROJECTION = `d.id, d.type, d.path, d.title, d.tags, d.meta,
            c.id AS chunk_id, c.ordinal,
            CASE WHEN c.ordinal = -1
                 THEN (SELECT c0.content FROM chunk AS c0 WHERE c0.document = c.document AND c0.ordinal = 0)
                 ELSE c.content END AS chunk_content`;

/// Daijin's own schema, applied by `migrate()`. Versioned and checksummed like the
/// platform's ledger: a migration whose text changed after it was applied is a silent
/// divergence between what the database has and what the code believes.
function migrations(dimension) {
  return [
    {
      version: 1,
      name: 'initial-schema',
      sql: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS document (
  id text PRIMARY KEY,
  project text,
  type text NOT NULL,
  path text NOT NULL,
  title text,
  tags text[],
  meta jsonb,
  content text NOT NULL,
  content_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunk (
  id text PRIMARY KEY,
  document text NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  content text NOT NULL,
  embedding vector(${dimension}),
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (document, ordinal)
);

CREATE INDEX IF NOT EXISTS chunk_embedding_idx ON chunk USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
CREATE INDEX IF NOT EXISTS chunk_content_tsv_idx ON chunk USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS chunk_document_idx ON chunk (document);

CREATE TABLE IF NOT EXISTS relationship (
  src text NOT NULL,
  dst text NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (src, dst, kind),
  CHECK (kind IN ('imports', 'depends_on', 'supersedes', 'fixes', 'violates', 'refs'))
);

CREATE TABLE IF NOT EXISTS system_meta (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`,
    },
  ];
}

function checksum(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function createPgVectorStore({
  connectionString,
  client: injectedClient = null,
  project = null,
  dimension = null,
  embedderId = null,
  applicationName = 'daijin-engine',
  statementTimeoutMs = 30_000,
  queryTimeoutMs = 60_000,
  // Emit the platform's statements byte for byte, including where they leave row order to
  // the planner. Used only by the extraction parity fixture; see allDocuments for the one
  // place the two modes differ and for the measurement that sizes the difference.
  parityMode = false,
} = {}) {
  let client = injectedClient;
  const ownsClient = !injectedClient;
  let connected = Boolean(injectedClient);
  let transactionDepth = 0;
  let vectorSessionLimit = null;

  async function connect() {
    if (connected) return client;
    if (!connectionString?.trim()) throw new Error('A connectionString or an injected client is required.');
    client = new Client({
      connectionString,
      application_name: applicationName,
      connectionTimeoutMillis: 5_000,
      query_timeout: queryTimeoutMs,
      statement_timeout: statementTimeoutMs,
    });
    await client.connect();
    connected = true;
    return client;
  }

  async function query(text, values) {
    await connect();
    return client.query(text, values);
  }

  // HNSW query time settings, set even when today's planner seq-scans a small corpus: the
  // day the table is big enough for the index to win, the ef_search default of 40 would
  // silently cap the ANN stream below the candidate limit, and the join filters (project,
  // draft, type) prune AFTER the scan, starving the pool further. ef_search is pinned to
  // the candidate limit (clamped to pgvector's 1000 maximum) and iterative scan lets a
  // filtered scan keep walking the graph instead of returning short.
  //
  // Session scoped SET on a dedicated or injected client; the values are computed integers.
  async function prepareVectorSession(limit) {
    if (vectorSessionLimit === limit) return;
    const efSearch = Math.min(1_000, Math.max(limit, 256));
    await query(`SET hnsw.ef_search = ${efSearch}`);
    await query("SET hnsw.iterative_scan = 'relaxed_order'");
    vectorSessionLimit = limit;
  }

  function assertKind(kind) {
    if (!RELATIONSHIP_KINDS.includes(kind)) throw new Error(`Unsupported relationship kind: ${kind}`);
    return kind;
  }

  const vectorLiteral = (vector) => (vector ? JSON.stringify(Array.from(vector)) : null);

  function asChunkRow(row) {
    return {
      id: String(row.chunk_id),
      documentId: row.id,
      type: row.type,
      area: row.meta?.area ?? null,
      text: row.chunk_content,
      vector: null,
      meta: { ...(row.meta || {}), ordinal: row.ordinal, path: row.path, title: row.title },
      score: Number(row.score),
    };
  }

  /// Record which embedder built this index, so retrieval can refuse to serve an index
  /// built by a different one. Written on the first chunk write rather than at migrate
  /// time: an empty schema has no index identity to report, and the conformance suite
  /// asserts exactly that distinction.
  async function recordEmbeddingIdentity() {
    if (!dimension) return;
    const existing = await store.indexedEmbeddingIdentity();
    if (existing) return;
    await store.setMeta('embedding_index', JSON.stringify({
      indexed: true, dimension, embedder: embedderId, provider: null, model: null, digest: null,
    }));
  }

  const store = {
    // ---- schema ---------------------------------------------------------------

    /** Open the store and bring the schema up to date. Idempotent. */
    async init() {
      await store.migrate();
    },

    /// Apply pending migrations from the checksummed ledger.
    ///
    /// Refuses a database another tool owns. The platform's database carries its own
    /// `schema_migration` ledger and this engine reads it for parity measurement; running
    /// DDL there would mutate the corpus the measurement is supposed to observe.
    async migrate() {
      if (!dimension) throw new Error('migrate requires the embedding dimension the index will be built at.');
      const foreign = await query(
        `SELECT to_regclass('schema_migration') IS NOT NULL AS foreign_ledger,
                to_regclass('${LEDGER_TABLE}') IS NOT NULL AS own_ledger`,
      );
      if (foreign.rows[0].foreign_ledger && !foreign.rows[0].own_ledger) {
        throw new Error('This database carries another tool\'s schema_migration ledger; refusing to migrate it.');
      }
      await query(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      return store.transaction(async () => {
        for (const migration of migrations(dimension)) {
          const digest = checksum(migration.sql);
          const applied = await query(`SELECT name, checksum FROM ${LEDGER_TABLE} WHERE version = $1`, [migration.version]);
          if (applied.rowCount > 0) {
            if (applied.rows[0].checksum !== digest) {
              throw new Error(`Migration ${migration.version} (${migration.name}) changed after it was applied.`);
            }
            continue;
          }
          await query(migration.sql);
          await query(`INSERT INTO ${LEDGER_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
            [migration.version, migration.name, digest]);
        }
      });
    },

    // ---- the four candidate arms ----------------------------------------------

    async semanticCandidates(vector, filters, limit) {
      await prepareVectorSession(limit);
      const filter = candidateFilterSql(filters, 2);
      const { rows } = await query(
        `SELECT ${CANDIDATE_PROJECTION},
                1 - (c.embedding <=> $1::vector) AS score
           FROM chunk AS c
           JOIN document AS d ON d.id = c.document
          WHERE ${filter.sql}
          ORDER BY c.embedding <=> $1::vector
          LIMIT ${Number(limit)}`,
        [vectorLiteral(vector), ...filter.values],
      );
      return rows;
    },

    /// Architecture can be pulled structurally from an inferred area, but the pinning
    /// guard still requires its own semantic score. Scoring that small, bounded document
    /// class explicitly beats widening the global ANN pool and destabilizing unrelated
    /// result order, which is why this arm has no limit.
    async architectureCandidates(vector, filters) {
      const filter = candidateFilterSql({ ...filters, types: ['architecture'] }, 2);
      const { rows } = await query(
        `SELECT ${CANDIDATE_PROJECTION},
                1 - (c.embedding <=> $1::vector) AS score
           FROM chunk AS c
           JOIN document AS d ON d.id = c.document
          WHERE ${filter.sql}
          ORDER BY c.embedding <=> $1::vector`,
        [vectorLiteral(vector), ...filter.values],
      );
      return rows;
    },

    /// Vector search misses exact tokens. Measured on the platform gold set, only 2 of 5
    /// identifier queries reached their document without this arm. Cosine is selected here
    /// too, so a lexical only hit still carries a real similarity for the fusion rescale
    /// and the pin floor; with no vector supplied the score is null and fusion falls back
    /// to rank alone.
    async lexicalCandidates(queryText, vector, filters, limit) {
      const filter = candidateFilterSql(filters, 3);
      const { rows } = await query(
        `SELECT ${CANDIDATE_PROJECTION},
                CASE WHEN $1::text IS NULL THEN NULL ELSE 1 - (c.embedding <=> $1::vector) END AS score,
                ts_rank(c.content_tsv, query) AS lex_rank
           FROM websearch_to_tsquery('english', $2) AS query,
                chunk AS c
           JOIN document AS d ON d.id = c.document
          WHERE ${filter.sql}
            AND c.content_tsv @@ query
          ORDER BY lex_rank DESC, c.id
          LIMIT ${Number(limit)}`,
        [vectorLiteral(vector), queryText, ...filter.values],
      );
      return rows;
    },

    async provenanceCandidates(vector, filters) {
      const filter = candidateFilterSql(filters, 2);
      const { rows } = await query(
        `SELECT ${CANDIDATE_PROJECTION},
                1 - (c.embedding <=> $1::vector) AS score
           FROM chunk AS c
           JOIN document AS d ON d.id = c.document
          WHERE ${filter.sql}
            AND jsonb_typeof(d.meta->'retrieval_provenance') = 'array'
            AND jsonb_array_length(d.meta->'retrieval_provenance') > 0
          ORDER BY c.embedding <=> $1::vector`,
        [vectorLiteral(vector), ...filter.values],
      );
      return rows;
    },

    // ---- inventory and graph ---------------------------------------------------

    /// The document inventory. Ordered by id EXCEPT in parity mode, and the difference is
    /// a measured finding rather than a style choice.
    ///
    /// The platform's statement has no ORDER BY, so its row order is whatever the planner
    /// returns. That would not matter if the ranker were order independent, but it is not:
    /// `strongestArea` takes the top entry of the inferred-area tally sorted by score
    /// descending, and Array.prototype.sort is stable, so an area TIE is broken by document
    /// arrival order. The platform floor therefore rests, on three of its 34 gold cases,
    /// on an unspecified row order.
    ///
    /// Measured on the platform corpus, k=8, 34 cases:
    ///   unordered (parity mode)  case rate 0.9117647058823529, MRR 0.6588935574229692
    ///   ORDER BY d.id            case rate 0.9117647058823529, MRR 0.6637955182072829
    /// The ENFORCED floor (case rate, violations) is identical either way; only MRR, which
    /// is deliberately never floored, moves, and it moves up. Three cases change their
    /// inferred area and their retrieved set.
    ///
    /// So Daijin ships the defined order, because two backends cannot be compared on an
    /// order neither of them defines, and the parity fixture opts into the platform's exact
    /// statement to prove the extraction changed nothing on its own.
    async allDocuments(filters) {
      const filter = candidateFilterSql(filters, 1);
      const { rows } = await query(
        `SELECT d.id, d.type, d.path, d.title, d.tags, d.meta, d.content, d.content_hash AS "contentHash"
           FROM document AS d
          WHERE ${filter.sql}${parityMode ? '' : '\n          ORDER BY d.id'}`,
        filter.values,
      );
      return rows;
    },

    /// Kinds are inlined as literals rather than bound as an array, and the reason is
    /// parity rather than style: this query has no ORDER BY, so its row order is the
    /// planner's, and the ranker is order sensitive (the supersession walk and the lesson
    /// link walk both consume edges in arrival order). Emitting the platform's exact
    /// statement keeps the plan, and therefore the order, identical. Each kind is validated
    /// against the schema's CHECK vocabulary before it reaches the string.
    async relationshipEdges(kinds = RETRIEVAL_RELATIONSHIP_KINDS) {
      // No kinds means no edges. Falling through would emit `kind IN ()`, which is a syntax
      // error rather than an empty result.
      if (!kinds?.length) return [];
      const list = kinds.map((kind) => `'${assertKind(kind)}'`).join(', ');
      const { rows } = await query(`SELECT src, dst, kind FROM relationship WHERE kind IN (${list})`);
      return rows;
    },

    /// An EXPLICIT empty-string prefix is an ERROR, never a match-all: `LIKE '%'` would
    /// make every document standing, and standing units ride OUTSIDE the token budget, so
    /// the whole corpus would be pinned into every prompt with nothing reporting it. The
    /// default when unspecified stays 'global.'.
    async standingDocuments({ prefix = STANDING_ID_PREFIX, excludeDocumentIds = [] } = {}) {
      if (prefix === '') throw new Error('standingDocuments refuses an empty prefix; it would make every document standing.');
      const { rows } = await query(
        `SELECT id, type, path, title, tags, meta, content, content_hash AS "contentHash"
           FROM document
          WHERE id LIKE $1
            AND NOT (id = ANY($2::text[]))
          ORDER BY type, id`,
        [`${prefix}%`, excludeDocumentIds],
      );
      return rows;
    },

    /// Which of these document ids exist at all, ignoring project and draft scope. The gold
    /// set existence gate needs this: a case that references a renamed document must fail
    /// loudly rather than quietly count as a miss and make retrieval look worse than it is.
    async existingDocumentIds(ids) {
      const { rows } = await query('SELECT id FROM document WHERE id = ANY($1::text[])', [ids]);
      return rows.map((row) => row.id);
    },

    async indexedEmbeddingIdentity() {
      const { rows } = await query("SELECT value FROM system_meta WHERE key = 'embedding_index'");
      const value = rows[0]?.value;
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },

    // ---- write side -------------------------------------------------------------

    /// Upsert one document. contentHash is COMPUTED when the caller does not supply one:
    /// incremental ingest compares it to detect what changed and to derive the deletion
    /// set, so a null hash turns every run into a full rebuild or a blind upsert.
    async upsertDocument(row) {
      if (typeof row?.content !== 'string') throw new Error(`upsertDocument requires content as a string for ${row?.id}.`);
      const content = row.content;
      await query(
        `INSERT INTO document (id, project, type, path, title, tags, meta, content, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (id) DO UPDATE
           SET project = EXCLUDED.project, type = EXCLUDED.type, path = EXCLUDED.path,
               title = EXCLUDED.title, tags = EXCLUDED.tags, meta = EXCLUDED.meta,
               content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
               updated_at = now()`,
        [
          row.id, row.project ?? project, row.type, row.path, row.title ?? null, row.tags ?? [],
          JSON.stringify(row.meta ?? {}), content, row.contentHash ?? checksum(content),
        ],
      );
    },

    /// Wholesale replace for one document's chunks. Delete then insert, inside the caller's
    /// transaction, so a rebuild cannot leave a stale window behind.
    ///
    /// Strict, and validated BEFORE the delete. ChunkWriteRow is { ordinal, content, vector }
    /// and none of it is inferred: an ordinal guessed from an array index would put the
    /// identity beacon (-1), which must never be read, where a chunk that must be read
    /// belongs. A chunk for a document nobody declared is an error rather than an invented
    /// stub whose type, area and path nothing ever recorded. Chunk ids are store assigned.
    async replaceChunks(documentId, rows) {
      for (const row of rows) {
        if (!Number.isInteger(row?.ordinal)) throw new Error(`replaceChunks requires an integer ordinal on every row for ${documentId}.`);
        if (typeof row.content !== 'string') throw new Error(`replaceChunks requires content as a string on every row for ${documentId}.`);
      }
      return store.transaction(async () => {
        const owner = await query('SELECT 1 FROM document WHERE id = $1', [documentId]);
        if (owner.rowCount === 0) throw new Error(`replaceChunks: document ${documentId} does not exist.`);
        await query('DELETE FROM chunk WHERE document = $1', [documentId]);
        for (const row of rows) {
          await query(
            'INSERT INTO chunk (id, document, ordinal, content, embedding) VALUES ($1, $2, $3, $4, $5::vector)',
            [`${documentId}#${row.ordinal}`, documentId, row.ordinal, row.content, vectorLiteral(row.vector)],
          );
        }
        await recordEmbeddingIdentity();
      });
    },

    /// Replace every edge whose source is `src`. Kinds are validated first: an invalid kind
    /// must not delete the existing edges on its way to failing.
    async replaceRelationships(src, rows) {
      for (const row of rows) assertKind(row.kind);
      return store.transaction(async () => {
        await query('DELETE FROM relationship WHERE src = $1', [src]);
        for (const row of rows) {
          await query(
            'INSERT INTO relationship (src, dst, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [row.src ?? src, row.dst, row.kind],
          );
        }
      });
    },

    /// GLOBAL relationship rebuild. A per source signature cannot express "remove every
    /// edge whose source no longer exists", and stale edges make impact analysis report
    /// dependents that are gone.
    async replaceAllRelationships(rows) {
      for (const row of rows) assertKind(row.kind);
      return store.transaction(async () => {
        await query('DELETE FROM relationship');
        for (const row of rows) {
          await query(
            'INSERT INTO relationship (src, dst, kind) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [row.src, row.dst, row.kind],
          );
        }
      });
    },

    async deleteDocuments(ids) {
      if (!ids?.length) return;
      return store.transaction(async () => {
        await query('DELETE FROM relationship WHERE src = ANY($1::text[]) OR dst = ANY($1::text[])', [ids]);
        await query('DELETE FROM document WHERE id = ANY($1::text[])', [ids]);
      });
    },

    /// Remove every document NOT in keepIds, WITHIN the given project scope. The ingest
    /// model is an atomic full mirror replace: a rebuild wraps upserts plus this prune
    /// inside ONE transaction, so a rebuild is authoritative rather than additive and a
    /// deleted source file cannot leave an orphan the gold set existence gate keeps
    /// certifying.
    ///
    /// The scope is a REQUIRED argument with no default, because the two sensible values
    /// differ by everything: `null` means the whole store (the one store per repo case)
    /// and a project id means that project only. Defaulting either way turns a rebuild of
    /// one project into a wipe of its neighbours, so silence is refused rather than guessed.
    async pruneDocumentsExcept(keepIds, projectScope) {
      if (projectScope === undefined) throw new Error('pruneDocumentsExcept requires a project scope (an id, or null for the whole store).');
      return store.transaction(async () => {
        const clauses = ['NOT (id = ANY($1::text[]))'];
        const values = [keepIds ?? []];
        if (projectScope !== null) {
          values.push(projectScope);
          clauses.push(`project = $${values.length}`);
        }
        const { rows } = await query(`SELECT id FROM document WHERE ${clauses.join(' AND ')}`, values);
        await store.deleteDocuments(rows.map((row) => row.id));
      });
    },

    /// Key value metadata. Values are stored and returned as text: the platform's column is
    /// jsonb and `indexedEmbeddingIdentity` absorbs that difference in one place rather than
    /// making every caller guess which schema it is talking to.
    async getMeta(key) {
      const { rows } = await query('SELECT value FROM system_meta WHERE key = $1', [key]);
      if (rows.length === 0) return null;
      const value = rows[0].value;
      return typeof value === 'string' ? value : JSON.stringify(value);
    },

    async setMeta(key, value) {
      await query(
        `INSERT INTO system_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, typeof value === 'string' ? value : JSON.stringify(value)],
      );
    },

    /// Nested calls join the outer transaction, via a savepoint so an inner failure does
    /// not silently abandon the outer one.
    async transaction(fn) {
      await connect();
      if (transactionDepth > 0) {
        const name = `daijin_sp_${transactionDepth}`;
        transactionDepth += 1;
        await query(`SAVEPOINT ${name}`);
        try {
          const result = await fn();
          await query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await query(`ROLLBACK TO SAVEPOINT ${name}`);
          throw error;
        } finally {
          transactionDepth -= 1;
        }
      }
      transactionDepth = 1;
      await query('BEGIN');
      try {
        const result = await fn();
        await query('COMMIT');
        return result;
      } catch (error) {
        await query('ROLLBACK');
        throw error;
      } finally {
        transactionDepth = 0;
      }
    },

    async close() {
      if (connected && ownsClient) await client.end();
      connected = Boolean(injectedClient);
    },
  };

  return store;
}
