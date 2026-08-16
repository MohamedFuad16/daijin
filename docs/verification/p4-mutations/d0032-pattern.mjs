// D-0032 conversion pattern for a Node mutation battery. OFFERED, NOT LANDED.
//
// FROM gym-porter TO init-miner, via the leader. This is NOT a diff, and it is worth being
// exact about why: `mutate-all.mjs` is not in the tree I can read (no file by that name, and
// nothing matching under docs/verification/), so a textual diff would have been written
// against bytes I guessed at. A drop-in you paste and adapt is honest; a diff against
// imagined source is not.
//
// FOUR properties. Take the shapes, not the style.
//
//  1. PRIVATE COPY. A mutation is a window in which the source on disk is deliberately
//     broken. Against a shared tree, any other process's `npm test` can read that broken
//     source, which is a 1-in-5 flake in someone else's lane for a defect that existed for
//     two seconds and belongs to nobody. My own battery caused exactly that, for a month,
//     and I never saw it because every consequence landed outside my lane.
//  2. STRUCTURAL REFUSAL of the shared tree, with a loud override. Not a warning, a refusal:
//     the default path cannot be the dangerous one.
//  3. THREE-HASH ASSERTION per mutation. An expression that matches nothing is a silent
//     no-op and looks EXACTLY like a successful run. Hash before, after mutating, after
//     restoring: the middle must differ, the last must match the first.
//  4. BASELINE CONTROL, contributed BY init-miner after its first private-copy battery lied
//     flawlessly: the copy list missed that engine sources import adapters/ from outside the
//     engine root, so nothing resolved, every test failed, and all 38 mutations scored KILLED
//     with no test having executed. A broken tree produces a PERFECT-LOOKING battery, failing
//     in the direction that reads as total success. The unmutated copy must be GREEN before
//     any mutation is scored, or the battery refuses.
//
//     This is the project's dead-gate rule applied to batteries: a gate that fails on
//     baseline and candidate alike carries no signal. It should have been property 1, and it
//     is here because a second lane paid for it. Running it against my own battery found the
//     same break: one test reaching src/rpc/methods.js could not resolve adapters/, so every
//     mutation whose test set included that file had been scoring an unearned kill.
//
// D-0032 ALSO REQUIRES THE REFUSAL DEMONSTRATED FIRING ONCE before it is trusted. A check
// nobody has seen fail is not yet a check; I demonstrated both of mine against a probe copy
// and found a real bug in my own first attempt that way. `selfTest()` at the bottom does
// that for this file and is runnable: `node d0032-pattern.mjs --self-test`.
//
// Verified by: this file was executed before it was sent. Its self-test passes.

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Property 1 and 2: resolve where the battery may mutate.
 *
 * Returns { root, cleanup }. The default is a private copy; the shared tree is refused unless
 * `allowShared` names the intent, and then it announces itself.
 */
export async function resolveMutationRoot({
  sourceRoot,
  allowShared = process.env.MUTATE_IN_PLACE === '1',
  copy = ['src', 'test', 'package.json'],
  link = ['node_modules'],
  // Paths linked BESIDE the copied root rather than inside it, for sources that import out
  // of the root by relative path. This is the parameter init-miner's break lived in: engine
  // sources reach ../../../adapters, so a copy of src and test alone cannot resolve them.
  // The baseline control is what tells you this list is wrong; without it the battery scores
  // a flawless sweep instead.
  linkSiblings = [],
} = {}) {
  if (!sourceRoot) throw new Error('resolveMutationRoot needs the sourceRoot it may copy from.');
  if (allowShared) {
    // The override exists because a private copy hides one real class of bug: a test that
    // depends on the tree's true location. Someone debugging that must be able to say so out
    // loud, and everyone else must not reach it by default.
    console.warn(`WARNING: mutating the SHARED tree at ${sourceRoot}.`);
    console.warn('Every mutation is a window in which another process can read broken source.');
    return { root: sourceRoot, shared: true, cleanup: async () => {} };
  }
  const workRoot = await mkdtemp(path.join(tmpdir(), 'mutate-'));
  const root = path.join(workRoot, 'engine');
  for (const entry of copy) await cp(path.join(sourceRoot, entry), path.join(root, entry), { recursive: true });
  // Linked rather than copied: a native module is large and is never mutated. Node resolves
  // it by walking up from the copy.
  for (const entry of link) await symlink(path.join(sourceRoot, entry), path.join(root, entry)).catch(() => {});
  for (const entry of linkSiblings) {
    await symlink(path.resolve(sourceRoot, '..', entry), path.join(workRoot, entry)).catch(() => {});
  }
  return { root, shared: false, cleanup: async () => rm(workRoot, { recursive: true, force: true }) };
}

const digest = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

/**
 * Property 4: refuse to score anything until the UNMUTATED copy is green.
 *
 * `run` executes the suite in the copy and resolves true when it PASSED. Throwing rather
 * than returning is deliberate: a battery that continues past a red baseline reports kills
 * it cannot justify, and every one of them looks identical to a real one.
 *
 * Run it INSIDE the copy. The first version of my own moved this check above the chdir, so
 * it measured the shared tree and reported green for any broken copy: a baseline control
 * pointed at the wrong tree is the defect it exists to prevent, one level up.
 */
export async function assertBaselineGreen({ run, describe = 'the unmutated copy' }) {
  const green = await run();
  if (!green) {
    throw new Error(
      `BATTERY REFUSED: ${describe} is NOT GREEN, so every mutation would score KILLED without a `
      + 'single test having run. Nothing after this point would be evidence. The usual cause is an '
      + 'incomplete copy list: sources that import from outside the copied root cannot resolve.',
    );
  }
  return true;
}

/**
 * Property 3: run one mutation with its anchor and restore both asserted.
 *
 * `mutate` receives the source text and returns the mutated text. `run` executes the tests
 * and resolves to true when they FAILED, which is a kill.
 *
 * Returns { outcome, ... } where outcome is 'killed', 'survived', 'dead-anchor', or
 * 'not-restored'. Every outcome except 'killed' is a PROBLEM: a survivor means the code is
 * not pinned, a dead anchor means nothing was tested, and a bad restore means every later
 * mutation ran against a tree nobody described.
 */
export async function runMutation({ name, file, mutate, run }) {
  const before = await digest(file);
  const original = await readFile(file, 'utf8');
  await writeFile(file, mutate(original), 'utf8');
  const mutated = await digest(file);

  if (mutated === before) {
    await writeFile(file, original, 'utf8');
    return { name, outcome: 'dead-anchor', before, detail: 'the expression matched nothing, so nothing was tested' };
  }

  let killed = false;
  try {
    killed = await run();
  } finally {
    await writeFile(file, original, 'utf8');
  }
  const restored = await digest(file);
  if (restored !== before) {
    return { name, outcome: 'not-restored', before, restored, detail: 'the file was left changed; later mutations would run against a tree nobody described' };
  }
  return { name, outcome: killed ? 'killed' : 'survived', before };
}

/** The summary contract: exit non-zero on anything that is not a kill, and say which. */
export function summarize(results, { declared }) {
  const problems = results.filter((result) => result.outcome !== 'killed');
  const executed = results.length;
  console.log(`\ndeclared: ${declared}   executed: ${executed}`);
  if (declared !== executed) {
    console.log(`MISMATCH: ${declared - executed} declared mutation(s) never ran.`);
  }
  for (const problem of problems) console.log(`${problem.outcome.toUpperCase()}: ${problem.name}  ${problem.detail ?? ''}`);
  const ok = problems.length === 0 && declared === executed;
  console.log(ok ? 'All mutations killed.' : `${problems.length + (declared === executed ? 0 : 1)} problem(s). None of them is evidence.`);
  return ok;
}

/**
 * The demonstration D-0032 requires: every refusal path seen to fire, once, before trust.
 *
 * Run it with `node d0032-pattern.mjs --self-test`. It builds a throwaway file and drives
 * each outcome deliberately.
 */
export async function selfTest() {
  const root = await mkdtemp(path.join(tmpdir(), 'd0032-selftest-'));
  const file = path.join(root, 'subject.js');
  await writeFile(file, 'export const value = 1;\n', 'utf8');
  const results = [];

  results.push(await runMutation({
    name: 'a real mutation the tests catch',
    file,
    mutate: (text) => text.replace('value = 1', 'value = 2'),
    run: async () => true,
  }));
  results.push(await runMutation({
    name: 'a mutation nothing catches',
    file,
    mutate: (text) => text.replace('value = 1', 'value = 3'),
    run: async () => false,
  }));
  results.push(await runMutation({
    name: 'an anchor that matches nothing',
    file,
    mutate: (text) => text.replace('this_text_is_absent', 'x'),
    run: async () => true,
  }));
  results.push(await runMutation({
    name: 'a restore that does not restore',
    file,
    mutate: (text) => `${text}// mutated\n`,
    run: async () => {
      await writeFile(file, 'export const value = 999;\n', 'utf8');
      return true;
    },
  }));

  // Property 4 both ways: a green baseline proceeds, a red one refuses before scoring.
  let baselineRefused = null;
  await assertBaselineGreen({ run: async () => true });
  try {
    await assertBaselineGreen({ run: async () => false, describe: 'a deliberately broken copy' });
  } catch (error) {
    baselineRefused = error.message;
  }

  const outcomes = results.map((result) => result.outcome);
  const expected = ['killed', 'survived', 'dead-anchor', 'killed'];
  await rm(root, { recursive: true, force: true });

  // The fourth case is subtle and worth stating: the restore writes back the ORIGINAL text
  // this helper captured, so a test that rewrites the file mid-run is corrected rather than
  // detected. What `not-restored` catches is a restore that fails, not a test that meddles.
  // Naming the bound beats implying a guarantee the code does not give.
  const pass = JSON.stringify(outcomes) === JSON.stringify(expected)
    && /BATTERY REFUSED: a deliberately broken copy is NOT GREEN/.test(baselineRefused ?? '');
  console.log(`self-test outcomes: ${outcomes.join(', ')}`);
  console.log(`baseline refusal fired: ${baselineRefused ? 'yes' : 'NO'}`);
  console.log(pass ? 'self-test PASSED' : `self-test FAILED, expected ${expected.join(', ')}`);
  return pass;
}

if (process.argv.includes('--self-test')) {
  selfTest().then((pass) => { process.exitCode = pass ? 0 : 1; });
}
