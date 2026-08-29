// The live student: the engineer role driving the student loop's one seam.
//
// runStudentLoop's contract is a single method, next(context) -> one action
// per round ({ kind: 'edit' | 'read' | 'check' | 'submit', tokens, ... }),
// with the diff derived from the SANDBOX WORKTREE, not from anything the
// model says. So a live driver's job is to make real edits inside
// context.sandbox and report honestly what it did and what it cost.
//
// Two transports, one contract:
//
// CLAUDE-CODE runs the whole attempt as one agentic CLI turn in the sandbox
// (the owner's chosen sub-agent file as the system prompt), then walks the
// loop's protocol: edit (the CLI's work, tokens from its usage report),
// check (the harness runs the build gate), submit. A rehearsal refusal comes
// back as `message` and triggers one more CLI turn with the failure text in
// front of it. The CLI is confined by tool policy, not by trust:
// --allowedTools grants only file tools, no Bash, and the working directory
// is the disposable worktree.
//
// API PROVIDERS (GLM and friends) get a compact JSON action protocol: each
// round is one generation over the transcript, answering with exactly one
// action; the DRIVER executes edits and reads against the sandbox with the
// path confined, because "the LLM may propose, mechanics accept" applies to
// file paths exactly as it applies to exam selections.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

import { createRoleGenerate } from '../roles/driver.js';

export const ATTEMPT_TIMEOUT_MS = 20 * 60_000;

/// Resolve a model-proposed path INSIDE the sandbox or refuse. Lexical, after
/// resolution, so neither `..` nor an absolute path can step out; a symlink
/// planted by the model would have needed a prior escape to plant.
export function confinePath(sandbox, proposed) {
  const root = path.resolve(sandbox);
  const resolved = path.resolve(root, String(proposed || ''));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`The student proposed a path outside its sandbox: ${proposed}`);
  }
  return resolved;
}

const PROTOCOL = `You are solving one coding task inside a sandbox you cannot see directly.
You interact ONLY by answering with STRICT JSON, one action per reply, no prose, no fences:
  {"action": "read", "file": "<relative path>"}            read a file; its content arrives next round
  {"action": "edit", "file": "<relative path>", "content": "<the COMPLETE new file content>"}
  {"action": "check"}                                       ask the harness to run the build gate
  {"action": "submit", "explanation": "<what you changed and why>"}
Rules: edit replaces the whole file, so always send complete content. Work inside the repo's
existing layout. When the harness message says you are out of budget, submit what you have.`;

function parseAction(text) {
  const stripped = String(text || '').trim().replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('The student reply is not JSON and contains no object literal.');
    parsed = JSON.parse(stripped.slice(start, end + 1));
  }
  if (!['read', 'edit', 'check', 'submit'].includes(parsed?.action)) {
    throw new Error(`The student reply names no known action: ${JSON.stringify(parsed?.action ?? null)}`);
  }
  return parsed;
}

/** The API-provider student: one generation per round, a JSON action back. */
export function createApiEngineer({ role, key }, { generate = null, ...options } = {}) {
  const ask = generate || createRoleGenerate(role, { key, ...options });
  const history = [];
  return {
    async next(context) {
      const status = [
        `Round ${context.round}. Work tokens spent ${context.workTokens} of ${context.tokenCap}.`,
        context.forced === 'submit' ? 'BUDGET EXHAUSTED: you must submit now.' : null,
        context.message ? `Harness: ${context.message}` : null,
      ].filter(Boolean).join('\n');
      const prompt = [
        context.prompt,
        ...history,
        status,
        'Answer with exactly one JSON action.',
      ].join('\n\n');
      const reply = await ask({ system: PROTOCOL, prompt, maxTokens: 16_384 });
      const tokens = reply.tokens ?? Math.ceil((reply.text?.length ?? 0) / 3);
      let action;
      try {
        action = parseAction(reply.text);
      } catch (error) {
        // One malformed reply is a nudge, not a crash: the loop counts the
        // tokens (they were spent) and the student reads its own mistake.
        history.push(`Your previous reply was rejected: ${error.message}`);
        return { kind: 'read', tokens };
      }
      if (context.forced === 'submit' && action.action !== 'submit') {
        return { kind: 'submit', tokens, explanation: 'Budget exhausted; submitting current state.' };
      }
      if (action.action === 'read') {
        const target = confinePath(context.sandbox, action.file);
        let content;
        try {
          content = await readFile(target, 'utf8');
        } catch (error) {
          content = `<<could not read: ${error.message}>>`;
        }
        history.push(`You read ${action.file}:\n${content.slice(0, 20_000)}`);
        return { kind: 'read', tokens };
      }
      if (action.action === 'edit') {
        const target = confinePath(context.sandbox, action.file);
        let existed = true;
        try { await access(target); } catch { existed = false; }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, String(action.content ?? ''), 'utf8');
        history.push(`You wrote ${action.file} (${String(action.content ?? '').length} chars).`);
        return { kind: 'edit', tokens, file: action.file, created: existed ? [] : [action.file] };
      }
      if (action.action === 'check') {
        history.push('You asked for a build check.');
        return { kind: 'check', tokens };
      }
      return { kind: 'submit', tokens, explanation: String(action.explanation || '').trim() };
    },
  };
}

/** The claude-code student: one agentic CLI attempt, then the loop protocol. */
export function createCliEngineer({ role, agentPath }, {
  execFileImpl = execFile,
  readFileImpl = readFile,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
} = {}) {
  let phase = 'attempt';
  let lastResult = '';

  const runAttempt = async (context, preamble) => {
    let system = null;
    if (agentPath) {
      const raw = await readFileImpl(agentPath, 'utf8');
      system = raw.startsWith('---') && raw.indexOf('\n---', 3) !== -1
        ? raw.slice(raw.indexOf('\n---', 3) + 4).trimStart()
        : raw;
    }
    const prompt = [preamble, context.prompt].filter(Boolean).join('\n\n');
    const args = [
      '-p', prompt,
      '--model', role.model,
      '--output-format', 'json',
      // FILE TOOLS ONLY. No Bash: the harness owns running gates (the check
      // action), and a student that can run arbitrary commands can also read
      // its own grader. The sandbox worktree is the blast radius either way.
      '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
      '--permission-mode', 'acceptEdits',
    ];
    if (system) args.push('--append-system-prompt', system);
    return new Promise((resolve, reject) => {
      // Same two rules as roles/driver.js: stdin is closed (the CLI waits
      // three seconds for it otherwise) and the CLI's own sentence wins over
      // the exec wrapper's "Command failed: <the entire prompt>".
      //
      // And the same correction: execFile silently drops a `stdio` option, so
      // the handle is what closes stdin. See roles/driver.js for the citation.
      const child = execFileImpl('claude', args, {
        cwd: context.sandbox,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      }, (error, stdout) => {
        let reported = null;
        try {
          const body = JSON.parse(stdout || '{}');
          if (body.is_error && body.result) reported = String(body.result).trim();
        } catch {
          reported = null;
        }
        if (error) {
          reject(new Error(error.code === 'ENOENT'
            ? 'The claude CLI is not on PATH. Install Claude Code to use a sub-agent engineer.'
            : reported
              ? `The claude CLI refused: ${reported.slice(0, 300)}`
              : `The claude CLI failed: ${String(error.message || '').split('\n')[0].slice(0, 200)}`));
          return;
        }
        let parsed;
        try { parsed = JSON.parse(stdout); } catch { reject(new Error('The claude CLI answered with a body that is not JSON.')); return; }
        if (parsed.is_error) { reject(new Error(`The claude CLI refused: ${String(parsed.result || '').slice(0, 300)}`)); return; }
        let tokens = 0;
        for (const tally of Object.values(parsed.modelUsage || {})) {
          for (const value of Object.values(tally || {})) if (typeof value === 'number') tokens += value;
        }
        resolve({ text: String(parsed.result ?? ''), tokens: tokens || 1 });
      });
      // The actual close; see roles/driver.js. Optional-chained because an injected
      // execFileImpl returns no handle.
      child?.stdin?.end();
    });
  };

  /// New files the attempt created, from git itself. Untracked files are
  /// invisible to the worktree diff, and with no Bash tool the only writer in
  /// the sandbox is the student, so porcelain's untracked list IS the
  /// student's created set.
  const untracked = (context) => new Promise((resolve) => {
    execFileImpl('git', ['-C', context.sandbox, 'status', '--porcelain'], { timeout: 60_000 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(String(stdout || '').split('\n')
        .filter((line) => line.startsWith('?? '))
        .map((line) => line.slice(3).trim())
        .filter(Boolean));
    });
  });

  return {
    async next(context) {
      if (context.forced === 'submit' && phase !== 'attempt') {
        return { kind: 'submit', tokens: 0, explanation: 'Budget exhausted; submitting current state.' };
      }
      if (context.message) {
        // A rehearsal refusal or a refused submit: one more attempt with the
        // harness's words in front, then re-check and re-submit.
        const { text, tokens } = await runAttempt(context, `HARNESS FEEDBACK ON YOUR PREVIOUS ATTEMPT:\n${context.message}\n\nFix this and continue the task below.`);
        lastResult = text;
        phase = 'check';
        return { kind: 'edit', tokens, created: await untracked(context) };
      }
      if (phase === 'attempt') {
        const { text, tokens } = await runAttempt(context, null);
        lastResult = text;
        phase = 'check';
        return { kind: 'edit', tokens, created: await untracked(context) };
      }
      if (phase === 'check') {
        phase = 'submit';
        return { kind: 'check', tokens: 0 };
      }
      return { kind: 'submit', tokens: 0, explanation: lastResult.slice(0, 2_000) };
    },
  };
}

/** The factory gymStart wires: one live engineer for the configured role. */
export function createEngineerDriver({ role, key = null, agentPath = null }, options = {}) {
  if (role.provider === 'claude-code') return createCliEngineer({ role, agentPath }, options);
  return createApiEngineer({ role, key }, options);
}
