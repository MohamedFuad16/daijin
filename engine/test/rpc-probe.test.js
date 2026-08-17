// The status probe: bounded in time, and probed once per window rather than per paint.
//
// The defect these pin cost the owner a five-second home screen on every paint. Nothing
// here reaches a real network: the one "remote" host is a local socket that ACCEPTS AND
// NEVER ANSWERS, which is the shape my earlier fixtures all missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRpcServer } from '../src/rpc/server.js';
import { PROBE_TIMEOUT_MS, checkOllama } from '../src/rag/embed.js';

/// A listener that completes the TCP handshake and then says nothing, ever.
///
/// THE CASE EVERY EARLIER FIXTURE MISSED. A refused port returns instantly and a hostname
/// that does not resolve fails instantly, so every unreachable-endpoint test I had written
/// was fast, and none of them could notice a five-second timeout. This is the shape a
/// laptop actually meets: a machine that is asleep, firewalled, or on a VPN that dropped.
async function silentHost() {
  // Sockets are tracked and destroyed on close. A silent server never ends its own
  // connections, so server.close() waits for them forever and the test process never
  // exits - which is the same class of defect as the one under test, in the fixture for it.
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.unref();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a host that accepts and never answers is bounded by the probe timeout', async () => {
  const host = await silentHost();
  try {
    const started = Date.now();
    await assert.rejects(() => checkOllama({
      environment: { OLLAMA_BASE_URL: host.url, EMBEDDING_MODEL: 'bge-m3' },
      timeoutMs: 300,
    }));
    const elapsed = Date.now() - started;
    // A BOUND, not an exact value: the assertion is that the timeout governs, and a wall
    // clock in a test suite is weather. The old code waited 5,000 ms here.
    assert.ok(elapsed < 2_000, `the probe ran for ${elapsed} ms, so the timeout did not govern`);
  } finally {
    await host.close();
  }
});

/// Answers one probe path and hangs on the other, so each request is isolated.
async function halfSilentHost(hangingPath) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url.startsWith(hangingPath)) return; // never responds
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: '0.0.0-test', models: [{ name: 'bge-m3:latest', model: 'bge-m3', digest: 'sha256:x' }] }));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.unref();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('BOTH probe requests honour the timeout, not just whichever fails first', async () => {
  // A mutation hardcoding the timeout on ONE of the two requests survived: they run under
  // Promise.all, so the whole call rejects as soon as EITHER times out, and a fast failure
  // on one masks an unbounded wait on the other. Each request needs its own hanging host.
  for (const hanging of ['/api/version', '/api/tags']) {
    const host = await halfSilentHost(hanging);
    try {
      const started = Date.now();
      await assert.rejects(() => checkOllama({
        environment: { OLLAMA_BASE_URL: host.url, EMBEDDING_MODEL: 'bge-m3' },
        timeoutMs: 300,
      }), `${hanging} hanging must still reject`);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2_000, `${hanging} hanging ran for ${elapsed} ms, so its timeout did not govern`);
    } finally {
      await host.close();
    }
  }
});

test('the shipped timeout is well under the paint budget it broke', () => {
  // Named rather than measured, because measuring the default would put its full cost in
  // the suite on every run. What is asserted is that the constant the code uses is small
  // enough to be survivable on a screen paint, which is the property the number is for.
  assert.ok(PROBE_TIMEOUT_MS <= 2_000, 'a status probe on a screen paint cannot cost seconds');
  assert.ok(PROBE_TIMEOUT_MS >= 500, 'and must not be so tight that a slow-but-working host reads as down');
});

async function harness({ probe, now }) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'probe-state-'));
  const server = createRpcServer({
    stateRoot,
    write: () => {},
    deps: { checkOllama: probe, ...(now ? { now } : {}) },
  });
  return { server, stateRoot };
}

test('repeated paints probe ONCE, which is what turns a slow endpoint from repeated to single', async () => {
  let calls = 0;
  const { server } = await harness({ probe: async () => { calls += 1; throw new Error('unreachable'); } });
  try {
    for (let i = 0; i < 5; i += 1) await server.methods.serveStatus({});
    // FAILURES are cached too. The expensive case is the unreachable endpoint, so a cache
    // that only held successes would have missed the entire defect.
    assert.equal(calls, 1, `five paints made ${calls} probes`);
  } finally {
    await server.close();
  }
});

test('the cache expires, so a user who starts ollama is not told it is down for long', async () => {
  let calls = 0;
  let clock = 1_000;
  const { server } = await harness({
    probe: async () => { calls += 1; throw new Error('unreachable'); },
    now: () => clock,
  });
  try {
    await server.methods.serveStatus({});
    await server.methods.serveStatus({});
    assert.equal(calls, 1, 'inside the window');
    clock += 60_000;
    await server.methods.serveStatus({});
    assert.equal(calls, 2, 'a stale window must re-probe, or recovery looks like breakage');
  } finally {
    await server.close();
  }
});

test('changing the endpoint re-probes AT ONCE rather than serving the old server state', async () => {
  // The cache is keyed on endpoint and model. A cache that outlived a settings change
  // would report the state of a server the engine is no longer using, which is exactly the
  // defect F5 fixed, and it must not come back behind a cache.
  let seen = [];
  const { server } = await harness({
    probe: async ({ environment }) => { seen.push(environment.OLLAMA_BASE_URL ?? null); throw new Error('unreachable'); },
  });
  try {
    await server.methods.serveStatus({});
    await server.methods.settingsSet({ patch: { retrieval: { ollamaBaseUrl: 'http://elsewhere.test:11434' } } });
    await server.methods.serveStatus({});
    assert.equal(seen.length, 2, 'the endpoint changed and the probe did not re-run');
    assert.notEqual(seen[0], seen[1]);
    assert.equal(seen[1], 'http://elsewhere.test:11434');
  } finally {
    await server.close();
  }
});

test('changing the embedding model also re-probes, since the answer is about that model', async () => {
  let calls = 0;
  const { server } = await harness({ probe: async () => { calls += 1; throw new Error('unreachable'); } });
  try {
    await server.methods.serveStatus({});
    await server.methods.settingsSet({ patch: { retrieval: { embeddingModel: 'some-other-model' } } });
    await server.methods.serveStatus({});
    assert.equal(calls, 2, 'the model changed and the cached answer was about the old one');
  } finally {
    await server.close();
  }
});
