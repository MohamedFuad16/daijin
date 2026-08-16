// `npm run retrieval-score`: the mechanical measure of SELECT quality.
//
// Ported from the platform (platform/rag/retrieval-score.js). Same metrics, same floor
// judgement, same zero slack; the differences are that a corpus descriptor supplies the
// gold set, the fixes and the baseline, and that retrieval runs over a Store rather than
// a Postgres client.
//
// Runs every case in the corpus gold set through the DEFAULT retrieval path (no type
// filter, the same path a real engineer task takes) and reports:
//
//   hit rate   fraction of required documents that came back at all
//   case rate  fraction of cases where EVERY required document came back
//   MRR        mean reciprocal rank of the first required document
//   violations a `must_not_outrank` document that beat a required one
//
// Why case rate as well as hit rate: a case asking for two documents that returns only
// one is not half useful to an engineer, it is a partial answer that reads as complete.
// Case rate is the honest headline; hit rate shows how close the misses are.
//
// Every id in the gold set is checked against the live index BEFORE scoring, so a renamed
// or mistyped document fails loudly instead of quietly counting as a miss and making
// retrieval look worse than it is.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { retrieve } from '../rag/retrieve.js';
import { isStandingId } from '../rag/standing.js';
import { createPgVectorStore } from '../store/pgvector.js';
import {
  loadBaseline, loadCorpus, loadCorpusByName, loadCorpusEnvironment, loadCorpusEnvironmentSoft, loadGoldset, loadRetrievalFixes,
} from './corpus.js';

function parseArgs(argv) {
  const value = (flag) => {
    const found = argv.find((entry) => entry.startsWith(`${flag}=`));
    return found ? found.slice(flag.length + 1) : null;
  };
  const k = value('--k');
  const only = value('--only');
  return {
    json: argv.includes('--json'),
    corpus: value('--corpus'),
    corpusFile: value('--corpus-file'),
    k: k ? Number(k) : 8,
    only: only ? only.split(',').map((entry) => entry.trim()).filter(Boolean) : null,
    // A run counts toward the reported trend ONLY when it is explicitly marked as a
    // shipped configuration. The same quarantine the exam ledger applies to harness debug
    // runs: on the night the platform built this metric, three of its five runs were per
    // candidate cap experiments that were measured and deliberately NOT shipped, and
    // plotting those as history would invent progress that never landed.
    shipped: argv.includes('--shipped'),
    label: value('--label'),
    // Opt in on purpose. Ad hoc measurement must stay a measurement: turning every
    // exploratory run into a tripwire is how people stop running the instrument. The write
    // paths pass it; a human asking "where are we?" does not.
    enforce: argv.includes('--enforce'),
    out: value('--out'),
  };
}

/// Judge the summary against the committed baseline.
///
/// WHY caseRate AND violations, BUT NOT mrr
/// During the one regression the platform has measured (2026-08-09) case rate FELL from
/// 79.4 to 76.5 while MRR ROSE from 0.606 to 0.621. An MRR floor passes that event.
/// Worse, MRR is the number a pin can buy directly: a pin that moves a document from rank
/// 3 to rank 1 on a case that passed either way raises MRR and helps nobody, so flooring
/// it would reward the behaviour ADR-0150 exists to stop. MRR is reported as movement,
/// never as a gate. `rankedOnlyCaseRate` is likewise reported and not floored: its
/// denominator (cases minus the standing assisted ones) is too thin to gate on.
///
/// WHY ZERO SLACK
/// One gold case is 2.9 points at n=34, and the 2026-08-09 regression WAS one case. Any
/// tolerance band sized to absorb a single case is blind to the only regression on record.
/// Zero slack is only safe because the baseline holds the EXACT measured value: case rate
/// is quantised to k/n, so nothing can land between 0.794 and the stored 0.7941176. A
/// floor typed from the rounded display would sit above the measurement it came from.
export function floorBreaches(summary, baseline) {
  const breaches = [];
  if (summary.caseRate < baseline.caseRate) {
    breaches.push(`case rate ${(summary.caseRate * 100).toFixed(1)}% is below the floor of ${(baseline.caseRate * 100).toFixed(1)}%`);
  }
  if (summary.violations > baseline.violations) {
    breaches.push(`${summary.violations} must-not violation(s) against a floor of ${baseline.violations}`);
  }
  return breaches;
}

export function validateGoldset(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('gold set is empty.');
  const seen = new Set();
  for (const entry of cases) {
    if (!entry?.id || typeof entry.id !== 'string') throw new Error('every gold-set case needs a string id.');
    if (seen.has(entry.id)) throw new Error(`duplicate gold-set id: ${entry.id}`);
    seen.add(entry.id);
    if (!entry.query?.trim()) throw new Error(`${entry.id}: query is required.`);
    if (!Array.isArray(entry.must_return) || entry.must_return.length === 0) {
      throw new Error(`${entry.id}: must_return needs at least one document id.`);
    }
    if (entry.must_not_outrank && !Array.isArray(entry.must_not_outrank)) {
      throw new Error(`${entry.id}: must_not_outrank must be a list.`);
    }
    if (!entry.why?.trim()) throw new Error(`${entry.id}: why is required, a case with no reason cannot be judged later.`);
  }
  return cases;
}

/// Reject ids that are not in the index. A gold set that references a renamed document
/// silently reports a regression that does not exist.
export async function assertIdsExist(store, cases) {
  const referenced = [...new Set(cases.flatMap((entry) => [...entry.must_return, ...(entry.must_not_outrank || [])]))];
  const known = new Set(await store.existingDocumentIds(referenced));
  const missing = referenced.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(`gold set references ${missing.length} document(s) that are not indexed:\n  ${missing.join('\n  ')}`);
  }
}

/// `retrievedIds` is what the engineer actually receives, standing units included, so it
/// is what the headline scores. `standingAssisted` records separately whether a case owes
/// any of its required documents to pinning rather than to ranking: without that flag a
/// pinning change would read as a ranking improvement it never made.
export function scoreCase(entry, retrievedIds, standingPrefix) {
  const rankOf = (id) => {
    const index = retrievedIds.indexOf(id);
    return index === -1 ? null : index + 1;
  };
  const required = entry.must_return.map((id) => ({ id, rank: rankOf(id) }));
  const found = required.filter((item) => item.rank !== null);
  const bestRequiredRank = found.length ? Math.min(...found.map((item) => item.rank)) : null;
  const violations = (entry.must_not_outrank || [])
    .map((id) => ({ id, rank: rankOf(id) }))
    .filter((item) => item.rank !== null && (bestRequiredRank === null || item.rank < bestRequiredRank));
  return {
    id: entry.id,
    identifier: Boolean(entry.identifier),
    standingAssisted: entry.must_return.some((id) => isStandingId(id, standingPrefix)),
    hits: found.length,
    required: required.length,
    complete: found.length === required.length,
    reciprocalRank: bestRequiredRank ? 1 / bestRequiredRank : 0,
    misses: required.filter((item) => item.rank === null).map((item) => item.id),
    violations,
  };
}

export function summarise(results) {
  const totalRequired = results.reduce((sum, item) => sum + item.required, 0);
  const totalHits = results.reduce((sum, item) => sum + item.hits, 0);
  const identifierCases = results.filter((item) => item.identifier);
  const standingCases = results.filter((item) => item.standingAssisted);
  const complete = (rows) => (rows.length ? rows.filter((item) => item.complete).length / rows.length : 0);
  return {
    cases: results.length,
    hitRate: totalRequired ? totalHits / totalRequired : 0,
    caseRate: complete(results),
    mrr: results.length ? results.reduce((sum, item) => sum + item.reciprocalRank, 0) / results.length : 0,
    identifierCaseRate: complete(identifierCases),
    identifierCases: identifierCases.length,
    // Cases whose answer is a standing unit. These are guaranteed by pinning, so the rate
    // below shows what ranking alone is achieving on everything else.
    standingAssistedCases: standingCases.length,
    rankedOnlyCaseRate: complete(results.filter((item) => !item.standingAssisted)),
    violations: results.reduce((sum, item) => sum + item.violations.length, 0),
  };
}

const pct = (value) => `${(value * 100).toFixed(1)}%`;

/// Score the gold set and record the run. Extracted so any write path measures with
/// exactly the code the CLI measures with: a gate scoring by its own private copy of the
/// metric would drift from the number everyone quotes.
export async function scoreGoldset({
  corpus, k = 8, only = null, shipped = false, label = null, retrieveOptions = {}, store: injectedStore = null,
  environment: injectedEnvironment = null, fetchImpl = null, reranker = null,
} = {}) {
  const cases = validateGoldset(await loadGoldset(corpus))
    .filter((entry) => !only || only.includes(entry.id));
  // THREE WAYS TO GET AN ENVIRONMENT, narrowest first.
  //
  // A caller that supplies one is believed and nothing global is touched: no dotenv load,
  // no process.env read, no connection string demanded. That is the path the RPC surface
  // and the init pipeline take, because a repo's own sqlite brain has no DATABASE_URL and
  // never will, and its embedder identity comes from the index rather than the shell.
  //
  // Threading it here rather than leaving callers to arrange process.env is not tidiness:
  // init-miner was carrying a sentinel variable and a lend-and-restore of the EMBEDDING_
  // keys to work around this function reaching for globals, and a lend-and-restore is a
  // race the moment two measurements overlap.
  const { databaseUrl, environment } = injectedEnvironment
    ? { databaseUrl: null, environment: injectedEnvironment }
    : injectedStore
      ? { databaseUrl: null, environment: loadCorpusEnvironmentSoft(corpus) }
      : loadCorpusEnvironment(corpus);
  const retrievalFixes = await loadRetrievalFixes(corpus);

  // One connection for all cases: dozens of queries each opening their own would dominate
  // the runtime and tell us nothing about retrieval.
  const store = injectedStore || createPgVectorStore({
    connectionString: databaseUrl,
    applicationName: 'daijin-retrieval-score',
    project: corpus.project,
    ...corpus.storeOptions,
  });
  const results = [];
  // Per case retrieval facts that SCORING does not see.
  //
  // Verifier finding, 2026-08-16: a claim about inferredArea could not be checked against a
  // score record, because scoreCase reduces a retrieval to hits and ranks and throws the
  // rest away. Two runs can differ in which documents came back while agreeing on every
  // scored field, so a record that carries only scores cannot answer "did retrieval
  // change?", only "did the SCORE change?". These are recorded alongside, never mixed into
  // `results`, so the scoring surface and the per-case differ stay exactly as they were.
  const diagnostics = [];
  let embedding = null;
  try {
    await assertIdsExist(store, cases);
    for (const entry of cases) {
      // Default path on purpose: no `types`, so this measures what an engineer task
      // actually receives, including the evaluation exclusion.
      const result = await retrieve(
        { query: entry.query, project: corpus.project, k, ...corpus.retrieveOptions, ...retrieveOptions },
        {
          store,
          environment,
          // Threaded so a caller can drive retrieval against its own embedder client
          // without reaching into globals. Undefined leaves retrieve on its default.
          ...(fetchImpl ? { fetchImpl } : {}),
          // The rerank backend for an A/B. It does nothing unless the run also passes
          // `rerank: { enabled: true }` in retrieveOptions, so an A arm and a B arm differ
          // by one option rather than by which dependencies were wired.
          ...(reranker ? { reranker } : {}),
          retrievalFixes,
          pathGrammar: corpus.pathGrammar,
          standingPrefix: corpus.standingPrefix,
        },
      );
      results.push(scoreCase(entry, result.meta.retrievedIds, corpus.standingPrefix));
      embedding = result.meta.embedding;
      diagnostics.push({
        id: entry.id,
        inferredArea: result.meta.inferredArea,
        tokenCount: result.meta.tokenCount,
        truncated: result.meta.truncated,
        retrievedIds: result.meta.retrievedIds,
        rankedIds: result.meta.rankedIds,
        standingIds: result.meta.standingIds,
      });
    }
  } finally {
    if (!injectedStore) await store.close();
  }

  const summary = summarise(results);
  const record = {
    at: new Date().toISOString(),
    engine: 'daijin',
    corpus: corpus.id,
    k,
    goldsetCases: cases.length,
    shipped,
    label: label || (shipped ? 'shipped' : 'experiment'),
    // Which arm this record is. A rerank A/B whose records do not say which side they came
    // from is two numbers nobody can pair up later.
    rerank: retrieveOptions?.rerank?.enabled
      ? { enabled: true, topK: retrieveOptions.rerank.topK ?? null, backend: reranker?.id ?? null }
      : { enabled: false },
    // The embedder that produced these numbers. Every absolute threshold downstream (the
    // 0.35 semantic threshold, the 0.35 pin floor, the 0.55 reserved-slot floor) sits on
    // one embedder's similarity distribution, so a record that does not name its embedder
    // cannot be compared to another record except by assuming they shared one. Recorded so
    // identity verification is a lookup rather than an inference (verifier finding 66).
    embedding,
    // Which backend statements produced it. parityMode changes the document inventory's
    // row order, which is a measured difference, not a cosmetic one.
    store: { parityMode: Boolean(corpus.storeOptions?.parityMode) },
    summary,
    results,
    diagnostics,
  };
  return { summary, results, diagnostics, record, cases };
}

/// Measure, then judge against the committed floor. Used by every WRITE path.
export async function assertRetrievalFloor({ corpus, k = 8, label = null, context = null } = {}) {
  const { summary } = await scoreGoldset({ corpus, k, label });
  const baseline = await loadBaseline(corpus);
  if (!baseline) throw new Error(`Corpus ${corpus.id} has no committed baseline to judge against.`);
  const breaches = floorBreaches(summary, baseline);
  if (breaches.length > 0) {
    // Name what the batch just wrote. An alarm that only says "retrieval got worse" sends
    // the reader hunting; naming the writes turns it into a diagnosis.
    const wrote = context?.length ? `\nThis batch wrote: ${context.join(', ')}` : '';
    throw new Error(`Retrieval fell below the committed floor after this batch's writes:\n  ${breaches.join('\n  ')}${wrote}`);
  }
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = args.corpusFile
    ? await loadCorpus(args.corpusFile)
    : await loadCorpusByName(args.corpus || 'platform');
  const { summary, results, record, cases } = await scoreGoldset({
    corpus, k: args.k, only: args.only, shipped: args.shipped, label: args.label,
  });

  if (args.out) {
    await mkdir(path.dirname(args.out), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(record, null, 2)}\n`);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else {
    console.log(`RETRIEVAL SCORE  ·  ${corpus.id}  ·  ${cases.length} cases  ·  k=${args.k}\n`);
    for (const item of results) {
      const mark = item.violations.length ? 'VIOLATION' : item.complete ? 'ok  ' : 'MISS';
      const detail = item.violations.length
        ? `${item.violations.map((violation) => `${violation.id} outranked at #${violation.rank}`).join('; ')}`
        : item.complete ? `rank ${(1 / item.reciprocalRank).toFixed(0)}` : `missing ${item.misses.join(', ')}`;
      console.log(`  ${mark.padEnd(10)}${item.id}${item.identifier ? ' [id]' : '     '}  ${item.hits}/${item.required}  ${detail}`);
    }
    console.log('\n  -- summary --');
    console.log(`  case rate            ${pct(summary.caseRate)}   (every required doc returned)`);
    console.log(`  hit rate             ${pct(summary.hitRate)}   (${summary.cases} cases)`);
    console.log(`  MRR                  ${summary.mrr.toFixed(3)}`);
    console.log(`  identifier cases     ${pct(summary.identifierCaseRate)}   (${summary.identifierCases} exact-token queries)`);
    console.log(`  ranking alone        ${pct(summary.rankedOnlyCaseRate)}   (excludes ${summary.standingAssistedCases} cases answered by a pinned standing unit)`);
    console.log(`  must-not violations  ${summary.violations}`);
  }

  if (args.enforce) {
    const baseline = await loadBaseline(corpus);
    if (!baseline) throw new Error(`Corpus ${corpus.id} has no committed baseline to enforce.`);
    const breaches = floorBreaches(summary, baseline);
    // Movement on the unfloored numbers is reported either way, so a breach can be read
    // against what else moved rather than in isolation: MRR rose during the one regression
    // this floor exists to catch.
    if (!args.json) {
      console.log(`\n  floor ${pct(baseline.caseRate)} case rate / ${baseline.violations} violations (${baseline.measuredAt}, ${baseline.cases} cases, k=${baseline.k})`);
      console.log(`  MRR movement         ${(summary.mrr - baseline.mrr >= 0 ? '+' : '')}${(summary.mrr - baseline.mrr).toFixed(3)} (recorded, not enforced)`);
    }
    if (breaches.length > 0) {
      throw new Error(`retrieval is below the committed floor:\n  ${breaches.join('\n  ')}\nBaseline: ${corpus.baselinePath}`);
    }
  }
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
