// The one place that knows where anything lives, after D-0031.
//
// Before this module the paths were computed by hand in eight files, each joining
// '.daijin' to a repo path. That was survivable while everything lived in one directory.
// It stops being survivable the moment the index moves out of the repo, because a single
// file that keeps the old join does not fail: it opens an empty database at the old path
// and reports an unindexed brain, which reads exactly like a repo nobody has run init on.
//
// The layout is described in LAYOUT.md beside this file. The short version is two axes:
// WHERE a thing lives (the repo, which travels with the project, or the state root, which
// is this machine's view of it) and WHETHER IT CAN BE REGENERATED (derived from the brain,
// or a record that exists nowhere else). The index is the only thing that is both
// machine-scoped and regenerable, which is what makes it disposable.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/// The schema the manifest declares. Bumped when the on-disk shape changes in a way an
/// older or newer daijin has to notice; init reads it before it reads anything else.
export const MANIFEST_SCHEMA = 1;

export const DAIJIN_DIRECTORY = '.daijin';

/// Repo-side paths. These travel with the project and are committed.
export function repoPaths(repoPath) {
  const root = path.join(path.resolve(repoPath), DAIJIN_DIRECTORY);
  return {
    daijinRoot: root,
    manifestPath: path.join(root, 'manifest.json'),
    // CONTRACT. Never ingested, never chunked, never retrieved (D-0031 invariant 1).
    agentsRoot: path.join(root, 'agents'),
    // BRAIN. Canonical markdown; the index is derived from these files and they are not
    // derived from anything.
    brainRoot: path.join(root, 'brain'),
    goldsetPath: path.join(root, 'goldset.yaml'),
    gatesPath: path.join(root, 'gates.yaml'),
    // The owner flips this by hand and it is committed. A machine-local authorization
    // could not be a committed record of a spend decision.
    gatePath: path.join(root, 'GATE'),
    gymDatabasePath: path.join(root, 'gym.sqlite'),
    gymResultsRoot: path.join(root, 'gym', 'results'),
  };
}

/// Machine-side paths for one repo, under the state root.
export function statePaths(stateRoot, repoId) {
  const root = path.join(path.resolve(stateRoot), 'repos', repoId);
  return {
    repoStateRoot: root,
    // Which working tree this was built for. A mismatch means the repo moved or was
    // cloned, and those are indistinguishable from in here.
    originPath: path.join(root, 'origin.json'),
    // DISPOSABLE. Everything under here is regenerable from the brain markdown, and a
    // clear-index removes exactly this directory.
    indexRoot: path.join(root, 'index'),
    databasePath: path.join(root, 'index', 'brain.sqlite'),
    rangeFilePath: path.join(root, 'index', 'discriminating-range.json'),
    sandboxesRoot: path.join(root, 'index', 'sandboxes'),
    // KEPT. Measured on a date by a particular embedder; nothing can recompute the past,
    // so a cleared index must not take these with it.
    recordsRoot: path.join(root, 'records'),
    scoreHistoryPath: path.join(root, 'records', 'score-history.json'),
  };
}

/**
 * Read the manifest, or null when the repo has never been initialised.
 *
 * A CORRUPT manifest is not null. Returning null for unparseable JSON would make init
 * treat a damaged contract as a fresh repo and overwrite it, which turns a recoverable
 * problem into a lost one.
 */
export async function readManifest(repoPath) {
  const file = repoPaths(repoPath).manifestPath;
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`The manifest at ${file} is not valid JSON (${error.message}). Refusing to treat a damaged contract as a fresh repo.`);
  }
}

/**
 * The manifest, written if this repo has never had one.
 *
 * `repoId` is generated ONCE and never regenerated, because it is the key the whole state
 * root is organised by: a new id orphans the index and the measurement history in the same
 * move, and the user sees a fresh floor with no trend behind it and no way to learn why.
 */
export async function ensureManifest(repoPath, { now = Date.now, id = randomUUID } = {}) {
  const existing = await readManifest(repoPath);
  if (existing?.repoId) return existing;
  const paths = repoPaths(repoPath);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    repoId: existing?.repoId || id(),
    createdAt: new Date(now()).toISOString(),
    ...existing,
  };
  await mkdir(paths.daijinRoot, { recursive: true });
  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

/**
 * The id the state root is keyed by, WITHOUT writing anything.
 *
 * A repo with no manifest still has to be addressable: `serveStatus` lists repos that may
 * never have been initialised, and a status call that writes a contract file into a user's
 * repo as a side effect of being looked at is a surprise nobody asked for. Those fall back
 * to a hash of the absolute path, which is stable for as long as the repo does not move
 * and is exactly as good as the old behaviour for a repo that was never initialised.
 */
export function repoIdFor(repoPath, manifest = null) {
  if (manifest?.repoId) return manifest.repoId;
  return `path-${createHash('sha256').update(path.resolve(repoPath)).digest('hex').slice(0, 16)}`;
}

/**
 * Everything one repo's paths resolve to, repo side and machine side together.
 *
 * `ensure: true` writes the manifest if it is missing, which is what init does. Every other
 * caller reads: a daemon method that materialises a contract file merely by being called
 * would put a write on a read path.
 */
export async function repoLayout(repoPath, { stateRoot, ensure = false, now, id } = {}) {
  if (!stateRoot) throw new Error('repoLayout requires a stateRoot; the index no longer lives in the repo.');
  const manifest = ensure ? await ensureManifest(repoPath, { now, id }) : await readManifest(repoPath);
  const repoId = repoIdFor(repoPath, manifest);
  return {
    repoPath: path.resolve(repoPath),
    repoId,
    manifest,
    ...repoPaths(repoPath),
    ...statePaths(stateRoot, repoId),
  };
}

/**
 * Record which working tree an index was built for, and report a mismatch.
 *
 * Returns `{ moved, from }`. A mismatch means the repo was moved or a second clone shares
 * its manifest id, and from in here those two are indistinguishable. Neither is an error:
 * the index is regenerable, so the honest response is to say so and rebuild, and `records/`
 * is untouched because a measurement history is not invalidated by a directory move.
 */
export async function noteOrigin(layout, { now = Date.now } = {}) {
  let previous = null;
  try {
    previous = JSON.parse(await readFile(layout.originPath, 'utf8'));
  } catch {
    previous = null;
  }
  const moved = Boolean(previous?.repoPath) && previous.repoPath !== layout.repoPath;
  await mkdir(layout.repoStateRoot, { recursive: true });
  await writeFile(layout.originPath, `${JSON.stringify({ repoPath: layout.repoPath, at: new Date(now()).toISOString() }, null, 2)}\n`, 'utf8');
  return { moved, from: moved ? previous.repoPath : null };
}
