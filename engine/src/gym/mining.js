// The exam mining funnel: mechanical first, judgment last, expensive last.
//
// Three stages, in this order for a cost reason and an integrity reason:
//
//  1. DETERMINISTIC FILTER. Drops renames, format-only, lockfile-only, docs-only, empty and
//     giant mixed commits. No model, no spend, no worktree. This stage is why the auditor
//     reads tens of commits rather than thousands.
//  2. AUDITOR SHORTLIST. The one judgment step: coherent single intent, a statement writable
//     without leaking the solution, core surfaces, tier and surface spread, held-out split.
//     It is the LLM step, so it sits behind the spend gate, and it is STUBBED here: the
//     interface is defined and refused without an injected auditor.
//  3. EXPENSIVE VALIDATION, only on the chosen. Worktree at base, discovered baseline gates
//     must pass, scope re-verified from the REAL diff rather than from the mining stats, and
//     forbidden strings armed with the gold commit.
//
// Ordering matters beyond cost: validating before selection would spend worktree time on
// commits the auditor rejects, and selecting before filtering would let a lockfile bump
// occupy a judgment slot.
//
// History access is a local git walk; a remote URL is cloned first by the caller. A huge
// history is capped by config WITH THE CAP DISPLAYED, never silently: `capped` in the return
// is a fact the TUI shows, because a silently truncated history reads as a small repository.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { supersedingRelations, applySupersedingRule } from './superseding.js';
import { assertSpendGate } from './spend-gate.js';

const execFileAsync = promisify(execFile);

/** Generated or vendored: a change made by a tool, not by a person. */
export const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Podfile\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$|\.xcodeproj\/|\.xcworkspace\/|(^|\/)(dist|build|vendor|node_modules)\//;

/** Prose: real work, and not a task a student can be graded on against gates. */
export const DOCUMENTATION = /(^|\/)(agent|docs?|decisions|lessons|workflows)(\/|$)|(^|\/)[^/]*\.(md|mdx|txt|rst)$/i;

// `style` is the conventional-commit prefix for formatting, so it belongs to the format
// rule rather than the chore rule: the format rule is the one a MEASUREMENT can overrule,
// and a real code change mislabelled `style:` should survive the funnel.
const FORMAT_SUBJECT = /format(ting)?[ -]only|whitespace[ -]only|\bprettier\b|\breformat\b|\blint[ -]?fix(es)?\b|^style(\(|:)/i;
const CHORE_SUBJECT = /^(docs|chore\(agents?\)|debug)(:|\()/i;

/**
 * Parse `git log --numstat` entries, including rename records.
 *
 * With rename detection on, a pure rename prints `0\t0\told => new` (or a brace form). Both
 * are recorded as renames rather than as zero-line edits, because "0 added, 0 deleted" is
 * also what a mode-only change looks like and the two deserve different reasons.
 */
export function parseNumstat(raw) {
  const entries = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    const renamed = file.includes(' => ');
    entries.push({
      added: added === '-' ? 0 : Number(added),
      deleted: deleted === '-' ? 0 : Number(deleted),
      binary: added === '-' && deleted === '-',
      renamed,
      file: renamed ? renameTarget(file) : file,
    });
  }
  return {
    entries,
    files: entries.map((entry) => entry.file),
    changedLines: entries.reduce((sum, entry) => sum + entry.added + entry.deleted, 0),
  };
}

function renameTarget(file) {
  // Two shapes: `old/path.js => new/path.js` and `src/{old.js => new.js}`.
  const braced = file.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replaceAll('//', '/');
  const plain = file.split(' => ');
  return plain.length === 2 ? plain[1] : file;
}

/**
 * The deterministic filter, as a pure function over one candidate.
 *
 * Returns null to keep, or the reason it is dropped. A reason string rather than a boolean
 * because the dropped list is shown: an operator who disagrees with the funnel needs to see
 * WHY a commit they expected is missing, and "filtered" answers nothing.
 *
 * `whitespaceInsensitiveChangedLines`, when the caller supplies it (git diff -w), makes the
 * format-only test a measurement instead of a subject-line guess: zero changed lines under
 * -w means the commit changed no code, whatever its subject claims.
 */
export function deterministicFilterReason({
  subject = '', entries = [], files = [], changedLines = 0, whitespaceInsensitiveChangedLines = null,
  parents = 1, maxFiles = 50, maxChangedLines = 2_500,
}) {
  if (parents !== 1) return 'not a single-parent commit';
  if (files.length === 0 || entries.length === 0) return 'empty change';
  if (entries.every((entry) => entry.renamed)) return 'rename only';
  if (whitespaceInsensitiveChangedLines === 0) return 'format only (no change under whitespace-insensitive diff)';
  if (whitespaceInsensitiveChangedLines === null && FORMAT_SUBJECT.test(subject)) return 'format only (by subject)';
  if (files.every((file) => GENERATED.test(file))) return 'generated or lockfile only';
  if (files.every((file) => DOCUMENTATION.test(file))) return 'documentation only';
  if (CHORE_SUBJECT.test(subject)) return 'documentation, agent wiring, or temporary debug';
  if (entries.every((entry) => entry.binary)) return 'binary only';
  if (files.length > maxFiles || changedLines > maxChangedLines) return 'giant mixed commit';
  return null;
}

/** Scope tier from the gold diff. Platform exam-scope.js, unchanged: the tier decides the
 *  budget, so it is computed from the diff rather than declared by anyone. */
export function scopeTier({ files, insertions }) {
  if (!Number.isInteger(files) || files < 1) throw new Error('Scope files must be a positive integer.');
  if (!Number.isInteger(insertions) || insertions < 0) throw new Error('Scope insertions must be a non-negative integer.');
  if (files > 5 || insertions > 200) return 'L';
  return files <= 2 ? 'S' : 'M';
}

export async function runGit(repo, args, { exec = execFileAsync } = {}) {
  const { stdout } = await exec('git', args, {
    cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  return stdout;
}

function parseLog(output) {
  return String(output).split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [commit, parents, date, subject, numstat = ''] = record.split('\x1f');
    return {
      commit,
      parents: String(parents).split(' ').filter(Boolean),
      date,
      subject,
      ...parseNumstat(numstat.replace(/^\n/, '')),
    };
  });
}

/**
 * Stage 1: walk the history and apply the deterministic filter.
 *
 * The cap is applied AFTER the walk order (newest first) and is reported, never silent.
 */
export async function mineCommits(repo, {
  ref = 'HEAD', cap = 2_000, exec = execFileAsync, maxFiles = 50, maxChangedLines = 2_500,
} = {}) {
  const output = await runGit(repo, [
    'log', ref, '--no-merges', '-M', '--numstat', '--format=%x1e%H%x1f%P%x1f%aI%x1f%s%x1f',
  ], { exec });
  const all = parseLog(output);
  const capped = all.length > cap;
  const walked = capped ? all.slice(0, cap) : all;
  const candidates = [];
  const dropped = [];
  for (const item of walked) {
    const reason = deterministicFilterReason({ ...item, parents: item.parents.length, maxFiles, maxChangedLines });
    if (reason) dropped.push({ ...item, reason });
    else candidates.push(item);
  }
  return {
    candidates,
    dropped,
    // Shown, never assumed: a truncated history that reads as a whole one turns "we mined
    // everything" into a claim nobody checked.
    capped: { applied: capped, limit: cap, seen: all.length, walked: walked.length },
  };
}

/**
 * Stage 2: the auditor selects the bank. THE LLM STEP, stubbed behind the spend boundary.
 *
 * The deterministic halves around it are complete: superseding relations are computed and
 * handed to the auditor as fact, and the latest-wins rule is applied to whatever comes back.
 * Only the judgment itself is missing, and it refuses rather than approximating: a heuristic
 * standing in for the auditor would produce a bank nobody authored, and "the exam committee
 * is the auditor" is an authorship rule (owner review, gold sets and exams), not a
 * convenience.
 */
export async function selectBankWithAuditor({
  candidates, auditor = null, repoPath, overlapThreshold = 0.5, auditorOverrides = [],
}, dependencies = {}) {
  const relations = supersedingRelations(candidates, { overlapThreshold });
  const { bank: eligible, layer2Material } = applySupersedingRule(candidates, relations, { overrides: auditorOverrides });
  if (!auditor) {
    const error = new Error(
      'Auditor shortlist selection is not wired yet: the exam committee is the auditor, and the deterministic '
      + 'funnel refuses to elect a bank on its own. Inject an auditor to select from the eligible candidates.',
    );
    error.code = 'AUDITOR_NOT_WIRED';
    error.eligible = eligible;
    error.relations = relations;
    error.layer2Material = layer2Material;
    throw error;
  }
  // The one paid step in the funnel, so it passes the owner gate like every other one.
  await (dependencies.assertSpendGate || assertSpendGate)('exam-mining', { repoPath, file: dependencies.gateFile });
  const selection = await auditor.selectExamBank({ candidates: eligible, relations });
  if (!Array.isArray(selection?.chosen)) throw new Error('The auditor must return { chosen: [...] }.');
  const byCommit = new Map(eligible.map((candidate) => [candidate.commit, candidate]));
  const chosen = selection.chosen.map((entry) => {
    const candidate = byCommit.get(entry.commit);
    // The auditor proposes; mechanics accept. A selection naming a commit the deterministic
    // stage dropped is refused rather than reinstated, which is the same rule the gold-set
    // pipeline runs on ("the LLM may propose, mechanics accept").
    if (!candidate) throw new Error(`The auditor selected ${entry.commit}, which is not an eligible candidate.`);
    // The auditor AUTHORS the task and title, not just the pick: the task is
    // what the student reads, so it rides the selection rather than being
    // reconstructed later from the subject line the student must not see.
    return {
      ...candidate,
      auditorRationale: entry.rationale ?? null,
      auditorTask: entry.task ?? null,
      auditorTitle: entry.title ?? null,
      heldOut: Boolean(entry.heldOut),
    };
  });
  return { chosen, relations, layer2Material, eligible };
}

/**
 * Stage 3: expensive validation, only on the chosen.
 *
 * Four checks, each of which has failed on the platform at least once:
 *  - the base commit must check out into a worktree at all;
 *  - the discovered baseline gates must PASS at base, or a candidate run cannot tell a
 *    student regression from a repository that was already broken;
 *  - the scope is re-derived from the REAL diff rather than from the mining stats, because
 *    the tier decides the budget and a wrong tier under-funds a run;
 *  - forbidden strings are armed with the gold commit and its short form, so the gold sha
 *    cannot appear in the student's output.
 */
export async function validateChosenExam({
  candidate, sourceRepo, gates, engineRoot, sandboxesRoot, gateTimeoutMs = 900_000,
}, dependencies = {}) {
  const createSandbox = dependencies.createSandbox;
  const runGateSet = dependencies.runGateSet;
  const expandGates = dependencies.expandGates;
  const diffStat = dependencies.diffStat || (async (repo, base, gold) => runGit(repo, ['diff', '--numstat', base, gold]));
  if (!createSandbox || !runGateSet || !expandGates) {
    throw new Error('validateChosenExam requires createSandbox, runGateSet, and expandGates.');
  }
  const failures = [];
  let sandbox = null;
  let baseline = [];
  try {
    sandbox = await createSandbox({
      sourceRepo, baseCommit: candidate.baseCommit, examId: candidate.examId || 'exam-candidate', sandboxesRoot,
    });
    // ZERO GATES SKIPS THE BASELINE, NOT THE WORKTREE. expandGates refuses an
    // empty list (correctly: a gate RUN over nothing is a lie), but a repo
    // with no discovered gates can still prove its base commit checks out,
    // and the caller has already warned that validation is weaker here.
    if ((gates || []).length > 0) {
      const expanded = expandGates(gates, { engineRoot, sandbox: sandbox.directory });
      baseline = await runGateSet(expanded, { cwd: sandbox.directory, timeoutMs: gateTimeoutMs });
      const notPassing = baseline.filter((gate) => gate.status !== 'pass');
      if (notPassing.length) {
        failures.push(`baseline gates do not pass at ${candidate.baseCommit}: ${notPassing.map((gate) => `${gate.id}=${gate.status}`).join(', ')}`);
      }
    }
  } catch (error) {
    failures.push(`sandbox at base failed: ${error.message}`);
  } finally {
    if (sandbox) await sandbox.cleanup();
  }

  const stat = parseNumstat(await diffStat(sourceRepo, candidate.baseCommit, candidate.goldCommit));
  const scopeFiles = stat.entries.length;
  const scopeInsertions = stat.entries.reduce((sum, entry) => sum + entry.added, 0);
  if (scopeFiles === 0) failures.push('the real diff between base and gold is empty');
  const tier = scopeFiles > 0 ? scopeTier({ files: scopeFiles, insertions: scopeInsertions }) : null;

  return {
    ok: failures.length === 0,
    failures,
    baseline,
    scope: { files: scopeFiles, insertions: scopeInsertions, tier },
    // Armed with the gold commit and its short form, exactly as the platform arms the
    // engineer run: the student must never be able to name the reference it is measured
    // against.
    forbiddenStrings: [candidate.goldCommit, String(candidate.goldCommit).slice(0, 12)],
  };
}
