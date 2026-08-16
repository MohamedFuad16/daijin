# Verifier attribution corrections

Dated corrections to attributions made in earlier verifier reports, appended in place
rather than rewriting the reports, per the project's correction convention. The VERDICTS
these appear in are unaffected and stand: each was taken inside a freeze window with a
source hash or tree-sha pinned on both sides of the attack, and none of the corrections
below touches a pinned result.

What is corrected is the ATTRIBUTION of red suites observed alongside those verdicts.

---

## Correction 2026-08-16, following verifier report 18

Report 18 characterized the suite flake: mutation batteries were mutating the shared
working tree while other processes ran the suite against it, so a run overlapping a
mutation window failed on whichever test that mutation targeted. The controlled result was
18 runs separating perfectly by source hash, an immutable snapshot clean 10 for 10, and a
confirmed concurrent `mutate-all.mjs` process. D-0032 mandates private copies as a result.

**Consequence for my own earlier reports.** On several occasions I observed a red suite
alongside a verdict and attributed it to a lane's in-flight editing. That attribution was
reasonable at the time and may have been wrong. A battery window and a mid-edit state look
identical from outside: both present a modified tree, both resolve on their own, and both
produce a failure in the lane whose files are involved. I could not have distinguished them
before report 18, and I did not try.

The affected attributions, each stated as it was made and as it should now be read:

**Report 8 (P4 attack, 2026-08-16 08:26).** I observed the full suite at 360 tests with one
failure, `every generated unit cites files that exist, and one that does not is DROPPED`
and neighbours, and attributed it to "init-miner's in-flight P3 work". Now read as: a red
in init-miner's surface, cause not established, possibly a battery window rather than an
edit in progress. The P4 verdict is unaffected; it was pinned to a gym tree-sha that was
0 dirty at both ends of the attack.

**Report 15 (rubric persistence, 2026-08-16).** I observed the gym suite at 129 tests with
2 failures, both certification tests, and attributed it to "gym-porter mid-edit on
certification". That attribution was later corroborated by the certify delta landing, so it
is probably correct, but it rested on inference from two modified files rather than on
evidence that an edit rather than a mutation produced the failures. The persistence probes
are unaffected; they ran before any modification and I re-verified the one conclusion that
could have been invalidated.

**Reports 14, 16 and 17.** Three further reds attributed to "the extractor's in-flight
relocation" on the leader's attribution rather than my own investigation. Those remain the
leader's attributions; I record only that I passed them through without independent
evidence, and that the same ambiguity applies.

**What does not change.** No verdict rests on any of these attributions. Each verdict names
the artifact it covers and the hash or tree-sha it was pinned to, and in every case the
attacked surface was clean at both ends of the attack. The corrections are about what I
said caused a red I saw beside the work, not about the work.

**What I do differently now.** An observed red gets one of three labels: caused, with
evidence; attributed by another party, named as theirs; or unexplained. "In-flight lane
work" is not a fourth category, because it was the label I reached for when I meant
unexplained and the tree looked busy.

---

## Correction 2026-08-16 (later), following the extractor's retraction

The extractor has retracted the init-lane chunk-count drift in full, with evidence, at
`docs/verification/init-chunk-drift.md` (commit `5007e52`). The 44 and 45 were read from two
error messages at two different times with no commit pinned, straddling `9056789`, which
moved that file's chunk totals by hundreds. At a fixed commit the count is six-for-six
identical, and an independent harness produces byte-identical decision lists.

Three of my own moves need dating as a result. None is overwritten.

**Report 19's "two mechanisms, neither subsuming the other" was half right, and half right
by luck.** The second mechanism I named, init-lane nondeterminism, does not exist; it
collapsed with the datum it rested on. But report 20 then traced a real second mechanism,
the un-awaited discovery job racing a later test in `rpc-surface.test.js`, which fires in CI
where no battery can run. So the conclusion "there are at least two causes" survives with a
different second member, and it survives because a later trace found one, not because the
reasoning that produced it was sound.

**Report 18's dissolution of the chunk-count variance into battery windows was right after
all.** Report 19 corrected report 18 on this point, and that correction was correct
reasoning on a false premise: given the drift as reported, my argument that a mutated source
cannot produce a drifting count on an isolated fixture was valid. The premise was the
problem. Report 18's original position is restored; report 19's correction of it is
withdrawn; both stand in the record with their dates.

**Report 19 cited the extractor's isolated-fixture method as exemplary. That citation is
unearned in that instance**, in the extractor's own words, and I record the distinction
rather than withdrawing the praise wholesale: its kill of the escaped-fetch theory
(instrumented wrapper on the real global fetch, six runs, zero calls, reported precisely
because plausible stories get believed when only surviving evidence is shown) remains
earned and remains exemplary. What was not earned was the drift observation sitting beside
it, which had no pin and was not a repeated measurement of one thing.

### The lesson, which is mine rather than the extractor's

I made the commit pin a requirement for P3 and wrote that it "leads because it is the one
clause that cannot be repaired retroactively: if the repo moves, a re-derivation stops being
the same experiment." I then accepted two unpinned numbers, in the same session, and built a
finding on them.

The difference was posture. P3's number arrived as a claim to attack, so I asked what it was
pinned to. The drift arrived as help, offered by a lane doing its own honest hunting, and I
took it as input rather than as a claim. **A measurement offered in support is still a
measurement, and the pin question is not an accusation.** The rule I should have applied to
it is the rule I had already written down for everyone else.

---

## Standing note on instruments I have endorsed

Report 18 also found that `docs/verification/p4-mutations/mutate.sh` defaults to mutating
the live engine in place. I placed `gate-scanner-plants.mjs` beside it as an acceptance
instrument and reviewed the battery's hardening across three rounds without noticing the
in-place default. The finding is mine and so is the miss; recorded here so the endorsement
and the defect appear in the same place.
