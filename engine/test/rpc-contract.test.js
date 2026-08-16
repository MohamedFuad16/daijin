// The contract is PARSED and checked against the implementation.
//
// D-0018 records this pattern from the TUI's suite: read methods.md, extract the method
// rows, and assert the code covers exactly them. A hand-maintained list of methods in a
// test is a second copy of the contract that drifts from the first, and the drift is
// invisible precisely because both are written by the same person on the same day.
//
// It earns its place immediately: v5 added budgetEstimate, and a hand-written list would
// have kept passing without it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JobRunner } from '../src/rpc/jobs.js';
import { CONTRACT_VERSION, ENGINE_VERSION, createMethods } from '../src/rpc/methods.js';
import { EngineState } from '../src/rpc/state.js';

const engineRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractFile = path.join(engineRoot, 'src', 'rpc', 'methods.md');

/// Every method named in a table row: lines shaped `| \`name\` | params | returns |`.
export function parseContractMethods(markdown) {
  const names = new Set();
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\|\s*`([a-zA-Z][a-zA-Z0-9]*)`\s*\|/);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

/// The version in the document's own title, which the contract requires to be bumped in
/// the same edit as the hello value.
export function parseContractVersion(markdown) {
  return markdown.match(/^#\s*Daijin RPC surface,\s*v(\d+)/m)?.[1] ?? null;
}

async function methodTable() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-contract-'));
  const state = new EngineState({ stateRoot });
  const jobs = new JobRunner({ notify: () => {} });
  return { methods: createMethods({ state, jobs }), stateRoot };
}

test('the parser finds method rows and ignores prose backticks', () => {
  // A guard on the guard: a parser that silently matched nothing would make every
  // assertion below vacuously true, which is the classic dead-gate shape.
  const sample = [
    '| method | params | returns |',
    '| --- | --- | --- |',
    '| `hello` | `{ clientVersion }` | `{ engineVersion }` |',
    '| `repoAttach` | `{ repoPath }` | `{ repo }` |',
    'prose mentioning `notAMethod` in the middle of a sentence',
  ].join('\n');
  assert.deepEqual(parseContractMethods(sample), ['hello', 'repoAttach']);
  assert.equal(parseContractVersion('# Daijin RPC surface, v5, FROZEN 2026-08-16'), '5');
});

test('every method in the contract has a handler', async () => {
  const markdown = await readFile(contractFile, 'utf8');
  const contracted = parseContractMethods(markdown);
  assert.ok(contracted.length > 20, `parsed only ${contracted.length} methods; the parser is probably broken`);

  const { methods, stateRoot } = await methodTable();
  try {
    const missing = contracted.filter((name) => typeof methods[name] !== 'function');
    assert.deepEqual(missing, [], 'a contracted method with no handler answers method-not-found, which is a lie about a frozen surface');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('the engine implements nothing the contract does not name', async () => {
  // The other direction. An undocumented method is a surface the TUI cannot rely on and
  // the leader never froze, and it is how a contract quietly stops describing the engine.
  const contracted = new Set(parseContractMethods(await readFile(contractFile, 'utf8')));
  const { methods, stateRoot } = await methodTable();
  try {
    const extra = Object.keys(methods).filter((name) => !contracted.has(name));
    assert.deepEqual(extra, [], 'these methods exist in the engine but not in methods.md');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('hello reports the version in the contract title', async () => {
  // The contract: "contractVersion tracks THIS document's version and must be bumped in
  // the same edit that bumps the title". This is what makes that sentence enforceable.
  const documented = parseContractVersion(await readFile(contractFile, 'utf8'));
  assert.equal(CONTRACT_VERSION, documented,
    'methods.md and the hello constant disagree; bump both in one edit');
});

test('hello reports the version in package.json', async () => {
  // Caught for real by the installer's smoke check on first contact: ENGINE_VERSION was a
  // literal 0.1.0 while the manifest said 0.0.1. The manifest wins, because npm already
  // believes it, and this test is what stops the two drifting again.
  const manifest = JSON.parse(await readFile(path.join(engineRoot, 'package.json'), 'utf8'));
  assert.equal(ENGINE_VERSION, manifest.version,
    'hello.engineVersion must come from the manifest, never from a restated literal');
});

// ---- the ERROR CONVENTION, also read from the contract ---------------------------------
//
// The method rows are not the only enforceable part of methods.md. v5's error convention
// states the deferred-method code, the phase pattern and the minimum hint length as
// numbers, so those numbers can be parsed and checked rather than transcribed into a test
// where they would quietly stop matching the document.

/// The codes methods.md names, as a set, so a code invented in the engine is visible.
export function parseContractCodes(markdown) {
  return [...new Set([...markdown.matchAll(/`(-32\d{3})`/g)].map((match) => match[1]))].sort();
}

/// The minimum hint length the contract requires of a deferred answer.
export function parseHintFloor(markdown) {
  const found = markdown.match(/`data\.hint` of at least (\d+) characters/);
  return found ? Number(found[1]) : null;
}

test('the codes the engine can emit are the codes the contract names', async () => {
  const markdown = await readFile(contractFile, 'utf8');
  const documented = parseContractCodes(markdown);
  assert.ok(documented.includes('-32050'), 'the parser should find the spend code');
  assert.ok(documented.includes('-32001'), 'v5 names the deferred code; the parser must see it');
  assert.ok(documented.includes('-32601'), 'and the code the contract forbids for declared methods');

  const errors = await import('../src/rpc/errors.js');
  // Every non-standard code the engine defines has to be one the contract names. A code
  // invented in the engine is a behaviour the TUI cannot be expected to handle.
  const engineCodes = [errors.ERR_SPEND_REFUSED, errors.ERR_NOT_IMPLEMENTED].map(String);
  for (const code of engineCodes) {
    assert.ok(documented.includes(code), `the engine emits ${code} but methods.md never names it`);
  }
  assert.equal(String(errors.ERR_NOT_IMPLEMENTED), '-32001');
  assert.notEqual(errors.ERR_NOT_IMPLEMENTED, errors.ERR_METHOD_NOT_FOUND,
    'a declared method must never answer method-not-found');
});

test('a deferred answer satisfies the contract shape the document states', async () => {
  const markdown = await readFile(contractFile, 'utf8');
  const floor = parseHintFloor(markdown);
  assert.ok(floor && floor >= 10, `parsed a hint floor of ${floor}; the parser is probably broken`);

  const { notImplemented } = await import('../src/rpc/errors.js');
  const error = notImplemented('gymStatus', 'P4 (gym port)', 'The ledger schema exists; the runner does not.');
  assert.equal(error.code, -32001);
  assert.match(error.data.phase, /^P\d/, 'the contract requires a phase matching /^P\\d/');
  assert.ok(error.data.hint.length >= floor,
    `the contract requires at least ${floor} characters of hint; got ${error.data.hint.length}`);

  // And the phase is REQUIRED, not decorative: an answer that cannot say which phase will
  // implement it tells a user nothing about whether to wait or to act.
  const vague = notImplemented('gymStatus', undefined);
  assert.equal(vague.data.phase, undefined, 'a missing phase is visible rather than invented');
});
