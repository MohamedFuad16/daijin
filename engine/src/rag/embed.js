// Embedding client. Copied from the platform (platform/ingest/embed.js).
//
// Ollama is the zero spend default and the only provider Daijin ships enabled; the
// openai and voyage branches are kept because the abstraction is already three provider
// shaped and dropping them would be an unmeasured change, not a simplification. Nothing
// in the retrieval path may call a paid API (README, non negotiable constraints).
//
// The alignment and dimension assertions below are hard won safety and must survive any
// port: the comment above assertBatchAlignment records exactly the silent corruption
// they prevent.
// The stable PREFIX every unreachable-ollama message starts with, kept exported so a
// caller can still match on it. The message itself is built per endpoint below.
const OLLAMA_DOWN = 'Ollama not reachable';

// NAMES THE HOST IT ACTUALLY TRIED. The old constant hardcoded localhost:11434 and the
// brew advice with it, so once serveStatus began reporting the real endpoint the hint
// contradicted the endpoint on the same row, and a user pointed at a remote ollama was
// told to start a service on the wrong machine. `brew services` is offered ONLY for a
// local endpoint, because it is not advice that can help anyone else.
function ollamaDown(baseUrl) {
  const endpoint = normalizeBaseUrl(baseUrl);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(endpoint);
  return local
    ? `${OLLAMA_DOWN} at ${endpoint}; start it with brew services start ollama`
    : `${OLLAMA_DOWN} at ${endpoint}; check that the host is up and reachable, or clear the configured endpoint to fall back to a local ollama`;
}

function timeoutSignal(milliseconds) {
  return AbortSignal.timeout(milliseconds);
}

async function requestJson(url, options, { retries = 2, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const { timeoutMs = 60_000, ...requestOptions } = options;
      const response = await fetchImpl(url, { ...requestOptions, signal: timeoutSignal(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function normalizeBaseUrl(value) {
  return (value || 'http://localhost:11434').replace(/\/$/, '');
}

/**
 * How long a status probe waits before calling the endpoint unreachable.
 *
 * 1.5 s rather than 5 s. This is the STATUS path, which runs on a screen paint, not the
 * embedding path, where a slow answer is still worth waiting for. The number is bounded by
 * what a person will sit through rather than by what a busy server might need: a local
 * ollama answers in single-digit milliseconds, and a remote one that cannot manage 1.5 s
 * is not going to serve a retrieval run either.
 *
 * The value only matters for a host that ACCEPTS AND NEVER ANSWERS. A refused connection
 * returns instantly and a name that does not resolve fails instantly; a machine that is
 * asleep, firewalled, or on a VPN that went down is the case that reaches this timeout,
 * and it was costing five seconds on every paint.
 */
export const PROBE_TIMEOUT_MS = 1_500;

export async function checkOllama({ environment = process.env, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const baseUrl = normalizeBaseUrl(environment.OLLAMA_BASE_URL);
  try {
    const [version, tags] = await Promise.all([
      requestJson(`${baseUrl}/api/version`, { timeoutMs }, { retries: 0, fetchImpl }),
      requestJson(`${baseUrl}/api/tags`, { timeoutMs }, { retries: 0, fetchImpl }),
    ]);
    const model = environment.EMBEDDING_MODEL;
    const installed = tags.models?.find((item) => item.name === model || item.name === `${model}:latest` || item.model === model);
    if (!installed) throw new Error(`Ollama model ${model} is not installed; run ollama pull ${model}`);
    // `endpoint` is returned rather than kept private because a caller that renders status
    // otherwise has to recompute this default to say WHERE it looked, and a status screen
    // whose endpoint is a second guess at the same default is exactly how a wrong endpoint
    // stays invisible: it would agree with itself while disagreeing with the probe.
    return { endpoint: baseUrl, version: version.version, digest: installed.digest, model: installed.model || installed.name };
  } catch (error) {
    if (/not installed/.test(error.message)) { error.endpoint = baseUrl; throw error; }
    const down = new Error(ollamaDown(baseUrl));
    // Carried on the error so the failure branch can still report where it tried. A status
    // screen is most useful precisely when the probe FAILED, and that is the branch that
    // used to know the least.
    down.endpoint = baseUrl;
    throw down;
  }
}

// One vector per input, in input order: the assumption every caller already makes and
// none of them checked. Ingest slices the flat vector array by per document chunk
// counts, so a batch that returns even one vector short shifts every LATER document onto
// its neighbour's embeddings and writes SQL NULL for the tail. Retrieve takes `[vector]`
// from a batch of one, so an empty response binds a NULL query vector and every cosine
// score comes back NULL. Both corruptions are silent: no error, no log line, wrong
// answers thereafter.
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

// OpenAI documents `index` on each item precisely because the array order is not the
// contract. Sorting by it costs nothing and removes the silent misalignment case; a
// response without indexes keeps its arrival order, which is all we ever had.
function orderedEmbeddings(data) {
  const items = [...(data || [])];
  if (items.length > 0 && items.every((item) => Number.isInteger(item?.index))) {
    items.sort((left, right) => left.index - right.index);
  }
  return items.map((item) => item?.embedding);
}

async function embedOllama(inputs, identity, environment, fetchImpl) {
  const baseUrl = normalizeBaseUrl(environment.OLLAMA_BASE_URL);
  try {
    const result = await requestJson(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: identity.model, input: inputs }),
      timeoutMs: 60_000,
    }, { fetchImpl });
    return { vectors: result.embeddings, tokens: result.prompt_eval_count || null, cost: 0 };
  } catch {
    throw new Error(ollamaDown(environment.OLLAMA_BASE_URL));
  }
}

async function embedOpenAi(inputs, identity, environment, fetchImpl) {
  if (!environment.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for the openai embedding provider.');
  const result = await requestJson('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${environment.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: identity.model, input: inputs, dimensions: identity.dimension }),
    timeoutMs: 60_000,
  }, { fetchImpl });
  return { vectors: orderedEmbeddings(result.data), tokens: result.usage?.total_tokens || null, cost: null };
}

async function embedVoyage(inputs, identity, environment, fetchImpl, inputType) {
  if (!environment.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY is required for the voyage embedding provider.');
  const result = await requestJson('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { authorization: `Bearer ${environment.VOYAGE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: identity.model, input: inputs, input_type: inputType }),
    timeoutMs: 60_000,
  }, { fetchImpl });
  return { vectors: result.data.map((item) => item.embedding), tokens: result.usage?.total_tokens || null, cost: null };
}

export async function embedTexts(inputs, identity, {
  environment = process.env,
  fetchImpl = fetch,
  batchSize = Number(environment.EMBEDDING_BATCH_SIZE || 16),
  inputType = 'document',
  onBatch = async () => {},
} = {}) {
  const vectors = [];
  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    const batch = inputs.slice(offset, offset + batchSize);
    const started = performance.now();
    let result;
    if (identity.provider === 'ollama') result = await embedOllama(batch, identity, environment, fetchImpl);
    else if (identity.provider === 'openai') result = await embedOpenAi(batch, identity, environment, fetchImpl);
    else if (identity.provider === 'voyage') result = await embedVoyage(batch, identity, environment, fetchImpl, inputType);
    else throw new Error(`Unsupported embedding provider: ${identity.provider}.`);
    assertBatchAlignment(result.vectors, batch.length);
    assertDimensions(result.vectors, identity.dimension);
    vectors.push(...result.vectors);
    await onBatch({
      inputs: batch.length,
      offset,
      durationMs: Math.round(performance.now() - started),
      model: identity.model,
      tokens: result.tokens,
      cost: result.cost,
    });
  }
  return vectors;
}

export async function resolveServedIdentity(identity, options = {}) {
  if (identity.provider !== 'ollama') return identity;
  const served = await checkOllama(options);
  if (served.digest !== identity.digest) {
    throw new Error(`Configured Ollama digest does not match the served ${identity.model} digest; update EMBEDDING_MODEL_DIGEST before indexing.`);
  }
  return { ...identity, digest: served.digest };
}

export { OLLAMA_DOWN, ollamaDown };
