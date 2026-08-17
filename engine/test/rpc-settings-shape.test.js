// The settings shape after F4: the role migration, repoScanRoots, and the provider trio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EngineState, DEFAULT_SETTINGS } from '../src/rpc/state.js';

async function stateWith(settings) {
  const root = await mkdtemp(path.join(tmpdir(), 'settings-'));
  await mkdir(root, { recursive: true });
  if (settings) await writeFile(path.join(root, 'settings.json'), JSON.stringify(settings), 'utf8');
  return new EngineState({ stateRoot: root });
}

test('a settings file written BEFORE these fields existed still reads with the full key set', async () => {
  // THE MIGRATION, and the reason it is not optional: the top-level merge is shallow, so a
  // stored `roles` array replaces the defaults wholesale. Without normalising, an owner who
  // configured roles before `provider` existed keeps rows without it, and the contract
  // promises a closed key set. The shape would be right on a fresh state root and wrong on
  // the only machine that matters, which is the exact defect class this batch closes.
  const state = await stateWith({
    roles: [
      { role: 'engineer', preset: 'GLM', model: 'glm-4.6', endpoint: null, keyRef: null, keyMasked: null, ping: null },
      { role: 'teacher', preset: null, model: null, endpoint: null, keyRef: null, keyMasked: null, ping: null },
    ],
  });
  const settings = await state.settings();

  assert.equal(settings.roles.length, 4, 'roles missing from the file are restored from the defaults');
  const engineer = settings.roles.find((row) => row.role === 'engineer');
  assert.equal(engineer.model, 'glm-4.6', 'a stored value survives the normalisation');
  assert.equal(engineer.provider, null, 'a field the file predates arrives as its default');
  assert.equal(Object.hasOwn(engineer, 'reasoningEffort'), true);

  // preset is GONE, not carried through. A retired field left in place reappears in
  // settingsGet, where a client cannot tell it from a live one.
  for (const row of settings.roles) {
    assert.equal(Object.hasOwn(row, 'preset'), false, `${row.role} still carries the retired preset field`);
  }

  // Every row has the SAME key set, whatever the file held for it.
  const shapes = settings.roles.map((row) => Object.keys(row).sort().join(','));
  assert.equal(new Set(shapes).size, 1, 'rows disagree about their own shape');
});

test('repoScanRoots defaults to the two documented directories and is REPLACED, never merged', async () => {
  const state = await stateWith(null);
  const initial = await state.settings();
  assert.equal(initial.repoScanRoots.length, 2);
  assert.ok(initial.repoScanRoots[0].endsWith('Documents'));
  assert.ok(initial.repoScanRoots[1].endsWith(path.join('Documents', 'GitHub')));

  const updated = await state.patchSettings({ repoScanRoots: ['/tmp/a', '/tmp/b'] });
  // REPLACED. A merge cannot express removal, so a merged list would make a scan root
  // permanent: the owner could add one and never take one away.
  assert.deepEqual(updated.repoScanRoots, ['/tmp/a', '/tmp/b']);

  const shrunk = await state.patchSettings({ repoScanRoots: ['/tmp/a'] });
  assert.deepEqual(shrunk.repoScanRoots, ['/tmp/a'], 'removing a root must be possible');

  // Entries are resolved, so a relative path cannot mean two things on two days.
  const resolved = await state.patchSettings({ repoScanRoots: ['.'] });
  assert.ok(path.isAbsolute(resolved.repoScanRoots[0]));
});

test('repoScanRoots refuses anything that is not a list of non-empty paths', async () => {
  const state = await stateWith(null);
  for (const bad of ['/tmp/a', [''], ['  '], [42], [null]]) {
    await assert.rejects(() => state.patchSettings({ repoScanRoots: bad }), /list of non-empty directory paths/,
      `${JSON.stringify(bad)} must be refused`);
  }
});

test('the provider trio is refused at SET time when a known model contradicts it', async () => {
  const state = await stateWith(null);
  await assert.rejects(
    () => state.patchSettings({ roles: [{ role: 'engineer', provider: 'not-a-vendor' }] }),
    /Unusable provider settings for the engineer role.*unknown provider not-a-vendor/s,
  );
  // An unknown MODEL is not refused: the catalog calls itself a starting point.
  const ok = await state.patchSettings({ roles: [{ role: 'engineer', provider: 'openai', model: 'gpt-9-未来' }] });
  const engineer = ok.roles.find((row) => row.role === 'engineer');
  assert.equal(engineer.model, 'gpt-9-未来');
  assert.equal(engineer.modelKnown, false, 'and it is reported as unrecognised rather than silently accepted');
  assert.match(engineer.modelReason, /still be used as written/);
});

test('modelKnown and modelReason are DERIVED, and a client cannot write them', async () => {
  const state = await stateWith(null);
  const written = await state.patchSettings({
    roles: [{ role: 'engineer', provider: 'openai', model: 'gpt-9-未来', modelKnown: true, modelReason: 'all fine' }],
  });
  const engineer = written.roles.find((row) => row.role === 'engineer');
  // Accepting these from a patch would let a client mark its own role recognised, which is
  // the same reason `ping` and `keyResolvable` are refused from a patch.
  assert.equal(engineer.modelKnown, false);
  assert.notEqual(engineer.modelReason, 'all fine');

  // AND IT MUST NOT REACH THE STATE FILE, which the response alone cannot show: settings()
  // recomputes these after spreading the stored row, so a written value is overwritten on
  // the way out and the wire looks correct while the file on disk is wrong. A mutation
  // removing the guard survived against the response check for exactly that reason. The
  // stored value matters because it persists: it is read by anything that reads the file
  // directly, and it outlives the process that wrote it.
  const stored = JSON.parse(await readFile(state.settingsFile, 'utf8'));
  const storedEngineer = stored.roles.find((row) => row.role === 'engineer');
  assert.equal(Object.hasOwn(storedEngineer, 'modelKnown'), false,
    'a derived field must never be persisted from a client patch');
  assert.equal(Object.hasOwn(storedEngineer, 'modelReason'), false);
});

test('DEFAULT_SETTINGS has no preset and every role carries the new trio', () => {
  for (const role of DEFAULT_SETTINGS.roles) {
    assert.equal(Object.hasOwn(role, 'preset'), false);
    assert.equal(role.provider, null);
    assert.equal(role.reasoningEffort, null);
  }
});

test('a settings file predating a key inside retrieval still gets that default back', async () => {
  // THE SHALLOW MERGE, one level up from the roles hole and the same defect. A stored
  // `retrieval` used to replace the default outright, so a file written before
  // embeddingDimension existed lost it, and the wire carried dimension: null on the
  // machines with the longest history. Aged state is the only state a real owner has.
  const state = await stateWith({ retrieval: { tokenBudget: 6000, k: 8 } });
  const settings = await state.settings();

  assert.equal(settings.retrieval.tokenBudget, 6000, 'the stored value wins');
  assert.equal(settings.retrieval.embeddingDimension, DEFAULT_SETTINGS.retrieval.embeddingDimension,
    'and a key the file predates comes back from the defaults');
  assert.equal(settings.retrieval.embeddingModel, DEFAULT_SETTINGS.retrieval.embeddingModel);
  assert.deepEqual(Object.keys(settings.retrieval).sort(), Object.keys(DEFAULT_SETTINGS.retrieval).sort());
});

test('every object-valued section is filled in, not just retrieval', async () => {
  // Fixed for the CLASS. Three other sections have the same shape, and repairing only the
  // one with a visible symptom leaves the next for whoever adds a key to storage or charts.
  const state = await stateWith({ retrieval: {}, storage: {}, charts: {}, spendGate: {} });
  const settings = await state.settings();
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (Array.isArray(value) || typeof value !== 'object' || value === null) continue;
    assert.deepEqual(Object.keys(settings[key]).sort(), Object.keys(value).sort(),
      `${key} lost its defaults to a shallow merge`);
  }
});

test('arrays are REPLACED by the stored file, never merged back to their defaults', async () => {
  // The other half of the rule, and the one a careless fix breaks: a list is data, not a
  // shape. An owner who removed a scan root must not be handed it back on the next read.
  const state = await stateWith({ repoScanRoots: ['/only/this/one'] });
  const settings = await state.settings();
  assert.deepEqual(settings.repoScanRoots, ['/only/this/one']);
});

test('the keyRef refusal REACHES the caller with its reason, and without the value', async () => {
  // The same lesson as F1's blocked report: a fix that lands only on the helper is
  // invisible to the person it was written for. A mutation dropping keyRefRefusal from
  // settingsSet survived until this existed, because every other test called the message
  // function directly and none checked that settingsSet used it.
  const state = await stateWith(null);
  await assert.rejects(
    () => state.patchSettings({ roles: [{ role: 'engineer', keyRef: 'file:rel/key' }] }),
    (error) => {
      assert.match(error.message, /engineer role/, 'the refusal names which role');
      assert.match(error.message, /relative/, 'and carries the reason, not just a rejection');
      assert.match(error.message, /absolute path|full path from the root/);
      return true;
    },
  );

  // AND THE VALUE MUST NOT TRAVEL WITH IT. This error crosses the RPC boundary and lands
  // in logs, and the likeliest wrong value here is a pasted key.
  const sentinel = 'sk-ant-DAIJIN-SENTINEL-NEVER-LOG-ME-42';
  await assert.rejects(
    () => state.patchSettings({ roles: [{ role: 'engineer', keyRef: sentinel }] }),
    (error) => {
      assert.equal(error.message.includes(sentinel), false, 'the refusal leaked the pasted value');
      assert.match(error.message, /never the key/);
      return true;
    },
  );
});
