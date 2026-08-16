# Clause (i) at the pin: the detached-worktree procedure, demonstrated

Dated 2026-08-16, by the extractor. Registered as clause (i)'s fourth sharpening; this is
the demonstration rather than the argument, per the ruling.

## Why a worktree rather than more runs

Five runs against the shared checkout are five samples of whatever the tree happened to
contain at the time, because four lanes commit and edit in it continuously. That is not a
statement about anyone's discipline: it is what a shared working directory is. Raising the
run count samples the same wrong thing more often.

A detached worktree at the pinned commit is the checkout the claim is about, and nothing
else can write to it.

## The procedure

```
git worktree add --detach <somewhere>/p8-verify <pinned-commit>
ln -s <repo>/engine/node_modules <somewhere>/p8-verify/engine/node_modules
cd <somewhere>/p8-verify/engine && npm test
```

The symlink is deliberate and worth naming: `node_modules` is not part of the commit, so
sharing the installed tree keeps the run measuring the pinned SOURCE rather than an
install that happened to differ. If a dependency version is ever part of a claim, that
symlink is the thing to replace with a clean install.

## Result at pin `e65cd2d`

Five consecutive runs, run count recorded as the clause requires:

| run | tests | pass | fail |
| --- | --- | --- | --- |
| 1 | 590 | 590 | 0 |
| 2 | 590 | 590 | 0 |
| 3 | 590 | 590 | 0 |
| 4 | 590 | 590 | 0 |
| 5 | 590 | 590 | 0 |

## Report 18's assertion: the tree did not move under the run

Source digest over every `.js` and `.py` file in the worktree, taken before and after a
full suite run:

```
before: e370a5a92c5ffedf
after:  e370a5a92c5ffedf
```

**Stated bound, as the verifier asked:** a before/after digest cannot see a mutation window
that opens and closes entirely inside the run. It proves the tree ended as it started, not
that it never changed. What makes the worktree stronger than the digest is that no other
process has a reason to write there at all.

## Report 21's addition: the stability claim, re-derived rather than re-read

The retraction cited six-for-six identical chunking decisions at a fixed commit. The
verifier read that number rather than re-running it, and said so. Re-derived here, in this
worktree, at this pin:

| run | chunk writes | total chunks |
| --- | --- | --- |
| 1..6 | 159 | 699 |

Distinct decision lists across the six runs: **1**. Not merely equal totals, the same
per-document decisions in the same order every time.

Verified by:

```
PROBE_ENGINE=<worktree>/engine PROBE_LOG=<log> \
  node --import file://docs/verification/init-chunk-drift/count-probe.mjs \
  --test test/init-pipeline.test.js
```

## What this does and does not establish

- It establishes that at `e65cd2d`, in an undisturbed checkout, the suite is green five
  times out of five and the init pipeline's chunking is deterministic six times out of six.
- It does NOT establish that the suite is free of load-dependent races. The CI
  gates-are-data failure was exactly that, and quiet local runs cannot exclude it: that is
  why the report-20 fix had to land before these runs rather than be measured by them. The
  fix is in the pin (`1cd98b6`).
- It does not speak for the TUI suite, which is tui-builder's half of the clause.
