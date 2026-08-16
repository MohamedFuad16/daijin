// The measured FTS5 recipe, proven element by element.
//
// Each test asserts two things: that the shipped path gets the hit, and that a control
// built WITHOUT the mechanism does not. Delete porter from the tokenizer, delete the
// stopword filter, or stop quoting the tokens, and the corresponding test fails on the
// shipped assertion while its control keeps passing. That is the point: these are not
// smoke tests, they are the evidence that each element of the recipe is load bearing.
//
// Recipe and evidence: docs/fts5-adapter-recipe.py, docs/fts5-report.json. The CODE in
// that script is authoritative, not its header prose: the header says "unicode61 (no
// stemming)" while the code creates tokenize='porter unicode61', which does stem, and its
// stopword list is a hand written approximation of the Postgres 'english' configuration
// rather than the full snowball list. The stemming test below is what pins the truth.
//
// Scope caveat, recorded on D-0001: the measured win was an unfiltered lexical-arm
// comparison over raw chunk content, not the shipped filtered path, so it does not
// predict fused end-to-end case rate. These tests prove the mechanism, not the outcome.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  FTS5_TOKENIZE,
  LEXICAL_TOP_K,
  STOPWORDS,
  buildMatchExpression,
  matchTokens,
} from '../../adapters/sqlite/fts5.js';
import { SqliteStore } from '../src/store/sqlite.js';

const CORPUS = [
  {
    id: 'rag.rank',
    type: 'card',
    area: 'rag',
    content: 'The ranking function ranks candidates and caps how much any one candidate may take.',
  },
  {
    id: 'rag.retrieve',
    type: 'card',
    area: 'rag',
    content: 'fuseRankings merges the semantic and the lexical arms with reciprocal rank fusion.',
  },
  {
    id: 'store.adr-0040',
    type: 'adr',
    area: 'store',
    content: 'ADR-0040: a rebuild must handle deleting tracker rows before it writes anything new.',
  },
];

const ANY = { project: null };
const roots = [];
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function seededStore(rows = CORPUS) {
  const root = mkdtempSync(join(tmpdir(), 'daijin-fts5-'));
  roots.push(root);
  const store = new SqliteStore({ path: join(root, '.daijin', 'brain.sqlite'), project: null });
  await store.init();
  await store.transaction(async () => {
    for (const row of rows) {
      await store.upsertDocument({
        id: row.id,
        project: null,
        type: row.type,
        path: `agent/${row.id}.md`,
        title: null,
        tags: [],
        meta: { area: row.area },
        content: row.content,
        contentHash: null,
      });
      await store.replaceChunks(row.id, [{ ordinal: 0, content: row.content, vector: null }]);
    }
  });
  return store;
}

const hits = (rows) => rows.map((row) => row.id);

/** A control index that keeps everything except the named mechanism. */
function controlIndex(tokenize) {
  const database = new Database(':memory:');
  database.exec(`CREATE VIRTUAL TABLE f USING fts5(cid UNINDEXED, text, tokenize='${tokenize}')`);
  const insert = database.prepare('INSERT INTO f(cid, text) VALUES (?, ?)');
  for (const row of CORPUS) insert.run(row.id, row.content);
  return {
    match(expression) {
      try {
        return database.prepare('SELECT cid FROM f WHERE f MATCH ? ORDER BY bm25(f)').all(expression).map((row) => row.cid);
      } catch (error) {
        return { error: error.message };
      }
    },
    close: () => database.close(),
  };
}

test('recipe: porter stemming reaches an inflected form that unicode61 alone misses', async () => {
  const store = await seededStore();
  try {
    // The corpus says "ranking" and "ranks"; the query says "rank".
    const rows = await store.lexicalCandidates('rank', null, ANY, 10);
    assert.ok(hits(rows).includes('rag.rank'), 'porter must stem rank to the ranking chunk');
    assert.ok(hits(rows).includes('rag.retrieve'));
  } finally {
    await store.close();
  }

  const control = controlIndex('unicode61');
  try {
    assert.deepEqual(control.match('"ranking"'), ['rag.rank'], 'the control does find the literal form');
    assert.deepEqual(control.match('"ranks"'), ['rag.rank'], 'and the exact plural');
    // Without porter, the query form and the corpus form never meet.
    assert.deepEqual(control.match('"rankings"'), [], 'unicode61 alone cannot reach ranking from rankings');
  } finally {
    control.close();
  }
});

test('recipe: the tokenizer that ships is the tokenizer that was measured', async () => {
  assert.equal(FTS5_TOKENIZE, 'porter unicode61');
  const store = await seededStore();
  await store.close();
  // Read the live DDL, not the constant, so a hand edited table is caught as well.
  const database = new Database(store.path, { readonly: true });
  try {
    const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get();
    assert.match(sql, /tokenize='porter unicode61'/);
  } finally {
    database.close();
  }
});

test('recipe: stopwords are dropped before matching, or a strict AND returns nothing', async () => {
  const store = await seededStore();
  try {
    const query = 'how should a rebuild handle deleting tracker rows';
    assert.deepEqual(
      matchTokens(query),
      ['rebuild', 'handle', 'deleting', 'tracker', 'rows'],
      'how, should and a are stopwords in the measured set',
    );
    // The tokens join with implicit AND, so every surviving token must appear in the
    // chunk. That strictness is exactly why the stopword filter is not optional.
    assert.deepEqual(hits(await store.lexicalCandidates(query, null, ANY, 10)), ['store.adr-0040']);
  } finally {
    await store.close();
  }

  const control = controlIndex(FTS5_TOKENIZE);
  try {
    // Same index, same ranking, only the stopword filter removed from query building.
    const unfiltered = 'how should a rebuild handle deleting tracker rows'
      .split(/\s+/)
      .map((token) => `"${token}"`)
      .join(' ');
    assert.deepEqual(control.match(unfiltered), [], 'the unfiltered AND demands the literal how and should');
  } finally {
    control.close();
  }
});

test('recipe: an all stopword query still searches instead of returning nothing', () => {
  assert.deepEqual(matchTokens('what is it'), ['what', 'is', 'it']);
  assert.equal(buildMatchExpression('what is it'), '"what" "is" "it"');
  assert.equal(buildMatchExpression('   '), null, 'an empty query has no candidates at all');
  assert.ok(STOPWORDS.has('how') && STOPWORDS.has('the') && !STOPWORDS.has('rebuild'));
});

test('recipe: identifier-like tokens are issued as quoted phrases, which is what makes them searchable', async () => {
  assert.equal(buildMatchExpression('fuseRankings'), '"fuseRankings"');
  assert.equal(buildMatchExpression('what does fuseRankings() do'), '"fuseRankings()"');
  assert.equal(buildMatchExpression('ADR-0040'), '"ADR-0040"');
  assert.equal(buildMatchExpression('say "hi"'), '"say" """hi"""', 'an embedded quote is doubled, not dropped');

  const store = await seededStore();
  try {
    assert.deepEqual(hits(await store.lexicalCandidates('fuseRankings', null, ANY, 10)), ['rag.retrieve']);
    assert.deepEqual(hits(await store.lexicalCandidates('what does fuseRankings() do', null, ANY, 10)), ['rag.retrieve']);
    assert.deepEqual(hits(await store.lexicalCandidates('ADR-0040', null, ANY, 10)), ['store.adr-0040']);
  } finally {
    await store.close();
  }

  const control = controlIndex(FTS5_TOKENIZE);
  try {
    // Unquoted, these are FTS5 syntax rather than search terms. The identifier arm the
    // gold set cares about would be a hard error instead of a hit.
    assert.match(control.match('ADR-0040').error, /no such column: 0040/);
    assert.match(control.match('fuseRankings()').error, /syntax error/);
  } finally {
    control.close();
  }
});

test('recipe: bm25 orders the arm and never leaks into the cosine score field', async () => {
  const store = await seededStore();
  try {
    const rows = await store.lexicalCandidates('ranking candidates', null, ANY, 10);
    assert.equal(rows[0].id, 'rag.rank');
    for (let index = 1; index < rows.length; index += 1) {
      assert.ok(rows[index - 1].lex_rank >= rows[index].lex_rank, 'lex_rank orders the arm, descending');
    }
    // sqlite bm25 is negative and more negative is better, so a raw pass through would
    // have ordered these backwards. The sign flip is the normalization the contract asks
    // for, and it belongs to lex_rank alone: score carries cosine on every arm.
    assert.ok(rows[0].lex_rank > 0, `expected a positive lex_rank, received ${rows[0].lex_rank}`);
    assert.equal(rows[0].score, null, 'no query vector was given, so there is no cosine to report');
  } finally {
    await store.close();
  }
});

test('recipe: the lexical arm defaults to the measured candidate depth of 40', async () => {
  assert.equal(LEXICAL_TOP_K, 40);
  const wide = Array.from({ length: 45 }, (_, index) => ({
    id: `wide.${index}`,
    type: 'card',
    area: 'rag',
    content: `retrieval candidate number ${index} mentions the ranking arm`,
  }));
  const store = await seededStore(wide);
  try {
    assert.equal((await store.lexicalCandidates('ranking', null, ANY)).length, LEXICAL_TOP_K,
      'no limit means the measured depth');
    assert.equal((await store.lexicalCandidates('ranking', null, ANY, 5)).length, 5, 'an explicit limit still wins');
  } finally {
    await store.close();
  }
});
