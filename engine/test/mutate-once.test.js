// The mutation tool's own guard against a cache that outlives a restore.
//
// tui-builder found this in a tool I wrote and share: a .pyc header records the source
// mtime in WHOLE SECONDS plus its size, and the cache is trusted when both match, so a
// SAME-LENGTH mutation restored inside the same wall-clock second leaves bytecode Python
// believes. A later run then executes mutated bytecode against restored source.
//
// The contamination outlives the tool's invocation, which is what makes it worse than a
// wrong answer: the next unrelated run in that directory inherits it. Both polarities
// exist, and the quiet one is an unrelated later run PASSING against mutated bytecode.
//
// Driven rather than asserted on the source, because a test that greps for the env var
// would pass on a tool that sets it in the wrong place.
//
// ONE CAVEAT FOR WHOEVER MUTATES THIS GUARD: do not mutate the tool USING the tool. The
// outer invocation exports the variable into its child's environment, the child passes it
// on, and the inner instance inherits the very guard you removed. The mutation reads as
// surviving when it was masked. Mutate this file by hand, or run the mutation with the
// variable explicitly unset.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-live', 'mutate-once.mjs');

async function hasPython() {
  try {
    await run('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
}

test('a same-length mutation leaves no bytecode a later run would trust', async (t) => {
  if (!await hasPython()) {
    // Announced, never silent: a skip nobody sees is the same as coverage that does not
    // exist, and this file's whole subject is instruments that lie by omission.
    console.log('  SKIPPED: python3 is not on this machine, so the bytecode guard is unverified here');
    t.skip('python3 unavailable');
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), 'dj-mutate-once-'));
  try {
    await writeFile(path.join(root, 'mod.py'), 'VALUE = 1\n', 'utf8');
    await writeFile(path.join(root, 'check.py'), [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(root)})`,
      'import mod',
      'sys.exit(0 if mod.VALUE == 1 else 1)',
    ].join('\n'), 'utf8');

    // VALUE = 1 -> VALUE = 2 is the same length, which is the case that reproduces: a
    // flipped comparison, a changed constant, one glyph in a table.
    const { stdout } = await run(process.execPath, [
      TOOL, path.join(root, 'mod.py'), 'VALUE = 1', 'VALUE = 2', '--', 'python3', path.join(root, 'check.py'),
    ]).catch((error) => error);
    assert.match(String(stdout), /KILLED/, 'the mutation is caught while it is applied');

    // Checked BEFORE the verification run below, because that run is unguarded and writes
    // its own cache legitimately. The first version asserted this afterwards and failed on
    // its own side effect, which is the same shape as asserting a property after an action
    // that is allowed to violate it.
    const afterTool = await readdir(root);
    assert.equal(afterTool.includes('__pycache__'), false,
      'the tool wrote no bytecode, so nothing it did can outlive it');

    // THE PROPERTY THAT MATTERS: a later, unrelated run sees the restored source. Before
    // the fix this exited 1 against a file that was correct on disk.
    await run('python3', [path.join(root, 'check.py')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
