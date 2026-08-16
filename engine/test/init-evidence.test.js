// The deterministic evidence tables. Pure functions over a synthetic source map, so every
// assertion is a count a reader can check by eye.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areaEvidence, buildEvidence, conventionCensus, dependencyCensus, historyStats,
  importGraph, isBuiltinSpecifier, ratio, resolveRelative, symbolIndex, testLayout,
} from '../src/init/evidence.js';

const SOURCES = new Map([
  ['src/util/tokens.js', "export function countTokens(text) {\n  return text.split(' ').length;\n}\n"],
  ['src/store/sqlite.js', "import { countTokens } from '../util/tokens.js';\nimport lodash from 'lodash';\n\nexport class SqliteStore {}\n\nexport function createSqliteStore() {\n  return new SqliteStore();\n}\n"],
  ['src/rag/rank.js', "import { countTokens } from '../util/tokens.js';\n\nexport function rankRetrieval(rows) {\n  return rows;\n}\n"],
  ['src/api/server.js', "import { createSqliteStore } from '../store/sqlite.js';\nimport { rankRetrieval } from '../rag/rank.js';\nimport fetch from 'node-fetch';\n\nexport function startServer() {\n  return { createSqliteStore, rankRetrieval, fetch };\n}\n"],
]);

test('ratio never stores a rounded percentage', () => {
  const measured = ratio(31, 34);
  assert.equal(measured.exact, 31 / 34);
  assert.equal(measured.display, '31 of 34');
  // The failure this shape exists to prevent: a value typed back from its own display.
  assert.notEqual(measured.exact, 0.912);
  assert.equal(ratio(0, 0).exact, 0, 'an empty denominator is 0, never NaN');
});

test('the import graph resolves relative specifiers and counts packages once', () => {
  const graph = importGraph(SOURCES);
  assert.deepEqual(graph.edges, [
    { src: 'src/api/server.js', dst: 'src/rag/rank.js' },
    { src: 'src/api/server.js', dst: 'src/store/sqlite.js' },
    { src: 'src/rag/rank.js', dst: 'src/util/tokens.js' },
    { src: 'src/store/sqlite.js', dst: 'src/util/tokens.js' },
  ]);
  assert.equal(graph.inDegree.get('src/util/tokens.js'), 2);
  assert.equal(graph.outDegree.get('src/api/server.js'), 2);
  assert.deepEqual(graph.external.map((entry) => entry.specifier).sort(), ['lodash', 'node-fetch']);
  assert.deepEqual(graph.unresolved, []);
});

test('a commented-out import is not an edge', () => {
  const graph = importGraph(new Map([
    ['a.js', "// import { x } from './b.js';\n/* import { y } from './b.js'; */\nexport const a = 1;\n"],
    ['b.js', 'export const b = 1;\n'],
  ]));
  assert.deepEqual(graph.edges, [], 'a commented import would put a false dependency in an architecture card');
});

test('a relative specifier that resolves to nothing is reported, not dropped', () => {
  const graph = importGraph(new Map([['a.js', "import { x } from './gone.js';\n"]]));
  assert.deepEqual(graph.unresolved, [{ file: 'a.js', specifier: './gone.js' }]);
  assert.deepEqual(graph.edges, []);
});

test('resolveRelative tries a fixed candidate order rather than a directory listing', () => {
  const files = new Set(['src/store/index.js', 'src/util/tokens.js']);
  assert.equal(resolveRelative('src/api/a.js', '../util/tokens.js', files), 'src/util/tokens.js');
  assert.equal(resolveRelative('src/api/a.js', '../util/tokens', files), 'src/util/tokens.js');
  assert.equal(resolveRelative('src/api/a.js', '../store', files), 'src/store/index.js');
  assert.equal(resolveRelative('src/api/a.js', '../nope', files), null);
});

test('the dependency census names both disagreements', () => {
  const graph = importGraph(SOURCES);
  const census = dependencyCensus({
    manifests: { 'package.json': { dependencies: { lodash: '^4.0.0', unused: '^1.0.0' } } },
    external: graph.external,
  });
  assert.deepEqual(census.unusedDeclared, ['unused'], 'declared and never imported is dead weight a reader should not hunt for');
  assert.deepEqual(census.undeclaredImports.map((row) => row.name), ['node-fetch'], 'imported and never declared is a build that works on one machine');
  assert.deepEqual(census.usedRatio, { count: 1, total: 2, exact: 0.5, display: '1 of 2' });
});

test('node builtins are not reported as undeclared dependencies', () => {
  const graph = importGraph(new Map([['a.js', "import path from 'node:path';\nimport fs from 'fs';\nexport const a = path && fs;\n"]]));
  const census = dependencyCensus({ manifests: {}, external: graph.external });
  assert.deepEqual(census.undeclaredImports, []);
});

test('conventions are measured with their denominators and their exceptions named', () => {
  const conventions = conventionCensus(new Map([
    ['a.js', "export const a = 'one';\nfunction f() {\n  return 1;\n}\n"],
    ['b.js', "export const b = 'two';\nfunction g() {\n  return 2;\n}\n"],
    ['c.js', 'export const c = "three";\nfunction h() {\n\treturn 3;\n}\n'],
  ]));
  assert.equal(conventions.quotes.dominant, 'single');
  assert.equal(conventions.quotes.measured.display, '2 of 3');
  assert.deepEqual(conventions.quotes.exceptions, ['c.js'], 'the exceptions are where a new contributor gets it wrong');
  assert.equal(conventions.indentation.dominant, 'spaces');
  assert.equal(conventions.indentation.width, 2);
  assert.equal(conventions.moduleSystem.dominant, 'esm');
  assert.equal(conventions.fileNaming.dominant, 'lowercase');
});

test('the test layout is measured from paths', () => {
  const layout = testLayout(['src/a.js', 'test/a.test.js', 'test/b.test.js', 'src/c.js']);
  assert.equal(layout.testFiles, 2);
  assert.equal(layout.dominant, 'top-level-directory');
  assert.equal(layout.measured.display, '2 of 4');
});

test('symbolIndex reports only symbols one file can claim', () => {
  const symbols = symbolIndex(new Map([
    ['a.js', 'export function shared() {}\nexport function onlyHere() {}\n'],
    ['b.js', 'export function shared() {}\n'],
  ]));
  assert.deepEqual(symbols.unique.map((entry) => entry.name), ['onlyHere']);
  assert.equal(symbols.byName.get('shared').size, 2, 'a symbol two files define cannot be an identifier case');
});

test('history stats separate fixes from reverts and never turn either into a lesson', () => {
  const history = {
    available: true,
    cap: 100,
    capped: false,
    total: 3,
    commits: [
      { sha: 'a'.repeat(40), shortSha: 'a'.repeat(12), author: 'Ada', authorEmail: 'ada@example.test', date: '2026-01-01T00:00:00Z', subject: 'fix: guard the null case', body: '', files: [{ path: 'src/a.js', added: 2, deleted: 1 }] },
      { sha: 'b'.repeat(40), shortSha: 'b'.repeat(12), author: 'Ada', authorEmail: 'ada@example.test', date: '2026-01-02T00:00:00Z', subject: 'Revert "add the thing"', body: 'This reverts commit ' + 'a'.repeat(40), files: [{ path: 'src/a.js', added: 1, deleted: 2 }] },
      { sha: 'c'.repeat(40), shortSha: 'c'.repeat(12), author: 'Grace', authorEmail: 'grace@example.test', date: '2026-01-03T00:00:00Z', subject: 'add the second module', body: '', files: [{ path: 'src/a.js', added: 5, deleted: 0 }, { path: 'src/b.js', added: 5, deleted: 0 }] },
    ],
  };
  const stats = historyStats(history, { existingFiles: ['src/a.js', 'src/b.js'], coChangeMinimum: 1 });
  assert.equal(stats.available, true);
  assert.equal(stats.fixCommits.length, 1);
  assert.equal(stats.revertCommits.length, 1);
  assert.equal(stats.authors[0].name, 'Ada');
  assert.equal(stats.authors[0].commits, 2);
  assert.equal(stats.hotFiles[0].file, 'src/a.js');
  assert.equal(stats.hotFiles[0].commits, 3);
  assert.deepEqual(stats.coChange, [{ files: ['src/a.js', 'src/b.js'], commits: 1 }]);
  assert.equal(stats.firstCommit, '2026-01-01T00:00:00Z');
});

test('a sweeping commit is excluded from co-change so it cannot dominate every pair', () => {
  const files = Array.from({ length: 80 }, (unused, index) => ({ path: `src/f${index}.js`, added: 1, deleted: 0 }));
  const stats = historyStats({
    available: true, cap: 10, capped: false, total: 1,
    commits: [{ sha: 'x'.repeat(40), shortSha: 'x'.repeat(12), author: 'A', authorEmail: 'a@x', date: '2026-01-01T00:00:00Z', subject: 'reformat everything', body: '', files }],
  }, { existingFiles: files.map((file) => file.path), coChangeMinimum: 1, maxCommitFiles: 60 });
  assert.deepEqual(stats.coChange, [], 'one 80-file commit would otherwise produce 3160 spurious pairs');
});

test('no history is absence, and absence is reported rather than zeroed', () => {
  const stats = historyStats({ available: false, reason: 'no git history', cap: 2000 });
  assert.equal(stats.available, false);
  assert.equal(stats.commits, 0);
  assert.deepEqual(stats.fixCommits, []);
  assert.match(stats.reason, /no git history/);
});

test('areaEvidence folds file edges into area edges without counting self-imports', () => {
  const graph = importGraph(SOURCES);
  const areas = areaEvidence({ sources: SOURCES, graph, history: { hotFiles: [] } });
  const api = areas.find((area) => area.area === 'src/api');
  assert.deepEqual(api.importsOut.map((entry) => entry.name).sort(), ['src/rag', 'src/store']);
  assert.deepEqual(api.importedBy, []);
  const util = areas.find((area) => area.area === 'src/util');
  assert.deepEqual(util.importedBy.map((entry) => entry.name).sort(), ['src/rag', 'src/store']);
  assert.deepEqual(api.external.map((entry) => entry.name), ['node-fetch']);
});

test('buildEvidence is deterministic over the same inputs', () => {
  const analysis = {
    repoPath: '/x', name: 'fixture', files: { count: 4, source: 'git-ls-files' },
    languages: [], structure: { areas: [] },
  };
  const inputs = { analysis, sources: SOURCES, files: [...SOURCES.keys()], manifests: {}, history: null };
  const first = buildEvidence(inputs);
  const second = buildEvidence(inputs);
  const stripMaps = (value) => JSON.parse(JSON.stringify({ ...value, symbols: { unique: value.symbols.unique, total: value.symbols.total } }));
  assert.deepEqual(stripMaps(first), stripMaps(second));
});

test('a Node built-in is never reported as an external package', () => {
  // Found live on the P3 target: the dependency census filtered built-ins with a private
  // regex while the area tables did not, so an architecture card announced
  // "External packages used here: node:fs". One definition now serves both.
  assert.equal(isBuiltinSpecifier('node:crypto'), true);
  assert.equal(isBuiltinSpecifier('fs'), true);
  assert.equal(isBuiltinSpecifier('lodash'), false);
  assert.equal(isBuiltinSpecifier('@vitejs/plugin-react'), false);

  const sources = new Map([
    ['api/handler.mjs', "import crypto from 'node:crypto';\nimport fs from 'fs';\nimport lodash from 'lodash';\nexport function handler() { return [crypto, fs, lodash]; }\n"],
  ]);
  const graph = importGraph(sources);
  assert.deepEqual(
    graph.external.map((entry) => [entry.specifier, entry.builtin]).sort(),
    [['fs', true], ['lodash', false], ['node:crypto', true]],
  );
  const [area] = areaEvidence({ sources, graph, history: { hotFiles: [] } });
  assert.deepEqual(area.external.map((entry) => entry.name), ['lodash']);
  assert.deepEqual(area.builtins.map((entry) => entry.name).sort(), ['fs', 'node:crypto']);
});
