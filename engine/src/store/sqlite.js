// SQLite Store: the shipped default backend (P2), against Store v3.
//
// One index file per repo, in the daijin state root and keyed by the repo's manifest id
// (D-0031: the index is a disposable derivation and does not belong in the working tree).
// Vectors in sqlite-vec, lexical text in FTS5
// under the measured recipe (adapters/sqlite/fts5.js), and a meta table carrying the
// index digest and the embedder identity the health gate asserts against the served
// embedder. Every method here is store.d.ts v3; nothing from the superseded v1 CRUD
// surface survives, so no caller can reach a shape the pgvector twin does not have.
//
// Design notes worth keeping:
//
// - Type and area live on the DOCUMENT, exactly as on pgvector. Chunks carry ordinal and
//   content only, and the store assigns their ids as `${documentId}#${ordinal}`, which is
//   unique because (document_id, ordinal) is.
// - Filters are applied by joining the document table, never by vec0 metadata columns.
//   vec0 metadata rejects NULL, area is nullable, and its constraint support varies by
//   sqlite-vec version. The semantic arm over-fetches and widens k instead, which keeps
//   filtered results exact and identical to the Postgres arm.
// - The unlimited arms (architecture, provenance) score with the vec_distance_cosine
//   scalar over a join rather than with KNN, because vec0's MATCH requires a k and those
//   two arms deliberately have none: their classes are small and bounded.
// - score is raw cosine on EVERY arm, the lexical one included. bm25 is negative and
//   lower is better, so if it ever leaked into score a lexical-only hit would invert
//   silently through the fusion rescale. bm25 orders the lexical arm and is reported
//   separately as lex_rank, sign flipped to descending.
// - The index digest covers chunk ids, chunk content hashes, whether each chunk carries a
//   vector, and the embedder identity. A scrambled index, a dropped embedding or a
//   swapped embedder all move it, which is what lets the identity gate fail.
// - better-sqlite3 is synchronous. The contract is async, so every method returns a
//   promise over synchronous work. transaction() holds a real BEGIN across awaits, so the
//   store is single connection and expects one writer flow at a time.

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  openDatabase,
  engineVersions,
} from '../../../adapters/sqlite/database.js';
import {
  LEXICAL_TOP_K,
  bm25Expression,
  buildMatchExpression,
  createFtsTableSql,
  lexicalScore,
} from '../../../adapters/sqlite/fts5.js';
import {
  assertDimension,
  createVecTableSql,
  decodeEmbedding,
  toFloat32,
} from '../../../adapters/sqlite/vec.js';
import { STANDING_ID_PREFIX } from '../rag/standing.js';
import { indexPathFor } from '../state/layout.js';

const DOCUMENTS = 'document';
const CHUNKS = 'chunks';
const CHUNKS_FTS = 'chunks_fts';
const CHUNK_VECTORS = 'chunk_vectors';
const RELATIONSHIPS = 'relationship';
const MIGRATIONS_TABLE = 'schema_migration';

/** Relationship vocabulary, matching pgvector.js and the platform schema's CHECK. */
export const RELATIONSHIP_KINDS = ['imports', 'supersedes', 'fixes', 'refs'];

/** One SQLite file is one repo, so the project scope defaults rather than being required. */
export const DEFAULT_PROJECT = 'default';

/** The gold-provenance exclusion is capped, the same bound retrieve.js validates against. */
export const MAX_EXCLUDED_DOCUMENT_IDS = 1_000;

/** Meta keys the rest of the engine reads. */
export const META_KEYS = {
  embedderId: 'embedder.id',
  dimension: 'embedder.dimension',
  indexDigest: 'index.digest',
  chunkCount: 'index.chunk_count',
  embeddingIndex: 'embedding_index',
};

/**
 * Schema migrations, applied in order and recorded with a checksum.
 *
 * The ledger is not decoration: a migration edited after it shipped would otherwise apply
 * to new brains and silently skip existing ones, leaving two schemas with one version
 * number. Editing an applied migration is refused loudly instead. Append new entries;
 * never edit an existing one.
 *
 * The vec0 table is deliberately NOT here: its dimension is only known once an embedder
 * is chosen, so it is created lazily and guarded by the embedding identity assert.
 */
export const MIGRATIONS = [
  {
    id: '001-base',
    sql: `
      CREATE TABLE IF NOT EXISTS ${DOCUMENTS} (
        id           TEXT PRIMARY KEY,
        project      TEXT,
        type         TEXT NOT NULL,
        path         TEXT,
        title        TEXT,
        tags         TEXT NOT NULL DEFAULT '[]',
        meta         TEXT NOT NULL DEFAULT '{}',
        content      TEXT NOT NULL DEFAULT '',
        content_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS document_project ON ${DOCUMENTS}(project);
      CREATE INDEX IF NOT EXISTS document_type ON ${DOCUMENTS}(type);

      CREATE TABLE IF NOT EXISTS ${CHUNKS} (
        id           TEXT PRIMARY KEY,
        document_id  TEXT NOT NULL REFERENCES ${DOCUMENTS}(id) ON DELETE CASCADE,
        ordinal      INTEGER NOT NULL,
        content      TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        has_vector   INTEGER NOT NULL DEFAULT 0,
        UNIQUE (document_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS chunks_document_id ON ${CHUNKS}(document_id);

      CREATE TABLE IF NOT EXISTS ${RELATIONSHIPS} (
        src  TEXT NOT NULL,
        dst  TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (src, dst, kind)
      );
      CREATE INDEX IF NOT EXISTS relationship_dst ON ${RELATIONSHIPS}(dst);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      ${createFtsTableSql(CHUNKS_FTS)};
    `,
  },
];

function placeholders(count) {
  return new Array(count).fill('?').join(', ');
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Chunk ids are the store's to assign. Unique because (document_id, ordinal) is. */
export function chunkIdFor(documentId, ordinal) {
  return `${documentId}#${ordinal}`;
}

// A draft unit is never a candidate and never appears in allDocuments. json_extract
// returns 1 for a JSON boolean true and the string 'true' for a quoted one, so both
// encodings are covered; the Postgres arm's ->> operator only ever sees the text form.
const draftExclusion = (alias) => `coalesce(json_extract(${alias}.meta, '$.draft'), 'false') NOT IN (1, 'true')`;

/**
 * The WHERE clause the arms and allDocuments share.
 *
 * Two rules are not caller opinion, which is why this is one function rather than an
 * inline string per call site: a draft unit is never retrievable here, and the project
 * scope is applied whenever the caller names one. project null means the whole store,
 * which is the per-repo sqlite case.
 *
 * There is deliberately NO type default here. The ['evaluation'] exclusion belongs to the
 * retrieval layer (retrieve.js:60, DEFAULT_EXCLUDED_TYPES), and the store honors filters
 * exactly as given: baking it in would double-apply it and hide evaluations from
 * brain.record_evaluation reads (D-0013, correcting the earlier v2/v3 wording).
 */
export function candidateFilterSql(filters = {}, alias = 'd') {
  const {
    project = null, types, area, excludeTypes = [], excludeDocumentIds = [],
  } = filters;
  const clauses = [draftExclusion(alias)];
  const params = [];

  if (project !== null && project !== undefined) {
    clauses.push(`${alias}.project = ?`);
    params.push(project);
  }
  if (types?.length) {
    clauses.push(`${alias}.type IN (${placeholders(types.length)})`);
    params.push(...types);
  }
  if (area !== null && area !== undefined) {
    clauses.push(`json_extract(${alias}.meta, '$.area') = ?`);
    params.push(area);
  }

  if (excludeTypes.length > 0) {
    clauses.push(`${alias}.type NOT IN (${placeholders(excludeTypes.length)})`);
    params.push(...excludeTypes);
  }
  if (excludeDocumentIds.length > 0) {
    assertExclusionBound(excludeDocumentIds);
    clauses.push(`${alias}.id NOT IN (${placeholders(excludeDocumentIds.length)})`);
    params.push(...excludeDocumentIds);
  }
  return { sql: clauses.join(' AND '), params };
}

function assertExclusionBound(ids) {
  if (ids.length > MAX_EXCLUDED_DOCUMENT_IDS) {
    throw new Error(`excludeDocumentIds must contain at most ${MAX_EXCLUDED_DOCUMENT_IDS} document ids.`);
  }
}

function assertRelationshipKind(kind) {
  if (!RELATIONSHIP_KINDS.includes(kind) && !/^[a-z_]+$/.test(kind ?? '')) {
    throw new Error(`Unsupported relationship kind: ${kind}`);
  }
}

// The identity chunk (ordinal -1) is a ranking beacon and must never reach an engineer's
// context, so the projection substitutes the document's first real chunk for it. Keeping
// the substitution here leaves chunk.js free of retrieval concerns.
const CANDIDATE_PROJECTION = `d.id AS id, d.type AS type, d.path AS path, d.title AS title,
       d.tags AS tags, d.meta AS meta, c.id AS chunk_id, c.ordinal AS ordinal,
       CASE WHEN c.ordinal = -1
            THEN (SELECT c0.content FROM ${CHUNKS} AS c0
                   WHERE c0.document_id = c.document_id AND c0.ordinal = 0)
            ELSE c.content END AS chunk_content`;

function mapCandidate(row) {
  const candidate = {
    id: row.id,
    type: row.type,
    path: row.path,
    title: row.title,
    tags: parseJson(row.tags, []),
    meta: parseJson(row.meta, {}),
    chunk_id: row.chunk_id,
    ordinal: row.ordinal,
    chunk_content: row.chunk_content,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
  };
  if (row.lex_rank !== undefined) candidate.lex_rank = Number(row.lex_rank);
  return candidate;
}

function mapDocument(row) {
  return {
    id: row.id,
    type: row.type,
    path: row.path,
    title: row.title,
    tags: parseJson(row.tags, []),
    meta: parseJson(row.meta, {}),
    content: row.content,
    contentHash: row.content_hash ?? null,
  };
}

/**
 * ChunkWriteRow is strictly { ordinal, content, vector }. The lenient reading that also
 * accepted `text` and `meta.ordinal` is gone on purpose: two accepted spellings of the
 * same field is how one backend silently ordinals a corpus differently from the other,
 * and ordinal -1 is a ranking beacon that must not be inferred from an array index.
 */
function normalizeChunkWrite(row, index, documentId) {
  if (!Number.isInteger(row?.ordinal)) {
    throw new Error(`Chunk ${index} of ${documentId} requires an integer ordinal; -1 is the identity chunk.`);
  }
  if (typeof row.content !== 'string') {
    throw new Error(`Chunk ${row.ordinal} of ${documentId} requires content as a string.`);
  }
  return {
    id: chunkIdFor(documentId, row.ordinal),
    documentId,
    ordinal: row.ordinal,
    content: row.content,
    vector: row.vector ?? null,
  };
}

export class SqliteStore {
  #database = null;
  #path;
  #repoPath;
  #stateRoot;
  #project;
  #dimension;
  #embedder;
  #embedderId;
  #standingPrefix;
  #transactionDepth = 0;
  #vectorTableReady = false;
  #digestDirty = false;

  /**
   * @param {object} options
   * @param {string} [options.path]        Database file. Defaults to the repo's brain file.
   * @param {string} [options.repoPath]    Repo root, used when path is omitted.
   * @param {string|null} [options.project] Project written on documents this store creates.
   * @param {number} [options.dimension]   Embedding width. Inferred from the first vector when omitted.
   * @param {object} [options.embedder]    Served embedder { provider, model, digest, dimension }.
   *                                       Retrieval's identity assert compares against this, so a
   *                                       store meant to serve retrieval passes it.
   * @param {string} [options.embedderId]  Flat identity, when the structured one is unavailable.
   */
  constructor({
    path, repoPath, stateRoot, project = DEFAULT_PROJECT, dimension, embedder, embedderId,
    standingPrefix = STANDING_ID_PREFIX,
  } = {}) {
    if (!path && !repoPath) throw new Error('SqliteStore requires a path, or a repoPath with a stateRoot.');
    // A repoPath alone used to be enough, because the index lived inside the repo. Under
    // D-0031 it does not, and the dangerous version of this constructor is one that
    // quietly rebuilds the old in-repo location when a caller forgets the state root:
    // nothing fails, and the daemon and the store end up looking at different files.
    // layout.js refuses the same way and for the same reason.
    if (!path && !stateRoot) {
      throw new Error(
        'SqliteStore requires a stateRoot alongside repoPath; the index no longer lives in the repo (D-0031). '
        + 'Pass an explicit path, or a stateRoot so the manifest id can resolve it.',
      );
    }
    const width = dimension ?? embedder?.dimension ?? null;
    if (width !== null) assertDimension(width);
    // Resolved in init(), because resolving means reading the repo's manifest and this
    // constructor is not async. Until then the store knows only what it was told.
    this.#path = path ?? null;
    this.#repoPath = repoPath ?? null;
    this.#stateRoot = stateRoot ?? null;
    this.#project = project;
    this.#dimension = width;
    this.#embedder = embedder ? { ...embedder, dimension: width } : null;
    this.#embedderId = embedderId ?? (embedder ? embedderIdOf(embedder) : null);
    this.#standingPrefix = assertStandingPrefix(standingPrefix);
  }

  get path() {
    return this.#path;
  }

  get project() {
    return this.#project;
  }

  get dimension() {
    return this.#dimension;
  }

  #db() {
    if (!this.#database) throw new Error('Store is not initialized; call init() first.');
    return this.#database;
  }

  // ---- lifecycle -----------------------------------------------------------------

  async init() {
    if (this.#database) return;
    // THE resolver, called rather than reimplemented: one derivation of the repo key, so a
    // repo reached by a different spelling, a symlink, or a moved checkout still finds the
    // index the daemon built.
    if (!this.#path) this.#path = await indexPathFor(this.#repoPath, { stateRoot: this.#stateRoot });
    const database = openDatabase(this.#path, { Database, sqliteVec });
    this.#database = database;
    // EVERY FAILURE AFTER THE OPEN CLOSES THE HANDLE. The migration ledger and the two
    // identity asserts below all throw AFTER the database is open, and createSqliteStore
    // discards the half-built instance on a throw - with `#database` private, nothing can
    // ever close it again. Measured at 8 file handles (db, -wal, -shm) left behind by three
    // failed inits, and the trigger is ordinary: a user who changes their Ollama embedding
    // model gets the identity assert on every attempt, and the daemon is long-lived, so
    // each retry from the TUI burns more until EMFILE. Two call sites in methods.js open the
    // store OUTSIDE the try whose finally would have closed it, so the leak is reachable.
    try {
      this.#initOpened();
    } catch (error) {
      // Closed and forgotten, so a later init() on the same instance re-opens cleanly
      // rather than short-circuiting on a handle that is already gone.
      try { database.close(); } catch { /* a close failure must not mask the real error */ }
      this.#database = null;
      throw error;
    }
  }

  /// Everything init() does once the handle is open, so init() can own the close-on-throw.
  #initOpened() {
    this.#applyMigrations();

    const storedDimension = this.#readMeta(META_KEYS.dimension);
    const storedEmbedder = this.#readMeta(META_KEYS.embedderId);

    // Identity assert at open time: a brain built with one embedder must not be extended
    // by another, because the vectors would then share an index and not a space.
    if (storedDimension !== null && this.#dimension !== null && Number(storedDimension) !== this.#dimension) {
      throw new Error(
        `Index dimension ${storedDimension} does not match the configured dimension ${this.#dimension}; `
        + 'rebuild the index or point at the matching embedder.',
      );
    }
    if (storedEmbedder !== null && this.#embedderId !== null && storedEmbedder !== this.#embedderId) {
      throw new Error(
        `Index was built by embedder ${storedEmbedder} but the configured embedder is ${this.#embedderId}; `
        + 'rebuild the index or point at the matching embedder.',
      );
    }

    if (storedDimension !== null) this.#dimension = Number(storedDimension);
    else if (this.#dimension !== null) this.#writeMeta(META_KEYS.dimension, String(this.#dimension));
    if (storedEmbedder === null && this.#embedderId !== null) {
      this.#writeMeta(META_KEYS.embedderId, this.#embedderId);
    } else if (storedEmbedder !== null) {
      this.#embedderId = storedEmbedder;
    }
    // The structured identity is what retrieval's assert compares field by field; the
    // flat embedder id above is what the digest binds to and what a human reads.
    if (this.#embedder) {
      this.#writeMeta(META_KEYS.embeddingIndex, JSON.stringify({
        provider: this.#embedder.provider ?? null,
        model: this.#embedder.model ?? null,
        digest: this.#embedder.digest ?? null,
        dimension: this.#dimension,
      }));
    }

    if (this.#dimension !== null) this.#ensureVectorTable(this.#dimension);
    this.#refreshDigest();
  }

  /**
   * Apply pending migrations from the checksummed ledger. Idempotent.
   * A migration whose recorded checksum no longer matches its definition is refused:
   * that is an edited migration, which would leave older brains on a schema no version
   * number distinguishes from the current one.
   */
  async migrate() {
    if (!this.#database) {
      await this.init();
      return;
    }
    this.#applyMigrations();
  }

  #applyMigrations() {
    const database = this.#db();
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id         TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = database.prepare(`SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE id = ?`);
    const record = database.prepare(
      `INSERT INTO ${MIGRATIONS_TABLE}(id, checksum, applied_at) VALUES (?, ?, datetime('now'))`,
    );
    for (const migration of MIGRATIONS) {
      const checksum = sha256(migration.sql);
      const row = applied.get(migration.id);
      if (row) {
        if (row.checksum !== checksum) {
          throw new Error(
            `Migration ${migration.id} was already applied with checksum ${row.checksum} but now hashes to `
            + `${checksum}; an applied migration must not be edited.`,
          );
        }
        continue;
      }
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(migration.sql);
        record.run(migration.id, checksum);
        database.exec('COMMIT');
      } catch (error) {
        if (database.inTransaction) database.exec('ROLLBACK');
        throw error;
      }
    }
  }

  #ensureVectorTable(dimension) {
    assertDimension(dimension);
    if (this.#dimension === null) {
      this.#dimension = dimension;
      this.#writeMeta(META_KEYS.dimension, String(dimension));
    } else if (this.#dimension !== dimension) {
      throw new Error(`Vector dimension ${dimension} does not match the index dimension ${this.#dimension}.`);
    }
    if (!this.#vectorTableReady) {
      this.#db().exec(createVecTableSql(CHUNK_VECTORS, dimension));
      this.#vectorTableReady = true;
    }
  }

  #hasVectorTable() {
    if (this.#vectorTableReady) return true;
    const row = this.#db()
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(CHUNK_VECTORS);
    this.#vectorTableReady = Boolean(row);
    return this.#vectorTableReady;
  }

  #readMeta(key) {
    const row = this.#db().prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  #writeMeta(key, value) {
    this.#db()
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  /**
   * Mark the digest stale. Recomputing it eagerly on every write would make a bulk
   * ingest quadratic, because ingest writes one document at a time and each write would
   * rescan the whole chunk table. It is recomputed on the next read of it, and again at
   * init, so a process that dies mid ingest cannot leave a stale value behind.
   */
  #markDigestStale() {
    this.#digestDirty = true;
  }

  #ensureDigest() {
    if (this.#digestDirty) this.#refreshDigest();
  }

  #refreshDigest() {
    const hash = createHash('sha256');
    hash.update(`embedder:${this.#embedderId ?? ''}\n`);
    hash.update(`dimension:${this.#dimension ?? ''}\n`);
    let count = 0;
    const statement = this.#db().prepare(`SELECT id, content_hash, has_vector FROM ${CHUNKS} ORDER BY id`);
    for (const row of statement.iterate()) {
      hash.update(`${row.id} ${row.content_hash} ${row.has_vector}\n`);
      count += 1;
    }
    this.#writeMeta(META_KEYS.indexDigest, hash.digest('hex'));
    this.#writeMeta(META_KEYS.chunkCount, String(count));
    this.#digestDirty = false;
  }

  // ---- read side: the four candidate arms -----------------------------------------

  /** ANN pool. Ordered by distance ascending, which is cosine descending.
   *
   *  NULL distances are excluded in the SQL: vec0 returns distance NULL for a stored
   *  zero-magnitude vector under cosine (undefined there), and NULLs sort FIRST under
   *  ASC - measured: a zero vector outranked an exact match at the top of the pool and
   *  consumed one of the k slots, evicting a real neighbour. The exclusion starves the
   *  pool by that slot, and the over-fetch loop below already widens k until the limit
   *  fills, so the evicted neighbour comes back on the next round.
   *
   *  The unary + before v.distance is load-bearing: without it SQLite flattens the
   *  predicate into the vec0 virtual-table query, which only accepts GT/GE/LT/LE on its
   *  distance column and throws "Illegal WHERE constraint". The + disqualifies the
   *  expression from constraint pushdown, so the filter runs OUTSIDE the KNN. */
  async semanticCandidates(vector, filters = {}, limit = 10) {
    const requested = Math.max(0, Number(limit) || 0);
    if (requested === 0 || !this.#hasVectorTable()) return [];
    const query = toFloat32(vector, this.#dimension ?? undefined);
    const database = this.#db();
    const total = database.prepare(`SELECT count(*) AS count FROM ${CHUNK_VECTORS}`).get().count;
    if (total === 0) return [];

    const filter = candidateFilterSql(filters, 'd');
    const statement = database.prepare(`
      SELECT ${CANDIDATE_PROJECTION}, 1 - v.distance AS score
        FROM (SELECT chunk_id, distance FROM ${CHUNK_VECTORS} WHERE embedding MATCH ? AND k = ?) AS v
        JOIN ${CHUNKS} AS c ON c.id = v.chunk_id
        JOIN ${DOCUMENTS} AS d ON d.id = c.document_id
       WHERE ${filter.sql}
         AND +v.distance IS NOT NULL
       ORDER BY v.distance ASC, c.id ASC
       LIMIT ?
    `);

    // Over-fetch and widen until the limit is filled or the whole index has been scanned.
    // Without it a filtered query silently returns fewer rows than asked for while
    // matching rows exist, which is the failure mode that starves the ANN pool.
    let k = Math.min(total, Math.max(requested * 4, requested + 16));
    let rows = [];
    for (;;) {
      rows = statement.all(query, k, ...filter.params, requested);
      if (rows.length >= requested || k >= total) break;
      k = Math.min(total, k * 2);
    }
    return rows.map(mapCandidate);
  }

  /**
   * Full text arm. Ordered by lexical rank descending then chunk id, limit 40.
   * score is raw cosine here too, so a lexical-only hit carries a real similarity into
   * the fusion rescale and the pin floor. bm25 never reaches score: it is negative and
   * lower is better, so it would invert the fusion silently.
   */
  async lexicalCandidates(query, vector, filters = {}, limit = LEXICAL_TOP_K) {
    const requested = Math.max(0, Number(limit) || 0);
    if (requested === 0) return [];
    const match = buildMatchExpression(query);
    if (match === null) return [];

    const filter = candidateFilterSql(filters, 'd');
    const rank = bm25Expression(CHUNKS_FTS);
    // THE LEFT JOIN CAN YIELD A NULL EMBEDDING, and vec_distance_cosine treats NULL as an
    // input error rather than as NULL: an FTS hit on a chunk with has_vector = 0 aborted the
    // whole query with "Error reading 1st vector ... found NULL", killing retrieve() rather
    // than one arm. A mixed store is not exotic - ab-sqlite-pgvector's mirrorCorpus counts
    // `embedded` separately precisely because it writes vectorless chunks - and it is the
    // corpus the two backends are compared over. The pgvector twin returns NULL for the same
    // row (`c.embedding <=> $1` is NULL-propagating), and a null score is already the
    // contract downstream: fusion falls back to rank alone. The CASE restores that parity.
    const scored = vector != null && this.#hasVectorTable();
    const queryVector = scored ? toFloat32(vector, this.#dimension ?? undefined) : null;

    const rows = this.#db().prepare(`
      SELECT ${CANDIDATE_PROJECTION},
             ${scored ? 'CASE WHEN v.embedding IS NULL THEN NULL ELSE 1 - vec_distance_cosine(v.embedding, ?) END' : 'NULL'} AS score,
             ${rank} AS bm25_rank
        FROM ${CHUNKS_FTS}
        JOIN ${CHUNKS} AS c ON c.id = ${CHUNKS_FTS}.chunk_id
        JOIN ${DOCUMENTS} AS d ON d.id = c.document_id
        ${scored ? `LEFT JOIN ${CHUNK_VECTORS} AS v ON v.chunk_id = c.id` : ''}
       WHERE ${CHUNKS_FTS} MATCH ? AND ${filter.sql}
       ORDER BY ${rank} ASC, c.id ASC
       LIMIT ?
    `).all(...(scored ? [queryVector] : []), match, ...filter.params, requested);

    return rows.map((row) => mapCandidate({ ...row, lex_rank: lexicalScore(row.bm25_rank) }));
  }

  /** Every architecture chunk in scope, scored. No limit: the class is small and bounded. */
  async architectureCandidates(vector, filters = {}) {
    return this.#scoredScan(vector, { ...filters, types: ['architecture'] }, '');
  }

  /** Units carrying a non-empty retrieval_provenance array, scored, no limit. */
  async provenanceCandidates(vector, filters = {}) {
    return this.#scoredScan(vector, filters, `
      AND json_type(d.meta, '$.retrieval_provenance') = 'array'
      AND json_array_length(d.meta, '$.retrieval_provenance') > 0
    `);
  }

  #scoredScan(vector, filters, extraSql) {
    if (!this.#hasVectorTable()) return [];
    const query = toFloat32(vector, this.#dimension ?? undefined);
    const filter = candidateFilterSql(filters, 'd');
    // vec0's MATCH needs a k and these arms deliberately have none, so the scalar
    // distance function scans the bounded class instead.
    const rows = this.#db().prepare(`
      SELECT ${CANDIDATE_PROJECTION}, 1 - vec_distance_cosine(v.embedding, ?) AS score
        FROM ${CHUNKS} AS c
        JOIN ${DOCUMENTS} AS d ON d.id = c.document_id
        JOIN ${CHUNK_VECTORS} AS v ON v.chunk_id = c.id
       WHERE ${filter.sql}${extraSql}
       ORDER BY score DESC, c.id ASC
    `).all(query, ...filter.params);
    return rows.map(mapCandidate);
  }

  /**
   * Whole documents with content. No type default here on purpose: the ranker resolves
   * supersession chains and lesson links through units it will never fund, so it needs
   * the whole inventory (retrieve.js:92-100).
   */
  async allDocuments(filters = {}) {
    const filter = candidateFilterSql(filters, 'd');
    return this.#db().prepare(`
      SELECT d.id, d.type, d.path, d.title, d.tags, d.meta, d.content, d.content_hash
        FROM ${DOCUMENTS} AS d
       WHERE ${filter.sql}
       ORDER BY d.id
    `).all(...filter.params).map(mapDocument);
  }

  /**
   * Graph edges of the given kinds. No ORDER BY, matching pgvector: the ranker's
   * supersession walk consumes edges in arrival order, and rowid order is insertion order.
   */
  async relationshipEdges(kinds = RELATIONSHIP_KINDS) {
    const list = Array.from(kinds ?? []);
    for (const kind of list) assertRelationshipKind(kind);
    if (list.length === 0) return [];
    return this.#db().prepare(
      `SELECT src, dst, kind FROM ${RELATIONSHIPS} WHERE kind IN (${placeholders(list.length)})`,
    ).all(...list);
  }

  /**
   * Standing units by id namespace, ordered by type then id.
   * No draft and no project predicate, by platform fidelity (standing.js:33-39).
   */
  async standingDocuments({ prefix = this.#standingPrefix, excludeDocumentIds = [] } = {}) {
    const namespace = assertStandingPrefix(prefix);
    assertExclusionBound(excludeDocumentIds);
    const exclusion = excludeDocumentIds.length > 0
      ? ` AND id NOT IN (${placeholders(excludeDocumentIds.length)})`
      : '';
    return this.#db().prepare(`
      SELECT id, type, path, title, tags, meta, content, content_hash
        FROM ${DOCUMENTS}
       WHERE id LIKE ? ESCAPE '\\'${exclusion}
       ORDER BY type, id
    `).all(`${namespace.replace(/[%_\\]/g, '\\$&')}%`, ...excludeDocumentIds).map(mapDocument);
  }

  /**
   * Which of these ids exist at all, ignoring project and draft scope. The gold-set
   * existence gate reads this: a case pointing at a renamed document must fail loudly
   * rather than count as a quiet miss and make retrieval look worse than it is.
   */
  async existingDocumentIds(ids) {
    const list = Array.from(ids ?? []);
    if (list.length === 0) return [];
    const found = [];
    const batchSize = 400;
    for (let offset = 0; offset < list.length; offset += batchSize) {
      const batch = list.slice(offset, offset + batchSize);
      const rows = this.#db().prepare(
        `SELECT id FROM ${DOCUMENTS} WHERE id IN (${placeholders(batch.length)})`,
      ).all(...batch);
      found.push(...rows.map((row) => row.id));
    }
    return found;
  }

  /**
   * The embedding identity the index was built with, or null when nothing is indexed.
   * The shape is the one runtime/embedding-identity.js asserts on. An index built
   * without a structured embedder still answers, with nulls, so the assert refuses it
   * loudly instead of the store claiming an identity it never recorded.
   */
  async indexedEmbeddingIdentity() {
    this.#ensureDigest();
    const chunkCount = Number(this.#readMeta(META_KEYS.chunkCount) ?? 0);
    if (chunkCount === 0) return null;
    const stored = parseJson(this.#readMeta(META_KEYS.embeddingIndex), null);
    return {
      indexed: true,
      provider: stored?.provider ?? null,
      model: stored?.model ?? null,
      digest: stored?.digest ?? null,
      dimension: stored?.dimension ?? this.#dimension,
      embedderId: this.#readMeta(META_KEYS.embedderId),
      indexDigest: this.#readMeta(META_KEYS.indexDigest),
    };
  }

  // ---- write side ------------------------------------------------------------------

  async upsertDocument(row) {
    if (!row?.id) throw new Error('Document row requires an id.');
    if (!row.type) throw new Error(`Document ${row.id} requires a type.`);
    // DocumentRow.content is non-optional in v3. Coercing a missing one to '' would hash
    // the empty string as though it were real content and feed a garbage contentHash into
    // the incremental-ingest diff, which decides docs_changed and deletedIds.
    if (typeof row.content !== 'string') {
      throw new Error(`Document ${row.id} requires content as a string; v3 does not default it.`);
    }
    const { content } = row;
    this.#db().prepare(`
      INSERT INTO ${DOCUMENTS}(id, project, type, path, title, tags, meta, content, content_hash)
      VALUES (@id, @project, @type, @path, @title, @tags, @meta, @content, @contentHash)
      ON CONFLICT(id) DO UPDATE SET
        project      = excluded.project,
        type         = excluded.type,
        path         = excluded.path,
        title        = excluded.title,
        tags         = excluded.tags,
        meta         = excluded.meta,
        content      = excluded.content,
        content_hash = excluded.content_hash
    `).run({
      id: row.id,
      project: row.project === undefined ? this.#project : row.project,
      type: row.type,
      path: row.path ?? null,
      title: row.title ?? null,
      tags: JSON.stringify(row.tags ?? []),
      meta: JSON.stringify(row.meta ?? {}),
      content,
      // Written at ingest so incremental runs can compute docs_changed and deletedIds
      // without rehashing the corpus; defaulted here so no caller can forget it.
      contentHash: row.contentHash ?? sha256(content),
    });
  }

  /** Replace a document's chunks wholesale. The old rows leave every index with them. */
  async replaceChunks(documentId, rows) {
    if (!documentId) throw new Error('replaceChunks requires a documentId.');
    const normalized = Array.from(rows ?? []).map((row, index) => normalizeChunkWrite(row, index, documentId));
    await this.transaction(async () => {
      // The document must already exist: v3 has upsertDocument, so inventing a stub here
      // would let an ingest write chunks for a document whose type, area and path nothing
      // ever recorded, and every filter would then miss them.
      const owner = this.#db().prepare(`SELECT id FROM ${DOCUMENTS} WHERE id = ?`).get(documentId);
      if (!owner) throw new Error(`replaceChunks: document ${documentId} does not exist; upsertDocument first.`);
      this.#deleteChunkRows(this.#chunkIdsOfDocuments([documentId]));
      this.#db().prepare(`DELETE FROM ${CHUNKS} WHERE document_id = ?`).run(documentId);
      this.#writeChunks(normalized);
      this.#markDigestStale();
    });
  }

  #writeChunks(rows) {
    if (rows.length === 0) return;
    const database = this.#db();
    const firstVector = rows.find((row) => row.vector != null)?.vector;
    if (firstVector) this.#ensureVectorTable(toFloat32(firstVector).length);

    const insert = database.prepare(`
      INSERT INTO ${CHUNKS}(id, document_id, ordinal, content, content_hash, has_vector)
      VALUES (@id, @documentId, @ordinal, @content, @contentHash, @hasVector)
      ON CONFLICT(id) DO UPDATE SET
        document_id  = excluded.document_id,
        ordinal      = excluded.ordinal,
        content      = excluded.content,
        content_hash = excluded.content_hash,
        has_vector   = excluded.has_vector
    `);
    const insertFts = database.prepare(`INSERT INTO ${CHUNKS_FTS}(chunk_id, text) VALUES (?, ?)`);
    const hasVectors = this.#hasVectorTable();
    const insertVector = hasVectors
      ? database.prepare(`INSERT INTO ${CHUNK_VECTORS}(chunk_id, embedding) VALUES (?, ?)`)
      : null;

    for (const row of rows) {
      insert.run({
        id: row.id,
        documentId: row.documentId,
        ordinal: row.ordinal,
        content: row.content,
        contentHash: sha256(row.content),
        hasVector: row.vector != null ? 1 : 0,
      });
      insertFts.run(row.id, row.content);
      if (row.vector != null && insertVector) insertVector.run(row.id, toFloat32(row.vector, this.#dimension));
    }
  }

  #chunkIdsOfDocuments(documentIds) {
    if (documentIds.length === 0) return [];
    const found = [];
    const batchSize = 400;
    for (let offset = 0; offset < documentIds.length; offset += batchSize) {
      const batch = documentIds.slice(offset, offset + batchSize);
      const rows = this.#db().prepare(
        `SELECT id FROM ${CHUNKS} WHERE document_id IN (${placeholders(batch.length)})`,
      ).all(...batch);
      found.push(...rows.map((row) => row.id));
    }
    return found;
  }

  /** Remove chunk ids from the two satellite indexes. The chunk rows themselves follow. */
  #deleteChunkRows(chunkIds) {
    if (chunkIds.length === 0) return;
    const database = this.#db();
    const deleteFts = database.prepare(`DELETE FROM ${CHUNKS_FTS} WHERE chunk_id = ?`);
    const deleteVector = this.#hasVectorTable()
      ? database.prepare(`DELETE FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`)
      : null;
    for (const id of chunkIds) {
      deleteFts.run(id);
      if (deleteVector) deleteVector.run(id);
    }
  }

  /**
   * GLOBAL relationship rebuild: every edge goes, then the given rows land, inside the
   * caller's transaction. A per-source signature cannot express "remove every edge whose
   * source no longer exists", and stale edges make brain.impact_of report dependents that
   * are gone.
   */
  async replaceAllRelationships(rows) {
    const list = Array.from(rows ?? []);
    for (const row of list) {
      assertRelationshipKind(row.kind);
      if (!row.src || !row.dst) throw new Error('A relationship edge requires src and dst.');
    }
    await this.transaction(async () => {
      const database = this.#db();
      database.prepare(`DELETE FROM ${RELATIONSHIPS}`).run();
      const insert = database.prepare(
        `INSERT OR IGNORE INTO ${RELATIONSHIPS}(src, dst, kind) VALUES (?, ?, ?)`,
      );
      for (const row of list) insert.run(row.src, row.dst, row.kind);
    });
  }

  /**
   * Remove documents by id, with their chunks and their relationships.
   * Edges go where the document is source OR destination; for imports edges the
   * destination case is the common one, and leaving those behind is what makes
   * brain.impact_of point at files that no longer exist.
   */
  async deleteDocuments(ids) {
    const list = [...new Set(Array.from(ids ?? []))];
    if (list.length === 0) return;
    await this.transaction(async () => {
      const database = this.#db();
      this.#deleteChunkRows(this.#chunkIdsOfDocuments(list));
      const batchSize = 400;
      for (let offset = 0; offset < list.length; offset += batchSize) {
        const batch = list.slice(offset, offset + batchSize);
        const marks = placeholders(batch.length);
        database.prepare(`DELETE FROM ${CHUNKS} WHERE document_id IN (${marks})`).run(...batch);
        database.prepare(
          `DELETE FROM ${RELATIONSHIPS} WHERE src IN (${marks}) OR dst IN (${marks})`,
        ).run(...batch, ...batch);
        database.prepare(`DELETE FROM ${DOCUMENTS} WHERE id IN (${marks})`).run(...batch);
      }
      this.#markDigestStale();
    });
  }

  /**
   * Remove every document NOT in keepIds within the given project scope.
   * project is required: an unscoped prune against a multi-project database would delete
   * every other project's documents. null means the whole store, which is the per-repo
   * sqlite case.
   *
   * A full rebuild wraps its upserts and this prune in ONE transaction, so a rebuild is
   * authoritative rather than additive and a deleted source file cannot leave an orphan
   * the gold-set existence gate keeps certifying.
   */
  async pruneDocumentsExcept(keepIds, project) {
    if (project === undefined) {
      throw new Error('pruneDocumentsExcept requires a project scope; pass null for the whole store.');
    }
    const keep = [...new Set(Array.from(keepIds ?? []))];
    await this.transaction(async () => {
      const database = this.#db();
      // A temp table rather than an IN list: a real corpus can carry more keep ids than
      // SQLite allows bound parameters, and a silent truncation here deletes documents.
      database.exec('CREATE TEMP TABLE IF NOT EXISTS prune_keep (id TEXT PRIMARY KEY)');
      database.prepare('DELETE FROM prune_keep').run();
      const insertKeep = database.prepare('INSERT OR IGNORE INTO prune_keep(id) VALUES (?)');
      for (const id of keep) insertKeep.run(id);

      const scope = project === null ? '' : ' AND project = ?';
      const params = project === null ? [] : [project];
      const doomed = database.prepare(
        `SELECT id FROM ${DOCUMENTS} WHERE id NOT IN (SELECT id FROM prune_keep)${scope}`,
      ).all(...params).map((row) => row.id);
      database.prepare('DELETE FROM prune_keep').run();
      if (doomed.length > 0) await this.deleteDocuments(doomed);
    });
  }

  // ---- metadata and transactions ----------------------------------------------------

  async getMeta(key) {
    if (key === META_KEYS.indexDigest || key === META_KEYS.chunkCount) this.#ensureDigest();
    return this.#readMeta(key);
  }

  async setMeta(key, value) {
    this.#writeMeta(key, typeof value === 'string' ? value : JSON.stringify(value));
  }

  async transaction(fn) {
    const database = this.#db();
    // Nested calls join the outer transaction through a savepoint, so an inner failure
    // does not silently abandon the outer one.
    if (this.#transactionDepth > 0) {
      const name = `daijin_sp_${this.#transactionDepth}`;
      this.#transactionDepth += 1;
      database.exec(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        database.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        database.exec(`RELEASE SAVEPOINT ${name}`);
        throw error;
      } finally {
        this.#transactionDepth -= 1;
      }
    }
    database.exec('BEGIN IMMEDIATE');
    this.#transactionDepth = 1;
    try {
      const result = await fn();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (database.inTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      this.#transactionDepth = 0;
    }
  }

  async close() {
    if (!this.#database) return;
    if (this.#digestDirty && !this.#database.inTransaction) this.#refreshDigest();
    this.#database.close();
    this.#database = null;
    this.#vectorTableReady = false;
  }

  // ---- additive helpers, outside the contract ---------------------------------------

  /** What the health gate compares against the served embedder. */
  async identity() {
    this.#ensureDigest();
    const dimension = this.#readMeta(META_KEYS.dimension);
    return {
      embedderId: this.#readMeta(META_KEYS.embedderId),
      dimension: dimension === null ? null : Number(dimension),
      indexDigest: this.#readMeta(META_KEYS.indexDigest),
      chunkCount: Number(this.#readMeta(META_KEYS.chunkCount) ?? 0),
      migrations: this.#db().prepare(`SELECT id, checksum FROM ${MIGRATIONS_TABLE} ORDER BY id`).all(),
      engine: engineVersions(this.#db()),
    };
  }

  /** Read stored vectors back, for verification and for the gym. */
  async chunkVectors(ids) {
    const found = new Map();
    const list = Array.from(ids ?? []);
    if (list.length === 0 || !this.#hasVectorTable()) return found;
    const batchSize = 400;
    for (let offset = 0; offset < list.length; offset += batchSize) {
      const batch = list.slice(offset, offset + batchSize);
      const rows = this.#db().prepare(
        `SELECT chunk_id, embedding FROM ${CHUNK_VECTORS} WHERE chunk_id IN (${placeholders(batch.length)})`,
      ).all(...batch);
      for (const row of rows) found.set(row.chunk_id, decodeEmbedding(row.embedding));
    }
    return found;
  }
}

/**
 * The standing namespace must be a real prefix. An empty one matches every document,
 * makes everything standing, and rides the whole corpus outside the token budget with no
 * error at all, so it is refused rather than defaulted.
 */
function assertStandingPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new Error('standingDocuments requires a non empty namespace prefix; the contract default is "global.".');
  }
  return prefix;
}

/** Flat identity string, the form the digest binds to and a human reads. */
export function embedderIdOf({ provider, model, digest } = {}) {
  const head = provider ? `${provider}:${model ?? ''}` : String(model ?? '');
  return digest ? `${head}@${digest}` : head;
}

/** Open and initialize a store in one call. */
export async function createSqliteStore(options) {
  const store = new SqliteStore(options);
  await store.init();
  return store;
}

export { STANDING_ID_PREFIX };
