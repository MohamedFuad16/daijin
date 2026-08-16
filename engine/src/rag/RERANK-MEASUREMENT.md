# Cross-encoder rerank: the measured verdict

D-0025 required a measured gold-set win before the stage could become a default,
judged per D-0017: case rate and violations enforced, MRR reported as movement.

**VERDICT: no measured win. The knob ships OFF.** Measured 2026-08-16 on the
platform corpus, and the honest number is the deliverable.

## Setup

- Corpus: the platform gold set, 34 cases, k=8.
- Backend: llama-server (brew) with `bge-reranker-v2-m3-Q8_0.gguf` on port 8012,
  flags `--rerank -c 8192 -b 8192 -ub 8192`.
- Both arms run the SHIPPED (ordered) pgvector path, one option apart. They are
  NOT the P1 parity path: the stage refuses a parity-mode store by design, so the
  control here is the shipped-path number (MRR 0.6638) rather than the P1 parity
  number (MRR 0.6589), at an identical case rate.

Backend verified before use, not assumed: it discriminates (a relevant document
at +1.41, an irrelevant one at -11.02) and is deterministic (identical inputs
return identical scores to the last digit), which a comparison depends on.

## Numbers

| arm | case rate | MRR | violations | identifier | wall clock | per query |
| --- | --- | --- | --- | --- | --- | --- |
| control, rerank off | 0.9117647058823529 | 0.6637955182072829 | 0 | 1.000 | 6.1s | 0.18s |
| rerank topK=20 | 0.9117647058823529 | 0.6834033613445377 | 0 | 1.000 | 256.8s | 7.6s |
| rerank topK=40 | 0.9117647058823529 | 0.6834033613445377 | 0 | 1.000 | 495.1s | 14.6s |

## Reading

THE ENFORCED METRICS DID NOT MOVE. Case rate is identical to the last digit in
all three arms, and violations stay at 0. Per D-0017 those are what decide, so
there is no win to promote on.

MRR ROSE, +0.0196, and that is exactly the shape the floor's design says not to
trust. D-0017 does not floor MRR precisely because MRR is the number a pin can
buy directly, and during the one regression the platform has measured (2026-08-09)
case rate FELL while MRR ROSE. A change that moves only MRR is the signature the
gate exists to be unimpressed by. It is reported here as movement and nothing more.

Per case, the rerank moved five cases and the movement is mixed: g003 (0.5 to 1),
g007 (0.2 to 0.33), g012 (0.5 to 1) and g030 (0.17 to 0.20) improved, and **g010
got worse** (1 to 0.5). Four better, one worse, no case changed from hit to miss
or back. The cross-encoder is doing real work; it is not doing work the enforced
gauge can see.

THE COST IS 42x TO 81x. 0.18s per query becomes 7.6s at topK=20 and 14.6s at
topK=40, on this machine, on CPU. The initial context rides in every round of a
gym exam, so this is not a one-off cost per session.

topK=40 SCORES IDENTICALLY TO topK=20 while costing twice as much, so there is no
argument for the deeper shortlist on this corpus.

## A finding the score record alone would have hidden

topK=20 and topK=40 have identical scores on every case AND identical summaries,
so a score-level comparison calls them the same run. They are not: the
retrieval-level differ reports **18 differences** between them, including
different documents retrieved on g004, g005, g007, g017, g024, g029 and g030 and
token counts moving by up to 308.

The two arms retrieve differently and score identically. That is the exact shape
that makes "the numbers matched" an unsafe conclusion, and it is why the
diagnostics block and the retrieval-level pass exist (verifier finding 66).

## What ships

The knob, OFF, documented as measured-neutral on the enforced metrics and
positive on the reported one at 42x cost, on this corpus. Nothing about the
default changes.

## What this measurement does NOT say

- It says nothing about a corpus where the bi-encoder is weaker. 34 cases at a
  91.2% floor leaves 3 failing cases, so the headroom the enforced metric can
  even show is 3 cases wide. A rerank cannot demonstrate a case-rate win it has
  almost no room to make.
- It says nothing about the portfolio-mine corpus, which D-0025 also names. That
  corpus scores 25 of 25 with a permuted control at 18 of 25, so it has less
  discriminating range than this one, not more.
- It was measured on CPU. A machine with GPU offload would change the cost column
  and none of the quality columns.

The honest summary is that this corpus cannot answer the question the ruling asks,
because its enforced metric is nearly saturated. A corpus with real retrieval
failures is where a rerank would have room to prove itself, and that is the
measurement worth running when one exists.
