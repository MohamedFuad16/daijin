#!/bin/bash
# P4 mutation evidence: each mutation must turn a green test red, and the named test must be
# the one that catches it. 35 mutations, 35 killed as of 2026-08-16 (see mutate-output.txt
# for the run this claim comes from).
#
# Usage:  bash docs/verification/p4-mutations/mutate.sh
# Expect: every line reads KILLED. A SURVIVED line is a real coverage gap, and two of them
#         were found and closed exactly that way (the quarantine-reason minimum, which only
#         the helper covered, and the step-0 disable, whose first test passed for a reason
#         unrelated to the step). Both are in the report record.
#
# TWO WARNINGS, and the second is the larger one.
#
# MTIME: this script restores each mutated file with `mv file.bak file`, leaving the CONTENT
# byte-identical and the MTIME new. Every file it touches looks freshly modified afterwards.
# Bound drift by content hash, never by mtime; the hashes of the reviewed tree are in
# README.md beside this script.
#
# CONCURRENCY (D-0032): a mutation is a WINDOW during which the source on disk is
# deliberately broken. Run against the shared tree and every other process's `npm test` can
# read that broken source, which is a 1-in-5 suite flake whose cause is invisible from the
# failure: another lane's gate fails for a defect that exists for two seconds and belongs to
# nobody. So the battery mutates a PRIVATE COPY by default and refuses the shared tree unless
# someone names the intent. The failure this prevents is not in this lane's tests; it is in
# everyone else's, which is why it went unnoticed by the author and the reviewer both.
set -u
# Resolved BEFORE any cd: the declared-count grep reads this script, and once the run moves
# into a private copy a relative $0 no longer resolves. The counter caught that itself on the
# first private-copy run, reporting a problem rather than printing a clean sweep.
SCRIPT_PATH=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
ENGINE_SOURCE=${DAIJIN_ENGINE:-/Users/mfuad16/Documents/daijin/engine}
[ -d "$ENGINE_SOURCE" ] || { echo "No engine at $ENGINE_SOURCE"; exit 1; }

if [ "${DAIJIN_MUTATE_IN_PLACE:-0}" = "1" ]; then
  # The explicit override. It exists because a private copy hides a real class of bug (a test
  # that depends on the tree's true location), so someone debugging that must be able to say
  # so out loud. It is never the default and it announces itself.
  echo "WARNING: mutating the SHARED tree at $ENGINE_SOURCE."
  echo "Every mutation is a window in which another process's npm test reads broken source."
  ENGINE="$ENGINE_SOURCE"
else
  WORKROOT=$(mktemp -d "${TMPDIR:-/tmp}/daijin-mutate-XXXXXX")
  ENGINE="$WORKROOT/engine"
  mkdir -p "$ENGINE"
  # src, test and package.json are copied; node_modules is LINKED, because the native module
  # is large and is never mutated. Node resolves it by walking up from the copy.
  cp -R "$ENGINE_SOURCE/src" "$ENGINE_SOURCE/test" "$ENGINE_SOURCE/package.json" "$ENGINE/"
  ln -s "$ENGINE_SOURCE/node_modules" "$ENGINE/node_modules"
  # adapters/ lives BESIDE the engine, not inside it, and engine sources import it by
  # relative path (src/rpc/methods.js reaches ../../../adapters/ollama/client.js). A copy of
  # src and test alone cannot resolve that, which is precisely the break init-miner found and
  # which the baseline control below caught here too. Linked as a SIBLING so the relative
  # path resolves exactly as it does in the real tree.
  ln -s "$(cd "$ENGINE_SOURCE/.." && pwd)/adapters" "$WORKROOT/adapters"
  trap 'rm -rf "$WORKROOT"' EXIT
  echo "Mutating a private copy at $ENGINE (the shared tree is never touched)."
fi

# THE CONTAINMENT CLAIM, TAKEN BY THE SCRIPT (was previously a command the operator typed
# around the invocation, which meant a run whose operator forgot it claimed nothing about
# containment while looking identical to one that proved it). An evidence check that lives in
# someone's shell history is not evidence; it is a habit.
tree_digest() {
  find "$1/src" "$1/test" -type f -name '*.js' -print0 2>/dev/null | sort -z |
    xargs -0 shasum -a 256 2>/dev/null | shasum -a 256 | cut -d" " -f1
}
SHARED_BEFORE=$(tree_digest "$ENGINE_SOURCE")

cd "$ENGINE" || exit 1

# THE BASELINE CONTROL. It runs AFTER the cd, and that placement is the whole guard: the
# first version of this block sat before it, so it tested the SHARED tree and reported green
# for any broken copy. A baseline control measuring the wrong tree is a guard that cannot
# fail, which is the defect it exists to prevent, one level up. Caught by probing it.
#
# THE BASELINE CONTROL, and it is the property that would otherwise let this whole file lie
# flawlessly. Every mutation scores KILLED when the tests fail, so a BROKEN COPY scores a
# perfect sweep having executed nothing: unresolvable imports, a missing directory, a bad
# link, all report as total success. Init-miner hit exactly that, 38 of 38 killed with no
# test ever running, and returned the guard.
#
# It is the project's own dead-gate rule applied to batteries: a gate that fails on baseline
# and candidate alike carries no signal. A battery whose baseline is red carries none either,
# and unlike a dead gate it announces the opposite.
#
# So: the UNMUTATED copy must be green before any mutation is scored, and the battery refuses
# rather than reporting kills it cannot justify. Note the copy list this guards, which is
# where init-miner's break lived: engine sources import adapters/ from OUTSIDE the engine
# root, so a copy of src and test alone is broken for anything reaching the sqlite store.
echo "Baseline control: the unmutated copy must be green before anything is scored."
if ! node --test "test/gym-*.test.js" > .baseline.log 2>&1; then
  echo "BATTERY REFUSED: the unmutated copy is NOT GREEN, so every mutation would score KILLED"
  echo "  without a single test having run. Nothing below this line would have been evidence."
  echo "  Last lines of the baseline run:"
  tail -12 .baseline.log | sed 's/^/    /'
  echo "  Most likely cause: the copy list is incomplete. Engine sources import adapters/ from"
  echo "  outside the engine root, so a tree of src and test alone cannot resolve them."
  exit 1
fi
echo "Baseline green; mutations below are measured against a working tree."

# Anything that is not a KILL: a survivor (the code is not pinned) or a skip (the expression
# matched nothing, so nothing was tested). Both are counted, and the script exits non-zero.
PROBLEMS=0
# Mutations that actually EXECUTED, compared against the declared count at the end.
EXECUTED=0

# Hash of one file, used three times per mutation: before, mutated, restored.
digest() { shasum -a 256 "$1" | cut -d" " -f1; }

run_mutation() {
  local name="$1" file="$2" expr="$3" tests="$4"
  EXECUTED=$((EXECUTED + 1))
  cp "$file" "$file.bak"
  # THE ANCHOR ASSERTION (D-0032 item 3). A perl expression that matches nothing is a silent
  # no-op, and a silent no-op looks EXACTLY like a successful run: the tests pass, the line
  # prints, and nothing tested anything. The verifier produced a minute of false evidence
  # this way while holding the F81 lie class in mind, which is the argument for counters
  # over conventions. Hashes make the claim checkable rather than inferred from a diff.
  local before mutated restored
  before=$(digest "$file")
  perl -0pi -e "$expr" "$file"
  mutated=$(digest "$file")
  if [ "$before" = "$mutated" ]; then
    # A SKIPPED mutation is NOT evidence: the expression matched nothing, so nothing was
    # tested, and the line still reads like a result at a glance. Both skips seen on
    # 2026-08-16 were caused by a refactor moving an anchor out from under an expression.
    echo "SKIPPED (anchor matched nothing, RE-ANCHOR THIS): $name"
    echo "         source unchanged at $before"
    PROBLEMS=$((PROBLEMS + 1))
    mv "$file.bak" "$file"
    return
  fi
  local out
  out=$(node --test $tests 2>&1 | grep -E "^ℹ (pass|fail) " | tr '\n' ' ')
  local failed
  failed=$(echo "$out" | sed -n 's/.*fail \([0-9]*\).*/\1/p')
  if [ "${failed:-0}" -gt 0 ]; then
    echo "KILLED   ($failed failing): $name"
  else
    echo "SURVIVED (!!): $name"
    PROBLEMS=$((PROBLEMS + 1))
  fi
  mv "$file.bak" "$file"
  # THE RESTORE ASSERTION. A mutation that does not put the file back leaves every later
  # mutation running against a tree nobody described, and the failure would be attributed to
  # whichever mutation ran next.
  restored=$(digest "$file")
  if [ "$restored" != "$before" ]; then
    echo "NOT RESTORED (!!): $name"
    echo "         expected $before, found $restored"
    PROBLEMS=$((PROBLEMS + 1))
  fi
}

run_mutation "boundary check never fires (condition inverted)" \
  src/gym/budget.js \
  's/return editsSinceBoundary >= progressEdits && checkPassedSinceBoundary !== true;/return editsSinceBoundary >= progressEdits && checkPassedSinceBoundary === true;/' \
  "test/gym-budget.test.js"

run_mutation "extension no longer requires edits since the boundary" \
  src/gym/budget.js \
  's/return editsSinceBoundary >= progressEdits && checkPassedSinceBoundary === true;\n}/return checkPassedSinceBoundary === true;\n}/' \
  "test/gym-budget.test.js"

run_mutation "extension no longer requires a passing check" \
  src/gym/budget.js \
  's/  return editsSinceBoundary >= progressEdits && checkPassedSinceBoundary === true;\n\}\n\n\/\*\*\n \* Whether/  return editsSinceBoundary >= progressEdits;\n}\n\n\/**\n * Whether/' \
  "test/gym-budget.test.js"

run_mutation "hard outer bound is not enforced at configuration time" \
  src/gym/budget.js \
  's/if \(policy\.extensionStep > 0 && worstCap/if (false \&\& policy.extensionStep > 0 \&\& worstCap/' \
  "test/gym-budget.test.js"

run_mutation "the seal keeps the unverified state instead of rolling back" \
  src/gym/student-loop.js \
  's/        discardedEdits = editsSinceVerified;\n        state = lastVerifiedState;/        discardedEdits = editsSinceVerified;/' \
  "test/gym-budget.test.js"

run_mutation "the submit rehearsal fires on every submission, not once" \
  src/gym/student-loop.js \
  's/rehearsalsUsed === 0 && workTokens <= cap/workTokens <= cap/' \
  "test/gym-budget.test.js"

run_mutation "a missing gate reads as open" \
  src/gym/spend-gate.js \
  's/    return blocked\(.No gate file\..,/    return { file, open: true, status: "open", scope: null, reason: "no gate", hint: null }; \/\/ (/' \
  "test/gym-spend-gate.test.js test/gym-cycle.test.js"

run_mutation "the automatic closure writes open instead of blocked" \
  src/gym/spend-gate.js \
  "s/    status: 'blocked',\n    reason: reason \|\|/    status: 'open',\n    reason: reason ||/" \
  "test/gym-spend-gate.test.js"

run_mutation "quarantine no longer requires a substantive reason" \
  src/gym/exams.js \
  's/quarantineReason\.length < MIN_QUARANTINE_REASON/false/' \
  "test/gym-mode-quarantine.test.js"

run_mutation "a quarantined exam may be drawn in harness-debug" \
  src/gym/exams.js \
  "s/  if \(exam\.benchmarkStatus === 'quarantined'\) \{/  if (exam.benchmarkStatus === 'quarantined' \&\& mode === 'evaluation') {/" \
  "test/gym-mode-quarantine.test.js test/gym-cycle.test.js"

run_mutation "the ledger accepts a row for a run with no applied diff" \
  src/gym/ledger.js \
  's/    if \(applied !== true\) \{/    if (false) {/' \
  "test/gym-ledger.test.js test/gym-cycle.test.js"

run_mutation "certification no longer checks the run mode" \
  src/gym/ledger.js \
  "s/    assertScoredWrite\(run\.mode, 'a certification'\);//" \
  "test/gym-ledger.test.js"

run_mutation "cycleRuns defaults to every mode instead of the scored view" \
  src/gym/ledger.js \
  's/cycleRuns\(cycleId, \{ scoredOnly = true \} = \{\}\)/cycleRuns(cycleId, { scoredOnly = false } = {})/' \
  "test/gym-ledger.test.js test/gym-cycle.test.js"

run_mutation "the drawn cohort is denominated on rows" \
  src/gym/result-files.js \
  's/  return drawn\.size >= rowPaths\.size \? drawn\.size : null;/  return rowPaths.size;/' \
  "test/gym-ledger.test.js"

run_mutation "result files count every mode, harness-debug included" \
  src/gym/result-files.js \
  "s/    if \(artifact\.mode !== 'evaluation'\) continue;//" \
  "test/gym-ledger.test.js test/gym-cycle.test.js"

run_mutation "the deterministic filter keeps lockfile-only commits" \
  src/gym/mining.js \
  "s/  if \(files\.every\(\(file\) => GENERATED\.test\(file\)\)\) return 'generated or lockfile only';//" \
  "test/gym-mining.test.js"

run_mutation "an auditor override can resurrect a reverted gold" \
  src/gym/superseding.js \
  "s/      if \(relation\.kind === 'revert'\) \{\n        throw new Error/      if (false) {\n        throw new Error/" \
  "test/gym-mining.test.js"

run_mutation "the auditor may select a commit the funnel dropped" \
  src/gym/mining.js \
  's/    if \(!candidate\) throw new Error\(`The auditor selected/    if (false) throw new Error(`The auditor selected/' \
  "test/gym-mining.test.js"

run_mutation "the prompt audit always reports complete" \
  src/gym/prompt.js \
  's/    sections\[section\.id\] = section\.markers\.every\(\(marker\) => marker\.test\(text\)\);/    sections[section.id] = true;/' \
  "test/gym-agent-files.test.js test/gym-cycle.test.js"

run_mutation "the cycle runner skips the spend gate" \
  src/gym/cycle.js \
  "s/  const gate = await \(dependencies\.assertSpendGate \|\| assertSpendGate\)\('gym-cycle', \{\n    repoPath, file: dependencies\.gateFile,\n  \}\);/  const gate = { file: null, status: 'open', reason: 'skipped' };/" \
  "test/gym-cycle.test.js"

run_mutation "ensureAgentFiles overwrites the user's edited instructions" \
  src/gym/agent-files.js \
  's/    if \(record\.installed\) continue;//' \
  "test/gym-agent-files.test.js"

run_mutation "the boundary verdict is delivered, so condemned work ships as student-owned" \
  src/gym/student-loop.js \
  "s/      await runCheck\('extension-boundary', true, false\);/      await runCheck('extension-boundary', true);/" \
  "test/gym-budget.test.js"

run_mutation "extension constants drift (step 300k, limit 6)" \
  src/gym/budget.js \
  's/  extensionStep: 400_000,\n  extensionLimit: 8,/  extensionStep: 300_000,\n  extensionLimit: 6,/' \
  "test/gym-budget.test.js test/gym-cycle.test.js"

run_mutation "step 0 no longer disables the boundary check" \
  src/gym/budget.js \
  's/  if \(!step \|\| step <= 0\) return false;\n  if \(workTokens <= tokenCap\) return false;\n  if \(granted >= limit\) return false;\n  if \(solved\) return false;/  if (workTokens <= tokenCap) return false;\n  if (granted >= limit) return false;\n  if (solved) return false;/' \
  "test/gym-budget.test.js"

run_mutation "the integration-seam-first section is dropped from the shipped student file" \
  src/gym/agents-defaults/student.md \
  's/## Integration seam first/## Some other heading/' \
  "test/gym-agent-files.test.js test/gym-cycle.test.js"

run_mutation "the gauge and the seam rule swap order in the shipped student file" \
  src/gym/agents-defaults/student.md \
  's/(## Completion gauge.*?)(## Integration seam first.*)$/$2\n$1/s' \
  "test/gym-agent-files.test.js"

# ---- gold-provenance exclusion (D-0020) -------------------------------------------------

run_mutation "the exclusion is computed but never reaches retrieval" \
  src/gym/cycle.js \
  's/      excludeDocumentIds: goldExclusion \? goldExclusion\.ids : \[\],/      excludeDocumentIds: [],/' \
  "test/gym-cycle.test.js"

run_mutation "the artifact carries no exclusion record" \
  src/gym/cycle.js \
  's/      goldExclusion: goldExclusion \? exclusionRecord\(goldExclusion, exam\) : null,/      goldExclusion: null,/' \
  "test/gym-cycle.test.js"

run_mutation "certification stops requiring an exclusion record" \
  src/gym/ledger.js \
  's/    if \(!hasExclusionRecord\(artifact\)\) \{/    if (false) {/' \
  "test/gym-ledger.test.js test/gym-cycle.test.js"

run_mutation "an absent exclusion record reads as present" \
  src/gym/provenance.js \
  's/  return Boolean\(record && record\.computed === true && Array\.isArray\(record\.ids\)\);/  return true;/' \
  "test/gym-provenance.test.js test/gym-ledger.test.js"

run_mutation "rule 2 excludes on file change rather than section change" \
  src/gym/provenance.js \
  's/    if \(afterSection !== null && beforeSection !== afterSection\) exclude\(document, .source-section-changed-by-gold.\);/    exclude(document, "source-section-changed-by-gold");/' \
  "test/gym-provenance.test.js"

run_mutation "rule 3 dropped: a document the gold commit ADDED is retrievable" \
  src/gym/provenance.js \
  "s/    if \(introduced && introduced === exam\.goldCommit\) exclude\(document, 'brain-commit-introduced-by-gold'\);//" \
  "test/gym-provenance.test.js"

run_mutation "an oversized exclusion is truncated instead of refused" \
  src/gym/provenance.js \
  's/  if \(truncated\) \{/  if (false) {/' \
  "test/gym-provenance.test.js"

run_mutation "an unknown gold commit fails OPEN instead of loud" \
  src/gym/provenance.js \
  "s/  const changed = new Set\(\(await run\(\['diff-tree', '--no-commit-id', '--name-only', '-r', exam\.goldCommit\]\)\)/  const changed = new Set(((await run(['diff-tree', '--no-commit-id', '--name-only', '-r', exam.goldCommit], { allowFailure: true })) || '')/" \
  "test/gym-provenance.test.js"

# Anchored on SCANNED.slice(1) rather than on the list's contents: the scanned set is
# DESIGNED to grow whenever a lane adds a directory, and this anchor went stale three times
# chasing it. An anchor on a value that is supposed to change is a stale anchor waiting.
run_mutation "the scanned set stops covering the engine" \
  test/gym-spend-gate.test.js \
  's/const declared = \[\.\.\.SCANNED,/const declared = [...SCANNED.slice(1),/' \
  "test/gym-spend-gate.test.js"

# ---- pre-seal check (ADR-0147) ----------------------------------------------------------

run_mutation "the pre-seal check fires without unverified edits to warn about" \
  src/gym/budget.js \
  's/  if \(editsSinceAssessedCheck <= 0\) return false;//' \
  "test/gym-budget.test.js"

run_mutation "the pre-seal check is unbounded, so it never yields to the boundary check" \
  src/gym/budget.js \
  's/  if \(deliveries >= maxDeliveries\) return false;//' \
  "test/gym-budget.test.js"

run_mutation "the pre-seal verdict is not delivered to the student" \
  src/gym/student-loop.js \
  "s/        message = 'PRE-SEAL CHECK: your budget is nearly spent/        message = null \&\& ('PRE-SEAL CHECK: your budget is nearly spent/;s/ \+ 'Fix them now: unverified edits are discarded when the budget seals\.';/ + 'Fix them now: unverified edits are discarded when the budget seals.');/" \
  "test/gym-budget.test.js"

run_mutation "pre-seal constants drift (fraction 0.5, deliveries 5)" \
  src/gym/budget.js \
  's/  preSealFraction: 0\.85,/  preSealFraction: 0.5,/;s/  preSealMaxDeliveries: 2,/  preSealMaxDeliveries: 5,/' \
  "test/gym-budget.test.js"

# ---- P7: grading, rubric import, harvest (registered at 1cdc2b8) -------------------------

run_mutation "P7 c1: an axis may be missing" \
  src/gym/grading.js \
  's/    if \(!entry\) throw new RubricRefused\(`Rubric for \$\{runId\} is missing axis \$\{axis\}\.`, \{ runId, field: axis \}\);/    if (!entry) continue;/' \
  "test/gym-grading.test.js"

run_mutation "P7 c1: a score outside 1 to 5 is accepted" \
  src/gym/grading.js \
  's/    if \(!Number\.isInteger\(score\) \|\| score < 1 \|\| score > 5\) \{/    if (false) {/' \
  "test/gym-grading.test.js"

run_mutation "P7 c2: a citation naming an untouched file is accepted" \
  src/gym/grading.js \
  's/  if \(!packet\.citableFiles\.includes\(path\)\) \{/  if (false) {/' \
  "test/gym-grading.test.js"

run_mutation "P7 c2: a withheld document may be cited" \
  src/gym/grading.js \
  's/    if \(packet\.excludedDocumentIds\.includes\(text\)\) \{/    if (false) {/' \
  "test/gym-grading.test.js"

run_mutation "P7 c3: binding to the task digest alone" \
  src/gym/grading.js \
  's/  if \(rubric\.submissionDigest !== packet\.submissionDigest\) \{/  if (false) {/' \
  "test/gym-grading.test.js"

run_mutation "P7 c4: the exam author may grade its own exam" \
  src/gym/grading.js \
  's/    if \(refusal\) throw new RubricRefused\(refusal, \{ runId, field: .author. \}\);//' \
  "test/gym-grading.test.js"

run_mutation "P7 c4: independence keyed on role, which can never fire" \
  src/gym/exams.js \
  's/key: `\$\{model\}@\$\{endpoint\}`,/key: `${role}`,/' \
  "test/gym-mode-quarantine.test.js test/gym-grading.test.js"

run_mutation "P7 c5: a measured-metric-only regression is not capped at partial" \
  src/gym/grading.js \
  's/  if \(metricOnly && proposed === .fail.\) return .partial.;//' \
  "test/gym-grading.test.js"

run_mutation "P7 c5: a run with no diff may carry a rubric" \
  src/gym/grading.js \
  's/  if \(!packet\.applied\) \{\n    throw new RubricRefused\(/  if (false) {\n    throw new RubricRefused(/' \
  "test/gym-grading.test.js"

run_mutation "P7 c6: a differing self-report is overwritten instead of preserved" \
  src/gym/grading.js \
  's/    \.\.\.\(reported && reported !== identity\.key \? \{ reportedAuthor: reported \} : \{\}\),//' \
  "test/gym-grading.test.js"

run_mutation "P7 c11: a no-write gap tag asks a question anyway" \
  src/gym/harvest.js \
  's/      if \(NO_WRITE_TAGS\.includes\(gap\.tag\)\) \{/      if (false) {/' \
  "test/gym-harvest.test.js"

run_mutation "P7 c12: a held-out run may be harvested" \
  src/gym/harvest.js \
  's/    if \(exam\?\.heldOut\) \{/    if (false) {/' \
  "test/gym-harvest.test.js"

run_mutation "P7 c13: an empty concern is accepted" \
  src/gym/harvest.js \
  's/    if \(!concern\) \{/    if (false) {/' \
  "test/gym-harvest.test.js"

run_mutation "P7 c14: a targeted answer may name a document that does not exist" \
  src/gym/harvest.js \
  's/      if \(!documentIds\.includes\(target\)\) \{/      if (false) {/' \
  "test/gym-harvest.test.js"

run_mutation "P7 c15: the citation backstop stops dropping unresolvable citations" \
  src/gym/harvest.js \
  's/      for \(const failure of citationFailures\) reasons\.push\(`citation-validation: \$\{failure\}`\);//' \
  "test/gym-harvest.test.js"

run_mutation "P7 c16: a deleted file still validates" \
  src/gym/harvest.js \
  "s/    if \(lines === null\) \{\n      failures\.push\(\`\\\$\{path\} no longer exists\`\);\n      continue;\n    \}/    if (lines === null) continue;/" \
  "test/gym-harvest.test.js"

run_mutation "P7 c10/21: a non-evaluation batch may teach the brain" \
  src/gym/harvest.js \
  "s/  if \(mode !== 'evaluation'\) \{/  if (false) {/" \
  "test/gym-harvest.test.js"

run_mutation "P7 c18: the provider scan stops seeing calls" \
  test/gym-discipline.test.js \
  's/const PROVIDER_CALL = composePattern\(PROVIDER_BRANCHES\);/const PROVIDER_CALL = new RegExp("matches_nothing_at_all");/' \
  "test/gym-discipline.test.js"

run_mutation "P7 c7: rubrics filed by arrival order instead of by runId" \
  src/gym/grading.js \
  's/    const packet = packetsByRunId\[runId\];/    const packet = Object.values(packetsByRunId)[accepted.length];/' \
  "test/gym-grading.test.js"

run_mutation "P7 c8/c9: the importer stops validating, so it stops being the boundary" \
  src/gym/grading.js \
  's/    accepted\.push\(validateRubric\(rubric, packet, \{ grader, exam: examsByRunId\[runId\] \}\)\);/    accepted.push(rubric);/' \
  "test/gym-grading.test.js"

run_mutation "P7 c17: the batch counts every proposal as accepted" \
  src/gym/harvest.js \
  's/  const accepted = proposals\.filter\(\(proposal\) => proposal\.accepted\);/  const accepted = proposals;/' \
  "test/gym-harvest.test.js"

run_mutation "P7 c19: a stale exemption hides a file that no longer exists" \
  test/gym-discipline.test.js \
  "s/const CLAUSE_19_EXEMPT = Object\.freeze\(\[/const CLAUSE_19_EXEMPT = Object.freeze([\n  { path: 'gym-deleted-long-ago.test.js', reason: 'a stale exemption nobody removed when the file went away, which is a hole' },/" \
  "test/gym-discipline.test.js"

# ---- verifier findings 77 and 78 ---------------------------------------------------------

run_mutation "F77: identity stops casefolding the model, so capitalization evades the refusal" \
  src/gym/exams.js \
  's/  return String\(model\)\.trim\(\)\.toLowerCase\(\);/  return String(model).trim();/' \
  "test/gym-mode-quarantine.test.js"

run_mutation "F77: identity stops stripping the trailing slash, so a slash evades the refusal" \
  src/gym/exams.js \
  "s/  const text = String\(endpoint\)\.trim\(\)\.replace\(\/\\\\\/\+\\\$\/, ''\) \|\| 'default';/  const text = String(endpoint).trim() || 'default';/" \
  "test/gym-mode-quarantine.test.js"

run_mutation "F77: normalization flattens the URL path too, conflating real deployments" \
  src/gym/exams.js \
  's/url\.pathname\.replace/url.pathname.toLowerCase().replace/' \
  "test/gym-mode-quarantine.test.js"

run_mutation "F78: the router branch is deleted from the provider scan" \
  test/gym-discipline.test.js \
  "s/  \['router-key', 'OPENROUTER'\],//" \
  "test/gym-discipline.test.js"

run_mutation "F78: the lower-case key branch is deleted from the provider scan" \
  test/gym-discipline.test.js \
  "s/  \['lower-key', 'api_key'\],//" \
  "test/gym-discipline.test.js"


# ---- rubric persistence (joint round with the extractor) ---------------------------------

run_mutation "rubric import is not a transaction, so a bad batch writes half a cohort" \
  src/gym/ledger.js \
  's/    const write = this\.database\.transaction\(\(\) => \{/    const write = ((fn) => fn)(() => {/' \
  "test/gym-ledger.test.js"

run_mutation "the rubric store stops checking the run exists" \
  src/gym/ledger.js \
  's/        if \(!run\) \{\n          \/\/ Named before the foreign key fires/        if (false) {\n          \/\/ Named before the foreign key fires/' \
  "test/gym-ledger.test.js"

run_mutation "a harness-debug cohort may be graded into the record" \
  src/gym/ledger.js \
  's/    if \(!isGradableRun\(mode\)\) \{/    if (false) {/' \
  "test/gym-ledger.test.js"

run_mutation "a rubric may cross modes into another batch" \
  src/gym/ledger.js \
  's/        if \(run\.mode !== mode\) \{/        if (false) {/' \
  "test/gym-ledger.test.js"

run_mutation "the one-rubric-per-run index is dropped" \
  src/gym/ledger.js \
  's/      CREATE UNIQUE INDEX IF NOT EXISTS rubric_run ON rubric\(run_id\);/      CREATE INDEX IF NOT EXISTS rubric_run ON rubric(run_id);/' \
  "test/gym-ledger.test.js"

run_mutation "attemptsForExam stops attaching rubrics, so graded reads as ungraded" \
  src/gym/ledger.js \
  's/    return runs\.map\(\(run\) => \(\{ \.\.\.run, rubric: rubrics\.get\(run\.id\) \?\? null \}\)\);/    return runs.map((run) => ({ ...run, rubric: null }));/' \
  "test/gym-ledger.test.js"

# ---- certification axes derived from the rubric (extractor handover defect) --------------

run_mutation "certify takes axes from its caller again, so {} can reach the strictest record" \
  src/gym/ledger.js \
  's/  certify\(\{ runId, verdict = null, harness = \{\}, artifact = null \}\) \{/  certify({ runId, verdict = null, axes = {}, harness = {}, artifact = null }) {/;s/      JSON.stringify\(rubric.axes\), JSON.stringify\(harness\),/      JSON.stringify(axes), JSON.stringify(harness),/' \
  "test/gym-ledger.test.js"

run_mutation "certify stops requiring a rubric, so a pass claim has nothing behind it" \
  src/gym/ledger.js \
  's/    if \(!rubric\) \{/    if (false) {/' \
  "test/gym-ledger.test.js"

run_mutation "certify stops checking the caller assertion against the stored verdict" \
  src/gym/ledger.js \
  's/    if \(verdict !== null \&\& verdict !== rubric.verdict\) \{/    if (false) {/' \
  "test/gym-ledger.test.js"

run_mutation "the certification stops naming the rubric it snapshotted" \
  src/gym/ledger.js \
  's/      runId, run.exam_id, rubric.id, new Date\(\).toISOString\(\), rubric.verdict,/      runId, run.exam_id, null, new Date().toISOString(), rubric.verdict,/' \
  "test/gym-ledger.test.js"

run_mutation "F81: the wire safety net stops rendering an empty rubric as ungraded" \
  src/rpc/methods.js \
  's/  return entries\.every\(Boolean\) \? entries : null;/  return entries.filter(Boolean);/' \
  "test/gym-ledger.test.js"

# ---- summary. NOTHING MAY BE APPENDED BELOW THIS LINE ------------------------------------
#
# Six mutations were once appended AFTER this block and never ran, while the script still
# printed "All mutations killed." That is the same defect the skip counter exists for, in a
# new costume: an instrument reporting a result for a check that did not execute. The count
# check below is the structural fix, since a comment asking people not to append is a habit.

# FINDING 81: the class is [[:space:]]* rather than column zero. An INDENTED run_mutation,
# inside a conditional or a loop, would be invisible to the DECLARED side while still
# incrementing EXECUTED, so the comparison would read as balanced while the count was wrong.
# Zero instances today; the point is that the next person's ordinary edit must not silently
# disarm the counter that exists to catch silent disarming.
SHARED_AFTER=$(tree_digest "$ENGINE_SOURCE")
echo
if [ "$SHARED_BEFORE" = "$SHARED_AFTER" ]; then
  echo "shared tree unchanged: $SHARED_BEFORE"
else
  echo "SHARED TREE CHANGED (!!): $SHARED_BEFORE -> $SHARED_AFTER"
  echo "  A mutation did not restore, or something else wrote to the tree during the run."
  PROBLEMS=$((PROBLEMS + 1))
fi
# BOUND, stated because this check would otherwise be over-read: comparing the ends cannot
# see a window fully contained inside the run. The private copy is the containment; this
# catches the case where that structure is broken.

DECLARED=$(grep -cE '^[[:space:]]*run_mutation ' "$SCRIPT_PATH")
echo
echo "declared: $DECLARED   executed: $EXECUTED"
if [ "$DECLARED" -ne "$EXECUTED" ]; then
  echo "MISMATCH: $((DECLARED - EXECUTED)) declared mutation(s) never ran; something after an exit, or an early return."
  PROBLEMS=$((PROBLEMS + 1))
fi
if [ "$PROBLEMS" -eq 0 ]; then
  echo "All mutations killed."
else
  echo "$PROBLEMS problem(s): survived, skipped, or never executed. None of the three is evidence."
fi
exit $([ "$PROBLEMS" -eq 0 ] && echo 0 || echo 1)
