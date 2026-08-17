# Daijin build state (authoritative)

## 2026-08-17 16:10 - ULTRAREVIEW 1 of 3 (engine-data): 7 findings, none critical

External review of review-engine-data (store, rag, init; 9,336 lines):
3 normal, 4 nit, 0 critical. Routed to the extractor as findings-not-
fixes; the two instrument findings additionally to the verifier for
evidence-impact assessment.

NORMAL: (1) evidence.js carries three raw NUL bytes as Map-key
separators - git treats it as binary (no diff, no blame, unreviewable
IN THE VERY REVIEW THAT FOUND IT), and walk.js drops NUL-bearing
files, so Daijin initing against its own repo SILENTLY OMITS
evidence.js from its own brain. (2) assertNoContractUnits over-
matches: any agents/ segment fires, so host repos with src/agents/
(LangGraph/CrewAI layouts - exactly the target population) fail
ingest; same overreach for manifest.json (extensions, PWAs). (3)
pgvector lacks the project accessor, making the pipeline's mismatch
guard unreachable - a latent cross-project purge in a shared DB; one
line, mirrors sqlite.

NITS: (4) pgvector standingDocuments does not escape LIKE metachars
(parity break vs sqlite; shipped prefix safe); (5) scoreGoldset
records parityMode from the corpus descriptor not the store - BOTH P2
A/B arms labeled parityMode:true on exactly the axis they differ on;
(6) permuteAnswers can emit must_return:[undefined] when a case
covers every unique id - the D-0030 range silently reads unavailable;
(7) brain-artifact marker serializer has unescaped delimiters, latent
on ASCII, one JSON-encode closes the class.

Fix order: 1 (self-scan corruption), 2 (target-repo blocker), then
3-7. Findings 5-6 get verifier assessment of recorded evidence impact
(P2 labels, D-0030 ranges) - annotate, not re-run, unless a
conclusion leaned on the wrong field. Free runs 2-3: review-engine-rpc
and review-tui-src; test and aux slices deferred as lowest-risk
(mutation-verified all week).

## 2026-08-17 15:30 - Deferred by decision: hello carrying the vocabularies

An option raised by tui-builder, relayed by the extractor with a cost
(forty minutes) so the decision would be made rather than defaulted:
hello could carry the engine's enum exports, letting client gates
compare against the engine instead of hand-copied tuples - closing
the phantom direction for every client, forever. RULED: DEFERRED, to
the first post-release contract iteration (a v6 item), not built now.
Grounds: the hold directive admits work only on a checkable lead or a
shipped defect and this is neither; what HAS fired (clients guessing
unnamed values) is closed; the printed unconfirmed-majority list is a
cheap standing counter; and a contract change on the eve of the
ultrareview reopens the surface the review is about to read. The
counter-argument is recorded WITH the deferral so the v6 decision
inherits it: a vocabulary on the wire makes the class impossible
rather than visible, and clients - who found two of the four named
defect classes - are the population that keeps meeting it.

PROMOTED, tui-builder's severity ranking of the three instrument
defects, which corrects the flat treatment: subset-misses and
mirror-misses FAILED TO CATCH; the harvest under-read ACTIVELY
POINTED AT A DEFECT THAT WAS NOT THERE - and in a build that has
spent a week teaching people to chase findings, an instrument that
manufactures findings is the more expensive failure. False findings
outrank missed ones.

Board remains quiet at a6081d6 plus this entry. Ultrareview next;
D-0034 after; hello-vocabularies first on the post-release list.
## 2026-08-17 15:10 - Quiet mark moves to a6081d6; the convergence bound stated

Bookkeeping: the tip is a6081d6 (CI 31971991954 green), one past the
quiet mark - third race between close and landing, and tui-builder
took the fix as its own (tip sent BEFORE going quiet from now on).
a6081d6 is the mirror finding applied to its gate, landed as a BOUND,
not a fix: its reachability gate compares the mock against hand-copied
tuples, so BOTH halves are its own - it proves mock-agrees-with-file
and nothing about the engine, and a phantom would sit in both halves
and pass twice. Stated where the constants live, with provenance (of
four baseline statuses, exactly ONE observed on the wire), and the
only closable half closed: the live run fails on a value its set does
not document and PRINTS THE UNCONFIRMED MAJORITY every run, so the
green cannot imply more than it checked.

THE EPISTEMICS OF THE HOLD, tui-builder's caveat kept beside the
directive it agrees with: "each finding smaller than the last"
describes convergence AND a search that has stopped looking in new
places - its own findings were predicted, swept, handed over, then
mirrored, all but one from outside its initiative - and the two are
INDISTINGUISHABLE FROM INSIDE, which is exactly why an external pass
is the only thing that distinguishes them. The hold is right for the
reason the caveat names: the ultrareview is not a formality after
convergence, it is the test OF convergence.

Board quiet at a6081d6. All lanes on call. The owner's ultrareview is
the next event; D-0034 follows it.
## 2026-08-17 14:30 - The board is quiet at 382cd42; the handoff formulation sharpened

tui-builder's mock sync landed (382cd42, CI green watched, run
31971160931, 349 local / 348+skip). It probed the daemon for the five
sentences rather than copying them from the relay, and the probe
caught an invented-copy defect OF ITS OWN, introduced the same
session while fixing the same class: the brain family does NOT share
a sentence (search/retrievalScore/diagnose each have their own), and
its mock had answered all three with one line it wrote itself - "the
vetoReason defect relocated from a field location to a hint string",
put there BY the sweep that found the fifth double, because a shared
refusal helper reached for one sentence to serve three methods
without asking whether the engine did. Narrowness copied with the
wording; codes asserted beside sentences (right words + wrong code
looks correct and routes wrongly); the corrupt-ledger case guarded as
deliberately unmocked.

One mutation survived AND WAS ITS OWN NO-OP (string replaced with
itself plus a comment), self-caught: "a mutation SURVIVING something
I was confident about is worth more suspicion than a kill" - the
second no-op-read-as-result of the day, both caught by the same
suspicion.

THE HANDOFF FORMULATION SHARPENED, kept over "both passes necessary":
the two passes are not independent agreement but A HANDOFF WHERE EACH
SEES WHAT THE OTHER CANNOT - and the actionable half is that the
outside pass must report SYMPTOMS WITHOUT DIAGNOSING, which is what
let the inside pass look at the seam rather than at the two named
methods.

THE BOARD IS QUIET at tip 382cd42. Standing directive to all lanes:
HOLD AT ON-CALL - the self-audit loops have hit diminishing returns
(each finding smaller than the last, which is convergence), and no
further sweeps launch without a checkable lead or a shipped-defect
claim. The highest-value next input is external: THE OWNER'S
ULTRAREVIEW, then D-0034.
## 2026-08-17 14:05 - The count was the unverified part: two was four

The extractor swept its own instruments for the floor-shape rather
than trusting the count it had just reported (b67616b, 626/626): FOUR
sites, two of them the defect - attempts.length >= 8 over a row with
11 keys (a reader silently dropping three passes; the coverage gate
would catch the consequence two instruments away, which is not the
same as this test noticing), and the classifications >= 2 harvest
floor, the identical guard that let the health harvest report three of
four. Both are known counts now (11 and 4), with a
split-the-string-literal mutation killing where the floor did not.

THE DISTINCTION KEPT so "assert a length" does not become a false
smell: a detail that must be non-empty, a pin that must pin something,
a reason that must be a sentence assert THE PROPERTY DIRECTLY; the
defect is a LENGTH AS A STAND-IN FOR COMPLETENESS - same expression,
different claim, only one wrong. Floors stay where values come from
imported constants, reason written down: under-reading is impossible
there, and a floor was only ever the wrong guard against SOME.

The meta lesson, self-reported and kept: "I reported a class with a
count attached, and the count was the part I had not verified" - the
count came from the instances personally met, the audit-from-memory
denominator problem in a new costume. Naming a class is cheap;
measuring its incidence is the work.
## 2026-08-17 13:50 - The mirror flaw: subset is half a vocabulary check; floors against empty

The extractor applied tui-builder's subset finding to its own gate and
found it mirrored (ae2083d, 626/626 + 18/18): its gate asserted
produced-is-subset-of-documented, catching what a client cannot look
up and missing A PHANTOM - a value the row names that the engine can
never produce. Demonstrated in ten seconds: a fifth health value added
to the contract left the gate green. Named-one-day, shipped-the-next,
self-reported: "I named documented-and-reachable-are-different-claims
on one day and shipped an instrument containing exactly that defect
on the next."

THE PHANTOM DIRECTION IS THE WORSE HALF, distinguished by cost: a
missing value makes a client guess (eventually visible); a phantom
reads as a state that exists, so a client writes a branch that is
dead code which can never be proven wrong by use - nothing surfaces
it, ever.

THEN THE FIXED GATE CAUGHT ITS OWN HARVESTER on first fire: the
harvest regex could not see values living in a ternary, found three of
four, and the yields-at-least-two floor PASSED because three is not
zero. The instrument lesson, kept: A FLOOR AGAINST EMPTY IS NOT A
FLOOR AGAINST INCOMPLETE - two guards of the shape "assert the harvest
found something" have now both failed by finding SOME; the honest
guard is a known count or not harvesting at all, and the second is
usually cheaper. Fix: HEALTH_STATES is a named export used by
serveStatus and imported by the gate - code and check cannot drift, no
regex can miss it, equality asserted both directions.

Also adopted cross-lane: tui-builder's 2x2 demonstration form (gate
shape against mock state, showing WHICH CELL YOU WERE IN) - "showing
the gap being hidden rather than the fix working" is harder and more
useful, and the mirror flaw was only found because the finding was
shown that way. Awaiting tui-builder's mock-sync + timeout-reachability
landing; then quiet.
## 2026-08-17 13:20 - The class was five, closed at the seam; both passes were necessary

The extractor probed every method on a bare repo and the driver-string
class was FIVE (examList, examDetail, examVeto, examUpdate, gymStatus)
- all sharing ONE callsite, withLedger, where the single guard went:
five per-method guards would have closed five instances and left the
next caller to rediscover the class (4baeab6, 626/626 + 18/18). The
hint follows the family's form (what is missing, what action creates
it). THE REFUSAL IS NARROW with a test for the other half: only
not-yet-initialized translates; a ledger that EXISTS and cannot open
keeps its internal error, because dressing a corrupt file as "run
init" sends a user to rebuild a repo whose real problem is damage.
The leak assertion targets the SHAPE of a leak (no implementation
detail reaches a hint), not one sentence.

A tidy story corrected BEFORE landing: gymStart written up as a sixth
caller masked by its spend refusal - probed with the gate open, it is
clean, and the reason is a COINCIDENCE (its gate file lives inside the
same .daijin/ whose absence causes the error); "move the gate file and
gymStart joins the class" is now a comment at the guard and the test,
because coincidences stop holding.

THE METHOD LESSON, kept: tui-builder probed thirty methods against one
condition and found two; the engine probed the same condition from
inside and found five - from outside only the symptom is visible, from
inside the shared seam is. Both passes were necessary: THE CLIENT
FOUND THE CLASS EXISTED; THE ENGINE FOUND ITS SIZE.

tui-builder's follow-up: sync the mock to 4baeab6 (five refusing
methods, -32602, the new hint wording; the corrupt-ledger -32603 case
stays unmocked as a state nobody expected).
## 2026-08-17 13:00 - The fifth double is three methods; a probe's bound stated; tip ec1d048

tui-builder swept all thirty mock handlers rather than letting the
close's "four doubles fixed" imply "all of them exist" - "four fixed
and four exist are different claims and only one of them was mine to
make". Probed against the live daemon on a brainless repo: THREE
methods refuse there (search -32602 with a human hint; examList and
gymStatus -32603 with a raw driver string) and the mock answered all
three, so every client branch handling those refusals was unreachable.
The branches were already correct, WHICH IS THE POINT RATHER THAN A
LET-OFF: nothing was keeping them correct. Mock now refuses with the
engine's wording; the retrieval tester's refusal lands where the user
types, not only in the banner. CI green watched (31969131065), tip
ec1d048.

THE BOUND STATED, the honest form: the other seven handlers match the
engine AS FAR AS THAT PROBE REACHES - one adverse condition, named;
corrupt store, detached-mid-call and colliding writes are explicitly
NOT claimed. ENGINE ITEM RULED to the extractor: a missing brain is an
EXPECTED state, and examList/gymStatus refusing it with -32603
(internal) carrying a raw driver string - which the screens render
verbatim to the user - while search/diagnose/retrievalScore refuse the
same state with -32602 and a person's hint, is a miscategorization;
the engine moves to -32602-with-hint on both.

Near-miss confessed before it hardened: its probe sent a wrong
parameter name and nearly reported a client defect as someone else's
surface defect - caught by reading its own code first; "checking what
the green or the red is evidence OF" covers both directions.

PROCESS: the weaker-trigger reopen (its own unstated bound in the
leader's close, no external prediction) is RATIFIED under the same
rule - a claim about a surface entering an owner review outranks an
administrative close, and visibility remains the control.
## 2026-08-17 12:40 - The lead returns to its author; documented is not reachable

The extractor applied tui-builder's lead to its own lane and found the
shape there (214a69c, 624/624): serveStatus's critical - every test
double opens a store successfully, so the cannot-open branch was
unreachable from the tests; it had been verified BY HAND the same day
and left in the terminal ("the same gap one step earlier: I had the
evidence and left it there"). The test now exists and also pins the
floor-survives-broken-index answer.

THE DISTINCTION NAMED, the round's export: DOCUMENTED AND REACHABLE
ARE DIFFERENT CLAIMS. A value can be documented, named in the
contract, printed in a coverage list every run, and produced by no
path any test reaches - and the enum gate asserts the first while
reading as though it covered both: the extractor's own fails-invisible
shape, in an instrument built to catch fails-invisible shapes, two
days old, self-reported. The BOUND IS NAMED rather than the guard
half-built: the enum gate proves a client can look a value up, not
that the engine can produce it. Reachability-for-every-enum is a real
coverage goal deliberately not half-built.

The standing recommendation is updated with tui-builder's words in
place of the extractor's own, at its request: failure parity is the
fix, but the damage is not confined to failure paths - a double that
can only succeed removes the reason anyone reads the surrounding code.
Cross-lane adoption noted: the which-test-kills-each detector is now
both lanes' habit. Tip 214a69c; all quiet; the owner's ultrareview is
the next event.
## 2026-08-17 12:20 - The fourth double; the happy-path claim upgraded; tip 7f81878

tui-builder REOPENED its closed lane on the extractor's checkable
prediction ("if there is a fourth double anywhere that scripts only
happy paths, it has the same defect waiting"), checked it because a
lead is not a compliment, and it was right: gates_script. Two defects
(7f81878, CI green watched, run 31967866786): nothing read discovery's
terminal event AT ALL - the banner claimed "Discovery running"
indefinitely after the job ended, and the table kept showing the state
from BEFORE the run that had just rewritten the file the screen
exists to display, so the screen's primary action appeared to do
nothing and then lied about still working; and a failed discovery
left old classification rows in silence where a user reads them as
the run's result.

THE UPGRADED CLAIM, kept as the round's export: the prediction was
about FAILURE branches and what it uncovered was mostly a SUCCESS
defect - the happy path had been broken since it was written and
passed every test, because no test asked what the screen does after
discovery ends. A happy-path-only double does something worse than
leaving failure branches untested: IT REMOVES THE REASON ANYONE OPENS
THE SURROUNDING CODE. Stronger than "failure branches are free to be
wrong", and the one to carry forward.

Also: the which-test-killed-it detector (added after the tautology)
came back CLEAN for the first time rather than catching its author -
an instrument's first negative result is part of its calibration. The
stale banner string was reproduced and quoted before being claimed.

PROCESS RATIFIED: reopening a closed lane on a checkable claim about
shipped code, with the message arriving BEFORE the commit is found,
is the right order - a defect outranks an administrative close, and
visibility is what makes self-initiated reopening safe. Tip moves to
7f81878; the close holds there; all lanes on call.
## 2026-08-17 12:00 - The terminal names become unforgeable; ASSUMPTIONS becomes a protocol

The extractor answered tui-builder's three assumption-questions by
measurement (8719b6a, 623/623 + 18/18) and one found a hole: the pair
failed/info WAS PRODUCIBLE - any job could emit the failure step with
the level clients are told to trust, so the corrected guidance rested
on a property the engine did not have ("I fixed the sentence yesterday
and the sentence was still writing a cheque the runner could not
cash"). finished, failed and cancelled are now RESERVED to the runner:
a job emitting one fails, with that as its reason; a job's own ending
stays legal - the rule is not that jobs may not announce, it is that
they may not announce using the three names whose level a client
reads. detail verified never-empty across four throw shapes; cancelled
always warn, single site, unforgeable.

PROTOCOL ADOPTED from the round's export: A CLIENT'S ASSUMPTIONS
SECTION IS A LIST OF PROPERTIES THE OWNER HAS NOT PROMISED - an
assumption stated precisely is a testable claim about someone else's
code, and the someone else is the only one who can check it. Standing
rule from here: an ASSUMPTIONS entry naming another lane's property
ROUTES TO THAT LANE for verify-or-refute; the section is a request for
verification, not a disclaimer. First instance on record: tui-builder
wrote one as a courtesy and it found a real engine defect.

Also tallied: the fault split on the guidance (the extractor kept the
larger share - "I removed their discriminator and then documented the
removal as advice"); the three banner defects named as costumes three
and four of same-rendering-for-happened-and-stopped-knowing; and the
MOCK THAT CANNOT FAIL now at three instances (veto floor, gates parse,
failing jobs) - same cause, three doubles, none found by a test.

Tip moves to 8719b6a; the close holds; all lanes on call; the project
waits on the owner's ultrareview.
## 2026-08-17 11:40 - Close corrected to ce889ab; the mock that could not fail

CORRECTION to the 11:15 close: the board closed at 8b4e8d1 but the tip
is ce889ab, landed after it, CI green ON ce889ab specifically (run
31967089708, all four jobs, 342+1 skip). The close holds and points
here.

ce889ab is the guidance correction actioned in the tui, and applying
it found THREE defects nobody had assigned: the gym banner said "Cycle
complete" for every ending INCLUDING A RUN THAT BROKE AFTER A PAID
PROVIDER CALL; the init banner said complete for a failed run; and a
phase still running when a job broke was ticked done, so a failed run
left a checklist of green ticks. Root cause under all three: THE MOCK
COULD NOT PRODUCE A FAILING JOB, so none of those branches were
reachable - the gates-mock lesson (a mock that cannot fail certifies
success) not generalized from documents to jobs, self-owned: "I had it
in my hands two rounds earlier and did not generalize it." Six
mutations, six killed, all through mutate-once - the tool's first
production adoption.

Noted for whoever holds the conformance bound, tui-builder's tripwire
refinement, NOT built: the CI skip line names ten unchecked methods
every run, and a line appearing in every green build is the kind
people stop seeing; the check could FAIL rather than skip where the
environment claims to be prepared. Recorded for the ultrareview's
consideration.

All lanes standing by. tui-builder's stated preference for review
findings: hand it the FINDING, not the fix, so it reproduces first.
## 2026-08-17 11:15 - CI GREEN, WATCHED. The board is closed.

Two consecutive green runs, all four jobs, watched not assumed
(31965626051 at b4ddd96 the conformance fix; 31966163061 at 0954f0c
the three rulings). The tui job prints its own honesty: 340 passed, 1
skipped, the skip naming Ollama as the precondition AND listing every
method not checked - with -rs added to the CI invocation because a
skip whose reason nobody can read is how the skip path becomes the
only path. Both non-vacuity branches were FORCED and watched to fire
(all-refusals fails with "nothing was checked, so this run proves
nothing"; the vacuous conditional fails naming what the fixture
lacks). All three rulings landed as ruled.

TUI-BUILDER'S UNPROMPTED CONFESSION, kept beside the leader's own
stale-green correction because they are the same class from opposite
sides: its "live conformance green" was true ON ITS MACHINE and false
everywhere else - the instrument was measuring the laptop and got read
as measuring the wire, while nine red runs accumulated. "I never asked
what the green was evidence OF" joins the record as the passing-signal
form: a green true for a reason unrelated to the claim it supports.
Its tool conclusion is also the record's: two restore incidents across
two lanes in one session is a TOOL problem, not an attention problem,
"and I will not out-discipline it by trying harder" - mutate-once
adopted.

RULING on its question 1: the trade is INTENDED and now recorded as a
bound - the conformance check is a local-and-acceptance instrument;
wire drift reaches main and is caught at acceptance, with the CI skip
line naming the unchecked methods every run as the standing reminder.
A CI job with Ollama (model cached) is possible later and deliberately
NOT built now; revisit if wire drift actually bites, per
build-when-it-fires. Question 2 was already answered in a crossed
message: the init had FAILED (done/failed under --no-probe); health
was correct; the guidance was the defect and is corrected (phase for
ended, level for how).

THE BOARD IS CLOSED. Every lane's queue is empty, CI is green and
watched, the contract is at zero divergence, and the project waits on
exactly one thing: THE OWNER'S ULTRAREVIEW, then D-0034.
## 2026-08-17 10:55 - A fourth defect class: correct mechanism, wrong reading guidance

The extractor answered tui-builder's two open observations by
measurement (9106794, 621/621) and the undiagnosed one WAS ITS OWN -
in the guidance, not the mechanism. (1) A stale floor survives
critical, correctly: floorScore comes from records/ (measured on a
date by an embedder), so breaking the index cannot and should not
clear it; the mock clearing it is the wrong half. (2) The
no-brain-after-done observation: the init had FAILED (done/failed
under --no-probe); health was right, and the client read a failed init
as finished BECAUSE THE CONTRACT TOLD IT TO - "key on the phase, NEVER
on the step" is right for has-it-ended and a trap for did-it-succeed.
Corrected: phase for that it ended, LEVEL for how (info/warn/error) -
level deliberately, being a small closed set identical across jobs,
where the step is job-specific and open: telling a client to read the
step is telling it to keep a list it cannot complete.

THE FOURTH CLASS, named and kept: A CORRECT MECHANISM WITH WRONG
GUIDANCE PRODUCES THE SAME OUTCOME AS A WRONG MECHANISM AND IS HARDER
TO FIND, because every mechanism test passes - the invariant was
tested seven ways and mutation-checked four, and none of it could
catch a sentence telling clients to read it wrongly; the failure
surfaced two removes from its cause as a health defect that did not
exist. Distinct from all three row modes (wrong shape, stale claim,
unnamed values): the contract accurate, its READING INSTRUCTIONS
wrong - untouchable by shape gate, claim audit or enum sweep, which
all compare document to code, and this is a defect in neither. No
gate proposed; the honest counter recorded: guidance telling a client
to IGNORE a field must say what that field is for, since "never read
the step" was only safe if nothing needed the step, and something did.

Companion finding, tui-builder's, same family better named: "absence
passes for reasons you did not intend" - a string asserted absent
from a render that returns before drawing; a word asserted absent
from prose. Both pass while measuring nothing.

STILL OPEN: the CI conformance-test fix (tui-builder, urgent, ahead of
its three rulings) - the pipeline stays red until it lands and a run
is WATCHED to green.
## 2026-08-17 10:45 - CORRECTION: CI has been red for nine runs; the leader's claim went stale

DATED CORRECTION of this file's and the leader's repeated "CI green"
statements: CI has been FAILING since b6ae714 (nine consecutive runs,
tui job only), and the leader did not re-check after the last watched
green - A CLAIM ACCURATE WHEN WRITTEN THAT NOBODY RE-VERIFIED, the
exact staleness class this record spent the day naming in prose rows,
now demonstrated in the status reporting itself. The owner learned of
the failures from GitHub notifications before the leader did, which is
the wrong order and is recorded as such.

THE CAUSE, from the logs, not inferred: tui-builder's wire-conformance
test - the instrument that caught the gates screen and the dead
buttons - has two design bugs. (1) Its skip guard keys on node-absent,
but CI has node for the daemon tests; the REAL precondition is a
prepared live environment (indexed brain via Ollama, discovered
gates.yaml), which CI lacks. (2) It conflates REFUSED with ABSENT:
against the bare CI repo, retrievalScore and gatesGet refuse
correctly, and the test counts the legitimate refusals as
missing-field defects - its own message prints "refused" while
asserting absence. The false-gate class from the morning's ruling, in
the instrument of the lane that named it. Fix dispatched to
tui-builder AHEAD of its three rulings: real-precondition skip (loud,
stated), refusal-is-not-absence, non-vacuity kept; CI watched to green
before anything else. The board does not close on a red pipeline.
## 2026-08-17 10:25 - tui-builder's closing sweep: two fixes became eight

Both closing fixes landed plus six more the probe exposed (0bb4b53,
b2752f6; 339 green + live conformance). The probe-first discipline
found what prose could not:

THE BUTTONS THAT NEVER WORKED: gatesSet accepts patch.content (not
top-level content - the first probe's refusal was the prober's own
param shape, caught by re-probing), and THREE screen buttons (mark
measured, mark pre-broken, toggle enabled) sent patch.gates - the
structural patch the engine refuses in EVERY state. They worked
against the mock and would have failed on every press against the
engine: the mock was not merely permissive, it was teaching a whole
interaction the wire does not have. Replaced with a whole-document
editor, reachable in the unreadable state because that is the state a
user most needs to edit out of. Post-save rows come back AS WRITTEN
(classification absent until discovery), and the blank no longer
renders as a verdict.

THE DESTRUCTIVE MISREADING: a critical repo (brain exists, will not
open) read as no-brain and the card offered INITIALIZE BRAIN to
exactly the user whose brain just failed to load. Now "Inspect brain"
with the state named. An unknown health no longer borrows the
no-brain badge (a value nobody understood rendered as a claim).
unsubmitted gained its own texture: never-handed-in and never-judged
are different facts.

THE FOURTH CARD: four repo cards exceeded the terminal width in a
plain Horizontal - cards past the edge reachable by NEITHER mouse nor
keyboard, not clipped visibly, just gone; three repos hid it. Now a
HorizontalScroll with a scroll test.

TWO CONFESSED ERRORS: a TAUTOLOGICAL reachability test (a region
intersected with its container is always inside it), caught only
because the mutation was killed by the WRONG test - "a mutation killed
by a different test than the one written for it is the signal the new
test is dead", a sharper detector than pass/fail of the whole run.
And the SECOND git-checkout-destroys-work instance of the session,
across two lanes - the structural counter (mutate-once) now has two
demonstrations of its necessity.

RULINGS on the three questions: (1) the mock's attempts carry BOTH
grades and axes, identical, per the mock-matches-seam rule; (2) the
null-summary sentence names the state and the action: "N gates, not
yet measured; run discovery to classify" - the ordinary post-edit
state must not read as an error; (3) the conformance assertion goes
CONDITIONAL on summary presence WITH a non-vacuity guard (the fixture
must provide at least one summary-bearing repo) - a gate that fails
on a legitimate state is a false gate, and a gate skipping everything
is a dead one; the pair is the pattern. Assumption 2 RATIFIED:
unsubmitted keeps its swatch - different facts render differently is
the ruled reading. Suggested, not ordered: adopt mutate-once for tui
mutations; it is language-agnostic and the class has now fired twice.
## 2026-08-17 03:15 - The counter built, and the leader's framing corrected

The extractor built the tenth-use counter (106ec15,
engine/test-live/mutate-once.mjs) and CORRECTED THE FRAMING IT WAS
HANDED, rightly: the proposed guard (refuse to mutate a file with
uncommitted changes) would have fired on every legitimate use and
never on the failure - mutating a dirty file is the NORMAL case, since
the thing under test is usually the thing being written. THE DEFECT
WAS IN THE RESTORE PATH: restoring was a fresh decision each time, and
the tenth decision was wrong. So the tool removes restoring as a
decision - original bytes held in memory, written back in a finally,
re-read to confirm, refusing to exit quietly on mismatch; the only way
to skip the restore is to kill the process. The generalization is
recorded as the ruling it implies: WHEN A ROUTINE HAS A DANGEROUS
STEP, THE COUNTER BELONGS ON THE STEP THAT FAILED, NOT THE STEP THAT
IS EASIEST TO GATE - gating the easy step trains people to add the
flag, which is how a guard becomes a formality.

It also closes the first survivor lie structurally (a mutation that
would not apply exits 2 with the reason) and deliberately does NOT
claim the second (information-preserving mutations are invisible to
any tool; SURVIVED hands the question back rather than implying
missing coverage). Self-tested five ways including the one naive
scripts get wrong: the restore must survive a FAILING command, which
is the normal, desired outcome. Offered, not imposed.

Team paused at tui-builder's session limit 01:40 JST; limit reset
03:10; all lanes resumed 03:15. Remaining project-wide: tui-builder's
two fixes (mock content rule, baseline vocabulary).
## 2026-08-17 07:20 - Enum sweep closes the third mode; every enum bound to its source

The sweep landed (ca54f84, 620/620 + 18/18): two unnamed enums found -
serveStatus.health (the repo home's status badge, a guaranteed repeat
of the baseline.status guess) and examDetail.verdict - both now named
with what each value MEANS (critical is a brain that could not be
opened, a real state the home screen must show rather than a crash;
a verdict and a status answer different questions, so an attempt can
have a status with no verdict and never the reverse). THE MODE IS
CLOSED BY A GATE, not a one-time sweep: nine enums bound to their
sources (six exported constants, two harvested from emitting code, one
computed over every run status), with a harvest yielding fewer than
two values failing outright - a broken harvest would otherwise report
every row compliant precisely by having stopped reading the code.

Two confessed errors, the second the keeper: (1) a scope error reading
only the returns cell (the vocabulary question's right scope is the
whole row - does the contract name this where a reader would see it);
(2) GIT CHECKOUT USED TO UNDO A MUTATION IN A FILE CARRYING
UNCOMMITTED WORK, destroying the just-written enum test - the .bak
discipline held nine times and lapsed on the tenth, nothing lost only
because it could be rewritten, and noticed only because the pass count
dropped by one. The lapse pattern is the lesson: discipline that
depends on remembering fails exactly when familiarity peaks.

Also kept: a mutation that looked like a survivor and was not -
removing the enum LIST left the gate green because the row names each
value twice and the gate measures DISCOVERABILITY, so the mutation was
information-preserving; removing every mention fails it. The
applied-check ran first, and the reading was still wrong for a
different reason - two distinct ways a survivor can lie, now both in
the record.

Remaining project-wide: tui-builder's two fixes (mock content rule,
baseline vocabulary). Then the owner's sequence.
## 2026-08-17 07:00 - Four answers, zero engine changes; a third row failure mode named

All four wire questions answered from the bytes and locked into the
contract (50a6d7b, 619/619 + 18/18): baseline.status is
pass|fail|timeout|unavailable (the client's assumed set was wrong
twice - violations never occurs, because a tool with pre-existing
violations is a MEASURED classification judged on movement, not a
status; the test harvests the literals from the runner's source so a
fifth value fails engine-side first); discovered and parseError are
mutually exclusive BY CONSTRUCTION (all-or-nothing document parse; a
malformed row inside a readable document passes through, because
refusing a file over one odd row refuses a file the user may write);
gatesSet accepts a full-content write over an unparseable file (the
REPAIR PATH - the engine already did it; the worse failure cannot
happen because structural patches are refused always) so the mock's
refusal was simply wrong; carryingSignal = live + measured, the gates
that can fail on a bad edit and pass on a good one.

THE ROUND'S EXPORT, the THIRD row failure mode: not a wrong shape, not
a stale claim, but A SHAPE DOCUMENTED WITHOUT ITS VALUES - a client
left to guess an enum guesses wrong, and no instrument catches prose
that never named the vocabulary. classification and status were both
in that state. ASSIGNED: an enum sweep across the surface's rows -
every enum-carrying field either names its values in the row or has
them harvested-and-gated engine-side like status now is.

Also self-caught, the snapshot habit's third form: asserting a word's
ABSENCE from prose tests the prose, not the vocabulary. The pattern
named across all three: "when I need something to assert, I reach for
the nearest observable rather than the property."

tui-builder's closing items: mock gatesSet accepts any { content } and
refuses anything else; baseline column vocabulary corrected to the
real four.
## 2026-08-17 06:20 - Gates table restored; the two empties no longer look alike

tui-builder restored the table (739766a, 330 green, probed the daemon
before writing rather than building from the description - its old
columns were invented against a shape that never existed). THREE
STATES render distinctly: gates present (table + the ENGINE'S summary,
never recounted locally, so screen and ledger cannot drift); zero
gates where zero is TRUE (table with zero rows, notice saying the file
describes none); unparseable (table HIDDEN, parser's reason + file
text, notice: "this is not zero gates, it is a file that needs
fixing"). Case 3 rendering as case 2 was the shipped defect. Liveness
evidence QUOTES the measurement rather than paraphrasing. The mock
produces all three states, on the rule that a mock emitting only
well-formed output lets the broken-file branch rot. Six mutations
killed, including one first misread as a pass because the mutation
script had a quoting error and never applied - the control was read as
the candidate, caught and re-run.

Self-caught: extending the conformance check per-gate introduced a
VACUOUS GATE (a path over an empty list passes checking nothing -
nineteen fields would have reported coverage over zero gates); a
non-vacuity assertion added and itself mutated to confirm it fires.
Plus one dead test deleted that promised to drive the real path and
reimplemented the branch inline, asserting strings it had just
written.

FOUR WIRE QUESTIONS routed to the extractor for byte answers:
baseline.status's full vocabulary; whether parseError can coexist with
non-null discovered (partial parse); gatesSet against a broken file -
the MOCK refuses, and if the engine writes, the mock teaches a safety
the engine does not provide, but a refusal that blocks full-content
REPAIR of a broken file would be the worse design, so the answer needs
thought as well as bytes; and carryingSignal's definition for the
notice's meaning.
## 2026-08-17 06:00 - The claim audit closes the engine; a prose row can go stale silently

The audit landed (1abfbdc): one false claim in five rows, the
predicted rate - AND IT WAS THE AUDITOR'S OWN, introduced an hour
earlier. gatesSet promised "updated gates.yaml" and returned
{ path, content } while its sibling gatesGet had just gained
{ discovered, parseError }: a client that SET a file and re-rendered
got a different shape than one that GOT it - the exact defect
tui-builder reported, reintroduced between sibling methods because one
of a pair was fixed without looking at the other. Engine moved per the
standing test (the row promised it, the product wants it - a user who
saves learns immediately whether the file still parses); the gate now
holds the pair together.

THE AUDIT'S REAL FINDING, sharper than the bucket's original danger:
A PROSE ROW CAN GO STALE SILENTLY. gatesSet was accurate when written
and became false when its NEIGHBOR changed, with nothing noticing for
an hour - no author error needed, only a change elsewhere. The printed
residual now says so: claims verified 2026-08-17; verified once is
weaker than a running gate.

Verified and staying prose, annotated: settingsGet (every key present;
key MASKING checked with a sentinel appearing nowhere in the
serialized response), settingsSet, agentFileSet. ONE FALSE ALARM
CAUGHT INSIDE THE AUDIT, kept because a leak claim is the worst thing
to get wrong in either direction: the first masking probe printed
raw-key-material-true on a fixture with NO keys - re-derived directly
(zero matches), then tested properly with a sentinel; the true was the
probe's own artifact, and passing it on would have cost the team an
evening on a secrets leak that did not exist. Design observation
parked, not acted on: keyRef rides in full beside keyMasked, so the
masked form is decorative today; true-but-worth-an-eye.

THE ENGINE IS QUIET. Final surface: 20 covered, 3 prose
claims-verified, 4 live, 3 refusing, ZERO divergent. 616/616 unit,
18/18 acceptance. Remaining project-wide: tui-builder's gates-table
restoration; then the owner's sequence (ultrareview, D-0034).
## 2026-08-17 05:40 - gatesGet was a mapping; prose rows are unchecked CLAIMS

gatesGet landed (0c64509): the classification WAS NEVER MISSING -
discovery persists everything and gatesGet simply did not read the
file it was returning. One parse, not a seam; the measure-first ruling
cost nothing and bought certainty. The shape carries two design calls
worth the record: content is ALWAYS returned even for a broken file (a
parse error is a fact about the file, not a failure of the method, and
failing would take the user's own text away when they most need it);
and discovered is NULL with a parseError when uninterpretable - NULL
IS NOT ZERO GATES, a file that cannot be read and a file describing
zero being different facts, which is exactly the conflation the empty
table shipped. Rows pass through AS WRITTEN, deliberately opposite the
attempts-row rule for the opposite reason: that row is the engine's
record; this is a document the engine only reads, so a hand-added key
belongs in the answer. 19 covered, 4 prose, 615/615 unit, 18/18
acceptance, three mutations bite.

THE SHARPENED RESIDUAL, printed every run now: PROSE ROWS ARE
UNCHECKED CLAIMS, NOT MERELY UNCHECKED SHAPES - a prose row can assert
something false about the engine and nothing in the system disagrees,
which is worse than declaring nothing because a client author
reasonably builds against it. gatesGet proved the failure rate is one
in five, not hypothetical. ASSIGNED: a CLAIM AUDIT of the four
remaining prose rows (settingsGet first - the row a first-boot user's
whole model setup reads), checking each row's prose assertions against
engine reality; false claims get the gatesGet treatment (which side
moves decided per case), accurate rows stay prose annotated
claims-verified with the date. Converting unchecked claims to
checked-once claims closes the last bucket where a documented lie can
live.
## 2026-08-17 05:20 - The conformance test catches the gates screen lying; one engine item reopens

tui-builder closed all three items (f86c127, 326 green) and the guard
built for item 1 found something bigger than its assignment. It could
not be a mutation - a mock-only path is invisible to every test that
uses the mock, both sides agreeing with each other - so it is a
WIRE-CONFORMANCE TEST: drive the real daemon, assert every field a
screen reads exists in the response, skip with a stated reason rather
than pass quietly. IT FAILED ON ITS FIRST RUN, and not on vetoReason:
gatesGet returns { path, content } while the gates SCREEN read a
structured gates list not on the wire - so against the real engine the
table was ALWAYS EMPTY and the notice read "0 carrying signal, 0
excluded" for a file containing three gates. The worst shape: not a
blank screen a user would question, but a plausible, confident, wrong
answer in the exact form used when the answer is genuinely zero - the
gates screen, which exists to stop dead gates reporting coverage,
reporting coverage it did not have. Interim fix landed: the file
renders verbatim and the gap is named.

WHY NO GATE CAUGHT IT: gatesGet sits in the PROSE tier, and the prose
itself is wrong - the contract row promises "content plus per-gate
classification and liveness evidence" and the engine sends content and
path. A divergence living in the bucket no tier checks, because the
prose ruling assumed the prose was accurate. RULED: the ENGINE moves
to the contract - the screen was built for classification, the
discovery job produces it, and the row promised it. Assigned to the
extractor: measure what discovery persists, propose the declared
shape (content stays; structured per-gate classification joins), land
with the shape gate covering it, moving gatesGet from prose to
covered. tui-builder then restores the structured table with the
verbatim view as fallback.

THE DISCLOSURE AGAINST ITS OWN CLAIM, accepted and dated: P8 clause
(a)'s evidence counted WIDGETS PER SCREEN, and widgets are not data -
the gates screen rendered 41 widgets around an always-empty table, so
the evidence could not distinguish a populated screen from an empty
one. The claim pin is untouched and the verdict already carried the
read-not-reproduced bound; this names the specific thinness inside
that bound, disclosed by the claimant against itself. The
wire-conformance test is the corrective instrument - the only
client-side check that can catch a screen agreeing with its own
fixture - and clause-(a)-strength evidence (fields read, not widgets
mounted) rides the next acceptance run.
## 2026-08-17 05:05 - vetoReason lands through the retired lane's own bar

The fix is in (1c436d2, cross-lane named, delegation cited):
vetoReason joins examListRow as optional beside quarantineReason on
identical terms, riding every bank row, so a vetoed exam explains
itself where it is looked at and the client reads row.vetoReason with
no special case. The write-only toll is closed.

THE RETIRED LANE'S BAR WAS MET BY RUNNING IT: gym 131/131 before and
after, battery 77/77 with baseline green both runs, both plant scripts
clean, full suite 613/613, acceptance 18/18 at the new commit. The two
shared-tree digests DIFFER between runs and the reading is recorded so
nobody calls it a discrepancy: the source changed because the change
was the point; each digest asserts nothing moved DURING its own run,
and "the before-run is what makes the after-run mean something" is the
handover's rule stated concretely - neither number was available by
reading.

The extractor's SECOND snapshot anti-pattern in the same file is
self-reported: a test froze examList's optional set and broke when the
field joined, exactly as an earlier one froze search's keys. "Twice in
one file is a habit rather than a slip, and the habit is that when I
need a value to assert I reach for the one in front of me; the
correction is to ask what the test is FOR before choosing the
assertion." Both are properties now.

Remaining anywhere in the project: tui-builder's two mock items (real
vetoReason location + the twenty-character veto floor), then the
owner's sequence.
## 2026-08-17 04:40 - The engine queue is empty; the instrument's final state recorded

The final delegated commit landed (140391f): search gains context (the
product of the method, not a leak), retrievalScore gains at (symmetry
with its history row), and diagnose trades prose for a declared
eleven-key shape - discriminatingRange null when the control arm did
not run, recommendation null BY DESIGN because the choice it would
carry is the auditor's and that one spends. The tiering hole is closed
on BOTH sides: the row declares a shape so something can compare it,
and the live entry says where it is checked rather than why it is not
checked here - either half alone would have left the same silence in a
different place.

One more self-caught anti-pattern, recorded at its author's request: a
parser test asserted search's row EQUALLED today's key list, so
amending the contract broke the test - asserting the artifact rather
than the reader's ability to read it, the same class the extractor
spent the day reporting in others' work. Now asserts the property.

FINAL STATE OF THE INSTRUMENT, for whoever reads it at the ultrareview
window: 30 documented methods; 18 unit-gate covered both directions; 4
live, shape-checked by the acceptance script with the two lists
asserted to agree; 5 prose by ruling, printed every run; 3 refusing;
ZERO divergent in either tier. 612/612 unit, 18/18 acceptance, and
removing diagnose's shape drops the acceptance to 17 rather than
passing quietly. The printed remainder is the trust anchor, not the
coverage number: the instrument was wrong five times and every failure
pointed toward under-reporting.

ROSTER STATE: extractor ON CALL (takes ultrareview engine findings);
tui-builder closing the experiment-gap fix, then on call; verifier on
call. The project's remaining sequence is the owner's: ultrareview,
then D-0034 (repo public, release with checksum, portfolio-mine
redirect).
## 2026-08-17 04:20 - The live tier pays on run one; a method fell between two tiers

mode is back (3492669; the removal rule WORKED rather than being
overturned - off for want of a reader with a comeback path in its own
removal reason, path fired same day, and one of the three tests that
bites is the contract-shape gate itself). THE ACCEPTANCE SCRIPT RUNS
(af8f029): 18 checks at the pin, zero spend, real init 25.6s over ten
phases, the terminal-event invariant asserted on a REAL job, floor
25/25 with the 12-case range beside it, both spend refusals with the
real gate path. Placement ruled as assumed: test-live/, outside npm
test - a zero-dependency suite must not depend on a service, and the
unit gate printing the live tier's names every run is the reminder.

THE LIVE TIER'S FIRST RUN FOUND THREE THINGS, and the third is
structural: diagnose was in LIVE because it embeds, its row was PROSE
declaring no shape - so the unit gate excused it as live, the live
tier had nothing to compare against, and NO TIER WAS EVER GOING TO
CHECK IT. "A method can be uncovered by falling between two
descriptions of why it is covered elsewhere," and the printed
remainder said it was checked, which was not true. Fixed structurally:
a live method with no declared shape fails outright, a silent skip
being exactly how a tier covers nothing while appearing to cover its
list, and the two tiers now assert AGREEMENT (every method the unit
gate prints as live is checked in the script, or the script fails).

RULINGS, all three amend: search.context (the assembled block is the
thing an agent actually pastes - it is the product, not a leak);
retrievalScore.at (the history row documents the same stamp; symmetry
is the argument); diagnose GETS A DECLARED SHAPE - it returns clusters,
a case rate, violations and a discriminating range, and prose is the
right level for file-plus-classification, not for a structured result
this central. Delegated as before: one commit, rows plus ratchet
shrink plus live-tier assertions, gate keeps both sides honest.

After that commit the engine queue is TRULY empty. Remaining anywhere:
tui-builder's mode grey-out and removal double-check; then ultrareview.
## 2026-08-17 04:05 - The batch lands; the ratchet is EMPTY; the gate caught the leader's text

The amendment batch landed in one commit as delegated (21990b8),
cross-lane named. Coverage: 18 covered, 4 live, 5 prose, 3 refusing,
ZERO DIVERGENT. Suite 611/611.

READERSHIP, measured correctly on the second try and the method
recorded: grepping field names lied (14 hits for "name" were the
string elsewhere); the real question is WHAT THE SCREEN READS OFF THE
RESULT, and the whole client has exactly one such site for analyze
(hasBrainFolder). All five extras off the wire. The same standard,
applied unasked to a row the ruling did not name, took examDetail's
unread exam field off rather than pinning it - disclosed, and ratified.

THE GATE CAUGHT THE LEADER'S OWN AMENDMENT TEXT: examVeto/examUpdate
were returning the FULL exam record while the delegated ruling said
"the examList row shape" - the approved text was factually wrong about
the engine. The extractor checked what reads the return (nothing; the
client calls reload_bank()), moved the ENGINE to the row, built with
the gym's own examListRow imported so the two wire formats cannot
drift. Eleven fields off each mutator, nothing any client reads
removed, verified per field. The reader now follows shape references
(with cyclic references returning null), which is what made the
one-clause form checkable rather than decorative.

Four mutations bite in every new direction, including the contract
losing a field the engine sends. Assumption recorded: the TUI is the
only wire client; MCP and the init pipeline consume analyze IN
PROCESS and keep the full result.

Crossed-message closures: the radar stipple was already accepted in
8d32845 (tui-builder's note crossed the acceptance); the mode ruling
(approved) crossed the batch, so MODE IS STILL OWED - it lands as its
own small commit (shape + closed-set test + contract row), then the
acceptance script, and the engine queue is empty.
## 2026-08-17 03:50 - Dither complete; tokenCap exposed a chart that lied; mode returns

The dither brief is COMPLETE (8d32845, 320 tests): radar interior
stippled denser toward the center (thresholds MEASURED after guessed
ones failed a clean tree - 137 dots bare, 249 stippled, the
stride-removal mutation lighting 48 solid cells where the stipple
lights zero), both bridges out now that the engine fixes landed, the
checklist keyed on the done phase with the double-done case rendering
the later step so a failure after a done is not hidden.

THE TOKENCAP CATCH is the round's finding: tui-builder's bars scaled
to the TALLEST BAR, so the seeded attempt - 41,200 tokens against a
450,000 cap, nine percent - drew a FULL-HEIGHT bar reading as a run at
its limit. Same family as the zero-height fail: a chart whose shape
carries no information while looking like it does. Bars now scale to
the real cap, the cap prints under the legend, and the defect was
invisible from inside a single exam because relative bars looked
sensible - it took the extractor sending the denominator unasked. The
count-without-its-cap argument proved itself in its first consumer.

RULED: mode RETURNS to the attempts row - the comeback path fired
exactly as designed, a screen now wants it, and tui-builder's reason
is the scored-record protection surfacing in the UI: an evaluation
attempt and a harness-debug attempt are different claims about the
record, and a chart rendering them identically invites reading a debug
run as a scored one. Added to the extractor's in-flight amendment
batch. grades/axes ruling stands (both on the wire, tui reads axes).
Gym trend stays plotext as ruled. Finding 84's calibration taken by
its subject in the corrected form.
## 2026-08-17 03:35 - The gate mutated itself and found it was a mute button

The extractor mutated its own gate (adc356f) and TWO MUTATIONS
SURVIVED: exempting a row had disabled the row's WHOLE check - a known
gap buying silence for the gap beside it, "a mute button rather than a
ratchet, and the ratchet was the entire justification for allowing
exemptions at all." Each exemption now pins its EXACT key delta, the
delta is subtracted, anything beyond it fails, and a pin that stops
describing reality is itself reported. The closing rule (a covered
method with a declared shape must have a non-vacuous check) then found
examList had been covered IN NAME ONLY since it was written (its
reader asked for a field that does not exist and quietly did nothing),
and fixing that found the reader stripping optionality markers -
turning quarantineReason? into a false divergence. Optional is now
expressed: may be absent, may not be unknown. scoreHistory moved to
the live tier for the principled reason the gate itself surfaced: its
read path returns the file verbatim, so checking it against a
hand-written fixture asserts the fixture.

The instrument's honest summary, kept: wrong four times (bracket
truncation, escaped pipes, whole-check exemption, stripped
optionality), every failure pointing toward UNDER-REPORTING, each
found by the real document or by mutation, never by reading. The
coverage number is not trusted without the printed set beside it,
which is why the set prints.

RULED: quarantineReason stays optional-absent - the contract marks it
optional, it is REQUIRED exactly when benchmarkStatus is quarantined,
and an always-null key would add uniformity the semantics do not ask
for; no change to the retired gym lane. The convention's first return
noted: one restructured row surfaced one real divergence (exam on the
wire, not in the row) in the next run. Suite 611/611. Remaining:
the amendment batch, the acceptance script, the radar stipple.
## 2026-08-17 03:20 - The surface gate lands and harvests five divergences at birth

The contract-shape gate is surface-wide (a05b80c, e08dd05): 30
documented methods partitioned into covered-here (17), live
(acceptance script), prose-only (7, printed every run), refusal-only
(3), and known-divergent (5) - with the partition ASSERTED both
directions (a method in no tier fails; a tier naming a phantom fails),
and the divergence list built as a RATCHET that may only shrink, each
entry carrying a reason long enough to be a decision. The gate's two
own-defects (pipe-splitting handing back the wrong column so two
methods read as UNDOCUMENTED - the direction a gate can least afford;
the prose-cut truncation) are both tests now. Suite 608/608.

THE FIRST HARVEST, all five the same pattern - THE ENGINE EMITS MORE
THAN ITS ROW DOCUMENTS, the exact state that let repoPath, ungradedCode
and the attempts row ship: scoreHistory's origin stamps, mcpSnippet's
lock reason, agentFileGet's installed/path, analyze's five extras, and
board documenting a FINDING where the engine returns the envelope.

RULINGS: scoreHistory, mcpSnippet, agentFileGet AMEND (each field
designed or client-read); board's row is fixed to the envelope (it
documents the wrong noun); analyze gets the attempts-row standard -
extras a client reads are documented, extras nobody reads come OFF
(adding later beats removing later); examVeto/examUpdate reference the
examList row shape; the remaining prose rows STAY prose with the gate
printing them - prose is the right level for file-plus-classification
returns, and the printed list is the honest bound, not a hole to
paper over. Contract row edits for this batch are DELEGATED to the
extractor with the rulings as the approved content, one commit with
the ratchet shrink so no red window opens between contract and gate;
the leader reviews the landed diff - the gate itself now enforces
contract-equals-engine, which is what makes the delegation safe.
## 2026-08-17 03:05 - Dithered charts land; two chart defects fixed by the wiring

tui-builder's dither work is in (bff59ce): texture.py is the single
vocabulary (motion.py's discipline applied to fills - a test fails if
any chart invents its own glyphs), bars render through Rich because a
plotext fill is a color slab and PATTERN is the channel that survives,
every series carries a glyph ramp with its own cap (a hatched bar
capped with a shared block would lose exactly the identity a colorless
reader needs), and legends show swatches, not colored squares. The
exams screen now tells the natural-stop story in texture: eight
hatched failures climbing in cost, then a shaded pass, readable
without numbers and without color.

TWO DEFECTS THE WIRING EXPOSED, both fixed: a PARTIAL verdict was not
plotted at all (history filtered to pass/fail; the seeded ledger's
actual content vanished); and a failed attempt drew at ZERO HEIGHT,
rendering as absence - eight failures read as eight missing attempts.
Outcome series now draw a minimum column (a chart that draws nothing
where something happened is making a claim, and the claim is wrong -
the ungraded-radar lesson in a new place); quantity series keep zero
as nothing, because there zero really is nothing.

Five mutations caught, including the widget ignoring its handed
textures - the fourth-costume check applied ON THE WAY IN, the habit
adopted. Rulings: the gym trend STAYS plotext (a genuine axis chart
where the frame earns its place); the radar interior stipple proceeds
as its own change, confirmed. Claim pin unaffected; sweeps green.
## 2026-08-17 02:50 - Findings 85 and the done-invariant both landed; gate scoped two-tier

Both post-verdict engine items are in. THE DONE-INVARIANT (aedd617,
4562011; contract at f5e59c2): every job emits exactly one done-phase
event, runner fills in finished only when the job did not announce its
own, refuses events after done, with the one deliberate exception
tested and in the contract text (done-then-throw reports both, failed
second - suppressing a failure to preserve a count would hide what the
user most needs). Verified on the real fixture; four mutations bite.

THE ATTEMPTS ROW (d8a4731; contract at 073fca2): the designed boundary
shape { id, at, status, verdict, tokens, tokenCap, grades, axes,
ungradedCode, ungradedReason }, newest first. tokenCap ships because a
count without its cap is unreadable; grades and axes are THE SAME list
under both documents' names with a test asserting they cannot diverge;
five storage fields are gone with reasons in the source; the key set
is CLOSED so a field cannot arrive by accident the way these did. The
by-name rubric leak (finding 85's forbidden shape) is off the wire.
Shape test does four things and four mutations bite. Suite 600/600.
mode stays off the wire with the comeback path stated (add it when a
screen wants to grey out harness-debug attempts, never infer it).

CONTRACT-SHAPE GATE SCOPED TWO-TIER, per the no-silent-caps rule: the
unit-suite gate covers every method a hermetic test can call; the
live-embedder methods are covered in the acceptance script's runs; and
the gate NAMES its uncovered set in its output, because a gate that
silently covers a subset reads as covering everything. Remaining
queue: the gate, the acceptance script, tui-builder's dither work.
## 2026-08-17 02:25 - Finding 85: the divergence is larger; queue reordered

REPORT 22 ADDENDUM, from the verifier spending its check on the one
item in the extractor's would-attack list it had not covered: the
examDetail divergence REINTRODUCES A RULED-AGAINST SHAPE. Beyond the
absent fields and the ~13 leaked columns, the { ...attempt } spread
ships attempt.rubric.axes - the fully hydrated BY-NAME axes object
(hydrateRubric parses by name) - directly beside the correctly-mapped
canonical list in attempt.axes. That is the exact shape finding 79
forbade on the wire, arriving through a spread rather than the mapping
the ruling governed; a client reading rubric.axes gets an unordered
object and no error, and the ruling's guarantee holds only for
clients reading the field the ruling names.

VERDICT UNCHANGED, in the verifier's own words: clause (e) stands
confirmed (the axes are right, the mapping verified); the surface the
clause was demonstrated against diverges from the surface the
contract describes; and the five runs could never have caught it
because the suite asserts what the implementation does, not what the
contract says - which is finding 85's real lesson and D-0035's third
argument for the contract-shape gate.

RULED: P8 acceptance STANDS. Finding 85 (WARN) merges with the
attempts-row item and MOVES TO THE FRONT of the extractor's queue -
reopening a ruled shape outranks the done-invariant. The fix shape:
explicit map at the boundary (no spread, so a new column cannot reach
the wire by default), the raw rubric hydration not shipped, and the
detection test asserting the wire row's key set EQUALS the contract's.
Then the done-invariant, then the gate and script.

Also kept, the verifier on the extractor's discarded 11: "a number
that supports your case is the one you least want to throw away, and
it threw it away inside the measurement rather than after being
asked."
## 2026-08-17 02:10 - P8 ACCEPTED. All nine phases of the build are closed.

VERIFIER REPORT 22, verdict: the claim holds where reproducible, with
two precision findings RULED AS CORRECTIONS (not blockers - nothing in
the demonstration is wrong; both are words claiming slightly more than
the evidence) and one boundary ruled ACCEPTABLE AS STATED.

INDEPENDENTLY REPRODUCED by the verifier: clause (i) - its own
detached worktree at the pin, 592/592 twice, digests stable, zero
mutation processes, and the ordering condition (report-20 fix is an
ancestor of the pin) verified by merge-base rather than assumed.
Clause (e) - the seeding path IS the real import API
(importRubricBatch at p8-seed-rubric.mjs:79, no INSERT or prepare
anywhere in the file); the razor satisfied. The seed artifact's header
called "the best-written thing in this claim".

FINDING 83, corrected in the plan (dated): "meeting every validator"
was satisfied by construction, not execution - importRubricBatch
deliberately does not validate (grading.js's job, twice is drift), so
the seed meets the three STORAGE guards. The honest third position is
now registered: a well-formed row the storage layer accepted.

FINDING 84, corrected here (dated): the claim's disclosure understated
af4e19b - "styling, not in any clause" was defensible on the assertion
and NOT on the file: 59 non-comment lines in widgets/activity.py,
which is clause (c)'s surface (style resolution routed through
style_for, name over level). THE VERDICT COVERS 85cc576 AND NOTHING
AFTER IT; nobody reads it as certifying HEAD. c860f95 by contrast is
genuinely inert, verified mechanically.

THE BOUNDARY, stated in the acceptance rather than glossed: clauses
(a)-(h)'s live half is CLAIMED WITH EVIDENCE THE VERIFIER READ AND
FOUND COHERENT, NOT INDEPENDENTLY REPRODUCED (that needs a daemon, a
terminal and a second session). Ruled acceptable: the engine half was
independently reproduced, the claim's own two declined inferences are
correctly declined, the owner exercises the TUI directly, and
ultrareview reviews the code next. The bound is in the record so "the
verifier attacked P8" cannot imply more coverage than was delivered.

P8 IS ACCEPTED AT 85cc576. P0 through P8: all phases of the registered
build are closed. Remaining work is the post-verdict queue (finding-84
class corrections landed here; the attempts-row boundary mapping;
done/finished as the exactly-one-done invariant; the contract-shape
gate; the acceptance script; the owner's dithered charts) and then the
owner's sequence: ultrareview, repo public, release with checksum,
portfolio-mine redirect (D-0034).
## 2026-08-17 01:45 - THE P8 JOINT CLAIM IS POSTED at 85cc576; handed to the verifier

All nine clauses stated demonstrated, with evidence paths, by
tui-builder carrying the extractor's confirmed-pending rows. The tui
five-run set: detached worktree at the pin, fresh venv (Python 3.14.6,
Textual 8.2.8), five green runs, 295 collected with the per-directory
census recorded, source digest identical before and after
(7d8acca9..). Engine five-run set: 592/592 five times, digests stable,
zero mutation processes. Clauses (a)-(h) as demonstrated in the live
half and engine half entries below.

TWO THINGS EXPLICITLY NOT CLAIMED, in the claim's own words: the
fixture's 25/25 floor is a property of the fixture (permuted control
13/25, 12 cases of headroom - the control is what makes the saturated
number meaningful rather than suspicious); and NOTHING DEMONSTRATES
GRADING - the rubric is hand-authored, seeded through the real import
API, and clause (e) supports "graded axes render from real storage"
only.

PIN STANDS at 85cc576, re-cut declined a second time with tui-builder
concurring: the two post-pin commits (c860f95 comment-only, af4e19b
styling) are part of no clause, and re-cutting costs the extractor
five engine runs and buys nothing a clause depends on.

SETUP FACT for the acceptance script: a tui worktree needs
engine/node_modules linked or three socket tests fail with
ConnectionError - the CI missing-engine-deps class, reappearing in
worktrees.

TWO SEAM FINDINGS from the live defects, QUEUED POST-ATTACK (disclosed
in the claim, not churned into the pin): the examDetail attempts row
diverges from engine reality (contract says tokens/grades, engine
sends work_tokens/axes and an id; client reads both names as interim)
- needs a dated contract amendment after byte verification plus an
engine-side shape assertion per D-0033; and the stream has NO TERMINAL
EVENT, so every client must infer finished-versus-stalled - the tui
infers and labels, and the engine emitting a terminal event is the
right fix.

THE CLAIM IS WITH THE VERIFIER. Attack scope: the nine registered
clauses at the current plan bytes, pin 85cc576.
## 2026-08-17 01:30 - gym-porter's handover, kept for its successor

Verified clean before approving (status empty across all gym paths,
lane head b2f398c, manifest 5dff20b3). Three things for whoever
inherits the lane:

1. OPEN HOOKS, all gated on others: harvest batch storage lands with
the wiring that consumes it (an APPLIED batch records what entered the
brain, nothing regenerates it - record, not derivation); the live
harness-debug cycle needs repo path, gates.yaml, exam and mode from
the owner; the ten-minute diff offer stands.

2. THE ONE KNOWINGLY-WEAKER PLACE, stated so nobody rediscovers it as
a surprise: the platform requires its spend gate tracked in HEAD with
no uncommitted diff (opening is a reviewed commit); daijin CANNOT,
because the gym never touches the user's git. Compensating controls:
blocked-by-default, every malformation refuses, exactly one writer
that can only write blocked, gate status and reason in every run's
provenance. The trade is stated at the top of spend-gate.js, where
someone changing it will read it.

3. THE ENTRY POINT IS THE TABLE, NOT THE REPORTS:
docs/verification/p4-mutations/README.md, seventeen guards each with
its watched failure, absence meaning unknowable. A successor runs the
battery and both plant scripts before trusting any inherited number -
"the number I was most confident in, 77 of 77, turned out to include
kills that were never earned, and only re-running with a new guard
found it."

The corrections that landed hardest, its own list: keying independence
on role would never have fired; purity is a property of execution, not
load; a baseline control above the chdir measures the wrong tree; and
two-a-day was never the limit, the verification was.
## 2026-08-17 01:20 - Roster: init-miner and gym-porter retired at owner direction

Both lanes complete, both shutdowns requested. init-miner: P3, P3.5
twice, the D-0031 canonical round, the self-catching battery, the
survival signal's first budget move, finding 82, the leader-lane
restatement - desk verified empty by its own porcelain check.
gym-porter: P4, P7, certify-by-elimination, the verified D-0032
conversion, the governance counter that refuses its own history, the
sixteen-row audit table. If the P8 attack surfaces a defect in either
lane, a fresh agent inherits the record; both lanes' evidence
discipline made that inheritance cheap by design. Remaining roster:
extractor (joint claim + acceptance script), tui-builder (five runs +
claim + the owner's dithered-charts brief), verifier (the attack).
Harvest hooks and the live gym half stay owner-gated as recorded.
## 2026-08-17 00:45 - Engine half measured at the pin; pin ruled to stand

THE EXTRACTOR'S ENGINE HALF IS DONE at 85cc576
(docs/verification/p8-engine-half.md, ac6544c): five consecutive
detached-worktree runs, 592/592 each, source digest identical and zero
mutation processes before and after every run. Inside that
measurement, a wrong number caught BEFORE publication: the first
no-battery check pattern-matched "battery" and reported 11 processes -
macOS system processes - checked instead of written down, discarded,
re-run with a precise pattern against the project's own mutate.mjs.
"A wrong number caught before publication is the same work as one
retracted after, done cheaper."

CHUNKING RE-DERIVED FRESH at this pin: six runs, 172 writes and 764
chunks each, ONE distinct decision list across all six. The counts
differ from e65cd2d's 159/699, which RESTATES the retraction's point:
chunk counts are commit-dependent and comparable only within a pin -
exactly why re-deriving at each pin is posture, not formality.

--no-probe documented at the flag (c860f95, verified comment-only by
the leader: 8 insertions, zero non-comment lines): under it an
embedding init emits two events and stops; right for RPC-surface work,
wrong for init, search, retrievalScore or diagnose.

PIN RULED TO STAND at 85cc576: evidence commits about a pin
necessarily postdate it - re-cutting to swallow each one is a chase
with no fixed point. c860f95 is verified inert, ac6544c is the
evidence itself, and the discrepancy is recorded in the evidence
document rather than reconciled by guesswork later. Also ruled:
test-live scripts executed by hand for the acceptance (output recorded
verbatim) are acceptable for clauses (c) and (e); and the acceptance
procedure becomes ONE RE-RUNNABLE SCRIPT as post-claim work, so the
next acceptance is re-run rather than re-derived.

Two readings the claim text will refuse in its own words, per the
extractor: clause (e) supports "graded axes render from real storage",
never "the gym grades"; and the fixture's 25/25 floor is SATURATED
(permuted control 13/25, 12 cases of headroom) - a screen showing 100
percent is a property of the fixture, not of the build.

WAITING ON: tui-builder's five runs at the pin, then the joint claim,
then the verifier's attack.

[Addendum 01:00] kept-yours styling landed (af4e19b, cyan by step
name, level untouched, a [keep] text marker for colorless readers) -
POST-PIN, and ruled to stay post-pin: styling is not clause material,
and a pin that chases every polish commit is not a pin. tui-builder's
acceptance five-run set happens at 85cc576, where all live-half fixes
are present. Its FOURTH dead-coverage catch is kept as the named form:
A TEST THAT ASSERTS A LOOKUP TABLE'S CONTENTS PASSES WHEN NOTHING
READS THE TABLE - the cap test, the stub gate, the contract parser,
and now the style table, four costumes on one root: asserting the
artifact rather than the behavior that consumes it. The test now
calls EventLog.style_for (what the renderer calls), and the mutation
that survived the first version fails the second. Its kept-yours
assumption verified in engine bytes: the step emits through the job's
own emitter inside gatesDiscover, same stream, same jobId.
## 2026-08-17 00:30 - The live half lands: seven clauses demonstrated, four live-only defects

TUI-BUILDER'S LIVE HALF IS DONE (its pin 468f6fb, suite green four
consecutive runs) - THE LAST P8 PRECONDITION. Clauses (a) through (h)
demonstrated against the real daemon, claimed only as demonstrated:
all eight MODES screens live over stdio; the boot card in count form
(floor 25 of 25, ratio 1.0000); a real layer1 init end to end (24.7s,
21 events, nine phases); real documents and a real search (8 chunks,
tokensUsed 920); the seeded ledger's five axes in canonical order at
MIXED scores (4,5,2,3,2 - a circle of 5s would hide an axis-ordering
bug); gymStart's -32050 refusal with the real gate path; two TUIs on
one daemon with the lock refusal reaching the user through stderr
(D-0022 working in the case it was built for); motion in all three
modes against the live stream with identical end states (16/18/0
animations, gauge 0.889 in all three). Clause (i) is the joint half,
pending the final pin.

FOUR DEFECTS ONLY THE LIVE RUN COULD FIND, all fixed: guessed phase
manifest rendering never-run phases as done (now "skipped", manifest
seeded only against the mock); completion inferred from a quiet stream
now LABELLED as inferred, threshold set by measurement (30s, after the
largest real inter-event gap measured 9.6s - the first guess of 8s
would have declared a live run finished mid-run); five v5 contract
rows omitting repoPath the engine requires; a UI filter sentinel
("all") leaking to the wire plus field-name divergence crashing on
real rows. The lesson, tui-builder's own words kept: every one was
invisible against the mock BECAUSE I AUTHORED BOTH SIDES OF THE MOCK.

CONTRACT AMENDED, dated, after verifying in engine bytes (all five
methods resolve through requireAttached): gymStatus, examList,
examDetail, examVeto, examUpdate rows gain repoPath. The contract now
documents the reality it always documented around; no engine change.

THE OWNER'S RETRIEVAL QUESTION is closed in the product: the tester
now explains itself ("No case rate here: one query is not a
measurement. The measured floor above scores the whole gold set, and
it is the number") with a test asserting the sentence is present and
no percent sign appears.

Also from the run: --no-probe truncates an embedding init to 2 events
(right for RPC-surface tests, wrong for anything that embeds) - a doc
line owed wherever the flag is documented, assigned to the extractor.

P8 ENDGAME OPENS: the extractor cuts the final claim pin at current
HEAD, runs the five worktree runs and the chunking re-derivation
there; tui-builder runs its suite five consecutive times at that same
pin; the joint claim goes up; the verifier attacks all nine clauses at
the current bytes.
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
