// Deterministic repo file inventory.
//
// Everything downstream of init (the import graph, the convention census, the area map,
// the gold set) is only as reproducible as the file list it starts from, so the list is
// built one of two ways and the way is RECORDED rather than inferred:
//
//   git-ls-files  tracked files only, which is what the repo's own ignore rules already
//                 decided is source. Deterministic across machines and checkouts.
//   walk          a filtered directory walk, for a repo with no git history. The ignore
//                 set below is the fallback's whole honesty budget, so it is a named
//                 constant a user can read rather than a regex buried in a loop.
//
// The chosen source travels with the result. A census taken over an untracked build
// directory and one taken over tracked source are different measurements, and a report
// that does not say which it took cannot be checked later.
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Directories a fallback walk never descends into. */
export const IGNORED_DIRECTORIES = Object.freeze([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out',
  'target', 'vendor', '.next', '.nuxt', 'coverage', '.pytest_cache', '.mypy_cache',
  'DerivedData', '.gradle', 'Pods', '.terraform', '.idea', '.tox', '.cache',
]);

/**
 * Extension to language. The map is data because the language census is a REPORT, not a
 * routing decision: an unknown extension counts as itself rather than vanishing, so a
 * repo written in something this table has never seen still gets an honest inventory.
 */
export const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
  '.kt': 'Kotlin', '.kts': 'Kotlin', '.swift': 'Swift', '.m': 'Objective-C', '.mm': 'Objective-C',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++',
  '.cs': 'C#', '.php': 'PHP', '.scala': 'Scala', '.ex': 'Elixir', '.exs': 'Elixir',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
  '.css': 'CSS', '.scss': 'CSS', '.less': 'CSS', '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
  '.sql': 'SQL', '.md': 'Markdown', '.mdx': 'Markdown',
  '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML',
});

/** Extensions whose files are parsed for imports and measured for conventions. */
export const SOURCE_EXTENSIONS = Object.freeze([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.vue', '.svelte',
]);

const SOURCE_EXTENSION_SET = new Set(SOURCE_EXTENSIONS);

/**
 * Locale-independent string order.
 *
 * Deliberately NOT localeCompare. Collation is locale data: under an English locale
 * localeCompare sorts 'package.json' before 'README.md' by folding case, and under the C
 * locale, or a Node built without full ICU, it does not. Every ordering in init feeds
 * something that is supposed to be reproducible (the file list, the unit order, the
 * evidence digest, the gold-case ids), so an order that changes with the machine's locale
 * would make two correct runs disagree and make the digest useless as a check.
 */
export function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function languageOf(file) {
  const extension = path.extname(file).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] || (extension ? extension.slice(1) : 'no-extension');
}

export function isSourceFile(file) {
  return SOURCE_EXTENSION_SET.has(path.extname(file).toLowerCase());
}

async function gitTrackedFiles(repoPath) {
  // -z because a repo is allowed to contain a filename with a newline in it, and a naive
  // line split would then invent two files that do not exist.
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'ls-files', '-z'], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout.split('\0').filter(Boolean);
}

/**
 * Breadth-first, and BOUNDED IN BOTH FILES AND TIME.
 *
 * It used to walk the entire tree and let the caller trim afterwards, which made the cap a
 * post-hoc lie about a walk that had already happened: on the owner's machine an attached
 * `/` walked the whole disk and analyze never answered, so the home screen span forever
 * awaiting one card. A cap applied after the walk bounds the ANSWER and not the WORK.
 *
 * BOTH bounds are needed and they stop different things. The file cap stops a tree with
 * too many files. The deadline stops a tree that is slow rather than large: a network
 * mount, a fuse filesystem, a directory that blocks on stat. A count cap alone would still
 * hang on ten slow directories, which is the case a laptop actually meets.
 *
 * Breadth-first matters more now that stopping early is possible. Root files are reached
 * before anything nested, so a truncated walk still finds package.json and the manifests
 * that decide gate candidates. The old sort-then-slice could drop them: sorted by full
 * path, `a/deep/thing.js` precedes `package.json`, so a truncated repo could lose its own
 * manifest to files in an early-alphabet directory.
 */
async function walkDirectory(repoPath, ignored, { limit = Infinity, deadline = null } = {}) {
  const found = [];
  const queue = [''];
  let stopped = null;
  while (queue.length > 0) {
    if (found.length >= limit) { stopped = 'file-limit'; break; }
    if (deadline !== null && Date.now() >= deadline) { stopped = 'deadline'; break; }
    const relative = queue.shift();
    const absolute = path.join(repoPath, relative);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sorted at every level so the walk order is the same on every filesystem; readdir
    // order is not specified and two machines would otherwise produce two file lists that
    // hash differently while naming the same files.
    for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
      // CHECKED INSIDE THE ENTRY LOOP, not only between directories. The first version of
      // this bound tested the cap once per directory, so ONE directory holding a million
      // files sailed past it in a single iteration and the walk was unbounded exactly
      // where it most needed bounding. Caught by the test written for the bound itself.
      if (found.length >= limit) { stopped = 'file-limit'; break; }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) queue.push(child);
      } else if (entry.isFile()) {
        found.push(child);
      }
    }
    if (stopped) break;
  }
  return { files: found, stopped };
}

/**
 * List the repo's files, newline-safe and sorted.
 *
 * @returns {Promise<{ files: string[], source: 'git-ls-files'|'walk', truncated: boolean, limit: number }>}
 */
export async function listRepoFiles(repoPath, {
  limit = 50_000,
  timeBudgetMs = 10_000,
  ignoreDirectories = IGNORED_DIRECTORIES,
} = {}) {
  const ignored = new Set(ignoreDirectories);
  let files = null;
  let source = 'walk';
  let stopped = null;
  try {
    // git answers about a REPOSITORY, so it is inherently bounded by what is tracked and
    // needs no cap. This path is why a normal repo never notices any of the below.
    files = await gitTrackedFiles(repoPath);
    source = 'git-ls-files';
  } catch {
    files = null;
  }
  if (!files || files.length === 0) {
    // The bounds are passed IN rather than applied after. This is the fix for the hang:
    // the walk stops at the cap instead of finishing and being trimmed.
    const walked = await walkDirectory(repoPath, ignored, {
      limit,
      deadline: timeBudgetMs === null ? null : Date.now() + timeBudgetMs,
    });
    files = walked.files;
    stopped = walked.stopped;
    source = 'walk';
  }
  const sorted = files.sort((left, right) => compareStrings(left, right));
  // A cap that trims silently would make every count downstream a lie of unknown size, so
  // the flag rides with the list and every report that uses the list prints it. `stopped`
  // says WHICH bound ended it, because "too many files" and "too slow" are different
  // problems with different answers for the user.
  const truncated = stopped !== null || sorted.length > limit;
  return {
    files: truncated && sorted.length > limit ? sorted.slice(0, limit) : sorted,
    source,
    truncated,
    stopped,
    limit,
  };
}

/** Byte size per file, skipping anything unreadable rather than failing the whole init. */
export async function fileSizes(repoPath, files) {
  const sizes = new Map();
  for (const file of files) {
    try {
      const info = await stat(path.join(repoPath, file));
      sizes.set(file, info.size);
    } catch {
      sizes.set(file, 0);
    }
  }
  return sizes;
}

/**
 * Language census: file counts and byte totals, largest first, ties broken by name.
 * Counts are exact integers; nothing here is a percentage, because a percentage without
 * its denominator is the class of number this project has been burned by.
 */
export function languageCensus(files, sizes = new Map()) {
  const totals = new Map();
  for (const file of files) {
    const language = languageOf(file);
    const entry = totals.get(language) || { language, files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += sizes.get(file) || 0;
    totals.set(language, entry);
  }
  return [...totals.values()].sort(
    (left, right) => right.files - left.files || compareStrings(left.language, right.language),
  );
}

/**
 * The area map: the unit an architecture card is written about.
 *
 * A repo's own top level is usually too coarse (everything under src/) and its leaf
 * directories too fine (one card per folder of three files). The rule is one level of
 * descent through a container directory, which is measured rather than assumed: src/,
 * lib/, app/, packages/ and engine/ hold modules, so their CHILDREN are the areas.
 */
export const CONTAINER_DIRECTORIES = Object.freeze([
  'src', 'lib', 'app', 'apps', 'packages', 'engine', 'server', 'client', 'services', 'modules',
]);

export function areaOf(file, containers = CONTAINER_DIRECTORIES) {
  const parts = file.split('/');
  if (parts.length === 1) return '(root)';
  const containerSet = new Set(containers);
  if (containerSet.has(parts[0]) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

export function areaCensus(files, { containers = CONTAINER_DIRECTORIES, sourceOnly = true } = {}) {
  const areas = new Map();
  for (const file of files) {
    if (sourceOnly && !isSourceFile(file)) continue;
    const area = areaOf(file, containers);
    const entry = areas.get(area) || { area, files: [] };
    entry.files.push(file);
    areas.set(area, entry);
  }
  return [...areas.values()]
    .map((entry) => ({ ...entry, fileCount: entry.files.length }))
    .sort((left, right) => right.fileCount - left.fileCount || compareStrings(left.area, right.area));
}

/** Read a text file, returning null instead of throwing: init never dies on one bad file. */
export async function readTextFile(repoPath, file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  try {
    const info = await stat(path.join(repoPath, file));
    if (info.size > maxBytes) return null;
    const content = await readFile(path.join(repoPath, file), 'utf8');
    // A NUL byte means this is not text, whatever its extension claims.
    return content.includes('\0') ? null : content;
  } catch {
    return null;
  }
}
