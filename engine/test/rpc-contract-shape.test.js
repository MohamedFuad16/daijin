// The contract-shape reader itself.
//
// A gate is only as good as its parser, and this one reads English-adjacent Markdown. Its
// failure mode is the dangerous direction: a parser that cannot find a shape returns null,
// null reads as "the contract documents nothing here", and a test that treats null as a
// skip passes precisely when the instrument stopped working. That is the dead-gate shape
// this build keeps rediscovering, so the parser gets its own tests and the callers assert
// non-null before comparing.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { contractRow, documentedKeys } from './helpers/contract-shape.js';

async function fixtureContract(rows) {
  const root = await mkdtemp(path.join(tmpdir(), 'dj-contract-'));
  const file = path.join(root, 'methods.md');
  await writeFile(file, ['| method | params | returns |', '| --- | --- | --- |', ...rows].join('\n'), 'utf8');
  return { file, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('a nested list-of-objects is read, not truncated at its bracket', async () => {
  // THE BUG THIS ENCODES: the first version cut the cell at the first `[` to drop prose
  // additions, and `attempts: [{ ... }]` opens with one. It truncated the shape and
  // returned null for a field that WAS documented, which reads as "not documented" and
  // would have excused the very divergence the gate exists to catch.
  const { file, cleanup } = await fixtureContract([
    '| `thing` | `{ x }` | `{ head, rows: [{ a, b, c }], tail }`. [Amended 2026-01-01: prose with [nested] brackets] |',
  ]);
  try {
    assert.deepEqual(await documentedKeys('thing', { field: 'rows', file }), ['a', 'b', 'c']);
  } finally {
    await cleanup();
  }
});

test('prose additions are dropped, and only at a dated marker', async () => {
  const { file, cleanup } = await fixtureContract([
    '| `plain` | `{}` | `{ alpha, beta }` [Addition 2026-01-01: gamma is discussed here but not returned] |',
  ]);
  try {
    // `gamma` appears in the cell and must NOT be read as a documented key: the prose
    // explains, the shape declares.
    assert.deepEqual(await documentedKeys('plain', { file }), ['alpha', 'beta']);
  } finally {
    await cleanup();
  }
});

test('optional markers are keys, and a nested field contributes only its name', async () => {
  const { file, cleanup } = await fixtureContract([
    '| `mixed` | `{}` | `{ required, optional?, rows: [{ inner }] }` |',
  ]);
  try {
    assert.deepEqual(await documentedKeys('mixed', { file }), ['optional', 'required', 'rows']);
    assert.deepEqual(await documentedKeys('mixed', { field: 'rows', file }), ['inner']);
  } finally {
    await cleanup();
  }
});

test('an unknown method and an unknown field are NULL, distinctly from empty', async () => {
  // "The contract says nothing" and "the contract says nothing is there" are different
  // facts. A gate that conflated them would pass on a missing row, which is the one
  // outcome a contract gate must never produce.
  const { file, cleanup } = await fixtureContract(['| `known` | `{}` | `{ a }` |']);
  try {
    assert.equal(await documentedKeys('missing', { file }), null);
    assert.equal(await documentedKeys('known', { field: 'nope', file }), null);
    assert.equal(await contractRow('missing', { file }), null);
    assert.deepEqual(await documentedKeys('known', { file }), ['a'], 'and a real row still reads');
  } finally {
    await cleanup();
  }
});

test('the reader works against the REAL contract, not only fixtures', async () => {
  // A parser tested only on fixtures it was written beside proves that it matches its own
  // examples. The document it exists to read is the one that has to parse.
  const attempts = await documentedKeys('examDetail', { field: 'attempts' });
  // NOT `length >= 8`, which was the shape that just failed twice elsewhere: a floor
  // against empty is not a floor against incomplete, and a reader silently dropping three
  // keys would have passed it. The count is asserted exactly, so under-reading fails here
  // rather than being caught two instruments away.
  assert.ok(attempts, 'the real examDetail attempts row is readable');
  assert.equal(attempts.length, 11, 'every key of the real row, not merely enough of them');
  assert.ok(attempts.includes('tokens') && attempts.includes('grades'));
  assert.equal(attempts.some((key) => key.includes('_')), false, 'no ledger column names are documented');

  // A PROPERTY, not a snapshot. The first version asserted search's row equalled
  // ['chunks','tokensUsed'] and broke the moment the row was legitimately amended, which
  // is a test asserting today's contract rather than the reader's ability to read it. The
  // contract-shape gate is what compares the row against the engine; this file only has to
  // prove the reader works.
  const search = await documentedKeys('search');
  assert.ok(search.includes('chunks') && search.includes('tokensUsed'),
    'the reader finds the stable core of a real row');
  assert.ok(search.every((key) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(key)), 'and reads keys rather than prose');
});

test('optionality survives the read, because the contract really says it', async () => {
  // `quarantineReason?` is a documented key that may be absent: an exam that was never
  // quarantined has no reason. The names-only reader strips the marker, and a gate built on
  // it reported a false divergence the first time it met a real row. An exemption list that
  // fills with false entries stops meaning anything, which is the failure the gate exists
  // to prevent one level down.
  const { documentedShape } = await import('./helpers/contract-shape.js');
  const { file, cleanup } = await fixtureContract([
    '| `thing` | `{}` | `{ always, sometimes?, rows: [{ inner, maybe? }] }` |',
  ]);
  try {
    assert.deepEqual(await documentedShape('thing', { file }), {
      required: ['always', 'rows'], optional: ['sometimes'],
    });
    assert.deepEqual(await documentedShape('thing', { field: 'rows', file }), {
      required: ['inner'], optional: ['maybe'],
    });
    // The names-only reader still returns everything, since callers that only want the key
    // set should not have to know about optionality.
    assert.deepEqual(await documentedKeys('thing', { file }), ['always', 'rows', 'sometimes']);
    assert.equal(await documentedShape('missing', { file }), null);
  } finally {
    await cleanup();
  }
});

test('the real contract has optional keys, so this is not a fixture-only feature', async () => {
  // A PROPERTY, not a snapshot, and this file has now written the snapshot form twice: the
  // first froze search's key set and broke when the row was legitimately amended, and this
  // one froze examList's optional set and broke when vetoReason joined it. Both were tests
  // asserting today's contract rather than the reader's ability to read it, which is the
  // anti-pattern this whole instrument exists to report in other people's work. The gate is
  // what compares a row against the engine; this file proves only that the reader reads.
  const { documentedShape } = await import('./helpers/contract-shape.js');
  const examList = await documentedShape('examList');
  assert.ok(examList.optional.includes('quarantineReason'),
    'an exam that was never quarantined carries no reason, and the contract says so');
  assert.ok(examList.optional.every((key) => !examList.required.includes(key)),
    'a key is optional or required, never both');
  assert.ok(examList.required.length > examList.optional.length,
    'and the row is mostly required keys, so optionality is the exception the reader handles');
});
