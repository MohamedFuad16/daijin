// Drive the real RPC daemon over a real pipe.
//
// Not an in-process harness on purpose. The framing IS part of the contract, so a test
// that calls the dispatcher directly cannot catch a newline that never got written, a
// response that came back out of order, or a stray console.log corrupting stdout. This
// spawns the same process the TUI spawns.
//
// Hermetic: `--no-probe` keeps the daemon off the network, and the state root is a temp
// directory the caller owns.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'rpc', 'daemon.js');

export async function startDaemon({ stateRoot, probe = false, extraArgs = [] } = {}) {
  const root = stateRoot || await mkdtemp(path.join(tmpdir(), 'daijin-rpc-'));
  const args = [DAEMON, `--state-root=${root}`, ...(probe ? [] : ['--no-probe']), ...extraArgs];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  const pending = new Map();
  const notifications = [];
  const strayFrames = [];
  const notificationWaiters = [];
  let stderr = '';
  let buffer = '';
  let nextId = 0;

  child.stderr.on('data', (chunk) => { stderr += chunk; });
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
      } catch (error) {
        // A line stdout could not parse is a protocol violation, and swallowing it is how
        // a stray log line goes unnoticed until the TUI desyncs.
        for (const { reject } of pending.values()) reject(new Error(`daemon wrote a non-JSON line: ${line}`));
        pending.clear();
        continue;
      }
      if (message.method && message.id === undefined) {
        notifications.push(message);
        for (const waiter of notificationWaiters.splice(0)) waiter();
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) {
        // A frame that is neither a notification nor an answer to anything outstanding.
        // Dropping it silently is what let the daemon answer NOTIFICATIONS with error
        // envelopes unnoticed: a real client would face the same frame with the same two
        // bad options, drop it or mis-attribute it. Recorded so a test can assert none.
        strayFrames.push(message);
        continue;
      }
      pending.delete(message.id);
      entry.resolve(message);
    }
  });

  return {
    stateRoot: root,
    child,
    notifications,
    strayFrames,
    get stderr() { return stderr; },

    /// Send a request and await its full envelope, error included. Tests assert on the
    /// envelope rather than on a thrown value, because the error SHAPE is the contract.
    request(method, params = {}) {
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`timed out waiting for ${method}`));
        }, 15_000).unref();
      });
    },

    /// Send a raw line, for framing tests that a well-formed request cannot reach.
    sendRaw(line) {
      child.stdin.write(`${line}\n`);
    },

    /// Send a notification: no id, so the daemon must NOT answer.
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },

    async waitForNotification(predicate, { timeoutMs = 10_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = notifications.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('timed out waiting for a notification');
        await new Promise((resolve) => {
          notificationWaiters.push(resolve);
          setTimeout(resolve, 50).unref();
        });
      }
    },

    async stop({ keepStateRoot = false } = {}) {
      // A process that already exited will never fire 'exit' again, so waiting on it would
      // burn the full timeout on every daemon that refused to start.
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        await new Promise((resolve) => {
          child.once('exit', resolve);
          setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000).unref();
        });
      }
      if (!keepStateRoot && !stateRoot) await rm(root, { recursive: true, force: true });
    },
  };
}

export function resultOf(envelope) {
  if (envelope.error) throw new Error(`expected a result, got ${envelope.error.code}: ${envelope.error.message}`);
  return envelope.result;
}

export function errorOf(envelope) {
  if (!envelope.error) throw new Error(`expected an error, got a result: ${JSON.stringify(envelope.result)}`);
  return envelope.error;
}
