// analyze(repoPath): the scan that runs BEFORE anything is decided.
//
// Contract: RPC v4 `analyze` returns { languages, commitCount, structure, gateCandidates,
// hasBrainFolder }. Those five fields are the frozen surface; everything else this
// function returns is additive detail the TUI may ignore.
//
// Three properties are load-bearing:
//
//   Deterministic. Two runs over an unchanged tree return identical bytes. Nothing here
//   reads the clock, and the file list is sorted at the source (walk.js).
//   Zero-spend. No provider, no network, and no execution of the repo's own code. Gate
//   candidates are PROBED here and RUN later (gate-discovery.js), so a user can see what
//   Daijin proposes to execute before it executes anything.
//   Honest about absence. A repo with no git history returns commitCount null, not 0, and
//   an unreadable file lowers a count rather than aborting the scan. Every count that
//   could have been truncated carries its cap.
import path from 'node:path';

import { commitCount, isGitRepository } from './git.js';
import { collectGateSources, probeGateCandidates } from './gate-discovery.js';
import { areaCensus, compareStrings, fileSizes, isSourceFile, languageCensus, listRepoFiles, readTextFile } from './walk.js';

/**
 * Knowledge folders Daijin recognises, in the order it prefers them.
 *
 * `hasBrainFolder` decides the init branch: an existing folder is INGESTED as-is (with an
 * auditor drift check later), a missing one is GENERATED. Guessing wrong in the ingest
 * direction is the costly error, so a directory only counts when it holds at least one
 * markdown file: an empty `docs/` is not a brain and must not divert the pipeline.
 */
export const BRAIN_FOLDER_CANDIDATES = Object.freeze([
  { directory: 'agent', kind: 'agent-folder' },
  { directory: '.daijin/brain', kind: 'daijin' },
  { directory: 'ai-brain', kind: 'ai-brain' },
  { directory: 'brain', kind: 'brain' },
  { directory: '.brain', kind: 'brain' },
]);

/** Manifests worth naming in the structure report. */
const MANIFEST_FILES = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Package.swift',
  'composer.json', 'mix.exs', 'CMakeLists.txt',
];

export function detectBrainFolder(files, candidates = BRAIN_FOLDER_CANDIDATES) {
  for (const candidate of candidates) {
    const prefix = `${candidate.directory}/`;
    const held = files.filter((file) => file.startsWith(prefix));
    const markdown = held.filter((file) => /\.mdx?$/i.test(file));
    if (markdown.length > 0) {
      return {
        present: true,
        directory: candidate.directory,
        kind: candidate.kind,
        files: held.length,
        markdownFiles: markdown.length,
        // Named so the ingest branch can report what it is about to read rather than a count.
        sample: markdown.slice(0, 10),
      };
    }
  }
  return { present: false, directory: null, kind: null, files: 0, markdownFiles: 0, sample: [] };
}

/**
 * Directory shape: top-level entries with their file counts, plus the derived areas an
 * architecture card will be written about.
 */
export function describeStructure(files, sizes) {
  const topLevel = new Map();
  for (const file of files) {
    const parts = file.split('/');
    const name = parts.length === 1 ? '(root files)' : parts[0];
    const entry = topLevel.get(name) || { name, files: 0, bytes: 0, directory: parts.length > 1 };
    entry.files += 1;
    entry.bytes += sizes.get(file) || 0;
    topLevel.set(name, entry);
  }
  const sourceFiles = files.filter(isSourceFile);
  return {
    totalFiles: files.length,
    sourceFiles: sourceFiles.length,
    totalBytes: [...sizes.values()].reduce((sum, value) => sum + value, 0),
    maxDepth: files.reduce((deepest, file) => Math.max(deepest, file.split('/').length), 0),
    topLevel: [...topLevel.values()].sort(
      (left, right) => right.files - left.files || compareStrings(left.name, right.name),
    ),
    manifests: MANIFEST_FILES.filter((name) => files.includes(name)),
    areas: areaCensus(files).map(({ area, fileCount }) => ({ area, fileCount })),
  };
}

/**
 * Scan a repo. Zero-spend, deterministic, no repo code executed.
 *
 * @param {string} repoPath absolute path to the repo root
 */
export async function analyze(repoPath, { fileLimit = 50_000 } = {}) {
  const root = path.resolve(repoPath);
  const listing = await listRepoFiles(root, { limit: fileLimit });
  const sizes = await fileSizes(root, listing.files);
  const git = await isGitRepository(root);
  const commits = git ? await commitCount(root) : null;
  const { manifests, texts } = await collectGateSources(root, listing.files);

  const rootManifest = manifests['package.json'] || null;
  return {
    repoPath: root,
    name: rootManifest?.name || path.basename(root),
    // --- the five frozen contract fields ---
    languages: languageCensus(listing.files, sizes),
    commitCount: commits,
    structure: describeStructure(listing.files, sizes),
    gateCandidates: probeGateCandidates({ files: listing.files, manifests, texts }),
    hasBrainFolder: detectBrainFolder(listing.files).present,
    // --- additive detail ---
    brainFolder: detectBrainFolder(listing.files),
    git: {
      repository: git,
      // A repo with git but no commits is a real state (this very repo was in it at P0),
      // and it is the state where every history-derived evidence table must come back
      // empty rather than absent-with-an-error.
      history: git && commits !== null,
    },
    files: {
      count: listing.files.length,
      source: listing.source,
      truncated: listing.truncated,
      limit: listing.limit,
    },
  };
}

/**
 * Read the raw text of every source file once, for the evidence pass.
 *
 * Separate from analyze() because analyze is the cheap scan the home screen runs on every
 * repo card, and reading every source file is not cheap. Callers that need content ask
 * for it explicitly.
 */
export async function readSources(repoPath, files, { maxFiles = 20_000 } = {}) {
  const sources = new Map();
  let skipped = 0;
  for (const file of files.filter(isSourceFile).slice(0, maxFiles)) {
    const text = await readTextFile(repoPath, file);
    if (text === null) skipped += 1;
    else sources.set(file, text);
  }
  return { sources, skipped, considered: files.filter(isSourceFile).length, maxFiles };
}
