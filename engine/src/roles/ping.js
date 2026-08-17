// One real generation against a role's configured provider, measured.
//
// This is the ONLY path in the engine that verifies a model or a key, and it is
// spend-touching by definition: a ping is a real one-token generation, because anything
// cheaper proves less than the thing the settings screen claims. A HEAD request proves a
// host is up; an unauthenticated GET proves a route exists; only a generation proves this
// key, this model and this endpoint answer together. servedModelId is the identity check
// the contract names: the id the provider REPORTS, never the one that was requested.
//
// The measurement is honest about what it can see:
//   ttftMs    time from request start to the FIRST BODY BYTE. With max_tokens 1 that is
//             effectively time-to-first-token without needing SSE parsing.
//   latencyMs time from request start to the response fully read.
//   httpStatus the transport's answer, or null where there is no HTTP (claude-code runs
//             a local CLI on the owner's login auth).
//
// A provider-level failure (bad key, wrong model, host down) RETURNS rather than throws:
// { ok: false, httpStatus, hint }. The caller stores it, because a failed verification is
// a fact about the configuration worth keeping, where a thrown error would evaporate. The
// hint never quotes the key or any request header.

import { execFile } from 'node:child_process';

/// Sixty seconds, not five: reasoning models routinely think before the first token, and
/// a ping that times out on a healthy-but-slow model reports a working configuration as
/// broken. The probe timeout in embed.js is 5s because a LOCAL embedder answers fast or
/// not at all; a paid remote generation has no such distribution.
export const PING_TIMEOUT_MS = 60_000;

const PROMPT = 'Reply with the single word pong.';

function withV1(endpoint) {
  const trimmed = String(endpoint || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

async function readBody(response) {
  // First-chunk time is read off the stream so ttft is a measured fact, not the
  // latency relabelled. getReader over arrayBuffer for exactly that reason.
  const reader = response.body?.getReader?.();
  if (!reader) return { text: await response.text(), firstByteAt: Date.now() };
  const chunks = [];
  let firstByteAt = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteAt === null) firstByteAt = Date.now();
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), firstByteAt };
}

function failureHint(status, bodyText) {
  // The provider's own sentence when it sent one; the status alone otherwise. Never the
  // request, never a header: the only secret in flight lives in those two places.
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch {
    detail = String(bodyText || '').slice(0, 200);
  }
  return `The provider answered ${status}. ${detail}`.trim();
}

async function httpPing({ url, headers, body, fetchImpl, timeoutMs, servedIdFrom }) {
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      httpStatus: null,
      ttftMs: null,
      latencyMs: Date.now() - started,
      servedModelId: null,
      hint: timedOut
        ? `No answer within ${Math.round(timeoutMs / 1000)}s from ${url}.`
        : `Could not reach ${url}: ${error?.cause?.code || error?.message || error}.`,
    };
  }
  const { text, firstByteAt } = await readBody(response);
  const latencyMs = Date.now() - started;
  const ttftMs = firstByteAt === null ? null : firstByteAt - started;
  if (!response.ok) {
    return { ok: false, httpStatus: response.status, ttftMs, latencyMs, servedModelId: null, hint: failureHint(response.status, text) };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, httpStatus: response.status, ttftMs, latencyMs, servedModelId: null, hint: 'The provider answered 200 with a body that is not JSON.' };
  }
  return { ok: true, httpStatus: response.status, ttftMs, latencyMs, servedModelId: servedIdFrom(parsed) ?? null };
}

function cliPing({ model, execFileImpl, timeoutMs }) {
  // claude-code has no endpoint and no key: it is the owner's local `claude` CLI on their
  // login auth. -p json gives one headless turn; the served id comes out of modelUsage,
  // which names the models that ACTUALLY answered rather than the one requested.
  const started = Date.now();
  return new Promise((resolve) => {
    execFileImpl(
      'claude',
      ['-p', PROMPT, '--model', model, '--output-format', 'json', '--max-turns', '1'],
      { timeout: timeoutMs },
      (error, stdout) => {
        const latencyMs = Date.now() - started;
        if (error) {
          const missing = error.code === 'ENOENT';
          resolve({
            ok: false,
            httpStatus: null,
            ttftMs: null,
            latencyMs,
            servedModelId: null,
            hint: missing
              ? 'The claude CLI is not on PATH. Install Claude Code to use sub-agent roles.'
              : `The claude CLI failed: ${String(error.message || '').slice(0, 200)}`,
          });
          return;
        }
        let served = null;
        try {
          const parsed = JSON.parse(stdout);
          const usage = parsed?.modelUsage && Object.keys(parsed.modelUsage);
          served = (usage && usage[0]) || parsed?.model || null;
        } catch {
          served = null;
        }
        // The CLI's whole turn is the latency; a first-token time is not observable
        // through -p json output, and null says so rather than inventing one.
        resolve({ ok: true, httpStatus: null, ttftMs: null, latencyMs, servedModelId: served });
      },
    );
  });
}

/**
 * Ping one configured role. `role` carries provider, model, endpoint; `key` is the
 * RESOLVED value (or null for keyless providers) - resolution stays the caller's job so
 * this module never sees a pointer and cannot mix the two up.
 */
export async function pingProvider(role, key, {
  fetchImpl = fetch,
  execFileImpl = execFile,
  timeoutMs = PING_TIMEOUT_MS,
} = {}) {
  const { provider, model, endpoint } = role;
  if (provider === 'claude-code') return cliPing({ model, execFileImpl, timeoutMs });
  if (provider === 'anthropic') {
    return httpPing({
      url: `${withV1(endpoint)}/messages`,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: 1, messages: [{ role: 'user', content: PROMPT }] },
      fetchImpl,
      timeoutMs,
      servedIdFrom: (parsed) => parsed?.model,
    });
  }
  // Everything else in the catalog speaks the OpenAI chat-completions shape, including
  // ollama (whose default endpoint lacks the /v1 the shape lives under - withV1 adds it).
  // OpenAI's reasoning models refuse max_tokens and burn thought before the first sampled
  // token, so that one provider gets max_completion_tokens with room to think.
  const body = { model, messages: [{ role: 'user', content: PROMPT }] };
  if (provider === 'openai') body.max_completion_tokens = 16;
  else body.max_tokens = 1;
  return httpPing({
    url: `${withV1(endpoint)}/chat/completions`,
    headers: key ? { authorization: `Bearer ${key}` } : {},
    body,
    fetchImpl,
    timeoutMs,
    servedIdFrom: (parsed) => parsed?.model,
  });
}
