// The cross-encoder rerank stage (D-0025).
//
// Hermetic: the ordering logic is pure, and the backend is driven with a fake fetch. No
// model, no second process, no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { retrieve } from '../src/rag/retrieve.js';
import {
  applyRerankOrder, assertRerankAllowed, DEFAULT_RERANK, normalizeRerankOptions, rerankFusedRows,
} from '../src/rag/rerank.js';
import { createLlamaServerReranker, createReranker, LLAMA_RERANK_PATH } from '../src/rag/rerank-backends.js';
import { fakeEnvironment, fakeOllama, fakeStore, makeDocument } from './helpers/fixtures.js';

const fused = (rows) => rows.map((row, index) => ({ fusedRank: index + 1, ...row }));

test('reranking is OFF by default, and stays off unless explicitly enabled', () => {
  assert.deepEqual(normalizeRerankOptions(undefined), { enabled: false, topK: 40 });
  assert.deepEqual(normalizeRerankOptions({}), { enabled: false, topK: 40 });
  // Truthy is not enabled: it becomes a default only on a measured win, so a coincidence
  // must not turn it on.
  assert.equal(normalizeRerankOptions({ enabled: 'yes' }).enabled, false);
  assert.equal(normalizeRerankOptions({ enabled: 1 }).enabled, false);
  assert.equal(normalizeRerankOptions({ enabled: true }).enabled, true);
  assert.equal(DEFAULT_RERANK.enabled, false);
  assert.throws(() => normalizeRerankOptions({ enabled: true, topK: 0 }), /topK/);
  assert.throws(() => normalizeRerankOptions({ enabled: true, topK: 500 }), /topK/);
});

test('the rerank reorders while PRESERVING the score distribution', () => {
  // The same trick fusion uses. A raw cross-encoder score written into `score` would fail
  // every absolute threshold downstream (the 0.35 pin floor, the 0.55 slot floor), because
  // those are calibrated on cosine.
  const rows = fused([
    { chunk_id: 'a', score: 0.90, semanticSimilarity: 0.90 },
    { chunk_id: 'b', score: 0.50, semanticSimilarity: 0.50 },
    { chunk_id: 'c', score: 0.40, semanticSimilarity: 0.40 },
  ]);
  const reranked = applyRerankOrder(rows, new Map([['a', 0.1], ['b', 9.9], ['c', 5.0]]));

  assert.deepEqual(reranked.map((row) => row.chunk_id), ['b', 'c', 'a'], 'reordered by rerank score');
  assert.deepEqual(reranked.map((row) => row.score), [0.90, 0.50, 0.40], 'the cosine distribution is re-laid over the new order');
  assert.deepEqual(reranked.map((row) => row.semanticSimilarity), [0.50, 0.40, 0.90],
    'raw cosine is untouched: it is the evidence the reserved-semantic champion is chosen on');
  assert.deepEqual(reranked.map((row) => row.rerankRank), [1, 2, 3]);
  assert.equal(reranked[0].rerankScore, 9.9);
});

test('a row the reranker did not score sorts below every scored row, keeping its fused order', () => {
  // Absent is not the same as scored zero, and treating it as zero would silently demote a
  // candidate the backend simply did not see.
  const rows = fused([
    { chunk_id: 'a', score: 0.9 }, { chunk_id: 'b', score: 0.8 },
    { chunk_id: 'c', score: 0.7 }, { chunk_id: 'd', score: 0.6 },
  ]);
  const reranked = applyRerankOrder(rows, new Map([['d', -5]]));
  assert.deepEqual(reranked.map((row) => row.chunk_id), ['d', 'a', 'b', 'c'],
    'the only scored row leads even on a negative score; the rest keep fused order');
  assert.equal(reranked[1].rerankScore, null);
});

test('an empty list reranks to an empty list rather than throwing', () => {
  assert.deepEqual(applyRerankOrder([], new Map()), []);
});

test('only the shortlist is scored, and the tail keeps its fused order', async () => {
  // A forward pass per candidate over a 256-row pool would pay for candidates the budget
  // was never going to fund.
  const rows = fused(Array.from({ length: 50 }, (unused, index) => ({
    chunk_id: `c${index}`, score: 1 - index / 100, chunk_content: `doc ${index}`,
  })));
  let asked = null;
  const reranker = {
    id: 'fake',
    async rerank(query, documents) { asked = documents; return documents.map((unused, index) => index); },
  };
  const result = await rerankFusedRows({ query: 'q', rows, reranker, topK: 5, now: () => 0 });

  assert.equal(asked.length, 5, 'only the shortlist reached the backend');
  assert.equal(result.scored, 5);
  assert.equal(result.rows.length, 50, 'the tail is kept, not dropped');
  // Scores ascend with index, so the shortlist reverses; the tail is untouched.
  assert.deepEqual(result.rows.slice(0, 5).map((row) => row.chunk_id), ['c4', 'c3', 'c2', 'c1', 'c0']);
  assert.deepEqual(result.rows.slice(5, 8).map((row) => row.chunk_id), ['c5', 'c6', 'c7']);
});

test('a misaligned backend response is refused rather than reordered on', async () => {
  // The embedder learned this the hard way: a response one short shifts every later
  // document onto its neighbour's score, silently.
  const rows = fused([{ chunk_id: 'a', score: 1, chunk_content: 'x' }, { chunk_id: 'b', score: 0.5, chunk_content: 'y' }]);
  const short = { id: 'fake', async rerank() { return [0.5]; } };
  await assert.rejects(rerankFusedRows({ query: 'q', rows, reranker: short }), /refusing to reorder on a misaligned response/);
});

test('the stage reports what it cost, because the knob has to display it', async () => {
  const rows = fused([{ chunk_id: 'a', score: 1, chunk_content: 'x' }]);
  let clock = 1000;
  const reranker = { id: 'llama-server:test', async rerank() { clock += 37; return [1]; } };
  const result = await rerankFusedRows({ query: 'q', rows, reranker, now: () => clock });
  assert.equal(result.latencyMs, 37, 'a stage whose price is invisible gets enabled by people who would not have paid it');
  assert.equal(result.backend, 'llama-server:test');
});

// ---- the parity guard --------------------------------------------------------------------

test('a parity-mode store REFUSES to rerank', () => {
  // Off-by-default is a claim about configuration. This is a claim about the code, and it
  // is what keeps P1's byte-for-byte measurement measuring the same thing.
  assert.throws(() => assertRerankAllowed({ parityMode: true }), /Refusing to rerank on a parity-mode store/);
  assert.doesNotThrow(() => assertRerankAllowed({ parityMode: false }));
  assert.doesNotThrow(() => assertRerankAllowed({}));
});

test('retrieve refuses to rerank a parity store even when asked', async () => {
  const store = fakeStore({ documents: [makeDocument({ project: 'demo' })], chunks: [] });
  store.parityMode = true;
  await assert.rejects(
    retrieve({ query: 'q', project: 'demo', rerank: { enabled: true } }, {
      store, environment: fakeEnvironment(), fetchImpl: fakeOllama(), reranker: { id: 'x', async rerank() { return []; } },
    }),
    /parity-mode store/,
  );
});

test('retrieve does not rerank unless asked, and says so in meta', async () => {
  const documents = [makeDocument({ id: 'a', project: 'demo', tags: ['storage'] })];
  const chunks = [{ id: 1, documentId: 'a', ordinal: 0, content: 'storage text', score: 0.8 }];
  let called = false;
  const reranker = { id: 'x', async rerank(query, docs) { called = true; return docs.map(() => 1); } };

  const off = await retrieve({ query: 'storage', project: 'demo' }, {
    store: fakeStore({ documents, chunks }), environment: fakeEnvironment(), fetchImpl: fakeOllama(), reranker,
  });
  assert.equal(called, false, 'a supplied backend is not enough; it has to be asked for');
  assert.equal(off.meta.rerank, null, 'null distinguishes "off" from "ran and cost nothing"');

  const on = await retrieve({ query: 'storage', project: 'demo', rerank: { enabled: true, topK: 5 } }, {
    store: fakeStore({ documents, chunks }), environment: fakeEnvironment(), fetchImpl: fakeOllama(), reranker,
  });
  assert.equal(called, true);
  assert.equal(on.meta.rerank.backend, 'x');
  assert.equal(on.meta.rerank.topK, 5);
  assert.equal(typeof on.meta.rerank.latencyMs, 'number');
});

test('asking to rerank with no backend is an error, not a silent skip', async () => {
  // A silent skip would report a reranked run that never reranked, which is the shape that
  // makes an A/B meaningless.
  await assert.rejects(
    retrieve({ query: 'q', project: 'demo', rerank: { enabled: true } }, {
      store: fakeStore({ documents: [makeDocument({ project: 'demo' })], chunks: [] }),
      environment: fakeEnvironment(), fetchImpl: fakeOllama(),
    }),
    /no reranker backend was supplied/,
  );
});

// ---- the llama-server backend --------------------------------------------------------------

test('the llama-server backend posts the documented shape to the documented path', async () => {
  let seen = null;
  const reranker = createLlamaServerReranker({
    baseUrl: 'http://localhost:8080',
    fetchImpl: async (url, options) => {
      seen = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, async json() { return { results: [{ index: 0, relevance_score: 2.5 }] }; } };
    },
  });
  const scores = await reranker.rerank('a query', ['doc one']);
  assert.equal(seen.url, `http://localhost:8080${LLAMA_RERANK_PATH}`);
  assert.equal(seen.body.query, 'a query');
  assert.deepEqual(seen.body.documents, ['doc one']);
  assert.deepEqual(scores, [2.5]);
  assert.equal(reranker.id, 'llama-server:bge-reranker-v2-m3');
});

test('results are read by their index, never positionally', async () => {
  // The index field exists precisely because arrival order is not the contract. Reading
  // positionally is the misalignment class the embedder already paid for once.
  const reranker = createLlamaServerReranker({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return { results: [{ index: 2, relevance_score: 30 }, { index: 0, relevance_score: 10 }, { index: 1, relevance_score: 20 }] }; },
    }),
  });
  assert.deepEqual(await reranker.rerank('q', ['a', 'b', 'c']), [10, 20, 30]);
});

test('a partial or unreachable backend is refused with an actionable message', async () => {
  const partial = createLlamaServerReranker({
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { results: [{ index: 0, relevance_score: 1 }] }; } }),
  });
  await assert.rejects(partial.rerank('q', ['a', 'b']), /scored 1 of 2 document\(s\)/);

  const down = createLlamaServerReranker({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(down.rerank('q', ['a']), (error) => {
    assert.match(error.message, /unreachable/);
    assert.match(error.message, /llama-server --model .* --rerank --embedding --pooling rank/,
      'the error has to say how to start the thing it could not reach');
    return true;
  });

  const broken = createLlamaServerReranker({ fetchImpl: async () => ({ ok: false, status: 500, async text() { return 'boom'; } }) });
  await assert.rejects(broken.rerank('q', ['a']), /HTTP 500/);
});

test('available() reports reachability without throwing into a query', async () => {
  const up = createLlamaServerReranker({
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { results: [{ index: 0, relevance_score: 1 }] }; } }),
  });
  assert.deepEqual(await up.available(), { ok: true, hint: null });

  const down = createLlamaServerReranker({ fetchImpl: async () => { throw new Error('nope'); } });
  const status = await down.available();
  assert.equal(status.ok, false);
  assert.match(status.hint, /unreachable/);
});

test('createReranker returns null when reranking is off, and refuses an unknown backend', () => {
  assert.equal(createReranker({}), null);
  assert.equal(createReranker({ rerank: { enabled: false } }), null);
  assert.ok(createReranker({ rerank: { enabled: true } }));
  assert.throws(() => createReranker({ rerank: { enabled: true, backend: 'ollama' } }), (error) => {
    assert.match(error.message, /Ollama has no rerank endpoint, verified/,
      'the refusal carries the verification, so nobody re-litigates it from memory');
    return true;
  });
});
