// P7 clauses 18 and 19, held as tests rather than as habits.
//
// Both are properties of the SOURCE rather than of any one run, which is why they are scans.
// A discipline nobody can fail is a slogan; these two can fail, and the second half of each
// test shows exactly how.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { stripCommentLines } from '../src/gym/spend-gate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const gymRoot = path.resolve(here, '../src/gym');

/** A provider call: a network fetch, an SDK, or a key read. Prose is not a call, so the scan
 *  runs over code with comment lines removed; the gym's own comments discuss the platform's
 *  model names and its OpenAI-compatible transport at length. */
const PROVIDER_CALL = /\bfetch\s*\(|\bhttps?:\/\/(?!provider\.invalid|other\.invalid)[a-z]|openai|anthropic|OPENROUTER|API_KEY|api_key|Bearer\s/;

/** A write outside a temp directory. Every gym test that writes uses mkdtemp; the platform
 *  twice nearly chased a fixture batch that landed seconds from a real one. */
const REAL_DIRECTORY_WRITE = /(writeFile|mkdir|rm|appendFile)\s*\(\s*['"`](?!\/tmp|\.\/tmp)[^'"`]*(logs|harvest|teacher-inbox|\.daijin)[^'"`]*['"`]/;

async function gymSources() {
  const names = (await readdir(gymRoot)).filter((name) => name.endsWith('.js'));
  return Promise.all(names.map(async (name) => ({
    path: name, source: await readFile(path.join(gymRoot, name), 'utf8'),
  })));
}

async function gymTests() {
  const names = (await readdir(here)).filter((name) => name.startsWith('gym-') && name.endsWith('.test.js'));
  return Promise.all(names.map(async (name) => ({
    path: name, source: await readFile(path.join(here, name), 'utf8'),
  })));
}

test('clause 18: no gym source can reach a provider', async () => {
  const sources = await gymSources();
  assert.ok(sources.length >= 12, `the scan must see the gym, saw ${sources.length} files`);
  const offenders = sources
    .filter((file) => PROVIDER_CALL.test(stripCommentLines(file.source)))
    .map((file) => file.path);
  assert.deepEqual(offenders, [],
    'a gym module can reach a provider; the teacher, the student and the auditor are INJECTED, and zero spend is a property of the code rather than of the test that happens to mock them');

  // The scan can fail, and EVERY BRANCH of it is exercised separately.
  //
  // Found by mutation: a single combined example (a fetch to an https URL with a Bearer
  // header) matched four alternatives at once, so neutering any one of them left the control
  // green and the mutation SURVIVED. A positive control that passes for the wrong reason is
  // the same defect as a gate that cannot fail, one level up.
  const PROVIDER_SHAPES = [
    ['a network call', 'const response = await fetch(endpoint);'],
    ['a provider URL', 'const endpoint = "https://models.example.com/v1/chat";'],
    ['an SDK import', 'import OpenAI from "openai";'],
    ['another SDK', 'import { anthropic } from "sdk";'],
    ['a router key', 'const key = process.env.OPENROUTER_API_KEY;'],
    ['a key read', 'const key = process.env.API_KEY;'],
    ['a bearer header', 'headers.set("Authorization", `Bearer ${token}`);'],
  ];
  for (const [what, shape] of PROVIDER_SHAPES) {
    assert.ok(PROVIDER_CALL.test(stripCommentLines(shape)), `the scan must catch ${what}`);
  }
  // And prose about providers stays prose, or the rule becomes one people silence.
  assert.equal(PROVIDER_CALL.test(stripCommentLines(
    '// The platform ran openai/gpt-5.6 as the teacher and called fetch() in engineer.js.\nexport const x = 1;\n',
  )), false);
});

/**
 * Files permitted to CONTAIN a write-shaped literal, because their subject is offending code.
 *
 * This exemption is narrow and it is not free. Two files hold deliberate counterexamples:
 * the gate scanner's plant set, whose plants are the VERIFIER's and are copied verbatim so
 * they must not be reworded, and this file, which demonstrates the shapes its own rule
 * catches. Without the exemption the rule flags the tests that prove it works, which is how a
 * scan gets silenced.
 *
 * The compensating control is real rather than decorative: an exempt file must confine its
 * ACTUAL writes to a temp directory, checked by requiring `mkdtemp`. An exemption buys the
 * right to quote an offending shape, never the right to write outside a temp directory.
 */
const CLAUSE_19_EXEMPT = Object.freeze([
  {
    path: 'gym-spend-gate.test.js',
    reason: 'holds the verifier plant set verbatim, which necessarily contains gate-writing literals',
  },
  {
    path: 'gym-discipline.test.js',
    reason: 'demonstrates the very shapes this rule catches, so its own counterexamples are literals',
  },
]);

test('clause 19: no gym test writes outside a temp directory', async () => {
  const tests = await gymTests();
  assert.ok(tests.length >= 8, `the scan must see the gym tests, saw ${tests.length} files`);
  const exempt = new Map(CLAUSE_19_EXEMPT.map((entry) => [entry.path, entry.reason]));

  const offenders = tests
    .filter((file) => !exempt.has(file.path))
    .filter((file) => REAL_DIRECTORY_WRITE.test(stripCommentLines(file.source)))
    .map((file) => file.path);
  assert.deepEqual(offenders, [],
    'a gym test writes into a real logs, harvest or .daijin directory; the platform twice nearly chased a fixture batch that had landed seconds from a real one');

  // The exemption is checked, not trusted: every exempt file must exist, must carry a real
  // reason, and must confine its actual writes to a temp directory.
  for (const [name, reason] of exempt) {
    const file = tests.find((entry) => entry.path === name);
    assert.ok(file, `${name} is exempted but does not exist; a stale exemption is a hole`);
    assert.ok(reason.length > 40, `${name} needs a reason someone can argue with`);
    assert.match(file.source, /mkdtemp/, `${name} is exempt from the literal scan and must still write only under mkdtemp`);
  }

  // The failing shapes, composed rather than written, so this file does not have to contain
  // the literals its own rule forbids.
  const shape = (call, target) => `await ${call}(${JSON.stringify(target)}, body);`;
  assert.ok(REAL_DIRECTORY_WRITE.test(shape('writeFile', 'logs/harvest/batch.json')));
  assert.ok(REAL_DIRECTORY_WRITE.test(shape('mkdir', '.daijin/agents')));
  // A path built from a temp root is fine, which is what every gym test actually does.
  assert.equal(REAL_DIRECTORY_WRITE.test('await writeFile(path.join(root, "logs", "x.json"), body);'), false);
});
