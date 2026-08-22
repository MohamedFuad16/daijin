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

import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { homedir } from 'node:os';
import { loadProviderCatalog } from '../roles/providers.js';
import { resolveKey } from '../roles/keys.js';
import { pingProvider } from '../roles/ping.js';
import { FIX_CATALOG, ZAI_PAYG_URL, auditTriage, examBankFindings, gateFindings, gateRunFindings, goalStopDecision, roleFindings, statusFindings, watcherVerify } from './watch.js';
import { scanAgentCatalog } from '../roles/agents.js';
import { cloneRepository, parseCloneUrl } from '../init/clone.js';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { analyze as analyzeRepo } from '../init/analyze.js';
import { discoverGates, gatesFilePath, renderGatesYaml } from '../init/gate-discovery.js';
import { embedderFromOllama, servedIndexIdentity } from '../init/ingest.js';
import { artifactPaths, initBrain as runInitPipeline, reindexFromBrain } from '../init/pipeline.js';
import { writeLessonUnit } from '../init/brain-artifacts.js';
import { caseRateOf, MCP_UNLOCK_THRESHOLD, mcpUnlock } from '../init/floor.js';
import { discriminatingRange, permuteAnswers } from '../init/rerank-ab.js';
import { scoreGoldset } from '../init/retrieval-score.js';
import { createOllamaClient } from '../../../adapters/ollama/client.js';
import { checkOllama } from '../rag/embed.js';
import { formatContext } from '../rag/context.js';
import { retrieve as retrieveImpl } from '../rag/retrieve.js';
import { getAgentFile as readAgentFile, setAgentFile as writeAgentFile, studentRules } from '../gym/agent-files.js';
import { runGymCycle } from '../gym/cycle.js';
import { AXES, buildGradingPacket } from '../gym/grading.js';
import { answersToProposals, applyProposals, buildHarvestQuestions, curateProposals, harvestBatch } from '../gym/harvest.js';
import { harvestAnswersWithTeacher } from '../gym/teacher-driver.js';
import { examDrawRefusal, examListRow, parseExamRecord, quarantineExam, vetoExam } from '../gym/exams.js';
import { GymLedger, gymDatabasePath } from '../gym/ledger.js';
import { loadResultFiles } from '../gym/result-files.js';
import { GYM_SPEND_SCOPES, assertSpendGate, gymSpendGatePath, ownerAuthorizeSpendGate, readSpendGate, writeBlockedSpendGate } from '../gym/spend-gate.js';
import { mineCommits, selectBankWithAuditor, validateChosenExam } from '../gym/mining.js';
import { buildCommitteeAuditor } from '../gym/committee.js';
import { createRoleGenerate } from '../roles/driver.js';
import { createEngineerDriver } from '../gym/engineer-driver.js';
import { isGradableRun } from '../gym/run-mode.js';
import { createSandbox } from '../gym/sandbox.js';
import { expandGates, runGateSet } from '../gym/gates.js';
import { createSqliteStore } from '../store/sqlite.js';
import { noteOrigin, repoLayout } from '../state/layout.js';
import { invalidParams, spendRefused } from './errors.js';

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
/**
 * One cycle in the shape the WIRE owes.
 *
 * gymStatus shipped `SELECT * FROM cycle` raw: snake_case column names and an unparsed JSON
 * string sitting beside boundary-mapped fields in the same response. That is the anti-
 * pattern this file's own examDetail comment argues against, twenty lines away, and it
 * survived because nobody read the two together.
 */
export function cycleForWire(cycle) {
  return {
    id: cycle.id,
    mode: cycle.mode,
    trigger: cycle.trigger ?? null,
    status: cycle.status,
    startedAt: cycle.started_at,
    finishedAt: cycle.finished_at ?? null,
    // PARSED. A client should not have to know the ledger stores this as a JSON string, and
    // one that did would be parsing a storage detail it cannot see the schema of.
    config: parseJsonOr(cycle.config, {}),
    brainVersionStart: cycle.brain_version_start ?? null,
    brainVersionEnd: cycle.brain_version_end ?? null,
  };
}

function parseJsonOr(text, fallback) {
  try {
    return typeof text === 'string' ? JSON.parse(text) : (text ?? fallback);
  } catch {
    // A row whose config cannot be parsed is a fact about that row, not a reason to fail a
    // status call that is mostly about other rows.
    return fallback;
  }
}

export function attemptForWire(attempt, { axes, ungradedCode, ungradedReason }) {
  return {
    id: attempt.id,
    at: attempt.at,
    mode: attempt.mode,
    status: attempt.status,
    // The rubric's verdict when one exists: the run row's verdict column
    // predates inline grading and stays null on graded rows, which served a
    // "VERDICT null" beside five populated axes in the first live graded run.
    verdict: attempt.rubric?.verdict ?? attempt.verdict ?? null,
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

/**
 * One gym step's detail, rendered for a feed that shows text.
 *
 * The gym passes structured subjects and details (an exam id, a list of gate verdicts) and
 * the step stream carries a sentence. Compact rather than pretty: this is a live feed line,
 * not a record, and the record is the result file.
 */
export function describeStep(subject, detail, startedAt) {
  const parts = [];
  if (subject && typeof subject === 'object') {
    parts.push(Object.entries(subject).map(([key, value]) => `${key}=${value}`).join(' '));
  } else if (subject) parts.push(String(subject));
  if (typeof detail === 'string') parts.push(detail);
  else if (Array.isArray(detail)) parts.push(detail.map((row) => (typeof row === 'object' ? JSON.stringify(row) : String(row))).join(', '));
  else if (detail && typeof detail === 'object') parts.push(JSON.stringify(detail));
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
    parts.push(`${Math.max(0, Math.round(Date.now() - startedAt))}ms`);
  }
  return parts.filter(Boolean).join(' ') || 'step';
}

/**
 * What is true about a path someone asked to attach: whether it can be a repo at all, and
 * whether it looks like the repo they meant.
 *
 * Separate from repoAttach so it can be tested without a daemon, and so the two answers
 * stay distinct: a REFUSAL is for a path that cannot work, and a WARNING is for one that
 * works and probably surprises.
 */
export async function inspectAttachTarget(repoPath, { runGit = null, stat: statFn = stat, realpath: realpathFn = realpath } = {}) {
  const resolved = path.resolve(repoPath);

  let info;
  try {
    info = await statFn(resolved);
  } catch {
    return {
      refusal: {
        summary: 'no such directory',
        hint: `${resolved} does not exist. Attach the path to a repository on this machine; a mistyped or partial command line lands here (the field test attached the literal string "cd").`,
      },
      warning: null,
    };
  }
  // NEVER A PROJECT, refused before anything else touches the filesystem.
  //
  // The owner's home screen hung on an attached `/`, left by an early field test before
  // attach validated anything. Under D-0036 `/` passes every existing check: it exists, it
  // is a directory, it is simply not a git repo, so it WARNED AND ATTACHED. But a
  // filesystem root is not works-and-produces-less: there is no project there to produce
  // anything from, and analyzing it means walking the whole disk.
  //
  // This does not reopen D-0036. That ruling drew the line between what cannot work and
  // what merely surprises; these two paths are on the cannot-work side and were simply
  // never named. A home directory is the same case: it is a container of projects, and
  // attaching it mines a decade of unrelated material.
  const home = homedir();
  if (resolved === path.parse(resolved).root || resolved === path.resolve(home)) {
    return {
      refusal: {
        summary: 'not a project',
        hint: `${resolved} is a ${resolved === home ? 'home directory' : 'filesystem root'}, not a project. Attach the repository you want a brain for; attaching a whole disk would mine everything on it and finish for nobody.`,
      },
      warning: null,
    };
  }
  if (!info.isDirectory()) {
    return {
      refusal: { summary: 'not a directory', hint: `${resolved} is a file. Attach the repository directory that contains it.` },
      warning: null,
    };
  }

  const git = runGit ?? (async (args, cwd) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('git', args, { cwd });
    return stdout.trim();
  });

  let toplevel = null;
  try {
    toplevel = await git(['rev-parse', '--show-toplevel'], resolved);
  } catch {
    // WARNED, NOT REFUSED, against the letter of the field-test ruling and measured before
    // deciding: init on a directory with no git COMPLETES eight phases and blocks only at
    // the gold-set gates, which is the same block a too-small repo gets and now carries its
    // own explanation. So this is a path that WORKS AND PRODUCES LESS, not one that cannot
    // work, and the distinction this function is built on puts it here.
    //
    // Stated plainly because the convenient answer and the correct one coincide, which is
    // the shape of a motivated conclusion: refusing also breaks sixty test fixtures, and
    // that is not the reason. The reason is the measurement above; if the ruling stands as
    // written the fixtures are cheap to fix and I will fix them.
    return {
      refusal: null,
      warning: {
        code: 'not-a-git-repository',
        detail: `${resolved} is not inside a git repository. Daijin mines commit history for its gold set and its lessons, so a brain built here will be much thinner: no commit archaeology, no fix-and-revert lessons, and usually too few gold cases to measure. Run git init and commit, or attach a repository.`,
        attached: resolved,
        repositoryRoot: null,
      },
    };
  }

  // THE NESTED CASE. Legitimate for a monorepo package and a mistake most other times, so
  // it is reported rather than refused. Named both ways round, because the useful sentence
  // is not "this is a subdirectory" but "here is the root you may have meant".
  // COMPARED THROUGH REALPATH, and this was a bug in the first version of this check that
  // its own test caught. path.resolve does not resolve symlinks, while `git rev-parse
  // --show-toplevel` always answers with the real path. On macOS /var is a symlink to
  // /private/var, so attaching a repository ROOT under a symlinked path produced a
  // nested-in-repository warning whose detail named the SAME directory on both sides.
  //
  // That is the failure mode worth avoiding twice over: a warning that fires on the
  // correct action teaches the owner to dismiss warnings, and the next one to fire is the
  // real one. Both sides go through realpath so the comparison is between two canonical
  // paths rather than between two spellings of one.
  const canonicalAttached = await realpathFn(resolved).catch(() => resolved);
  const canonicalToplevel = await realpathFn(toplevel).catch(() => path.resolve(toplevel));
  if (canonicalToplevel !== canonicalAttached) {
    return {
      refusal: null,
      warning: {
        code: 'nested-in-repository',
        detail: `You attached ${resolved}, which is a subdirectory of the repository at ${canonicalToplevel}. `
          + 'That is fine for a single package in a monorepo, and a mistake otherwise: the file walk sees only this '
          + 'directory while git answers from the repository root, so the analysis reports few files against many '
          + 'commits and nothing else says why.',
        attached: resolved,
        repositoryRoot: canonicalToplevel,
      },
    };
  }
  return { refusal: null, warning: null };
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
  /// Resolve one role into a live generate function plus its identity: the
  /// shared plumbing under the auditor committee, the live engineer, and the
  /// inline teacher. Refuses (invalidParams) when the role is unconfigured.
  const roleGenerate = async (roleName) => {
    const settings = await state.settings();
    const role = settings.roles.find((row) => row.role === roleName);
    if (!role?.provider || !role?.model) {
      throw invalidParams(`${roleName} not configured`,
        `The ${roleName} role has no provider or model configured. Set it up in settings first.`);
    }
    const catalog = await loadProviderCatalog();
    const entry = catalog.providers.find((candidate) => candidate.id === role.provider);
    let key = null;
    if (entry?.keyRequired ?? true) {
      if (!role.keyRef) throw invalidParams('no key pointer', `The ${roleName} role has no key pointer and ${role.provider} needs one.`);
      try {
        key = await resolveRoleKey(role.keyRef);
      } catch (error) {
        throw invalidParams('key not resolvable', error.message);
      }
    }
    let agentPath = null;
    if (role.provider === 'claude-code' && role.agentRef) {
      const agents = await scanAgents({ repoPaths: (await state.repos()).map((row) => row.path) });
      agentPath = agents.find((agent) => agent.id === role.agentRef)?.path ?? null;
    }
    const endpoint = role.endpoint || entry?.endpointDefault || null;
    return {
      role: { ...role, endpoint },
      key,
      agentPath,
      generate: makeAuditorGenerate({ ...role, endpoint }, { key, agentPath }),
      identity: { role: roleName, model: role.model, endpoint: endpoint ?? 'default' },
    };
  };

  // THE PAID SEAM. `engineer.next()` is the only provider call in a gym cycle. The
  // default factory builds the live driver from the ENGINEER role the owner configured
  // (claude-code roles run their chosen sub-agent); injectable so a cycle is fully
  // testable with a scripted student at zero spend.
  const createEngineer = deps.createEngineer || (async ({ settings, repoPath }) => {
    const role = settings.roles.find((row) => row.role === 'engineer');
    if (!role?.provider || !role?.model) {
      throw invalidParams('engineer not configured',
        'The student IS the engineer role, and it has no provider or model configured. Set it up in settings first.');
    }
    const catalog = await loadProviderCatalog();
    const entry = catalog.providers.find((candidate) => candidate.id === role.provider);
    let key = null;
    if (entry?.keyRequired ?? true) {
      if (!role.keyRef) throw invalidParams('no key pointer', `The engineer role has no key pointer and ${role.provider} needs one.`);
      key = await resolveRoleKey(role.keyRef);
    }
    let agentPath = null;
    if (role.provider === 'claude-code' && role.agentRef) {
      const agents = await scanAgents({ repoPaths: (await state.repos()).map((row) => row.path) });
      agentPath = agents.find((agent) => agent.id === role.agentRef)?.path ?? null;
    }
    return createEngineerDriver({
      role: { ...role, endpoint: role.endpoint || entry?.endpointDefault || null },
      key,
      agentPath,
    });
  });
  // The rolePing seam: the generation, the key resolution, and the agent scan are all
  // injectable so the ping path is fully testable against a local mock HTTP server with
  // no provider, no key, and no claude CLI on the machine.
  const ping = deps.pingProvider || pingProvider;
  const resolveRoleKey = deps.resolveKey || resolveKey;
  const scanAgents = deps.scanAgentCatalog || scanAgentCatalog;
  // The exam-mining seams, injectable so the funnel is testable with no git
  // walk, no provider, and no worktree; production uses the real four.
  const mine = deps.mineCommits || mineCommits;
  const selectBank = deps.selectBank || selectBankWithAuditor;
  const validateExam = deps.validateExam || validateChosenExam;
  const makeAuditorGenerate = deps.createRoleGenerate || createRoleGenerate;

  /// The gym run in flight, or null. `jobs.activeGymRun?.()` was called and DID NOT EXIST,
  /// so gymStatus.activeRun was permanently absent although the contract names it. The job
  /// runner is the wrong owner: it knows about jobs and nothing about exams, so the fact
  /// lives here, set when a cycle starts and cleared in the same finally that closes its
  /// handles.
  let activeGymRun = null;

  /**
   * The last status probe, reused for a few seconds.
   *
   * serveStatus runs on a screen paint and every paint re-probed, so a slow endpoint cost
   * its full timeout EVERY TIME and a client polling faster than the timeout piled calls
   * up behind each other. The cache turns a repeated cost into a single one.
   *
   * KEYED ON ENDPOINT AND MODEL, so changing either through settings re-probes at once
   * rather than showing the old answer for the rest of the window. A cache that outlived a
   * configuration change would report the state of a server the engine is no longer using,
   * which is the exact defect F5 fixed and I will not reintroduce behind a cache.
   *
   * SHORT on purpose: a user who starts ollama should see it within a paint or two. This
   * caches FAILURES as well as successes, and a long window would make recovery look
   * broken.
   */
  const PROBE_CACHE_MS = 3_000;
  let probeCache = null;
  const cachedProbe = async (key, probe, { fresh = false } = {}) => {
    if (!fresh && probeCache && probeCache.key === key && now() - probeCache.at < PROBE_CACHE_MS) {
      return probeCache.value;
    }
    // A bypassed probe still WRITES its result, so an explicit check refreshes the window
    // rather than leaving the stale entry behind it for the next automatic paint to serve.
    const value = await probe();
    probeCache = { key, at: now(), value };
    return value;
  };

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

  /// Re-block a repo's spend gate. Called from the finally of every job that
  /// spends (D-0060): an authorization lives exactly as long as the run it
  /// authorized. Best-effort by design - a reblock failure must not turn a
  /// finished run into a failed one, but it is worth a stderr line.
  const reblockGate = async (repoPath) => {
    try {
      // Named gatePath, not file: the mutation guard's alias rule flags any
      // write to an identifier that ever held the gate path, and methods.js
      // writes OTHER files through a variable named file (gates.yaml).
      const gatePath = gymSpendGatePath(repoPath);
      await mkdir(path.dirname(gatePath), { recursive: true });
      await writeBlockedSpendGate(gatePath, 'Re-blocked automatically when the authorized run ended.');
    } catch (error) {
      console.error(`could not re-block the spend gate for ${repoPath}: ${error.message}`);
    }
  };

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
  /// `at` is accepted rather than always generated, because retrievalScore stamps its
  /// record before writing and a second `new Date()` here would put a different moment on
  /// the same measurement.
  async function appendScoreHistory(repoPath, floor, { store = null, at = null } = {}) {
    const history = await readHistory(repoPath);
    const layout = await layoutFor(repoPath);
    history.unshift({
      at: at ?? new Date(now()).toISOString(),
      caseRate: floor.caseRate,
      chosenBudget: floor.chosenBudget ?? null,
      embedding: floor.embedding ?? null,
      // The unlock enforces this floor from history, so a history row that
      // dropped it would silently un-enforce it (the dogfood catch).
      violations: floor.violations ?? null,
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

  // NAMED, not returned inline: server dispatch grabs bare function references
  // (methods[name]), so `this` inside a handler is undefined. systemCheck
  // composes serveStatus through this binding instead.
  const api = {
    // ---- handshake and lifecycle ------------------------------------------------

    async hello() {
      // contractVersion tracks methods.md's version. A mismatch renders an upgrade screen
      // in the TUI, which is why this is a value and not an error.
      return { engineVersion: ENGINE_VERSION, contractVersion: CONTRACT_VERSION };
    },

    /**
     * Attach a repo, refusing what cannot be one and WARNING about what probably is not the
     * one the user meant.
     *
     * Both halves come from the owner's field test. A literal `cd` was attached by accident
     * and accepted, because the only check was that a string arrived; and a NESTED
     * near-empty directory was attached inside a real repository, which is the failure that
     * cost a screenshot and an archaeology session to diagnose. The nested case is the
     * nastier one because everything downstream then behaves plausibly: the walk sees one
     * file, `git` answers from the PARENT repository, so the analysis reports a handful of
     * files against dozens of commits and nothing says the two came from different places.
     *
     * The warning is a WARNING and not a refusal: attaching a subdirectory is legitimate
     * (a monorepo package is the obvious case), so the engine says what it noticed and
     * leaves the decision where it belongs.
     */
    async repoAttach(params) {
      const repoPath = requireRepoPath(params);
      const inspection = await inspectAttachTarget(repoPath, { runGit: deps.runGit });
      if (inspection.refusal) throw invalidParams(inspection.refusal.summary, inspection.refusal.hint);
      const repo = await state.attachRepo(repoPath);
      // Null rather than absent when there is nothing to say, so a client can tell "checked
      // and fine" from "this engine does not report warnings".
      return { repo, warning: inspection.warning };
    },

    // ATTACH BY URL, as a job (D-0039). The clone is minutes of network work with a
    // progress stream, so it is not an overload of repoAttach: a client must be able to
    // tell a local row from a long remote operation before it calls, and the shape of an
    // argument is not a way to tell it.
    async repoClone(params) {
      const url = params?.url;
      if (typeof url !== 'string' || !url.trim()) {
        throw invalidParams('url is required', 'repoClone needs the URL of a repository to clone.');
      }
      const name = params?.name ?? null;
      if (name !== null && (typeof name !== 'string' || !name.trim())) {
        throw invalidParams('name must be a non-empty string', 'Omit name to use the repository\'s own name.');
      }
      // REFUSED BEFORE THE JOB STARTS. A URL we cannot parse is knowable immediately, and
      // handing back a jobId that fails on its first step makes the client render a
      // progress screen for a mistake it could have been told about in the same breath.
      if (!parseCloneUrl(url)) {
        throw invalidParams('unparseable repository URL',
          `${url} is not a repository URL this can clone. Expected something like https://github.com/owner/name or git@github.com:owner/name.git. To attach a directory you already have, use repoAttach.`);
      }

      const jobId = jobs.start('clone', async ({ emit, cancelled }) => {
        const cloned = await cloneRepository({
          url,
          name,
          stateRoot: state.stateRoot,
          cancelled,
          runGit: deps.runGit,
          emit: async (step, detail, extra) => emit('clone', step, detail, extra),
        });
        if (!cloned || cancelled()) return;
        await emit('clone', 'attaching', `attaching ${cloned.destination}`, { destination: cloned.destination });
        const inspection = await inspectAttachTarget(cloned.destination, { runGit: deps.runGit });
        if (inspection.refusal) {
          // A clone that lands but does not inspect as a repository is a bug rather than a
          // user error, and it is reported rather than swallowed into a bare failure.
          throw Object.assign(new Error(inspection.refusal.summary), { hint: inspection.refusal.hint });
        }
        const repo = await state.attachRepo(cloned.destination);
        return { repo, warning: inspection.warning, destination: cloned.destination, reused: cloned.reused };
      });
      return { jobId };
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
      // THE SAME WARNING ATTACH GIVES, because this is the method whose numbers the
      // warning explains. A client calling analyze on a subdirectory sees the PARENT's
      // commit count against a handful of files, and nothing in the response says why: the
      // walk sees the subdirectory while git answers from the repository root. That exact
      // reading is what stalled the owner's field test, and attach warning about it does
      // not help a client that went straight here.
      const inspection = await inspectAttachTarget(repoPath).catch(() => ({ warning: null }));
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
        warning: inspection.warning,
        walk: analysis.walk,
      };
    },

    async serveStatus(params) {
      // EXPLICIT FRESHNESS, for a user-initiated check only (D-0044).
      //
      // Caching failures was right for the paint path and it created a lie behind the one
      // button a user presses right after fixing the thing: start ollama, press refresh,
      // read `unreachable` from a cache. ctrl+r is the user saying "I changed something,
      // look again", which is exactly the input where a cached answer is wrong.
      //
      // Only an exact `true` bypasses, and anything else is REFUSED rather than coerced: a
      // client sending `fresh: "yes"` would otherwise be silently ignored and would look
      // like a broken refresh, which is the defect this parameter exists to fix.
      if (params?.fresh !== undefined && typeof params.fresh !== 'boolean') {
        throw invalidParams('fresh must be a boolean',
          'Pass fresh: true only for an explicit user-initiated check; automatic refreshes should use the cache.');
      }
      const fresh = params?.fresh === true;
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

      // CONFIGURATION IS NOT A PROBE RESULT. The endpoint, the embedding model and the
      // dimension are known from settings whether or not ollama answers, and the previous
      // shape conflated the two: it nulled the model on failure and never carried the
      // endpoint or the dimension at all, so the owner's status screen rendered "?" for
      // three values the engine held in a variable at that moment (owner field test, F5).
      //
      // The key set is now IDENTICAL on both branches. It differed before (`hint` appeared
      // only on failure), which means no client could rely on a fixed set of keys and the
      // contract-shape gate could not check one.
      const configuredModel = settings.retrieval?.embeddingModel || process.env.EMBEDDING_MODEL || null;
      const configuredDimension = settings.retrieval?.embeddingDimension ?? null;
      // THREADED FROM THE SAME SETTING THE INDEXER USES, and this was a defect of its own,
      // found while fixing F5 rather than reported by it. This call passed a SYNTHETIC
      // environment holding only EMBEDDING_MODEL, so `OLLAMA_BASE_URL` was invisible to the
      // probe and it silently fell back to the localhost default. The ingest path threads
      // the setting properly, so on any machine with a non-default host the status screen
      // and the indexer were probing DIFFERENT SERVERS, with the status screen reporting
      // the healthy one it was not using.
      //
      // Invisible until this batch because the field it would have contradicted did not
      // exist: nothing rendered the endpoint, so nothing could disagree with it. Adding
      // `endpoint` without this fix would have shipped a field that is confidently wrong,
      // which is worse than the "?" the owner complained about.
      const configuredBaseUrl = settings.retrieval?.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || null;
      const probeEnvironment = {
        EMBEDDING_MODEL: configuredModel,
        ...(configuredBaseUrl ? { OLLAMA_BASE_URL: configuredBaseUrl } : {}),
      };
      // WHEN THE PROBE RAN, stamped INSIDE the cached callback so a cached response
      // carries the ORIGINAL probe time rather than the time it was served. Serving the
      // moment of the reply would make every cached answer look fresh, which is the exact
      // thing this field exists to prevent.
      //
      // The rule is already this document's, about ping: "every stored ping is historical
      // (recorded at `at`), never a live reading." The cache turned `ollama` into that
      // class of value and it had no `at`. This is that rule applied, not a new one.
      //
      // ISO string, because that is what every `at` in this codebase is. `ts` is a number
      // on the event stream; `at` is an ISO string on a record; and probedAt is an
      // at-shaped name for an at-shaped thing.
      // One probe per window, whatever the paint rate. The whole block is cached rather
      // than the raw call, so both branches are covered: an unreachable endpoint is the
      // expensive case and caching only success would have missed it entirely.
      const ollamaStatus = await cachedProbe(`${configuredBaseUrl ?? ''}|${configuredModel ?? ''}`, async () => {
      let ollamaStatus;
      try {
        const served = await ollama({ environment: probeEnvironment });
        ollamaStatus = {
          reachable: true,
          probedAt: new Date(now()).toISOString(),
          endpoint: served.endpoint ?? null,
          // The SERVED model, which can differ from the configured one by a tag: settings
          // say `bge-m3` and ollama answers `bge-m3:latest`. The served name is the honest
          // one when we have it, since that is what produced the digest beside it.
          model: served.model ?? configuredModel,
          dimension: configuredDimension,
          version: served.version ?? null,
          digest: served.digest ?? null,
          hint: null,
        };
      } catch (error) {
        ollamaStatus = {
          reachable: false,
          probedAt: new Date(now()).toISOString(),
          endpoint: error.endpoint ?? null,
          model: configuredModel,
          dimension: configuredDimension,
          version: null,
          digest: null,
          hint: error.message,
        };
      }
      return ollamaStatus;
      }, { fresh });

      // The gate is observable BEFORE anything is attempted, per the contract. A user
      // should never discover the gate's state by being refused.
      const gatePath = rows[0] ? gymSpendGatePath(rows[0].path) : null;
      const spendGate = gatePath
        ? await gate({ file: gatePath }).then((row) => ({ open: row.open, path: row.file }))
        : { open: false, path: null };

      return {
        repos: rows,
        ollama: ollamaStatus,
        db: {
          backend: settings.storage?.backend || 'sqlite',
          repos: rows.length,
          // Always a real path: EngineState resolves it in its constructor and refuses to
          // exist without one, so there is no null case to represent. NOT an index path,
          // which is per repository and belongs on the repo row rather than here.
          stateRoot: state.stateRoot,
        },
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
      // recall: true serves the STORED last measurement instantly, stamped recalled: true
      // with the `at` it was taken. A screen opening on a repo should not re-run an
      // embedding sweep per visit - measuring is the explicit button. No stored record
      // falls through to a real measurement, so a first look still works.
      if (params?.recall === true) {
        try {
          const stored = JSON.parse(await readFile((await layoutFor(repoPath)).lastScorePath, 'utf8'));
          if (stored?.record?.caseRate) return { ...stored.record, recalled: true };
        } catch { /* nothing stored yet; measure below */ }
      }
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
        // THE SHARED WRITER, actually called. This block used to duplicate it inline while
        // its own comment claimed otherwise, and the copy ended in `.catch(() => {})`: a
        // full disk dropped the measurement silently here while init's path failed loudly,
        // so the same failure produced an error on one screen and a missing row on another.
        //
        // Duplicating the writer is also what let the two rows drift in the first place;
        // the stamps had to be copied into both, and a third caller would have had to know
        // to copy them again.
        await appendScoreHistory(repoPath, {
          caseRate: record.caseRate,
          chosenBudget: record.chosenBudget,
          embedding: chosen.record?.embedding ?? null,
          violations: record.violations ?? null,
        }, { store, at: record.at });

        // The FULL record beside the history row, so recall: true (and diagnose's recall)
        // can serve this measurement without re-running the sweep. The raw scorer results
        // ride along because clustering needs the misses arrays, not the display rows.
        const layout = await layoutFor(repoPath);
        await mkdir(path.dirname(layout.lastScorePath), { recursive: true });
        await writeFile(layout.lastScorePath, JSON.stringify({ record, results: chosen.results }, null, 2), 'utf8');

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
      // the one the measurement wrote rather than a paraphrase of it. Violations ride from
      // the same history row; null (a pre-field row) is said in the reason, never zeroed.
      const decision = mcpUnlock(caseRate, { violations: history[0]?.violations ?? null });
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
      // recall: true clusters over the STORED last measurement - arithmetic and a sqlite
      // read, no embedder. The arms column is unattributed on recall because per-arm
      // diagnostics are not stored; a fresh diagnose (the default) still carries them.
      if (params?.recall === true) {
        let stored = null;
        try {
          stored = JSON.parse(await readFile((await layoutFor(repoPath)).lastScorePath, 'utf8'));
        } catch { /* nothing stored yet; measure below */ }
        if (Array.isArray(stored?.results) && stored.results.length) {
          return withStore(repoPath, async (store) => {
            const inventory = new Map((await store.allDocuments({ project: null }))
              .map((row) => [row.id, { type: row.type, area: row.meta?.area ?? null }]));
            const clustered = clusterCases(stored.results, inventory, new Map());
            const fingerprint = rangeFingerprint({
              k: settings.retrieval?.k ?? 8,
              tokenBudget: settings.retrieval?.tokenBudget ?? 4_000,
              goldset: await readFile(goldsetPath, 'utf8').catch(() => ''),
              documents: inventory.size,
            });
            return {
              caseRate: caseRateShape(stored.results),
              violations: stored.record?.violations ?? 0,
              ...clustered,
              discriminatingRange: await recallRange(repoPath, fingerprint),
              controlSkipped: null,
              recommendation: null,
              recalled: true,
              at: stored.record?.at ?? null,
            };
          });
        }
      }
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
        // An OPEN draw (no examId) skips exams the draw rule would refuse - a reserved
        // held-out exam in a training cohort is excluded from sampling, not a reason to
        // fail the whole run. The rule is asked, not duplicated. An EXPLICIT pick keeps
        // its loud refusal below, because a person naming a reserved exam should be told.
        const records = wanted.map((row) => ledger.getExam(row.examId));
        const pool = config.examId
          ? records
          : records.filter((exam) => !examDrawRefusal(exam, { mode: config.mode ?? 'harness-debug', cohort: config.cohort ?? 'training' }));
        if (pool.length === 0) {
          throw invalidParams('nothing drawable',
            'Every promoted exam is reserved for held-out measurement under the current mode and cohort. Pick one explicitly to run it as held-out, or promote more exams.');
        }
        return pool.slice(0, config.cohortSize ?? 1);
      });

      // THE DRAW RULES ARE CHECKED HERE, before consent buys a cycle the runner
      // will refuse. The owner met exactly that: a held-out exam picked from
      // the list produced a spend dialog, a job, and a failed run whose only
      // content was a refusal the daemon could have made at the click. The
      // hint carries the fix rather than only the rule.
      const cohort = config.cohort ?? 'training';
      for (const exam of drawn) {
        const refusal = examDrawRefusal(exam, { mode: config.mode ?? 'harness-debug', cohort });
        if (refusal) {
          throw invalidParams('exam cannot be drawn', exam.heldOut && cohort !== 'held-out'
            ? `${refusal} Run it as a held-out cohort (the client sends cohort: "held-out" when you pick a held-out exam), or clear heldOut on the exam first.`
            : refusal);
        }
      }

      // THE GATES COME FROM THE REPO'S OWN FILE, like mining's validation: the
      // cycle's whole measurement is baseline-vs-candidate gates, and the old
      // `config.gates ?? []` default sent every un-configured start into
      // expandGates' (correct) empty-list refusal INSIDE the job. A repo with
      // no live or measured gate is refused here, before consent was spent on
      // a job that cannot measure anything.
      let cycleGates = config.gates;
      if (!Array.isArray(cycleGates) || cycleGates.length === 0) {
        try {
          const parsed = parseGatesFile(await readFile(gatesFilePath(repoPath), 'utf8'));
          cycleGates = (parsed.discovered?.gates || []).filter((gate) => gate.enabled && ['live', 'measured'].includes(gate.classification));
        } catch {
          cycleGates = [];
        }
      }
      if (cycleGates.length === 0) {
        throw invalidParams('no gates carry signal',
          `No live or measured gate exists for ${repoPath}, and a gym run's measurement IS baseline-vs-candidate gates. Run gate discovery (and install any missing runtimes) first.`);
      }

      // BUILT BEFORE THE JOB, so an unconfigured engineer role refuses at the
      // call (where the user is looking) rather than as a failure event inside
      // a job they already consented to. Construction is cheap: no provider is
      // dialled until the first next().
      const engineer = await createEngineer({ settings, repoPath });
      // THE TEACHER RIDES GRADABLE CYCLES (owner round 10: "everything has to
      // be wired"). harness-debug stays ungraded because the ledger refuses
      // rubrics for it; an unconfigured teacher on a gradable mode refuses
      // HERE, before consent buys a cycle whose grades can never arrive.
      let teacher = null;
      if (isGradableRun(config.mode ?? 'harness-debug')) {
        const resolved = deps.createTeacher ? await deps.createTeacher({ settings, repoPath }) : await roleGenerate('teacher');
        teacher = { generate: resolved.generate, grader: resolved.identity ?? resolved.grader };
      }

      const jobId = jobs.start('gym', async ({ emit, cancelled }) => {
        // EVERYTHING inside one try, including the opens: the live run caught
        // openStore throwing BEFORE the old try began, which skipped the gate
        // re-block and left an authorization standing after a failed job.
        let store = null;
        let ledger = null;
        try {
          // Through openBrain, not bare openStore: the index left the repo
          // (D-0031) and a store opened without the layout's path resolves the
          // legacy location - the live run failed on exactly this.
          store = await openBrain(repoPath);
          // Opened HERE so the finally below can close it. It used to be opened inline in
          // the options object, where nothing held a reference to close, so every cycle
          // leaked a better-sqlite3 handle for the life of the daemon.
          ledger = openLedger(repoPath);
          activeGymRun = { jobId, mode: config.mode ?? 'harness-debug', exams: drawn.map((exam) => exam.examId), startedAt: new Date(now()).toISOString() };
          const environment = await embedderEnvironment(store, { ollamaBaseUrl: settings.retrieval?.ollamaBaseUrl });
          // A brainless repo RUNS but cannot certify, so documents are optional and their
          // absence is not an error.
          const documents = environment ? await store.allDocuments({ project: null }) : undefined;
          await runCycle({
            exams: drawn,
            mode: config.mode ?? 'harness-debug',
            cohort,
            ledger,
            teacher,
            gates: cycleGates,
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
              // Context AND the ids it carried: the run artifact records what was shown, so
              // the teacher's citations and the harvest's absent-list have a real list to
              // check against instead of a permanently empty one.
              return {
                context: formatContext(result),
                // Deduplicated: retrieve.js already unions the standing ids into
                // retrievedIds, and a doubled id reaches the teacher's citable list as a
                // doubled id in the prompt's own sentence.
                shownDocumentIds: [...new Set([...(result.meta?.retrievedIds || []), ...(result.meta?.standingIds || [])])],
              };
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
            // POSITIONAL, because that is how every gym module calls it:
            // `logger.step(name, subject, detail, startedAt)`. The wrapper took an EVENT
            // OBJECT and read `event.step`, which on a string argument is undefined, so
            // every gym step would have reached the feed nameless. Latent only because no
            // driver has wired createEngineer yet; the first real cycle would have shown a
            // live view of blank rows.
            logger: {
              step: async (name, subject, detail, startedAt) => emit('gym', name, describeStep(subject, detail, startedAt)),
            },
            // NO OPTIONAL CHAINING on our own interface. `jobs.notifyFinding?.()` silently
            // discarded every finding a cycle raised, because a missing method and a method
            // returning nothing are indistinguishable through `?.`. Persisted first so the
            // board survives a restart, then pushed to the live channel.
            emitFinding: async (finding) => {
              await state.addBoardFinding(finding);
              jobs.notifyFinding(finding);
            },
            abortSignal: { get aborted() { return cancelled(); } },
          });
        } finally {
          // BOTH handles. The ledger was opened inline in the options object and never
          // closed, so every cycle leaked a better-sqlite3 handle; the finally closed only
          // the store. withLedger exists for exactly this and could not be used here
          // because the ledger outlives the call that opens it.
          await store?.close?.();
          ledger?.close?.();
          activeGymRun = null;
          // The gate re-blocks when the run ends (D-0060), same as mining.
          await reblockGate(repoPath);
        }
      });
      return { jobId };
    },

    async gymStatus(params) {
      const repoPath = await requireAttached(params);
      return withLedger(repoPath, async (ledger) => {
        const files = await loadResultFiles((await layoutFor(repoPath)).gymResultsRoot).catch(() => null);
        return {
          cycles: ledger.cycles().map(cycleForWire),
          // Omitted rather than null when nothing is running, because the contract marks it
          // optional and a null would read as "a run that reports nothing".
          ...(activeGymRun ? { activeRun: activeGymRun } : {}),
          // drawnFromResultFiles is NULL when the denominator is not derivable. A client
          // renders that as "not derivable" and never as 0: a zero meaning "four exams
          // vanished" is the exact defect the drawn-cohort rule exists to remove.
          ledger: ledger.summary({ resultFiles: files }),
          // Harvest batches, newest first. Summaries only: the full proposal set is read
          // for review through the batch record, not painted on every status call.
          harvest: ledger.harvestBatches(),
        };
      });
    },

    /**
     * The learning half of the loop: turn a graded cycle's gaps into reviewed proposals.
     *
     * PROPOSAL-ONLY (P7 clause 10): this writes a batch record and never a brain document.
     * The teacher answers one question per gap ("what knowledge, had it been retrieved,
     * would have prevented this?"), harvest.js validates every answer, the curation gates
     * and the citation backstop drop what cannot be checked, and the surviving batch lands
     * in the ledger for the owner to read. gymHarvestApply is the separate act that writes.
     */
    async gymHarvest(params) {
      const repoPath = await requireAttached(params);
      // Same locks as the cycle that produced the grades: the teacher speaks, so the gate
      // and per-call consent both apply, and the gate re-blocks when the job ends.
      await assertGate('gym-cycle', { file: gymSpendGatePath(repoPath) });
      await requireConsent('gymHarvest', params,
        'Harvest asks the teacher role one question per graded gap, which is a real provider generation. Proposals are recorded for your review; nothing is written to the brain by this call.');
      const settings = await state.settings();
      // Built BEFORE the job, the gymStart rule: an unconfigured teacher refuses at the
      // call, not inside a job the user already consented to.
      const resolved = deps.createTeacher ? await deps.createTeacher({ settings, repoPath }) : await roleGenerate('teacher');
      const teacher = { generate: resolved.generate };
      const requestedCycle = Number.isInteger(params?.cycleId) ? params.cycleId : null;

      const jobId = jobs.start('harvest', async ({ emit }) => {
        let store = null;
        let ledger = null;
        try {
          ledger = openLedger(repoPath);
          const cycles = ledger.cycles();
          const cycle = requestedCycle !== null
            ? cycles.find((row) => row.id === requestedCycle)
            : cycles.find((row) => row.status === 'completed' && isGradableRun(row.mode));
          if (!cycle) {
            throw new Error(requestedCycle !== null
              ? `No cycle ${requestedCycle} exists in this ledger.`
              : 'No completed graded cycle exists. Run the gym in a graded mode first; a debug run is never graded, so there is nothing to learn from it.');
          }
          if (!isGradableRun(cycle.mode)) {
            throw new Error(`Cycle ${cycle.id} ran in mode ${cycle.mode}, which is never graded, so there is nothing to learn from.`);
          }
          const runs = ledger.cycleRuns(cycle.id, { scoredOnly: false });
          const rubrics = runs.map((run) => ledger.rubricFor(run.id)).filter(Boolean);
          if (rubrics.length === 0) throw new Error(`Cycle ${cycle.id} has no graded attempt to learn from.`);
          emit('harvest', 'read', `${rubrics.length} graded attempt(s) in cycle ${cycle.id}`);

          // Packets rebuilt from the result artifacts, never from anything the teacher
          // says: the artifact recorded what the student was shown, and the gaps' target
          // ids that exist but were not shown form the packet's absent list, which is
          // exactly the set a retrieval-fix may name.
          const examsByRunId = {};
          const packetsByRunId = {};
          const resultsRoot = (await layoutFor(repoPath)).gymResultsRoot;
          for (const rubric of rubrics) {
            const run = runs.find((row) => row.id === rubric.runId);
            const exam = ledger.getExam(run.exam_id);
            examsByRunId[rubric.runId] = exam;
            let artifact = null;
            try {
              artifact = JSON.parse(await readFile(path.join(resultsRoot, run.result_file), 'utf8'));
            } catch {
              // A missing artifact leaves this run without a packet; targeted answers for
              // it are refused by answersToProposals, which is the honest degradation.
            }
            if (artifact) {
              const packet = buildGradingPacket({ artifact, exam });
              packet.absentDocumentIds = (rubric.gaps || [])
                .map((gap) => gap.targetDocumentId)
                .filter((id) => id && !packet.shownDocumentIds.includes(id));
              packetsByRunId[rubric.runId] = packet;
            }
          }

          const { questions, skipped } = buildHarvestQuestions({ rubrics, examsByRunId });
          emit('harvest', 'questions',
            `${questions.length} question(s); ${skipped.length} gap(s) measured with no brain write`,
            { counts: { questions: questions.length, skipped: skipped.length } });

          let proposals = [];
          if (questions.length > 0) {
            store = await openBrain(repoPath);
            const documents = await store.allDocuments({ project: null }).catch(() => []);
            const answers = await (deps.harvestAnswers || harvestAnswersWithTeacher)({
              questions, packetsByRunId, generate: teacher.generate,
            });
            proposals = answersToProposals(answers, questions, {
              documentIds: documents.map((document) => document.id),
              packetsByRunId,
            });
            proposals = await curateProposals(proposals, {
              existingDocuments: documents,
              // The citation backstop reads CURRENT code, confined to the repo: a teacher
              // path that resolves outside it reads as "no longer exists" rather than as a
              // window into the machine.
              readFileLines: async (file) => {
                const target = path.resolve(repoPath, String(file));
                if (target !== repoPath && !target.startsWith(repoPath + path.sep)) return null;
                try {
                  return (await readFile(target, 'utf8')).split('\n').length;
                } catch {
                  return null;
                }
              },
            });
          }
          const batch = harvestBatch({
            cycleId: cycle.id, mode: cycle.mode, proposals, skipped, at: new Date(now()).toISOString(),
          });
          const batchId = ledger.recordHarvestBatch(batch);
          const accepted = proposals.filter((proposal) => proposal.accepted).length;
          emit('done', 'harvested',
            `Batch ${batchId}: ${questions.length} question(s) asked, ${accepted} lesson proposal(s) kept, ${proposals.length - accepted} dropped. `
            + (cycle.mode === 'evaluation'
              ? (accepted ? 'Review them and apply to teach the brain.' : 'Zero kept is a measured outcome, and it is recorded as one.')
              : 'An experiment batch is a recommendation to read; only an evaluation cycle teaches the brain.'),
            { counts: { batch: batchId, questions: questions.length, accepted, rejected: proposals.length - accepted } });
        } finally {
          await store?.close?.();
          ledger?.close?.();
          // The gate re-blocks when the run ends (D-0060), same as every spending job.
          await reblockGate(repoPath);
        }
      });
      return { jobId };
    },

    /**
     * THE SEPARATE ACT (P7 clause 10): write an evaluation batch's accepted proposals into
     * the brain as lesson documents, and reindex so retrieval serves what was learned.
     *
     * No provider is called; this is the owner's hand, so it is not spend-gated, and
     * consent is still explicit because it writes into the repo's brain. applyProposals and
     * the ledger both refuse a non-evaluation batch and a second apply.
     */
    async gymHarvestApply(params) {
      const repoPath = await requireAttached(params);
      if (!Number.isInteger(params?.batchId)) {
        throw invalidParams('batchId is required', 'gymHarvestApply needs the harvest batch to apply.');
      }
      await requireConsent('gymHarvestApply', params,
        "Applying a harvest batch writes the accepted lessons into this repo's brain and reindexes it.");
      const settings = await state.settings();

      const jobId = jobs.start('harvest-apply', async ({ emit }) => {
        let store = null;
        let ledger = null;
        try {
          ledger = openLedger(repoPath);
          const stored = ledger.getHarvestBatch(params.batchId);
          if (!stored) throw new Error(`No harvest batch ${params.batchId} exists for this repo.`);
          // The ledger column is the truth about application, not the stored record: the
          // record is the batch as harvested, and it stays byte-identical after an apply.
          if (stored.applied) throw new Error(`Harvest batch ${stored.id} has already been applied.`);
          const brainRoot = artifactPaths(repoPath).brainRoot;

          const applied = await applyProposals(stored.batch, {
            mode: stored.mode,
            writeDocument: async ({ kind, body, targetDocumentId, provenance }) => {
              const id = `gym-lesson-b${stored.id}-r${provenance.runId}-g${provenance.gapIndex}`;
              const title = String(provenance.concern || 'Harvested lesson').slice(0, 80);
              // Targeted kinds become lessons that NAME their target rather than editing
              // it: the brain learns the pointer, and the user's document stays theirs.
              const opening = kind === 'retrieval-fix'
                ? `The document ${targetDocumentId} held the answer and was not retrieved.\n\n`
                : kind === 'sharpen-convention'
                  ? `Sharpens ${targetDocumentId}.\n\n`
                  : '';
              const proposal = (stored.batch.proposals || []).find((row) => (
                row.runId === provenance.runId && row.gapIndex === provenance.gapIndex
              ));
              const written = await writeLessonUnit(brainRoot, {
                id,
                type: 'lesson',
                title,
                content: `# ${title}\n\n${opening}${body}\n\nProvenance: gym run ${provenance.runId}, exam ${provenance.examId}.`,
                citations: proposal?.citations ?? [],
                meta: { area: 'lessons', layer: 3, generated: true },
              });
              emit('apply', 'lesson-written', `${id} -> ${written.file}`);
              return { id, file: written.file };
            },
          });
          ledger.markHarvestApplied(stored.id, { written: applied.written, at: new Date(now()).toISOString() });

          // REINDEX FROM THE BRAIN, the same derivation init uses, so retrieval actually
          // serves the lessons that were just written. An index that lagged its brain would
          // report "applied" while retrieving the world as it was.
          const retrieval = settings.retrieval || {};
          const model = retrieval.embeddingModel || DEFAULT_EMBEDDING.model;
          const dimension = Number(retrieval.embeddingDimension || DEFAULT_EMBEDDING.dimension);
          const baseUrl = retrieval.ollamaBaseUrl || undefined;
          const client = makeEmbedderClient({ model, dimension, baseUrl });
          const digest = retrieval.embeddingDigest?.trim() || (await ollama({
            environment: { EMBEDDING_MODEL: model, ...(baseUrl ? { OLLAMA_BASE_URL: baseUrl } : {}) },
          })).digest;
          const served = await indexIdentity({
            environment: {
              EMBEDDING_PROVIDER: 'ollama',
              EMBEDDING_MODEL: model,
              EMBEDDING_DIM: String(dimension),
              EMBEDDING_MODEL_DIGEST: digest,
              ...(baseUrl ? { OLLAMA_BASE_URL: baseUrl } : {}),
            },
          });
          const layout = await layoutFor(repoPath);
          store = await openStore(repoPath, { path: layout.databasePath, embedder: served, project: 'default' });
          await reindexFromBrain({
            repoPath,
            store,
            embedder: embedderFromClient(client),
            project: 'default',
            jobId,
            onStep: (event) => emit(event.phase, event.step, event.detail, { counts: event.counts, level: event.level }),
          });
          emit('done', 'applied',
            `${applied.written} lesson(s) written into the brain and the index rebuilt from it.`,
            { counts: { written: applied.written } });
        } finally {
          await store?.close?.();
          ledger?.close?.();
        }
      });
      return { jobId };
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

    /**
     * Mine the exam bank from this repo's real commit history. SPEND-TOUCHING:
     * the committee is the AUDITOR role answering once over the eligible
     * candidates, so the call sits behind the owner gate (scope exam-mining)
     * AND per-call consent, the same two locks gymStart holds.
     *
     * A JOB: the git walk is seconds but the committee is minutes and the
     * per-exam validation (worktree + baseline gates) is minutes more, so
     * everything after the refusals streams. Steps ride the `mine` and
     * `validate` phases; `done` carries the counts.
     *
     * Selected exams land as DRAFTS, move to `validated` when their worktree
     * checks pass, and are PROMOTED only by the owner (examUpdate): mining
     * proposes, validation verifies, the owner admits to the bank. The
     * scored record never gains a row any model elected on its own.
     */
    /**
     * Flip the spend gate from the TUI. THE FLIP IS STILL THE OWNER'S HAND
     * (D-0060): this method only ever runs off an explicit button press with
     * confirm: true, the consent is recorded like every spend consent, and
     * the invariant evolves rather than falls - the engine still never opens
     * a gate on its own initiative, and every job that spends RE-BLOCKS the
     * gate in its finally, so an authorization lives exactly as long as the
     * run it authorized.
     *
     * `blocked` needs no confirmation: closing a gate is always safe.
     */
    async spendGateSet(params) {
      const repoPath = await requireAttached(params);
      const gatePath = gymSpendGatePath(repoPath);
      const status = params?.status;
      if (status === 'blocked') {
        await mkdir(path.dirname(gatePath), { recursive: true });
        return writeBlockedSpendGate(gatePath, 'Blocked from the TUI by the owner.');
      }
      if (status !== 'authorized') {
        throw invalidParams('unknown gate status', "status must be 'authorized' (with scope and reason) or 'blocked'.");
      }
      if (!GYM_SPEND_SCOPES.includes(params?.scope)) {
        throw invalidParams('unknown scope', `scope must be one of ${GYM_SPEND_SCOPES.join(', ')}.`);
      }
      const reason = String(params?.reason || '').trim();
      if (reason.length < 20) {
        throw invalidParams('reason too short',
          'Opening a spend gate needs a written reason of at least 20 characters; six weeks later it is the only record of why.');
      }
      await requireConsent('spendGateSet', params,
        `Opening the gate authorizes ${params.scope} provider spend on this machine until the run re-blocks it.`);
      await mkdir(path.dirname(gatePath), { recursive: true });
      // The write lives in the gate module under the D-0060 licence; this
      // boundary holds the locks (owner button, reason, recorded consent).
      return ownerAuthorizeSpendGate(gatePath, { scope: params.scope, reason });
    },

    /**
     * THE GOAL LOOP (owner round 11): the watcher runs until the tool is
     * clean, and the auditor acts on what it finds.
     *
     * One sweep is: the mechanical systemCheck surface, the repo's gates
     * ACTUALLY RUN (a gate that fails here is a current break, not a claim
     * about a gate file), and the exam bank read for what stands between the
     * owner and a runnable gym. Every finding is persisted and pushed to the
     * board, so the loop's output is the board rather than a private log.
     *
     * ZERO SPEND BY DEFAULT, and that is what makes it able to run forever.
     * `triage: true` additionally hands each NEW finding to the auditor role
     * (spend, so it needs the gate and consent) which may apply a fix from
     * the CLOSED catalog and always writes its reasoning to the finding's
     * thread. Everything outside that catalog is a recommendation the owner
     * reads - an LLM editing this repo unattended is a different product and
     * is not this one.
     *
     * IT STOPS WHEN THE WORK IS DONE, not on a timer: `cleanSweepsToStop`
     * consecutive sweeps with no open finding ends the loop and says so.
     * jobCancel ends it at any point, and `maxSweeps` is a backstop.
     */
    async goalStart(params) {
      const repoPath = await requireAttached(params);
      const triage = params?.triage === true;
      const intervalMs = Math.max(5_000, Math.min(Number(params?.intervalMs) || 60_000, 3_600_000));
      const cleanSweepsToStop = Math.max(1, Math.min(Number(params?.cleanSweepsToStop) || 2, 10));
      const maxSweeps = Math.max(1, Math.min(Number(params?.maxSweeps) || 1_000, 10_000));

      let auditor = null;
      let watcherVoice = null;
      if (triage) {
        // The auditor SPEAKS here, so both locks apply, and they are taken
        // before the loop starts rather than at the first finding: a loop
        // that runs for an hour and then refuses has wasted the hour.
        await assertGate('exam-mining', { file: gymSpendGatePath(repoPath) });
        await requireConsent('goalStart', params,
          'Auditor triage sends each new finding to the auditor role, which is a real provider generation per finding.');
        auditor = await roleGenerate('auditor');
        // The WATCHER'S VOICE rides the same locks: with triage on, the
        // configured watcher role verifies each new finding cheaply and its
        // note reaches the auditor and the finding's thread. An unconfigured
        // watcher is not a refusal - the mechanical sweep IS the watcher's
        // floor, and the loop degrades to it rather than dying for a voice.
        try {
          watcherVoice = await roleGenerate('watcher');
        } catch {
          watcherVoice = null;
        }
      }

      const jobId = jobs.start('goal', async ({ emit, cancelled }) => {
        const seen = new Map();
        let clean = 0;
        let sweep = 0;
        let fixed = 0;
        let triageFailures = 0;
        let triageStopped = false;
        let watcherFailures = 0;
        let watcherStopped = false;
        try {
          while (!cancelled() && sweep < maxSweeps && clean < cleanSweepsToStop) {
            sweep += 1;
            emit('watch', 'sweep', `sweep ${sweep}: reading the tool, the gates and the exam bank`);
            const at = new Date(now()).toISOString();
            const findings = [];

            // SEPARATE TRIES, because these read different things and one
            // shared catch let a slow embedder probe swallow the role sweep
            // with it: a partial sweep must lose only its own half.
            try {
              findings.push(...statusFindings(await api.serveStatus({}), { at }));
            } catch (error) {
              emit('watch', 'sweep-partial', `the engine status sweep failed this round: ${error.message}`, { level: 'warn' });
            }
            try {
              const settings = await state.settings();
              const catalog = await loadProviderCatalog();
              findings.push(...roleFindings(settings.roles, {
                at,
                zaiDefault: catalog.providers.find((row) => row.id === 'zai')?.endpointDefault || ZAI_PAYG_URL,
              }));
            } catch (error) {
              emit('watch', 'sweep-partial', `the role sweep failed this round: ${error.message}`, { level: 'warn' });
            }

            // The gates, RUN. This is the expensive half of a sweep and the
            // only one that can catch a break the owner has not met yet.
            let gateList = [];
            try {
              const parsed = parseGatesFile(await readFile(gatesFilePath(repoPath), 'utf8'));
              gateList = (parsed.discovered?.gates || []).filter((gate) => gate.enabled);
              findings.push(...gateFindings(repoPath, parsed, { at }));
            } catch {
              gateList = [];
            }
            if (gateList.length > 0 && !cancelled()) {
              try {
                const expanded = expandGates(gateList, {
                  engineRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
                  sandbox: repoPath,
                });
                const results = await runGateSet(expanded, { cwd: repoPath, timeoutMs: 900_000 });
                emit('watch', 'gates-run',
                  results.map((gate) => `${gate.id}=${gate.status}`).join(', '),
                  { counts: { gates: results.length, failing: results.filter((gate) => gate.status === 'fail').length } });
                findings.push(...gateRunFindings(repoPath, results, { at }));
              } catch (error) {
                emit('watch', 'gates-unrunnable', error.message, { level: 'warn' });
              }
            }

            try {
              const exams = await withLedger(repoPath, async (ledger) => ledger.listExams({}));
              findings.push(...examBankFindings(repoPath, exams, { at }));
            } catch {
              // No ledger yet is not a finding: nothing has been mined.
            }

            const fresh = findings.filter((row) => !seen.has(row.id));
            for (const row of findings) seen.set(row.id, row);
            for (const row of fresh) {
              await state.addBoardFinding(row);
              jobs.notifyFinding(row);
            }
            emit('watch', 'swept',
              `${findings.length} finding(s), ${fresh.length} new`,
              { counts: { findings: findings.length, fresh: fresh.length }, level: findings.length ? 'warn' : 'info' });

            if (triage && fresh.length && !cancelled()) {
              for (const row of fresh) {
                if (cancelled()) break;
                if (triageStopped) break;
                // THE WATCHER SPEAKS FIRST: a cheap verification whose note
                // rides the finding's thread and the auditor's prompt. A
                // failing watcher degrades to the mechanical finding alone
                // (two consecutive failures silence it for the loop, the same
                // rule the auditor has), because the sweep must not die for
                // its commentary.
                let watcherNote = null;
                if (watcherVoice && !watcherStopped) {
                  try {
                    const check = await watcherVerify(watcherVoice, row);
                    watcherFailures = 0;
                    watcherNote = `${check.confirmed ? 'confirmed' : 'not confirmed'}: ${check.note}`;
                    emit('watch', 'verified', `${row.id} ${watcherNote}`.slice(0, 200));
                  } catch (error) {
                    watcherFailures += 1;
                    emit('watch', 'verify-failed', `${row.id}: ${String(error.message).slice(0, 160)}`, { level: 'warn' });
                    if (watcherFailures >= 2) {
                      watcherStopped = true;
                      emit('watch', 'verify-stopped',
                        'The watcher role failed twice in a row; findings go to the auditor without its note for the rest of this loop.',
                        { level: 'warn' });
                    }
                  }
                }
                try {
                  const verdict = await auditTriage(auditor, row, { watcherNote });
                  triageFailures = 0;
                  const stamp = new Date(now()).toISOString();
                  const thread = [
                    ...(watcherNote ? [{ at: stamp, by: 'watcher', text: watcherNote }] : []),
                    { at: stamp, by: 'auditor', text: verdict.reasoning },
                  ];
                  await state.addBoardFinding({ ...row, status: 'triaged', thread });
                  emit('audit', 'triaged', `${row.id}: ${String(verdict.reasoning).slice(0, 120)}`);
                  if (verdict.applyFixId && row.action?.fixId === verdict.applyFixId) {
                    const applied = await api.systemFix({
                      fixId: verdict.applyFixId,
                      role: row.category === 'roles' ? row.target : undefined,
                      confirm: true,
                    });
                    fixed += applied.ok ? 1 : 0;
                    emit('audit', applied.ok ? 'fixed' : 'fix-failed', `${row.id}: ${applied.detail}`,
                      { level: applied.ok ? 'info' : 'warn' });
                    if (applied.ok) seen.delete(row.id);
                  }
                } catch (error) {
                  triageFailures += 1;
                  emit('audit', 'triage-failed', `${row.id}: ${String(error.message).slice(0, 200)}`, { level: 'warn' });
                  // TWO CONSECUTIVE FAILURES STOP TRIAGE FOR THE LOOP. The
                  // live run burned one futile call per finding against a
                  // provider that had already said "you've reached your
                  // limit"; a loop that keeps asking after that is spending
                  // the owner's quota to re-learn one fact. The sweep itself
                  // is free and carries on.
                  if (triageFailures >= 2) {
                    triageStopped = true;
                    emit('audit', 'triage-stopped',
                      `The auditor failed twice in a row (${String(error.message).slice(0, 140)}). Triage is off for the rest of this loop; the watcher keeps sweeping for free.`,
                      { level: 'warn' });
                  }
                }
              }
            }

            const decision = goalStopDecision({
              findingCount: findings.length, clean, cleanSweepsToStop, sweep, maxSweeps, cancelled: cancelled(),
            });
            clean = decision.clean;
            if (decision.stop) break;
            // Sleep in slices so a cancel lands in seconds, not at the end of
            // the interval: a loop that ignores a stop for a minute reads as
            // a loop that ignores the owner.
            for (let waited = 0; waited < intervalMs && !cancelled(); waited += 1_000) {
              await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, intervalMs - waited)));
            }
          }
          const open = [...seen.values()];
          emit('done', 'goal',
            clean >= cleanSweepsToStop
              ? `Clean: ${cleanSweepsToStop} consecutive sweep(s) found nothing open after ${sweep} sweep(s)${fixed ? `, ${fixed} fix(es) applied` : ''}.`
              : `Stopped after ${sweep} sweep(s) with ${open.length} finding(s) still open${fixed ? `, ${fixed} fix(es) applied` : ''}. The board carries them.`,
            { counts: { sweeps: sweep, open: open.length, fixed }, level: clean >= cleanSweepsToStop ? 'info' : 'warn' });
        } finally {
          if (triage) await reblockGate(repoPath);
        }
      });
      return { jobId };
    },

    async examMine(params) {
      const repoPath = await requireAttached(params);
      await assertGate('exam-mining', { file: gymSpendGatePath(repoPath) });
      await requireConsent('examMine', params,
        'Exam mining sends the eligible candidate commits to the auditor role for selection, which is a real provider generation. The gate authorizes the machine; this call still needs your explicit go ahead.');
      const settings = await state.settings();
      const auditorRole = settings.roles.find((row) => row.role === 'auditor');
      if (!auditorRole?.provider || !auditorRole?.model) {
        throw invalidParams('auditor not configured',
          'The exam committee IS the auditor role, and it has no provider or model configured. Set it up in settings first.');
      }
      const catalog = await loadProviderCatalog();
      const entry = catalog.providers.find((candidate) => candidate.id === auditorRole.provider);
      let key = null;
      if (entry?.keyRequired ?? true) {
        if (!auditorRole.keyRef) {
          throw invalidParams('no key pointer', `The auditor role has no key pointer and ${auditorRole.provider} needs one.`);
        }
        try {
          key = await resolveRoleKey(auditorRole.keyRef);
        } catch (error) {
          throw invalidParams('key not resolvable', error.message);
        }
      }
      let agentPath = null;
      if (auditorRole.provider === 'claude-code' && auditorRole.agentRef) {
        const agents = await scanAgents({ repoPaths: (await state.repos()).map((row) => row.path) });
        agentPath = agents.find((agent) => agent.id === auditorRole.agentRef)?.path ?? null;
      }
      const endpoint = auditorRole.endpoint || entry?.endpointDefault || null;
      const target = Number.isInteger(params?.target) && params.target > 0 ? Math.min(params.target, 25) : 10;

      const jobId = jobs.start('mine', async ({ emit, cancelled }) => {
        try {
        emit('mine', 'walk', 'walking the commit history through the deterministic filter');
        const mined = await mine(repoPath);
        emit('mine', 'filtered',
          `${mined.candidates.length} candidate(s) kept, ${mined.dropped.length} dropped by the deterministic filter`
          + (mined.capped.applied ? `; history capped at ${mined.capped.limit} of ${mined.capped.seen} commits` : ''),
          { counts: { candidates: mined.candidates.length, dropped: mined.dropped.length } });
        if (cancelled()) return;
        if (mined.candidates.length === 0) {
          emit('done', 'empty', 'No commit survived the deterministic filter, so there is nothing for the committee to read.', { level: 'warn' });
          return;
        }

        const generate = makeAuditorGenerate({ ...auditorRole, endpoint }, { key, agentPath });
        const auditor = buildCommitteeAuditor(generate, { target });
        emit('mine', 'committee',
          `the auditor (${auditorRole.provider} ${auditorRole.model}) is reading ${mined.candidates.length} candidate(s)`);
        const selection = await selectBank(
          { candidates: mined.candidates, auditor, repoPath },
          { assertSpendGate: (scope) => assertGate(scope, { file: gymSpendGatePath(repoPath) }) },
        );
        if (cancelled()) return;
        emit('mine', 'selected', `${selection.chosen.length} exam(s) selected by the committee`,
          { counts: { chosen: selection.chosen.length, eligible: selection.eligible.length } });

        // Gates for baseline validation: what discovery classified as able to
        // carry signal. An empty list validates vacuously and the event says so.
        let gateList = [];
        try {
          const parsed = parseGatesFile(await readFile(gatesFilePath(repoPath), 'utf8'));
          gateList = (parsed.discovered?.gates || []).filter((gate) => gate.enabled && ['live', 'measured'].includes(gate.classification));
        } catch {
          gateList = [];
        }
        if (gateList.length === 0) {
          emit('validate', 'no-gates',
            'No live or measured gate exists, so baseline validation checks only the worktree and the diff. Run gate discovery for stronger validation.',
            { level: 'warn' });
        }

        const written = [];
        await withLedger(repoPath, async (ledger) => {
          const existing = ledger.listExams({});
          let next = existing.reduce((highest, row) => {
            const match = /^exam-(\d{4})$/.exec(row.examId);
            return match ? Math.max(highest, Number(match[1])) : highest;
          }, 0);
          const engineRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
          // A HELD-OUT SPLIT IS A SAMPLING DECISION, NOT A JUDGMENT, so the
          // engine owns it and the committee's flag is advisory. Below five
          // exams there is no split worth reserving, and holding out the only
          // exam in a bank leaves the gym with nothing runnable - which is
          // exactly what the owner met: one mined exam, marked held out, and
          // every training draw refused.
          const bankAfter = existing.length + selection.chosen.length;
          const splitWorthReserving = bankAfter >= 5;
          const layout = await layoutFor(repoPath);
          for (const candidate of selection.chosen) {
            if (cancelled()) break;
            next += 1;
            const examId = `exam-${String(next).padStart(4, '0')}`;
            const baseCommit = candidate.parents?.[0];
            if (!baseCommit) {
              emit('validate', 'skipped', `${examId}: ${candidate.commit} has no parent to base the exam on`, { level: 'warn' });
              continue;
            }
            emit('validate', 'checking', `${examId}: worktree at base, baseline gates, real diff (${String(candidate.subject).slice(0, 60)})`);
            const verdict = await validateExam({
              candidate: { ...candidate, baseCommit, goldCommit: candidate.commit, examId },
              sourceRepo: repoPath,
              gates: gateList,
              engineRoot,
              sandboxesRoot: path.join(layout.repoStateRoot, 'sandboxes'),
            }, { createSandbox, runGateSet, expandGates });
            const record = {
              examId,
              title: candidate.auditorTitle || candidate.subject,
              status: verdict.ok ? 'validated' : 'draft',
              benchmarkStatus: 'active',
              heldOut: splitWorthReserving && Boolean(candidate.heldOut),
              scopeTier: verdict.scope.tier ?? 'S',
              scopeFiles: Math.max(1, verdict.scope.files),
              scopeInsertions: verdict.scope.insertions,
              baseCommit,
              goldCommit: candidate.commit,
              task: candidate.auditorTask,
              goldNotes: verdict.ok
                ? (candidate.auditorRationale ?? null)
                : `NOT VALIDATED: ${verdict.failures.join(' | ')}${candidate.auditorRationale ? ` (committee: ${candidate.auditorRationale})` : ''}`,
              provenance: {
                source: 'auditor-selection',
                authoredBy: { role: 'auditor', model: auditorRole.model, endpoint: endpoint ?? 'default' },
                commit: candidate.commit,
              },
            };
            try {
              ledger.putExam(record);
              written.push({ examId, ok: verdict.ok });
              emit('validate', verdict.ok ? 'validated' : 'draft-only',
                `${examId} ${verdict.ok ? 'validated' : `stays a draft: ${verdict.failures.join('; ').slice(0, 140)}`}`,
                verdict.ok ? undefined : { level: 'warn' });
            } catch (error) {
              emit('validate', 'rejected', `${examId} refused by the record parser: ${error.message}`, { level: 'warn' });
            }
          }
        });
        const validated = written.filter((row) => row.ok).length;
        emit('done', 'mined',
          `${written.length} exam(s) written: ${validated} validated, ${written.length - validated} draft(s). `
          + 'Promote the ones you accept; only promoted exams can run.',
          { counts: { written: written.length, validated } });
        } finally {
          // THE GATE OUTLIVES NOTHING (D-0060): whatever authorized this run
          // is re-blocked when the job ends, success or failure, so an open
          // gate is never left lying around for the next call to spend
          // through.
          await reblockGate(repoPath);
        }
      });
      return { jobId };
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
        // Ingest ADOPTS the user's curated knowledge folder: adopt.js splits it into
        // units marked human-written, validateCitations is the mechanical drift check
        // (a unit citing a file or commit that is not there is dropped and named), and
        // the derived brain lands in .daijin/brain while the source folder is never
        // written. Zero spend: no narration runs, so no consent beyond the click.
        //
        // Checked HERE as well as in the pipeline, because the pipeline's own refusal
        // comes after its analyze pass: a repo with no qualifying folder would watch a
        // job start and then fail. This is the refusal they meet; the pipeline's is the
        // backstop for a direct caller.
        const analysis = await analyze(repoPath);
        if (!analysis.brainFolder?.present) {
          throw invalidParams('no knowledge folder',
            'Mode ingest adopts an existing knowledge folder and this repo has none that qualifies. '
            + 'A folder counts when it holds at least one markdown file. Use mode layer1 to generate one.');
        }
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
              // FORWARDED BY NAME, and the list is the wire contract rather than an
              // oversight: the pipeline's event carries in-process detail that has no
              // business on a client's stream. But an unlisted field is DROPPED IN
              // SILENCE, which is how actionCode came to exist engine-side and be
              // unreachable client-side - added to the emit and killed at this line.
              // init-pipeline.test.js drives a real run and fails if the pipeline emits a
              // key that is neither forwarded here nor named internal, so the next field
              // cannot be lost the same way.
              emit(event.phase, event.step, event.detail, {
                counts: event.counts,
                level: event.level,
                actionCode: event.actionCode,
              });
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
          if (report?.floor?.caseRate) {
            await appendScoreHistory(repoPath, report.floor, { store });
            // The SAME measurement, stored for recall: without this, the first Brain
            // visit after init re-ran the whole sweep init had just finished. Arm and
            // rank detail are not in the pipeline's per-case rows, so recall shows
            // them unattributed until the first explicit re-measure.
            const layout = await layoutFor(repoPath);
            const results = (report.floor.perCase || []).map((row) => ({
              id: row.caseId,
              complete: Boolean(row.hit),
              misses: row.misses || [],
              reciprocalRank: null,
              identifier: Boolean(row.identifier),
              standingAssisted: Boolean(row.standingAssisted),
            }));
            const record = {
              at: new Date(now()).toISOString(),
              caseRate: report.floor.caseRate,
              mrr: report.floor.mrr ?? null,
              violations: report.floor.violations ?? 0,
              chosenBudget: report.floor.chosenBudget ?? null,
              rationale: report.floor.rationale ?? null,
              perCase: results.map((row) => ({
                caseId: row.id, hit: row.complete, rank: null, arm: null, type: null, area: null,
                missed: row.misses[0] ?? null, identifier: row.identifier, standingAssisted: row.standingAssisted,
              })),
              budgetSweep: (report.floor.budgetSweep || []).map((point) => ({
                budget: point.budget ?? point.tokenBudget ?? null,
                caseRate: point.caseRate ?? null,
              })),
            };
            await mkdir(path.dirname(layout.lastScorePath), { recursive: true });
            await writeFile(layout.lastScorePath, JSON.stringify({ record, results }, null, 2), 'utf8');
          }
        } finally {
          await store.close?.();
        }
      });
      return { jobId };
    },

    /**
     * The auditor narrates a recommendation over the MECHANICAL diagnosis.
     *
     * The division is the contract's: diagnose is free arithmetic and already names which
     * cases missed and how they cluster; choosing between enriching documents, running
     * Layer 2 on an area, or bootstrapping through the gym is the auditor's call, and that
     * one spends. One generation per explicit user action; no gate scope, because the
     * consent IS the whole authorization for a single bounded call (methods.md spend table).
     */
    async diagnoseNarrate(params) {
      const repoPath = await requireAttached(params);
      await requireConsent('diagnoseNarrate', params,
        "The auditor's recommendation is a paid generation. The mechanical clusters from diagnose are free and already answer most of the question.");
      // The auditor is built BEFORE the free sweep runs: an unconfigured role refuses at
      // the call, not after the embedder has re-measured every gold case for nothing.
      const auditor = await roleGenerate('auditor');
      const diagnosis = await api.diagnose({ repoPath });
      const clusterLines = (axis, rows) => (rows || []).map((row) => `- ${axis} ${row.value}: ${row.count} miss(es)`);
      const missedRows = (diagnosis.perCase || []).filter((row) => !row.hit);
      const prompt = [
        'You are the auditor for a developer tool called daijin. A repo\'s retrieval was measured',
        'against its gold set, and the mechanical diagnosis below clusters the missed cases.',
        '',
        `repo: ${repoPath}`,
        `case rate: ${diagnosis.caseRate?.cases ?? '?'} complete`,
        `must-not violations: ${diagnosis.violations}`,
        `identifier misses: ${diagnosis.identifierMisses}`,
        '',
        'Missed cases:',
        ...(missedRows.length
          ? missedRows.map((row) => `- ${row.caseId}: missed ${row.missed ?? '?'} (type ${row.type ?? 'unattributed'}, area ${row.area ?? 'unattributed'}, arm ${row.arm ?? 'unattributed'})`)
          : ['- none; every case is complete']),
        '',
        'Clusters:',
        ...clusterLines('type', diagnosis.clusters?.byType),
        ...clusterLines('area', diagnosis.clusters?.byArea),
        ...clusterLines('arm', diagnosis.clusters?.byArm),
        '',
        'Recommend what the owner should do next, in a short paragraph. The available moves',
        'are: enrich or split the named documents, run Layer 2 narration on a named area,',
        'bootstrap knowledge through the gym, or accept the number and do nothing yet. Name',
        'the move and the evidence for it. Do not invent cases or documents not listed above.',
      ].join('\n');
      const { text } = await auditor.generate({ prompt, maxTokens: 2_048 });
      const recommendation = String(text || '').trim();
      if (!recommendation) {
        throw invalidParams('empty narration', 'The auditor returned no text, so there is no recommendation to show. The spend still happened; try again or check the auditor role.');
      }
      return { recommendation };
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

    // The catalog the settings dialog populates from. A SEPARATE METHOD rather than a key
    // on settingsGet: a catalog is a constant and settings are user state, and folding a
    // constant into the settings payload re-sends it on every screen paint.
    //
    // Zero spend and unprobeable: one local file read. It cannot list a provider's models
    // over the API, because that is an authenticated call on every provider and a paid one
    // on some, and a settings screen that spends money to render is not a settings screen.
    // rolePing remains the only path that verifies a model or a key.
    async providerCatalog() {
      return loadProviderCatalog();
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
      // Consent BEFORE anything else, as it was when this was a stub: a role ping is a
      // real provider generation and only ever runs because the user asked for this one.
      await requireConsent('rolePing', params,
        'A role ping is a real provider generation and costs money. It only ever runs when you ask for it, never on a screen opening.');
      const settings = await state.settings();
      const role = settings.roles.find((row) => row.role === params.role);
      if (!role?.provider || !role?.model) {
        throw invalidParams('role not configured',
          `The ${params.role} role has no ${role?.provider ? 'model' : 'provider'} configured. Configure it in settings first; a ping verifies a configuration, so there has to be one.`);
      }
      const catalog = await loadProviderCatalog();
      const entry = catalog.providers.find((candidate) => candidate.id === role.provider);
      // The endpoint falls back to the catalog default so a fresh role is pingable
      // without copying a URL by hand; claude-code has neither and needs neither.
      const endpoint = role.endpoint || entry?.endpointDefault || null;
      if (!endpoint && role.provider !== 'claude-code') {
        throw invalidParams('no endpoint',
          `The ${params.role} role has no endpoint and the catalog has no default for ${role.provider}.`);
      }
      let key = null;
      if (entry?.keyRequired ?? true) {
        if (!role.keyRef) {
          throw invalidParams('no key pointer',
            `The ${params.role} role has no key pointer. ${role.provider} needs one; set keyRef in settings first.`);
        }
        // Resolved HERE, at the moment of the call, and handed to the ping as a value:
        // the pointer-only rule is about storage and the wire, and this is neither.
        try {
          key = await resolveRoleKey(role.keyRef);
        } catch (error) {
          // The resolver's sentence names the fix (which variable, which file); pass it
          // through as the hint rather than wrapping it in a vaguer one.
          throw invalidParams('key not resolvable', error.message);
        }
      }
      const measured = await ping({ ...role, endpoint }, key);
      const record = { ...measured, at: new Date(now()).toISOString() };
      // Recorded whether it worked or not. A failed verification is a fact about the
      // configuration worth keeping; clients read ping.ok and ping.hint from settingsGet.
      await state.recordRolePing(params.role, record);
      return record;
    },

    /// Custom sub-agent discovery: Claude Code agent files in ~/.claude/agents and in
    /// each attached repo's .claude/agents. ZERO SPEND: a directory listing and a
    /// frontmatter read, no network, no CLI launch. The claude-code provider's model
    /// list stays in providerCatalog; this lists which AGENT plays the role.
    async agentCatalog() {
      const repos = await state.repos();
      const agents = await scanAgents({ repoPaths: repos.map((row) => row.path) });
      return { agents };
    },

    /// The tool-wide watch (owner field round 6): the watcher's beat over the
    /// WHOLE product, mechanised and zero spend. Findings are board-shaped
    /// rows (source 'watcher'); the paid narration rides later. Each sweep is
    /// computed fresh from state the engine already holds - a stored finding
    /// would keep reporting a problem after the owner fixed it.
    async systemCheck() {
      const at = new Date(now()).toISOString();
      const status = await api.serveStatus({});
      const settings = await state.settings();
      const catalog = await loadProviderCatalog();
      const zaiDefault = catalog.providers.find((p) => p.id === 'zai')?.endpointDefault || ZAI_PAYG_URL;
      const findings = [
        ...statusFindings(status, { at }),
        ...roleFindings(settings.roles, { at, zaiDefault }),
      ];
      for (const repo of status.repos || []) {
        try {
          const content = await readFile(gatesFilePath(repo.path), 'utf8');
          findings.push(...gateFindings(repo.path, parseGatesFile(content), { at }));
        } catch {
          // No gates file is not a finding: discovery simply has not run, and
          // the init flow already owns telling the user that.
        }
      }
      return { findings, at };
    },

    /// The auditor's hand, under two locks: confirm is required on every call
    /// (this changes the MACHINE or the settings, and the engine never infers
    /// consent), and the catalog is CLOSED (watch.js) - a fix either runs a
    /// command written in this codebase or patches a setting to a value
    /// written in this codebase. Nothing from a repo or a provider response
    /// is ever executed.
    async systemFix(params) {
      const fix = FIX_CATALOG[params?.fixId];
      if (!fix) {
        throw invalidParams('unknown fix',
          `fixId must be one of: ${Object.keys(FIX_CATALOG).join(', ')}. The fix catalog is closed on purpose.`);
      }
      if (params?.confirm !== true) {
        throw invalidParams('not confirmed',
          `${fix.label} changes this machine or its settings, so it needs confirm: true from an explicit user action.`);
      }
      if (fix.needsRole) {
        if (!ROLES.includes(params?.role)) {
          throw invalidParams('unknown role', `This fix patches one role's endpoint; role must be one of ${ROLES.join(', ')}.`);
        }
        await state.patchSettings({ roles: [{ role: params.role, endpoint: fix.endpoint }] });
        return { ok: true, applied: params.fixId, detail: `${params.role} endpoint set to ${fix.endpoint}. Verify the role to confirm.` };
      }
      const run = deps.execFix || ((command, args) => new Promise((resolve) => {
        execFileCb(command, args, { timeout: 180_000 }, (error, stdout, stderr) => {
          resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
      }));
      const { error, stdout, stderr } = await run(fix.command, [...fix.args]);
      if (error) {
        return { ok: false, applied: params.fixId, detail: `${fix.label} failed: ${String(stderr || error.message || '').slice(-400)}` };
      }
      return { ok: true, applied: params.fixId, detail: `${fix.label} succeeded. ${String(stdout).trim().split('\n').slice(-1)[0] || ''}`.trim() };
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
  return api;
}

export { ROLES, AGENT_ROLES, INIT_MODES };
