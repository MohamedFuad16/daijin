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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import YAML from 'yaml';

import { retrieve } from '../rag/retrieve.js';
import { adoptKnowledgeFolder } from './adopt.js';
import { readBrainArtifacts, writeBrainArtifacts } from './brain-artifacts.js';
import { analyze, readSources } from './analyze.js';
import { buildEvidence } from './evidence.js';
import { BUDGET_SWEEP, checkContentSurvival, collectDeliveries, localCorpus, lowResolutionCaution, mcpUnlock, measureResolution, sweepBudgets } from './floor.js';
import { collectGateSources, discoverGates, gatesFilePath, probeGateCandidates, renderGatesYaml } from './gate-discovery.js';
import { readHistory, shaIndex } from './git.js';
import { caseKey, mineAdoptedGoldset, mineGoldset } from './goldset.js';
import { permuteAnswers } from './rerank-ab.js';
import { DEFAULT_FLOORS as FLOORS, runGoldsetGates } from './goldset-gates.js';
import { importRelationships, ingestUnits } from './ingest.js';
import { narrate, SpendRefusedError } from './narrate.js';
import { scaffoldLayer1, validateCitations } from './scaffold.js';
import { listRepoFiles } from './walk.js';
import { repoPaths } from '../state/layout.js';

export const DAIJIN_DIRECTORY = '.daijin';
export const BRAIN_DIRECTORY = `${DAIJIN_DIRECTORY}/brain`;
export const GOLDSET_FILE = `${DAIJIN_DIRECTORY}/goldset.yaml`;
export const RETIRED_GOLDSET_FILE = `${DAIJIN_DIRECTORY}/goldset-retired.yaml`;
export const REPORT_FILE = `${DAIJIN_DIRECTORY}/init-report.json`;

/**
 * The repo-side paths, from the module that owns the mapping.
 *
 * repoPaths joins its sub-paths under a given root, so passing the ARTIFACT root gives the
 * same structure in the place a read-only target needs it. Two things follow that matter:
 * nothing here computes .daijin sub-paths by hand, and agentsRoot is a SIBLING of brainRoot
 * under one root, which is precisely the arrangement the ingest-boundary contract guard
 * exists to survive.
 */
export function artifactPaths(artifactRoot) {
  return repoPaths(artifactRoot);
}

/** Modes, from RPC v4 initBrain. */
export const MODES = Object.freeze(['ingest', 'layer1', 'layer1+layer2']);

function stepper({ jobId, onStep, clock }) {
  let phase = 'init';
  return {
    setPhase(next) { phase = next; },
    get phase() { return phase; },
    async emit({ step, detail = null, counts = null, level = 'info', ...extra }) {
      if (!onStep) return;
      // EXTRAS PASS THROUGH. This used to rebuild the event from four named fields, so any
      // other key an emit call supplied was dropped HERE, before the forwarder in
      // methods.js that has its own list. actionCode was added to the blocked emit and died
      // at this line: two silent whitelists in series, and the field existed engine-side
      // and was unreachable client-side.
      //
      // The wire boundary stays in methods.js, which is the right place to decide what a
      // client sees. This is not that boundary; it is the pipeline talking to itself, and
      // silently discarding what a caller deliberately attached is not filtering, it is
      // losing data.
      await onStep({ ts: clock(), jobId, phase, step, detail, counts, level, ...extra });
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
 * Rebuild the index from the brain files, without regenerating the brain.
 *
 * This is the operation D-0031 invariant 3 actually promises: "the index is regenerable
 * from them at any time". Without an entry point that reads ONLY the files, the claim is
 * untestable, and an init that happened to ingest from memory would look identical to one
 * that ingests from disk. It is also the operation a user needs after deleting the index,
 * after editing the brain by hand, or after a schema change.
 *
 * Deliberately does NOT re-run analyze, scaffold or the gold-set miner: those regenerate
 * the brain, and a regeneration is a different act from a reindex. Mixing them is how "I
 * rebuilt the index" quietly becomes "I overwrote what I had edited".
 */
export async function reindexFromBrain({
  repoPath, artifactRoot = null, store, embedder, project = null, relationships = [], onStep = null,
  clock = () => Date.now(), jobId = 'reindex',
} = {}) {
  if (!store) throw new Error('reindexFromBrain requires an initialised Store.');
  if (!embedder?.embed) throw new Error('reindexFromBrain requires an embedder with an embed(texts) method.');
  const root = path.resolve(repoPath);
  const artifacts = artifactRoot ? path.resolve(artifactRoot) : root;
  const scope = project ?? (store.project === undefined ? 'default' : store.project);
  const steps = stepper({ jobId, onStep, clock });
  steps.setPhase('reindex');

  const brainRoot = artifactPaths(artifacts).brainRoot;
  const brain = await readBrainArtifacts(brainRoot);
  if (!brain.present || brain.units.length === 0) {
    throw new Error(
      `No brain to reindex at ${brainRoot}. The index is derived from the brain files, so there is `
      + 'nothing to derive it from; run init to generate or adopt one first.',
    );
  }
  await steps.emit({
    step: 'brain-read',
    detail: `${brain.units.length} units from ${brain.files.length} file(s), schema ${brain.schema}`,
    counts: { units: brain.units.length, files: brain.files.length },
  });

  const ingested = await ingestUnits({
    store, units: brain.units, embedder, project: scope, relationships, onStep: (event) => steps.emit(event),
  });
  return { brainRoot, schema: brain.schema, files: brain.files, ...ingested };
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

  // --- brain artifacts (D-0031 invariant 3) ---------------------------------------
  //
  // The brain is durable markdown and the index is derived from it. Units are WRITTEN to
  // .daijin/brain/ and then READ BACK, and it is the read-back units that get indexed, so
  // the index is provably a function of the files rather than of whatever the generator
  // held in memory. A round trip that lost a field shows up immediately as a gold-set miss
  // rather than as a divergence nobody notices until a rebuild.
  let brainWrite = null;
  if (writeArtifacts) {
    steps.setPhase('brain');
    const brainRoot = artifactPaths(artifacts).brainRoot;
    brainWrite = await writeBrainArtifacts(brainRoot, units, {
      generator: mode === 'ingest' ? 'daijin-adopt' : 'daijin-layer1',
    });
    const readBack = await readBrainArtifacts(brainRoot);
    // Compared by CONTENT, not by id. An id check passes while a unit is silently truncated,
    // because the surviving fragment keeps the id; that is how the heading-collision bug got
    // past the first version of this check.
    const before = new Map(units.map((unit) => [unit.id, unit]));
    const after = new Map(readBack.units.map((unit) => [unit.id, unit]));
    const damaged = [...before.entries()]
      .filter(([id, unit]) => {
        const round = after.get(id);
        if (!round) return true;
        return round.content.trim() !== unit.content.trim();
      })
      .map(([id]) => id);
    if (damaged.length > 0) {
      throw new Error(
        `The brain round trip changed ${damaged.length} unit(s) (${damaged.slice(0, 3).join(', ')}). `
        + 'The index is derived from these files, so a unit that does not survive the round trip '
        + 'would be indexed as something the brain does not say.',
      );
    }
    // `core` is a MEASUREMENT annotation (the span the content-survival gate demands back
    // verbatim), not brain content, so it is carried across by id rather than encoded in the
    // artifact. Asserted rather than assumed: a unit that lost its core would make the
    // survival gate silently check nothing.
    units = readBack.units.map((unit) => ({ ...unit, core: before.get(unit.id)?.core ?? null }));
    const coreless = units.filter((unit) => !unit.core).length;
    if (coreless > 0 && coreless === units.length) {
      throw new Error('Every unit lost its measurement core in the round trip; the survival gate would check nothing.');
    }
    report.phases.brain = {
      root: brainRoot,
      schema: readBack.schema,
      written: brainWrite.written,
      unitsWritten: brainWrite.units,
      unitsReadBack: readBack.units.length,
      unknownTypes: brainWrite.unknownTypes,
    };
    await steps.emit({
      step: 'brain-written',
      detail: `${brainWrite.units} units across ${brainWrite.written.length} file(s), read back ${readBack.units.length}`,
      counts: { written: brainWrite.units, readBack: readBack.units.length },
    });
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
    // WHAT USUALLY CAUSES THIS, which is the half a conclusion cannot supply. A gold set
    // this small almost always means the walk saw very little, and the two reasons it sees
    // very little are a repo with nothing in it yet and a repo that is not the one the user
    // meant. The owner's field test was the second: a nested directory attached by mistake.
    // TWO KINDS OF BLOCK, because they are different problems with different next moves.
    // This one is "the gauge is not fit to measure"; the discrimination block below is
    // "the gauge measured and cannot see". A client that renders both the same way sends
    // the user to mine more material when the material is not the problem.
    const tiny = gated.cases.length < 5;
    const action = tiny
      ? `Only ${gated.cases.length} case(s) could be mined, which usually means the attached directory holds very little: check that you attached the repository root rather than a subdirectory, and that the repo has code and history to mine.`
      : 'Mine more material, or attach a repository with more code and history; the gates above name what is short.';
    // A CODE BESIDE THE PROSE. The TUI wants to offer "attach the root instead" as a
    // button, and branching on the sentence would make the wording load-bearing: a comma
    // moved in a message written for a human would silently unwire a control. The prose
    // stays the thing a person reads and the code stays the thing a client switches on.
    // Closed set, so a client can exhaust it.
    const actionCode = tiny ? 'too-little-material' : 'gold-set-too-thin';

    report.blocked = {
      at: 'goldset-gates',
      reason: 'The gold set did not pass its own integrity gates, so it is not fit to measure.',
      failed,
      action,
      actionCode,
    };
    report.finishedAt = clock();
    if (writeArtifacts) await writeReport(artifacts, report);
    // THE EVIDENCE TRAVELS WITH THE CONCLUSION. This emitted the bare reason while `failed`
    // sat in a report file the user never opens, so the owner's field test showed a verdict
    // with nothing to check it against and took a screenshot plus archaeology to diagnose.
    // A refusal carries its reason and the action that clears it; this is the product's
    // most important failure path and it was the one place we did not.
    await steps.emit({
      step: 'blocked',
      detail: `${report.blocked.reason} Failed: ${failed.join(' | ')}. ${action}`,
      level: 'warn',
      // ON THE EVENT, not only on the report. The report is an in-process object that no
      // method returns and nothing writes to disk, so a client's ONLY sight of a block is
      // this event: a field that lives on the report alone is unreachable, which is what
      // tui-builder measured when they went to build the control it was added for.
      actionCode,
    });
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
  let survival = checkContentSurvival(deliveries, { units, tokenBudget: sweep.chosen });

  // D-0003 names content survival as the MECHANICAL RAISE SIGNAL, and a signal that only
  // says "something is wrong" is half an instrument. When it fires at the chosen budget the
  // sweep is walked upward until cores survive, so the report can name the smallest budget
  // that works instead of leaving the reader to guess.
  //
  // Measured on the curated arm of P3.5, which is the case this exists for: the case rate is
  // FLAT across 3k/4k/6k/8k, so the rate rule picks 3000, while survival fails at 3000 and
  // 4000 and passes at 6000. The rate says the small budget is free; the survival gate says
  // it costs whole cores. Same repo, different corpus, different answer.
  if (survival.status !== 'pass') {
    for (const candidateBudget of [...budgets].sort((left, right) => left - right)) {
      if (candidateBudget <= sweep.chosen) continue;
      const raisedDeliveries = await collectDeliveries({
        cases: gated.active, retrieveFn, tokenBudget: candidateBudget,
      });
      const raised = checkContentSurvival(raisedDeliveries, { units, tokenBudget: candidateBudget });
      if (raised.status === 'pass') {
        survival = {
          ...survival,
          raisedBudget: candidateBudget,
          raisedSurvival: raised.survival,
          recommendation: `The case rate is unchanged from ${sweep.chosen} to ${candidateBudget} tokens, so the rate rule `
            + `chose ${sweep.chosen}; content survival FAILS there and PASSES at ${candidateBudget}. D-0003 makes this the `
            + `mechanical raise signal, so ${candidateBudget} is the smallest budget this corpus can be served at without `
            + 'delivering units whose cores were cut.',
        };
        await steps.emit({ step: 'survival-raise', detail: survival.recommendation, level: 'warn' });
        break;
      }
    }
    if (!survival.raisedBudget) {
      survival = {
        ...survival,
        raisedBudget: null,
        recommendation: 'Content survival fails at every budget in the sweep, so raising it is not the fix here; '
          + 'the units themselves are the thing to change.',
      };
    }
  }

  // D-0030: the floor never ships without the range it was measured inside. The control is
  // the SAME cases with deliberately wrong answers, so it measures this gauge on this
  // corpus rather than a general property of small repos.
  let resolution = null;
  // SCRATCH, never the repo. The permuted control is a measurement INPUT the
  // range record makes reproducible, not an artifact: written under the repo
  // it left a top-level control/ directory in the owner's working tree, found
  // by the dogfood run's git status. The measured range lives in the report
  // and the range file; the permuted file itself is derivable and disposable.
  let controlScratch = null;
  try {
    controlScratch = writeArtifacts ? await mkdtemp(path.join(tmpdir(), 'daijin-control-')) : null;
    const controlPath = controlScratch
      ? await writeGoldset(controlScratch, permuteAnswers(gated.active))
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
  } finally {
    if (controlScratch) await rm(controlScratch, { recursive: true, force: true }).catch(() => {});
  }

  // The unlock is decided AFTER the range is known, so the decision can carry it (finding
  // 80). The threshold itself is untouched; only what the reader is told changes.
  const unlock = mcpUnlock(sweep.chosenPoint.caseRate, { resolution: resolution?.unavailable ? null : resolution, violations: sweep.chosenPoint.violations ?? null });
  if (unlock.saturation) {
    await steps.emit({ step: 'mcp-saturation', detail: unlock.saturation, level: 'warn' });
  }

  // THE GAUGE MUST BE ABLE TO SEE AN EFFECT BEFORE ITS NUMBER IS PUBLISHED (D-0046).
  //
  // This REVERSES a documented decision. measureResolution says "Reported, never gated",
  // on the reasoning that a narrow range is a fact about the corpus rather than a failure.
  // That reasoning is right about the FACT and wrong about what to do with it: a floor
  // published from a gauge with no discriminating room reads as "retrieval is perfect
  // here" when it means "this gauge cannot tell", which is the same class as scoring a
  // gold set that failed its own integrity gates - a number that looks exactly like a real
  // one. The range stays reported either way; what changes is that a set with no room does
  // not also get a floor.
  //
  // Unavailable is NOT a failure. A corpus that cannot be permuted (fewer than two distinct
  // answers) yields no range, and absence of evidence must not become evidence of absence.
  const headroom = resolution && !resolution.unavailable
    ? resolution.caseRate?.casesOfHeadroom ?? null
    : null;
  if (headroom !== null && headroom < FLOORS.minimumHeadroomCases) {
    report.floor = null;
    report.blocked = {
      at: 'discrimination',
      reason: 'The gold set scores almost as well with deliberately wrong answers, so it cannot tell a working retriever from a broken one.',
      failed: [`headroom: ${headroom} case(s), minimum ${FLOORS.minimumHeadroomCases}`],
      action: 'This is a property of the corpus rather than of the repository: the brain is small enough that presence is nearly free, so almost any answer scores. Add material, or accept that a floor here would not mean what it appears to mean.',
      actionCode: 'gauge-cannot-discriminate',
    };
    report.finishedAt = clock();
    if (writeArtifacts) await writeReport(artifacts, report);
    await steps.emit({
      step: 'blocked',
      detail: `${report.blocked.reason} ${report.blocked.failed[0]}. ${report.blocked.action}`,
      level: 'warn',
      actionCode: report.blocked.actionCode,
    });
    return report;
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
    // Null above the band. Present when the number is real but coarse, so the widest-bar
    // case names itself instead of relying on a reader to derive bars from a denominator.
    lowResolution: lowResolutionCaution(sweep.chosenPoint.caseRate?.total ?? null, FLOORS),
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
