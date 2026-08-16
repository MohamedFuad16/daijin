#!/usr/bin/env node
// Serve ONE repo's brain over MCP, on stdio.
//
//   node engine/src/mcp/serve-repo.js <repoPath>
//
// This is the other end of what mcpSnippet pastes into a coding agent's config, and it
// closes the product loop: init builds the brain, the floor gates it, this serves it.
//
// Distinct from brain-mcp.js on purpose. That one is the P1-era entry: it takes a corpus
// DESCRIPTOR and opens Postgres, which is how the platform corpus is measured. A user's own
// repo has no descriptor and no Postgres; it has a sqlite brain at .daijin/brain.sqlite. The
// snippet used to point at brain-mcp.js and produced a config that exited immediately with
// "brain-mcp requires --corpus-file", which is a paste-ready config that pastes a failure.
//
// stdout is MCP framing and nothing else, so the console channels move to stderr before the
// server module is loaded. The imports are dynamic for that reason: static imports hoist and
// would evaluate the server before the redirect is in place.

for (const method of ['log', 'info', 'debug']) {
  console[method] = (...argumentsList) => console.error(...argumentsList);
}

const path = (await import('node:path')).default;
const { access } = await import('node:fs/promises');
const { servedIndexIdentity } = await import('../init/ingest.js');
const { retrieve } = await import('../rag/retrieve.js');
const { createSqliteStore, brainDatabasePath } = await import('../store/sqlite.js');
const { startBrainServer } = await import('./server.js');

function argument(flag, fallback = null) {
  const found = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  return found ? found.slice(flag.length + 1) : fallback;
}

/**
 * The environment retrieval reads its embedder identity from.
 *
 * Built from what the INDEX recorded, then resolved through the SAME function the retrieval
 * path uses, so the index identity and the query identity cannot drift. The adapter names a
 * model by the tag it found while retrieval names it by configuration, and
 * assertRetrievalIdentity compares the string exactly, so a mismatch here means every query
 * is refused by the index it was built to answer.
 */
async function embedderEnvironmentFor(store) {
  const identity = await store.indexedEmbeddingIdentity();
  if (!identity?.provider || !identity?.model) return null;
  const base = {
    EMBEDDING_PROVIDER: identity.provider,
    EMBEDDING_MODEL: identity.model,
    EMBEDDING_MODEL_DIGEST: identity.digest || '',
    EMBEDDING_DIM: String(identity.dimension || ''),
    ...(process.env.OLLAMA_BASE_URL ? { OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL } : {}),
  };
  try {
    const served = await servedIndexIdentity({ environment: base });
    return { ...base, EMBEDDING_MODEL_DIGEST: served.digest || base.EMBEDDING_MODEL_DIGEST };
  } catch {
    // The embedder being down is a runtime condition the tools report per call, not a
    // reason to refuse to start: an agent with a configured but unreachable brain should
    // get a clear failure when it searches, rather than a server that never came up.
    return base;
  }
}

async function main() {
  const repoPath = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : argument('--repo', process.cwd()));
  const brainRoot = argument('--brain-root', path.join(repoPath, '.daijin', 'brain'));

  // Fail EARLY and by name. An MCP server that starts against a repo with no brain answers
  // every search with an obscure error from three layers down, and the agent using it has
  // no way to learn that the brain was never built.
  const database = brainDatabasePath(repoPath);
  try {
    await access(database);
  } catch {
    throw new Error(`No brain at ${database}. Run init on ${repoPath} first; there is nothing to serve.`);
  }

  const store = await createSqliteStore({ repoPath, project: 'default' });
  const environment = await embedderEnvironmentFor(store);
  if (!environment) {
    await store.close?.();
    throw new Error(`The brain at ${database} records no embedder identity, so it has not been indexed. Run init on ${repoPath}.`);
  }

  const close = async () => {
    await store.close?.().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  await startBrainServer({
    name: 'daijin-brain',
    brainRoot,
    stateRoot: path.join(repoPath, '.daijin'),
    engineRulesPath: argument('--engineer-rules'),
    // Bound to this repo's store. The MCP tools take a project from the caller, so the
    // default is supplied here and a caller that names one still wins.
    retrieve: (input) => retrieve({ project: store.project, ...input }, { store, environment }),
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
