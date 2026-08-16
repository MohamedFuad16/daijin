// Git worktree sandbox and diff application. Ported from the platform
// (platform/exam/sandbox.js). One coupling removed: the platform's
// `git clean -fd -e editor/node_modules` hard codes one repository's dependency
// directory. It is TRIVIAL but load bearing, so it is now a configured preserve list;
// forget it and every gate re-runs its install from scratch.
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

// Common dependency directories, preserved across restores so an install survives the
// baseline-to-candidate cycle. Per repo discovery may extend this at init time.
export const DEFAULT_PRESERVE_PATHS = ['node_modules'];

async function git(repository, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout.trim();
}

export async function createSandbox({
  sourceRepo, baseCommit, examId, sandboxesRoot, preservePaths = DEFAULT_PRESERVE_PATHS,
}) {
  await mkdir(sandboxesRoot, { recursive: true });
  const directory = path.join(sandboxesRoot, `${examId}-${randomUUID()}`);
  await git(sourceRepo, ['worktree', 'add', '--detach', '--force', directory, baseCommit]);
  const cleanArgs = ['clean', '-fd', ...preservePaths.flatMap((entry) => ['-e', entry])];
  let cleaned = false;
  return {
    directory,
    preservePaths,
    async restore() {
      await git(directory, ['reset', '--hard', baseCommit]);
      await git(directory, cleanArgs);
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await git(sourceRepo, ['worktree', 'remove', '--force', directory]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
      await git(sourceRepo, ['worktree', 'prune']).catch(() => {});
    },
  };
}

export async function assertSandboxRootEmpty(sandboxesRoot) {
  await mkdir(sandboxesRoot, { recursive: true });
  const entries = (await readdir(sandboxesRoot)).filter((name) => name !== '.gitkeep');
  if (entries.length > 0) throw new Error(`Sandbox leak detected: ${entries.join(', ')}`);
  return true;
}

// After cleanup a run owns exactly one invariant: its own worktree is gone. Asserting the
// whole root instead let a sandbox abandoned by an unrelated crashed run throw from the
// caller's `finally` and discard a result that had already been paid for in full.
export async function assertOwnSandboxRemoved(directory) {
  const present = await stat(directory).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (present) throw new Error(`Sandbox leak detected: ${path.basename(directory)}`);
  return true;
}

// Foreign entries are reported rather than thrown so they stay visible without costing a
// run its work. A stale sandbox is instead refused by `assertSandboxRootEmpty` before any
// spend starts.
export async function foreignSandboxEntries(sandboxesRoot, ownDirectory) {
  await mkdir(sandboxesRoot, { recursive: true });
  const own = ownDirectory ? path.basename(ownDirectory) : null;
  return (await readdir(sandboxesRoot)).filter((name) => name !== '.gitkeep' && name !== own);
}

export function validateUnifiedDiff(diff) {
  if (typeof diff !== 'string' || !diff.trim()) throw new Error('Engineer returned an empty diff.');
  const headers = [...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)];
  if (headers.length === 0) throw new Error('Engineer output is not a git-compatible unified diff.');
  for (const match of headers) {
    for (const relative of [match[1], match[2]]) {
      const parts = relative.split('/');
      if (path.isAbsolute(relative) || parts.includes('..') || parts.includes('.git') || parts.some((part) => /^\.env(?:\.|$)/.test(part))) {
        throw new Error('Engineer diff contains a forbidden path.');
      }
    }
  }
}

function gitApply(repository, args, diff, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', ...args], {
      cwd: repository,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, error: timedOut ? 'git apply timed out.' : stderr.trim(), stdout: stdout.trim() });
    });
    child.stdin.end(diff);
  });
}

export async function applyEngineerDiff(repository, diff, timeoutMs = 30_000) {
  try {
    validateUnifiedDiff(diff);
  } catch (error) {
    return { applied: false, error: error.message };
  }
  const checked = await gitApply(repository, ['--check', '--recount', '--whitespace=error-all'], diff, timeoutMs);
  if (!checked.ok) return { applied: false, error: checked.error || 'git apply --check failed.' };
  const applied = await gitApply(repository, ['--recount', '--whitespace=error-all'], diff, timeoutMs);
  return applied.ok
    ? { applied: true, error: null }
    : { applied: false, error: applied.error || 'git apply failed.' };
}
