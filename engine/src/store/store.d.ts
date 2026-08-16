/**
 * Store interface, v3, FROZEN 2026-08-16, amended same day with the delete
 * and prune operations (verifier report 2 finding 39, D-0009). Supersedes v2
 * and absorbs engine/src/store/retrieval-store.d.ts, which is now deleted.
 * Revision record: agent/decisions.md D-0004 (v1 to v2), D-0008 (v2 to v3),
 * D-0009 (ingest semantics). Changes require the leader.
 *
 * Why v3: the extractor derived a candidate surface from the same call sites
 * independently of the leader's v2, and the two converged on the four arms but
 * differed in detail. Where they differed, the platform-faithful version wins,
 * because P1's acceptance is metric and per-case parity and renaming rows the
 * ranker reads directly is parity risk for zero benefit. Concretely from the
 * extractor's draft: the lexical arm takes the VECTOR too (cosine is selected
 * on every arm; a lexical-only hit still needs a real similarity for the
 * fusion rescale and the pin floor), candidate rows keep the platform's flat
 * field names, filters carry project and a single area, standing units take a
 * namespace prefix, and existingDocumentIds and indexedEmbeddingIdentity are
 * first-class (the gold-set existence gate and the embedding identity health
 * gate read them).
 *
 * Two implementations: pgvector (P1, ported from the platform) and
 * sqlite-vec + FTS5 (P2, the shipped default). Both must pass the same
 * conformance suite in engine/test/store-conformance.test.js.
 *
 * Implementation invariants both backends MUST enforce identically:
 * - Draft exclusion applies to every CANDIDATE query and to allDocuments: a
 *   document whose meta.draft is 'true' never appears there (retrieve.js:93).
 *   It does NOT apply to standingDocuments (the platform standing query,
 *   standing.js:33-39, has no draft and no project predicate; filtering
 *   drafts there would diverge from the platform per-case) nor to
 *   existingDocumentIds. [Narrowed 2026-08-16, verifier finding 59: v3's
 *   "any read" wording overreached.]
 * - Type default: the ['evaluation'] exclusion when the caller expresses no
 *   type opinion (DEFAULT_EXCLUDED_TYPES) is applied by the RETRIEVAL LAYER
 *   (retrieve.js:60), NOT by the store. The store honors filters exactly as
 *   given. Baking the default into the store would double-apply it and hide
 *   evaluations from brain.record_evaluation reads. [Corrected 2026-08-16,
 *   store-adapter's challenge upheld against the platform bytes, D-0013;
 *   earlier v2/v3 wording made this a store invariant, which was wrong.]
 * - excludeDocumentIds is validated to at most 1000 safe ids; it is the
 *   gold-provenance exclusion that keeps the gym honest (standing.js:26-28).
 * - project: the platform store is multi-project, daijin ships one store per
 *   repo. project: null means the whole store; the pgvector parity impl is
 *   always called with a concrete project, the sqlite impl usually with null.
 *
 * Deliberately OUT of this interface (verifier finding 53): exam persistence,
 * project registry rows, and the ingest_run ledger. The gym writes only to
 * its own store (plan line: "Gym writes only to its own store, never the
 * user's git"), so P4 defines its own ledger seam; it must not be smuggled in
 * here.
 */

export interface CandidateFilters {
  project: string | null;
  types?: string[] | null;
  area?: string | null;
  excludeTypes?: string[];
  excludeDocumentIds?: string[];  // EXCLUDE, max 1000: the gold-provenance exclusion
}

/**
 * One join row: document identity plus the winning chunk. Field names follow
 * the platform's row shape because rank.js and context.js read them directly
 * and parity forbids renaming them at P1.
 */
export interface CandidateRow {
  id: string;                 // document id
  type: string;
  path: string;
  title: string | null;
  tags: string[] | null;
  meta: Record<string, unknown> | null;  // carries area, retrieval_provenance, draft
  chunk_id: string | number;
  ordinal: number;            // -1 is the identity chunk
  chunk_content: string;      // identity chunks (ordinal -1) resolve to ordinal 0 content
  score: number;              // raw cosine similarity, 1 - distance, every arm
  lex_rank?: number;          // lexical arm only, impl-specific ranking, descending
}

export interface DocumentRow {
  id: string;
  type: string;
  path: string;
  title: string | null;
  tags: string[] | null;
  meta: Record<string, unknown> | null;
  content: string;
  /** Hash of content, written at ingest. Incremental ingest compares it to
   *  detect docs_changed and to compute the deletedIds set; without it every
   *  run is a full rebuild or a blind upsert (verifier finding 47). */
  contentHash: string | null;
}

export interface ChunkWriteRow {
  ordinal: number;            // -1 identity chunk, 0..n body chunks
  content: string;            // verbatim chunk text, type core preserved
  vector: Float32Array | number[] | null;  // null until embedded
}

export interface RelationshipEdge {
  src: string;
  dst: string;
  /** Lowercase identifier. The platform's CHECK admits six kinds (imports,
   *  depends_on, supersedes, fixes, violates, refs) while the engine names
   *  four by default; validators MUST accept any lowercase identifier and
   *  never tighten to a named subset. A tightened validator silently drops
   *  edges on mirror, and brain.impact_of gets quieter rather than louder
   *  (store-adapter finding, 2026-08-16). */
  kind: string;
}

export interface Store {
  /** Create or open schema, indexes, FTS tables. Idempotent. */
  init(): Promise<void>;

  /** Apply pending schema migrations from the checksummed ledger. Idempotent. */
  migrate(): Promise<void>;

  // Read side: the four candidate arms of retrieve.js:172-283.

  /** ANN pool. Ordered by distance ascending, i.e. cosine descending.
   *  Callers pass limit = max(k * 12, 256). */
  semanticCandidates(vector: number[], filters: CandidateFilters, limit: number): Promise<CandidateRow[]>;

  /** Full text arm. Takes the vector TOO: cosine is selected alongside the
   *  lexical rank so a lexical-only hit carries a real similarity into the
   *  fusion rescale and the pin floor. Ordered by lexical rank descending
   *  then chunk id. Callers pass limit 40. FTS5 recipe on sqlite, tsquery on
   *  pgvector. */
  lexicalCandidates(query: string, vector: number[], filters: CandidateFilters, limit: number): Promise<CandidateRow[]>;

  /** Every architecture chunk in scope, scored. Deliberately NO limit: the
   *  class is small and bounded, and it must not compete in the global ANN
   *  pool (retrieve.js:200-221). */
  architectureCandidates(vector: number[], filters: CandidateFilters): Promise<CandidateRow[]>;

  /** Units with a non-empty retrieval_provenance array, scored. NO limit
   *  (retrieve.js:243-265). */
  provenanceCandidates(vector: number[], filters: CandidateFilters): Promise<CandidateRow[]>;

  /** Whole documents with content: what the ranker budgets and returns. */
  allDocuments(filters: CandidateFilters): Promise<DocumentRow[]>;

  /** Graph edges of the given kinds (retrieve.js:272). */
  relationshipEdges(kinds: string[]): Promise<RelationshipEdge[]>;

  /** Standing units by id namespace, minus caller exclusions, ordered by type
   *  then id. Document rows; they ride outside the token budget
   *  (standing.js:32-49). */
  standingDocuments(options: { prefix?: string; excludeDocumentIds?: string[] }): Promise<DocumentRow[]>;
  // prefix defaults to 'global.' (STANDING_ID_PREFIX, standing.js:29), and the
  // default is part of the contract: an implementation that defaults to the
  // empty string matches every document, makes everything standing, and rides
  // it all OUTSIDE the token budget with no error (verifier finding 58). An
  // EXPLICIT empty-string prefix is an ERROR on both backends, never a
  // match-all (adopted from the sqlite impl, stricter than the default rule
  // and safer; the match-all failure mode is silent). No draft or project
  // predicate here, by platform fidelity (finding 59).

  /** Which of these ids exist at all, ignoring project and draft scope.
   *  The gold-set existence gate reads this. */
  existingDocumentIds(ids: string[]): Promise<string[]>;

  /** The embedding identity the index was built with (embedder id, dimension,
   *  digest), or null if never ingested. The embedding identity health gate
   *  compares this to the served embedder. */
  indexedEmbeddingIdentity(): Promise<Record<string, unknown> | null>;

  // Write side (ingest and brain.record_evaluation).

  upsertDocument(row: DocumentRow): Promise<void>;
  replaceChunks(documentId: string, rows: ChunkWriteRow[]): Promise<void>;

  /** GLOBAL relationship rebuild: delete every edge, then insert rows, inside
   *  the caller's transaction. The platform's replaceRelationships takes no
   *  source filter because the import graph is rebuilt wholesale on every
   *  ingest run (ingest/index.js); a per-source signature cannot express
   *  "remove every edge whose source no longer exists", and stale edges make
   *  brain.impact_of report dependents that are gone (verifier finding 44). */
  replaceAllRelationships(rows: RelationshipEdge[]): Promise<void>;

  /** Remove documents by id, with their chunks and relationships. This is the
   *  platform's deletedIds path: incremental ingest computes deletions from
   *  contentHash presence and evicts them inside the rebuild transaction. */
  deleteDocuments(ids: string[]): Promise<void>;
  // deleteDocuments removes relationships where the document is source OR
  // destination; for imports edges the destination case is the common one.

  /** Remove every document NOT in keepIds WITHIN the given project scope,
   *  with chunks and relationships. project is REQUIRED (null means the whole
   *  store, the per-repo sqlite case); an unscoped prune against the
   *  multi-project platform database would delete every other project's
   *  documents, which is verifier finding 55's data-loss hazard. The platform
   *  scopes its full-rebuild delete by project for exactly this reason
   *  (ingest/index.js: DELETE FROM document WHERE project = $1).
   *  Ingest model is the platform's ATOMIC FULL-MIRROR REPLACE (D-0009): a
   *  full rebuild wraps upserts plus this prune inside ONE transaction, so a
   *  rebuild is authoritative rather than additive and a deleted source file
   *  cannot leave an orphan the gold-set existence gate keeps certifying. The
   *  conformance suite must prove orphan removal is atomic AND that a prune
   *  scoped to project A leaves project B intact.
   *
   *  SAFETY POLICY (D-0012): the pgvector parity impl never points write
   *  operations at the owner's live platform database. Parity runs are
   *  read-only; write-path conformance runs against fixture databases only. */
  pruneDocumentsExcept(keepIds: string[], project: string | null): Promise<void>;

  /** Key value metadata: corpus stats and anything not covered by the typed
   *  reads above. */
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  /** Run fn atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/**
 * Gold-set case shape, unchanged from v2. Answers are artifacts, never prose.
 * provenance records the real origin (commit-archaeology | structural |
 * identifier | paraphrase:auditor).
 *
 * must_not_outrank keeps the platform's RANKING semantics (retrieval-score.js:9):
 * a violation is a listed document that beats a required one, not an exclusion.
 * violations: 0 is an ENFORCED floor (D-0005).
 *
 * Staleness (a case retires with its superseded target) is enforced by the
 * gold-set pipeline gates; a retired case keeps its record with the date and
 * reason rather than being deleted.
 */
export interface GoldCase {
  id: string;
  query: string;
  must_return: string[];        // artifact ids (file, symbol, or document id)
  must_not_outrank?: string[];  // ranking constraint, platform semantics
  identifier?: boolean;
  provenance: string;
  /** One line stating what the case exists to prove. REQUIRED by the ported
   *  scorer's validateGoldset; added 2026-08-16 after init-miner found the
   *  contract and the measured harness disagreed on paper. The harness is
   *  the measured instrument, so the contract moved to it. */
  why: string;
  retired?: { date: string; reason: string };
}
