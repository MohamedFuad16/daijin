// initBrain, wired to init-miner's pipeline.
//
// Driven IN PROCESS with injected dependencies rather than over the pipe, because a real
// run needs a live Ollama and engine/test is network-free (D-0015). What is asserted here
// is the WIRING: that the daemon builds the right call, forwards the pipeline's steps onto
// the notification channel unaltered in shape, and crosses the spend boundary before any
// work rather than inside the job. The refusals are also exercised over the real pipe in
// rpc-spend.test.js, because those are what a user meets.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRpcServer } from '../src/rpc/server.js';

const ERR_SPEND_REFUSED = -32050;
const ERR_NOT_IMPLEMENTED = -32001;

/// A server with every outside dependency injected. `calls` records what the daemon asked
/// the pipeline for, which is the thing under test.
async function harness({ pipeline, repoPath } = {}) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-init-state-'));
  const messages = [];
  const calls = [];
  let storeOptions = null;
  const served = { provider: 'ollama', model: 'test-embed', digest: 'sha256:test', dimension: 8 };

  const server = createRpcServer({
    stateRoot,
    write: (message) => messages.push(message),
    deps: {
      createEmbedderClient: (options) => ({
        options,
        async servedIdentity() { return served; },
        async embed(texts) { return texts.map(() => new Array(8).fill(0.1)); },
      }),
      embedderFromClient: (client) => ({ client, async embed(texts) { return client.embed(texts); } }),
      // Injected because the daemon resolves the STORE's identity through the retrieval
      // path's own resolver rather than the adapter's tag, and that resolver reaches the
      // live embedder. Hermetic tests supply it; the trap it avoids is in the source.
      servedIndexIdentity: async () => served,
      openStore: async (root, options) => { storeOptions = options; return { root, options, project: 'default', async close() {} }; },
      initBrain: async (options) => {
        calls.push(options);
        return pipeline ? pipeline(options) : { floor: null };
      },
      readSpendGate: async () => ({ open: false, file: '/nowhere/GATE', hint: 'blocked' }),
      // Answers, rather than throwing, because initBrain now DISCOVERS an unconfigured
      // digest from the served model: a first-boot user has none, and requiring them to run
      // `ollama list` and paste a hash before building a brain is a setup step nobody would
      // forgive. serveStatus still gets its probe refusal from the daemon's --no-probe flag.
      checkOllama: async () => ({ version: '0.0.0-test', model: 'bge-m3', digest: 'sha256:test' }),
    },
  });
  if (repoPath) await server.methods.repoAttach({ repoPath });
  return {
    server, messages, calls, stateRoot, served,
    get storeOptions() { return storeOptions; },
    steps: () => messages.filter((row) => row.method === 'step').map((row) => row.params),
    async cleanup() {
      await server.close();
      await rm(stateRoot, { recursive: true, force: true });
    },
  };
}

test('initBrain layer1 returns a jobId and streams the pipeline steps onto the channel', async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-init-repo-'));
  const context = await harness({
    repoPath,
    pipeline: async ({ onStep }) => {
      // The shape init-miner's stepper emits, forwarded rather than rewrapped.
      await onStep({ ts: 1, jobId: 'x', phase: 'identify', step: 'analyze', detail: '12 files', counts: { files: 12 }, level: 'info' });
      await onStep({ ts: 2, jobId: 'x', phase: 'evidence', step: 'imports', detail: 'graph built', counts: null, level: 'info' });
      await onStep({ ts: 3, jobId: 'x', phase: 'floor', step: 'measured', detail: '2 of 3', counts: null, level: 'info' });
      return { floor: { caseRate: { exact: 2 / 3, cases: '2 of 3' }, chosenBudget: 4000 } };
    },
  });
  try {
    const { jobId } = await context.server.methods.initBrain({ repoPath, mode: 'layer1' });
    assert.match(jobId, /^job-init-/, 'the jobId comes back immediately, before the work finishes');
    await context.server.jobs.drain();

    const steps = context.steps().filter((row) => row.jobId === jobId);
    // IDENTITY LEADS THE STREAM. D-0031 invariant 4 makes init a lifecycle contract that
    // guarantees identity first, and the stream shows the order it actually happened in
    // rather than starting at the first interesting-looking step.
    // Identity leads and the ENDING closes it. Before the terminal event existed, a
    // successful init's last event was a phase name (floor/measured), so a client could
    // observe a job ending only when it went wrong and had to infer success from an idle
    // stream.
    assert.deepEqual(steps.map((row) => row.phase), ['identity', 'identify', 'evidence', 'floor', 'done']);
    assert.deepEqual(steps.map((row) => row.step), ['manifest', 'analyze', 'imports', 'measured', 'finished']);
    const pipelineSteps = steps.slice(1, -1);
    assert.deepEqual(pipelineSteps[0].counts, { files: 12 });
    // counts is OMITTED, not sent empty, so a client can tell "no counts" from "zero".
    assert.equal(Object.hasOwn(pipelineSteps[1], 'counts'), false);
    for (const row of steps) {
      assert.equal(typeof row.ts, 'number');
      assert.ok(row.ts > 1_600_000_000_000, 'ts is restamped by the runner, so one clock owns the stream');
    }
  } finally {
    await context.cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('the daemon hands the pipeline the SERVED embedder identity, not the configured claim', async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-init-repo-'));
  const context = await harness({ repoPath });
  try {
    await context.server.methods.initBrain({ repoPath, mode: 'layer1' });
    await context.server.jobs.drain();

    assert.equal(context.calls.length, 1);
    const call = context.calls[0];
    assert.equal(call.mode, 'layer1');
    assert.equal(call.repoPath, repoPath);
    // THE IDENTITY TRAP, made into a test. The model NAME is the configured one and the
    // DIGEST is the served one, resolved through the same function retrieve uses.
    //
    // Using the adapter's notion instead would name the model by the tag it found
    // (bge-m3:latest) while retrieval names it by configuration (bge-m3), and
    // assertRetrievalIdentity compares the string exactly. The store would then be refused
    // by every query it was built to answer, with an error telling the user to re-ingest,
    // which would not have helped. init-miner lost a live run to exactly this.
    assert.equal(call.environment.EMBEDDING_MODEL, 'bge-m3', 'the CONFIGURED name, not the adapter tag');
    assert.equal(call.environment.EMBEDDING_MODEL_DIGEST, context.served.digest, 'the SERVED digest');
    assert.ok(call.embedder?.embed, 'the pipeline needs an embedder with embed()');
    assert.equal(call.narrator, null, 'no narrator: Layer 2 is not reachable in this build');
    // And a CONCRETE project scope: retrieval requires a non-empty project while the store
    // treats null as the whole store, so a null-project store writes documents that no
    // query selects and every gold case would miss for a reason unrelated to retrieval.
    assert.equal(context.storeOptions?.project, 'default');
  } finally {
    await context.cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('a measured floor lands in the SAME history retrievalScore writes', async () => {
  // Two sources writing two histories would give a repo card that shows half the
  // measurements that were actually taken.
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-init-repo-'));
  const context = await harness({
    repoPath,
    pipeline: async () => ({ floor: { caseRate: { exact: 0.8, cases: '4 of 5' }, chosenBudget: 6000 } }),
  });
  try {
    await context.server.methods.initBrain({ repoPath, mode: 'layer1' });
    await context.server.jobs.drain();

    // In the STATE ROOT, not the repo: the history is machine-scoped (measured by this
    // machine's embedder) and not regenerable, so it left the repo with the index but into
    // records/ rather than into the disposable index/ (D-0031, LAYOUT.md).
    const { repoLayout } = await import('../src/state/layout.js');
    const layout = await repoLayout(repoPath, { stateRoot: context.stateRoot });
    assert.ok(!layout.scoreHistoryPath.startsWith(repoPath), 'the history is not in the repo');
    assert.ok(!layout.scoreHistoryPath.startsWith(layout.indexRoot), 'and a cleared index does not take it');
    const history = JSON.parse(await readFile(layout.scoreHistoryPath, 'utf8'));
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].caseRate, { exact: 0.8, cases: '4 of 5' });
    assert.equal(history[0].chosenBudget, 6000);

    // And scoreHistory serves it, which is what the repo card renders.
    assert.deepEqual(await context.server.methods.scoreHistory({ repoPath }), history);
  } finally {
    await context.cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('a pipeline failure reaches the user on the step stream', async () => {
  // The request returned its jobId long ago, so this channel is the only place a user can
  // learn the job died.
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-init-repo-'));
  const context = await harness({
    repoPath,
    pipeline: async () => { throw new Error('the evidence pass exploded'); },
  });
  try {
    await context.server.methods.initBrain({ repoPath, mode: 'layer1' });
    await context.server.jobs.drain();
    const failure = context.steps().find((row) => row.step === 'failed');
    assert.ok(failure, 'a pipeline failure must reach the stream');
    assert.equal(failure.level, 'error');
    assert.match(failure.detail, /exploded/);
  } finally {
    await context.cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('mode ingest is refused BEFORE a job starts, naming why', async () => {
  // The pipeline throws for ingest too, but only after its analyze pass, so a user would
  // watch a job start and then fail. This refusal is the one they meet.
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-init-repo-'));
  const context = await harness({ repoPath });
  try {
    await assert.rejects(
      context.server.methods.initBrain({ repoPath, mode: 'ingest' }),
      (error) => {
        assert.equal(error.code, ERR_NOT_IMPLEMENTED);
        assert.match(error.data.phase, /^P3/);
        assert.match(error.data.hint, /overwrite your work with machine output/);
        return true;
      },
    );
    assert.equal(context.calls.length, 0, 'no job ran');
    assert.deepEqual(context.steps(), [], 'and nothing was streamed');
  } finally {
    await context.cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('layer1+layer2 crosses the spend boundary before any work', async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-init-repo-'));
  const context = await harness({ repoPath });
  try {
    await assert.rejects(
      context.server.methods.initBrain({ repoPath, mode: 'layer1+layer2' }),
      (error) => { assert.equal(error.code, ERR_SPEND_REFUSED); return true; },
    );
    assert.equal(context.calls.length, 0, 'the refusal happened before the pipeline was called');
    assert.deepEqual(context.steps(), [], 'a refusal must not look like a job that started');

    // Confirmed, it reaches the pipeline, which refuses Layer 2 itself for want of a
    // narrator. Two boundaries: the user-facing one here, the structural one there.
    await context.server.methods.initBrain({ repoPath, mode: 'layer1+layer2', confirm: true, budget: { estimatedTokens: 90_000 } });
    await context.server.jobs.drain();
    assert.equal(context.calls.length, 1);
    assert.equal(context.calls[0].narrator, null);
    assert.equal(context.calls[0].confirmedBudget, 90_000, 'the budget the user saw travels to the pipeline');
  } finally {
    await context.cleanup();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('initBrain on an unattached repo does not start a job', async () => {
  const context = await harness({});
  try {
    await assert.rejects(
      context.server.methods.initBrain({ repoPath: '/definitely/not/attached', mode: 'layer1' }),
      (error) => { assert.equal(error.code, -32602); return true; },
    );
    assert.equal(context.calls.length, 0);
  } finally {
    await context.cleanup();
  }
});

// ---- the mechanical clusterer ------------------------------------------------------------

test('clusterCases attributes a miss to the MISSED DOCUMENT, not to the query', async () => {
  // The distinction is the whole value. "architecture units are being missed" is
  // actionable; "queries about storage missed" is not, and an earlier version of this
  // reported the query's inferred area under the name `area`, which reads as the first
  // while being the second.
  const { clusterCases } = await import('../src/rpc/methods.js');
  const inventory = new Map([
    ['arch.overview', { type: 'architecture', area: 'rag' }],
    ['adr.0040', { type: 'decision', area: 'store' }],
  ]);
  const results = [
    { id: 'g001', complete: false, reciprocalRank: 0, misses: ['arch.overview'], identifier: false },
    { id: 'g002', complete: false, reciprocalRank: 0, misses: ['adr.0040'], identifier: true },
    { id: 'g003', complete: true, reciprocalRank: 0.5, misses: [], identifier: false },
  ];
  const arms = new Map([['g001', 'semantic'], ['g002', 'lexical']]);
  const report = clusterCases(results, inventory, arms);

  assert.deepEqual(report.misses, ['g001', 'g002']);
  assert.equal(report.perCase.find((row) => row.caseId === 'g001').type, 'architecture');
  assert.equal(report.perCase.find((row) => row.caseId === 'g001').area, 'rag');
  assert.equal(report.perCase.find((row) => row.caseId === 'g003').rank, 2, 'a hit reports the rank it came back at');
  assert.deepEqual(report.clusters.byType, [{ value: 'architecture', count: 1 }, { value: 'decision', count: 1 }]);
  assert.deepEqual(report.clusters.byArm, [{ value: 'lexical', count: 1 }, { value: 'semantic', count: 1 }]);
  assert.equal(report.identifierMisses, 1, 'identifier misses are counted separately; they are the lexical arm failing');
});

test('an unattributable miss is named, not hidden', async () => {
  // "unknown" folded into a real bucket hides how much of a diagnosis could not be
  // attributed, which is the number a reader needs most before acting on it.
  const { clusterCases } = await import('../src/rpc/methods.js');
  const report = clusterCases(
    [{ id: 'g001', complete: false, reciprocalRank: 0, misses: ['gone.missing'], identifier: false }],
    new Map(),
    new Map(),
  );
  assert.deepEqual(report.clusters.byType, [{ value: 'unattributed', count: 1 }]);
  assert.deepEqual(report.clusters.byArm, [{ value: 'unattributed', count: 1 }]);
  assert.equal(report.perCase[0].missed, 'gone.missing', 'and the id it failed on is still named');
});

test('clusters are ordered by count, so the biggest problem reads first', async () => {
  const { clusterCases } = await import('../src/rpc/methods.js');
  const inventory = new Map([
    ['a', { type: 'architecture', area: 'x' }],
    ['b', { type: 'architecture', area: 'y' }],
    ['c', { type: 'decision', area: 'x' }],
  ]);
  const report = clusterCases(
    ['a', 'b', 'c'].map((id, index) => ({ id: `g00${index}`, complete: false, reciprocalRank: 0, misses: [id], identifier: false })),
    inventory,
    new Map(),
  );
  assert.deepEqual(report.clusters.byType, [{ value: 'architecture', count: 2 }, { value: 'decision', count: 1 }]);
});

test('the clusterer carries its denominator, so an empty cluster can be read correctly', async () => {
  // init-miner's live P3 run is the argument: 25 of 25 on an 11-document corpus, where a
  // permuted control with every answer deliberately wrong still scored 18 of 25 because
  // k=8 returns most of the corpus whatever the ranking. On a gauge that small an empty
  // miss-cluster is not evidence retrieval is healthy, so the count travels with it.
  const { clusterCases } = await import('../src/rpc/methods.js');
  const allPassing = clusterCases(
    Array.from({ length: 25 }, (unused, index) => ({ id: `g${index}`, complete: true, reciprocalRank: 1, misses: [], identifier: false })),
    new Map(),
    new Map(),
  );
  assert.deepEqual(allPassing.misses, []);
  assert.deepEqual(allPassing.clusters.byType, [], 'nothing missed, so nothing to cluster');
  assert.equal(allPassing.cases, 25, 'and the denominator is right there to size the emptiness');
  assert.equal(allPassing.hits, 25);
});
