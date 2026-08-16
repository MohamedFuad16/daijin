// The path seam after D-0031.
//
// These tests exist because the failure mode of a half-done relocation is silent: a caller
// that keeps the old join opens an empty database at the old path and reports an unindexed
// brain, which reads exactly like a repo nobody has run init on.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ensureManifest, MANIFEST_SCHEMA, noteOrigin, readManifest, repoIdFor, repoLayout, repoPaths, statePaths,
} from '../src/state/layout.js';

async function scratch() {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'dj-layout-repo-'));
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dj-layout-state-'));
  return { repoPath, stateRoot, cleanup: async () => {
    await rm(repoPath, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  } };
}

test('the index lives OUTSIDE the repo, and the brain lives inside it', async () => {
  // The whole point of D-0031 invariant 2, asserted as a path fact rather than as prose.
  const { repoPath, stateRoot, cleanup } = await scratch();
  try {
    const layout = await repoLayout(repoPath, { stateRoot, ensure: true });
    assert.ok(!layout.databasePath.startsWith(path.resolve(repoPath)), 'the index is not in the repo');
    assert.ok(layout.brainRoot.startsWith(path.resolve(repoPath)), 'the brain is');
    assert.ok(layout.manifestPath.startsWith(path.resolve(repoPath)), 'and so is the contract');
    assert.ok(layout.databasePath.startsWith(path.resolve(stateRoot)));
  } finally {
    await cleanup();
  }
});

test('disposable and kept are DIFFERENT directories, so clearing one keeps the other', async () => {
  // score-history is machine-scoped and NOT regenerable: those numbers were measured by
  // this machine's embedder on a date and nothing recomputes the past. Putting it beside
  // the index would make a cache clear destroy a trend line.
  const paths = statePaths('/state', 'repo-1');
  assert.ok(paths.databasePath.startsWith(paths.indexRoot), 'the index is inside the disposable directory');
  assert.ok(paths.rangeFilePath.startsWith(paths.indexRoot), 'and so is the range cache');
  assert.ok(paths.scoreHistoryPath.startsWith(paths.recordsRoot), 'the measurement history is not');
  assert.ok(!paths.scoreHistoryPath.startsWith(paths.indexRoot),
    'clearing the index must not take the trend line with it');
});

test('the manifest id is generated once and never regenerated', async () => {
  // A new id orphans the index and the measurement history in one move, and the user sees
  // a fresh floor with no trend behind it and no way to learn why.
  const { repoPath, stateRoot, cleanup } = await scratch();
  try {
    const first = await ensureManifest(repoPath);
    assert.equal(first.schema, MANIFEST_SCHEMA);
    assert.match(first.repoId, /[0-9a-f-]{36}/);

    // Byte-for-byte, because "the id came back the same" is satisfied by a function that
    // rewrites the file every time it is called, and rewriting a contract file on every
    // status call is a write on a read path. A mutation that removed the early return
    // survived a test that only compared the returned id.
    const before = await readFile(repoPaths(repoPath).manifestPath, 'utf8');
    const second = await ensureManifest(repoPath);
    assert.equal(second.repoId, first.repoId, 'a second init keeps the id');
    assert.equal(second.createdAt, first.createdAt, 'and does not restamp it');
    assert.equal(await readFile(repoPaths(repoPath).manifestPath, 'utf8'), before,
      'an already-initialised repo is not rewritten at all');

    // Identical bytes do not prove no write happened, so the property is tested where it is
    // observable: reading an initialised repo must not REQUIRE write permission. A user
    // whose checkout is read-only, or whose manifest is checked in and unwritable, still
    // has to be able to open their brain.
    const { chmod } = await import('node:fs/promises');
    await chmod(repoPaths(repoPath).manifestPath, 0o444);
    try {
      const readOnly = await ensureManifest(repoPath);
      assert.equal(readOnly.repoId, first.repoId, 'a read-only manifest still resolves');
    } finally {
      await chmod(repoPaths(repoPath).manifestPath, 0o644);
    }

    // A field this version does not know about survives, because a newer daijin may have
    // written it and an older one has no business dropping it.
    const extended = JSON.parse(before);
    extended.somethingNewerWrote = { keep: true };
    await writeFile(repoPaths(repoPath).manifestPath, `${JSON.stringify(extended, null, 2)}\n`, 'utf8');
    const third = await ensureManifest(repoPath);
    assert.deepEqual(third.somethingNewerWrote, { keep: true });

    const layout = await repoLayout(repoPath, { stateRoot });
    assert.equal(layout.repoId, first.repoId, 'and the state root is keyed by it');
  } finally {
    await cleanup();
  }
});

test('a repo with no manifest is still addressable, and looking at it writes NOTHING', async () => {
  // serveStatus lists repos that may never have been initialised. A status call that
  // materialises a contract file into a user's repo as a side effect of being looked at is
  // a write on a read path.
  const { repoPath, stateRoot, cleanup } = await scratch();
  try {
    const layout = await repoLayout(repoPath, { stateRoot });
    assert.match(layout.repoId, /^path-[0-9a-f]{16}$/, 'it falls back to the path');
    assert.equal(layout.manifest, null);
    await assert.rejects(readFile(layout.manifestPath, 'utf8'), 'and nothing was written');

    // Stable for as long as the repo does not move, which is exactly as good as the old
    // behaviour for a repo that was never initialised.
    assert.equal(repoIdFor(repoPath), layout.repoId);
    assert.notEqual(repoIdFor(`${repoPath}-other`), layout.repoId);
  } finally {
    await cleanup();
  }
});

test('a CORRUPT manifest is refused, never treated as a fresh repo', async () => {
  // Returning null for unparseable JSON would make init overwrite a damaged contract,
  // turning a recoverable problem into a lost one.
  const { repoPath, stateRoot, cleanup } = await scratch();
  try {
    await mkdir(repoPaths(repoPath).daijinRoot, { recursive: true });
    await writeFile(repoPaths(repoPath).manifestPath, '{ half a manifest', 'utf8');
    await assert.rejects(readManifest(repoPath), /not valid JSON/);
    await assert.rejects(repoLayout(repoPath, { stateRoot }), /not valid JSON/);
    // And the damaged bytes are still there to recover from.
    assert.equal(await readFile(repoPaths(repoPath).manifestPath, 'utf8'), '{ half a manifest');
  } finally {
    await cleanup();
  }
});

test('a moved or cloned repo is DISCLOSED rather than silently reindexed under the wrong tree', async () => {
  const { repoPath, stateRoot, cleanup } = await scratch();
  try {
    const layout = await repoLayout(repoPath, { stateRoot, ensure: true });
    const first = await noteOrigin(layout);
    assert.equal(first.moved, false, 'the first look has nothing to compare against');

    // The same manifest id, a different working tree: a move, or a second clone. From in
    // here the two are indistinguishable, which is why the report says which path it was
    // built for rather than guessing which happened.
    const elsewhere = { ...layout, repoPath: `${layout.repoPath}-clone` };
    const second = await noteOrigin(elsewhere);
    assert.equal(second.moved, true);
    assert.equal(second.from, layout.repoPath);

    const written = JSON.parse(await readFile(layout.originPath, 'utf8'));
    assert.equal(written.repoPath, elsewhere.repoPath, 'and the newest tree is recorded');
  } finally {
    await cleanup();
  }
});

test('repoLayout refuses to guess a state root', async () => {
  // The old code could compute every path from a repo path alone. If that still worked,
  // a caller that forgot to thread the state root would get the pre-D-0031 layout back and
  // nothing would fail.
  const { repoPath, cleanup } = await scratch();
  try {
    await assert.rejects(repoLayout(repoPath, {}), /requires a stateRoot/);
  } finally {
    await cleanup();
  }
});

test('the gym record and the gauge stay in the repo', async () => {
  // Not a derivation: certifications are claims, the drawn-cohort denominator is counted
  // from the result files rather than from rows, and the gold set carries per-case
  // provenance with dated retirement reasons. A gauge that vanishes with a cache is not a
  // gauge.
  const { repoPath, stateRoot, cleanup } = await scratch();
  try {
    const layout = await repoLayout(repoPath, { stateRoot });
    for (const key of ['gymDatabasePath', 'gymResultsRoot', 'goldsetPath', 'gatePath']) {
      assert.ok(layout[key].startsWith(path.resolve(repoPath)), `${key} must stay in the repo`);
    }
  } finally {
    await cleanup();
  }
});

test('DELETE THE INDEX, LOSE NOTHING: the invariant, executed', async () => {
  // D-0031 invariant 2 as an executed fact rather than a described one. Everything the
  // project knows is written into the repo, everything derived is written into index/, and
  // then index/ is removed the way a user or a bug would remove it.
  const { repoPath, stateRoot, cleanup } = await scratch();
  try {
    const layout = await repoLayout(repoPath, { stateRoot, ensure: true });

    // The project's memory, in the repo.
    await mkdir(layout.brainRoot, { recursive: true });
    await mkdir(layout.agentsRoot, { recursive: true });
    await writeFile(path.join(layout.brainRoot, 'architecture.md'), '# Architecture\n', 'utf8');
    await writeFile(path.join(layout.agentsRoot, 'student.md'), '# rules\n', 'utf8');
    await writeFile(layout.goldsetPath, '- id: g001\n', 'utf8');
    await writeFile(layout.gatePath, 'blocked\n', 'utf8');

    // The machine's view of it, outside the repo, split by whether it can be regenerated.
    await mkdir(layout.indexRoot, { recursive: true });
    await mkdir(layout.recordsRoot, { recursive: true });
    await writeFile(layout.databasePath, 'pretend-sqlite', 'utf8');
    await writeFile(layout.rangeFilePath, '{}', 'utf8');
    await writeFile(layout.scoreHistoryPath, '[]', 'utf8');

    await rm(layout.indexRoot, { recursive: true, force: true });

    for (const file of [
      path.join(layout.brainRoot, 'architecture.md'),
      path.join(layout.agentsRoot, 'student.md'),
      layout.goldsetPath,
      layout.gatePath,
      layout.manifestPath,
      // The trend line survives too: those numbers were measured on a date by a particular
      // embedder, and nothing recomputes the past.
      layout.scoreHistoryPath,
    ]) {
      await readFile(file, 'utf8');
    }
    // And the identity survives, which is what lets the rebuilt index find its own history.
    const after = await repoLayout(repoPath, { stateRoot });
    assert.equal(after.repoId, layout.repoId);
  } finally {
    await cleanup();
  }
});

test('NOTHING derived is left in the repo for the index to be deleted around', async () => {
  // The other half of the invariant: if a stray writer put a database back inside .daijin,
  // deleting the index directory would leave a second, stale one that still opens.
  const layout = repoPaths('/repo');
  const machine = statePaths('/state', 'repo-1');
  for (const value of Object.values(machine)) {
    assert.ok(!value.startsWith('/repo'), `${value} must not be inside the repo`);
  }
  assert.ok(!Object.values(layout).some((value) => value.endsWith('brain.sqlite')),
    'no database path resolves inside the repo any more');
});

// ---- init as a lifecycle contract (D-0031 invariant 4) -----------------------------------

test('init guarantees IDENTITY FIRST, before anything is built', async () => {
  // A brain built before an identity exists is written under a path-derived key and then
  // orphaned by the manifest that arrives after it, which is a fresh floor with no trend
  // behind it and no way for the user to learn why.
  const { mkdtemp: makeTemp } = await import('node:fs/promises');
  const { createRpcServer } = await import('../src/rpc/server.js');

  const repoPath = await makeTemp(path.join(tmpdir(), 'dj-lifecycle-repo-'));
  const stateRoot = await makeTemp(path.join(tmpdir(), 'dj-lifecycle-state-'));
  const messages = [];
  const served = { provider: 'ollama', model: 'test-embed', digest: 'sha256:test', dimension: 8 };
  const server = createRpcServer({
    stateRoot,
    write: (message) => messages.push(message),
    deps: {
      createEmbedderClient: () => ({ async servedIdentity() { return served; }, async embed(texts) { return texts.map(() => new Array(8).fill(0.1)); } }),
      embedderFromClient: (client) => ({ client, async embed(texts) { return client.embed(texts); } }),
      servedIndexIdentity: async () => served,
      openStore: async () => ({ project: 'default', async close() {}, async allDocuments() { return []; } }),
      initBrain: async () => ({ floor: null }),
    },
  });
  try {
    await server.methods.repoAttach({ repoPath });
    const { jobId } = await server.methods.initBrain({ repoPath, mode: 'layer1' });
    await server.jobs.drain();

    const steps = messages.filter((row) => row.method === 'step').map((row) => row.params).filter((row) => row.jobId === jobId);
    assert.equal(steps[0].phase, 'identity', 'identity leads the stream, because it happened first');
    assert.equal(steps[0].step, 'manifest');

    // And it is on disk, which is what the state root is keyed by from here on.
    const manifest = await readManifest(repoPath);
    assert.match(manifest.repoId, /[0-9a-f-]{36}/);
    const layout = await repoLayout(repoPath, { stateRoot });
    assert.equal(layout.repoId, manifest.repoId);
    // The origin record says which working tree this index belongs to, so a later move is
    // detectable rather than silently reindexed under the wrong tree.
    const origin = JSON.parse(await readFile(layout.originPath, 'utf8'));
    assert.equal(origin.repoPath, path.resolve(repoPath));

    // A SECOND working tree carrying the same manifest is a move or a clone, and from in
    // here those are indistinguishable. Either way the user hears it: two checkouts sharing
    // one index is something to discover from a message rather than from wrong answers.
    const moved = await makeTemp(path.join(tmpdir(), 'dj-lifecycle-moved-'));
    try {
      await mkdir(path.join(moved, '.daijin'), { recursive: true });
      await writeFile(path.join(moved, '.daijin', 'manifest.json'), await readFile(layout.manifestPath, 'utf8'), 'utf8');
      await server.methods.repoAttach({ repoPath: moved });
      const second = await server.methods.initBrain({ repoPath: moved, mode: 'layer1' });
      await server.jobs.drain();

      const movedSteps = messages.filter((row) => row.method === 'step').map((row) => row.params)
        .filter((row) => row.jobId === second.jobId);
      const disclosure = movedSteps.find((row) => row.step === 'moved');
      assert.ok(disclosure, 'the move is disclosed on the stream, not handled silently');
      assert.match(disclosure.detail, new RegExp(path.resolve(repoPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'and it names the tree the index was built for');
      assert.match(disclosure.detail, /history is kept/i,
        'the trend line survives a move: nothing recomputes measurements taken on a date');
    } finally {
      await rm(moved, { recursive: true, force: true });
    }
  } finally {
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('two processes resolving the same repo get the SAME index directory, after a move', async () => {
  // The property store-adapter asked for before writing against this: if the daemon derives
  // the key one way and the store another, the index goes missing in exactly the situation
  // nobody tests, a repo reached by a different path spelling or a moved checkout.
  const { indexPathFor } = await import('../src/state/layout.js');
  const { repoPath, stateRoot, cleanup } = await scratch();
  try {
    await ensureManifest(repoPath);
    const fromOne = await indexPathFor(repoPath, { stateRoot });
    const fromAnother = await indexPathFor(repoPath, { stateRoot });
    assert.equal(fromOne, fromAnother);

    // A different spelling of the same path resolves to the same index, because the key is
    // the manifest id rather than the string it was reached by.
    const spelled = path.join(repoPath, '.', '');
    assert.equal(await indexPathFor(spelled, { stateRoot }), fromOne);

    // And after a MOVE: the manifest travels with the repo, so the id does, so the index
    // and the trend line are still found. A path hash would have orphaned both.
    const moved = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-moved`);
    const { cp } = await import('node:fs/promises');
    await cp(repoPath, moved, { recursive: true });
    try {
      assert.equal(await indexPathFor(moved, { stateRoot }), fromOne,
        'a moved checkout finds the index it built');
    } finally {
      await rm(moved, { recursive: true, force: true });
    }

    await assert.rejects(indexPathFor(repoPath, {}), /requires a stateRoot/);
  } finally {
    await cleanup();
  }
});

test('a history row says WHICH CHECKOUT and WHICH BRAIN produced it', async () => {
  // store-adapter's refinement on the shared-id ruling. Clones share one repoId and
  // therefore one score history, which is the right identity: a trend is a property of the
  // project, and splitting it forks the history invisibly and permanently. The cost is that
  // two checkouts on different branches write different brains' floors into one series, and
  // a series that mixes conditions with nothing marking the change is a reporting defect
  // everywhere else in this build.
  const { indexContentDigest } = await import('../src/rpc/methods.js');

  const rows = [{ id: 'b', contentHash: 'h2' }, { id: 'a', contentHash: 'h1' }];
  const first = await indexContentDigest({ allDocuments: async () => rows });
  assert.equal(first.documents, 2);
  assert.match(first.digest, /^sha256:[0-9a-f]{16}$/);

  // Row order is the store's business. A digest that moved with it would mark every
  // rebuild of identical content as a new condition, which is the opposite of the point.
  const shuffled = await indexContentDigest({ allDocuments: async () => [...rows].reverse() });
  assert.equal(shuffled.digest, first.digest);

  // It moves when the brain moves, which is the whole job.
  const edited = await indexContentDigest({
    allDocuments: async () => [{ id: 'a', contentHash: 'h1' }, { id: 'b', contentHash: 'DIFFERENT' }],
  });
  assert.notEqual(edited.digest, first.digest);

  // A missing content hash falls back to the id alone rather than to a guess: it records
  // that the row was there without claiming to know what was in it.
  const partial = await indexContentDigest({ allDocuments: async () => [{ id: 'a' }] });
  assert.match(partial.digest, /^sha256:/);
});
