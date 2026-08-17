// The custom sub-agent catalog: Claude Code agent definitions found on this machine.
//
// ZERO SPEND AND LOCAL BY CONSTRUCTION, like providers.js: this module reads markdown
// files and has no client to reach. A sub-agent is a file in ~/.claude/agents (user
// scope) or <repo>/.claude/agents (project scope) with YAML frontmatter naming it; the
// owner assigns one to a role instead of an API key, and the gym launches it headless
// through the claude CLI on their login auth.
//
// The frontmatter parse is DELIBERATELY minimal: name, description and model are the
// three keys this catalog renders, they are single-line scalars in every agent file the
// product writes, and a YAML library would be a dependency bought to read three lines.
// A file whose frontmatter cannot be read is listed with its filename as the name rather
// than dropped: the user is choosing among their own files, and a scanner that silently
// hides one turns a formatting nit into a missing agent.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const fields = {};
  for (const line of text.slice(3, end).split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

async function scanDirectory(directory, scope) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const file = path.join(directory, entry.name);
    let fields = {};
    try {
      fields = parseFrontmatter(await readFile(file, 'utf8'));
    } catch {
      fields = {};
    }
    const id = entry.name.replace(/\.md$/, '');
    agents.push({
      id,
      name: fields.name || id,
      description: fields.description || null,
      model: fields.model || null,
      path: file,
      scope,
    });
  }
  return agents;
}

/**
 * Every sub-agent visible to this machine, user scope first, then each repo's project
 * scope. A project agent with the same id as a user one is a DIFFERENT row, not a
 * shadow: which definition wins is the claude CLI's business, and this catalog reports
 * what exists rather than adjudicating.
 */
export async function scanAgentCatalog({ repoPaths = [], home = homedir() } = {}) {
  const agents = await scanDirectory(path.join(home, '.claude', 'agents'), 'user');
  for (const repoPath of repoPaths) {
    agents.push(...await scanDirectory(path.join(repoPath, '.claude', 'agents'), 'project'));
  }
  return agents;
}
