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
import { repoLayout } from '../src/state/layout.js';
import { createSqliteStore } from '../src/store/sqlite.js';

const CASES = [
  { id: 'g001', query: 'where does storage live', must_return: ['doc.a'] },
  { id: 'g002', query: 'why did the mount change', must_return: ['doc.b'] },
  { id: 'g003', query: 'what replaced it', must_return: ['doc.c'] },
];

/// A repo with a gold set in it and an index in the state root, which is where the index
/// lives after D-0031.
async function fixture({ cases = CASES } = {}) {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'dj-diag-'));
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dj-diag-state-'));
  await mkdir(path.join(repoPath, '.daijin', 'brain'), { recursive: true });
  const layout = await repoLayout(repoPath, { stateRoot, ensure: true });
  await mkdir(layout.indexRoot, { recursive: true });
  const store = await createSqliteStore({
    path: layout.databasePath,
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
  await writeFile(layout.goldsetPath, YAML.stringify(cases), 'utf8');
  return { repoPath, stateRoot, layout };
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

async function methodsOver({ repoPath, stateRoot }, score) {
  const state = new EngineState({ stateRoot });
  await state.attachRepo(repoPath);
  const methods = createMethods({ state, jobs: new JobRunner({ notify: () => {} }), deps: { scoreGoldset: score } });
  return { methods, cleanup: async () => {} };
}

test('the control arm is OFF unless asked for, and its absence is not a measured zero', async () => {
  // A caller that renders a range has to be able to tell "not measured" from "measured and
  // found to be nothing", so the unmeasured case carries no numbers at all.
  const repo = await fixture();
  const { repoPath } = repo;
  const seen = [];
  const { methods, cleanup } = await methodsOver(repo, stubScore({ seen }));
  try {
    const result = await methods.diagnose({ repoPath });
    assert.equal(result.discriminatingRange, null);
    assert.equal(result.controlSkipped, null);
    assert.equal(seen.length, 1, 'exactly one arm ran: the control doubles an interactive call and was not asked for');
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('control: true measures the range against a permuted arm on the same settings', async () => {
  const repo = await fixture();
  const { repoPath } = repo;
  const seen = [];
  // 2 of 3 permuted against 3 of 3 real: a gauge with one case of headroom, which is the
  // shape that says the number above it is nearly meaningless.
  const { methods, cleanup } = await methodsOver(repo, stubScore({ permutedHits: 2, seen }));
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
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('the permuted gold set is never written beside the real one', async () => {
  // A file of deliberately wrong answers sitting in the user's repo is one mistaken read
  // away from becoming the thing that measures them. It lives in a temp directory and the
  // directory is removed afterwards.
  const repo = await fixture();
  const { repoPath } = repo;
  const seen = [];
  const { methods, cleanup } = await methodsOver(repo, stubScore({ seen }));
  try {
    await methods.diagnose({ repoPath, control: true });
    const permutedPath = seen[1].goldsetPath;
    assert.ok(!permutedPath.startsWith(repoPath), `the permuted file must not live in the repo: ${permutedPath}`);
    await assert.rejects(readFile(permutedPath, 'utf8'), 'and it is cleaned up');

    const onDisk = YAML.parse(await readFile(repo.layout.goldsetPath, 'utf8'));
    assert.deepEqual(onDisk, CASES, 'the real gold set is untouched');
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('a corpus too small to permute is REPORTED, not thrown, so the clusters survive', async () => {
  // Fewer than two distinct answers cannot be permuted. That is a fact about the corpus,
  // and killing the whole diagnosis over an optional arm would punish the caller for asking
  // the harder question.
  const repo = await fixture({ cases: [{ id: 'g001', query: 'only one', must_return: ['doc.a'] }] });
  const { repoPath } = repo;
  const { methods, cleanup } = await methodsOver(repo, stubScore({}));
  try {
    const result = await methods.diagnose({ repoPath, control: true });
    assert.equal(result.discriminatingRange, null);
    assert.match(result.controlSkipped, /at least two distinct answers/);
    assert.ok(result.caseRate, 'the diagnosis itself still answers');
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('control is opt in by the literal true, not by anything truthy', async () => {
  // A string, a 1 or an object arriving from a client that guessed the shape must not
  // silently double the cost of an interactive call.
  const repo = await fixture();
  const { repoPath } = repo;
  const seen = [];
  const { methods, cleanup } = await methodsOver(repo, stubScore({ seen }));
  try {
    for (const value of ['true', 1, {}, 'yes']) {
      await methods.diagnose({ repoPath, control: value });
    }
    assert.equal(seen.length, 4, 'one arm per call, never two');
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('measureDiscriminatingRange cleans its temp directory even when the arm throws', async () => {
  const repo = await fixture();
  const { repoPath } = repo;
  const goldsetPath = repo.layout.goldsetPath;
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
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

// ---- recall: shown wherever the floor is quoted, measured only on request ----------------
//
// The leader's ruling (2026-08-16): the TUI shows the range automatically beside any sub-75
// diagnosis, and the checkbox governs only whether the expensive arm RUNS. Those cannot be
// the same switch, so a measured range is written down and recalled, dated, with what has
// changed since.

test('a measured range is recalled on a later diagnosis that did not measure', async () => {
  const repo = await fixture();
  const { repoPath } = repo;
  const seen = [];
  const { methods, cleanup } = await methodsOver(repo, stubScore({ permutedHits: 2, seen }));
  try {
    const measured = await methods.diagnose({ repoPath, control: true });
    assert.equal(measured.discriminatingRange.fresh, true);
    assert.equal(measured.discriminatingRange.stale, false);

    const recalled = await methods.diagnose({ repoPath });
    assert.equal(seen.length, 3, 'the second call ran one arm, not two: recall is free');
    assert.equal(recalled.discriminatingRange.caseRate.control, '2 of 3', 'the same numbers come back');
    // fresh: false is the whole point. A dated measurement rendered as if it were taken now
    // is a number a reader acts on believing it describes the brain in front of them.
    assert.equal(recalled.discriminatingRange.fresh, false);
    assert.equal(recalled.discriminatingRange.stale, false, 'nothing changed, so it still applies');
    assert.match(recalled.discriminatingRange.measuredAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('a recalled range says WHAT CHANGED since it was measured', async () => {
  // A range is a property of a corpus, a gold set and the settings it was taken at. A stale
  // range shown as current is worse than no range at all.
  const repo = await fixture();
  const { repoPath } = repo;
  const { methods, cleanup } = await methodsOver(repo, stubScore({ permutedHits: 2 }));
  try {
    await methods.diagnose({ repoPath, control: true });

    // The gold set changes underneath it.
    await writeFile(repo.layout.goldsetPath,
      YAML.stringify([...CASES, { id: 'g004', query: 'a new question', must_return: ['doc.a'] }]), 'utf8');
    const afterGoldset = await methods.diagnose({ repoPath });
    assert.equal(afterGoldset.discriminatingRange.stale, true);
    assert.match(afterGoldset.discriminatingRange.staleBecause, /the gold set changed/);
    assert.ok(afterGoldset.discriminatingRange.caseRate, 'and it is still shown, disclosed rather than hidden');
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('settings moving under a stored range is disclosed by name', async () => {
  const { stalenessOf, rangeFingerprint } = await import('../src/rpc/methods.js');
  const base = rangeFingerprint({ k: 8, tokenBudget: 4000, goldset: 'a', documents: 3 });
  assert.equal(stalenessOf(base, base), null);
  assert.match(stalenessOf(base, { ...base, k: 10 }), /k moved from 8 to 10/);
  assert.match(stalenessOf(base, { ...base, tokenBudget: 6000 }), /token budget moved from 4000 to 6000/);
  assert.match(stalenessOf(base, { ...base, documents: 40 }), /3 documents to 40/);
  // Several at once are all named: a reader deciding whether to remeasure needs the whole
  // list, not the first thing that differed.
  const many = stalenessOf(base, { ...base, k: 10, documents: 40 });
  assert.match(many, /k moved/);
  assert.match(many, /documents to 40/);
  // A record with no fingerprint at all cannot be judged, and unjudgeable is stale.
  assert.match(stalenessOf(null, base), /were not recorded/);
});

test('a corrupt range file reads as NEVER MEASURED, it does not kill the diagnosis', async () => {
  // A cache that can fail a diagnosis is a liability, and null already has an honest meaning.
  const repo = await fixture();
  const { repoPath } = repo;
  const { methods, cleanup } = await methodsOver(repo, stubScore({}));
  try {
    await mkdir(repo.layout.indexRoot, { recursive: true });
    await writeFile(repo.layout.rangeFilePath, '{ not json at all', 'utf8');
    const result = await methods.diagnose({ repoPath });
    assert.equal(result.discriminatingRange, null);
    assert.ok(result.caseRate, 'the diagnosis still answers');
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('a skipped control does not overwrite a range that was measured earlier', async () => {
  // The gold set shrinking below two answers must not erase a real measurement: losing a
  // number because a later call could not take it is the cache making things worse.
  const repo = await fixture();
  const { repoPath } = repo;
  const { methods, cleanup } = await methodsOver(repo, stubScore({ permutedHits: 2 }));
  try {
    await methods.diagnose({ repoPath, control: true });
    await writeFile(repo.layout.goldsetPath,
      YAML.stringify([{ id: 'g001', query: 'only one', must_return: ['doc.a'] }]), 'utf8');

    const result = await methods.diagnose({ repoPath, control: true });
    assert.match(result.controlSkipped, /at least two distinct answers/);
    assert.ok(result.discriminatingRange, 'the earlier measurement survives');
    assert.equal(result.discriminatingRange.fresh, false);
    assert.equal(result.discriminatingRange.stale, true, 'and it is stale, because the gold set is not the one it was taken on');
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

// ---- the retrieval scope, which no injected scorer was checking ---------------------------

test('every measured corpus carries the STORE\'s project, never a null scope', async () => {
  // The defect this closes, found by pointing the daemon at a real brain rather than by a
  // test: retrievalScore and diagnose both built their corpus with `project: null`, which
  // retrieve.js refuses by name. Every unit test injects the scorer, so the refusal only
  // appeared the first time either method met an actual index, and both were dead against
  // a real repo while the suite was green.
  //
  // Asserted on the corpus rather than on the outcome, so it stays hermetic and still bites.
  const repo = await fixture();
  const { repoPath } = repo;
  const seen = [];
  const { methods, cleanup } = await methodsOver(repo, async (options) => {
    seen.push(options.corpus);
    return stubScore({})(options);
  });
  try {
    await methods.retrievalScore({ repoPath });
    await methods.diagnose({ repoPath, control: true });

    assert.equal(seen.length, 3, 'one score, one diagnose, one permuted control');
    for (const corpus of seen) {
      assert.ok(corpus.project, `${corpus.id} was measured with a null scope, which retrieve refuses`);
      assert.equal(corpus.project, 'default', 'and the scope is the store\'s own');
    }
    // The control arm shares the candidate's scope. A control measured against a different
    // project would be measuring a different index, and the range would be a number about
    // that difference rather than about the gauge.
    const [, candidate, control] = seen;
    assert.equal(control.project, candidate.project);
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('diagnoseNarrate: the auditor reads the mechanical clusters and returns a recommendation', async () => {
  // The stub reports one missed case so the prompt has something real to carry. The
  // auditor is scripted through the same deps hook the goal loop's tests use; an
  // unconfigured auditor must refuse BEFORE the free sweep re-measures anything.
  const repo = await fixture();
  const { repoPath } = repo;
  const prompts = [];
  const scoreRuns = [];
  const missScore = async ({ corpus }) => {
    scoreRuns.push(corpus.id);
    const cases = YAML.parse(await readFile(corpus.goldsetPath, 'utf8'));
    const results = cases.map((entry, index) => ({
      id: entry.id,
      complete: index !== 0,
      misses: index === 0 ? [entry.must_return[0]] : [],
      reciprocalRank: index === 0 ? 0 : 1,
      identifier: false,
      standingAssisted: false,
      documents: entry.must_return,
    }));
    return {
      results,
      diagnostics: [],
      summary: { cases: results.length, caseRate: (results.length - 1) / results.length, mrr: 0.8, violations: 0, identifierCaseRate: 1 },
      record: {},
    };
  };
  const state = new EngineState({ stateRoot: repo.stateRoot });
  await state.attachRepo(repoPath);
  const methods = createMethods({
    state,
    jobs: new JobRunner({ notify: () => {} }),
    deps: {
      scoreGoldset: missScore,
      resolveKey: async () => 'test-key',
      createRoleGenerate: () => async ({ prompt }) => {
        prompts.push(prompt);
        return { text: '  Enrich doc.a in area storage, then re-measure; the gym is premature. ' };
      },
    },
  });
  try {
    // Unconfigured auditor: refused at the call, and the sweep never ran for it.
    await assert.rejects(
      methods.diagnoseNarrate({ repoPath, confirm: true }),
      /auditor.*not configured|no provider/i,
    );
    assert.equal(scoreRuns.length, 0, 'no measurement was spent on a call that could not narrate');

    await state.patchSettings({ roles: [{ role: 'auditor', provider: 'zai', model: 'glm-5.3', keyRef: 'env:DIAG_TEST_KEY' }] });
    const { recommendation } = await methods.diagnoseNarrate({ repoPath, confirm: true });
    assert.equal(recommendation, 'Enrich doc.a in area storage, then re-measure; the gym is premature.');
    assert.equal(prompts.length, 1, 'one explicit action, one generation');
    assert.match(prompts[0], /g001: missed doc\.a/, 'the missed case rides the prompt by name');
    assert.match(prompts[0], /area storage: 1 miss/, 'the area cluster rides the prompt');
    assert.match(prompts[0], /must-not violations: 0/);
  } finally {
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});

test('recall serves the stored measurement instantly, and never re-runs the sweep', async () => {
  // A screen visit must not cost an embedding sweep. Measuring writes the full record
  // beside the history; recall reads it back stamped recalled: true, and diagnose
  // clusters over the same stored results with no scorer call at all.
  const repo = await fixture();
  const { repoPath } = repo;
  const seen = [];
  const { methods, cleanup } = await methodsOver(repo, async (options) => {
    seen.push(options.corpus.id);
    return stubScore({})(options);
  });
  try {
    const measured = await methods.retrievalScore({ repoPath });
    assert.equal(seen.length, 1, 'the real measurement ran once');
    assert.ok(!measured.recalled, 'a fresh measurement is not stamped recalled');

    const recalled = await methods.retrievalScore({ repoPath, recall: true });
    assert.equal(recalled.recalled, true);
    assert.equal(recalled.at, measured.at, 'the stored measurement keeps its own timestamp');
    assert.deepEqual(recalled.caseRate, measured.caseRate);
    assert.equal(seen.length, 1, 'recall did not re-measure');

    const diagnosis = await methods.diagnose({ repoPath, recall: true });
    assert.equal(diagnosis.recalled, true);
    assert.equal(diagnosis.cases, 3);
    assert.equal(seen.length, 1, 'diagnose recall did not re-measure either');

    // No stored record falls through to a real measurement rather than refusing.
    const { rm: rmFile } = await import('node:fs/promises');
    const { repoLayout: layoutOf } = await import('../src/state/layout.js');
    await rmFile((await layoutOf(repoPath, { stateRoot: repo.stateRoot })).lastScorePath, { force: true });
    const fresh = await methods.retrievalScore({ repoPath, recall: true });
    assert.ok(!fresh.recalled);
    assert.equal(seen.length, 2, 'with nothing stored, recall measures for real');
  } finally {
    await cleanup();
    await rm(repo.repoPath, { recursive: true, force: true });
    await rm(repo.stateRoot, { recursive: true, force: true });
  }
});
