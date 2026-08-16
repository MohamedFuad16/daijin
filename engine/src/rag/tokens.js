// Query tokenization. The portable half of the platform's rag/query.js; the repo-shaped
// half (module path grammar) lives in paths.js.
//
// These tokens drive tag and title matching in the ranker and the curated-fix trigger
// overlap, so the stop word list and the length floor are ranking parameters, not
// cosmetics. Copied unchanged: any edit here moves the measured floor.

const STOP_WORDS = new Set([
  'about', 'and', 'are', 'did', 'does', 'for', 'from', 'how', 'into', 'the', 'this',
  'was', 'were', 'what', 'when', 'where', 'which', 'why', 'with', 'would', 'layer',
]);

export function queryTokens(query) {
  const values = query.toLocaleLowerCase('en').match(/[\p{L}\p{N}_-]+/gu) || [];
  return [...new Set(values.filter((value) => {
    const isCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
    return (isCjk || value.length >= 3) && !STOP_WORDS.has(value);
  }))];
}

/// Content tokenization, shared by the chunker and the token budget.
///
/// CJK characters count one token each; everything else is a word or a lone symbol.
/// The budget and the chunk windows must count the same way or a chunk that fits at
/// ingest time overflows at retrieval time.
export function tokens(text) {
  return text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+|[^\s]/gu) || [];
}

export { STOP_WORDS };
