// D-0025's measurement: the cross-encoder rerank, judged on the gold set, per repo.
//
// The ruling assigns the stage and the backend to the extractor and this A/B to init. It
// also fixes how the number is judged, and the wording is worth keeping in front of the
// reader: the rerank "becomes a default ONLY on a measured gold-set win, judged per D-0017
// (case rate and violations enforced, MRR reported as movement), A/B on the platform
// corpus AND the portfolio-mine corpus once its gold set exists, in the budget-sweep
// style: the number decides, per repo. If the measured win is absent, the knob still
// ships, documented as measured-neutral-or-negative on these corpora, and the honest
// number is the deliverable."
//
// So this file is built to be able to report a LOSS. Three properties enforce that:
//
//   The arms differ by ONE option. Both arms receive the reranker dependency; only the
//   treatment passes rerank.enabled. The extractor built the seam that way deliberately,
//   and an A/B whose arms differ by which dependencies were wired is comparing two
//   programs rather than one change.
//   The judgment is D-0017's, not a fresh one. Case rate and violations decide; MRR is
//   recorded as movement and can never promote. The 2026-08-09 regression is the reason:
//   case rate fell one case while MRR rose, and an MRR-led judgment passes that event.
//   The gauge's own resolution is measured first. A gold set that cannot tell a right
//   answer from a wrong one cannot tell a rerank from no rerank either, and on a small
//   corpus that is the normal case rather than the exotic one (measured on portfolio-mine:
//   a permuted gold set still scores 18 of 25). Reporting a win inside the noise floor is
//   the failure this instrument exists to prevent.
import { compareRecords } from './compare-runs.js';
import { caseRateOf } from './floor.js';
import { scoreGoldset } from './retrieval-score.js';

/**
 * topK values worth sweeping. topK is an experimental variable: only the top of the fused
 * list is reordered, so it decides how much of the ranking the rerank can touch.
 *
 * Swept DOWNWARD, on the extractor's measured advice from the platform arm (2026-08-16):
 * 20 and 40 scored identically on every case and in every summary field there, and 40 cost
 * exactly twice as much. So depth past 20 bought nothing and the open question is the other
 * direction, how shallow a shortlist still captures the reordering.
 */
export const DEFAULT_TOP_KS = Object.freeze([10, 20]);

/**
 * Build a permuted gold set: every query kept, every answer deliberately wrong.
 *
 * The instrument that says how much range a gauge has. A gold set with real resolution
 * scores near zero here; one whose corpus is small enough that retrieval returns most of
 * it scores high, and then no A/B run over it can mean anything.
 *
 * Deterministic: the replacement answer is chosen by position in the sorted id list, so
 * two runs permute identically and the control is re-derivable.
 */
export function permuteAnswers(cases) {
  const ids = [...new Set(cases.flatMap((entry) => entry.must_return))].sort();
  if (ids.length < 2) throw new Error('A permuted control needs at least two distinct answers to swap between.');
  return cases.map((entry, index) => {
    const wrong = ids.filter((id) => !entry.must_return.includes(id));
    // A case whose answers cover EVERY id in the set has no wrong answer to swap to, and
    // `wrong[index % 0]` is `undefined`, which produced `must_return: [undefined]` and a
    // control arm that scored a case it could never satisfy. Downstream the D-0030 range
    // then read as unavailable with nothing said about why.
    //
    // Thrown rather than skipped, and thrown by NAME. Skipping the case would give the
    // control a different denominator from the candidate, which is the one property the
    // range depends on; the caller catches this and reports it as a skipped control with
    // the reason, which is what a reader needs to decide whether the corpus can be
    // permuted at all.
    if (wrong.length === 0) {
      throw new Error(`Case ${entry.id} names every answer in the gold set, so a permuted control cannot give it a wrong one. A control that scores it anyway would measure nothing.`);
    }
    const { must_not_outrank: unused, ...rest } = entry;
    return { ...rest, must_return: [wrong[index % wrong.length]] };
  });
}

/**
 * How much of each metric's range the gauge actually has on this corpus.
 *
 * Reported, never gated. A range is a property of the corpus and the gold set, not a
 * defect to fail on, and the honest use is to say how large an effect would have to be
 * before this gauge could see it.
 */
export function discriminatingRange(candidate, control) {
  const caseRange = candidate.caseRate.exact - control.caseRate.exact;
  const mrrRange = candidate.mrr - control.mrr;
  return {
    caseRate: {
      candidate: candidate.caseRate.cases,
      control: control.caseRate.cases,
      range: caseRange,
      // One case is the smallest movement the metric can express, so a range narrower than
      // a few cases cannot separate a real change from a rounding of the corpus.
      casesOfHeadroom: candidate.caseRate.hits - control.caseRate.hits,
    },
    mrr: { candidate: candidate.mrr, control: control.mrr, range: mrrRange },
  };
}

/**
 * Judge one arm pair, per D-0017.
 *
 * Enforced: case rate must not fall and violations must not rise. Reported: MRR movement,
 * which never promotes and never blocks. A "win" needs the enforced metric to MOVE, not
 * merely to hold, because holding is what the knob does when it does nothing.
 */
export function judgeRerank(control, treatment) {
  const caseDelta = treatment.caseRate.hits - control.caseRate.hits;
  const violationDelta = treatment.violations - control.violations;
  const mrrDelta = treatment.mrr - control.mrr;

  let verdict;
  if (violationDelta > 0) verdict = 'regression';
  else if (caseDelta < 0) verdict = 'regression';
  else if (caseDelta > 0) verdict = 'win';
  else verdict = 'neutral';

  return {
    verdict,
    caseDelta,
    violationDelta,
    mrrDelta,
    enforced: {
      caseRate: `${control.caseRate.cases} to ${treatment.caseRate.cases}`,
      violations: `${control.violations} to ${treatment.violations}`,
    },
    // Stated rather than implied: MRR is in the record and had no vote.
    mrrMovement: `${control.mrr} to ${treatment.mrr} (recorded as movement, never a promotion criterion)`,
    summary: verdict === 'win'
      ? `rerank gains ${caseDelta} case(s) with violations ${violationDelta >= 0 ? 'unchanged or up' : 'down'}`
      : verdict === 'regression'
        ? `rerank LOSES: case delta ${caseDelta}, violation delta ${violationDelta}`
        : 'rerank moves no enforced metric on this corpus',
  };
}

/** One measurement, with its arm disclosed exactly as the harness recorded it. */
async function measure({ corpus, store, environment, fetchImpl, k, tokenBudget, reranker, rerank, score, now }) {
  // D-0025 requires the knob's COST to be displayed next to it, so the A/B measures it
  // rather than leaving a later reader to guess. Wall time over the whole arm divided by
  // the case count: the per-query number a user pays on every retrieval.
  const started = now();
  const { summary, results, record } = await score({
    corpus,
    store,
    k,
    label: rerank?.enabled ? `rerank-on-top${rerank.topK}-budget${tokenBudget}` : `rerank-off-budget${tokenBudget}`,
    // BOTH arms receive the backend. Only the option differs.
    reranker,
    retrieveOptions: { ...(corpus.retrieveOptions || {}), tokenBudget, ...(rerank ? { rerank } : {}) },
    ...(environment ? { environment } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const elapsedMs = Math.round(now() - started);
  return {
    tokenBudget,
    rerank: record.rerank ?? { enabled: false },
    elapsedMs,
    msPerQuery: results.length ? Math.round(elapsedMs / results.length) : null,
    caseRate: caseRateOf(summary, results),
    mrr: summary.mrr,
    violations: summary.violations,
    identifierCaseRate: summary.identifierCaseRate,
    summary,
    results,
    record,
  };
}

/**
 * Run the A/B across the budget sweep, in the same shape the floor sweep reports.
 *
 * @param {object} options
 * @param {object} options.reranker  { id, rerank(query, documents) } from rerank-backends,
 *                                   or a deterministic stub when only the wiring is under test
 * @param {number[]} options.topKs   topK is an experimental variable, so it sweeps too
 * @param {object[]} [options.controlCases] permuted gold set for the resolution measurement
 */
export async function rerankAB({
  corpus,
  store,
  reranker,
  budgets = [3000, 4000],
  topKs = DEFAULT_TOP_KS,
  k = 8,
  environment = null,
  fetchImpl = null,
  score = scoreGoldset,
  controlCorpus = null,
  onStep = null,
  // Injectable time source, same idiom as pipeline.js's `clock`. The cold/warm cost
  // comparison is a claim about MEASURED durations, and a test asserting it on the real
  // scheduler is racing the machine's load - the 1-in-5 flake this closes.
  now = () => performance.now(),
} = {}) {
  if (!reranker?.rerank) throw new Error('rerankAB requires a reranker with a rerank(query, documents) method.');
  const pairs = [];
  const coldTopKs = new Set();

  for (const tokenBudget of [...budgets].sort((left, right) => left - right)) {
    const control = await measure({
      corpus, store, environment, fetchImpl, k, tokenBudget, reranker, rerank: null, score, now,
    });
    if (control.rerank.enabled) {
      // The one thing that would invalidate every pair silently: an arm labelled off that
      // reranked anyway. The harness writes the disclosure, so it is checkable rather than
      // assumed.
      throw new Error('The control arm reported rerank enabled; the arms are not one option apart.');
    }
    for (const topK of topKs) {
      const treatment = await measure({
        corpus, store, environment, fetchImpl, k, tokenBudget, reranker, rerank: { enabled: true, topK }, score, now,
      });
      if (!treatment.rerank.enabled || treatment.rerank.topK !== topK) {
        throw new Error(`The treatment arm at topK ${topK} did not report reranking; the option did not reach the stage.`);
      }
      const judgment = judgeRerank(control, treatment);
      // Only the FIRST arm to score a given topK is a cost measurement. Measured live on
      // 2026-08-16: topK 40 came back at 15087 ms per query on its first arm and 1491 on a
      // later one, a tenfold difference for identical work, because the backend caches
      // query-document pairs and every later arm re-asks questions it has already answered.
      // Reporting the later number as the knob's price would understate it by an order of
      // magnitude. The flag rides with the number rather than living in a footnote.
      const cold = !coldTopKs.has(topK);
      coldTopKs.add(topK);
      // Per-case diff, because IDENTICAL SUMMARIES DO NOT MEAN IDENTICAL RUNS. Measured by
      // the extractor on the platform arm: topK 20 and 40 matched in every summary field
      // while the retrieval-level differ reported eighteen differences across seven cases.
      // A runner that compares only the headline would call topK inert when it is not, and
      // "the knob changed nothing" is precisely the conclusion that needs the stronger
      // evidence.
      const perCase = compareRecords(control.record, treatment.record);
      pairs.push({ tokenBudget, topK, control, treatment, judgment, cold, perCase });
      if (onStep) {
        await onStep({
          step: 'rerank-pair',
          detail: `budget ${tokenBudget} topK ${topK}: ${control.caseRate.cases} to ${treatment.caseRate.cases}, ${judgment.verdict}`,
          counts: { tokenBudget, topK, caseDelta: judgment.caseDelta },
        });
      }
    }
  }

  // The gauge's resolution, measured on the SAME corpus with the same store, so the number
  // below is the range this A/B had to work inside.
  let resolution = null;
  if (controlCorpus) {
    const candidateArm = pairs[0].control;
    const permuted = await measure({
      corpus: controlCorpus, store, environment, fetchImpl, k, tokenBudget: pairs[0].tokenBudget, reranker, rerank: null, score, now,
    });
    resolution = discriminatingRange(candidateArm, permuted);
  }

  const wins = pairs.filter((pair) => pair.judgment.verdict === 'win');
  const regressions = pairs.filter((pair) => pair.judgment.verdict === 'regression');
  const verdict = regressions.length > 0 ? 'regression' : wins.length > 0 ? 'win' : 'neutral';

  return {
    pairs: pairs.map((pair) => ({
      tokenBudget: pair.tokenBudget,
      topK: pair.topK,
      control: { caseRate: pair.control.caseRate, mrr: pair.control.mrr, violations: pair.control.violations, arm: pair.control.rerank, msPerQuery: pair.control.msPerQuery },
      treatment: { caseRate: pair.treatment.caseRate, mrr: pair.treatment.mrr, violations: pair.treatment.violations, arm: pair.treatment.rerank, msPerQuery: pair.treatment.msPerQuery },
      judgment: pair.judgment,
      // Whether the two arms actually ran the same, as opposed to scoring the same.
      perCase: {
        identical: pair.perCase.identical,
        differences: pair.perCase.differences.length,
        cases: [...new Set(pair.perCase.differences.map((entry) => entry.id))].length,
        detail: pair.perCase.differences,
      },
      // The price of the knob on this machine, alongside what it bought, and whether this
      // pair is a price measurement at all.
      cost: {
        msPerQuery: pair.treatment.msPerQuery,
        addedMsPerQuery: (pair.treatment.msPerQuery ?? 0) - (pair.control.msPerQuery ?? 0),
        cold: pair.cold,
        caveat: pair.cold
          ? null
          : 'Backend cache warm: this arm re-asked questions an earlier arm already answered, so its latency understates the knob. Read the cold arm for this topK.',
      },
    })),
    verdict,
    resolution,
    backend: reranker.id ?? null,
    k,
    // The price, taken only from arms that actually paid it.
    cost: Object.fromEntries([...coldTopKs].map((topK) => {
      const cold = pairs.find((pair) => pair.topK === topK && pair.cold);
      return [`topK${topK}`, {
        msPerQuery: cold?.treatment.msPerQuery ?? null,
        addedMsPerQuery: (cold?.treatment.msPerQuery ?? 0) - (cold?.control.msPerQuery ?? 0),
      }];
    })),
    // The sentence D-0025 asks for when the win is absent, written here so the report
    // cannot quietly omit it.
    // Stated separately from the verdict: a neutral verdict over arms that demonstrably
    // retrieved different documents is a different fact from a neutral verdict over arms
    // that did the same thing.
    movedWithoutScoring: pairs.filter((pair) => !pair.perCase.identical && pair.judgment.caseDelta === 0).length,
    conclusion: verdict === 'win'
      ? `Rerank wins on ${wins.length} of ${pairs.length} measured pairs; the knob is a default candidate on this corpus and nowhere else until measured there.`
      : verdict === 'regression'
        ? `Rerank REGRESSES on ${regressions.length} of ${pairs.length} measured pairs; it stays off and the number is the deliverable.`
        : `Rerank is measured-neutral on all ${pairs.length} pairs: it moves no enforced metric on this corpus. The knob ships off and documented as neutral here, per D-0025.`,
  };
}
