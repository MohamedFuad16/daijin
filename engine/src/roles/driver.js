// One real generation for a configured role: the first LLM driver in daijin.
//
// rolePing proves a role CAN answer; this module is how a role answers with
// content. Same transport table as ping.js and deliberately beside it rather
// than merged into it: a ping is one token with the timing measured, a
// generation is a real completion with the text kept, and folding the two
// into one function is how a timing probe grows a token budget.
//
// The key arrives RESOLVED, like ping.js: this module never sees a pointer,
// so it cannot mix pointers and values up. claude-code needs no key at all;
// it runs the local CLI on the owner's login auth, with the sub-agent file's
// BODY as an appended system prompt so the agent the owner picked is the
// agent that answers.
//
// role.tools (zai web_search) is deliberately NOT attached here. The one
// caller today is the exam committee, a deterministic judgment over material
// already in the prompt; a web search inside it adds variance and quota cost
// to a decision that must be reproducible. When a caller genuinely wants the
// role's tools, it will say so explicitly.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/// Ten minutes: a committee reads tens of candidates and writes a task
/// statement per selection, which is minutes of thinking on a reasoning
/// model. Distinct from PING_TIMEOUT_MS on purpose - a slow ping is a
/// misconfiguration signal, a slow committee is the committee working.
export const GENERATE_TIMEOUT_MS = 10 * 60_000;

function withV1(endpoint) {
  const trimmed = String(endpoint || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? text : text.slice(end + 4).trimStart();
}

async function cliGenerate({ role, system, prompt, execFileImpl, timeoutMs }) {
  const args = ['-p', prompt, '--model', role.model, '--output-format', 'json', '--max-turns', '1'];
  if (system) args.push('--append-system-prompt', system);
  return new Promise((resolve, reject) => {
    // stdin IGNORED, not inherited and not left open: the CLI waits three
    // seconds for stdin data before proceeding, so every call paid a silent
    // three-second tax and printed a warning that read like a defect. The
    // daemon's own stdin is the RPC pipe and must never be handed to a child.
    execFileImpl('claude', args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, (error, stdout) => {
      // THE CLI'S OWN SENTENCE WINS over the exec wrapper's. A non-zero exit
      // still carries a JSON body, and that body is where the reason lives:
      // the live goal loop reported "Command failed: claude -p <the entire
      // prompt>" five times when the truth was one line, "You've reached your
      // Fable 5 limit". The wrapper's message also echoes the whole prompt
      // into the step stream, which is noise at best.
      let reported = null;
      try {
        const body = JSON.parse(stdout || '{}');
        if (body.is_error && body.result) reported = String(body.result).trim();
      } catch {
        reported = null;
      }
      if (error) {
        reject(new Error(error.code === 'ENOENT'
          ? 'The claude CLI is not on PATH. Install Claude Code to use sub-agent roles.'
          : reported
            ? `The claude CLI refused: ${reported.slice(0, 300)}`
            : `The claude CLI failed: ${String(error.message || '').split('\n')[0].slice(0, 200)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.is_error) {
          reject(new Error(`The claude CLI refused: ${String(parsed.result || '').slice(0, 300)}`));
          return;
        }
        // Tokens summed across modelUsage: the work-token accounting upstream
        // needs one number per call, and the helper model's tokens are real
        // spend on the owner's plan too.
        let tokens = 0;
        for (const tally of Object.values(parsed.modelUsage || {})) {
          for (const value of Object.values(tally || {})) {
            if (typeof value === 'number') tokens += value;
          }
        }
        resolve({ text: String(parsed.result ?? ''), servedModelId: role.model, tokens: tokens || null });
      } catch {
        reject(new Error('The claude CLI answered with a body that is not JSON.'));
      }
    });
  });
}

async function httpGenerate({ url, headers, body, fetchImpl, timeoutMs, textFrom, servedFrom }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = '';
    try { detail = JSON.parse(text)?.error?.message || ''; } catch { detail = text.slice(0, 200); }
    throw new Error(`The provider answered ${response.status}. ${detail}`.trim());
  }
  const parsed = JSON.parse(text);
  // Both usage dialects: OpenAI-shape total_tokens, Anthropic input+output.
  const usage = parsed?.usage || {};
  const tokens = usage.total_tokens
    ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) || null);
  return { text: textFrom(parsed) ?? '', servedModelId: servedFrom(parsed) ?? null, tokens };
}

/**
 * A generate function for one configured role.
 *
 * `agentSystemPrompt` resolves the claude-code sub-agent body: the caller
 * passes the agent file PATH (from agentCatalog) rather than this module
 * scanning directories itself, so what the user picked in settings is
 * provably what runs.
 */
export function createRoleGenerate(role, {
  key = null,
  agentPath = null,
  fetchImpl = fetch,
  execFileImpl = execFile,
  readFileImpl = readFile,
  timeoutMs = GENERATE_TIMEOUT_MS,
} = {}) {
  return async function generate({ system = null, prompt, maxTokens = 8_192 }) {
    if (role.provider === 'claude-code') {
      let body = system;
      if (agentPath) {
        const raw = await readFileImpl(agentPath, 'utf8');
        // The agent file IS the system prompt; a caller-supplied system rides
        // after it so task framing cannot silently replace the agent's rules.
        body = [stripFrontmatter(raw), system].filter(Boolean).join('\n\n');
      }
      return cliGenerate({ role, system: body, prompt, execFileImpl, timeoutMs });
    }
    if (role.provider === 'anthropic') {
      return httpGenerate({
        url: `${withV1(role.endpoint)}/messages`,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: {
          model: role.model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: prompt }],
        },
        fetchImpl,
        timeoutMs,
        textFrom: (parsed) => (parsed?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
        servedFrom: (parsed) => parsed?.model,
      });
    }
    const body = {
      model: role.model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
    };
    if (role.provider === 'openai') {
      body.max_completion_tokens = maxTokens;
      if (role.reasoningEffort) body.reasoning_effort = role.reasoningEffort;
    } else {
      body.max_tokens = maxTokens;
      // GLM thinking is a switch, not a tier (the catalog says so); other
      // OpenAI-shape vendors ignore an absent field rather than a wrong one.
      if (role.provider === 'zai' && role.reasoningEffort) {
        body.thinking = { type: role.reasoningEffort === 'on' ? 'enabled' : 'disabled' };
      }
    }
    return httpGenerate({
      url: `${withV1(role.endpoint)}/chat/completions`,
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body,
      fetchImpl,
      timeoutMs,
      textFrom: (parsed) => parsed?.choices?.[0]?.message?.content ?? '',
      servedFrom: (parsed) => parsed?.model,
    });
  };
}
