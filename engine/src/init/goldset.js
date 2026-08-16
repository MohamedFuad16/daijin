// The mechanical gold-set miner.
//
// Authorship rule from the plan, which decides everything below: "Gold sets: deterministic
// sources are code, no model. The LLM share (paraphrase queries, candidate selection)
// belongs to the AUDITOR, owner of measurement integrity. Never the student (self-authored
// tests are gaming), never the teacher (grader must not calibrate the gauge)."
//
// So this file authors cases from code alone, in the plan's trust order:
//   1. commit archaeology     a real commit touched one area; the card for that area is
//                             the artifact an engineer asking about that change should get
//   2. structural self-reference  relations the evidence already proves: a sole importer,
//                             a package used in one place, a measured convention
//   3. identifier cases       a symbol defined in exactly one file, asked as a bare token
//
// One design decision is worth stating because the easy alternative is a rubber stamp:
// candidate queries are NOT filtered for lexical overlap with their answer. Requiring a
// mined query to share tokens with the card it points at would select for cases retrieval
// can already win, and the number that came out would measure the filter rather than the
// brain. A case whose answer the scaffold never covered is supposed to MISS; that miss is
// the signal the sub-75 diagnosis path reads to recommend enrichment. A gauge that only
// asks questions it knows the answer to is not a gauge.
//
// Answers are ARTIFACTS, never prose (store.d.ts GoldCase): every must_return entry is a
// document id that must resolve in the live index, and the existence gate proves it.
import { createHash } from 'node:crypto';

import { queryTokens } from '../rag/tokens.js';
import { classifyCommit } from './git.js';
import { areaOf, compareStrings } from './walk.js';

/** Diversity floor, from the plan's authorship section. Minimum count, not a target. */
export const MINIMUM_CASES = 25;

/** One case per this many chunks, capped. The plan's "one per 20 to 25 chunks". */
export const CHUNKS_PER_CASE = 22;
export const MAXIMUM_CASES = 150;

/** Identifier cases required by the coverage gate. */
export const MINIMUM_IDENTIFIER_CASES = 5;

/** Trust order. Lower sorts first and survives the target cut first. */
export const SOURCE_TRUST = Object.freeze({
  'commit-archaeology': 0,
  structural: 1,
  identifier: 2,
});

/**
 * How many cases this brain should carry.
 *
 * Displayed with its formula, because "enough" being mechanical and visible is the plan's
 * requirement: the TUI shows points per case so a small set reads with its error bar.
 */
export function targetCaseCount(chunkCount, {
  minimum = MINIMUM_CASES, perChunks = CHUNKS_PER_CASE, maximum = MAXIMUM_CASES,
} = {}) {
  const scaled = Math.ceil(chunkCount / perChunks);
  const target = Math.min(maximum, Math.max(minimum, scaled));
  return {
    target,
    chunkCount,
    formula: `max(${minimum}, ceil(${chunkCount} chunks / ${perChunks})) capped at ${maximum} = ${target}`,
    scaled,
    minimum,
    maximum,
  };
}

/**
 * A case's stable identity, written once at mining time and never recomputed for a case
 * that already carries one.
 *
 * NOT the id: ids are positional (g001, g002) and are reassigned on every mining run, so
 * they cannot survive a re-mine. NOT the query either, because the query is the field a
 * user edits, and an identity that changes when a user rewords a question turns their edit
 * into a duplicate case. The key binds the provenance (where the case came from) to the
 * CANONICAL query the miner produced, so re-mining the same fact reproduces the same key
 * while a user's rewording leaves it alone.
 */
export function caseKey(provenance, canonicalQuery) {
  const digest = createHash('sha256').update(`${canonicalQuery}`, 'utf8').digest('hex').slice(0, 8);
  return `${provenance}#${digest}`;
}

function normalizeQuery(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Clean a commit subject into a query.
 *
 * Conventional-commit prefixes and issue trailers are removed because they are repo
 * bookkeeping rather than the engineer's question, and a query beginning "feat(store):"
 * measures how well retrieval handles punctuation.
 */
export function subjectToQuery(subject) {
  return normalizeQuery(
    String(subject)
      .replace(/^\s*(feat|fix|chore|docs|refactor|test|perf|build|ci|style|revert)(\([^)]*\))?!?:\s*/i, '')
      .replace(/\(#\d+\)\s*$/, '')
      .replace(/^\[[^\]]+\]\s*/, ''),
  );
}

function candidate({ query, mustReturn, why, provenance, source, identifier = false, mustNotOutrank = [], target }) {
  return {
    query: normalizeQuery(query),
    must_return: [...new Set(mustReturn)],
    must_not_outrank: [...new Set(mustNotOutrank)].filter((id) => !mustReturn.includes(id)),
    identifier,
    provenance,
    source,
    why,
    target,
  };
}

// ---------------------------------------------------------------------------------
// Source 1: commit archaeology
// ---------------------------------------------------------------------------------

/**
 * The deterministic filter, applied before anything is proposed.
 *
 * The plan's funnel: "(1) deterministic filter drops renames, format-only, lockfile-only,
 * docs-only, out-of-scope commits". A commit that survives touches real source in exactly
 * one area, which is what makes a single card the correct answer rather than a guess
 * among several.
 */
export function commitCases(history, { cardByArea, minimumSubjectTokens = 3 } = {}) {
  if (!history?.available) return [];
  const cases = [];
  for (const commit of history.commits) {
    const kind = classifyCommit(commit);
    if (kind.revert || kind.docsOnly || kind.lockfileOnly || kind.renameOnly || kind.binaryOnly || kind.empty) continue;
    const areas = [...new Set(commit.files.map((file) => areaOf(file.path)))];
    if (areas.length !== 1) continue;
    const card = cardByArea.get(areas[0]);
    if (!card) continue;
    const query = subjectToQuery(commit.subject);
    // A subject of one or two words ("cleanup", "wip") is not a question anyone would ask
    // and cannot be judged; it is dropped rather than padded into one.
    if (queryTokens(query).length < minimumSubjectTokens) continue;
    cases.push(candidate({
      query,
      mustReturn: [card.id],
      why: `Commit ${commit.shortSha} changed only ${areas[0]}, so an engineer asking about that work should receive the ${areas[0]} module card.`,
      provenance: `commit-archaeology:${commit.shortSha}`,
      source: 'commit-archaeology',
      target: { kind: 'commit', sha: commit.shortSha, area: areas[0] },
    }));
  }
  return cases;
}

// ---------------------------------------------------------------------------------
// Source 2: structural self-reference
// ---------------------------------------------------------------------------------

/**
 * Relations the evidence already proves, turned into questions.
 *
 * Every generator here requires UNIQUENESS before it emits: a sole importer, a package
 * used in one area, a convention with one card. A question with two correct answers
 * scores as a miss against whichever one it did not name, which would make the metric
 * report a retrieval failure that is really an authoring failure.
 */
export function structuralCases(evidence, { cardByArea, unitsById }) {
  const cases = [];

  const importersOf = new Map();
  for (const area of evidence.areas) {
    for (const target of area.importsOut) {
      const list = importersOf.get(target.name) || [];
      list.push(area.area);
      importersOf.set(target.name, list);
    }
  }
  for (const [target, importers] of [...importersOf.entries()].sort()) {
    if (importers.length !== 1) continue;
    const card = cardByArea.get(importers[0]);
    const targetCard = cardByArea.get(target);
    if (!card || !targetCard) continue;
    cases.push(candidate({
      query: `which part of this codebase depends on ${target}`,
      mustReturn: [card.id],
      why: `${importers[0]} is the only area importing ${target}, measured from the import graph.`,
      provenance: `structural:sole-importer:${target}`,
      source: 'structural',
      // The imported area is the plausible wrong answer: it is the one lexically nearest
      // the query. must_not_outrank keeps the ranking honest where confusion exists.
      mustNotOutrank: [targetCard.id],
      target: { kind: 'area', area: importers[0] },
    }));
  }

  // Packages and built-ins are asked about separately, and the wording follows the fact:
  // node:fs is a built-in MODULE, not a third-party package, and a gold case that calls it
  // one teaches the reader something false while measuring retrieval.
  for (const [label, key] of [['package', 'external'], ['built-in module', 'builtins']]) {
    const areaOfDependency = new Map();
    for (const area of evidence.areas) {
      for (const dependency of area[key] || []) {
        const list = areaOfDependency.get(dependency.name) || [];
        list.push(area.area);
        areaOfDependency.set(dependency.name, list);
      }
    }
    for (const [name, areas] of [...areaOfDependency.entries()].sort()) {
      if (areas.length !== 1) continue;
      const card = cardByArea.get(areas[0]);
      if (!card) continue;
      cases.push(candidate({
        query: `where is the ${name} ${label} used`,
        mustReturn: [card.id],
        why: `${name} is imported only from ${areas[0]}, measured from the import graph.`,
        provenance: `structural:sole-consumer:${name}`,
        source: 'structural',
        target: { kind: 'area', area: areas[0] },
      }));
    }
  }

  // Conventions and history. These carry the TYPE spread the diversity gate requires:
  // without them every answer is an architecture card and the gauge measures one class.
  const conventionQueries = [
    ['indentation', 'how is code indented in this repo'],
    ['quotes', 'single or double quotes for strings here'],
    ['semicolons', 'are semicolons used at the end of statements'],
    ['moduleSystem', 'does this project use ES modules or CommonJS'],
    ['fileNaming', 'how are source files named in this project'],
    ['test-layout', 'where do the tests live'],
  ];
  for (const [key, query] of conventionQueries) {
    const id = `daijin.convention.${key === 'test-layout' ? 'test-layout' : key.toLowerCase()}`;
    if (!unitsById.has(id)) continue;
    cases.push(candidate({
      query,
      mustReturn: [id],
      why: `The ${key} convention is measured statistically and written up as one card, so this question has exactly one answer.`,
      provenance: `structural:convention:${key}`,
      source: 'structural',
      target: { kind: 'unit', id },
    }));
  }

  const historyId = 'daijin.workflow.history';
  if (unitsById.has(historyId)) {
    for (const query of ['which files change most often in this repo', 'who has been changing this codebase']) {
      cases.push(candidate({
        query,
        mustReturn: [historyId],
        why: 'Change frequency and authorship are measured in one history card, so this question has exactly one answer.',
        provenance: 'structural:history',
        source: 'structural',
        target: { kind: 'unit', id: historyId },
      }));
    }
  }

  const dependencyId = 'daijin.architecture.dependencies';
  if (unitsById.has(dependencyId)) {
    cases.push(candidate({
      query: 'which third party dependencies does this project declare',
      mustReturn: [dependencyId],
      why: 'The dependency census is one card crossing the manifests with the import graph.',
      provenance: 'structural:dependencies',
      source: 'structural',
      target: { kind: 'unit', id: dependencyId },
    }));
  }

  return cases;
}

// ---------------------------------------------------------------------------------
// Source 3: identifier cases
// ---------------------------------------------------------------------------------

/**
 * Bare-token queries for symbols defined in exactly one file.
 *
 * These are the platform's identifier cases and they measure something the semantic arm
 * cannot: an exact token an engineer types verbatim. The sibling areas sharing a path
 * prefix are the plausible wrong answers, so they go into must_not_outrank, which is a
 * RANKING constraint (D-0005) and not an exclusion.
 */
export function identifierCases(evidence, { cardByArea, limit = 60 }) {
  const cases = [];
  for (const symbol of evidence.symbols.unique) {
    const area = areaOf(symbol.file);
    const card = cardByArea.get(area);
    if (!card) continue;
    const prefix = area.split('/')[0];
    const siblings = [...cardByArea.entries()]
      .filter(([name]) => name !== area && name.split('/')[0] === prefix)
      .slice(0, 2)
      .map(([, sibling]) => sibling.id);
    cases.push(candidate({
      query: symbol.name,
      mustReturn: [card.id],
      why: `${symbol.name} is defined in exactly one file (${symbol.file}), so the card for ${area} is the only correct answer to the bare token.`,
      provenance: `identifier:${symbol.name}`,
      source: 'identifier',
      identifier: true,
      mustNotOutrank: siblings,
      target: { kind: 'symbol', name: symbol.name, file: symbol.file, area },
    }));
    if (cases.length >= limit) break;
  }
  return cases;
}

// ---------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------

function dedupe(cases) {
  const seen = new Set();
  const kept = [];
  for (const entry of cases) {
    const key = `${entry.query.toLowerCase()}::${[...entry.must_return].sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

/**
 * Cut the candidate pool down to the target, keeping the spread the gates demand.
 *
 * Round-robin over ANSWER, not over source, so a repo whose history is one hot module
 * cannot fill the whole set with cases pointing at a single card. Identifier cases are
 * seated first up to their quota because the coverage gate requires at least five of
 * them and they are the scarcest class in a small repo.
 */
export function selectCases(candidates, { target, identifierQuota = MINIMUM_IDENTIFIER_CASES }) {
  const pool = dedupe(candidates);
  const chosen = [];
  const takenPerAnswer = new Map();
  const take = (entry) => {
    const key = entry.must_return.join(',');
    takenPerAnswer.set(key, (takenPerAnswer.get(key) || 0) + 1);
    chosen.push(entry);
  };

  const identifiers = pool.filter((entry) => entry.identifier);
  for (const entry of identifiers.slice(0, identifierQuota)) take(entry);

  const rest = pool
    .filter((entry) => !chosen.includes(entry))
    .sort((left, right) => SOURCE_TRUST[left.source] - SOURCE_TRUST[right.source]
      || compareStrings(left.provenance, right.provenance)
      || compareStrings(left.query, right.query));

  // Widening passes: one case per answer, then two, and so on. The set stays spread at
  // every size instead of being spread only if the target happens to be large.
  //
  // The ramp runs to a computed BOUND rather than stopping at the first pass that adds
  // nothing. Found live on the P3 target, 2026-08-16: the identifier quota had already
  // seated four cases on one card, so every pass from allowance 1 to 4 skipped that card's
  // ten remaining candidates, the pass at 4 added nothing, and a no-progress break ended
  // selection at 19 of 29 available cases. The gauge came out ten cases smaller than the
  // evidence supported and then failed its own diversity floor for a reason that was mine
  // and not the repo's. The bound is the largest an allowance could ever need to be: the
  // most any answer was seated, plus the most candidates any answer has.
  const candidatesPerAnswer = new Map();
  for (const entry of rest) {
    const key = entry.must_return.join(',');
    candidatesPerAnswer.set(key, (candidatesPerAnswer.get(key) || 0) + 1);
  }
  const maxAllowance = Math.max(0, ...takenPerAnswer.values())
    + Math.max(0, ...candidatesPerAnswer.values());
  const taken = new Set(chosen);
  for (let allowance = 1; chosen.length < target && allowance <= maxAllowance; allowance += 1) {
    for (const entry of rest) {
      if (chosen.length >= target) break;
      if (taken.has(entry)) continue;
      const key = entry.must_return.join(',');
      if ((takenPerAnswer.get(key) || 0) >= allowance) continue;
      take(entry);
      taken.add(entry);
    }
  }

  return chosen.sort(
    (left, right) => SOURCE_TRUST[left.source] - SOURCE_TRUST[right.source]
      || compareStrings(left.provenance, right.provenance)
      || compareStrings(left.query, right.query),
  );
}

/**
 * Mine a gold set from the evidence and the generated units.
 *
 * @returns {{ cases: object[], target: object, pool: object, notes: string[] }}
 */
export function mineGoldset({
  evidence, units, chunkCount, history = null, identifierQuota = MINIMUM_IDENTIFIER_CASES,
} = {}) {
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const cardByArea = new Map(
    units.filter((unit) => unit.type === 'architecture' && unit.meta?.area).map((unit) => [unit.meta.area, unit]),
  );
  const sizing = targetCaseCount(chunkCount);

  // The RAW history walk, not the stats table: commit archaeology needs each commit's
  // subject and file list, and historyStats deliberately reduces those to counts.
  const fromCommits = commitCases(history, { cardByArea });
  const fromStructure = structuralCases(evidence, { cardByArea, unitsById });
  const fromIdentifiers = identifierCases(evidence, { cardByArea, limit: Math.max(identifierQuota * 4, 40) });

  const selected = selectCases([...fromCommits, ...fromStructure, ...fromIdentifiers], {
    target: sizing.target, identifierQuota,
  });
  const cases = selected.map((entry, index) => ({
    id: `g${String(index + 1).padStart(3, '0')}`,
    key: caseKey(entry.provenance, entry.query),
    query: entry.query,
    must_return: entry.must_return,
    ...(entry.must_not_outrank.length ? { must_not_outrank: entry.must_not_outrank } : {}),
    ...(entry.identifier ? { identifier: true } : {}),
    provenance: entry.provenance,
    source: entry.source,
    why: entry.why,
    target: entry.target,
  }));

  const notes = [];
  if (cases.length < sizing.target) {
    notes.push(
      `Mined ${cases.length} cases against a target of ${sizing.target} (${sizing.formula}). `
      + 'The shortfall is reported rather than padded: a case invented to reach a count measures nothing.',
    );
  }
  return {
    cases,
    target: sizing,
    pool: {
      'commit-archaeology': fromCommits.length,
      structural: fromStructure.length,
      identifier: fromIdentifiers.length,
      afterDedupe: dedupe([...fromCommits, ...fromStructure, ...fromIdentifiers]).length,
    },
    notes,
  };
}
