import assert from 'node:assert/strict';
import test from 'node:test';

import { chunkDocument, identityChunk, IDENTITY_ORDINAL } from '../src/rag/chunk.js';
import { formatContext } from '../src/rag/context.js';
import { fuseRankings, RRF_K } from '../src/rag/fuse.js';
import { displayModulePath, normalizeModulePath, reverseImpact, GENERIC_PATH_GRAMMAR } from '../src/rag/paths.js';
import { asStandingUnits, isStandingId } from '../src/rag/standing.js';
import { queryTokens, tokens } from '../src/rag/tokens.js';

test('queryTokens drops stop words, keeps CJK, and enforces the length floor', () => {
  assert.deepEqual(queryTokens('why was the storage layer redesigned'), ['storage', 'redesigned']);
  assert.deepEqual(queryTokens('a to db sqlite'), ['sqlite'], 'tokens under three characters are dropped');
  assert.deepEqual(queryTokens('設計 の 理由'), ['設計', 'の', '理由']);
  assert.deepEqual(queryTokens('ADR-0040 adr-0040'), ['adr-0040']);
});

test('tokens counts CJK per character and words per word', () => {
  assert.equal(tokens('hello world').length, 2);
  assert.equal(tokens('設計理由').length, 4);
  assert.equal(tokens('a, b.').length, 4);
});

test('module paths normalize into the mod namespace and render back', () => {
  assert.equal(normalizeModulePath('editor/src/App.jsx'), 'mod:web/src/App.jsx');
  assert.equal(normalizeModulePath('`./src/App.jsx`'), 'mod:web/src/App.jsx');
  assert.equal(normalizeModulePath('Feed.swift'), 'mod:ios/Feed.swift');
  assert.equal(displayModulePath('mod:web/src/App.jsx'), 'editor/src/App.jsx');
  assert.equal(displayModulePath('mod:ios/Feed.swift'), 'InternshipPortal/Feed.swift');
  // A grammar with no declared roots leaves a path alone rather than inventing a namespace.
  assert.equal(normalizeModulePath('lib/thing.js', GENERIC_PATH_GRAMMAR), 'lib/thing.js');
});

test('reverseImpact walks importers breadth first and orders deterministically', () => {
  const relationships = [
    { src: 'mod:web/src/App.jsx', dst: 'mod:web/src/api.js', kind: 'imports' },
    { src: 'mod:web/src/Page.jsx', dst: 'mod:web/src/api.js', kind: 'imports' },
    { src: 'mod:web/src/Root.jsx', dst: 'mod:web/src/App.jsx', kind: 'imports' },
    { src: 'x', dst: 'y', kind: 'supersedes' },
  ];
  const impact = reverseImpact('what depends on editor/src/api.js', relationships);
  assert.deepEqual(impact.map((item) => [item.path, item.depth]), [
    ['editor/src/App.jsx', 1],
    ['editor/src/Page.jsx', 1],
    ['editor/src/Root.jsx', 2],
  ]);
});

test('atomic types chunk whole, windowed types get breadcrumbs and an identity beacon', () => {
  const atomic = chunkDocument({ type: 'decision', path: 'a.md', title: 'A', content: 'body' });
  assert.deepEqual(atomic, [{ ordinal: 0, content: 'body' }]);

  const body = `## One\n\nThe first section explains the storage decision clearly.\n\n## Two\n\nThe second section explains the retrieval decision clearly.\n`;
  const windowed = chunkDocument({ type: 'architecture', path: 'b.md', title: 'B', tags: ['t'], body, content: body });
  assert.equal(windowed.length, 3, 'two sections plus the identity beacon');
  assert.ok(windowed[0].content.startsWith('Breadcrumb: B > One'));
  assert.equal(windowed.at(-1).ordinal, IDENTITY_ORDINAL);
  assert.ok(windowed.at(-1).content.startsWith('B\nTags: t'));

  // A single window document already IS its own identity, so it gets no beacon.
  const single = chunkDocument({ type: 'architecture', path: 'c.md', title: 'C', body: 'just one paragraph here', content: 'x' });
  assert.equal(single.length, 1);
  assert.equal(single[0].ordinal, 0);
});

test('identityChunk skips identifier noise in favour of the first prose sentence', () => {
  const card = identityChunk({ title: 'T', tags: [] }, [
    { breadcrumb: 'T > S', text: '`x`. The section describes where user data lives.' },
  ]);
  assert.equal(card.content, 'T\nT > S: The section describes where user data lives.');
});

test('fuseRankings preserves the cosine distribution while applying the fused order', () => {
  const rows = [
    { chunk_id: 'a', score: 0.9 },
    { chunk_id: 'b', score: 0.5 },
    { chunk_id: 'c', score: 0.4 },
  ];
  const fusedWithoutLexical = fuseRankings(rows, []);
  assert.deepEqual(fusedWithoutLexical.map((row) => row.chunk_id), ['a', 'b', 'c'], 'no lexical arm reduces to cosine order');
  assert.deepEqual(fusedWithoutLexical.map((row) => row.score), [0.9, 0.5, 0.4]);

  // Lexical hits on c and b lift both past a, which has the best cosine and no lexical
  // match at all. The point of the rescale is that c, now first, is handed a's cosine.
  const fused = fuseRankings(rows, ['c', 'b']);
  assert.deepEqual(fused.map((row) => row.chunk_id), ['c', 'b', 'a']);
  assert.deepEqual(fused.map((row) => row.score), [0.9, 0.5, 0.4], 'distribution is reused position by position');
  assert.equal(fused[0].semanticSimilarity, 0.4, 'the pre-fusion cosine survives for the reserved slot');
  assert.equal(fused[0].lexicalRank, 1);
  assert.equal(RRF_K, 60);
});

test('fuseRankings is deterministic under ties', () => {
  const rows = [{ chunk_id: 'b', score: 0.5 }, { chunk_id: 'a', score: 0.5 }];
  assert.deepEqual(fuseRankings(rows, []).map((row) => row.chunk_id), ['a', 'b']);
  assert.deepEqual(fuseRankings([...rows].reverse(), []).map((row) => row.chunk_id), ['a', 'b']);
});

test('standing ids are a namespace contract', () => {
  assert.equal(isStandingId('global.lesson.helper-call-sites'), true);
  assert.equal(isStandingId('web.lesson.anything'), false);
  assert.equal(isStandingId('house.rule.x', 'house.'), true);
  const units = asStandingUnits([{ id: 'global.a', type: 'lesson', title: 'T', path: 'p', meta: { area: 'x' }, tags: null, content: 'c' }]);
  assert.deepEqual(units, [{ id: 'global.a', type: 'lesson', title: 'T', path: 'p', area: 'x', tags: [], content: 'c', standing: true }]);
});

test('formatContext escapes markup, leads with standing rules, and reports the budget', () => {
  const output = formatContext({
    standing: [{ id: 'global.a', type: 'lesson', title: 'Rule', path: 'p', content: '<script>' }],
    decisions: [{ id: 'd1', type: 'decision', title: 'D', path: 'p', content: 'x & y', current: true, superseded: [{ id: 'd0' }] }],
    lessons: [], exemplars: [], chunks: [],
    meta: { retrievedIds: ['global.a', 'd1'], standingIds: ['global.a'], tokenCount: 12, tokenBudget: 4000 },
  });
  assert.ok(output.indexOf('Standing engineering rules') < output.indexOf('Current decisions'));
  assert.ok(output.includes('&lt;script&gt;'));
  assert.ok(output.includes('&amp;'));
  assert.ok(output.includes('decision-status: current'));
  assert.ok(output.includes('superseded: d0'));
  assert.ok(output.includes('tokens: 12/4000 (standing units are outside this budget)'));
});
