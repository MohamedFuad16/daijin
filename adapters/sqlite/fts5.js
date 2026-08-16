// FTS5 lexical adapter: the measured recipe, and a requirement rather than a suggestion.
//
// Measured on the platform gold set (docs/fts5-adapter-recipe.py, docs/fts5-report.json):
// tokenize='porter unicode61', stopword filtering before matching, whitespace tokens
// issued as quoted phrases joined by implicit AND, bm25 ranking, top 40. Against the
// Postgres 'english' ts_rank arm over the same 732 chunks the recipe scored 12 hits to
// 10 overall and 5/5 on identifier cases, and kept every document the Postgres arm found.
//
// Every element earns its place, so none of them is a knob:
//
// - porter: a query that says "ranks" must reach a chunk that says "ranking", the way the
//   Postgres 'english' configuration stems. unicode61 alone does no stemming at all.
// - stopword filter: websearch_to_tsquery drops stopwords before matching. FTS5 does not,
//   so a strict AND of every whitespace token would demand the literal "how" and "should"
//   inside the chunk and return nothing for most natural language queries.
// - quoted phrases: a bare token carrying punctuation (ADR-0040) or an operator-looking
//   token is FTS5 *syntax*, not a search term. Quoting turns each token into a phrase,
//   which is the faithful translation of websearch_to_tsquery's phrase-safe handling and
//   is also what keeps identifier queries such as fuseRankings from becoming a syntax
//   error. unicode61 does not split camelCase, so the identifier stays one token.
// - bm25 top 40: the ranking function and the candidate depth the measurement used. The
//   fusion stage downstream expects that depth.
//
// The stopword set below is copied verbatim from the measured script. It is a
// snowball-derived English subset, not the full 174 word snowball list; the subset is
// what produced the numbers above, so it is what ships.

/** Tokenizer clause for every FTS5 table in the brain. */
export const FTS5_TOKENIZE = 'porter unicode61';

/** Candidate depth the lexical arm was measured at. */
export const LEXICAL_TOP_K = 40;

/** Stopwords dropped before matching, verbatim from docs/fts5-adapter-recipe.py. */
export const STOPWORDS = new Set(
  `a an and are as at be by for from has have how i in is it its of on or
should that the this to was what when where which who why will with must does do not`
    .split(/\s+/)
    .filter(Boolean),
);

/** DDL for a chunk text index. Column order is part of the contract with sqlite.js. */
export function createFtsTableSql(table) {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5(`
    + `chunk_id UNINDEXED, text, tokenize='${FTS5_TOKENIZE}')`;
}

/** bm25 ranking expression. Lower is better, which is why callers negate it. */
export function bm25Expression(table) {
  return `bm25(${table})`;
}

/**
 * Normalize bm25 output to the Store contract's descending score.
 * SQLite returns bm25 as a negative number where more negative is a better match;
 * the contract wants "descending score", so the sign flips once, here.
 */
export function lexicalScore(bm25Value) {
  return -bm25Value;
}

function quotePhrase(token) {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build the FTS5 MATCH expression for a natural language query.
 * Returns null when the query carries no tokens at all, which callers treat as
 * "no lexical candidates" rather than as an error.
 */
export function buildMatchExpression(query) {
  const raw = String(query ?? '').split(/\s+/).filter(Boolean);
  if (raw.length === 0) return null;
  const kept = raw.filter((token) => !STOPWORDS.has(token.toLowerCase()));
  // An all-stopword query ("what is it") still deserves a search rather than an empty
  // result, so the filter falls back to the unfiltered tokens. Same rule as the script.
  const tokens = kept.length > 0 ? kept : raw;
  return tokens.map(quotePhrase).join(' ');
}

/** The tokens the match expression will actually search for. Exposed for tests and diagnostics. */
export function matchTokens(query) {
  const raw = String(query ?? '').split(/\s+/).filter(Boolean);
  const kept = raw.filter((token) => !STOPWORDS.has(token.toLowerCase()));
  return kept.length > 0 ? kept : raw;
}
