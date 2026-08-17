// Cloning a public repository into the managed location, so the owner can attach one by
// URL instead of finding a checkout first.
//
// A JOB rather than a repoAttach overload (D-0039). A clone of a real repository takes
// minutes and streams progress, and one method whose behaviour is decided by the shape of
// its argument leaves a client unable to tell whether it is about to get a row back or a
// five minute network operation.
//
// NOT SPEND GATED: git talks to a code host, not to a paid model API, so there is no cost
// to authorize. It is still network egress that writes outside the repository, so both the
// destination and the remote are disclosed in the step stream rather than being silently
// gated. A user should never learn where their disk was written by finding the directory.

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Hosts whose URLs we understand well enough to derive an owner and a name from. */
const SSH_FORM = /^(?:git\+)?ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/;
const SCP_FORM = /^(?:[^@\s]+@)([^:\s]+):(.+)$/;

/**
 * Parse a clone URL into the pieces the managed path is built from.
 *
 * Returns null for anything unparseable, which the caller turns into a refusal BY NAME.
 * Guessing here would be worse than refusing: a URL we half understand becomes a directory
 * in the wrong place, and the owner finds it months later with no idea what put it there.
 */
export function parseCloneUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  let host = null;
  let pathname = null;

  const scp = SCP_FORM.exec(text);
  const ssh = SSH_FORM.exec(text);
  if (ssh) {
    host = ssh[1];
    pathname = ssh[2];
  } else if (scp && !text.includes('://')) {
    // git@github.com:owner/name.git, which is not a URL and does not parse as one.
    host = scp[1];
    pathname = scp[2];
  } else {
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    // FILE URLS AND LOCAL PATHS ARE REFUSED HERE, not because cloning them fails but
    // because this method exists to fetch something remote. A local path is repoAttach's
    // job, and silently accepting it here would put a second copy of a repository the
    // owner already has into a managed directory they did not choose.
    if (!['http:', 'https:', 'git:'].includes(parsed.protocol)) return null;
    if (!parsed.hostname) return null;
    host = parsed.hostname;
    pathname = parsed.pathname;
  }

  const segments = String(pathname)
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (segments.length < 2) return null;
  // The LAST two segments, so a self-hosted forge with a prefix path still yields an owner
  // and a name rather than a directory tree that mirrors somebody's URL scheme.
  const name = segments[segments.length - 1];
  const owner = segments[segments.length - 2];
  if (!/^[\w.-]+$/.test(name) || !/^[\w.-]+$/.test(owner) || !/^[\w.:-]+$/.test(host)) return null;
  // A segment of `..` would climb out of the managed root when joined.
  if ([host, owner, name].some((part) => part === '.' || part === '..')) return null;
  return { host, owner, name };
}

/** Where a parsed URL lands. Host and owner included so two forges cannot collide. */
export function clonePathFor({ host, owner, name }, { stateRoot }) {
  return path.join(stateRoot, 'clones', host, owner, name);
}

async function remoteOf(directory) {
  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: directory });
    return stdout.trim();
  } catch {
    return null;
  }
}

/// Two URLs that differ only by a .git suffix, a trailing slash or scheme are one remote.
function sameRemote(a, b) {
  const left = parseCloneUrl(a);
  const right = parseCloneUrl(b);
  if (!left || !right) return false;
  return left.host === right.host && left.owner === right.owner && left.name === right.name;
}

/**
 * Clone `url` into the managed location, emitting a step per phase.
 *
 * `emit(step, detail, extra)` matches the job runner's shape. The runner owns `finished`,
 * `failed` and `cancelled`; nothing here emits those.
 */
export async function cloneRepository({
  url,
  name = null,
  stateRoot,
  emit = async () => {},
  cancelled = () => false,
  runGit = null,
  depth = null,
}) {
  const git = runGit ?? ((args, options = {}) => run('git', args, options));

  const parsed = parseCloneUrl(url);
  if (!parsed) {
    throw Object.assign(new Error('unparseable repository URL'), {
      hint: `${url} is not a repository URL this can clone. Expected something like https://github.com/owner/name or git@github.com:owner/name.git. A local path is repoAttach's job, not this one.`,
      code: 'unparseable-url',
    });
  }
  // The override renames only the LAST segment, so it cannot collide across owners: two
  // repos both named "engine" from different owners still land in different directories.
  const target = { ...parsed, name: name ? String(name).trim() : parsed.name };
  if (!/^[\w.-]+$/.test(target.name) || target.name === '.' || target.name === '..') {
    throw Object.assign(new Error('unusable name'), {
      hint: `${name} is not usable as a directory name. Use letters, digits, dots, dashes and underscores.`,
      code: 'unusable-name',
    });
  }

  const destination = clonePathFor(target, { stateRoot });
  await emit('resolving', `${url} resolves to ${target.host}/${target.owner}/${target.name}`, {
    url, host: target.host, owner: target.owner, name: target.name, destination,
  });

  // A DESTINATION THAT ALREADY EXISTS is either the same repo cloned twice, which is fine
  // and reuses it, or a different repo wearing the same path, which is refused by name. It
  // is never silently overwritten: that directory may be the only copy of work someone did
  // in a clone.
  let existing = null;
  try {
    existing = await stat(destination);
  } catch { /* absent, which is the ordinary case */ }
  if (existing) {
    if (!existing.isDirectory()) {
      throw Object.assign(new Error('destination is not a directory'), {
        hint: `${destination} exists and is not a directory. Move it, or pass a different name.`,
        code: 'destination-occupied',
      });
    }
    const entries = await readdir(destination);
    if (entries.length) {
      const remote = await remoteOf(destination);
      if (remote && sameRemote(remote, url)) {
        await emit('cloned', `${destination} already holds a clone of this repository; reusing it`, {
          destination, reused: true, remote,
        });
        return { destination, reused: true, host: target.host, owner: target.owner, name: target.name };
      }
      throw Object.assign(new Error('destination already holds a different repository'), {
        hint: remote
          ? `${destination} already holds a clone of ${remote}, which is not ${url}. Pass a different name, or remove that directory yourself.`
          : `${destination} already exists and is not empty, and it is not a git clone of ${url}. Pass a different name, or remove that directory yourself.`,
        code: 'destination-occupied',
      });
    }
  }

  if (cancelled()) return null;
  await mkdir(path.dirname(destination), { recursive: true });
  await emit('cloning', `cloning ${url} into ${destination}; this reaches the network and writes outside the repository`, {
    url, destination,
  });

  // NO SUBMODULE RECURSION. A submodule URL is a second remote the owner did not name, and
  // under-cloning visibly beats fetching something they never asked for. --no-tags and the
  // optional depth keep a first clone from pulling a decade of history nobody reads; the
  // full history is one `git fetch --unshallow` away and the step stream says so.
  const args = ['clone', '--no-recurse-submodules', '--no-tags'];
  if (depth) args.push('--depth', String(depth));
  args.push(url, destination);

  try {
    await git(args, { cwd: stateRoot });
  } catch (error) {
    // The directory git left behind on a failed clone is removed, or the next attempt hits
    // the destination-occupied refusal above and blames the user for git's leftovers.
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    const message = String(error?.stderr || error?.message || '');
    if (/Authentication failed|could not read Username|Permission denied|access rights/i.test(message)) {
      throw Object.assign(new Error('repository is private or needs authentication'), {
        // NAMED, rather than passed through. Git's own "authentication failed" reads as a
        // broken credential to someone who never had one, and the owner's likely case is a
        // private repo they can reach in a browser because they are logged in there.
        hint: `${url} needs authentication, so it is either private or does not exist. Public repositories clone without credentials. For a private one, install the GitHub CLI and run gh auth login, then try again.`,
        code: 'authentication-required',
      });
    }
    if (/not found|Repository not found|does not exist/i.test(message)) {
      throw Object.assign(new Error('repository not found'), {
        hint: `${url} was not found. Check the owner and repository name; a private repository also reports as not found until you authenticate.`,
        code: 'not-found',
      });
    }
    throw Object.assign(new Error('clone failed'), {
      hint: `git could not clone ${url}: ${message.split('\n')[0] || 'no further detail'}`,
      code: 'clone-failed',
    });
  }

  await emit('cloned', `cloned into ${destination}`, { destination, reused: false });
  return { destination, reused: false, host: target.host, owner: target.owner, name: target.name };
}
