// Adapter barrel. The engine imports from here so a backend swap is one file.

export { brainDatabasePath, openDatabase, engineVersions } from './sqlite/database.js';
export {
  FTS5_TOKENIZE,
  LEXICAL_TOP_K,
  STOPWORDS,
  buildMatchExpression,
  bm25Expression,
  createFtsTableSql,
  lexicalScore,
  matchTokens,
} from './sqlite/fts5.js';
export {
  assertDimension,
  cosineFromDistance,
  cosineSimilarity,
  createVecTableSql,
  decodeEmbedding,
  toFloat32,
} from './sqlite/vec.js';
export { createOllamaClient, OLLAMA_DOWN } from './ollama/client.js';
