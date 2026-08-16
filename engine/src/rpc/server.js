// The RPC daemon: JSON-RPC 2.0 over stdio, newline delimited, one JSON object per line.
//
// Same framing as the MCP stdio transport the engine already speaks, which is why the TUI
// can drive both with one client. stdout carries ONLY protocol; anything else written
// there corrupts the stream, so the console channels are redirected to stderr before any
// handler can log.

import path from 'node:path';
import { createInterface } from 'node:readline';

import { acquireWriterLock, nullLogger } from '../runtime/logger.js';

import { ERR_INVALID_REQUEST, ERR_METHOD_NOT_FOUND, ERR_PARSE, RpcError, toErrorResponse } from './errors.js';
import { BOARD_FINDING_NOTIFICATION, JobRunner, STEP_NOTIFICATION } from './jobs.js';
import { createMethods } from './methods.js';
import { EngineState } from './state.js';

/**
 * Build a daemon around a write function.
 *
 * `write` takes one JSON-serializable message. Injecting it is what lets the tests drive
 * the whole dispatcher without a process, and what lets the stdio entry point be four
 * lines instead of a second implementation.
 */
export function createRpcServer({ stateRoot, write, deps = {} } = {}) {
  if (typeof write !== 'function') throw new Error('createRpcServer requires a write function.');
  const state = new EngineState({ stateRoot });

  const notify = (method, params) => write({ jsonrpc: '2.0', method, params });
  const jobs = new JobRunner({ notify, now: deps.now });
  const methods = createMethods({ state, jobs, deps });

  /// Handle one parsed message. Returns the response, or null for a notification.
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return new RpcError(ERR_INVALID_REQUEST, 'invalid request', {
        hint: 'The engine expects one JSON-RPC object per line.',
      }).toResponse(null);
    }
    const { id, method, params } = message;
    if (typeof method !== 'string' || !method) {
      return new RpcError(ERR_INVALID_REQUEST, 'missing method', {
        hint: 'The request carried no method name.',
      }).toResponse(id ?? null);
    }
    const handler = Object.hasOwn(methods, method) ? methods[method] : null;
    if (!handler) {
      // Reached only by a method that is NOT in the contract. Every contracted method has
      // a handler, including the ones whose capability has not shipped; those answer with
      // a structured not-implemented instead.
      return new RpcError(ERR_METHOD_NOT_FOUND, `unknown method ${method}`, {
        hint: `The engine has no method named ${method}. The frozen surface is in engine/src/rpc/methods.md.`,
      }).toResponse(id ?? null);
    }
    try {
      const result = await handler(params || {});
      // A request without an id is a notification: the client wants no answer.
      return id === undefined || id === null ? null : { jsonrpc: '2.0', id, result: result ?? null };
    } catch (error) {
      return toErrorResponse(error, id ?? null, method);
    }
  }

  /// Handle one raw line. Kept separate so a parse failure is answered rather than dropped.
  async function handleLine(line) {
    const text = String(line).trim();
    if (!text) return null;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return new RpcError(ERR_PARSE, 'parse error', {
        hint: 'The engine could not parse that line as JSON.',
      }).toResponse(null);
    }
    return handle(message);
  }

  return {
    state,
    jobs,
    methods,
    handle,
    handleLine,
    notify,
    /// Emit a board finding. NOT job scoped: the watcher pushes these with nothing running.
    pushBoardFinding(row) {
      notify(BOARD_FINDING_NOTIFICATION, row);
    },
    async close() {
      await jobs.drain();
    },
  };
}

/**
 * Take the single-writer lock for a state root, or refuse with a named error.
 *
 * ONE DAEMON PER STATE ROOT (D-0019). Multiple TUI instances are served by one daemon with
 * multiple clients; they are never served by multiple daemons, because two daemons on one
 * ~/.daijin race repos.json and the loser's attach silently disappears. With an installer
 * putting a `daijin` shim on PATH, two terminals starting it at once stopped being
 * hypothetical.
 *
 * The refusal NAMES the holder's pid, because "already running" without saying which
 * process leaves a user with nothing to act on. A stale lock from a crashed daemon is
 * reclaimed rather than blocking forever.
 */
export async function acquireDaemonLock(stateRoot, { acquire = acquireWriterLock } = {}) {
  const lockFile = path.join(path.resolve(stateRoot), 'daemon.lock');
  try {
    return await acquire(lockFile, nullLogger(), 'daijin-rpc-daemon');
  } catch (error) {
    const held = error.message.match(/PID (\d+)/)?.[1];
    throw new Error(held
      ? `Another daijin daemon is already serving ${stateRoot} (PID ${held}). One daemon per state root: point this client at the running one, or stop PID ${held} first. Lock: ${lockFile}`
      : `Could not take the daemon lock for ${stateRoot}: ${error.message}. Lock: ${lockFile}`);
  }
}

/// Run the daemon on stdin and stdout until stdin closes.
export async function serveStdio({ stateRoot, deps = {} } = {}) {
  // stdout is the protocol. A stray console.log from any handler would be parsed by the
  // client as a message, so the channels are moved before the server is built.
  for (const channel of ['log', 'info', 'debug']) {
    console[channel] = (...argumentsList) => console.error(...argumentsList);
  }

  // Taken BEFORE the first byte is served: a second daemon that answered even one request
  // before discovering the lock would already have read a repos.json it may be about to
  // overwrite.
  const release = await acquireDaemonLock(stateRoot, deps);

  const write = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const server = createRpcServer({ stateRoot, write, deps });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    // Sequential on purpose: responses stay in request order, and a slow handler cannot
    // interleave a half-written line into the stream. Long work belongs in a job, which
    // returns immediately and reports through notifications.
    const response = await server.handleLine(line);
    if (response) write(response);
  }
  await server.close();
  await release();
  return server;
}

export { STEP_NOTIFICATION, BOARD_FINDING_NOTIFICATION };
