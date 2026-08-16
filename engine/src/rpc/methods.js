// The v4 method table.
//
// EVERY method in methods.md answers. A method whose capability has not shipped returns a
// structured not-implemented naming its phase, never a method-not-found: the TUI has to be
// able to connect today and render honestly, and "this engine has no such method" would be
// a lie about a frozen surface.
//
// Zero spend is STRUCTURAL here, not a policy note. This module imports no provider client
// and has no code path that reaches one. The four spend-touching methods the contract
// enumerates (gymStart, rolePing, initBrain layer1+layer2, diagnoseNarrate) refuse BEFORE
// they would do anything, so the refusal cannot regress into a call when their phases land.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { analyze as analyzeRepo } from '../init/analyze.js';
import { discoverGates, gatesFilePath, renderGatesYaml } from '../init/gate-discovery.js';
import { embedderFromOllama, servedIndexIdentity } from '../init/ingest.js';
import { initBrain as runInitPipeline } from '../init/pipeline.js';
import { caseRateOf, MCP_UNLOCK_THRESHOLD, mcpUnlock } from '../init/floor.js';
import { discriminatingRange, permuteAnswers } from '../init/rerank-ab.js';
import { scoreGoldset } from '../init/retrieval-score.js';
import { createOllamaClient } from '../../../adapters/ollama/client.js';
import { checkOllama } from '../rag/embed.js';
import { formatContext } from '../rag/context.js';
import { retrieve as retrieveImpl } from '../rag/retrieve.js';
import { getAgentFile as readAgentFile, setAgentFile as writeAgentFile, studentRules } from '../gym/agent-files.js';
import { runGymCycle } from '../gym/cycle.js';
import { AXES } from '../gym/grading.js';
import { examListRow, parseExamRecord, quarantineExam, vetoExam } from '../gym/exams.js';
import { GymLedger, gymDatabasePath } from '../gym/ledger.js';
import { loadResultFiles } from '../gym/result-files.js';
import { assertSpendGate, readSpendGate, gymSpendGatePath } from '../gym/spend-gate.js';
import { createSqliteStore } from '../store/sqlite.js';
import { noteOrigin, repoLayout } from '../state/layout.js';
import { invalidParams, notImplemented, spendRefused } from './errors.js';

/**
 * The health states a repo row can report, and the only source of them.
 *
 * A CONSTANT rather than four literals, because the enum gate could not see them all: two
 * live in a ternary and its harvest read `return 'x'` forms, so it found three of four and
 * reported the fourth as documented-but-unproducible. The floor that says a harvest must
 * yield at least two values passed, because three is not zero.
 *
 * That is the harvest's own fails-invisible shape, and the fix is to stop harvesting. A
 * named export cannot be missed by a regex, and the gate imports it the way it imports
 * RUN_MODES.
 */
export const HEALTH_STATES = Object.freeze(['no-brain', 'warn', 'ok', 'critical']);

/// The contract version hello reports.
///
/// A constant rather than a parse of methods.md, because the daemon must not need its own
/// documentation installed beside it to answer a handshake. It cannot drift silently: a
/// test parses the title of methods.md and fails if the two disagree, which is the same
/// discipline the engine version below is under.
export const CONTRACT_VERSION = '5';

/// The engine version hello reports, READ FROM THE MANIFEST, never restated here.
///
/// A literal drifted from package.json within a day of being written and was caught by the
/// installer's smoke check on first contact (store-adapter, P6). Two places holding one
/// version is two places to forget; the manifest is the one npm already believes, so it
/// wins, and a test asserts they still agree.
export const ENGINE_VERSION = createRequire(import.meta.url)('../../package.json').version;
/// The floor a repo must reach before its MCP config is offered, IMPORTED from where the
/// measurement lives rather than restated. Two constants for one threshold is the drift
/// this codebase keeps finding; floor.js owns it because floor.js is what measures against
/// it. Re-exported under the daemon's name so existing callers are unaffected.
export { MCP_UNLOCK_THRESHOLD as MCP_THRESHOLD };

const ROLES = ['engineer', 'teacher', 'auditor', 'watcher'];
const AGENT_ROLES = ['student', 'teacher', 'auditor', 'watcher'];
const INIT_MODES = ['ingest', 'layer1', 'layer1+layer2'];
/// v5: exactly these, and nothing else. q is a substring over id, title and path.
const DOCUMENT_FILTER_KEYS = ['q', 'type', 'area'];
/// The modes budgetEstimate can price. Both are spend-touching operations whose dialog
/// needs a number BEFORE the user consents.
const BUDGET_MODES = ['layer1+layer2', 'gym'];
/// The zero-spend local embedder Daijin ships with. Settings override both fields.
const DEFAULT_EMBEDDING = Object.freeze({ model: 'bge-m3', dimension: 1024 });

/// "31 of 34" alongside the exact rational. The contract asks for both because a rate with
/// no denominator hides how much one case is worth, and a displayed percentage is not a
/// measurement (the platform's baseline note is explicit about this).
export function caseRateShape(results) {
  const total = results.length;
  const passing = results.filter((item) => item.complete).length;
  return { exact: total ? passing / total : 0, cases: `${passing} of ${total}` };
}

/**
 * Normalize an echoed budget for the audit trail.
 *
 * The canonical echo is the whole budgetEstimate result, `{ estimatedTokens, basis }`,
 * because `basis` is the derivation the user actually read and a figure without it records
 * a number nobody can re-check. The engine is TOLERANT of anything carrying
 * estimatedTokens, and of a bare number, because refusing a malformed echo would invent a
 * refusal condition on a spend path, which is worse than a thin record.
 *
 * An echo it cannot make sense of is kept verbatim under `raw` rather than dropped: a
 * consent record that silently discards what the client sent is exactly the audit gap this
 * whole mechanism exists to close.
 */
export function normalizeBudgetEcho(budget) {
  if (budget === null || budget === undefined) return null;
  if (typeof budget === 'number' && Number.isFinite(budget)) return { estimatedTokens: budget, basis: null };
  if (typeof budget === 'object' && Number.isFinite(Number(budget.estimatedTokens))) {
    return { estimatedTokens: Number(budget.estimatedTokens), basis: budget.basis ?? null };
  }
  return { estimatedTokens: null, basis: null, raw: budget };
}

/**
 * Describe each gold case as the sub-75 path needs it, and cluster the misses.
 *
 * type and area come from the MISSED DOCUMENT, looked up in the inventory, not from the
 * query. That distinction is the whole value: "architecture units are being missed" is
 * actionable (enrich or re-chunk them), while "queries about storage missed" is not, and
 * an earlier version of this reported the query's inferred area under the name `area`,
 * which reads as the second while claiming to be the first.
 *
 * Pure, so the clustering can be tested without a store or an embedder.
 */
export function clusterCases(results, documentsById = new Map(), armsByCase = new Map()) {
  const perCase = results.map((item) => {
    // The first missed document is what the case failed ON. A complete case has none.
    const missed = item.misses?.[0] ?? null;
    const document = missed ? documentsById.get(missed) : null;
    return {
      caseId: item.id,
      hit: item.complete,
      rank: item.reciprocalRank ? Math.round(1 / item.reciprocalRank) : null,
      arm: armsByCase.get(item.id) ?? null,
      type: document?.type ?? null,
      area: document?.area ?? null,
      missed,
      identifier: Boolean(item.identifier),
      standingAssisted: Boolean(item.standingAssisted),
    };
  });

  const misses = perCase.filter((row) => !row.hit);
  const tally = (key) => {
    const counts = new Map();
    for (const row of misses) {
      // `null` is a real bucket and is named as one: "unknown" hides how much of the
      // diagnosis could not be attributed, which is the number a reader needs most.
      const value = row[key] ?? 'unattributed';
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || String(left.value).localeCompare(String(right.value)));
  };

  return {
    perCase,
    misses: misses.map((row) => row.caseId),
    clusters: { byType: tally('type'), byArea: tally('area'), byArm: tally('arm') },
    identifierMisses: misses.filter((row) => row.identifier).length,
    // THE DENOMINATOR, carried so an empty cluster can be read correctly.
    //
    // init-miner's live P3 run is the argument: at 25 cases over 11 documents the gauge
    // scored 25 of 25, and a permuted control with every answer deliberately wrong still
    // scored 18 of 25, because k=8 returns most of an 11-document corpus whatever the
    // ranking. On a corpus that small most cases pass for reasons unrelated to ranking, so
    // an empty miss-cluster is NOT evidence that retrieval is healthy, and a reader needs
    // the case count to know how much the emptiness is worth.
    cases: perCase.length,
    hits: perCase.length - misses.length,
  };
}

/**
 * The five axes of one attempt, in canonical order, or NULL when it was never graded.
 *
 * THE SHAPE IS A LIST AND THE UNGRADED VALUE IS NULL, both deliberately (D-0025 era finding
 * 79). An empty object was the previous answer and is now forbidden: zeroed or absent axes
 * on a radar chart render exactly like measured ones, so a viewer cannot tell "not graded"
 * from "graded badly". Null cannot be plotted by accident.
 *
 * grading.js keys axes BY NAME because a rubric is authored by name and validated by name.
 * A chart needs a fixed order, and the order must not come from object key order, which is
 * an accident of how the rubric was written. Mapping name-keyed to canonically-ordered
 * happens HERE, at the daemon boundary, because that is where the wire shape is owed.
 *
 * `max` travels with every score. A 4 means nothing without the 5 beside it, and a client
 * that hardcodes the denominator silently misreads the day the scale changes.
 */
export function axesFor(rubric) {
  if (!rubric?.axes) return null;
  const entries = AXES.map((name) => {
    const entry = rubric.axes[name];
    return Number.isFinite(entry?.score) ? { name, score: entry.score, max: 5 } : null;
  });
  // All five or none. A partial radar is a shape that reads as a low score on the missing
  // axes, and validateRubric already refuses a rubric missing one, so a partial here means
  // something upstream is wrong rather than that the grader was brief.
  return entries.every(Boolean) ? entries : null;
}

/**
 * Why an attempt has no axes: a stable CODE to branch on and a sentence to display.
 *
 * Both, deliberately. The sentence is written for a reader and will be rewritten when a
 * better wording is found; a client that branches on its prose breaks the day it improves.
 * The code is the contract and does not move. Same principle as a hint being displayed
 * verbatim and never parsed.
 *
 * `unsubmitted` is not a bad grade. It records that the student never answered and so
 * cannot have answered badly, which is the distinction the contract asks be preserved.
 */
export function ungradedExplanation(attempt) {
  if (attempt?.status === 'unsubmitted') {
    return { code: 'unsubmitted', reason: 'the student never submitted, so there is no diff to grade' };
  }
  if (attempt?.status === 'apply-error') {
    return { code: 'apply-error', reason: 'the submitted diff did not apply, so there is nothing to grade' };
  }
  return { code: 'pending', reason: 'this attempt produced a diff and has not been graded yet' };
}

/**
 * One attempt in the shape the WIRE owes, mapped from the shape the LEDGER keeps.
 *
 * The ledger's rows went straight out before this, so `cycle_id`, `result_file`,
 * `token_cap`, `extensions_granted` and `sealed_state` were on a frozen public surface by
 * accident: column names of a schema the daemon does not own, published as contract.
 *
 * This is the same argument that retired the raw `SELECT * FROM run` from examDetail, and
 * it is the half I missed then. I fixed the query and left the leak, so the coupling the
 * argument exists to prevent survived in the response. `axes` was mapped at this boundary
 * from the start, for exactly this reason; nothing else on the row was.
 *
 * What each field is for, since a wire shape should be able to justify itself:
 *  - `id`, `at`, `status`, `verdict`: what the attempt IS, and what a list renders.
 *  - `mode`: whether this attempt is part of the SCORED record or a harness-debug run.
 *    Removed in the D-0035 batch with a comeback path written into the reason, and the
 *    path fired the same day: an evaluation attempt and a debug attempt are different
 *    claims about the record, and a chart that renders them identically invites reading a
 *    debug run as a scored one.
 *  - `tokens` and `tokenCap`: what it cost against what it was allowed. The cap travels
 *    with the count for the same reason `max` travels with an axis score: 41,200 means
 *    nothing without the 450,000 beside it.
 *  - `grades`: the contract's name for the axis list, kept because a client was written
 *    against it and the name is better than `axes` for a per-attempt field.
 *  - `axes`: the finding-79 field, kept alongside `grades` as the SAME list, because the
 *    top level already speaks of axes and a reader should not have to learn that two names
 *    mean one thing at two levels.
 *
 * Deliberately NOT on the wire: `cycle_id` (a client cannot ask for a cycle),
 * `result_file` (a path into a directory the client does not read), `sealed_state` and
 * `extensions_granted` (harness internals). Any of them can be added when something needs
 * them, which is cheaper than removing a field a client started using, and `mode` above is
 * that principle collecting: it came off for want of a reader and came back the day one
 * appeared.
 */
export function attemptForWire(attempt, { axes, ungradedCode, ungradedReason }) {
  return {
    id: attempt.id,
    at: attempt.at,
    mode: attempt.mode,
    status: attempt.status,
    verdict: attempt.verdict ?? null,
    tokens: attempt.work_tokens ?? null,
    tokenCap: attempt.token_cap ?? null,
    grades: axes,
    axes,
    ungradedCode,
    ungradedReason,
  };
}

/**
 * Attempts newest first, sorted EXPLICITLY rather than trusted from the query.
 *
 * The top-level axes are the most recent graded attempt's, so an order that is merely
 * assumed silently picks the wrong attempt, and picking the wrong attempt is invisible: the
 * numbers look exactly as real as the right ones. `at` decides because it is when the
 * attempt happened, which is what "most recent" means to a reader; the id breaks ties and
 * covers a row whose `at` is missing or equal, which is the only place insertion order is
 * the better answer.
 */
export function attemptsNewestFirst(attempts) {
  return [...attempts].sort((left, right) => {
    const byTime = String(right.at ?? '').localeCompare(String(left.at ?? ''));
    return byTime !== 0 ? byTime : (right.id ?? 0) - (left.id ?? 0);
  });
}


/**
 * What a stored range was measured UNDER, so a later read can tell whether it still applies.
 *
 * A range is a property of a corpus, a gold set and the settings it was measured at. Change
 * any of them and the stored number describes a gauge that no longer exists, so the
 * fingerprint carries all four and a mismatch is DISCLOSED rather than silently corrected.
 * A stale range shown as current is worse than no range, because it is a number a reader
 * will act on.
 */
export function rangeFingerprint({ k, tokenBudget, goldset, documents }) {
  return { k, tokenBudget, goldsetHash: createHash('sha256').update(goldset).digest('hex').slice(0, 16), documents };
}

/// What changed since the range was measured, in a sentence, or null if nothing did.
export function stalenessOf(stored, current) {
  if (!stored) return 'the settings it was measured under were not recorded';
  const changes = [];
  if (stored.k !== current.k) changes.push(`k moved from ${stored.k} to ${current.k}`);
  if (stored.tokenBudget !== current.tokenBudget) changes.push(`the token budget moved from ${stored.tokenBudget} to ${current.tokenBudget}`);
  if (stored.goldsetHash !== current.goldsetHash) changes.push('the gold set changed');
  if (stored.documents !== current.documents) changes.push(`the brain went from ${stored.documents} documents to ${current.documents}`);
  return changes.length ? changes.join(', ') : null;
}

/**
 * Read the structured half of a gates file, tolerating anything a user may have done to it.
 *
 * Returns `{ discovered, parseError }`. `discovered` is non-null only when the document
 * parses AND carries a `gates` array, because those are the two things a client needs
 * before it can render a table; anything else is a file this method will hand back
 * verbatim without pretending to understand it.
 *
 * The rows are passed through AS WRITTEN rather than mapped to a fixed set. This file is
 * the user's, not the engine's: a key someone added by hand belongs in the answer, and the
 * contract documents what DISCOVERY writes rather than what a file may contain. That is the
 * opposite of the attempts-row rule and for the opposite reason, since that row is the
 * engine's own record and this one is a document it only reads.
 */
export function parseGatesFile(content) {
  let document;
  try {
    document = YAML.parse(content);
  } catch (error) {
    return { discovered: null, parseError: `gates.yaml is not valid YAML (${error.message.split('\n')[0]})` };
  }
  if (!document || typeof document !== 'object') {
    return { discovered: null, parseError: 'gates.yaml is empty or is not a mapping, so it describes no gates' };
  }
  if (!Array.isArray(document.gates)) {
    return { discovered: null, parseError: 'gates.yaml has no `gates:` list, so there is nothing to classify' };
  }
  return {
    discovered: {
      version: document.version ?? null,
      discoveredAt: document.discoveredAt ?? null,
      timeoutMs: document.timeoutMs ?? null,
      // Null rather than a zeroed object when absent: a summary of nothing and a file that
      // never carried one are different facts, and this is the field the screen renders as
      // "n carrying signal".
      summary: document.summary ?? null,
      gates: document.gates,
    },
    parseError: null,
  };
}

/**
 * A digest of WHAT WAS INDEXED, so two measurements can be told apart after the fact.
 *
 * store-adapter's refinement, taken: one repo id is shared by every checkout of a project,
 * which is the right identity (a trend is a property of the project, and splitting it forks
 * the history invisibly and permanently). The cost is that two checkouts on different
 * branches produce different brains and write their floors into ONE series. A series mixing
 * measurements taken under different conditions with nothing marking the change is a
 * reporting defect everywhere else in this build, so it is one here too.
 *
 * Over ids and content hashes rather than over the file: the database file's bytes move with
 * vacuum, page layout and insertion order, so a file digest would report a change on every
 * rebuild of identical content and mark every entry as a new condition. A content hash that
 * is absent falls back to the id alone, which is honest: it says the row was there without
 * claiming to know its contents.
 */
export async function indexContentDigest(store) {
  const rows = await store.allDocuments({ project: null });
  const hash = createHash('sha256');
  // SORTED, because allDocuments' row order is the store's business and a digest that
  // moved with it would mark every rebuild as a new condition.
  for (const row of rows.map((entry) => `${entry.id}\t${entry.contentHash ?? ''}`).sort()) hash.update(`${row}\n`);
  return { digest: `sha256:${hash.digest('hex').slice(0, 16)}`, documents: rows.length };
}

/**
 * Measure how much range the gauge has on this corpus, by re-scoring a permuted gold set.
 *
 * The permuted arm keeps every query and deliberately makes every answer wrong, so its
 * score is what this corpus returns for questions it should fail entirely. A high permuted
 * score means k returns most of the corpus whatever is asked, and then the real number
 * above it is not evidence about retrieval quality.
 *
 * The permuted file is written to a TEMP DIRECTORY, never beside the real gold set: a file
 * named goldset.yaml holding deliberately wrong answers, sitting in a user's repo, is one
 * mistaken read away from becoming the thing that measures them.
 */
export async function measureDiscriminatingRange({ run, goldsetPath, store, environment, k, tokenBudget, score }) {
  const cases = YAML.parse(await readFile(goldsetPath, 'utf8'));
  let permuted;
  try {
    permuted = permuteAnswers(cases);
  } catch (error) {
    // A corpus with fewer than two distinct answers cannot be permuted, and that is a fact
    // about the corpus rather than a failure of the diagnosis. Reported, not thrown: the
    // clusters above are still worth reading, and killing a whole diagnosis over an
    // optional arm would punish the caller for asking a harder question.
    return { range: null, skipped: error.message };
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'daijin-control-'));
  const file = path.join(directory, 'permuted-goldset.yaml');
  try {
    await writeFile(file, YAML.stringify(permuted, { lineWidth: 0 }), 'utf8');
    const controlRun = await score({
      corpus: {
        // The SAME scope as the candidate arm. A control measured against a different
        // project would be measuring a different index, and the range would be a number
        // about that difference rather than about the gauge.
        id: 'permuted-control', project: store?.project ?? null, root: path.dirname(goldsetPath), goldsetPath: file,
        retrievalFixesPath: null, baselinePath: null, envFiles: [], databaseUrlEnv: 'DATABASE_URL',
        retrieveOptions: {}, storeOptions: {},
      },
      k, store, environment, retrieveOptions: { tokenBudget },
    });
    return {
      range: discriminatingRange(
        { caseRate: caseRateOf(run.summary, run.results), mrr: run.summary.mrr },
        { caseRate: caseRateOf(controlRun.summary, controlRun.results), mrr: controlRun.summary.mrr },
      ),
      skipped: null,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function requireRepoPath(params) {
  const repoPath = params?.repoPath;
  if (typeof repoPath !== 'string' || !repoPath.trim()) {
    throw invalidParams('repoPath is required', 'This call needs the path of an attached repo.');
  }
  return path.resolve(repoPath);
}

/**
 * The environment retrieval reads its embedder identity from.
 *
 * Synthesized from what the INDEX recorded rather than from process.env, which is the
 * whole point of the identity assert: an index built by one embedder and served by another
 * produces no error and wrong answers. A repo with no recorded identity has no brain yet,
 * and that is a different message from "retrieval failed".
 */
export async function embedderEnvironment(store, { ollamaBaseUrl } = {}) {
  const identity = await store.indexedEmbeddingIdentity();
  if (!identity?.provider || !identity?.model) return null;
  return {
    EMBEDDING_PROVIDER: identity.provider,
    EMBEDDING_MODEL: identity.model,
    EMBEDDING_MODEL_DIGEST: identity.digest || '',
    EMBEDDING_DIM: String(identity.dimension || ''),
    ...(ollamaBaseUrl ? { OLLAMA_BASE_URL: ollamaBaseUrl } : {}),
  };
}

export function createMethods({
  state,
  jobs,
  deps = {},
} = {}) {
  if (!state) throw new Error('createMethods requires an EngineState.');
  if (!jobs) throw new Error('createMethods requires a JobRunner.');

  const analyze = deps.analyze || analyzeRepo;
  // The index no longer lives in the repo (D-0031 invariant 2), so the path is threaded
  // EXPLICITLY rather than derived from repoPath inside the store. The store's own
  // repoPath default still exists and is now the legacy layout; a caller here that forgot
  // to pass a path would silently open an empty database at the old location and report an
  // unindexed brain, which reads exactly like a repo nobody has run init on.
  const openStore = deps.openStore || ((repoPath, options = {}) => createSqliteStore({ repoPath, ...options }));
  const retrieve = deps.retrieve || retrieveImpl;
  const score = deps.scoreGoldset || scoreGoldset;
  const gate = deps.readSpendGate || readSpendGate;
  const assertGate = deps.assertSpendGate || assertSpendGate;
  const discover = deps.discoverGates || discoverGates;
  const ollama = deps.checkOllama || checkOllama;
  const now = deps.now || Date.now;
  const makeEmbedderClient = deps.createEmbedderClient || createOllamaClient;
  const embedderFromClient = deps.embedderFromClient || embedderFromOllama;
  // The identity the STORE is built with. Deliberately NOT client.servedIdentity(): the
  // adapter reports the model as the tag it found (bge-m3:latest) while the retrieval path
  // reports the configured name with the served digest (bge-m3), and assertRetrievalIdentity
  // compares the model string exactly. A store built from the adapter's notion is refused by
  // every query it was built to answer, with an error telling the user to re-ingest, which
  // would not have helped. init-miner lost a live run to exactly this.
  const indexIdentity = deps.servedIndexIdentity || servedIndexIdentity;
  const runInit = deps.initBrain || runInitPipeline;
  const openLedger = deps.openLedger || ((repoPath) => GymLedger.open(gymDatabasePath(repoPath)));
  const runCycle = deps.runGymCycle || runGymCycle;
  // THE PAID SEAM. `engineer.next()` is the only provider call in a gym cycle, and no
  // driver exists yet: building one needs a configured role, and roles arrive with the
  // model-setup round. Injectable so a cycle is fully testable with a fake student.
  const createEngineer = deps.createEngineer || null;

  /// Open a repo's brain, run `body`, and always close. A leaked sqlite handle in a
  /// long-lived daemon is a file descriptor that never comes back.
  async function withStore(repoPath, body, options = {}) {
    const store = await openBrain(repoPath, options);
    try {
      return await body(store);
    } finally {
      await store.close?.();
    }
  }

  async function requireAttached(params) {
    const repoPath = requireRepoPath(params);
    if (!await state.isAttached(repoPath)) {
      throw invalidParams('repo is not attached', `${repoPath} is not attached. Attach it from the repo home first.`);
    }
    return repoPath;
  }

  /// Per-call consent (v5). One guard, used by every spend-touching method, so consent
  /// cannot be enforced in three places and forgotten in the fourth.
  ///
  /// It is deliberately a bare `=== true`: a truthy string, a 1, or an object would all be
  /// a client sending something it did not mean, and inferring consent from a coincidence
  /// is the exact failure this parameter exists to prevent.
  async function requireConsent(method, params, why) {
    if (params?.confirm !== true) {
      throw spendRefused(method, `${why} Send confirm: true with the call once the user has agreed.`);
    }
    // Record WHAT THE USER SAW, not just that they agreed. `budget` is optional by ruling
    // (inventing a refusal condition on a spend path is worse than a thin record), so it
    // is recorded as null when the client did not echo one, which is itself the useful
    // fact: it says the agreement was made without a displayed figure. Sending it is the
    // CLIENT's obligation, enforced by client-side tests, never by a stricter engine.
    await state.recordConsent({
      method,
      repoPath: params?.repoPath ?? null,
      budget: normalizeBudgetEcho(params?.budget),
      at: new Date(now()).toISOString(),
    });
  }

  /// Open a repo's gym ledger, use it, and always close. The ledger is synchronous
  /// better-sqlite3 and REFUSES to open a database carrying brain tables, so a mis-pointed
  /// path fails loudly on open rather than growing gym tables inside a user's brain.
  /**
   * Open a repo's gym ledger, run `body`, and always close.
   *
   * A MISSING LEDGER IS AN EXPECTED STATE, not an internal error. A repo that has never run
   * init has no `.daijin/` directory, so the driver refuses with "Cannot open database
   * because the directory does not exist", and that string was reaching the wire as -32603
   * on five methods. The client renders hints verbatim, which is correct, so a user who had
   * simply not built a brain yet read database internals on the exams and gym screens.
   *
   * Refused HERE rather than in each method, because the miscategorisation is per-callsite
   * and not per-method: every caller of this function inherited it. One guard at the shared
   * seam closes the class; five guards in five methods would have closed the instances and
   * left the next caller to rediscover it.
   *
   * gymStart is the sixth caller and does NOT leak, which is worth knowing because the
   * reason is incidental rather than designed: the spend gate file lives inside `.daijin/`,
   * the same directory whose absence causes this error, so a repo that can open its gate
   * necessarily has the directory and a ledger can be created. Move the gate file and
   * gymStart joins the class. Checked rather than assumed; I had written it up as a masked
   * sixth before probing it.
   *
   * The wording follows the search hint's form deliberately: say what is missing and what
   * action creates it. A user meeting this has done nothing wrong and needs a next step,
   * not a diagnosis.
   */
  async function withLedger(repoPath, body) {
    let ledger;
    try {
      ledger = openLedger(repoPath);
    } catch (error) {
      // Only the not-yet-initialised case is translated. A ledger that exists and cannot be
      // opened is a genuine internal error and keeps -32603, because a corrupt database is
      // a state nobody expected and hiding it behind a friendly sentence would send the
      // user to run init on a repo whose real problem is a damaged file.
      if (/does not exist|ENOENT|no such file/i.test(String(error?.message ?? ''))) {
        throw invalidParams('no gym ledger',
          `${repoPath} has no gym ledger yet, so there are no exams or cycles to read. Run init on ${repoPath} first; it creates the ledger.`);
      }
      throw error;
    }
    try {
      return await body(ledger);
    } finally {
      ledger.close?.();
    }
  }

  /// gym-porter's modules throw messages written for a person and naming the field and the
  /// rule. Those are the caller's to fix, so they map to a parameter error with the message
  /// verbatim rather than being flattened into a generic failure.
  function asParameterError(error, fallback) {
    throw invalidParams(fallback, error.message);
  }

  /// This repo's paths, repo side and machine side. Read-only: a daemon method that
  /// materialised a contract file merely by being called would put a write on a read path.
  const layoutFor = (repoPath) => repoLayout(repoPath, { stateRoot: state.stateRoot });

  /// Open a repo's brain at its RELOCATED path.
  const openBrain = async (repoPath, options = {}) => {
    const layout = await layoutFor(repoPath);
    return openStore(repoPath, { path: layout.databasePath, ...options });
  };

  const historyFile = async (repoPath) => (await layoutFor(repoPath)).scoreHistoryPath;

  /// Best effort on purpose: failing a diagnosis because its optional cache could not be
  /// written would trade a good answer for a bookkeeping problem.
  const writeRange = async (repoPath, record) => {
    const file = (await layoutFor(repoPath)).rangeFilePath;
    await mkdir(path.dirname(file), { recursive: true })
      .then(() => writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8'))
      .catch(() => {});
  };

  /// A previously measured range, with what has changed since it was taken.
  ///
  /// A corrupt or missing file reads as NEVER MEASURED rather than throwing: a cache that
  /// can kill a diagnosis is a liability, and null already has an honest meaning here.
  const recallRange = async (repoPath, fingerprint) => {
    let stored;
    try {
      stored = JSON.parse(await readFile((await layoutFor(repoPath)).rangeFilePath, 'utf8'));
    } catch {
      return null;
    }
    if (!stored?.range) return null;
    const staleBecause = stalenessOf(stored, fingerprint);
    return { ...stored.range, measuredAt: stored.at ?? null, fresh: false, stale: Boolean(staleBecause), staleBecause };
  };

  /// One history, whoever measured. init and retrievalScore both write here so the repo
  /// card's trend line cannot show half the measurements that were actually taken.
  async function appendScoreHistory(repoPath, floor, { store = null } = {}) {
    const history = await readHistory(repoPath);
    const layout = await layoutFor(repoPath);
    history.unshift({
      at: new Date(now()).toISOString(),
      caseRate: floor.caseRate,
      chosenBudget: floor.chosenBudget ?? null,
      embedding: floor.embedding ?? null,
      // WHICH CHECKOUT AND WHICH BRAIN produced this number. Clones share one repoId and
      // therefore one history, so without these two fields a series that mixes branches
      // reads as a smooth trend. Null when unknown rather than guessed: a stamp invented
      // for a row is worse than a row that admits it has none.
      originPath: layout.repoPath,
      index: store ? await indexContentDigest(store).catch(() => null) : (floor.index ?? null),
    });
    const file = await historyFile(repoPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  }

  async function readHistory(repoPath) {
    try {
      const rows = JSON.parse(await readFile(await historyFile(repoPath), 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  return {
    // ---- handshake and lifecycle ------------------------------------------------

    async hello() {
      // contractVersion tracks methods.md's version. A mismatch renders an upgrade screen
      // in the TUI, which is why this is a value and not an error.
      return { engineVersion: ENGINE_VERSION, contractVersion: CONTRACT_VERSION };
    },

    async repoAttach(params) {
      const repoPath = requireRepoPath(params);
      return { repo: await state.attachRepo(repoPath) };
    },

    async repoDetach(params) {
      const repoPath = requireRepoPath(params);
      const removed = await state.detachRepo(repoPath);
      if (!removed) throw invalidParams('unknown repoPath', `${repoPath} is not attached, so there was nothing to detach.`);
      return { ok: true };
    },

    async jobCancel(params) {
      const jobId = params?.jobId;
      if (typeof jobId !== 'string' || !jobId) throw invalidParams('jobId is required', 'Cancelling needs the jobId the start call returned.');
      return jobs.cancel(jobId);
    },

    // ---- core --------------------------------------------------------------------

    async analyze(params) {
      const repoPath = requireRepoPath(params);
      const analysis = await analyze(repoPath);
      // MAPPED AT THE BOUNDARY, like the attempts row. The internal function returns more
      // (name, repoPath, files, git, brainFolder) because gate discovery and the init
      // pipeline use it in process, and none of that is wire data: readership was verified
      // in the client, which reads `hasBrainFolder` and nothing else. Adding a field later
      // is cheaper than removing one someone has started using (D-0035 batch).
      return {
        languages: analysis.languages,
        commitCount: analysis.commitCount,
        structure: analysis.structure,
        gateCandidates: analysis.gateCandidates,
        hasBrainFolder: analysis.hasBrainFolder,
      };
    },

    async serveStatus() {
      const repos = await state.repos();
      const settings = await state.settings();

      // Health is DERIVED here rather than trusted from the registry: a repo whose brain
      // was deleted on disk must not keep reporting the health it had when it was attached.
      const rows = [];
      for (const repo of repos) {
        const history = await readHistory(repo.path);
        const floorScore = history[0]?.caseRate?.exact ?? null;
        const [NO_BRAIN, WARN, OK, CRITICAL] = HEALTH_STATES;
        let health = NO_BRAIN;
        try {
          health = await withStore(repo.path, async (store) => {
            const identity = await store.indexedEmbeddingIdentity();
            if (!identity?.indexed && !identity?.provider) return NO_BRAIN;
            // Never measured and measured-below-threshold are both WARN on the wire, and a
            // client tells them apart by floorScore being null or a number. Two values
            // where the discriminator is already on the row would be redundant.
            if (floorScore === null) return WARN;
            return floorScore >= MCP_UNLOCK_THRESHOLD ? OK : WARN;
          });
        } catch {
          // An unopenable brain is a real state the home screen must show, not a crash.
          health = CRITICAL;
        }
        rows.push({ path: repo.path, health, floorScore, mcpActive: Boolean(repo.mcpActive) });
      }

      let ollamaStatus;
      try {
        const served = await ollama({ environment: { EMBEDDING_MODEL: settings.retrieval?.embeddingModel || process.env.EMBEDDING_MODEL } });
        ollamaStatus = { reachable: true, version: served.version, model: served.model, digest: served.digest };
      } catch (error) {
        ollamaStatus = { reachable: false, version: null, model: null, digest: null, hint: error.message };
      }

      // The gate is observable BEFORE anything is attempted, per the contract. A user
      // should never discover the gate's state by being refused.
      const gatePath = rows[0] ? gymSpendGatePath(rows[0].path) : null;
      const spendGate = gatePath
        ? await gate({ file: gatePath }).then((row) => ({ open: row.open, path: row.file }))
        : { open: false, path: null };

      return {
        repos: rows,
        ollama: ollamaStatus,
        db: { backend: settings.storage?.backend || 'sqlite', repos: rows.length },
        spendGate,
      };
    },

    async search(params) {
      const repoPath = await requireAttached(params);
      const query = params?.query;
      if (typeof query !== 'string' || !query.trim()) {
        throw invalidParams('query is required', 'Search needs a query string.');
      }
      const options = params?.options || {};
      const settings = await state.settings();
      return withStore(repoPath, async (store) => {
        const environment = await embedderEnvironment(store, { ollamaBaseUrl: settings.retrieval?.ollamaBaseUrl });
        if (!environment) {
          throw invalidParams('no brain', `${repoPath} has no indexed brain yet, so there is nothing to search. Initialize the brain first.`);
        }
        const result = await retrieve({
          query,
          project: store.project,
          k: options.k ?? settings.retrieval?.k ?? 8,
          tokenBudget: options.tokenBudget ?? settings.retrieval?.tokenBudget ?? 4000,
          types: options.types,
          area: options.area,
        }, { store, environment });
        const chunks = [...result.decisions, ...result.lessons, ...result.exemplars, ...result.chunks].map((row) => ({
          documentId: row.id,
          type: row.type,
          area: row.area,
          title: row.title,
          path: row.path,
          text: row.content,
          tokens: row.tokenCount ?? null,
          score: row.score,
          standing: false,
          arm: result.meta.arms?.[row.id] ?? null,
        }));
        // Standing units ride OUTSIDE the token budget, so they are returned and are not
        // counted against tokensUsed. Flattening that distinction would make the budget
        // display wrong in exactly the direction that hides it.
        const standing = result.standing.map((row) => ({
          documentId: row.id,
          type: row.type,
          area: row.area,
          title: row.title,
          path: row.path,
          text: row.content,
          tokens: null,
          score: null,
          standing: true,
          arm: 'standing',
        }));
        return { chunks: [...standing, ...chunks], tokensUsed: result.meta.tokenCount, context: formatContext(result) };
      });
    },

    async documents(params) {
      const repoPath = await requireAttached(params);
      const filters = params?.filters || {};
      // v5: the filter keys are exactly q, type and area, and an unknown key is an ERROR.
      // Silently ignoring a misspelled filter returns EVERYTHING, which reads as "your
      // filter matched a lot" rather than "your filter was never applied".
      const unknown = Object.keys(filters).filter((key) => !DOCUMENT_FILTER_KEYS.includes(key));
      if (unknown.length > 0) {
        throw invalidParams(`unknown filter key(s): ${unknown.join(', ')}`,
          `documents accepts only ${DOCUMENT_FILTER_KEYS.join(', ')}. A misspelled filter would otherwise return everything and read as a match.`);
      }
      return withStore(repoPath, async (store) => {
        const rows = await store.allDocuments({
          project: null,
          types: filters.type && filters.type !== 'all' ? [filters.type] : null,
          area: filters.area && filters.area !== 'all' ? filters.area : null,
        });
        const query = String(filters.q || '').trim().toLowerCase();
        return rows
          .filter((row) => !query || `${row.title || ''} ${row.id} ${row.path}`.toLowerCase().includes(query))
          .map((row) => ({
            id: row.id,
            type: row.type,
            path: row.path,
            title: row.title,
            area: row.meta?.area ?? null,
            tags: row.tags || [],
          }));
      });
    },

    async scoreHistory(params) {
      const repoPath = await requireAttached(params);
      // Newest first, as the contract states. An empty history is a valid answer: a repo
      // whose floor has never been measured has no trend, which is different from an error.
      return readHistory(repoPath);
    },

    async retrievalScore(params) {
      const repoPath = await requireAttached(params);
      const goldsetPath = (await layoutFor(repoPath)).goldsetPath;
      const settings = await state.settings();
      // `project` is filled in from the STORE below, not here. A null scope reaches
      // retrieve.js, which refuses it by name ("project is required"), so this measured
      // nothing against a real brain: every caller in the unit tests injects the scorer, so
      // the refusal only appears the first time it is pointed at an actual index. Found by
      // running the P8 fixture rather than by a test.
      const corpus = {
        id: path.basename(repoPath),
        project: null,
        root: repoPath,
        goldsetPath,
        retrievalFixesPath: null,
        baselinePath: null,
        envFiles: [],
        databaseUrlEnv: 'DATABASE_URL',
        pathGrammar: undefined,
        standingPrefix: undefined,
        retrieveOptions: {},
        storeOptions: {},
      };

      return withStore(repoPath, async (store) => {
        const environment = await embedderEnvironment(store, { ollamaBaseUrl: settings.retrieval?.ollamaBaseUrl });
        if (!environment) {
          throw invalidParams('no brain', `${repoPath} has no indexed brain yet, so there is no floor to measure.`);
        }
        const budgets = params?.sweep ? [3_000, 4_000, 6_000, 8_000] : [params?.tokenBudget || settings.retrieval?.tokenBudget || 4_000];
        const measurements = [];
        // The store's own scope, so the measurement asks the index the question the index
        // was built to answer. `allDocuments({ project: null })` still means the whole
        // store, deliberately; only the RETRIEVAL scope has to be concrete.
        const scoped = { ...corpus, project: store.project };
        for (const tokenBudget of budgets) {
          const run = await score({
            corpus: scoped,
            k: settings.retrieval?.k ?? 8,
            store,
            // Passed rather than assigned into process.env. A daemon that mutated its own
            // environment to measure a repo would leak that repo's embedder identity into
            // every later measurement of a different one.
            environment,
            retrieveOptions: { tokenBudget },
          });
          measurements.push({ budget: tokenBudget, ...run });
        }

        // The shipped budget is MEASURED per repo: the smallest within one case of the
        // best score. 4,000 is the anchor because it is the only measured point on the
        // platform corpus, not because it is universally right.
        const best = Math.max(...measurements.map((row) => row.summary.caseRate));
        const oneCase = measurements[0].results.length ? 1 / measurements[0].results.length : 0;
        const chosen = measurements.find((row) => row.summary.caseRate >= best - oneCase) || measurements[0];

        // type and area come from the missed DOCUMENT, so the inventory is needed.
        const inventory = new Map((await store.allDocuments({ project: null }))
          .map((row) => [row.id, { type: row.type, area: row.meta?.area ?? null }]));
        const armsByCase = new Map((chosen.diagnostics || [])
          .map((row) => [row.id, row.arms?.[chosen.results.find((item) => item.id === row.id)?.misses?.[0]] ?? null]));
        const { perCase } = clusterCases(chosen.results, inventory, armsByCase);

        const record = {
          at: new Date(now()).toISOString(),
          caseRate: caseRateShape(chosen.results),
          mrr: chosen.summary.mrr,
          violations: chosen.summary.violations,
          chosenBudget: chosen.budget,
          rationale: budgets.length > 1
            ? `smallest budget within one case (${oneCase.toFixed(3)}) of the best measured case rate`
            : 'single budget measured; no sweep requested',
          perCase,
        };
        if (params?.sweep) {
          record.budgetSweep = measurements.map((row) => ({ budget: row.budget, caseRate: caseRateShape(row.results) }));
        }

        // Append to the repo's own history so the card trend line has something to draw.
        //
        // Each row carries the EMBEDDING IDENTITY that produced it, like the harness
        // records do. A trend line comparing measurements taken under different embedders
        // is comparing two different instruments and calling the difference progress; every
        // absolute threshold downstream sits on one embedder's similarity distribution.
        const history = await readHistory(repoPath);
        history.unshift({
          at: record.at,
          caseRate: record.caseRate,
          chosenBudget: record.chosenBudget,
          embedding: chosen.record?.embedding ?? null,
          // The same stamps init writes. Two writers into one series must agree on the
          // shape, or half the rows explain themselves and half do not.
          originPath: (await layoutFor(repoPath)).repoPath,
          index: await indexContentDigest(store).catch(() => null),
        });
        // Through appendScoreHistory's path so the two writers cannot land in two places.
        await mkdir(path.dirname(await historyFile(repoPath)), { recursive: true })
          .then(async () => writeFile(await historyFile(repoPath), `${JSON.stringify(history, null, 2)}\n`, 'utf8'))
          .catch(() => {});

        return record;
      });
    },

    /**
     * What a spend-touching operation is likely to cost, BEFORE the user consents.
     *
     * ZERO SPEND, and structurally so: it reads corpus size and commit count and does
     * arithmetic. An estimate that called a provider to price a provider call would defeat
     * its own purpose, since the dialog it feeds exists to let someone decline.
     *
     * The numbers are declared, not hidden: `basis` is a one-line derivation the dialog
     * shows next to the figure, because an unexplained number in a consent dialog is a
     * number nobody can argue with.
     */
    async budgetEstimate(params) {
      const repoPath = await requireAttached(params);
      const mode = params?.mode;
      if (!BUDGET_MODES.includes(mode)) {
        throw invalidParams('unknown mode', `budgetEstimate prices ${BUDGET_MODES.join(' or ')}.`);
      }
      const areas = params?.scope?.areas || null;

      if (mode === 'layer1+layer2') {
        // Layer 2 narrates prose over evidence rows. The cost scales with how many units
        // there are to narrate, so the unit count is the driver and the scope divides it.
        const units = await withStore(repoPath, async (store) => (await store.allDocuments({ project: null })).length)
          .catch(() => 0);
        const scoped = areas?.length ? Math.ceil(units / Math.max(1, areas.length)) : units;
        const perUnit = 1_400;
        return {
          estimatedTokens: scoped * perUnit,
          basis: `${scoped} unit(s)${areas?.length ? ` in ${areas.length} scoped area(s)` : ''} times ~${perUnit} tokens per narration`,
        };
      }

      // A gym cycle's cost is the work budget times the rounds, and the initial context
      // rides in EVERY round's prompt, which is the term people forget.
      const { commitCount } = await analyze(repoPath);
      const exams = Math.max(1, Math.min(8, Math.floor((commitCount || 0) / 50) || 1));
      const perExam = 800_000;
      return {
        estimatedTokens: exams * perExam,
        basis: `${exams} exam(s) at the M and L work-token cap of ${perExam.toLocaleString('en')} (S tier is 450,000); derived from ${commitCount ?? 0} commit(s)`,
      };
    },

    async mcpSnippet(params) {
      const repoPath = await requireAttached(params);
      const history = await readHistory(repoPath);
      const caseRate = history[0]?.caseRate ?? null;
      if (!caseRate) return { unlocked: false, threshold: MCP_UNLOCK_THRESHOLD, snippet: null, reason: 'No floor has been measured for this repo yet.' };
      // The decision AND its sentence come from floor.js, so the lock reason a user reads is
      // the one the measurement wrote rather than a paraphrase of it.
      const decision = mcpUnlock(caseRate);
      if (!decision.unlocked) return { unlocked: false, threshold: decision.threshold, snippet: null, reason: decision.reason };
      // Points at serve-repo.js, the per-repo entry, NOT at brain-mcp.js. The latter is the
      // P1-era entry that takes a corpus descriptor and opens Postgres; pointed at a user's
      // repo it exits immediately with "brain-mcp requires --corpus-file", so the snippet
      // used to be a paste-ready config that pasted a failure.
      // The state root rides in the snippet because the index left the repo (D-0031): a
      // pasted config that omitted it would resolve the daemon's DEFAULT state root, and an
      // agent launched under a different HOME would open an empty index and answer every
      // search with nothing found. The one number a paste-ready config cannot afford to
      // infer is where the data is.
      const snippet = JSON.stringify({
        mcpServers: {
          daijin: {
            command: process.execPath,
            args: [
              path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'mcp', 'serve-repo.js'),
              repoPath,
              `--state-root=${state.stateRoot}`,
            ],
          },
        },
      }, null, 2);
      return { unlocked: true, threshold: decision.threshold, snippet, reason: decision.reason };
    },

    /**
     * Mechanical sub-75 diagnosis. ZERO SPEND, structurally: it measures with the local
     * embedder and folds the result, and this module has no provider client to reach.
     *
     * It RE-MEASURES rather than reading a stored record, because a diagnosis of a stale
     * measurement recommends work against a brain that has since changed. The auditor's
     * narration over these clusters is diagnoseNarrate, and that one spends.
     *
     * `control: true` adds a permuted arm and reports the gauge's discriminating range.
     * OPT IN, never a default: it doubles the wall clock of an interactive call, and the
     * caller staring at a sub-75 number is exactly the one who should choose to pay that
     * deliberately. The range answers a question the case rate cannot: on a corpus small
     * enough that retrieval returns most of it, a gold set with every answer deliberately
     * WRONG still scores high (init-miner measured 18 of 25 against a real 25 of 25), and
     * then no number from this brain separates a good retrieval from a lucky one.
     */
    async diagnose(params) {
      const repoPath = await requireAttached(params);
      const goldsetPath = (await layoutFor(repoPath)).goldsetPath;
      const settings = await state.settings();
      return withStore(repoPath, async (store) => {
        const environment = await embedderEnvironment(store, { ollamaBaseUrl: settings.retrieval?.ollamaBaseUrl });
        if (!environment) {
          throw invalidParams('no brain', `${repoPath} has no indexed brain yet, so there is nothing to diagnose.`);
        }
        let run;
        try {
          run = await score({
            corpus: {
              id: path.basename(repoPath), project: store.project, root: repoPath, goldsetPath,
              retrievalFixesPath: null, baselinePath: null, envFiles: [], databaseUrlEnv: 'DATABASE_URL',
              retrieveOptions: {}, storeOptions: {},
            },
            k: settings.retrieval?.k ?? 8,
            store,
            environment,
            retrieveOptions: { tokenBudget: settings.retrieval?.tokenBudget ?? 4_000 },
          });
        } catch (error) {
          if (/ENOENT|gold set is empty/i.test(error.message)) {
            throw invalidParams('no gold set', `No gold set has been mined for ${repoPath}, so there is nothing to diagnose. Initialize the brain first.`);
          }
          throw error;
        }

        const inventory = new Map((await store.allDocuments({ project: null }))
          .map((row) => [row.id, { type: row.type, area: row.meta?.area ?? null }]));
        const armsByCase = new Map((run.diagnostics || [])
          .map((row) => [row.id, row.arms?.[run.results.find((item) => item.id === row.id)?.misses?.[0]] ?? null]));
        const clustered = clusterCases(run.results, inventory, armsByCase);

        // The permuted arm runs over the SAME store, embedder, k and budget, so the only
        // thing that differs between the arms is whether the answers are right. Anything
        // else varying would make the range a measurement of the difference rather than of
        // the gauge.
        // The range is SHOWN wherever a sub-75 number is quoted, but MEASURING it is opt in,
        // so the two cannot be the same switch. A measured range is written down and recalled
        // on later diagnoses with the date it was taken and what has changed since; the
        // checkbox governs only whether the expensive arm runs again.
        const fingerprint = rangeFingerprint({
          k: settings.retrieval?.k ?? 8,
          tokenBudget: settings.retrieval?.tokenBudget ?? 4_000,
          goldset: await readFile(goldsetPath, 'utf8').catch(() => ''),
          documents: inventory.size,
        });
        let control = null;
        if (params?.control === true) {
          control = await measureDiscriminatingRange({
            run, goldsetPath, store, environment,
            k: fingerprint.k, tokenBudget: fingerprint.tokenBudget, score,
          });
          if (control.range) await writeRange(repoPath, { at: new Date(now()).toISOString(), ...fingerprint, range: control.range });
        }
        const range = control?.range
          ? { ...control.range, measuredAt: new Date(now()).toISOString(), fresh: true, stale: false, staleBecause: null }
          : await recallRange(repoPath, fingerprint);

        return {
          caseRate: caseRateShape(run.results),
          violations: run.summary.violations,
          ...clustered,
          // Null means NEVER MEASURED, which is not the same as "measured and found to be
          // nothing". A caller that renders a range must be able to tell the difference, so
          // the unmeasured case carries no numbers at all rather than zeroes. A recalled
          // range carries measuredAt and fresh: false, so nothing dated is mistaken for now.
          discriminatingRange: range,
          controlSkipped: control?.skipped ?? null,
          // What the clusters do NOT say is worth saying: this names which cases missed and
          // how they group. Choosing between enriching docs, running Layer 2 on an area, or
          // bootstrapping through the gym is the auditor's call, and that one spends.
          recommendation: null,
        };
      });
    },

    // ---- gates ---------------------------------------------------------------------

    /**
     * The gates file, verbatim AND parsed.
     *
     * It used to return `{ path, content }` while its contract row promised "content plus
     * per-gate classification and liveness evidence". The screen was built for the promise,
     * read a gates list that was never on the wire, and therefore showed an empty table and
     * "0 carrying signal" over a file describing three gates. That is the dead-gate shape
     * inside the screen whose whole job is to prevent it, and it survived because the row
     * sat in the PROSE tier, where nothing compares the promise to the bytes.
     *
     * The classification was never missing. Discovery persists it in full: every row carries
     * its command, source, classification, enabled flag and a baseline block with the
     * evidence, and gatesGet simply did not read the file it was returning.
     *
     * CONTENT IS ALWAYS RETURNED, whatever state the file is in. It is a file the user is
     * invited to edit, so a hand-written or half-edited one must still come back rather than
     * failing the call: the engine treats gates as data it does not author, and a parse
     * error is a fact about the file rather than an error of this method.
     *
     * `discovered` is NULL when the file is not discovery-shaped, with `parseError` saying
     * why. Null is not "no gates": a client can tell a file it cannot interpret from a file
     * that describes zero, which is exactly the distinction the empty table got wrong.
     */
    async gatesGet(params) {
      const repoPath = await requireAttached(params);
      const file = gatesFilePath(repoPath);
      let content;
      try {
        content = await readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') {
          throw invalidParams('no gates discovered', `No gates.yaml exists for ${repoPath}. Run gate discovery first.`);
        }
        throw error;
      }
      return { path: file, content, ...parseGatesFile(content) };
    },

    async gatesSet(params) {
      const repoPath = await requireAttached(params);
      const content = params?.patch?.content;
      if (typeof content !== 'string') {
        // The engine treats gates as DATA, so the patch is the file. Accepting a partial
        // structural patch would make the engine the author of a file the user owns.
        throw invalidParams('patch.content is required', 'gatesSet takes the full gates.yaml content; the engine treats it as data it does not author.');
      }
      const file = gatesFilePath(repoPath);
      await writeFile(file, content, 'utf8');
      // THE SAME SHAPE ITS SIBLING RETURNS. gatesGet gained `discovered` and `parseError`
      // and this did not, so a client that SET a file and re-rendered got a different shape
      // from one that GOT it, which is the defect tui-builder had just reported one level
      // up. Found by the claim audit, an hour after I introduced it.
      //
      // It also answers a real question at the moment it is asked: a user who saves a file
      // learns immediately whether it still parses, rather than saving, re-fetching, and
      // discovering the breakage on the next screen.
      return { path: file, content, ...parseGatesFile(content) };
    },

    /// Probe, then classify each candidate against a baseline run, reporting as it goes.
    ///
    /// A job rather than a request: classification RUNS each candidate command, which can
    /// take minutes on a real repo, and a user staring at a frozen screen cannot tell a
    /// slow build from a hung engine. The step stream is what makes it a live feed.
    ///
    /// Zero spend: every command here is the repo's own tooling, run locally.
    async gatesDiscover(params) {
      const repoPath = await requireAttached(params);
      // What gates.yaml held when the job STARTED. Discovery classifies by running commands,
      // which takes minutes on a real repo, and the file it will write is a file the user is
      // invited to edit: its own header says "this file is DATA: edit it, and the engine
      // obeys it". A job that writes unconditionally at the end obeys nothing; it silently
      // destroys whatever the user wrote while it was working. Read here rather than inside
      // the job so the window starts at the moment the user asked, not later.
      const before = await readFile(gatesFilePath(repoPath), 'utf8').catch(() => null);
      const jobId = jobs.start('gates', async ({ emit, cancelled }) => {
        emit('probe', 'scan', 'probing package.json, CI configs and Makefiles');
        const analysis = await analyze(repoPath);
        const candidates = analysis.gateCandidates || [];
        emit('probe', 'candidates', `${candidates.length} candidate gate(s) found`, { counts: { candidates: candidates.length } });
        if (cancelled()) return;

        const discovered = await discover({
          repoPath,
          candidates,
          onStep: async (step) => {
            if (cancelled()) return;
            emit('classify', step.step, step.detail, { counts: step.counts });
          },
        });
        if (cancelled()) return;

        // REFUSE TO CLOBBER. If the file changed while discovery was running, the user
        // edited it, and their edit is the authority here: the engine treats gates as data
        // it does not author. Discovery reports what it found and leaves the file alone,
        // rather than overwriting an edit with generated content the user never asked for.
        const current = await readFile(gatesFilePath(repoPath), 'utf8').catch(() => null);
        if (current !== before) {
          emit('done', 'kept-yours',
            `gates.yaml changed while discovery was running, so your version was kept. ${discovered.summary.carryingSignal} of ${discovered.summary.total} discovered gate(s) carry signal; run discovery again to take them.`,
            { counts: discovered.summary });
          return;
        }

        await mkdir(path.dirname(gatesFilePath(repoPath)), { recursive: true });
        await writeFile(gatesFilePath(repoPath), renderGatesYaml({
          gates: discovered.gates,
          summary: discovered.summary,
          timeoutMs: discovered.timeoutMs,
          discoveredAt: new Date(now()).toISOString(),
        }), 'utf8');

        // carryingSignal, not total, is the honest headline: a pre-broken or unavailable
        // gate is reported and never counted as coverage.
        emit('done', 'written', `${discovered.summary.carryingSignal} of ${discovered.summary.total} gate(s) carry signal`, {
          counts: discovered.summary,
        });
      });
      return { jobId };
    },

    // ---- gym and exams --------------------------------------------------------------

    async gymStart(params) {
      const repoPath = await requireAttached(params);
      // The GATE IS CHECKED FIRST, before anything else can fail. A gym cycle calls a paid
      // provider, so an argument error must never be the reason a user learns the gate
      // would have allowed it. The gate is flipped by the owner's hand, never the engine's.
      //
      // assertSpendGate, NOT readSpendGate: `open` alone is not authorization. A gate
      // `authorized` for `exam-mining` is open, and must still refuse a `gym-cycle`. Reading
      // the flag and branching on it here was exactly that bug, caught by the scope test.
      await assertGate('gym-cycle', { file: gymSpendGatePath(repoPath) });

      // TWO INDEPENDENT REFUSAL CONDITIONS (v5). The owner gate says this MACHINE may
      // spend; `confirm: true` says this PERSON asked for this call. An open gate is not
      // consent, so a confirmed-absent call is refused even here, past the gate. The engine
      // never infers consent.
      await requireConsent('gymStart', params,
        'A gym cycle calls a paid provider on every round. The gate authorizes the machine; this call still needs your explicit go ahead.');
      // Preconditions are checked BEFORE the missing-driver refusal, deliberately. A user
      // with a closed gate, no consent, an empty bank or a bad draw should learn about
      // that, not about a driver they cannot do anything about.
      const config = params?.config ?? {};
      const settings = await state.settings();
      const drawn = await withLedger(repoPath, async (ledger) => {
        const bank = ledger.listExams({ benchmarkStatus: 'active', status: 'promoted' });
        if (bank.length === 0) {
          throw invalidParams('empty bank',
            `No promoted, unquarantined exam exists for ${repoPath}, so there is nothing to run. Mine and promote exams first.`);
        }
        const wanted = config.examId ? bank.filter((row) => row.examId === config.examId) : bank;
        if (wanted.length === 0) {
          throw invalidParams('unknown examId', `${config.examId} is not a promoted, active exam in this bank.`);
        }
        // Full records, not list rows: the runner needs the whole exam.
        return wanted.slice(0, config.cohortSize ?? 1).map((row) => ledger.getExam(row.examId));
      });

      if (!createEngineer) {
        // THE ONE THING GENUINELY MISSING. Everything above ran: the gate authorized, the
        // user consented, the bank produced a draw. What does not exist is the student
        // driver, because `engineer.next()` is a provider call and no role is configured
        // yet. Named precisely so nobody reads this as "the gym is not built".
        throw notImplemented('gymStart', 'P4 (student driver over a configured engineer role)',
          `The gate, your consent and the draw are all fine (${drawn.length} exam(s) ready). What is missing is the student driver: engineer.next() is a provider call and no engineer role is configured yet.`);
      }

      const jobId = jobs.start('gym', async ({ emit, cancelled }) => {
        const engineer = await createEngineer({ settings, repoPath });
        const store = await openStore(repoPath);
        try {
          const environment = await embedderEnvironment(store, { ollamaBaseUrl: settings.retrieval?.ollamaBaseUrl });
          // A brainless repo RUNS but cannot certify, so documents are optional and their
          // absence is not an error.
          const documents = environment ? await store.allDocuments({ project: null }) : undefined;
          await runCycle({
            exams: drawn,
            mode: config.mode ?? 'harness-debug',
            cohort: config.cohort ?? 'training',
            ledger: openLedger(repoPath),
            gates: config.gates ?? [],
            engineer,
            rules: await studentRules(repoPath),
            documents,
            // THE EXCLUSION SEAM. The gym computes which documents would leak the answer
            // and threads them here; they go straight into retrieve as excludeDocumentIds.
            // A gold-provenance exclusion that silently did nothing would make every exam
            // it touched an open-book test reported as a closed-book one.
            retrieveContext: async ({ query, excludeDocumentIds }) => {
              if (!environment) return '';
              const result = await retrieve(
                { query, project: store.project, excludeDocumentIds, tokenBudget: settings.retrieval?.tokenBudget ?? 4_000 },
                { store, environment },
              );
              return formatContext(result);
            },
            policy: config.policy ?? {},
            repoPath,
            sourceRepo: config.sourceRepo ?? repoPath,
            engineRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
            // Sandboxes are scratch: they belong in the disposable tree. Results do NOT
            // move, because the drawn-cohort denominator is counted from those files rather
            // than from ledger rows, so losing them breaks a rule this build enforces.
            sandboxesRoot: (await layoutFor(repoPath)).sandboxesRoot,
            resultDir: (await layoutFor(repoPath)).gymResultsRoot,
            logger: { step: async (event) => emit(event.phase ?? 'gym', event.step, event.detail, { counts: event.counts, level: event.level }) },
            emitFinding: async (finding) => jobs.notifyFinding?.(finding),
            abortSignal: { get aborted() { return cancelled(); } },
          });
        } finally {
          await store.close?.();
        }
      });
      return { jobId };
    },

    async gymStatus(params) {
      const repoPath = await requireAttached(params);
      return withLedger(repoPath, async (ledger) => {
        const files = await loadResultFiles((await layoutFor(repoPath)).gymResultsRoot).catch(() => null);
        return {
          cycles: ledger.database.prepare('SELECT * FROM cycle ORDER BY id DESC').all(),
          activeRun: jobs.activeGymRun?.(params?.jobId) ?? undefined,
          // drawnFromResultFiles is NULL when the denominator is not derivable. A client
          // renders that as "not derivable" and never as 0: a zero meaning "four exams
          // vanished" is the exact defect the drawn-cohort rule exists to remove.
          ledger: ledger.summary({ resultFiles: files }),
        };
      });
    },

    /// The bank plus the draft queue. An empty bank is a legitimate state, not an error: a
    /// repo whose exams have never been mined has none, and that renders as an empty view.
    async examList(params) {
      const repoPath = await requireAttached(params);
      return withLedger(repoPath, async (ledger) => ledger.listExams(params?.filters ?? {}));
    },

    async examDetail(params) {
      if (!params?.examId) throw invalidParams('examId is required', 'examDetail needs an examId.');
      const repoPath = await requireAttached(params);
      return withLedger(repoPath, async (ledger) => {
        const exam = ledger.getExam(params.examId);
        if (!exam) throw invalidParams('unknown examId', `No exam named ${params.examId} is in the bank.`);
        // Through the ledger's own accessor, never past it into the tables. The raw SELECT
        // that used to be here coupled this surface to a schema the daemon does not own, and
        // when the rubric tables landed it would have returned rows with no rubric field:
        // every attempt reading ungraded, forever, with nothing failing. The explicit sort
        // stays because the top-level axes depend on it and the accessor's order is the
        // ledger's business, not a promise to this caller.
        const attempts = attemptsNewestFirst(ledger.attemptsForExam(params.examId));
        // NOTE, dated 2026-08-16 (finding 79): this used to return `axes: {}` behind a
        // comment saying "empty until the grading round lands". The grading round HAS
        // landed, and `{}` is now a forbidden value: an empty object renders on a radar
        // exactly like a set of measured zeros. The ruled shape is null when ungraded, and
        // a canonically-ordered list of { name, score, max } when graded.
        const graded = attempts.map((attempt) => {
          const axes = axesFor(attempt.rubric);
          // Prose for humans, code for branching. A client that switches on the sentence
          // breaks the day the sentence is improved.
          const explanation = axes ? null : ungradedExplanation(attempt);
          return attemptForWire(attempt, {
            axes,
            ungradedCode: explanation?.code ?? null,
            ungradedReason: explanation?.reason ?? null,
          });
        });
        const latestGraded = graded.find((attempt) => attempt.axes);
        return {
          // `exam` is NOT on the wire: the client reads axes, attempts and provenance and
          // nothing else, verified rather than assumed, and the same standard that took
          // five keys off analyze applies here (D-0035 batch). The record is still read
          // above, to reject an unknown examId and to carry provenance out.
          attempts: graded,
          provenance: exam.provenance ?? null,
          // The most recent GRADED attempt's axes, or null. Null is not "zero on every
          // axis"; it is "this has never been graded", and every attempt carries its own
          // ungradedReason so a reader can tell a missing grade from a missing submission.
          axes: latestGraded?.axes ?? null,
        };
      });
    },

    async examVeto(params) {
      if (!params?.examId) throw invalidParams('examId is required', 'examVeto needs an examId.');
      if (!String(params?.reason || '').trim()) {
        throw invalidParams('veto reason required', 'A veto without a written reason is not reviewable later. Say why.');
      }
      const repoPath = await requireAttached(params);
      return withLedger(repoPath, async (ledger) => {
        const exam = ledger.getExam(params.examId);
        if (!exam) throw invalidParams('unknown examId', `No exam named ${params.examId} is in the bank.`);
        try {
          // Through vetoExam rather than a direct write: the helper and the parser both
          // enforce the reason minimum, and a record reaching the store any other way would
          // carry "broken" as its whole audit trail.
          ledger.putExam(vetoExam(exam, params.reason));
        } catch (error) {
          asParameterError(error, 'veto refused');
        }
        // THE BANK ROW, not the whole record (D-0035 batch). The client ignores this
        // return and reloads the bank, so nothing reads the extra eleven fields, and the
        // row is what the contract references by name. Built with the gym's own
        // examListRow so the wire format cannot drift from the one examList serves.
        return examListRow(ledger.getExam(params.examId));
      });
    },

    async examUpdate(params) {
      if (!params?.examId) throw invalidParams('examId is required', 'examUpdate needs an examId.');
      const repoPath = await requireAttached(params);
      const patch = params?.patch ?? {};
      return withLedger(repoPath, async (ledger) => {
        const exam = ledger.getExam(params.examId);
        if (!exam) throw invalidParams('unknown examId', `No exam named ${params.examId} is in the bank.`);
        try {
          // Quarantine goes through its helper for the same reason a veto does: both it and
          // the parser enforce the 20-character reason.
          const next = patch.benchmarkStatus === 'quarantined'
            ? quarantineExam({ ...exam, ...patch }, patch.quarantineReason ?? exam.quarantineReason)
            : parseExamRecord({ ...exam, ...patch }, params.examId);
          ledger.putExam(next);
        } catch (error) {
          asParameterError(error, 'invalid exam patch');
        }
        // The bank row, for the reason examVeto gives above.
        return examListRow(ledger.getExam(params.examId));
      });
    },

    // ---- init and narration (spend-touching where marked) -----------------------------

    /**
     * Build a repo's brain. Returns a jobId; everything else arrives on the step stream.
     *
     * The SPEND BOUNDARY is crossed before any work, not inside the job: a refusal that
     * arrived as a step event would mean the user had already watched a job start.
     */
    async initBrain(params) {
      const repoPath = await requireAttached(params);
      const mode = params?.mode;
      if (!INIT_MODES.includes(mode)) {
        throw invalidParams('unknown mode', `mode must be one of ${INIT_MODES.join(', ')}.`);
      }
      // Layer 2 runs LLM narration on the user's engineer key. The budget is displayed and
      // CONFIRMED per call; without the confirmation this is refused before any work.
      if (mode === 'layer1+layer2') {
        await requireConsent('initBrain layer1+layer2', params,
          'Layer 2 narration runs on your engineer key and spends. The estimated budget from budgetEstimate has to be shown and agreed before the job starts. Layer 1 is deterministic and free.');
      }
      if (mode === 'ingest') {
        // Refused HERE as well as in the pipeline, and the duplication is deliberate: the
        // pipeline's throw comes after its analyze pass, so a user who asked for a mode
        // that does not exist would watch a job start and then fail. This is the refusal
        // they meet; the pipeline's is the backstop for a direct caller.
        //
        // The reason is init-miner's and stands: adopting an existing knowledge folder
        // as-is needs its own auditor drift check, and silently generating a Layer 1 brain
        // over a curated one would overwrite the user's work with machine output.
        throw notImplemented('initBrain mode ingest', 'P3 (adopt an existing knowledge folder)',
          'Adopting an existing knowledge folder as-is needs its own drift check; generating over a curated folder would overwrite your work with machine output. Use mode layer1 to generate.');
      }

      const settings = await state.settings();
      const retrieval = settings.retrieval || {};
      const model = retrieval.embeddingModel || DEFAULT_EMBEDDING.model;
      const dimension = Number(retrieval.embeddingDimension || DEFAULT_EMBEDDING.dimension);
      const baseUrl = retrieval.ollamaBaseUrl || undefined;

      const jobId = jobs.start('init', async ({ emit, cancelled }) => {
        // IDENTITY FIRST, before anything is built (D-0031 invariant 4: init is a lifecycle
        // contract, not a folder check). The manifest is what the state root is keyed by, so
        // a brain built before an identity exists would be written under a path-derived key
        // and then orphaned by the manifest that arrived after it. Generated once and never
        // regenerated; an existing manifest is left byte-identical.
        const layout = await repoLayout(repoPath, { stateRoot: state.stateRoot, ensure: true, now });
        emit('identity', 'manifest', `repo ${layout.repoId}`, { counts: { schema: layout.manifest.schema } });
        // A repo that MOVED keeps its identity and its records and rebuilds its index. Said
        // out loud rather than handled silently: from in here a move and a second clone
        // sharing one manifest are indistinguishable, and a user who cloned should hear that
        // the two checkouts share an index rather than discover it.
        const origin = await noteOrigin(layout, { now });
        if (origin.moved) {
          emit('identity', 'moved',
            `this brain was last indexed for ${origin.from}; rebuilding the index for ${layout.repoPath}. Measurement history is kept.`);
        }
        const client = makeEmbedderClient({ model, dimension, baseUrl });

        // THE DIGEST IS LEARNED ON FIRST INDEX, then pinned by the index itself.
        //
        // embeddingIdentity() requires a digest and a first-boot user has none: asking
        // someone to run `ollama list` and paste a hash before they can build a brain is a
        // setup step nobody would forgive. So an unconfigured digest is discovered from the
        // SERVED model here. That is not a weakening of the identity assert, because the
        // assert compares the INDEX's recorded digest against the served one on every later
        // query; learning it once at build time is exactly how the index gets something to
        // pin. A configured digest still wins, which is how a user pins it deliberately.
        const configuredDigest = retrieval.embeddingDigest?.trim();
        const digest = configuredDigest || (await ollama({
          environment: { EMBEDDING_MODEL: model, ...(baseUrl ? { OLLAMA_BASE_URL: baseUrl } : {}) },
        })).digest;
        const pipelineEnvironment = {
          EMBEDDING_PROVIDER: 'ollama',
          EMBEDDING_MODEL: model,
          EMBEDDING_DIM: String(dimension),
          EMBEDDING_MODEL_DIGEST: digest,
          ...(baseUrl ? { OLLAMA_BASE_URL: baseUrl } : {}),
        };
        // Resolved through the SAME function retrieve uses, so the index identity and the
        // query identity cannot drift. The digest still comes from the server; only the
        // name is reconciled.
        const served = await indexIdentity({ environment: pipelineEnvironment });
        // A CONCRETE project scope: retrieval requires a non-empty project while the store
        // treats null as the whole store, so a null-project store writes documents no query
        // selects and every gold case misses for a reason unrelated to retrieval.
        const store = await openStore(repoPath, { path: layout.databasePath, embedder: served, project: 'default' });
        try {
          if (cancelled()) return;
          const report = await runInit({
            repoPath,
            mode,
            store,
            embedder: embedderFromClient(client),
            environment: { ...pipelineEnvironment, EMBEDDING_MODEL_DIGEST: served.digest ?? '' },
            // Where artifacts land and where gate commands run. Both default to the repo,
            // which is what a user's own repo wants; a repo Daijin has no authorization to
            // write into points them elsewhere.
            ...(params?.artifactRoot ? { artifactRoot: params.artifactRoot } : {}),
            ...(params?.gateRepoPath ? { gateRepoPath: params.gateRepoPath } : {}),
            k: retrieval.k ?? 8,
            jobId,
            // The pipeline already emits the contract's step shape, so it is forwarded
            // rather than rewrapped. ts is restamped by the runner so every event on the
            // stream comes from one clock.
            onStep: (event) => {
              if (cancelled()) return;
              emit(event.phase, event.step, event.detail, { counts: event.counts, level: event.level });
            },
            // Layer 2 is not reachable in this build: no narrator is passed, so the
            // pipeline's own spend boundary refuses it. The consent check above is the
            // user-facing gate; this is the structural one.
            narrator: null,
            confirmedBudget: normalizeBudgetEcho(params?.budget)?.estimatedTokens ?? null,
            narrationAreas: params?.scope?.areas ?? null,
            spendGate: await gate({ file: gymSpendGatePath(repoPath) }).then((row) => ({ open: row.open, path: row.file })),
          });

          // A floor measured by init is the same measurement retrievalScore produces, so it
          // lands in the same history the repo card trend reads. Two sources writing two
          // histories would give a card that shows half its own measurements.
          if (report?.floor?.caseRate) await appendScoreHistory(repoPath, report.floor, { store });
        } finally {
          await store.close?.();
        }
      });
      return { jobId };
    },

    async diagnoseNarrate(params) {
      await requireAttached(params);
      await requireConsent('diagnoseNarrate', params,
        "The auditor's recommendation is a paid generation. The mechanical clusters from diagnose are free and already answer most of the question.");
      throw notImplemented('diagnoseNarrate', 'P3 (auditor narration)',
        'Confirmed, but the auditor role and the mechanical clusters it narrates over do not exist yet.');
    },

    // ---- settings, roles, board -------------------------------------------------------

    async settingsGet() {
      const settings = await state.settings();
      const repos = await state.repos();
      const gatePath = repos[0] ? gymSpendGatePath(repos[0].path) : null;
      settings.spendGate = gatePath
        ? await gate({ file: gatePath }).then((row) => ({ open: row.open, path: row.file }))
        : { open: false, path: null };
      return settings;
    },

    async settingsSet(params) {
      const patch = params?.patch;
      if (!patch || typeof patch !== 'object') throw invalidParams('patch is required', 'settingsSet needs a patch object.');
      for (const rolePatch of patch.roles || []) {
        if (!ROLES.includes(rolePatch?.role)) {
          throw invalidParams('unknown role', `role must be one of ${ROLES.join(', ')}.`);
        }
        // A key VALUE must never reach the daemon. keyRef points at an env var or a file.
        if (Object.hasOwn(rolePatch, 'key') || Object.hasOwn(rolePatch, 'apiKey')) {
          throw invalidParams('secrets are pointers, never values',
            'Set keyRef to the name of an environment variable or a file path. The engine never stores a key value.');
        }
      }
      return state.patchSettings(patch);
    },

    async rolePing(params) {
      if (!ROLES.includes(params?.role)) {
        throw invalidParams('unknown role', `role must be one of ${ROLES.join(', ')}.`);
      }
      // Refused BEFORE the not-implemented, deliberately. A role ping is a real provider
      // generation, so the confirmation requirement is enforced now, while there is no
      // provider client to reach, rather than added later next to one.
      await requireConsent('rolePing', params,
        'A role ping is a real provider generation and costs money. It only ever runs when you ask for it, never on a screen opening.');
      throw notImplemented('rolePing', 'P3 (first-boot model setup)',
        'Confirmed, but no role has an endpoint or a key pointer configured yet, so there is nothing to ping.');
    },

    async board(params) {
      const filters = params?.filters || {};
      const all = await state.board();
      const rows = all.filter((row) => ['source', 'severity', 'status', 'category']
        .every((field) => !filters[field] || filters[field] === 'all' || row[field] === filters[field]));
      return { rows, total: all.length };
    },

    /// A role's instruction file, with the hashes the settings badge is computed from.
    ///
    /// Deferred until the shipped defaults existed, because `modified` is a comparison
    /// AGAINST a default and a badge with nothing to compare to would have been decoration.
    /// gym-porter's agents-defaults are that default; this reads through its loader rather
    /// than hashing the files a second way, so the badge and the gym cannot disagree about
    /// whether a file is modified.
    async agentFileGet(params) {
      const role = params?.role;
      if (!AGENT_ROLES.includes(role)) {
        throw invalidParams('unknown role', `role must be one of ${AGENT_ROLES.join(', ')}.`);
      }
      const repoPath = await requireAttached(params);
      const record = await readAgentFile(repoPath, role);
      // `installed` is additive: a fresh repo reads the DEFAULT rather than erroring, and
      // the flag is how the TUI can say "showing the shipped default" instead of implying
      // the user has a file they do not.
      return {
        content: record.content,
        defaultHash: record.defaultHash,
        currentHash: record.currentHash,
        modified: record.modified,
        path: record.path,
        installed: record.installed,
      };
    },

    async agentFileSet(params) {
      const role = params?.role;
      if (!AGENT_ROLES.includes(role)) {
        throw invalidParams('unknown role', `role must be one of ${AGENT_ROLES.join(', ')}.`);
      }
      const repoPath = await requireAttached(params);
      if (typeof params?.content !== 'string') {
        throw invalidParams('content is required', 'agentFileSet takes the full instruction file content as a string.');
      }
      try {
        const record = await writeAgentFile(repoPath, role, params.content);
        return {
          content: record.content,
          defaultHash: record.defaultHash,
          currentHash: record.currentHash,
          modified: record.modified,
          path: record.path,
          installed: record.installed,
        };
      } catch (error) {
        // An empty rules file silently removes every rule, which is the one edit that looks
        // like a small change and is not. The loader refuses it; the refusal is surfaced as
        // a parameter error rather than an internal one, because it is the caller's to fix.
        if (/empty/.test(error.message)) throw invalidParams('empty instruction file', error.message);
        throw error;
      }
    },
  };
}

export { ROLES, AGENT_ROLES, INIT_MODES };
