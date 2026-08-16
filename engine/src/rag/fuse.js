// Reciprocal Rank Fusion. Lifted out of the platform's rag/retrieve.js, which is the
// first refactor the extraction report asks for (section 2a): the function is pure and
// totally portable and was trapped in a file that also opened a Postgres client.

/// Reciprocal Rank Fusion constant. 60 is the value from the original RRF paper and is
/// deliberately left alone: its whole appeal is that it needs no tuning.
export const RRF_K = 60;

/// Fuse the vector and lexical rankings into one order.
///
/// WHY RRF: the two arms produce incommensurable numbers, cosine similarity on one side
/// and a text rank on the other. Adding or weighting them means inventing an exchange
/// rate and then tuning it. RRF only needs each arm's RANK, so there is nothing to tune
/// and no scale to mismatch. That property is also what makes the storage swap survivable:
/// Postgres ts_rank and SQLite bm25 are different scoring functions, but RRF consumes only
/// the order they produce.
///
/// WHY THE RESCALE: downstream ranking is full of absolute thresholds calibrated against
/// cosine similarity, the structural pin floor of 0.35 chief among them. A raw RRF score
/// (about 0.016 at rank 1) would silently fail every one of them. So the fused ORDER is
/// applied while the original score DISTRIBUTION is preserved: the row in fused position i
/// receives the i-th largest cosine value from the pool. Ordering changes; the numbers
/// those thresholds see do not.
///
/// With no lexical matches every lexical rank is absent, RRF reduces to the cosine order,
/// and the output is identical to the vector only behaviour.
export function fuseRankings(rows, lexicalChunkIds = []) {
  if (rows.length === 0) return [];
  const lexicalRank = new Map(lexicalChunkIds.map((id, index) => [String(id), index + 1]));

  const byCosine = [...rows].sort((a, b) => Number(b.score) - Number(a.score)
    || String(a.chunk_id).localeCompare(String(b.chunk_id)));
  const semanticRank = new Map(byCosine.map((row, index) => [String(row.chunk_id), index + 1]));

  const scored = rows.map((row) => {
    const chunkId = String(row.chunk_id);
    const sem = semanticRank.get(chunkId);
    const lex = lexicalRank.get(chunkId);
    return {
      row,
      lexicalRank: lex ?? null,
      rrf: (sem ? 1 / (RRF_K + sem) : 0) + (lex ? 1 / (RRF_K + lex) : 0),
    };
  });

  // Ties broken by cosine, then chunk id: identical input must always produce identical
  // output, which is the property the ranker's determinism rests on.
  scored.sort((a, b) => b.rrf - a.rrf
    || Number(b.row.score) - Number(a.row.score)
    || String(a.row.chunk_id).localeCompare(String(b.row.chunk_id)));

  const distribution = byCosine.map((row) => Number(row.score));
  return scored.map((entry, index) => ({
    ...entry.row,
    score: distribution[index],
    semanticSimilarity: Number(entry.row.score),
    lexicalRank: entry.lexicalRank,
    fusedRank: index + 1,
  }));
}
