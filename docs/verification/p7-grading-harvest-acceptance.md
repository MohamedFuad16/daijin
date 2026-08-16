# P7 acceptance: grading, rubric import, harvest

REGISTERED text. Written and reviewed before the work exists, so it can be failed rather
than fitted. The verifier attacks this document; the builder (gym-porter) builds to it and to
nothing else. Supersedes the draft at
`docs/verification/p7-grading-harvest-acceptance-draft.md`, which is kept for its record of
the three open decisions and how they were ruled.

Lineage: platform `grade.js`, `grade-export.js`, `grade-import.js`, `grade-offline.js`,
`harvest.js`, `harvest-import.js`, `harvest-offline.js`, `apply-proposals.js`, `curate.js`,
and TEACHER.md, whose refusal list is the compressed record of what went wrong on the
platform over a year of cycles.

## Why this phase is pre-registered against failure modes

Grading is where a measurement becomes a number, and harvest is the ONLY step that puts
anything back into the brain. The platform's record is unambiguous about both failure modes:
cycles 30 and 32 through 37 harvested or skipped and then never applied, so seven cycles of
graded evidence taught the project nothing; and cycle 32 returned empty gaps on all five
exams, four of which had failed, teaching nothing while looking complete.

An acceptance reading "grading works" passes in both of those worlds. Every clause below
therefore names the failure it exists to prevent, and every clause is falsifiable.

## MECHANISM HALF (the acceptance; zero spend, freely verifiable)

The teacher is an INJECTED interface, exactly as the student is. Every clause is demonstrated
against a scripted fake teacher, and no clause requires a provider call.

### A. Grading

1. A rubric scores five fixed axes (`correctness_vs_gold`, `convention_adherence`,
   `decision_awareness`, `reasoning_quality`, `blast_radius_awareness`), each 1 to 5, each
   with at least one citation. A rubric missing an axis, scoring outside the range, or
   carrying an uncited axis is REFUSED, and the refusal names the axis.
2. A citation is real or the rubric is refused: `path:line` must name a file the submission
   diff actually touched, or a brain document id that appeared in what the student was shown.
   An invented path and an invented document id are separately demonstrated as refused.
3. A rubric binds to BOTH `taskDigest` and `submissionDigest`. Re-running an exam produces
   identical task text and a different diff, so a task-only binding lets one attempt's rubric
   silently grade another. The test drives exactly that scenario and requires a refusal.
4. AUTHOR-GRADER INDEPENDENCE IS STRUCTURAL. Exam provenance records the authoring IDENTITY
   (who authored the exam, not merely that its source was auditor selection), and a grading
   call whose grader identity matches the exam's authoring identity is REFUSED. The gym store
   owns the exam schema, so this field is added as part of this phase. A version of this
   clause that cannot fail is struck rather than softened into prose.
5. Verdict rules, each with its own test: a run whose ONLY gate damage is a measured-metric
   regression caps at `partial` rather than `fail`; a run with no applied diff is
   `unsubmitted` and NO RUBRIC MAY BE WRITTEN FOR IT (the importer refuses one); and a
   cycle's pass rate counts only the runs that produced a diff, with the drawn count stated
   beside it.
6. Author stamping is canonical, and it reads THE SAME SETTINGS SURFACE THE DAEMON SERVES
   (`settingsGet().roles`, RPC v4). The injected teacher supplies its identity through that
   same shape, so the mechanism is tested against the real surface rather than against a stub
   identity. A differing self-report is PRESERVED as `reportedAuthor` rather than overwritten:
   the platform lost a cycle's provenance to one grader appearing under two names. Whether a
   real provider's SERVED identity matches its configured one is not this clause; that is
   `rolePing`, and it belongs to the live half.

### B. Rubric import, refusal-first

7. Rubrics are filed by the `(runId, index)` they carry, never by arrival order. A transposed
   pair is refused rather than attached to the wrong run, demonstrated by submitting a
   deliberately swapped pair.
8. Every refusal in clauses 1, 2, 3 and 5 is exercised through the IMPORT path as well as
   through the validator, because the importer is the boundary and a validator nobody calls
   is not a boundary.
9. A rejected import changes nothing: after a refused batch, the ledger and the rubric store
   are byte-identical to before it. Partial application of a bad batch is the failure this
   clause exists to prevent.

### C. Harvest, the step that teaches

10. Harvest is PROPOSAL-ONLY. It writes no brain document; it writes a batch. A separate,
    explicitly invoked apply step turns survivors into documents, and the two are different
    functions with different names in different modules.
11. One question per gap, and the gap tag decides whether a question is asked at all:
    `retrieval-miss` and `knowledge-gap` produce questions; `model-limit`, `harness-defect`
    and `stale-gold` produce NO BRAIN WRITE, and the test asserts that absence rather than
    trusting it.
12. Held-out runs are refused BEFORE any question is asked. That boundary is what keeps the
    reserved exams an honest yardstick, and a harvest over a held-out run must throw.
13. Every answer carries a non-empty, single-line `concern`, INCLUDING `none` answers. Six
    answers were rejected in one platform round for empty concerns; the test drives an empty
    concern and requires the refusal.
14. `retrieval-fix` and `sharpen-convention` answers REQUIRE a `targetDocumentId` naming a
    document that exists, and every cited document id must have appeared in that packet's
    retrieved or absent lists. An id invented from memory is refused.
15. The curation gates run and each CAN FAIL: contradiction, duplicate, provenance, and
    one-concern. Each ships with a mutation that turns a green test red. A gate that cannot
    fail is dead coverage and does not count toward this clause.
16. THE BACKSTOP: every lesson a gym run writes back is validated against CURRENT code before
    it enters the brain. A proposal citing a path or line that no longer resolves is dropped
    with its reason recorded.
    NAMED GAP, registered rather than discovered later: this clause is accepted at PATH AND
    LINE validation only. Validating that a cited SYMBOL still exists and still means what
    the proposal claims needs a symbol resolver, which is a separate future item and is NOT
    part of this phase. A report on this phase states the gap in the same breath as the pass.
17. Zero accepted proposals is a legitimate, recorded outcome, not an error path. A round in
    which every gap is `model-limit` produces a measured zero, and the test asserts the zero
    is written rather than inferred.

### D. Discipline clauses, inherited rather than reinvented

18. Zero spend: the teacher, the auditor and any narration are injected. `npm test` makes no
    provider call, demonstrated by the same source scan that covers the gym today.
19. Fixture isolation: no test writes into a real logs or harvest directory. The platform
    nearly chased a fixture batch that landed seconds from a real one, twice.
20. Mutation evidence: every clause above ships with a mutation that turns a green test red,
    recorded in the durable battery with captured output. A clause with no killing mutation
    is not accepted.
21. Mode quarantine holds across the new surface: a rubric or a harvest batch from a
    non-`evaluation` run never reaches a scored aggregate, and certification still refuses a
    scored run without its gold-provenance exclusion record.

## LIVE HALF (deferred, owner-gated, NOT part of this acceptance)

One real graded cycle with a real teacher model, followed by a real harvest and apply,
against the example repo. It runs only on the owner's explicit authorization through the
leader, and gets its own pre-registered sentence when that authorization exists.

## Explicitly OUT of scope, so the boundary is registered rather than assumed

- The teacher's PROMPT quality. Instruction-file content is user-editable and audited the way
  the student's is; grading the grader's prose is not falsifiable here.
- Inter-rater reliability, calibration drift, and any claim about grade QUALITY. This phase
  accepts that the machinery refuses what it should refuse. Whether the grades are good is a
  measurement over many cycles, with its own future registered sentence and its own owner.
- Symbol-level citation validation (see clause 16's named gap).
- Dashboard and scorecard rendering of grades. Display follows the data; it is P5's lane.

## Decisions taken at registration

- Clause 4: kept at full strength, and the exam-provenance authoring identity is added in
  this phase to make it able to fail.
- Clause 16: path-and-line validation registered, symbol resolution named as an explicit gap
  in the registered text.
- Clause 6: kept in the hermetic half, reading the settings surface the daemon already serves,
  with served-identity verification left to `rolePing` in the live half.
