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
const OLLAMA_DOWN = 'Ollama not reachable at localhost:11434; start it with brew services start ollama';

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

export async function checkOllama({ environment = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = normalizeBaseUrl(environment.OLLAMA_BASE_URL);
  try {
    const [version, tags] = await Promise.all([
      requestJson(`${baseUrl}/api/version`, { timeoutMs: 5_000 }, { retries: 0, fetchImpl }),
      requestJson(`${baseUrl}/api/tags`, { timeoutMs: 5_000 }, { retries: 0, fetchImpl }),
    ]);
    const model = environment.EMBEDDING_MODEL;
    const installed = tags.models?.find((item) => item.name === model || item.name === `${model}:latest` || item.model === model);
    if (!installed) throw new Error(`Ollama model ${model} is not installed; run ollama pull ${model}`);
    return { version: version.version, digest: installed.digest, model: installed.model || installed.name };
  } catch (error) {
    if (/not installed/.test(error.message)) throw error;
    throw new Error(OLLAMA_DOWN);
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
    throw new Error(OLLAMA_DOWN);
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

export { OLLAMA_DOWN };
