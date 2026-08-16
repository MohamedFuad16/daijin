#!/usr/bin/env node
// Process entry point for the RPC daemon.
//
//   node engine/src/rpc/daemon.js [--state-root=<dir>] [--no-probe] [--socket]
//
// The TUI spawns exactly this and speaks JSON-RPC over the pipe. Kept separate from
// server.js so the server can be imported and driven in-process by tests without a
// process entry running as a side effect of the import.

import os from 'node:os';
import path from 'node:path';

import { serveSocket } from './socket.js';
import { serveStdio } from './server.js';

function argument(flag, fallback = null) {
  const found = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  return found ? found.slice(flag.length + 1) : fallback;
}

// One state root per user by default: which repos are attached and what the settings are
// belong to the person, not to whichever directory they happened to launch from.
const stateRoot = argument('--state-root') || path.join(os.homedir(), '.daijin');

// `--no-probe` runs the daemon without touching a live local service.
//
// serveStatus otherwise asks Ollama whether it is up, which is a real connection. Two
// callers want it off: a hermetic test suite (engine/test is network-free by ruling
// D-0015), and a doctor run on a machine where probing would hang. The status is still
// ANSWERED, and it says the probe was skipped rather than reporting a healthy service it
// never contacted.
const deps = process.argv.includes('--no-probe')
  ? {
    checkOllama: async () => {
      throw new Error('probe skipped: the daemon was started with --no-probe');
    },
    // NO LIVE SERVICE AT ALL, not merely no health probe. initBrain builds an embedder
    // client and a job that reached Ollama would make a network call from a suite that is
    // required to make none (D-0015). Refusing here fails the job fast on the step stream
    // with a reason, which is also what a doctor run on a machine with no Ollama should see.
    createEmbedderClient: () => {
      throw new Error('embedder unavailable: the daemon was started with --no-probe, so it will not contact a live service');
    },
  }
  : {};

// `--socket` serves the ATTACH transport: one daemon, many clients. Opt in, never
// inferred, so a client cannot get the other transport by accident. stdio remains the
// default and remains what the tests drive.
const wanted = process.argv.includes('--socket') ? serveSocket : serveStdio;

wanted({ stateRoot, deps }).then((served) => {
  if (served?.socketPath) {
    // stdout is the protocol on the stdio transport, so anything a human reads goes to
    // stderr on both, keeping one rule rather than two.
    console.error(`daijin-rpc listening on ${served.socketPath}`);
    const stop = async () => {
      await served.close().catch(() => {});
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
}).catch((error) => {
  // The lock refusal is the expected failure here and it is already a complete sentence
  // naming the holding pid, so it is printed as written rather than wrapped in a trace.
  console.error(error.message);
  process.exitCode = 1;
});
