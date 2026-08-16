# Daijin build state (authoritative)

## 2026-08-16 11:58 - Committed and pushed; limit pause; cross-encoder ordered

Owner granted full commit/push/autonomous authority. Initial commit b1844a0
pushed to the new private remote MohamedFuad16/daijin: the evidence
substrate exists, verdicts pin commits from here (supersedes the
hash-manifest half of D-0024; manifests remain for uncommitted mid-work
claims). The entire team hit the session limit again (reset 12:10 JST);
the leader's local one-shot resume job fires 12:11 and re-dispatches every
lane from this file. NEW WORK ORDERED at resume, D-0025: a cross-encoder
rerank stage, verified absent today, to be built LOCAL-ONLY, off by
default, absent from the parity path, and measured per D-0017 before it
can become a default; extractor implements, init-miner extends the A/B,
verifier attacks the number. Backend choice (Ollama rerank support vs
local llama-server vs in-process ONNX) requires docs verification first,
never a guess.

Resume queue snapshot: tui-builder owes the FREEZE declaration (manifest
plus the 221-to-160-to-232 suite explanation), then polish; verifier owes
the P6 attack (in flight when the limit hit) then P5 on the freeze; the
extractor owes P3-methods wiring, then the socket, then D-0025;
init-miner owes workaround cleanup then the LIVE portfolio-mine run;
gym-porter owes the gold-provenance exclusion, pre-seal check,
RPC-SHAPES.md; adapter holds for the P6 attack.

## 2026-08-16 08:48 - P5 attack deferred to a freeze window; P6 attack begins

The verifier correctly refused to issue a P5 verdict against a tree that
moved three times in its eleven-minute window (the leader's scheduling
error: the attack was sent in while tui-builder executed an ordered
queue). Standing protocol formalized: A PHASE ATTACK RUNS ONLY INSIDE A
DECLARED HOLD WINDOW; the worker declares a freeze with a D-0024 hash
manifest, the verifier pins the verdict to the manifest. What the
provisional pass already established, timestamped: 30 of 30 methods
CALLED (findings 68 and 69 closed with a no-stale-stub gate), spend
paths correct both directions with gate-before-consent, real keyboard
and mouse, dash sweep clean, and the copy gate proven LIVE by a planted
dash reaching composited output and firing. The verifier also caught the
initBrain mock-refusal defect mid-attack (true when measured, forbidden
by the contract's own sentence) and verified its fix landing four
minutes later: the mock-fidelity rule visibly working. tui-builder owes
the freeze report including the 221-to-160 suite-composition
explanation. The verifier proceeds to the P6 attack now (the adapter's
tree is quiet), P5 pins on the freeze signal, and the polish pass begins
after the P5 verdict.

## 2026-08-16 08:42 - Finding 73 CLOSED on evidence: 4/4 plants, by the leader's own run

The widened scanner landed and the leader ran the verifier's instrument
directly (docs/verification/p4-mutations/gate-scanner-plants.mjs): 4/4
plants caught, innocent control clean, ACCEPTANCE MET, exit 0. gym-porter's
own 12-plant instrument (gate-plants.mjs) also passes with 4 controls
clean. The design is the burden-of-proof inversion: owner writes are
GUILTY UNLESS PROVABLY BLOCKED (an adjacent blocked literal is the proof;
nothing about the write target is consulted, so concatenation, templates
and variables become uninteresting), foreign modules that write files and
name the gate need an explicit allowlist entry, and the single entry
(rpc/methods.js) buys distance, never permission. gym-porter's own words:
the arbiter was right and my argument was wrong in a specific, instructive
way; both design errors were the same mistake, reasoning about the write
TARGET. Bonus finds: the widened scanner flagged ITSELF (comments read as
code), and the proper comment tokenizer FAILED SILENTLY IN THE WRONG
DIRECTION (regex character classes desynchronize quote tracking, which
can swallow real code); shipped the line-based stripper that costs false
positives and never misses, with flagging commented-out gate-opening code
recorded as a feature.

The ran-versus-stated question resolves benignly: the earlier report's
mutant-catch results were real runs against ITS OWN mutant shapes (its
aliased mutant used the helper-bound form the OLD rule already caught);
the verifier's plants were different shapes, and this round's report
explicitly disclaimed the reconstruction (I am not claiming the
verifier's result; I am claiming mine). Remaining from the round: the
empty-allowlist refactor (extractor swaps the direct gymSpendGatePath
import for a gym-owned status read so methods.js never names the gate),
the scanned-set enforcement test, the README hash refresh, then
gym-porter's queue: gold-provenance exclusion, pre-seal check,
RPC-SHAPES.md. Suite 393/393 at 23:42Z.

## 2026-08-16 08:36 (P3 pipeline reported) - Built, mutation-verified, live run authorized

init-miner delivered the P3 pipeline: twelve modules, 97 tests, 20
mutations killed with one honest survival worth the record (M11: two
refusals sharing an error class and code, so deleting the gate check left
the test green; rewritten so the closed gate is the only thing left to
refuse on). Two self-found defects fixed: retired gold cases were being
written into the file the scorer loads (a retired case would score as a
permanent miss forever; now split into goldset.yaml active and
goldset-retired.yaml append-only), and the staleness gate was structurally
unable to fire (re-mining regenerates every case from the current tree, so
nothing it produces can be stale; the previous set is now carried forward
keyed on provenance plus query, which gives the gate something to judge).
Fixture measurement reported as mechanism-check only (hash embedder, 0.36
floor measures the hash, honestly labeled). Rulings: live run is
recorded-only, never a test-live gate (a number pinned from a moving repo
is how a dead gate gets born); the 25-of-64 window-missed architecture
cards recorded now, judged after the real embedder speaks; stable per-case
key format change approved now, before user data exists; GoldCase gains
required why (the harness is the measured instrument; the contract moved
to it); the no-lexical-overlap-filter assumption is affirmed ON THE RECORD
BEFORE the live number exists: a filter would select for cases retrieval
already wins, and lower-and-honest is the test working. The live
constants-generalization run on portfolio-mine (81d453a at designation)
is AUTHORIZED with the real bge-m3 embedder; the report lands whatever
number appears. Routed: environment-threading fix to the extractor, the
stray 15MB mirror cleanup to the adapter.

## 2026-08-16 08:33 - P4 record closed; scanner arbiter decided; N=2 blocker

1. The verifier re-derived the entire P4 verdict on the stabilized tree
(fourteen of fifteen gym sources had moved, all bounded by mtime): every
certified behavior re-derives identically, 76/76 gym, 375/375 full, the
verdict stands with its scope pinned (sources at or before 08:30:53,
stable through 08:33:06). New verdict discipline adopted: verdicts pin
mtimes of files in scope at verdict time, so a moving tree can never
require a second pass again.

2. THE ARBITER DECIDED: finding 73 reproduces byte-identically against
gym-porter's UPDATED scanner (1 of 4 plants caught; the third alias rule
did not close the verifier's plants). Per D-0023 the allowlist widening
goes in regardless of the design argument. The verifier's additions are
binding guidance: extend the plant set (four is ten minutes of thought,
not a bound), and the innocent-writer control matters as much as the
plants, since a widened rule firing on writeFile(resultPath) would be
worse than the narrow one. attack.mjs is the acceptance instrument.
[CORRECTION 2026-08-16 08:34, verifier evidence: the above was PREMATURE
and is RETRACTED. The plants ran against the OLD scanner: spend-gate.js
is unchanged since 08:30:08 and gym-porter's described widening (third
alias rule, daemon-wide scan, real-source mutants) is NOT in the bytes;
docs/verification/p4-mutations/ holds only mutate.sh with no battery
output. The arbiter has not fired, and a decision against a design that
never landed would be deciding against work instead of evidence. The
verifier also records that gym-porter's narrow-design argument is
credible and that if the landed third rule catches the plants, the
narrow design deserves to win. Open question to gym-porter: where did
the reported mutant-catch results come from, if the code is not in the
tree. The leader's error: enacting an arbiter outcome without checking
the bytes had landed, the claims-are-not-bytes lesson again, this time
mine.]

3. The extractor's transport proposal landed with a MEASURED blocker:
EngineState's temp-file name is per-process, so two concurrent writes in
ONE daemon collide; measured failing at N=2 (1 of 2 attaches lands).
Not live today only because the stdio loop is sequential, but the first
two attached clients hit it immediately. Rulings: the serialization fix
(async mutex, per-write temp name, N-concurrent test) lands NOW,
independently; the socket proposal is APPROVED as designed (lock then
bind, stale socket resolved by the lock not connect-and-decide, sun_path
length check with named error, fan-out to all clients, per-connection
request ids, no auto-reconnect, 0600 in 0700, AF_UNIX never TCP, stdio
stays for tests, opt-in --socket) with build gated on tui-builder's six
pending client answers resolving. The stderr fix stays necessary: a
daemon that cannot start cannot be attached to.

## 2026-08-16 (the mid-attack edit explained) - The failing-boundary clause caught a real defect

The gym tree's movement during the attack window was gym-porter executing
the leader's own earlier order (build to the corrected addendum), which
crossed the later hold order in flight; the sequencing collision is the
leader's. What the work found justifies the clause that demanded it:
writing "a boundary check that FAILS" as a test exposed that runCheck
reset the assessed-edits counter for EVERY check, boundary included, so a
FAILING boundary check marked the condemned sprint as assessed, disarmed
the seal's rollback, and would have shipped exactly the broken state the
refusal was standing over. The platform never delivers the boundary
verdict to the model precisely so every delivery label keeps its meaning
(ADR-0164 lineage); the fix threads delivered=false for the boundary
check only, pinned by a named mutation. The suite is green at 373/373
(23:30Z), 26 mutations killed after TWO honest survivals both reported
(the step-0 test looked like coverage and was not: its script's passing
first-edit check meant no boundary check could run for unrelated reasons;
rewritten to satisfy every condition except the step). gym-porter also
extended the gate scan to the daemon with mutants built from REAL sources
and declined one D-0023 widening rule with an argument worth hearing (a
rule that flags methods.js's legitimate shape is a rule everyone learns
to silence); the arbiter stays the verifier's four plants: all caught or
the widening continues. Verifier re-run of the moved-file probes now
triggered.

## 2026-08-16 08:34 - P4 ACCEPTED: mechanism half PASS; the scanner must rise

Verifier report 8, every number its own: gym 70/70 at 08:26; the ADR
constants confirmed pinned and enforced at configuration time (the outer
bound throws before a run starts, not at the eighth grant), with the test
"the ADR constants are the shipped defaults, not merely the shipped
branches" implementing the verifier's own audit clause as a gate;
integration-seam-first and the gauge asserted present AND ordered;
the submit rehearsal correctly opt-in and tested on both branches; the
boundary-check control pair confirmed as a real pair; the disclosed
surviving mutation confirmed killed at BOTH the helper and the parser. The
cap-death refusal survived six truthy-coercion attacks (1, "true", {},
omitted, false, and a no-resultFile control), and the verifier caught its
own instrument error (a null cycle id makes the quarantine filter match
nothing, a false pass) and redid the probe with a real id: the
harness-debug row exists and is invisible to the scored read. Zero spend
confirmed structural: the gym has no transport at all.

Finding 73: the gate-writer scanner caught 1 of 4 planted offenders,
including missing the exact demo-helper scenario its own comment names.
Ruled in D-0023: the sentence stands, the scanner widens (both directions,
false positives behind an allowlist), and the live half is never
authorized before the widened scanner passes the verifier's plants. P4
flips to ACCEPTED with that follow-up. Outstanding process item: the
mid-attack edit by gym-porter (student-loop.js at 08:28:50, inside the
verifier's 08:26-08:34 window); the verifier's gym counts predate it and
its boundary probes passed on its run, but the stabilization report and
the re-run of any probe touching the moved files remain owed before the
P4 record fully closes. The verifier's full-suite run also showed
init-miner mid-build in citation validation (a good progress signal, not
a finding).

## 2026-08-16 (three closures) - P6 provenance fixed; lock wired; 49 checks

1. The verifier caught that P6's acceptance was never IN THE PLAN: the
leader authored six criteria in the assignment message pre-build but never
transcribed them, so the record showed a self-graded 47/47. Fixed with
honest provenance (D-0021): (a) through (f) transcribed as authored, (g)
Ollama-and-embedder honesty and (h) two-runtime handling ADDED post-report
from the verifier's coverage candidates, marked as such; the attack checks
whether the worker's self-authored checks cover them. Standing rule
extended: pre-registration means in the plan file, not in a message.
2. The adapter found a SECOND dead check before the attack (shasum
idempotency comparison passing vacuously without perl; empty string equals
empty string), fixed with python3 and non-empty guards, disclosed so the
verifier sees 49/0 not 47/0. Instrument rule now two questions: does it
fire on a plant, and what does it do when its tool is missing (D-0021).
3. The extractor wired the single-writer lock (taken before the first byte
served; refusal names the holder PID; released on clean exit with a
ghost-lock test; stale locks reclaimed by pid liveness), made history
records carry embedding identity, and re-ran the real-client handshake
with v5 on both sides, both halves having adopted v5 independently.
360/360 hermetic, 61/61 live, parity still IDENTICAL.

## 2026-08-16 (P4 reported) - The gym's mechanism half, claimed; attack launched

gym-porter delivered the hermetic half: eleven modules, four instruction
files, 70 gym tests, 21 mutations killed, a full cycle end to end against a
real temp git repo with a scripted fake engineer, zero spend by
construction (no fetch, URL, or key reference in src/gym at all). Standout
properties: the denominator rule is structural (recordRun THROWS on a run
with no applied diff, so a cap-death cannot have a row), the gate has
exactly one writer with a literal 'blocked' status and a mechanical
offender scan with two independently-failing rules, the boundary check
ships WITH ITS CONTROL (4d251c9 lineage; the mechanism's value stated as
the difference between candidate and control, not as work-survived), and a
SURVIVING mutation was reported as prominently as the kills (the
quarantine-reason minimum was only covered through one path; test added,
mutation now dies). Rulings in D-0020, including the harness-debug default
inversion (a TUI-reachable RPC method must not touch the scored record by
omission) and the prompt-audit-not-reinjection principle. Known accepted
gap queued for next round: the gold-provenance exclusion at retrieval
(provenance.js port), with certification refusing scored runs lacking an
exclusion record. Verifier attack in flight; queue reordered P4 then P5
then P6. The live cycle remains owner-gated and untouched.

## 2026-08-16 (daemon v5 round) - Consent enforced both ways; 332/332

The extractor landed v5: contractVersion 5, unknown documents filter keys
refused -32602 (a silently dropped misspelled filter returns EVERYTHING,
which reads as matched-a-lot rather than never-applied), ping null for
never-verified, zero-spend budgetEstimate with a stated basis (coefficients
are ESTIMATES, marked as such; when P3 can measure Layer 2's real per-unit
cost the coefficient comes from data), and consent as ONE shared guard with
two named mutations proven both ways: an OPEN gate is not consent, and
consent is a literal true, never a truthy coincidence (driven with 'true',
1, {}, 'yes'). Two self-caught bugs: a consent-guard arg slip that made
layer1+layer2 unconfirmable (a spend path that can only refuse), and a
deferred-method hint restating v4 in prose after the bump (a version number
in prose is a small lie that outlives every edit). The contract-parse gate
is adopted engine-side with both directions plus a self-guard against the
vacuous parse. The install smoke's version-drift finding is closed at the
source (ENGINE_VERSION reads the manifest). 332/332 hermetic, 61/61 live,
parity still IDENTICAL. Next for the extractor: the single-writer state
lock (two-daemons test), then the v5 re-handshake with the TUI.

## 2026-08-16 (P6 reported) - Install story: 47/47, four real defects found

The adapter's install harness: one prefix (program at ~/.local/share/daijin,
deliberately separate from the daemon's ~/.daijin STATE so uninstall removes
the program without touching what users would miss), private venv, one POSIX
shim, dry run into a throwaway prefix. Four defects found by the harness,
none findable by reading: hello's hardcoded engineVersion drifting from the
manifest (fixed upstream by the extractor, caught by the smoke check
refusing on first contact); the TUI help text pointing at server.js (the
library) instead of daemon.js (the entry), routed to tui-builder as its
file; the shim's exit-inside-command-substitution swallowing a refusal
(caught by the move-the-engine-aside mutation); and the adapter's OWN dash
sweep being dead across grep implementations, now python3 and SELF-TESTING
against a planted dash before its real result is trusted (finding 48's
lesson applied to its own instrument). The sanctioned daemon stub was
deliberately deleted once the real daemon landed: a stub answering hello
makes a broken install look finished, and its hardcoded contractVersion had
already drifted once. 29 mutations across six batches. Rulings: the
checksum step is built the day the owner publishes a real artifact, not
against nothing; the dry run joins CI as its own job that fails loudly and
never skips; the six failing RPC tests are the extractor's in-flight v5
round, expected. STATUS: CLAIMED, verifier attack queued after the P5
re-check.

## 2026-08-16 (owner directive) - Continuous enhancement until stable; TUI polish pass

Standing owner directive: keep enhancing the pipeline until stable, keep
the team running under leader direction. The owner ran the TUI locally and
liked the UI and the buttons; the new headline requirement is SMOOTH
ANIMATIONS. tui-builder has a detailed polish brief, sequenced after its
v5 round: a motion system module owning all durations and easings (no
magic numbers at call sites, swept by test), a full/reduced/off motion
setting with a zero-invocation assertion at off, semantic animations
(gauge fills, extension pulse, rollback counting down, phase-check
settles), charts animating on mount and data change only, worker-wrapped
RPC so the real daemon's latency cannot freeze a frame, step-event
coalescing to ~30 renders/second with a burst-responsiveness test, table
virtualization, and frame-timing numbers reported with honest bounds.

## 2026-08-16 (daemon accepted) - The engine speaks; real client, real pipe

The RPC daemon met all four pre-registered conditions: every declared
method answers over a real pipe with zero missing-method errors (deferrals
carry -32001 with a named phase and a real hint, now in v5's error
convention per D-0019), the step stream works end to end (gatesDiscover
wired as a real job writing a real gates.yaml), both suites green (255/255
hermetic, 61/61 live), and the spend-refusal mutation guard demonstrated
failing and recovering. The integration handshake is PROVEN, not claimed:
the extractor drove the TUI's own StdioRpcClient against the daemon, mock
on neither side, before announcing readiness.

Best find: gymStart originally read the gate flag and branched on open,
and the scope test caught it, since a gate authorized for exam-mining IS
open but must not authorize a gym-cycle. Fixed to assertSpendGate with the
generalization recorded in D-0019: open is not authorization. Also ruled:
single-writer lock on the state root (multiple TUIs are one daemon with
many clients, never many daemons); meta.arms additive exposure with parity
re-verified IDENTICAL; score-history.json as scoreHistory's backing.
Owed: the v5 adoption round on both daemon and TUI, then the re-handshake.

## 2026-08-16 (owner designation) - P3 target is portfolio-mine

The owner designated /Users/mfuad16/Documents/GitHub/portfolio-mine as the
constants-generalization target. Leader verification at designation: clean
tree at 81d453a, 67 commits, React with Vite scripts, deps include react,
react-dom, gsap. Constraints relayed to init-miner: target repo READ-ONLY
(brain store and any scaffold output land outside the target tree; no
writes into portfolio-mine are authorized), commit pinned and recorded at
run time, Layer 1 only, zero spend. Expectation stated in advance: the
25-case gold floor will bind on a corpus this small, and the diversity
gate's honest bound should say so rather than pad.

## 2026-08-16 (P5 findings closed, RPC v5) - The TUI is method-complete on v4

tui-builder closed the report-6 queue: 202 tests green, documents wired
with the false stub deleted and its pinning test inverted, scoreHistory
trend on the card with the budget sweep moved to the brain view under a
caption naming the distinction, fixture keys de-scannered. Findings 67 and
70 were already fixed before the verifier's snapshot (verified, relayed so
the re-check does not double-count). Two new self-checking gates shipped:
method coverage parses the CONTRACT TABLES with a minimum-25 anti-vacuity
guard (found 29, matching the corrected count, and handled hello at its
real call site instead of excluding it), and a stub-denial gate fires only
when a denial phrase and a declared method name co-occur, verified in both
directions. Seven mutations, all caught.

The finished shell surfaced five contract ambiguities, ruled at once as
RPC v5 (D-0018): confirm: true is the consent parameter and a
spend-touching call without it is refused -32050 EVEN WITH THE GATE OPEN
(the engine never infers consent); documents filters are exactly q, type,
area with unknown keys an error; ping: null encodes never-verified roles;
examList rows gain a human-readable title; and a zero-spend budgetEstimate
method powers the consent dialog, because an estimate that spent would
defeat a dialog whose purpose is showing cost before consent. tui-builder
has one small v5 adoption round; the verifier attacks the pre-registered
P5 sentence after that round reports.

## 2026-08-16 08:03 - P2 ACCEPTED: A/B verdict PASS, all probes confirmed

Verifier report 7, two independent runs plus four direct mirror
interrogations: case rate IDENTICAL across backends (0.9117647058823529,
same 31 complete, same 3 failing, miss lists identical), identifiers 5/5
both arms (g003 g005 g007 g010 g012), violations 0 both, MRR delta
-0.0039215686274510775 matching the adapter's claim. The decisive evidence:
the mode cross-check (the A/B control MRR is bit-for-bit the shipped-ordered
value the verifier measured independently during P1, from a different
runner on a different day, proving WHICH pgvector path ran), the live-FTS5
probe (732 rows, porter tokenizer confirmed from the DDL, all five
identifier tokens returning real bm25 hits), and the verifier's own
mutation probe (deleting a document from a COPY of the mirror removes it
from that arm's results while the clean mirror still returns it, so the
sqlite arm demonstrably reads its own store).

The most informative number is not the verdict: retrieval-level
diagnostics show SIX cases differ in retrieved-id order while only TWO
differ in score. That six-versus-two gap is the measured statement of what
the storage swap actually moved, the quiet-degradation surface Risk 5
warned about, now quantified. Recorded here as reference material for the
auditor era; not a defect, both arms score identically.

Three measured MRR reference points now exist on this corpus and are
pinned in D-0017 (dated addition) and README: parity-path pgvector
0.6588935574229692, shipped-path pgvector 0.6637955182072829, shipped-path
sqlite 0.6598739495798318. The sqlite value sits BETWEEN the pgvector
values, so comparing against the wrong reference flips the sign of the
conclusion. Finding 72 (rounded verdict detail strings) to the adapter
with its queued fixes. Next: extractor assigned the RPC daemon
(engine/src/rpc implementing methods.md v4), the bridge to P6 integration.

## 2026-08-16 07:11 JST - Session-limit pause and resume; two records secured

The entire team hit the provider session limit at 03:15 JST (reset 07:10);
the leader session stayed up. Actions during the pause window:

1. The verifier's compare-runs finding (per-case misses and violations
   "omitted") was REFUTED by the extractor with evidence: the differ
   compares both BY VALUE via listDiff at compare-runs.js:41-47; they are
   absent from the scalar FIELDS list because array identity comparison
   ([] !== []) would report two spurious differences on every case of
   every run. The extractor refused the instructed fix, reproduced the
   migrating-violation scenario (caught, 2 per-case differences under a
   held summary), and added four regression tests including the
   identical-cases-report-nothing control. The leader's routing of a
   static-read finding as a work order is the recorded lesson; the
   claim-to-verify rule applied to the leader's own instruction is what
   caught it. 158/158 hermetic, 61/61 live after.
2. The adapter's A/B artifacts were secured by the leader from its dying
   session's scratch into docs/verification/p2-ab/ (both runs, JSONs only;
   the 15MB mirrored corpus databases were deliberately excluded so no
   platform corpus content enters this repo). Verdict spot-checked from
   the artifact: pass true, caseDelta 0, all three checks.

Resume state: verifier owes the A/B attack (artifacts now durable) and the
P5 re-check; tui-builder owes the five report-6 findings; init-miner and
gym-porter were freshly spawned and resume their builds; extractor and
adapter hold stable trees (158/158, platform clean at 1c7871b).

## 2026-08-16 (P2 A/B reported) - PASS claimed, identical case rate; attack launched

The adapter's A/B: case rate IDENTICAL across backends (0.9117647058823529,
same 31 complete, same 3 failing with byte-identical miss lists),
identifiers 5/5 both arms, violations 0 both, MRR delta -0.0039215686
attributed and verified at the lexical arm (the only genuinely differing
component; g012 and g030 move rank in opposite directions, membership never
changes). Controls: mode cross-check against the extractor's independent
shipped-ordered MRR (exact match proves which pgvector path ran), mirror
reconciliation 557/732/399 with 23 identity chunks, live-lexical-arm probe,
two-run reproducibility, D-0012 write guard active throughout. Honest
bounds stated: one corpus, one embedder, one k; the instrument cannot
resolve below one case; context bytes not compared (and this corpus has no
two-ancestor supersession head, so the known caveat cannot fire); copied
vectors mean the embedding path is held constant. This run was also the
first corpus-scale exercise of the atomic full-mirror replace. D-0017
appended: no MRR tolerance, enforced pair plus per-case diff judge backend
changes, both measured MRR points kept as the reference band. STATUS:
CLAIMED-PASS; the verifier is re-deriving. P3 constants-generalization
target repo still awaits the owner's designation.

## 2026-08-16 (P1 residuals closed) - The area claim confirmed; records grew diagnostics

The extractor re-derived the contested three-area-change claim from raw
artifacts rather than defending its transcript: g003 storage to ui, g011
catalog to gmail, g031 firestore to ui, with the exact reconciliation of the
verifier's one-scored-row observation (three retrieved SETS change, one
scored outcome changes; scoreCase discards the rest). Root cause was that
the instrument did not exist in the repo, so the instrument was built rather
than the claim merely restated: harness records now carry embedding identity
(finding 66, lookup not inference), store.parityMode (which statements
produced a number is part of what it means), and an unconditional per-case
diagnostics block; compare-runs.js now distinguishes scored-identical from
retrieval-identical and says NOT COMPARABLE when a record predates
diagnostics, with the trap case under hermetic test. The MRR assertion keeps
sixteen digits with a written diagnosis ORDER (MRR moved and caseRate did
not: suspect planner row order first; both moved: real regression).

Process near-miss, disclosed by the extractor: a persisted shell cwd ran the
control in the wrong repo and compared the port against itself, printing a
clean IDENTICAL; caught because the output claimed a retrieval-level match a
genuine platform record cannot produce. A wrong-directory control looks
exactly like a passing control; the record's new engine field is the guard.
Parity re-verified end to end after all changes: 154/154 hermetic, 61/61
live, control and port equal to the last digit, platform clean at 1c7871b.

## 2026-08-16 03:12 (verifier report 6) - P5 fails acceptance on five findings

The TUI pass: fixtures and de-rounding closed properly (finding 50 verified
closed; the case_rate helper's rounding-at-the-source docstring called the
lesson internalized), mock shapes correct on every checked method including
the promoted-and-quarantined exam, spend structurally impossible (no HTTP
client exists in tui/), dash sweep clean. But the pytest suite fails to
COLLECT (a de-rounding rename retired format_percent and left the test
importing it, so zero TUI tests run and the tui CI job is red), the
documents method is unwired behind stub text that now contradicts the
frozen surface (and a test pins the stale text), scoreHistory has zero
references with the card conflating trend and sweep, the demo-open flag
D-0014 promised does not exist, and a fixture key literal uses the sk-ant-
prefix that trips secret scanners. All routed to tui-builder, 67 gating.
Rulings: card shows trend AND sweep as separate elements; --mock-gate open
is the demo flag with blocked default; P5's acceptance is now PRE-REGISTERED
in the plan (suite collects, 30 of 30 methods, both spend paths reachable,
keyboard and mouse under test, live-engine check moved to P6 integration).

## 2026-08-16 03:07 - P1 ACCEPTED: parity verified adversarially, PASS on all ten conditions

Verifier report 5, executed 03:00 to 03:03 against the pre-registered
protocol, every number re-derived from the verifier's own runs: control
executed and deterministic; caseRate 0.9117647058823529 (31 of 34), MRR
0.6588935574229692, violations 0, EQUAL on control and candidate; passing
case SET identical (failures g018, g023, g024 both sides); per-case diff
zero field-level differences with the ordered-list masking check passing;
k=8 echoed; and the decisive condition 10, the gold-set mutation probe:
corrupting g003's must_return moved the candidate to exactly 30 of 34 with
all other 33 cases unchanged, proving the harness computes rather than
quotes. Corpus had drifted (557 vs baseline 538) and the control STILL
reproduced the baseline exactly, so the pre-registered contingency resolved
to the strong form: candidate = control = committed baseline. The verifier
also independently verified the context-SHA claim on a 5-query sample
(identifier and non-ASCII cases included) and the parityMode disclosure's
enforced-metrics and MRR claims exactly. Condition-0's finding 63 (split
unexecuted at 03:00) was resolved by bytes at 03:07: test-live/ exists,
hermetic 146/146. P1 is accepted; the P2 A/B gate is open.

Residuals ruled: MRR assertion stays EXACT with a diagnosis-note comment
(finding 65; loosening the only test that catches a real per-case regression
is the worse trade; a parity-path MRR failure is diagnosed as planner order
first); harness records gain the embedder identity fields (finding 66, makes
every parity record self-describing); the "three cases change inferred area"
claim is returned to the extractor for its own citation or downgrade, since
harness output cannot confirm it (one scored row moved, g003). The verifier
corrected its own earlier CI-permanently-red claim (finding 64): the parity
test skips with a named reason off-corpus; the split was still right per
D-0015 because a skipped test is not coverage.

## 2026-08-16 (P1 finishing pass) - Both suites green, order question measured

engine-extractor applied every ruling and re-verified parity afterward with a
freshly EXECUTED control (18:02Z run pair): summary, per-case, and context
SHA-256 all identical; npm test 145/145 hermetic, test:live 61/61, platform
repo clean. The D-0015 split is now real (parity and pgvector conformance
live in test-live/; CI carries an explicit not-run-here disclosure step).

The relationship-order question is answered with a measured split: retrieval
is ORDER-INSENSITIVE (edges fully reversed reproduce all 34 cases to the
context SHA-256, so the platform baseline is not planner-dependent through
that path and both backends stay unordered), but the superseded: metadata
list renders in edge arrival order, demonstrated adversarially on a two-head
fixture the platform corpus never exercises. Both facts are pinned by tests.
Ruling: no sort now (touches measured code, changes context bytes); recorded
as an auditor-proposable post-parity change and part of the platform finding
for the owner. "Measured safe here is not safe by construction."

Also: evaluation default removed from pgvector (the extractor's own words:
the contract's reasoning is the real argument, not the test), v1 CRUD residue
deleted, validate-before-delete on replaceChunks, D-0012 enforced in code
(migrate refuses foreign ledgers), a second rounded-form comment found and
fixed beyond what finding 52 named, and the shared-suite import switched to
hard-fail. P1 acceptance still awaits the verifier's verdict.

## 2026-08-16 (P2 alignment closed) - 22 mutations; A/B staged behind the P1 gate

store-adapter applied all rulings including inverting its own fresh work
(store-level evaluation default removed entirely, conformance case inverted;
strict ChunkWriteRow with positional-ordinal inference removed, because
inferring the identity beacon from array position is how a beacon lands where
a readable chunk belongs; stub documents replaced by a named error). 22
mutations verified across three batches. It also found a protocol gap before
the verifier's diff step fired: record.at and record.label guarantee a
non-empty whole-file diff, so the parity diff is pinned to record.results
sorted by id plus field-by-field summary. A/B rulings: runner at
engine/src/init/ab-sqlite-pgvector.js (one-file carve-out), sqlite arm
ingests the corpus through the SHIPPED write path rather than a direct table
load, measurement gated on the P1 verdict. A transient two-case pgvector
divergence (both freshly-ruled invariants) was observed mid-edit and will be
confirmed deliberately under test-live, never trusted from the snapshot.

## 2026-08-16 (P2 v3 port complete) - 200 green, 19 mutations, twin ready

store-adapter completed the v3 port: 200 tests green (55 adapter tests), the
v1 CRUD surface deleted so no caller can reach a shape the pgvector twin
lacks, migrate() refusing edited-but-applied migrations, contentHash
defaulted to sha256(content), prune via temp keep-table (an IN list silently
truncates past SQLite's bound-parameter cap and deletes documents), and eight
new mutation kills on the D-0011/D-0012 obligations on top of the previous
eleven. Its evaluation-default question crossed D-0013 and resolved further
in its favor: the default leaves the store entirely (verified again: the
platform inventory passes types null; retrieve.js:60 hands the arms explicit
excludeTypes), so the store-level arms default is being removed and its
mutation case inverted. Adopted into the contract from this port: an explicit
empty standing prefix is an ERROR on both backends, never match-all. Both
backends now carry identical v3 surfaces; the A/B waits on the P1 verdict.

## 2026-08-16 (P1 reported) - Exact parity claimed; verifier attack in flight

engine-extractor reports P1: the committed baseline reproduced to the last
digit at k=8 (caseRate 0.9117647058823529 = 31 of 34, MRR 0.6588935574229692,
violations 0), per-case diff identical on all 34 cases against the platform's
own executed run, and byte-identical full retrieval output including a
SHA-256 of the assembled context. Acceptance mutation-tested live (cap revert
0.22 to 0.40 drops to 29/34 and the test names the number), with a disclosed
negative result: RRF_K 60 to 61 moves nothing on this corpus. STATUS:
CLAIMED, not accepted; the verifier's pre-registered attack (condition 0
first) is executing. Known acceptance gap at report time: the D-0015
hermetic/live split was not yet executed (parity test still in test/).

Platform finding worth the owner's eyes (D-0016): the platform's 91.2%
depends on unspecified SQL row order; rank.js breaks area ties by arrival
order. ORDER BY d.id leaves enforced metrics identical and moves only MRR,
upward. Daijin ships ordered; parityMode preserves the platform's exact
statements for measurement; changing the platform itself is the owner's call.

Also in the P1 report: ~3,178 source lines landed behind Store v3, MCP's
foundational coupling removed (all roots injected), pgvector refuses to
migrate a database carrying another tool's ledger, and the shared conformance
suite caught four real bugs in the extractor's own store including an
unscoped prune, the exact hazard D-0012 exists for.

## 2026-08-16 (P5 delivered, RPC v4) - The TUI shell runs and field-tested the contract

tui-builder delivered P5: all seven screens render against the bundled mock
engine, keyboard and mouse, 112 tests, zero spend, with pure chart renderers
asserted without a running app, a stdio round-trip test over a real pipe, its
own mutation checks (including finding and killing one piece of dead radar
coverage), and a copy gate that scans composited screen output and caught
Textual's own em-dash in the Header widget. The report was composed against
the v1 contract (the v2/v3 rulings crossed its long build turn), so three of
its five stubbed gaps were already methods; the two real gaps plus its
assumption set became RPC v4 (D-0014): documents, scoreHistory, notification
names step and boardFinding, ts epoch ms, gym/settings/board shapes codified,
mock spend gate default flipped to blocked. Green-suite-at-report is now a P1
acceptance addendum in the plan. Verifier re-verified all report-4 closures
in bytes and correctly flagged the leader's 129/129 as a snapshot of a moving
suite presented without a timestamp; ruling in D-0014, suite claims carry
timestamps and the caveat from now on.

## 2026-08-16 (P2 delivered) - The sqlite backend is in and serves the real ranker

store-adapter delivered P2: one SQLite file per repo, sqlite-vec cosine, FTS5
under the measured recipe, and rag/retrieve.js runs on it unmodified. 130
tests green (51 adapter tests), zero spend, eleven mutation kills each named
to the test that catches it, including the measured proof that dropping cosine
from the lexical arm breaks retrieve() itself. The integration test found a
defect the conformance suite could not: indexedEmbeddingIdentity returned a
shape the identity assert rejects, so every query would have been refused
while all store tests stayed green; fixed with the seam under test. The
adapter also challenged the contract and was RIGHT: the evaluation-type
default belongs to the retrieval layer, not the store (double-apply plus
hiding evaluations from record_evaluation reads); contract corrected, D-0013.
Stopwords ship as the measured subset, not the unmeasured full snowball list.
Pending: A/B vs pgvector once P1 lands (conformance suite already
parameterized). Open coordination item: the adapter composed its report
against the pre-v3 contract state; leader re-sent the v3 alignment deltas
(method names, prune scope, strict ChunkWriteRow, no stub documents).

## 2026-08-16 (verifier report 3) - The ingest call site, and a gate that could lie

Report 3 walked platform/ingest/index.js, the one Store call site report 1 had
not read, and found the write side wrong in two ways: relationship replacement
was per-source where the platform's is a global table rebuild (stale edges
would corrupt brain.impact_of), and there was no deletedIds path. Closed in
Store v3 same day (D-0011): replaceAllRelationships(rows), deleteDocuments(ids),
DocumentRow.contentHash, store-assigned chunk ids, and exams/projects/ingest_run
declared out of Store scope for P4. Also closed: the CI em-dash gate treated a
grep failure (exit 2) as clean and now fails explicitly on tool breakage;
examList carries benchmarkStatus and quarantineReason and heldOut orthogonal
to authoring status; D-0007's miscount corrected in place (ten gaps, not
nine); this file's P0 correction made precise (.gitignore was hygiene, not a
plan acceptance item). The verifier confirmed the recipe annotation left the
FTS5 evidence byte-intact and re-deriving D-0001 exactly, and that every
leader numeric correction matches the baseline field for field. Routed:
pgvector.js's rounded-number comment (extractor), mock_data.py's ten stale
numbers and v2-shaped fixtures (tui-builder, folded into P5 acceptance).

## 2026-08-16 (verifier report 2) - Two criticals in the leader's own v2 text

Report 2 verified the report-1 closures (599 confirmed independently, README
anchors exact field by field, em-dash CI gate proven live by mutation pair)
and found two new criticals, both leader-authored: the lexical arm's score
semantics (already fixed by the v3 convergence merge, which crossed the
verifier's snapshot in flight; bm25-as-score would have inverted lexical-only
hits on sqlite silently) and a wrong spend enumeration (initBrain layer2
spends on the engineer key but was not listed). Closures: RPC v3 (D-0010,
exhaustive spend set, diagnose split from paid narration, agent-file methods,
job-independent boardFinding notification), Store v3 amended with
deleteDocument and pruneDocumentsExcept under atomic full-mirror-replace
ingest semantics (D-0009), the plan's P1 acceptance line restated so the
extractor and the verifier read the same falsifiable sentence, and
*.egg-info/ ignored. Known and accepted: CI is red on arrival because
tests-first means both test jobs fail until the workers land their first
tests; the verifier confirmed neither job is vacuously green.

## 2026-08-16 (later still) - Store contract v3, the convergence merge

The extractor and the leader wrote candidate surfaces independently within two
minutes of each other (retrieval-store.d.ts at 02:25, store.d.ts v2 at 02:27),
converging on the four arms. v3 merges them; platform-faithful details win
because P1 acceptance is parity (D-0008). retrieval-store.d.ts deleted.
store-adapter reports its v1 sqlite backend complete (37 tests green, zero
spend) and is porting to v3; the v1 surface it proved is superseded.
Leader fixed engines to >=22 and widened the test glob. NUL-byte scan over all
engine src and test files: clean.
[CORRECTION 2026-08-16, verifier report 4 finding 57: "widened the test glob"
was FALSE when written. The leader's glob edit had failed on a concurrent file
modification and only the engines fix landed; the claim went out unverified in
messages to three workers. The glob actually widened only after report 4
proved test/sub/deep.test.js ran zero tests silently under the old pattern.
The lesson is the project's own rule: verify the edit landed before claiming
it, even for one-line fixes.]

## 2026-08-16 (later) - Verifier report 1 on P0: contracts revised, record corrected

The verifier's first report (9 critical, 19 warn, 8 info) held up under the
leader's spot checks. Leader actions, same day:

- CORRECTION to the entry below: P0 was reported done while an acceptance
  item was missing. [Precision added 2026-08-16, verifier report 3: the plan's
  P0 acceptance names the CI skeleton; .gitignore was repo hygiene the
  verifier raised, not a plan requirement.] Both exist now
  (.github/workflows/ci.yml with an em-dash hygiene job, .gitignore keeping
  69 MB of build output and a native binary out of the first commit).
- Measured anchors were wrong in README and plan: k is 8 (not 10), and the
  floor is the exact rational 0.9117647058823529 = 31 of 34 (91.2% is a
  rounded display that fails a healthy tree). Corrected in place, dated, in
  docs/daijin-build-plan.md and README.md.
- Store contract v2: widened to the derived seam (excludeDocumentIds gold
  provenance exclusion, document and relationship rows, ordinals, four
  candidate arms, write path, migrate). D-0004.
- RPC contract v2: one revision closing all nine gaps (hello handshake,
  repoAttach/Detach, jobCancel, gates methods, examList/Veto/Update, rolePing
  as a marked spend-touching method, observable spendGate, mcpSnippet,
  initBrain area scope, retrievalScore sweep and diagnosis fields). D-0007.
- Gold-case field is must_not_outrank with platform ranking semantics, not an
  exclusion set. D-0005.
- Platform suite count settled by measurement: 599 tests, 599 pass
  (npm test in the platform repo, 2026-08-16). Plan's 599 was right; the
  extraction report's 578 is stale.
- Routed to workers: broken npm test script and zero tests on nine copied
  files (engine-extractor); engines >= 22 declaration, recipe header
  contradiction, unfiltered-comparison caveat (store-adapter); build against
  RPC v2 (tui-builder).

## 2026-08-16 - P0 scaffold and team launch

Repo created at ~/Documents/daijin by the leader session. Plan and extraction
report preserved from the ephemeral scratchpad into docs/ (the scratchpad copy
under /private/tmp is not durable).

P0 done by the leader: directory layout, frozen contracts
(engine/src/store/store.d.ts, engine/src/rpc/methods.md), README with measured
anchors. Git initialized, nothing committed; commits are the owner's call.

Team launched as named background agents coordinated by the leader over
SendMessage (the native team runtime was glitchy last launch, so this session
uses named agents, which serve the same shape: leader coordinates, workers own
code, verifier reports only):

- engine-extractor: P1, copy portable core behind Store with pgvector impl,
  port retrieval-score harness, reproduce the 91.2% floor on the platform corpus.
- store-adapter: P2, sqlite-vec + FTS5 Store impl per the measured recipe,
  conformance tests; A/B vs pgvector once P1 lands.
- tui-builder: P5 shell against the frozen RPC contract with a mock event
  stream (real engine wiring after P1).
- verifier: report-only, attacks each phase's acceptance check.

init-miner (P3) and gym-porter (P4) launch after P1 proves parity, since both
sit on the extracted core.

Deviation from plan noted: workers write to disjoint directories of this repo
instead of one worktree each; the repo has no commits yet so worktrees are not
possible, and the ownership boundaries are directory-disjoint.
