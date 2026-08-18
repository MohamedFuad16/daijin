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
| `repoAttach` | `{ repoPath }` | `{ repo, warning }` creates the connected-repo entry the home screen lists. [Amended 2026-08-17, owner field test: `warning` is NULL when there is nothing to say, and an object `{ code, detail, attached, repositoryRoot }` when there is. Null rather than absent so a client can tell "checked and fine" from "this engine does not report warnings". Codes are `nested-in-repository` (the attached path is a subdirectory of a git repo; `repositoryRoot` names the root) and `not-a-git-repository` (`repositoryRoot` is null). BOTH ARE WARNINGS AND NOT REFUSALS because both cases WORK: a monorepo package is a legitimate attach, and a directory with no git still builds a brain, it is simply much thinner. What IS refused, with `-32602`: a path that does not exist, and a path that is a file. The nested case is the one that cost the field test a diagnosis, because the file walk sees the subdirectory while git answers from the repository root, so the analysis reports few files against many commits and nothing else says why] | [Amended 2026-08-17, D-0042: the FILESYSTEM ROOT and the user's HOME DIRECTORY are REFUSED with `-32602`, summary `not a project`. This does not reopen D-0036, which split what cannot work from what merely surprises: these two were always on the cannot-work side and were simply never named. A root holds no project; a home directory is a container OF projects and attaching it would mine a decade of unrelated material. The owner's home screen hung on an attached `/` left from before attach validated anything, and under D-0036 alone `/` still warned and attached. Both are compared AFTER resolution, so a trailing slash cannot smuggle one past. Ordinary directories under the home directory are unaffected, which is a positive control in the suite, since that is where projects actually live.]
| `repoClone` | `{ url, name? }` | `{ jobId }` clones a repository into the managed location and attaches it. [Added 2026-08-17, D-0039, F3. A JOB rather than an overload of repoAttach: a clone is minutes of network work with a progress stream, and one method whose behaviour is decided by the shape of its argument leaves a client unable to tell a local row from a long remote operation before it calls. Steps are `resolving`, `cloning`, `cloned`, `attaching`, under the `clone` phase, then the runner's reserved `finished` / `failed` / `cancelled`. The job's result is `{ repo, warning, destination, reused }`, the same `repo` and `warning` repoAttach returns. Destination is `<stateRoot>/clones/<host>/<owner>/<name>`: host and owner are in the path because a bare name collides the moment two owners both have a repository called `engine`. `name` overrides ONLY the last segment, so an override still cannot collide across owners. CLONES ARE NOT CLEARED BY CLEAR-INDEX (D-0031): `index/` is disposable because it regenerates, and a working tree does not. REFUSALS, all -32602: an unparseable URL, refused before a jobId is issued so a client does not render progress for a mistake; a local path or file: URL, which is repoAttach's job; a destination holding a DIFFERENT repository, never overwritten, since that directory may be the only copy of work done in a clone; and a private repository refused BY NAME with the gh CLI named, because git's own \"authentication failed\" reads as a broken credential to someone who never had one. Cloning the same repository twice REUSES the existing clone and reports `reused: true`. NOT SPEND GATED: git talks to a code host, not a paid model API. It is network egress that writes outside the repository, so the remote and the destination are disclosed in the step stream BEFORE the write. Submodules are not recursed: a submodule URL is a second remote the owner did not name.] |
| `repoDetach` | `{ repoPath }` | `{ ok }` |
| `jobCancel` | `{ jobId }` | `{ cancelled }` stops an initBrain or gym job |

## Core

| method | params | returns |
| --- | --- | --- |
| `analyze` | `{ repoPath }` | `{ languages, commitCount, structure, gateCandidates, hasBrainFolder, warning, walk: { filesSeen, capped, stoppedBy, limit } }` [Amended 2026-08-17, D-0035 batch: the engine was returning five further keys (`name`, `repoPath`, `files`, `git`, `brainFolder`) that NO client reads; readership was verified in the TUI, which takes `hasBrainFolder` and nothing else. They are mapped off at the daemon boundary rather than documented, on the standing argument that adding a field later is cheaper than removing one a client has started using. The internal analyze function still returns them; the wire does not] | [Amended 2026-08-17, D-0038: `warning` is the SAME object repoAttach returns, null when there is nothing to say. Added because this is the method whose numbers the warning explains: on a subdirectory the file walk sees the subdirectory while git answers from the repository root, so `commitCount` is the PARENT's against a handful of files, and nothing else in this response says why. A client that attaches and then analyzes would get the warning once; a client that calls analyze directly used to get the confusing numbers alone, which is the reading that stalled the owner field test.] [Amended 2026-08-17, D-0042, the owner's hang: `walk` reports whether the file walk saw everything. `capped` is true when it stopped early, `stoppedBy` is `file-limit` or `deadline` or null, and `filesSeen` is the count it stopped at, beside `limit` so a number arrives with its bar.

THE WALK IS NOW BOUNDED IN FILES AND IN TIME. It previously walked the whole tree and the caller trimmed the result, which bounded the ANSWER and not the WORK: an attached `/` walked the entire disk and this method never returned, so a client awaiting it per card span forever. Two bounds because they stop different things - a cap stops a tree that is too large, a deadline stops one that is too slow (a network mount, a volume that went away), and a count cap alone still hangs on slow directories.

The flag is ON THE WIRE because analyze already knew it had truncated and could not say so: the old flag lived on `files`, which D-0035 removed from the wire, so the engine held the caveat and no client could receive it. A capped census read as the whole repository.]
| `initBrain` | `{ repoPath, mode: "ingest" \| "layer1" \| "layer1+layer2", scope?: { areas: string[] }, budget? }` | `{ jobId }` scope limits Layer 2 to named areas (sub-75 path). Mode `layer1+layer2` is SPEND-TOUCHING: Layer 2 runs LLM narration on the user's engineer key, so the estimated budget is displayed and confirmed by an explicit user action before the job starts; without confirmation the call is refused with `-32050` |
| `diagnose` | `{ repoPath, control?: boolean }` | `{ caseRate: { exact, cases }, violations, cases, hits, misses, perCase, clusters: { byType, byArea, byArm }, identifierMisses, recommendation, discriminatingRange, controlSkipped }` [Amended 2026-08-17, D-0035 live tier: this row was PROSE, and prose is the right level for a return that is "the file, plus classification" and the wrong level for a structured result carrying clusters, a case rate, violations and a range. It was also the method that exposed the tiering hole: listed as live because it embeds, described in prose so nothing could compare it, and therefore checked by NO tier while the gate printed it as covered elsewhere. `discriminatingRange` is null when the control arm was not run and carries `measuredAt`, `fresh`, `stale` and `staleBecause` when it was, so a recalled measurement is never read as a fresh one; `controlSkipped` names why when the arm could not run. `recommendation` is null here by design: choosing between enriching docs, running Layer 2 or bootstrapping through the gym is the auditor's call, and that one spends] mechanical sub-75 diagnosis, zero-spend: missed gold cases clustered by type, area, and arm, from the retrieval-score tooling. [Addition 2026-08-16, v5, D-0030's surface: `control: true` (the LITERAL true; a truthy guess does not arm it) adds a permuted arm over the same store, embedder, k and budget, and returns `discriminatingRange: { caseRate: { candidate, control, range, casesOfHeadroom }, mrr: { candidate, control, range } }` or `controlSkipped` naming why (a corpus with under two distinct answers cannot be permuted). OFF by default because the arm doubles the call's wall clock; `discriminatingRange` is null when unmeasured, never zeroes, since a client must distinguish unmeasured from measured-and-found-nothing.] |
| `diagnoseNarrate` | `{ repoPath }` | `{ recommendation }` SPEND-TOUCHING: the auditor narrates a recommendation over the mechanical diagnosis. Explicit user action per call |
| `retrievalScore` | `{ repoPath, tokenBudget?, sweep?: boolean }` | `{ at, caseRate: { exact, cases }, mrr, violations, chosenBudget, rationale, perCase, budgetSweep? }` [Amended 2026-08-17, D-0035 live tier: `at` is when the measurement was taken. The scoreHistory row documents the same stamp, and two representations of one fact should be documented once each, identically] sweep=true runs 3k/4k/6k/8k. caseRate.exact is the rational value, cases is "31 of 34" form. caseRate and violations are enforced floors; mrr is recorded for movement only, never floored. perCase rows: `{ caseId, hit, rank, arm: "semantic" \| "lexical" \| "fused", type, area }` so sub-75 diagnosis clusters by type, area, and arm |
| `search` | `{ repoPath, query, options? }` | `{ chunks, tokensUsed, context }` [Amended 2026-08-17, D-0035 live tier: `context` is the assembled block, which is the thing an agent actually pastes, so it is the PRODUCT of this method rather than a leak. A search whose most-used output went undocumented would be the repoPath defect again. Found by the live tier, which is the only tier that can call this method] |
| `documents` | `{ repoPath, filters?: { q?, type?, area? } }` | document inventory for the brain browser: `[{ id, type, path, title, area, tags }]`; browsing is not search-only. Filter keys are exactly q (substring over id, title, path), type, and area; unknown filter keys are an error, never silently ignored, so a misspelled filter cannot return everything |
| `budgetEstimate` | `{ repoPath, mode: "layer1+layer2" \| "gym", scope? }` | `{ estimatedTokens, basis }` ZERO-SPEND deterministic estimate (from corpus size, commit count, and scope), computed without any provider call; this is what the spend confirmation dialog displays BEFORE consent, so an estimate that itself spent would defeat its purpose. basis is a one-line human-readable derivation |
| `scoreHistory` | `{ repoPath }` | past floor measurements, newest first: `[{ at, caseRate: { exact, cases }, chosenBudget, embedding, originPath, index }]`; [Amended 2026-08-17, D-0035 batch: `originPath` and `index` say WHICH CHECKOUT and WHICH BRAIN produced a row. Clones share one repoId and therefore one history, which is the right identity because a trend is a property of the project, but two checkouts on different branches then write different brains' floors into one series; without these a mixed series reads as a smooth trend. `index` is `{ digest, documents }` over document ids and content hashes, not over the database file, whose bytes move with vacuum and would mark every rebuild of identical content as a new condition. `embedding` is the served identity the row was measured with. Null rather than guessed when unknown] the repo card trend line renders from this, distinct from budgetSweep which is one measurement across budgets |
| `serveStatus` | `{ fresh? }` | `{ repos: [{ path, health, floorScore, mcpActive }], ollama: { reachable, probedAt, endpoint, model, dimension, version, digest, hint }, db: { backend, repos, stateRoot }, spendGate: { open, path } }` the gate is observable before anything is attempted. [Addition 2026-08-17, enum sweep: `health` is `no-brain` \| `warn` \| `ok` \| `critical`. `no-brain` means never indexed, `warn` means indexed but below the MCP unlock threshold or never measured, `ok` means at or above it, and `critical` means the brain exists and could not be opened, which is a real state the home screen must show rather than a crash. A row's health is recomputed per call, so a repo whose brain was deleted on disk stops reporting the health it had when it was attached] | [Amended 2026-08-17, owner field test F5: `ollama` and `db` were documented as BARE NAMES with no shape, which is why the contract-shape gate never checked them and the client rendered `?` for values the engine held in a variable. Both key sets are now closed and IDENTICAL ACROSS BRANCHES: `hint` used to appear only on the failure branch, so no client could rely on a fixed set. `endpoint`, `model` and `dimension` are CONFIGURATION and are sent on both branches, populated from settings whether or not ollama answers; `version` and `digest` are probe results and are null when unreachable; `hint` is null when reachable. `endpoint` is the host actually probed, threaded from `retrieval.ollamaBaseUrl`, which the probe previously could not see at all. `db.stateRoot` is always a real path, never null.]

[Amended 2026-08-17, D-0043: the ollama probe is BOUNDED AND CACHED. Its timeout is 1.5 s,
down from 5 s, because this runs on a screen paint rather than on the embedding path. And
the result is reused for a few seconds, keyed on ENDPOINT AND MODEL, so repeated paints do
not re-probe and a settings change re-probes at once rather than reporting the state of a
server the engine is no longer using.

Measured: with `retrieval.ollamaBaseUrl` pointing at a host that ACCEPTS AND NEVER ANSWERS,
serveStatus cost 5,017 ms on EVERY call. It is now ~1.5 s once and ~10 ms thereafter. A
refused connection and an unresolvable name were always instant; the timeout is only
reached by a host that is asleep, firewalled, or behind a VPN that dropped, which is why
every earlier unreachable-endpoint fixture failed fast and none of them noticed the cost.

FAILURES ARE CACHED TOO. The unreachable endpoint is the expensive case, so a cache holding
only successes would have missed the defect entirely. The window is deliberately short: a
user who starts ollama should see it within a paint or two.]

[Added 2026-08-17, D-0044: `fresh: true` skips the probe cache and re-probes. It is a
BOOLEAN and anything else is refused with `-32602` rather than coerced, because a client
sending `fresh: "yes"` would otherwise be silently served from the cache and would look
like a broken refresh button, which is the defect this parameter exists to fix. A bypassed
probe still WRITES its result, so an explicit check refreshes the window instead of
leaving the stale entry behind it for the next paint to serve.

THE CONSTRAINT, which is part of the contract and not a suggestion: `fresh` IS FOR AN
EXPLICIT USER ACTION. Automatic paints, polls and timers use the cache. A client that
passes `fresh: true` on every paint defeats the cache entirely and restores the
five-second-per-paint defect that the cache was added to fix; the engine cannot enforce
this and states it here so the discipline is inherited as text rather than as tribal
memory.

Why it exists: caching failures is correct for the paint path and it put a stale answer
behind the one button a user presses immediately after fixing the thing. Pressing refresh
right after starting ollama is the likeliest recovery action there is, and it was on the
lying path. Worst case for an explicit check is the probe timeout, which is the right
price for a press.]

[Added 2026-08-17, D-0045: `probedAt` is WHEN THE PROBE RAN, as an ISO string, and a cached
response carries the ORIGINAL probe time rather than the moment it was served - otherwise
every cached answer would look fresh, which is the thing this field exists to prevent. A
client derives staleness from it; a boolean `cached` was considered and rejected because it
cannot say HOW stale.

This is not a new rule. The roles section already says every stored ping is historical
(recorded at `at`) and never a live reading, precisely because a measurement rendered as
current when it is not is a lie with a timestamp missing. The probe cache turned `ollama`
into that class of value and it shipped without an `at`; this applies the existing rule to
the value that missed it.

Timestamp convention, worth stating once because a mixed convention inside one payload gets
copied rather than corrected: `ts` is a NUMBER on the event stream, `at` is an ISO STRING on
a record, and `probedAt` is an at-shaped name for an at-shaped thing.

It also gives a client a behavioural check for `fresh` that does not require trusting the
parameter: `probedAt` moves after `fresh: true` and does not after an automatic paint.]
| `mcpSnippet` | `{ repoPath }` | `{ unlocked, threshold: 0.75, snippet, reason }` the paste-ready MCP config, locked below the floor threshold. [Amended 2026-08-17, D-0035 batch: `reason` is the sentence floor.js wrote for the decision, displayed verbatim by the client, so a locked snippet explains itself in the words the measurement used rather than a paraphrase] [Amended 2026-08-17, dogfood catch: the unlock decision enforces VIOLATIONS from the same scoreHistory row the case rate is read from - a must-not pair surfacing means a wrong answer is being served, so the snippet is refused whatever the case rate says. History rows written before the field carry null, which the reason SAYS (re-run init to enforce that floor) and never treats as zero. scoreHistory rows now record `violations` for exactly this purpose] |

## Gates (discovered, user-editable data)

| method | params | returns |
| --- | --- | --- |
| `gatesDiscover` | `{ repoPath }` | `{ jobId }` probes package.json, CI configs, Makefiles; classifies each candidate live, measured, pre-broken, or unavailable against the baseline |
| `gatesGet` | `{ repoPath }` | `{ path, content, discovered, parseError }` [Amended 2026-08-17, D-0035: this row was PROSE and the prose was WRONG. It promised "content plus per-gate classification and liveness evidence" while the engine returned `{ path, content }`, so the screen built for the promise read a gates list that was never on the wire and showed an empty table with "0 carrying signal" over a file describing three gates. The prose tier is where no gate checks, and the ruling to leave rows in prose assumed the prose was accurate; this is that residual realized. THE ENGINE MOVED TO THE CONTRACT, not the reverse, because discovery had persisted the classification all along and gatesGet simply did not read the file it was returning. `content` is ALWAYS present, whatever state the file is in, because it is a file the user is invited to edit and a parse error is a fact about the file rather than a failure of this method. `discovered` is NULL when the document is not discovery-shaped, with `parseError` saying why, and null is not "no gates": a file that cannot be interpreted and a file describing zero are different facts, which is exactly the distinction the empty table got wrong. When non-null it carries `{ version, discoveredAt, timeoutMs, summary, gates }`, each of the first four nullable, and `gates` rows AS WRITTEN, since this document is the user's and the engine only reads it; discovery writes `id`, `command`, `role`, `cwd`, `availabilityCommand`, `unavailableHint`, `source`, `classification`, `enabled` and a `baseline` block carrying the liveness evidence] [Addition 2026-08-17, from the client's restoration questions, answered from the code: (1) `baseline.status` is exactly `pass` \| `fail` \| `timeout` \| `unavailable`. There is no `violations` status; a tool with pre-existing violations is a MEASURED gate, which is a `classification`, judged on movement rather than on a threshold. (2) `discovered` and `parseError` are MUTUALLY EXCLUSIVE: exactly one is non-null, always. There is no partial parse, because the parse is all-or-nothing at the document level and a malformed row inside a readable document is passed through as written rather than rejected. A client may branch on `discovered` alone. (3) `classification` is `live` \| `measured` \| `pre-broken` \| `unavailable`, and `summary.carryingSignal` is `live + measured`: THE GATES THAT CAN FAIL ON A BAD EDIT AND PASS ON A GOOD ONE. Pre-broken and unavailable gates are reported and never counted, because a gate that fails either way cannot tell a good edit from a bad one and counting it is how a repo reports checks it does not have] |
| `gatesSet` | `{ repoPath, patch }` | `{ path, content, discovered, parseError }`, the same shape `gatesGet` returns; the engine treats gates.yaml as DATA and stores what the user wrote byte for byte. [Amended 2026-08-17, claim audit: the prose claim "updated gates.yaml" became misleading the moment gatesGet gained its parsed half and this did not, because a client that SET a file and re-rendered then got a different shape from one that GOT it. Returning the parsed half here also answers the question at the moment it is asked: a user who saves learns immediately whether the file still parses, rather than discovering the breakage on the next screen] [Addition 2026-08-17: A FULL-CONTENT WRITE IS ALWAYS ACCEPTED, whatever state the file is currently in, INCLUDING when the file on disk does not parse. That is not a leniency, it is the repair path: refusing to write because the current content is broken would lock a user out of fixing the file they broke, and gatesSet is the only way they can fix it. What is refused, always and regardless of file state, is a STRUCTURAL patch (`{ gates: [...] }` rather than `{ content }`), with `-32602`: the engine treats gates.yaml as data it does not author, so it will replace the whole document on the user's instruction and will never merge into one] |

## Gym and exams

| method | params | returns |
| --- | --- | --- |
| `gymStart` | `{ repoPath, config }` | `{ jobId }` REQUIRES the open spend gate; refused otherwise [Amended 2026-08-18, owner round 9: THE STUDENT DRIVER IS REAL. The engineer is built from the configured engineer role before the job starts (an unconfigured role is a -32602 at the call, not a failure inside a consented job): claude-code roles run one confined agentic CLI attempt in the sandbox (file tools only, no Bash - the harness owns running gates) with the owner's chosen sub-agent file as the system prompt, and API roles drive a strict JSON action protocol (read / edit / check / submit) where the DAEMON executes edits with the path confined to the sandbox. Gates default to the repo's own gates.yaml rows that carry signal (enabled, live or measured) when `config.gates` is absent, and a repo where no gate carries signal is refused with -32602 before consent is spent - the cycle's measurement IS baseline-vs-candidate gates. The job re-blocks the spend gate in its finally (D-0060)] [Amended 2026-08-18, owner round 10: THE TEACHER IS WIRED. On gradable modes (`experiment`, `evaluation`) the cycle grades each applied attempt inline: the TEACHER role's configured model receives the task, the submission diff, the gate results and the shown document ids (never the gold commit), and its rubric walks the full grading.js refusal list - five cited axes, verdict capped mechanically, author stamped from the configured identity, grader independence checked against the exam's recorded author - before importRubricBatch stores it beside the run. `harness-debug` stays UNGRADED because the ledger refuses rubrics for it; that boundary is respected, not tested. An unconfigured teacher role on a gradable mode refuses at the call, before consent buys a cycle whose grades can never arrive. A grading refusal mid-cycle is a `gym-grading-refused` step and the attempt stays pending (a rubric can be written later; an attempt cannot be re-run); it never fails the cycle] |
| `gymStatus` | `{ repoPath, jobId? }` | `{ cycles, activeRun?, ledger }` |
| `examList` | `{ repoPath, filters? }` | bank plus draft queue. Two ORTHOGONAL status axes plus the split flag, platform semantics (exams.js:28-34): `[{ examId, title, status: "draft" \| "validated" \| "promoted" \| "vetoed", benchmarkStatus: "active" \| "quarantined", quarantineReason?, vetoReason?, heldOut: boolean, tier, provenance }]`. title is the human-readable one-liner from the auditor's task statement (v5; the bank was unreadable by id alone). status is the authoring pipeline; benchmarkStatus is measurement integrity (a promoted exam can be quarantined, e.g. cap-death per ADR-0148 lineage, and quarantineReason is required, min 20 chars, when quarantined). [Amended 2026-08-17, D-0035 batch: `vetoReason` joins the row on the same terms as `quarantineReason`, present exactly when its precondition is true. The engine COMPELS it (a veto is refused without twenty characters) and stored it faithfully while no wire shape carried it, so a user was required to write a justification that nothing could ever display. That gap was introduced by this batch, which moved examVeto's return from the full record to this row, and was found by the client asking why its veto screen never showed a reason back] |
| `examMine` | `{ repoPath, target?, confirm: true, budget? }` | `{ jobId }` mine the exam bank from the repo's real commit history. SPEND-TOUCHING, under BOTH locks gymStart holds: the owner gate (scope `exam-mining`) and per-call consent. A JOB streaming phases `mine` (walk, deterministic filter, committee, selected) and `validate` (per-exam worktree at base, baseline gates where any live or measured gate exists, real-diff scope), ending `done`/`mined` with `{ written, validated }` counts. The committee IS the auditor role: its configured provider answers once over the eligible candidates (claude-code roles run the owner's chosen sub-agent file as the system prompt) and AUTHORS each exam's task and title; the reply is strict JSON, and a selection naming a commit the deterministic filter dropped FAILS the job rather than being reinstated (the auditor proposes; mechanics accept). Selected exams land `status: "draft"`, move to `validated` when their worktree checks pass, and are PROMOTED only by the owner through `examUpdate` - gymStart banks `promoted` exams only, so no model can elect its own exam into the scored record. Every exam's provenance is `auditor-selection` with `authoredBy` naming the committee's model, written at mine time (P7 clause 4). `target` caps the committee's selection (default 10, max 25). [Added 2026-08-18. Funnel, refusals and the ledger rows pinned in exam-mining-rpc.test.js] |
| `spendGateSet` | `{ repoPath, status: "authorized" \| "blocked", scope?, reason?, confirm? }` | `{ file, open, status, scope, reason, hint }` flip this repo's spend gate from the TUI. [Added 2026-08-18, D-0060, owner round 9: "this gate opening and closing has to be a button". THE FLIP IS STILL THE OWNER'S HAND: the method only ever runs off an explicit button press; `authorized` requires a scope from the closed set, a written reason of at least 20 characters, and `confirm: true` (recorded like every spend consent), while `blocked` always works unconditionally, because closing a gate is always safe. The engine still never opens a gate on its own initiative, and EVERY JOB THAT SPENDS RE-BLOCKS THE GATE IN ITS FINALLY (examMine and gymStart both), so an authorization lives exactly as long as the run it authorized and a gate cannot be left open by accident. The return is the readSpendGate row, so a set renders like a status read] |
| `examDetail` | `{ repoPath, examId }` | `{ axes, attempts: [{ id, at, mode, status, verdict, tokens, tokenCap, grades, axes, ungradedCode, ungradedReason }], provenance }` [Addition 2026-08-17, enum sweep: `verdict` is `pass` \| `partial` \| `fail` \| `unsubmitted`, or null when the attempt has not been graded; `status` is the run status the ledger enforces (`completed`, `gates-regressed`, `metric-regressed`, `apply-error`, `unsubmitted`). A verdict and a status answer different questions: the verdict is what the grader concluded about the submission, the status is what the harness observed about the run, and an attempt can have a status with no verdict but never the reverse]` attempts newest first by `at` with `id` breaking ties. [Amended 2026-08-17, v5, finding 85: the designed boundary shape replaces what was an accidental spread of the gym ledger's row. `tokens` is the work tokens the attempt spent and `tokenCap` what it was allowed; a count without its cap is unreadable. `grades` and `axes` are THE SAME list, the finding-79 five-axis shape, under the contract's name and the name finding 79 introduced; a shape test asserts they cannot diverge and that this key set is CLOSED. AXES IS CANONICAL (finding 79's ruled shape and the name clients read); grades is the compatibility name from this contract's earlier text, and if the divergence test ever fires, axes is the one that was meant. The ledger's column names are NOT on this surface: it is a schema the daemon does not own, and the mapping happens at the daemon boundary] [Amended 2026-08-17, D-0035 batch addition: `mode` is `evaluation` \| `experiment` \| `harness-debug`, as the ledger enforces them. An evaluation attempt and a harness-debug attempt are different claims about the record, and a chart that renders them identically invites reading a debug run as a scored one. It came off the wire for want of a reader and came back the day one appeared, which is the removal rule working rather than being overturned] [Addition 2026-08-16, v5, finding 79: axes has THREE states and one shape. States: a graded attempt returns its axes; an ungraded attempt with a diff returns `null`; an attempt with NO diff returns `null` with its status saying why. `null` renders as "not graded", NEVER as zeroed axes, and an empty object is a forbidden value, because zeroed axes on a radar read exactly like measured ones. Shape: a LIST of `{ name, score, max }` in the canonical five-axis order (the wire serves rendering, and order matters on a radar; the engine's internal by-name keying maps to the list at the daemon boundary). Each ungraded attempt additionally carries `ungradedCode` (exactly one of `unsubmitted`, `apply-error`, `pending`; a new run status cannot reach the wire without mapping to one) and `ungradedReason` (the prose sentence, displayed verbatim); codes are for branching, prose is for humans [added 2026-08-16, verifier P8 audit: the field was real in the engine and the client and absent from the surface meant to adjudicate between them, finding 79's shape in a new place].] |
| `examVeto` | `{ repoPath, examId, reason }` | the updated exam record, in the `examList` row shape; user veto per the plan's bank view. [Amended 2026-08-17, D-0035 batch: naming the shape by reference moves this row from prose to checkable at the cost of one clause] |
| `examUpdate` | `{ repoPath, examId, patch }` | the updated exam record, in the `examList` row shape. [Amended 2026-08-17, D-0035 batch: naming the shape by reference moves this row from prose to checkable at the cost of one clause] |

[Amendment 2026-08-17, v5, tui-builder's P8 live run: the five rows above gained `repoPath`. The engine has always required it (each resolves through `requireAttached`, methods.js; a ledger is per repo), and the contract omitted it, so clients built against the contract rendered empty screens against a ledger that had rows. The contract now documents the reality it always should have; no engine change.]

## Settings, roles, board

| method | params | returns |
| --- | --- | --- |
| `settingsGet` | `{}` | full settings object, secrets masked [Claims verified 2026-08-17, claim audit: both assertions checked against the engine rather than assumed. FULL: every key in DEFAULT_SETTINGS is present in the response. MASKED: a role configured with a real key file returns the POINTER and never the value, verified with a sentinel that does not appear anywhere in the serialized response. Prose is retained because this row's answer is genuinely "the settings object", whose shape is DEFAULT_SETTINGS and would be a second copy of it here] |
| `providerCatalog` | `{}` | `{ version, providers: [{ id, label, endpointDefault, keyRequired, note, models: [{ id, label, reasoningEffort, note }] }] }` the closed provider list and its suggested models, for the settings dialog to populate from. [Added 2026-08-17, D-0037, F4. ZERO SPEND AND UNPROBEABLE: one local read of `engine/config/providers.json`. It does not and cannot list a provider's models over the API, which would be an authenticated call everywhere and a paid one on some; `rolePing` remains the only path that verifies a model or a key. A SEPARATE METHOD rather than a key on settingsGet, because a catalog is a constant and settings are user state, and folding a constant into settings re-sends it on every screen paint. `reasoningEffort` on a model is the accepted values or NULL where there is no such control, so a client enables that field from the catalog rather than from a table of its own. `keyRequired` is false for ollama, whose endpoint is local, and for claude-code, which is the owner's own CLI auth. [Amended 2026-08-17, owner field round 4: providers additionally carry `tools`, the opt-in tool list a role may enable (`[{ id, label, note }]`, today only zai's web_search, whose note discloses the shared Web Search / Reader / Zread quota) or null where a provider offers none. A `claude-code` provider entry exists with `endpointDefault: null`: its models are the Claude models the CLI accepts, and which sub-agent plays the role comes from `agentCatalog`, not from this file.] `note` is optional and carries a disclosure: ollama's models are a SUGGESTION rather than an inventory, since what is installed is local truth this method deliberately does not read. The file is owner-maintained through ordinary commits and is explicitly a starting point, not a registry.] |
| `settingsSet` | `{ patch }` | updated settings [Claims verified 2026-08-17, claim audit: the response is the full settings object, same key set as settingsGet, reflecting the patch] |
| `rolePing` | `{ role: "engineer" \| "teacher" \| "auditor" \| "watcher", confirm: true }` | `{ ok, httpStatus, ttftMs, latencyMs, servedModelId, at, hint? }` SPEND-TOUCHING: a real one-token provider generation. Only ever user-initiated from the TUI, never automatic, and retryable without a settings edit. servedModelId is the identity check; catalogue endpoints are not authoritative. [Implemented 2026-08-17, owner field round 4: the return is the STORED ping record (the same object settingsGet serves under role.ping), which is a superset of the four measurements this row froze. A provider-level failure (bad key, wrong model, host down) RETURNS `ok: false` with `hint` rather than throwing, because a failed verification is a stored fact the settings screen renders; refusals that precede any request (no consent, role unconfigured, unresolvable pointer) still throw. `ttftMs` is time to the first response body byte; with one token that is effectively first-token time. The endpoint falls back to the catalog's endpointDefault when the role has none. For provider `claude-code` the generation runs through the local claude CLI on the owner's login auth: `httpStatus` and `ttftMs` are null (there is no HTTP and no observable first token through `-p --output-format json`), and servedModelId comes from the CLI's modelUsage report, specifically the model with the MOST tokens against its name: the report lists the housekeeping helper (haiku) beside the main model, and the first key is whichever happened to be first - the dogfood run reported haiku as the identity of an opus ping until the weighting landed] |
| `agentCatalog` | `{}` | `{ agents: [{ id, name, description, model, path, scope }] }` custom Claude Code sub-agents found on this machine: `~/.claude/agents` (`scope: "user"`) and each attached repo's `.claude/agents` (`scope: "project"`). [Added 2026-08-17, owner field round 4. ZERO SPEND: a directory listing and a frontmatter read, no network and no CLI launch. `id` is the filename stem and is what a role's `agentRef` stores; `name`, `description` and `model` come from frontmatter and are null when absent, and a file with unreadable frontmatter is LISTED under its filename rather than hidden, because the user is choosing among their own files. Rows are reported as found: a project agent sharing an id with a user one is a second row, not a shadow, since which definition wins belongs to the claude CLI] |
| `board` | `{ filters? }` | `{ rows: [{ ts, source, severity, category, target, evidence, status }], total }` [Amended 2026-08-17, D-0035 batch: the row previously documented a FINDING where the method returns the page of them. The documented noun was wrong, and the fix is the noun; `total` is the count before any filter] |
| `systemCheck` | `{}` | `{ findings, at }` the tool-wide watch (owner ruling, field round 6: the watcher and auditor are UNIVERSAL, watching daijin itself, not just the gym). ZERO SPEND, mechanical, computed fresh per call: the embedder's reachability, the spend gate, brainless repos, each repo's gates file (unavailable gates and zero-signal summaries), and the role rows (failed verifications, never-verified configurations, and the Z.ai realm trap: a zai key answering 429 on the pay-as-you-go realm while the role sits on the catalog default is flagged as a probable GLM Coding Plan key aimed at the wrong billing realm). Each finding is a BOARD-SHAPED row (`{ id, ts, source: "watcher", severity, category, target, evidence: "systemCheck", status: "open", summary, detail, action }`) so the board renders both vocabularies as one; `action` is null or `{ fixId, label }` referencing systemFix's closed catalog. Findings are never stored: a stored finding keeps reporting a problem after the owner fixed it. [Added 2026-08-17. Shape pinned in test/system-watch.test.js] |
| `systemFix` | `{ fixId, role?, confirm: true }` | `{ ok, applied, detail }` the auditor's hand, under two locks. `confirm: true` is required on every call because a fix changes the machine or its settings, and the engine never infers consent. The catalog is CLOSED (engine/src/rpc/watch.js): a fix either runs a command written in this codebase (`install-pnpm`, `install-yarn`, both `npm install -g`) or patches one role's endpoint to a value written in this codebase (`zai-coding-endpoint` and `zai-payg-endpoint`, each needing `role`; the pair exists because the realm trap points both ways since the coding realm became the zai default, D-0056). Nothing from a repo's gates.yaml, a hint, or a provider response is ever executed or stored; an unknown fixId is a parameter error naming the whole catalog. A failed command returns `ok: false` with the tail of its stderr rather than throwing, because a half-applied machine change is a fact the user needs to read. NOT spend-gated: no provider is called. [Added 2026-08-17. Refusals and the closed-catalog property pinned in test/system-watch.test.js] |
| `goalStart` | `{ repoPath, triage?, intervalMs?, cleanSweepsToStop?, maxSweeps?, confirm?, budget? }` | `{ jobId }` the GOAL LOOP: the watcher runs until the tool is clean. [Added 2026-08-18, owner round 11, D-0063. One sweep is the mechanical systemCheck surface, the repo's gates ACTUALLY RUN (a gate that fails here is a current break in the repo, not a claim about a gate file; a failing live gate is `critical`), and the exam bank read for what stands between the owner and a runnable gym (unpromoted exams, an all-held-out bank). Every finding is persisted through the board and pushed on the boardFinding channel, so the loop's output is the board rather than a private log; findings are deduplicated by id across sweeps and only NEW ones are announced. ZERO SPEND by default, which is what lets it run indefinitely. `triage: true` hands each new finding to the AUDITOR role and is therefore spend-touching: it takes the owner gate (scope `exam-mining`) AND consent BEFORE the loop starts, and re-blocks the gate when the loop ends. The auditor answers with reasoning plus an optional fix id, which is honoured ONLY when it matches the fix the finding itself offered - the auditor's judgment decides WHETHER a known remedy runs, never WHAT runs, and everything outside the closed catalog is a recommendation written to the finding's thread. The loop ends on `cleanSweepsToStop` consecutive findingless sweeps (default 2), on `maxSweeps` (default 1000), or on `jobCancel`, which lands within a second because the interval is slept in slices; the stop rule is the pure `goalStopDecision` and its boundaries are pinned in system-watch.test.js. The terminal event says which: clean, or how many findings stand] |
| `agentFileGet` | `{ role: "student" \| "teacher" \| "auditor" \| "watcher" }` | `{ content, defaultHash, currentHash, modified, installed, path }` [Amended 2026-08-17, D-0035 batch: `installed` says whether the repo has its own file or is reading the shipped default, and `path` where it would be written; both are read by the client today] the .daijin/agents instruction file; modified drives the settings badge |
| `agentFileSet` | `{ role, content }` | updated file record with recomputed hashes [Claims verified 2026-08-17, claim audit: currentHash changes with the content, defaultHash does not, `modified` flips, and the key set matches agentFileGet's, so a client can render a set the same way it renders a get] |

## Events (server initiated notifications)

Notification method names are part of the contract: step events arrive as
JSON-RPC notification method `step`, board findings as method `boardFinding`.
`ts` is epoch milliseconds everywhere; clients display offsets.

One jsonl step-event stream, the same shape the platform emits, powering both
the init activity feed and the gym live view:

`{ ts, jobId, phase, step, detail, counts?, actionCode?, level }`

[Amended 2026-08-17, D-0041: `actionCode` joins the step event, OMITTED rather than null
when there is none, exactly as `counts` behaves, so a control keyed on its presence cannot
be switched on by an empty field. Today only the init pipeline's `blocked` step carries it.

It was already documented on initBrain's blocked REPORT and was unreachable: no method
returns that report and nothing writes it to disk, so this event is a client's only sight
of a block. tui-builder measured it against a real daemon when they went to build the
control it was added for, and found the field existed engine-side and arrived nowhere.

A step crosses FOUR reconstructions between the pipeline and a client - the pipeline's
stepper, initBrain's onStep forwarder, the job runner, and stepEvent - and every one was a
positive whitelist that dropped unlisted keys in SILENCE. The field was added at the source
and died three times without a word. Only the last of the four is a wire boundary and it is
right to be closed; the three upstream now pass extras through, and a test drives a real
run and fails if the pipeline emits a key the forwarder does not carry.]

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

[Added 2026-08-17, from a client assumption the engine could not honour:
`finished`, `failed` and `cancelled` are RESERVED to the runner. A job that
emits one of those as its own ending FAILS instead, with that as the reason.
So a done event carrying one of those three steps was written by the runner,
and its `level` can be trusted: nothing else can produce `failed` with
`level: "info"`, which is the pair a client following this guidance would have
believed. A job's own ending (`written`, `kept-yours`) is unaffected and
carries `level: "info"`. And a failure ALWAYS carries a reason in `detail`,
including when what was thrown had an empty message or was not an Error at
all, because a banner stating a consequence with no cause is the defect this
whole block exists to prevent.]

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

`settingsGet` returns `{ roles, instructionFiles, retrieval, storage, spendGate, charts, repoScanRoots }`
where each role is `{ role, provider, model, reasoningEffort, endpoint, keyRef, keyMasked, keyResolvable, keyReason, modelKnown, modelReason, tools, agentRef, ping: { ok, httpStatus, ttftMs, latencyMs, servedModelId, at, hint? } | null }`.

[Addition 2026-08-17, owner field round 4: `tools` is a list of provider tool ids this
role's calls carry (today only zai's `web_search`; the catalog's provider `tools` key
names what is offerable) or null for none. `agentRef` is an agentCatalog id when
provider is `claude-code`, else null: the role then runs headless through the local
claude CLI on the owner's login auth, with `model` choosing which Claude model the CLI
is asked for and no keyRef required.]

[Amended 2026-08-17, D-0037, F4: `preset` is REMOVED and `provider` replaces it. preset was
declared in DEFAULT_SETTINGS, written by nothing, and rendered as a column by the TUI that
was populated only in its mock data, so against a real engine that column was always blank
and the test asserted only that the key existed. A name like "Claude" is a RENDERING of
provider plus model rather than a stored value.

`provider` is a CLOSED enum of vendor ids, derived from `engine/config/providers.json` so
the enum and the catalog cannot drift; an unknown provider is REFUSED at set time, since a
typo is a silent misroute later and no data-file edit makes it valid.

`model` is NOT closed. The catalog calls itself a starting point rather than a registry, so
an unrecognised model is DESCRIBED and used as written rather than refused: refusing would
make the file authoritative over a fact it disclaims and would block a model that shipped
today until someone edits JSON. `modelKnown` is true / false / null-for-unconfigured, the
same three states as keyResolvable and for the same reason, with `modelReason` carrying the
sentence. Both are DERIVED per read, never stored, and are ignored in a patch.

`reasoningEffort` is null wherever the model has no such control, and null is the ONLY
encoding of unsupported: a string like `none` would read as a supported setting deliberately
turned off. It is refused at set time only when a KNOWN model contradicts it, because an
unknown model cannot contradict anything.

Roles are NORMALISED ON READ against the defaults: every row carries the full key set
whatever is on disk, and retired keys are dropped. Without this an owner who configured
roles before a field existed would keep rows missing that field, so the shape would be
correct on a fresh state root and wrong on the only machine that matters.]
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

[Amended 2026-08-17, D-0040: THE PREFIXED FORMS ARE NOW SHAPE CHECKED, which the contract
already implied and the parser did not enforce. `file:` and the path half of `env-file:`
must be ABSOLUTE, because a relative pointer resolves against the DAEMON's working
directory rather than the user's shell, so the same setting names a different file
depending on how the process was started. `env:` must be followed by something that can be
an environment variable name (`[A-Za-z_][A-Za-z0-9_]*`), which is what stops a pasted key
being accepted behind the prefix and failing much later as an unset variable; case is
allowed here, unlike the bare form which must SHOUT to be distinguished from a path.

Found by tui-builder's conformance test running inputs through the engine's own parser and
comparing verdicts against its independent mirror: the mirror was STRICTER THAN THE ENGINE.
Neither side could have found it by re-reading, since each matched what its author believed
the rule was.

The refusal now carries its ACTION rather than reprinting the list of forms, and NEVER
ECHOES THE VALUE IT REFUSED: the likeliest wrong value here is a pasted API key, and this
message crosses the RPC boundary and lands in logs.]

`initBrain`'s report carries `blocked` when a phase stops the run:
`{ at, reason, failed, action, actionCode }`. `reason` is the conclusion, `failed` names
every gate that fell short WITH ITS FLOOR beside its count, and `action` is the next move
in prose. `actionCode` (added 2026-08-17, D-0037) is the closed machine-readable twin of
`action`: `too-little-material` when too few cases could be mined to judge, which usually
means the attached directory holds very little, and `gold-set-too-thin` otherwise. A
client offering an "attach the repository root instead" control switches on the CODE; the
prose is written for a person and must stay free to be reworded without unwiring a button.

[Amended 2026-08-17, D-0046, the owner's 18-case repo: `blocked.at` now takes TWO values and
`actionCode` a third. `goldset-gates` is the gauge not being fit to measure; `discrimination`
is the gauge having measured and being unable to see, with `actionCode`
`gauge-cannot-discriminate`. Different problems with different next moves: the first asks
for more material, the second says the corpus is small enough that presence is nearly free
so almost any answer scores, which more cases of the same material will not fix. A client
that renders both the same way sends the user to mine when mining is not the problem.

THE COUNT FLOOR IS NO LONGER THE TARGET. `targetCases` stays 25, which is what mining aims
for; `minimumCases` is 12, the count below which a case rate stops being a measurement.
They were one number, so a repository that mined 18 well-diversified cases was refused on
headcount with every other check passing. The identifier floor SCALES with the set
(`max(3, ceil(0.2 x count))`, capped at the configured value) instead of being a fixed 5,
which is 20 percent of the target and 42 percent of a 12-case set - without scaling,
lowering the count would have moved the refusal rather than lifting it.

`floor.lowResolution` is null above 15 cases and otherwise carries `{ cases, perCasePoints,
spreadPoints, note }`: the band where a floor is real but coarse names itself, rather than
leaving a reader to infer error bars from a denominator. `perCasePoints` is exact
arithmetic (one case is 1/N); `spreadPoints` is measured, and its evidence and its own
retraction are in `docs/verification/goldset-floor-sweep/`.]

`repoScanRoots` is the list of directories the attach dialog scans for repositories to
offer, defaulting to `~/Documents` and `~/Documents/GitHub`. It lives in ENGINE settings
rather than in a client config because it is a user preference that must survive the
client: a scan root kept by a TUI is lost the first time another front end talks to the
same daemon. A patch REPLACES the list wholesale rather than merging it, because a merge
cannot express removing a root, and entries are resolved to absolute paths and refused if
any is not a non-empty string.

`board` returns `{ rows, total }`, rows as defined in its method row above.

`serveStatus().repos[].health` takes values `ok | warn | critical | no-brain`;
whether a repo needs a brain comes from `analyze().hasBrainFolder`, which is
authoritative.

## Error convention

JSON-RPC error codes. Data field always carries `{ hint }` written for the TUI
to display verbatim. Spend-gated refusals use code `-32050` with the gate path
in `data.gate`. The spend-touching methods, exhaustively: `gymStart` (owner
gate), `examMine` (both locks: the exam-mining gate scope and per-call consent), `goalStart` ONLY with `triage: true` (the sweep itself is mechanical and free; auditor triage takes both locks before the loop starts), `rolePing` (explicit user action per call), `initBrain` with mode
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
