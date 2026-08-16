// diagnose's OPT-IN control arm: how much range the gauge has on this corpus.
//
// The question it answers is not "did retrieval do well" but "could this corpus tell me if
// it had not". init-miner measured a permuted gold set, every answer deliberately wrong,
// scoring 18 of 25 against a real 25 of 25, because k=8 returns most of an 11-document
// brain whatever is asked. A case rate read without that number is read without its error
// bar.
//
// Opt in, never a default: the arm doubles the wall clock of an interactive call.
//
// Hermetic. scoreGoldset is injected, so nothing here needs an embedder or a network.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import YAML from 'yaml';

import { createMethods, measureDiscriminatingRange } from '../src/rpc/methods.js';
import { JobRunner } from '../src/rpc/jobs.js';
import { EngineState } from '../src/rpc/state.js';
import { createSqliteStore } from '../src/store/sqlite.js';

const CASES = [
  { id: 'g001', query: 'where does storage live', must_return: ['doc.a'] },
  { id: 'g002', query: 'why did the mount change', must_return: ['doc.b'] },
  { id: 'g003', query: 'what replaced it', must_return: ['doc.c'] },
];

/// A repo with an indexed brain and a gold set on disk.
async function fixture({ cases = CASES } = {}) {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'dj-diag-'));
  await mkdir(path.join(repoPath, '.daijin', 'brain'), { recursive: true });
  const store = await createSqliteStore({
    repoPath,
    project: 'default',
    embedder: { provider: 'ollama', model: 'bge-m3', digest: 'sha256:test', dimension: 4 },
  });
  await store.transaction(async () => {
    for (const id of ['doc.a', 'doc.b', 'doc.c']) {
      await store.upsertDocument({
        id, project: 'default', type: 'decision', path: `brain/${id}.md`, title: id,
        tags: [], meta: { area: 'storage' }, content: `content of ${id}`, contentHash: null,
      });
      // Chunks with vectors: the embedder identity is recorded by INDEXING, so a brain with
      // documents and no chunks reads as never indexed, which is what diagnose refuses on.
      await store.replaceChunks(id, [{ ordinal: 0, content: `content of ${id}`, vector: [1, 0, 0, 0] }]);
    }
  });
  await store.close();
  await writeFile(path.join(repoPath, '.daijin', 'goldset.yaml'), YAML.stringify(cases), 'utf8');
  return repoPath;
}

/// A scoreGoldset stub that reports every case complete for the real gold set and, for a
/// permuted one, only the fraction asked for. The arms are told apart by the file they are
/// pointed at, which is the same way the real function tells them apart.
function stubScore({ permutedHits = 1, seen = [] } = {}) {
  return async ({ corpus, k, retrieveOptions }) => {
    const cases = YAML.parse(await readFile(corpus.goldsetPath, 'utf8'));
    seen.push({ goldsetPath: corpus.goldsetPath, k, tokenBudget: retrieveOptions?.tokenBudget, cases });
    const permuted = corpus.id === 'permuted-control';
    const results = cases.map((entry, index) => ({
      id: entry.id,
      complete: permuted ? index < permutedHits : true,
      misses: [],
      documents: entry.must_return,
    }));
    const hits = results.filter((row) => row.complete).length;
    return {
      results,
      diagnostics: [],
      summary: {
        cases: results.length,
        caseRate: hits / results.length,
        mrr: permuted ? 0.4 : 0.9,
        violations: 0,
        identifierCaseRate: 1,
      },
      record: {},
    };
  };
}

async function methodsOver(repoPath, score) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dj-diag-state-'));
  const state = new EngineState({ stateRoot });
  await state.attachRepo(repoPath);
  const methods = createMethods({ state, jobs: new JobRunner({ notify: () => {} }), deps: { scoreGoldset: score } });
  return { methods, cleanup: () => rm(stateRoot, { recursive: true, force: true }) };
}

test('the control arm is OFF unless asked for, and its absence is not a measured zero', async () => {
  // A caller that renders a range has to be able to tell "not measured" from "measured and
  // found to be nothing", so the unmeasured case carries no numbers at all.
  const repoPath = await fixture();
  const seen = [];
  const { methods, cleanup } = await methodsOver(repoPath, stubScore({ seen }));
  try {
    const result = await methods.diagnose({ repoPath });
    assert.equal(result.discriminatingRange, null);
    assert.equal(result.controlSkipped, null);
    assert.equal(seen.length, 1, 'exactly one arm ran: the control doubles an interactive call and was not asked for');
  } finally {
    await cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('control: true measures the range against a permuted arm on the same settings', async () => {
  const repoPath = await fixture();
  const seen = [];
  // 2 of 3 permuted against 3 of 3 real: a gauge with one case of headroom, which is the
  // shape that says the number above it is nearly meaningless.
  const { methods, cleanup } = await methodsOver(repoPath, stubScore({ permutedHits: 2, seen }));
  try {
    const result = await methods.diagnose({ repoPath, control: true });
    assert.equal(seen.length, 2, 'two arms');
    assert.equal(result.controlSkipped, null);
    assert.equal(result.discriminatingRange.caseRate.candidate, '3 of 3');
    assert.equal(result.discriminatingRange.caseRate.control, '2 of 3');
    assert.equal(result.discriminatingRange.caseRate.casesOfHeadroom, 1);
    assert.ok(Math.abs(result.discriminatingRange.mrr.range - 0.5) < 1e-9);

    // ONLY the answers differ between the arms. Anything else varying would make the range
    // a measurement of that difference rather than of the gauge.
    const [candidate, control] = seen;
    assert.equal(candidate.k, control.k);
    assert.equal(candidate.tokenBudget, control.tokenBudget);
    assert.deepEqual(candidate.cases.map((row) => row.query), control.cases.map((row) => row.query),
      'every query is kept');
    assert.ok(control.cases.every((row, index) => row.must_return[0] !== candidate.cases[index].must_return[0]),
      'and every answer is deliberately wrong');
  } finally {
    await cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('the permuted gold set is never written beside the real one', async () => {
  // A file of deliberately wrong answers sitting in the user's repo is one mistaken read
  // away from becoming the thing that measures them. It lives in a temp directory and the
  // directory is removed afterwards.
  const repoPath = await fixture();
  const seen = [];
  const { methods, cleanup } = await methodsOver(repoPath, stubScore({ seen }));
  try {
    await methods.diagnose({ repoPath, control: true });
    const permutedPath = seen[1].goldsetPath;
    assert.ok(!permutedPath.startsWith(repoPath), `the permuted file must not live in the repo: ${permutedPath}`);
    await assert.rejects(readFile(permutedPath, 'utf8'), 'and it is cleaned up');

    const onDisk = YAML.parse(await readFile(path.join(repoPath, '.daijin', 'goldset.yaml'), 'utf8'));
    assert.deepEqual(onDisk, CASES, 'the real gold set is untouched');
  } finally {
    await cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('a corpus too small to permute is REPORTED, not thrown, so the clusters survive', async () => {
  // Fewer than two distinct answers cannot be permuted. That is a fact about the corpus,
  // and killing the whole diagnosis over an optional arm would punish the caller for asking
  // the harder question.
  const repoPath = await fixture({ cases: [{ id: 'g001', query: 'only one', must_return: ['doc.a'] }] });
  const { methods, cleanup } = await methodsOver(repoPath, stubScore({}));
  try {
    const result = await methods.diagnose({ repoPath, control: true });
    assert.equal(result.discriminatingRange, null);
    assert.match(result.controlSkipped, /at least two distinct answers/);
    assert.ok(result.caseRate, 'the diagnosis itself still answers');
  } finally {
    await cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('control is opt in by the literal true, not by anything truthy', async () => {
  // A string, a 1 or an object arriving from a client that guessed the shape must not
  // silently double the cost of an interactive call.
  const repoPath = await fixture();
  const seen = [];
  const { methods, cleanup } = await methodsOver(repoPath, stubScore({ seen }));
  try {
    for (const value of ['true', 1, {}, 'yes']) {
      await methods.diagnose({ repoPath, control: value });
    }
    assert.equal(seen.length, 4, 'one arm per call, never two');
  } finally {
    await cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('measureDiscriminatingRange cleans its temp directory even when the arm throws', async () => {
  const repoPath = await fixture();
  const goldsetPath = path.join(repoPath, '.daijin', 'goldset.yaml');
  let usedPath = null;
  try {
    await assert.rejects(measureDiscriminatingRange({
      run: { summary: { cases: 3, caseRate: 1, mrr: 0.9, violations: 0 }, results: [{ complete: true }] },
      goldsetPath,
      store: null,
      environment: {},
      k: 8,
      tokenBudget: 4000,
      score: async ({ corpus }) => { usedPath = corpus.goldsetPath; throw new Error('the embedder is down'); },
    }), /the embedder is down/);
    assert.ok(usedPath, 'the arm was attempted');
    await assert.rejects(readFile(usedPath, 'utf8'), 'and the temp file is gone regardless');
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
