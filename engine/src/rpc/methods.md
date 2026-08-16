# Daijin RPC surface, v5, FROZEN 2026-08-16

Supersedes v4 (same day). v2 closed the nine gaps from verifier report 1
(D-0007); v3 closed report 2's findings 38, 41 and 42 (D-0010); v4 (D-0014)
codified the P5 shapes; v5 (D-0018) rules the five ambiguities the finished
TUI surfaced: the spend-confirmation parameter is named, documents' filter
keys are fixed, never-verified roles are representable, exam rows carry a
human-readable title, and the spend dialog gets a zero-spend budget
estimate to display. Changes require the leader.

JSON-RPC 2.0 over stdio, reusing the MCP stdio transport framing. The TUI is a
pure client; every screen renders from these methods plus the event stream.

## Handshake and lifecycle

| method | params | returns |
| --- | --- | --- |
| `hello` | `{ clientVersion }` | `{ engineVersion, contractVersion: "5" }` first call on connect; contractVersion tracks THIS document's version and must be bumped in the same edit that bumps the title; mismatch renders an upgrade screen, not a method error |
| `repoAttach` | `{ repoPath }` | `{ repo }` creates the connected-repo entry the home screen lists |
| `repoDetach` | `{ repoPath }` | `{ ok }` |
| `jobCancel` | `{ jobId }` | `{ cancelled }` stops an initBrain or gym job |

## Core

| method | params | returns |
| --- | --- | --- |
| `analyze` | `{ repoPath }` | `{ languages, commitCount, structure, gateCandidates, hasBrainFolder }` |
| `initBrain` | `{ repoPath, mode: "ingest" \| "layer1" \| "layer1+layer2", scope?: { areas: string[] }, budget? }` | `{ jobId }` scope limits Layer 2 to named areas (sub-75 path). Mode `layer1+layer2` is SPEND-TOUCHING: Layer 2 runs LLM narration on the user's engineer key, so the estimated budget is displayed and confirmed by an explicit user action before the job starts; without confirmation the call is refused with `-32050` |
| `diagnose` | `{ repoPath }` | mechanical sub-75 diagnosis, zero-spend: missed gold cases clustered by type, area, and arm, from the retrieval-score tooling |
| `diagnoseNarrate` | `{ repoPath }` | `{ recommendation }` SPEND-TOUCHING: the auditor narrates a recommendation over the mechanical diagnosis. Explicit user action per call |
| `retrievalScore` | `{ repoPath, tokenBudget?, sweep?: boolean }` | `{ caseRate: { exact, cases }, mrr, violations, chosenBudget, rationale, perCase, budgetSweep? }` sweep=true runs 3k/4k/6k/8k. caseRate.exact is the rational value, cases is "31 of 34" form. caseRate and violations are enforced floors; mrr is recorded for movement only, never floored. perCase rows: `{ caseId, hit, rank, arm: "semantic" \| "lexical" \| "fused", type, area }` so sub-75 diagnosis clusters by type, area, and arm |
| `search` | `{ repoPath, query, options? }` | `{ chunks, tokensUsed }` |
| `documents` | `{ repoPath, filters?: { q?, type?, area? } }` | document inventory for the brain browser: `[{ id, type, path, title, area, tags }]`; browsing is not search-only. Filter keys are exactly q (substring over id, title, path), type, and area; unknown filter keys are an error, never silently ignored, so a misspelled filter cannot return everything |
| `budgetEstimate` | `{ repoPath, mode: "layer1+layer2" \| "gym", scope? }` | `{ estimatedTokens, basis }` ZERO-SPEND deterministic estimate (from corpus size, commit count, and scope), computed without any provider call; this is what the spend confirmation dialog displays BEFORE consent, so an estimate that itself spent would defeat its purpose. basis is a one-line human-readable derivation |
| `scoreHistory` | `{ repoPath }` | past floor measurements, newest first: `[{ at, caseRate: { exact, cases }, chosenBudget }]`; the repo card trend line renders from this, distinct from budgetSweep which is one measurement across budgets |
| `serveStatus` | `{}` | `{ repos: [{ path, health, floorScore, mcpActive }], ollama, db, spendGate: { open, path } }` the gate is observable before anything is attempted |
| `mcpSnippet` | `{ repoPath }` | `{ unlocked, threshold: 0.75, snippet }` the paste-ready MCP config, locked below the floor threshold |

## Gates (discovered, user-editable data)

| method | params | returns |
| --- | --- | --- |
| `gatesDiscover` | `{ repoPath }` | `{ jobId }` probes package.json, CI configs, Makefiles; classifies each candidate live, measured, pre-broken, or unavailable against the baseline |
| `gatesGet` | `{ repoPath }` | gates.yaml content plus per-gate classification and liveness evidence |
| `gatesSet` | `{ repoPath, patch }` | updated gates.yaml; the engine treats it as data |

## Gym and exams

| method | params | returns |
| --- | --- | --- |
| `gymStart` | `{ repoPath, config }` | `{ jobId }` REQUIRES the open spend gate; refused otherwise |
| `gymStatus` | `{ jobId? }` | `{ cycles, activeRun?, ledger }` |
| `examList` | `{ filters? }` | bank plus draft queue. Two ORTHOGONAL status axes plus the split flag, platform semantics (exams.js:28-34): `[{ examId, title, status: "draft" \| "validated" \| "promoted" \| "vetoed", benchmarkStatus: "active" \| "quarantined", quarantineReason?, heldOut: boolean, tier, provenance }]`. title is the human-readable one-liner from the auditor's task statement (v5; the bank was unreadable by id alone). status is the authoring pipeline; benchmarkStatus is measurement integrity (a promoted exam can be quarantined, e.g. cap-death per ADR-0148 lineage, and quarantineReason is required, min 20 chars, when quarantined) |
| `examDetail` | `{ examId }` | `{ axes, attempts: [{ tokens, verdict, grades }], provenance }` |
| `examVeto` | `{ examId, reason }` | updated exam record; user veto per the plan's bank view |
| `examUpdate` | `{ examId, patch }` | updated exam record |

## Settings, roles, board

| method | params | returns |
| --- | --- | --- |
| `settingsGet` | `{}` | full settings object, secrets masked |
| `settingsSet` | `{ patch }` | updated settings |
| `rolePing` | `{ role: "engineer" \| "teacher" \| "auditor" \| "watcher" }` | `{ httpStatus, ttftMs, latencyMs, servedModelId }` SPEND-TOUCHING: a real provider generation. Only ever user-initiated from the TUI, never automatic, and retryable without a settings edit. servedModelId is the identity check; catalogue endpoints are not authoritative |
| `board` | `{ filters? }` | findings rows: `{ ts, source, severity, category, target, evidence, status }` |
| `agentFileGet` | `{ role: "student" \| "teacher" \| "auditor" \| "watcher" }` | `{ content, defaultHash, currentHash, modified }` the .daijin/agents instruction file; modified drives the settings badge |
| `agentFileSet` | `{ role, content }` | updated file record with recomputed hashes |

## Events (server initiated notifications)

Notification method names are part of the contract: step events arrive as
JSON-RPC notification method `step`, board findings as method `boardFinding`.
`ts` is epoch milliseconds everywhere; clients display offsets.

One jsonl step-event stream, the same shape the platform emits, powering both
the init activity feed and the gym live view:

`{ ts, jobId, phase, step, detail, counts?, level }`

Gym adds: round events, per-file edit events, check verdicts, extension grants
and refusals, boundary check results, rollback events with discarded-edit
counts, the criteria audit at submit.

Board findings are NOT job-scoped and can arrive with no job running, so they
have their own notification shape, mirroring the board row:

`boardFinding: { ts, source, severity, category, target, evidence, status }`

severity "critical" is pushed to the TUI as a notification the moment it
arrives; lower severities render on the board view only.

## Codified payload shapes (v4, adopted from the P5 assumption set)

`gymStatus` returns `{ cycles, activeRun?, ledger }` where
`ledger: { mode, scoredWrites, drawnFromResultFiles, rowsWritten, certifications, exams }`
and `activeRun: { jobId, examId, round, state, mode, edits, checks, extensions, boundary, criteriaAudit, rollbacks }`.
drawnFromResultFiles is the denominator rule made visible: drawn exams are
counted from result files, never rows.

`settingsGet` returns `{ roles, instructionFiles, retrieval, storage, spendGate, charts }`
where each role is `{ role, preset, model, endpoint, keyRef, keyMasked, ping: { ok, httpStatus, ttftMs, latencyMs, servedModelId, at, hint? } | null }`.
`ping: null` is the canonical encoding for a never-verified role (v5): rolePing
is spend-touching and never fires automatically, so a role that has never been
paid for must be representable; clients render it as "never", and every stored
ping is historical (recorded at `at`), never a live reading.
Each instruction file is `{ name, path, hash, defaultHash, modified }`.
Secrets are masked; keyRef is a pointer, never a value.

`board` returns `{ rows, total }`, rows as defined in its method row above.

`serveStatus().repos[].health` takes values `ok | warn | critical | no-brain`;
whether a repo needs a brain comes from `analyze().hasBrainFolder`, which is
authoritative.

## Error convention

JSON-RPC error codes. Data field always carries `{ hint }` written for the TUI
to display verbatim. Spend-gated refusals use code `-32050` with the gate path
in `data.gate`. The spend-touching methods, exhaustively: `gymStart` (owner
gate), `rolePing` (explicit user action per call), `initBrain` with mode
`layer1+layer2` (budget displayed and confirmed per call), and
`diagnoseNarrate` (explicit user action per call). Everything else is
zero-spend by construction, and adding a spend path to any other method is a
contract change, not an implementation detail.

Per-call spend confirmation (v5): consent travels as `confirm: true` in the
method params; `initBrain` with `layer1+layer2` additionally sends the
`budget` the user saw (from `budgetEstimate`). A spend-touching call without
`confirm: true` is refused with `-32050` even when the owner gate is open;
the engine never infers consent.

[Addition 2026-08-16, from the TUI's v5 round: EVERY spend-confirmed call
whose dialog displayed an estimate echoes it as `budget` (the full
budgetEstimate result object is canonical; the engine tolerates anything
carrying estimatedTokens), gymStart included, and the engine records the
echoed budget in the run or job record so the audit trail shows what the
user saw. The engine ACCEPTS a confirm without a budget echo (refusing
would invent a refusal condition on a spend path); the obligation to send
it is the CLIENT'S, enforced by client-side tests, never by making a mock
engine stricter than the real one. Gate is checked before consent on
gymStart: the owner's refusal outranks the client's.]

Deferred methods (added to v5 same day, from the daemon build, D-0019): a
declared method whose backing phase has not landed answers with code
`-32001` (implementation-defined range, distinct from `-32050`), carrying
`data.phase` matching /^P\d/ and a `data.hint` of at least 20 characters.
`-32601` (missing method) is never a legal answer for a declared method;
"not implemented" must never degrade into a shrug.
