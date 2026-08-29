// Ollama client wrapper: the local, zero-spend embedding provider.
//
// The alignment and dimension guards are ported from the platform's ingest/embed.js,
// where they were written after a silent corruption: a batch that returns one vector
// short shifts every later chunk onto its neighbour's embedding and writes NULL for the
// tail. No error, no log line, wrong answers thereafter. They stay hard failures here.
//
// fetchImpl is injectable so every test in this repo runs without a running Ollama and
// without a network call.

const DEFAULT_BASE_URL = 'http://localhost:11434';
const OLLAMA_DOWN = 'Ollama is not reachable; start it with `brew services start ollama`';

function normalizeBaseUrl(value) {
  return (value || DEFAULT_BASE_URL).replace(/\/$/, '');
}

async function requestJson(url, options, { retries = 2, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const { timeoutMs = 60_000, ...requestOptions } = options;
      const response = await fetchImpl(url, { ...requestOptions, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        // Tagged with the status so callers can tell "the server answered badly" from "no
        // server answered". Untagged, a 404 for a model that was deleted mid run is
        // indistinguishable from a closed port, and the caller reports the wrong one.
        const httpError = new Error(`HTTP ${response.status}: ${await response.text()}`);
        httpError.status = response.status;
        throw httpError;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((done) => setTimeout(done, 250 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function assertBatchAlignment(vectors, expected) {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    const got = Array.isArray(vectors) ? vectors.length : 'no';
    throw new Error(`Embedding response returned ${got} vectors for ${expected} input(s); refusing to write misaligned embeddings.`);
  }
}

function assertDimensions(vectors, dimension) {
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dimension) {
      throw new Error(`Embedding response dimension was ${vector?.length ?? 'missing'}; expected ${dimension}.`);
    }
  }
}

/**
 * @param {object} options
 * @param {string} options.model     Ollama model tag, for example 'mxbai-embed-large'.
 * @param {number} options.dimension Expected vector width; a mismatch is a hard failure.
 */
export function createOllamaClient({
  model,
  dimension,
  baseUrl = process.env.OLLAMA_BASE_URL,
  fetchImpl = fetch,
  batchSize = 16,
  retries = 2,
  timeoutMs = 60_000,
} = {}) {
  if (!model) throw new Error('createOllamaClient requires a model tag.');
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new Error('createOllamaClient requires an integer dimension.');
  }
  // A batch size below 1 never advances embed's offset, so the loop reissues the same
  // request forever against a live server rather than failing. Refused at construction,
  // where the caller can still see which knob it set.
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`createOllamaClient requires a batch size of at least 1; received ${batchSize}.`);
  }
  const root = normalizeBaseUrl(baseUrl);

  /** Served identity, not the catalogue's claim. The health gate compares this to meta. */
  async function servedIdentity() {
    let version;
    let tags;
    try {
      [version, tags] = await Promise.all([
        requestJson(`${root}/api/version`, { timeoutMs: 5_000 }, { retries: 0, fetchImpl }),
        requestJson(`${root}/api/tags`, { timeoutMs: 5_000 }, { retries: 0, fetchImpl }),
      ]);
    } catch (error) {
      // Same rule as embed: OLLAMA_DOWN is a claim about REACHABILITY, so a server that
      // answered keeps its own message. Only an unanswered request is "down", and it is
      // tagged as such so health() can report the difference rather than guess from the
      // message string.
      if (error?.status !== undefined) throw error;
      const unreachable = new Error(OLLAMA_DOWN, { cause: error });
      unreachable.unreachable = true;
      throw unreachable;
    }
    const installed = (tags.models || []).find(
      (item) => item.name === model || item.name === `${model}:latest` || item.model === model,
    );
    if (!installed) throw new Error(`Ollama model ${model} is not installed; run \`ollama pull ${model}\`.`);
    return {
      provider: 'ollama',
      model: installed.model || installed.name,
      digest: installed.digest || null,
      dimension,
      serverVersion: version.version,
      embedderId: embedderId(installed.digest || null),
    };
  }

  function embedderId(digest) {
    return digest ? `ollama:${model}@${digest}` : `ollama:${model}`;
  }

  /** Health probe that never throws, for the watcher beat. */
  async function health() {
    try {
      const identity = await servedIdentity();
      return { reachable: true, ...identity };
    } catch (error) {
      // reachable is a claim about the SERVER, not about the model. A missing model and an
      // HTTP error both mean Ollama answered, so both report reachable with the real
      // reason; only a request that got no answer at all is unreachable. Reporting a
      // running server as down sends someone to restart the one thing that was working,
      // and it is the distinction probe-ollama.mjs already draws (exit 3 vs exit 4).
      return {
        reachable: error?.unreachable !== true,
        error: error.message,
        provider: 'ollama',
        model,
        dimension,
      };
    }
  }

  async function embed(texts, { onBatch = async () => {} } = {}) {
    const inputs = [...texts];
    const vectors = [];
    for (let offset = 0; offset < inputs.length; offset += batchSize) {
      const batch = inputs.slice(offset, offset + batchSize);
      const started = performance.now();
      const result = await requestJson(`${root}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
        timeoutMs,
      }, { retries, fetchImpl }).catch((error) => {
        // OLLAMA_DOWN is a claim about REACHABILITY, so only an unanswered request may
        // make it. A server that answered and refused (a model pulled out from under a
        // run is the common one) keeps its own message and its cause: the difference
        // between telling someone to start Ollama and telling them to pull a model is
        // the difference between a fixed run and an afternoon spent restarting a server
        // that was never down.
        if (error?.status !== undefined) throw error;
        throw new Error(OLLAMA_DOWN, { cause: error });
      });
      assertBatchAlignment(result.embeddings, batch.length);
      assertDimensions(result.embeddings, dimension);
      vectors.push(...result.embeddings);
      await onBatch({
        inputs: batch.length,
        offset,
        durationMs: Math.round(performance.now() - started),
        model,
        tokens: result.prompt_eval_count ?? null,
        cost: 0,
      });
    }
    return vectors;
  }

  async function embedQuery(text) {
    const [vector] = await embed([text]);
    return vector;
  }

  return { model, dimension, baseUrl: root, embedderId, servedIdentity, health, embed, embedQuery };
}

export { OLLAMA_DOWN };
