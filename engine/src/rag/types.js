// The Brain unit vocabulary, in ONE place.
//
// The platform repeats these eight strings in four files (rag/retrieve.js,
// ingest/chunk.js, mcp/tools.js, ingest/documents.js); the extraction report calls that
// duplication out (section 1e) as the one thing that must change when the vocabulary
// travels. The vocabulary itself is generic and ships as the product's schema.

export const ALLOWED_TYPES = Object.freeze([
  'decision', 'lesson', 'exemplar', 'convention', 'principle', 'evaluation', 'architecture', 'workflow',
]);

export const ALLOWED_TYPE_SET = new Set(ALLOWED_TYPES);

// Chunking policy per type: atomic units embed whole, windowed units are split.
export const ATOMIC_TYPES = new Set(['decision', 'lesson', 'exemplar', 'convention', 'principle', 'evaluation']);
export const WINDOWED_TYPES = new Set(['architecture', 'workflow']);

// Types held back from an unfiltered retrieval.
//
// Evaluations are grading records, one per exam run, and they are the single largest
// class of unit in a mature Brain (145 of 332 when the platform measured it, and one
// more every run). Left in the default pool they crowd ADRs and lessons out of a coding
// task's context budget with the system's own report cards, which is the context
// distraction failure: the model attends to a growing history instead of the knowledge
// it needs. They remain fully retrievable (any caller passing `types: ['evaluation']`
// still gets them) but a task that asks a general question no longer pays for them.
export const DEFAULT_EXCLUDED_TYPES = Object.freeze(['evaluation']);

// The structural bucket a unit type lands in, and the priority a pinned unit of that
// bucket carries. These numbers are the surviving end of a measured experiment and
// travel with the code; they are not user configuration.
export const TYPE_BUCKETS = Object.freeze({ decision: 'decisions', lesson: 'lessons', exemplar: 'exemplars' });
export const BUCKET_PRIORITY = Object.freeze({ decisions: 0.5, lessons: 0.35, chunks: 0.75, exemplars: 0 });
