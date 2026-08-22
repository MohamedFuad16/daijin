// The gold set's own gates. It passes these before it is allowed to measure anything.
//
// Plan, verbatim: "The gold set passes its own gates before it may measure: existence
// (every must_return resolves in the live index), leakage (query never quotes the answer
// verbatim), staleness (a case retires with its superseded target), provenance (every case
// records its real origin), and a diversity floor (minimum count, spread across types and
// areas, identifier subset flagged)."
//
// And the soundness rule that outranks all five: "no gate ships without a mutation test
// demonstrating it CAN fail (scrambled index, invented citation, broken baseline). A gate
// without a demonstrated failure mode is dead coverage." Every gate below has one in
// engine/test/init-goldset-gates.test.js, and each mutation is named next to the gate it
// kills.
//
// The order matters. Existence runs against the LIVE index rather than against the unit
// list, because the unit list is what the miner believed and the index is what retrieval
// will actually search; those two disagreeing is precisely the failure the gate is for.
import { tokens } from '../rag/tokens.js';

/** Contiguous token span shared between a query and its answer that counts as leakage. */
export const LEAKAGE_SPAN = 6;

/** Below this many tokens a query is too short for the substring rule to mean anything. */
export const LEAKAGE_MIN_QUERY_TOKENS = 4;

/**
 * THE TARGET AND THE FLOOR ARE DIFFERENT NUMBERS, which they were not before (D-0046).
 *
 * `targetCases` is what mining aims for and is the platform's 25, measured on a large
 * corpus. It was also being used as a hard minimum, so a legitimate repo that mined 18
 * well-diversified cases was REFUSED on headcount alone - the owner's re-test found exactly
 * that, with every other gate passing.
 *
 * `minimumCases` is the MEASURABILITY floor: the count below which a case rate stops being
 * a measurement. It is argued from arithmetic rather than from a threshold in data. One
 * case is 1/N of the rate, so at 12 a single case moves the floor 8.3 points and below 12
 * one case is a tenth of the scale or worse. The sweep in docs/verification/
 * goldset-floor-sweep/ is the evidence, including the part that did NOT support a
 * threshold: discrimination against a permuted control holds at every size down to six, so
 * D-0030's range cannot pick this number and the choice is a product judgment about how
 * coarse a published number may be.
 */
export const DEFAULT_FLOORS = Object.freeze({
  targetCases: 25,
  minimumCases: 12,
  // Below this many cases of headroom over a permuted control, the set is not measuring
  // retrieval at all. Rarely binds - the sweep never saw it reached - and it exists because
  // a set can be large and degenerate, which a count can never see.
  minimumHeadroomCases: 3,
  // The band where a floor is real but coarse. Reports in it carry an explicit caution
  // rather than leaving the reader to infer error bars from a denominator.
  lowResolutionBelow: 15,
  minimumIdentifierCases: 5,
  minimumTypes: 3,
  minimumAreas: 3,
});

/**
 * The identifier-case floor SCALES WITH THE SET, instead of being a fixed 5.
 *
 * 5 is 20 percent of the 25-case target and 42 percent of a 12-case set, so lowering the
 * count floor alone would have moved the block rather than removed it: a 12-case set with
 * 3 identifier cases failed identifier-cases as well as count. This keeps the proportion
 * the fixed number already encoded at the target, with a hard minimum of 3 so the check
 * cannot evaporate on a small set.
 */
export function identifierFloorFor(count, floors = DEFAULT_FLOORS) {
  // THE CONFIGURED VALUE IS THE CEILING, always. An earlier version put the hard minimum
  // on the OUTSIDE - Math.max(3, ...) - which floored every caller at 3 and silently
  // overrode an explicit request for a lower one. A caller that configures 0 means 0, and
  // a scaling rule that cannot be turned off is not a default, it is a law. Caught by an
  // existing test that configures the floors down for a fixture.
  return Math.min(floors.minimumIdentifierCases, Math.max(3, Math.ceil(0.2 * count)));
}

function gate(id, status, detail, extra = {}) {
  return { id, status, detail, ...extra };
}

function referencedIds(cases) {
  return [...new Set(cases.flatMap((entry) => [...entry.must_return, ...(entry.must_not_outrank || [])]))];
}

/**
 * EXISTENCE. Every id a case names resolves in the live index.
 *
 * Mutation that kills it: drop one document from the store (the scrambled index) and the
 * gate names the id and the cases that referenced it.
 */
export async function existenceGate(cases, { store }) {
  const referenced = referencedIds(cases);
  if (referenced.length === 0) {
    return gate('existence', 'fail', 'no case names any document id', { failures: [] });
  }
  const known = new Set(await store.existingDocumentIds(referenced));
  const missing = referenced.filter((id) => !known.has(id)).sort();
  const failures = missing.map((id) => ({
    id,
    cases: cases.filter((entry) => entry.must_return.includes(id) || (entry.must_not_outrank || []).includes(id)).map((entry) => entry.id),
  }));
  return gate(
    'existence',
    missing.length === 0 ? 'pass' : 'fail',
    missing.length === 0
      ? `all ${referenced.length} referenced document ids resolve in the live index`
      : `${missing.length} of ${referenced.length} referenced ids are not in the live index`,
    { failures, referenced: referenced.length },
  );
}

/**
 * Whitespace-delimited words, compared by their word-character skeleton.
 *
 * The content tokenizer emits lone symbols as tokens, which is right for a token BUDGET
 * and wrong for a leakage measure: leakage is about copied prose, and punctuation is not
 * prose. Found live on the P3 target, 2026-08-16: the query "where is the
 * @vitejs/plugin-react package used" tripped the six-token threshold because the package
 * name alone tokenizes to `@ vitejs / plugin - react`, three of which are punctuation. A
 * single identifier is not a quotation, and a gate that says it is will be turned off.
 *
 * [Amended 2026-08-22, found live on TokaiHub: stripping punctuation TOKENS was not
 * enough - `@aws-sdk/client-cognito-identity-provider` still splits into six word tokens,
 * so one package name blocked the whole gold set as a "copied phrase". The unit of prose
 * is the whitespace-delimited word: each chunk collapses to its word characters and
 * counts as ONE token, so any single identifier is span 1 while a genuinely copied
 * sentence still counts word by word.]
 */
function wordTokens(text) {
  return String(text).toLowerCase().split(/\s+/)
    .map((chunk) => (chunk.match(/[\p{L}\p{N}_]/gu) || []).join(''))
    .filter((chunk) => chunk.length > 0);
}

/** Longest contiguous run of word tokens the two strings share. */
export function longestSharedSpan(queryText, answerText) {
  const left = wordTokens(String(queryText).toLowerCase());
  const right = wordTokens(String(answerText).toLowerCase());
  if (left.length === 0 || right.length === 0) return 0;
  const positions = new Map();
  right.forEach((token, index) => {
    const list = positions.get(token) || [];
    list.push(index);
    positions.set(token, list);
  });
  let best = 0;
  // Bounded by the QUERY length, which is short; this is not a general LCS over two
  // documents and does not need to be.
  for (let start = 0; start < left.length; start += 1) {
    for (const anchor of positions.get(left[start]) || []) {
      let length = 0;
      while (start + length < left.length && anchor + length < right.length
        && left[start + length] === right[anchor + length]) length += 1;
      if (length > best) best = length;
    }
  }
  return best;
}

/**
 * Does this query quote this answer.
 *
 * THE one definition of the leakage rule, exported so the miner filters with exactly what
 * the gate judges with. It exists because deriving the rule twice went wrong twice: the
 * first pre-filter checked only the contiguous span and every proposed title case still
 * failed on containment; the second checked containment with queryTokens while the gate
 * counts with tokens, so a three-stopword-stripped query slipped through. A pre-filter that
 * is half the rule is worse than none, because it makes the case look vetted.
 */
export function quotesAnswer(query, content, span = LEAKAGE_SPAN) {
  const normalizedContent = String(content).toLowerCase().replace(/\s+/g, ' ');
  const normalizedQuery = String(query).toLowerCase().replace(/\s+/g, ' ');
  const contained = tokens(query).length >= LEAKAGE_MIN_QUERY_TOKENS
    && normalizedContent.includes(normalizedQuery);
  const shared = longestSharedSpan(query, content);
  return { leaks: contained || shared >= span, contained, shared };
}

/**
 * LEAKAGE. A query never quotes its own answer.
 *
 * Two rules, because they catch different mistakes: a long contiguous span is a copied
 * phrase, and full containment is a copied sentence. A single identifier is neither, which
 * is why identifier cases (a bare token that does appear in the card) pass honestly rather
 * than by exemption.
 *
 * Mutation that kills it: author a case whose query is a sentence lifted from the answer.
 */
export function leakageGate(cases, { unitsById, span = LEAKAGE_SPAN }) {
  const failures = [];
  for (const entry of cases) {
    for (const id of entry.must_return) {
      const unit = unitsById.get(id);
      if (!unit) continue;
      const { leaks, contained, shared } = quotesAnswer(entry.query, unit.content, span);
      if (leaks) {
        failures.push({
          case: entry.id,
          answer: id,
          sharedSpan: shared,
          contained,
          reason: contained ? 'the query appears verbatim inside the answer' : `the query shares a ${shared} token run with the answer`,
        });
      }
    }
  }
  return gate(
    'leakage',
    failures.length === 0 ? 'pass' : 'fail',
    failures.length === 0
      ? `no case quotes its answer (threshold: ${span} contiguous tokens)`
      : `${failures.length} case(s) quote their answer`,
    { failures },
  );
}

/**
 * Find cases whose target no longer exists.
 *
 * A case retires WITH its superseded target rather than being deleted: store.d.ts says a
 * retired case keeps its record with the date and reason. Deleting it would erase the
 * evidence that the gauge used to cover something the repo has since dropped.
 */
export function findStaleCases(cases, { files = [], commits = new Set(), unitsById = new Map() } = {}) {
  const fileSet = new Set(files);
  const stale = [];
  for (const entry of cases) {
    if (entry.retired) continue;
    const target = entry.target || {};
    let reason = null;
    if (target.kind === 'symbol' && target.file && !fileSet.has(target.file)) {
      reason = `the defining file ${target.file} is gone`;
    } else if (target.kind === 'commit' && target.sha && commits.size > 0 && !commits.has(target.sha)) {
      reason = `commit ${target.sha} is no longer in the walked history`;
    } else if (target.kind === 'unit' && target.id && !unitsById.has(target.id)) {
      reason = `the unit ${target.id} is no longer generated`;
    }
    const missingAnswer = entry.must_return.find((id) => !unitsById.has(id));
    if (!reason && missingAnswer) reason = `the answer ${missingAnswer} is no longer generated`;
    if (reason) stale.push({ case: entry.id, reason });
  }
  return stale;
}

/**
 * Drop ranking constraints whose document no longer exists.
 *
 * The existence gate checks must_return AND must_not_outrank; staleness judged only the
 * ANSWER. So a case whose distractor was deleted was never stale and never existent, and
 * the two gates deadlocked the pipeline against each other. Found by the carry-forward
 * test on 2026-08-16: deleting one module left six cases naming its card, four in
 * must_return and two in must_not_outrank, and only the four could ever be retired.
 *
 * Pruning is the right resolution rather than retiring: must_not_outrank says "this
 * document must not beat the answer", and a document that no longer exists cannot beat
 * anything. The constraint is vacuous, not the case. Retiring a good case because a
 * distractor vanished would shrink the gauge for no reason.
 */
export function pruneVanishedConstraints(cases, { unitsById }) {
  const pruned = [];
  const next = cases.map((entry) => {
    if (!entry.must_not_outrank?.length) return entry;
    const kept = entry.must_not_outrank.filter((id) => unitsById.has(id));
    if (kept.length === entry.must_not_outrank.length) return entry;
    pruned.push({ case: entry.id, dropped: entry.must_not_outrank.filter((id) => !unitsById.has(id)) });
    const copy = { ...entry };
    if (kept.length > 0) copy.must_not_outrank = kept;
    else delete copy.must_not_outrank;
    return copy;
  });
  return { cases: next, pruned };
}

/** Retire the stale cases, keeping their record. */
export function retireCases(cases, stale, { date }) {
  const byId = new Map(stale.map((entry) => [entry.case, entry.reason]));
  return cases.map((entry) => (byId.has(entry.id)
    ? { ...entry, retired: { date, reason: byId.get(entry.id) } }
    : entry));
}

/**
 * STALENESS. No stale case is still active in the set about to measure.
 *
 * Mutation that kills it: delete a symbol's defining file and skip the retirement step;
 * the gate then names the case that would have been scored against a target that is gone.
 */
export function stalenessGate(activeCases, context) {
  const stale = findStaleCases(activeCases, context);
  return gate(
    'staleness',
    stale.length === 0 ? 'pass' : 'fail',
    stale.length === 0 ? 'no active case points at a target that is gone' : `${stale.length} active case(s) point at a target that is gone`,
    { failures: stale },
  );
}

const PROVENANCE_PATTERN = /^(commit-archaeology|structural|identifier|record-label|paraphrase:auditor):(.+)$/;

/**
 * PROVENANCE. Every case records a real origin, and the origin resolves.
 *
 * Recording an origin is not enough; a string nobody resolves is decoration. So a
 * commit-archaeology case must name a sha in the walked log, an identifier case a symbol
 * the scan actually found, and a structural case a unit or area that exists.
 *
 * Mutation that kills it: invent a provenance ("commit-archaeology:deadbeef") on one case.
 */
export function provenanceGate(cases, { commits = new Set(), symbols = null, unitsById = new Map(), cardByArea = new Map() }) {
  const failures = [];
  for (const entry of cases) {
    const match = PROVENANCE_PATTERN.exec(entry.provenance || '');
    if (!match) {
      failures.push({ case: entry.id, provenance: entry.provenance || null, reason: 'unparseable or missing provenance' });
      continue;
    }
    const [, kind, rest] = match;
    if (kind === 'commit-archaeology') {
      if (commits.size > 0 && !commits.has(rest)) {
        failures.push({ case: entry.id, provenance: entry.provenance, reason: `commit ${rest} is not in the walked history` });
      }
    } else if (kind === 'identifier') {
      if (symbols && !symbols.byName.has(rest)) {
        failures.push({ case: entry.id, provenance: entry.provenance, reason: `symbol ${rest} was not found by the deterministic scan` });
      }
    } else if (kind === 'record-label') {
      // A curated record label resolves against the unit whose title carries it, which is
      // the same rule the miner used to choose the answer. Resolving it against the code
      // symbol index (as an `identifier:` origin is) would fail every one of them: a label
      // is not a symbol.
      const home = unitsById.get(entry.target?.id);
      if (!home || !String(home.title || '').includes(rest)) {
        failures.push({ case: entry.id, provenance: entry.provenance, reason: `no unit carries ${rest} in its title` });
      }
    } else if (kind === 'structural') {
      const target = entry.target || {};
      const resolved = target.kind === 'unit' ? unitsById.has(target.id) : cardByArea.has(target.area);
      if (!resolved) {
        failures.push({ case: entry.id, provenance: entry.provenance, reason: 'the structural target does not resolve to a unit or an area card' });
      }
    }
  }
  return gate(
    'provenance',
    failures.length === 0 ? 'pass' : 'fail',
    failures.length === 0 ? `all ${cases.length} cases record an origin that resolves` : `${failures.length} case(s) record an origin that does not resolve`,
    { failures },
  );
}

/**
 * DIVERSITY. The floor, the identifier subset, and the spread.
 *
 * The floors adapt DOWNWARD only where the repo genuinely cannot supply more: a brain
 * with two unit types cannot spread across three. That adaptation is reported in the
 * detail line, so a relaxed floor is visible rather than silent.
 *
 * Mutation that kills it: hand it 24 cases, or a set with four identifier cases.
 */
export function diversityGate(cases, { unitsById, floors = DEFAULT_FLOORS, availableTypes = null, availableAreas = null }) {
  const active = cases.filter((entry) => !entry.retired);
  const answerTypes = new Set();
  const answerAreas = new Set();
  for (const entry of active) {
    for (const id of entry.must_return) {
      const unit = unitsById.get(id);
      if (!unit) continue;
      answerTypes.add(unit.type);
      answerAreas.add(unit.meta?.area || 'unknown');
    }
  }
  const identifiers = active.filter((entry) => entry.identifier).length;
  const typeFloor = Math.min(floors.minimumTypes, availableTypes ?? floors.minimumTypes);
  const areaFloor = Math.min(floors.minimumAreas, availableAreas ?? floors.minimumAreas);

  const failures = [];
  if (active.length < floors.minimumCases) {
    failures.push({ check: 'count', got: active.length, floor: floors.minimumCases });
  }
  const identifierFloor = identifierFloorFor(active.length, floors);
  if (identifiers < identifierFloor) {
    failures.push({ check: 'identifier-cases', got: identifiers, floor: identifierFloor });
  }
  if (answerTypes.size < typeFloor) {
    failures.push({ check: 'types', got: answerTypes.size, floor: typeFloor });
  }
  if (answerAreas.size < areaFloor) {
    failures.push({ check: 'areas', got: answerAreas.size, floor: areaFloor });
  }
  const relaxed = [
    typeFloor < floors.minimumTypes ? `type floor relaxed to ${typeFloor}: the brain only has ${availableTypes} types` : null,
    areaFloor < floors.minimumAreas ? `area floor relaxed to ${areaFloor}: the brain only has ${availableAreas} areas` : null,
  ].filter(Boolean);

  // EACH FAILING CHECK NAMES ITS FLOOR. "2 active cases" tells a reader what was counted
  // and not what was required, and the owner's field test failed on exactly that: the
  // number was there and the bar was not, so the message stated a conclusion the reader
  // could not check. Passing counts stay bare, because a floor beside a number that
  // cleared it is noise.
  const shortfalls = failures.map(({ check, got, floor }) => `${check} ${got}, minimum ${floor}`);
  return gate(
    'diversity',
    failures.length === 0 ? 'pass' : 'fail',
    (failures.length
      ? `${shortfalls.join('; ')} (of ${active.length} active cases, ${identifiers} identifier, ${answerTypes.size} types, ${answerAreas.size} areas)`
      : `${active.length} active cases, ${identifiers} identifier, ${answerTypes.size} types, ${answerAreas.size} areas`)
      + (relaxed.length ? ` (${relaxed.join('; ')})` : ''),
    {
      failures,
      counts: { cases: active.length, identifiers, types: [...answerTypes].sort(), areas: [...answerAreas].sort() },
    },
  );
}

/**
 * Run every gate. The gold set may measure only if this returns passed: true.
 *
 * @param {object[]} cases
 * @param {object} context store, units, files, commits, symbols, floors, date
 * @returns {Promise<{ passed: boolean, gates: object[], cases: object[], active: object[], retired: object[] }>}
 */
export async function runGoldsetGates(cases, {
  store,
  units = [],
  files = [],
  commits = new Set(),
  symbols = null,
  floors = DEFAULT_FLOORS,
  date,
  retire = true,
} = {}) {
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const cardByArea = new Map(
    units.filter((unit) => unit.type === 'architecture' && unit.meta?.area).map((unit) => [unit.meta.area, unit]),
  );
  // Vacuous ranking constraints go first, so staleness and existence judge the same ids.
  const { cases: withLiveConstraints, pruned } = pruneVanishedConstraints(cases, { unitsById });
  const stale = findStaleCases(withLiveConstraints, { files, commits, unitsById });
  // Retirement happens BEFORE the gates so the gates judge the set that will measure.
  // Passing retire: false is how the mutation test proves the staleness gate can fail.
  const withRetirements = retire ? retireCases(withLiveConstraints, stale, { date }) : withLiveConstraints;
  const active = withRetirements.filter((entry) => !entry.retired);

  const gates = [
    await existenceGate(active, { store }),
    leakageGate(active, { unitsById }),
    stalenessGate(active, { files, commits, unitsById }),
    provenanceGate(active, { commits, symbols, unitsById, cardByArea }),
    diversityGate(withRetirements, {
      unitsById,
      floors,
      availableTypes: new Set(units.map((unit) => unit.type)).size,
      availableAreas: new Set(units.map((unit) => unit.meta?.area).filter(Boolean)).size,
    }),
  ];
  return {
    passed: gates.every((entry) => entry.status === 'pass'),
    gates,
    cases: withRetirements,
    active,
    retired: withRetirements.filter((entry) => entry.retired),
    constraintsPruned: pruned,
  };
}
