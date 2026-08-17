// The provider and model catalog, loaded from engine/config/providers.json.
//
// A COMMITTED DATA FILE RATHER THAN A LITERAL, so the owner corrects a stale model
// identifier with a one-line edit instead of a code change. Model lists go stale faster
// than this repository is touched, and a catalog that needs a developer to fix is a
// catalog that stays wrong.
//
// ZERO SPEND, AND UNPROBEABLE BY CONSTRUCTION: this module reads one local file and has
// no fetch, no client, and no network dependency to inject. Listing a provider's models
// over its API would be a paid call on some providers and an authenticated one on all of
// them, and a settings screen that spends money to render is not a settings screen.
// Verifying that a model and key actually work stays rolePing, which is spend-touching
// and fires only when a user asks for it per call.
//
// THE ENUM IS DERIVED FROM THE FILE rather than declared beside it. A hand-maintained
// list of valid provider ids next to a hand-maintained file of providers is two copies of
// one fact, and the second one goes stale silently: adding a provider to the JSON without
// adding it to the enum would produce a catalog offering a choice the validator refuses.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../config/providers.json');

let cached = null;

/**
 * The parsed catalog file.
 *
 * Cached because it is a constant on disk and settingsGet is called on every screen
 * paint. `reload` exists for tests rather than for callers.
 */
export async function loadProviderCatalog({ file = CATALOG_PATH, reload = false } = {}) {
  if (cached && !reload && file === CATALOG_PATH) return cached;
  const raw = await readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  const catalog = {
    version: parsed.version,
    providers: (parsed.providers || []).map((provider) => ({
      id: provider.id,
      label: provider.label,
      endpointDefault: provider.endpointDefault ?? null,
      keyRequired: Boolean(provider.keyRequired),
      // Carried to the wire because the ollama entry uses it to say that its model list is
      // a suggestion rather than an inventory, and a client that renders the list without
      // that sentence is making a claim the file explicitly disclaims.
      note: provider.note ?? null,
      models: (provider.models || []).map((model) => ({
        id: model.id,
        label: model.label,
        // Null, never an empty array. An empty array reads as "this model accepts a
        // reasoning effort, and the set of valid values is empty", which is not a thing.
        reasoningEffort: Array.isArray(model.reasoningEffort) && model.reasoningEffort.length
          ? [...model.reasoningEffort]
          : null,
        note: model.note ?? null,
      })),
    })),
  };
  if (file === CATALOG_PATH) cached = catalog;
  return catalog;
}

/** The closed set of provider ids, derived from the catalog so it cannot drift from it. */
export async function providerIds(options = {}) {
  const catalog = await loadProviderCatalog(options);
  return catalog.providers.map((provider) => provider.id);
}

/**
 * The set-time REFUSALS: the things that cannot be made to work later.
 *
 * Returns null when acceptable, or a reason. The line between this and describeRoleModel
 * below is the same one attach draws between a refusal and a warning, and it is drawn from
 * what the catalog claims about itself:
 *
 *   THE PROVIDER ENUM IS CLOSED, so an unknown provider is refused. It is five vendor ids,
 *   a typo in one is a silent misroute, and no edit to any data file makes `openai-compatable`
 *   into a provider.
 *
 *   THE MODEL LIST IS NOT CLOSED. The catalog says so in its own header: a starting point,
 *   not a registry. Refusing a model for being absent would make this file authoritative
 *   over a fact it explicitly disclaims, and would block an owner from configuring a model
 *   that shipped this morning until someone edits JSON. Unknown models are DESCRIBED
 *   instead, on the role row, so the settings screen can say "not in the catalog" without
 *   anyone being stopped.
 *
 * A reasoning effort is refused only when the model IS known and contradicts it, because
 * that is the only case where the contradiction is a fact rather than a guess.
 */
export async function checkRoleProvider({ provider, model, reasoningEffort }, options = {}) {
  if (provider === null || provider === undefined) return null;
  const catalog = await loadProviderCatalog(options);
  const entry = catalog.providers.find((candidate) => candidate.id === provider);
  if (!entry) {
    return `unknown provider ${provider}; the catalog offers ${catalog.providers.map((p) => p.id).join(', ')}`;
  }
  if (!model || !reasoningEffort) return null;
  const chosen = entry.models.find((candidate) => candidate.id === model);
  // An unknown model cannot contradict anything: we do not know what it supports.
  if (!chosen) return null;
  if (!chosen.reasoningEffort) {
    return `${provider} ${model} has no reasoning effort control, so it cannot be set to ${reasoningEffort}`;
  }
  if (!chosen.reasoningEffort.includes(reasoningEffort)) {
    return `${provider} ${model} accepts reasoning effort ${chosen.reasoningEffort.join(', ')}, not ${reasoningEffort}`;
  }
  return null;
}

/**
 * The ADVISORY half, rendered on the role row beside keyResolvable and keyReason.
 *
 * `modelKnown` is true, false, or null for "no model configured", the same three-state
 * encoding keyResolvable uses, and for the same reason: never-configured is a different
 * claim from configured-and-unrecognised.
 */
export async function describeRoleModel({ provider, model }, options = {}) {
  if (!provider || !model) return { modelKnown: null, modelReason: null };
  const catalog = await loadProviderCatalog(options);
  const entry = catalog.providers.find((candidate) => candidate.id === provider);
  if (!entry) return { modelKnown: null, modelReason: null };
  if (entry.models.some((candidate) => candidate.id === model)) {
    return { modelKnown: true, modelReason: null };
  }
  // Phrased so the CATALOG is the suspect, not the owner. The file is a starting point by
  // its own account, so a model it lacks is more likely a stale file than a wrong user.
  return {
    modelKnown: false,
    modelReason: `${model} is not in the catalog for ${provider}. It will still be used as written; engine/config/providers.json may simply be out of date.`,
  };
}
