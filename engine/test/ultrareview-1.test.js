// Ultrareview run 1: the seven findings, each pinned by the property it was about.
//
// One test per finding, named for the CONSEQUENCE rather than the mechanism, so a later
// reader learns what breaks if it regresses rather than what line changed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { unitMarker, parseBrainFile, renderUnit, BRAIN_SCHEMA } from '../src/init/brain-artifacts.js';
import { assertNoContractUnits } from '../src/init/ingest.js';
import { permuteAnswers } from '../src/init/rerank-ab.js';
import { readTextFile } from '../src/init/walk.js';
import { createPgVectorStore } from '../src/store/pgvector.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('F1: no engine source contains a NUL, so git can diff it and the walker can read it', async () => {
  // evidence.js held three, used as Map-key separators. Two consequences, and the second is
  // the one that matters: git classified the file as BINARY, so it had no diff and no blame
  // and was unreviewable in the review that found it; and readTextFile drops NUL-bearing
  // files, correctly, so DAIJIN INDEXING ITS OWN REPO OMITTED THIS FILE FROM ITS OWN BRAIN.
  //
  // Swept over every source rather than pinned to the one file, because the defect is a
  // habit available to any file and the fix in one place says nothing about the next.
  const { readdir } = await import('node:fs/promises');
  const offenders = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const bytes = await readFile(full);
      if (bytes.includes(0)) offenders.push(path.relative(SRC, full));
    }
  };
  await walk(SRC);
  assert.deepEqual(offenders, [], 'a NUL makes the file binary to git and invisible to the walker');

  // And the specific file the finding named is readable as text again.
  const text = await readTextFile(path.join(SRC, '..'), 'src/init/evidence.js');
  assert.ok(text && text.length > 1000, 'evidence.js is text and the walker reads it');
});

test('F2: a host repo with src/agents or a PWA manifest still ingests', async () => {
  // The old pattern matched ANY `agents/` segment and ANY `manifest.json`, so it failed the
  // WHOLE INGEST for the standard LangGraph, CrewAI and AutoGen layout, and for any
  // extension or PWA. The contract is a LOCATION, not a naming convention.
  for (const unit of [
    { id: 'a', path: 'src/agents/planner.py' },
    { id: 'b', path: 'app/agents/crew.ts' },
    { id: 'c', path: 'extension/manifest.json' },
    { id: 'd', path: 'public/manifest.json' },
    { id: 'e', path: 'brain/architecture.md', citations: ['src/agents/planner.py'] },
  ]) {
    assert.doesNotThrow(() => assertNoContractUnits([unit]), `${unit.path} is host source, not the contract`);
  }

  // And the contract itself is still refused, including in the spellings a naive matcher
  // misses: a leading ./, a Windows separator, an absolute path.
  for (const unit of [
    { id: 'f', path: '.daijin/agents/student.md' },
    { id: 'g', path: '.daijin/manifest.json' },
    { id: 'h', path: './.daijin/agents/teacher.md' },
    { id: 'i', path: '.daijin\\agents\\auditor.md' },
    { id: 'j', path: '/home/me/repo/.daijin/agents/watcher.md' },
    { id: 'k', path: 'brain/a.md', citations: ['.daijin/agents/student.md'] },
  ]) {
    assert.throws(() => assertNoContractUnits([unit]), /sourced from the CONTRACT/, `${unit.path} IS the contract`);
  }
});

test('F3: pgvector reports its project, so the mismatch guard is reachable', async () => {
  // sqlite has had this accessor since it was written and pgvector never did, so
  // pipeline.js's guard read undefined and its own `!== undefined` check skipped it. The
  // guard exists because a store constructed with one project and an init called with
  // another writes under one scope while pruning the other, which in a shared database
  // deletes rows belonging to a project the run never mentioned.
  const store = createPgVectorStore({ connectionString: 'postgres://unused', project: 'alpha' });
  assert.equal(store.project, 'alpha');

  const bare = createPgVectorStore({ connectionString: 'postgres://unused' });
  assert.equal(bare.project, null, 'null rather than undefined, so the guard sees it');

  const { initBrain } = await import('../src/init/pipeline.js');
  await assert.rejects(
    () => initBrain({ repoPath: '/tmp', mode: 'layer1', project: 'beta', store, embedder: { embed: async () => [] } }),
    /but the store writes documents with project "alpha"/,
  );
});

test('F4: a standing prefix containing a LIKE wildcard pins only itself', async () => {
  // `_` and `%` are LIKE metacharacters. Unescaped, `global_` pins every id with ANY
  // character in that slot, so documents that are not standing are pinned into every
  // retrieval. Sqlite escaped and pgvector did not, which is a parity break on the axis P1
  // and P2 are measured over.
  // BEHAVIOUR, not source text. The first version of this test asserted that the word
  // ESCAPE appears in pgvector.js, and it passed against a mutation that removed the
  // clause, because the word also appears in the comment explaining it. A source-text
  // assertion that matches its own prose is not a test, which is why the rule is now an
  // exported function.
  const { escapeLikePrefix } = await import('../src/store/pgvector.js');
  assert.equal(escapeLikePrefix('global.'), 'global.%', 'an ordinary prefix is unchanged but for the wildcard');
  assert.equal(escapeLikePrefix('global_'), 'global\\_%', 'an underscore is a wildcard and must be escaped');
  assert.equal(escapeLikePrefix('a%b.'), 'a\\%b.%', 'so is a percent');
  assert.equal(escapeLikePrefix('back\\slash.'), 'back\\\\slash.%', 'and the escape character itself');

  // The consequence, stated as the property: an escaped prefix cannot match an id that
  // merely has SOME character where the metacharacter is.
  const pattern = escapeLikePrefix('global_');
  assert.ok(pattern.includes('\\_'), 'global_ pins only a literal underscore, not global1. or globalZ.');
});

test('F5: the parity label comes from the store that ran, not the descriptor that asked', async () => {
  // Both P2 A/B arms were labelled from `corpus.storeOptions`, which the A/B does not set
  // because it injects stores directly. A record that describes both arms of an experiment
  // identically ON THE EXPERIMENTAL VARIABLE is worse than one with no label: it invites a
  // reader to conclude the arms were comparable when the label is what failed.
  const source = await readFile(path.join(SRC, 'init', 'retrieval-score.js'), 'utf8');
  assert.match(source, /parityMode: Boolean\(store\?\.parityMode\)/);
  assert.ok(!/parityMode: Boolean\(corpus\./.test(source), 'never from the descriptor');
});

test('F6: a case that names every answer is refused, not permuted into an undefined', async () => {
  // `wrong[index % 0]` is undefined, so the control arm scored a case it could never
  // satisfy and the D-0030 range read as unavailable with nothing said about why. Thrown by
  // NAME rather than skipped, because skipping gives the control a different denominator
  // from the candidate, which is the one property the range depends on.
  const covering = [
    { id: 'g1', query: 'a', must_return: ['doc.a', 'doc.b'] },
    { id: 'g2', query: 'b', must_return: ['doc.a'] },
  ];
  assert.throws(() => permuteAnswers(covering), /Case g1 names every answer/);

  const ordinary = [
    { id: 'g1', query: 'a', must_return: ['doc.a'] },
    { id: 'g2', query: 'b', must_return: ['doc.b'] },
  ];
  const permuted = permuteAnswers(ordinary);
  assert.ok(permuted.every((row) => row.must_return.every((id) => typeof id === 'string' && id)),
    'every permuted answer is a real id');
  assert.ok(permuted.every((row, index) => !row.must_return.includes(ordinary[index].must_return[0])),
    'and every one is wrong, which is the point of the control');
});

test('F7: a marker survives commas, quotes and a comment terminator', async () => {
  // Three hazards, all reproduced: a comma inside a citation was indistinguishable from the
  // separator between citations; a quote was REWRITTEN to an apostrophe, corrupting a path
  // silently; and a value containing --> ended the HTML comment, so the marker broke out
  // and the rest rendered as document text.
  const hostile = {
    id: 'web.decision.adr-0001', type: 'decision', title: 'A decision', content: 'Body text.',
    meta: { area: 'storage', sourceFile: 'src/say"hi".ts' },
    citations: ['src/a,b.ts', 'src/c.ts', 'src/d-->.ts'],
  };

  const marker = unitMarker(hostile);
  assert.ok(!marker.slice(0, -4).includes('-->'), 'no value may terminate the comment it lives in');

  const text = `---\ndaijin-schema: ${BRAIN_SCHEMA}\ngenerator: t\n---\n\n${renderUnit(hostile)}`;
  const back = parseBrainFile(text, { file: 'brain/decisions.md' }).units[0];
  assert.equal(back.id, hostile.id);
  assert.equal(back.meta.sourceFile, hostile.meta.sourceFile, 'the quote survives rather than becoming an apostrophe');
  assert.deepEqual(back.citations, hostile.citations, 'three citations in, three out, commas intact');
});
