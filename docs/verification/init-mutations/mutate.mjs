// The init lane's mutation battery, in the D-0032 shape.
//
// WHY THIS FILE IS IN THE TREE AT ALL: it used to live in session scratch, and an
// uncommitted battery cannot carry a demonstrated refusal, cannot be reviewed, and cannot be
// re-run by anyone else. Compliance that lives in scratch is a claim rather than bytes.
//
// THE INCIDENT IT WAS REWRITTEN FOR: the previous version mutated engine/src IN PLACE, and
// other lanes ran their suites through those broken windows. Every captured failure landed
// in the init surface because init was the battery running, so the evidence pointed at my
// code while the cause was my tooling. A tool that makes other people's tests lie is worse
// than no tool.
//
// Four properties. Three are D-0032's, taken from gym-porter's tested pattern module at
// docs/verification/p4-mutations/d0032-pattern.mjs; the fourth is one this battery learned
// the hard way and is offered back.
//
//  1. PRIVATE COPY by default. A mutation is a window in which the source on disk is
//     deliberately broken, and no other process may be able to read it.
//  2. STRUCTURAL REFUSAL of the shared tree, with a loud override. The default path cannot
//     be the dangerous one. Demonstrated firing in refusal-demo.txt, because a check nobody
//     has seen fail is not yet a check.
//  3. THREE-HASH ASSERTION per mutation: before, after mutating, after restoring. The middle
//     must differ (or the anchor matched nothing and NOTHING WAS TESTED, which looks exactly
//     like a successful run) and the last must equal the first (or every later mutation runs
//     against a tree nobody described).
//  4. BASELINE CONTROL, before any mutation runs. This one is not in the pattern module and
//     it is the check that caught this battery lying: the first private-copy version omitted
//     the repo's adapters/ directory, which engine/src/store/sqlite.js imports from OUTSIDE
//     the engine root, so every test file failed to resolve, every run was red, and all 38
//     mutations were scored KILLED for a reason that had nothing to do with any mutation. A
//     broken tree produces a perfect-looking battery. The project's own rule already covers
//     it: a gate that fails on baseline and candidate alike carries no signal.
//
// Usage:
//   node mutate.mjs                 private copy, the only sane default
//   node mutate.mjs <dir>           a tree you already prepared
//   MUTATE_IN_PLACE=1 node mutate.mjs <shared>   announced, and only on purpose
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');
const SHARED = path.join(REPO, 'engine');

const MUTATIONS = JSON.parse(readFileSync(path.join(here, 'mutations.json'), 'utf8'));

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Copy the REPO SHAPE, not just the engine.
 *
 * engine/src/store/sqlite.js imports ../../../adapters/, which resolves outside the engine
 * directory. gym-porter's pattern says to widen the COPY LIST rather than fall back to the
 * shared tree when a battery reaches outside src and test, and this is that widening.
 * adapters is COPIED rather than linked so a mutation aimed there could never reach the
 * shared tree; node_modules is linked because it is large and is never a mutation target.
 */
function makePrivateTree() {
  const workRoot = mkdtempSync(path.join(tmpdir(), 'daijin-init-mutate-'));
  const engine = path.join(workRoot, 'engine');
  for (const entry of ['src', 'test', 'package.json']) {
    cpSync(path.join(SHARED, entry), path.join(engine, entry), { recursive: true });
  }
  cpSync(path.join(REPO, 'adapters'), path.join(workRoot, 'adapters'), { recursive: true });
  symlinkSync(path.join(SHARED, 'node_modules'), path.join(engine, 'node_modules'), 'dir');
  return { engine, workRoot };
}

function runTests(root, files) {
  try {
    execFileSync('node', ['--test', ...files], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true, failed: [] };
  } catch (error) {
    const raw = `${error.stdout || ''}${error.stderr || ''}`;
    const names = [...new Set([...raw.matchAll(/^✖ (.+?) \(\d/gm)].map((match) => match[1]))];
    // Prefer test TITLES. Node also emits one file-level row per failing file, which tells a
    // reader nothing about which assertion caught the mutation.
    const titles = names.filter((name) => !name.endsWith('.test.js'));
    return { ok: false, failed: titles.length > 0 ? titles : names };
  }
}

const requested = process.argv[2] ? path.resolve(process.argv[2]) : null;
const allowShared = process.env.MUTATE_IN_PLACE === '1';

if (requested && requested === SHARED && !allowShared) {
  console.error('REFUSED: this battery does not mutate the shared tree.');
  console.error('Other lanes run their suites against it, and every mutation is a window in which');
  console.error('their tests read deliberately broken source and fail for a defect that belongs to');
  console.error('nobody. That happened, which is why this refusal exists.');
  console.error('');
  console.error('Run without arguments to use a private copy, or set MUTATE_IN_PLACE=1 to say');
  console.error('out loud that you mean the shared tree.');
  process.exit(2);
}

let root = requested;
let cleanup = () => {};
if (!root) {
  const made = makePrivateTree();
  root = made.engine;
  cleanup = () => rmSync(made.workRoot, { recursive: true, force: true });
} else if (root === SHARED) {
  console.warn(`WARNING: mutating the SHARED tree at ${SHARED}.`);
  console.warn('Every mutation is a window in which another process can read broken source.');
}
console.log(`battery tree: ${root}${root === SHARED ? ' (SHARED, overridden)' : ' (private copy)'}`);

const results = [];
try {
  // Property 4: the unmutated tree must be green, or nothing below means anything.
  const baselineFiles = [...new Set(MUTATIONS.flatMap((mutation) => mutation.tests))];
  const baseline = runTests(root, baselineFiles);
  if (!baseline.ok) {
    console.error('\nREFUSED: the UNMUTATED tree is not green, so no result from it would be evidence.');
    console.error(`Failing with no mutation applied: ${baseline.failed.join('; ') || '(see the run output)'}`);
    process.exit(3);
  }
  console.log(`baseline: green across ${baselineFiles.length} file(s)\n`);

  for (const mutation of MUTATIONS) {
    const file = path.join(root, mutation.file);
    const original = readFileSync(file, 'utf8');
    const before = sha256(original);

    writeFileSync(file, original.replace(mutation.from, mutation.to));
    const mutated = sha256(readFileSync(file, 'utf8'));
    if (mutated === before) {
      writeFileSync(file, original);
      console.log(`DEAD-ANCHOR  ${mutation.id}`);
      console.log('               the expression matched nothing, so NOTHING WAS TESTED.');
      results.push({ id: mutation.id, outcome: 'dead-anchor' });
      continue;
    }

    let outcome;
    try {
      outcome = runTests(root, mutation.tests);
    } finally {
      writeFileSync(file, original);
    }
    if (sha256(readFileSync(file, 'utf8')) !== before) {
      console.log(`NOT-RESTORED ${mutation.id}`);
      console.log('               the file was left changed; every later mutation would run against');
      console.log('               a tree nobody described. Stopping.');
      results.push({ id: mutation.id, outcome: 'not-restored' });
      break;
    }

    results.push({ id: mutation.id, outcome: outcome.ok ? 'survived' : 'killed', failing: outcome.failed });
    console.log(`${outcome.ok ? 'SURVIVED    ' : 'killed      '} ${mutation.id}`);
    for (const name of outcome.failed) console.log(`               fails: ${name}`);
  }
} finally {
  cleanup();
}

// Declared versus executed, so a table that silently shrank is visible.
const problems = results.filter((entry) => entry.outcome !== 'killed');
console.log(`\ndeclared: ${MUTATIONS.length}   executed: ${results.length}   killed: ${results.filter((entry) => entry.outcome === 'killed').length}`);
if (problems.length > 0) {
  console.log('NOT KILLS, each of which is a problem rather than a note:');
  for (const entry of problems) console.log(`  ${entry.outcome.padEnd(13)} ${entry.id}`);
}
writeFileSync(path.join(tmpdir(), 'init-mutation-results.json'), `${JSON.stringify(results, null, 2)}\n`);
process.exit(problems.length > 0 || results.length !== MUTATIONS.length ? 1 : 0);
