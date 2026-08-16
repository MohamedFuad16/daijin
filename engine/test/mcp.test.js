import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { renderDraft, writeEvaluationDraft } from '../src/mcp/evaluation.js';
import { MODE_RULES, registerBrainPrompts } from '../src/mcp/prompts.js';
import { discoverBrainResources } from '../src/mcp/resources.js';
import { createBrainServer } from '../src/mcp/server.js';
import { registerBrainTools } from '../src/mcp/tools.js';

function fakeResult() {
  return {
    standing: [], decisions: [{ id: 'd1', type: 'decision', title: 'T', path: 'p', content: 'body' }],
    lessons: [], exemplars: [], chunks: [],
    impact: [{ node: 'mod:web/src/a.js', path: 'editor/src/a.js', depth: 1, root: 'mod:web/src/b.js', rootPath: 'editor/src/b.js' }],
    meta: { retrievedIds: ['d1'], standingIds: [], tokenCount: 10, tokenBudget: 4000 },
  };
}

// A minimal McpServer double: the registrations are what this suite asserts.
function fakeServer() {
  const registry = { tools: new Map(), resources: new Map(), prompts: new Map() };
  return {
    registry,
    registerTool(name, config, handler) { registry.tools.set(name, { config, handler }); },
    registerResource(name, uri, config, handler) { registry.resources.set(name, { uri, config, handler }); },
    registerPrompt(name, config, handler) { registry.prompts.set(name, { config, handler }); },
  };
}

test('the five brain tools register and every read tool is annotated read only', () => {
  const server = fakeServer();
  registerBrainTools(server, { retrieve: async () => fakeResult(), writeEvaluation: async () => ({}) });
  assert.deepEqual([...server.registry.tools.keys()].sort(), [
    'brain.conventions', 'brain.impact_of', 'brain.record_evaluation', 'brain.relevant_adrs', 'brain.search',
  ]);
  for (const name of ['brain.search', 'brain.conventions', 'brain.impact_of', 'brain.relevant_adrs']) {
    assert.equal(server.registry.tools.get(name).config.annotations.readOnlyHint, true, name);
  }
  assert.equal(server.registry.tools.get('brain.record_evaluation').config.annotations.readOnlyHint, false);
});

test('brain.search returns the formatted context as both text and structured content', async () => {
  const server = fakeServer();
  registerBrainTools(server, { retrieve: async () => fakeResult(), writeEvaluation: async () => ({}) });
  const output = await server.registry.tools.get('brain.search').handler({ query: 'q', project: 'demo' });
  assert.deepEqual(output.structuredContent.retrievedIds, ['d1']);
  assert.equal(output.structuredContent.impactCount, 1);
  assert.equal(output.content[0].text, output.structuredContent.context);
  assert.ok(output.structuredContent.context.startsWith('<brain-context'));
});

test('brain.conventions constrains the type filter for the caller', async () => {
  const seen = [];
  const server = fakeServer();
  registerBrainTools(server, {
    retrieve: async (input) => { seen.push(input); return fakeResult(); },
    writeEvaluation: async () => ({}),
  });
  await server.registry.tools.get('brain.conventions').handler({ project: 'demo', area: 'storage' });
  assert.deepEqual(seen[0].types, ['convention', 'principle', 'workflow']);
  assert.equal(seen[0].area, 'storage');
});

test('resource discovery is ordered, extension filtered, and skips the answers directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-brain-'));
  try {
    await mkdir(path.join(root, 'exams'), { recursive: true });
    await mkdir(path.join(root, 'decisions'), { recursive: true });
    await writeFile(path.join(root, 'exams', 'exam-0001.yaml'), 'id: exam-0001\n');
    await writeFile(path.join(root, 'decisions', 'adr-0001.md'), '# ADR\n');
    await writeFile(path.join(root, 'notes.txt'), 'ignored extension');
    await writeFile(path.join(root, 'index.json'), '{}');

    const resources = await discoverBrainResources(root);
    assert.deepEqual(resources.map((item) => item.relative), ['decisions/adr-0001.md', 'index.json']);
    assert.equal(resources[0].uri, 'ai-brain:///decisions/adr-0001.md');
    assert.equal(resources[0].mimeType, 'text/markdown');

    // The skip list is data, so a repo that keeps answers elsewhere can say so.
    const custom = await discoverBrainResources(root, ['decisions']);
    assert.deepEqual(custom.map((item) => item.relative), ['exams/exam-0001.yaml', 'index.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the server takes its roots as input rather than deriving them from its own location', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-brain-'));
  try {
    await writeFile(path.join(root, 'a.md'), '# a\n');
    const built = await createBrainServer({ brainRoot: root, retrieve: async () => fakeResult() });
    assert.deepEqual(built.resources.map((item) => item.relative), ['a.md']);
    assert.deepEqual(built.prompts, [], 'prompts are only registered when engineer rules are supplied');
    await assert.rejects(createBrainServer({ retrieve: async () => fakeResult() }), /requires brainRoot/);
    await assert.rejects(createBrainServer({ brainRoot: root }), /requires a bound retrieve/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a prompt with no engineer rules is refused rather than registered empty', async () => {
  const server = fakeServer();
  await assert.rejects(registerBrainPrompts(server, { retrieve: async () => fakeResult() }), /requires engineerRules/);
  await assert.rejects(registerBrainPrompts(server, { engineerRules: '   ', retrieve: async () => fakeResult() }), /requires engineerRules/);
  assert.equal(server.registry.prompts.size, 0);
});

test('a registered prompt carries the rules, the mode rule, the escaped task, and the context', async () => {
  const server = fakeServer();
  const names = await registerBrainPrompts(server, { engineerRules: 'THE RULES', retrieve: async () => fakeResult() });
  assert.deepEqual(names, Object.keys(MODE_RULES));
  const message = await server.registry.prompts.get('fix-bug').handler({ task: 'fix <script> injection', project: 'demo' });
  const text = message.messages[0].content.text;
  assert.ok(text.startsWith('THE RULES'));
  assert.ok(text.includes(MODE_RULES['fix-bug']));
  assert.ok(text.includes('fix &lt;script&gt; injection'), 'task text is data, never markup');
  assert.ok(text.includes('<brain-context'));
});

test('an evaluation draft is quarantined by its own front matter', () => {
  const rendered = renderDraft({ project: 'demo', task: 't', summary: 's', verdict: 'pass' }, 'evaluation.draft.demo.x');
  assert.ok(rendered.includes('draft: true'), 'every retrieval filter excludes draft units');
  assert.ok(rendered.includes('type: evaluation'));
  assert.ok(rendered.includes('requires the human curation gate'));
});

test('a draft that looks like it carries a secret is refused', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-state-'));
  try {
    await assert.rejects(
      writeEvaluationDraft(
        { project: 'demo', task: 't', summary: 'the key is sk-abcdefghijklmnopqrstuvwxyz', verdict: 'pass' },
        { stateRoot: root, brainRoot: path.join(root, 'brain') },
      ),
      /appears to contain a secret/,
    );
    await assert.rejects(
      writeEvaluationDraft({ project: 'Not A Project', task: 't', summary: 's', verdict: 'pass' }, { stateRoot: root, brainRoot: root }),
      /safe project id/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a clean draft lands in the drafts directory and reports a relative path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'daijin-state-'));
  const brainRoot = path.join(root, 'brain');
  try {
    const result = await writeEvaluationDraft(
      { project: 'demo', task: 'task', summary: 'summary', verdict: 'partial', evidence: ['a'] },
      { stateRoot: root, brainRoot },
    );
    assert.equal(result.status, 'draft');
    assert.ok(result.path.includes(path.join('projects', 'demo', 'evaluations', 'runs', 'drafts')));
    const written = await readFile(path.join(root, result.path), 'utf8');
    assert.ok(written.includes('draft: true'));
    assert.ok(written.includes('&quot;verdict&quot;: &quot;partial&quot;') || written.includes('"verdict": "partial"'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
