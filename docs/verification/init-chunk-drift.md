# The init-lane "chunk-count drift": RETRACTED

Dated 2026-08-16, by the extractor, correcting the extractor.

## The retraction, first

I reported that `test/init-pipeline.test.js` produced **44 chunks in one run and 45 in
another on an isolated fixed-content fixture**, and offered it as evidence of
nondeterminism inside the init pipeline. Report 19 accepted it as a real, separate defect
that the mutation-battery mechanism could not produce, and an assignment was opened on it.

**The observation does not support that conclusion, and I withdraw it.** The two numbers
were read from two error messages taken at two different times, and I never pinned the
commit. They are not two runs of one thing.

## Why the numbers cannot mean what I said

The same test file produces materially different chunk counts at different commits:

| commit | chunk writes | total chunks |
| --- | --- | --- |
| `c96ad53` (before the D-0031 init rewrite) | 110 | 470 |
| `HEAD` (after `9056789`, the brain becomes durable markdown) | 159 | 699 |

Verified by (a probe that wraps `SqliteStore.prototype.replaceChunks` and records every
chunking decision, loaded with `--import` so it patches before any test imports the store):

```
PROBE_ENGINE=<engine> PROBE_LOG=<log> node --import file://<probe>.mjs \
  --test test/init-pipeline.test.js
```

A 229-chunk difference across a rewrite is expected; it is what "the brain becomes durable
markdown" means. Against that, a one-chunk difference read across the same rewrite is
noise, not signal. My two observations straddle `9056789` (17:56), so 44 and 45 are
consistent with two commits and prove nothing about determinism.

## What the counts do at a FIXED commit

Six consecutive runs at `HEAD`, each recording every chunking decision:

```
run 1..6: 159 writes, 699 chunks   (identical, every run)
```

And an independent harness that runs the real pipeline six times over six fresh copies of
one fixture with a deterministic hash embedder: `13 units, 58 chunks` six times out of six,
byte-identical decision lists.

**The chunk count is stable at a fixed commit.** There is no drift to diagnose.

## The failures were real. The cause was the shared working tree.

The test failures I saw were not imagined: a different test failed on roughly one run in
three, always in `init-pipeline.test.js`, always state-shaped. Two facts locate them:

1. **`391d806` (17:55) "the mutation battery mutates a private copy, never the shared
   tree".** Until that commit the battery mutated the tree my runs were reading. Every
   observation I reported predates it.
2. **My own clean-tree control, run at the time and then not followed.** With other lanes'
   uncommitted work present, `init-pipeline.test.js` failed. At both `HEAD` and `262ce6e`
   with a clean tree, it passed 18 of 18. I recorded that result and still attributed the
   failures to nondeterminism in the code. The control had already answered the question.

Current state, after `391d806`:

| where | runs | failures |
| --- | --- | --- |
| `HEAD`, isolated file | 24+ | 0 |
| `c96ad53` in a detached worktree | 8 | 0 |
| `HEAD`, with a source-churn watcher sampling every 500ms | 10 | 0 failures, 0 source changes detected |

## What went wrong in my method

- **I compared two numbers across time without pinning the commit**, in a repository where
  four lanes commit hourly. The number moved because the code moved.
- **I ran the right control and did not believe it.** A clean tree passing while a dirty
  tree fails is the whole answer; I treated it as one datum among several.
- **My reproduction "lever" measured the wrong thing.** Adding an async hop to fetch raised
  the failure rate from about 1-in-3 to about 5-in-6, which I read as evidence of an
  ordering bug in the pipeline. A longer run window is also a wider window for a concurrent
  writer to land in, so the lever is equally consistent with the shared-tree explanation.
  It discriminated nothing.

The one thing I did right here is the part worth keeping: I killed my own escaped-fetch
theory with six instrumented runs and zero calls, and reported the kill. The same standard
applied to the drift claim earlier would have caught this before it reached a report.

## Consequence for P8 clause (i)

The five-clean-runs clause is still worth having, and the reason it was unsound is now a
different reason than the one recorded. It is not that a code defect randomly fails a test;
at a fixed commit with an undisturbed tree the suite is stable across every run measured
here. It is that **the suite was being run against a shared working tree that other agents
were writing to**, so "npm test passes" described the tree at an instant rather than the
commit under claim.

The fix is procedural and cheap: run the acceptance suites from a **detached worktree at
the pinned commit**, not from the shared checkout.

```
git worktree add --detach /tmp/p8-verify <pinned-commit>
ln -s <repo>/engine/node_modules /tmp/p8-verify/engine/node_modules
cd /tmp/p8-verify/engine && npm test
```

That is how the `c96ad53` column above was measured, and it makes the claim "green at the
pinned commit" mean what it says.
