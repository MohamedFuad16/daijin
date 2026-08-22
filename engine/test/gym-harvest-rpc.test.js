// gymHarvest and gymHarvestApply: the learning loop over the wire.
//
// Real ledger, real batch records, real lesson files and a real sqlite reindex; the ONLY
// fake is the teacher's generate function, because the answers are the one step that costs
// money. The funnel exercised here is the one production runs: harvestPrompt -> the
// teacher's JSON -> answersToProposals -> curateProposals -> recordHarvestBatch, and then
// applyProposals -> writeLessonUnit -> reindexFromBrain.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GymLedger, gymDatabasePath } from '../src/gym/ledger.js';
import { gymSpendGatePath } from '../src/gym/spend-gate.js';
import { harvestBatch } from '../src/gym/harvest.js';
import { createRpcServer } from '../src/rpc/server.js';
import { repoLayout } from '../src/state/layout.js';

function exam(overrides = {}) {
  return {
    examId: 'exam-0001',
    title: 'Add the missing call site',
    status: 'promoted',
    benchmarkStatus: 'active',
    heldOut: false,
    scopeTier: 'S',
    baseCommit: 'a'.repeat(40),
    goldCommit: 'b'.repeat(40),
    task: 'A task statement long enough to be a real one for the validator to accept.',
    scopeFiles: 2,
    scopeInsertions: 40,
    provenance: { source: 'commit-mining', commit: 'c'.repeat(40) },
    ...overrides,
  };
}

const AXES_ALL = Object.fromEntries(['correctness_vs_gold', 'convention_adherence', 'decision_awareness',
  'reasoning_quality', 'blast_radius_awareness'].map((name) => [name, { score: 4, citations: ['src/mod.js:1'] }]));

async function harness({
  exams = [], gateOpen = true, teacherRole = true, createTeacher = null, documents = [], realStore = false,
} = {}) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-harvest-state-'));
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-harvest-repo-'));
  await mkdir(path.join(repoPath, '.daijin'), { recursive: true });
  // A real file for the citation backstop to resolve.
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  await writeFile(path.join(repoPath, 'src', 'mod.js'), 'export const answer = 42;\nexport const twice = 84;\n', 'utf8');
  if (gateOpen) {
    await writeFile(gymSpendGatePath(repoPath),
      JSON.stringify({ status: 'authorized', scope: 'gym-cycle', reason: 'owner authorized this harvest by hand' }), 'utf8');
  }

  const seeded = GymLedger.open(gymDatabasePath(repoPath));
  for (const row of exams) seeded.putExam(row);
  seeded.close?.();

  const messages = [];
  const identity = { provider: 'ollama', model: 'bge-m3', digest: 'sha256:test', dimension: 4 };
  const server = createRpcServer({
    stateRoot,
    write: (message) => messages.push(message),
    deps: {
      checkOllama: async () => ({ digest: 'sha256:test' }),
      createEmbedderClient: () => ({}),
      embedderFromClient: () => ({ embed: async (texts) => texts.map(() => [1, 0, 0, 0]) }),
      servedIndexIdentity: async () => identity,
      ...(realStore ? {} : {
        openStore: async () => ({
          project: 'default',
          async close() {},
          async allDocuments() { return documents; },
          async indexedEmbeddingIdentity() { return identity; },
        }),
      }),
      ...(createTeacher ? { createTeacher } : {}),
    },
  });
  if (teacherRole) {
    await server.methods.settingsSet({ patch: { roles: [{ role: 'teacher', provider: 'zai', model: 'glm-5.3', keyRef: 'env:HARVEST_TEST_KEY' }] } });
  }
  const layout = await repoLayout(repoPath, { stateRoot });
  return {
    server, repoPath, stateRoot, messages, layout,
    steps: () => messages.filter((row) => row.method === 'step').map((row) => row.params),
    async attach() { await server.methods.repoAttach({ repoPath }); },
    async cleanup() {
      await server.close();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(repoPath, { recursive: true, force: true });
    },
  };
}

/// The job's own ending, or the runner's failure. The runner emits phase `done` with the
/// RESERVED step `failed` when a job throws; the harvest jobs emit their own `done` step
/// (`harvested` / `applied`) before the runner's `finished`.
async function waitForEnd(kit, jobId, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const end = kit.steps().find((event) => (
      event.jobId === jobId && event.phase === 'done' && ['harvested', 'applied', 'failed'].includes(event.step)
    ));
    if (end) return end;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`job ${jobId} never ended; last: ${JSON.stringify(kit.steps().at(-1))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/// A completed graded cycle with one run, its rubric, and its result artifact on disk.
async function seedGradedCycle(kit, {
  mode = 'experiment',
  gaps = [{ tag: 'knowledge-gap', note: 'The student did not know tax applies after the discount.' }],
  shownDocumentIds = ['web.decision.adr-0001'],
} = {}) {
  const resultFile = 'seeded-exam-0001-result.json';
  const ledger = GymLedger.open(gymDatabasePath(kit.repoPath));
  const cycleId = ledger.startCycle({ mode });
  const runId = ledger.recordRun({
    cycleId, examId: 'exam-0001', mode, status: 'completed', resultFile, applied: true,
  });
  ledger.importRubricBatch({
    mode,
    source: 'test',
    rubrics: [{
      runId,
      verdict: 'partial',
      axes: AXES_ALL,
      gaps,
      taskDigest: 'sha256:task',
      submissionDigest: 'sha256:submission',
    }],
  });
  ledger.finishCycle(cycleId, { status: 'completed' });
  ledger.close?.();

  await mkdir(kit.layout.gymResultsRoot, { recursive: true });
  await writeFile(path.join(kit.layout.gymResultsRoot, resultFile), JSON.stringify({
    timestamp: new Date().toISOString(),
    mode,
    exam: { id: 'exam-0001', task: 'A task statement long enough to be a real one for the validator to accept.' },
    status: 'completed',
    apply: { applied: true },
    student: { diff: 'diff --git a/src/mod.js b/src/mod.js\n' },
    provenance: { shownDocumentIds },
    candidate: [],
    resultFile,
  }), 'utf8');
  return { cycleId, runId };
}

const raised = async (promise) => promise.then(() => null, (error) => error);

// ---- refusals at the call, before any job exists ---------------------------------------

test('harvest is refused while the gate is blocked, before anything is read', async () => {
  const kit = await harness({ gateOpen: false, exams: [exam()] });
  try {
    await kit.attach();
    const error = await raised(kit.server.methods.gymHarvest({ repoPath: kit.repoPath, confirm: true }));
    assert.ok(error, 'a blocked gate refuses');
    assert.match(String(error.data?.hint || error.message), /blocked|gate/i);
  } finally {
    await kit.cleanup();
  }
});

test('harvest is refused without consent, past the gate', async () => {
  const kit = await harness({ exams: [exam()] });
  try {
    await kit.attach();
    const error = await raised(kit.server.methods.gymHarvest({ repoPath: kit.repoPath }));
    assert.ok(error, 'consent is never inferred');
    assert.match(String(error.data?.hint || error.message), /go ahead|confirm|consent/i);
  } finally {
    await kit.cleanup();
  }
});

test('harvest is refused when the teacher role is not configured', async () => {
  const kit = await harness({ exams: [exam()], teacherRole: false });
  try {
    await kit.attach();
    const error = await raised(kit.server.methods.gymHarvest({ repoPath: kit.repoPath, confirm: true }));
    assert.ok(error);
    assert.match(String(error.data?.hint || error.message), /teacher/i);
  } finally {
    await kit.cleanup();
  }
});

// ---- the funnel ------------------------------------------------------------------------

test('the harvest funnel end to end: questions, teacher answers, curation, a recorded batch', async () => {
  const captured = {};
  const kit = await harness({
    exams: [exam()],
    documents: [
      { id: 'web.decision.adr-0001', content: 'Tax is applied after the discount.' },
      { id: 'web.lesson.l-0001', content: 'An unrelated lesson.' },
    ],
    createTeacher: async () => ({
      identity: { role: 'teacher', model: 'test-model', endpoint: 'default' },
      generate: async ({ prompt }) => {
        captured.prompt = prompt;
        // Answer read FROM the prompt, so the prompt's content is itself asserted.
        const runId = Number(prompt.match(/runId (\d+)/)?.[1]);
        assert.ok(Number.isInteger(runId), 'the prompt names the runId the answer must bind to');
        assert.match(prompt, /what knowledge, had it been retrieved/i, 'the gap question is the platform question');
        return {
          text: JSON.stringify([{
            runId,
            gapIndex: 0,
            kind: 'new-lesson',
            concern: 'Tax is applied after the discount',
            body: 'Tax is computed on the discounted total, never the subtotal. The finance review settled this and the pricing module encodes it.',
            targetDocumentId: null,
            citations: ['src/mod.js:1'],
          }]),
        };
      },
    }),
  });
  try {
    await kit.attach();
    const { cycleId } = await seedGradedCycle(kit, {
      gaps: [
        { tag: 'knowledge-gap', note: 'The student did not know tax applies after the discount.' },
        { tag: 'model-limit', note: 'The student was shown the rule and ignored it.' },
      ],
    });
    const { jobId } = await kit.server.methods.gymHarvest({ repoPath: kit.repoPath, confirm: true });
    const end = await waitForEnd(kit, jobId);
    assert.equal(end.step, 'harvested', `the job ends harvested, not ${end.step}: ${end.detail}`);
    assert.match(end.detail, /1 question\(s\) asked, 1 lesson proposal\(s\) kept/);

    const ledger = GymLedger.open(gymDatabasePath(kit.repoPath));
    const batches = ledger.harvestBatches();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].cycleId, cycleId);
    assert.equal(batches[0].questionsAsked, 1, 'the model-limit gap asked NO question (no-write tag)');
    assert.equal(batches[0].accepted, 1);
    assert.equal(batches[0].applied, false, 'proposal-only: nothing was applied');
    const stored = ledger.getHarvestBatch(batches[0].id);
    assert.equal(stored.batch.proposals[0].kind, 'new-lesson');
    assert.equal(stored.batch.proposals[0].accepted, true);
    assert.equal(stored.batch.skippedGaps.length, 1, 'the measured no-write gap is recorded as skipped');
    ledger.close?.();

    // The gate re-blocked itself when the job ended (D-0060).
    const gate = JSON.parse(await readFile(gymSpendGatePath(kit.repoPath), 'utf8'));
    assert.equal(gate.status, 'blocked');
  } finally {
    await kit.cleanup();
  }
});

test('a citation into code that does not resolve is dropped by the backstop, and the zero is recorded', async () => {
  const kit = await harness({
    exams: [exam()],
    documents: [],
    createTeacher: async () => ({
      generate: async ({ prompt }) => ({
        text: JSON.stringify([{
          runId: Number(prompt.match(/runId (\d+)/)?.[1]),
          gapIndex: 0,
          kind: 'new-lesson',
          concern: 'A lesson citing a file that no longer exists',
          body: 'This lesson cites a path nothing can check.',
          targetDocumentId: null,
          citations: ['src/deleted.js:10'],
        }]),
      }),
    }),
  });
  try {
    await kit.attach();
    await seedGradedCycle(kit);
    const { jobId } = await kit.server.methods.gymHarvest({ repoPath: kit.repoPath, confirm: true });
    const end = await waitForEnd(kit, jobId);
    assert.equal(end.step, 'harvested');
    assert.match(end.detail, /0 lesson proposal\(s\) kept, 1 dropped/);
    const ledger = GymLedger.open(gymDatabasePath(kit.repoPath));
    const stored = ledger.getHarvestBatch(ledger.harvestBatches()[0].id);
    assert.match(stored.batch.proposals[0].droppedFor, /citation-validation: src\/deleted\.js no longer exists/);
    ledger.close?.();
  } finally {
    await kit.cleanup();
  }
});

test('a held-out run refuses harvest before any question is asked', async () => {
  const kit = await harness({
    exams: [exam({ heldOut: true })],
    createTeacher: async () => ({
      generate: async () => { throw new Error('the teacher must never be dialled for a held-out run'); },
    }),
  });
  try {
    await kit.attach();
    await seedGradedCycle(kit);
    const { jobId } = await kit.server.methods.gymHarvest({ repoPath: kit.repoPath, confirm: true });
    const end = await waitForEnd(kit, jobId);
    assert.equal(end.step, 'failed');
    assert.match(end.detail, /HELD-OUT/i);
  } finally {
    await kit.cleanup();
  }
});

test('a debug cycle has nothing to learn from, said at the job rather than hidden', async () => {
  const kit = await harness({
    exams: [exam()],
    createTeacher: async () => ({ generate: async () => ({ text: '[]' }) }),
  });
  try {
    await kit.attach();
    // A harness-debug cycle: runs exist, rubrics cannot (the ledger refuses them).
    const ledger = GymLedger.open(gymDatabasePath(kit.repoPath));
    const cycleId = ledger.startCycle({ mode: 'harness-debug' });
    ledger.recordRun({ cycleId, examId: 'exam-0001', mode: 'harness-debug', status: 'completed', resultFile: 'x.json', applied: true });
    ledger.finishCycle(cycleId, { status: 'completed' });
    ledger.close?.();

    const { jobId } = await kit.server.methods.gymHarvest({ repoPath: kit.repoPath, confirm: true });
    const end = await waitForEnd(kit, jobId);
    assert.equal(end.step, 'failed');
    assert.match(end.detail, /No completed graded cycle exists/);
  } finally {
    await kit.cleanup();
  }
});

// ---- apply, the separate act ------------------------------------------------------------

async function seedBatch(kit, { mode = 'evaluation', accepted = true } = {}) {
  const { cycleId, runId } = await seedGradedCycle(kit, { mode });
  const ledger = GymLedger.open(gymDatabasePath(kit.repoPath));
  const batchId = ledger.recordHarvestBatch(harvestBatch({
    cycleId,
    mode,
    proposals: [{
      runId,
      gapIndex: 0,
      examId: 'exam-0001',
      tag: 'knowledge-gap',
      kind: 'new-lesson',
      concern: 'Tax is applied after the discount',
      body: 'Tax is computed on the discounted total, never the subtotal.',
      targetDocumentId: null,
      citations: ['src/mod.js:1'],
      accepted,
      droppedFor: accepted ? null : 'teacher answered none',
    }],
    skipped: [],
  }));
  ledger.close?.();
  return { cycleId, runId, batchId };
}

test('apply is refused without consent', async () => {
  const kit = await harness({ exams: [exam()] });
  try {
    await kit.attach();
    const error = await raised(kit.server.methods.gymHarvestApply({ repoPath: kit.repoPath, batchId: 1 }));
    assert.ok(error);
    assert.match(String(error.data?.hint || error.message), /confirm|consent|go ahead/i);
  } finally {
    await kit.cleanup();
  }
});

test('an experiment batch never teaches the brain: apply refuses it', async () => {
  const kit = await harness({ exams: [exam()], realStore: true });
  try {
    await kit.attach();
    const { batchId } = await seedBatch(kit, { mode: 'experiment' });
    const { jobId } = await kit.server.methods.gymHarvestApply({ repoPath: kit.repoPath, batchId, confirm: true });
    const end = await waitForEnd(kit, jobId);
    assert.equal(end.step, 'failed');
    assert.match(end.detail, /only an evaluation cycle teaches the brain/);
  } finally {
    await kit.cleanup();
  }
});

test('apply writes the lesson into the brain, reindexes it, and marks the batch applied ONCE', async () => {
  const kit = await harness({ exams: [exam()], realStore: true });
  try {
    await kit.attach();
    const { batchId } = await seedBatch(kit, { mode: 'evaluation' });
    const { jobId } = await kit.server.methods.gymHarvestApply({ repoPath: kit.repoPath, batchId, confirm: true });
    const end = await waitForEnd(kit, jobId);
    assert.equal(end.step, 'applied', `apply ends applied, not ${end.step}: ${end.detail}`);
    assert.match(end.detail, /1 lesson\(s\) written/);

    // The lesson is a real brain file with the unit marker, under lessons/.
    const lessonsDir = path.join(kit.repoPath, '.daijin', 'brain', 'lessons');
    const files = await readdir(lessonsDir);
    assert.equal(files.length, 1);
    const body = await readFile(path.join(lessonsDir, files[0]), 'utf8');
    assert.match(body, /Tax is computed on the discounted total/);
    assert.match(body, /<!-- daijin /, 'the unit marker makes it a round-trippable brain unit');
    assert.match(body, /Provenance: gym run /, 'the lesson names the run that earned it');

    // The ledger records the apply, and a second apply is refused.
    const ledger = GymLedger.open(gymDatabasePath(kit.repoPath));
    const row = ledger.getHarvestBatch(batchId);
    assert.equal(row.applied, true);
    assert.equal(row.written, 1);
    ledger.close?.();

    const again = await kit.server.methods.gymHarvestApply({ repoPath: kit.repoPath, batchId, confirm: true });
    const secondEnd = await waitForEnd(kit, again.jobId);
    assert.equal(secondEnd.step, 'failed');
    assert.match(secondEnd.detail, /already been applied/);
  } finally {
    await kit.cleanup();
  }
});

test('gymStatus carries the harvest batches, applied state visible', async () => {
  const kit = await harness({ exams: [exam()] });
  try {
    await kit.attach();
    const before = await kit.server.methods.gymStatus({ repoPath: kit.repoPath });
    assert.deepEqual(before.harvest, [], 'no batch yet is an empty list, not an absence');
    const { batchId } = await seedBatch(kit, { mode: 'evaluation' });
    const status = await kit.server.methods.gymStatus({ repoPath: kit.repoPath });
    assert.equal(status.harvest.length, 1);
    assert.equal(status.harvest[0].id, batchId);
    assert.equal(status.harvest[0].applied, false, 'an unapplied batch is visibly unapplied');
    assert.equal(status.harvest[0].accepted, 1);
  } finally {
    await kit.cleanup();
  }
});
