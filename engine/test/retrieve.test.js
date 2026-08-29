import assert from 'node:assert/strict';
import test from 'node:test';

import { embedTexts, resolveServedIdentity } from '../src/rag/embed.js';
import { queryIndex, retrieve, semanticCandidateLimit, validateOptions } from '../src/rag/retrieve.js';
import { assertRetrievalIdentity } from '../src/runtime/embedding-identity.js';
import { fakeEnvironment, fakeOllama, fakeStore, makeDocument } from './helpers/fixtures.js';

test('validateOptions carries the measured defaults', () => {
  const parsed = validateOptions({ query: 'q', project: 'demo' });
  assert.equal(parsed.k, 8);
  assert.equal(parsed.tokenBudget, 4000);
  assert.equal(parsed.perCandidateCapRatio, 0.22);
  assert.deepEqual(parsed.documentAggregation, { mode: 'max' });
  assert.deepEqual(parsed.slotAllocation, { mode: 'reserved-semantic', floor: 0.55, slots: 1, championMetric: 'raw' });
  assert.deepEqual(parsed.excludeTypes, ['evaluation'], 'evaluations are excluded when the caller states no opinion');
});

test('an explicit type list turns the evaluation exclusion off', () => {
  assert.deepEqual(validateOptions({ query: 'q', project: 'demo', types: ['evaluation'] }).excludeTypes, []);
});

test('validateOptions refuses out-of-range and unsafe input', () => {
  const bad = (options, message) => assert.throws(() => validateOptions({ query: 'q', project: 'demo', ...options }), new RegExp(message));
  bad({ k: 0 }, 'k must be an integer');
  bad({ k: 51 }, 'k must be an integer');
  bad({ tokenBudget: 127 }, 'tokenBudget must be an integer');
  bad({ perCandidateCapRatio: 0.01 }, 'perCandidateCapRatio');
  bad({ types: ['nonsense'] }, 'unsupported document type');
  bad({ excludeDocumentIds: ['../etc/passwd'] }, 'safe document ids');
  bad({ slotAllocation: { mode: 'invented' } }, 'slotAllocation.mode');
  assert.throws(() => validateOptions({ project: 'demo' }), /query is required/);
  assert.throws(() => validateOptions({ query: 'q' }), /project is required/);
});

test('the ANN pool is far wider than k', () => {
  assert.equal(semanticCandidateLimit(8), 256);
  assert.equal(semanticCandidateLimit(30), 360);
});

test('queryIndex fuses all four arms, dedupes by chunk id, and keeps first-seen order', async () => {
  const documents = [
    makeDocument({ id: 'a', project: 'demo' }),
    makeDocument({ id: 'b', project: 'demo', type: 'architecture', meta: { area: 'storage', retrieval_provenance: ['run-1'] } }),
  ];
  const chunks = [
    { id: 1, documentId: 'a', ordinal: 0, content: 'alpha locking text', score: 0.8, lexRank: 0.9 },
    { id: 2, documentId: 'b', ordinal: 0, content: 'beta text', score: 0.3 },
  ];
  const store = fakeStore({ documents, chunks });
  const parsed = validateOptions({ query: 'alpha', project: 'demo' });
  const result = await queryIndex(store, [1, 0, 0, 0], parsed);

  assert.deepEqual(store.calls.map((call) => call[0]), ['semantic', 'architecture', 'lexical', 'provenance']);
  assert.equal(store.calls[0][1], 256, 'semantic arm asks for the wide pool');
  assert.equal(store.calls[2][1], 40, 'lexical arm is capped at 40');
  assert.equal(result.semanticRows.length, 2, 'the same chunk appearing on several arms is counted once');
  assert.deepEqual(result.documents.map((document) => document.id), ['a', 'b']);
});

test('the architecture arm is skipped when the caller filtered it out', async () => {
  const store = fakeStore({ documents: [makeDocument({ id: 'a', project: 'demo' })], chunks: [] });
  await queryIndex(store, [1, 0, 0, 0], validateOptions({ query: 'q', project: 'demo', types: ['decision'] }));
  assert.equal(store.calls.some((call) => call[0] === 'architecture'), false);
});

test('retrieve returns standing units outside the budget and reports both id lists', async () => {
  const documents = [
    makeDocument({ id: 'web.decision.adr-0001', project: 'demo', tags: ['storage'] }),
    // Deliberately unrelated to the query: a standing unit must arrive by pinning, not by
    // winning a similarity contest it would lose exactly when it is needed.
    makeDocument({
      id: 'global.lesson.house-rule',
      project: 'demo',
      type: 'lesson',
      title: 'House rule',
      tags: ['procedure'],
      content: 'always call the helper you declared',
    }),
  ];
  const chunks = [{ id: 1, documentId: 'web.decision.adr-0001', ordinal: 0, content: 'storage text', score: 0.8 }];
  const store = fakeStore({ documents, chunks });
  const result = await retrieve({ query: 'storage', project: 'demo' }, {
    store,
    environment: fakeEnvironment(),
    fetchImpl: fakeOllama(),
  });
  assert.deepEqual(result.meta.standingIds, ['global.lesson.house-rule']);
  assert.deepEqual(result.meta.rankedIds, ['web.decision.adr-0001']);
  assert.deepEqual(result.meta.retrievedIds, ['web.decision.adr-0001', 'global.lesson.house-rule']);
  assert.equal(result.standing[0].standing, true);
  // The standing unit's tokens are NOT charged to the task's evidence budget.
  assert.equal(result.meta.tokenCount, result.decisions[0].tokenCount);
});

test('an excluded document is removed from ranking AND from the standing pins', async () => {
  const documents = [
    makeDocument({ id: 'global.lesson.house-rule', project: 'demo', type: 'lesson' }),
    makeDocument({ id: 'web.decision.adr-0001', project: 'demo', tags: ['storage'] }),
  ];
  const chunks = [{ id: 1, documentId: 'web.decision.adr-0001', ordinal: 0, content: 'storage text', score: 0.8 }];
  const store = fakeStore({ documents, chunks });
  const result = await retrieve({ query: 'storage', project: 'demo', excludeDocumentIds: ['global.lesson.house-rule'] }, {
    store, environment: fakeEnvironment(), fetchImpl: fakeOllama(),
  });
  assert.deepEqual(result.meta.standingIds, [], 'always present is not a licence to leak an answer');
  assert.equal(result.meta.excludedDocumentCount, 1);
});

test('an identity chunk never reaches the caller as context', async () => {
  const documents = [makeDocument({ id: 'arch', project: 'demo', type: 'architecture', meta: { area: 'storage' } })];
  const chunks = [
    { id: 1, documentId: 'arch', ordinal: 0, content: 'the real first window', score: 0.4 },
    { id: 2, documentId: 'arch', ordinal: -1, content: 'IDENTITY BEACON TEXT', score: 0.9 },
  ];
  const store = fakeStore({ documents, chunks });
  const result = await retrieve({ query: 'storage', project: 'demo' }, {
    store, environment: fakeEnvironment(), fetchImpl: fakeOllama(),
  });
  const returned = [...result.chunks, ...result.decisions, ...result.lessons, ...result.exemplars];
  assert.equal(returned.length, 1);
  assert.equal(returned[0].content, 'the real first window');
  assert.ok(!JSON.stringify(result).includes('IDENTITY BEACON TEXT'));
});

test('retrieval refuses to serve an index built by a different embedder', async () => {
  const store = fakeStore({
    documents: [makeDocument({ project: 'demo' })],
    chunks: [],
    identity: { indexed: true, provider: 'ollama', model: 'other-model', digest: 'sha256:test', dimension: 4 },
  });
  await assert.rejects(
    retrieve({ query: 'q', project: 'demo' }, { store, environment: fakeEnvironment(), fetchImpl: fakeOllama() }),
    /index identity differs/,
  );
});

test('assertRetrievalIdentity rejects an unindexed or mismatched dimension', () => {
  const served = { provider: 'ollama', model: 'm', digest: 'd', dimension: 4 };
  assert.doesNotThrow(() => assertRetrievalIdentity({ indexed: true, ...served }, served));
  assert.throws(() => assertRetrievalIdentity({ indexed: false, ...served }, served), /index identity differs/);
  assert.throws(() => assertRetrievalIdentity({ indexed: true, ...served, dimension: 8 }, served), /index identity differs/);
  assert.throws(() => assertRetrievalIdentity(null, served), /index identity differs/);
});

test('the embedder refuses a short batch or a wrong dimension rather than writing them', async () => {
  const identity = { provider: 'ollama', model: 'test-embed', digest: 'sha256:test', dimension: 4 };
  const short = async () => ({ ok: true, status: 200, json: async () => ({ embeddings: [] }), text: async () => '' });
  await assert.rejects(
    embedTexts(['one'], identity, { environment: fakeEnvironment(), fetchImpl: short, batchSize: 1 }),
    /refusing to write misaligned embeddings/,
  );
  const wrongDimension = async () => ({ ok: true, status: 200, json: async () => ({ embeddings: [[1, 2]] }), text: async () => '' });
  await assert.rejects(
    embedTexts(['one'], identity, { environment: fakeEnvironment(), fetchImpl: wrongDimension, batchSize: 1 }),
    /dimension was 2; expected 4/,
  );
});

test('a served Ollama digest that drifts from the pinned one is refused', async () => {
  const identity = { provider: 'ollama', model: 'test-embed', digest: 'sha256:pinned', dimension: 4 };
  await assert.rejects(
    resolveServedIdentity(identity, { environment: fakeEnvironment(), fetchImpl: fakeOllama({ digest: 'sha256:drifted' }) }),
    /digest does not match/,
  );
});

test('embedTexts refuses a batch size that cannot advance', async () => {
  // EMBEDDING_BATCH_SIZE=0 survives the || default (the string "0" is truthy) and never
  // advances offset - an infinite loop of EMPTY requests against a possibly paid API. A
  // non-numeric value becomes NaN and exits after one empty batch, silently returning no
  // vectors. Both are refused at entry, naming the knob.
  const identity = { provider: 'ollama', model: 'bge-m3', dimension: 4 };
  const neverCalled = async () => { throw new Error('the request must never be issued'); };
  await assert.rejects(
    () => embedTexts(['one'], identity, { environment: { EMBEDDING_BATCH_SIZE: '0' }, fetchImpl: neverCalled }),
    /batch size of at least 1.*EMBEDDING_BATCH_SIZE/,
  );
  await assert.rejects(
    () => embedTexts(['one'], identity, { environment: { EMBEDDING_BATCH_SIZE: 'abc' }, fetchImpl: neverCalled }),
    /batch size of at least 1/,
  );
});
