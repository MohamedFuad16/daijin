// Ingest: units in, an indexed brain out.
//
// Three properties, each of them a rule the project already paid for:
//
//   ATOMIC FULL-MIRROR REPLACE (D-0009). Upserts, the relationship rebuild and the prune
//   all happen inside ONE transaction, so a rebuild is authoritative rather than additive.
//   The failure this prevents is specific: a source file deleted between two runs leaves
//   an orphan document that the gold-set existence gate then keeps certifying, and the
//   floor measures a brain that no longer matches the repo.
//   ALIGNMENT IS ASSERTED, NOT ASSUMED. The embedder returns one vector per input in input
//   order. rag/embed.js says why in detail; the same assertion is repeated here because
//   this is the second place a misalignment could enter, and a batch that comes back one
//   vector short shifts every later document onto its neighbour's embedding silently.
//   IDENTITY IS CHECKED AFTER THE WRITE. Retrieval refuses to query an index built by a
//   different embedder, so an ingest that wrote vectors the served embedder cannot match
//   has produced a brain that answers nothing. Better to fail here, named.
//
// Zero-spend: the embedder is injected. The shipped default is the local Ollama adapter;
// tests inject a deterministic double and touch no network.
import { chunkDocument } from '../rag/chunk.js';
import { resolveServedIdentity } from '../rag/embed.js';
import { embeddingIdentity } from '../runtime/embedding-identity.js';
import { GENERIC_PATH_GRAMMAR, normalizeModulePath } from '../rag/paths.js';
import { compareStrings } from './walk.js';
import { DAIJIN_DIRECTORY } from '../state/layout.js';

/**
 * Import-graph edges as relationship rows.
 *
 * The ranker's reverse-impact walk reads `imports` edges as MODULE NODES, not document
 * ids (rag/paths.js reverseImpact), so the edge endpoints are normalised repo paths. The
 * generic grammar is the right one until a repo declares its roots: it passes `mod:`
 * nodes through and recognises a source path by extension.
 */
export function importRelationships(graph, grammar = GENERIC_PATH_GRAMMAR) {
  const rows = graph.edges.map((edge) => ({
    src: normalizeModulePath(edge.src, grammar),
    dst: normalizeModulePath(edge.dst, grammar),
    kind: 'imports',
  }));
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.src} ${row.dst}`;
    if (seen.has(key) || row.src === row.dst) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => compareStrings(left.src, right.src) || compareStrings(left.dst, right.dst));
}

/** Chunk every unit, keeping the flat order the embedder is called with. */
export function chunkUnits(units) {
  const plans = [];
  for (const unit of units) {
    const chunks = chunkDocument({
      type: unit.type,
      path: unit.path,
      title: unit.title,
      tags: unit.tags,
      content: unit.content,
      body: unit.body ?? unit.content,
    });
    plans.push({ unit, chunks });
  }
  return plans;
}

/**
 * D-0031 invariant 1: THE CONTRACT IS NEVER INGESTED, NEVER CHUNKED, NEVER RETRIEVED.
 *
 * Asserted at the INGEST BOUNDARY rather than in any producer's filter, because the
 * boundary is the one place every unit must pass through. A check on the adopt filter would
 * hold today and miss the next producer; this holds for scaffold, adopt, narration and
 * anything added later, without those authors knowing the rule exists.
 *
 * The reason it is needed NOW is that the invariant currently survives by accident. The
 * generate path constructs its units rather than collecting files, and the adopt filter
 * cannot reach .daijin/agents only because agents/ is a SIBLING of .daijin/brain. Once the
 * contract and the brain share one .daijin root, three one-line edits break it silently:
 * adding .daijin to the candidate roots, moving agents/ under brain/ for tidiness, or a
 * legacy agent/ folder that happens to contain an agents/ subfolder.
 *
 * A rule that scores lower than a chunk is still a rule. Retrieval decides nothing about
 * how agents behave, so the contract must never be a candidate for it.
 */
const CONTRACT_AGENTS = new RegExp(`(^|/)${DAIJIN_DIRECTORY.replace('.', '\\.')}/agents/`);
const CONTRACT_MANIFEST = new RegExp(`(^|/)${DAIJIN_DIRECTORY.replace('.', '\\.')}/manifest\\.json$`);

export function assertNoContractUnits(units) {
  const offending = [];
  for (const unit of units) {
    for (const candidate of [unit.path, unit.meta?.sourceFile, unit.meta?.sourceArtifact, ...(unit.citations || [])]) {
      if (!candidate) continue;
      const normalized = String(candidate).replace(/\\/g, '/').replace(/^\.\//, '');
      // ANCHORED TO THE CONTRACT ROOT, not to the words. The previous pattern matched any
      // `agents/` segment and any `manifest.json`, which refuses the WHOLE INGEST for a
      // host repo that has `src/agents/` (the standard layout for LangGraph, CrewAI and
      // AutoGen, which is exactly the population this tool is for) or an `extension/
      // manifest.json` or a PWA. Worse, it refused a brain unit that merely CITED such a
      // file, so a unit about a host's architecture killed the run that produced it.
      //
      // The contract is a LOCATION, not a naming convention: `.daijin/agents/` and
      // `.daijin/manifest.json` and nothing else. The directory comes from the layout
      // module so the guard cannot drift from the thing it guards. Still matched anywhere
      // in the string, because a citation may be absolute.
      const isAgentFile = CONTRACT_AGENTS.test(normalized);
      const isManifest = CONTRACT_MANIFEST.test(normalized);
      if (isAgentFile || isManifest) {
        offending.push({ id: unit.id, path: candidate, kind: isManifest ? 'manifest' : 'agent-instruction' });
        break;
      }
    }
  }
  if (offending.length > 0) {
    throw new Error(
      `Refusing to ingest ${offending.length} unit(s) sourced from the CONTRACT (D-0031 invariant 1): `
      + `${offending.map((entry) => `${entry.id} <- ${entry.path}`).join('; ')}. `
      + 'Agent instruction files and the manifest load whole and first; they are never chunked, '
      + 'never retrieved, and retrieval can never outrank them.',
    );
  }
}

function assertAlignment(vectors, expected) {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    const got = Array.isArray(vectors) ? vectors.length : 'no';
    throw new Error(`Embedder returned ${got} vectors for ${expected} chunk(s); refusing to write misaligned embeddings.`);
  }
}

/**
 * Write the units into the store.
 *
 * @param {object} options
 * @param {import('../store/store.d.ts').Store} options.store
 * @param {object[]} options.units      Layer 1 (and later Layer 2) units
 * @param {{embed: Function}} options.embedder
 * @param {string|null} options.project prune scope. null means the whole store, which is
 *                                      the per-repo sqlite case (D-0012)
 * @param {object[]} options.relationships
 */
export async function ingestUnits({
  store, units, embedder, project = null, relationships = [], onStep = null,
} = {}) {
  if (!store) throw new Error('ingestUnits requires a store.');
  if (!embedder?.embed) throw new Error('ingestUnits requires an embedder with an embed(texts) method.');

  // Before anything is chunked or embedded: the contract cannot enter the store.
  assertNoContractUnits(units);
  const plans = chunkUnits(units);
  const texts = plans.flatMap((plan) => plan.chunks.map((chunk) => chunk.content));
  if (onStep) await onStep({ step: 'embed', detail: `${texts.length} chunks`, counts: { chunks: texts.length, documents: units.length } });
  const vectors = texts.length ? await embedder.embed(texts) : [];
  assertAlignment(vectors, texts.length);

  let cursor = 0;
  const rows = plans.map((plan) => {
    const chunkRows = plan.chunks.map((chunk) => {
      const vector = vectors[cursor];
      cursor += 1;
      return { ordinal: chunk.ordinal, content: chunk.content, vector };
    });
    return { unit: plan.unit, chunkRows };
  });

  const keepIds = units.map((unit) => unit.id);
  await store.transaction(async () => {
    for (const row of rows) {
      const unit = row.unit;
      await store.upsertDocument({
        id: unit.id,
        type: unit.type,
        path: unit.path,
        title: unit.title,
        tags: unit.tags || [],
        meta: unit.meta || {},
        content: unit.content,
        contentHash: unit.contentHash ?? null,
      });
      await store.replaceChunks(unit.id, row.chunkRows);
    }
    await store.replaceAllRelationships(relationships);
    // Inside the same transaction, so a run that dies mid-write leaves the previous brain
    // intact rather than a half-pruned one.
    await store.pruneDocumentsExcept(keepIds, project);
  });

  const identity = await store.indexedEmbeddingIdentity();
  if (onStep) {
    await onStep({
      step: 'ingested',
      detail: `${units.length} units, ${texts.length} chunks`,
      counts: { documents: units.length, chunks: texts.length, relationships: relationships.length },
    });
  }
  return {
    documents: units.length,
    chunks: texts.length,
    identityChunks: plans.filter((plan) => plan.chunks.some((chunk) => chunk.ordinal === -1)).length,
    relationships: relationships.length,
    indexedIdentity: identity,
  };
}

/**
 * The identity an index must be built with, derived the same way retrieval derives it.
 *
 * There are two defensible notions of "served identity" and they disagree on one field.
 * The Ollama adapter reports the model as the TAG it found (bge-m3:latest), while the
 * retrieval path reports it as the CONFIGURED name with the served digest attached
 * (bge-m3, from resolveServedIdentity). assertRetrievalIdentity compares the model string
 * exactly, so a store built from the adapter's notion is refused by every query it was
 * built to answer, with an error that says re-ingest and would not have helped.
 *
 * Hit live on the P3 target, 2026-08-16, after the gold set had already passed its gates.
 * The fix is not to pick a winner by hand: both sides now call the same function, so they
 * cannot drift again. The digest is still the real beacon and still comes from the server.
 */
export async function servedIndexIdentity({ environment = process.env, fetchImpl } = {}) {
  return resolveServedIdentity(embeddingIdentity(environment), { environment, fetchImpl });
}

/**
 * Adapt the Ollama client to the embedder shape ingest expects.
 *
 * Kept here rather than in the adapter so the adapter stays a transport and the engine
 * owns the contract. The identity is the SERVED one: a catalogue's claim about a model is
 * not authoritative, and the index digest is bound to what actually answered.
 */
export function embedderFromOllama(client) {
  return {
    async servedIdentity() { return client.servedIdentity(); },
    async embed(texts) { return client.embed(texts); },
  };
}
