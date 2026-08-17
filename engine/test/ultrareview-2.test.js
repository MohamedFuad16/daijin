// Ultrareview run 2: seven nits, and the review's own observation about them.
//
// Findings 5, 6 and 7 were RECURRENCES of patterns this codebase had already fixed and
// documented elsewhere. The fix had propagated to a site and not to the class, so each
// test here pins the CLASS where one exists rather than the site that was reported.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cycleForWire, describeStep } from '../src/rpc/methods.js';
import { JobRunner } from '../src/rpc/jobs.js';
import { temporaryNameFor, writeFileAtomic } from '../src/runtime/atomic.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('F6 CLASS: no source builds a temp name that is only unique per process', async () => {
  // The reported sites were three. The class is "any file that writes atomically", and the
  // sweep is what turns a symptom list into a size: three were broken, one (mcp/evaluation)
  // was already safe because it used a uuid, and there was no fourth.
  //
  // Swept rather than pinned, because the next site to need an atomic write is the one this
  // test exists to catch.
  const offenders = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = await readFile(full, 'utf8');
      // A temp name built from the pid ALONE is the defect: same name for every concurrent
      // write in one process.
      for (const line of source.split('\n')) {
        if (!/\.tmp|tmp-/.test(line) || line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        if (/process\.pid/.test(line) && !/randomUUID|writeCounter|temporaryNameFor/.test(line)) {
          offenders.push(`${path.relative(SRC, full)}: ${line.trim()}`);
        }
      }
    }
  };
  await walk(SRC);
  assert.deepEqual(offenders, [], 'a per-process temp name collides between concurrent writes in one process');
});

test('F6: two writes never share a temp name, and a failed write leaves nothing behind', async () => {
  const names = new Set();
  for (let index = 0; index < 5000; index += 1) names.add(temporaryNameFor('/x/state.json'));
  assert.equal(names.size, 5000, 'unique per WRITE; the old expression produced one name for all of them');

  // The second property, which the finding did not name and all three sites also lacked: a
  // failed write must not leave its temp file next to the real one, or a transient error
  // becomes a permanent mess found long after the error scrolled away.
  const root = await mkdtemp(path.join(tmpdir(), 'dj-atomic-'));
  try {
    const removed = [];
    await assert.rejects(() => writeFileAtomic(path.join(root, 'x.json'), 'body', {
      writeFile: async () => { throw new Error('disk full'); },
      rm: async (file) => { removed.push(file); },
    }), /disk full/);
    assert.equal(removed.length, 1, 'the temp file is cleaned up');
    assert.match(removed[0], /x\.json\.tmp-/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F5: one writer owns the score history, and it does not swallow a failure', async () => {
  // retrievalScore duplicated appendScoreHistory inline, ending in `.catch(() => {})`, while
  // its own comment claimed it used the shared writer. A full disk dropped the measurement
  // silently there and failed loudly on init's path: the same failure, two behaviours.
  const source = await readFile(path.join(SRC, 'rpc', 'methods.js'), 'utf8');
  const inlineWrites = [...source.matchAll(/writeFile\(await historyFile/g)];
  assert.equal(inlineWrites.length, 0, 'nothing writes the history except appendScoreHistory');
  assert.ok(!/historyFile\(repoPath\)\), `\$\{JSON\.stringify\(history/.test(source), 'no inline copy of the writer');
});

test('F7: a cycle goes out mapped, with no ledger column names or unparsed JSON', async () => {
  const wire = cycleForWire({
    id: 3, mode: 'evaluation', trigger: 'manual', status: 'completed',
    started_at: '2026-08-17T00:00:00.000Z', finished_at: '2026-08-17T00:10:00.000Z',
    config: '{"budget":4000}', brain_version_start: 'a', brain_version_end: 'b',
  });
  assert.deepEqual(Object.keys(wire).sort(), [
    'brainVersionEnd', 'brainVersionStart', 'config', 'finishedAt', 'id', 'mode', 'startedAt', 'status', 'trigger',
  ]);
  assert.equal(Object.keys(wire).some((key) => key.includes('_')), false, 'no column names reach the wire');
  assert.deepEqual(wire.config, { budget: 4000 }, 'config is parsed; a client cannot see the storage schema');

  // A row whose config is unreadable is a fact about that row, not a reason to fail a
  // status call that is mostly about other rows.
  assert.deepEqual(cycleForWire({ id: 1, config: '{oops' }).config, {});
});

test('F1: the gym logger wrapper takes the shape the gym actually calls', async () => {
  // Every module in src/gym calls `logger.step(name, subject, detail, startedAt)`. The
  // wrapper expected an EVENT OBJECT and read `event.step`, which on a string is undefined,
  // so every gym step would have reached the feed nameless. It survived because the only
  // test of it used the wrapper's shape rather than the gym's.
  //
  // Bound to the REAL call sites: the shape is harvested from src/gym rather than asserted
  // from memory, so a change on either side fails here.
  const calls = [];
  for (const name of await readdir(path.join(SRC, 'gym'))) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(path.join(SRC, 'gym', name), 'utf8');
    for (const match of source.matchAll(/logger\.step\(\s*(['"`])/g)) calls.push(`${name}:${match[1]}`);
  }
  assert.ok(calls.length >= 4, `the gym calls logger.step positionally in ${calls.length} places`);

  // AND THE WRAPPER ITSELF IS DRIVEN, not just its formatter. The first version of this
  // test checked describeStep in isolation and harvested the call sites, and a mutation
  // reverting the wrapper to the object form PASSED it: a test named for a finding that
  // survives the finding's own regression is measuring next to the defect rather than at
  // it.
  const { createRpcServer } = await import('../src/rpc/server.js');
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dj-uv2-state-'));
  const repoPath = await mkdtemp(path.join(tmpdir(), 'dj-uv2-repo-'));
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.join(repoPath, '.daijin'), { recursive: true });
  await writeFile(path.join(repoPath, '.daijin', 'GATE'), JSON.stringify({ status: 'open', reason: 'probe authorization by hand for this test' }), 'utf8');
  // gymStart refuses a repo with no signal-carrying gate (the cycle's whole
  // measurement is baseline-vs-candidate gates), so the fixture carries one.
  await writeFile(path.join(repoPath, '.daijin', 'gates.yaml'), [
    'version: 1',
    'gates:',
    '  - id: noop',
    '    command: exit 0',
    '    enabled: true',
    '    classification: live',
  ].join('\n'), 'utf8');

  const emitted = [];
  const { GymLedger, gymDatabasePath } = await import('../src/gym/ledger.js');
  const seeded = GymLedger.open(gymDatabasePath(repoPath));
  seeded.putExam({
    examId: 'exam-0001', title: 'An exam', status: 'promoted', benchmarkStatus: 'active', heldOut: false,
    scopeTier: 'S', baseCommit: 'a'.repeat(40), goldCommit: 'b'.repeat(40),
    task: 'A task statement long enough for the validator to accept it as a real one.',
    scopeFiles: 1, scopeInsertions: 6, provenance: { source: 'commit-mining', commit: 'c'.repeat(40) },
  });
  seeded.close?.();

  const server = createRpcServer({
    stateRoot,
    write: (message) => { if (message.method === 'step') emitted.push(message.params); },
    deps: {
      createEngineer: async () => ({}),
      openStore: async () => ({ project: 'default', async close() {}, async allDocuments() { return []; }, async indexedEmbeddingIdentity() { return null; } }),
      // Calls the logger EXACTLY as src/gym does.
      runGymCycle: async ({ logger }) => {
        await logger.step('gym-sandbox', { exam: 'exam-0001' }, 'created');
        return { cycleId: 1, runs: [] };
      },
    },
  });
  try {
    await server.methods.repoAttach({ repoPath });
    await server.methods.gymStart({ repoPath, config: {}, confirm: true, budget: { estimatedTokens: 1 } });
    await server.jobs.drain();
    const gymSteps = emitted.filter((row) => row.phase === 'gym');
    assert.ok(gymSteps.length > 0, 'the cycle emitted onto the feed');
    assert.equal(gymSteps[0].step, 'gym-sandbox', 'the step is NAMED; the object-shaped wrapper made every one undefined');
    assert.match(gymSteps[0].detail, /exam=exam-0001 created/);
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(repoPath, { recursive: true, force: true });
  }

  // And the formatter handles every shape those calls pass.
  assert.equal(describeStep({ exam: 'exam-0001' }, 'created'), 'exam=exam-0001 created');
  assert.equal(describeStep({ exam: 'e' }, [{ id: 'lint', status: 'pass' }]), 'exam=e {"id":"lint","status":"pass"}');
  assert.match(describeStep({ exam: 'e' }, 'done', Date.now() - 50), /exam=e done \d+ms/);
  assert.equal(describeStep(undefined, undefined), 'step', 'never empty, so a feed line is never blank');
});

test('F2: the board-finding channel exists rather than being optional-chained away', async () => {
  // `jobs.notifyFinding?.(finding)` and `jobs.activeGymRun?.()` were calls to methods that
  // DID NOT EXIST. The optional chaining hid both: a missing method and a method that
  // returns nothing are indistinguishable through `?.`, so the call sites read as defensive
  // when they were inert. Every gym finding was discarded, including the ADR-0167 scaffold
  // warning on scored runs.
  const events = [];
  const jobs = new JobRunner({ notify: (method, params) => events.push({ method, params }), now: () => 1 });
  assert.equal(typeof jobs.notifyFinding, 'function', 'the method exists');

  jobs.notifyFinding({ ts: 1, source: 'gym', severity: 'warn', category: 'scaffold', target: 'exam-0001', evidence: 'x', status: 'open' });
  assert.equal(events.length, 1);
  assert.equal(events[0].method, 'boardFinding');
  assert.equal(events[0].params.category, 'scaffold');

  // And no CODE reaches for one of our own interfaces through optional chaining, which is
  // the shape that hid these two.
  //
  // Comments are excluded, because the first version of this assertion matched the comments
  // EXPLAINING the defect and failed on a file that no longer had it. That is the fourth
  // time I have written a source-text check that catches its own prose; the rule is that a
  // scan over source must strip what a human wrote about the source.
  const source = await readFile(path.join(SRC, 'rpc', 'methods.js'), 'utf8');
  const code = source.split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const optional = code.match(/jobs\.\w+\?\./g) ?? [];
  assert.deepEqual(optional, [], 'a missing method on our own runner must throw, not vanish');
});

test('F3: the first result of the first cycle creates its own directory', async () => {
  // `mkdir` defaulted to null while every sibling default was the real function, so the
  // directory was created only when a caller passed one and the first cycle on a fresh repo
  // wrote into a directory that did not exist. ENOENT on the first result of the first run,
  // which is the one run a new user watches.
  const { writeResultFile } = await import('../src/gym/result-files.js');
  const root = await mkdtemp(path.join(tmpdir(), 'dj-uv2-results-'));
  try {
    const directory = path.join(root, 'never', 'created', 'before');
    const written = await writeResultFile(directory, {
      exam: { id: 'exam-0001' }, timestamp: '2026-08-17T00:00:00.000Z', mode: 'harness-debug',
    });
    const back = JSON.parse(await readFile(written.file, 'utf8'));
    assert.equal(back.exam.id, 'exam-0001', 'the file is there, in a directory nobody created for it');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('F4: a gym cycle closes its ledger, not only its store', async () => {
  // The ledger was opened INLINE in the options object, where nothing held a reference to
  // close it, and the finally closed only the store. Every cycle leaked a better-sqlite3
  // handle for the life of the daemon.
  const { createRpcServer } = await import('../src/rpc/server.js');
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dj-uv2-leak-state-'));
  const repoPath = await mkdtemp(path.join(tmpdir(), 'dj-uv2-leak-repo-'));
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(path.join(repoPath, '.daijin'), { recursive: true });
  await writeFile(path.join(repoPath, '.daijin', 'GATE'), JSON.stringify({ status: 'open', reason: 'probe authorization by hand for this test' }), 'utf8');
  // gymStart refuses a repo with no signal-carrying gate (the cycle's whole
  // measurement is baseline-vs-candidate gates), so the fixture carries one.
  await writeFile(path.join(repoPath, '.daijin', 'gates.yaml'), [
    'version: 1',
    'gates:',
    '  - id: noop',
    '    command: exit 0',
    '    enabled: true',
    '    classification: live',
  ].join('\n'), 'utf8');

  const { GymLedger, gymDatabasePath } = await import('../src/gym/ledger.js');
  const seeded = GymLedger.open(gymDatabasePath(repoPath));
  seeded.putExam({
    examId: 'exam-0001', title: 'An exam', status: 'promoted', benchmarkStatus: 'active', heldOut: false,
    scopeTier: 'S', baseCommit: 'a'.repeat(40), goldCommit: 'b'.repeat(40),
    task: 'A task statement long enough for the validator to accept it as a real one.',
    scopeFiles: 1, scopeInsertions: 6, provenance: { source: 'commit-mining', commit: 'c'.repeat(40) },
  });
  seeded.close?.();

  // Every ledger this run opens, and whether it was closed.
  const opened = [];
  const server = createRpcServer({
    stateRoot,
    write: () => {},
    deps: {
      createEngineer: async () => ({}),
      openStore: async () => ({ project: 'default', async close() {}, async allDocuments() { return []; }, async indexedEmbeddingIdentity() { return null; } }),
      openLedger: (repo) => {
        const real = GymLedger.open(gymDatabasePath(repo));
        const record = { closed: false };
        opened.push(record);
        return new Proxy(real, {
          get(target, property) {
            if (property === 'close') return () => { record.closed = true; return real.close?.(); };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      runGymCycle: async () => ({ cycleId: 1, runs: [] }),
    },
  });
  try {
    await server.methods.repoAttach({ repoPath });
    await server.methods.gymStart({ repoPath, config: {}, confirm: true, budget: { estimatedTokens: 1 } });
    await server.jobs.drain();

    assert.ok(opened.length >= 1, 'the cycle opened a ledger');
    assert.deepEqual(opened.map((row) => row.closed), opened.map(() => true),
      'every ledger a cycle opens is closed; one leaked handle per cycle outlives the daemon');
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
    await rm(repoPath, { recursive: true, force: true });
  }
});
