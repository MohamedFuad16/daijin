// agentCatalog: zero-spend discovery of Claude Code sub-agent files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { scanAgentCatalog } from '../src/roles/agents.js';

async function agentDir(base, segments) {
  const directory = path.join(base, ...segments);
  await mkdir(directory, { recursive: true });
  return directory;
}

test('frontmatter names the agent; the filename is the id; scopes are labelled', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'agents-home-'));
  const repo = await mkdtemp(path.join(tmpdir(), 'agents-repo-'));
  const userDir = await agentDir(home, ['.claude', 'agents']);
  const projectDir = await agentDir(repo, ['.claude', 'agents']);

  await writeFile(path.join(userDir, 'daijin-teacher.md'),
    '---\nname: daijin-teacher\ndescription: Grades one attempt against the rubric\nmodel: claude-opus-5\n---\n\nBody.\n');
  await writeFile(path.join(projectDir, 'repo-reviewer.md'),
    '---\nname: repo-reviewer\ndescription: Project-local reviewer\n---\n\nBody.\n');

  const agents = await scanAgentCatalog({ repoPaths: [repo], home });
  assert.equal(agents.length, 2);

  const teacher = agents.find((agent) => agent.id === 'daijin-teacher');
  assert.equal(teacher.name, 'daijin-teacher');
  assert.equal(teacher.description, 'Grades one attempt against the rubric');
  assert.equal(teacher.model, 'claude-opus-5');
  assert.equal(teacher.scope, 'user');
  assert.ok(teacher.path.endsWith('daijin-teacher.md'));

  const reviewer = agents.find((agent) => agent.id === 'repo-reviewer');
  assert.equal(reviewer.scope, 'project');
  assert.equal(reviewer.model, null, 'no model in frontmatter is null, never a guess');
});

test('a file with broken frontmatter is LISTED under its filename, never hidden', async () => {
  // The user is choosing among their own files; a scanner that drops one turns a
  // formatting nit into a missing agent, which reads as "daijin lost my agent".
  const home = await mkdtemp(path.join(tmpdir(), 'agents-broken-'));
  const userDir = await agentDir(home, ['.claude', 'agents']);
  await writeFile(path.join(userDir, 'oddball.md'), 'no frontmatter here at all\n');

  const agents = await scanAgentCatalog({ repoPaths: [], home });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'oddball');
  assert.equal(agents[0].name, 'oddball');
  assert.equal(agents[0].description, null);
});

test('missing directories are an empty catalog, not an error', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'agents-none-'));
  const agents = await scanAgentCatalog({ repoPaths: [path.join(home, 'not-a-repo')], home });
  assert.deepEqual(agents, []);
});

test('non-markdown files and subdirectories are ignored', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'agents-mixed-'));
  const userDir = await agentDir(home, ['.claude', 'agents']);
  await writeFile(path.join(userDir, 'notes.txt'), 'not an agent');
  await mkdir(path.join(userDir, 'nested.md'));
  await writeFile(path.join(userDir, 'real.md'), '---\nname: real\n---\nBody.\n');

  const agents = await scanAgentCatalog({ repoPaths: [], home });
  assert.deepEqual(agents.map((agent) => agent.id), ['real']);
});
