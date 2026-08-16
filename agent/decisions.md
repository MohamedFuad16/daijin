# Daijin decisions (append-only)

## D-0001 (2026-08-16) Storage default

SQLite + sqlite-vec + FTS5 is the default backend, Postgres + pgvector the
secondary. Grounds: measured FTS5 parity with the Postgres lexical arm on the
platform gold set (identifiers 5/5 both arms, overall 12 vs 10, FTS5 keeping
every Postgres hit). Record: docs/fts5-report.json. Caveat added 2026-08-16
per verifier report 1: that comparison was an unfiltered lexical arm over raw
chunk content, not the shipped filtered path, so it does not predict fused
end-to-end case rate; the P2 A/B measures that.

## D-0002 (2026-08-16) Contracts frozen at P0

Store interface and RPC surface freeze before parallel work; changes go
through the leader. Grounds: five workers build against them concurrently.

## D-0003 (2026-08-16) Retrieval budget is measured per repo

4,000 stays the anchor (only measured point, exact floor 0.9117647058823529 =
31 of 34). Init sweeps 3k/4k/6k/8k zero-spend and picks the smallest budget
within one case of the best score, curve displayed. Content-survival gate is
the mechanical raise signal. Per-tier budgets ship only as an
auditor-proposable experiment.

## D-0004 (2026-08-16) Store contract widened to the derived seam (v2)

The v1 freeze could not serve retrieve.js: no gold-provenance exclusion, no
document or relationship access, no write path, no ordinals, no architecture
or provenance arms, no migrate. v2 adopts the seam derived in
docs/extraction-report.md from the real call sites. Grounds: verifier report 1
findings 3 through 7 and 10 through 12, each cited to platform line numbers.
v1's meta(key) became getMeta/setMeta and close() was added; both carried
forward.

## D-0005 (2026-08-16) must_not_outrank keeps platform ranking semantics

v1 renamed the field must_not, which reads as an exclusion set. The platform
metric is a ranking constraint (a listed document beating a required one,
retrieval-score.js:9) and violations: 0 is one of only two enforced floors.
The field is must_not_outrank with unchanged semantics.

## D-0006 (2026-08-16) Copies strip em and en dashes; parity is metric parity

The portable core carries 32 em dashes the no-dash rule forbids importing, so
daijin copies are NOT byte-identical to their platform originals. "Reproduced
byte-for-byte" in the plan's P1 check means the metric values and per-case
output, not source-file identity. Anyone diffing a copy against its source
should expect dash-only deltas.

## D-0007 (2026-08-16) One RPC revision before the TUI hardens

[Correction 2026-08-16, verifier finding 51: report 1 raised TEN numbered RPC
gaps (8, 9, 15 through 22), not nine; all ten closed in v2. An eleventh gap
from report 1's prose, the agent instruction files, was NOT closed in v2 and
closed later in v3 (D-0010). The original sentence below stands as written.]

All nine surface gaps from verifier report 1 close in a single v2 revision
(handshake, repo attach, job cancel, gates data methods, exam bank methods,
rolePing marked spend-touching and user-initiated, observable spend gate,
mcpSnippet, scoped Layer 2, sweep and diagnosis fields on retrievalScore).
Rationale: tui-builder builds against one stable surface instead of chasing
increments.

## D-0008 (2026-08-16) Store contract v3: the platform-faithful merge

The extractor independently derived a candidate surface (retrieval-store.d.ts)
from the same call sites as the leader's v2, converging on the four arms but
differing in detail. v3 merges both into the single store.d.ts, and where they
differed the platform-faithful version won, because P1's acceptance is metric
and per-case parity: lexicalCandidates takes the vector too (cosine selected
on every arm for the fusion rescale and pin floor), CandidateRow keeps the
platform's flat field names (id, chunk_id, ordinal, chunk_content, score,
lex_rank), filters carry project (null means whole store; daijin is one store
per repo) and a single area, standingDocuments takes a namespace prefix, and
existingDocumentIds plus indexedEmbeddingIdentity are first-class methods for
the gold-set existence gate and the embedding identity health gate.
retrieval-store.d.ts is deleted; store.d.ts v3 is the single contract of
record and the conformance suite targets v3 only. Engines floor is >=22
(better-sqlite3@13 requirement), not the platform's 20.18.1.

## D-0009 (2026-08-16) Ingest is an atomic full-mirror replace

Verifier report 2 finding 39: the write path had no delete, so a rebuild was
additive and a deleted source file left an orphan the gold-set existence gate
would keep certifying. Ruling: platform semantics. A full rebuild wraps
upserts plus pruneDocumentsExcept inside one transaction (ingest/index.js:198
lineage); deleteDocument and pruneDocumentsExcept added to Store v3. The
conformance suite must prove orphan removal is atomic.

## D-0010 (2026-08-16) RPC v3: the spend enumeration was wrong

Verifier report 2 finding 38: the error convention named gymStart and rolePing
as the only spend-touching methods while initBrain mode layer1+layer2 runs LLM
narration on the user's engineer key. That is the one class of error this
project does not ship, so D-0007's one-revision promise is broken knowingly.
RPC v3: the spend-touching set is exhaustive (gymStart, rolePing, initBrain
with layer1+layer2 behind a per-call budget confirmation, diagnoseNarrate),
the mechanical diagnose is split from the auditor's paid narration, agent
instruction files get agentFileGet/Set with hash badges (finding 41), and
board findings get a job-independent boardFinding notification with critical
pushed immediately (finding 42). Adding a spend path to any method is a
contract change, never an implementation detail.

## D-0011 (2026-08-16) Write side finalized against the real ingest path

Verifier report 3 (findings 44 through 47, 53) read platform/ingest/index.js,
the one call site report 1 had not walked. Closures, all in Store v3 same day:
replaceAllRelationships(rows) is a GLOBAL rebuild (the platform deletes the
whole relationship table and reinserts inside the ingest transaction; a
per-source signature cannot evict edges from deleted modules and stale edges
corrupt brain.impact_of); deleteDocuments(ids) is the deletedIds path next to
pruneDocumentsExcept's full-rebuild path; DocumentRow carries contentHash so
incremental ingest can detect change; chunk ids are store-assigned and absent
from the write shape (ChunkWriteRow is ordinal, content, vector, matching what
chunkDocument actually emits). Exam persistence, project registry, and the
ingest_run ledger are declared OUT of the Store interface: the gym writes only
to its own store, and P4 defines its own ledger seam.

## D-0012 (2026-08-16) Prune is project-scoped; parity writes never touch the live DB

Verifier report 4 finding 55: pruneDocumentsExcept(keepIds) with no scope,
pointed at the owner's multi-project platform database (557 documents), would
delete every project outside keepIds. Closures: the signature is
pruneDocumentsExcept(keepIds, project) with project required (null means the
whole store, the per-repo sqlite case), the conformance suite must prove a
prune scoped to project A leaves project B intact, and as standing policy the
pgvector parity impl never points write operations at the live platform
database: parity runs are read-only, write conformance runs against fixtures.
Also from report 4: contractVersion in hello tracks the methods.md document
version and is bumped in the same edit (was still "2" in the v3 document,
the one field whose only job is catching drift, drifted); standingDocuments
prefix defaults to 'global.' as contract, since an empty-string default makes
every document standing and rides it all outside the token budget silently;
the draft invariant is narrowed back to candidate queries and allDocuments,
because the platform standing query has no draft predicate and filtering
there would diverge per-case.

## D-0013 (2026-08-16) The evaluation default lives in the retrieval layer

The store-adapter challenged the contract rather than quietly complying: v2
and v3 stated the evaluation-type default as a store invariant, but the
platform applies it in retrieve.js:60 above the store, and baking it into the
store would double-apply the exclusion and hide evaluation documents from
brain.record_evaluation reads. Verified against platform bytes and upheld;
the contract now states the store honors filters exactly as given. A worker
saying "I believe the contract is wrong there, and say so rather than quietly
comply" is the behavior this team is designed around.

Also ruled the same day: stopwords ship as the MEASURED subset from the
recipe script (the set that produced 12 vs 10), not the full 174-word
snowball list, which is unmeasured; swapping it is an auditor-proposable
experiment, never a silent upgrade. relationshipEdges stays unordered on both
backends for P1 parity (the platform query has no ORDER BY); whether the
ranker's supersession walk is order-sensitive is routed to the extractor as a
question, and if it is, that is a platform nondeterminism finding first and a
pinned order on both backends second.

## D-0014 (2026-08-16) RPC v4: the P5 build is the contract's field test

The TUI build surfaced what the surface was missing in practice: notification
method names and the clock convention were unstated (now: methods step and
boardFinding, ts epoch milliseconds), the brain browser had no document
inventory (documents method added; browsing is not search-only), repo cards
had no floor-over-time series (scoreHistory added, distinct from budgetSweep),
and the gym, settings, and board payload shapes existed only as the TUI's
assumptions (now codified after review, including drawnFromResultFiles making
the denominator rule visible in the wire format). Also ruled: the MOCK spend
gate defaults to BLOCKED like the product; a demo that opens the gate is an
explicit flag, because the product's signature discipline is not inverted for
demos. Suite-count claims in leader messages carry a timestamp and the
moving-target caveat from now on; a snapshot of an actively-written suite
stated as a stable count is how the 129/129 claim went stale within minutes.

## D-0015 (2026-08-16) Hermetic and live suites are split

Verifier heads-up: the P1 parity test runs against the owner's live Postgres
and local Ollama, neither of which exists on a CI runner, so CI would be
permanently red, which teaches the team to ignore it, the inverse of the
vacuous-green class D-0014 closed. Ruling: engine/test/ is HERMETIC ONLY (no
network, no live services; injected embedders per the adapter's pattern) and
is what npm test and CI run; anything needing DATABASE_URL or a live Ollama
lives in engine/test-live/ and runs via npm run test:live, locally and
explicitly. The P1 green-suite precondition covers BOTH: npm test green on a
bare tree, and the parity test green under test:live at report time.

## D-0016 (2026-08-16) Row order: daijin ships ordered, parity runs the platform's statements

P1 finding, measured: the platform's 91.2% depends on unspecified SQL row
order. The document inventory query has no ORDER BY, and rank.js breaks
inferred-area ties by arrival order through a stable sort. With ORDER BY d.id
as the only change: enforced metrics identical (caseRate 0.9117647058823529,
violations 0), MRR moves 0.6588935574229692 to 0.6637955182072829, three
cases change inferred area. Ruling: daijin SHIPS the ordered form
(determinism is a product property and two backends cannot be compared on an
order neither defines); the pgvector store's parityMode runs the platform's
exact unordered statements for acceptance measurement only; both paths are
tested; the P2 sqlite-vs-pgvector A/B runs against the SHIPPED ordered path.
Changing the platform's own tie-break is the owner's call and is surfaced as
a platform finding, not acted on. Also ruled with P1: ChunkWriteRow strict
(lenient write-seam fallbacks deleted on both backends), the CRUD wrappers
are convenience not contract (conformance suite exercises v3 only), missing
shared suite is a hard failure not a skip, and the harness keeps explicit
--out with no automatic score ledger.

## D-0017 (2026-08-16) MRR carries no tolerance for backend changes, by design

The P2 A/B measured sqlite vs shipped-ordered pgvector at identical case
rate (0.9117647058823529 both arms, same 31 complete, same 3 failing with
byte-identical miss lists), identifiers 5/5 both, violations 0 both, MRR
delta -0.0039215686 (0.6637955182072829 vs 0.6598739495798318), mechanism
verified at the lexical arm (FTS5 bm25 vs ts_rank ordering, the only
component that genuinely differs; two cases move rank in opposite
directions, membership never changes). Ruling on the adapter's question: NO
MRR tolerance is pinned, deliberately, extending the platform's ADR-0150
reasoning: MRR is the number a ranking tweak can buy while case rate falls,
so flooring or tolerancing it invites optimizing the wrong thing. Backend
changes are judged on the enforced pair (case rate, violations) plus the
per-case diff; MRR is recorded as movement with both measured points
(pgvector 0.6637955182072829, sqlite 0.6598739495798318 on the platform
corpus at k=8) kept as the reference band. A future backend change that
moves MRR outside the band with case rate unmoved is a prompt to look at
the lexical arm, not a failure.

[Addition to D-0017, 2026-08-16, after verifier report 7: there are THREE
measured MRR reference points on the platform corpus at k=8, and conflating
any two flips the sign of a conclusion, since the sqlite value sits between
the pgvector values: 0.6588935574229692 pgvector on the parity path
(unordered inventory, P1 acceptance); 0.6637955182072829 pgvector on the
shipped path (ORDER BY d.id, P1 disclosure and P2 control);
0.6598739495798318 sqlite on the shipped path (P2 candidate). Any future
MRR comparison names its reference point and path.]

## D-0018 (2026-08-16) RPC v5: the finished TUI's five ambiguities ruled at once

The completed P5 shell surfaced five contract gaps, bundled into one
revision per the one-stable-surface discipline: (1) per-call spend consent
travels as confirm: true, initBrain layer1+layer2 additionally echoing the
budget the user saw, and a spend-touching call without confirm is refused
-32050 even with the owner gate open, the engine never infers consent; (2)
documents filters are exactly q, type, area, with unknown keys an ERROR so a
misspelled filter cannot silently return everything; (3) ping: null is the
canonical never-verified role encoding, since rolePing never fires
automatically and an unpaid role must be representable; (4) examList rows
carry a human-readable title from the auditor's task statement; (5) new
zero-spend budgetEstimate method powers the spend dialog, because an
estimate that itself spent would defeat the dialog whose entire purpose is
showing cost before consent. Also recorded: the TUI's method-coverage gate
parses the contract tables rather than trusting a count (minimum-25 guard
against a broken parse), and its stub-denial gate fires only when a denial
phrase and a declared method name co-occur; both patterns are recommended
to the daemon's test suite.

## D-0019 (2026-08-16) Daemon rulings: deferral code, gate order, one lock

From the daemon build. (1) Deferred declared methods answer -32001 with
data.phase and a real hint, named in v5's error convention; -32601 is never
legal for a declared method. (2) The gate-check-BEFORE-deferral order in
gymStart is a protected property: the daemon's own scope test caught the
bug of reading the gate flag instead of asserting scope ("open" is NOT
authorization; a gate authorized for exam-mining must not authorize a
gym-cycle), the fix is assertSpendGate('gym-cycle'), and whoever wires the
P4 cycle runner keeps check-then-defer, guarded by the existing mutation
test. Any future caller that reads the flag instead of asserting a scope
has the same bug. (3) The daemon takes a single-writer lock on its state
root; a second daemon exits with a named error pointing at the first.
Multiple TUIs are served by ONE daemon with multiple clients, never by
multiple daemons racing repos.json. Also accepted: the additive meta.arms
exposure in retrieve.js (arm is a property of how retrieval reached a
document, not of the document; destructured out before the ranker, parity
re-verified IDENTICAL after); retrievalScore appending to the repo's own
.daijin/score-history.json as the backing for scoreHistory; settingsSet
refusing a raw key VALUE outright rather than silently dropping it; and
the --no-probe flag reporting the probe was skipped instead of claiming
health it never checked.

## D-0020 (2026-08-16) Gym rulings at P4 delivery

From the P4 report, each confirmed by the leader. (1) The gym's own store
seam: .daijin/gym.sqlite beside the brain, refusing a database carrying
brain tables and refusing a foreign migration marker; the certification
ledger never touches the brain store or the user's git. (2) The denominator
rule is STRUCTURAL: recordRun throws for a run with no applied diff, so a
cap-death cannot have a row and the drawn cohort must be counted from
result files. (3) DEFAULT_RUN_MODE is harness-debug, deliberately inverting
the platform: the platform's caller is a committed run-order script, ours
is an RPC method a TUI button reaches, and a forgotten mode must not be
able to touch the scored record. (4) Prompt audit, not reinjection: the
artifact records which ADR-0167 sections the student actually received; a
scored run missing one raises a warn finding; the harness never silently
restores an owner-edited instruction file, because that would make the
settings badge a lie. (5) One authorization spends once: the cycle
auto-blocks the gate after running (closeGateAfter defaults true);
multi-cycle authorization is a future owner-side scope, never a default.
(6) Certification semantics as defined: one per run, evaluation mode, pass
verdict, exam unquarantined at certification time, non-empty harness
provenance. (7) S/M/L tier caps ship at the platform's measured ADR-0149
split (450k/800k/800k); a small task needing 800k is a runaway loop.
(8) Exam records live in the gym store, not YAML: one source of truth for
the two status axes. Known gap, next round after the verifier's P4 attack:
the gold-provenance exclusion (the platform's provenance.js) is NOT yet
ported, so "the student never sees gold" is currently enforced at output
(forbidden strings) but not at retrieval; gym-porter ports it and the
daemon's gymStart wiring threads excludeDocumentIds into retrieval, with a
scored run refusing to certify without an exclusion record. Also queued
post-attack: the ADR-0147 pre-seal check, grading/rubric/harvest, and the
extractor wiring the six gym RPC methods from gym-porter's call shapes.

## D-0021 (2026-08-16) Instrument checks answer two questions, and P6's provenance

(1) From the adapter's second dead check (a shasum-based idempotency
comparison that passed vacuously when perl was absent, since empty string
equals empty string): every shell instrument answers TWO questions before
its result is trusted: does it FIRE on a planted defect, and what does it
do when a tool it depends on is MISSING. Any check whose result comes from
a command substitution needs a non-empty guard, because an empty string is
the most agreeable value in shell. Both halves are now the standing
instrument rule. (2) P6's acceptance provenance, recorded plainly: the
leader authored six criteria in the assignment message before the build
but failed to transcribe them into the plan, so the record showed a
self-graded phase until the verifier caught it. The transcription is now
in the plan with two coverage clauses added AFTER the report (Ollama
honesty, two-runtime handling), marked as such, and the verifier's attack
checks whether the worker's 49 self-authored checks cover them. The
standing rule gains a second half: pre-registration means IN THE PLAN
FILE, not in a message; a sentence that lives only in a message is not
registered.

## D-0022 (2026-08-16) The refusal must reach the person it is for

Adapter finding: the daemon's lock refusal (a careful sentence naming the
PID and lock path) is written to stderr, which the TUI client discards
(rpc.py stderr=DEVNULL), so the user sees a bare "engine closed its
stdout" the first time they open Daijin twice, on a path the installer
made ordinary. Rulings, per the adapter's own recommendation: (fix 2, now)
the client keeps the daemon's stderr and surfaces its tail in the
connection error, turning the whole startup-failure class visible, owner
tui-builder; (fix 1, properly) one-daemon-many-clients is the real answer
and requires a second transport, a unix domain socket in the state root
with attach-before-spawn client behavior; the extractor DESIGNS it as a
proposal (not a build) with tui-builder consulted, since it is a contract
transport change; (fix 3, declined and recorded) the shim will not read
the lock file: a duplicated liveness check that drifts silently is worse
than no check, and the lock file stays an implementation detail, not an
interface. Also noted: the smoke check SIGKILLs daemons and the
pid-liveness reclaim survived five kills against one state root, verified
by the adapter rather than assumed.

## D-0023 (2026-08-16) The sentence stands; the scanner rises to it

Verifier finding 73: the gate-writer scanner caught 1 of 4 planted
offenders, and one miss is the exact demo-helper scenario its own comment
names as its purpose; another miss follows the module's own code style
(writes to a variable target), so the rule as written cannot fire on a
mutant imitating the owner. Ruling on the verifier's question (widen the
rules, or soften the sentence to what the test demonstrates): WIDEN. The
pre-registered sentence ("no code path exists that opens the gate, and
that absence is mutation-tested") is what the record remembers, and
weakening a promise to match an instrument is the wrong direction in a
project whose gates must be able to fail. Both suggested widenings adopt:
the owner rule fires on an open-status literal in any write window
regardless of target, and any foreign module that both writes files and
carries a /GATE string literal anywhere is an offender requiring an
explicit allowlist entry. False positives with an allowlist are the
correct trade for a rule whose failure mode is silence. P4 is ACCEPTED
with the widening as a required follow-up, and the live half is never
authorized before the widened scanner passes the verifier's four plants.

## D-0024 (2026-08-16) Every report carries a hash manifest; the substrate gap

gym-porter's answer to the ran-versus-stated question was the honest fourth
option: ran, landed, and unprovable, because THE REPOSITORY HAS NO COMMITS.
git log is empty; nobody can reconstruct any file's bytes at any past
moment; every byte-check is a read of a live, concurrently edited tree;
and three workers on one tree guarantee more mid-edit snapshots (three in
one hour). Two of the verifier's three observations reconcile cleanly (the
scan extension lives in the test's file-gathering helper by design; two
gateWriterOffenders call sites is the correct count), and the third (the
alias rule's presence at 08:33:54) is permanently unsettleable and is
recorded as such rather than adjudicated. Adopted now, team-wide: every
worker report carries a sha256 manifest of the files it makes claims
about, which makes each claim checkable without history. The stronger fix,
committing, is the OWNER'S call per the ground rules and is surfaced to
them. The verifier-plants acceptance is additionally pinned inside npm
test itself (the four plants verbatim in gym-spend-gate.test.js), so the
bar survives refactors; if script and test copy disagree, the script wins.

## D-0025 (2026-08-16) Cross-encoder reranking: build it measured, ship it off

Owner request: check for a cross-encoder in the RAG reranking and implement
if absent. Verified absent: no rerank stage exists in daijin or the
platform; ranking is bi-encoder (bge-m3) arms, RRF fusion, raw-cosine
champion and pins. Design constraints, non-negotiable: LOCAL ONLY (ADR-0139
lineage, no paid APIs in the retrieval path; the local Ollama currently
serves only bge-m3, so the backend choice needs a docs-verified answer:
Ollama rerank support, a local llama-server --rerank with a
bge-reranker-v2-m3 GGUF, or an in-process ONNX cross-encoder; VERIFY
against documentation, never guess); OFF BY DEFAULT and absent from the
parity path (P1's byte-for-byte claim must survive untouched; parityMode
never reranks); inserted as an optional re-scoring of the FUSED candidate
list before the budget stage, behind a config knob whose cost (latency per
query) is displayed next to it; and it becomes a default ONLY on a measured
gold-set win, judged per D-0017 (case rate and violations enforced, MRR
reported as movement), A/B on the platform corpus AND the portfolio-mine
corpus once its gold set exists, in the budget-sweep style: the number
decides, per repo. Assignment at resume: extractor implements the stage and
the backend adapter (its seam), init-miner extends retrieval-score with a
rerank on/off A/B, verifier attacks the measurement. If the measured win is
absent, the knob still ships, documented as measured-neutral-or-negative on
these corpora, and the honest number is the deliverable.
