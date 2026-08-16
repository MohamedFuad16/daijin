// Gate discovery: find the repo's own checks, run them against the untouched baseline,
// and write what was learned as USER-EDITABLE DATA.
//
// Two rules from the plan drive every design choice here.
//
// 1. "Repo work gates are DATA": init writes a discovered gates.yaml, the engine reads it,
//    and a user edits it. Nothing in the engine hard-codes a repo's commands. That is why
//    this file produces a document and a classification and never a decision.
// 2. "Gates must be able to fail" and its corollary, pre-broken is not coverage. A gate
//    that fails on the untouched baseline cannot tell a good edit from a bad one, so it
//    is EXCLUDED and LABELED. The label is the product: silence here is how a repo ends up
//    reporting five gates of coverage while two of them have been red for a year.
//
// Execution is the platform's ported runner (engine/src/gym/gates.js), consumed and never
// forked: runCommand for the process-group kill and the environment allowlist,
// parseGateMetric for the GATE_METRIC convention. A gate is arbitrary repo code, so it
// sees the allowlisted environment and nothing else, which is why the engine's provider
// keys and database URL cannot leak into it.
import path from 'node:path';

import YAML from 'yaml';

import { parseGateMetric, runCommand } from '../gym/gates.js';
import { readTextFile } from './walk.js';

/** Per-gate wall clock. Displayed in the record, never applied silently. */
export const DEFAULT_GATE_TIMEOUT_MS = 300_000;

/** Where a repo's discovered gates live. User-editable, engine-read. */
export const GATES_FILE = '.daijin/gates.yaml';

/**
 * package.json script names worth probing, and the role each carries.
 *
 * Matching is by name because a script's NAME is the repo's own statement of intent,
 * while its command text is an implementation detail that changes under it. `role: build`
 * matters beyond bookkeeping: the gym's check_build tool selects by declared role rather
 * than by list position, so a reordered gate list cannot silently turn the compiler into
 * the linter (gym/gates.js buildGateCommand).
 */
const SCRIPT_ROLES = [
  { pattern: /^(build|compile|bundle)(:.*)?$/, role: 'build' },
  { pattern: /^(tsc|typecheck|type-check|types)(:.*)?$/, role: 'typecheck' },
  { pattern: /^(test|tests|test:unit|test:ci|jest|vitest)(:.*)?$/, role: 'test' },
  { pattern: /^(lint|eslint|lint:js|lint:ts)(:.*)?$/, role: 'lint' },
  { pattern: /^(format:check|fmt:check|prettier:check)$/, role: 'format' },
  { pattern: /^(check|verify|ci|validate)(:.*)?$/, role: 'check' },
];

function roleForScript(name) {
  return SCRIPT_ROLES.find((entry) => entry.pattern.test(name))?.role || null;
}

/** Package manager, chosen by lockfile so the probe runs the repo's real toolchain. */
export function packageManagerOf(files) {
  const has = (name) => files.includes(name);
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

function candidate(entry) {
  return {
    id: entry.id,
    command: entry.command,
    role: entry.role || null,
    source: entry.source,
    availabilityCommand: entry.availabilityCommand || null,
    unavailableHint: entry.unavailableHint || null,
    cwd: entry.cwd || null,
  };
}

/**
 * Probe the repo for gate candidates. PURE inspection: nothing is executed here, so
 * `analyze` can report candidates without running a line of the repo's code.
 *
 * @param {object} inputs
 * @param {string[]} inputs.files       repo-relative file list
 * @param {object} inputs.manifests     parsed manifests keyed by path (package.json and friends)
 * @param {object} inputs.texts         raw text keyed by path (Makefile, CI workflows)
 */
export function probeGateCandidates({ files = [], manifests = {}, texts = {} } = {}) {
  const found = [];
  const seen = new Set();
  const push = (entry) => {
    const built = candidate(entry);
    const key = `${built.command}::${built.cwd || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(built);
  };

  // 1. package.json scripts. The repo wrote these down; they are the strongest evidence.
  for (const [file, manifest] of Object.entries(manifests)) {
    if (!file.endsWith('package.json') || !manifest?.scripts) continue;
    const directory = path.dirname(file) === '.' ? null : path.dirname(file);
    const manager = packageManagerOf(files);
    for (const name of Object.keys(manifest.scripts).sort()) {
      const role = roleForScript(name);
      if (!role) continue;
      push({
        id: directory ? `${directory}:${name}` : name,
        command: `${manager} run ${name}`,
        role,
        source: `${file}#scripts.${name}`,
        // The probe checks the package manager AND that dependencies are installed. Both
        // halves matter, and the second one is the honest half: a script that fails only
        // because node_modules is absent is UNAVAILABLE, not pre-broken. Labelling it
        // pre-broken would blame the repo for the state of the machine running the probe,
        // and pre-broken is a claim about the repo's own health that a user acts on.
        availabilityCommand: `${manager} --version && test -d node_modules`,
        unavailableHint: `Install ${manager} and run its install step in ${directory || 'the repo root'}; dependencies are not present, so the script cannot run here.`,
        cwd: directory,
      });
    }
  }

  // 2. CI configs. A step a CI file runs is a check the repo already trusts.
  for (const [file, text] of Object.entries(texts)) {
    if (!/(^|\/)(\.github\/workflows\/.*\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml)$/.test(file)) continue;
    for (const line of String(text).split('\n')) {
      const match = line.match(/^\s*-?\s*run:\s*(.+)$/);
      if (!match) continue;
      const command = match[1].trim().replace(/^["']|["']$/g, '');
      // Multi-line block scalars and templated commands are skipped rather than guessed
      // at: a candidate the discovery step cannot execute verbatim is not a candidate.
      if (!command || command === '|' || command === '>' || command.includes('${{')) continue;
      if (!/^(npm|pnpm|yarn|bun|make|cargo|go|swift|python3?|pytest|ruff|mypy|gradle|\.\/gradlew|xcodebuild|dotnet|mvn)\b/.test(command)) continue;
      push({
        id: `ci:${command.slice(0, 60)}`,
        command,
        role: roleForScript(command.split(/\s+/).pop()) || null,
        source: file,
        availabilityCommand: null,
      });
    }
  }

  // 3. Makefile targets, restricted to the four names that mean the same thing everywhere.
  for (const [file, text] of Object.entries(texts)) {
    if (!/(^|\/)(Makefile|makefile|GNUmakefile)$/.test(file)) continue;
    const directory = path.dirname(file) === '.' ? null : path.dirname(file);
    for (const line of String(text).split('\n')) {
      const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):(?!=)/);
      if (!match) continue;
      const target = match[1];
      const role = roleForScript(target);
      if (!role) continue;
      push({
        id: directory ? `${directory}:make-${target}` : `make-${target}`,
        command: `make ${target}`,
        role,
        source: `${file}#${target}`,
        availabilityCommand: 'make --version',
        unavailableHint: 'Install make (build-essential, or Xcode command line tools on macOS).',
        cwd: directory,
      });
    }
  }

  // 4. Language conventions. These are INFERRED, not read out of the repo, so the source
  //    says so: a user reading gates.yaml must be able to tell a command the repo declared
  //    from one Daijin guessed by file presence.
  const conventions = [
    { when: 'Cargo.toml', gates: [['cargo-build', 'cargo build', 'build'], ['cargo-test', 'cargo test', 'test']], availability: 'cargo --version' },
    { when: 'go.mod', gates: [['go-build', 'go build ./...', 'build'], ['go-test', 'go test ./...', 'test']], availability: 'go version' },
    { when: 'Package.swift', gates: [['swift-build', 'swift build', 'build'], ['swift-test', 'swift test', 'test']], availability: 'swift --version' },
    { when: 'pyproject.toml', gates: [['pytest', 'python3 -m pytest -q', 'test']], availability: 'python3 -c "import pytest"' },
  ];
  for (const convention of conventions) {
    if (!files.includes(convention.when)) continue;
    for (const [id, command, role] of convention.gates) {
      push({
        id,
        command,
        role,
        source: `convention:${convention.when}`,
        availabilityCommand: convention.availability,
        unavailableHint: `The toolchain for ${convention.when} is not on PATH in the engine's environment.`,
      });
    }
  }

  return found;
}

/**
 * Classify ONE baseline run of a candidate.
 *
 * This is deliberately NOT gym/gates.js classifyGateResults, and the difference is the
 * point. That function compares a candidate run to a baseline run and answers "did this
 * edit break something". Discovery has only the baseline, and answers a different
 * question: "can this command carry signal at all". Reusing the two-run classifier here
 * would report every gate as `pass` and hide the pre-broken ones, which is the exact
 * dead-coverage failure the plan forbids.
 *
 * Precedence matches the platform's: unavailable beats everything, a measured gate is
 * recognised by its GATE_METRIC line before any pass or fail reading, and only then does
 * the exit code decide.
 */
export function classifyBaselineRun(result) {
  if (result.status === 'unavailable') {
    return { classification: 'unavailable', enabled: false, metric: null };
  }
  const metric = parseGateMetric(result.stdout);
  if (metric) {
    // A measured gate is judged on MOVEMENT, so it stays enabled even when its absolute
    // reading is bad. This is the platform's answer to a tool with pre-existing
    // violations: eslint at 17 unused variables is useless as a threshold and precise as
    // a direction.
    return { classification: 'measured', enabled: true, metric: { ...metric, baselineValue: metric.value } };
  }
  if (result.status === 'pass') return { classification: 'live', enabled: true, metric: null };
  return {
    classification: 'pre-broken',
    enabled: false,
    metric: null,
    // Named, because "excluded" without a reason reads as a bug in Daijin rather than a
    // fact about the repo.
    reason: result.status === 'timeout'
      ? `The command did not finish inside the gate timeout, so it cannot distinguish a good edit from a bad one.`
      : `The command already fails on the untouched baseline (exit ${result.exitCode}), so it carries no signal until the repo fixes it.`,
  };
}

/**
 * Run every candidate against the untouched baseline and classify it.
 *
 * @param {object} options
 * @param {string} options.repoPath
 * @param {object[]} options.candidates
 * @param {Function} [options.run]  injected runner, for hermetic tests
 */
export async function discoverGates({
  repoPath,
  candidates,
  timeoutMs = DEFAULT_GATE_TIMEOUT_MS,
  environment = process.env,
  run = runCommand,
  onStep = null,
} = {}) {
  const gates = [];
  for (const gate of candidates) {
    const cwd = gate.cwd ? path.join(repoPath, gate.cwd) : repoPath;
    let result;
    if (gate.availabilityCommand) {
      const availability = await run(gate.availabilityCommand, {
        cwd, environment, timeoutMs: Math.min(timeoutMs, 30_000),
      });
      if (availability.status !== 'pass') {
        result = {
          status: 'unavailable',
          exitCode: null,
          duration_ms: availability.duration_ms,
          stdout: availability.stdout,
          stderr: availability.stderr,
          unavailableReason: gate.unavailableHint
            ? `Required gate runtime failed preflight: ${gate.availabilityCommand}. ${gate.unavailableHint}`
            : `Required gate runtime failed preflight: ${gate.availabilityCommand}`,
        };
      }
    }
    if (!result) result = await run(gate.command, { cwd, environment, timeoutMs });
    const classified = classifyBaselineRun(result);
    const record = {
      ...gate,
      ...classified,
      baseline: {
        status: result.status,
        exitCode: result.exitCode ?? null,
        durationMs: result.duration_ms ?? null,
        timeoutMs,
        stdoutTail: String(result.stdout || '').slice(-600),
        stderrTail: String(result.stderr || '').slice(-600),
        unavailableReason: result.unavailableReason || null,
      },
    };
    gates.push(record);
    if (onStep) {
      await onStep({
        step: 'gate-classified',
        detail: `${gate.id}: ${classified.classification}`,
        counts: { durationMs: record.baseline.durationMs },
      });
    }
  }
  return { gates, summary: summariseGates(gates), timeoutMs };
}

/** Counts by classification, plus the one number that must never be inflated. */
export function summariseGates(gates) {
  const by = (name) => gates.filter((gate) => gate.classification === name);
  return {
    total: gates.length,
    live: by('live').length,
    measured: by('measured').length,
    preBroken: by('pre-broken').length,
    unavailable: by('unavailable').length,
    // Coverage counts ONLY gates that can fail on a bad edit and pass on a good one.
    // pre-broken and unavailable gates are reported and never added here.
    carryingSignal: by('live').length + by('measured').length,
  };
}

/**
 * Render gates.yaml. The comment header is part of the artifact: this file is edited by
 * humans, and a human who does not know that pre-broken gates were excluded on purpose
 * will re-enable them and think coverage improved.
 */
export function renderGatesYaml({ gates, summary, timeoutMs, discoveredAt }) {
  const document = {
    version: 1,
    discoveredAt,
    timeoutMs,
    summary,
    gates: gates.map((gate) => ({
      id: gate.id,
      command: gate.command,
      role: gate.role,
      cwd: gate.cwd,
      availabilityCommand: gate.availabilityCommand,
      unavailableHint: gate.unavailableHint,
      source: gate.source,
      classification: gate.classification,
      enabled: gate.enabled,
      ...(gate.reason ? { reason: gate.reason } : {}),
      ...(gate.metric ? { metric: gate.metric } : {}),
      baseline: gate.baseline,
    })),
  };
  const header = [
    '# Daijin discovered gates. This file is DATA: edit it, and the engine obeys it.',
    '#',
    '# classification is what the baseline run measured, not an opinion:',
    '#   live        passed on the untouched repo, so a failure means your edit',
    '#   measured    printed GATE_METRIC, so it is judged on movement, not on a threshold',
    '#   pre-broken  already failed on the untouched repo. DISABLED on purpose: a gate that',
    '#               fails either way cannot tell a good edit from a bad one, and counting',
    '#               it as coverage is how a repo reports checks it does not have.',
    '#   unavailable its runtime is not installed here. Also disabled, also not coverage.',
    '#',
    '# Re-enabling a pre-broken gate is allowed and is a real choice: fix the repo first,',
    '# or the gym will attribute a pre-existing failure to the run under test.',
    '',
  ].join('\n');
  return `${header}${YAML.stringify(document, { lineWidth: 0 })}`;
}

export function gatesFilePath(repoPath) {
  return path.join(repoPath, GATES_FILE);
}

/** Read the manifests and texts probeGateCandidates needs, tolerating absence. */
export async function collectGateSources(repoPath, files) {
  const manifests = {};
  const texts = {};
  const manifestFiles = files.filter((file) => /(^|\/)package\.json$/.test(file) && !file.includes('node_modules'));
  for (const file of manifestFiles.slice(0, 50)) {
    const raw = await readTextFile(repoPath, file);
    if (!raw) continue;
    try {
      manifests[file] = JSON.parse(raw);
    } catch {
      // A malformed manifest is a fact about the repo, not a reason to abort discovery.
      manifests[file] = null;
    }
  }
  const textFiles = files.filter((file) => /(^|\/)(Makefile|makefile|GNUmakefile)$/.test(file)
    || /^\.github\/workflows\/.*\.ya?ml$/.test(file)
    || /^\.gitlab-ci\.yml$/.test(file)
    || /^\.circleci\/config\.yml$/.test(file));
  for (const file of textFiles.slice(0, 50)) {
    const raw = await readTextFile(repoPath, file);
    if (raw) texts[file] = raw;
  }
  return { manifests, texts };
}
