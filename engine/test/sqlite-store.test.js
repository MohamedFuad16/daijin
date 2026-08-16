// SQLite backend specifics: the one file per repo layout, the checksummed migration
// ledger, the meta identity the health gate reads, and the mutation tests that prove
// those gates can fail.
//
// Soundness rule from the plan's gate inventory: no gate ships without a mutation test
// demonstrating it CAN fail. The digest tests below are that demonstration, and the
// identity tests show the assert firing on a swapped embedder rather than only on a
// happy path.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { cosineSimilarity } from '../../adapters/sqlite/vec.js';
import {
  META_KEYS,
  MIGRATIONS,
  SqliteStore,
  STANDING_ID_PREFIX,
  chunkIdFor,
  createSqliteStore,
} from '../src/store/sqlite.js';
import { indexPathFor, repoLayout } from '../src/state/layout.js';

const DIMENSION = 8;
const roots = [];

process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repoRoot() {
  const root = mkdtempSync(join(tmpdir(), 'daijin-repo-'));
  roots.push(root);
  return root;
}

// The index left the repo (D-0031), so a fixture needs a state root as well as a repo.
function stateRoot() {
  const root = mkdtempSync(join(tmpdir(), 'daijin-state-'));
  roots.push(root);
  return root;
}

// Every fixture vector is distinct. Exact ties are not a realistic embedder output and
// they are resolved by the vector index's own scan order once k truncates the tied set,
// which would make a ranking assertion a coin flip rather than a check.
function unitVector(index) {
  const vector = new Array(DIMENSION).fill(0.05);
  vector[index % DIMENSION] = 1;
  vector[(index + 3) % DIMENSION] = 0.2 + (index % 7) / 20;
  vector[(index + 5) % DIMENSION] = 0.01 * (index + 1);
  return vector;
}

async function freshStore(options = {}) {
  return createSqliteStore({
    repoPath: repoRoot(),
    stateRoot: stateRoot(),
    dimension: DIMENSION,
    embedderId: 'ollama:mxbai-embed-large@sha256-fixture',
    ...options,
  });
}

/** Write one single chunk document, the shape most of these tests need. */
async function writeDocument(store, id, content, vector, extra = {}) {
  await store.upsertDocument({
    id,
    project: extra.project,
    type: extra.type ?? 'card',
    path: extra.path ?? `agent/${id}.md`,
    title: null,
    tags: [],
    meta: { area: extra.area ?? 'rag', ...(extra.meta ?? {}) },
    content,
    contentHash: null,
  });
  await store.replaceChunks(id, [{ ordinal: 0, content, vector }]);
}

test('one index per repo, in the state root, surviving a reopen', async () => {
  const root = repoRoot();
  const state = stateRoot();
  const expected = await indexPathFor(root, { stateRoot: state });
  // Under the state root, keyed by repo identity, and NOT in the working tree.
  assert.ok(expected.startsWith(join(state, 'repos')), `${expected} should live under the state root`);
  assert.equal(basename(expected), 'brain.sqlite');
  assert.ok(!expected.startsWith(root), 'the index must not sit inside the repo any more');

  const store = await createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'fixture:v1' });
  await writeDocument(store, 'a', 'the ranking arm caps any one candidate', unitVector(0));
  const digest = await store.getMeta(META_KEYS.indexDigest);
  await store.close();

  assert.ok(existsSync(expected), 'the brain file is written where brainDatabasePath says');

  const reopened = await createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'fixture:v1' });
  try {
    assert.equal(await reopened.getMeta(META_KEYS.indexDigest), digest, 'the digest survives a reopen');
    assert.equal((await reopened.allDocuments({ project: null })).length, 1);
    assert.equal((await reopened.lexicalCandidates('ranking', null, { project: null }, 5)).length, 1);
    assert.equal((await reopened.semanticCandidates(unitVector(0), { project: null }, 5)).length, 1);
    assert.equal(chunkIdFor('a', 0), 'a#0');
  } finally {
    await reopened.close();
  }
});

test('the migration ledger records what it applied and refuses an edited migration', async () => {
  const root = repoRoot();
  const state = stateRoot();
  const store = await createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'fixture:v1' });
  const identity = await store.identity();
  assert.deepEqual(identity.migrations.map((row) => row.id), MIGRATIONS.map((row) => row.id));
  assert.match(identity.migrations[0].checksum, /^[0-9a-f]{64}$/);
  await store.migrate();
  assert.deepEqual((await store.identity()).migrations.length, MIGRATIONS.length, 'migrate is idempotent');
  await store.close();

  // Rewrite the recorded checksum: that is what an edited migration looks like on the
  // next open. Applying silently would leave two schemas behind one version number.
  const raw = new Database(await indexPathFor(root, { stateRoot: state }));
  raw.prepare('UPDATE schema_migration SET checksum = ? WHERE id = ?').run('0'.repeat(64), MIGRATIONS[0].id);
  raw.close();

  await assert.rejects(
    () => createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'fixture:v1' }),
    /must not be edited/,
  );
});

test('meta carries the embedder identity and dimension the health gate reads', async () => {
  const store = await freshStore();
  try {
    assert.equal(await store.getMeta(META_KEYS.embedderId), 'ollama:mxbai-embed-large@sha256-fixture');
    assert.equal(await store.getMeta(META_KEYS.dimension), String(DIMENSION));

    const identity = await store.identity();
    assert.equal(identity.dimension, DIMENSION);
    assert.equal(identity.chunkCount, 0);
    assert.match(identity.indexDigest, /^[0-9a-f]{64}$/);
    assert.match(identity.engine.sqliteVec, /^v?\d+\.\d+\.\d+/);
    assert.equal(await store.indexedEmbeddingIdentity(), null, 'nothing indexed yet');
  } finally {
    await store.close();
  }
});

test('the identity assert fires when a brain is reopened with a different embedder', async () => {
  const root = repoRoot();
  const state = stateRoot();
  const first = await createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'ollama:model-a@digest-1' });
  await writeDocument(first, 'a', 'first embedder wrote this', unitVector(1));
  await first.close();

  await assert.rejects(
    () => createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'ollama:model-b@digest-2' }),
    /built by embedder ollama:model-a@digest-1/,
    'a swapped embedder must not silently extend an existing index',
  );
  await assert.rejects(
    () => createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION * 2, embedderId: 'ollama:model-a@digest-1' }),
    /dimension 8 does not match the configured dimension 16/,
  );

  const same = await createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'ollama:model-a@digest-1' });
  const identity = await same.indexedEmbeddingIdentity();
  assert.equal(identity.embedderId, 'ollama:model-a@digest-1');
  assert.equal(identity.dimension, DIMENSION);
  assert.equal(identity.indexed, true);
  await same.close();
});

test('a vector of the wrong width is refused rather than indexed', async () => {
  const store = await freshStore();
  try {
    await assert.rejects(
      () => writeDocument(store, 'bad', 'three floats is not eight', [1, 2, 3]),
      /does not match the index dimension/,
    );
    await assert.rejects(
      () => store.semanticCandidates([1, 2, 3], { project: null }, 5),
      /does not match the index dimension/,
    );
  } finally {
    await store.close();
  }
});

test('an empty standing prefix is refused rather than matching every document', async () => {
  const store = await freshStore();
  try {
    await writeDocument(store, 'global.lesson.one', 'a standing unit', unitVector(0));
    await writeDocument(store, 'web.card.two', 'not standing at all', unitVector(1));

    assert.equal(STANDING_ID_PREFIX, 'global.');
    assert.deepEqual((await store.standingDocuments({})).map((row) => row.id), ['global.lesson.one']);
    await assert.rejects(() => store.standingDocuments({ prefix: '' }), /non empty namespace prefix/);
    await assert.rejects(() => store.standingDocuments({ prefix: '  ' }), /non empty namespace prefix/);
  } finally {
    await store.close();
  }
});

test('mutation: scrambling the index moves the digest', async () => {
  const store = await freshStore();
  try {
    await writeDocument(store, 'a', 'the ranking arm caps any one candidate', unitVector(0));
    await writeDocument(store, 'b', 'fuseRankings merges the two arms', unitVector(1));
    const baseline = await store.getMeta(META_KEYS.indexDigest);
    assert.equal(await store.getMeta(META_KEYS.chunkCount), '2');

    // Swap the two documents' chunk content: same ids, same count, different index.
    await store.replaceChunks('a', [{ ordinal: 0, content: 'fuseRankings merges the two arms', vector: unitVector(0) }]);
    await store.replaceChunks('b', [{ ordinal: 0, content: 'the ranking arm caps any one candidate', vector: unitVector(1) }]);
    assert.notEqual(await store.getMeta(META_KEYS.indexDigest), baseline,
      'a scrambled index must not report the baseline digest');

    // Put it back: the digest is a function of content, so it returns to the baseline.
    await store.replaceChunks('a', [{ ordinal: 0, content: 'the ranking arm caps any one candidate', vector: unitVector(0) }]);
    await store.replaceChunks('b', [{ ordinal: 0, content: 'fuseRankings merges the two arms', vector: unitVector(1) }]);
    assert.equal(await store.getMeta(META_KEYS.indexDigest), baseline);

    // Dropping an embedding is also a change, even though the content is untouched.
    await store.replaceChunks('b', [{ ordinal: 0, content: 'fuseRankings merges the two arms', vector: null }]);
    assert.notEqual(await store.getMeta(META_KEYS.indexDigest), baseline, 'a missing embedding must move the digest');
  } finally {
    await store.close();
  }
});

test('mutation: the same corpus under a different embedder yields a different digest', async () => {
  const left = await freshStore({ embedderId: 'ollama:model-a@digest-1' });
  const right = await freshStore({ embedderId: 'ollama:model-b@digest-2' });
  try {
    for (const store of [left, right]) {
      await writeDocument(store, 'a', 'identical text, different embedder', unitVector(0));
    }
    assert.notEqual(
      await left.getMeta(META_KEYS.indexDigest),
      await right.getMeta(META_KEYS.indexDigest),
      'the digest binds the index to the embedder that built it',
    );
  } finally {
    await left.close();
    await right.close();
  }
});

test('the digest is lazy but never stale, even when a writer dies without closing', async () => {
  const root = repoRoot();
  const state = stateRoot();
  const writer = await createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'fixture:v1' });
  await writeDocument(writer, 'a', 'the ranking arm caps any one candidate', unitVector(0));
  await writeDocument(writer, 'b', 'fuseRankings merges the two arms', unitVector(1));
  const fresh = await writer.getMeta(META_KEYS.indexDigest);
  assert.equal(await writer.getMeta(META_KEYS.chunkCount), '2', 'a read resolves the pending digest');

  // No close: this is the process that died mid ingest. A second opener recomputes at
  // init rather than trusting whatever value happened to be on disk.
  const reader = await createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'fixture:v1' });
  try {
    assert.equal(await reader.getMeta(META_KEYS.indexDigest), fresh);
  } finally {
    await reader.close();
    await writer.close();
  }
});

test('semantic scores equal a hand computed cosine, and filtered results stay exact', async () => {
  const store = await freshStore();
  try {
    const written = [];
    await store.transaction(async () => {
      for (let index = 0; index < 60; index += 1) {
        const id = `c${index}`;
        const vector = unitVector(index);
        written.push({ id, vector, type: index % 10 === 0 ? 'adr' : 'card' });
        await writeDocument(store, id, `candidate ${index}`, vector, {
          type: index % 10 === 0 ? 'adr' : 'card',
          area: index % 3 === 0 ? 'store' : 'rag',
        });
      }
    });

    const query = new Array(DIMENSION).fill(0);
    query[2] = 1;
    query[5] = 0.4;

    const hits = await store.semanticCandidates(query, { project: null }, 5);
    for (const hit of hits) {
      const source = written.find((row) => row.id === hit.id);
      assert.ok(
        Math.abs(hit.score - cosineSimilarity(query, source.vector)) < 1e-6,
        `${hit.id} score ${hit.score} should equal the reference cosine`,
      );
    }

    // The adr rows are 1 in 10 and none of them is a nearest neighbour of the query, so
    // filling limit 5 requires the over-fetch loop to widen k past the naive depth.
    const rare = await store.semanticCandidates(query, { project: null, types: ['adr'] }, 5);
    assert.equal(rare.length, 5, 'a rare type filter still fills the requested limit');
    assert.ok(rare.every((row) => row.type === 'adr'));

    const bruteForce = written
      .filter((row) => row.type === 'adr')
      .map((row) => ({ id: row.id, score: cosineSimilarity(query, row.vector) }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, 5)
      .map((row) => row.id);
    assert.deepEqual(rare.map((row) => row.id), bruteForce, 'filtered ranking matches a brute force ranking');
  } finally {
    await store.close();
  }
});

test('a store used before init refuses to answer', async () => {
  const store = new SqliteStore({ repoPath: repoRoot(), stateRoot: stateRoot(), dimension: DIMENSION });
  await assert.rejects(() => store.getMeta('anything'), /not initialized/);
});

test('a repoPath without a state root is refused, not quietly resolved to the old location', async () => {
  // The dangerous version of this constructor is one that rebuilds the pre-D-0031 in-repo
  // path when a caller forgets the state root: nothing fails, and the daemon and the store
  // then read different files for the same repo. layout.js refuses the same way.
  const root = repoRoot();
  assert.throws(
    () => new SqliteStore({ repoPath: root, dimension: DIMENSION }),
    /requires a stateRoot alongside repoPath/,
  );
  assert.throws(() => new SqliteStore({ dimension: DIMENSION }), /requires a path, or a repoPath with a stateRoot/);
  // An explicit path still needs no state root: it is already the answer the resolver gives.
  const explicit = new SqliteStore({ path: join(stateRoot(), 'explicit.sqlite'), dimension: DIMENSION });
  await explicit.init();
  await explicit.close();
});

test('an initialised repo keeps its index across a move; an uninitialised one cannot', async () => {
  // The property the resolver exists for, asserted from the store's side: the store and
  // anything else resolving the same repo must agree, INCLUDING after a move, or the index
  // goes missing in the one situation nobody tests.
  const root = repoRoot();
  const state = stateRoot();
  // ensure mints the manifest, which is what init does. Without it the resolver falls back
  // to a path hash, and the second half of this test is what that fallback costs.
  const before = await repoLayout(root, { stateRoot: state, ensure: true });
  const store = await createSqliteStore({ repoPath: root, stateRoot: state, dimension: DIMENSION, embedderId: 'fixture:v1' });
  await writeDocument(store, 'a', 'written before the move', unitVector(0));
  await store.close();

  const moved = join(dirname(root), `${basename(root)}-moved`);
  renameSync(root, moved);
  roots.push(moved);

  const after = await repoLayout(moved, { stateRoot: state });
  assert.equal(after.repoId, before.repoId, 'the manifest id travelled with the checkout');
  assert.equal(after.databasePath, before.databasePath, 'so the index is the same file');

  const reopened = await createSqliteStore({ repoPath: moved, stateRoot: state, dimension: DIMENSION, embedderId: 'fixture:v1' });
  try {
    assert.equal((await reopened.allDocuments({ project: null })).length, 1, 'and the corpus is still there');
  } finally {
    await reopened.close();
  }

  // The documented fallback, stated as a cost rather than left to be discovered: a repo
  // with no manifest is keyed by its path, so moving it orphans the index. That is the
  // pre-init case only, and it is exactly as good as the old in-repo behaviour, but a
  // reader should not have to infer it.
  const bare = repoRoot();
  const bareBefore = await repoLayout(bare, { stateRoot: state });
  assert.match(bareBefore.repoId, /^path-/, 'no manifest means a path key');
  const bareMoved = join(dirname(bare), `${basename(bare)}-moved`);
  renameSync(bare, bareMoved);
  roots.push(bareMoved);
  const bareAfter = await repoLayout(bareMoved, { stateRoot: state });
  assert.notEqual(bareAfter.repoId, bareBefore.repoId, 'and a moved path is a different key');
});
