// The P2 A/B runner, proven in the parts that can be proven before the gate opens.
//
// The measurement itself is held until the leader opens it on the P1 verdict, so this
// file exercises everything around it against fakes and a real local SQLite store: the
// read-only guard that keeps a parity run off the owner's database, the mirror that loads
// the candidate through the shipped write path, the vector parser, and the verdict.
//
// The verdict tests matter most. A judge that cannot fail is the same dead coverage the
// gate inventory bans, so each criterion is exercised on both sides of its threshold.
//
// Zero spend, no network, no database.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WRITE_METHODS,
  checkMirrorCompleteness,
  judgeAb,
  mirrorCorpus,
  parseVector,
  readOnlyStore,
} from '../src/init/ab-sqlite-pgvector.js';
import { createSqliteStore } from '../src/store/sqlite.js';

const DIMENSION = 4;
const PROJECT = 'internship-portal';
const roots = [];

process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sqliteTarget() {
  const root = mkdtempSync(join(tmpdir(), 'daijin-ab-'));
  roots.push(root);
  return join(root, 'ab.sqlite');
}

/** A stand in for the corpus database, in the shape pgCorpusSource returns. */
function fakeSource({ documents, chunks, relationships }) {
  return {
    documents: async () => documents,
    chunks: async () => chunks,
    relationships: async () => relationships,
  };
}

const SOURCE_DOCUMENTS = [
  {
    id: 'store.adr-0040',
    project: PROJECT,
    type: 'decision',
    path: 'agent/decisions.md',
    title: 'Storage layer redesign',
    tags: ['storage'],
    meta: { area: 'store' },
    content: 'ADR-0040 records why the storage layer was redesigned.',
    contentHash: 'hash-adr-0040',
  },
  {
    id: 'rag.retrieve',
    project: PROJECT,
    type: 'convention',
    path: 'engine/src/rag/retrieve.js',
    title: 'Retrieval entry point',
    tags: [],
    meta: { area: 'rag' },
    content: 'fuseRankings merges the semantic and the lexical rankings.',
    contentHash: 'hash-retrieve',
  },
];

const SOURCE_CHUNKS = [
  { documentId: 'store.adr-0040', ordinal: -1, content: 'identity beacon for adr-0040', vector: [1, 0, 0, 0] },
  { documentId: 'store.adr-0040', ordinal: 0, content: 'ADR-0040 records why the storage layer was redesigned.', vector: [0.9, 0.1, 0, 0] },
  { documentId: 'rag.retrieve', ordinal: 0, content: 'fuseRankings merges the semantic and the lexical rankings.', vector: [0, 1, 0, 0] },
];

const SOURCE_RELATIONSHIPS = [
  { src: 'rag.retrieve', dst: 'store.adr-0040', kind: 'refs' },
  // The platform vocabulary is wider than the four kinds the engine names by default.
  { src: 'store.adr-0040', dst: 'rag.retrieve', kind: 'depends_on' },
];

async function targetStore() {
  return createSqliteStore({
    path: sqliteTarget(),
    project: PROJECT,
    embedder: { provider: 'ollama', model: 'fixture-embed', digest: 'sha256-fixture', dimension: DIMENSION },
  });
}

test('the parity arm refuses every write, so a read-only run is a mechanism not a promise', async () => {
  const calls = [];
  const real = {
    async allDocuments() { calls.push('allDocuments'); return []; },
    async upsertDocument() { calls.push('upsertDocument'); },
    async pruneDocumentsExcept() { calls.push('pruneDocumentsExcept'); },
    async init() { calls.push('init'); },
    async close() { calls.push('close'); },
  };
  const guarded = readOnlyStore(real, 'pgvector');

  assert.deepEqual(await guarded.allDocuments(), [], 'reads pass straight through');
  assert.deepEqual(await guarded.close(), undefined, 'so does close');

  for (const method of WRITE_METHODS) {
    await assert.rejects(async () => guarded[method](), /read only \(D-0012\)/, `${method} must be refused`);
  }
  // init is included on purpose: the parity arm attaches to an already migrated database.
  assert.ok(WRITE_METHODS.includes('init'));
  assert.deepEqual(calls, ['allDocuments', 'close'], 'no write ever reached the real store');
});

test('a pgvector vector literal round trips', () => {
  assert.deepEqual(parseVector('[0.5,-0.25,0,1]'), [0.5, -0.25, 0, 1]);
  assert.deepEqual(parseVector([1, 2]), [1, 2], 'an already parsed array is left alone');
  assert.equal(parseVector(null), null);
  assert.throws(() => parseVector('"not an array"'), /not an array/);
});

test('the mirror loads the candidate through the shipped write path', async () => {
  const store = await targetStore();
  try {
    const counts = await mirrorCorpus({
      source: fakeSource({
        documents: SOURCE_DOCUMENTS, chunks: SOURCE_CHUNKS, relationships: SOURCE_RELATIONSHIPS,
      }),
      target: store,
      project: PROJECT,
    });
    assert.deepEqual(counts, { documents: 2, chunks: 3, relationships: 2, embedded: 3 });

    const documents = await store.allDocuments({ project: PROJECT });
    assert.deepEqual(documents.map((row) => row.id), ['rag.retrieve', 'store.adr-0040']);
    assert.equal(documents[1].contentHash, 'hash-adr-0040', 'the source hash is copied, not recomputed');
    assert.deepEqual(documents[1].tags, ['storage']);

    // Ordinals survive, which is what keeps the identity beacon a beacon.
    const candidates = await store.semanticCandidates([1, 0, 0, 0], { project: PROJECT }, 5);
    const beacon = candidates.find((row) => String(row.chunk_id) === 'store.adr-0040#-1');
    assert.equal(beacon.ordinal, -1);
    assert.equal(beacon.chunk_content, 'ADR-0040 records why the storage layer was redesigned.',
      'and the beacon still resolves to ordinal 0 content');

    assert.equal((await store.relationshipEdges(['refs', 'depends_on'])).length, 2,
      'the platform relationship vocabulary is wider than the engine default and must survive');

    // The copied identity is what lets retrieval serve this index at all.
    const identity = await store.indexedEmbeddingIdentity();
    assert.equal(identity.model, 'fixture-embed');
    assert.equal(identity.digest, 'sha256-fixture');
    assert.equal(identity.dimension, DIMENSION);
  } finally {
    await store.close();
  }
});

test('the mirror is a full replace: a document dropped at the source leaves the candidate', async () => {
  const store = await targetStore();
  try {
    const source = fakeSource({
      documents: SOURCE_DOCUMENTS, chunks: SOURCE_CHUNKS, relationships: SOURCE_RELATIONSHIPS,
    });
    await mirrorCorpus({ source, target: store, project: PROJECT });

    // Second run of the same mirror, with one document gone from the source.
    const shrunk = fakeSource({
      documents: SOURCE_DOCUMENTS.slice(1),
      chunks: SOURCE_CHUNKS.filter((chunk) => chunk.documentId !== 'store.adr-0040'),
      relationships: [],
    });
    await mirrorCorpus({ source: shrunk, target: store, project: PROJECT });

    assert.deepEqual((await store.allDocuments({ project: PROJECT })).map((row) => row.id), ['rag.retrieve'],
      'the mirror is authoritative, not additive');
    assert.deepEqual(await store.existingDocumentIds(['store.adr-0040']), [],
      'so the gold-set existence gate cannot keep certifying it');
    assert.deepEqual(await store.relationshipEdges(['refs', 'depends_on']), []);
  } finally {
    await store.close();
  }
});

test('mutation: the mirror-completeness gate fires when a row is dropped', async () => {
  const store = await targetStore();
  try {
    // The honest case first: a complete mirror reconciles against the source counts.
    const source = fakeSource({
      documents: SOURCE_DOCUMENTS, chunks: SOURCE_CHUNKS, relationships: SOURCE_RELATIONSHIPS,
    });
    const truth = { documents: 2, chunks: 3, relationships: 2 };
    const clean = checkMirrorCompleteness(truth, await mirrorCorpus({ source, target: store, project: PROJECT }));
    assert.equal(clean.complete, true);
    assert.deepEqual(clean.mismatches, []);

    // The mutation: a source that hands over one document fewer than it counts, which is
    // what a silently partial read looks like. The mirror itself succeeds and reports
    // clean numbers for what it moved; only the reconciliation against the independent
    // count catches it.
    const partial = fakeSource({
      documents: SOURCE_DOCUMENTS.slice(1),
      chunks: SOURCE_CHUNKS.filter((chunk) => chunk.documentId !== 'store.adr-0040'),
      relationships: SOURCE_RELATIONSHIPS,
    });
    const dropped = checkMirrorCompleteness(truth, await mirrorCorpus({ source: partial, target: store, project: PROJECT }));
    assert.equal(dropped.complete, false, 'a partial mirror must not report a clean comparison');
    assert.deepEqual(dropped.mismatches, [
      { field: 'documents', source: 2, mirrored: 1 },
      { field: 'chunks', source: 3, mirrored: 1 },
    ]);

    // The asymmetry that makes this worth a gate: the partial mirror leaves a SMALLER
    // corpus, and a smaller corpus can only flatter the arm measured on it.
    assert.equal((await store.allDocuments({ project: PROJECT })).length, 1);
  } finally {
    await store.close();
  }
});

test('every mirror count is reconciled, not just the document count', () => {
  const truth = { documents: 10, chunks: 40, relationships: 7 };
  assert.equal(checkMirrorCompleteness(truth, { ...truth }).complete, true);
  for (const field of ['documents', 'chunks', 'relationships']) {
    const short = { ...truth, [field]: truth[field] - 1 };
    const result = checkMirrorCompleteness(truth, short);
    assert.equal(result.complete, false, `${field} must be reconciled`);
    assert.deepEqual(result.mismatches, [{ field, source: truth[field], mirrored: truth[field] - 1 }]);
  }
  // A mirror carrying MORE than the source is also a mismatch: it means the target was
  // not empty, so the comparison would run over someone else's leftovers.
  assert.equal(checkMirrorCompleteness(truth, { ...truth, documents: 11 }).complete, false);
});

test('the verdict passes a backend that matches and fails one that does not', () => {
  const control = {
    cases: 34, caseRate: 31 / 34, identifierCases: 5, identifierCaseRate: 1, violations: 0, mrr: 0.6637955182072829,
  };

  const identical = judgeAb({ control, candidate: { ...control } });
  assert.equal(identical.pass, true);
  assert.deepEqual(identical.checks.map((check) => check.pass), [true, true, true]);

  // One case worse is the documented tolerance, two is not.
  const oneWorse = judgeAb({ control, candidate: { ...control, caseRate: 30 / 34 } });
  assert.equal(oneWorse.pass, true, 'within one case is the acceptance bound');
  assert.ok(Math.abs(oneWorse.caseDelta - 1) < 1e-9);

  const twoWorse = judgeAb({ control, candidate: { ...control, caseRate: 29 / 34 } });
  assert.equal(twoWorse.pass, false);
  assert.equal(twoWorse.checks[0].pass, false);

  // The tolerance is symmetric: a candidate that scores BETTER by two cases is also a
  // divergence worth stopping on, because the arms are supposed to be the same product.
  const twoBetter = judgeAb({ control, candidate: { ...control, caseRate: 33 / 34 } });
  assert.equal(twoBetter.pass, false);

  const identifierMiss = judgeAb({ control, candidate: { ...control, identifierCaseRate: 4 / 5 } });
  assert.equal(identifierMiss.pass, false);
  assert.equal(identifierMiss.checks[1].pass, false);
  assert.match(identifierMiss.checks[1].detail, /sqlite 4\/5 = 0\.8/);

  const violated = judgeAb({ control, candidate: { ...control, violations: 1 } });
  assert.equal(violated.pass, false);
  assert.equal(violated.checks[2].pass, false);

  // A corpus with no identifier cases cannot certify the identifier criterion.
  const noIdentifiers = judgeAb({
    control, candidate: { ...control, identifierCases: 0, identifierCaseRate: 0 },
  });
  assert.equal(noIdentifiers.checks[1].pass, false, 'an empty identifier set is not a pass');
});

test('the verdict reports exact rates and cases, never a rounded percentage', () => {
  // Verifier finding 72. Two arms a third of a case apart both round to 91.2%, so a
  // rounded display reads as agreement where the arithmetic saw movement. The detail
  // string has to carry what the check actually compared.
  const control = { cases: 34, caseRate: 31 / 34, identifierCases: 5, identifierCaseRate: 1, violations: 0, mrr: 0.66 };
  const candidate = { ...control, caseRate: 30.7 / 34 };

  const verdict = judgeAb({ control, candidate });
  const [caseCheck] = verdict.checks;
  assert.match(caseCheck.detail, /0\.9117647058823529/, 'the exact control rate is shown');
  assert.match(caseCheck.detail, /0\.9029411764705882/, 'and the exact candidate rate, which rounds to the same 91.2%');
  assert.ok(!/91\.2%/.test(caseCheck.detail), 'no rounded percentage survives in the detail string');
  assert.equal(caseCheck.values.control.complete, 31);
  assert.equal(caseCheck.values.candidate.caseRate, 30.7 / 34);
  assert.equal(caseCheck.values.tolerance, 1);

  // Rounding is display only: the judgement always ran on the exact floats.
  assert.ok(Math.abs(caseCheck.values.caseDelta - 0.3) < 1e-9);
  assert.equal(caseCheck.pass, true, 'a third of a case apart still passes, and says so honestly');

  // MRR is reported exactly and never judged (D-0017).
  assert.equal(verdict.mrr.toleranced, false);
  assert.equal(verdict.mrr.delta, candidate.mrr - control.mrr);
  assert.ok(verdict.checks.every((check) => !/%/.test(check.detail)), 'no check rounds anything');
});
