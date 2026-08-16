// The attach transport: one daemon, many clients, over a unix domain socket.
//
// Designed in TRANSPORT-PROPOSAL.md and approved as designed (D-0022). stdio is
// unchanged and remains what the tests drive; this is opt-in behind `--socket`, so no
// client gets the other transport by accident.
//
// The framing is identical to stdio: one JSON object per line, UTF-8, newline terminated.
// That is what lets one dispatcher serve both and one client base read both.
//
// WHAT IS PER CONNECTION AND WHAT IS SHARED, since getting this backwards is the whole
// class of bug this file can have:
//   per connection   the read buffer, and the RESPONSE routing. Request ids are a
//                    per-client counter starting at 1, so two clients both send id 1 and a
//                    global pending map would hand one client the other's answer.
//   shared           the dispatcher, the job runner, the state, and the NOTIFICATIONS.
//                    step and boardFinding broadcast to every attached client.

import { createServer } from 'node:net';
import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import { acquireDaemonLock, createRpcServer } from './server.js';

/// Where a state root's socket lives. Beside the lock, so the socket follows the state it
/// serves and an uninstall that leaves state alone leaves it alone too.
export function daemonSocketPath(stateRoot) {
  return path.join(path.resolve(stateRoot), 'daemon.sock');
}

/**
 * The platform limit on a unix socket path, measured rather than assumed.
 *
 * `sun_path` is 104 bytes on macOS and 108 on Linux; binding a 170-byte path fails with a
 * bare EINVAL that says nothing about length. The real paths are far inside the limit
 * (~/.daijin/daemon.sock is 34 bytes, a mkdtemp test root 79), so this check exists for the
 * case that WOULD first hit it: a harness with a deep temporary directory, where an
 * unexplained EINVAL at startup is exactly the kind of thing that costs an afternoon.
 */
export const MAX_SOCKET_PATH = process.platform === 'darwin' ? 104 : 108;

export function assertSocketPathFits(socketPath) {
  if (Buffer.byteLength(socketPath) >= MAX_SOCKET_PATH) {
    throw new Error(
      `The socket path is ${Buffer.byteLength(socketPath)} bytes and this platform allows `
      + `${MAX_SOCKET_PATH - 1}: ${socketPath}. Use a shorter --state-root; the socket has to live beside the state it serves.`,
    );
  }
  return socketPath;
}

/**
 * Remove a socket file left behind by a daemon that is gone.
 *
 * Resolved BY THE LOCK rather than by connecting to it and seeing what happens. Reaching
 * the point of binding means the lock was taken, and the lock is only taken when no live
 * daemon holds it, so any socket file here belongs to a dead one. Connect-then-decide would
 * be racy and would also hang against a socket whose owner is wedged rather than dead.
 */
export async function clearStaleSocket(socketPath) {
  try {
    await stat(socketPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  await unlink(socketPath);
  return true;
}

/**
 * Serve on a unix socket until closed.
 *
 * Lock FIRST, then bind: two daemons must never both believe they own a state root, and
 * binding before locking would leave a window where a second daemon had a live socket.
 */
export async function serveSocket({
  stateRoot,
  socketPath = daemonSocketPath(stateRoot),
  deps = {},
} = {}) {
  assertSocketPathFits(socketPath);
  const release = await acquireDaemonLock(stateRoot, deps);

  const connections = new Set();
  // Notifications go to EVERY attached client. Responses do not: they are written by the
  // connection that asked, below.
  const broadcast = (message) => {
    const line = `${JSON.stringify(message)}\n`;
    for (const socket of connections) {
      if (socket.writable) socket.write(line);
    }
  };
  const rpc = createRpcServer({ stateRoot, write: broadcast, deps });

  const server = createServer((socket) => {
    connections.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    // Requests on ONE connection are handled in order, matching the stdio loop, so a slow
    // handler cannot interleave a half-written line. Connections do not block each other.
    let chain = Promise.resolve();

    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        chain = chain.then(async () => {
          const response = await rpc.handleLine(line);
          // Back to THIS connection only. A response routed by a shared map would answer
          // whichever client happened to be waiting on the same id.
          if (response && socket.writable) socket.write(`${JSON.stringify(response)}\n`);
        }).catch(() => {});
      }
    });

    const drop = () => { connections.delete(socket); };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  await clearStaleSocket(socketPath);
  await mkdir(path.dirname(socketPath), { recursive: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // Same-user only, by filesystem permission. A socket readable by others in a shared
  // directory would be a local privilege boundary crossed by accident; anything that can
  // read the state root can already read the brain, so this matches the existing posture
  // rather than inventing a weaker one.
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    rpc,
    get connectionCount() { return connections.size; },
    /// Notify every attached client. Exposed so a caller can push a board finding.
    broadcast,
    async close() {
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise((resolve) => server.close(resolve));
      await rpc.close();
      await unlink(socketPath).catch(() => {});
      await release();
    },
  };
}
