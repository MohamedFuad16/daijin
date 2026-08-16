// Key pointers: the value is fetched at use, never stored, never returned.
//
// The property under test is negative, which is the hard kind: no path through this module
// puts a key into settings, into a response, or into an error message. The tests use a
// distinctive sentinel so a leak anywhere shows up as a string match rather than as a
// judgment call.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkKeyRef, parseKeyRef, resolveKey } from '../src/roles/keys.js';

const SECRET = 'sk-do-not-let-this-escape-0123456789';

async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), 'dj-keys-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('the legacy bare pointer is disambiguated by SHAPE, not guessed', async () => {
  // The contract documents a bare pointer as "the name of an environment variable or a
  // file path", which is one string with two meanings. Resolved by shape rather than
  // broken: an absolute path is a file, a SHOUTING_NAME is an environment variable.
  assert.deepEqual(parseKeyRef('OPENROUTER_API_KEY'), { kind: 'env', name: 'OPENROUTER_API_KEY', legacy: true });
  assert.deepEqual(parseKeyRef('/etc/daijin/key'), { kind: 'file', file: '/etc/daijin/key', legacy: true });
  // A lowercase relative string is the shape of a mistake, and guessing which meaning was
  // intended is how a key ends up somewhere nobody expected.
  assert.equal(parseKeyRef('my-key.txt'), null);
  assert.equal(parseKeyRef('sk-a-literal-key-value'), null);
  assert.equal(parseKeyRef(''), null);
  assert.equal(parseKeyRef(null), null);
  assert.equal(parseKeyRef('env:'), null);
  assert.equal(parseKeyRef('env-file:/path/no-hash'), null);
  assert.equal(parseKeyRef('env-file:#NAME'), null);
  assert.equal(parseKeyRef('env-file:/path#'), null);
  await assert.rejects(resolveKey('my-key.txt'), /Unusable key pointer/);
  // The legacy form still resolves, because breaking a documented contract to fix its
  // ambiguity would strand every configuration written against it.
  assert.equal(await resolveKey('LEGACY_NAME', { environment: { LEGACY_NAME: SECRET } }), SECRET);
});

test('env: reads the process environment at USE time', async () => {
  const value = await resolveKey('env:DAIJIN_TEST_KEY', { environment: { DAIJIN_TEST_KEY: `${SECRET}\n` } });
  assert.equal(value, SECRET, 'trimmed, because a trailing newline in a header is a 401');
  await assert.rejects(resolveKey('env:DAIJIN_TEST_KEY', { environment: {} }), /is not set/);
});

test('file: reads a secret file, and an empty one is a refusal rather than an empty key', async () => {
  // An empty key sent to a provider is a 401 three layers down; caught here it names the
  // file that is empty.
  const { root, cleanup } = await scratch();
  try {
    const file = path.join(root, 'key.txt');
    await writeFile(file, `${SECRET}\n`, 'utf8');
    assert.equal(await resolveKey(`file:${file}`), SECRET);

    await writeFile(file, '\n\n', 'utf8');
    await assert.rejects(resolveKey(`file:${file}`), /is empty/);
    await assert.rejects(resolveKey(`file:${path.join(root, 'missing')}`), /cannot be read/);
  } finally {
    await cleanup();
  }
});

test('env-file: follows the platform\'s _FILE convention to a second hop', async () => {
  // This is the case the first wiring actually needs: the platform's .env.local holds
  // OPENROUTER_API_KEY_FILE, which names a file outside the repository, which holds the
  // key. Two hops, both by name. Flattening it would copy a secret out of one 0600 file
  // into a JSON file in a state directory.
  const { root, cleanup } = await scratch();
  try {
    const keyFile = path.join(root, 'openrouter.key');
    const envFile = path.join(root, '.env.local');
    await writeFile(keyFile, `${SECRET}\n`, 'utf8');
    await writeFile(envFile, [
      '# a comment line',
      'DATABASE_URL=postgres://example',
      `OPENROUTER_API_KEY_FILE=${keyFile}`,
      'ENGINEER_MODEL=some-model',
    ].join('\n'), 'utf8');

    assert.equal(await resolveKey(`env-file:${envFile}#OPENROUTER_API_KEY_FILE`), SECRET);

    // A name WITHOUT the _FILE suffix is the value itself, which is the other half of the
    // convention.
    await writeFile(envFile, `OPENROUTER_API_KEY="${SECRET}"`, 'utf8');
    assert.equal(await resolveKey(`env-file:${envFile}#OPENROUTER_API_KEY`), SECRET);

    await assert.rejects(resolveKey(`env-file:${envFile}#NOT_PRESENT`), /is not set in/);
    await assert.rejects(resolveKey(`env-file:${path.join(root, 'nope')}#X`), /Cannot read the environment file/);
  } finally {
    await cleanup();
  }
});

test('NO REFUSAL MESSAGE CONTAINS THE KEY', async () => {
  // Errors are read by users and pasted into issues. Naming the pointer and the hop that
  // failed is actionable; printing what is behind it is a leak in a bug report.
  const { root, cleanup } = await scratch();
  try {
    const keyFile = path.join(root, 'k');
    const envFile = path.join(root, 'e');
    await writeFile(keyFile, SECRET, 'utf8');
    await writeFile(envFile, `OPENROUTER_API_KEY=${SECRET}\nBROKEN_FILE=${path.join(root, 'gone')}\n`, 'utf8');

    const messages = [];
    for (const ref of ['nonsense', 'env:MISSING', `file:${path.join(root, 'gone')}`,
      `env-file:${envFile}#NOT_PRESENT`, `env-file:${envFile}#BROKEN_FILE`]) {
      const checked = await checkKeyRef(ref, { environment: {} });
      assert.equal(checked.resolvable, false);
      messages.push(checked.reason);
    }
    for (const message of messages) {
      assert.ok(!message.includes(SECRET), `a refusal leaked the key: ${message}`);
    }
  } finally {
    await cleanup();
  }
});

test('checkKeyRef answers READY or NOT without handing over the key', async () => {
  // What a settings screen calls: "the watcher is ready" has to be renderable without a
  // secret crossing the RPC boundary.
  const { root, cleanup } = await scratch();
  try {
    const file = path.join(root, 'key');
    await writeFile(file, SECRET, 'utf8');
    const ready = await checkKeyRef(`file:${file}`);
    assert.deepEqual(ready, { resolvable: true, reason: null });
    assert.ok(!JSON.stringify(ready).includes(SECRET), 'the answer carries no key');
  } finally {
    await cleanup();
  }
});

// ---- the settings boundary ---------------------------------------------------------------

test('a malformed pointer is refused AT SET TIME, not at the provider call', async () => {
  // Stored unchecked it fails later, at the moment of a provider call, where the user reads
  // it as the provider being down rather than as a setting they mistyped.
  const { EngineState } = await import('../src/rpc/state.js');
  const { root, cleanup } = await scratch();
  try {
    const state = new EngineState({ stateRoot: root });
    await assert.rejects(
      state.patchSettings({ roles: [{ role: 'engineer', keyRef: 'sk-a-literal-key-value' }] }),
      /Unusable key pointer for the engineer role/,
    );
    const settings = await state.settings();
    assert.equal(settings.roles.find((row) => row.role === 'engineer').keyRef, null,
      'and nothing was stored, so a rejected key value does not linger in the file');
  } finally {
    await cleanup();
  }
});

test('settingsGet says whether a role can REACH its key, and never what the key is', async () => {
  const { EngineState } = await import('../src/rpc/state.js');
  const { root, cleanup } = await scratch();
  try {
    const keyFile = path.join(root, 'engineer.key');
    await writeFile(keyFile, SECRET, 'utf8');
    const state = new EngineState({ stateRoot: root });
    await state.patchSettings({ roles: [
      { role: 'engineer', keyRef: `file:${keyFile}` },
      { role: 'watcher', keyRef: `file:${path.join(root, 'absent.key')}` },
    ] });

    const settings = await state.settings();
    const engineer = settings.roles.find((row) => row.role === 'engineer');
    const watcher = settings.roles.find((row) => row.role === 'watcher');
    const teacher = settings.roles.find((row) => row.role === 'teacher');

    assert.equal(engineer.keyResolvable, true);
    assert.equal(watcher.keyResolvable, false, 'configured and unreachable');
    assert.match(watcher.keyReason, /cannot be read/);
    // NULL, not false. Never configured is a different claim from configured and broken,
    // and a settings screen that shows a red mark on a role nobody has set up yet is
    // reporting a problem that does not exist.
    assert.equal(teacher.keyResolvable, null);
    assert.equal(teacher.keyReason, null);

    // The whole response, serialised, carries no key.
    assert.ok(!JSON.stringify(settings).includes(SECRET), 'no key reaches the settings response');
  } finally {
    await cleanup();
  }
});

test('a client cannot patch itself into looking reachable', async () => {
  // keyResolvable is DERIVED. Accepting it from a patch would let a client claim a role can
  // reach its key without anything having checked, which is the same defect as patching a
  // ping.
  const { EngineState } = await import('../src/rpc/state.js');
  const { root, cleanup } = await scratch();
  try {
    const state = new EngineState({ stateRoot: root });
    const settings = await state.patchSettings({
      roles: [{ role: 'engineer', keyResolvable: true, keyReason: 'trust me' }],
    });
    const engineer = settings.roles.find((row) => row.role === 'engineer');
    assert.equal(engineer.keyResolvable, null, 'unconfigured stays unconfigured');
    assert.equal(engineer.keyReason, null);
    const raw = await state.rawSettings();
    assert.equal(Object.hasOwn(raw.roles.find((row) => row.role === 'engineer'), 'keyResolvable'), false,
      'and nothing derived is written to disk');
  } finally {
    await cleanup();
  }
});
