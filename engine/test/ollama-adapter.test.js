// Ollama wrapper: every test runs against an injected fetch, so the suite stays local and
// zero spend whether or not Ollama is running on this machine.
//
// The alignment and dimension guards are the point of this file. The platform lost a full
// index to a batch that returned one vector short: no error, no log line, every later
// chunk sitting on its neighbour's embedding. A guard that only runs in production is not
// a guard, so both failure modes are exercised here.

import assert from 'node:assert/strict';
import test from 'node:test';
import { OLLAMA_DOWN, createOllamaClient } from '../../adapters/ollama/client.js';

const DIMENSION = 4;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** A fake Ollama that records every call it receives. */
function fakeOllama({ embeddings, tags, version = '0.5.7' } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: options?.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/api/version')) return jsonResponse({ version });
    if (url.endsWith('/api/tags')) return jsonResponse({ models: tags ?? [] });
    if (url.endsWith('/api/embed')) {
      const inputs = JSON.parse(options.body).input;
      return jsonResponse({ embeddings: embeddings(inputs), prompt_eval_count: inputs.length * 3 });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, calls };
}

const vectorFor = (text) => Array.from({ length: DIMENSION }, (_, index) => text.length + index);

test('embed batches the inputs and keeps the response in input order', async () => {
  const server = fakeOllama({ embeddings: (inputs) => inputs.map(vectorFor) });
  const client = createOllamaClient({
    model: 'mxbai-embed-large',
    dimension: DIMENSION,
    fetchImpl: server.fetchImpl,
    batchSize: 2,
  });
  const batches = [];
  const vectors = await client.embed(['a', 'bb', 'ccc', 'dddd', 'eeeee'], {
    onBatch: async (event) => batches.push(event),
  });

  assert.equal(vectors.length, 5);
  assert.deepEqual(vectors[0], vectorFor('a'));
  assert.deepEqual(vectors[4], vectorFor('eeeee'));
  assert.equal(batches.length, 3, 'five inputs at batch size two is three requests');
  assert.deepEqual(batches.map((event) => event.inputs), [2, 2, 1]);
  assert.equal(batches[0].cost, 0, 'the local provider is free, and says so');
  assert.ok(server.calls.every((call) => call.url.startsWith('http://localhost:11434')));
});

test('a short batch is refused rather than written misaligned', async () => {
  const server = fakeOllama({ embeddings: (inputs) => inputs.slice(1).map(vectorFor) });
  const client = createOllamaClient({
    model: 'mxbai-embed-large',
    dimension: DIMENSION,
    fetchImpl: server.fetchImpl,
  });
  await assert.rejects(
    () => client.embed(['a', 'bb', 'ccc']),
    /returned 2 vectors for 3 input\(s\); refusing to write misaligned embeddings/,
  );
});

test('a wrong width response is refused', async () => {
  const server = fakeOllama({ embeddings: (inputs) => inputs.map(() => [1, 2]) });
  const client = createOllamaClient({
    model: 'mxbai-embed-large',
    dimension: DIMENSION,
    fetchImpl: server.fetchImpl,
  });
  await assert.rejects(() => client.embed(['a']), /dimension was 2; expected 4/);
});

test('servedIdentity reports the served model id, not the configured one', async () => {
  const server = fakeOllama({
    embeddings: () => [],
    tags: [{ name: 'mxbai-embed-large:latest', model: 'mxbai-embed-large:latest', digest: 'sha256-abc123' }],
  });
  const client = createOllamaClient({ model: 'mxbai-embed-large', dimension: DIMENSION, fetchImpl: server.fetchImpl });
  const identity = await client.servedIdentity();

  assert.equal(identity.model, 'mxbai-embed-large:latest');
  assert.equal(identity.digest, 'sha256-abc123');
  assert.equal(identity.dimension, DIMENSION);
  assert.equal(identity.serverVersion, '0.5.7');
  assert.equal(identity.embedderId, 'ollama:mxbai-embed-large@sha256-abc123');
});

test('a model that is not installed is named in the error', async () => {
  const server = fakeOllama({ embeddings: () => [], tags: [{ name: 'nomic-embed-text:latest' }] });
  const client = createOllamaClient({ model: 'mxbai-embed-large', dimension: DIMENSION, fetchImpl: server.fetchImpl });
  await assert.rejects(() => client.servedIdentity(), /mxbai-embed-large is not installed/);
});

test('health never throws and says why it is unhealthy', async () => {
  const client = createOllamaClient({
    model: 'mxbai-embed-large',
    dimension: DIMENSION,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const health = await client.health();
  assert.equal(health.reachable, false);
  assert.equal(health.error, OLLAMA_DOWN);
  assert.equal(health.model, 'mxbai-embed-large');
});

test('an unreachable server during embed fails loudly', async () => {
  const client = createOllamaClient({
    model: 'mxbai-embed-large',
    dimension: DIMENSION,
    retries: 0,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(() => client.embed(['a']), new RegExp(OLLAMA_DOWN.slice(0, 30)));
});

test('the client refuses to be constructed without an identity', () => {
  assert.throws(() => createOllamaClient({ dimension: DIMENSION }), /requires a model tag/);
  assert.throws(() => createOllamaClient({ model: 'x' }), /requires an integer dimension/);
});
