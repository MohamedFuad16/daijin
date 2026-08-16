# Daijin build plan (agent team seed)

Written 2026-08-16, ready for the team launch. This file is the leader's brief and the
single source the team boots from, so a fresh Claude Code session (restart first: the
team runtime was glitchy last launch) can start the build with zero re-derivation.

## Goal, one sentence

Extract the proven AI Brain engine into an installable tool named Daijin: a Textual TUI
over a Node engine daemon that connects to any repo, builds and serves a project brain
over MCP behind a measured retrieval floor, and runs the certification gym with the
ADR-0167 harness defaults.

## Constraints, non-negotiable

- No em dashes or en dashes anywhere. Identifiers and commits in English.
- Zero-spend defaults: nothing in retrieval calls a paid API; gym spend sits behind an
  owner gate, blocked by default.
- Tests first: every mechanism ships with a test that fails without it. The platform
  suite (599) must stay green throughout the extraction.
  [NOTE 2026-08-16: three platform test counts circulate (599 here, 578 in the
  extraction report, 410+ in the platform CLAUDE.md). Authoritative is what the
  platform's own npm test reports at check time; the leader measured it, result
  recorded in agent/state.md.]
- Minimal diffs against the platform repo; the extraction copies, it does not mutate,
  until parity is proven.
- Reviewer and verifier agents report only; fixes belong to the owning worker.
- Every worker returns: short summary + ASSUMPTIONS + OPEN QUESTIONS; the leader answers
  every open question.

## Source facts (do not re-derive, verify only if suspicious)

- Platform repo: /Users/mfuad16/Documents/Codex/2026-07-21/hand-ai-brain-build-instructions-md/ai-brain-platform
- Portable core (~2,600 lines): platform/rag/rank.js, platform/ingest/chunk.js,
  platform/rag/retrieve.js (fuseRankings), platform/rag/context.js, platform/rag/standing.js,
  platform/rag/embed.js, platform/mcp/** (529 lines), platform/exam/gates.js, platform/exam/sandbox.js.
- Extraction report with coupling inventory: scratchpad/dijin/extraction-report.md.
- FTS5 adapter recipe (measured): tokenize='porter unicode61', snowball stopword filter,
  whitespace tokens as quoted phrases, bm25 ranking, top 40. Scripts: scratchpad/dijin/fts5-*.py.
  [CORRECTION 2026-08-16, verifier report 1: "snowball stopword filter" overstates the
  measured script, which uses a hand-written 30-word list approximating Postgres
  'english'. Porter DOES stem despite the script header's "no stemming" prose; the
  CREATE VIRTUAL TABLE line is authoritative. Preserved at docs/fts5-adapter-recipe.py.]
- Retrieval config that scores 91.2%: k=10, tokenBudget 4000, RRF_K 60,
  perCandidateCapRatio 0.22, slot floor 0.55, raw-cosine champion, standing outside budget.
  [CORRECTION 2026-08-16, verifier report 1: k is 8, not 10. The committed baseline
  platform/rag/retrieval-baseline.json records k: 8, and the scorer and retrieve() both
  default to 8. The floor value is the exact rational 0.9117647058823529 (31 of 34
  cases); 91.2% is a rounded display, and a floor typed from the rounded form sits above
  the measurement and fails on a healthy tree. caseRate and violations are ENFORCED;
  MRR (0.6588935574229692) is recorded for movement only and deliberately not floored.]
- Harness defaults: ADR-0167 (extensions 400k x8 + boundary check on, gauge +
  integration-first in prompt, submit rehearsal opt-in).
- Gold-set method: queries from commit archaeology and structural self-reference; answers
  are artifacts (file, symbol, document id), never prose; LLM may propose, mechanics accept.

## Repo layout to scaffold (empty files first, contracts in headers)

daijin/
  engine/            Node. Copied core + new code. Owns DB, MCP, gym, RPC.
    src/store/       Store interface + pgvector impl + sqlite impl
    src/rag/         rank, chunk, retrieve, context, standing, embed (copied)
    src/mcp/         copied MCP server
    src/init/        repo analyzer, brain scaffolder, gold-set miner, gate discovery
    src/gym/         exam miner, cycle runner (ADR-0167 defaults), certification ledger
    src/rpc/         JSON-RPC surface for the TUI (reuses MCP stdio transport)
    test/
  tui/               Python Textual. Pure client.
    daijin_tui/      app, screens/, widgets/, rpc client
  adapters/          sqlite-vec + FTS5 binding, ollama client
  install/           curl script, packaging
  docs/

## Interface contracts (freeze before parallel work)

Store interface (engine/src/store/store.d.ts):
  init(), ingestChunks(rows), semanticQuery(vector, filters, limit),
  lexicalQuery(query, filters, limit), documents(filters), standingUnits(),
  meta(key) get/set, transaction(fn)
RPC methods (engine/src/rpc/methods.md):
  analyze(repoPath), initBrain(options), retrievalScore(), search(query, options),
  serveStatus(), gymStart(config), gymStatus(), examDetail(id), settingsGet/Set
Gold-set case shape: { id, query, must_return: [artifactId], identifier?: bool, provenance }

## Phases with acceptance checks

P0 scaffold: layout + empty files + contracts + CI skeleton. Check: tree exists, contracts reviewed by leader.
P1 extraction: copy core behind Store with pgvector impl; port the retrieval-score
   harness. Check: 91.2% floor reproduced byte-for-byte on the platform corpus.
   [CORRECTION 2026-08-16, verifier report 2 finding 43: the check, stated so it can
   fail: exact caseRate equality with the committed baseline, 0.9117647058823529 =
   31 of 34, plus a clean per-case output diff, at k=8, with the platform's own
   retrieval-score run as the executed baseline control, not quoted from the
   baseline file. Parity means metric and per-case parity, not source-byte identity
   (D-0006). This sentence is the acceptance the extractor builds to and the
   verifier attacks; the original line above is superseded. Addendum, same
   day: the engine suite must be green at the moment of the P1 report; a
   parity number measured over a red suite is not certifiable.]
P2 sqlite adapter: implement recipe. Check: A/B vs pgvector on the same corpus,
   case rate within one case, identifiers 5/5, violations 0.
P3 headless init: analyze + scaffold + gold-set miner + gate discovery.
   Check: full init on the owner's example React repo; measure the floor honestly;
   THIS IS THE CONSTANTS-GENERALIZATION TEST. Record whatever number appears.
   [ACCEPTANCE RESTATED 2026-08-16, pre-registered before the P3 report per the
   verifier's request. The run is LAYER 1 ONLY, zero spend, so it is freely
   re-derivable; Layer 2 is out of the acceptance and stays behind the engineer-key
   confirmation. Target repo: designated by the owner and relayed by the leader,
   with the commit PINNED and recorded in the report so re-derivation is the same
   experiment. Pass conditions, each falsifiable: (a) init completes headlessly
   end to end; (b) gates.yaml is written with every candidate classified live,
   measured, pre-broken, or unavailable, with liveness evidence attached; (c) the
   gold set passes its own integrity gates BEFORE it may measure (existence,
   leakage, staleness, provenance, diversity floor of 25 cases minimum with at
   least 5 identifier cases and type/area spread), and each integrity gate has a
   demonstrated failure mode; (d) errors.md starts empty when history evidence is
   absent; (e) the budget sweep runs at 3k/4k/6k/8k with the curve, chosen budget,
   and one-line rationale recorded; (f) the floor number is recorded as an exact
   rational with case counts, whatever it is, and is EXPLICITLY NOT a pass/fail
   criterion: a low floor on a foreign repo is a finding about the constants, not
   about init-miner; (g) the MCP unlock condition is evaluated against the 0.75
   threshold and reported either way.]
P4 gym port: cycle runner with ADR-0167 defaults, mode quarantine, spend gate.
   Check: one harness-debug cycle on the example repo, zero scored writes.
   [ACCEPTANCE RESTATED 2026-08-16, pre-registered before the P4 report per the
   verifier's request. The acceptance SPLITS, because a real cycle calls the
   student model and spend sits behind the owner's gate. MECHANISM HALF, the P4
   acceptance, zero spend and freely verifiable: the cycle runner executes end to
   end against a SCRIPTED fake engineer and demonstrates every ADR-0167 campaign
   default live in tests [corrected 2026-08-16 same day, verifier: the first
   enumeration omitted the fourth default and left the constants unpinned]: base
   cap, an extension GRANT and an extension REFUSAL at the ADR's constants (step
   400,000, limit 8, hard outer bound 5,000,000, and step 0 disabling extensions
   entirely, each constant asserted by test, since a runner with the right
   branches and the wrong constants is not the ADR's defaults), a boundary check
   that passes and one that fails, a rollback with its discarded-edit count, the
   completion gauge in the engineer prompt, and the INTEGRATION-SEAM-FIRST
   sections in the engineer prompt (asserted present and ordered by test; this
   default is credited with the first route wiring exam-0058 ever saw and is one
   of the two measured sentences the product stands on). The submit rehearsal is
   deliberately ABSENT from this enumeration: ADR-0167 keeps it opt-in, promoted
   only when a live firing validates it, so demanding it as a default would
   contradict the ADR. Zero scored writes, with mode
   quarantine falsifiable on artifacts: the run is recorded as harness-debug,
   appears in no scored aggregate, and the drawn-cohort denominator is counted
   from RESULT FILES with a cap-death-leaves-no-row case included in the tests;
   the spend gate refuses gymStart with -32050 while closed, no code path exists
   that opens the gate, and that absence is mutation-tested. LIVE HALF, deferred:
   one real harness-debug cycle on the example repo runs only on the owner's
   explicit authorization through the leader, and gets its own pre-registered
   sentence when that authorization exists. P4 acceptance does not require it.]
P5 TUI shell: entry screen, dashboard, brain browser + retrieval tester, gym live view,
   settings. Check: every view renders against the live engine; keyboard and mouse.
   [ACCEPTANCE RESTATED 2026-08-16, verifier report 6 open question 3, so the check is
   falsifiable and pre-registered: (a) the pytest suite collects and passes with zero
   errors; (b) every request method the v4 method tables declare is referenced (29
   at the time of writing; the tables are the count, not this sentence), every
   screen renders from contract-shaped data, and no on-screen text contradicts the
   frozen surface; (c)
   every spend-touching method has BOTH a reachable refusal path and a reachable
   confirmed path in the mock (--mock-gate open is the explicit demo flag, blocked is
   the default); (d) keyboard and mouse navigation across all seven screens is
   exercised by tests; (e) dash and spend sweeps clean, copy gate scans composited
   screen output; (f) the live-engine rendering check of the original sentence moves
   to the P6 integration pass, when the engine daemon exists to serve a real client.]
P8 INTEGRATION (registered 2026-08-16 17:52, pre-registered before any part is
   claimed, per the standing rule; claimed jointly by tui-builder and the
   extractor, attacked by the verifier). The real TUI against the real daemon,
   real store, real embedder, zero spend, on a fixture repo initialized by the
   real pipeline. Clauses, each falsifiable: (a) daijin <repo> reaches a working
   engine over BOTH transports (stdio spawn and socket attach), and all seven
   screens render live data, no mock on either side; (b) the boot screen renders
   real serveStatus cards with the concurrency strand active and a visible
   loading state, never a frozen frame; (c) the init activity feed renders a
   REAL initBrain layer1 run's step events end to end on the fixture repo; (d)
   the brain browser lists real documents and the retrieval tester returns real
   chunks with tokensUsed from the real store; (e) exam and gym screens render
   the deferral-free surface honestly against a real ledger carrying at least
   one imported rubric: graded axes as the canonical list, no radar for
   ungraded, reasons from ungradedCode; (f) spend surfaces are live: gymStart's
   refusal renders the real gate path, consent dialogs show a real
   budgetEstimate with its basis, and no spend-touching call passes without
   confirm; (g) both connect stories demonstrated: spawn-owning and
   attach-to-running (two TUIs, one daemon), and a second daemon's lock refusal
   reaching the user through the stderr tail; (h) motion runs against the live
   stream in all three modes, and the coalescing claim gets its REAL-TERMINAL
   measurement (repaint cadence recorded from an actual terminal, honest bounds
   stated), per tui-builder's own request that the repaint count not stand in
   for a smoothness claim; (i) both suites green at the pinned commits, zero
   provider calls throughout, dash and spend sweeps clean. The verifier attacks
   the registered text; a clause that cannot be demonstrated is reported as
   such, never softened.

P6 install story: packaging + curl script. Check: clean-machine dry run documented.
   [ACCEPTANCE TRANSCRIBED 2026-08-16, with honest provenance: clauses (a) through
   (f) were authored by the leader in the P6 assignment message BEFORE the build,
   but were never transcribed here, so the record showed a self-graded phase until
   the verifier caught the gap; the transcription failure is the leader's. Clauses
   (g) and (h) are ADDED NOW, after the P6 report, adopted from the verifier's
   coverage question, and the attack must specifically check whether the worker's
   self-authored criteria cover them, since the worker could not have built to
   them. (a) A documented clean-machine dry run: from a bare directory assuming
   only node >= 22, python >= 3.10, and git, the install path produces a working
   daijin command talking to a working engine, every step logged. (b) The script
   is idempotent and re-runnable. (c) No secret, no provider call, no network
   beyond package registries. (d) Versions of both halves are stamped and hello's
   engineVersion comes from the stamp. (e) Uninstall is documented and removes the
   program without touching state or repository brains. (f) Dash and spend sweeps
   clean. (g) ADDED: the install story is HONEST about Ollama and the embedder,
   the extraction report's named ugliest onboarding failure mode: the requirement
   (Ollama serving the embedding model) is stated where a first-run user will see
   it, a missing Ollama produces a named message rather than a hang or a false
   success, and no green line implies retrieval works when the embedder was never
   probed. (h) ADDED: the two-runtime question is handled explicitly: both
   runtimes are version-checked with named refusals when absent or too old, and
   the failure of either runtime check refuses the install rather than degrading
   it.]
P7 grading, rubric import, harvest: the teacher half of a cycle, and the only step
   that puts anything back into the brain.
   [ACCEPTANCE PRE-REGISTERED 2026-08-16, drafted by gym-porter against the
   platform's failure modes, ruled and registered by the leader BEFORE the build
   exists. One-line summary: with an INJECTED teacher and zero spend, the grading
   and harvest machinery refuses everything it must refuse (uncited, transposed or
   digest-mismatched rubrics, a rubric for a run that produced no diff, a grader
   who authored the exam, harvest over a held-out run, invented document ids, empty
   concerns), harvest stays proposal-only with apply as a separate act, every lesson
   written back is validated against current code, a measured zero is a recorded
   outcome, and every clause carries a mutation that kills it. The full 21 clauses,
   the three registration decisions, the named symbol-resolver gap in clause 16, and
   the out-of-scope list (grade QUALITY is a many-cycle measurement with its own
   future sentence, never this one) are registered at
   docs/verification/p7-grading-harvest-acceptance.md, commit 1cdc2b8. The plan is
   the findable index; that document is the text the verifier attacks. The LIVE half,
   one real graded cycle with a real teacher model, is deferred and owner-gated
   exactly as P4's is.]

## Team shape (launch after a Claude Code restart; team runtime was glitchy)

- Leader: coordinates, owns contracts, answers open questions, merges. Never writes
  worker code directly.
- engine-extractor (P1), store-adapter (P2), init-miner (P3), gym-porter (P4),
  tui-builder (P5): one worktree each, communicating through the leader.
- verifier: report-only, attacks each phase's acceptance check independently.
- Mechanical sweeps (renames, license headers) go to a mech worker with an exact recipe.

## Open questions already answered by the owner

Storage default SQLite, Postgres secondary. Teacher API. Single-package repos v1.
Monorepos later. Embeddings 1024 default with per-corpus suggestions. Gym writes only to
its own store, never the user's git. iOS in scope for validation, gates adapt per repo.
Curl means distribution of Daijin itself from the owner's domain.

## The two measured sentences the product stands on

The brain keeps cheap models from breaking things they do not understand (measured:
gate regressions bare vs brain-on). The budget, not the model, was the ceiling on task
completion (measured: the natural-stop loop, first non-fail on a nine-run exam).

## Owner clarifications (2026-08-16, pre-launch)

Boot flow: `daijin .` opens the repo home (connected repos as cards with health dots and
floor scores; settings reachable everywhere). A repo without a brain shows one primary
action, Initialize brain: scan, then ingest an existing agent folder as-is, or generate.

Brain generation policy, strict order, LLM optional:
- Layer 1 deterministic, no key, no spend: architecture cards from the import graph and
  directory tree, dependency census, gate discovery, conventions measured statistically,
  history and ownership stats. Every unit cites the repo, reproducible, marked generated.
  Layer 1 alone enables retrieval and MCP.
- Layer 2 LLM-enriched, optional, bounded, user's engineer key: commit archaeology into
  decision and lesson candidates, doc distillation. THE LLM PROPOSES, MECHANICS ACCEPT:
  cited paths and commits must exist or the unit is dropped. Budget shown before running.
- The gym converts the scaffold into earned knowledge; the scaffold is day zero.

Init UX: Claude Code style live activity feed, never a frozen wait. Phase checklist with
spinners, animated verbs on the active line, per-phase counts, elapsed time, driven by
the engine's existing jsonl step events over RPC. The same stream powers the gym live
view (rounds, edits by file, checks, extensions, boundary events, the criteria audit).

Charts in the TUI: plotext-backed bar and line widgets (cycle trends, token series),
sparklines on cards, radar drawn on a unicode canvas with a five-axis horizontal-bar
fallback (user-switchable). Exams section: enter an exam, see its axis radar, pass and
fail history line, and per-attempt token bars.

## The three-layer boundary (owner design correction, 2026-08-16 13:20, D-0031;
## supersedes any earlier reading where "agent folder" and "brain" overlap)

CONTRACT, BRAIN, and INDEX are three different classes of knowledge, not two
ways of remembering the same thing. The contract (.daijin/manifest.json plus
.daijin/agents/) says how agents behave: loaded whole, always available,
NEVER ingested or retrieved, and retrieval can never outrank it. The brain
(.daijin/brain/ markdown: architecture.md, decisions/, lessons/,
conventions.md, errors.md) is the durable, evidence-cited project memory and
the CANONICAL artifact; humans and agents read it directly. The index is a
disposable machine derivation of the brain living OUTSIDE the repo in the
daijin state root; deleting it loses nothing because ingest regenerates it
from the brain files. daijin init is a lifecycle contract guaranteeing
identity, contract, brain, index, gold set, and floor in order; manifest.json
is the API boundary declaring the schema. Contract mutations are governed
(watcher detects, auditor recommends, promotion explicit), never
retrieval-driven. Expanding the retrieval corpus to raw source/docs/history
is DEFERRED to its own registered experiment: corpus composition is part of
the measured gauge, and the unit-centric design with citations pointing into
source is the platform-proven configuration.

## Init pipeline v2 (owner refinements, 2026-08-16, supersedes the generation bullets above where they differ)

Generation is a MIX by design: deterministic extraction produces evidence tables (script
and import graphs, per-page script usage, function definition and call sites, CSS usage,
dependency census, co-change clusters); the LLM narrates prose units (architecture.md and
friends) OVER that evidence; mechanics validate every citation before a unit enters the
brain. The LLM never discovers facts, it narrates verified ones.

errors.md rule: with history, mine fix and revert commits into candidate lessons, each
validated against the real commit. With no history, errors.md STARTS EMPTY. Never invent
an error record; the gym writes the first real entry.

First boot, model setup: four roles (engineer, teacher, auditor, watcher), one
OpenAI-compatible key reusable across roles, model and endpoint per role, presets for
Claude, GPT, GLM, Grok, DeepSeek plus custom. On save, per-role verification ping shows
HTTP status, time to first token, latency, and the SERVED model id (catalogue endpoints
are not authoritative; the identity check is). No role ready until its ping passes.
Layer-1-only mode works with zero keys.

Pipeline order: verify roles -> identify (commits, languages, structure, gates) ->
brain phase (existing folder: auditor drift-check with sampled claim validation and
cited updates; missing: Layer 1 evidence then LLM narration then citation validation)
-> chunk, embed, per-repo SQLite -> mechanical gold set -> retrieval floor -> at 75
percent or above, MCP unlocks with a paste-ready snippet.

Below 75 percent: mechanical diagnosis first (which gold cases missed, clustered by
type, area, and arm, from the retrieval-score tooling), auditor narrates a
recommendation (enrich docs, run Layer 2 on a named area, or bootstrap via the gym).
The auditor RECOMMENDS the gym; the user approves the spend. The spend gate moves by
the owner's hand in the product exactly as in the platform.

## Gate inventory and gold-set integrity (owner review, 2026-08-16)

Soundness rule, a merge requirement: no gate ships without a mutation test demonstrating
it CAN fail (scrambled index, invented citation, broken baseline). A gate without a
demonstrated failure mode is dead coverage.

Utilization audit recovered four platform pieces the plan had missed; all four are now
requirements: the content-survival instrument as a chunking gate (verbatim type cores
survive the budget trim), the mutation-test discipline above, the drawn-cohort
denominator rule (count drawn exams from result files, never rows; a cap-death leaves no
row), and the embedding identity assert (index digest and dimension must match the
served embedder) as a health gate.

Gold-set pipeline: sources in trust order are commit archaeology, structural
self-reference, and identifier cases; the LLM only proposes paraphrase queries for known
answers. The gold set passes its own gates before it may measure: existence (every
must_return resolves in the live index), leakage (query never quotes the answer
verbatim), staleness (a case retires with its superseded target), provenance (every case
records its real origin), and a diversity floor (minimum count, spread across types and
areas, identifier subset flagged). Scored as today: case rate, MRR, must-not violations.

Repo work gates are DATA: init writes a discovered gates.yaml (probed from package.json,
CI configs, Makefiles), each candidate command run against the baseline and classified
live, measured (GATE_METRIC movement for pre-existing-violation tools), pre-broken
(excluded and labeled, never silent coverage), or unavailable. User-editable; engine
treats it as data, extending the platform's project.yaml pattern.

## The four agents, the board, and the instruction files (owner review 2, 2026-08-16)

Roles. Student: sandboxed exam work under gauge and ordering rules (engineer-prompt.md
lineage). Teacher: blind five-axis grading with citations and gap tags (TEACHER.md
lineage). WATCHER: continuous detection, never judgment, never action; cheapest model;
beat: health (MCP, Ollama, DB, served-model-id vs pinned, 429 rates, TTFT drift), gates
(dead-gate detection, live-to-pre-broken transitions, duration drift, flake rates), live
cycles (cap events, extension grants and refusals, boundary failures, rollbacks with
discarded-edit counts, apply errors, sandbox leaks, quota stops, stuck runs, token
anomalies), ledger (quarantine violations, orphaned artifacts past the last cycle,
rubricless graded runs). AUDITOR: scheduled judgment, never silent action; triages
watcher findings with written verdicts, brain drift checks by sampled citation
validation, sub-75 diagnosis and recommendation, storage and config proposals, per-cycle
audit (quarantine held, denominator from files, grades sane). Spend and destructive
actions always need the user's hand. Detection and judgment stay separated by design.

Board: a findings table in the store, TUI Board view. Fields: time, source (watcher,
auditor, engine), severity (info, warn, critical), category, target, evidence citation
into the jsonl stream, status thread (open, triage verdict, resolved). Watcher writes,
auditor triages in place, user reads and filters; critical pushes a notification.

Instruction files: .daijin/agents/{student,teacher,auditor,watcher}.md, shipped
defaults, user-editable with a modified-from-default badge (hash) in settings.
Conventions from the TEACHER.md saga apply to all four: corrections dated in place,
withdrawn claims marked WITHDRAWN rather than deleted, era notes when the harness
changes underneath the reader.

Final sweep additions: orphaned-artifact detection is a standing watcher check;
dead-gate TRANSITIONS (live to pre-broken) are a distinct signal from dead-gate state;
negative results and dated in-place corrections are board conventions, structural
rather than habitual.

## Authorship assignments (owner question, 2026-08-16): gold sets and exams

Gold sets: deterministic sources are code, no model. The LLM share (paraphrase queries,
candidate selection) belongs to the AUDITOR, owner of measurement integrity. Never the
student (self-authored tests are gaming), never the teacher (grader must not calibrate
the gauge), never the watcher. "Enough" is mechanical and displayed: floor 25 cases,
scale one per 20 to 25 chunks capped at 150, coverage gates (types, areas, at least 5
identifier cases, must-not pairs where confusion exists), and the TUI shows points per
case so small sets read with their error bar. Integrity gates apply on top; the auditor
certifies the gauge fit to measure and can demand more cases.

Exams: discovery is deterministic (base is parent of gold, baseline gates pass on base,
scope bounds decide tier, budget per tier). The AUDITOR is the exam committee and
authors task details from the gold diff; the TEACHER only grades, preserving
author-grader independence; the student never sees gold (forbidden-strings guard carries
over). Replacing owner approval: draft -> mechanical validation gates -> auditor review
-> promoted with user notification, bank view in the TUI with veto and edit. Model tier
guidance: auditor strong, teacher strong, watcher cheapest, student is the model under
test; the asymmetry is the economic argument.

## Exam mining funnel and the superseding rule (owner question 2, 2026-08-16)

History access: local git walk (git log --numstat), remote URLs cloned first; huge
histories capped by config with the cap displayed, never silent.

Funnel, mechanical-first, judgment-last, expensive-last: (1) deterministic filter drops
renames, format-only, lockfile-only, docs-only, out-of-scope commits; (2) the auditor
reads the shortlist and selects the bank (coherent single intent, statement writable
without leaking the solution, core surfaces, tier and surface spread, held-out split);
(3) expensive validation only on the chosen: worktree at base, discovered baseline gates
must pass, scope re-verified from the real diff, forbidden-strings armed with gold.

Superseding commits: detection is deterministic (diff overlap across candidates plus
revert detection), the auditor is told the relation as computed fact. Default
latest-wins: the later commit enters the bank, the superseded one is excluded as an exam
and reclassified as Layer 2 brain material (a decision or lesson with evidence).
Auditor overrides allowed for partial overlaps, each writing its reasoning into the
exam's provenance record. Backstop for anything that slips through: harvest-time
citation validation, every lesson a gym run writes back is validated against CURRENT
code before it enters the brain.

## Retrieval budget policy (owner question 3, 2026-08-16)

4,000 stays the anchor (the only measured point, 91.2%) but the shipped number is
MEASURED PER REPO: init sweeps the floor at 3k, 4k, 6k, 8k (zero-spend, local) and picks
the smallest budget within one case of the best score, curve displayed with the
auditor's one-line rationale. Rationale against naive raising: the initial context rides
in every round's prompt (4k times 44 rounds is ~176k per exam), our failures were
work-budget and ordering bound with retrieval already correct, and brain_search (3k per
call) is the mid-task relief valve. Guardrails: the content-survival gate is a
mechanical raise signal when typed cores cannot survive the trim; the knob displays
budget times expected rounds so cost is visible. Standing pins stay outside the budget.
Per-tier budgets (S/M/L) are unmeasured and ship only as an auditor-proposable
experiment, never a default.
