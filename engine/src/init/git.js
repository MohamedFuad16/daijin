// Local git history access.
//
// The plan's rule (exam mining funnel section): history is read by a local git walk with
// `git log --numstat`, and huge histories are capped by config WITH THE CAP DISPLAYED,
// never silently. So every function here reports what it could not see. A history read
// that quietly stopped at 2,000 commits and a history read that reached the root commit
// produce different ownership statistics, and only one of them is the repo's.
//
// Nothing here is a network call and nothing here writes: `git log`, `git rev-list`,
// `git rev-parse`. A repo with no commits, no git, or no git binary is a supported case
// that returns `available: false` with a reason, because the alternative is an init that
// refuses to run on a directory that is not a repository yet.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default history cap. Displayed with every capped result, per the plan. */
export const DEFAULT_COMMIT_CAP = 2_000;

const RECORD_SEPARATOR = '\u001e';
const FIELD_SEPARATOR = '\u001f';

async function git(repoPath, args, { timeout = 120_000, maxBuffer = 128 * 1024 * 1024 } = {}) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], { timeout, maxBuffer });
  return stdout;
}

export async function isGitRepository(repoPath) {
  try {
    const stdout = await git(repoPath, ['rev-parse', '--is-inside-work-tree'], { timeout: 15_000 });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Total commits reachable from HEAD, or null when there is no history to count.
 *
 * null and 0 are different facts: null is "this is not a repository with commits", 0 is
 * never returned by rev-list on a valid HEAD. The analyze contract carries the null
 * through rather than flattening it to zero, because a zero commit count would let the
 * history-dependent Layer 1 evidence look measured-and-empty rather than absent.
 */
export async function commitCount(repoPath) {
  try {
    const stdout = await git(repoPath, ['rev-list', '--count', 'HEAD'], { timeout: 60_000 });
    const value = Number(stdout.trim());
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Parse `git log --numstat` output in the record format this module requests.
 *
 * Exported and pure so the parser is tested against captured output rather than only
 * through a live repo: the numstat quirks (binary files report '-', renames report a
 * three-part path) are exactly the kind of detail a live-only test passes by accident.
 */
export function parseLog(stdout) {
  const commits = [];
  for (const block of stdout.split(RECORD_SEPARATOR)) {
    if (!block.trim()) continue;
    const [header, ...rest] = block.split('\n');
    const [sha, author, authorEmail, date, subject] = header.split(FIELD_SEPARATOR);
    if (!sha) continue;
    const files = [];
    let body = '';
    let inBody = true;
    for (const line of rest) {
      const numstat = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (numstat) {
        inBody = false;
        const [, added, deleted, rawPath] = numstat;
        // `a/{b => c}/d` and `old => new` are rename notations; the post-rename path is
        // the one that exists now, which is the one every downstream lookup uses.
        const renamed = rawPath.includes(' => ');
        const file = renamed
          ? rawPath.replace(/\{([^}]*) => ([^}]*)\}/g, '$2').replace(/^.* => /, '')
          : rawPath;
        files.push({
          path: file,
          added: added === '-' ? null : Number(added),
          deleted: deleted === '-' ? null : Number(deleted),
          binary: added === '-' && deleted === '-',
          renamed,
        });
      } else if (inBody && line.length > 0) {
        body += `${line}\n`;
      }
    }
    commits.push({
      sha,
      shortSha: sha.slice(0, 12),
      author: author || '',
      authorEmail: authorEmail || '',
      date: date || '',
      subject: subject || '',
      body: body.trim(),
      files,
    });
  }
  return commits;
}

/**
 * Walk the history, newest first, capped.
 *
 * @returns {Promise<{ available: boolean, reason: string|null, commits: object[], capped: boolean,
 *                     cap: number, total: number|null }>}
 */
export async function readHistory(repoPath, { cap = DEFAULT_COMMIT_CAP, includeMerges = false } = {}) {
  const total = await commitCount(repoPath);
  if (total === null) {
    return {
      available: false,
      reason: 'no git history: the path is not a git work tree, or HEAD has no commits',
      commits: [], capped: false, cap, total: null,
    };
  }
  // The header is one line of separator-joined fields; the BODY follows on its own lines
  // because it is the only multi-line field, and revert detection reads it ("This reverts
  // commit <sha>" lives in the body, never the subject). parseLog treats every non-numstat
  // line after the header as body, which is exactly this layout.
  const format = `${[`${RECORD_SEPARATOR}%H`, '%an', '%ae', '%aI', '%s'].join(FIELD_SEPARATOR)}\n%b`;
  const args = ['log', `--max-count=${cap}`, '--numstat', `--format=${format}`];
  if (!includeMerges) args.push('--no-merges');
  let stdout;
  try {
    stdout = await git(repoPath, args);
  } catch (error) {
    return { available: false, reason: `git log failed: ${error.message}`, commits: [], capped: false, cap, total };
  }
  const commits = parseLog(stdout);
  return {
    available: true,
    reason: null,
    commits,
    // total counts merges, the walk excludes them by default, so the cap flag is derived
    // from the walk's own length against the cap rather than from total > cap, which
    // would raise a false "capped" on any repo with more merges than the difference.
    capped: commits.length >= cap && total > commits.length,
    cap,
    total,
  };
}

const REVERT_SUBJECT = /^Revert\s+"/i;
const REVERT_BODY = /This reverts commit ([0-9a-f]{7,40})/i;
const FIX_SUBJECT = /^(fix|bugfix|hotfix|patch)(\([^)]*\))?[:!]|^fix(es|ed)?\s|\b(bug ?fix|regression|hotfix)\b/i;

/**
 * Classify a commit's intent from its message alone.
 *
 * Deliberately shallow: this is the DETERMINISTIC filter that feeds candidates to a later
 * judgment step, and a shallow filter that a human can re-run by eye is worth more here
 * than a clever one nobody can audit. The classification never becomes a lesson on its
 * own; per the plan, errors.md starts empty and the LLM narration step (out of Layer 1)
 * is the only thing allowed to turn a fix commit into prose.
 */
export function classifyCommit(commit) {
  const revert = REVERT_SUBJECT.test(commit.subject) || REVERT_BODY.test(commit.body || '');
  const revertsSha = commit.body?.match(REVERT_BODY)?.[1] || null;
  return {
    revert,
    revertsSha,
    fix: !revert && FIX_SUBJECT.test(commit.subject),
    docsOnly: commit.files.length > 0 && commit.files.every((file) => /\.(md|mdx|txt|rst)$/i.test(file.path)),
    lockfileOnly: commit.files.length > 0 && commit.files.every(
      (file) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/.test(file.path),
    ),
    renameOnly: commit.files.length > 0 && commit.files.every((file) => file.renamed && !file.added && !file.deleted),
    binaryOnly: commit.files.length > 0 && commit.files.every((file) => file.binary),
    empty: commit.files.length === 0,
  };
}

/** Does this sha exist in the walked history: the provenance gate's resolver. */
export function shaIndex(commits) {
  const index = new Set();
  for (const commit of commits) {
    index.add(commit.sha);
    index.add(commit.shortSha);
  }
  return index;
}
