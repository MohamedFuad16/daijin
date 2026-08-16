# P3.5: curated versus generated, on one repo

COMMIT PIN: `81d453aaf200ecc1c27dfdca6f8b201bb976736a` (portfolio-mine). Working tree clean
before and after both runs, HEAD unchanged, checked on both sides of each.

EMBEDDING IDENTITY: `ollama/bge-m3`, dimension 1024, digest
`7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab`. Identical on both arms.

Both arms were produced by ONE code path at one code version: same pipeline, same gauge
method, same budget sweep, and the same permuted-control construction (the answer-id
exclusion derangement in `permuteAnswers`, called by the pipeline's own resolution step on
both arms). The generated arm was re-run for this comparison rather than reusing the earlier
P3 numbers, so no difference between the arms can come from a difference in the code that
measured them.

## The pre-registered metric: discriminating range

| | generated (Layer 1) | adopted (curated `agent/`) |
| --- | --- | --- |
| units in the brain | 11 | 257 |
| chunks | 49 | 266 |
| floor | **25 of 25** (exact 1) | **24 of 25** (exact 0.96) |
| MRR | 0.9600 | 0.8590 |
| violations | 0 | 0 |
| chosen budget | 3000 | 3000 |
| permuted control | 18 of 25 | **4 of 25** |
| **discriminating range** | **7 cases** (0.2800) | **20 cases** (0.8000) |
| MRR range | 0.8235 | 0.7633 |
| content survival | pass (0 truncated) | **fail (4 truncated)** |
| MCP unlock | unlocked, WITH saturation warning | unlocked, no warning |

Read on the pre-registered metric: **the curated brain is far more measurable.** Its gauge
has 20 cases of discriminating room against the generated brain's 7. The raw case rates are
nearly identical (25 of 25 against 24 of 25) and say almost nothing, which is exactly why
the metric was pre-registered as the range rather than the rate.

The saturation warning fires on the generated arm and not the curated one, from the same
threshold and the same code. That is finding 80 working on real data: a gold set with
deliberately wrong answers scores 18 of 25 on the generated brain, within one case of the
0.75 unlock threshold, so the unlock there stands on 7 cases of room rather than on the
distance from zero.

## Does granularity explain the gap? No, and this was measured rather than assumed

The prediction to beat was that curated units are roughly four times the size of generated
ones (the platform's curated units run 1000 to 1250 tokens against Layer 1 cards at about
250), so a fixed token budget would buy far fewer curated documents and the two arms would
not be comparable at the same `k` and budget.

Measured (`delivery.json`), both arms at k=8 and a 3000-token budget:

| | generated | adopted |
| --- | --- | --- |
| mean units returned per query | 6.96 | 7.28 |
| as a fraction of the corpus | 0.6327 | 0.0283 |
| mean tokens returned per query | 856 | 2672 |
| median unit size (tokens) | 190 | 95 |
| largest unit (tokens) | 368 | 1625 |

Both arms return about seven units per query, because `k` binds before the token budget on
both. So granularity does NOT explain the gap. What explains it is CORPUS SIZE: seven units
out of eleven is 63 percent of the generated brain, and seven out of 257 is under 3 percent
of the curated one. A gold set's wrong answer lands in the returned set most of the time in
the first case and almost never in the second.

The four-to-one unit-size assumption also did not survive contact with this folder: these
curated units have a MEDIAN of 95 tokens, smaller than the generated cards, because a
hand-written `errors.md` is a list of one-paragraph records. The 1000-to-1250 figure came
from the platform's brain and is not a property of curated writing in general.

Where unit size does bite is the tail: the largest curated unit is 1625 tokens against a
per-candidate cap of 660 at a 3000-token budget, and the content-survival gate fails on the
curated arm with four delivered units losing their core. The generated arm passes it. That
is a real, actionable difference and it is about the LARGEST units, not the median.

## What the adopt path had to learn from this target

The curated arm did not measure on the first three attempts, and the reasons are properties
of curated writing rather than bugs in the target:

1. A record's title sits verbatim inside its own body, so title-as-query leaks by
   construction. Curated records are not mechanically askable through their titles.
2. A curated brain cross-references itself constantly. Each ADR label appeared in two to
   eight units (its own record, the index, other ADRs citing it, state entries, component
   docs), so "the unit that mentions X" has no unique answer. The sound rule is TITLE
   OWNERSHIP: exactly one record carries the label in its title, and the units that merely
   cite it become `must_not_outrank` distractors.
3. Labels only exist where a folder numbers its records, which on this target is two
   documents. A label-only gauge measured two types and two areas and failed the diversity
   spread floor for a real reason. Path self-reference (a repo file named by exactly one
   record) is what reaches components, architecture, data and errors.

The general finding: a GENERATED brain is mechanically measurable because it is generated
(every fact has exactly one home by construction, and a card's claim is not its query). A
CURATED brain is measurable only through the narrow non-leaky, non-duplicated seams above,
and the plan already anticipated the rest of the answer: paraphrase queries belong to the
auditor, behind the spend boundary.

## Files

| file | what it is |
| --- | --- |
| `generated-report.json` | the Layer 1 arm's full run record |
| `adopted-report.json` | the adopt arm's full run record, including the per-file split rules |
| `generated-goldset.yaml` | the 25 mined cases for the generated brain |
| `adopted-goldset.yaml` | the 25 mined cases for the curated brain |
| `delivery.json` | units and tokens returned per query on both arms |
| `run-generated.mjs`, `run-adopted.mjs` | the two run scripts; they differ only in `mode` |

Both scripts leave the target repo untouched: artifacts to a scratch `artifactRoot`, brain
database in the run directory, gate commands in a `git archive` export at the pin.

## A note for the dash scan

`adopted-report.json` contains em dashes. They are confined to `units[].title`,
`units[].body`, `units[].content`, `units[].core` and `units[].meta.section`, which are the
owner's own curated prose captured VERBATIM from `agent/decisions.md`, whose ADR headings
use them. Nothing authored for this project contains one, and the data is deliberately not
rewritten: an adopted unit that does not match its source file byte for byte would make the
citation false and the artifact useless as evidence. The project's no-dash rule governs what
is written here, not what is quoted from elsewhere.
