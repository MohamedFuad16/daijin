# D-0025 rerank A/B: the portfolio-mine falsification arm

The other half of this evidence is the PLATFORM arm, run by the extractor and written up at
`engine/src/rag/RERANK-MEASUREMENT.md`. D-0025 registered a two-arm design and neither half
means much alone: the platform corpus is the promotion arm, this one is the falsification
arm. Read them together.

COMMIT PIN: `81d453aaf200ecc1c27dfdca6f8b201bb976736a` (portfolio-mine), tree clean before
and after.
BACKEND: `llama-server:bge-reranker-v2-m3` (bge-reranker-v2-m3-Q8_0.gguf) at
`http://localhost:8012`, probed for discriminating scores before use. The server has since
been stopped, which is part of why this record exists.
EMBEDDER: `ollama/bge-m3`, dimension 1024, digest
`7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`.

## Result: neutral on all four pairs

| budget | topK | case rate | MRR | violations | verdict |
| --- | --- | --- | --- | --- | --- |
| 3000 | 20 | 25 of 25 to 25 of 25 | 0.960000 to 0.950000 | 0 to 0 | neutral |
| 3000 | 40 | 25 of 25 to 25 of 25 | 0.960000 to 0.950000 | 0 to 0 | neutral |
| 4000 | 20 | 25 of 25 to 25 of 25 | 0.960000 to 0.950000 | 0 to 0 | neutral |
| 4000 | 40 | 25 of 25 to 25 of 25 | 0.960000 to 0.950000 | 0 to 0 | neutral |

Arm disclosures were CHECKED against the harness's own record rather than assumed from what
was requested: every control reported `{"enabled":false}` and every treatment reported
`{"enabled":true,topK,backend}`. A run where those disagreed would have been refused.

## How to read it, per the D-0025 amendment

NEUTRAL here is evidence about the GAUGE, not about reranking. The control arm sits at
25 of 25, which is the ceiling, so `caseDelta` could only be zero or negative and a win was
impossible by construction. No regression appeared, so this arm produces no disqualifying
evidence against the reranker either.

The MRR movement of -0.01 is recorded and had no vote (D-0017: MRR never promotes). It is
also small and decomposable: -0.01 across 25 cases is exactly -0.25 of total reciprocal
rank, which is one case moving from rank 2 to rank 4. One case reordered slightly worse;
nothing else moved.

## Cost, and the number that was withheld

D-0025 requires the knob's cost displayed beside it. The raw per-arm latencies were
incoherent: topK 40 measured 15087 ms per query on one pair and 1491 ms on another, a
tenfold difference for identical work. That is llama-server caching query-document pairs,
so every arm after the first re-asks questions already answered and measures the cache
rather than the compute. The 1491 ms figure was the flattering one and it is not the price.

Only the first arm to score a given topK is treated as a price measurement. Cold:

- topK 20: about 6.7 seconds per query
- topK 40: about 15 seconds per query
- control (no rerank): about 0.24 seconds per query

An isolated single-query measurement taken separately agrees: 10.0 s for one reranked
retrieval over 40 real chunks. So reranking costs one to two orders of magnitude more per
query than not reranking on this machine, and bought nothing measurable on this corpus.

## A gap left visible

These four pairs are identical in every field the runner captured at the time, which is a
WEAKER statement than "the four pairs did the same thing". The extractor measured on the
platform corpus that topK 20 and 40 can match in every summary field while a
retrieval-level differ finds eighteen differences across seven cases. The runner now records
a per-case diff and a `movedWithoutScoring` count, but that fix landed after this run and
the backend is gone, so for THIS measurement the question is unanswerable rather than merely
unanswered.

## Files

| file | what it is |
| --- | --- |
| `portfolio-mine-report.json` | the full A/B record: every pair, both arms, judgments, resolution, arm disclosures |
| `run-portfolio-arm.mjs` | the script that produced it |
| `run-plumbing-proof.mjs` | the two-stub proof that the option reaches the ranker |

## The plumbing proof, which is why the numbers are about the reranker

Before trusting any result, the option was proved to reach the stage using two stubs chosen
to prove opposite things, run through the real seam over this same brain:

- an order-PRESERVING stub left the measurement byte-identical (25 of 25, MRR 0.9600,
  delta exactly 0), so the option is accepted and correctly does nothing when order does not
  change;
- an order-INVERTING stub moved it to 21 of 25 and MRR 0.1957, so the flag genuinely reaches
  the ranker.

A single stub would have proved only one of those, and the identity stub is the one that
would have quietly passed if the flag were being dropped.

That inversion also measures the corpus ceiling from a second direction: the most
destructive reordering available costs only four cases on the enforced metric while
collapsing MRR by 0.76.
