# Daijin build state (authoritative)

## 2026-08-17 00:15 - init-miner's lane is empty; the battery caught itself within a minute

REPORT 8: queue fully clear, all four commits path-scoped and clean
(a6a7443 gates sandbox, 4c83b89 battery, c1a0626 M36 anchor repair,
24527ec the two sweep artifacts a pathspec commit had missed). Both of
init-miner's P8 items are DONE.

THE BATTERY CAUGHT ITSELF within a minute of landing: its first
committed run reported 37/38 with M36 as DEAD-ANCHOR - the per-record
heading-shift change had renamed the expression M36 anchored on, so
the mutation silently stopped applying. Under the old script that was
a no-op that looked exactly like a kill, and precisely that shipped
twice before being caught by hand; under the new three-hash assertion
it REPORTED ITSELF. Anchor repointed, re-run 38/38/38 exit 0. That is
the dead-anchor guard earning its place in production on its first
day.

Item 6: init-gates commands now run in their own mkdtemp sandboxes.
init-miner's honest addendum kept: nothing was ever written, AND THAT
WAS LUCK - the candidates happened to be shell builtins; gate
discovery exists to execute arbitrary repo code, making its own tests
the last place to point at a real tree.

Two crossed items resolved in place: the baseline-control finding
already reached gym-porter and caught ITS battery too (see the 00:00
entry); the hook gap was already ruled closed via the leader lane
(D-0026 addendum 2) while report 8 was in flight.

P8 preconditions: ONLY tui-builder's live runs remain. Suite 592/592.
init-miner holds capacity for pin-time re-runs if the claim needs
them.
## 2026-08-17 00:00 - The baseline control finds the same break in the pattern's author

gym-porter checked its own battery against init-miner's property and
it FAILED THE SAME WAY: methods.js imports adapters/ from outside the
engine root, one gym test (the finding-81 layer-boundary test) reaches
it, so since that test landed every private-copy run carried a failing
file - and EVERY MUTATION WHOSE TEST SET INCLUDED IT SCORED A KILL IT
HAD NOT EARNED (roughly the ledger, certification and rubric
mutations).

DATED CORRECTION to this file's earlier 77/77 citations: kill counts
from private-copy runs before b2f398c included unearned kills for that
subset; the containment claims (verifier's 91-sample check, the digest
comparisons) are unaffected - they measured a different property. The
battery re-ran fixed (adapters linked as a SIBLING so relative paths
resolve as in the real tree): baseline green, 77/77, and the
conclusions now stand ON THIS RUN, stated rather than carried forward.

THE WORSE BUG, caught only by the install-time precedent: gym-porter's
first baseline guard sat ABOVE the chdir into the copy, so it tested
the SHARED tree and reported green for any broken copy - a baseline
control measuring the wrong tree is a guard that cannot fail, the
exact defect it exists to prevent, one level up. The deliberate
broken-copy probe said green where it should have refused; without the
exercise-the-failure-direction requirement this guard would have
shipped inert and been reported as adopted.

The pattern module carries FOUR properties plus the parameter the
break actually lived in (linkSiblings, for sources importing out of
the copied root - "a property without the parameter it guards would
have shipped the same trap with a better error message").
assertBaselineGreen THROWS: a battery that continues past a red
baseline reports kills it cannot justify. Header credits init-miner
and states the property should have been first and arrived because a
second lane paid for it.

THE GENERALIZED PRINCIPLE, kept: a battery scores KILLED when tests
FAIL, so anything that breaks the tree universally reads as total
success - ANY INSTRUMENT WHOSE FAILURE SIGNAL IS ALSO ITS SUCCESS
SIGNAL NEEDS A CONTROL THAT DISTINGUISHES THEM. Not specific to
batteries. Manifest 5dff20b3 unchanged, stated.
## 2026-08-16 23:40 - init-miner clears its queue; survival moves a budget for the first time

REPORT 7: everything done except the battery commit, which the hook
was correctly holding as unmapped - the lane map now carries
docs/verification/init-mutations/ (mapped, exercised, ready to land).
init-miner declined the cross-lane override because its commit was
single-lane and "the override would be a false claim" - the discipline
working exactly as designed.

THE BATTERY, and the finding it returned to the pattern: its first
private-copy version LIED FLAWLESSLY - the copy list missed that
sqlite.js imports adapters/ from outside the engine root, so every
test failed to resolve, every run was red, and all 38 mutations scored
KILLED while no test had executed under any mutation. A broken tree
produces a perfect-looking battery. The guard is a FOURTH property
offered back to the pattern module: a BASELINE CONTROL - the unmutated
copy must be green or the run refuses (the project's own dead-gate
rule, applied to batteries). Final battery: declared 38, executed 38,
killed 38, refusal demonstrated in refusal-demo.txt, shared tree never
written. Determinism: five consecutive runs, 139/139, source hash
identical across all five - clause (i) satisfied for this lane.

P3.5 RE-RUN: numbers UNCHANGED (generated 25/25 control 18, range 7;
adopted 24/25 control 4, range 20; both arms, same scripts, same pin)
- and the re-run caught a real defect the numbers could never show:
the heading demotion turned an in-body h1 into h2, WHICH IS THE RECORD
SEPARATOR, truncating the unit; the shift is now per-record and
recorded in the marker so the reader undoes exactly what the writer
did. Re-deriving beat inferring for a reason neither party predicted.

FINDING 82: THREE causes distinguished, not two (core-larger-than-
slot, per-candidate-cap, budget-exhausted) - forced by a fixture where
two constraints were live at once and a binary split would have told a
user to shorten a unit that cannot fit at any budget. The misleading
allowance field is renamed nominalCap with its bound stated.

THE PER-CORPUS SWEEP is the round's headline: case rate, MRR and range
are FLAT across 3000-8000 on the curated corpus, but CONTENT SURVIVAL
is not - it fails at 3000 and 4000 and passes from 6000. First time
D-0003's survival signal has FIRED TO MOVE A BUDGET: same repo, two
corpora, two answers (3000 generated, 6000 curated), which is what
the per-corpus sharpening exists to measure. Made actionable: on
survival failure the pipeline walks the sweep and NAMES the smallest
passing budget, with a test. En route it caught its own vacuous pass
(units read back carry no core, so the check skipped everything and
passed) - denominators now printed by default, same family as the
battery lie, twice in one session.

HOOK GAP RULED CLOSED (D-0026 addendum 2): agent/* and non-
verification docs/* map to a LEADER lane, so lane-code plus a staged
state/plan file refuses; residual shared class (README, .github,
package manifests) accepted and stated. Suite at 592/592.

P8 preconditions: init-miner DONE once the battery commit lands
(unblocked now); tui-builder's live runs remain the last one.
## 2026-08-16 23:25 - The audit denominator is now a table, not a memory

gym-porter's follow-through (809779f, README only, verified inert):
the thirteen-passed-one-failed audit was not copyable because the
guard list was recited FROM MEMORY - the denominator was whatever the
auditor recalled, so the next run would silently audit a different
set. Now sixteen rows in the evidence README, each naming where that
guard's failure has been WATCHED, not merely where it is defined, plus
the instruction: a guard absent from the table is one nobody can tell
has been exercised. Writing it down surfaced TWO guards memory had
missed (the hook wiring, the scanned-set coverage) - both exercised,
neither recitable - which is the argument for the table in one
observation. The generalization, plainly stated and kept: the
containment check was a habit until it was in the script; the audit
was a habit until it was in the file; each fix is the same move -
write the implicit thing down where someone who is not you can check
it. Manifest unchanged at 5dff20b3, stated per the standing form.

## 2026-08-16 23:15 - The precedent audits its own author: the containment evidence was a habit

gym-porter turned the new install-time precedent into a checkable
question (which of my mechanisms has a failure direction NEVER
exercised?) and ran it against its own lane. Thirteen passed. The one
that failed was the least expected and the most quoted: THE
CONTAINMENT EVIDENCE ITSELF. The shared-tree before-and-after digest -
cited all day as proof the battery touches nothing - was a command the
OPERATOR TYPED around the invocation, never part of the script. A run
whose operator forgot the wrapper claimed nothing while producing
output identical to one that proved containment, and the check had
never been seen to fail. "An evidence check that lives in someone's
shell history is a habit, not evidence. I have been citing a habit."

CORRECTION to this file's 18:05 entry, dated here: "the check lives in
the captured output" was true only because the operator put it there;
it was not structural. The containment FACT for that run stands
independently (the verifier's 91-sample continuous check was its own
instrument), but the battery's self-evidence was not what the record
said it was. Fixed at 9af54c8: the script itself takes the comparison,
prints it, and counts mismatch as a problem - then EXERCISED, per the
precedent: a sabotaged restore on a throwaway engine copy reports both
NOT RESTORED and SHARED TREE CHANGED with both digests; the real tree
checked untouched after the probe.

Why it hid, in gym-porter's words, kept because it names the next
level up: every other mechanism was a check on THE CODE and got asked
whether it could fail; this one was a check on ITS OWN INSTRUMENT and
its output was treated as measurement rather than as another claim
needing the same scrutiny. The verification of the verification is
where everyone stops looking.

Manifest 5dff20b3 UNCHANGED, stated rather than inferred from silence
("unchanged is also a claim the verifier should be able to check").
Noted in passing: three init-lane files are mid-work (brain-artifacts,
floor, init-floor.test) - init-miner is moving on its queue.
## 2026-08-16 22:58 - The governance check catches its own author; a latent hole found

THE MECHANICAL CHECK LANDED (gym-porter, 1051f43;
docs/verification/p4-mutations/check-scanner-commit.mjs) and is WIRED
as the commit-msg hook (leader re-ran the self-test before wiring;
unrelated-commit control verified through the hook path). Self-test:
both refusals fire (false declaration, unannounced widening,
too-thin-reason widening) and three honest controls pass. The stronger
evidence, run against REAL history: it ACCEPTS the extractor's honest
src/roles declaration and REFUSES a881df2 - gym-porter's OWN layout.js
widening, the one it self-owned in prose - which is the whole argument
for counters in one line: the rule was agreed, the author knew it was
broken, and it still took a machine to catch it in the record rather
than in memory.

THE LATENT HOLE, found because the verifier asked a clarifying
question: the scanned set was TWO lists - the declaration in the
coverage test and a separate array of walked roots - agreeing only by
maintenance. A directory declared but not walked would read COVERED AND
NEVER SCANNED, and the coverage test would pass, because it compared
the declaration against disk, never against what the walk read. Fixed:
one exported constant, walk derived. The question was about how to
write a checker; the answer was a bug.

TWO RULINGS: placement stays docs/verification/p4-mutations/ (the
check's self-test and real-history runs ARE its evidence; a tools/
directory happens when three infrastructure scripts exist to move
together, not for one). Widening-must-stand-alone is DECLINED as
gym-porter left it: widenings already go through the leader in a
freeze window, and a window forces effective isolation without the
check inventing scope beyond what was ruled. Reason bar of 60 chars
stands as visible-and-arguable. Manifest supersedes to 5dff20b3
(delta: the unified constant in gym-spend-gate.test.js + two evidence
files).

[Addendum 23:08] gym-porter independently verified the hook wiring
from its side - both directions exercised through the INSTALLED hook
(honest message exit 0; a declaration claim over a881df2's real
widening diff exit 1) - so the installed thing is proven to be the
thing that governs, by two parties. Its named class, kept: a hook is a
mechanism whose failure is INVISIBLE (fails open, fails quietly, fails
by mode bit or working directory, all identical to a clean run) - the
same family as the dead gate, the skipped mutation, and the unexecuted
battery entry. Four members found in one week; the family is large.

THE EXTRACTOR CLOSED ITS jobCancel ASSUMPTION (bce6252) and the
reading was worth more than the confirmation: cancel is cooperative,
NEVER THROWS ({cancelled:false} on unknown/finished), but is NOT a
hard stop - a job past its last checkpoint still completes its write.
Consequence written into the test file: the isolation rests on the OWN
REPO, not the cancel; the cancel only stops work sooner. Verified
empirically the real way: zero temp dirs before and after, meaningful
because an outliving job would RECREATE its directory on write.
## 2026-08-16 23:02 - store-adapter's closing note, kept for whoever reads next

It verified before approving rather than after (git status empty
across all nineteen owned paths; 70e80f7 carries the history stamping)
and left two things in the record. The checksum is DELIBERATELY
UNBUILT, not forgotten: a checksum against nothing verifies nothing,
so it waits to be written against the real release artifact, never
designed in advance of it. And the habit to inherit, with its four
instances from one lane: A PASSING CHECK IS NOT EVIDENCE UNTIL IT HAS
BEEN WATCHED FAILING - it caught a dash sweep that passed with a
planted em dash, a hash comparison of two empty strings, a shim whose
exit killed only its subshell, and a mutation that proved nothing
because its path expression was wrong. Every one failed in the
direction that looks like nothing happening, which is why reading them
was never going to be enough. Terminated cleanly, pane released.

## 2026-08-16 22:50 - Roster: store-adapter retired at owner direction

store-adapter shut down, its lane complete: P2 conformance, the A/B,
the D-0031 install side, the uninstaller's three lifetimes, and the
shared-id refinement (landed by the extractor, 70e80f7). Its one
deferred item - the publishing checksum - is blocked on a real release
artifact existing (post-P8 packaging); a fresh agent picks it up from
the record if it goes live. Remaining roster: extractor, init-miner,
tui-builder, gym-porter (on call + the mechanical governance check),
verifier (P8 attack).

## 2026-08-16 22:45 - Race fixed as a PATTERN; a product defect underneath; worktree demonstrated

THE EXTRACTOR CLEARED ITS P8 PRECONDITION, all three parts, plus one
product defect nobody had assigned.

(a) The race (1cd98b6): both rpc-surface sweeps get their own
throwaway repo (sharing removed, not sequenced around; jobs CANCELLED,
not abandoned - an un-awaited writer outliving its file is a writer
with no owner). Isolation asserted POSITIVELY: the sweep asserts no
gates.yaml appears in the shared fixture, and the assertions were
proven by putting the fixture back and watching them fail.

(b) The pattern check came back PATTERN, two instances: rpc-spend had
the same shape with a LARGER blast radius (two un-awaited initBrain
jobs write manifest, brain files, gates.yaml, score history; four
later tests read them) - fixed in the same commit. rpc-events,
init-pipeline, init-gates: clean on this shape, stated positively.
Separate flag, deliberately not conflated: init-gates classifies
against process.cwd(), so a test run executes the engine repo's own
npm scripts - a second way for tests to write where nobody expects;
init-miner's file; queued to init-miner, not touched.

THE PRODUCT DEFECT (4f5ad9b, found underneath the CI failure):
gatesDiscover wrote gates.yaml UNCONDITIONALLY at the end of a
minutes-long job, destroying anything the user wrote meanwhile - in a
file whose first line promises "edit it, and the engine obeys it".
Discovery now reads at request time, compares at write time, keeps the
user's version and says so on the stream (new step: kept-yours), with
a test for the OTHER side so the refusal cannot become a feature that
silently stopped working. Ruling on the step's level: stays default -
"warn" would tell a user they did something wrong when the engine is
KEEPING their work; the TUI styles by step name instead, which needs
no contract change.

(c) The worktree procedure DEMONSTRATED at pin e65cd2d
(docs/verification/p8-worktree-procedure.md): five consecutive runs,
590/590 each, run count recorded; the digest bound honestly stated
(before/after proves ended-as-started, not never-changed; the
worktree's strength is that nothing else has a reason to write there);
report 21's re-derivation done properly - six chunking runs, ONE
distinct decision list across all six, same decisions in the same
order, not merely equal totals. Bound recorded for later: node_modules
is symlinked, so the runs pin SOURCE against a shared install; a
dependency-version claim would need a clean install instead.

Also landed: store-adapter's history refinement (70e80f7) - rows stamp
originPath and an index digest computed over ids and content hashes,
NOT file bytes, because vacuum and page layout would mark every
rebuild of identical content as a new condition.

Suite is 590/590. P8 preconditions remaining: init-miner (committed
battery + P3.5 re-run), tui-builder (live-half runs).
## 2026-08-16 22:35 - Ruling placed at its point of use; P7 manifest superseded

gym-porter put the declaration-versus-widening ruling INSIDE the
failing test (123d17b, comment-only: 14 insertions, zero non-comment
lines, re-derived by the leader), on the correct argument that the
person who needs it is staring at a red suite in another lane and will
read the failing test, never state.md. Its closing line is placed where
it can change behavior: if a red suite is pressuring you toward an
exemption, that pressure is the argument for declaring rather than
excusing. RETAINED under the inert-change ruling. NOTE FOR ATTACK
PINS: the frozen-tree manifest is superseded, eb26cab9.. ->
f6f3c8c79d37adc566d46c6de8de3a1f3189c3425ac67230f0b0df3b23deb78a,
delta exactly one comment block in engine/test/gym-spend-gate.test.js.
Norm set for small landings: inert edits verified inert are welcome
without asking; any edit that moves a frozen manifest states the
supersession and the delta in the same report, as this one did.
## 2026-08-16 22:25 - Scanner governance completed: declarations land, widenings wait

gym-porter surfaced the case the settlement did not cover, with the two
commits that had already exercised it (git log -S checked before
claiming): the scanned-set test forces a scanner edit whenever ANY lane
adds an engine directory, so the window rule as written would either be
violated quietly or obeyed at the cost of a suite red for everyone
until a window opens - and the red-until-window path drives people
toward the exemption, the worse failure mode. RULED, its distinction
adopted verbatim because it tracks the guarantee rather than the file:

- DECLARING a new directory as scanned is NOT a widening - coverage
  grows, nothing is excused, the guarantee gets strictly stronger. It
  lands immediately by whoever's commit triggered it, any lane, with
  the commit message stating "scanned-set declaration, strictly
  stronger". (src/roles was this, and was right to land.)
- An ALLOWLIST ENTRY is a widening - it excuses a file from the
  ownership rule and weakens the guarantee. It goes through the leader,
  in a freeze window, carrying its reason. (layout.js was this, landed
  mid-round without flagging; gym-porter owned the miss itself.)

The test of the ruling is that both historical cases land on the
correct side of it. Recording the answer before the moment it is
needed, per the conditional-ruling habit, is the pattern this build
should keep exporting.
## 2026-08-16 22:20 - Governance sharpened: inert changes need no window, and inert is verified

The verifier found that the scanner file's own standing note ("EXTEND
THIS SET", written pre-ruling) now contradicts the governance rule and
points toward the unsafe action - and raised it rather than editing it,
so the rule's first test was its author following it when inconvenient.
RULED: the window requirement governs BEHAVIOR; a comment-only edit is
not a gate change and lands immediately, on two conditions that make
comment-only a verified property rather than a claimed one: the diff
shows only comment lines, and the script is run post-edit and exits 0,
both stated in the commit message. Fixed now rather than riding along,
because a contradiction that misdirects is a defect today and "the
next change" is made by exactly the person the trap was set for. The
corrected note carries the rule inside the instrument: a plant set
that stops growing becomes a checklist; one that grows casually turns
someone else's push red for a shape nobody agreed to.
## 2026-08-16 22:15 - Report 21 closes the correction chain; team resumed after limit

All five lanes hit the session limit at 18:09 JST and were resumed at
22:12 with their standing assignments restated.

VERIFIER REPORT 21 (the report-chain correction, 116 lines): report
19's "two mechanisms" recorded as half right BY LUCK - the second
member collapsed with the retracted datum, and the conclusion survives
only because report 20 later traced a real one; written so the
conclusion's survival cannot launder the argument. Report 18's
dissolution restored with its date. The exemplary-method citation SPLIT
rather than withdrawn (the escaped-fetch kill stays earned; the drift
datum beside it was not; wholesale praise is the same error as
wholesale condemnation). The transferable lesson, the verifier's own:
IT APPLIED THE PIN DISCIPLINE TO CLAIMS IT ATTACKS AND NOT TO CLAIMS
THAT HELPED IT - a measurement offered in support is still a
measurement, and the pin question is not an accusation. Its recorded
assumption (it READ the retraction's six-for-six rather than re-running
it, the same posture that produced the error) is adopted as a P8 item:
the fixed-commit stability re-derivation happens in the detached
worktree alongside the five acceptance runs.

gym-porter's close-out sharpened the day's principle into its honest
conditional form, kept in preference to the slogan: ISOLATION BEATS
COORDINATION WHEN THE SHARED THING IS CHEAP TO COPY - a lock makes
everyone wait and fails open when someone forgets; a copy makes the
question not arise; and it would not generalize to something expensive
to duplicate. Its watch item for its own lane is noted: the exam bank
will eventually compare commits across history, which is exactly where
unpinned cross-time comparison could bite next.
## 2026-08-16 18:45 - Gate governance ruled; the D-0032 pattern ships as a module

GOVERNANCE RULING on the scanner gate, from the verifier's EMISSIONS
enumeration surfacing that a report-only agent owns a live CI gate
(gate-scanner-plants.mjs at ci.yml:70, executed by every lane's push):
the split it proposed is ADOPTED. The scanner's threshold and widening
are gym-porter's (it owns the scanner); the plant set is the verifier's
to extend; EITHER change goes through the leader and belongs in a
freeze window like any other gate change - a fifth plant shape is a
change to a gate other lanes depend on, never a casual append. The
verifier's line worth keeping: of its emissions, the markdown is read
by people who go looking; the .mjs is executed by every push whether
anyone is looking or not.

THE D-0032 PATTERN shipped as a tested drop-in module rather than a
diff (docs/verification/p4-mutations/d0032-pattern.mjs, 45b0334):
init-miner's mutate-all.mjs is NOT IN THE TREE - it lives uncommitted
in session scratch - so a diff would have been written against guessed
bytes. The module carries private-copy-by-default, structural refusal
with loud override, the three-hash assertion, a self-test driving all
four outcomes (killed, survived, dead-anchor, restore-failure), and
NAMES ITS OWN BOUND: the restore writes back the captured original, so
a mid-run meddling test is corrected, not detected. Relayed to
init-miner by the leader (lane sessions cannot address each other
directly). CONSEQUENCE RULED: init-miner's battery must be COMMITTED
under its evidence scope - an uncommitted battery cannot carry a
demonstrated refusal or be reviewed, and D-0032 compliance that lives
in scratch is a claim, not bytes.
## 2026-08-16 18:35 - The drift is retracted; the race is traced; clause (i) goes to worktrees

TWO CORRECTIONS ARRIVED IN ONE ROUND, pointing opposite directions, and
the record now holds both (D-0032 addendum 2).

THE EXTRACTOR RETRACTED THE CHUNK DRIFT, and the retraction is the
build's best self-correction to date: the 44 and 45 were two error
messages read at two different times with no pinned commit, straddling
9056789, which moved the file's chunk totals by hundreds. At any fixed
commit: six-for-six identical counts, byte-identical decision lists
over six fresh fixture copies. Its three confessed method failures are
kept verbatim in the retraction artifact: unpinned cross-time
comparison in a repo where four lanes commit hourly; RUNNING THE RIGHT
CONTROL AND NOT BELIEVING IT (the clean-tree 18-for-18 was the whole
answer, recorded as one datum among several); and a lever that
discriminated nothing (a longer run is also a wider window for a
concurrent writer). Report 18 was right about the drift; report 19's
second mechanism rested on the bad datum. The verifier writes the
correction into its own report chain, citing the retraction artifact.

AND YET A SECOND MECHANISM EXISTS - verifier report 20 traced it fully,
which is why the two corrections do not cancel: rpc-surface.test.js's
surface sweep fires gatesDiscover and initBrain as UN-AWAITED JOBS
against the file's single shared temp repo; twenty-two later tests use
that repo; the discovery job's write lands wherever contention puts it
(CI is slow, hence CI is where it fired; fast local machines win the
race, hence nobody reproduced it). The read-back content matched
gate-discovery.js:334 character for character. The graver half of the
finding: this class produces GREEN THAT MEANS NOTHING as readily as
red, in the file whose job is proving the frozen contract is wired.
The verifier's refuted prediction is the epistemics worth keeping: a
mechanism-specific conditional could be killed by one CI occurrence;
"this test looks fragile" would have been unfalsifiably right.

FIX ASSIGNED to the extractor (its file): the sweep gets its OWN
throwaway repo - remove the sharing, never sequence around it - plus
un-awaited work must not outlive the file (sweep cancels or its own
cleanup is asserted), plus the pattern check across the four other
gates.yaml-touching test files (init-gates, init-pipeline, rpc-events,
rpc-spend) so this is known to be instance or pattern.

CLAUSE (i) SHARPENED A FOURTH TIME, adopting the extractor's procedural
point: the five acceptance runs execute in a DETACHED WORKTREE at the
pinned commit ("npm test passes" on a shared tree describes an instant,
not a commit), with the prior assertions retained as corroboration and
the report-20 fix required to land BEFORE the runs, since a
load-dependent race cannot be excluded by five quiet-machine greens.

gym-porter ruled its lane OUT as the gates.yaml writer in bytes (no
write calls; every gym test writes under mkdtemp; clause 19 enforces
the property on every run) - consistent with report 20, which found the
writer in the discovery job. Ruling a lane out cheaply because its
owner can is the negative-result habit working as intended.
## 2026-08-16 18:25 - Conversion verified by the strong instrument; envelope gains a line

The verifier verified gym-porter's D-0032 conversion with the
instrument its own audit demanded: NOT before-and-after (documented
blind to contained windows) but CONTINUOUS SAMPLING - 91 shared-tree
digest samples at 0.5s intervals across the whole 77-mutation battery,
zero differing, ends identical. The untouched property holds against
the strong instrument. Second unplanned counter fire noted for the
record: converting to a private copy broke $0 resolution and the F81
declared-vs-executed counter caught it on the first run - the guard
firing on the very change that could have disarmed it silently.

gym-porter wrote the containment bound beside its own digest check
(ab7ceee) unprompted: the digest proves the tree unchanged AT THE ENDS;
the containment is the private copy, which works by there being no
window, not by catching one. Its offer to write the D-0032 diff against
init-miner's mutate-all.mjs (written, not landed, theirs to accept or
refuse) is ACCEPTED - the pattern moves as a reviewable diff instead of
a pointer.

PROTOCOL ADOPTED, from gym-porter's caveat on the externalized-cost
lesson: the worker return envelope gains a fourth line - EMISSIONS:
what does this change write, and who else reads it. The testable form
of the lesson (ask what an instrument writes and who reads that) would
have found the battery defect in a minute; audit-your-emissions joins
audit-your-inputs. Effective for all lanes from next report.

Verifier's P8 posture confirmed: it will re-read all nine clauses at
claim time rather than from its earlier audit (three have moved), and
will specifically check clause (e)'s seeding goes through the import
API rather than a direct insert - "the storage layer accepted this"
versus "someone wrote a row".
## 2026-08-16 18:15 - CI evidence resolves one defect and exposes a third cause

TWO LEADER CORRECTIONS FROM RAW CI LOGS, both dated here.

CORRECTION 1: the "Event loop is closed" defect was MISCHARACTERIZED by
the leader as a surviving test failure. The raw log of the one run that
showed it (81ee2b8) says otherwise: it is a PytestUnraisableExceptionWarning
at garbage-collection time (proto.pipe.close() in unix_events.py after
the loop closed - Linux pipe-transport finalization, consistent with
tui-builder's macOS-vs-Linux lead), and the test that actually FAILED
in that run was the wall-clock concurrency assertion (184ms against a
~180ms threshold), the exact flake ad161b0 fixed structurally.
ad161b0 is NOT an ancestor of 81ee2b8: the "it survived my fix"
observation was from a PRE-fix run. Since ad161b0 landed, the tui job
is green in all seven runs. tui-builder's finally-gap fix (5dcf760, two
socket tests closing outside finally) targets exactly the warning's
class and is kept. The 3.12-not-the-variable reproduction (290 pass on
the exact CI pairing, forced-failure probe clean) was correct work
handed over honestly.

FINDING: A THIRD CAUSE EXISTS. The d86a2c4 run's ENGINE job failed on
rpc-surface.test.js:182 "gates are data: set writes the file, get reads
it back" - the exact test the verifier flagged as predicted-under-the-
battery-mechanism - and it failed IN CI, a fresh single-checkout
container where no battery can possibly run. The failure content:
gatesSet wrote the user's literal content, gatesGet read back the
GENERATED discovered-gates header, meaning something rewrote gates.yaml
between a set and a get milliseconds apart. The battery mechanism
cannot produce this in CI; the verifier's prediction becomes the
discriminating instance it hoped for. 574/575 in that run. Assigned to
the extractor's nondeterminism hunt as a second data point beside the
chunk drift (both smell of async ordering against shared paths inside
one suite process); the CI log is preserved evidence.

INIT-MINER'S D-0031 INVARIANTS LANDED (9056789, d46f53e): the brain is
durable markdown that the pipeline READS BACK (the index is a function
of the files, proven by reindexFromBrain and a sourceArtifact field only
the file reader writes); the contract-never-enters-the-store invariant
is asserted at the ingest boundary with four plants and a passing
control. Four silent-loss defects found by building: sub-heading
truncation invisible to id-based checks (round-trip now compares
CONTENT), producer shape divergence (both now emit h1+body, which makes
generated brains hand-editable without migration), heading-only records
failing their own round trip, and meta fields silently not crossing
(every marker attribute now consumed by something named). Two surviving
mutations were fixed by adding the coverage they exposed, not by
adjusting the count. errors.md is written EMPTY deliberately: absent
reads "not implemented", empty reads "nothing learned yet", and the
second is true. Its commit technique (add -N + commit -F -- paths) is
adopted into D-0026 as the standing form.

GYM-PORTER'S THIRD ITEM LANDED (3bbd571): every mutation hashes its
file three times; mutated-must-differ catches dead anchors, restored-
must-equal catches corrupted restores, and BOTH assertions were
demonstrated firing against a probe copy before being trusted - "a
check that has never been seen to fail is not yet a check" applied to
the fix itself.

OPEN RULINGS ISSUED THIS ROUND: init-miner re-measures P3.5 numbers
after the shape normalization (zero-spend, minutes; re-derive beats
infer) and restates the hook gap for ruling; its battery must carry the
D-0032 refusal structurally, demonstrated once. The p4 battery stays
OUT of per-push CI (evidence instrument for freeze points; CI never
invokes it, so the in-place override cannot be an accidental default
there); revisit if it ever joins CI.

GYM-PORTER'S D-0032 CONVERSION LANDED (391d806): the battery copies
src/test/package.json to a temp dir, links node_modules, mutates THERE;
in-place survives only as a loud explicit override. Untouched is
MEASURED: shared-tree digest identical before and after all 77
mutations, 77/77 killed, and the check lives in the captured output.
Its instrument caught two breaks the conversion itself introduced
(third catch each), yielding a named lesson: an anchor on a value that
is SUPPOSED to change is a stale anchor waiting; anchor mutations on
the mechanism, not the data. Also named for the general record: a tool
whose cost is externalized (every consequence lands in someone else's
test run) is one nobody is positioned to notice. Remaining unconverted
battery: init-miner's mutate-all.mjs.

STORE-ADAPTER'S D-0031 INSTALL SIDE LANDED (715ae71): dry run 80/80,
suite 584/584. brainDatabasePath left adapters entirely (layout is the
extractor's exported resolver; one key, one owner); the legacy repoPath
default now THROWS instead of silently splitting daemon and store onto
different files. The uninstaller speaks the three lifetimes (authored
.daijin, regenerable index/, unrepeatable records/). Clone question
answered: clones SHARE the id because the id keys records/ and
score-history is a property of the project; refinement offered (each
history entry stamps origin path + index digest so mixed checkouts
cannot fake a smooth series). A mutation that deleted nothing was
reported and discarded as evidence, correctly.

EXTRACTOR: found retrievalScore and diagnose DEAD against any real
brain (project: null, refused by name in retrieve.js; every unit test
injected the scorer) - fixed fd2afb0, and the generalization is now
D-0033: a method whose only tests inject its seam has not been tested
against reality. Built the P8 fixture repo (deterministic 6-commit
history, real init 32.6s, floor 25/25, permuted control 13/25 = 12
cases of range, better gauge than portfolio-mine) and the seed-rubric
script (real API, real validators, honest header). Suite at 586.

THREE RULINGS ISSUED, all amended into the plan BEFORE acceptance runs:
(e) the rubric is SEEDED through the real import API; the claim is
"graded axes render from real storage", never "the gym grades" -
grader-produced rubrics belong to the owner-gated live half. (h)
tui-builder's real-terminal measurement CORRECTED its own repaint claim
- coalescing does not change cadence (Textual already batches); it cuts
bytes-to-terminal 15.5% (10.8-18.9% across four paired runs), exactly
zero at an instant stream; the registered claim is byte volume, not
cadence, and the 34-to-3 number was function calls. (i) third
sharpening from the verifier auditing ITS OWN contribution: the
before/after hash cannot see a window fully contained inside a run (in
the measured environment the common case, so report 18's rate was a
floor); the clause adds a cause-level no-battery-executing assertion
with the hash check's bound stated.

VERIFIER's attribution sweep found FIVE affected attributions, not two
(docs/verification/verifier-attribution-corrections.md); no verdict
moves. The durable discipline, adopted: an observed red gets exactly
one of three labels - caused with evidence, attributed by another party
and named as theirs, or UNEXPLAINED. "In-flight lane work" was a
fourth, invented label that read like an explanation so nobody asked
again. And the transferable question, from its hash-hole self-audit:
what would this check look like if the thing it measures were absent?
If the answer is "identical", ask what fits between the samples.

P8 now waits on exactly: init-miner's mutate-all.mjs conversion +
D-0031 canonical-brain round, the extractor pinning the chunk drift,
and tui-builder's live-half runs on the now-existing fixture.

## 2026-08-16 17:54 - The flake is pinned (D-0032); reports 18 and 19; CI green

(Stamp note: this entry is newer than the 17:58 entry below despite the
earlier stamp; that stamp ran a few minutes fast. Insertion order, newest
first, is authoritative. Also correcting a record gap: report 18 and D-0032
were recorded in decisions.md and the plan but never here; this entry
covers both reports.)

VERIFIER REPORT 18 pinned the 1-in-5 suite flake: mutation batteries
mutate the SHARED WORKING TREE in place (copy aside, break, test,
restore), and every mutation is a window where any concurrent process
reads deliberately broken source. Two-arm experiment, 38 runs, 18-for-18
separation by starting source hash; an immutable snapshot ran 10-for-10
clean at the same code; a battery was caught mutating live. Ruling
D-0032: batteries run against PRIVATE COPIES and refuse when the target
resolves to the shared tree absent explicit override. The gravest
consequence, now in the record: every retry-until-green during the
battery era was indistinguishable, from the record, from a real
regression retried away. init-miner's ordering-bug hunt stood down (the
tree under its tests was lying, not its code); its regeneration test's
authority restored. P8 clause (i) sharpened a second time: each of the
five runs asserts the source hash is stable across the run, captured
before and after.

VERIFIER REPORT 19 closed gym-porter's two "unexplainable" pure-function
cases and CORRECTED one part of the report-18 relay. The cases: purity
is a property of execution, not of load; a pure function imported from a
mutated file is a mutated pure function. Demonstrated, not argued: one
battery-style mutation to src/gym/exams.js failed exactly the two named
cases together (finding 77 + P7 clause 4, same module), hash-verified
and restored. The loop closes on itself: gym-porter's own battery
(p4-mutations/mutate.sh, defaulting to the live engine) is what made
gym-porter's pure-function tests flake. Resource pressure is NOT needed
and that hunt is stood down. THE CORRECTION [2026-08-16]: report 18's
dissolution of the chunk-count drift was overbroad and I relayed it as
total; report 19 establishes TWO mechanisms, neither subsuming the
other. The extractor's init-lane nondeterminism (chunk count 44 to 45 on
an ISOLATED fixed-content fixture, timing lever moving it 1-in-3 to
5-in-6) cannot be produced by tree mutation: a mutated source fails a
test, it does not drift a count on an isolated fixture. Consequence:
fixing either mechanism alone leaves the npm-test gate unsound; a clean
run after one fix only establishes that no battery was running. The
verifier also reported its own process error (a String.replace no-op
producing evidence from a mutation that never happened, the exact F81
lie class, caught because a PASSING test was the wrong answer for its
hypothesis) - the argument for counters over conventions, from the
person who knew better and still walked into it.

Ownership settled: mutate.sh conversion is gym-porter's (assigned in the
report-18 dispatch; verifier is report-only and rightly did not touch
it). The isolated-fixture chunk drift needs a pinned cause: assigned to
the extractor (its instrumentation, its lever); the fix, if in init-lane
code, lands via init-miner after its D-0031 round.

CI: the full pipeline is GREEN on the evidence-exemption commit (tui,
engine, install-dry-run, hygiene; run watched to completion, GH_EXIT=0).
Honest bound: one green tui run does not close the "Event loop is
closed" defect; by this project's own lesson it may only mean this run
overlapped no bad interleaving. tui-builder's Python 3.12 chase stands.

The extractor completed all four items. The relocation's design call is
the regeneration test applied independently: the state root splits into
index/ (disposable: brain.sqlite regenerates) and records/
(machine-scoped but NOT regenerable: score-history was measured by this
machine's embedder on a date and nothing recomputes the past). Not
moved, correctly: gym.sqlite and results (the record), goldset.yaml
(the gauge), GATE (machine-local authorization cannot be a committed
record). Identity is repoId in manifest.json with origin.json
disclosing clone-versus-move divergence; one id per project ratified.
The delete-index-read-everything-back invariant is EXECUTED as a test.
Roles: engineer wired to glm-5.3 via the ZAI key file, all by pointer,
no value anywhere; ONE OVERRULE per the owner's instruction: the
watcher moves to the SAME ZAI key (owner said same key for both), model
left null because naming a model is a cost decision. keyRef ambiguity
resolved by shape and adopted into the contract (lowercase-relative
refused as the shape of a pasted key; keyResolvable/keyReason on role
rows). The graded branch proven end to end through both lanes' real
code (scrambled key order in, canonical list out).

BLOCKING P8: a 1-in-5 suite flake, a different test each time, across
lanes, reproducing at concurrency 1. The extractor's framing is the
assignment: a suite failing one random test in five runs quietly
converts the npm-test gate under every claim into a coin flip, and at
P8 a flake reads as an integration failure. The verifier is
characterizing under a controlled protocol (quiet tree versus active
tree); owning lanes fix on its attribution.

## 2026-08-16 17:48 - P3.5 PASSED; finding 82; the per-corpus sharpening

Verifier report 17: PASS, with the same-construction requirement
verified in the strongest available form (one diff line between the two
run scripts, the arm selector; permuteAnswers promoted to shared engine
code, the requirement now structural rather than procedural). The
verifier corrected its own check-4 language: the saturation mechanism
BOUNDS rather than predicts (right direction, right arm ordering,
understates the level in both arms, systematically, across corpora 23x
apart), because a permuted answer is a gold answer for some other query
and such units are semantically central (5.7x random rate on the
curated arm); consequence in the safe direction: the reported
discriminating range UNDER-estimates the gauge's real range, the
correct direction for an instrument's error to run. FINDING 82: the
survival diagnosis contradicted its own artifact (no truncated core
exceeded the cap; the TOTAL BUDGET bound at 89 percent consumption; 3
units not 4; the 1625 was the corpus max), and the two diagnoses imply
OPPOSITE fixes, so the text is corrected before any user sees it.
RULING SHARPENED from its question 2: the budget sweep is PER CORPUS,
not per repo (D-0003's correct form); the adopted brain gets its own
sweep with the D-0030 range beside each point, because a chosen budget
is measured on the brain it serves, never inherited from a sibling. The
title-ownership premise guard (homes.length !== 1 emits no case rather
than an arbitrary answer) was the line the verifier most wanted to
find, and found.

## 2026-08-16 17:44 - P3.5 MEASURED: curated 20 cases of range, generated 7

The curated-versus-generated question is answered on one repo, one
embedder, one code path, both controls from one construction: the
CURATED brain (257 units) carries 20 cases of discriminating range
against the generated brain's 7, while the raw rates (24/25 vs 25/25)
say almost nothing, which is the pre-registered metric earning its
place. Granularity does NOT explain the gap and the prediction that
curated units run large died in public (median 95 tokens, SMALLER than
generated; a hand-written errors.md is one-paragraph records; the
1000-1250 figure is a property of the platform's brain, not of curated
writing); CORPUS SIZE explains it (7 of 257 is 3 percent, 7 of 11 is 63
percent). Where size does bite is the tail: the largest curated unit
(1625 tokens) fails content survival against the 660 cap, ruled
REPORT-NOT-MUTATE (the adopt path never silently edits a user's units;
the four units are named to the user). The closing insight of the P3
arc: a generated brain is mechanically measurable BECAUSE it is
generated (one home per fact by construction); a curated brain is
measurable only through non-leaky seams (title ownership, path
self-reference), with paraphrase queries staying behind the auditor's
spend boundary as planned. Finding 80 fired only where it should
(saturation warning on the generated arm alone, one threshold, one code
path). The delivery correction moved AGAINST the mechanism (6.96 of 11
over all 25; predicts 0.63 vs 0.72 observed) and is stated loudly; the
verifier re-judges its check 4 against it. The FOURTH sweep exposed the
hook's shared-path blindness (one lane plus foreign shared files reads
as one lane), ruled and fixed: evidence directories lane-mapped,
unmapped verification paths refuse. Verifier attacking P3.5 now;
init-miner proceeds to the D-0031 brain-artifacts round.

## 2026-08-16 17:40 - D-0031 audited: invariant 1 true, unguarded, and a race

The verifier audited the one invariant D-0031 claims already holds, and
named WHY it holds: two incidental mechanisms, neither a rule (the
generate path constructs units rather than collecting files, so there
is nothing to exclude; the adopt filter's prefix cannot reach
.daijin/agents because contract and brain are currently SIBLINGS). The
mandated refusal test has not landed, so the invariant is true and
unguarded, exactly the state the ADR calls the problem, and invariant
3's canonical-artifacts work is what ends the incidental safety by
putting contract and brain under one root. RULED into init-miner's
in-flight round: the guard is a property of the INGEST BOUNDARY (no
unit's source path under agents/ or equal to manifest.json, driven by a
plant), not of the adopt filter; and the delete-and-regenerate test
asserts the PERMUTED CONTROL scores identically too, since a subtle
retrieval change could hold a saturated 1.0 while moving what the gauge
discriminates. The corpus-expansion deferral is now a standing
tripwire in the verifier's words: any widening invalidates every
measured number in the build until re-measured, however good the idea.

## 2026-08-16 17:37 addendum - The principle sharpened, with its honest bound

The verifier sharpened unrepresentability's mechanism: a refusal HAS TO
BE REACHED, so "is this guard on every path?" needs re-answering after
every refactor; a parameter that does not exist is on no path and the
question stops being askable. The first kind decays under maintenance;
the second does not. And the bound that keeps the principle honest:
elimination only works when the dangerous input has NO legitimate use;
certify's verdict could not be eliminated because a caller genuinely
needs to assert one, so it became a checked assertion, and the nine
constructed refusals are the cases where enforcement is the only
available answer. Also: F81 re-verified with the case that found it
(counts 2 then 3), the partial-rubric wire case singled out as the
harder one (an empty object is obviously nothing; one axis with a real
score LOOKS like a grade), and gym-porter's defect framing adopted over
the verifier's own: the only way to catch a check that agrees with
itself is to ask what it would do if the thing it measures went missing.

## 2026-08-16 17:35 - Certify delta PASS; the first unplanned guard fires

Verifier report 16, no findings: the contradictory verdict refused
naming both sides (the caller's verdict framed as an assertion checked
against the record), rubric-less certification refused, and the
rubric_id linkage confirmed as the point: snapshot-agreement becomes a
query anyone can run later, not an assertion that weakens the moment a
rubric is replaced. The verifier failed to construct a valid
certification six times and censused NINE distinct refusals by tripping
them (with the honest bound that construction finds what you trip), the
ninth being the one nobody would think to check: an uncontextualized
pass is not reproducible, so a certification carries the harness
provenance it was earned under. The absent-is-not-empty flag
({computed: true, ids: []} accepted, {ids: []} refused) verified from
the inside. MILESTONE, in the verifier's words: the scanned-set test
catching src/state and the skip counter catching its own stale anchor
are the first two cases in this build where a guard caught something
its author did not plant: the transition from shown-capable-of-failing
to actually-failed-usefully, the evidence the mutation discipline is
doing work rather than performing.

## 2026-08-16 17:33 addendum - The regeneration test, sharper than record-vs-derivation

gym-porter refined the invariant-2 ratification into the test future
storage decisions use: ask WHAT REGENERATES A STORE, not what a store
feels like. The index regenerates from canonical brain markdown, so
deleting it loses nothing; the gym ledger has no canonical source above
it, so it is the thing itself. Applied in advance to the harvest-batch
question: proposals derive from rubrics plus gaps (closer to
derivation), but an APPLIED batch records what entered the brain and
when, which nothing above it regenerates, so applied batches are the
record. Harvest storage designs to that test instead of re-running the
argument.

## 2026-08-16 17:31 - F81 landed; the unrepresentability principle named

gym-porter landed finding 81 (test-only delta, re-frozen at 300b63bb)
with the defect's sharpest statement yet: an indented mutation was
invisible to DECLARED while incrementing EXECUTED, so the comparison
read balanced while wrong: not a check that fails, A CHECK THAT AGREES
WITH ITSELF AND IS WRONG. The storage/wire boundary moved from
documented to PINNED (an end-to-end test through the daemon's real
axesFor proving stored empty axes render null on the wire, a mutation
proving the net can fail). And its closing generalization is adopted
into the record as a design principle: ELIMINATION BEATS REFUSAL,
because a refusal is a check someone can later weaken, reorder, or
route around, while a parameter that does not exist has no path to
weaken; the shape now appears three times in the gym lane (certify
takes no axes, the run table cannot hold a diff-less run for the FK to
reference, the gate module exports no writer that can produce an open
status). Where a rule can be made UNREPRESENTABLE rather than merely
enforced, it has held better, every time it has been tried here.

Also: the certify fix (a881df2) answered the open question plainly
(missed, timing not judgment, accountability stated), fixed by deletion
plus derivation (snapshot copied from the stored rubric, rubric_id
linkage, contradictory verdicts refused naming both, rubric-less
certification refused). CI: the tui job's root cause fixed (engine deps
installed; daemon spawns pass on the runner); one timing-flaky
concurrency assertion remains, routed to tui-builder with the
assert-structure-not-wall-clock prescription. The gym store's exemption
from invariant 2 ratified: it is the RECORD, not a derivation.

## 2026-08-16 17:16 - Persistence check PASS; certify resolved by elimination

Verifier report 15, all five probes: the structural claim held at three
levels including the check that would have made the FK decorative
(foreign_keys = ON at the single connection path, immediately after
open); clause 9 held including the batch row (a surviving grade_batch
with zero rubrics reads as a graded cohort in a count query; nothing
survives); one-rubric-per-run blocked by unique index, not a forgettable
check; the quarantine reaches the rubric table. The certify {} question
resolved WITHOUT the owed answer: certify() has no axes parameter at
all, deriving axes from the stored rubric it already requires;
elimination beats refusal and was checkable directly. The
declared-versus-executed comparison FIRES on its lie class, with one
latent evasion (finding 81, INFO: the column-0 anchor misses indented
mutations both ways; zero instances today; one character class; folded
into gym-porter's in-flight round). Layer boundary documented: storage
can hold an empty axes object from a grading.js bypass, the wire cannot
emit it, validation is grading.js's job by design. The verifier holds
the corpus-expansion deferral as its own enforcement: any widening
invalidates every measured number until re-measured.

## 2026-08-16 13:22 - Owner design correction ruled (D-0031); team paused to 17:10

The whole team hit the session limit (resets 17:10 JST). The leader used
the window to reason, verify, and rule the owner's three-layer directive:
CONTRACT (never ingested; verified already true in bytes, now guarded),
BRAIN (durable markdown, canonical, evidence-cited), INDEX (disposable,
OUT of the repo). Full ruling in D-0031 and a structural plan section;
corpus expansion to raw source deferred to a registered experiment
because corpus composition is part of the measured gauge.

RESUME WORK ORDERS (dispatch on wake, in this order per lane):
- init-miner: FIRST finish P3.5 in flight (the adopt-path test was
  mid-work at the pause). THEN the D-0031 brain-artifacts change:
  scaffold writes .daijin/brain/ markdown as canonical, ingest reads
  from those files, plus the contract-refusal test (agents/ and
  manifest.json can never enter the store).
- extractor: the index relocation (brain.sqlite and machine state to
  the daijin state root keyed by repo identity; serve-repo, daemon,
  and snippet follow), the manifest.json lifecycle in initBrain, and
  the one-line attemptsForExam change (queued pre-pause). Then role
  config: student and watcher from the platform's existing key BY
  POINTER (no value enters this repo); teacher and auditor await the
  owner's keys.
- adapter (on call): install smoke and dry run follow the index
  relocation (the state-root layout changes).
- gym-porter: answer the certify {} question (queued pre-pause); then
  hold for the verifier's persistence check.
- tui-builder: SocketRpcClient, then motion; the repo-home cards
  follow the manifest/brain split when it lands (brain browser reads
  canonical markdown, not only search).
- verifier: the persistence-round check (queued), then P3.5's report,
  then D-0031's invariants join the attack surface (the
  contract-refusal test and the delete-the-index-lose-nothing property
  are both falsifiable and should be attacked as such).
- Owner items pending owner: teacher/auditor keys; the claude-code
  provider sub-agent spec; the live gym cycle authorization.

## 2026-08-16 13:14 - Polish strands 1-2 landed; finding 79 verified closed everywhere

tui-builder's concurrency strand: boot screen blocking cost 635ms to
142ms at the 60ms/call rank (4.5x), all-views total 2.5x, cap living in
RpcClient (MAX_IN_FLIGHT 5, provisional, recorded with its remeasure
basis for the transport doc). Its confession joins the one-rule list: the
first cap tests asserted peak <= cap, which passes exactly when the cap
has been removed; mutated to 500 they stayed green; now they assert the
cap BINDS, and the lesson was propagated to the extractor for any
server-side limit test, since the natural phrasing is the tautological
one. Strand 2: workers and skeletons, the settings screen painting with
its indicator at 304ms while data lands at 881ms; a real banner bug found
and fixed (a confirmation overwritten by the refetch it triggered;
user actions are events, not state); a static schedules-without-awaiting
guard replacing a hang with a 0.02s readable failure. 249 tests.

Finding 79 verified closed by the verifier, driven not awaited: all
three ruled states produce the ruled value, plus its own fourth probe (a
rubric carrying an empty axes object, the input closest to the forbidden
value, returns null), both paths routing through one function so neither
drifts independently, and the stale comment replaced by a dated note.
The verifier's closing observation is the next era's default suspicion:
the findings that mattered were almost all in INSTRUMENTS, not
mechanisms; the mechanisms were generally right; what needed attacking
was the machinery that was supposed to prove them right. P3.5 gained one
pre-run requirement: both brains' controls built by ONE construction, or
the comparison measures the permutation rather than the brains.

## 2026-08-16 13:12 - Two principles named at the close of the verdict era

1. gym-porter's unification, one rule where the build kept finding three
costumes: the boundary check that only demonstrated its passing branch,
the step-0 test that passed for a reason unrelated to the step, and the
positive control that matched four alternatives at once are ALL the same
defect, A CHECK THAT CANNOT FAIL FOR THE REASON IT CLAIMS TO TEST, and
each was found by an instrument rather than by reading, which is the
argument for the instruments. 2. Its governance corollary, adopted as
standing: WHICH OF AN AUTHOR'S OWN OPEN QUESTIONS GET CLOSED IS A
LEADER'S CALL, never the author's, because an author choosing is the
same conflict as an author grading their own exam ("I would not have run
the reconstruction if it had been mine to decide whether it was worth
running"). 3. The verifier's pin logic on the P7 alignment is the model
for doc-only claims: the tree-sha being identical across a window that
SPANS the change verifies doc-only more strongly than reading the diff;
and it executed the handover snippet itself, noting the frozen AXES
export gives the canonical order the same single-source property that
made the branch table work. Verification debt remains zero; rubric
persistence, P3.5, and polish are the open work.

## 2026-08-16 13:10 - P7 CLOSED: every registered phase now fully accepted

Verifier report 14: findings 77 and 78 closed, verified by re-running the
INSTRUMENTS THAT FOUND THEM unchanged against the fixed code (the
strongest delta check: no opportunity to soften the test to match the
fix). 77 closed without over-correcting: both evasions refuse AND the
three allow cases still allow, since a normalization collapsing too much
would refuse genuinely independent graders, the same failure inverted;
the full URL matrix verified RFC-correct on both sides (host and scheme
case collapse, path case stays distinct). 78 closed with the counting
method now an ENFORCED PROPERTY the verifier attacked itself: removing
either new control fails the property by name, and the named-branch
table as the single source both the pattern and the property read is,
in the verifier's words, better than what it suggested. The battery's
skip-equals-problem hardening verified by exit-code contract; the plant
instrument still exits 0 against the current scanner, the standing
commitment held. Full suite 518/518.

FINAL SCOREBOARD: P0 P1 P2 P3 P4 P5 P6 P7 ALL ACCEPTED, every one
through pre-registered acceptance and adversarial attack. Outstanding
work: finding-79 implementation (three lanes, verifier checks when
landed), P3.5's curated-versus-generated measurement, the polish pass,
the TUI-daemon integration pre-registration, and the owner-gated live
gym cycle. The narrow-scanner reconstruction settled the last open
historical question; D-0025 is closed with both arms measured.

## 2026-08-16 13:08 - The narrow-scanner question, settled by reconstruction

The record had marked the narrow-versus-widened comparison unanswerable;
gym-porter settled it while holding, with zero repo writes, and first
CORRECTED the record's premise: the narrow scanner was never committed at
all (the repo's first commit already carries the widened one), so the
original bytes never existed anywhere. It reconstructed the narrow design
from its own report and ran the VERIFIER'S instrument against it: 1 of 4
plants caught, control clean, and not merely the same count as the
verifier's original run but the SAME one caught and the SAME three
missed, plant by plant. Two independent artifacts built from one design,
agreeing exactly. Its own summary is the record's: the arbiter's decision
to widen was correct ON THE EVIDENCE, not on authority; my argument has
now lost twice, once on a reconstruction I built myself while trying to
give it its fairest hearing. The surviving fragment of that argument is
correctly relocated: a rule everyone learns to silence is worse than one
that fires honestly is why the widened design carries a CHECKED allowlist
and an innocent-writer bound, the argument earning its place inside the
winning design rather than against it. Honest bound stated: a
reconstruction measures the design as described, not the artifact as it
ran, and the script is offered for attack rather than belief.

## 2026-08-16 13:05 - P6 ACCEPTED: delta PASS, no findings, both breaks defeated

Verifier report 13, pinned to the install subtree (0 dirty at both ends):
full dry run reproduced at 73/0. Break attempt 1 (can the bare completion
line print without a ready probe) failed on THREE independent counts:
state initializes unknown not ready, the probe is unconditional, the exit
mapping's wildcard sends every unexpected exit to unreachable, and the
bare line gates on ready exactly. Break attempt 2 (mock passing while the
real path is broken) failed against the REAL dependency: the verifier ran
the shipped probe against its own live Ollama, confirming the tag-suffix
resolution end to end, and verified the mock is minimal on exactly the
consumed fields, fidelity not convenience. Finding 75's refusals driven
independently (nodeless PATH, v20 node) with the named-path promise
demonstrated, and the control-on-the-control present (node genuinely
hidden, so the refusal test is not vacuous). Finding 76 closed stronger
than asked: settings-not-merely-emptied and the uninstaller saying where
kept data lives. Clauses (g) and (h) are met and verified; P6 CLOSES.

SCOREBOARD: P0 P1 P2 P3 P4 P5 P6 ALL ACCEPTED. P7 pending its delta
check. P3.5, polish, finding-79 fix, TUI integration in flight. Live gym
cycle owner-gated.

## 2026-08-16 13:03 - THE PRODUCT LOOP IS CLOSED: init builds, the floor gates, MCP serves

The extractor's MCP serve entry (a6b8764) closed the loop and proved it
live: a real brain built with the real embedder, served over MCP stdio,
searched by an agent-shaped client, returning web.decision.adr-0040
first for a why-question. Two finds on the way: the SNIPPET WAS BROKEN
(mcpSnippet pointed at the P1-era corpus-descriptor entry, so the 75%
unlock handed users a paste-ready failure, worse than a locked snippet
because the user believes it), found by running the command the snippet
prints; and a FIRST-BOOT defect (embeddingIdentity required a digest no
fresh machine has; now discovered from the served model at index time,
which gives the index something to pin without weakening the assert,
since the assert compares the RECORDED digest on later queries and a
configured digest still wins). New standing test class from the first
find: anything we hand a user to paste is executed by a test. serve-repo
fails early and by name (no brain: "Run init first; there is nothing to
serve"), because a server that starts against a brainless repo answers
every search with an error from three layers down. The lane map gained
the extractor's test-file entries; the reranker server is down.

## 2026-08-16 13:01 - P3 ACCEPTED; finding 80 ruled; D-0025 closed both arms

Verifier report 12: P3 PASSES with the control surviving all five
pre-registered checks. Check 1 found the construction stronger than
demanded (a guaranteed derangement via answer-id exclusion); check 4
confirmed the mechanism PREDICTS the observation (7.6 of 11 delivered
predicts 0.69, control observed 0.72). Clause (f) held under maximum
pressure in the unregistered direction, and the verifier's sentence is
the build's epitaph for it: a perfect score volunteered as uninformative
is the strongest evidence of method honesty in this build. Finding 80
(the 0.75 MCP unlock sits 0.03 above a deliberately-wrong gold set)
ruled report-not-refloor: the unlock stands, its report carries the
control range with an explicit saturation sentence, control-distance
gating recorded as the auditor-era question; the 7.6 figure re-measures
over all 25; P3.5's metric pre-registered as DISCRIMINATING RANGE before
the run. D-0025 closed with both arms measured (platform neutral-on-
enforced with the D-0017-distrusted MRR-only rise; portfolio neutral per
the amendment; cold cost 6.7-15s/query vs 0.24s; the cache-flattered
number withheld). The hook's two gaps fixed per the adapter's
prescriptions (unmapped refuses and names itself; false-refusal mappings
added). Reranker server stopped.

SCOREBOARD: P0 P1 P2 P3 P4 P5 ACCEPTED. P6 delta and P7 delta pending
verdicts. P3.5, polish, MCP entry in flight. Live gym cycle owner-gated.

## 2026-08-16 12:52 - P7 verdict: PASS with two required follow-ups, both instruments

Verifier report 11, pinned to gym subtree sha 8ee45504 (0 dirty in scope
throughout while repo HEAD moved twice under it): mechanisms hold. The
withheld-document refusal confirmed as a real composition (grading reads
the exclusion record from the artifact and refuses an axis citing a
withheld id, naming both); clause 19's checked exemption fired on all
three planted holes; zero spend re-derived; counts reproduced exactly.
Two findings, both the phase's own subject one level up (a control
passing for the wrong reason): 77, agentIdentity does not casefold or
normalize, so GLM-5.2 vs glm-5.2 or a trailing endpoint slash evades the
independence refusal on ordinary accidents (fix: normalize, with both
evasions as cases; served-model-id keying recorded as the live-half
strengthening); 78, two PROVIDER_CALL alternatives had no dedicated
control (the router shape also matched API_KEY, lowercase api_key had no
shape). RULING: accepted-with-required-follow-ups, the P4 shape; both
land as one delta commit, verifier delta-checks the two, P7 record
closes then. The verifier's drop-each-alternative-count-broken-controls
method is the new standard for multi-branch pattern controls. Standing
pattern named for the record: instruments deserve the same adversarial
treatment as mechanisms, recursively.

## 2026-08-16 12:46 - P7 built and frozen; gym RPC live; rerank measurement running

Three lanes converged: (1) gym-porter built all 21 registered P7 clauses
(122 gym tests, 61 mutations killed, one honest survival: a positive
control matching four scan branches at once, a gate that cannot fail one
level up, rewritten per-branch). Design wins recorded: clause 4 keyed on
model-and-endpoint because role-keying could never fire; a refusal the
platform lacks (a rubric citing a document the exclusion withheld is
grading against the gold); the checked-not-trusted exemption pattern.
Frozen for the verifier's attack; rubric/batch tables land with the RPC
wiring jointly with the extractor. (2) The extractor wired the gym RPC:
NO method answers -32001 anymore; gymStart's blocker moved to the real
missing piece (the paid engineer seam) with the refusal naming what DID
work; measurement-protecting refusals kept (empty axes, null denominator,
harness-debug default). Next: the MCP serve entry, the last unclosed
product loop. (3) The rerank backend is provisioned and live (llama-server
plus bge-reranker-v2-m3 at :8012, verified discriminating); D-0025
amended IN ADVANCE (1f912bf): the portfolio-mine arm can only falsify,
promotion decides on the platform corpus only; the real A/B is running.
Suite 503/503 at 03:46Z. Verifier holds three ready-gated attacks: P7
(frozen now), P6 delta (awaiting adapter re-freeze), P3 (awaiting
artifacts).

## 2026-08-16 12:27 - P3 LIVE RUN COMPLETE: 25 of 25, and the control says why that is not the point

init-miner ran the constants-generalization init on portfolio-mine pinned
at 81d453aaf200ecc1c27dfdca6f8b201bb976736a, Layer 1 only, zero spend,
repo read-only and verified byte-identical before and after. Floor 25 of
25 = exact 1, MRR 0.96, 0 violations, chosen budget 3000 from a flat
3k/4k/6k/8k curve, MCP unlocked at 0.75, all five integrity gates passing
before measurement, errors.md empty with 9 fix commits kept as evidence,
one gate candidate classified UNAVAILABLE with its reason named (pnpm not
installed HERE is never pre-broken; pre-broken blames the repo and is a
claim a user acts on). Embedder recorded: ollama/bge-m3 dim 1024, digest
verified equal to the platform's before indexing.

THE NUMBER IS QUALIFIED BY ITS OWN CONTROL and is never quoted alone
(D-0030): the permuted control scores 0.72 because k=8 delivers 7.6 of 11
documents per query. Case rate saturates on a small corpus; MRR still
separates (range 0.8235). The enforced metric loses its discriminating
power exactly where the unfloored one keeps it.

Four defects only the live run could surface, all fixed and
mutation-covered: the selection ramp dropping 10 of 29 candidates (nearly
a FALSE FINDING: two runs blocked at diversity with 19 cases and "the
repo cannot supply 25" would have been wrong); leakage false-positives on
scoped package names; built-ins reported as external packages; and the
existence/staleness deadlock (D-0029). Plus the served-tag versus
configured-name identity mismatch, both sides now derived from one
function. Instrument lesson recorded: two stale mutation anchors read as
SURVIVORS ("18 of 20 killed" was wrong); a mutation that fails to apply
is not evidence either way, and the harness now shouts ANCHOR!! instead.
Also: corpus shape explains everything (73 files but only 6 source files;
11 units, 49 chunks); the architecture-window dilution persists under the
real embedder (86 of 174) and is chunking, deferred for its own decision
after P4. The extractor's workarounds are deleted; process.env asserted
unchanged across a sweep. init-miner's seven files were swept into
df1f99b (D-0026 addition covers it; correcting commit c3ae35f).

## 2026-08-16 12:23 - P5 ACCEPTED: PASS on all six clauses, zero findings

Verifier report 10, the first attack run inside a real hold window and the
first with nothing to report: tui tree-sha IDENTICAL across the whole
battery (db7e9947... at start and end) while repo HEAD moved twice under
it, which is exactly why the tree pin beats HEAD, and tui/ is identical
between b1844a0 and current HEAD so either commit pins it. All clauses
met: 232/232 reproduced exactly; 30 of 30 methods CALLED through the
client with no stale stub text (the one lookalike string checked rather
than counted: it is the honest inverse of finding 68, affirming the
surface and naming the phase, inert by default); both spend directions per
method with the gate default pinned by test; seven keyboard targets and
50 real mouse clicks; the copy gate re-proven LIVE on the frozen tree
with a planted dash firing from composited render; finding 71 confirmed
closed in passing. The verifier's verdict on the suite-composition answer
is the epistemics the project wants: named growth checks out, the moved
assertion strengthened coverage in the place the fidelity ruling
demanded, and the 160 stays a labeled hypothesis, taken as explained
rather than verified. Process note in the verifier's words: every earlier
attack carried a moving-tree caveat, this one carries none, and the
difference is entirely the hold window, which cost one freeze
declaration.

SCOREBOARD: P0, P1, P2, P4, P5 ACCEPTED. P3 pipeline built, live
portfolio-mine measurement pending. P6 open on clauses (g) and (h),
adapter building, delta attack pre-registered. tui-builder unfrozen into
the polish queue: concurrency, workers plus skeletons, SocketRpcClient,
motion.

## 2026-08-16 12:20 - P6 verdict: (a)-(f) PASS; the phase STAYS OPEN on (g) and (h)

Verifier report 9, pinned to commit 5c3ac8f with per-file sha256: the dry
run reproduced independently at 49/0, all four named claims re-derived
(the subshell-exit fix with its mutation, the self-testing dash sweep
attacked beyond its own self-test with a planted dash in a scratch copy of
the SHIPPED README firing correctly, program-versus-state separation, the
deleted-stub property). The coverage question earned its place: clause (g)
is UNMET (no Ollama or embedder mention anywhere in install/, and the
green completion line prints without probing an embedder, the exact
first-ingest failure the extraction report calls the ugliest onboarding
mode), and clause (h) is implemented well but NO check can fail on it (six
check_fails mutations exist elsewhere; none covers a runtime refusal).
Finding 76: clause (e) half-verified (repository brain planted and proven
surviving uninstall; user-level state never planted).

RULINGS: P6 stays OPEN until (g) and (h) are met, the verifier's lean
adopted with its reasoning (a phase accepted with a known-unmet clause
gets remembered as accepted). The (g) fix is PROBE PLUS NAMED MESSAGE,
not documentation-only: install.sh probes Ollama at completion,
non-fatally; present-with-model prints ready; absent prints the named
message with the exact next steps (install Ollama, pull the model) and
the completion line says retrieval is not yet functional; the install
never fails on it (a runtime dependency, not an install dependency) and
never prints a green line implying retrieval works unprobed; README gains
the requirement where a first-run user reads; the dry run gains BOTH
branches with the probe pointed at a mock endpoint, never a live service.
Finding 71's sk-ant fixture was already fixed by tui-builder in its
report-6 round (mk-mock prefix); the install sweep's four-file scoping
stands as deliberate. Adapter unfrozen with findings 74, 75, 76 as its
work order; re-freeze and a delta attack on the new checks after.

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
