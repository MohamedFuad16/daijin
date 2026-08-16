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
# WARNING, and it matters during a verification hold: this script restores each mutated file
# with `mv file.bak file`, leaving the CONTENT byte-identical and the MTIME new. Every file it
# touches looks freshly modified afterwards. Bound drift by content hash, never by mtime; the
# hashes of the reviewed tree are in README.md beside this script.
set -u
ENGINE=${DAIJIN_ENGINE:-/Users/mfuad16/Documents/daijin/engine}
cd "$ENGINE" || exit 1

run_mutation() {
  local name="$1" file="$2" expr="$3" tests="$4"
  cp "$file" "$file.bak"
  perl -0pi -e "$expr" "$file"
  if cmp -s "$file" "$file.bak"; then
    echo "SKIPPED (no textual change): $name"
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
  fi
  mv "$file.bak" "$file"
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

run_mutation "the scanned set stops covering the engine" \
  test/gym-spend-gate.test.js \
  "s/  const SCANNED = \['gym', 'rpc'\];/  const SCANNED = ['gym'];/" \
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
