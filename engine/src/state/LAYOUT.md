# The path seam after D-0031

The relocation, written down before it is built, because init-miner's ingest is
moving to read canonical brain markdown at the same time and the two meet at
these paths. Anything here that is wrong is cheaper to argue with now.

STATUS: proposed 2026-08-16 by the extractor. Sections marked OPEN are the
judgment calls, and they are the ones worth reading first.

## Two axes, not one

D-0031 says the index is disposable and lives outside the repo. Reading that as
"machine state moves out" collapses two different questions into one, and the
collapse loses things:

- WHERE: the repo (travels with the project, committed, shared between people)
  or the state root (this machine's view of that project).
- WHETHER IT CAN BE REGENERATED: derived from the brain, or a record that exists
  nowhere else.

`brain.sqlite` is machine-scoped AND regenerable, which is why it can be deleted
freely. `score-history.json` is machine-scoped and NOT regenerable: the numbers
were measured by this machine's embedder on a date, and nothing can recompute
the past. Both leave the repo. Only one of them is disposable.

So the state root gets two subtrees per repo, and "delete the index" means one
directory rather than everything this machine knows.

## The layout

```
REPO, committed, human-readable, the source of truth
  .daijin/manifest.json     identity and schema; the lifecycle contract's API boundary
  .daijin/agents/*.md       CONTRACT: never ingested, never chunked, never retrieved
  .daijin/brain/**.md       BRAIN: canonical, evidence-cited, what ingest reads
  .daijin/goldset.yaml      the gauge, plus its retired-case record
  .daijin/gates.yaml        discovered gates, user-owned data
  .daijin/GATE              spend authorization, flipped by the owner's hand

STATE ROOT (default ~/.daijin), this machine
  repos.json settings.json board.json consent.jsonl    unchanged
  repos/<repoId>/
    origin.json             { repoPath, at }: which working tree this was built for
    index/
      brain.sqlite          THE INDEX. Disposable. Regenerated from .daijin/brain/
      discriminating-range.json   a cached measurement, keyed by its own fingerprint
    records/
      score-history.json    measured floors over time; nothing can recompute these
```

`index/` is what a clear-index command removes. `records/` is not touched by it.
A user who deletes the whole `repos/<repoId>/` directory loses the trend line and
keeps the project, which is the correct order of loss.

## Identity: the manifest owns it

`repoId` is generated once, at init, and written into `.daijin/manifest.json`.
It is the key the state root is organised by.

Keying by ABSOLUTE PATH was the obvious alternative and is worse: a repo that is
moved or renamed silently orphans its index and its history, and the user gets a
fresh 91.2 percent measurement with no trend behind it and no way to know why.

The manifest id has its own failure: two clones of the same repo carry the same
id and would share one index. That is why `origin.json` records the path the
index was built for. On open, a path that differs from `origin.json` means moved
OR cloned, and the two are indistinguishable from inside. The response is to
DISCLOSE and rebuild the index rather than to fail: the index is regenerable, so
rebuilding is cheap and correct in both cases, and `records/` is left alone
because a measurement history is not invalidated by a directory move.

OPEN: whether a clone should get its own id at init time. Writing a new id into
a clone means committing a manifest change back, which is a repo mutation for a
machine-local reason. I lean toward one id per project, shared by clones, with
`origin.json` handling the divergence. Owner's call if it matters.

## What does NOT move, and why

- `.daijin/gym.sqlite` and `.daijin/gym/results/`: these are the RECORD, not a
  derivation. Certifications are claims, and the drawn-cohort denominator is
  counted from the result files rather than from rows, so losing the files
  breaks a rule this build enforces. They are also gym-porter's lane. Unmoved
  and flagged rather than moved quietly.
- `.daijin/goldset.yaml`: the gold set is the gauge. It carries provenance per
  case and a retired-case record with dated reasons, which is memory rather than
  derivation, and a gauge that vanishes with a cache is not a gauge.
- `.daijin/GATE`: the owner flips it by hand and the platform commits it. Moving
  authorization to a machine-local directory would make a committed record of a
  spend decision impossible.

OPEN: the leader's brief named score-history as following the relocation, which
this proposal does, but into `records/` rather than into the disposable part.
If the intent was that a cleared index also clears the trend, say so and it
moves one directory up.

## The seam init-miner needs

Ingest reads FROM the repo and writes TO the index, and after this change those
are two different roots. One module owns the mapping and nothing else computes
these paths by hand:

```js
import { repoLayout } from '../state/layout.js';

const layout = await repoLayout(repoPath, { stateRoot });
layout.repoId            // from the manifest
layout.brainRoot         // <repo>/.daijin/brain       READ
layout.manifestPath      // <repo>/.daijin/manifest.json
layout.goldsetPath       // <repo>/.daijin/goldset.yaml
layout.databasePath      // <stateRoot>/repos/<id>/index/brain.sqlite   WRITE
layout.indexRoot         // the disposable directory
layout.recordsRoot       // the kept directory
```

The rule that makes the invariant hold in bytes rather than in intent: ingest
may READ nothing from `index/` that it did not write there, and may WRITE
nothing into `.daijin/` except the brain files and the manifest. If deleting
`index/` can lose something, something wrote a record into the wrong tree.

## The refusal that guards invariant 1

The contract is never ingested. That already holds in bytes (no reference to
`agents/` in the init pipeline) but nothing guarded it, so a refusal test lands
with this work: `agents/` and `manifest.json` offered to the ingest path are
refused by name, not skipped silently. A silent skip passes on the day someone
renames the directory.
