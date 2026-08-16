// The ranker. Copied from the platform (platform/rag/rank.js), which the extraction
// report calls the most valuable single artifact in that repository: the reserved
// semantic slot allocation (ADR-0158), the per candidate cap ratio 0.22 (ADR-0156), the
// supersession component resolution, and the pin relevance rule requiring overlap >= 3
// (ADR-0150) are each the surviving end of a measured experiment, documented in place
// with the counterexample that produced it.
//
// Changes here move the measured floor. The only edits from the platform copy are the
// import paths and the bucket tables moving to types.js.
import { queryTokens, tokens } from './tokens.js';
import { BUCKET_PRIORITY, TYPE_BUCKETS } from './types.js';

export const DEFAULT_SEMANTIC_THRESHOLD = 0.35;
export const DEFAULT_STRUCTURAL_PIN_FLOOR = 0.35;

function normalizeTags(tags = []) {
  return new Set(tags.map((tag) => String(tag).toLocaleLowerCase('en')));
}

function documentMatch(document, terms) {
  const tags = normalizeTags(document.tags);
  const title = (document.title || '').toLocaleLowerCase('en');
  let tagMatches = 0;
  let titleMatches = 0;
  for (const term of terms) {
    if (tags.has(term)) tagMatches += 1;
    if (title.includes(term)) titleMatches += 1;
  }
  return { tagMatches, titleMatches, score: tagMatches * 4 + titleMatches * 2 };
}

// One semantic entry per document. 'max' (the shipped default) takes the best chunk and
// ignores every other window, which is exactly the chunk dilution failure the 2026-08-14
// diagnosis isolated: all four systematically missed gold targets are 4 to 12 chunk
// architecture documents whose identity is smeared across windows, so no single window
// beats an atomic document's whole content similarity. 'max-support' adds a small bounded
// bonus per additional chunk above supportFloor: five moderately relevant windows are
// evidence about the DOCUMENT that one strong window cannot see. The bonus is capped so a
// 50 chunk document cannot win by having 50 chances, and small because downstream
// thresholds (semanticHit and the 0.35 pin floor) are calibrated on raw cosine scores.
export function semanticByDocument(rows, aggregation = { mode: 'max' }) {
  const byDocument = new Map();
  for (const row of rows) {
    const score = Number(row.score);
    const prior = byDocument.get(row.id);
    // The fused pipeline reorders rows and rescales `score` onto the semantic
    // distribution, but every row keeps its pre fusion cosine in `semanticSimilarity`.
    // Both are tracked: thresholds calibrated on the rescaled numbers keep seeing them,
    // while the reserved slot champion can be selected on raw semantic evidence.
    const raw = row.semanticSimilarity === undefined ? score : Number(row.semanticSimilarity);
    if (!prior) {
      byDocument.set(row.id, {
        chunkId: row.chunk_id,
        ordinal: row.ordinal,
        chunkContent: row.chunk_content,
        semanticScore: score,
        rawSemanticScore: raw,
        chunkScores: [score],
      });
      continue;
    }
    prior.chunkScores.push(score);
    prior.rawSemanticScore = Math.max(prior.rawSemanticScore, raw);
    if (score > prior.semanticScore) {
      prior.chunkId = row.chunk_id;
      prior.ordinal = row.ordinal;
      prior.chunkContent = row.chunk_content;
      prior.semanticScore = score;
    }
  }
  if (aggregation.mode === 'max-support') {
    const perExtra = Number(aggregation.perExtra ?? 0.02);
    const maxBonus = Number(aggregation.maxBonus ?? 0.06);
    const supportFloor = Number(aggregation.supportFloor ?? 0.3);
    for (const entry of byDocument.values()) {
      const supporters = entry.chunkScores.filter((score) => score >= supportFloor).length - 1;
      if (supporters > 0) {
        entry.supportBonus = Math.min(maxBonus, perExtra * supporters);
        entry.semanticScore = entry.semanticScore + entry.supportBonus;
      }
    }
  }
  return byDocument;
}

export function supersessionComponent(id, relationships) {
  const edges = relationships
    .filter((edge) => edge.kind === 'supersedes')
    .map((edge) => ({ src: edge.src.replace(/^doc:/, ''), dst: edge.dst.replace(/^doc:/, '') }));
  const newer = new Map();
  const older = new Map();
  for (const edge of edges) {
    newer.set(edge.dst, [...(newer.get(edge.dst) || []), edge.src]);
    older.set(edge.src, [...(older.get(edge.src) || []), edge.dst]);
  }
  const component = new Set([id]);
  const queue = [id];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const adjacent of [...(newer.get(node) || []), ...(older.get(node) || [])]) {
      if (!component.has(adjacent)) {
        component.add(adjacent);
        queue.push(adjacent);
      }
    }
  }
  const currentIds = [...component].filter((node) => !(newer.get(node)?.some((candidate) => component.has(candidate))));
  return { currentIds, supersededIds: [...component].filter((node) => !currentIds.includes(node)) };
}

function asCandidate(document, semantic, match, reason, bucket = null, structuralPinFloor = DEFAULT_STRUCTURAL_PIN_FLOOR) {
  const area = document.meta?.area || null;
  const structural = Boolean(reason);
  const semanticScore = semantic?.semanticScore ?? null;
  const rawSemanticScore = semantic?.rawSemanticScore ?? null;
  const pinEligible = structural && semanticScore !== null && semanticScore >= structuralPinFloor;
  const resolvedBucket = bucket || (TYPE_BUCKETS[document.type] || 'chunks');
  const structuralPriority = BUCKET_PRIORITY[resolvedBucket] || 0;
  return {
    id: document.id,
    type: document.type,
    title: document.title,
    path: document.path,
    area,
    tags: document.tags || [],
    content: document.type === 'architecture' && semantic?.chunkContent
      ? semantic.chunkContent
      : document.content,
    chunkId: semantic?.chunkId || null,
    ordinal: semantic?.ordinal ?? null,
    semanticScore,
    rawSemanticScore,
    structuralScore: match?.score || 0,
    pinEligible,
    score: pinEligible
      ? 2 + structuralPriority + (match?.score || 0) / 10 + (semantic?.semanticScore || 0)
      : semantic?.semanticScore || 0,
    reasons: [reason, semantic ? 'semantic' : null].filter(Boolean),
    bucket: resolvedBucket,
  };
}

function mergeCandidate(target, candidate) {
  const prior = target.get(candidate.id);
  if (!prior || candidate.score > prior.score || candidate.current) {
    candidate.score = Math.max(candidate.score, prior?.score || 0);
    candidate.reasons = [...new Set([...(prior?.reasons || []), ...candidate.reasons])];
    target.set(candidate.id, candidate);
  }
  else prior.reasons = [...new Set([...prior.reasons, ...candidate.reasons])];
}

function truncateToBudget(content, budget) {
  if (tokens(content).length <= budget) return content;
  const matches = [...content.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+|[^\s]/gu)];
  const keep = Math.max(1, budget - 4);
  const boundary = matches[Math.min(keep, matches.length) - 1];
  return `${content.slice(0, boundary.index + boundary[0].length)}\n[truncated]`;
}

function applyBudget(candidates, k, tokenBudget, perCandidateCapRatio = 0.22) {
  const selected = [];
  let used = 0;
  let truncated = false;
  // 0.22 shipped 2026-08-14 (ADR-0156). 0.4 held from Phase 4 until the content survival
  // instrument could answer what presence alone cannot: whether a tighter cap beheads the
  // decision a chunk exists to convey. Measured: 0.22 raises the case rate from 79.4% to
  // 82.3% (breadth, more documents fit the fixed budget) with 100% survival of every
  // instrumented decision bearing core; 0.12 adds truncations (6 to 16) for zero further
  // presence gain, and 0.05 collapses survival to 61.5%, so 0.22 is the knee, not the
  // smallest value that passes today's test.
  const perCandidateCap = Math.max(64, Math.floor(tokenBudget * perCandidateCapRatio));
  for (const candidate of candidates) {
    if (selected.length >= k || used >= tokenBudget) break;
    const count = tokens(candidate.content).length;
    const remaining = tokenBudget - used;
    const allowance = Math.min(remaining, perCandidateCap);
    if (count <= allowance) {
      selected.push({ ...candidate, tokenCount: count });
      used += count;
    } else if (allowance >= 64) {
      const content = truncateToBudget(candidate.content, allowance);
      const tokenCount = tokens(content).length;
      selected.push({ ...candidate, content, tokenCount, truncated: true });
      used += tokenCount;
      truncated = true;
    }
  }
  return { selected, tokenCount: used, truncated };
}

function diversifiedOrder(candidates) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const structural = sorted.filter((candidate) => candidate.pinEligible
    && candidate.reasons.some((reason) => reason !== 'semantic'));
  const anchors = ['decisions', 'lessons', 'chunks', 'exemplars']
    .map((bucket) => structural.find((candidate) => candidate.bucket === bucket))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const anchored = new Set(anchors.map((candidate) => candidate.id));
  return [...anchors, ...sorted.filter((candidate) => !anchored.has(candidate.id))];
}

export function rankRetrieval({
  query,
  documents,
  semanticRows,
  relationships,
  area = null,
  types = null,
  k = 8,
  tokenBudget = 4000,
  perCandidateCapRatio = 0.22,
  semanticThreshold = DEFAULT_SEMANTIC_THRESHOLD,
  structuralPinFloor = DEFAULT_STRUCTURAL_PIN_FLOOR,
  retrievalFixes = [],
  documentAggregation = { mode: 'max' },
  slotAllocation = { mode: 'reserved-semantic', floor: 0.55, slots: 1, championMetric: 'raw' },
}) {
  const terms = queryTokens(query);
  const semantics = semanticByDocument(semanticRows, documentAggregation);
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const matches = new Map(documents.map((document) => [document.id, documentMatch(document, terms)]));
  const eligible = (document) => (!types?.length || types.includes(document.type))
    && (!area || document.meta?.area === area);
  const inferredAreas = new Map();
  for (const document of documents) {
    if (!eligible(document)) continue;
    if (!['decision', 'lesson', 'exemplar'].includes(document.type)) continue;
    const match = matches.get(document.id);
    if (match.score === 0 || !document.meta?.area) continue;
    inferredAreas.set(document.meta.area, (inferredAreas.get(document.meta.area) || 0) + match.score);
  }
  const strongestArea = [...inferredAreas.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const candidates = new Map();
  const curatedTargets = new Map();
  for (const fix of retrievalFixes) {
    const triggerTerms = new Set(queryTokens(fix.trigger));
    const overlap = terms.filter((term) => triggerTerms.has(term)).length;
    const denominator = Math.min(terms.length, triggerTerms.size);
    const relevance = denominator > 0 ? overlap / denominator : 0;
    // Overlap is a COUNT and scales with query length; `relevance` is a FRACTION over
    // min(|query|,|trigger|), so it is inversely sensitive to it: a short query clears the
    // fraction on two incidental words while a real 16 token task query would need seven
    // matches to reach 0.4. That asymmetry fired an owner status pin on a Gmail API key
    // query and cost the gold set a case (g033). Raising the count to 3 is the lever that
    // scales correctly: it suppresses no firing on real task queries and kills the short
    // query accidents. Raising the FRACTION instead was measured and struck, because it
    // guts real retrieval (firings collapse from 187 to 35 at 0.4, to 11 at 0.5).
    //
    // The single token branch stays. With |query| = 1, `overlap >= 3` is arithmetically
    // impossible, so this branch is the only thing that lets a one word query fire a pin at
    // all; removing it would be an unmeasured functional change, not a consistency fix.
    if ((overlap >= 3 && relevance >= 0.3) || (overlap >= 1 && terms.length === 1)) {
      curatedTargets.set(fix.targetId, Math.max(curatedTargets.get(fix.targetId) || 0, relevance));
    }
  }

  for (const document of documents) {
    if (!eligible(document)) continue;
    const semantic = semantics.get(document.id);
    const match = matches.get(document.id);
    const semanticHit = semantic && semantic.semanticScore >= semanticThreshold;
    const explicitlyCuratedArchitecture = document.type === 'architecture'
      && Array.isArray(document.meta?.retrieval_provenance)
      && document.meta.retrieval_provenance.length > 0;
    const tagHit = (['decision', 'lesson', 'exemplar'].includes(document.type) || explicitlyCuratedArchitecture)
      && match.score > 0;
    const areaHit = Boolean(area);
    const architectureHit = document.type === 'architecture' && strongestArea && document.meta?.area === strongestArea;
    const curatedFixRelevance = curatedTargets.get(document.id) || 0;
    const curatedFixHit = curatedFixRelevance > 0;
    if (!semanticHit && !tagHit && !areaHit && !architectureHit && !curatedFixHit) continue;
    const reason = curatedFixHit
      ? 'curated-retrieval-fix'
      : tagHit ? 'tag-or-title' : areaHit ? 'area-filter' : architectureHit ? 'inferred-area-architecture' : null;
    const candidate = asCandidate(document, semantic, match, reason, null, structuralPinFloor);
    if (curatedFixHit && candidate.pinEligible) candidate.score = Math.max(candidate.score, 4 + curatedFixRelevance);
    mergeCandidate(candidates, candidate);
  }

  for (const lesson of [...candidates.values()].filter((candidate) => candidate.type === 'lesson'
    && candidate.reasons.some((reason) => reason !== 'semantic'))) {
    const linkedIds = relationships
      .filter((edge) => ['fixes', 'refs'].includes(edge.kind) && edge.src === `doc:${lesson.id}`)
      .map((edge) => edge.dst.replace(/^doc:/, ''));
    for (const linkedId of linkedIds) {
      const linkedDocument = documentsById.get(linkedId);
      if (!linkedDocument || linkedDocument.type !== 'decision' || !eligible(linkedDocument)) continue;
      const linked = asCandidate(linkedDocument, semantics.get(linkedId), matches.get(linkedId), 'linked-from-lesson', 'decisions', structuralPinFloor);
      if (linked.pinEligible) linked.score = Math.max(linked.score, lesson.score - 0.1);
      mergeCandidate(candidates, linked);
    }
  }

  for (const candidate of [...candidates.values()].filter((item) => item.type === 'decision')) {
    const component = supersessionComponent(candidate.id, relationships);
    candidates.delete(candidate.id);
    for (const currentId of component.currentIds) {
      const current = documentsById.get(currentId);
      if (!current) continue;
      const structural = candidate.reasons.some((reason) => reason !== 'semantic');
      const resolved = asCandidate(current, semantics.get(currentId), matches.get(currentId), structural ? 'current-decision' : null, 'decisions', structuralPinFloor);
      resolved.reasons = [...new Set([...candidate.reasons, ...resolved.reasons])];
      const replacementBoost = structural && currentId !== candidate.id ? 0.5 : 0;
      if (!structural || resolved.pinEligible) {
        resolved.score = Math.max(resolved.score, candidate.score + replacementBoost);
      }
      resolved.current = true;
      resolved.superseded = component.supersededIds
        .map((supersededId) => documentsById.get(supersededId))
        .filter(Boolean)
        .map((document) => ({ id: document.id, title: document.title, path: document.path }));
      mergeCandidate(candidates, resolved);
    }
  }

  let ranked = diversifiedOrder(candidates.values());
  // Slot allocation. 'reserved-semantic' shipped 2026-08-14 (ADR-0157, floor 0.55, the
  // mid plateau of the 0.50 to 0.60 sweep, one slot; two slots measured identical). Under
  // the prior 'governed' behaviour, structural anchors and pins outrank any pure semantic
  // score by construction (their score starts at 2 plus), and the token budget often funds
  // fewer than k candidates, so a semantic candidate's position is doubly precarious. The
  // 2026-08-14 trace on g009 showed the failure mode: the corpus best semantic document
  // (identity beacon at 0.6773, corpus rank 1) never reaches the funded set.
  // 'reserved-semantic' guarantees FUNDING, not position: after the normal budget pass, the
  // strongest unfunded semantic candidate at or above the floor displaces the weakest
  // funded candidate, once per reserved slot. Governance order is otherwise untouched, so
  // this bounds pin dominance (ADR-0150 history) instead of abolishing it.
  let budgeted = applyBudget(ranked, k, tokenBudget, perCandidateCapRatio);
  if (slotAllocation.mode === 'reserved-semantic') {
    const floor = Number(slotAllocation.floor ?? 0.55);
    const slots = Math.max(1, Number(slotAllocation.slots ?? 1));
    // 'fused' selects on the post fusion rescaled score. The g014 trace showed its defect:
    // rescaling hands a lexically boosted candidate the i-th cosine VALUE, so a lexical
    // winner can tie the true semantic champion (both 0.673) and take the slot on tie
    // break. 'raw' selects on pre fusion cosine, the evidence this slot exists to protect,
    // and lexical only candidates (no raw cosine) are simply not champions. 'raw' shipped
    // 2026-08-14 (ADR-0158).
    const championMetric = slotAllocation.championMetric === 'fused'
      ? (candidate) => candidate.semanticScore
      : (candidate) => candidate.rawSemanticScore;
    const forced = new Set();
    for (let round = 0; round < slots; round += 1) {
      const funded = new Set(budgeted.selected.map((candidate) => candidate.id));
      const champion = ranked
        .filter((candidate) => !funded.has(candidate.id)
          && championMetric(candidate) !== null && championMetric(candidate) >= floor)
        .sort((a, b) => championMetric(b) - championMetric(a))[0];
      if (!champion) break;
      const victims = budgeted.selected.filter((candidate) => !forced.has(candidate.id));
      const victim = victims[victims.length - 1];
      if (!victim) break;
      forced.add(champion.id);
      const victimIndex = ranked.findIndex((candidate) => candidate.id === victim.id);
      ranked = ranked.filter((candidate) => candidate.id !== champion.id && candidate.id !== victim.id);
      ranked.splice(victimIndex, 0, champion);
      budgeted = applyBudget(ranked, k, tokenBudget, perCandidateCapRatio);
    }
  }
  const result = { chunks: [], decisions: [], lessons: [], exemplars: [] };
  for (const candidate of budgeted.selected) result[candidate.bucket].push(candidate);
  return {
    ...result,
    meta: {
      retrievedIds: budgeted.selected.map((candidate) => candidate.id),
      tokenCount: budgeted.tokenCount,
      tokenBudget,
      truncated: budgeted.truncated || ranked.length > budgeted.selected.length,
      semanticThreshold,
      structuralPinFloor,
      inferredArea: strongestArea,
    },
  };
}
