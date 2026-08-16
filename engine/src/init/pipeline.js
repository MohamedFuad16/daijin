// The headless init pipeline.
//
// Order is the plan's, and the order is the product: "verify roles -> identify (commits,
// languages, structure, gates) -> brain phase (existing folder: auditor drift-check with
// sampled claim validation and cited updates; missing: Layer 1 evidence then LLM narration
// then citation validation) -> chunk, embed, per-repo SQLite -> mechanical gold set ->
// retrieval floor -> at 75 percent or above, MCP unlocks with a paste-ready snippet."
//
// Everything here is zero-spend. The one step that would spend (Layer 2 narration) sits
// behind narrate.js and refuses by default; running init with mode 'layer1' never reaches
// it. Steps are emitted as they happen, in the shape RPC v4 froze
// ({ ts, jobId, phase, step, detail, counts, level }), because the init UX is a live
// activity feed and a pipeline that only reports at the end cannot drive one.
//
// The report this returns is the honest record: whatever the floor turns out to be, it is
// written down with its case counts, its budget curve, and the gates that did or did not
// pass. Nothing in here rounds, and nothing in here retries a measurement it did not like.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

import { retrieve } from '../rag/retrieve.js';
import { adoptKnowledgeFolder } from './adopt.js';
import { analyze, readSources } from './analyze.js';
import { buildEvidence } from './evidence.js';
import {
  BUDGET_SWEEP, checkContentSurvival, collectDeliveries, localCorpus, mcpUnlock, measureResolution, sweepBudgets,
} from './floor.js';
import { collectGateSources, discoverGates, gatesFilePath, probeGateCandidates, renderGatesYaml } from './gate-discovery.js';
import { readHistory, shaIndex } from './git.js';
import { caseKey, mineAdoptedGoldset, mineGoldset } from './goldset.js';
import { permuteAnswers } from './rerank-ab.js';
import { runGoldsetGates } from './goldset-gates.js';
import { importRelationships, ingestUnits } from './ingest.js';
import { narrate, SpendRefusedError } from './narrate.js';
import { scaffoldLayer1, validateCitations } from './scaffold.js';
import { listRepoFiles } from './walk.js';

export const DAIJIN_DIRECTORY = '.daijin';
export const GOLDSET_FILE = `${DAIJIN_DIRECTORY}/goldset.yaml`;
export const RETIRED_GOLDSET_FILE = `${DAIJIN_DIRECTORY}/goldset-retired.yaml`;
export const REPORT_FILE = `${DAIJIN_DIRECTORY}/init-report.json`;

/** Modes, from RPC v4 initBrain. */
export const MODES = Object.freeze(['ingest', 'layer1', 'layer1+layer2']);

function stepper({ jobId, onStep, clock }) {
  let phase = 'init';
  return {
    setPhase(next) { phase = next; },
    get phase() { return phase; },
    async emit({ step, detail = null, counts = null, level = 'info' }) {
      if (!onStep) return;
      await onStep({ ts: clock(), jobId, phase, step, detail, counts, level });
    },
  };
}

/**
 * Write the gold set where the harness can load it.
 *
 * YAML, because that is what corpus.js loadGoldset parses, and because a gold set is a
 * thing a human edits: the auditor may demand more cases, and a user may veto one.
 *
 * ACTIVE cases only. The harness scores every case in the file it loads (scoreGoldset ->
 * loadGoldset -> validateGoldset), so a retired case left in this file would be measured
 * against a target that is known to be gone and would show up as a permanent miss. The
 * retirement RECORD is preserved instead, in its own file: store.d.ts is explicit that a
 * retired case keeps its date and reason rather than being deleted.
 */
export async function writeGoldset(artifactRoot, cases) {
  const file = path.join(artifactRoot, GOLDSET_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  const header = [
    '# Daijin gold set. Mechanically mined; every case records where it came from.',
    '# Answers are ARTIFACTS (document ids), never prose. must_not_outrank is a RANKING',
    '# constraint: a listed id beating a required one is a violation, not an exclusion.',
    '# ACTIVE cases only: these are the ones that measure. Retired cases keep their record',
    `# in ${RETIRED_GOLDSET_FILE}, with the date and the reason they stopped being askable.`,
    '',
  ].join('\n');
  await writeFile(file, `${header}${YAML.stringify(cases, { lineWidth: 0 })}`);
  return file;
}

/**
 * Append to the retirement record.
 *
 * Read first, then merge: a retirement is history, and a run that overwrote the file with
 * only its own retirements would erase the record of every case retired before it. Keyed
 * on provenance plus query because case ids are positional and are reassigned on every
 * mining run.
 */
export async function writeRetiredGoldset(artifactRoot, retired) {
  const file = path.join(artifactRoot, RETIRED_GOLDSET_FILE);
  let existing = [];
  try {
    existing = YAML.parse(await readFile(file, 'utf8')) || [];
  } catch {
    existing = [];
  }
  const merged = [...(Array.isArray(existing) ? existing : []), ...retired];
  const seen = new Set();
  const deduped = merged.filter((entry) => {
    const key = entry?.key || `${entry?.provenance || ''}::${entry?.query || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length === 0) return null;
  await mkdir(path.dirname(file), { recursive: true });
  const header = [
    '# Retired gold cases. Kept, never deleted: each one records what the gauge used to',
    '# cover and the date its target stopped existing. Re-mining does not resurrect them.',
    '',
  ].join('\n');
  await writeFile(file, `${header}${YAML.stringify(deduped, { lineWidth: 0 })}`);
  return file;
}

/**
 * Read the gold set a previous run (or a user) left behind.
 *
 * Carrying it forward is what makes the staleness gate mean anything. Re-mining alone
 * regenerates every case from the CURRENT tree, so nothing it produces can ever be stale
 * and the gate would be structurally unable to fire. The cases that go stale are the ones
 * that persist: a case a user wrote by hand, a case the auditor demanded, or a case an
 * earlier run mined against a module that has since been deleted.
 */
export async function readExistingGoldset(artifactRoot) {
  try {
    const parsed = YAML.parse(await readFile(path.join(artifactRoot, GOLDSET_FILE), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Union of freshly mined cases and carried-forward ones.
 *
 * Keyed on provenance plus query rather than id, because ids are positional and are
 * reassigned every run. Mined cases win the key so a re-mined case picks up any changed
 * answer; anything left is carried with `carried: true` so the report can say how much of
 * the gauge is inherited rather than measured today.
 */
export function mergeGoldset(mined, carried) {
  // Identity is the STABLE KEY the miner wrote, not the positional id and not the query.
  // Legacy files written before keys existed fall back to provenance plus query, which is
  // what that generation of the format had.
  const identity = (entry) => entry.key || caseKey(entry.provenance || '', entry.query || '');
  const carriedByKey = new Map(carried.filter((entry) => !entry.retired).map((entry) => [identity(entry), entry]));

  const merged = mined.map((entry) => {
    const previous = carriedByKey.get(identity(entry));
    carriedByKey.delete(identity(entry));
    if (!previous) return entry;
    // Mechanics own the ANSWER, because must_return is a fact about the tree as it is now.
    // The user owns the WORDING. Preserving their edit is the whole point of a stable key:
    // without it their rewritten question came back every run as a second case.
    const userWorded = previous.query && previous.query !== entry.query;
    return {
      ...entry,
      query: previous.query || entry.query,
      ...(previous.must_not_outrank ? { must_not_outrank: previous.must_not_outrank } : {}),
      ...(userWorded ? { userEdited: true } : {}),
    };
  });

  // Whatever is left was authored by a user or mined by a version that no longer proposes
  // it. It rides along and the staleness gate judges it.
  const inherited = [...carriedByKey.values()].map((entry) => ({ ...entry, carried: true }));
  return [...merged, ...inherited].map((entry, index) => ({ ...entry, id: `g${String(index + 1).padStart(3, '0')}` }));
}

/** A retrieve() bound to this repo's store, for the content-survival pass. */
function boundRetrieve({ store, project, environment, standingPrefix, pathGrammar, k, fetchImpl }) {
  return async ({ query, tokenBudget }) => retrieve(
    { query, project: project || 'default', k, tokenBudget },
    { store, environment, standingPrefix, pathGrammar, fetchImpl },
  );
}

/**
 * Run a full init, headlessly.
 *
 * @param {object} options
 * @param {string} options.repoPath
 * @param {'ingest'|'layer1'|'layer1+layer2'} options.mode
 * @param {object} options.store      an initialised Store (v3)
 * @param {object} options.embedder   { embed(texts) }
 * @param {Function} [options.onStep] step-event sink
 * @param {Function} [options.clock]  injected clock; determinism in tests, wall clock in the product
 */
export async function initBrain({
  repoPath,
  mode = 'layer1',
  store,
  embedder,
  project = null,
  environment = process.env,
  standingPrefix = 'global.',
  pathGrammar = null,
  fetchImpl = undefined,
  k = 8,
  budgets = BUDGET_SWEEP,
  spendGate = { open: false, path: null },
  narrator = null,
  confirmedBudget = null,
  narrationAreas = null,
  scaffoldOptions = {},
  discoverRepoGates = true,
  gateRepoPath = null,
  gateRunner = undefined,
  gateTimeoutMs = undefined,
  onStep = null,
  clock = () => Date.now(),
  jobId = 'init',
  artifactRoot = null,
  writeArtifacts = true,
  commitCap = undefined,
} = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown init mode ${mode}; expected one of ${MODES.join(', ')}.`);
  if (!store) throw new Error('initBrain requires an initialised Store.');
  if (!embedder?.embed) throw new Error('initBrain requires an embedder with an embed(texts) method.');

  // One store per repo, but the project scope still has to be a concrete string: the
  // retrieval path REQUIRES a project (retrieve.js validateOptions) while the store treats
  // null as the whole store. Taking the store's own project keeps the three uses aligned
  // (the project written on documents, the prune scope, and the query filter); a mismatch
  // here writes documents no query can see, and every case would miss for a reason that
  // has nothing to do with retrieval.
  const storeProject = store.project;
  const scope = project ?? (storeProject === undefined ? 'default' : storeProject);
  if (typeof scope !== 'string' || scope.length === 0) {
    throw new Error(
      'initBrain needs a concrete project scope. The retrieval path requires a non-empty project '
      + 'while the store treats null as the whole store, so a null-project store writes documents '
      + 'that no query selects and every gold case misses for a reason unrelated to retrieval. '
      + 'Construct the Store with a project; its own default is "default".',
    );
  }
  if (storeProject !== undefined && storeProject !== scope) {
    throw new Error(
      `initBrain was given project "${scope}" but the store writes documents with project "${storeProject}".`,
    );
  }
  const root = path.resolve(repoPath);
  // Where the artifacts land. Defaults to the repo, which is what a user's own repo wants.
  // A READ-ONLY target (an owner's repo Daijin has no authorization to write into) points
  // this at a scratch directory instead, and the report records both paths so a reader can
  // tell where the brain was measured from where its record was kept.
  const artifacts = artifactRoot ? path.resolve(artifactRoot) : root;
  const steps = stepper({ jobId, onStep, clock });
  const startedAt = clock();
  const report = { jobId, repoPath: root, artifactRoot: artifacts, mode, project: scope, startedAt, phases: {} };

  // --- identify ------------------------------------------------------------------
  steps.setPhase('identify');
  await steps.emit({ step: 'analyze', detail: root });
  const analysis = await analyze(root);
  report.analysis = analysis;
  await steps.emit({
    step: 'analyzed',
    detail: `${analysis.files.count} files, ${analysis.languages.length} languages, ${analysis.commitCount ?? 'no'} commits`,
    counts: { files: analysis.files.count, commits: analysis.commitCount, gateCandidates: analysis.gateCandidates.length },
  });

  if (mode === 'ingest' && !analysis.brainFolder.present) {
    // Refusing by name rather than quietly generating: a user who asked to adopt has a
    // folder in mind, and handing them machine output instead is the wrong answer to the
    // question they asked.
    throw new Error(
      'Mode "ingest" adopts an existing knowledge folder and this repo has none that qualifies. '
      + 'A folder counts when it holds at least one markdown file. Use mode "layer1" to generate one.',
    );
  }

  // --- evidence ------------------------------------------------------------------
  steps.setPhase('evidence');
  const listing = await listRepoFiles(root);
  const { sources, skipped } = await readSources(root, listing.files);
  await steps.emit({ step: 'read-sources', detail: `${sources.size} source files read`, counts: { read: sources.size, skipped } });
  const history = await readHistory(root, commitCap ? { cap: commitCap } : {});
  if (history.capped) {
    await steps.emit({
      step: 'history-capped',
      detail: `history walk stopped at the cap of ${history.cap} commits of ${history.total}; every history statistic below covers that window only`,
      level: 'warn',
    });
  }
  const { manifests, texts } = await collectGateSources(root, listing.files);
  const evidence = buildEvidence({ analysis, sources, files: listing.files, manifests, history });
  report.phases.evidence = {
    sourceFiles: sources.size,
    edges: evidence.graph.edges.length,
    externalPackages: evidence.graph.external.length,
    uniqueSymbols: evidence.symbols.unique.length,
    history: { available: history.available, commits: evidence.history.commits, capped: history.capped, cap: history.cap },
  };
  await steps.emit({
    step: 'evidence-built',
    detail: `${evidence.graph.edges.length} import edges, ${evidence.areas.length} areas, ${evidence.symbols.unique.length} unique symbols`,
    counts: report.phases.evidence,
  });

  // --- scaffold, or adopt --------------------------------------------------------
  const commits = shaIndex(history.commits || []);
  let scaffold = null;
  let adopted = null;
  let proposedUnits = [];
  if (mode === 'ingest') {
    steps.setPhase('adopt');
    adopted = await adoptKnowledgeFolder(root, {
      directory: analysis.brainFolder.directory,
      files: listing.files,
    });
    proposedUnits = adopted.units;
    await steps.emit({
      step: 'adopted',
      detail: `${adopted.granularity.units} units from ${adopted.granularity.documents} curated documents `
        + `(split rules: ${Object.entries(adopted.granularity.byRule).map(([rule, count]) => `${rule} ${count}`).join(', ') || 'none'})`,
      counts: adopted.granularity,
    });
  } else {
    steps.setPhase('scaffold');
    scaffold = scaffoldLayer1(evidence, scaffoldOptions);
    proposedUnits = scaffold.units;
  }
  const validated = validateCitations(proposedUnits, { files: listing.files, commits });
  if (validated.dropped.length > 0) {
    await steps.emit({
      step: 'citations-dropped',
      detail: `${validated.dropped.length} generated unit(s) dropped for citing something that is not there`,
      level: 'warn',
    });
  }
  let units = validated.accepted;
  if (mode === 'ingest') {
    report.phases.adopt = {
      documents: adopted.granularity.documents,
      proposed: adopted.units.length,
      accepted: units.length,
      dropped: validated.dropped,
      granularity: adopted.granularity,
      files: adopted.files,
      notes: adopted.notes,
    };
  } else {
    report.phases.scaffold = {
      generated: scaffold.units.length,
      accepted: units.length,
      dropped: validated.dropped,
      notes: scaffold.notes,
      errors: { units: scaffold.errors.units.length, reason: scaffold.errors.reason, candidates: {
        fixCommits: scaffold.errors.candidates.fixCommits.length,
        revertCommits: scaffold.errors.candidates.revertCommits.length,
      } },
    };
    await steps.emit({
      step: 'scaffolded',
      detail: `${units.length} Layer 1 units, 0 error records (${scaffold.errors.candidates.fixCommits.length} fix and ${scaffold.errors.candidates.revertCommits.length} revert commits kept as evidence only)`,
      counts: { units: units.length },
    });
  }

  // --- narration (spend boundary) -------------------------------------------------
  if (mode === 'layer1+layer2') {
    steps.setPhase('narrate');
    try {
      const narrated = await narrate({
        evidence, narrator, spendGate, confirmedBudget, areas: narrationAreas, files: listing.files, commits,
      });
      units = [...units, ...narrated.accepted];
      report.phases.narrate = { accepted: narrated.accepted.length, dropped: narrated.dropped };
      await steps.emit({ step: 'narrated', detail: `${narrated.accepted.length} accepted, ${narrated.dropped.length} dropped for failing citation validation` });
    } catch (error) {
      if (!(error instanceof SpendRefusedError)) throw error;
      report.phases.narrate = { refused: true, code: error.code, reason: error.message };
      await steps.emit({ step: 'narration-refused', detail: error.message, level: 'warn' });
    }
  }

  // --- ingest --------------------------------------------------------------------
  steps.setPhase('ingest');
  const relationships = importRelationships(evidence.graph);
  const ingested = await ingestUnits({
    store, units, embedder, project: scope, relationships, onStep: (event) => steps.emit(event),
  });
  report.phases.ingest = ingested;

  // --- gates ---------------------------------------------------------------------
  if (discoverRepoGates) {
    steps.setPhase('gates');
    const candidates = probeGateCandidates({ files: listing.files, manifests, texts });
    await steps.emit({ step: 'gates-probed', detail: `${candidates.length} candidate command(s)`, counts: { candidates: candidates.length } });
    // Gate commands are arbitrary repo code and a build gate WRITES (a bundler emits into
    // dist/). Running them in the target is a mutation of it, so a read-only target points
    // gateRepoPath at a sandbox checked out at the same commit. Same lineage as the gym's
    // sandbox at the exam's base commit, and the same reason.
    const gateRoot = gateRepoPath ? path.resolve(gateRepoPath) : root;
    const discovered = await discoverGates({
      repoPath: gateRoot,
      candidates,
      environment,
      ...(gateRunner ? { run: gateRunner } : {}),
      ...(gateTimeoutMs ? { timeoutMs: gateTimeoutMs } : {}),
      onStep: (event) => steps.emit(event),
    });
    report.phases.gates = discovered.summary;
    report.gates = discovered.gates;
    if (writeArtifacts) {
      const file = gatesFilePath(artifacts);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, renderGatesYaml({ ...discovered, discoveredAt: new Date(startedAt).toISOString() }));
      report.phases.gates.file = file;
      report.phases.gates.ranIn = gateRoot;
      report.phases.gates.sandboxed = gateRoot !== root;
    }
    await steps.emit({
      step: 'gates-classified',
      detail: `${discovered.summary.carryingSignal} of ${discovered.summary.total} gate(s) carry signal `
        + `(${discovered.summary.preBroken} pre-broken, ${discovered.summary.unavailable} unavailable, both excluded and labeled)`,
      counts: discovered.summary,
    });
  }

  // --- gold set ------------------------------------------------------------------
  steps.setPhase('goldset');
  // The adopted brain has no area cards, no import graph behind its units and no fixed
  // convention ids, so the generated sources cannot reach it. Same trust order, same target
  // formula, same gates: only the evidence differs, which is what keeps a
  // curated-versus-generated comparison a comparison of brains rather than of methods.
  const mined = mode === 'ingest'
    ? mineAdoptedGoldset({ units, symbols: evidence.symbols, history, repoFiles: listing.files.filter((file) => !file.startsWith(`${analysis.brainFolder.directory}/`)), chunkCount: ingested.chunks })
    : mineGoldset({ evidence, units, history, chunkCount: ingested.chunks });
  // Cases a previous run or a user left behind ride along. They are the only cases that
  // can go stale, and the staleness gate is what retires them.
  const carried = await readExistingGoldset(artifacts);
  const proposed = mergeGoldset(mined.cases, carried);
  const gated = await runGoldsetGates(proposed, {
    store,
    units,
    files: listing.files,
    commits,
    symbols: evidence.symbols,
    date: new Date(startedAt).toISOString().slice(0, 10),
  });
  report.phases.goldset = {
    mined: mined.cases.length,
    carried: proposed.length - mined.cases.length,
    target: mined.target,
    pool: mined.pool,
    notes: mined.notes,
    active: gated.active.length,
    retired: gated.retired.length,
    constraintsPruned: gated.constraintsPruned,
    passed: gated.passed,
    gates: gated.gates.map((entry) => ({ id: entry.id, status: entry.status, detail: entry.detail, failures: entry.failures || [] })),
  };
  // ACTIVE cases measure; the retirement record is preserved separately (see writeGoldset).
  const goldsetFile = writeArtifacts ? await writeGoldset(artifacts, gated.active) : null;
  const retiredFile = writeArtifacts ? await writeRetiredGoldset(artifacts, gated.retired) : null;
  report.phases.goldset.files = { active: goldsetFile, retired: retiredFile };
  await steps.emit({
    step: 'goldset-mined',
    detail: `${gated.active.length} active cases (target ${mined.target.target}), gates ${gated.passed ? 'PASS' : 'FAIL'}`,
    counts: { cases: gated.active.length, retired: gated.retired.length },
    level: gated.passed ? 'info' : 'warn',
  });

  // The gold set measures only after it passes its own gates. A failing gauge that scores
  // anyway produces a number that reads exactly like a real one, which is worse than none.
  if (!gated.passed) {
    const failed = gated.gates.filter((entry) => entry.status !== 'pass').map((entry) => `${entry.id}: ${entry.detail}`);
    report.floor = null;
    report.blocked = {
      at: 'goldset-gates',
      reason: 'The gold set did not pass its own integrity gates, so it is not fit to measure.',
      failed,
    };
    report.finishedAt = clock();
    if (writeArtifacts) await writeReport(artifacts, report);
    await steps.emit({ step: 'blocked', detail: report.blocked.reason, level: 'warn' });
    return { ...report, units, evidence, goldsetFile, cases: gated.cases };
  }

  // --- floor ---------------------------------------------------------------------
  steps.setPhase('floor');
  const corpus = localCorpus({
    id: analysis.name,
    project: scope,
    goldsetPath: goldsetFile || path.join(artifacts, GOLDSET_FILE),
    standingPrefix,
    pathGrammar,
  });
  const sweep = await sweepBudgets({ corpus, store, budgets, k, environment, fetchImpl, onStep: (event) => steps.emit(event) });
  const retrieveFn = boundRetrieve({ store, project: scope, environment, standingPrefix, pathGrammar, k, fetchImpl });
  const deliveries = await collectDeliveries({
    cases: gated.active, retrieveFn, tokenBudget: sweep.chosen,
  });
  const survival = checkContentSurvival(deliveries, { units, tokenBudget: sweep.chosen });

  // D-0030: the floor never ships without the range it was measured inside. The control is
  // the SAME cases with deliberately wrong answers, so it measures this gauge on this
  // corpus rather than a general property of small repos.
  let resolution = null;
  try {
    const controlPath = writeArtifacts
      ? await writeGoldset(path.join(artifacts, 'control'), permuteAnswers(gated.active))
      : null;
    if (controlPath) {
      resolution = await measureResolution({
        corpus,
        controlCorpus: localCorpus({
          id: `${analysis.name}-permuted`, project: scope, goldsetPath: controlPath, standingPrefix, pathGrammar,
        }),
        store,
        tokenBudget: sweep.chosen,
        k,
        environment,
        fetchImpl,
      });
      await steps.emit({ step: 'resolution-measured', detail: resolution.reading });
    }
  } catch (error) {
    // A gauge too small to permute (one distinct answer) has no range to report. That is
    // itself worth saying, and it must not take the floor down with it.
    resolution = { unavailable: true, reason: error.message };
    await steps.emit({ step: 'resolution-unavailable', detail: error.message, level: 'warn' });
  }

  // The unlock is decided AFTER the range is known, so the decision can carry it (finding
  // 80). The threshold itself is untouched; only what the reader is told changes.
  const unlock = mcpUnlock(sweep.chosenPoint.caseRate, { resolution: resolution?.unavailable ? null : resolution });
  if (unlock.saturation) {
    await steps.emit({ step: 'mcp-saturation', detail: unlock.saturation, level: 'warn' });
  }

  report.floor = {
    caseRate: sweep.chosenPoint.caseRate,
    mrr: sweep.chosenPoint.mrr,
    violations: sweep.chosenPoint.violations,
    identifierCaseRate: sweep.chosenPoint.identifierCaseRate,
    identifierCases: sweep.chosenPoint.identifierCases,
    chosenBudget: sweep.chosen,
    bestBudget: sweep.best,
    rationale: sweep.rationale,
    budgetSweep: sweep.curve,
    k,
    contentSurvival: survival,
    resolution,
    mcp: unlock,
    perCase: sweep.chosenPoint.results.map((entry) => ({
      caseId: entry.id,
      hit: entry.complete,
      hits: entry.hits,
      required: entry.required,
      misses: entry.misses,
      violations: entry.violations,
      identifier: entry.identifier,
      standingAssisted: entry.standingAssisted,
    })),
  };
  await steps.emit({
    step: 'floor-measured',
    detail: `${sweep.chosenPoint.caseRate.cases} at ${sweep.chosen} tokens, ${sweep.chosenPoint.violations} violations; MCP ${unlock.unlocked ? 'unlocked' : 'locked'}`,
    counts: { hits: sweep.chosenPoint.caseRate.hits, cases: sweep.chosenPoint.caseRate.total, tokenBudget: sweep.chosen },
  });
  if (survival.status !== 'pass') {
    await steps.emit({ step: 'content-survival', detail: survival.raiseSignal, level: 'warn' });
  }

  report.finishedAt = clock();
  if (writeArtifacts) await writeReport(artifacts, report);
  return { ...report, units, evidence, goldsetFile, cases: gated.cases };
}

export async function writeReport(artifactRoot, report) {
  const file = path.join(artifactRoot, REPORT_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
