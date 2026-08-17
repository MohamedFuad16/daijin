// rolePing: the one real generation that verifies a role's provider, model and key.
//
// Nothing here reaches a network: the "provider" is a local HTTP server speaking each
// wire shape, and the claude CLI is an injected exec. Every test asserts against the
// STORED record too, because a ping that measures and forgets is the observation-point
// defect all over again: the settings screen reads ping from settingsGet, not from the
// call's return value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EngineState } from '../src/rpc/state.js';
import { JobRunner } from '../src/rpc/jobs.js';
import { createMethods } from '../src/rpc/methods.js';
import { pingProvider } from '../src/roles/ping.js';

async function providerServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: [],
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    server,
  };
}

async function fixture({ role = {}, deps = {} } = {}) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'role-ping-'));
  const state = new EngineState({ stateRoot });
  if (Object.keys(role).length) {
    await state.patchSettings({ roles: [{ role: 'engineer', ...role }] });
  }
  const methods = createMethods({ state, jobs: new JobRunner({ notify: () => {} }), deps });
  return { state, methods };
}

test('a ping without consent is refused before anything is resolved or reached', async () => {
  const { methods } = await fixture({ role: { provider: 'openai', model: 'gpt-5.6-sol', keyRef: 'env:NOPE' } });
  await assert.rejects(() => methods.rolePing({ role: 'engineer' }), (error) => {
    assert.match(String(error.data?.hint || error.message), /confirm/i);
    return true;
  });
});

test('an unconfigured role is refused with the missing piece named, not pinged', async () => {
  const { methods } = await fixture();
  await assert.rejects(() => methods.rolePing({ role: 'engineer', confirm: true }), (error) => {
    assert.match(String(error.data?.hint || error.message), /no provider/i);
    return true;
  });
});

test('an openai-shape provider is pinged for one token and the served id is recorded', async () => {
  const seen = [];
  const host = await providerServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, auth: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'glm-5.3-airx', choices: [{ message: { content: 'pong' } }] }));
    });
  });
  try {
    const { state, methods } = await fixture({
      role: { provider: 'zai', model: 'glm-5.3', endpoint: `${host.url}/v1`, keyRef: 'env:PING_TEST_KEY' },
      deps: { resolveKey: async () => 'sk-test-value' },
    });
    const result = await methods.rolePing({ role: 'engineer', confirm: true });

    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    // The identity check: what the provider SAID it served, not what was asked for.
    assert.equal(result.servedModelId, 'glm-5.3-airx');
    assert.equal(typeof result.latencyMs, 'number');
    assert.equal(typeof result.ttftMs, 'number');
    assert.ok(result.at, 'the record carries when it was measured');

    assert.equal(seen.length, 1, 'exactly one generation');
    assert.equal(seen[0].url, '/v1/chat/completions');
    assert.equal(seen[0].auth, 'Bearer sk-test-value');
    assert.equal(seen[0].body.max_tokens, 1, 'one token: a verification, not a conversation');

    // THE STORED RECORD, which is what the settings screen actually reads.
    const settings = await state.settings();
    const engineer = settings.roles.find((row) => row.role === 'engineer');
    assert.equal(engineer.ping.ok, true);
    assert.equal(engineer.ping.servedModelId, 'glm-5.3-airx');
  } finally {
    await host.close();
  }
});

test('anthropic speaks its own shape: /messages, x-api-key, and a version header', async () => {
  const seen = [];
  const host = await providerServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ url: request.url, key: request.headers['x-api-key'], version: request.headers['anthropic-version'] });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ model: 'claude-fable-5', content: [{ type: 'text', text: 'pong' }] }));
    });
  });
  try {
    const { methods } = await fixture({
      role: { provider: 'anthropic', model: 'claude-fable-5', endpoint: `${host.url}/v1`, keyRef: 'env:PING_TEST_KEY' },
      deps: { resolveKey: async () => 'sk-ant-test' },
    });
    const result = await methods.rolePing({ role: 'engineer', confirm: true });
    assert.equal(result.ok, true);
    assert.equal(result.servedModelId, 'claude-fable-5');
    assert.equal(seen[0].url, '/v1/messages');
    assert.equal(seen[0].key, 'sk-ant-test');
    assert.ok(seen[0].version, 'anthropic requires its version header');
  } finally {
    await host.close();
  }
});

test('a refused key is recorded as a failed verification, with the provider sentence and no throw', async () => {
  const host = await providerServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  });
  try {
    const { state, methods } = await fixture({
      role: { provider: 'openai', model: 'gpt-5.6-sol', endpoint: `${host.url}/v1`, keyRef: 'env:PING_TEST_KEY' },
      deps: { resolveKey: async () => 'sk-wrong' },
    });
    const result = await methods.rolePing({ role: 'engineer', confirm: true });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
    assert.match(result.hint, /Incorrect API key/);
    // The failure is a stored fact, not a transient toast.
    const settings = await state.settings();
    assert.equal(settings.roles.find((row) => row.role === 'engineer').ping.ok, false);
  } finally {
    await host.close();
  }
});

test('an unresolvable pointer refuses BEFORE any request leaves the machine', async () => {
  let reached = 0;
  const host = await providerServer((request, response) => { reached += 1; response.end('{}'); });
  try {
    const { methods } = await fixture({
      role: { provider: 'openai', model: 'gpt-5.6-sol', endpoint: `${host.url}/v1`, keyRef: 'env:DEFINITELY_NOT_SET_ANYWHERE_1' },
    });
    await assert.rejects(() => methods.rolePing({ role: 'engineer', confirm: true }), (error) => {
      assert.match(String(error.data?.hint || error.message), /DEFINITELY_NOT_SET_ANYWHERE_1/);
      return true;
    });
    assert.equal(reached, 0, 'no request may leave with no key to carry');
  } finally {
    await host.close();
  }
});

test('claude-code pings through the CLI, keyless, and reads the served id from modelUsage', async () => {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args });
    callback(null, JSON.stringify({ type: 'result', modelUsage: { 'claude-sonnet-5-20260114': {} } }), '');
  };
  const { state, methods } = await fixture({
    role: { provider: 'claude-code', model: 'claude-sonnet-5', agentRef: 'daijin-engineer' },
    deps: { pingProvider: (role, key, options) => pingProvider(role, key, { ...options, execFileImpl }) },
  });
  const result = await methods.rolePing({ role: 'engineer', confirm: true });
  assert.equal(result.ok, true);
  assert.equal(result.httpStatus, null, 'there is no HTTP in a CLI launch, and null says so');
  assert.equal(result.servedModelId, 'claude-sonnet-5-20260114');
  assert.equal(calls[0].command, 'claude');
  assert.ok(calls[0].args.includes('--model'));
  const settings = await state.settings();
  assert.equal(settings.roles.find((row) => row.role === 'engineer').ping.ok, true);
});

test('a missing claude CLI is a recorded failure that names the install, not a crash', async () => {
  const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const execFileImpl = (command, args, options, callback) => callback(enoent, '', '');
  const { methods } = await fixture({
    role: { provider: 'claude-code', model: 'claude-sonnet-5' },
    deps: { pingProvider: (role, key, options) => pingProvider(role, key, { ...options, execFileImpl }) },
  });
  const result = await methods.rolePing({ role: 'engineer', confirm: true });
  assert.equal(result.ok, false);
  assert.match(result.hint, /not on PATH/);
});

test('the endpoint falls back to the catalog default so a fresh role is pingable', async () => {
  // The role has provider and model but no endpoint; the ping must aim at the catalog's
  // endpointDefault rather than refusing. The injected fetch asserts the aim.
  const aimed = [];
  const fetchImpl = async (url) => {
    aimed.push(url);
    return new Response(JSON.stringify({ model: 'gpt-5.6-sol' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { methods } = await fixture({
    role: { provider: 'openai', model: 'gpt-5.6-sol', keyRef: 'env:PING_TEST_KEY' },
    deps: {
      resolveKey: async () => 'sk-test',
      pingProvider: (role, key, options) => pingProvider(role, key, { ...options, fetchImpl }),
    },
  });
  const result = await methods.rolePing({ role: 'engineer', confirm: true });
  assert.equal(result.ok, true);
  assert.equal(aimed[0], 'https://api.openai.com/v1/chat/completions');
});
