// Cross-encoder reranking: an OPTIONAL re-scoring of the fused candidate list.
//
// D-0025. Verified absent before it was written: ranking here is bi-encoder arms (bge-m3),
// RRF fusion, a raw-cosine champion and pins. A cross-encoder is a different instrument:
// the bi-encoder embeds query and document separately and compares vectors, so it never
// sees the pair; a cross-encoder reads them TOGETHER and scores the relationship. That is
// why it is more accurate and far more expensive, and why it belongs on a shortlist rather
// than on a corpus.
//
// THREE CONSTRAINTS THAT ARE NOT NEGOTIABLE, from the ruling:
//
//  1. OFF BY DEFAULT. It becomes a default only on a measured gold-set win, judged per
//     D-0017: case rate and violations enforced, MRR reported as movement.
//  2. ABSENT FROM THE PARITY PATH. P1's byte-for-byte claim must survive untouched, so a
//     parity store never reranks, and that is asserted rather than trusted.
//  3. LOCAL ONLY. Nothing in the retrieval path calls a paid API (ADR-0139 lineage). The
//     backend seam takes a local reranker or nothing.
//
// WHERE IT SITS: after fusion, before the budget. Fusion decides the ORDER of the candidate
// pool; the budget decides which of that order gets funded. Reranking between them changes
// which candidates the budget sees first, which is the only place it can help.

/// The knob's shape. `topK` is the shortlist depth: a cross-encoder over the whole pool
/// would cost a forward pass per candidate, and the pool is 256+.
export const DEFAULT_RERANK = Object.freeze({ enabled: false, topK: 40 });

export function normalizeRerankOptions(options) {
  if (!options) return { ...DEFAULT_RERANK };
  const enabled = options.enabled === true;
  const topK = Number(options.topK ?? DEFAULT_RERANK.topK);
  if (!Number.isInteger(topK) || topK < 1 || topK > 200) {
    throw new Error('rerank.topK must be an integer from 1 to 200.');
  }
  return { enabled, topK };
}

/**
 * Reorder rows by rerank score, preserving the score DISTRIBUTION.
 *
 * The same trick fusion uses, and for the same reason: downstream ranking is full of
 * absolute thresholds calibrated against cosine similarity (the 0.35 pin floor, the 0.55
 * reserved-slot floor). A raw cross-encoder score is on an unrelated scale, often a logit,
 * and writing it into `score` would silently fail every one of those thresholds. So the
 * rerank decides the ORDER and the original cosine distribution is re-laid over it: the row
 * in reranked position i receives the i-th largest cosine from the pool.
 *
 * `semanticSimilarity` is left alone, because it is the raw evidence the reserved-semantic
 * slot selects its champion on, and a champion chosen on a rescaled number is the exact
 * defect ADR-0158 fixed.
 *
 * Pure, so the ordering is testable without a model.
 */
export function applyRerankOrder(rows, scoreById) {
  if (rows.length === 0) return rows;
  const distribution = [...rows].map((row) => Number(row.score)).sort((left, right) => right - left);

  const ordered = [...rows].sort((left, right) => {
    const leftScore = scoreById.get(String(left.chunk_id));
    const rightScore = scoreById.get(String(right.chunk_id));
    // A row the reranker did not score keeps its fused position relative to other unscored
    // rows and sorts below every scored one: absent is not the same as scored zero.
    if (leftScore === undefined && rightScore === undefined) return left.fusedRank - right.fusedRank;
    if (leftScore === undefined) return 1;
    if (rightScore === undefined) return -1;
    return rightScore - leftScore
      || Number(right.score) - Number(left.score)
      || String(left.chunk_id).localeCompare(String(right.chunk_id));
  });

  return ordered.map((row, index) => ({
    ...row,
    score: distribution[index],
    rerankScore: scoreById.get(String(row.chunk_id)) ?? null,
    rerankRank: index + 1,
  }));
}

/**
 * Rerank the top of a fused list with a local cross-encoder.
 *
 * Only the shortlist is scored and only the shortlist is reordered; the tail keeps its
 * fused order and sits below. Reranking the whole pool would be a forward pass per
 * candidate for candidates the budget was never going to fund.
 *
 * Returns the latency it cost, because the knob has to display it: a stage whose price is
 * invisible gets enabled by people who would not have paid it.
 */
export async function rerankFusedRows({
  query, rows, reranker, topK = DEFAULT_RERANK.topK, now = () => performance.now(),
}) {
  if (!reranker) throw new Error('rerankFusedRows requires a reranker backend.');
  if (rows.length === 0) return { rows, latencyMs: 0, scored: 0, backend: reranker.id ?? null };

  const shortlist = rows.slice(0, topK);
  const started = now();
  const scores = await reranker.rerank(query, shortlist.map((row) => row.chunk_content ?? ''));
  const latencyMs = Math.round(now() - started);

  if (!Array.isArray(scores) || scores.length !== shortlist.length) {
    // The same alignment discipline the embedder carries: a response one short would shift
    // every later document onto its neighbour's score, silently and wrongly.
    throw new Error(`Reranker returned ${Array.isArray(scores) ? scores.length : 'no'} scores for ${shortlist.length} document(s); refusing to reorder on a misaligned response.`);
  }

  const scoreById = new Map(shortlist.map((row, index) => [String(row.chunk_id), Number(scores[index])]));
  const reordered = applyRerankOrder(shortlist, scoreById);
  return {
    rows: [...reordered, ...rows.slice(topK)],
    latencyMs,
    scored: shortlist.length,
    backend: reranker.id ?? null,
  };
}

/// A parity store must never rerank. Asserted rather than trusted, because "it is off by
/// default" is a claim about configuration and this is a claim about the code.
export function assertRerankAllowed(store) {
  if (store?.parityMode) {
    throw new Error('Refusing to rerank on a parity-mode store: the P1 byte-for-byte claim is measured through this path and reranking it would silently change what it measures.');
  }
}
