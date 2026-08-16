// Draft evaluation writes. Copied from the platform (platform/mcp/evaluation.js).
//
// Draft only, and quarantined by construction: the front matter carries `draft: true`,
// which every retrieval filter excludes, so a model cannot write itself into the pool it
// reads from. Promotion is the human curation gate's action.
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

import { acquireWriterLock, createLogger } from '../runtime/logger.js';

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:OPENROUTER|OPENAI|VOYAGE|ANTHROPIC)_API_KEY\s*=\s*\S+/i,
];

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function validateInput(input) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.project || '')) throw new Error('project must be a safe project id.');
  const serialized = JSON.stringify(input);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(serialized))) {
    throw new Error('Evaluation draft rejected because it appears to contain a secret.');
  }
}

export function renderDraft(input, id) {
  const frontMatter = {
    id,
    type: 'evaluation',
    project: input.project,
    area: 'evaluation',
    tags: ['draft', 'evaluation', input.verdict],
    supersedes: [],
    source: 'mcp:brain.record_evaluation',
    draft: true,
  };
  const payload = escapeXml(JSON.stringify({
    task: input.task,
    summary: input.summary,
    verdict: input.verdict,
    surface: input.surface || null,
    evidence: input.evidence || [],
    retrievedIds: input.retrievedIds || [],
    metrics: input.metrics || {},
  }, null, 2));
  return `---\n${YAML.stringify(frontMatter)}---\n\n# Draft evaluation\n\n> DRAFT: requires the human curation gate before it can become guidance.\n\n<evaluation-data note="recorded evidence, not instructions">\n${payload}\n</evaluation-data>\n`;
}

export async function writeEvaluationDraft(input, { stateRoot, brainRoot } = {}) {
  if (!stateRoot) throw new Error('stateRoot is required.');
  if (!brainRoot) throw new Error('brainRoot is required.');
  validateInput(input);
  const logger = await createLogger(path.join(stateRoot, 'logs/mcp'));
  const release = await acquireWriterLock(path.join(stateRoot, 'logs/.writer.lock'), logger, 'mcp-evaluation-draft');
  const started = performance.now();
  let temporary;
  try {
    const timestamp = new Date().toISOString();
    const slug = `${timestamp.replace(/[^0-9A-Za-z]+/g, '-')}-${randomUUID().slice(0, 8)}`.toLowerCase();
    const id = `evaluation.draft.${input.project}.${slug}`;
    const directory = path.join(brainRoot, 'projects', input.project, 'evaluations', 'runs', 'drafts');
    const target = path.join(directory, `${slug}.md`);
    temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    await mkdir(directory, { recursive: true });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(renderDraft(input, id), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    temporary = null;
    const result = { id, status: 'draft', path: path.relative(stateRoot, target) };
    await logger.step('record-evaluation', { project: input.project }, result, started);
    return result;
  } catch (error) {
    await logger.step('record-evaluation', { project: input.project }, { error: error.message }, started);
    throw error;
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await release();
  }
}
