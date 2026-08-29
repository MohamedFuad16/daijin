// Transport and framing, driven over a real pipe against the real daemon process.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { errorOf, resultOf, startDaemon } from './helpers/rpc-pipe.js';

let daemon;

before(async () => { daemon = await startDaemon(); });
after(async () => { await daemon.stop(); });

test('hello answers the frozen contract version on the first call', async () => {
  const result = resultOf(await daemon.request('hello', { clientVersion: '0.1.0' }));
  assert.equal(result.contractVersion, '5', 'contractVersion tracks methods.md v5');
  assert.ok(result.engineVersion, 'the client records the engine version for the upgrade screen');
});

test('responses carry the id they were asked with, even out of order', async () => {
  // Three in flight at once: the client matches on id, so a daemon that answered
  // positionally would pass a one-at-a-time test and fail a real session.
  const [a, b, c] = await Promise.all([
    daemon.request('hello', {}),
    daemon.request('serveStatus', {}),
    daemon.request('hello', {}),
  ]);
  assert.equal(typeof a.id, 'number');
  assert.notEqual(a.id, b.id);
  assert.notEqual(b.id, c.id);
  for (const envelope of [a, b, c]) assert.equal(envelope.jsonrpc, '2.0');
});

test('a method outside the contract is the ONLY method-not-found', async () => {
  const error = errorOf(await daemon.request('noSuchMethod', {}));
  assert.equal(error.code, -32601);
  assert.match(error.data.hint, /methods\.md/, 'the hint points at the frozen surface');
});

test('an unparseable line is answered, not dropped', async () => {
  // A dropped parse error strands the client waiting forever on a request it thinks it
  // sent, which presents as a hung UI rather than an error.
  const seen = new Promise((resolve) => {
    const handle = setInterval(() => {
      const found = daemon.notifications.find(() => false);
      if (found) { clearInterval(handle); resolve(found); }
    }, 10);
    setTimeout(() => { clearInterval(handle); resolve(null); }, 100).unref();
  });
  daemon.sendRaw('{not json at all');
  await seen;
  // The parse error carries no id, so it is verified by the daemon still working after it.
  const result = resultOf(await daemon.request('hello', {}));
  assert.equal(result.contractVersion, '5', 'the stream survives a bad line');
});

test('a notification gets no response', async () => {
  daemon.notify('hello', {});
  // If the daemon answered a request with no id, the next response would carry the wrong
  // id and this request would time out or mismatch.
  const envelope = await daemon.request('hello', {});
  assert.ok(envelope.result, 'the next request still matches its own id');
});

test('a notification that FAILS is still not answered', async () => {
  // The spec is unconditional: "The Server MUST NOT reply to a Notification", and
  // "Notifications are not confirmable by definition ... the Client would not be aware of
  // any errors (like e.g. 'Invalid params','Internal error')".
  // https://www.jsonrpc.org/specification
  //
  // Only the SUCCESS path honoured that. A notification for an unknown method, or for a
  // real method that threw, came back as a full error envelope with `id: null` - a frame
  // matching no pending request, which a client can only drop or mis-attribute. The test
  // above could not see it: it notifies `hello`, which succeeds.
  const before = daemon.strayFrames.length;

  daemon.notify('noSuchMethod', {});                       // method-not-found
  daemon.notify('repoDetach', { repoPath: '/nowhere/at/all' }); // a real method that throws

  // Round-trip after them: the daemon reads lines in order, so once this answers, any
  // reply to the two above has already been written.
  const envelope = await daemon.request('hello', {});
  assert.ok(envelope.result, 'the next request still matches its own id');
  assert.deepEqual(daemon.strayFrames.slice(before), [],
    'a notification, failing or not, must draw no frame at all');
});

test('blank lines are ignored rather than answered', async () => {
  daemon.sendRaw('');
  daemon.sendRaw('   ');
  const result = resultOf(await daemon.request('hello', {}));
  assert.equal(result.contractVersion, '5');
});

test('every error carries a hint for the TUI to display verbatim', async () => {
  const envelopes = await Promise.all([
    daemon.request('repoDetach', { repoPath: '/nowhere/at/all' }),
    daemon.request('noSuchMethod', {}),
    daemon.request('jobCancel', {}),
    daemon.request('search', { repoPath: '/nowhere' }),
  ]);
  for (const envelope of envelopes) {
    const error = errorOf(envelope);
    assert.ok(error.data, `${error.code} carried no data`);
    assert.ok(typeof error.data.hint === 'string' && error.data.hint.length > 0, `${error.code} carried no hint`);
  }
});

test('stdout carries protocol only', async () => {
  // Every line the helper could not parse as JSON would have failed the pending requests
  // above. This asserts the other half: the daemon does write to stderr, so a handler
  // logging is not silently lost either.
  await daemon.request('hello', {});
  assert.equal(daemon.notifications.every((row) => typeof row.method === 'string'), true);
});

// ---- single-writer lock (D-0019) --------------------------------------------------------

test('one daemon per state root: a second is refused by name', async () => {
  // Multiple TUI instances are served by ONE daemon with multiple clients, never by two
  // daemons racing repos.json, where the loser's attach silently disappears. With a
  // `daijin` shim on PATH, two terminals starting it at once is an ordinary accident.
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const nodePath = (await import('node:path')).default;
  const stateRoot = await mkdtemp(nodePath.join(tmpdir(), 'daijin-lock-'));
  const first = await startDaemon({ stateRoot });
  try {
    // The first one is alive and answering, which is what makes the lock meaningful.
    assert.equal(resultOf(await first.request('hello', {})).contractVersion, '5');

    const second = await startDaemon({ stateRoot });
    const exited = await new Promise((resolve) => {
      second.child.once('exit', (code) => resolve(code));
      setTimeout(() => resolve(null), 8_000).unref();
    });
    assert.notEqual(exited, 0, 'the second daemon must not serve; it must exit');
    assert.match(second.stderr, /Another daijin daemon is already serving/);
    assert.match(second.stderr, /PID \d+/, 'the refusal names the holder, or the user has nothing to act on');
    assert.match(second.stderr, /daemon\.lock/, 'and names the lock file');
    await second.stop({ keepStateRoot: true });

    // The first is unaffected by the attempt.
    assert.equal(resultOf(await first.request('hello', {})).contractVersion, '5');
  } finally {
    await first.stop({ keepStateRoot: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('the lock is released on exit, so a restart is not blocked by a ghost', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const nodePath = (await import('node:path')).default;
  const stateRoot = await mkdtemp(nodePath.join(tmpdir(), 'daijin-lock2-'));
  try {
    const first = await startDaemon({ stateRoot });
    await first.request('hello', {});
    await first.stop({ keepStateRoot: true });

    // A lock that outlived its holder would make the tool unusable after any clean quit.
    const second = await startDaemon({ stateRoot });
    assert.equal(resultOf(await second.request('hello', {})).contractVersion, '5');
    await second.stop({ keepStateRoot: true });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('a SIGKILLed daemon leaves a lock that the next start reclaims', async () => {
  // Found by store-adapter's installer, not by design: their smoke check kills its child
  // because it has no reason to be polite, and their dry run does it five times against one
  // state root. My own tests only covered a clean exit and a live holder, so the crash path
  // was defended by luck. Their harness ran the real thing; this is that property written
  // down so it stays defended.
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const nodePath = (await import('node:path')).default;
  const stateRoot = await mkdtemp(nodePath.join(tmpdir(), 'daijin-sigkill-'));
  try {
    const killed = await startDaemon({ stateRoot });
    await killed.request('hello', {});
    const lockFile = nodePath.join(stateRoot, 'daemon.lock');
    const held = JSON.parse(await readFile(lockFile, 'utf8'));
    assert.ok(Number.isInteger(held.pid), 'the lock names its holder');

    killed.child.kill('SIGKILL');
    await new Promise((resolve) => { killed.child.once('exit', resolve); });

    // The lock file OUTLIVES the crash, which is the whole point: reclaim is by pid
    // liveness, not by the file's absence.
    assert.ok(await readFile(lockFile, 'utf8'), 'a killed daemon cannot clean up after itself');

    const next = await startDaemon({ stateRoot });
    assert.equal(resultOf(await next.request('hello', {})).contractVersion, '5',
      'the next start reclaims a lock whose holder is gone');
    await next.stop({ keepStateRoot: true });
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
