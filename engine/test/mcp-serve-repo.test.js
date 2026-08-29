// The per-repo MCP entry, driven over a real stdio pipe.
//
// This is the other end of what mcpSnippet pastes into a coding agent's config, so it is
// tested the way an agent would use it: spawn the process, speak MCP framing, read what
// comes back. The snippet previously pointed at brain-mcp.js, which takes a corpus
// descriptor and opens Postgres, so pasting it produced a config that exited immediately.
// A snippet that pastes a failure is worse than a locked snippet.
//
// Hermetic: sqlite only, no embedder needed for the paths asserted here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { repoLayout } from '../src/state/layout.js';
import { createSqliteStore } from '../src/store/sqlite.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'serve-repo.js');

/// Speak MCP over the child's stdio and collect framed replies.
function mcpClient(args) {
  const child = spawn(process.execPath, [ENTRY, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  let nextId = 0;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // stdout carrying a non-JSON line means something logged into the protocol, which
        // corrupts an MCP session. Surfaced rather than skipped.
        for (const reject of pending.values()) reject.reject(new Error(`non-JSON on stdout: ${line}`));
        pending.clear();
        continue;
      }
      const entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); entry.resolve(message); }
    }
  });
  return {
    child,
    get stderr() { return stderr; },
    request(method, params = {}) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`timed out on ${method}`)); }, 15_000).unref();
      });
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    stop() { child.stdin.end(); child.kill(); },
  };
}

async function brainRepo({ indexed = true } = {}) {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'dj-mcp-'));
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'dj-mcp-state-'));
  await mkdir(path.join(repoPath, '.daijin', 'brain'), { recursive: true });
  // The index lives in the state root after D-0031, and serve-repo is told where that is.
  const layout = await repoLayout(repoPath, { stateRoot, ensure: true });
  await mkdir(layout.indexRoot, { recursive: true });
  const store = await createSqliteStore({
    path: layout.databasePath,
    repoPath,
    project: 'default',
    ...(indexed ? { embedder: { provider: 'ollama', model: 'bge-m3', digest: 'sha256:test', dimension: 4 } } : {}),
  });
  if (indexed) {
    await store.transaction(async () => {
      await store.upsertDocument({
        id: 'web.decision.adr-0001',
        project: 'default',
        type: 'decision',
        path: 'brain/adr-0001.md',
        title: 'Storage layer redesign',
        tags: ['storage'],
        meta: { area: 'storage' },
        content: 'The storage layer moved off the shared mount because file locking is unreliable there.',
        contentHash: null,
      });
      await store.replaceChunks('web.decision.adr-0001', [
        { ordinal: 0, content: 'The storage layer moved off the shared mount.', vector: [1, 0, 0, 0] },
      ]);
    });
  }
  await store.close();
  return { repoPath, stateRoot, layout };
}

test('a repo with no brain is refused BY NAME, before the server starts', async () => {
  // An MCP server that starts against a repo with no brain answers every search with an
  // obscure error from three layers down, and the agent using it cannot learn that the
  // brain was never built.
  const repoPath = await mkdtemp(path.join(tmpdir(), 'dj-nobrain-'));
  const client = mcpClient([repoPath]);
  try {
    const code = await client.exited;
    assert.notEqual(code, 0, 'it must exit rather than serve');
    assert.match(client.stderr, /No brain at/);
    assert.match(client.stderr, /Run init on/, 'and say what to do about it');
  } finally {
    client.stop();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('a brain with no recorded embedder identity is refused, because it was never indexed', async () => {
  const { repoPath, stateRoot } = await brainRepo({ indexed: false });
  const client = mcpClient([repoPath, `--state-root=${stateRoot}`]);
  try {
    const code = await client.exited;
    assert.notEqual(code, 0);
    assert.match(client.stderr, /records no embedder identity|has not been indexed|No brain at/);
  } finally {
    client.stop();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('an indexed repo serves MCP over stdio and advertises the brain tools', async () => {
  const { repoPath, stateRoot } = await brainRepo();
  const client = mcpClient([repoPath, `--state-root=${stateRoot}`]);
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'daijin-test', version: '1' },
    });
    assert.ok(initialized.result, `initialize failed: ${JSON.stringify(initialized.error)}`);
    assert.equal(initialized.result.serverInfo.name, 'daijin-brain');
    client.notify('notifications/initialized');

    const tools = await client.request('tools/list', {});
    const names = tools.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'brain.conventions', 'brain.impact_of', 'brain.record_evaluation', 'brain.relevant_adrs', 'brain.search',
    ], 'the five brain tools an agent gets');

    // The read tools are annotated read-only, which is what tells an agent it may call them
    // freely; the evaluation write is not.
    const search = tools.result.tools.find((tool) => tool.name === 'brain.search');
    assert.equal(search.annotations.readOnlyHint, true);
    const write = tools.result.tools.find((tool) => tool.name === 'brain.record_evaluation');
    assert.equal(write.annotations.readOnlyHint, false);
  } finally {
    client.stop();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('the brain files are exposed as read-only resources', async () => {
  const { repoPath, stateRoot } = await brainRepo();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(repoPath, '.daijin', 'brain', 'adr-0001.md'), '# ADR 1\n', 'utf8');
  const client = mcpClient([repoPath, `--state-root=${stateRoot}`]);
  try {
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    client.notify('notifications/initialized');
    const resources = await client.request('resources/list', {});
    const uris = resources.result.resources.map((row) => row.uri);
    assert.ok(uris.some((uri) => uri.endsWith('adr-0001.md')), 'the brain file is served');
    assert.ok(uris.includes('ai-brain://'), 'and the tree index');
  } finally {
    client.stop();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('--engineer-rules actually registers the prompts it names', async () => {
  // A ONE-WORD TYPO, invisible by construction: the entry passed `engineRulesPath` while
  // createBrainServer destructures `engineerRulesPath`, so the key was DROPPED rather than
  // refused, the guard `engineerRules || engineerRulesPath` stayed false, and the server
  // started with zero prompts and no error at all. This is the entry mcpSnippet pastes into
  // a coding agent's config, so no real user ever received the engineer prompts.
  //
  // The test above proves nothing about this: it accepts `result || error` from
  // prompts/list because it supplies no rules. Naming the file is what makes the assertion
  // able to fail.
  const { writeFile } = await import('node:fs/promises');
  const { repoPath, stateRoot } = await brainRepo();
  const rulesPath = path.join(repoPath, '.daijin', 'agents', 'student.md');
  await mkdir(path.dirname(rulesPath), { recursive: true });
  await writeFile(rulesPath, '# Engineer rules\n\nCite every claim.\n', 'utf8');
  const client = mcpClient([repoPath, `--state-root=${stateRoot}`, `--engineer-rules=${rulesPath}`]);
  try {
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    client.notify('notifications/initialized');
    const prompts = await client.request('prompts/list', {});
    assert.ok(prompts.result, `prompts/list must succeed once rules are supplied: ${JSON.stringify(prompts.error)}`);
    assert.ok(prompts.result.prompts.length > 0, 'the rules file registers at least one prompt');
  } finally {
    client.stop();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('stdout carries MCP framing only', async () => {
  // The entry redirects console.log to stderr before loading the server, because one stray
  // log line into stdout desynchronises an MCP session for the rest of its life. The client
  // above rejects on any non-JSON stdout line, so reaching the end of a session proves it.
  const { repoPath, stateRoot } = await brainRepo();
  const client = mcpClient([repoPath, `--state-root=${stateRoot}`]);
  try {
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    client.notify('notifications/initialized');
    await client.request('tools/list', {});
    await client.request('resources/list', {});
    // prompts/list is EXPECTED to error here: no engineer rules were supplied, so no
    // prompts are registered and the capability is absent. What matters for this test is
    // that the reply is a well-formed envelope on stdout and the session keeps working,
    // because the client above rejects on any non-JSON stdout line.
    const prompts = await client.request('prompts/list', {});
    assert.ok(prompts.result || prompts.error, 'a framed reply either way');

    const stillAlive = await client.request('tools/list', {});
    assert.ok(stillAlive.result, 'the session survives an unsupported call without desynchronising');
  } finally {
    client.stop();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('the snippet the daemon hands out names THIS entry, and the file exists', async () => {
  // The defect this closes: the snippet used to point at brain-mcp.js, which requires a
  // corpus descriptor, so pasting it produced a config that exited immediately. A snippet
  // that pastes a failure is worse than a locked snippet, because the user believes it.
  const { access } = await import('node:fs/promises');
  const { createMethods } = await import('../src/rpc/methods.js');
  const { JobRunner } = await import('../src/rpc/jobs.js');
  const { EngineState } = await import('../src/rpc/state.js');

  const { repoPath, stateRoot } = await brainRepo();
  try {
    const state = new EngineState({ stateRoot });
    await state.attachRepo(repoPath);
    // The measurement history moved to the state root with the relocation: it is
    // machine-scoped and NOT regenerable, so it lives beside the index rather than in it.
    const { writeFile } = await import('node:fs/promises');
    const layout = await repoLayout(repoPath, { stateRoot });
    await mkdir(layout.recordsRoot, { recursive: true });
    await writeFile(layout.scoreHistoryPath, JSON.stringify([
      { at: new Date().toISOString(), caseRate: { exact: 0.92, cases: '23 of 25' }, chosenBudget: 4000 },
    ]), 'utf8');

    const methods = createMethods({ state, jobs: new JobRunner({ notify: () => {} }) });
    const result = await methods.mcpSnippet({ repoPath });
    assert.equal(result.unlocked, true, 'above the threshold, the snippet is offered');

    const config = JSON.parse(result.snippet);
    const [entry, target, stateRootArgument] = config.mcpServers.daijin.args;
    assert.match(entry, /serve-repo\.js$/, 'the snippet names the per-repo entry');
    assert.equal(target, repoPath, 'and the repo it serves');
    // The one number a paste-ready config cannot afford to infer is where the data is: an
    // agent launched under a different HOME would resolve a different default state root,
    // open an empty index, and answer every search with nothing found.
    assert.equal(stateRootArgument, `--state-root=${stateRoot}`);
    await access(entry);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(repoPath, { recursive: true, force: true });
  }
});

test('a blocked init keeps the snippet locked, however good the history row looks', async () => {
  // THE HALF-LANDED WIRING, pinned. mcpUnlock grew a `blocked` parameter with no caller,
  // so the guard existed and never fired. The failure it closes is real and was measured:
  // init blocks (gold set unfit), retrievalScore measures the same unfit gold set and
  // writes "2 of 2" to history, and mcpSnippet - which reads only history - hands out a
  // paste-ready config for a brain the pipeline just refused to certify.
  const { createMethods } = await import('../src/rpc/methods.js');
  const { JobRunner } = await import('../src/rpc/jobs.js');
  const { EngineState } = await import('../src/rpc/state.js');
  const { writeFile } = await import('node:fs/promises');
  const { REPORT_FILE } = await import('../src/init/pipeline.js');

  const { repoPath, stateRoot } = await brainRepo();
  try {
    const state = new EngineState({ stateRoot });
    await state.attachRepo(repoPath);
    const layout = await repoLayout(repoPath, { stateRoot });
    await mkdir(layout.recordsRoot, { recursive: true });
    // A rate that clears the threshold outright, written by retrievalScore.
    await writeFile(layout.scoreHistoryPath, JSON.stringify([
      { at: new Date().toISOString(), caseRate: { exact: 1, cases: '2 of 2' }, chosenBudget: 4000, violations: 0 },
    ]), 'utf8');

    const methods = createMethods({ state, jobs: new JobRunner({ notify: () => {} }) });
    const before = await methods.mcpSnippet({ repoPath });
    assert.equal(before.unlocked, true, 'baseline: with no block recorded the rate alone unlocks');

    // The report the pipeline writes when it refuses to certify a floor.
    const reportPath = path.join(repoPath, REPORT_FILE);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({
      floor: null,
      blocked: {
        at: 'goldset-gates',
        reason: 'The gold set did not pass its own integrity gates, so it is not fit to measure.',
        failed: ['size: 2 case(s), minimum 8'],
        action: 'Mine more material, or attach a repository with more code and history; the gates above name what is short.',
        actionCode: 'gold-set-too-thin',
      },
    }), 'utf8');

    const locked = await methods.mcpSnippet({ repoPath });
    assert.equal(locked.unlocked, false, 'the refusal outranks the rate measured by the gauge it refused');
    assert.equal(locked.snippet, null, 'and no config is handed out');
    assert.match(locked.reason, /did not pass its own integrity gates/);
    assert.match(locked.reason, /2 of 2 is not a floor/);
    assert.match(locked.reason, /Mine more material/, 'the action that clears it travels with the refusal');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(repoPath, { recursive: true, force: true });
  }
});
