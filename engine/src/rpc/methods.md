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
| `analyze` | `{ repoPath }` | `{ languages, commitCount, structure, gateCandidates, hasBrainFolder }` [Amended 2026-08-17, D-0035 batch: the engine was returning five further keys (`name`, `repoPath`, `files`, `git`, `brainFolder`) that NO client reads; readership was verified in the TUI, which takes `hasBrainFolder` and nothing else. They are mapped off at the daemon boundary rather than documented, on the standing argument that adding a field later is cheaper than removing one a client has started using. The internal analyze function still returns them; the wire does not] |
| `initBrain` | `{ repoPath, mode: "ingest" \| "layer1" \| "layer1+layer2", scope?: { areas: string[] }, budget? }` | `{ jobId }` scope limits Layer 2 to named areas (sub-75 path). Mode `layer1+layer2` is SPEND-TOUCHING: Layer 2 runs LLM narration on the user's engineer key, so the estimated budget is displayed and confirmed by an explicit user action before the job starts; without confirmation the call is refused with `-32050` |
| `diagnose` | `{ repoPath, control?: boolean }` | `{ caseRate: { exact, cases }, violations, cases, hits, misses, perCase, clusters: { byType, byArea, byArm }, identifierMisses, recommendation, discriminatingRange, controlSkipped }` [Amended 2026-08-17, D-0035 live tier: this row was PROSE, and prose is the right level for a return that is "the file, plus classification" and the wrong level for a structured result carrying clusters, a case rate, violations and a range. It was also the method that exposed the tiering hole: listed as live because it embeds, described in prose so nothing could compare it, and therefore checked by NO tier while the gate printed it as covered elsewhere. `discriminatingRange` is null when the control arm was not run and carries `measuredAt`, `fresh`, `stale` and `staleBecause` when it was, so a recalled measurement is never read as a fresh one; `controlSkipped` names why when the arm could not run. `recommendation` is null here by design: choosing between enriching docs, running Layer 2 or bootstrapping through the gym is the auditor's call, and that one spends] mechanical sub-75 diagnosis, zero-spend: missed gold cases clustered by type, area, and arm, from the retrieval-score tooling. [Addition 2026-08-16, v5, D-0030's surface: `control: true` (the LITERAL true; a truthy guess does not arm it) adds a permuted arm over the same store, embedder, k and budget, and returns `discriminatingRange: { caseRate: { candidate, control, range, casesOfHeadroom }, mrr: { candidate, control, range } }` or `controlSkipped` naming why (a corpus with under two distinct answers cannot be permuted). OFF by default because the arm doubles the call's wall clock; `discriminatingRange` is null when unmeasured, never zeroes, since a client must distinguish unmeasured from measured-and-found-nothing.] |
| `diagnoseNarrate` | `{ repoPath }` | `{ recommendation }` SPEND-TOUCHING: the auditor narrates a recommendation over the mechanical diagnosis. Explicit user action per call |
| `retrievalScore` | `{ repoPath, tokenBudget?, sweep?: boolean }` | `{ at, caseRate: { exact, cases }, mrr, violations, chosenBudget, rationale, perCase, budgetSweep? }` [Amended 2026-08-17, D-0035 live tier: `at` is when the measurement was taken. The scoreHistory row documents the same stamp, and two representations of one fact should be documented once each, identically] sweep=true runs 3k/4k/6k/8k. caseRate.exact is the rational value, cases is "31 of 34" form. caseRate and violations are enforced floors; mrr is recorded for movement only, never floored. perCase rows: `{ caseId, hit, rank, arm: "semantic" \| "lexical" \| "fused", type, area }` so sub-75 diagnosis clusters by type, area, and arm |
| `search` | `{ repoPath, query, options? }` | `{ chunks, tokensUsed, context }` [Amended 2026-08-17, D-0035 live tier: `context` is the assembled block, which is the thing an agent actually pastes, so it is the PRODUCT of this method rather than a leak. A search whose most-used output went undocumented would be the repoPath defect again. Found by the live tier, which is the only tier that can call this method] |
| `documents` | `{ repoPath, filters?: { q?, type?, area? } }` | document inventory for the brain browser: `[{ id, type, path, title, area, tags }]`; browsing is not search-only. Filter keys are exactly q (substring over id, title, path), type, and area; unknown filter keys are an error, never silently ignored, so a misspelled filter cannot return everything |
| `budgetEstimate` | `{ repoPath, mode: "layer1+layer2" \| "gym", scope? }` | `{ estimatedTokens, basis }` ZERO-SPEND deterministic estimate (from corpus size, commit count, and scope), computed without any provider call; this is what the spend confirmation dialog displays BEFORE consent, so an estimate that itself spent would defeat its purpose. basis is a one-line human-readable derivation |
| `scoreHistory` | `{ repoPath }` | past floor measurements, newest first: `[{ at, caseRate: { exact, cases }, chosenBudget, embedding, originPath, index }]`; [Amended 2026-08-17, D-0035 batch: `originPath` and `index` say WHICH CHECKOUT and WHICH BRAIN produced a row. Clones share one repoId and therefore one history, which is the right identity because a trend is a property of the project, but two checkouts on different branches then write different brains' floors into one series; without these a mixed series reads as a smooth trend. `index` is `{ digest, documents }` over document ids and content hashes, not over the database file, whose bytes move with vacuum and would mark every rebuild of identical content as a new condition. `embedding` is the served identity the row was measured with. Null rather than guessed when unknown] the repo card trend line renders from this, distinct from budgetSweep which is one measurement across budgets |
| `serveStatus` | `{}` | `{ repos: [{ path, health, floorScore, mcpActive }], ollama, db, spendGate: { open, path } }` the gate is observable before anything is attempted. [Addition 2026-08-17, enum sweep: `health` is `no-brain` \| `warn` \| `ok` \| `critical`. `no-brain` means never indexed, `warn` means indexed but below the MCP unlock threshold or never measured, `ok` means at or above it, and `critical` means the brain exists and could not be opened, which is a real state the home screen must show rather than a crash. A row's health is recomputed per call, so a repo whose brain was deleted on disk stops reporting the health it had when it was attached] |
| `mcpSnippet` | `{ repoPath }` | `{ unlocked, threshold: 0.75, snippet, reason }` the paste-ready MCP config, locked below the floor threshold. [Amended 2026-08-17, D-0035 batch: `reason` is the sentence floor.js wrote for the decision, displayed verbatim by the client, so a locked snippet explains itself in the words the measurement used rather than a paraphrase] |

## Gates (discovered, user-editable data)

| method | params | returns |
| --- | --- | --- |
| `gatesDiscover` | `{ repoPath }` | `{ jobId }` probes package.json, CI configs, Makefiles; classifies each candidate live, measured, pre-broken, or unavailable against the baseline |
| `gatesGet` | `{ repoPath }` | `{ path, content, discovered, parseError }` [Amended 2026-08-17, D-0035: this row was PROSE and the prose was WRONG. It promised "content plus per-gate classification and liveness evidence" while the engine returned `{ path, content }`, so the screen built for the promise read a gates list that was never on the wire and showed an empty table with "0 carrying signal" over a file describing three gates. The prose tier is where no gate checks, and the ruling to leave rows in prose assumed the prose was accurate; this is that residual realized. THE ENGINE MOVED TO THE CONTRACT, not the reverse, because discovery had persisted the classification all along and gatesGet simply did not read the file it was returning. `content` is ALWAYS present, whatever state the file is in, because it is a file the user is invited to edit and a parse error is a fact about the file rather than a failure of this method. `discovered` is NULL when the document is not discovery-shaped, with `parseError` saying why, and null is not "no gates": a file that cannot be interpreted and a file describing zero are different facts, which is exactly the distinction the empty table got wrong. When non-null it carries `{ version, discoveredAt, timeoutMs, summary, gates }`, each of the first four nullable, and `gates` rows AS WRITTEN, since this document is the user's and the engine only reads it; discovery writes `id`, `command`, `role`, `cwd`, `availabilityCommand`, `unavailableHint`, `source`, `classification`, `enabled` and a `baseline` block carrying the liveness evidence] [Addition 2026-08-17, from the client's restoration questions, answered from the code: (1) `baseline.status` is exactly `pass` \| `fail` \| `timeout` \| `unavailable`. There is no `violations` status; a tool with pre-existing violations is a MEASURED gate, which is a `classification`, judged on movement rather than on a threshold. (2) `discovered` and `parseError` are MUTUALLY EXCLUSIVE: exactly one is non-null, always. There is no partial parse, because the parse is all-or-nothing at the document level and a malformed row inside a readable document is passed through as written rather than rejected. A client may branch on `discovered` alone. (3) `classification` is `live` \| `measured` \| `pre-broken` \| `unavailable`, and `summary.carryingSignal` is `live + measured`: THE GATES THAT CAN FAIL ON A BAD EDIT AND PASS ON A GOOD ONE. Pre-broken and unavailable gates are reported and never counted, because a gate that fails either way cannot tell a good edit from a bad one and counting it is how a repo reports checks it does not have] |
| `gatesSet` | `{ repoPath, patch }` | `{ path, content, discovered, parseError }`, the same shape `gatesGet` returns; the engine treats gates.yaml as DATA and stores what the user wrote byte for byte. [Amended 2026-08-17, claim audit: the prose claim "updated gates.yaml" became misleading the moment gatesGet gained its parsed half and this did not, because a client that SET a file and re-rendered then got a different shape from one that GOT it. Returning the parsed half here also answers the question at the moment it is asked: a user who saves learns immediately whether the file still parses, rather than discovering the breakage on the next screen] [Addition 2026-08-17: A FULL-CONTENT WRITE IS ALWAYS ACCEPTED, whatever state the file is currently in, INCLUDING when the file on disk does not parse. That is not a leniency, it is the repair path: refusing to write because the current content is broken would lock a user out of fixing the file they broke, and gatesSet is the only way they can fix it. What is refused, always and regardless of file state, is a STRUCTURAL patch (`{ gates: [...] }` rather than `{ content }`), with `-32602`: the engine treats gates.yaml as data it does not author, so it will replace the whole document on the user's instruction and will never merge into one] |

## Gym and exams

| method | params | returns |
| --- | --- | --- |
| `gymStart` | `{ repoPath, config }` | `{ jobId }` REQUIRES the open spend gate; refused otherwise |
| `gymStatus` | `{ repoPath, jobId? }` | `{ cycles, activeRun?, ledger }` |
| `examList` | `{ repoPath, filters? }` | bank plus draft queue. Two ORTHOGONAL status axes plus the split flag, platform semantics (exams.js:28-34): `[{ examId, title, status: "draft" \| "validated" \| "promoted" \| "vetoed", benchmarkStatus: "active" \| "quarantined", quarantineReason?, vetoReason?, heldOut: boolean, tier, provenance }]`. title is the human-readable one-liner from the auditor's task statement (v5; the bank was unreadable by id alone). status is the authoring pipeline; benchmarkStatus is measurement integrity (a promoted exam can be quarantined, e.g. cap-death per ADR-0148 lineage, and quarantineReason is required, min 20 chars, when quarantined). [Amended 2026-08-17, D-0035 batch: `vetoReason` joins the row on the same terms as `quarantineReason`, present exactly when its precondition is true. The engine COMPELS it (a veto is refused without twenty characters) and stored it faithfully while no wire shape carried it, so a user was required to write a justification that nothing could ever display. That gap was introduced by this batch, which moved examVeto's return from the full record to this row, and was found by the client asking why its veto screen never showed a reason back] |
| `examDetail` | `{ repoPath, examId }` | `{ axes, attempts: [{ id, at, mode, status, verdict, tokens, tokenCap, grades, axes, ungradedCode, ungradedReason }], provenance }` [Addition 2026-08-17, enum sweep: `verdict` is `pass` \| `partial` \| `fail` \| `unsubmitted`, or null when the attempt has not been graded; `status` is the run status the ledger enforces (`completed`, `gates-regressed`, `metric-regressed`, `apply-error`, `unsubmitted`). A verdict and a status answer different questions: the verdict is what the grader concluded about the submission, the status is what the harness observed about the run, and an attempt can have a status with no verdict but never the reverse]` attempts newest first by `at` with `id` breaking ties. [Amended 2026-08-17, v5, finding 85: the designed boundary shape replaces what was an accidental spread of the gym ledger's row. `tokens` is the work tokens the attempt spent and `tokenCap` what it was allowed; a count without its cap is unreadable. `grades` and `axes` are THE SAME list, the finding-79 five-axis shape, under the contract's name and the name finding 79 introduced; a shape test asserts they cannot diverge and that this key set is CLOSED. AXES IS CANONICAL (finding 79's ruled shape and the name clients read); grades is the compatibility name from this contract's earlier text, and if the divergence test ever fires, axes is the one that was meant. The ledger's column names are NOT on this surface: it is a schema the daemon does not own, and the mapping happens at the daemon boundary] [Amended 2026-08-17, D-0035 batch addition: `mode` returns to the row, values as the ledger enforces them (`evaluation`, `experiment`, `harness-debug`). An evaluation attempt and a harness-debug attempt are different claims about the record, and a chart that renders them identically invites reading a debug run as a scored one. It came off the wire for want of a reader and came back the day one appeared, which is the removal rule working rather than being overturned] [Addition 2026-08-16, v5, finding 79: axes has THREE states and one shape. States: a graded attempt returns its axes; an ungraded attempt with a diff returns `null`; an attempt with NO diff returns `null` with its status saying why. `null` renders as "not graded", NEVER as zeroed axes, and an empty object is a forbidden value, because zeroed axes on a radar read exactly like measured ones. Shape: a LIST of `{ name, score, max }` in the canonical five-axis order (the wire serves rendering, and order matters on a radar; the engine's internal by-name keying maps to the list at the daemon boundary). Each ungraded attempt additionally carries `ungradedCode` (exactly one of `unsubmitted`, `apply-error`, `pending`; a new run status cannot reach the wire without mapping to one) and `ungradedReason` (the prose sentence, displayed verbatim); codes are for branching, prose is for humans [added 2026-08-16, verifier P8 audit: the field was real in the engine and the client and absent from the surface meant to adjudicate between them, finding 79's shape in a new place].] |
| `examVeto` | `{ repoPath, examId, reason }` | the updated exam record, in the `examList` row shape; user veto per the plan's bank view. [Amended 2026-08-17, D-0035 batch: naming the shape by reference moves this row from prose to checkable at the cost of one clause] |
| `examUpdate` | `{ repoPath, examId, patch }` | the updated exam record, in the `examList` row shape. [Amended 2026-08-17, D-0035 batch: naming the shape by reference moves this row from prose to checkable at the cost of one clause] |

[Amendment 2026-08-17, v5, tui-builder's P8 live run: the five rows above gained `repoPath`. The engine has always required it (each resolves through `requireAttached`, methods.js; a ledger is per repo), and the contract omitted it, so clients built against the contract rendered empty screens against a ledger that had rows. The contract now documents the reality it always should have; no engine change.]

## Settings, roles, board

| method | params | returns |
| --- | --- | --- |
| `settingsGet` | `{}` | full settings object, secrets masked [Claims verified 2026-08-17, claim audit: both assertions checked against the engine rather than assumed. FULL: every key in DEFAULT_SETTINGS is present in the response. MASKED: a role configured with a real key file returns the POINTER and never the value, verified with a sentinel that does not appear anywhere in the serialized response. Prose is retained because this row's answer is genuinely "the settings object", whose shape is DEFAULT_SETTINGS and would be a second copy of it here] |
| `settingsSet` | `{ patch }` | updated settings [Claims verified 2026-08-17, claim audit: the response is the full settings object, same key set as settingsGet, reflecting the patch] |
| `rolePing` | `{ role: "engineer" \| "teacher" \| "auditor" \| "watcher" }` | `{ httpStatus, ttftMs, latencyMs, servedModelId }` SPEND-TOUCHING: a real provider generation. Only ever user-initiated from the TUI, never automatic, and retryable without a settings edit. servedModelId is the identity check; catalogue endpoints are not authoritative |
| `board` | `{ filters? }` | `{ rows: [{ ts, source, severity, category, target, evidence, status }], total }` [Amended 2026-08-17, D-0035 batch: the row previously documented a FINDING where the method returns the page of them. The documented noun was wrong, and the fix is the noun; `total` is the count before any filter] |
| `agentFileGet` | `{ role: "student" \| "teacher" \| "auditor" \| "watcher" }` | `{ content, defaultHash, currentHash, modified, installed, path }` [Amended 2026-08-17, D-0035 batch: `installed` says whether the repo has its own file or is reading the shipped default, and `path` where it would be written; both are read by the client today] the .daijin/agents instruction file; modified drives the settings badge |
| `agentFileSet` | `{ role, content }` | updated file record with recomputed hashes [Claims verified 2026-08-17, claim audit: currentHash changes with the content, defaultHash does not, `modified` flips, and the key set matches agentFileGet's, so a client can render a set the same way it renders a get] |

## Events (server initiated notifications)

Notification method names are part of the contract: step events arrive as
JSON-RPC notification method `step`, board findings as method `boardFinding`.
`ts` is epoch milliseconds everywhere; clients display offsets.

One jsonl step-event stream, the same shape the platform emits, powering both
the init activity feed and the gym live view:

`{ ts, jobId, phase, step, detail, counts?, level }`

[Added 2026-08-17, v5, the terminal-event invariant] Every job emits EXACTLY
ONE event with `phase: "done"`, and it is the last event for that jobId. The
step names what happened: `finished` (the runner's, `level: "info"`, when the
job completed without announcing its own ending), or the job's own terminal
step (`written`, `kept-yours`), or `failed` (the work threw; `level: "error"`,
detail carries the message), or `cancelled` (`level: "warn"`). CLIENTS KEY ON
THE PHASE TO LEARN THAT IT ENDED, AND ON `level` TO LEARN HOW: the phase says
a job stopped, and `level` says whether it stopped well (`info`), was stopped
(`warn`), or broke (`error`). [Corrected 2026-08-17: the previous wording said
to key on the phase and NEVER on the step, which is right for "has it ended"
and a trap for "did it succeed". A client following it read a FAILED init as a
completion, and then reported the brain missing afterwards without connecting
the two. The failure was real, and the guidance had removed the only field
that distinguished it. `level` is the discriminator because it is a small
closed set that is the same for every job, where the step is job-specific and
open.] Events emitted by a job after its own done event are DROPPED by the
runner, so a client that has rendered the ending will not receive more. The
single exception: a job that announces done and then throws produces two done
events, `failed` second, because suppressing a failure to preserve the count
would hide the thing the user most needs.

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

[Addition 2026-08-16, v5, keyRef disambiguation: keyRef's two meanings (env
var name or file path) are resolved BY SHAPE, never guessed: an absolute
path is a file, a SHOUTING_NAME is an environment variable, and a lowercase
relative string is REFUSED rather than guessed, since that is also the
shape of a pasted key. Three unambiguous prefixed forms exist (env:, file:,
and literal refusal for raw values). Role rows additionally carry
keyResolvable (true / false / null for never-configured) and keyReason, so
a client can render key health without any value crossing the wire.]

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
