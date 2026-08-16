# DRAFT acceptance: grading, rubric import, harvest

Status: DRAFT by gym-porter for the leader's review. The leader edits and pre-registers; the
verifier attacks the registered text, not this one. Nothing here is built yet, which is the
point: the sentence is written before the work so it can be failed rather than fitted.

Lineage: platform grade.js, grade-export.js, grade-import.js, grade-offline.js, harvest.js,
harvest-import.js, harvest-offline.js, apply-proposals.js, curate.js, and TEACHER.md, whose
refusal list is the compressed record of what went wrong on the platform for a year.

## Why this phase is worth pre-registering carefully

Grading is where a measurement becomes a number, and harvest is the ONLY step that puts
anything back into the brain. The platform's own record is unambiguous about both failure
modes: cycles 30 and 32 through 37 harvested or skipped and then never applied, so seven
cycles of graded evidence taught the project nothing; and cycle 32 returned empty gaps on all
five exams, four of which failed, teaching nothing while looking complete. A phase whose
acceptance says "grading works" would pass in both of those worlds.

So the acceptance below is written against the failure modes, not the features.

## MECHANISM HALF (the acceptance; zero spend, freely verifiable)

The teacher is an INJECTED interface, exactly as the student is, and every clause is
demonstrated against a scripted fake teacher. No clause requires a provider call.

### A. Grading, with author-grader independence structural

1. A rubric scores five fixed axes (`correctness_vs_gold`, `convention_adherence`,
   `decision_awareness`, `reasoning_quality`, `blast_radius_awareness`), each 1 to 5, each
   with at least one citation. A rubric missing an axis, scoring outside the range, or
   carrying an uncited axis is REFUSED, and each refusal names the axis.
2. A citation is real or the rubric is refused: `path:line` must name a file the submission
   diff actually touched, or a brain document id that appeared in what the student was shown.
   An invented path and an invented document id are separately demonstrated as refused.
3. A rubric binds to BOTH `taskDigest` and `submissionDigest`. Re-running an exam produces
   identical task text and a different diff, so a task-only binding lets one attempt's rubric
   silently grade another; the test drives exactly that scenario and requires a refusal.
4. The teacher never authored the exam it grades. Demonstrated structurally: a grading call
   whose exam provenance records the same agent as the grader is refused, not merely
   discouraged in prose.
5. Verdict rules, each with its own test: a run whose ONLY gate damage is a measured-metric
   regression caps at `partial` rather than `fail`; a run with no applied diff is
   `unsubmitted` and NO RUBRIC MAY BE WRITTEN FOR IT (the importer refuses one); and a
   cycle's pass rate counts only the runs that produced a diff, with the drawn count stated
   beside it.
6. Author stamping is canonical: the rubric's author is the configured teacher identity, and
   a differing self-report is PRESERVED as `reportedAuthor` rather than overwritten. The
   platform lost a cycle's provenance to one grader appearing under two names.

### B. Rubric import, refusal-first

7. Rubrics are filed by the `(runId, axisOrGapIndex)` they carry, never by arrival order. A
   transposed pair is refused rather than attached to the wrong run, demonstrated by
   submitting a deliberately swapped pair.
8. Every refusal in clause 1, 2, 3 and 5 is exercised through the IMPORT path as well as the
   validator, because the platform's rule is that the importer is the boundary and a
   validator nobody calls is not a boundary.
9. A rejected import changes nothing: after a refused batch, the ledger and the rubric store
   are byte-identical to before it. Partial application of a bad batch is the failure this
   clause exists to prevent.

### C. Harvest, the step that teaches

10. Harvest is PROPOSAL-ONLY. It writes no brain document; it writes a batch. A separate,
    explicitly invoked apply step turns survivors into documents, and the two are different
    functions with different names in different modules.
11. One question per gap, and gap tags decide whether a question is asked at all:
    `retrieval-miss` and `knowledge-gap` produce questions; `model-limit`, `harness-defect`
    and `stale-gold` produce NO BRAIN WRITE, and the test asserts the absence rather than
    trusting it.
12. Held-out runs are refused BEFORE any question is asked. That boundary is what keeps the
    reserved exams an honest yardstick, and a harvest over a held-out run must throw.
13. Every answer carries a non-empty, single-line `concern`, INCLUDING `none` answers. Six
    answers were rejected in one platform round for empty concerns; the test drives an empty
    concern and requires the refusal.
14. `retrieval-fix` and `sharpen-convention` answers REQUIRE a `targetDocumentId` naming a
    document that exists, and every cited document id must have appeared in that packet's
    retrieved or absent lists. An id invented from memory is refused.
15. The curation gates run and each can fail: contradiction, duplicate, provenance, and
    one-concern. Each gate has a test that FAILS WITHOUT IT, per the mutation discipline;
    a gate that cannot fail is dead coverage and does not count toward this clause.
16. THE BACKSTOP, and the clause I would keep if I could keep only one: every lesson a gym
    run writes back is validated against CURRENT code before it enters the brain. A proposal
    citing a path or symbol that no longer exists is dropped with its reason recorded. This
    is the same rule that makes a superseded exam safe, and it is the last thing standing
    between a stale gold and a brain that believes it.
17. Zero accepted proposals is a legitimate, recorded outcome, not an error path. A round
    where every gap is `model-limit` produces a measured zero, and the test asserts the zero
    is written rather than inferred.

### D. Discipline clauses, inherited rather than reinvented

18. Zero spend: the teacher, the auditor and any narration are injected; `npm test` makes no
    provider call, demonstrated by the same grep that covers the gym today.
19. Fixture isolation: no test writes into a real logs or harvest directory. The platform
    nearly chased a fixture batch that landed seconds from a real one, twice.
20. Mutation evidence: every clause above ships with a mutation that turns a green test red,
    recorded in `docs/verification/p4-mutations/mutate.sh` (or its successor) with captured
    output. A clause with no killing mutation is not accepted.
21. Mode quarantine holds across the new surface: a rubric or a harvest batch from a
    non-`evaluation` run never reaches a scored aggregate, and certification still refuses
    without the gold-provenance exclusion record.

## LIVE HALF (deferred, owner-gated, NOT part of this acceptance)

One real graded cycle with a real teacher model, followed by a real harvest and apply,
against the example repo. It runs only on the owner's explicit authorization through the
leader and gets its own pre-registered sentence when that authorization exists.

## What I propose to leave OUT, so the boundary is explicit

- The teacher's PROMPT quality. Instruction-file content is already user-editable and audited
  the way the student's is; grading the grader's prose is not falsifiable here.
- Inter-rater reliability, calibration drift, and any claim about grade QUALITY. This phase
  accepts that the machinery refuses what it should refuse. Whether the grades are good is a
  measurement over many cycles and belongs to whoever owns that question, with its own
  registered sentence.
- The dashboard and scorecard rendering of grades. Display follows the data; it is P5's lane.

## Honest bounds on the draft itself

- Clause 4 (author-grader independence) is stronger than the platform's, which relies on
  role separation rather than a check. I propose making it structural, but it needs the exam
  provenance to record the authoring agent, which today records `auditor-selection` as a
  source and not an identity. If you accept clause 4, that field grows; if you would rather
  not grow it, clause 4 should be struck rather than weakened into prose.
- Clause 16 (citation validation at harvest time) needs a symbol resolver, not just a path
  check, to be worth its wording. I would ship path-and-line validation first and state the
  symbol case as an explicit gap rather than claim it.
- Clause 6 assumes a configured teacher identity exists in settings. If role config is not
  ready, clause 6 moves to the live half instead of being tested against a stub identity.
