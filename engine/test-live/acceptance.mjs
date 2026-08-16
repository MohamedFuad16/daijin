#!/usr/bin/env node
// The engine half of the P8 acceptance, RE-RUNNABLE by someone who is not its author.
//
//   node engine/test-live/acceptance.mjs [--keep]
//
// The first acceptance was a set of commands in an evidence file, which is reproducible in
// the sense that a transcript is reproducible: someone can read it and do the same things.
// This runs them. The difference matters at the next pin, where the numbers have to be
// re-derived rather than cited, and citing is what re-derivation exists to prevent.
//
// ZERO SPEND. Local Ollama for embeddings and nothing else; no provider is reachable from
// here and the spend-touching methods are exercised only through their REFUSALS.
//
// It also carries the LIVE TIER of the contract-shape gate. Four methods cannot be checked
// in the unit suite because they need a real embedder (search, retrievalScore, diagnose)
// or because their shape is set by a writer that measures (scoreHistory), and the gate
// prints them as uncovered on every unit run. This is where that debt is paid, and the
// gate's printed remainder and this script's coverage list have to agree or one of them is
// lying.
//
// ITS FIRST RUN JUSTIFIED THE TIER: it found `context` on search and `at` on
// retrievalScore, neither documented, and it found that `diagnose` is BOTH live and prose,
// so listing it as live had hidden that no tier was going to check it. Two undocumented
// fields and one method nobody was checking, on a surface the unit gate reports as
// eighteen-of-thirty covered.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildFixture } = await import(`${ENGINE}/test-live/p8-fixture.mjs`);
const { seedRubric } = await import(`${ENGINE}/test-live/p8-seed-rubric.mjs`);
const { createRpcServer } = await import(`${ENGINE}/src/rpc/server.js`);
const { documentedShape } = await import(`${ENGINE}/test/helpers/contract-shape.js`);

/// The methods the unit gate cannot reach. This list must match what the gate prints as
/// its live tier; a check that exists in neither place is the hole both were built to close.
const LIVE_TIER = ['search', 'retrievalScore', 'diagnose', 'scoreHistory'];

// The same ratchet the unit gate carries, and EMPTY for the same reason that one is: the
// three entries this tier found on its first run were all resolved by amending the rows
// they disagreed with. `search.context` is the product an agent pastes, `retrievalScore.at`
// is the stamp the history row already documents, and `diagnose` traded prose for a
// declared shape, which is what closed the falling-between-tiers hole it exposed.
//
// The rule if it fills again: each entry PINS its exact delta, the delta is subtracted,
// anything beyond it still fails, staleness is reported, and the list may only shrink.
const DIVERGENT = Object.freeze({});

const keep = process.argv.includes('--keep');
const results = [];
let failures = 0;

function record(clause, detail, ok = true) {
  results.push({ clause, detail, ok });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${clause}: ${detail}`);
}

/// Compare an emitted object against its documented shape, the same rule the unit gate
/// uses: a required key may not be absent, an optional key may be, and no key may be
/// undocumented.
async function checkShape(method, subject, { field = null } = {}) {
  const known = DIVERGENT[method] ?? { extra: [], missing: [] };
  const shape = await documentedShape(method, field ? { field } : {});
  if (!shape) {
    // An undocumented row is REPORTED, never skipped. Declared ones are a named gap and
    // count as checked; an undeclared one is a failure, because a silent skip is how a
    // tier ends up covering nothing while appearing to cover its list.
    return record(`shape ${method}`, `NAMED GAP: ${known.why ?? 'undocumented and undeclared'}`, Boolean(known.undocumented));
  }
  if (!subject || typeof subject !== 'object') {
    return record(`shape ${method}`, 'nothing was returned to compare', false);
  }
  const emitted = Object.keys(subject).sort();
  const documented = [...shape.required, ...shape.optional];
  const missing = shape.required.filter((key) => !emitted.includes(key) && !known.missing.includes(key));
  const extra = emitted.filter((key) => !documented.includes(key) && !known.extra.includes(key));
  const stale = [
    ...known.extra.filter((key) => !emitted.includes(key)),
    ...known.missing.filter((key) => emitted.includes(key)),
  ];
  if (stale.length) return record(`shape ${method}`, `the pinned divergence is STALE, remove [${stale}]`, false);
  const pinned = known.extra.length || known.missing.length ? ` (${known.extra.length + known.missing.length} pinned)` : '';
  return record(`shape ${method}`,
    missing.length || extra.length ? `missing [${missing}] extra [${extra}]` : `${emitted.length} keys match the contract${pinned}`,
    !missing.length && !extra.length);
}

async function main() {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'daijin-acceptance-repo-'));
  const stateRoot = await mkdtemp(path.join(tmpdir(), 'daijin-acceptance-state-'));
  await rm(repoPath, { recursive: true, force: true });

  const pin = execFileSync('git', ['-C', ENGINE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(`engine acceptance at ${pin}`);
  console.log(`  repo  ${repoPath}`);
  console.log(`  state ${stateRoot}\n`);

  const fixture = await buildFixture(repoPath);
  record('fixture', `${fixture.files} files, ${fixture.commits} commits`);

  const steps = [];
  const server = createRpcServer({ stateRoot, write: (message) => { if (message.method === 'step') steps.push(message.params); } });
  try {
    await server.methods.repoAttach({ repoPath });

    // (c) a real init, streaming.
    const started = Date.now();
    const { jobId } = await server.methods.initBrain({ repoPath, mode: 'layer1' });
    await server.jobs.drain();
    const mine = steps.filter((step) => step.jobId === jobId);
    const phases = [...new Set(mine.map((step) => step.phase))];
    const errors = mine.filter((step) => step.level === 'error');
    record('(c) real init', `${((Date.now() - started) / 1000).toFixed(1)}s, ${mine.length} events, ${phases.length} phases, ${errors.length} errors`, errors.length === 0);
    // The terminal-event invariant, on a real job rather than a fake one.
    const done = mine.filter((step) => step.phase === 'done');
    record('(c) one ending', `${done.length} done event(s), last is ${mine.at(-1).phase}/${mine.at(-1).step}`,
      done.length === 1 && mine.at(-1).phase === 'done');

    // (d) real documents and real chunks, plus two live-tier shapes.
    const documents = await server.methods.documents({ repoPath });
    record('(d) documents', `${documents.length} documents`, documents.length > 0);
    const search = await server.methods.search({ repoPath, query: 'why is tax applied after the discount' });
    record('(d) search', `${search.chunks.length} chunks, tokensUsed ${search.tokensUsed}`, search.chunks.length > 0);
    await checkShape('search', search);

    const score = await server.methods.retrievalScore({ repoPath });
    record('(d) floor', `${score.caseRate.cases}, mrr ${score.mrr.toFixed(4)}, violations ${score.violations}`);
    await checkShape('retrievalScore', score);

    const history = await server.methods.scoreHistory({ repoPath });
    record('(d) history', `${history.length} row(s), origin stamped ${Boolean(history[0]?.originPath)}`, history.length > 0);
    await checkShape('scoreHistory', history[0]);

    // The gauge's own range, because a saturated floor is a property of the fixture and a
    // number without it invites reading 100 percent as proof that retrieval is perfect.
    const diagnosis = await server.methods.diagnose({ repoPath, control: true });
    await checkShape('diagnose', diagnosis);
    const range = diagnosis.discriminatingRange;
    record('(d) range', range
      ? `permuted control ${range.caseRate.control} against ${range.caseRate.candidate}, ${range.caseRate.casesOfHeadroom} cases of headroom`
      : `no range measured (${diagnosis.controlSkipped})`, Boolean(range));

    // (e) graded axes from real storage.
    const seeded = seedRubric(repoPath);
    const detail = await server.methods.examDetail({ repoPath, examId: seeded.examId });
    const canonical = ['correctness_vs_gold', 'convention_adherence', 'decision_awareness', 'reasoning_quality', 'blast_radius_awareness'];
    const ordered = detail.axes?.map((axis) => axis.name);
    record('(e) axes', detail.axes ? `${detail.axes.length} axes in canonical order: ${String(ordered) === String(canonical)}` : 'no axes',
      String(ordered) === String(canonical));
    await checkShape('examDetail', detail.attempts[0], { field: 'attempts' });
    record('(e) provenance', 'the rubric is HAND AUTHORED and seeded through the real import API; this supports "graded axes render from real storage" and NOT "the gym grades"');

    // (f) spend surfaces, engine side.
    const refused = await server.methods.gymStart({ repoPath, config: {} }).then(() => null).catch((error) => error);
    record('(f) gymStart refuses', refused ? `code ${refused.code}, gate path in the hint: ${/GATE/.test(JSON.stringify(refused.data ?? ''))}` : 'NOT REFUSED',
      refused?.code === -32050);
    const estimate = await server.methods.budgetEstimate({ repoPath, mode: 'gym' });
    record('(f) budgetEstimate', `${estimate.estimatedTokens} tokens, basis: ${estimate.basis}`);

    // The live tier is CLOSED: every method the unit gate prints as uncovered is checked
    // here, and a name in neither place would be a hole both were built to close.
    const checked = new Set(results.filter((row) => row.clause.startsWith('shape ')).map((row) => row.clause.slice(6)));
    const unchecked = LIVE_TIER.filter((method) => !checked.has(method));
    record('live tier closed', unchecked.length ? `NOT CHECKED: ${unchecked.join(', ')}` : `all ${LIVE_TIER.length} live-tier shapes checked`,
      unchecked.length === 0);
  } finally {
    await server.close();
    if (!keep) {
      await rm(repoPath, { recursive: true, force: true });
      await rm(stateRoot, { recursive: true, force: true });
    } else {
      console.log(`\nkept: ${repoPath} and ${stateRoot}`);
    }
  }

  console.log(`\n${results.length - failures} of ${results.length} checks passed at ${pin}`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`acceptance failed to run: ${error.message}`);
  process.exitCode = 1;
});
