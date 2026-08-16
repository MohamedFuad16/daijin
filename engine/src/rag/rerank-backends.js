// Local cross-encoder backends. The seam, and one implementation.
//
// BACKEND CHOICE, VERIFIED AGAINST DOCUMENTATION 2026-08-16 rather than guessed, as D-0025
// requires:
//
//  OLLAMA: RULED OUT. Its documented API surface (github.com/ollama/ollama/docs/api.md)
//  lists 14 endpoints and none is a rerank. Confirmed against the running local instance,
//  version 0.32.1, with controls so the probe itself is trustworthy:
//      POST /api/rerank   -> 404
//      POST /api/embed    -> 200   (control: the probe reaches a real endpoint)
//      POST /api/nonsense -> 404   (control: 404 is what absent looks like)
//  A rerank "through Ollama" would therefore be an embedding similarity wearing the name,
//  which is the bi-encoder we already have and not a cross-encoder at all.
//
//  LLAMA-SERVER: REAL, and the backend implemented here. llama.cpp's server documents
//  `--rerank`/`--reranking` ("enable reranking endpoint on server (default: disabled)"),
//  serves /rerank, /reranking, /v1/rerank and /v1/reranking, and requires a reranker model
//  such as bge-reranker-v2-m3 run with `--embedding --pooling rank`.
//
//  IN-PROCESS ONNX: possible, deliberately not built yet. It would remove the second
//  process at the cost of a heavy native dependency (onnxruntime-node) and a model
//  download, and that trade should be made against a measured win rather than before one.
//
// The seam is one method, `rerank(query, documents) -> number[]`, so an ONNX backend drops
// in beside this one without touching the stage.

const DEFAULT_TIMEOUT_MS = 30_000;

/** The endpoint llama-server serves reranking on. `/v1/rerank` is the OpenAI-shaped one. */
export const LLAMA_RERANK_PATH = '/v1/rerank';

function normalizeBaseUrl(value) {
  return String(value || 'http://localhost:8080').replace(/\/$/, '');
}

/**
 * A reranker backed by a local llama-server started with `--rerank`.
 *
 * LOCAL ONLY by construction: the base URL defaults to localhost and nothing here carries
 * an API key or reaches a hosted endpoint. Pointing it at a remote host would be a config
 * error rather than a supported mode, and the retrieval path is not allowed to spend.
 */
export function createLlamaServerReranker({
  baseUrl,
  model = 'bge-reranker-v2-m3',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const root = normalizeBaseUrl(baseUrl);
  return {
    id: `llama-server:${model}`,
    baseUrl: root,

    async rerank(query, documents) {
      if (documents.length === 0) return [];
      let response;
      try {
        response = await fetchImpl(`${root}${LLAMA_RERANK_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, query, documents, top_n: documents.length }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new Error(
          `Rerank backend unreachable at ${root}${LLAMA_RERANK_PATH}: ${error.message}. `
          + 'Start it with: llama-server --model <bge-reranker-v2-m3.gguf> --rerank --embedding --pooling rank',
        );
      }
      if (!response.ok) {
        throw new Error(`Rerank backend returned HTTP ${response.status} from ${root}${LLAMA_RERANK_PATH}: ${await response.text()}`);
      }
      const body = await response.json();
      // The documented response is a results array of { index, relevance_score }. It is
      // NOT assumed to arrive in input order: the index field exists precisely because the
      // order is not the contract, and reading it positionally is the misalignment class
      // the embedder already learned the hard way.
      const rows = body?.results ?? body?.data;
      if (!Array.isArray(rows)) {
        throw new Error(`Rerank backend returned no results array from ${root}${LLAMA_RERANK_PATH}.`);
      }
      const scores = new Array(documents.length).fill(undefined);
      for (const row of rows) {
        const index = Number(row?.index);
        if (!Number.isInteger(index) || index < 0 || index >= documents.length) continue;
        scores[index] = Number(row.relevance_score ?? row.score);
      }
      if (scores.some((value) => value === undefined || Number.isNaN(value))) {
        throw new Error(`Rerank backend scored ${scores.filter((value) => value !== undefined).length} of ${documents.length} document(s); refusing to reorder on a partial response.`);
      }
      return scores;
    },

    /// Is the backend actually there? Used by the knob so a user can be told the stage is
    /// configured but unreachable, rather than discovering it mid-query.
    async available() {
      try {
        const scores = await this.rerank('probe', ['probe']);
        return { ok: Array.isArray(scores) && scores.length === 1, hint: null };
      } catch (error) {
        return { ok: false, hint: error.message };
      }
    },
  };
}

/// Build the configured backend, or null when reranking is off or unconfigured. Null is a
/// normal state, not an error: off by default is the shipped configuration.
export function createReranker(settings = {}, { fetchImpl } = {}) {
  const config = settings.rerank || {};
  if (!config.enabled) return null;
  if (config.backend && config.backend !== 'llama-server') {
    throw new Error(`Unknown rerank backend ${config.backend}; the built one is llama-server (Ollama has no rerank endpoint, verified 2026-08-16).`);
  }
  return createLlamaServerReranker({ baseUrl: config.baseUrl, model: config.model, fetchImpl });
}
