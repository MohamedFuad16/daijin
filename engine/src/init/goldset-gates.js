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

export const DEFAULT_FLOORS = Object.freeze({
  minimumCases: 25,
  minimumIdentifierCases: 5,
  minimumTypes: 3,
  minimumAreas: 3,
});

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
 * Word-like tokens only.
 *
 * The content tokenizer emits lone symbols as tokens, which is right for a token BUDGET
 * and wrong for a leakage measure: leakage is about copied prose, and punctuation is not
 * prose. Found live on the P3 target, 2026-08-16: the query "where is the
 * @vitejs/plugin-react package used" tripped the six-token threshold because the package
 * name alone tokenizes to `@ vitejs / plugin - react`, three of which are punctuation. A
 * single identifier is not a quotation, and a gate that says it is will be turned off.
 */
function wordTokens(text) {
  return tokens(text).filter((token) => /[\p{L}\p{N}_]/u.test(token));
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
      const shared = longestSharedSpan(entry.query, unit.content);
      const queryTokenCount = tokens(entry.query).length;
      const contained = queryTokenCount >= LEAKAGE_MIN_QUERY_TOKENS
        && unit.content.toLowerCase().replace(/\s+/g, ' ').includes(entry.query.toLowerCase().replace(/\s+/g, ' '));
      if (shared >= span || contained) {
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

const PROVENANCE_PATTERN = /^(commit-archaeology|structural|identifier|paraphrase:auditor):(.+)$/;

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
  if (identifiers < floors.minimumIdentifierCases) {
    failures.push({ check: 'identifier-cases', got: identifiers, floor: floors.minimumIdentifierCases });
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

  return gate(
    'diversity',
    failures.length === 0 ? 'pass' : 'fail',
    `${active.length} active cases, ${identifiers} identifier, ${answerTypes.size} types, ${answerAreas.size} areas`
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
  const stale = findStaleCases(cases, { files, commits, unitsById });
  // Retirement happens BEFORE the gates so the gates judge the set that will measure.
  // Passing retire: false is how the mutation test proves the staleness gate can fail.
  const withRetirements = retire ? retireCases(cases, stale, { date }) : cases;
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
  };
}
