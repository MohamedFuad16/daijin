# Daijin

An installable engineering-memory tool: a Textual TUI over a Node engine daemon
that connects to any repo, builds and serves a project brain over MCP behind a
measured retrieval floor, and runs the certification gym with the ADR-0167
harness defaults.

Extracted from the AI Brain Platform
(`~/Documents/Codex/2026-07-21/hand-ai-brain-build-instructions-md/ai-brain-platform`).
The extraction copies, it never mutates the platform, until parity is proven.

## Layout

- `engine/` Node ESM. Copied core plus new code. Owns DB, MCP, gym, RPC.
- `tui/` Python Textual. Pure RPC client.
- `adapters/` sqlite-vec + FTS5 binding, Ollama client.
- `install/` curl script and packaging.
- `docs/daijin-build-plan.md` the authoritative build plan (leader's brief).
- `agent/state.md` the authoritative build-state record.

## Non-negotiable constraints

- Zero-spend defaults. Nothing in retrieval calls a paid API. Gym spend sits
  behind an owner gate, blocked by default.
- Tests first. Every mechanism ships with a test that fails without it.
- No em dashes or en dashes anywhere. Identifiers and commits in English.
- Frozen contracts: `engine/src/store/store.d.ts` and `engine/src/rpc/methods.md`.

## Measured anchors (verify, do not re-derive)

[Corrected 2026-08-16 after verifier report 1: the first freeze of this section
carried k=10 and a rounded 91.2% floor; both were wrong against the committed
baseline.]

- Retrieval floor, per platform/rag/retrieval-baseline.json (measured
  2026-08-14 at platform commit 7917fab, corpus 538 documents):
  caseRate exactly 0.9117647058823529, which is 31 of 34 cases. Floors compare
  against the exact rational, never a rounded percentage; a 0.912 floor fails
  a healthy tree. caseRate and violations (0) are ENFORCED. MRR
  0.6588935574229692 is recorded for movement only and deliberately NOT
  floored: in the 2026-08-09 regression, case rate fell while MRR rose.
- Config behind that floor: k=8, tokenBudget 4000, RRF_K 60,
  perCandidateCapRatio 0.22, slot floor 0.55, raw-cosine champion, standing
  pins outside the budget.
- FTS5 recipe: `tokenize='porter unicode61'` (porter stems), stopword
  filtering via a 30-word hand-written list approximating Postgres 'english'
  (not snowball), whitespace tokens as quoted phrases, bm25, top 40. Evidence:
  docs/fts5-report.json; the script docs/fts5-adapter-recipe.py is a preserved
  measurement instrument, not product code, and its header prose is corrected
  in place.
- Budget policy: 4,000 is the anchor; the shipped number is measured per repo
  by an init-time sweep at 3k/4k/6k/8k, smallest budget within one case of the
  best score. The content-survival gate is the mechanical raise signal.
- Platform suite: 599 tests, 599 pass (measured 2026-08-16 by the leader,
  `npm test` in the platform repo). This is the green constraint during
  extraction.
- Three measured MRR reference points on the platform corpus at k=8; any
  comparison names its reference and path (D-0017): 0.6588935574229692
  pgvector parity path; 0.6637955182072829 pgvector shipped path (ORDER BY
  d.id); 0.6598739495798318 sqlite shipped path. Case rate is identical
  (0.9117647058823529) on all three.
