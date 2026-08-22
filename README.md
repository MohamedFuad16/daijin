<div align="center">

# Daijin

**A project brain for any repo: measured retrieval served over MCP, and a gym that grades what the brain teaches and feeds the lessons back. Terminal-native.**

[![TUI](https://img.shields.io/badge/TUI-Python_Textual-1f425f?style=for-the-badge&logo=python&logoColor=white)](tui/)
[![Engine](https://img.shields.io/badge/Engine-Node_22_ESM-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](engine/)
[![Retrieval](https://img.shields.io/badge/Retrieval-Local_first%2C_zero_spend-brightgreen?style=for-the-badge)](#the-floor-is-measured)
[![Tests](https://img.shields.io/badge/Tests-1250%2B_across_both_suites-blue?style=for-the-badge)](#development)

</div>

---

## Overview

Daijin connects to any git repository, builds a **project brain** (durable,
evidence-cited markdown knowledge distilled from the codebase and its history),
indexes it locally, and serves it to AI assistants over **MCP**, but only after
the brain passes a **measured retrieval floor**. A brain that cannot answer
questions about its own repo does not get recommended to your tools.

On top of the brain sits a **certification gym**: exams mined from the repo's
real commit history, run under a harness with graded five-axis rubrics, an
append-only ledger, and a spend gate that is **blocked by default** and opened
only by the owner's hand. The loop closes: graded gaps become questions to the
teacher role, surviving answers become **lesson proposals**, and applying an
accepted batch writes durable lessons into the brain and reindexes it, so
retrieval improves from what the gym measured - an active RAG loop with a
human hand on every write.

The whole product is terminal-native: a Python Textual TUI over a Node engine
daemon, speaking a frozen JSON-RPC contract over stdio or a Unix socket.

## Features

- **Brain init pipeline**: analyze the repo, scaffold a canonical markdown
  brain (`.daijin/brain/`: architecture, conventions, decisions, lessons),
  mine a gold set of retrieval cases from real commits, and index it all
  locally. The index is disposable by design; the brain files are the truth
  and the index regenerates from them at any time.
- **Three-layer memory architecture**: the agent contract (never indexed,
  always loaded), the brain (durable, hand-editable markdown with citations),
  and the index (throwaway, lives outside the repo under `~/.daijin/`).
  Generated brains are hand-editable into curated ones with no format
  migration.
- **A floor, not a vibe**: retrieval quality is scored against the mined gold
  set and reported in count form (`31 of 34`), never as a bare rounded
  percentage. Every floor report carries a permuted-control range so a
  saturated score cannot masquerade as a meaningful one. MCP serving unlocks
  only above the floor threshold.
- **Local-first, zero-spend retrieval**: bge-m3 embeddings via local Ollama,
  sqlite-vec + FTS5 hybrid search with RRF fusion. Nothing in the retrieval
  path calls a paid API, ever.
- **Certification gym**: exams with provenance, five-axis graded rubrics
  rendered as radar and dithered charts, per-attempt token accounting against
  the real cap, quarantine semantics for compromised benchmarks, and
  certify-by-elimination. All provider spend sits behind an owner-only gate
  file; the engine can only ever write it blocked. Run modes read plainly in
  the UI: practice (ungraded), graded practice, and official runs that touch
  the scored record.
- **The learning loop**: `gymHarvest` turns graded gaps into lesson proposals
  (proposal-only, teacher-answered, citation-checked against current code);
  `gymHarvestApply` is the owner's separate act that writes accepted
  evaluation lessons into `.daijin/brain/lessons/` and reindexes. A rubric
  graded below pass must name its gaps, and measured-only tags (model-limit,
  harness-defect, stale-gold) never write to the brain - the loop refuses to
  teach a lie.
- **Four model roles, yours to configure**: the engineer (student under
  test), teacher (grades with citations), auditor (mines exams, narrates
  diagnoses, triages findings), and watcher (verifies findings cheaply, in
  its own voice, before the auditor reads them). Any OpenAI-compatible
  provider or a local Claude Code agent per role.
- **A board with a goal loop**: a zero-spend watcher sweep that runs until
  the tool is clean, with optional paid triage where the watcher verifies
  each finding and the auditor judges it - both voices on the finding's
  thread.
- **Eight-screen TUI**: repos, init activity feed (live step events), brain
  browser + retrieval tester, gates, gym, exams, board, settings. Textured
  chart vocabulary (pattern and color as two channels, readable without
  color), three motion modes (full, reduced, off), and a full mock mode so
  the UI runs with no engine at all.
- **Gates as data**: CI commands are discovered from the repo, classified
  against a measured baseline, and stored in a `gates.yaml` the user owns.
  The engine never overwrites a user's edit; if discovery loses the race it
  keeps your version and says so on the stream.
- **A contract that can fail the build**: the RPC surface is a frozen,
  versioned document, and a shape gate asserts that what the engine emits
  matches what the contract documents, in both directions, with its
  uncovered set printed every run.

## How It Works

```
1. Attach     daijin connects to your repo; state lives under ~/.daijin, never in your tree.
2. Init       analyze -> scaffold brain -> mine gold set -> discover gates -> index -> measure.
3. Floor      retrieval is scored against the gold set, with a permuted control beside it.
4. Serve      above the floor, daijin hands you a paste-ready MCP snippet for your tools.
5. Gym        (owner-gated) exams run under the harness; rubrics grade five axes; the
              ledger records everything, and only official runs touch the scored record.
6. Learn      graded gaps become teacher-answered lesson proposals; applying an accepted
              batch writes lessons into the brain and reindexes, closing the RAG loop.
```

## Tech Stack

| Layer | Technology |
| ----- | ---------- |
| TUI | Python 3.12+, Textual, plotext, custom texture/motion vocabularies |
| Engine | Node 22, pure ESM, no framework |
| Store | SQLite + sqlite-vec (1024-dim) + FTS5 (`porter unicode61`), RRF fusion |
| Embeddings | Ollama, `bge-m3`, fully local |
| RPC | JSON-RPC 2.0 over stdio or Unix socket, frozen contract (`methods.md` v5) |
| Serving | MCP (Model Context Protocol) server per repo |
| Testing | `node:test` (engine, 800+) and pytest (TUI, 450+), mutation-verified gates |

## Project Structure

```
engine/                  # Node daemon: store, init pipeline, RAG, gym, RPC, MCP
  src/store/store.d.ts   # Frozen storage contract
  src/rpc/methods.md     # Frozen RPC contract (v5), enforced by a shape gate
  test-live/             # Live-only harnesses (need Ollama): fixtures, parity, acceptance
tui/                     # Python Textual client: eight screens, mock mode, motion + texture
adapters/                # sqlite-vec + FTS5 binding, Ollama client
install/                 # Install script and clean-machine dry run
docs/
  daijin-build-plan.md   # The authoritative build plan and registered acceptances
  verification/          # Durable evidence: measurements, mutation batteries, protocols
agent/                   # Build records: state.md (authoritative), decisions.md (ADRs)
```

## Install

Prereqs: Node 22+, Python 3.10+, and a local [Ollama](https://ollama.com) with
`bge-m3` pulled (only needed for real indexing; the TUI runs without it in
mock mode).

```bash
git clone https://github.com/MohamedFuad16/daijin.git
cd daijin
bash install/install.sh
```

That installs both halves into one self-contained prefix
(`~/.local/share/daijin`), puts a single `daijin` command on your PATH, and
keeps its Python environment private, so nothing fights whatever you already
have. Re-runnable: installing twice lands in the same state as once. Then:

```bash
daijin /path/to/your/repo    # connect to a real repo (spawns the engine daemon)
daijin . --mock              # or explore the full UI with no engine and no Ollama
```

A hosted `curl | bash` one-liner ships with the first release. `uninstall.sh`
removes the program and tells you, honestly, which data it will not touch and
why.

## Development

To hack on Daijin itself rather than install it:

```bash
# Engine
cd engine
npm install
npm test                 # 800+ tests, zero network, zero spend

# TUI
cd ../tui
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest   # 450+ tests
.venv/bin/daijin . --mock    # run the dev checkout directly
```

Everything above runs at zero spend. The only provider-calling paths in the
product (gym runs, auditor narration, Layer 2 enrichment) refuse unless the
owner's spend gate is open and the spend is explicitly confirmed in the UI.

## The Floor Is Measured

Anchors from the source platform, kept exact because rounded displays have
failed healthy trees before. Verify against the committed baselines; do not
re-derive from memory.

[Corrected 2026-08-16 after verifier report 1: the first freeze of this section
carried k=10 and a rounded 91.2% floor; both were wrong against the committed
baseline.]

- Retrieval floor, per the platform's `retrieval-baseline.json` (measured
  2026-08-14, corpus 538 documents): caseRate exactly
  `0.9117647058823529` = 31 of 34 cases. caseRate and violations (0) are
  enforced; MRR (`0.6588935574229692`) is recorded for movement only and
  deliberately not floored (case rate has fallen while MRR rose).
- Config behind the floor: k=8, tokenBudget 4000, RRF_K 60,
  perCandidateCapRatio 0.22, slot floor 0.55, raw-cosine champion.
- Budgets are measured per corpus by an init-time sweep (3k/4k/6k/8k),
  smallest budget within one case of the best score; the content-survival
  gate is the mechanical raise signal, and it has moved a real budget.
- Three MRR reference points exist for the platform corpus at k=8; any
  comparison names its reference and path (D-0017).

## Project Discipline

- **Zero-spend defaults.** Nothing in retrieval calls a paid API. Gym spend
  sits behind an owner gate, blocked by default, observable before anything
  is attempted.
- **Tests first, and tests that can fail.** Every mechanism ships with a test
  that fails without it; gates and batteries are mutation-verified, and a
  check that has never been seen to fail is not yet a check.
- **Frozen contracts**: `engine/src/store/store.d.ts` and
  `engine/src/rpc/methods.md`. Contract changes require the leader, and the
  shape gate makes the contract able to break the build.
- **Style**: no em dashes or en dashes anywhere; identifiers and commits in
  English.

## License

Private project. All rights reserved.

---

<div align="center">
Built by <a href="https://github.com/MohamedFuad16">Mohamed Fuad</a>
</div>
