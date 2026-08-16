# P1 parity attack protocol

Written 2026-08-16 by the verifier, BEFORE the extractor reported and before any
number was seen. Pre-registration is the point: the acceptance stated here cannot
drift after the fact, and any later change to this file is dated in place with
the original text left standing.

Report only. This file is a verifier artifact. Nothing in it authorizes a fix,
and no step below writes to the platform repository or to engine source.

## 1. The acceptance being attacked

Quoted verbatim from `docs/daijin-build-plan.md:90-97`, the corrected P1 phase
check, which is the sentence the extractor builds to and this protocol attacks:

> the check, stated so it can fail: exact caseRate equality with the committed
> baseline, 0.9117647058823529 = 31 of 34, plus a clean per-case output diff, at
> k=8, with the platform's own retrieval-score run as the executed baseline
> control, not quoted from the baseline file. Parity means metric and per-case
> parity, not source-byte identity (D-0006). Addendum, same day: the engine
> suite must be green at the moment of the P1 report; a parity number measured
> over a red suite is not certifiable.

Verified present in the plan at 02:52, addendum included.

Reference values, from `platform/rag/retrieval-baseline.json`:

| field | value |
| --- | --- |
| caseRate | 0.9117647058823529 |
| caseRateCases | 31 of 34 |
| violations | 0 (ENFORCED) |
| mrr | 0.6588935574229692 (recorded for movement, never floored) |
| cases | 34 |
| k | 8 |
| corpusDocuments | 538 |
| measuredAt | 2026-08-14 |
| measuredCommit | 7917fab |

## 2. Prerequisites, captured before anything runs

Checked 2026-08-16 02:43, all present:

- Ollama reachable, `{"version":"0.32.1"}` from `http://localhost:11434/api/version`.
- `DATABASE_URL` configured in the platform's `.env.local` (key presence confirmed
  by count; no value was read, and none will be).
- Embedding identity keys present: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`,
  `EMBEDDING_MODEL_DIGEST`, `EMBEDDING_DIM`, `OLLAMA_BASE_URL`.

If any prerequisite is absent at attack time the verdict is INCONCLUSIVE, never
PASS. A parity claim that cannot be re-derived is not a verified claim.

Capture and record before step 3:

```
cd <platform>
git rev-parse HEAD
git status --porcelain | wc -l
psql "$DATABASE_URL" -c "SELECT (SELECT count(*) FROM document) AS documents, (SELECT count(*) FROM chunk) AS chunks;"
curl -s http://localhost:11434/api/version
shasum -a 256 ai-brain/projects/internship-portal/retrieval-goldset.yaml
```

The document count matters. The baseline was measured over **538** documents;
the extraction report measured **557** on 2026-08-15
(`docs/extraction-report.md:22`). See the drift contingency in section 6.

## 3. Commands

### 3a. Control, the platform's own harness

Run from the platform repo. Zero spend: local Ollama embedding plus local
Postgres, no provider call.

```
cd /Users/mfuad16/Documents/Codex/2026-07-21/hand-ai-brain-build-instructions-md/ai-brain-platform
date +%s > /tmp/ctl.start
npm run retrieval-score -- --json --label=verifier-control-1 > <scratch>/control-1.json
date +%s > /tmp/ctl.end
npm run retrieval-score -- --json --label=verifier-control-2 > <scratch>/control-2.json
```

Two runs, deliberately. Determinism is established before comparison, not
assumed (section 5a).

**Flags that must NOT be passed.** `--shipped` marks a run as a shipped
configuration and plots it into the reported trend
(`platform/rag/retrieval-score.js:44-49`); a verifier's control run is a
measurement, not a shipped configuration, and marking it would invent history.
This is the same quarantine discipline the exam ledger applies to harness-debug
runs. `--enforce` is unnecessary for a control and is not passed.

### 3b. Candidate, the ported harness

Run from the daijin repo, against the same corpus, whatever the extractor's
entry point turns out to be (`engine/package.json` currently declares
`retrieval-score` and `retrieval-score:platform`):

```
cd /Users/mfuad16/Documents/daijin/engine
npm run retrieval-score:platform -- --json > <scratch>/candidate-1.json
npm run retrieval-score:platform -- --json > <scratch>/candidate-2.json
```

If the ported harness offers no JSON mode, that is itself a finding: a parity
claim whose output cannot be diffed mechanically is a claim that must be taken
on trust.

## 4. Pre-registered PASS and FAIL

Stated before any number is seen. "Close enough" is FAIL, by construction.

**PASS requires ALL of the following.**

0. The engine suite is GREEN at the moment of the P1 report, checked first,
   before any parity command runs. This is now part of the plan's acceptance,
   not only this protocol's gate. `cd engine && npm test` must report zero
   failures and a non-zero test count, and the count and timestamp are recorded
   with the result because the suite has been a moving target all session. A
   red suite makes the attack moot: stop, report, do not measure.
1. The control was EXECUTED this session, evidenced per section 5.
2. Control run 1 and control run 2 are identical on every scored field.
3. `caseRate` is equal between candidate and control as an EXACT value. The
   comparison is on the full double, not a rounded percentage. Equivalently:
   identical passing-case count over identical total.
4. The passing case SET is identical, compared by case id. Same count with a
   different membership is FAIL, not a rounding artifact.
5. `violations` is 0 on both.
6. `cases` is 34 on both.
7. k is 8 on both, echoed by each run's own output rather than assumed.
8. Per-case diff is clean after sorting both sides by case id: same
   `complete` verdict, same `reciprocalRank`, same `standingAssisted` flag, and
   the same violation list per case.

   **Amendment 2026-08-16, from a store-adapter finding relayed by the leader.**
   Never diff two score records as whole files. `record.at` is a fresh ISO
   timestamp and `record.label` is caller-supplied, so a literal file diff is
   guaranteed non-empty regardless of parity and every run would fail for a
   reason unrelated to retrieval. Compare `record.summary` field by field, and
   `record.results` indexed by case id; `at` and `label` are expected to differ
   and are excluded by design.

   Second half of the same record, also from the adapter, WITHDRAWING the
   broader form of its own finding: `src/init/compare-runs.js` already does
   exactly this, indexing results by case id (`:18`) against a fixed field list
   (`:13`) and comparing a fixed summary field list (`:50-51`) that never
   includes `at` or `label`. Verified independently before recording. So the
   gap was only ever in a literal file diff, which this protocol does not ask
   for. The amendment stands anyway because it pins wording that was previously
   only implied.

   Note while reading that tool: its per-case `FIELDS` list omits `misses` and
   `violations`, so a violation moving between cases while the total holds
   would not surface in a `compare-runs` diff. The attack below compares both
   fields directly and is therefore slightly stricter than the tool.
9. The embedding identity (provider, model, digest, dimension) is identical
   across control and candidate.
10. The mutation probe of section 5b moves the candidate's number.

**FAIL on any of the following.**

- `caseRate` differs at any decimal place, including a difference that rounds to
  the same displayed percentage.
- The passing case set differs, even at equal count.
- `violations` > 0.
- k is not 8, or a run does not state its own k.
- The per-case diff is non-empty after sorting.
- Embedding identity differs between the two runs.
- The mutation probe does not move the candidate's number (section 5b).
- The candidate reads `retrieval-baseline.json` to populate any reported value
  rather than to compare against a floor (section 6a).

**INCONCLUSIVE, never PASS**, if a prerequisite is missing, if the control
cannot be executed, or if the two control runs disagree.

`mrr` is compared and REPORTED as movement, never as a pass condition. The
baseline file is explicit that flooring MRR is wrong: in the 2026-08-09
regression case rate fell while MRR rose, and MRR is the number a pin can buy
directly. `rankedOnlyCaseRate` is likewise reported, never floored; its
denominator is too thin to gate on.

## 5. Proving the control was executed, not quoted

### 5a. Process evidence

- **Wall clock.** A real run embeds 34 queries through Ollama and queries
  Postgres per case. It takes seconds. A quoted number returns in
  milliseconds. Record start and end timestamps around each run.
- **Written artifact.** Each run writes
  `logs/retrieval-score/<iso-timestamp>.json` in the repo it runs from
  (`platform/rag/retrieval-score.js:215-217`). Before the attack, list that
  directory; after, list it again. A fresh file with a fresh timestamp is
  positive evidence of execution, and its absence is evidence against.

  Leader ruling 2026-08-16, recorded so this protocol is executable without
  re-reading messages: the control's log artifact STAYS in the platform's
  `logs/retrieval-score/`, and its path and timestamp are cited in the parity
  report. The read-only convention protects platform SOURCE from mutation; a
  timestamped log written by the platform's own instrument into its own log
  directory is that instrument behaving normally. `--shipped` is still never
  passed, so no trend history is invented.
- **Ollama was consulted.** The retrieval path resolves the served embedder
  identity and refuses a digest mismatch before scoring
  (`resolveServedIdentity`, `platform/ingest/embed.js:145-152`;
  `assertRetrievalIdentity`, `platform/rag/retrieve.js:82-87`). A run that
  completes has therefore contacted Ollama. Cross-check by stopping nothing and
  simply confirming the identity fields appear in the output.
- **Gold ids were validated against the live index.** The scorer checks every id
  against the index before scoring and fails loudly on a mistyped id
  (`retrieval-score.js:15-17`). A run reporting 34 cases has touched the index.

### 5b. The mutation probe, the decisive test

Process evidence can be faked; a number that will not move cannot be. In a
SCRATCH COPY of the gold set (never the platform's file), corrupt one
`must_return` id in a case that currently passes, point the candidate harness at
the copy, and re-run.

- If `caseRate` drops by exactly one case, the candidate is COMPUTING.
- If `caseRate` is unchanged, the candidate is QUOTING, and the parity claim is
  void regardless of how well the numbers matched.

Run the same probe against the control so the probe itself is calibrated. This
is the project's own mutation-test discipline (`docs/daijin-build-plan.md:167-169`,
no gate ships without a demonstrated failure mode) applied to the parity claim.

## 6. Failure modes to probe, each with its check

### 6a. The harness reads the baseline file instead of computing

`grep -n "retrieval-baseline" <ported harness>` and read every hit. The baseline
may be read ONLY inside the floor comparison (the equivalent of
`floorBreaches(summary, baseline)`), never to populate `summary`. Any path where
a reported value originates in the file is FAIL. The mutation probe (5b) is the
independent confirmation.

### 6b. Per-case output reordered to mask a diff

Compare twice: as an ordered list, and as a set keyed by case id. Sort both
sides by case id before diffing. Report BOTH results. A clean set diff with a
dirty ordered diff means the ranking order moved even though membership held,
which is a real finding for P2's A/B even if P1 passes.

### 6c. k silently defaulted differently

`k` defaults to 8 in three independent places
(`retrieval-score.js:42, 178, 222`) and in `retrieve()` itself
(`retrieve.js:44`). The candidate must echo its own k. Additionally run the
candidate once with an explicit `--k=8` and once with the default and require
identical output; a difference means the port's default is not 8. Note that k
also drives the ANN pool: `semanticCandidateLimit(8) = max(96, 256) = 256`
(`retrieve.js:113-115`), so a wrong k changes the candidate pool, not just the
cutoff.

### 6d. Embedder identity mismatch between runs

Compare provider, model, digest and dimension across control and candidate. A
different embedder makes every cosine number different, and every threshold in
`rank.js` (0.35 semantic, 0.35 pin floor, 0.55 reserved-slot floor, 0.3
max-support) sits on bge-m3's distribution. Equal case rates under different
embedders would be coincidence, not parity.

### 6e. Standing pins inside versus outside the budget

Standing units ride OUTSIDE the token budget by design
(`platform/rag/standing.js:16-19`; the context footer states it explicitly,
`context.js`). Three checks:

- The reported `standingAssistedCases` must match between runs.
- `rankedOnlyCaseRate` must match. If standing units were pulled inside the
  budget they would displace ranked material, and this is the number that moves
  first.
- The standing id set must match, and must all carry the `global.` prefix
  (`standing.js:29`). A different prefix default silently pins the whole corpus
  (verifier finding 58).

### 6f. Corpus drift, the contingency that must be pre-registered

The baseline was measured over 538 documents on 2026-08-14; the corpus measured
557 on 2026-08-15. If the corpus has grown, **the control may not reproduce
0.9117647058823529 either**, for entirely legitimate reasons.

Pre-registered ruling, decided now rather than after seeing numbers:

- If the CONTROL reproduces the committed baseline exactly, the acceptance is
  three-way equality: candidate = control = baseline file.
- If the CONTROL does NOT reproduce the committed baseline, the acceptance
  becomes candidate = control, measured on the same corpus in the same session,
  and the divergence between control and the committed baseline is reported as a
  separate finding against the platform, not against the extractor. The
  extractor cannot be failed for a corpus that moved underneath the baseline.
- In either case the per-case diff requirement is unchanged.

### 6g. Filter drift

The draft exclusion and the default evaluation-type exclusion are both
load-bearing and both unconditional in the platform
(`retrieve.js:27, 60, 93`). If either is off in the port, the candidate pool is
larger and results shift. Check that the candidate's own filters are exercised:
if the candidate returns evaluation-type documents in an unfiltered query, the
default exclusion is missing.

### 6h. Gold set identity

Both sides must score the same 34 cases. Compare the sha256 of the gold set each
side reads, and compare the case id list. A port that ships its own copy of the
gold set has introduced a second source of truth.

### 6i. Non-determinism

Any tie-break that falls back to insertion order rather than an explicit key
will produce run-to-run drift. The platform breaks ties by cosine then chunk id
(`retrieve.js:157-159`) precisely so identical input yields identical output.
Two identical control runs establish the baseline for this; two identical
candidate runs are also required.

## 7. Reporting

Numbered findings, severity, file and line, claim, evidence, owner, exactly as
in reports 1 through 4. The verdict line states PASS, FAIL, or INCONCLUSIVE
against section 4 and names which numbered condition decided it. Every
substantive number ships with a pasteable command that re-derives it. Negative
and inverted results are reported as prominently as confirmations.

---

## Appendix: report 3 closure verdicts, re-checked against current bytes

Checked 2026-08-16 02:43. Artifact hashes at check time: store.d.ts
`c80837ddade6db9bcb78949e976f5955`, methods.md `52467d9c84f077995d91ba369b121d24`,
decisions.md `fe7c16f16273b501155fb50f27f4cdcd`, state.md
`46472e85d88ebeea882a26193ce98019`, ci.yml `52a7e6ca22edef28474936f8e7838350`,
daijin-build-plan.md `5289cf1ff954b0b01475abf420859b66`.

- **Finding 44, per-source relationship replace: CLOSED.** `store.d.ts:156`
  is now `replaceAllRelationships(rows)`, a global rebuild, with the reasoning
  quoted in the contract comment. D-0011 records it.
- **Finding 45, no delete path: CLOSED.** `deleteDocuments(ids)` at
  `store.d.ts:161` is the deletedIds path, `pruneDocumentsExcept(keepIds)` at
  `:169` is the full-rebuild path, both inside one transaction per D-0009.
- **Finding 46, caller-invented chunk ids: CLOSED.** `ChunkWriteRow` is
  `{ ordinal, content, vector }`, matching what `chunkDocument` emits; ids are
  store-assigned.
- **Finding 47, missing contentHash: CLOSED.** `DocumentRow.contentHash` at
  `store.d.ts:81`.
- **Finding 48, hygiene gate silently dead on grep failure: CLOSED, verified by
  a three-case control.** `.github/workflows/ci.yml:32-45` now captures grep's
  exit status explicitly. Under a `-P`-capable grep: clean tree exits 0, planted
  U+2014 exits 1. Under a grep without `-P` (BSD grep via bash on this machine):
  all cases exit 1 with "the gate cannot report coverage", so the gate now fails
  closed instead of certifying what it cannot see. Scope note: CI runs GNU grep
  on ubuntu-latest, which supports `-P`; the discrimination half of this test was
  run through ugrep 7.5.0 as the `-P`-capable stand-in, so the gate LOGIC is
  verified and the ubuntu binary itself is inferred, not verified.
- **Finding 49, collapsed exam status axes: CLOSED.** `methods.md:50` carries
  `status`, `benchmarkStatus`, `quarantineReason` and `heldOut` separately.
- **Finding 51, D-0007 miscount: CLOSED.** `agent/decisions.md` D-0007 carries a
  dated in-place correction recording ten gaps closed in v2 and the eleventh
  closed in v3, with the original sentence left standing.
- **Finding 53, exam and ledger scope: CLOSED.** `store.d.ts:36-37` declares
  exam persistence, project registry rows and the ingest_run ledger out of the
  Store interface.
- **Q6 precision note: CLOSED.** `agent/state.md:15-16, 58-60` records that the
  CI skeleton was the P0 acceptance item and `.gitignore` was hygiene.
- **Finding 43, P1 acceptance sentence: CLOSED.** `docs/daijin-build-plan.md:90-97`
  now carries the falsifiable sentence quoted in section 1 above.

Still open at this check, all from report 4 and all crossing in flight:

- **Finding 55, `pruneDocumentsExcept` has no project scope** (`store.d.ts:169`),
  while `store.d.ts` states the pgvector impl runs against the multi-project
  platform database. Unchanged. Data-loss hazard if a write path is ever wired
  against that database.
- **Finding 56, `hello` still returns `contractVersion: "2"`** in the v3 document
  (`methods.md:18`).
- **Finding 57, `node --test "test/*.test.js"` does not recurse and exits 0 when
  the glob matches nothing** (`engine/package.json:8`).
- **Findings 58 and 59, `standingDocuments` prefix default unstated**
  (`store.d.ts:134`) and the draft invariant widened to "any read"
  (`store.d.ts:27`) against a `standing.js` query that has no draft predicate.
  Finding 58 is also a probe in section 6e above.

### Re-verification 2026-08-16 02:47

All four items above are now CLOSED in bytes, verified individually:

- **55 CLOSED.** `pruneDocumentsExcept(keepIds, project)` at `store.d.ts:192`
  with project required, and the standing safety policy at `:191`: parity runs
  read-only, write-path conformance against fixture databases only (D-0012).
- **56 CLOSED.** `contractVersion: "3"` at `methods.md:18`, with the rule that it
  tracks the document version and is bumped in the same edit as the title.
- **57 CLOSED, verified by re-running my own control.** The script is now
  `node --test "test/*.test.js" "test/**/*.test.js"`, and a tree whose only test
  is `test/sub/deep.test.js` collects 1 test and passes, where the old glob
  collected 0 and exited 0. CI also gained a zero-test guard (`ci.yml:15-18`,
  failing the job when the run reports `tests 0`), which closes the vacuous-green
  class rather than this one instance of it.
- **58 CLOSED.** Prefix documented as defaulting to `'global.'` at
  `store.d.ts:140`.
- **59 CLOSED.** The draft invariant is narrowed to candidate queries plus
  `allDocuments` and explicitly exempts `standingDocuments`, citing
  `standing.js:33-39` (`store.d.ts:26-30`).
- **60 and 61 CLOSED.** `replaceAllRelationships` global at `:166`,
  `deleteDocuments` removing edges where the document is source OR destination
  at `:171-172`, `contentHash` at `:86`.

Section 6e's standing-prefix probe stays in the protocol regardless: the contract
now states the default, and the probe is what confirms the implementation honors
it.

Note for the attack: at this same check the engine suite was RED and moving
(130 tests with 3 failures, then 176 with 5 failures seconds later, the extractor
being mid-write). One failure, `the lexical arm selects cosine as well as the
text rank`, asserts exactly the finding-37 semantics that section 6 depends on.
Parity cannot be attacked against a red suite; establishing green is a
precondition of step 3b.
