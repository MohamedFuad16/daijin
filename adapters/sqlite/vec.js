// sqlite-vec binding for the brain's semantic arm.
//
// vec0 owns the vectors and nothing else: chunk_id plus the embedding, cosine metric.
// Filters (types, areas, documentIds) are deliberately NOT vec0 metadata columns, for
// two measured reasons: metadata columns reject NULL (area is nullable in the Store
// contract), and their constraint support varies by sqlite-vec version. Filtering
// instead happens by joining the chunk table, with an over-fetch loop in sqlite.js, so
// the filter semantics are identical on both Store implementations.
//
// The contract asks semanticQuery for "raw cosine scores, descending". vec0's cosine
// distance is 1 - cosine similarity, so cosineFromDistance is an identity conversion and
// not an approximation.
//
// Corrected 2026-08-29: this header used to add "store-conformance asserts it against a
// JS-computed cosine". It does not. store-conformance.test.js defines its own local
// cosine() and asserts the SQL expression sqlite.js inlines (1 - v.distance), which is a
// different arm of code; cosineFromDistance itself has no call site in the repo. The
// identity above is measured (vec0 cosine distance matches a JS cosine to 1.4e-8 on a
// scaled-vector fixture), but this FUNCTION was never the thing under test.

/** Dimension ceiling guard. sqlite-vec accepts far more; this catches a wrong argument. */
const MAX_DIMENSION = 65_536;

/** DDL for the vector table. Dimension is fixed at create time, hence the identity assert. */
export function createVecTableSql(table, dimension) {
  assertDimension(dimension);
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(`
    + `chunk_id TEXT PRIMARY KEY, embedding float[${dimension}] distance_metric=cosine)`;
}

export function assertDimension(dimension) {
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > MAX_DIMENSION) {
    throw new Error(`Embedding dimension must be an integer between 1 and ${MAX_DIMENSION}; received ${dimension}.`);
  }
}

/** Coerce a contract vector (Float32Array or number[]) into the blob sqlite-vec binds. */
export function toFloat32(vector, dimension) {
  const typed = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  if (dimension !== undefined && typed.length !== dimension) {
    throw new Error(`Vector dimension ${typed.length} does not match the index dimension ${dimension}.`);
  }
  for (const value of typed) {
    if (!Number.isFinite(value)) throw new Error('Vector contains a non finite value; refusing to index it.');
  }
  return typed;
}

/** Read a vec0 embedding blob back as a Float32Array copy. */
export function decodeEmbedding(blob) {
  if (blob === null || blob === undefined) return null;
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/** vec0 cosine distance to raw cosine similarity. */
export function cosineFromDistance(distance) {
  // vec0 returns a NULL distance rather than an error when a stored vector has zero
  // magnitude, because cosine is undefined there. In JavaScript `1 - null` is 1, so an
  // unguarded conversion turns "this row has no comparable distance" into a PERFECT
  // similarity, and the row outranks every real match instead of being reported. The
  // absent distance has to be louder than the best possible score, not equal to it.
  if (typeof distance !== 'number' || !Number.isFinite(distance)) {
    throw new Error(`Cosine distance must be a finite number; received ${distance}.`);
  }
  return 1 - distance;
}

/** Reference cosine, used by the conformance suite to check the stored scores. */
export function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
