// Daemon state under concurrency.
//
// The daemon lock protects the state files from another PROCESS. Nothing protected them
// from another CONNECTION inside one daemon, and those are different problems. Measured
// before the fix, with EngineState driven directly:
//
//   2 concurrent attaches  -> 1 threw, repos.json holds 1 of 2   [hard error]
//   10 concurrent attaches -> 9 threw, repos.json holds 1 of 10
//
// It failed at N=2, and it was invisible only because the stdio read loop awaits each
// request before reading the next. These tests are what stop it coming back the moment a
// second client attaches or a job writes state.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EngineState, writeJsonAtomic } from '../src/rpc/state.js';

async function freshState() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-state-'));
  return { state: new EngineState({ stateRoot }), stateRoot };
}

test('N concurrent attaches all land, at every N that used to fail', async () => {
  for (const n of [2, 3, 5, 10, 25]) {
    const { state, stateRoot } = await freshState();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: n }, (unused, index) => state.attachRepo(`/tmp/repo-${index}`)),
      );
      const rejected = results.filter((row) => row.status === 'rejected');
      assert.deepEqual(rejected.map((row) => row.reason?.message), [], `${n} concurrent attaches threw`);

      const stored = JSON.parse(await readFile(path.join(stateRoot, 'repos.json'), 'utf8'));
      assert.equal(stored.length, n, `${n} concurrent attaches stored ${stored.length}`);
      // Not just the COUNT: a serialization that dropped one and duplicated another would
      // pass a count check.
      assert.deepEqual(
        stored.map((row) => row.path).sort(),
        Array.from({ length: n }, (unused, index) => path.resolve(`/tmp/repo-${index}`)).sort(),
      );
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }
});

test('concurrent mixed mutations across different files do not lose writes', async () => {
  // Attach, settings and board all read-modify-write their own file. Interleaving them is
  // what several attached clients on different screens actually produces.
  const { state, stateRoot } = await freshState();
  try {
    await Promise.all([
      ...Array.from({ length: 5 }, (unused, index) => state.attachRepo(`/tmp/mixed-${index}`)),
      ...Array.from({ length: 5 }, (unused, index) => state.patchSettings({ retrieval: { [`knob${index}`]: index } })),
      ...Array.from({ length: 5 }, (unused, index) => state.addBoardFinding({ ts: index, source: 'watcher', severity: 'info' })),
      ...Array.from({ length: 5 }, (unused, index) => state.recordConsent({ method: `m${index}` })),
    ]);

    assert.equal((await state.repos()).length, 5);
    assert.equal((await state.board()).length, 5);
    assert.equal((await state.consentLog()).length, 5);
    const settings = await state.settings();
    for (let index = 0; index < 5; index += 1) {
      assert.equal(settings.retrieval[`knob${index}`], index, `settings patch ${index} was lost`);
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('a failed write does not wedge every write after it', async () => {
  // The queue must survive a rejection. A chain that stops on the first failure would turn
  // one bad write into a daemon that silently accepts and discards everything afterwards,
  // which is worse than the failure it inherited.
  const { state, stateRoot } = await freshState();
  try {
    await assert.rejects(state.attachRepo(undefined), /path/i);
    const repo = await state.attachRepo('/tmp/after-the-failure');
    assert.equal(repo.path, path.resolve('/tmp/after-the-failure'));
    assert.equal((await state.repos()).length, 1);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('no temp files survive a burst of writes', async () => {
  // The original bug was a temp name shared by every write in a process. A leftover
  // .tmp- file is the visible residue of that class of bug, so it is asserted directly.
  const { state, stateRoot } = await freshState();
  try {
    await Promise.all(Array.from({ length: 20 }, (unused, index) => state.attachRepo(`/tmp/burst-${index}`)));
    const leftovers = (await readdir(stateRoot)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'a temp file outliving its write means a rename did not happen');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('the consent trail is ordered by when consent was given', async () => {
  // An append cannot lose a record, so this is about ORDER: anyone reading an audit trail
  // assumes line order is chronological without being told.
  const { state, stateRoot } = await freshState();
  try {
    await Promise.all(Array.from({ length: 10 }, (unused, index) => state.recordConsent({
      method: `call-${index}`,
      at: new Date(1_760_000_000_000 + index).toISOString(),
    })));
    const rows = await state.consentLog();
    assert.deepEqual(rows.map((row) => row.method), Array.from({ length: 10 }, (unused, index) => `call-${index}`));
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('a truncated final line does not make the whole trail unreadable', async () => {
  // A crash mid-append leaves a partial line. Losing the last record is survivable; losing
  // the entire audit trail because of it is not.
  const { state, stateRoot } = await freshState();
  try {
    await state.recordConsent({ method: 'first' });
    await state.recordConsent({ method: 'second' });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path.join(stateRoot, 'consent.jsonl'), '{"method":"trunc', 'utf8');

    const rows = await state.consentLog();
    assert.deepEqual(rows.map((row) => row.method), ['first', 'second']);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test('the atomic writer is safe when called concurrently, on its own terms', async () => {
  // Tested DIRECTLY rather than through EngineState, and the reason matters. The
  // serialization queue means EngineState never calls this concurrently, so restoring the
  // original shared temp name (`${file}.tmp-${pid}`) does NOT fail any test driven through
  // the state object. That would make the temp-name fix dead coverage: a defense no test
  // can fail on. The next caller to write state might not come through the queue, so the
  // writer has to be safe by itself and is checked by itself.
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-atomic-'));
  const target = path.join(stateRoot, 'thing.json');
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (unused, index) => writeJsonAtomic(target, { writer: index })),
    );
    assert.deepEqual(results.filter((row) => row.status === 'rejected').map((row) => row.reason?.message), [],
      'concurrent atomic writes must not collide on a shared temp path');

    // Exactly one writer wins, and the file is complete rather than interleaved.
    const written = JSON.parse(await readFile(target, 'utf8'));
    assert.ok(Number.isInteger(written.writer) && written.writer >= 0 && written.writer < 20);

    const leftovers = (await readdir(stateRoot)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'every temp file was renamed or cleaned up');
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
