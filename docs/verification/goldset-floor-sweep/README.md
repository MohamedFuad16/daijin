# Where the gold-set measurability floor came from

Dated 2026-08-17, by the extractor. The basis for `DEFAULT_FLOORS.minimumCases = 12`
(D-0046). It lives here rather than in scratch because a policy threshold whose evidence is
gone is a number nobody can check, and this one's basis changed twice while it was being
measured.

## The question

The owner's re-test mined 18 gold cases from a real repository and the gold set BLOCKED.
The gate that fired was a bare count at 25, with every other check passing:

```
count 18, minimum 25 (of 18 active cases, 6 identifier, 4 types, 5 areas)
failures  [{"check":"count","got":18,"floor":25}]
```

25 was the PLATFORM'S TARGET, measured on a large corpus, being used as a floor for every
repository. The question is not whether 18 is less than 25. It is: below what count does a
case rate stop being a measurement?

## What was measured

Both instruments subsample the platform corpus (34 cases, the only gold set here with a
committed baseline), score it, and read the result. Zero spend: local ollama embeddings.

- `headroom-sweep.mjs` scores each subsample against a PERMUTED CONTROL whose answers are
  deliberately wrong, and reports the gap (D-0030's discriminating range).
- `spread.mjs` scores 30 independent draws per size and reports the DISPERSION of the
  resulting floor.

Both use seeded sampling, so a re-run reproduces these numbers.

## Result 1: discrimination does not pick the floor

Minimum headroom over a permuted control, by size, across random and clustered draws:

| size | random draws | clustered draws (2 areas) |
| --- | --- | --- |
| 6 | 3 | - |
| 12 | 7 | 8 |
| 18 | 10 | 13 |
| 25 | 15 | 20 |

Headroom NEVER REACHES ZERO, at any size tested, down to six cases. So a gold set of six
still separates a working retriever from a broken one, and D-0030's criterion - the tool
this floor was expected to come from - cannot pick the number. It is kept as a separate
gate because it catches a set that is large and degenerate, which a count can never see,
but on this evidence it will rarely bind.

## Result 2: what does bind is resolution

Thirty independent draws per size. `sd` is the standard deviation of the measured floor
across equally valid minings of ONE corpus - same retriever, same index, only which cases
were mined differing.

| size | mean | sd | p10 | p90 | p90-p10 | one case is worth |
| --- | --- | --- | --- | --- | --- | --- |
| 12 | 93.6 | 6.1 | 83.3 | 100.0 | 16.7 | 8.3 pts |
| 15 | 93.3 | 5.5 | 86.7 | 100.0 | 13.3 | 6.7 pts |
| 18 | 92.0 | 4.8 | 88.9 | 100.0 | 11.1 | 5.6 pts |
| 25 | 91.3 | 3.2 | 88.0 | 96.0 | 8.0 | 4.0 pts |

Raw output in `spread-30-draws.txt` (seed 20000).

### Seed sensitivity: the dispersion did NOT survive a fresh seed

Re-run with `SEED=777001`, raw output in `spread-30-draws-seed777001.txt`:

| size | sd (20000 to 777001) | p10-p90 band | band in CASES |
| --- | --- | --- | --- |
| 12 | 6.1 to 7.2 | 16.7 to 16.7 | 2 to 2 |
| 15 | 5.5 to 6.4 | 13.3 to 13.3 | 2 to 2 |
| 18 | 4.8 to 4.7 | 11.1 to **16.7** | 2 to **3** |
| 25 | 3.2 to 2.8 | 8.0 to 8.0 | 2 to 2 |

The standard deviation moves by up to 18 percent, and the p10-p90 band moved at one size of
four. SO NO MEASURED SPREAD IS QUOTED IN USER-FACING COPY: the caution states the per-case
weight alone, which is exact arithmetic and identical on every run.

There is a reason the band looks stable where it is stable, and it is worth knowing before
anyone quotes it. At N cases the case rate is QUANTIZED to steps of 1/N, so p10 and p90 snap
to case boundaries. Expressed in cases rather than points the band is "about two cases" at
almost every size and seed - which is a restatement of the per-case arithmetic times two,
not an independent measurement of anything. A figure that is stable because it is coarse is
not the same as a figure that is stable because it is well estimated.

## THERE IS NO KNEE, and an earlier version of this document said there was

The first version of this measurement used max-minus-min over six to ten draws and reported
a knee between 12 and 15. Re-running it with different seeds:

| size | first run | second run |
| --- | --- | --- |
| 12 | 25.0 pts | 8.3 pts |
| 18 | 11.1 pts | 16.7 pts |

The statistic moved by a factor of three between runs. It was a range rather than a
dispersion, over too few draws, and it could not locate a knee anywhere. The 30-draw
measurement above shows a SMOOTH DECLINE - 6.1, 5.5, 4.8, 3.2 - with no threshold in it.

This is recorded rather than replaced because the retraction is the more useful half: a
curve drawn through three noisy points is the shape a threshold argument most wants to
have, and this one did not survive a re-run.

## A caveat that was also wrong

The first version argued that subsampling a mature corpus is a BEST CASE, because a real
thin repo mines a more clustered set, and used that to argue the floor should be no lower
than 12. Measured instead of asserted: clustered draws (concentrated in two areas, which is
what a small repo mines) showed identical spread and BETTER headroom than random draws.
Clustering degrades neither axis on this corpus. Heavy clustering is separately caught by
the areas and types gates, so the count floor never had to carry that load.

## So where does 12 come from

From arithmetic, and it is A PRODUCT JUDGMENT MADE BY THE LEAD rather than an empirical
threshold found here. This directory supplies the arithmetic and rules out the criterion
that was expected to supply the number; it does not itself pick 12.

One case is `1/N` of the case rate. That is exact, needs no sampling, and does not move
between runs: 8.3 points at 12, 5.6 at 18, 4.0 at 25. The question the floor answers is how
coarse a number may be published as a measurement, and the ruling was that a legitimate
modest repository deserves a measurement with wide bars rather than a refusal. Below 12 a
single case is a tenth of the scale or worse.

The same evidence supports 15 or 18 equally well. It does not distinguish them, and the
choice among them is not a finding.

## What this evidence does not establish

- It is ONE corpus. Every number here is a property of the platform gold set and its index,
  and a different corpus could behave differently.
- Subsamples of a mature gold set are not the same object as a mined thin set, even though
  the clustering check above found no difference in the direction that was feared.
- `mean` drifts down with size (93.6 at 12, 91.3 at 25) because smaller sets drop hard
  cases as often as easy ones. That is a property of subsampling, not a finding about
  small repositories.

## Re-running

```
cd <repo>/engine
node ../docs/verification/goldset-floor-sweep/spread.mjs                 # DRAWS=30, SEED=20000
SEED=777001 node ../docs/verification/goldset-floor-sweep/spread.mjs     # a fresh seed
node ../docs/verification/goldset-floor-sweep/headroom-sweep.mjs         # REPEATS=5 by default
```

SEED IS A PARAMETER on purpose. The first version of this measurement used a fixed seed and
a range statistic and moved by a factor of three when re-run, which was invisible until
someone re-ran it. Any figure quoted from here - especially one destined for user-facing
copy - has to survive a fresh seed first.

Both need a reachable local ollama and the platform corpus (`DAIJIN_PLATFORM_ROOT`). They
read the corpus and write nothing.
