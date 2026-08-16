// One cycle, end to end, against a scripted fake engineer and a real git repository.
//
// This is the hermetic half of the P4 acceptance check: a harness-debug cycle that draws
// exams, sandboxes them at their base commit, runs baseline gates, drives the student loop,
// reapplies the diff from a clean base, classifies the candidate gates, writes result files,
// and writes the ledger. The provider is the only thing faked, so ZERO SPEND is a property of
// the test rather than a claim about it. The live half, one harness-debug cycle against a
// real provider, is owner-gated and is not attempted here.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runExamAttempt, runGymCycle } from '../src/gym/cycle.js';
import { GymLedger } from '../src/gym/ledger.js';
import { parseExamRecord, quarantineExam } from '../src/gym/exams.js';
import { loadResultFiles } from '../src/gym/result-files.js';
import { gymSpendGatePath } from '../src/gym/spend-gate.js';
import { readDefaultAgentFile } from '../src/gym/agent-files.js';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

/** A source repository with two commits, so an exam has a real base and a real gold. */
async function makeSourceRepo(root) {
  const repo = path.join(root, 'source');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'app.js'), 'const value = 1;\n', 'utf8');
  await git(repo, ['add', 'app.js']);
  await git(repo, ['commit', '-m', 'base']);
  const baseCommit = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(path.join(repo, 'app.js'), 'const value = 1;\nexport const wired = true;\n', 'utf8');
  await git(repo, ['commit', '-am', 'gold: wire the value']);
  const goldCommit = await git(repo, ['rev-parse', 'HEAD']);
  return { repo, baseCommit, goldCommit };
}

function exam(examId, baseCommit, goldCommit, overrides = {}) {
  return parseExamRecord({
    examId,
    status: 'promoted',
    benchmarkStatus: 'active',
    heldOut: false,
    scopeTier: 'M',
    scopeFiles: 1,
    scopeInsertions: 1,
    baseCommit,
    goldCommit,
    task: 'Export a wired flag from app.js so the consumer can read one real datum across the seam.',
    provenance: { source: 'auditor-selection', commit: goldCommit },
    ...overrides,
  });
}

/** Gates as DATA. The build gate is found by its declared role, never by its command text. */
const GATES = [
  { id: 'build', role: 'build', command: 'grep -q "const value" app.js' },
  { id: 'lint', command: 'test ! -f BROKEN' },
];

/** A fake engineer that writes real files into the real sandbox it is handed. */
function fileEngineer(script) {
  const seen = [];
  return {
    seen,
    next: async (context) => {
      seen.push(context);
      const action = script[context.round - 1] || { kind: 'read', tokens: 0 };
      if (action.write) await writeFile(path.join(context.sandbox, action.write.file), action.write.content, 'utf8');
      return action;
    },
  };
}

async function withGym(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-cycle-'));
  const repoPath = path.join(root, 'repo');
  const gateFile = gymSpendGatePath(repoPath);
  const resultDir = path.join(root, 'results');
  const sandboxesRoot = path.join(root, 'sandboxes');
  await mkdir(path.dirname(gateFile), { recursive: true });
  await mkdir(resultDir, { recursive: true });
  const source = await makeSourceRepo(root);
  const rules = await readDefaultAgentFile('student');
  try {
    return await run({ root, repoPath, gateFile, resultDir, sandboxesRoot, rules, ...source });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function openGate(gateFile, reason = 'Owner authorization for the hermetic cycle test.') {
  await writeFile(gateFile, `${JSON.stringify({ status: 'open', reason }, null, 2)}\n`, 'utf8');
}

test('a full attempt: sandbox, baseline gates, student, reapply, candidate gates, result file', async () => {
  await withGym(async (context) => {
    await openGate(context.gateFile);
    const findings = [];
    const engineer = fileEngineer([
      { kind: 'edit', tokens: 100, write: { file: 'app.js', content: 'const value = 1;\nexport const wired = true;\n' } },
      { kind: 'submit', tokens: 100, explanation: 'CRITERIA AUDIT: export a wired flag. MET at app.js:2.' },
    ]);

    const result = await runExamAttempt({
      exam: exam('exam-0001', context.baseCommit, context.goldCommit),
      mode: 'harness-debug',
      gates: GATES,
      engineer,
      rules: context.rules,
      context: '<brain-context>nothing retrieved in this test</brain-context>',
      repoPath: context.repoPath,
      sourceRepo: context.repo,
      engineRoot: context.root,
      sandboxesRoot: context.sandboxesRoot,
      resultDir: context.resultDir,
      hypothesis: 'The hermetic cycle reaches a completed status with no provider call.',
      emitFinding: async (finding) => findings.push(finding),
    }, { gateFile: context.gateFile });

    assert.equal(result.status, 'completed');
    assert.equal(result.mode, 'harness-debug');
    assert.equal(result.apply.applied, true);
    assert.deepEqual(result.baseline.map((gate) => `${gate.id}:${gate.status}`), ['build:pass', 'lint:pass']);
    assert.deepEqual(result.candidate.map((gate) => `${gate.id}:${gate.classification}`), ['build:pass', 'lint:pass']);
    assert.match(result.student.diff, /export const wired = true/);
    assert.equal(result.sandboxClean, true);
    assert.deepEqual(result.foreignSandboxes, []);

    // The student was handed the shipped instruction file, and the artifact records which
    // ADR-0167 sections it actually carried.
    assert.equal(result.provenance.promptAudit.complete, true);
    assert.deepEqual(result.provenance.promptAudit.missing, []);
    assert.match(engineer.seen[0].prompt, /Completion gauge/);
    assert.match(engineer.seen[0].prompt, /Integration seam first/);
    assert.match(engineer.seen[0].prompt, /<task note="owner task data">/);
    assert.deepEqual(findings, [], 'a complete scaffold raises nothing');

    // The gate that authorized the spend is recorded with the run, not just consulted.
    assert.equal(result.provenance.gate.status, 'open');
    assert.equal(result.provenance.gate.path, context.gateFile);

    const files = await readdir(context.resultDir);
    assert.equal(files.length, 1);
    const artifact = JSON.parse(await readFile(path.join(context.resultDir, files[0]), 'utf8'));
    assert.equal(artifact.resultFile, files[0], 'the artifact records where it wrote itself');
    assert.equal(artifact.mode, 'harness-debug');
    // The sandbox is gone, and it took the student's edits with it: the gym never touches
    // the source repository's working tree.
    assert.deepEqual((await readdir(context.sandboxesRoot)).filter((name) => name !== '.gitkeep'), []);
    assert.equal(await readFile(path.join(context.repo, 'app.js'), 'utf8'), 'const value = 1;\nexport const wired = true;\n');
    assert.equal(await git(context.repo, ['status', '--porcelain']), '');
  });
});

test('a regressed gate is classified as such, and a measured regression is a different label', async () => {
  await withGym(async (context) => {
    await openGate(context.gateFile);
    const engineer = fileEngineer([
      // A CREATED file, declared: an untracked file is invisible to a worktree diff, so a
      // run whose whole contribution is a new file would otherwise seal an empty diff.
      { kind: 'edit', tokens: 100, created: ['BROKEN'], write: { file: 'BROKEN', content: 'the lint gate looks for this file\n' } },
      { kind: 'submit', tokens: 10, explanation: 'CRITERIA AUDIT: one criterion, UNMET.' },
    ]);
    const result = await runExamAttempt({
      exam: exam('exam-0002', context.baseCommit, context.goldCommit),
      mode: 'harness-debug',
      gates: GATES,
      engineer,
      rules: context.rules,
      repoPath: context.repoPath,
      sourceRepo: context.repo,
      engineRoot: context.root,
      sandboxesRoot: context.sandboxesRoot,
      resultDir: context.resultDir,
    }, { gateFile: context.gateFile });

    assert.equal(result.status, 'gates-regressed');
    assert.equal(result.candidate.find((gate) => gate.id === 'lint').classification, 'regressed');
    assert.equal(result.candidate.find((gate) => gate.id === 'build').classification, 'pass');
  });
});

test('a cap-death leaves a result file and no row, which is the denominator rule in one run', async () => {
  await withGym(async (context) => {
    await openGate(context.gateFile);
    const ledger = GymLedger.open(':memory:');
    const readingLoop = fileEngineer([
      { kind: 'read', tokens: 400 }, { kind: 'read', tokens: 400 }, { kind: 'read', tokens: 400 },
    ]);
    const result = await runExamAttempt({
      exam: exam('exam-0003', context.baseCommit, context.goldCommit),
      mode: 'harness-debug',
      gates: GATES,
      engineer: readingLoop,
      rules: context.rules,
      policy: { baseTokenCap: 1_000, tierTokenCaps: { S: 1_000, M: 1_000, L: 1_000 }, extensionStep: 500, extensionLimit: 2 },
      repoPath: context.repoPath,
      sourceRepo: context.repo,
      engineRoot: context.root,
      sandboxesRoot: context.sandboxesRoot,
      resultDir: context.resultDir,
    }, { gateFile: context.gateFile });

    assert.equal(result.status, 'unsubmitted');
    assert.equal(result.apply.applied, false);
    assert.match(result.boundedFailure, /work token cap exceeded/);
    assert.deepEqual(result.candidate, [], 'no diff means no candidate gate run to interpret');
    assert.ok(result.resultFile, 'the result file is the only durable record that this exam was drawn');

    assert.throws(() => ledger.recordRun({
      examId: 'exam-0003', mode: 'harness-debug', status: 'unsubmitted', applied: false, resultFile: result.resultFile,
    }), /never of a drawn one/);
    assert.equal(ledger.summary().rowsWritten, 0);
    ledger.close();
  });
});

test('the gate refuses before a sandbox exists, and the cycle closes the gate behind itself', async () => {
  await withGym(async (context) => {
    const engineer = fileEngineer([{ kind: 'read', tokens: 1 }]);
    const attempt = () => runExamAttempt({
      exam: exam('exam-0004', context.baseCommit, context.goldCommit),
      mode: 'harness-debug',
      gates: GATES,
      engineer,
      rules: context.rules,
      repoPath: context.repoPath,
      sourceRepo: context.repo,
      engineRoot: context.root,
      sandboxesRoot: context.sandboxesRoot,
      resultDir: context.resultDir,
    }, { gateFile: context.gateFile });

    await assert.rejects(attempt, (error) => {
      assert.equal(error.code, -32050);
      assert.equal(error.data.gate, context.gateFile);
      return true;
    });
    assert.equal(engineer.seen.length, 0, 'the student is never reached');
    assert.deepEqual(await readdir(context.sandboxesRoot).catch(() => []), [], 'and no sandbox was created');
  });
});

test('a quarantined exam is refused from execution in every mode, before the gate is even read', async () => {
  await withGym(async (context) => {
    await openGate(context.gateFile);
    const held = quarantineExam(
      exam('exam-0005', context.baseCommit, context.goldCommit),
      'Gold defect found in the audit; the reference no longer builds.',
    );
    for (const mode of ['evaluation', 'experiment', 'harness-debug']) {
      await assert.rejects(runExamAttempt({
        exam: held,
        mode,
        gates: GATES,
        engineer: fileEngineer([]),
        rules: context.rules,
        repoPath: context.repoPath,
        sourceRepo: context.repo,
        engineRoot: context.root,
        sandboxesRoot: context.sandboxesRoot,
        resultDir: context.resultDir,
      }, { gateFile: context.gateFile }), /is quarantined from execution: Gold defect/);
    }
  });
});

test('a cycle of two exams writes one row for the graded run, none for the casualty, and closes the gate', async () => {
  await withGym(async (context) => {
    await openGate(context.gateFile);
    const ledger = GymLedger.open(':memory:');
    const good = exam('exam-0006', context.baseCommit, context.goldCommit);
    const doomed = exam('exam-0007', context.baseCommit, context.goldCommit);
    ledger.putExam(good);
    ledger.putExam(doomed);

    let call = 0;
    const engineer = {
      next: async (contextIn) => {
        call += 1;
        // The first exam works and submits; the second reads until the cap kills it.
        if (contextIn.examId === 'exam-0006') {
          if (contextIn.round === 1) {
            await writeFile(path.join(contextIn.sandbox, 'app.js'), 'const value = 1;\nexport const wired = true;\n', 'utf8');
            return { kind: 'edit', tokens: 100 };
          }
          return { kind: 'submit', tokens: 10, explanation: 'CRITERIA AUDIT: wired flag exported. MET at app.js:2.' };
        }
        return { kind: 'read', tokens: 600 };
      },
      calls: () => call,
    };

    const { cycleId, attempts } = await runGymCycle({
      exams: [good, doomed],
      mode: 'harness-debug',
      ledger,
      gates: GATES,
      engineer,
      rules: context.rules,
      policy: { baseTokenCap: 1_000, tierTokenCaps: { S: 1_000, M: 1_000, L: 1_000 }, extensionStep: 500, extensionLimit: 2 },
      repoPath: context.repoPath,
      sourceRepo: context.repo,
      engineRoot: context.root,
      sandboxesRoot: context.sandboxesRoot,
      resultDir: context.resultDir,
    }, { gateFile: context.gateFile });

    assert.deepEqual(attempts.map((attempt) => attempt.status), ['completed', 'unsubmitted']);
    assert.equal(ledger.cycleRuns(cycleId, { scoredOnly: false }).length, 1, 'one row for two drawn exams');
    assert.equal(ledger.summary().scoredWrites, 0, 'a harness-debug cycle writes nothing to the scored record');

    // Two result files, one row: the gap between them IS the cap-death, and it is visible
    // rather than lost.
    const files = await readdir(context.resultDir);
    assert.equal(files.length, 2);
    assert.deepEqual(await loadResultFiles(context.resultDir), [], 'neither artifact is evaluation-mode, so neither is counted');

    // The authorization spent itself: the gate is blocked again with no hand involved.
    const gate = JSON.parse(await readFile(context.gateFile, 'utf8'));
    assert.equal(gate.status, 'blocked');
    assert.match(gate.reason, /Automatic safety closure/);
    ledger.close();
  });
});

test('mode quarantine is falsifiable on the artifacts, not just in the code', async () => {
  // The acceptance clause, checked the way a verifier would check it: run a harness-debug
  // cycle, then interrogate what it left on disk and in the ledger.
  await withGym(async (context) => {
    await openGate(context.gateFile);
    const ledger = GymLedger.open(':memory:');
    const drawn = exam('exam-0100', context.baseCommit, context.goldCommit);
    ledger.putExam(drawn);
    const { cycleId } = await runGymCycle({
      exams: [drawn],
      mode: 'harness-debug',
      ledger,
      gates: GATES,
      engineer: fileEngineer([
        { kind: 'edit', tokens: 10, write: { file: 'app.js', content: 'const value = 1;\nexport const wired = true;\n' } },
        { kind: 'submit', tokens: 10, explanation: 'CRITERIA AUDIT: wired flag exported. MET at app.js:2.' },
      ]),
      rules: context.rules,
      repoPath: context.repoPath,
      sourceRepo: context.repo,
      engineRoot: context.root,
      sandboxesRoot: context.sandboxesRoot,
      resultDir: context.resultDir,
    }, { gateFile: context.gateFile });

    // 1. The run IS recorded, and the artifact says which mode it was.
    const [name] = await readdir(context.resultDir);
    const artifact = JSON.parse(await readFile(path.join(context.resultDir, name), 'utf8'));
    assert.equal(artifact.mode, 'harness-debug');
    assert.equal(artifact.status, 'completed', 'a recorded run, not a discarded one');
    assert.equal(ledger.cycleRuns(cycleId, { scoredOnly: false }).length, 1);

    // 2. And it appears in NO scored aggregate. Every one of these is a different way to
    //    ask, because one filter honored and another forgotten is how a debug run leaks.
    const summary = ledger.summary({ cycleId });
    assert.equal(summary.mode, 'harness-debug');
    assert.equal(summary.scoredWrites, 0);
    assert.equal(summary.certifications, 0);
    assert.deepEqual(ledger.cycleRuns(cycleId), [], 'the scored view of the cycle is empty');
    assert.deepEqual(await loadResultFiles(context.resultDir), [], 'and the artifact is not a countable drawn attempt');

    // 3. Certification is refused at the mode, not merely absent by omission.
    const runId = ledger.cycleRuns(cycleId, { scoredOnly: false })[0].id;
    assert.throws(() => ledger.certify({ runId, verdict: 'pass', harness: { policy: 'adr-0167' } }),
      /may not write a certification/);
    ledger.close();
  });
});

test('a student instruction file missing an ADR-0167 section runs, and says so on the board', async () => {
  await withGym(async (context) => {
    await openGate(context.gateFile);
    const findings = [];
    const strippedRules = context.rules.split('## Completion gauge')[0];
    const result = await runExamAttempt({
      exam: exam('exam-0008', context.baseCommit, context.goldCommit),
      mode: 'evaluation',
      gates: GATES,
      engineer: fileEngineer([
        { kind: 'edit', tokens: 10, write: { file: 'app.js', content: 'const value = 2;\n' } },
        { kind: 'submit', tokens: 10, explanation: 'done' },
      ]),
      rules: strippedRules,
      repoPath: context.repoPath,
      sourceRepo: context.repo,
      engineRoot: context.root,
      sandboxesRoot: context.sandboxesRoot,
      resultDir: context.resultDir,
      emitFinding: async (finding) => findings.push(finding),
    }, { gateFile: context.gateFile });

    // The harness records rather than re-injecting: silently restoring a section the user
    // deleted would make the settings badge a lie.
    assert.equal(result.provenance.promptAudit.complete, false);
    assert.deepEqual(result.provenance.promptAudit.missing, ['completion-gauge', 'integration-first']);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warn', 'a scored run under a changed prompt is a warning, not a footnote');
    assert.equal(findings[0].category, 'prompt-scaffold');
    assert.equal(findings[0].target, 'exam-0008');
    assert.match(findings[0].evidence, /completion-gauge, integration-first/);
  });
});
