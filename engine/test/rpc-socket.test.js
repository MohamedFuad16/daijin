// The attach transport, driven with real sockets and several real clients at once.
//
// Hermetic: unix sockets are filesystem objects, not network, and every daemon here is
// built with injected dependencies that touch no live service.
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertSocketPathFits, clearStaleSocket, daemonSocketPath, MAX_SOCKET_PATH, serveSocket } from '../src/rpc/socket.js';

const OFFLINE = {
  checkOllama: async () => { throw new Error('probe skipped'); },
  createEmbedderClient: () => { throw new Error('embedder unavailable'); },
};

/// A minimal client: its own id counter starting at 1, exactly like the real one, which is
/// what makes the per-connection routing testable.
function client(socketPath) {
  const socket = connect(socketPath);
  const pending = new Map();
  const notifications = [];
  let buffer = '';
  let nextId = 0;
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method && message.id === undefined) { notifications.push(message); continue; }
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return {
    socket,
    notifications,
    ready: new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); }),
    request(method, params = {}) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout on ${method}`)); }, 10_000).unref();
      });
    },
    close() { socket.destroy(); },
  };
}

async function daemon() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-sock-'));
  const served = await serveSocket({ stateRoot, deps: OFFLINE });
  // NOT spread. `connectionCount` is a getter, and spreading would evaluate it once at
  // zero and copy the number, so the handle would report a frozen count forever.
  return {
    served,
    stateRoot,
    socketPath: served.socketPath,
    broadcast: served.broadcast,
    get connectionCount() { return served.connectionCount; },
    async stop() {
      await served.close();
      await rm(stateRoot, { recursive: true, force: true });
    },
  };
}

test('the socket path length is checked, with a named error rather than a bare EINVAL', () => {
  const fine = path.join('/tmp/short', 'daemon.sock');
  assert.equal(assertSocketPathFits(fine), fine);

  const tooLong = path.join('/tmp', 'a'.repeat(MAX_SOCKET_PATH), 'daemon.sock');
  assert.throws(() => assertSocketPathFits(tooLong), (error) => {
    assert.match(error.message, /bytes and this platform allows/);
    assert.match(error.message, /shorter --state-root/, 'the error has to say what to do about it');
    return true;
  });
});

test('two clients are served at once, each getting its OWN answers', async () => {
  // Both number ids from 1, so a global pending map would hand one client the other's
  // answer. This is the test that would catch that.
  const engine = await daemon();
  const a = client(engine.socketPath);
  const b = client(engine.socketPath);
  try {
    await Promise.all([a.ready, b.ready]);
    const repoA = await mkdtemp(path.join(tmpdir(), 'repo-a-'));
    const repoB = await mkdtemp(path.join(tmpdir(), 'repo-b-'));
    try {
      // Interleaved on purpose, both starting at id 1.
      const [attachA, attachB] = await Promise.all([
        a.request('repoAttach', { repoPath: repoA }),
        b.request('repoAttach', { repoPath: repoB }),
      ]);
      assert.equal(attachA.id, 1);
      assert.equal(attachB.id, 1, 'both clients used id 1, which is the point');
      assert.equal(attachA.result.repo.path, path.resolve(repoA));
      assert.equal(attachB.result.repo.path, path.resolve(repoB), 'client B got its OWN answer');

      // And both attaches landed: the shared state serialized them.
      const status = await a.request('serveStatus', {});
      assert.deepEqual(
        status.result.repos.map((row) => row.path).sort(),
        [path.resolve(repoA), path.resolve(repoB)].sort(),
      );
    } finally {
      await rm(repoA, { recursive: true, force: true });
      await rm(repoB, { recursive: true, force: true });
    }
  } finally {
    a.close(); b.close();
    await engine.stop();
  }
});

test('notifications broadcast to every attached client', async () => {
  const engine = await daemon();
  const a = client(engine.socketPath);
  const b = client(engine.socketPath);
  try {
    await Promise.all([a.ready, b.ready]);
    await a.request('hello', {});
    await b.request('hello', {});

    engine.broadcast({
      jsonrpc: '2.0',
      method: 'boardFinding',
      params: { ts: 1, source: 'watcher', severity: 'critical', category: 'x', target: 'y', evidence: 'z', status: 'open' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const [name, subscriber] of [['a', a], ['b', b]]) {
      const finding = subscriber.notifications.find((row) => row.method === 'boardFinding');
      assert.ok(finding, `client ${name} received the broadcast`);
      assert.equal(finding.params.severity, 'critical');
    }
  } finally {
    a.close(); b.close();
    await engine.stop();
  }
});

test('a job started by one client streams to BOTH, and every step carries its jobId', async () => {
  // jobId is mandatory on every event, including the first: it is the only key the client
  // filter has, and a client that adopted a foreign job would render someone else's run.
  const engine = await daemon();
  const a = client(engine.socketPath);
  const b = client(engine.socketPath);
  const repoPath = await mkdtemp(path.join(tmpdir(), 'repo-job-'));
  try {
    await Promise.all([a.ready, b.ready]);
    await a.request('repoAttach', { repoPath });
    const started = await a.request('gatesDiscover', { repoPath });
    const jobId = started.result.jobId;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (b.notifications.some((row) => row.method === 'step' && row.params.phase === 'done')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    for (const [name, subscriber] of [['a', a], ['b', b]]) {
      const steps = subscriber.notifications.filter((row) => row.method === 'step');
      assert.ok(steps.length > 0, `client ${name} saw the job it did not start`);
      for (const row of steps) {
        assert.equal(row.params.jobId, jobId, 'every step carries the jobId, including the first');
      }
    }
  } finally {
    a.close(); b.close();
    await rm(repoPath, { recursive: true, force: true });
    await engine.stop();
  }
});

test('a client disconnecting does not disturb the others', async () => {
  const engine = await daemon();
  const a = client(engine.socketPath);
  const b = client(engine.socketPath);
  try {
    await Promise.all([a.ready, b.ready]);
    await a.request('hello', {});
    await b.request('hello', {});
    assert.equal(engine.connectionCount, 2);

    a.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(engine.connectionCount, 1, 'the dropped connection is forgotten');

    const still = await b.request('hello', {});
    assert.equal(still.result.contractVersion, '5', 'the survivor is unaffected');

    // And a broadcast to a set containing a dead socket does not throw.
    engine.broadcast({ jsonrpc: '2.0', method: 'step', params: { ts: 1, jobId: 'j', phase: 'p', step: 's', detail: 'd', level: 'info' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(b.notifications.some((row) => row.method === 'step'));
  } finally {
    b.close();
    await engine.stop();
  }
});

test('a stale socket from a dead daemon is cleared, resolved by the lock rather than by connecting', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-stale-'));
  try {
    const socketPath = daemonSocketPath(stateRoot);
    // A first daemon binds and is killed without cleanup: the socket file survives it.
    const first = await serveSocket({ stateRoot, deps: OFFLINE });
    await stat(socketPath);
    await first.close();

    // Simulate the crash case: the file exists but no daemon owns it.
    const second = await serveSocket({ stateRoot, deps: OFFLINE });
    try {
      const probe = client(socketPath);
      await probe.ready;
      const hello = await probe.request('hello', {});
      assert.equal(hello.result.contractVersion, '5', 'the rebound socket serves');
      probe.close();
    } finally {
      await second.close();
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('clearStaleSocket reports whether it removed anything', async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-clear-'));
  try {
    assert.equal(await clearStaleSocket(path.join(stateRoot, 'nothing.sock')), false);
    const served = await serveSocket({ stateRoot, deps: OFFLINE });
    const socketPath = served.socketPath;
    await served.close();
    // close() unlinks, so write one back to stand in for a crash.
    const again = await serveSocket({ stateRoot, deps: OFFLINE });
    await again.close();
    assert.equal(await clearStaleSocket(socketPath), false, 'a clean close leaves nothing behind');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('the socket refuses a second daemon on the same state root', async () => {
  // Lock BEFORE bind, so two daemons can never both hold a live socket.
  const engine = await daemon();
  try {
    await assert.rejects(
      serveSocket({ stateRoot: engine.stateRoot, deps: OFFLINE }),
      /Another daijin daemon is already serving/,
    );
  } finally {
    await engine.stop();
  }
});

test('the socket is same-user only', async () => {
  const engine = await daemon();
  try {
    const mode = (await stat(engine.socketPath)).mode & 0o777;
    assert.equal(mode, 0o600, 'a socket others can read is a local privilege boundary crossed by accident');
  } finally {
    await engine.stop();
  }
});

test('closing the daemon removes its socket, so the next start is not blocked', async () => {
  const engine = await daemon();
  const socketPath = engine.socketPath;
  await engine.stop();
  await assert.rejects(stat(socketPath), (error) => error.code === 'ENOENT');
});
