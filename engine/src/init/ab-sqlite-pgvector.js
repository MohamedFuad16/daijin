// P2 acceptance: the SQLite adapter measured against pgvector on the same corpus.
//
// The claim this script exists to support is narrow and mechanical: swapping the storage
// backend does not move retrieval quality. Everything above the Store seam (fusion,
// ranking, budgeting, context formatting) is the same code on both arms, so a difference
// in the numbers is a difference in the backend and nothing else.
//
// Design decisions that make it a controlled experiment rather than a demonstration:
//
// - The pgvector arm runs the SHIPPED ordered path (D-0016), NOT the corpus descriptor's
//   parityMode. parityMode reproduces the platform's exact statements including an
//   unordered document inventory, which is the right control for P1's parity claim and
//   the wrong one here: P2 asks whether the shipped product behaves the same on two
//   backends, so both arms must be the shipped configuration.
// - Vectors are COPIED, never recomputed. Re-embedding would change the vectors and make
//   the two arms search different spaces, so the experiment would measure the embedder
//   rather than the store. The copy carries the source's embedding identity across too,
//   which is what lets retrieval's identity assert pass on the SQLite arm.
// - The SQLite arm is loaded through the shipped write path (upsertDocument,
//   replaceChunks, pruneDocumentsExcept, in ONE transaction: the atomic full mirror
//   replace of D-0009). A retrieval parity claim over a corpus loaded by a route the
//   product never uses is weaker than it looks, and this way the A/B doubles as the only
//   end-to-end exercise of the ingest seam at corpus scale.
// - The pgvector store is wrapped in a guard that THROWS on every write method, so
//   D-0012's read-only rule for parity runs against the owner's live database is a
//   mechanism rather than a promise. engine/test/ab-runner.test.js proves it fires.
//
// Gated: the measurement is held until the leader opens it on the P1 verdict. Invoking
// this file without --run prints the plan and touches nothing.
//
// Zero spend: both arms embed queries through the local Ollama the corpus is configured
// for, and the only remote access is a read-only read of the corpus database.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

import { compareRecords } from './compare-runs.js';
import { loadCorpusByName, loadCorpusEnvironment } from './corpus.js';
import { scoreGoldset } from './retrieval-score.js';
import { createPgVectorStore } from '../store/pgvector.js';
import { createSqliteStore } from '../store/sqlite.js';

/** Every Store method that mutates. The parity arm may call none of them. */
export const WRITE_METHODS = [
  'init', 'migrate', 'upsertDocument', 'replaceChunks', 'replaceAllRelationships',
  'deleteDocuments', 'pruneDocumentsExcept', 'setMeta',
];

/**
 * Wrap a store so any write attempt throws instead of reaching the database.
 * init is included: the parity arm attaches to an already migrated database and has no
 * business creating extensions in it.
 */
export function readOnlyStore(store, label = 'parity') {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (WRITE_METHODS.includes(property)) {
        return async () => {
          throw new Error(
            `${label} store is read only (D-0012): ${String(property)} was called against the corpus database.`,
          );
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Parse a pgvector `vector` literal, which arrives as text like "[0.1,-0.2]". */
export function parseVector(literal) {
  if (literal === null || literal === undefined) return null;
  if (Array.isArray(literal)) return literal;
  const parsed = JSON.parse(literal);
  if (!Array.isArray(parsed)) throw new Error('Embedding literal is not an array.');
  return parsed;
}

/**
 * Read the corpus out of the platform database.
 * Raw SQL rather than the Store contract on purpose: the contract has no "read every
 * chunk with its embedding" method, and inventing one to serve a migration utility would
 * widen a frozen interface for a script's convenience.
 */
export function pgCorpusSource(client, project) {
  return {
    async documents() {
      const { rows } = await client.query(
        `SELECT id, project, type, path, title, tags, meta, content, content_hash
           FROM document
          WHERE project = $1
          ORDER BY id`,
        [project],
      );
      return rows.map((row) => ({
        id: row.id,
        project: row.project,
        type: row.type,
        path: row.path,
        title: row.title,
        tags: row.tags || [],
        meta: row.meta || {},
        content: row.content,
        contentHash: row.content_hash ?? null,
      }));
    },
    async chunks() {
      const { rows } = await client.query(
        `SELECT c.document, c.ordinal, c.content, c.embedding::text AS embedding
           FROM chunk AS c
           JOIN document AS d ON d.id = c.document
          WHERE d.project = $1
          ORDER BY c.document, c.ordinal`,
        [project],
      );
      return rows.map((row) => ({
        documentId: row.document,
        ordinal: row.ordinal,
        content: row.content,
        vector: parseVector(row.embedding),
      }));
    },
    async relationships() {
      const { rows } = await client.query('SELECT src, dst, kind FROM relationship ORDER BY src, dst, kind');
      return rows;
    },
    /**
     * Row counts read straight from the source, independently of the rows the mirror
     * actually carried across. Counted separately on purpose: a reconciliation against
     * numbers derived from the same read it is checking proves nothing.
     */
    async counts() {
      const one = async (sql, params = []) => Number((await client.query(sql, params)).rows[0].n);
      return {
        documents: await one('SELECT count(*) AS n FROM document WHERE project = $1', [project]),
        chunks: await one(
          'SELECT count(*) AS n FROM chunk AS c JOIN document AS d ON d.id = c.document WHERE d.project = $1',
          [project],
        ),
        relationships: await one('SELECT count(*) AS n FROM relationship'),
      };
    },
  };
}

/**
 * Refuse to report a comparison over a partial mirror.
 *
 * A gate rather than a habit, and the asymmetry is the argument: a mirror that silently
 * dropped documents measures the SQLite arm on a SMALLER corpus, which can only flatter
 * it. That is the direction of error nobody questions, so it is the one that has to be
 * mechanical. A dead version of this check that could never fire would be exactly the
 * dead coverage the gate inventory bans, which is why its mutation test drops a row and
 * proves the gate fires.
 */
export function checkMirrorCompleteness(source, mirrored) {
  const mismatches = ['documents', 'chunks', 'relationships']
    .filter((field) => source[field] !== mirrored[field])
    .map((field) => ({ field, source: source[field], mirrored: mirrored[field] }));
  return { source, mirrored, complete: mismatches.length === 0, mismatches };
}

/**
 * Mirror a corpus into a target store through the shipped write path, atomically.
 * Upserts plus the prune ride in one transaction, so a failure leaves the previous mirror
 * intact and a success leaves no orphan behind.
 */
export async function mirrorCorpus({ source, target, project }) {
  const documents = await source.documents();
  const chunks = await source.chunks();
  const relationships = await source.relationships();

  const byDocument = new Map();
  for (const chunk of chunks) {
    if (!byDocument.has(chunk.documentId)) byDocument.set(chunk.documentId, []);
    byDocument.get(chunk.documentId).push({
      ordinal: chunk.ordinal,
      content: chunk.content,
      vector: chunk.vector,
    });
  }

  await target.transaction(async () => {
    for (const document of documents) {
      await target.upsertDocument(document);
      await target.replaceChunks(document.id, byDocument.get(document.id) ?? []);
    }
    await target.replaceAllRelationships(relationships);
    await target.pruneDocumentsExcept(documents.map((document) => document.id), project);
  });

  return {
    documents: documents.length,
    chunks: chunks.length,
    relationships: relationships.length,
    embedded: chunks.filter((chunk) => chunk.vector !== null).length,
  };
}

const completeCases = (summary) => Math.round(summary.caseRate * summary.cases);
const completeIdentifierCases = (summary) => Math.round(summary.identifierCaseRate * summary.identifierCases);

/**
 * The P2 acceptance check, stated as three mechanical questions.
 *
 * "Within one case" is counted in CASES, not in percentage points: a rate difference is
 * only meaningful against the denominator it came from.
 *
 * Every detail string carries the EXACT rate and the case counts behind it, never a
 * rounded percentage (verifier finding 72). These strings are what gets pasted into
 * summaries, and "91.2% vs 91.2%" reads as identical whether the arms agreed exactly or
 * differed by a third of a case, which is precisely the movement this check exists to
 * catch. The pass/fail arithmetic is unchanged and still runs on the exact floats; only
 * what a reader sees was ever rounded. Each check also carries a structured `values`
 * block, so a reader diffing verdicts mechanically never has to parse prose.
 */
export function judgeAb({ control, candidate }) {
  const cases = candidate.cases;
  const caseDelta = Math.abs(control.caseRate - candidate.caseRate) * cases;
  const checks = [
    {
      name: 'case rate within one case',
      pass: caseDelta <= 1.0000001,
      detail: `pgvector ${completeCases(control)}/${control.cases} = ${control.caseRate}`
        + `, sqlite ${completeCases(candidate)}/${candidate.cases} = ${candidate.caseRate}`
        + `, ${Math.abs(completeCases(control) - completeCases(candidate))} cases apart`,
      values: {
        control: { complete: completeCases(control), cases: control.cases, caseRate: control.caseRate },
        candidate: { complete: completeCases(candidate), cases: candidate.cases, caseRate: candidate.caseRate },
        caseDelta,
        tolerance: 1,
      },
    },
    {
      name: 'identifier cases complete on sqlite',
      pass: candidate.identifierCases > 0 && candidate.identifierCaseRate === 1,
      detail: `sqlite ${completeIdentifierCases(candidate)}/${candidate.identifierCases} = ${candidate.identifierCaseRate}`
        + `, pgvector ${completeIdentifierCases(control)}/${control.identifierCases} = ${control.identifierCaseRate}`,
      values: {
        control: { complete: completeIdentifierCases(control), cases: control.identifierCases, rate: control.identifierCaseRate },
        candidate: { complete: completeIdentifierCases(candidate), cases: candidate.identifierCases, rate: candidate.identifierCaseRate },
      },
    },
    {
      name: 'no must-not-outrank violations on sqlite',
      pass: candidate.violations === 0,
      detail: `sqlite ${candidate.violations} violations, pgvector ${control.violations}`,
      values: { control: control.violations, candidate: candidate.violations },
    },
  ];
  return {
    pass: checks.every((check) => check.pass),
    checks,
    caseDelta,
    // MRR is deliberately NOT toleranced (D-0017): it is the number a ranking tweak can
    // buy while case rate falls. It is reported exactly so movement stays visible, and
    // movement with case rate unmoved is a prompt to inspect the lexical arm.
    mrr: { control: control.mrr, candidate: candidate.mrr, delta: candidate.mrr - control.mrr, toleranced: false },
  };
}

/**
 * Run both arms and compare. Returns the two records, the per-case diff and the verdict;
 * writes nothing unless outDir is given.
 */
export async function runAb({
  corpusName = 'platform', k = 8, only = null, sqlitePath, outDir = null,
} = {}) {
  const corpus = await loadCorpusByName(corpusName);
  const { databaseUrl, environment } = loadCorpusEnvironment(corpus);
  // No default location, deliberately. The first version defaulted to
  // process.cwd()/.daijin/, which parked a 15 MB corpus mirror in the engine working tree
  // of every worker the first time anyone ran it from there. A measurement artifact that
  // size belongs somewhere its author chose, so the choice is required rather than
  // guessed, and the error says what to pass.
  if (!sqlitePath) {
    throw new Error(
      'runAb requires an explicit sqlitePath. A corpus mirror is large and is not written '
      + 'anywhere by default; pass --sqlite=<path> outside any repository working tree.',
    );
  }
  const target = sqlitePath;

  // Arm A: the shipped ordered pgvector path. corpus.storeOptions is deliberately NOT
  // spread here; see the header.
  const control = readOnlyStore(createPgVectorStore({
    connectionString: databaseUrl,
    applicationName: 'daijin-ab-control',
    project: corpus.project,
  }), 'pgvector');

  const reader = new pg.Client({ connectionString: databaseUrl, application_name: 'daijin-ab-mirror' });
  let candidateStore = null;
  try {
    const controlRun = await scoreGoldset({ corpus, k, only, label: 'ab-pgvector', store: control });

    // The SQLite index must claim the SAME embedder as the source, or retrieval refuses to
    // serve it. Copying the identity is honest here precisely because the vectors are
    // copied too: nothing was re-embedded.
    const identity = await control.indexedEmbeddingIdentity();
    if (!identity) throw new Error('The control index reports no embedding identity; refusing to mirror it.');

    await reader.connect();
    candidateStore = await createSqliteStore({
      path: target,
      project: corpus.project,
      embedder: {
        provider: identity.provider,
        model: identity.model,
        digest: identity.digest,
        dimension: Number(identity.dimension),
      },
    });
    const source = pgCorpusSource(reader, corpus.project);
    const mirrored = await mirrorCorpus({ source, target: candidateStore, project: corpus.project });
    const mirrorCheck = checkMirrorCompleteness(await source.counts(), mirrored);
    if (!mirrorCheck.complete) {
      throw new Error(
        'Mirror is incomplete, refusing to report a comparison over a partial corpus: '
        + `${JSON.stringify(mirrorCheck.mismatches)}`,
      );
    }

    const candidateRun = await scoreGoldset({ corpus, k, only, label: 'ab-sqlite', store: candidateStore });
    const diff = compareRecords(controlRun.record, candidateRun.record);
    const verdict = judgeAb({ control: controlRun.summary, candidate: candidateRun.summary });
    const report = {
      corpus: corpus.id,
      k,
      mirrored,
      mirrorCheck,
      control: controlRun.record,
      candidate: candidateRun.record,
      diff,
      verdict,
    };

    if (outDir) {
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, 'ab-pgvector.json'), `${JSON.stringify(controlRun.record, null, 2)}\n`);
      await writeFile(path.join(outDir, 'ab-sqlite.json'), `${JSON.stringify(candidateRun.record, null, 2)}\n`);
      await writeFile(path.join(outDir, 'ab-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  } finally {
    // scoreGoldset only closes stores it created, so both arms are ours to close.
    await reader.end().catch(() => {});
    if (candidateStore) await candidateStore.close().catch(() => {});
    await control.close().catch(() => {});
  }
}

function parseArgs(argv) {
  const value = (flag) => {
    const found = argv.find((entry) => entry.startsWith(`${flag}=`));
    return found ? found.slice(flag.length + 1) : null;
  };
  const k = value('--k');
  const only = value('--only');
  return {
    run: argv.includes('--run'),
    corpus: value('--corpus') || 'platform',
    k: k ? Number(k) : 8,
    only: only ? only.split(',').map((entry) => entry.trim()).filter(Boolean) : null,
    sqlite: value('--sqlite'),
    out: value('--out'),
  };
}

const GATE_NOTE = `P2 A/B runner, held until the leader opens it on the P1 verdict.

  Arm A  pgvector, shipped ordered path, READ ONLY against the corpus database
  Arm B  sqlite-vec + FTS5, mirrored through the shipped write path, vectors copied
  Judge  case rate within one case, identifier cases complete, zero violations

Re-run with --run to measure. --sqlite is REQUIRED and must sit outside any repository
working tree; the mirror is large and is never written to a default location.

  --run  --sqlite=<path>  [--out=<dir>]  [--corpus=platform]  [--k=8]  [--only=g001,g002]`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.run) {
    console.log(GATE_NOTE);
    return;
  }
  if (!args.sqlite) {
    console.error(
      'ab: --sqlite=<path> is required. The corpus mirror is large and is never written to a\n'
      + 'default location; choose a path outside any repository working tree, for example:\n'
      + '  node src/init/ab-sqlite-pgvector.js --run --sqlite=/tmp/daijin-ab/platform.sqlite --out=/tmp/daijin-ab',
    );
    process.exitCode = 2;
    return;
  }
  const report = await runAb({
    corpusName: args.corpus, k: args.k, only: args.only, sqlitePath: args.sqlite, outDir: args.out,
  });
  console.log(`\nA/B  ·  ${report.corpus}  ·  k=${report.k}  ·  ${report.candidate.summary.cases} cases`);
  console.log(`  mirrored: ${report.mirrored.documents} documents, ${report.mirrored.chunks} chunks `
    + `(${report.mirrored.embedded} embedded), ${report.mirrored.relationships} edges`);
  console.log(`  mirror reconciled against the source: ${report.mirrorCheck.complete ? 'complete' : 'INCOMPLETE'}\n`);
  for (const check of report.verdict.checks) {
    console.log(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}\n        ${check.detail}`);
  }
  // Reported, never judged (D-0017): tolerancing MRR invites optimizing the number a
  // ranking tweak can buy while case rate falls.
  const { mrr } = report.verdict;
  console.log(`\n  MRR (not toleranced): pgvector ${mrr.control}, sqlite ${mrr.candidate}, delta ${mrr.delta}`);
  console.log(`\n  per-case differences: ${report.diff.differences.length}`);
  for (const difference of report.diff.differences.slice(0, 20)) {
    console.log(`    ${difference.id}  ${difference.kind}  ${JSON.stringify(difference)}`);
  }
  if (report.diff.differences.length > 20) {
    console.log(`    ... and ${report.diff.differences.length - 20} more (full list in the report JSON)`);
  }
  if (!report.verdict.pass) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
