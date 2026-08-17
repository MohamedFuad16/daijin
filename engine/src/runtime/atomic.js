// Write a file atomically: one temp name per WRITE, renamed into place, cleaned up on
// failure.
//
// THIS EXISTS BECAUSE THE FIX WENT TO A SITE AND NOT TO THE CLASS. `state.js` had
// `${file}.tmp-${process.pid}`, which is the same name for every concurrent write inside
// one process, so two writes clobbered each other's temp file and one rename failed with
// ENOENT. Measured at the time: it failed at two concurrent writes and nine times in ten
// under load. That was fixed in state.js and nowhere else, and the identical expression
// survived at three more sites, which the second ultrareview found.
//
// A shared writer is the difference between fixing three sites and fixing the class: the
// next caller that needs an atomic write inherits the correct behaviour instead of copying
// whichever neighbour it happened to read.
//
// TWO PROPERTIES, not one. The review named the naming; the cleanup was missing at all
// three sites too. A failed write that leaves its temp file behind turns a transient error
// into a permanent scattering of `.tmp` files next to the real ones, which is the kind of
// mess a user finds long after the error that caused it has scrolled away.

import { randomUUID } from 'node:crypto';
import { mkdir as realMkdir, rename as realRename, rm as realRm, writeFile as realWriteFile } from 'node:fs/promises';
import path from 'node:path';

// Per PROCESS is not enough and per write is: the counter distinguishes writes within one
// tick, the uuid distinguishes processes and survives a counter reset, and the pid keeps
// the name readable when someone finds one of these after a crash.
let writeCounter = 0;

/// The temp name for one write. Exported so a test can assert the property that matters,
/// which is that two calls never collide, rather than asserting the format.
export function temporaryNameFor(file) {
  writeCounter += 1;
  return `${file}.tmp-${process.pid}-${writeCounter}-${randomUUID().slice(0, 8)}`;
}

/**
 * Write `contents` to `file` atomically.
 *
 * Dependencies are injectable because three of the four callers already injected their own
 * fs functions for testing, and a shared helper that could not be driven the same way would
 * have been rejected by its own callers.
 */
export async function writeFileAtomic(file, contents, {
  mkdir = realMkdir, writeFile = realWriteFile, rename = realRename, rm = realRm,
} = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = temporaryNameFor(file);
  try {
    await writeFile(temporary, contents, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    // Best effort, and deliberately swallowing its own failure: the caller needs the
    // ORIGINAL error, and a cleanup that throws over it would replace a real diagnosis
    // ("disk full") with an incidental one ("could not remove a temp file").
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

/// The JSON form, which is what most callers want. Two spaces and a trailing newline,
/// matching what every site already wrote.
export async function writeJsonAtomic(file, value, dependencies = {}) {
  return writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, dependencies);
}
