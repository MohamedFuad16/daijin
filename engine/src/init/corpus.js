// Corpus descriptors: everything the score harness needs to measure a brain that is not
// this repository's.
//
// A corpus is where a Brain's gold set, its curated retrieval fixes, its committed floor
// and its store connection live. Daijin's own repos will carry this inside the per repo
// settings store; the descriptor exists so P1 can measure the PLATFORM corpus from the
// Daijin repo without copying that project's data into this one.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { PLATFORM_PATH_GRAMMAR, GENERIC_PATH_GRAMMAR } from '../rag/paths.js';
import { loadEnvironmentFiles } from '../runtime/embedding-identity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORPORA_DIR = path.join(here, 'corpora');

const GRAMMARS = { platform: PLATFORM_PATH_GRAMMAR, generic: GENERIC_PATH_GRAMMAR };

function resolveTemplate(value, variables) {
  return String(value).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    if (!(key in variables)) throw new Error(`Corpus descriptor references unknown variable ${key}.`);
    return variables[key];
  });
}

/// Read a corpus descriptor and resolve its paths.
///
/// `root` may be overridden from the environment so a descriptor committed here does not
/// pin another checkout to one machine's directory layout.
export async function loadCorpus(descriptorPath) {
  const raw = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const root = (raw.rootEnv && process.env[raw.rootEnv]?.trim()) || raw.root;
  if (!root) throw new Error(`Corpus ${raw.id} has no root; set ${raw.rootEnv || 'root'}.`);
  const variables = { root };
  const resolve = (value) => (value ? path.resolve(resolveTemplate(value, variables)) : null);
  return {
    id: raw.id,
    project: raw.project,
    root,
    goldsetPath: resolve(raw.goldset),
    retrievalFixesPath: resolve(raw.retrievalFixes),
    baselinePath: resolve(raw.baseline),
    envFiles: (raw.envFiles || []).map(resolve),
    databaseUrlEnv: raw.databaseUrlEnv || 'DATABASE_URL',
    pathGrammar: GRAMMARS[raw.pathGrammar || 'generic'],
    standingPrefix: raw.standingPrefix || undefined,
    retrieveOptions: raw.retrieveOptions || {},
    // Backend options for this corpus. `parityMode` is the one that matters today: the
    // extraction fixture asks the pgvector store for the platform's exact statements.
    storeOptions: raw.storeOptions || {},
    note: raw.note || null,
  };
}

export async function loadCorpusByName(name) {
  return loadCorpus(path.join(CORPORA_DIR, `${name}.json`));
}

export async function loadGoldset(corpus) {
  return YAML.parse(await readFile(corpus.goldsetPath, 'utf8'));
}

/// Curated retrieval fixes are per corpus data, never engine defaults: each entry is a
/// pin authored in response to a real retrieval defect, and the pins that suit one Brain
/// are meaningless in another.
export async function loadRetrievalFixes(corpus) {
  if (!corpus.retrievalFixesPath) return [];
  const fixes = JSON.parse(await readFile(corpus.retrievalFixesPath, 'utf8'));
  if (!Array.isArray(fixes) || fixes.some((fix) => (
    !fix || typeof fix.targetId !== 'string' || typeof fix.trigger !== 'string'
    || !Array.isArray(fix.sourceRunIds) || fix.sourceRunIds.some((id) => !Number.isInteger(id))
  ))) throw new Error('Curated retrieval fixes file has an invalid entry.');
  return fixes;
}

export async function loadBaseline(corpus) {
  if (!corpus.baselinePath) return null;
  return JSON.parse(await readFile(corpus.baselinePath, 'utf8'));
}

export function loadCorpusEnvironment(corpus) {
  loadEnvironmentFiles(corpus.envFiles);
  const databaseUrl = process.env[corpus.databaseUrlEnv]?.trim();
  if (!databaseUrl) throw new Error(`${corpus.databaseUrlEnv} is required to measure corpus ${corpus.id}.`);
  return { databaseUrl, environment: process.env };
}

/// The same env-file loading WITHOUT the connection-string requirement, for callers that
/// bring their own opened store. Split rather than parameterized so no caller can reach
/// the lenient path by accident: the strict function is still the one a CLI run gets.
export function loadCorpusEnvironmentSoft(corpus) {
  loadEnvironmentFiles(corpus.envFiles);
  return process.env;
}
