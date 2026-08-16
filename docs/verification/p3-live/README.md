# P3 constants-generalization run: preserved artifacts

COMMIT PIN: `81d453aaf200ecc1c27dfdca6f8b201bb976736a` (portfolio-mine). Working tree clean
before and after the run, HEAD unchanged, checked with `git status --porcelain` on both
sides. The pin leads because it is the one clause that cannot be repaired retroactively: if
the repo moves, a re-derivation stops being the same experiment.

EMBEDDING IDENTITY: provider `ollama`, model `bge-m3`, dimension `1024`, digest
`7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`. Served as
`bge-m3:latest` by ollama 0.32.1; the run compares the served digest to the configured one
before indexing and refuses if they differ.

FLOOR: **25 of 25, exact 1**. MRR 0.96. Violations 0. Chosen budget 3000 tokens from a flat
3k/4k/6k/8k curve. Identifier cases 5 of 5. MCP unlock: unlocked at the 0.75 threshold.

## The qualifier that belongs with the number wherever it is quoted

A permuted control (same 25 queries, every answer deliberately reassigned to a different
unit) scores **18 of 25 = 0.72**, because at 11 documents k=8 delivers most of the corpus on
every query. Case rate retains 0.28 of discriminating range on this corpus; MRR retains
0.8235.

> **CORRECTION 2026-08-16.** The delivery figure first published here was "a mean of 7.6 of
> 11 documents per query", measured over 5 of the 25 queries. Re-measured over ALL 25
> (`delivery-all25.json`): the mean is **6.96 of 11, a fraction of 0.6327**, with a range of
> 3 to 8 and a median of 8. The original number overstated delivery by about 6 points
> because the 5-query sample happened to contain four queries that returned the full 8.
>
> This slightly WEAKENS the numeric agreement the mechanism was checked against, and that is
> stated rather than smoothed: if a query returns 6.96 of 11 documents, a deliberately wrong
> answer lands in the returned set about 63 percent of the time, against 72 percent
> observed. The prediction was 0.69 against 0.72 observed on the 5-query figure and is 0.63
> against 0.72 on the full one. The mechanism still explains the observation and now
> under-predicts it, which is the expected direction: retrieval is not random, and the
> permuted answers are still real documents in a corpus small enough that many of them are
> broadly relevant to any query.

Read that as: the ENFORCED metric saturates on a small corpus, and the metric this project
deliberately does not floor (MRR) is the one still carrying signal there. 25 of 25 is
arithmetically correct and nearly uninformative. It is not evidence that retrieval is
perfect on portfolio-mine.

A second, independent instrument agrees. Driving a deliberately worst-case reranker (full
order inversion, the most destructive reordering available) through the real retrieval seam
over this same brain costs only four cases on the enforced metric while collapsing MRR by
0.76: 25 of 25 and MRR 0.9600 becomes 21 of 25 and MRR 0.1957. Two different instruments,
same conclusion, which is what makes the ceiling a fact rather than a reading.

## Files

| file | what it is |
| --- | --- |
| `init-report.json` | the full run record: analysis, evidence counts, scaffold, ingest, gates, gold-set gates, floor, budget curve, content survival, MCP decision, and the pin |
| `control-report.json` | the permuted-answer control: corpus size, mean documents delivered per query, candidate and control metrics. Its `meanReturnedPerQuery` is the superseded 5-query figure; see the correction above |
| `delivery-all25.json` | the delivery re-measurement over all 25 queries, per-query and aggregate |
| `goldset.yaml` | the 25 mined cases, each with provenance, stable key, and the reason it exists |
| `gates.yaml` | the discovered gate, classified with its liveness evidence |
| `run-init.mjs` | the script that produced `init-report.json` |
| `run-control.mjs` | the script that produced `control-report.json` |

## Re-deriving

Both scripts take a run directory and write into it. They need the pinned repo present, a
local Ollama serving bge-m3 at the digest above, and the daijin engine on disk:

    node run-init.mjs <run-dir>        # writes <run-dir>/p3-report.json plus .daijin artifacts
    node run-control.mjs <run-dir>     # reads the brain the first script built

The run is Layer 1 only and zero spend: no provider is called, the embedder is the local
Ollama, and the Layer 2 narration path refuses by construction.

The target repo is READ-ONLY and stays that way. Artifacts go to an `artifactRoot` outside
it, the brain database lives in the run directory, and gate commands execute in a
`git archive` export at the pinned commit, because a build gate emits files and running it
in the target would have been a mutation.

## What the gate classification means here

One candidate was found (`pnpm run build`; `dev` and `preview` are correctly excluded as
long-running) and classified `unavailable`, so coverage is 0 of 1. The reason is named in
`gates.yaml`: pnpm is not installed on this machine and the sandbox has no `node_modules`.
That is a fact about the machine, not about the repo, which is why it is `unavailable` and
not `pre-broken`. `pre-broken` is a claim that the repo is failing its own checks and a user
acts on it.

## Three runs, and why there were three

Run 1 blocked at the gold-set gates (leakage plus diversity). Run 2 blocked at diversity
alone. Run 3 measured. Nothing tuned between them was a constant, a threshold or a floor:

1. Run 1 to 2 fixed a leakage FALSE POSITIVE (a scoped package name, `@vitejs/plugin-react`,
   tokenizes to a six-token run of which three are punctuation) and split Node built-ins out
   of the external-package tables.
2. Run 2 to 3 fixed a case-selection bug that dropped 10 of 29 available candidates whenever
   the identifier quota seated one answer above the widening allowance.

The second one is worth reading carefully by anyone attacking this record. It produced a
low result that LOOKED like an honest negative finding: "this repo cannot supply 25
mechanically mined cases, the floor binds, the gauge refuses." That conclusion was wrong,
and the cause was a bug in the miner rather than a property of the repo. Once repaired the
miner had 29 candidates for 25 slots.

## The rerank A/B on this brain

`docs/verification/rerank-ab/` holds the D-0025 falsification arm measured against this same
pinned brain: neutral on all four pairs, with the cost and the withheld cache-flattered
latency documented there. Its plumbing proof also measures this corpus's ceiling from a
second direction, and the platform half of that evidence is at
`engine/src/rag/RERANK-MEASUREMENT.md`.
