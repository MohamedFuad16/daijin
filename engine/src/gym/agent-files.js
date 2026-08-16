// The four instruction files: shipped defaults, user-editable, hash-badged.
//
// RPC v4 agentFileGet returns { content, defaultHash, currentHash, modified }, and `modified`
// drives the settings badge. The badge is the whole design: the files are the user's to edit,
// and the product's obligation is to make an edit VISIBLE rather than to prevent it. The
// harness never rewrites a user's file back to the default, and never silently re-injects a
// section the user removed; prompt.js audits instead, and the audit rides in every result
// artifact.
//
// The defaults live beside the code (agents-defaults/) rather than in the user's repo, so an
// upgrade ships new defaults and the badge shows exactly which files diverge from them.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_ROLES = Object.freeze(['student', 'teacher', 'auditor', 'watcher']);

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultAgentFilePath(role) {
  assertRole(role);
  return path.join(here, 'agents-defaults', `${role}.md`);
}

/** Where a repo's copy lives. `.daijin/agents/<role>.md`, per the plan. */
export function agentFilePath(repoPath, role) {
  assertRole(role);
  return path.join(path.resolve(repoPath), '.daijin', 'agents', `${role}.md`);
}

export function assertRole(role) {
  if (!AGENT_ROLES.includes(role)) throw new Error(`Unknown agent role: ${role ?? '<missing>'}. Roles: ${AGENT_ROLES.join(', ')}.`);
  return role;
}

/** Content hash. Line endings are normalized first: a checkout that rewrote CRLF is not a
 *  user edit, and a badge that lights up for it teaches the user to ignore the badge. */
export function agentFileHash(content) {
  return createHash('sha256').update(String(content).replaceAll('\r\n', '\n')).digest('hex');
}

export async function readDefaultAgentFile(role, { read = readFile } = {}) {
  return read(defaultAgentFilePath(role), 'utf8');
}

/**
 * Read a role's instruction file.
 *
 * A missing repo file reads as the DEFAULT with `installed: false`, rather than as an error:
 * a fresh repo has no `.daijin/agents/` yet, and the gym must be runnable before anyone has
 * opened settings. Writing the defaults to disk is `ensureAgentFiles`, an explicit act.
 */
export async function getAgentFile(repoPath, role, { read = readFile } = {}) {
  assertRole(role);
  const defaultContent = await readDefaultAgentFile(role, { read });
  const defaultHash = agentFileHash(defaultContent);
  const file = agentFilePath(repoPath, role);
  let content = defaultContent;
  let installed = true;
  try {
    content = await read(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    installed = false;
  }
  const currentHash = agentFileHash(content);
  return { role, path: file, content, defaultHash, currentHash, modified: currentHash !== defaultHash, installed };
}

export async function setAgentFile(repoPath, role, content, dependencies = {}) {
  assertRole(role);
  const text = String(content ?? '');
  if (!text.trim()) throw new Error(`Refusing to write an empty ${role} instruction file; an empty rules file silently removes every rule.`);
  const file = agentFilePath(repoPath, role);
  const write = dependencies.writeFile || writeFile;
  const renameFile = dependencies.rename || rename;
  await (dependencies.mkdir || mkdir)(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await write(temporary, text, 'utf8');
  await renameFile(temporary, file);
  return getAgentFile(repoPath, role, dependencies);
}

/** Install any missing defaults. Never overwrites an existing file: an upgrade that
 *  refreshed the user's edited instructions would be an unlogged behavior change to a
 *  measured system. */
export async function ensureAgentFiles(repoPath, dependencies = {}) {
  const installed = [];
  for (const role of AGENT_ROLES) {
    const record = await getAgentFile(repoPath, role, dependencies);
    if (record.installed) continue;
    await setAgentFile(repoPath, role, record.content, dependencies);
    installed.push(role);
  }
  return installed;
}

/** The rules text the cycle runner hands the student. */
export async function studentRules(repoPath, dependencies = {}) {
  return (await getAgentFile(repoPath, 'student', dependencies)).content;
}
