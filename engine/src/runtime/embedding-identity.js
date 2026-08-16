// Embedding identity. Lifted out of the platform's db/migrate.js so nothing in the
// retrieval path has to import a migration runner to learn which embedder is served.
//
// The identity is load bearing, not decoration: every absolute threshold downstream
// (the 0.35 semantic threshold, the 0.35 pin floor, the 0.55 reserved-slot floor) sits
// on one embedder's similarity distribution. Serving a different model against an index
// built by another produces no error and wrong answers, so the mismatch is refused.
import dotenv from 'dotenv';

export function parseEmbeddingDimension(raw) {
  if (!/^\d+$/.test(raw || '')) throw new Error('EMBEDDING_DIM must be a positive integer.');
  const dimension = Number(raw);
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 2000) {
    throw new Error('EMBEDDING_DIM must be between 1 and 2000 for pgvector HNSW indexes.');
  }
  return dimension;
}

export function embeddingIdentity(environment = process.env) {
  const provider = environment.EMBEDDING_PROVIDER?.trim();
  const model = environment.EMBEDDING_MODEL?.trim();
  const digest = environment.EMBEDDING_MODEL_DIGEST?.trim();
  const dimension = parseEmbeddingDimension(environment.EMBEDDING_DIM);
  if (!provider) throw new Error('EMBEDDING_PROVIDER is required.');
  if (!model) throw new Error('EMBEDDING_MODEL is required.');
  if (!digest) throw new Error('EMBEDDING_MODEL_DIGEST is required.');
  return { provider, model, digest, dimension };
}

/// Refuse to serve an index built by a different embedder than the one answering now.
export function assertRetrievalIdentity(indexed, served) {
  const matches = indexed?.indexed === true
    && ['provider', 'model', 'digest'].every((key) => indexed[key] === served[key])
    && Number(indexed.dimension) === served.dimension;
  if (!matches) throw new Error('Retrieval index identity differs from the currently served model; re-ingest the corpus.');
}

/// Load env files into process.env. Daijin reads its own config from the settings store;
/// this exists so the engine can measure a corpus whose configuration lives in a repo's
/// dotenv files (the platform corpus during extraction parity, for one).
export function loadEnvironmentFiles(files = []) {
  for (const file of files) dotenv.config({ path: file, quiet: true, override: false });
  return process.env;
}
