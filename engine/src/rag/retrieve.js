// The retrieval path. Ported from the platform's rag/retrieve.js with one structural
// change: the Postgres client is gone and a Store takes its place, so fusion, ranking,
// budgeting and context formatting sit above a seam that either backend can serve.
// Nothing else moved. The defaults below are the measured configuration and changing
// any of them moves the floor.
import { embedTexts, resolveServedIdentity } from './embed.js';
import { fuseRankings } from './fuse.js';
import { PLATFORM_PATH_GRAMMAR, reverseImpact } from './paths.js';
import { rankRetrieval } from './rank.js';
import { asStandingUnits, STANDING_ID_PREFIX } from './standing.js';
import { ALLOWED_TYPE_SET, DEFAULT_EXCLUDED_TYPES } from './types.js';
import { assertRetrievalIdentity, embeddingIdentity } from '../runtime/embedding-identity.js';
import { nullLogger } from '../runtime/logger.js';

const LEXICAL_CANDIDATE_LIMIT = 40;
const RELATIONSHIP_KINDS = ['imports', 'supersedes', 'fixes', 'refs'];

/// The ANN pool is deliberately far wider than k: the ranker's structural passes
/// (supersession resolution, lesson links, reserved slots) all need candidates that the
/// final cut will not fund, and a pool sized to k starves them.
export function semanticCandidateLimit(k) {
  return Math.max(k * 12, 256);
}

export function validateOptions(options) {
  const query = options.query?.trim();
  const project = options.project?.trim();
  const types = options.types?.map((type) => type.trim()).filter(Boolean) || null;
  const area = options.area?.trim() || null;
  const k = Number(options.k ?? 8);
  const tokenBudget = Number(options.tokenBudget ?? 4000);
  const perCandidateCapRatio = Number(options.perCandidateCapRatio ?? 0.22);
  const documentAggregation = options.documentAggregation ?? { mode: 'max' };
  if (!['max', 'max-support'].includes(documentAggregation.mode)) {
    throw new Error("documentAggregation.mode must be 'max' or 'max-support'.");
  }
  const slotAllocation = options.slotAllocation ?? { mode: 'reserved-semantic', floor: 0.55, slots: 1, championMetric: 'raw' };
  if (!['governed', 'reserved-semantic'].includes(slotAllocation.mode)) {
    throw new Error("slotAllocation.mode must be 'governed' or 'reserved-semantic'.");
  }
  if (slotAllocation.championMetric !== undefined && !['fused', 'raw'].includes(slotAllocation.championMetric)) {
    throw new Error("slotAllocation.championMetric must be 'fused' or 'raw'.");
  }
  const excludeDocumentIds = options.excludeDocumentIds || [];
  // Only applied when the caller expressed no opinion about types.
  const excludeTypes = options.types?.length ? [] : DEFAULT_EXCLUDED_TYPES;
  if (!query) throw new Error('query is required.');
  if (!project) throw new Error('project is required.');
  if (query.length > 10_000) throw new Error('query must be at most 10000 characters.');
  if (types?.some((type) => !ALLOWED_TYPE_SET.has(type))) throw new Error('types contains an unsupported document type.');
  if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error('k must be an integer from 1 to 50.');
  if (!Number.isInteger(tokenBudget) || tokenBudget < 128 || tokenBudget > 100_000) {
    throw new Error('tokenBudget must be an integer from 128 to 100000.');
  }
  if (!Number.isFinite(perCandidateCapRatio) || perCandidateCapRatio < 0.05 || perCandidateCapRatio > 1) {
    throw new Error('perCandidateCapRatio must be a number from 0.05 to 1.');
  }
  if (!Array.isArray(excludeDocumentIds) || excludeDocumentIds.length > 1_000
    || excludeDocumentIds.some((id) => typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,255}$/i.test(id))) {
    throw new Error('excludeDocumentIds must contain at most 1000 safe document ids.');
  }
  return {
    query, project, types, area, k, tokenBudget, perCandidateCapRatio, documentAggregation, slotAllocation, excludeTypes,
    excludeDocumentIds: [...new Set(excludeDocumentIds)],
  };
}

/// Gather every candidate arm and fuse them into one ranking.
///
/// Fusion runs over the WHOLE candidate pool the ranker consumes, not just the ANN arm:
/// the failing gold set cases were architecture chunks that were present as candidates
/// all along and simply scored too low to survive the final cut.
export async function queryIndex(store, vector, options) {
  const filters = {
    project: options.project,
    types: options.types,
    area: options.area,
    excludeTypes: options.excludeTypes,
    excludeDocumentIds: options.excludeDocumentIds,
  };
  const semanticLimit = semanticCandidateLimit(options.k);
  const semantic = await store.semanticCandidates(vector, filters, semanticLimit);

  let architectureRows = [];
  if (!options.types?.length || options.types.includes('architecture')) {
    architectureRows = await store.architectureCandidates(vector, filters);
  }

  const lexical = await store.lexicalCandidates(options.query, vector, filters, LEXICAL_CANDIDATE_LIMIT);
  const provenance = await store.provenanceCandidates(vector, filters);

  // Documents carry no type exclusion on purpose: the exclusion shapes which CHUNKS
  // become candidates, while the ranker still needs the whole inventory to resolve
  // supersession chains and lesson links through units it will never fund.
  const documents = await store.allDocuments({
    project: options.project,
    types: null,
    area: null,
    excludeDocumentIds: options.excludeDocumentIds,
  });
  const relationships = await store.relationshipEdges(RELATIONSHIP_KINDS);

  const pool = [...semantic, ...architectureRows, ...provenance, ...lexical];
  const deduped = [...new Map(pool.map((row) => [String(row.chunk_id), row])).values()];

  // Which ARM found each document, recorded for diagnosis and never used for ranking.
  //
  // The sub-75 path clusters missed gold cases "by type, area, and ARM" (methods.md v4,
  // retrievalScore.perCase), and arm is the one of the three that cannot be read off a
  // document: it is a property of how the retrieval reached it. Derived here from arm
  // membership, which is free, rather than threaded through rank.js, which is the measured
  // code the floor rests on. Purely additive: nothing downstream reads it.
  const lexicalDocumentIds = new Set(lexical.map((row) => row.id));
  const vectorDocumentIds = new Set([...semantic, ...architectureRows, ...provenance].map((row) => row.id));
  const arms = {};
  for (const id of new Set([...lexicalDocumentIds, ...vectorDocumentIds])) {
    const inLexical = lexicalDocumentIds.has(id);
    const inVector = vectorDocumentIds.has(id);
    arms[id] = inLexical && inVector ? 'fused' : inLexical ? 'lexical' : 'semantic';
  }

  return {
    semanticRows: fuseRankings(deduped, lexical.map((row) => row.chunk_id)),
    documents,
    relationships,
    arms,
  };
}

export async function retrieve(options, dependencies = {}) {
  const parsed = validateOptions(options);
  const store = dependencies.store;
  if (!store) throw new Error('retrieve requires a store.');
  const environment = dependencies.environment || process.env;
  const logger = dependencies.logger || nullLogger();
  const pathGrammar = dependencies.pathGrammar || PLATFORM_PATH_GRAMMAR;
  const standingPrefix = dependencies.standingPrefix || STANDING_ID_PREFIX;
  const started = performance.now();
  try {
    const configured = embeddingIdentity(environment);
    const preflightStarted = performance.now();
    const served = await resolveServedIdentity(configured, { environment, fetchImpl: dependencies.fetchImpl });
    await logger.step('retrieval-preflight', { project: parsed.project }, 'ready', preflightStarted, { id: served.model });

    const indexed = await store.indexedEmbeddingIdentity();
    assertRetrievalIdentity(indexed, served);

    const embedStarted = performance.now();
    const [vector] = await embedTexts([parsed.query], served, {
      environment,
      fetchImpl: dependencies.fetchImpl,
      batchSize: 1,
      inputType: 'query',
      onBatch: async (batch) => logger.step(
        'embed-query',
        { characters: parsed.query.length },
        'embedded',
        embedStarted,
        { id: batch.model, tokens: batch.tokens, cost: batch.cost },
      ),
    });

    const queryStarted = performance.now();
    const indexedRows = await queryIndex(store, vector, parsed);
    await logger.step('query-index', { project: parsed.project, k: parsed.k }, {
      semantic_rows: indexedRows.semanticRows.length,
      documents: indexedRows.documents.length,
    }, queryStarted);

    const rankStarted = performance.now();
    const retrievalFixes = dependencies.retrievalFixes ?? [];
    // `arms` is diagnosis metadata, not a ranking input, so it is destructured OUT before
    // the spread rather than passed to the ranker and ignored there by luck.
    const { arms, ...rankerInputs } = indexedRows;
    const ranked = rankRetrieval({ query: parsed.query, ...rankerInputs, ...parsed, retrievalFixes });
    const impact = reverseImpact(parsed.query, indexedRows.relationships, 12, pathGrammar);
    // Standing units are procedural memory, not retrieval. They are fetched after ranking
    // and deliberately do not pass through the k and token budget: charging the task's
    // evidence budget for house rules is how the house rules end up absent exactly when
    // an engineer is about to break one.
    const standing = asStandingUnits(await store.standingDocuments({
      prefix: standingPrefix,
      excludeDocumentIds: parsed.excludeDocumentIds,
    }));
    const standingIds = standing.map((unit) => unit.id);
    const result = {
      ...ranked,
      standing,
      impact,
      meta: {
        ...ranked.meta,
        query: parsed.query,
        project: parsed.project,
        embedding: { provider: served.provider, model: served.model, digest: served.digest, dimension: served.dimension },
        // The engineer genuinely receives these, so they belong in retrievedIds. They are
        // also listed separately, so a measurement can tell a hit that ranking earned from
        // one that pinning guaranteed.
        retrievedIds: [...new Set([...ranked.meta.retrievedIds, ...standingIds])],
        standingIds,
        rankedIds: [...new Set(ranked.meta.retrievedIds)],
        excludedDocumentCount: parsed.excludeDocumentIds.length,
        // Which arm reached each retrieved document. Recorded for the sub-75 diagnosis,
        // which clusters missed cases by type, area and arm.
        arms: Object.fromEntries(
          [...new Set([...ranked.meta.retrievedIds, ...standingIds])]
            .map((id) => [id, standingIds.includes(id) ? 'standing' : (arms[id] || null)]),
        ),
        log: logger.file,
      },
    };
    await logger.step('rank-and-budget', { candidates: indexedRows.documents.length }, {
      retrieved: result.meta.retrievedIds.length,
      impact: impact.length,
      tokens: result.meta.tokenCount,
    }, rankStarted);
    await logger.step('retrieve', { project: parsed.project }, 'complete', started, { id: served.model });
    return result;
  } catch (error) {
    await logger.step('retrieve', { project: parsed.project }, { error: error.message }, started);
    throw error;
  }
}

export { LEXICAL_CANDIDATE_LIMIT, RELATIONSHIP_KINDS };
