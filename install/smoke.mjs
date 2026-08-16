// Install smoke check: does the installed engine answer hello with the version we stamped?
//
// This is the one check that can tell a finished install from a directory of files. It
// speaks the real wire format (JSON-RPC 2.0, one object per line, UTF-8) against the real
// engine command the shim would use, and it compares hello's engineVersion against
// $PREFIX/VERSION rather than against a literal in this file. Two constants that agree
// prove nothing; a handshake compared to the stamp catches a stale install, a half copied
// tree, and a daemon reporting a version it did not come from.
//
// Exits non-zero with a specific message on every failure path, because the installer
// treats any failure here as "the install is not usable" and says so.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const TIMEOUT_MS = 20_000;

function argument(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

function fail(message) {
  process.stderr.write(`smoke: ${message}\n`);
  process.exit(1);
}

const prefix = argument('--prefix');
if (!prefix) fail('--prefix is required.');

const stampPath = join(prefix, 'VERSION');
if (!existsSync(stampPath)) fail(`no stamp at ${stampPath}; the install did not finish.`);
const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));

// daemon.js is the process entry point. server.js beside it exports the dispatcher and
// does nothing when run directly, so pointing this check at the library would produce a
// process that exits 0 without answering: a green-looking install that cannot talk.
//
// There is deliberately no stand-in to fall back to. A stub that answers hello makes a
// broken install look finished, which is the one thing this check exists to prevent, and
// it would carry a hardcoded contract version that drifts the moment methods.md moves.
const daemon = join(prefix, 'engine', 'src', 'rpc', 'daemon.js');
if (!existsSync(daemon)) {
  fail(`this install has no engine: ${daemon} does not exist. The install is not usable.`);
}

// --no-probe keeps the check off every live service, and --state-root keeps it out of the
// user's real state directory: a smoke check must not create or mutate anything a person
// would notice, and it must not contact anything to say hello.
const child = spawn('node', [
  daemon,
  '--no-probe',
  `--state-root=${join(prefix, 'install', 'smoke-state')}`,
], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';
let settled = false;

const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  child.kill('SIGKILL');
  fail(`the engine did not answer hello within ${TIMEOUT_MS / 1000}s.`);
}, TIMEOUT_MS);

function finish(code, message) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.kill('SIGKILL');
  if (message) process.stderr.write(`smoke: ${message}\n`);
  process.exit(code);
}

child.on('error', (error) => finish(1, `could not start the engine: ${error.message}`));
child.on('exit', (code) => {
  if (!settled) finish(1, `the engine exited (code ${code}) before answering hello.`);
});

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      finish(1, `the engine wrote a line that is not JSON: ${line.slice(0, 120)}`);
      return;
    }
    // Notifications carry no id and are not the answer to anything.
    if (message.id !== 1) continue;
    if (message.error) {
      finish(1, `hello returned an error: ${message.error.message}`);
      return;
    }

    const result = message.result || {};
    if (!result.engineVersion) {
      finish(1, 'hello answered without an engineVersion.');
      return;
    }
    if (result.engineVersion !== stamp.engineVersion) {
      finish(1, `hello reports engineVersion ${result.engineVersion}, but this install is stamped `
        + `${stamp.engineVersion}. The tree and the stamp disagree; reinstall.`);
      return;
    }
    if (!result.contractVersion) {
      finish(1, 'hello answered without a contractVersion; the client needs it to decide whether to render an upgrade screen.');
      return;
    }

    process.stdout.write(
      `smoke: hello ok, engineVersion ${result.engineVersion} matches the stamp, `
      + `contractVersion ${result.contractVersion}\n`,
    );
    finish(0);
    return;
  }
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'hello',
  params: { clientVersion: stamp.tuiVersion },
})}\n`);
