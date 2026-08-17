// The provider catalog: its shape, its refusals, and the properties that make it safe to
// render. Written against the COMMITTED file rather than a fixture wherever the property
// is about the real catalog, because a fixture would pass while the shipped file was
// broken, and the shipped file is the one the dialog reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProviderCatalog, providerIds, checkRoleProvider, describeRoleModel } from '../src/roles/providers.js';

const CATALOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../config/providers.json');

async function withCatalog(mutate) {
  const raw = JSON.parse(await readFile(CATALOG_FILE, 'utf8'));
  mutate(raw);
  const dir = await mkdtemp(path.join(tmpdir(), 'catalog-'));
  const file = path.join(dir, 'providers.json');
  await writeFile(file, JSON.stringify(raw));
  return file;
}

test('the committed catalog carries the six ruled providers, by id not by label', async () => {
  // claude-code joined the five vendors (owner field round 4): it is not an API vendor
  // but the owner's local CLI auth, and it lives in the same closed enum because a role
  // stores exactly one provider id whatever transport answers it.
  const ids = await providerIds();
  assert.deepEqual([...ids].sort(), ['anthropic', 'claude-code', 'ollama', 'openai', 'xai', 'zai']);
  // The ids are VENDOR names. The display names differ deliberately ("Claude", "GLM",
  // "Grok"), and a client that sends what it renders would send a provider that does not
  // exist. Pinned so a well-meaning rename of a label cannot become a rename of an id.
  const catalog = await loadProviderCatalog();
  const byId = new Map(catalog.providers.map((p) => [p.id, p.label]));
  assert.equal(byId.get('anthropic'), 'Claude');
  assert.equal(byId.get('zai'), 'GLM');
  assert.equal(byId.get('xai'), 'Grok');
});

test('every provider and model is renderable: no missing labels, endpoints or duplicate ids', async () => {
  const catalog = await loadProviderCatalog();
  const seenProviders = new Set();
  for (const provider of catalog.providers) {
    assert.ok(provider.id && typeof provider.id === 'string', 'a provider needs an id');
    assert.ok(provider.label, `${provider.id} needs a label to render`);
    // claude-code is the one provider with NOTHING to dial: it launches a local CLI on
    // the owner's login auth, so a default endpoint would be an invented fact.
    if (provider.id !== 'claude-code') {
      assert.ok(provider.endpointDefault, `${provider.id} needs a default endpoint to offer`);
    }
    assert.equal(seenProviders.has(provider.id), false, `duplicate provider id ${provider.id}`);
    seenProviders.add(provider.id);
    assert.ok(provider.models.length > 0, `${provider.id} offers no models, so its dialog would be empty`);
    const seenModels = new Set();
    for (const model of provider.models) {
      assert.ok(model.id, `a model of ${provider.id} needs an id`);
      assert.ok(model.label, `${provider.id}/${model.id} needs a label`);
      assert.equal(seenModels.has(model.id), false, `duplicate model id ${provider.id}/${model.id}`);
      seenModels.add(model.id);
    }
  }
});

test('reasoningEffort is null or a non-empty list of strings, never an empty list', async () => {
  const catalog = await loadProviderCatalog();
  let sawNull = false;
  let sawValues = false;
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      if (model.reasoningEffort === null) { sawNull = true; continue; }
      assert.ok(Array.isArray(model.reasoningEffort) && model.reasoningEffort.length > 0,
        `${provider.id}/${model.id} must use null for unsupported, never an empty list`);
      for (const value of model.reasoningEffort) assert.equal(typeof value, 'string');
      sawValues = true;
    }
  }
  // BOTH cases must be present in the shipped catalog, or this test is asserting against
  // a population of one and would pass on a file where every model looked the same.
  assert.ok(sawNull, 'the catalog must contain a model with no reasoning control');
  assert.ok(sawValues, 'the catalog must contain a model with graded reasoning');
});

test('an empty reasoningEffort list is normalised to null rather than carried', async () => {
  const file = await withCatalog((raw) => { raw.providers[0].models[0].reasoningEffort = []; });
  const catalog = await loadProviderCatalog({ file, reload: true });
  assert.equal(catalog.providers[0].models[0].reasoningEffort, null,
    'an empty list would read as "supported, with no valid values", which is not a state');
});

test('only the two local-auth providers need no key, and ollama says its list is a suggestion', async () => {
  const catalog = await loadProviderCatalog();
  const keyless = new Set(['ollama', 'claude-code']);
  for (const provider of catalog.providers) {
    assert.equal(provider.keyRequired, !keyless.has(provider.id),
      `${provider.id}: only local auth (a local endpoint, or the owner's own CLI login) can have no credential to point at`);
  }
  // The one place the catalog knowingly disagrees with reality: ollama's real models are
  // whatever is installed, which is locally knowable and deliberately not read here. The
  // note is the disclosure, and a client rendering the list without it makes a claim the
  // file itself refuses to make.
  const ollama = catalog.providers.find((p) => p.id === 'ollama');
  assert.ok(ollama.note, 'ollama must disclose that its list is a suggestion');
  assert.match(ollama.note, /SUGGESTIONS, NOT AN INVENTORY/);
});

test('the catalog is a local file read: it works with the network unavailable', async () => {
  // The zero-spend property, tested by DENYING THE NETWORK rather than by reading the
  // source for the absence of fetch. A source-text assertion would match its own comment,
  // which is a mistake this suite has made before.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('providerCatalog must not touch the network'); };
  try {
    const catalog = await loadProviderCatalog({ file: CATALOG_FILE, reload: true });
    assert.ok(catalog.providers.length >= 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- the validator ------------------------------------------------------------------

test('the set-time check refuses ONLY what cannot be made to work later', async () => {
  // A never-configured role.
  assert.equal(await checkRoleProvider({ provider: null, model: null, reasoningEffort: null }), null);

  // A model with no provider is ACCEPTED, and this is a deliberate reversal of my first
  // version. Three reasons, none of them "a test was in the way":
  //   rolePing is not implemented, so NOTHING routes on these fields yet and a refusal
  //   would be enforcing a router that does not exist;
  //   it is the shape existing configurations are already stored in;
  //   and it is recoverable, since setting a provider later completes it.
  // A set-time refusal is for what cannot work, not for what is incomplete.
  assert.equal(await checkRoleProvider({ provider: null, model: 'gpt-5', reasoningEffort: null }), null);
  assert.equal(await checkRoleProvider({ provider: null, model: null, reasoningEffort: 'high' }), null);
});

test('an unknown provider is refused BY NAME and the message lists the real ones', async () => {
  const reason = await checkRoleProvider({ provider: 'openai-compatible', model: null, reasoningEffort: null });
  assert.match(reason, /unknown provider openai-compatible/);
  assert.match(reason, /anthropic/);
  assert.match(reason, /ollama/);
});

test('an unknown model is DESCRIBED, never refused, and the catalog is named as the suspect', async () => {
  // The catalog calls itself a starting point rather than a registry, so refusing a model
  // for being absent would make the file authoritative over a fact it disclaims, and would
  // block an owner from using a model that shipped this morning until someone edits JSON.
  assert.equal(await checkRoleProvider({ provider: 'openai', model: 'gpt-6-turbo', reasoningEffort: null }), null);

  const described = await describeRoleModel({ provider: 'openai', model: 'gpt-6-turbo' });
  assert.equal(described.modelKnown, false);
  assert.match(described.modelReason, /gpt-6-turbo is not in the catalog/);
  // It will still be used. The sentence has to say so, or a settings screen renders this
  // as a broken role and the owner goes looking for a fault that is not there.
  assert.match(described.modelReason, /still be used as written/);
  assert.match(described.modelReason, /providers\.json may simply be out of date/);
});

test('modelKnown uses the same three states as keyResolvable', async () => {
  const catalog = await loadProviderCatalog();
  const known = catalog.providers[0].models[0];
  assert.deepEqual(await describeRoleModel({ provider: catalog.providers[0].id, model: known.id }),
    { modelKnown: true, modelReason: null });
  // NULL, not false, for never-configured: "no model set" and "model set and unrecognised"
  // are different claims, and a screen that renders both as a warning is lying about one.
  assert.deepEqual(await describeRoleModel({ provider: null, model: null }),
    { modelKnown: null, modelReason: null });
  assert.deepEqual(await describeRoleModel({ provider: catalog.providers[0].id, model: null }),
    { modelKnown: null, modelReason: null });
});

test('a reasoning effort is refused only when a KNOWN model contradicts it', async () => {
  // The boundary of the refusal: an unknown model cannot contradict anything, because we
  // do not know what it supports, and guessing would refuse valid configurations.
  assert.equal(await checkRoleProvider({ provider: 'openai', model: 'gpt-6-turbo', reasoningEffort: 'high' }), null);
});

test('a reasoning effort on a model that has no such control is refused, not dropped', async () => {
  const catalog = await loadProviderCatalog();
  const provider = catalog.providers.find((p) => p.models.some((m) => m.reasoningEffort === null));
  const model = provider.models.find((m) => m.reasoningEffort === null);
  const reason = await checkRoleProvider({ provider: provider.id, model: model.id, reasoningEffort: 'high' });
  assert.match(reason, /no reasoning effort control/);
  // Silently dropping it would leave the settings screen showing a value the engine is
  // not using, which is the exact defect this batch exists to close.
});

test('a reasoning effort outside the accepted values is refused and the values are named', async () => {
  const catalog = await loadProviderCatalog();
  const provider = catalog.providers.find((p) => p.models.some((m) => m.reasoningEffort));
  const model = provider.models.find((m) => m.reasoningEffort);
  const reason = await checkRoleProvider({ provider: provider.id, model: model.id, reasoningEffort: 'extreme' });
  assert.match(reason, /accepts reasoning effort/);
  for (const value of model.reasoningEffort) assert.ok(reason.includes(value));
});

test('every model in the catalog validates against its own catalog', async () => {
  // The sweep that makes the four refusals above meaningful: a validator that refused
  // everything would pass each of them. This is the positive control.
  const catalog = await loadProviderCatalog();
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      assert.equal(await checkRoleProvider({ provider: provider.id, model: model.id, reasoningEffort: null }), null,
        `${provider.id}/${model.id} must validate`);
      for (const effort of model.reasoningEffort || []) {
        assert.equal(await checkRoleProvider({ provider: provider.id, model: model.id, reasoningEffort: effort }), null,
          `${provider.id}/${model.id} must accept its own declared effort ${effort}`);
      }
    }
  }
});
