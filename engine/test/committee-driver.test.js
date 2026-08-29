// The committee's strict-JSON contract, and the role driver's transports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { committeePrompt, parseCommitteeReply } from '../src/gym/committee.js';
import { createRoleGenerate } from '../src/roles/driver.js';

test('the committee reply parser: strict, fence-tolerant, prose-extracting, never repairing', () => {
  const good = { chosen: [{ commit: 'a'.repeat(40), task: 'A task statement comfortably over the thirty-five character floor.', heldOut: false }] };
  assert.deepEqual(parseCommitteeReply(JSON.stringify(good)).chosen.length, 1);
  // A fenced reply is a formatting tic, not a defect.
  assert.equal(parseCommitteeReply('```json\n' + JSON.stringify(good) + '\n```').chosen.length, 1);
  // Prose around the object: the outermost literal is EXTRACTED, still parsed strictly.
  assert.equal(parseCommitteeReply('Here is my selection: ' + JSON.stringify(good) + ' Thanks!').chosen.length, 1);
  // A short task is a refusal naming the commit, because the student reads it.
  assert.throws(() => parseCommitteeReply(JSON.stringify({ chosen: [{ commit: 'b'.repeat(40), task: 'too short' }] })), /35 characters/);
  assert.throws(() => parseCommitteeReply('no json here at all'), /not JSON/);
  assert.throws(() => parseCommitteeReply('{"answer": 42}'), /no chosen array/);
});

test('the prompt lists candidates and relations deterministically', () => {
  const prompt = committeePrompt({
    candidates: [{ commit: 'c'.repeat(40), date: '2026-08-01', subject: 'fix: thing', files: ['a.js'], changedLines: 4 }],
    relations: [{ later: 'l'.repeat(40), earlier: 'e'.repeat(40), kind: 'revert' }],
    target: 5,
  });
  assert.match(prompt, /up to 5/);
  assert.match(prompt, new RegExp('c'.repeat(40)));
  assert.match(prompt, /supersedes/);
  assert.match(prompt, /STRICT JSON/);
});

test('the zai transport carries the thinking switch and the bearer key', async () => {
  const sent = [];
  const generate = createRoleGenerate(
    { provider: 'zai', model: 'glm-5.3', endpoint: 'https://api.z.ai/api/coding/paas/v4', reasoningEffort: 'on' },
    {
      key: 'sk-test',
      fetchImpl: async (url, options) => {
        sent.push({ url, options });
        return new Response(JSON.stringify({ model: 'glm-5.3', choices: [{ message: { content: 'ok' } }] }), { status: 200 });
      },
    },
  );
  const result = await generate({ system: 'be brief', prompt: 'hello' });
  assert.equal(result.text, 'ok');
  assert.equal(sent[0].url, 'https://api.z.ai/api/coding/paas/v4/chat/completions');
  const body = JSON.parse(sent[0].options.body);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(sent[0].options.headers.authorization, 'Bearer sk-test');
});

test('the claude-code transport runs the CHOSEN sub-agent file as the system prompt', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-'));
  const agentPath = path.join(dir, 'daijin-auditor.md');
  await writeFile(agentPath, '---\nname: daijin-auditor\nmodel: claude-fable-5\n---\n\nYou are the auditor. Judge carefully.\n');
  const calls = [];
  const generate = createRoleGenerate(
    { provider: 'claude-code', model: 'claude-fable-5' },
    {
      agentPath,
      execFileImpl: (command, args, options, callback) => {
        calls.push({ command, args });
        callback(null, JSON.stringify({ type: 'result', result: '{"chosen":[]}' }), '');
      },
    },
  );
  const result = await generate({ prompt: 'select' });
  assert.equal(result.text, '{"chosen":[]}');
  assert.equal(calls[0].command, 'claude');
  const appended = calls[0].args[calls[0].args.indexOf('--append-system-prompt') + 1];
  assert.match(appended, /You are the auditor/);
  // The frontmatter is STRIPPED: yaml keys are not instructions.
  assert.doesNotMatch(appended, /name: daijin-auditor/);
});

test('a provider error surfaces the provider sentence, never silence', async () => {
  const generate = createRoleGenerate(
    { provider: 'zai', model: 'glm-5.3', endpoint: 'https://api.z.ai/api/paas/v4' },
    {
      key: 'sk-x',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Insufficient balance' } }), { status: 429 }),
    },
  );
  await assert.rejects(() => generate({ prompt: 'x' }), /429.*Insufficient balance/s);
});

test('a CLI refusal surfaces the CLI\'s own sentence, not the exec wrapper\'s command line', async () => {
  // The live goal loop reported "Command failed: claude -p <the entire
  // prompt>" five times when the truth was one line: the account had hit its
  // model limit. The body carries the reason even on a non-zero exit.
  const limitBody = JSON.stringify({
    is_error: true,
    stop_reason: 'stop_sequence',
    result: "You've reached your Fable 5 limit. Switch to another model, or manage usage credits.",
  });
  let stdinClosed = false;
  const generate = createRoleGenerate(
    { provider: 'claude-code', model: 'claude-fable-5' },
    {
      execFileImpl: (command, args, options, callback) => {
        // stdin must be CLOSED: the CLI otherwise waits three seconds for it on every
        // single call and warns in a way that reads like a defect.
        //
        // This asserted `options.stdio` deep-equalled ['ignore','pipe','pipe'], which was a
        // DEAD GATE - it pinned the option rather than the effect, and execFile does not
        // accept a `stdio` option at all. It forwards a fixed list and drops the rest in
        // silence (https://nodejs.org/api/child_process.html), so the assertion passed on
        // every run while every real child kept an open stdin pipe and paid the tax the
        // comment says it avoids. The handle is the only thing that can close it, so the
        // handle is what this now checks.
        assert.equal(options.stdio, undefined, 'execFile has no stdio option; passing one only reads as a fix');
        callback(Object.assign(new Error('Command failed: claude -p <a very long prompt>'), { code: 1 }), limitBody, '');
        return { stdin: { end: () => { stdinClosed = true; } } };
      },
    },
  );
  await assert.rejects(() => generate({ prompt: 'x' }), (error) => {
    assert.match(error.message, /reached your Fable 5 limit/);
    assert.doesNotMatch(error.message, /Command failed/, 'the wrapper message is noise beside the real reason');
    return true;
  });
  assert.equal(stdinClosed, true, "the child's stdin is closed on the handle, which is the only thing that closes it");
});
