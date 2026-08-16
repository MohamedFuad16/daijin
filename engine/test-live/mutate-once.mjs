#!/usr/bin/env node
// Apply ONE mutation, run a command against it, and always put the file back.
//
//   node engine/test-live/mutate-once.mjs <file> <find> <replace> -- <command...>
//
// Built after a lapse of mine, and the lapse is the specification. I mutate a source file,
// run a test, and restore it, dozens of times a day. The restore is a separate decision
// every time, and on the tenth use in one session I reached for `git checkout` instead of
// the copy I had made, on a file carrying an hour of uncommitted work, and destroyed a test
// I had just written. I noticed only because a pass count dropped by one.
//
// THE COUNTER IS NOT "REFUSE TO MUTATE A DIRTY FILE", which was the first suggestion and
// would have blocked the workflow entirely: mutating a file with uncommitted changes is the
// normal case, because the thing under test is usually the thing being written. The defect
// was in the RESTORE path, so the fix is to remove restoring as a decision. This holds the
// original bytes in memory and writes them back in a finally, and the only way to skip that
// is to kill the process.
//
// It also refuses a mutation that would not apply. A mutation whose pattern is absent runs
// the command against unchanged source, the command passes, and the result reads exactly
// like a surviving mutant. That is one of the two ways a survivor can lie; the other is a
// mutation that applies but preserves the information the test measures, which no tool can
// detect and which stays the reader's job.

import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

function usage(message) {
  console.error(`${message}\n\n  node engine/test-live/mutate-once.mjs <file> <find> <replace> -- <command...>\n`);
  process.exitCode = 2;
}

const separator = process.argv.indexOf('--');
if (separator === -1 || separator < 5) {
  usage('a mutation needs a file, a pattern, a replacement, and a command after --');
} else {
  const [file, find, replace] = process.argv.slice(2, 5);
  const command = process.argv.slice(separator + 1);
  await main(path.resolve(file), find, replace, command);
}

async function main(file, find, replace, command) {
  const original = await readFile(file, 'utf8');

  // REFUSE A NO-OP. Running the command against unchanged source produces a pass that reads
  // exactly like a survivor, which is the failure this build has already met once.
  const occurrences = original.split(find).length - 1;
  if (occurrences === 0) {
    console.error(`REFUSED: the pattern is not in ${path.basename(file)}, so this mutation would not apply.`);
    console.error('A mutation that does not apply produces a pass that reads exactly like a survivor.');
    process.exitCode = 2;
    return;
  }
  if (replace !== '' && original.includes(replace) && find !== replace) {
    console.error(`WARNING: the replacement text is already present in ${path.basename(file)}; the mutation may be a no-op in effect.`);
  }

  console.log(`mutating ${path.basename(file)} (${occurrences} occurrence${occurrences === 1 ? '' : 's'}, replacing the first)`);
  let exitCode = null;
  try {
    await writeFile(file, original.replace(find, replace), 'utf8');
    exitCode = await run(command);
  } finally {
    // The original bytes, from memory, always. Not from git, which does not know about
    // uncommitted work, and not from a copy on disk, which is another thing to remember.
    await writeFile(file, original, 'utf8');
    const restored = await readFile(file, 'utf8');
    if (restored !== original) {
      console.error('RESTORE FAILED: the file does not match what was read. Check it before continuing.');
      process.exitCode = 3;
      return;
    }
    console.log(`restored ${path.basename(file)}`);
  }

  if (exitCode === 0) {
    console.log('SURVIVED: the command passed with the mutation applied.');
    console.log('  Either the tests do not cover this behaviour, or the mutation preserved what they measure.');
    console.log('  The second is not detectable from here and stays your job to rule out.');
    process.exitCode = 1;
  } else {
    console.log(`KILLED: the command failed (exit ${exitCode}) with the mutation applied.`);
  }
}

function run(command) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
