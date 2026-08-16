// Test doubles shared across the engine suite.
//
// The fake store implements the retrieval arms in memory so the whole retrieval path can
// be exercised with no database and no Ollama. The fake embedder answers the three Ollama
// endpoints the identity preflight and the embed call touch.

export function fakeEnvironment(overrides = {}) {
  return {
    EMBEDDING_PROVIDER: 'ollama',
    EMBEDDING_MODEL: 'test-embed',
    EMBEDDING_MODEL_DIGEST: 'sha256:test',
    EMBEDDING_DIM: '4',
    OLLAMA_BASE_URL: 'http://localhost:11434',
    ...overrides,
  };
}

/// A fetch double for the Ollama endpoints. `vector` is what every embed call returns.
export function fakeOllama({ vector = [1, 0, 0, 0], digest = 'sha256:test', model = 'test-embed' } = {}) {
  return async function fetchImpl(url) {
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (String(url).endsWith('/api/version')) return json({ version: '0.0.0-test' });
    if (String(url).endsWith('/api/tags')) return json({ models: [{ name: model, model, digest }] });
    if (String(url).endsWith('/api/embed')) return json({ embeddings: [vector], prompt_eval_count: 3 });
    throw new Error(`unexpected fetch to ${url}`);
  };
}

/// An in-memory RetrievalStore.
///
/// `documents` are whole units; `chunks` carry { documentId, ordinal, content, score,
/// lexRank }. Scores are supplied rather than computed so a test can pin an exact
/// ordering instead of depending on a similarity function.
export function fakeStore({ documents = [], chunks = [], relationships = [], identity = null } = {}) {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const eligible = (filters, document) => {
    if (!document) return false;
    if (filters.project && document.project !== filters.project) return false;
    if (String(document.meta?.draft) === 'true') return false;
    if (filters.types?.length && !filters.types.includes(document.type)) return false;
    if (filters.area && document.meta?.area !== filters.area) return false;
    if (filters.excludeTypes?.includes(document.type)) return false;
    if (filters.excludeDocumentIds?.includes(document.id)) return false;
    return true;
  };
  const asRow = (chunk) => {
    const document = byId.get(chunk.documentId);
    const content = chunk.ordinal === -1
      ? chunks.find((other) => other.documentId === chunk.documentId && other.ordinal === 0)?.content ?? chunk.content
      : chunk.content;
    return {
      id: document.id,
      type: document.type,
      path: document.path,
      title: document.title,
      tags: document.tags,
      meta: document.meta,
      chunk_id: chunk.id,
      ordinal: chunk.ordinal,
      chunk_content: content,
      score: chunk.score,
      lex_rank: chunk.lexRank ?? null,
    };
  };
  const scored = (filters) => chunks
    .filter((chunk) => eligible(filters, byId.get(chunk.documentId)))
    .map(asRow)
    .sort((a, b) => b.score - a.score || String(a.chunk_id).localeCompare(String(b.chunk_id)));

  return {
    calls: [],
    async init() {},
    async ingestChunks() {},
    async close() {},
    async transaction(fn) { return fn(); },
    async getMeta() { return null; },
    async setMeta() {},
    async semanticQuery(vector, filters, limit) { return scored(filters).slice(0, limit); },
    async lexicalQuery() { return []; },
    async documents(filters) { return (await this.allDocuments(filters)).map((d) => ({ id: d.id, type: d.type, area: d.meta?.area ?? null })); },
    async standingUnits() { return this.standingDocuments({}); },

    async semanticCandidates(vector, filters, limit) {
      this.calls.push(['semantic', limit]);
      return scored(filters).slice(0, limit);
    },
    async architectureCandidates(vector, filters) {
      this.calls.push(['architecture']);
      return scored({ ...filters, types: ['architecture'] });
    },
    async lexicalCandidates(query, vector, filters, limit) {
      this.calls.push(['lexical', limit]);
      return scored(filters)
        .filter((row) => row.lex_rank !== null && String(row.chunk_content).toLowerCase().includes(String(query).toLowerCase()))
        .sort((a, b) => b.lex_rank - a.lex_rank || String(a.chunk_id).localeCompare(String(b.chunk_id)))
        .slice(0, limit);
    },
    async provenanceCandidates(vector, filters) {
      this.calls.push(['provenance']);
      return scored(filters).filter((row) => Array.isArray(row.meta?.retrieval_provenance) && row.meta.retrieval_provenance.length > 0);
    },
    async allDocuments(filters) {
      return documents.filter((document) => eligible(filters, document));
    },
    async relationshipEdges(kinds) {
      return relationships.filter((edge) => kinds.includes(edge.kind));
    },
    async standingDocuments({ prefix = 'global.', excludeDocumentIds = [] } = {}) {
      return documents
        .filter((document) => document.id.startsWith(prefix) && !excludeDocumentIds.includes(document.id))
        .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
    },
    async existingDocumentIds(ids) {
      return ids.filter((id) => byId.has(id));
    },
    async indexedEmbeddingIdentity() {
      return identity ?? { indexed: true, provider: 'ollama', model: 'test-embed', digest: 'sha256:test', dimension: 4 };
    },
  };
}

export function makeDocument(overrides = {}) {
  return {
    id: 'web.decision.adr-0001',
    project: 'demo',
    type: 'decision',
    path: 'brain/decisions/adr-0001.md',
    title: 'Storage layer redesign',
    tags: ['storage'],
    meta: { area: 'storage' },
    content: 'The storage layer moved off the shared mount because file locking is unreliable there.',
    ...overrides,
  };
}
