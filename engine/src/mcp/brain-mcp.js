#!/usr/bin/env node
// stdio entry point. Anything written to stdout that is not MCP framing corrupts the
// protocol, so the console channels are redirected BEFORE the server module is loaded.
// The imports below are dynamic for exactly that reason: static imports hoist and would
// evaluate the server before this redirect is in place.
for (const method of ['log', 'info', 'debug']) {
  console[method] = (...argumentsList) => console.error(...argumentsList);
}

const path = (await import('node:path')).default;
const { loadCorpus, loadCorpusEnvironment } = await import('../init/corpus.js');
const { retrieve } = await import('../rag/retrieve.js');
const { createPgVectorStore } = await import('../store/pgvector.js');
const { startBrainServer } = await import('./server.js');

function argument(flag) {
  const found = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  return found ? found.slice(flag.length + 1) : null;
}

async function main() {
  const corpusFile = argument('--corpus-file');
  if (!corpusFile) throw new Error('brain-mcp requires --corpus-file=<descriptor.json>.');
  const corpus = await loadCorpus(corpusFile);
  const { databaseUrl, environment } = loadCorpusEnvironment(corpus);
  const store = createPgVectorStore({ connectionString: databaseUrl, applicationName: 'daijin-brain-mcp' });
  const brainRoot = argument('--brain-root') || path.join(corpus.root, 'ai-brain');
  const stateRoot = argument('--state-root') || process.cwd();
  await startBrainServer({
    brainRoot,
    stateRoot,
    engineerRulesPath: argument('--engineer-rules') || null,
    retrieve: (input) => retrieve({ project: corpus.project, ...input }, {
      store,
      environment,
      pathGrammar: corpus.pathGrammar,
      standingPrefix: corpus.standingPrefix,
    }),
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
