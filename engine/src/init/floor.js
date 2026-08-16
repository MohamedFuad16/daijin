// The retrieval floor, measured per repo, and the budget sweep that chooses the number.
//
// D-0003, and the plan's retrieval budget policy: "4,000 stays the anchor (the only
// measured point, 91.2%) but the shipped number is MEASURED PER REPO: init sweeps the
// floor at 3k, 4k, 6k, 8k (zero-spend, local) and picks the smallest budget within one
// case of the best score, curve displayed with the auditor's one-line rationale."
//
// Why SMALLEST within one case rather than best: the initial context rides in every
// round's prompt, so 4k times 44 rounds is about 176k per exam, and the measured failures
// were work-budget and ordering bound with retrieval already correct. A budget raised for
// a tie buys nothing and is paid for on every round of every run. The content-survival
// gate is the mechanical signal that says raise it anyway.
//
// Every number here is an exact rational carried with its case counts. `caseRate.exact` is
// the fraction, `caseRate.cases` is "31 of 34". Nothing is stored rounded, which is this
// repo's oldest correction: a floor typed from a rounded display sits above the
// measurement it came from and fails on a healthy tree.
//
// Zero-spend: scoring runs through the extractor's harness over an injected Store, and
// embeddings come from the local Ollama adapter. Nothing here calls a paid API.
import { tokens } from '../rag/tokens.js';
import { chunkUnits } from './ingest.js';
import { scoreGoldset } from './retrieval-score.js';

/** The four sweep points. Fixed by D-0003; 4000 is the anchor and stays in the list. */
export const BUDGET_SWEEP = Object.freeze([3000, 4000, 6000, 8000]);

/** Case rate at or above this unlocks the MCP snippet (RPC v4 mcpSnippet). */
export const MCP_UNLOCK_THRESHOLD = 0.75;

/**
 * A case rate in the only form this project stores it.
 *
 * `exact` is the rational; `cases` is the readable form WITH the denominator. Both, always,
 * because the display alone is unfalsifiable and the fraction alone is unreadable.
 */
export function caseRateOf(summary, results) {
  const total = summary.cases;
  const hits = results.filter((entry) => entry.complete).length;
  return { exact: summary.caseRate, cases: `${hits} of ${total}`, hits, total };
}

/**
 * Build a corpus descriptor for a local, already-open store.
 *
 * No database URL is named or needed. The harness believes an injected environment and
 * reaches for nothing global when one is supplied (retrieval-score.js scoreGoldset), so a
 * corpus measured over SQLite carries no connection string at all. The earlier sentinel
 * variable here existed only to satisfy a requirement that no longer exists.
 */
export function localCorpus({
  id, project = null, goldsetPath, baselinePath = null, standingPrefix = 'global.',
  pathGrammar = null, retrieveOptions = {},
}) {
  return {
    id,
    project,
    root: null,
    goldsetPath,
    retrievalFixesPath: null,
    baselinePath,
    envFiles: [],
    pathGrammar,
    standingPrefix,
    retrieveOptions,
    storeOptions: {},
    note: 'Local per-repo corpus measured over an injected Store with an injected environment.',
  };
}

/**
 * Run the gold set at one budget.
 */
export async function scoreAtBudget({
  corpus, store, tokenBudget, k = 8, score = scoreGoldset, environment = null, fetchImpl = null,
}) {
  const { summary, results, record } = await score({
    corpus,
    store,
    k,
    label: `budget-${tokenBudget}`,
    retrieveOptions: { ...(corpus.retrieveOptions || {}), tokenBudget },
    // Believed by the harness, which then touches nothing global. This matters beyond
    // tidiness: a lend-and-restore of process.env is a race the moment two measurements
    // overlap, and the sweep below runs four in a row.
    ...(environment ? { environment } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    tokenBudget,
    caseRate: caseRateOf(summary, results),
    mrr: summary.mrr,
    violations: summary.violations,
    hitRate: summary.hitRate,
    identifierCases: summary.identifierCases,
    identifierCaseRate: summary.identifierCaseRate,
    summary,
    results,
    record,
  };
}

/**
 * Pick the shipped budget from a measured curve.
 *
 * "Within one case of the best" is a COUNT comparison, not a rate comparison: at n cases
 * one case is 1/n, and comparing rates with a tolerance re-introduces the rounding this
 * project keeps getting bitten by. Ties break toward the smaller budget by construction,
 * since the curve is scanned in ascending budget order.
 */
export function chooseBudget(curve) {
  if (!curve.length) throw new Error('chooseBudget needs at least one measured point.');
  const ascending = [...curve].sort((left, right) => left.tokenBudget - right.tokenBudget);
  const best = ascending.reduce(
    (winner, point) => (point.caseRate.hits > winner.caseRate.hits ? point : winner),
    ascending[0],
  );
  const chosen = ascending.find((point) => best.caseRate.hits - point.caseRate.hits <= 1);
  const rationale = chosen.tokenBudget === best.tokenBudget
    ? `${chosen.tokenBudget} tokens: the best measured score on this repo (${chosen.caseRate.cases}); no smaller budget came within one case.`
    : `${chosen.tokenBudget} tokens: ${chosen.caseRate.cases}, within one case of the best (${best.caseRate.cases} at ${best.tokenBudget}), `
      + 'and the smaller budget is paid on every round of every run.';
  return { chosen, best, rationale };
}

/**
 * Sweep the budgets and choose. Zero-spend end to end.
 */
export async function sweepBudgets({
  corpus, store, budgets = BUDGET_SWEEP, k = 8, score = scoreGoldset,
  environment = null, fetchImpl = null, onStep = null,
} = {}) {
  const curve = [];
  for (const tokenBudget of [...budgets].sort((left, right) => left - right)) {
    const point = await scoreAtBudget({ corpus, store, tokenBudget, k, score, environment, fetchImpl });
    curve.push(point);
    if (onStep) {
      await onStep({
        step: 'budget-measured',
        detail: `${tokenBudget} tokens: ${point.caseRate.cases}, ${point.violations} violations`,
        counts: { tokenBudget, hits: point.caseRate.hits, cases: point.caseRate.total },
      });
    }
  }
  const { chosen, best, rationale } = chooseBudget(curve);
  return {
    curve: curve.map((point) => ({
      tokenBudget: point.tokenBudget,
      caseRate: point.caseRate,
      mrr: point.mrr,
      violations: point.violations,
      identifierCaseRate: point.identifierCaseRate,
      identifierCases: point.identifierCases,
    })),
    chosen: chosen.tokenBudget,
    chosenPoint: chosen,
    best: best.tokenBudget,
    rationale,
    k,
    points: curve,
  };
}

/**
 * The gauge's own resolution, measured on the same corpus and store as the floor.
 *
 * D-0030: every floor report carries this. The reason is a measurement, not a principle.
 * On portfolio-mine the floor came out 25 of 25 and a gold set with every answer
 * deliberately wrong STILL scored 18 of 25, because at 11 documents k=8 returns a mean of
 * 7.6 of them per query. Presence is nearly free on a small corpus, so the enforced metric
 * saturates while the deliberately unfloored one (MRR) keeps its range. A floor quoted
 * without this number reads as "retrieval is perfect here" when what it means is "this
 * gauge cannot tell".
 *
 * Reported, never gated. A narrow range is a fact about the corpus and the gold set, and
 * the honest use is to say how large an effect this gauge could have seen at all.
 */
export async function measureResolution({
  corpus, controlCorpus, store, tokenBudget, k = 8, score = scoreGoldset, environment = null, fetchImpl = null,
} = {}) {
  const candidate = await scoreAtBudget({ corpus, store, tokenBudget, k, score, environment, fetchImpl });
  const control = await scoreAtBudget({ corpus: controlCorpus, store, tokenBudget, k, score, environment, fetchImpl });
  const caseRange = candidate.caseRate.exact - control.caseRate.exact;
  return {
    tokenBudget,
    caseRate: {
      candidate: candidate.caseRate,
      control: control.caseRate,
      range: caseRange,
      casesOfHeadroom: candidate.caseRate.hits - control.caseRate.hits,
    },
    mrr: { candidate: candidate.mrr, control: control.mrr, range: candidate.mrr - control.mrr },
    // Said in words, because the number alone gets quoted without its meaning.
    reading: `A gold set with deliberately wrong answers scores ${control.caseRate.cases} against the real set's `
      + `${candidate.caseRate.cases}. Case rate has ${candidate.caseRate.hits - control.caseRate.hits} case(s) of `
      + `discriminating room on this corpus; MRR has ${(candidate.mrr - control.mrr).toFixed(4)}. `
      + 'An effect smaller than that room cannot be seen by this gauge, whatever the floor says.',
  };
}

/**
 * RPC v4 mcpSnippet: unlocked at or above the threshold, locked below it.
 *
 * The THRESHOLD stands and is not adjusted by the range (verifier finding 80). What the
 * range changes is what the reader is told alongside it. If a gold set with deliberately
 * wrong answers would also clear the bar, or comes within one case of clearing it, then
 * the unlock decision was made on a metric that cannot distinguish a good brain from a
 * scrambled one, and the report says so in a sentence rather than leaving a green tick to
 * speak for itself.
 */
export function mcpUnlock(caseRate, { threshold = MCP_UNLOCK_THRESHOLD, resolution = null } = {}) {
  const unlocked = caseRate.exact >= threshold;
  const control = resolution?.caseRate?.control ?? null;
  // One case is the smallest movement the metric can express, so "within one case of the
  // threshold" is the honest boundary for a warning rather than an arbitrary margin.
  const oneCase = caseRate.total ? 1 / caseRate.total : 0;
  const controlClears = control ? control.exact >= threshold : false;
  const controlNearlyClears = control ? control.exact + oneCase >= threshold : false;

  let saturation = null;
  if (controlClears) {
    saturation = `A gold set with deliberately WRONG answers scores ${control.cases}, which also clears the ${threshold} `
      + 'threshold. This unlock decision carries no information about retrieval quality: the metric cannot tell this '
      + 'brain from a scrambled one at this corpus size.';
  } else if (controlNearlyClears) {
    saturation = `A gold set with deliberately WRONG answers scores ${control.cases}, within one case of the ${threshold} `
      + `threshold. The unlock stands, and the margin it stands on is ${resolution.caseRate.casesOfHeadroom} case(s) of `
      + 'discriminating room, not the distance from zero.';
  }

  return {
    unlocked,
    threshold,
    caseRate,
    resolution,
    saturation,
    reason: unlocked
      ? `${caseRate.cases} is at or above the ${threshold} threshold, so the brain is fit to serve over MCP.`
      : `${caseRate.cases} is below the ${threshold} threshold. The mechanical diagnosis names which cases missed; MCP stays locked until the floor is earned.`,
  };
}

// ---------------------------------------------------------------------------------
// Content survival
// ---------------------------------------------------------------------------------

/**
 * The untrimmed text an entry was cut from.
 *
 * For an architecture document the retrieval path substitutes the winning CHUNK for the
 * document content (rank.js:126), so the untrimmed source is that chunk. For every other
 * type it is the whole document. Getting this wrong in either direction would make the
 * instrument report the wrong cause: a window that never held the core is a CHUNKING
 * outcome, and a core cut by the allowance is a BUDGET outcome, and the two have different
 * fixes.
 */
export function sourceContentFor(unit, entry, chunksByUnit) {
  if (unit.type !== 'architecture' || entry.ordinal === null || entry.ordinal === undefined) return unit.content;
  const chunks = chunksByUnit.get(unit.id) || [];
  // Ordinal -1 is the identity beacon, which resolves to ordinal 0 content on the query
  // path (store.d.ts CandidateRow), so the untrimmed source for it is chunk 0.
  const wanted = entry.ordinal === -1 ? 0 : entry.ordinal;
  return chunks.find((chunk) => chunk.ordinal === wanted)?.content ?? unit.content;
}

/**
 * Did every delivered unit's type core survive the trim, verbatim.
 *
 * Two distinct findings, deliberately not merged into one number:
 *   truncatedAway  the source held the core and the delivered text does not. This is the
 *                  budget trim beheading a unit, and it FAILS the gate: it is the plan's
 *                  "mechanical raise signal".
 *   windowMissed   the source never held the core, because a different window of the
 *                  document won retrieval. That is a chunking outcome, reported and not
 *                  failed, because raising the budget would not fix it.
 *
 * @param {object[]} deliveries [{ caseId, entries: [{ id, content, ordinal }] }]
 */
export function checkContentSurvival(deliveries, { units, tokenBudget, perCandidateCapRatio = 0.22 }) {
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const chunksByUnit = new Map(chunkUnits(units).map((plan) => [plan.unit.id, plan.chunks]));
  const truncatedAway = [];
  const windowMissed = [];
  let checked = 0;
  let survived = 0;

  for (const delivery of deliveries) {
    for (const entry of delivery.entries) {
      const unit = unitsById.get(entry.id);
      if (!unit?.core) continue;
      checked += 1;
      const delivered = String(entry.content || '');
      if (delivered.includes(unit.core)) {
        survived += 1;
        continue;
      }
      const source = sourceContentFor(unit, entry, chunksByUnit);
      const record = {
        caseId: delivery.caseId,
        id: unit.id,
        type: unit.type,
        ordinal: entry.ordinal ?? null,
        coreTokens: tokens(unit.core).length,
        deliveredTokens: tokens(delivered).length,
        allowance: Math.max(64, Math.floor(tokenBudget * perCandidateCapRatio)),
      };
      if (source.includes(unit.core)) truncatedAway.push(record);
      else windowMissed.push(record);
    }
  }

  return {
    status: truncatedAway.length === 0 ? 'pass' : 'fail',
    tokenBudget,
    perCandidateCap: Math.max(64, Math.floor(tokenBudget * perCandidateCapRatio)),
    checked,
    survived,
    // Exact counts, no percentage: the denominator is the point.
    survival: `${survived} of ${checked}`,
    truncatedAway,
    windowMissed,
    raiseSignal: truncatedAway.length > 0
      ? `${truncatedAway.length} delivered unit(s) lost their type core to the per-candidate cap of `
        + `${Math.max(64, Math.floor(tokenBudget * perCandidateCapRatio))} tokens at a ${tokenBudget} token budget. `
        + 'This is the mechanical signal to raise the budget or shorten the cards.'
      : null,
  };
}

/**
 * Collect what retrieval actually delivered for each case, for the survival check.
 *
 * Runs the same retrieval the score just ran, at the chosen budget, and keeps the entry
 * texts. Separate from scoring on purpose: the score harness reports ids, and survival is
 * a question about BYTES, so it needs the content the engineer would have received.
 */
export async function collectDeliveries({ cases, retrieveFn, tokenBudget }) {
  const deliveries = [];
  for (const entry of cases) {
    const result = await retrieveFn({ query: entry.query, tokenBudget });
    const entries = [
      ...(result.decisions || []), ...(result.lessons || []), ...(result.exemplars || []),
      ...(result.chunks || []), ...(result.standing || []),
    ].map((item) => ({ id: item.id, content: item.content, ordinal: item.ordinal ?? null }));
    deliveries.push({ caseId: entry.id, entries });
  }
  return deliveries;
}
