// Result files, and the drawn-cohort denominator rule.
//
// Ported from platform/exam/scorecard.js (loadExamResultFiles, drawnExamCount). This is one
// of the four platform pieces the utilization audit recovered as a requirement, and it is
// here rather than in the ledger because it is a rule about what a ROW is not:
//
//   A row is evidence of a graded attempt, never of a drawn one.
//
// A cap-death leaves no row at all. Platform cycle 65 drew fourteen exams, four cap-died,
// and the database held ten rows; denominating the cohort on rows reported "0 not measured"
// for the cycle with four unmeasured exams and turned a declining throughput series
// (21.4 -> 50.0 -> 42.9) into a rising one (21.4 -> 50.0 -> 60.0). The only durable record of
// a drawn attempt is its result file, so the cohort is counted from those.
//
// Everything is read from INSIDE the artifact (exam.id, timestamp, mode), never from the
// file name that merely happens to encode them, and the whole set FAILS CLOSED: an
// unreadable directory, an unparseable file, a missing field, or a file that disagrees with
// its own recorded path returns null for the entire set rather than a set with a hole in it.
// A quietly short set under-counts the cohort and reads as a measurement, which is the exact
// failure this metric exists to remove.

import { readdir as readdirNative, readFile as readFileNative, rename, writeFile as writeFileNative } from 'node:fs/promises';
import path from 'node:path';

export const RESULT_FILE_SUFFIX = '-result.json';

/** Result artifact schema version. Bump only with a documented reader change. */
export const RESULT_SCHEMA_VERSION = 1;

export function resultFileName(examId, timestamp) {
  return `${String(timestamp).replaceAll(':', '-')}-${examId}${RESULT_FILE_SUFFIX}`;
}

/**
 * Write one result artifact atomically, and stamp it with where it wrote itself.
 *
 * The self-recorded path is not decoration: `loadResultFiles` refuses a set in which any
 * artifact disagrees with its own path, so a copied or moved artifact is loud instead of
 * silently joining another cycle's cohort.
 */
export async function writeResultFile(directory, result, {
  writeFile = writeFileNative, renameFile = rename, mkdir = null,
} = {}) {
  if (!result?.exam?.id || !result?.timestamp || !result?.mode) {
    throw new Error('A result artifact must carry exam.id, timestamp, and mode before it can be written.');
  }
  if (mkdir) await mkdir(directory, { recursive: true });
  const name = resultFileName(result.exam.id, result.timestamp);
  const file = path.join(directory, name);
  const stamped = { ...result, schemaVersion: RESULT_SCHEMA_VERSION, resultFile: name };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stamped, null, 2)}\n`, 'utf8');
  await renameFile(temporary, file);
  return { file, name, result: stamped };
}

/**
 * Load the evaluation-mode result artifacts in a directory, or null if the set cannot be
 * trusted whole.
 *
 * Only `evaluation` artifacts are kept: a harness-debug run is recorded and never scored, so
 * counting one as a drawn exam would inflate whichever cycle's window it happened to fall in.
 * That filter is the mode quarantine reaching the denominator.
 */
export async function loadResultFiles(directory, dependencies = {}) {
  const list = dependencies.readdir || readdirNative;
  const read = dependencies.readFile || readFileNative;
  let names;
  try {
    names = (await list(directory)).filter((name) => name.endsWith(RESULT_FILE_SUFFIX));
  } catch {
    return null;
  }
  const files = [];
  for (const name of names.sort()) {
    let artifact;
    try {
      artifact = JSON.parse(await read(path.join(directory, name), 'utf8'));
    } catch {
      return null;
    }
    if (artifact.mode !== 'evaluation') continue;
    if (!artifact.exam?.id || !artifact.timestamp) return null;
    if (artifact.resultFile && artifact.resultFile !== name) return null;
    files.push({ path: name, exam: artifact.exam.id, at: artifact.timestamp });
  }
  return files;
}

/**
 * How many exams a cycle DREW, counted from result files.
 *
 * The window's upper bound is this cycle's last row-backed file. Its lower bound is the
 * PRECEDING cycle's last row-backed file, and that is the whole subtlety: bounding the window
 * by this cycle's own first row loses any casualty that came before the first attempt to
 * survive, and a cycle's leading attempts are the ones most likely to be rowless, because a
 * cap-death produces no row. Too generous a window invents attempts by absorbing the previous
 * cycle's tail; too narrow a one loses them by starting after the first casualty. The same
 * join fixes both directions.
 *
 * Returns null rather than a guess when the window cannot be established: the first cycle in
 * a series has no predecessor and therefore no principled lower bound. A null that says "not
 * derivable" is honest; a zero that means "four exams vanished" is not.
 */
export function drawnExamCount(rows, resultFiles, { previousCycleLastFileAt = null } = {}) {
  if (!Array.isArray(resultFiles) || resultFiles.length === 0) return null;
  const rowPaths = new Set(rows.map((row) => row.resultFile).filter(Boolean));
  if (rowPaths.size === 0) return null;
  if (!previousCycleLastFileAt) return null;
  const ordered = resultFiles.filter((file) => file.at && file.exam)
    .sort((left, right) => String(left.at).localeCompare(String(right.at)));
  const rowBacked = ordered.filter((file) => rowPaths.has(file.path));
  // Every row must point at a file in this set. When one does not, the set does not describe
  // the runs it claims to, and the count would be silently short.
  if (rowBacked.length !== rowPaths.size) return null;
  const upper = String(rowBacked.at(-1).at);
  const drawn = new Set(ordered
    .filter((file) => String(file.at) > String(previousCycleLastFileAt) && String(file.at) <= upper)
    .map((file) => file.exam));
  return drawn.size >= rowPaths.size ? drawn.size : null;
}
