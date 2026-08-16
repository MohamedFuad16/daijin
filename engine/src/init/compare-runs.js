// Diff two retrieval-score records case by case.
//
// A summary that merely LOOKS close is not parity. Two runs can land on the same case
// rate while disagreeing about which cases passed, and that is precisely the kind of
// divergence a headline number hides. This compares per case: hits, completeness,
// reciprocal rank, the miss list, and the violation list.
//
// Used twice: to prove the extracted engine reproduces the platform's floor (P1), and to
// A and B the SQLite adapter against pgvector on the same corpus (P2).
import { readFile } from 'node:fs/promises';
import process from 'node:process';

// Scalar per-case fields, compared by value with `!==`.
//
// `misses` and `violations` are NOT here, and their absence is deliberate rather than an
// omission: they are ARRAYS, so `!==` would compare identity and report every case as
// different ([] !== [] is true). They are compared just below, by value, through listDiff.
// Read this list on its own and it looks one field short, which is a misread that has
// happened once already; test/retrieval-score.test.js pins the real behaviour.
const FIELDS = ['hits', 'required', 'complete', 'reciprocalRank', 'identifier', 'standingAssisted'];

function indexResults(record) {
  const results = record.results || record;
  if (!Array.isArray(results)) throw new Error('record has no results array.');
  return new Map(results.map((item) => [item.id, item]));
}

function listDiff(left = [], right = []) {
  const a = [...left].sort();
  const b = [...right].sort();
  return JSON.stringify(a) === JSON.stringify(b) ? null : { left: a, right: b };
}

export function compareRecords(leftRecord, rightRecord) {
  const left = indexResults(leftRecord);
  const right = indexResults(rightRecord);
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
  const differences = [];
  for (const id of ids) {
    const a = left.get(id);
    const b = right.get(id);
    if (!a || !b) {
      differences.push({ id, kind: 'missing-case', inLeft: Boolean(a), inRight: Boolean(b) });
      continue;
    }
    for (const field of FIELDS) {
      if (a[field] !== b[field]) differences.push({ id, kind: 'field', field, left: a[field], right: b[field] });
    }
    const misses = listDiff(a.misses, b.misses);
    if (misses) differences.push({ id, kind: 'misses', ...misses });
    const violations = listDiff(
      (a.violations || []).map((item) => `${item.id}@${item.rank}`),
      (b.violations || []).map((item) => `${item.id}@${item.rank}`),
    );
    if (violations) differences.push({ id, kind: 'violations', ...violations });
  }
  const summaryFields = ['cases', 'hitRate', 'caseRate', 'mrr', 'identifierCaseRate', 'identifierCases',
    'standingAssistedCases', 'rankedOnlyCaseRate', 'violations'];
  const summaryDifferences = summaryFields
    .filter((field) => leftRecord.summary?.[field] !== rightRecord.summary?.[field])
    .map((field) => ({ field, left: leftRecord.summary?.[field], right: rightRecord.summary?.[field] }));
  return {
    cases: ids.length,
    differences,
    summaryDifferences,
    retrievalDifferences: compareDiagnostics(leftRecord, rightRecord),
    identical: differences.length === 0 && summaryDifferences.length === 0,
  };
}

const DIAGNOSTIC_FIELDS = ['inferredArea', 'tokenCount', 'truncated'];

/// Compare what RETRIEVAL did, not what scoring made of it.
///
/// Two runs can return different documents and still agree on every scored field, because
/// scoreCase reduces a retrieval to hits and ranks. That is not hypothetical: switching the
/// pgvector document inventory between the platform's unordered statement and the shipped
/// ORDER BY d.id changes the retrieved set on three of the 34 platform gold cases while
/// changing only ONE scored row. A differ that reads only `results` reports that as a
/// single-case difference and misses the other two.
///
/// Reported SEPARATELY from `identical`, and skipped when either record predates
/// diagnostics, so a comparison against another engine's record (the platform's, which has
/// no diagnostics block) still works and still means what it meant.
export function compareDiagnostics(leftRecord, rightRecord) {
  if (!Array.isArray(leftRecord.diagnostics) || !Array.isArray(rightRecord.diagnostics)) {
    return { comparable: false, reason: 'one or both records carry no diagnostics block', differences: [] };
  }
  const left = new Map(leftRecord.diagnostics.map((item) => [item.id, item]));
  const right = new Map(rightRecord.diagnostics.map((item) => [item.id, item]));
  const differences = [];
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(id);
    const b = right.get(id);
    if (!a || !b) {
      differences.push({ id, kind: 'missing-case', inLeft: Boolean(a), inRight: Boolean(b) });
      continue;
    }
    for (const field of DIAGNOSTIC_FIELDS) {
      if (a[field] !== b[field]) differences.push({ id, kind: 'field', field, left: a[field], right: b[field] });
    }
    // Order matters here: retrievedIds is what the engineer receives, in the order they
    // receive it, so a reordering is a real difference even when the set is equal.
    const leftIds = (a.retrievedIds || []).join('|');
    const rightIds = (b.retrievedIds || []).join('|');
    if (leftIds !== rightIds) {
      differences.push({ id, kind: 'retrievedIds', left: a.retrievedIds, right: b.retrievedIds });
    }
  }
  return { comparable: true, differences };
}

async function main() {
  const [leftPath, rightPath] = process.argv.slice(2);
  if (!leftPath || !rightPath) throw new Error('usage: compare-runs.js <left.json> <right.json>');
  const left = JSON.parse(await readFile(leftPath, 'utf8'));
  const right = JSON.parse(await readFile(rightPath, 'utf8'));
  const report = compareRecords(left, right);
  console.log(`compared ${report.cases} cases`);
  const retrieval = report.retrievalDifferences;
  if (report.identical) {
    console.log('IDENTICAL: every case and every summary field matches.');
    // A scored match is not a retrieval match. Say which one was actually checked, so
    // "IDENTICAL" is never read as a stronger claim than the records could support.
    if (!retrieval.comparable) console.log(`  (retrieval-level comparison skipped: ${retrieval.reason})`);
    else if (retrieval.differences.length === 0) console.log('  retrieval-level: identical too (inferredArea, tokens, retrieved ids and their order)');
    else {
      console.log(`  BUT retrieval differs on ${retrieval.differences.length} point(s) while every SCORE matched:`);
      for (const item of retrieval.differences) {
        console.log(`    ${item.id} ${item.kind}${item.field ? ` ${item.field}` : ''}: ${JSON.stringify(item.left)} vs ${JSON.stringify(item.right)}`);
      }
      process.exitCode = 1;
    }
    return report;
  }
  for (const item of report.summaryDifferences) {
    console.log(`  summary ${item.field}: ${JSON.stringify(item.left)} vs ${JSON.stringify(item.right)}`);
  }
  for (const item of report.differences) {
    console.log(`  ${item.id} ${item.kind}${item.field ? ` ${item.field}` : ''}: ${JSON.stringify(item.left)} vs ${JSON.stringify(item.right)}`);
  }
  process.exitCode = 1;
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
