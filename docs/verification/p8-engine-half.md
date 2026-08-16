# P8 acceptance: the engine half, measured at pin `85cc576`

Dated 2026-08-16, by the extractor. Evidence for the joint claim with tui-builder against
the nine registered clauses. Every number here was produced at the claim pin in a detached
worktree, not read from an earlier run.

## Procedure

```
git worktree add --detach <somewhere>/p8-final 85cc576
ln -s <repo>/engine/node_modules <somewhere>/p8-final/engine/node_modules
cd <somewhere>/p8-final/engine
```

All runs below execute inside that worktree. Nothing else writes there.

## Clause (i): the engine suite, five consecutive runs

| run | tests | pass | fail | source digest before/after | mutation processes before/after |
| --- | --- | --- | --- | --- | --- |
| 1 | 592 | 592 | 0 | `d329daabfc2124cc` -> identical | 0 / 0 |
| 2 | 592 | 592 | 0 | `d329daabfc2124cc` -> identical | 0 / 0 |
| 3 | 592 | 592 | 0 | `d329daabfc2124cc` -> identical | 0 / 0 |
| 4 | 592 | 592 | 0 | `d329daabfc2124cc` -> identical | 0 / 0 |
| 5 | 592 | 592 | 0 | `d329daabfc2124cc` -> identical | 0 / 0 |

The no-battery assertion is `pgrep -f "mutate.*\.mjs"`, matched against the project's own
`docs/verification/init-mutations/mutate.mjs`. A first attempt used the looser pattern
`battery`, which reported 11 processes; those were macOS system processes with "battery" in
their names, and the number is discarded rather than reported. The precise pattern returns
zero before and after every run.

**Stated bound, unchanged:** a before/after digest cannot see a mutation window that opens
and closes inside a run. It shows the tree ended as it started. The worktree is what makes
that strong, since no other process has a reason to write there.

## Chunking stability, re-derived at THIS pin

Not today's earlier numbers. Six runs of `test/init-pipeline.test.js` with the probe that
records every chunking decision:

| runs | chunk writes | total chunks | distinct decision lists |
| --- | --- | --- | --- |
| 1..6 | 172 | 764 | **1** |

Identical per-document decisions in the same order, six times. Note the counts differ from
the `e65cd2d` measurement (159 / 699), which is the retraction's point restated: chunk
counts are commit-dependent, so they may only be compared within a pin.

## Clause (c): a real init, streaming

Fixture built by `engine/test-live/p8-fixture.mjs` (11 files, 6 commits, fixed dates).
Zero spend, local Ollama only.

```
real initBrain layer1: 27.3s, 21 step events, 0 errors on the stream
phases: identity -> identify -> evidence -> scaffold -> brain -> ingest -> gates -> goldset -> floor
```

`identity` leads because init is a lifecycle contract (D-0031 invariant 4), and the feed
shows the order the work actually happened in.

## Clause (d): real documents and real chunks

```
documents: 13
search "why is tax applied after the discount": 5 chunks, tokensUsed 689
floor: 25 of 25, originPath stamped, index digest sha256:9c734a81db966c2b
```

The floor is saturated on this fixture, and the honest label for it is measured rather than
assumed: the permuted control scores 13 of 25 against the real 25 of 25, so the gauge has
12 cases of headroom. That was measured before the pin and is a property of the fixture
rather than of the build.

## Clause (e): graded axes from real storage

Seeded by `engine/test-live/p8-seed-rubric.mjs` through the real import API, meeting
`putExam`'s validator, `recordRun`'s no-applied-diff refusal and the batch rules. Read back
through `examDetail`:

```
correctness_vs_gold     4/5
convention_adherence    5/5
decision_awareness      2/5
reasoning_quality       3/5
blast_radius_awareness  2/5
graded attempt ungradedCode: null
ledger: {"mode":"evaluation","scoredWrites":1,"drawnFromResultFiles":null,"rowsWritten":1,"certifications":0,"exams":1}
```

Canonical five-axis order out of a store that holds them keyed by name, mapped at the
daemon boundary. `drawnFromResultFiles` is null rather than zero, which is the drawn-cohort
denominator rule holding: no result files exist, and null is not a count.

**What this supports and what it does not.** It supports *graded axes render from real
storage*. It does NOT support *the gym grades*: the rubric is hand-authored, because
nothing in this build has ever graded anything and a grader-produced rubric needs the
teacher role and the student driver, both paid and unbuilt. The label is in the seed
script's header, and the registered clause text was amended to say so before this run.

## Clause (f): spend surfaces, engine side

```
gymStart -> -32050, and the refusal hint carries the real GATE path
budgetEstimate(gym) -> 800000 tokens
  basis: "1 exam(s) at the M and L work-token cap of 800,000 (S tier is 450,000)"
```

The estimate is computed without any provider call, which is what lets it be shown before
consent. The CONFIRMED direction of the paid methods is out of this clause by the
registered bound, and belongs to the owner-gated live half.

## One thing landed after the pin

`c860f95` documents where `--no-probe` is wrong (an embedding init emits two step events
and stops, so a truncated run looks like a fast one). It is comment-only, changes no
behaviour, and is NOT in `85cc576`. The five runs above are the pin's suite; this note
exists so nobody has to reconcile the pin against the log later.
