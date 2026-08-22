// Gate execution and classification. Ported from the platform (platform/exam/gates.js),
// which the extraction report found better designed than expected: gate commands are
// already DATA read from project.yaml, not code.
//
// Three couplings are removed here, each named STRUCTURAL in the report (section 4a):
//
//  1. The platform appends a `[CONTRACTS] conformance` gate to every surface
//     unconditionally, running an internship-portal specific script. It is gone. A
//     contracts check is just another discovered gate now.
//  2. Availability was probed by regex on the command (`swiftlint` implies
//     `swiftlint version`). Each gate DECLARES its own availabilityCommand instead. The
//     pattern was right, the hard coding was not.
//  3. The build gate was found by regex over the command text. A gate declares
//     `role: 'build'` instead, so an arbitrary repo's compile step is discoverable.
//
// Everything else is the platform's, unchanged: the process group kill on timeout, the
// GATE_METRIC convention, and the classification precedence.
import { spawn } from 'node:child_process';
import path from 'node:path';

function tail(value, limit = 16_000) {
  return value.length <= limit ? value : value.slice(-limit);
}

/// The environment a gate is allowed to see.
///
/// An allowlist rather than a filter: a gate inheriting the engine's full environment
/// inherits its provider keys and its database URL, and a gate is arbitrary repo code.
export function gateEnvironment(environment = process.env, extraKeys = []) {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME', ...extraKeys];
  return Object.fromEntries(allowed.filter((key) => environment[key]).map((key) => [key, environment[key]]).concat([
    ['CI', '1'],
  ]));
}

export async function runCommand(command, {
  cwd,
  timeoutMs,
  environment = process.env,
  environmentKeys = [],
} = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      cwd,
      env: gateEnvironment(environment, environmentKeys),
      // Detached so the whole process group can be killed on timeout: a build tool that
      // spawns children survives a kill aimed only at the shell.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 2_000_000) stdout = tail(stdout, 1_000_000); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 2_000_000) stderr = tail(stderr, 1_000_000); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1_000).unref();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ status: 'fail', exitCode: null, signal: null, duration_ms: Math.round(performance.now() - started), stdout: tail(stdout), stderr: tail(`${stderr}\n${error.message}`) });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail',
        exitCode: code,
        signal,
        duration_ms: Math.round(performance.now() - started),
        stdout: tail(stdout),
        stderr: tail(stderr),
      });
    });
  });
}

/// Expand a discovered gate set for one sandbox.
///
/// Gate commands may reference engine owned tooling. A sandbox is checked out at the
/// exam's base commit, so anything that depends on the repository's CURRENT config (an
/// eslint flat config added last week, say) cannot run there. Substituting the engine
/// root lets a gate bring its own tooling and work at every commit age.
export function expandGates(gates, { engineRoot, sandbox, node = process.execPath }) {
  if (!Array.isArray(gates) || gates.length === 0) throw new Error('No gates configured.');
  const expand = (command) => String(command)
    .replaceAll('{{engineRoot}}', engineRoot)
    .replaceAll('{{node}}', node)
    .replaceAll('{{sandbox}}', sandbox);
  return gates.map((gate) => {
    if (!gate?.id || !gate?.command) throw new Error('Every gate needs an id and a command.');
    return {
      id: gate.id,
      role: gate.role || null,
      command: expand(gate.command),
      availabilityCommand: gate.availabilityCommand ? expand(gate.availabilityCommand) : null,
      unavailableHint: gate.unavailableHint || null,
      cwd: gate.cwd ? expand(gate.cwd) : null,
    };
  });
}

/// The compile gate, or null if none is declared.
///
/// The student's `check_build` tool needs to run exactly the command the run will be
/// judged by, and it must not silently pick the wrong one. Selecting by list position
/// couples it to gate ordering: reorder the gates and the compiler quietly becomes the
/// linter, with no error. The role is declared, so it survives reordering and returns null
/// (the tool is simply not offered) when a repo has no build gate.
export function buildGateCommand(gates) {
  return gates.find((gate) => gate.role === 'build')?.command || null;
}

/// A gate may print `GATE_METRIC:<lower-better|higher-better>:<number>` to report a
/// measurement instead of a verdict.
///
/// Some gates measure something that is already imperfect at the base commit: 17 unused
/// variables, a react-doctor score of 36. Judged against a fixed threshold they fail on the
/// baseline as well as the candidate, classify as `pre-broken`, and carry no signal at all,
/// so an engineer could add a tenth unused import and nothing would notice. What matters is
/// the DIRECTION of change, so these gates report a number and are judged against the same
/// number from the baseline run.
export function parseGateMetric(stdout) {
  const match = String(stdout ?? '').match(/GATE_METRIC:(lower-better|higher-better):(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  return { direction: match[1], value: Number(match[2]) };
}

function metricClassification(before, after) {
  const baselineMetric = parseGateMetric(before?.stdout);
  const candidateMetric = parseGateMetric(after?.stdout);
  if (!baselineMetric || !candidateMetric || baselineMetric.direction !== candidateMetric.direction) return null;
  const worse = candidateMetric.direction === 'lower-better'
    ? candidateMetric.value > baselineMetric.value
    : candidateMetric.value < baselineMetric.value;
  return {
    classification: worse ? 'regressed' : 'pass',
    metric: { ...candidateMetric, baselineValue: baselineMetric.value },
  };
}

export async function runGateSet(gates, options) {
  const results = [];
  for (const gate of gates) {
    // A gate's cwd is REPO-RELATIVE (discovery writes `path.dirname(file)`), so it must
    // resolve against the tree being tested, never the daemon's own process cwd. Discovery
    // already resolved it (gate-discovery.js joins repoPath); this runner did not, so the
    // same subdirectory gate was `live` when discovered and `unavailable` when the goal
    // sweep or a gym sandbox ran it - both honest about two different directories.
    const cwd = gate.cwd
      ? (path.isAbsolute(gate.cwd) ? gate.cwd : path.join(options.cwd, gate.cwd))
      : options.cwd;
    const gateOptions = { ...options, cwd };
    if (gate.availabilityCommand) {
      const availability = await runCommand(gate.availabilityCommand, {
        ...gateOptions,
        timeoutMs: Math.min(options.timeoutMs, 30_000),
      });
      if (availability.status !== 'pass') {
        results.push({
          id: gate.id, command: gate.command, role: gate.role || null, status: 'unavailable', exitCode: null, signal: null,
          duration_ms: availability.duration_ms, stdout: availability.stdout, stderr: availability.stderr,
          // Name the usual cause. On the platform, both iOS gates sat `unavailable` for
          // entire cycles because xcode-select pointed at CommandLineTools, and nothing in
          // the record said so: an iOS exam silently carried no mechanical signal at all.
          unavailableReason: gate.unavailableHint
            ? `Required gate runtime failed preflight: ${gate.availabilityCommand}. ${gate.unavailableHint}`
            : `Required gate runtime failed preflight: ${gate.availabilityCommand}`,
        });
        continue;
      }
    }
    const result = await runCommand(gate.command, gateOptions);
    results.push({ id: gate.id, command: gate.command, role: gate.role || null, ...result });
  }
  return results;
}

/// Classify a candidate gate run against its baseline. Precedence order matters:
/// unavailable beats everything, a measured gate is judged on movement, and only then
/// does the pass and fail comparison run.
///
/// `pre-broken` is honest but useless as coverage: a gate that fails on baseline and
/// candidate alike carries no signal. It is a label, not a verdict, and the caller must
/// exclude it from any pass rate rather than counting it as covered.
export function classifyGateResults(baseline, candidate) {
  const baselineById = new Map(baseline.map((gate) => [gate.id, gate]));
  return candidate.map((gate) => {
    const before = baselineById.get(gate.id);
    if (gate.status === 'unavailable' || before?.status === 'unavailable') {
      return { ...gate, baselineStatus: before?.status || 'not-run', classification: 'unavailable' };
    }
    // A measured gate is judged on movement, not on an absolute pass mark.
    const measured = metricClassification(before, gate);
    if (measured) {
      return {
        ...gate,
        baselineStatus: before?.status || 'not-run',
        classification: measured.classification,
        metric: measured.metric,
      };
    }
    const status = gate.status === 'pass'
      ? 'pass'
      : before?.status === 'pass'
        ? 'regressed'
        : 'pre-broken';
    return { ...gate, baselineStatus: before?.status || 'not-run', classification: status };
  });
}
