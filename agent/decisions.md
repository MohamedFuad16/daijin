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

## D-0026 (2026-08-16) Staging discipline: five lanes, one tree, one index

Incident: commit 9d9f7a4 ("Ignore .bak files...") contains 545 insertions
of which 5 match its message; the other 540 are the extractor's entire
socket transport. Cause, jointly owned: the extractor's git add -A swept
another lane's files, its reset --soft left the index staged, and the
LEADER's own single-file commit then took everything in the shared index
under its message. History was NOT rewritten: other lanes had built on
the push, and a wrong label plus a findable dated correcting commit
(2a49644) is the better trade; that mechanism is affirmed as the standard
for mislabeled pushed commits. Standing rules, all lanes and the leader:
(1) stage explicit paths only, never add -A in the shared tree; (2)
staging and committing are ONE atomic action, never leave a staged index
or a reset --soft window open; (3) git diff --cached --stat runs before
every commit and must list only your own lane's files, a foreign path
aborts the commit; (4) never stage another lane's in-flight files, and
uncommitted mid-edit work in the shared tree is a named hazard until its
owner commits. The irony that the sweeping commit's own message was about
wildcard-add hazards is retained in the record deliberately.

[Addition to D-0026, 2026-08-16 12:26: the bare-commit variant claimed its
second victim within the hour: gym-porter staged its own paths correctly
but ran a bare git commit, which took init-miner's concurrently staged
files under its message (df1f99b, seven foreign files, tree green, history
not rewritten, same mechanism and same remedy as 9d9f7a4). Rule (2) is
therefore sharpened: the commit itself is PATH-SCOPED, git commit -- <own
paths>, which cannot take another lane's staged work regardless of index
state. A bare git commit at the repo root is no longer a legal operation
for any lane, the leader included.]

## D-0027 (2026-08-16) A retired gold case never enters the file the scorer loads

The harness scores every case in the file it loads. A case retired because
its target no longer exists would be measured against a known-absent answer
and score as a permanent miss, quietly lowering every future floor. Ruling:
.daijin/goldset.yaml holds ACTIVE cases only; the retirement record lives
in .daijin/goldset-retired.yaml and is APPENDED, never overwritten, so a
run cannot erase what earlier runs retired. store.d.ts already required a
retired case keep its date and reason; this is where that lands in the
file layout. Mutation-covered both ways. (Drafted by init-miner, merged by
the leader.)

## D-0028 (2026-08-16) The gold set is carried forward; identity is a stable key

Re-mining regenerates every case from the CURRENT tree, so nothing the
miner produces can ever be stale: the staleness gate was live at the unit
level and dead in the product. Ruling: the previous gold set is read and
merged with the freshly mined one. Identity is a STABLE KEY written at
mining time (provenance plus a hash of the canonical query), not the
positional id and not the query, so a user rewording a question edits
their case instead of creating a second one. Mechanics own must_return (a
fact about the tree as it is now); the user owns the wording; a reworded
case is marked userEdited so the report can say how much of the gauge is
user-worded. Keyless legacy files fall back to that format's identity.
(Drafted by init-miner, merged by the leader.)

## D-0029 (2026-08-16) A vacuous ranking constraint is pruned, not grounds for retirement

The existence gate checks must_return AND must_not_outrank; the staleness
gate judged only the answer, so a case whose DISTRACTOR was deleted
satisfied neither and the two gates deadlocked the pipeline permanently.
Ruling: dead must_not_outrank ids are pruned before the gates run, with
what was pruned reported, never silent. Grounds: a document that no longer
exists cannot outrank anything, so the constraint is vacuous while the
case remains perfectly askable; retiring it would shrink the gauge for a
dead distractor. General lesson retained: two gates reading different id
sets over the same object can deadlock each other, and neither looks
wrong in isolation. (Drafted by init-miner, merged by the leader.)

## D-0030 (2026-08-16) Every floor report carries its permuted-control range

From the P3 live run: on portfolio-mine (11 units, 49 chunks) the floor
scored 25 of 25 = exact 1 while a PERMUTED control (every answer
deliberately wrong) scored 18 of 25 = 0.72, because k=8 delivers 7.6 of
11 documents per query; presence is nearly free and case rate retains
0.28 of discriminating range, while MRR retains 0.8235. The
constants-generalization answer: the constants were tuned on 557
documents and the FLOOR METRIC, not the retrieval configuration, is what
fails to generalize downward. Ruling: every floor measurement reports its
permuted-control range alongside the raw number, so a saturated gauge can
never be read as a perfect one (init-miner builds it into the report).
Gating the MCP unlock on the control range instead of the raw rate is a
contract change deferred to the auditor era, recorded here as the open
design question. init-miner's own verdict-line withdrawal (its script
printed DISCRIMINATING from an invented 0.8 threshold; it now reports
both ranges and no pass mark) is the discipline applied to its own
instrument.

[Addition to D-0025, 2026-08-16 12:36, recorded BEFORE any backend number
exists, at init-miner's request and for its stated reason: once a number
exists, "portfolio-mine returned neutral" would read as evidence that
reranking does nothing, and it is not. THE PORTFOLIO-MINE ARM CAN ONLY
FALSIFY, by construction: its control sits at 25 of 25, so caseDelta can
only be zero or negative, and every possible verdict there is evidence
about the GAUGE, not about reranking. The ceiling is measured from two
independent directions: the permuted control (0.28 of discriminating
range) and a deliberately worst-case full-order-inversion reranker driven
through the real seam, which costs only 4 cases on the enforced metric
while collapsing MRR by 0.76. Reading, binding: a regression on
portfolio-mine is real and disqualifying; a win there is impossible; THE
PROMOTION DECISION COMES FROM THE PLATFORM CORPUS ONLY (31 of 34, three
cases of headroom). Promoting on MRR because it is the only metric with
range on small corpora remains forbidden per D-0017.]

[Addition to D-0025, 2026-08-16 12:53, the MEASURED VERDICT: case rate
identical to the last digit across control, K=20 and K=40
(0.9117647058823529), violations 0 throughout, so per D-0017 there is
nothing to promote on and the knob ships OFF, documented as
measured-neutral-on-enforced. MRR rose 0.0196, which is precisely the
signature D-0017 exists to be unimpressed by: the platform's one measured
regression moved MRR up while case rate fell, and a change that moves
only MRR is the shape the gate refuses. Per-case movement is mixed (four
cases improved rank, one worsened, none crossed hit/miss), so the
cross-encoder does real work the enforced gauge cannot see, at 42x to 81x
per-query cost. topK=20 and topK=40 score identically on every case AND
retrieve differently on seven (eighteen retrieval-level differences,
token counts moving up to 308): the finding-66 diagnostics block caught
on its first real experiment what a score-level comparison would have
called the same run. VERDICT LIMIT, stated in the record: this corpus
cannot answer the ruling's question. At a 91.2% floor only three cases
can possibly improve, and portfolio-mine has less range still. The
measurement worth running is on a corpus with real retrieval failures,
and none exists yet; that re-measurement is the standing auditor-era
item. The full write-up is engine/src/rag/RERANK-MEASUREMENT.md at
1fe20f1.]

[Final addition to D-0025, 2026-08-16 12:58, closing the ruling: the
portfolio-mine falsification arm ran and returned NEUTRAL on all four
budget/topK pairs (25 of 25 both arms, violations 0, MRR -0.01 which is
exactly one case moving rank 2 to rank 4), read per the amendment: no
regression, nothing disqualifying, no promotion possible at the ceiling.
Combined with the platform arm (case rate identical to the last digit,
MRR-only movement, the D-0017-distrusted signature), D-0025's verdict is
complete: the knob ships OFF, documented measured-neutral on both
corpora, at a cold cost of 6.7 to 15 seconds per query against a 0.24s
control. Instrument note for the record: the first latency numbers
measured llama-server's pair cache, not compute (1.5s cache-warm vs 15s
cold for identical work), and the flattering number was WITHHELD; arms
are now labeled cold or cache-warm and the headline price comes only
from cold. The re-measurement trigger remains a corpus with real
retrieval failures. The reranker server is stopped; the provisioning
recipe lives in RERANK-MEASUREMENT.md.]

[Addition to D-0030, 2026-08-16 13:00, ruling verifier finding 80: the MCP
unlock threshold (0.75) sits 0.03 above the permuted control (0.72) on the
portfolio-mine corpus, so on a small corpus the unlock can pass for the
same reason the floor does: presence is nearly free, and the gate cannot
tell a good brain from a noisy one. Ruling, the report-not-refloor option
consistent with how this project treats MRR: the unlock STANDS on its
threshold, and the unlock report now carries the permuted-control range
BESIDE it with an explicit saturation sentence whenever the control sits
within the range of the threshold ("the gauge is saturated at this corpus
size; this unlock reflects presence, not discrimination"). Gating unlock
on control distance is recorded as the open auditor-era design question,
deliberately not taken now: a threshold tuned for saturation on small
corpora would be wrong for large ones, and the range is the number that
generalizes. Also ruled: the 7.6-of-11 delivery figure, the anchor of the
saturation mechanism, is re-measured over all 25 queries before it is
quoted further (it currently rests on 5). And P3.5's comparison metric is
PRE-REGISTERED BEFORE THE RUN: the primary comparison between curated and
generated brains is the DISCRIMINATING RANGE (case-range and MRR-range
from each brain's own permuted control), with raw case rate reported but
explicitly labeled saturated at this corpus size. Choosing the metric
before the number exists is the whole discipline.]

[Addition to D-0018, 2026-08-16 13:16, a known gate limitation disclosed
by the extractor while declining to edit the frozen contract itself: the
contract-coverage gates on both sides match METHOD NAMES, not parameter
shapes, so a parameter can be added to the shipped surface without any
contract test noticing. The diagnose control arm arrived exactly that
way (implemented first, contract line proposed to the leader, doc gap
silent throughout). Recorded as the instrument-suspicion item it is; a
param-shape gate is future work, not smuggled in now. Also ruled: the
TUI shows the discriminating range AUTOMATICALLY beside any sub-75
diagnosis result rather than behind a checkbox, per D-0030's spirit that
the range rides with the floor wherever the floor is quoted; the
rendering lands with tui-builder after the motion strand, and the
control checkbox governs only whether the EXPENSIVE arm runs, never
whether an already-measured range is shown.]

## D-0031 (2026-08-16) The three-layer correction: contract, brain, index

Owner directive, reasoned against the build's actual bytes before ruling.
The confusion being corrected: "agent folder" and "RAG" read as two
competing memories. The corrected model, now the architecture:

  CONTRACT  .daijin/manifest.json + .daijin/agents/   how agents behave
  BRAIN     .daijin/brain/ markdown                    what the project knows
  INDEX     machine state OUTSIDE the repo             how it is found now

Verified before ruling: the contract separation ALREADY HOLDS in bytes
(agent instruction files are never ingested; zero references in the init
pipeline) but was never stated, so nothing guarded it. Now invariant 1:
THE CONTRACT IS NEVER INGESTED, NEVER CHUNKED, NEVER RETRIEVED. It loads
whole, first, and retrieval can never outrank it; a chunk scoring higher
than a rule is not a reason to break the rule. Ingest gains a refusal
test proving agents/ and manifest.json cannot enter the store.

Invariant 2: THE INDEX IS DISPOSABLE AND LIVES OUTSIDE THE REPO. Today
brain.sqlite defaults to <repo>/.daijin/brain.sqlite, machine state in
the working tree. It moves to the daijin state root, keyed by repo
identity; delete the index and the project keeps its memory, because:

Invariant 3: THE BRAIN IS DURABLE MARKDOWN, THE DB IS DERIVED. Layer 1
currently writes units straight into the store. Corrected: scaffold
writes .daijin/brain/ as canonical human-readable artifacts
(architecture.md, decisions/, lessons/, conventions.md, errors.md), each
carrying its evidence citations; ingest READS FROM those files; the
index is regenerable from them at any time. The repo remains the source
of truth, the brain is curated knowledge over it, the index owns nothing.

Invariant 4: daijin init IS A LIFECYCLE CONTRACT, not a folder check.
manifest.json declares the schema; init guarantees identity, contract,
brain, index, gold set, floor, in order, idempotently. An existing brain
is read-validate-diff-update; a corrupted one has invalid claims
rejected and affected artifacts rebuilt; a missing one is generated. The
adopt path (P3.5) reads an existing curated folder INTO this shape.

Invariant 5: CONTRACT MUTATIONS ARE GOVERNED, never retrieval-driven.
The watcher detects, the auditor recommends, promotion is explicit; RAG
surfaces evidence and decides nothing. (Already the plan's separation;
now bound to this boundary.)

DEFERRED AS A MEASURED EXPERIMENT, deliberately not adopted silently:
expanding the retrieval corpus to raw code, docs, tests, and history.
The 91.2 floor and every gold set are measured over brain units; corpus
composition is part of the gauge, and the platform-proven design is
unit-centric with citations POINTING INTO source, the agent's own file
tools covering raw code. Indexing raw source duplicates what grep-class
tools already do well and changes every measured number. It ships, if
ever, through its own registered experiment with its own gold set.

Owner operational items recorded with the directive: student and watcher
roles configure from the previous project's existing key (POINTER ONLY,
the platform's env source; no key value enters this repo, per the
standing secrets rule); teacher and auditor keys arrive from the owner
later; and a claude-code provider preset is planned, a custom Claude
Code sub-agent with proper instructions invoked by daijin for designated
roles, using the owner's local authentication instead of an API key,
spec'd when the owner returns.

## D-0032 (2026-08-16) Batteries run against private copies, never the shared tree

Verifier report 18 pinned the 1-in-5 suite flake with a controlled
two-arm experiment (38 runs, 18-for-18 separation both directions): NOT
nondeterminism. Mutation batteries mutate the shared working tree in
place (copy aside, break, run one test file, restore), and every window,
hundreds of milliseconds wide, is a period in which any other process's
npm test reads deliberately broken source and fails on whatever the
active mutation targets. The signature that found it: the tree's source
hash oscillating between one settled value and one-off transients,
RETURNING IDENTICALLY, which ordinary editing never does; an immutable
snapshot arm ran 10-for-10 clean at the same code. Every prior
observation is explained: a different test each time (whichever mutation
was live), 1-in-5 (duty cycle against a 10-second suite), reproducing at
concurrency 1 (cross-PROCESS, no in-process setting touches it), the
extractor's lane clean (its files were not the ones being mutated), the
chunk-count variance and the async-hop lever (a mutated source mid-read,
and a longer run overlapping more windows). The verifier included its
own instrument in the finding: the landed mutate.sh defaults to the live
engine, and it endorsed that battery without noticing.

RULING, the only shape that removes the window rather than scheduling
around it: EVERY mutation battery, lane batteries and the landed
p4-mutations/mutate.sh alike, runs against a PRIVATE COPY of the tree
(the DAIJIN_ENGINE override already exists and becomes mandatory
practice; batteries refuse to run when their target resolves to the
shared tree unless an explicit override names the intent). The
repo-lock and freeze-convention alternatives are declined: one
serializes work with no reason to serialize, the other depends on
everyone remembering, the property this project keeps proving does not
hold. The gravest consequence named for the record: a gate failing
1-in-5 toward failure only means every retry-until-green was
indistinguishable from a real regression retried away. Earlier
red-suite ATTRIBUTIONS (mid-edit readings) may have been battery
windows; verdicts stand (all were taken in freeze windows with hash
pins), and the verifier annotates the two attributions rather than
re-running.

## D-0032 addendum (2026-08-16) The dissolution was overbroad: two mechanisms

Verifier report 19 corrects one explanatory sentence above: the
chunk-count variance does NOT dissolve into the battery mechanism. A
mutated source fails a test; it does not drift a count on an ISOLATED
fixed-content fixture, and the extractor's 44-versus-45 drift (timing
lever moving frequency from 1-in-3 to 5-in-6) was observed on exactly
such a fixture. Two mechanisms, both real, neither subsuming the other.
The ruling above is unaffected; the consequence is added: fixing either
mechanism alone leaves the npm-test gate unsound, and a clean run after
one fix only establishes that no battery was running during it. The
drift is assigned to the extractor to pin; an init-lane fix lands via
init-miner. Report 19 also demonstrated the pure-function corollary:
purity is a property of execution, not of load, and a pure function
imported from a mutated file is a mutated pure function.

## D-0033 (2026-08-16) A method whose only tests inject its seam has not been tested against reality

The extractor found retrievalScore and diagnose DEAD against any real
brain: both built their corpus with project: null, which retrieve.js
refuses by name. Every unit test injected the scorer, so the refusal
first appeared when the method met an actual index, months of green
suite notwithstanding. Same shape as the earlier mcpSnippet defect:
invisible to a green suite, found by executing the thing once.

RULING, generalizing the existing "anything we hand a user to paste is
executed by a test" rule to every injected seam: for each RPC method
that takes an injectable dependency, at least one test (or a named
acceptance clause) must execute the method against the REAL
implementation of that seam, and the regression test for any such
defect asserts on what crosses the seam (the corpus handed to the
scorer), not on the outcome, so it stays hermetic while still binding
the real wiring. A green suite composed entirely of injected seams is a
statement about the tests' own stubs. Clause (d) of P8 would have
caught this instance; the rule exists so it does not take an
integration phase to discover a method has no data source.

## D-0026 addendum (2026-08-16) The commit form that survives concurrent lanes

init-miner's technique is adopted as the standing D-0026 practice: for
new files `git add -N <files>` (intent-to-add, so the pathspec matches),
then `git commit -F <msgfile> -- <explicit paths>`. The pathspec form
commits the WORKING TREE state of exactly those paths and ignores the
shared index entirely, so another lane staging or resetting mid-command
can neither pull foreign files in nor drop yours out. Empirical basis:
three sweeps in a row under the add-then-commit form, zero under this
one. The pre-commit lane hook remains the backstop for lanes that have
not adopted the technique.

## D-0032 addendum 2 (2026-08-16) The drift is retracted; the real second cause is traced

Two same-day corrections to the addendum above, recorded together
because they arrived together and point opposite directions.

RETRACTED: the chunk-count drift never existed. The extractor's own
retraction (docs/verification/init-chunk-drift.md, 5007e52): the 44 and
45 were read from two error messages at two different times with NO
PINNED COMMIT, straddling 9056789, which rewrote the brain to durable
markdown and moved the file's chunk totals by hundreds. At any fixed
commit the count is identical six-for-six, and an independent harness
over six fresh fixture copies produces byte-identical decision lists.
The async-hop "lever" discriminated nothing: a longer run is also a
wider window for a concurrent writer, so it was equally consistent with
the explanation it was deployed against. Report 18's dissolution was
right about the drift after all.

TRACED: a second mechanism exists anyway, and it is not the drift.
Verifier report 20, every link verified: rpc-surface.test.js's surface
sweep fires gatesDiscover and initBrain as UN-AWAITED JOBS against the
file's one shared temp repo, then twenty-two later tests use that same
repo; the discovery job's write (the literal string at
gate-discovery.js:334, character for character what CI read back) lands
wherever contention puts it. CI fired it because CI is slow. The class
produces green-that-means-nothing as readily as red: a test passing
while a job is mid-write proves nothing about the contract. Fix ruled:
remove the sharing, never sequence around it (the sweep gets its own
throwaway repo, and un-awaited work must not outlive the file) - the
private-copies-over-locks argument, third appearance today.

CONSEQUENCE for P8 clause (i), the extractor's procedural point,
adopted: "npm test passes" on a shared working tree describes an
INSTANT, not a commit. The five acceptance runs execute in a DETACHED
WORKTREE at the pinned commit (git worktree add --detach, node_modules
linked); the hash and no-battery assertions are retained as
corroboration inside the worktree.

## D-0034 (2026-08-16) Release path: public repo at release, vanity URL by redirect

Owner ruling, recorded verbatim in effect: (a) the daijin repo flips
PUBLIC at release time, after ultrareview passes; the canonical
artifact store is GitHub Releases on this repo (versioned tarball,
install.sh, and the checksum store-adapter deliberately deferred -
written against the real artifact, never designed in advance of it).
www.mohamedfuad.com/daijin serves as the vanity URL with ZERO backend:
portfolio-mine gains a vercel.json redirect (/daijin -> the repo,
/daijin/install.sh -> the latest release asset), edited AFTER
ultrareview is done and deployed by the owner's manual Vercel CLI
flow. Sequencing is therefore: P8 claim -> owner-triggered ultrareview
-> findings fixed -> repo public + release cut with checksum ->
portfolio-mine redirect + owner deploy. The site edit and the
visibility flip are owner-gated actions in the owner's own sequence;
nothing here happens before ultrareview passes. The release work
(tarball, install.sh hardening, checksum) is unassigned until post-P8;
store-adapter's record holds the checksum's design constraint.

## D-0026 addendum 2 (2026-08-16) The shared-path gap closes: agent/ and docs/ are the leader's lane

init-miner restated the hook gap against current bytes: paths classed
"shared" were invisible to the multi-lane count, so one lane's code
plus another lane's staged agent/state.md read as one lane and passed
- and the shared class contained the two highest-traffic files in the
repo. RULED: agent/* and docs/* (outside docs/verification, which maps
to owning lanes) now map to a LEADER lane, so lane-code plus a state
or plan file counts two lanes and refuses without the explicit
override. Residual shared class, accepted and stated: README.md,
.gitignore, .github/*, engine/package.json and package-lock (lanes
legitimately touch the manifests when adding dependencies; the
traffic there is low and the risk is taken knowingly, not silently).
Also mapped: docs/verification/init-mutations/* to init. The new
mappings were exercised before being trusted (six-path probe, all
correct); the refusal path of the counting logic itself has been
watched failing three times in the record. Noted from the same
report: the pathspec commit form makes the gap unreachable for lanes
that use it; the hook protects the lanes that do not.

## D-0026 addendum 3 (2026-08-17) The pathspec form's one sharp edge

From init-miner's missed-files incident (24527ec): a pathspec commit
does not match a path git has never seen, so NEW files need the
intent-to-add (git add -N) first - and forgetting it FAILS SILENTLY BY
OMISSION rather than loudly: the commit lands, looks complete, and the
new files sit untracked. The check that catches it is the one
init-miner ran: git status --porcelain over your own paths after the
commit, empty or it is not done.

## D-0035 (2026-08-17) The wire is designed at the boundary, and the contract gains a gate

Three rulings from the extractor's post-claim measurements, all
frozen until the P8 verdict lands (wire shapes do not move under an
attack in progress):

1. examDetail's attempts row: the ENGINE is wrong, not the contract.
It emits the gym ledger's column names raw (seven snake_case keys,
result_file and extensions_granted made public surface by accident;
tokens and grades absent entirely, so a contract-written client
crashes on first real data). Ruled per the extractor's own
retired-SELECT* argument: MAP AT THE BOUNDARY to a designed shape
({ id, at, status, verdict, tokens, tokenCap, grades } plus the
finding-79 fields), amend the contract dated for the additions that
earn their place, land with a shape test. Breaking only for readers
of the leaked names, which is one client that already reads both.

2. done/finished APPROVED: JobRunner already emits done/failed and
done/cancelled, so a client observes a job ending exactly when it
went wrong and must guess when it went right - the asymmetry is the
defect. Five lines, strictly additive, same shape as the failure
event, with a runner test. Clients keep their labelled inference as
fallback until it lands; both independent measurements of the
inter-event gap (9.6s, 9.7s) stand as the threshold's basis.

3. THE GENERAL INSTRUMENT: a contract-shape gate asserting what the
engine EMITS matches what the contract DOCUMENTS. Four divergences
in one day (repoPath absent, ungradedCode absent, attempts disagreeing,
the terminal event missing from both) are the argument that "the
contract is a document that no test executes" is a standing defect,
not four incidents. Queued post-verdict beside the acceptance script;
D-0033 named the per-method seam rule, this is its surface-wide form.

## D-0033 addendum (2026-08-17) A mock more permissive than its original certifies the wrong behavior

From the vetoReason incident's second finding: tui-builder's veto
dialog accepted a one-character reason because ITS MOCK only required
non-empty while the engine requires twenty characters. A mock more
permissive than what it stands in for does not merely fail to test a
boundary - it CERTIFIES the wrong behavior, because every test passing
against it is evidence for a claim the real system will refuse. The
dead-gate family with the permissiveness moved into the double; the
same failure D-0033 names, one seam out. Rule: a mock's refusals are
part of the seam it doubles - when the real side enforces a bound, the
mock enforces the same bound, and the mock's validators are checked
against the contract the way wire shapes are.

Also recorded, the corrected READERSHIP RULE from the same incident:
before removing a field, check EVERY consumer including test suites (a
test is a consumer with a stronger claim than a screen: it is the
thing that would otherwise catch the break), and separately ask
whether the field is the only path to something a user was COMPELLED
to produce - a field with no reader because nobody could reach it is
not unread, it is unreachable, and removing it converts a required
record into a toll.

## D-0036 (2026-08-17) Attach warns on non-git, refuses only what cannot work

Field-test ruling, recorded here because the code's behavior departs
from the original spec text and the departure deserves a numbered
home, not a source comment alone. The spec said refuse a path not
inside a git repo; the ruling ACCEPTS the extractor's overrule: attach
REFUSES what cannot work (a path that does not exist, a file) and
WARNS on what works-and-produces-less (a non-git directory, a
subdirectory of a repo with the root named). The deciding measurement:
init on a non-git directory completes eight phases and blocks at the
gold-set integrity gate like any thin repo, now with the gate naming
its floors and the likely cause. Refuse-versus-warn is the distinction
the inspection exists to draw. The 60-fixture cost of refusal was
named by the extractor as a motivated-conclusion hazard and was not
the basis of the ruling.

## D-0037 (2026-08-17) `preset` is removed; `provider` replaces it

`preset` was declared in the role row, written by nothing, and rendered as a
column by the TUI that was populated only in its mock data - so against a
real engine that column was always blank, and the client test asserted only
that the key existed. A name like "Claude" is a RENDERING of provider plus
model rather than a stored value, and two fields meaning nearly the same
thing is how they drift.

Decision: `preset` removed, `provider` added as a closed enum of vendor ids
derived from `engine/config/providers.json` so the enum and the catalog
cannot drift. `reasoningEffort` added, with null as the only encoding of
unsupported. `model` is NOT closed: the catalog calls itself a starting point
rather than a registry, so an unrecognised model is described (`modelKnown`,
`modelReason`) and used as written rather than refused - refusing would make
the file authoritative over a fact it disclaims, and would block a model that
shipped this morning until someone edits JSON. Roles are normalised on read
so every row carries the full key set whatever is on disk.

## D-0038 (2026-08-17) `analyze` carries the attach warning

A client calling `analyze` on a subdirectory saw the PARENT's commit count
against a handful of files, with nothing in the response saying why: the file
walk sees the subdirectory while git answers from the repository root. That
exact reading stalled the owner's field test. `analyze` now returns the same
`warning` object `repoAttach` does, because this is the method whose numbers
the warning explains.

## D-0039 (2026-08-17) `repoClone` is a job, not an overload of `repoAttach`

A clone is minutes of network work with a progress stream. One method whose
behaviour is decided by the shape of its argument leaves a client unable to
tell a local row from a long remote operation before it calls.

Decision: `repoClone { url, name? }` returns `{ jobId }`. Destination is
`<stateRoot>/clones/<host>/<owner>/<name>` - host and owner in the path
because a bare name collides the moment two owners both have a repository
called `engine`. Clones are never cleared by clear-index: `index/` is
disposable because it regenerates and a working tree does not. Submodules are
not recursed, because a submodule URL is a second remote the owner did not
name. Cloning the same repository twice reuses the clone; a failed clone
removes the partial directory it left behind; a destination holding a
different repository is refused and never overwritten.

## D-0040 (2026-08-17) Prefixed key pointers are shape checked

`KEY_REF_FORMS` advertised `file:/abs/path` and `env-file:/abs/path#NAME`
while the parser accepted any string after the prefix. A relative pointer
resolves against the DAEMON's working directory rather than the user's shell,
so the same setting named a different file depending on how the process
started. `env:` accepted anything at all, so a pasted key parsed and failed
much later as an unset variable.

Found by tui-builder's conformance test running inputs through the engine's
own parser and comparing verdicts against an independent mirror: THE MIRROR
WAS STRICTER THAN THE ENGINE. Neither side could have found it by re-reading,
because each matched what its own author believed the rule was.

Decision: paths must be absolute; env names must match
`[A-Za-z_][A-Za-z0-9_]*`. Refusals carry their action and NEVER ECHO THE
VALUE THEY REFUSED - the likeliest wrong value at that input is a pasted API
key, and the message crosses the RPC boundary into logs.

## D-0041 (2026-08-17) `actionCode` reaches the client on the step event

The field existed on `initBrain`'s in-process report, which no method returns
and nothing writes to disk, so it was unreachable by any client. A step
crosses FOUR reconstructions between the pipeline and a client, each a
positive whitelist that dropped unlisted keys in silence; the field was added
at the source and died three times without a word.

Decision: extras pass through the pipeline stepper and the initBrain
forwarder; `stepEvent` carries `actionCode`, omitted rather than null when
absent so a control keyed on presence cannot be switched on by an empty
field. A test drives a real run and fails if the pipeline emits a key the
forwarder does not carry.

## D-0042 (2026-08-17) The file walk is bounded in files and in time

The owner's home screen hung forever on an attached `/`, left from before
attach validated anything. There WAS a cap of 50,000 files, applied after the
walk finished: walk everything, sort, slice. It bounded the ANSWER and not the
WORK, so on `/` the walk never reached the trim. `analyze('/')` never
returned; the client awaited it per card.

Decision: both bounds go into the walk, because they stop different things - a
file cap stops a tree that is too large, a deadline stops one that is too slow
(a network mount, a volume that went away), and a count cap alone still hangs
on slow directories. The truncation is reported ON THE WIRE as
`walk: { filesSeen, capped, stoppedBy, limit }`; it was previously known to
the engine and unreachable, since the old flag lived on a field the D-0035
batch had removed from the wire. The filesystem root and the home directory
are refused as `not a project` - they were always on the cannot-work side of
D-0036 and were simply never named.

## D-0043 (2026-08-17) The status probe is bounded and cached

With `retrieval.ollamaBaseUrl` pointing at a host that accepts and never
answers, `serveStatus` cost 5,017 ms on EVERY call. A refused connection and
an unresolvable name are both instant, so every earlier unreachable-endpoint
fixture failed fast and none of them noticed.

Decision: probe timeout 1.5 s, because this runs on a screen paint rather than
on the embedding path; result cached for a few seconds, KEYED ON ENDPOINT AND
MODEL so a settings change re-probes at once rather than reporting the state
of a server the engine is no longer using. FAILURES ARE CACHED TOO - the
unreachable endpoint is the expensive case, so a success-only cache would have
missed the defect entirely.

## D-0044 (2026-08-17) `fresh` bypasses the probe cache for explicit user action

Caching failures was right for the paint path and it put a stale answer behind
the one button a user presses immediately after fixing the thing. `ctrl+r` is
the user saying "I changed something, look again", which is exactly the input
where a cached answer is wrong.

Decision: `serveStatus({ fresh })`. A bypassed probe WRITES its result, so an
explicit check refreshes the window rather than leaving the stale entry for
the next paint. A non-boolean is refused rather than coerced, because a silent
coercion produces exactly the broken-refresh symptom the parameter exists to
remove. The constraint - `fresh` is for explicit user action, automatic paints
use the cache - is contract text, because the engine cannot enforce it.

## D-0045 (2026-08-17) `probedAt` says when the probe ran

The roles section already required this of measurements: every stored ping is
historical, recorded at `at`, never a live reading, because a measurement
rendered as current when it is not is a lie with a timestamp missing. The
probe cache turned `ollama` into that class of value and it shipped without an
`at`. This applies the existing rule to the value that missed it.

Decision: `ollama.probedAt`, an ISO string, stamped when the PROBE ran so a
cached response carries the original time rather than the moment it was
served - stamping at serve time would make every cached answer look fresh,
which is the thing the field exists to prevent. Convention, stated once
because a mixed one inside a payload gets copied: `ts` is a number on the
event stream, `at` is an ISO string on a record.

## D-0046 (2026-08-17) The gold-set target and its measurability floor are different numbers

The owner's re-test mined 18 cases from a real repository and the gold set
BLOCKED, on a bare count gate at 25 with every other check passing. 25 was
the platform's TARGET, measured on a large corpus, being used as a floor for
every repository - one number answering two questions that only coincide by
accident.

Decision: `targetCases` stays 25 and mining still aims for it. `minimumCases`
becomes 12, the measurability floor. Below 15 the floor report carries an
explicit low-resolution caution. A discrimination gate (headroom over a
permuted control >= 3 cases) is added alongside, and the identifier floor
scales with the set instead of sitting fixed at 5.

THE FLOOR IS A PRODUCT JUDGMENT, MADE BY THE LEAD, informed by arithmetic. It
is recorded that way because it was first proposed as an empirical threshold
and is not one. The arithmetic that survives is sufficient and does not move:
one case is 1/N of the rate, so at 12 a single case is worth 8.3 points -
coarse but still a measurement - while below 12 one case is a tenth of the
scale or worse, and a number one case can move by ten points has stopped
being a measurement the product should publish. 15 versus 12 is settled by
the question the owner actually asked: a legitimate modest repository gets
wide bars, not a refusal.

THE ONE EMPIRICAL FINDING THAT STANDS is that D-0030's discriminating range
CANNOT PICK THIS FLOOR. Headroom over a permuted control never reaches zero
at any size tested, down to six cases, across both random and clustered
draws. The range is kept as a separate gate because it catches a set that is
large and degenerate, which a count cannot see, and it is expected to bind
rarely. Adding it reverses `measureResolution`'s documented "reported, never
gated": the range stays reported either way, and what changes is that a set
with no discriminating room no longer also gets a floor - the same reasoning
that stops a gold set which failed its own integrity gates from scoring.

TWO CLAIMS MADE WHILE ARGUING FOR THIS NUMBER WERE RETRACTED BEFORE IT
LANDED, and both retractions are in the evidence directory rather than only
here.

THERE IS NO KNEE. The statistic that appeared to show one was a range over
six draws; re-run with different seeds it moved by a factor of three (12
gave 25.0 points then 8.3; 18 gave 11.1 then 16.7). A proper 30-draw
dispersion declines smoothly with no threshold in it. This is the
actionCode error class - a rule inferred from samples that happened to
differ, reported as a measurement - named two days earlier by the same
author and repeated on the very number under proposal, then caught by
re-running before landing rather than after.

AND THE OPTIMISM BOUND WAS FALSE. The argument that subsampling a mature
corpus is a best case, because a real thin repo mines a more clustered set,
was measured rather than left asserted: clustered draws showed identical
spread and better headroom. Clustering degrades neither axis, and heavy
clustering is separately caught by the areas and types gates, so the count
floor never had to carry that load.

The caution copy quotes ARITHMETIC ONLY for the same reason: a measured
spread had to survive a re-seed to be quoted in user-facing text, since a
figure a re-run can contradict is worse than no figure.

Evidence, both instruments, both runs, the seed sensitivity and the
clustering result: docs/verification/goldset-floor-sweep/. It lives in the
repository rather than in scratch because a policy threshold whose basis is
gone cannot be checked, and this basis changed twice in the hour it took to
measure.

Consequences: repositories between 12 and 24 cases now init and measure where
they were refused. Their numbers are coarse and say so.

## D-0047 (2026-08-17) rolePing is real: one token, the stored record is the return

The deferral stub is gone. A ping is one real generation against the role's
configured provider: chat-completions shape for openai/xai/zai/deepseek/ollama
(with /v1 appended where the endpoint lacks it, and max_completion_tokens for
openai's reasoning models), the messages shape for anthropic, and a headless
claude CLI turn for claude-code.

Three rulings inside it:

1. THE RETURN IS THE STORED RECORD. The contract row froze four measurement
   fields; the implementation returns the stored ping object (ok, at, hint
   riding along), because the settings screen renders the stored record and a
   return that differs from it is two truths for one fact. The contract row
   is amended to say so.
2. PROVIDER FAILURES RETURN, REFUSALS THROW. A 401 or a down host is a
   completed, billed verification worth storing (ok: false, hint from the
   provider's own sentence, never echoing a key). No-consent, no-provider and
   unresolvable-pointer refuse before any request leaves the machine.
3. ttftMs is the FIRST RESPONSE BODY BYTE, measured off the stream reader.
   With max_tokens 1 that is effectively first-token time. claude-code has
   no observable first token through -p json, so it carries null rather than
   an invented number, and httpStatus null because there is no HTTP.

recordRolePing enters state through its own method: patchSettings still
refuses `ping` from clients, because a client writing its own ping is a client
marking its roles verified without a provider answering.

Verified by: cd engine && node --test test/role-ping.test.js (9 tests, mock
HTTP servers and injected exec; no network).

## D-0048 (2026-08-17) claude-code is a provider; sub-agents come from agentCatalog

The owner runs roles through Claude Code sub-agents on their own login auth.
Encoded as a sixth provider id (claude-code) rather than a parallel mechanism,
because a role stores exactly one provider whatever transport answers it:
keyRequired false, endpointDefault null (nothing to dial), models are the
Claude models the CLI accepts. Which AGENT plays the role is a separate fact,
stored per role as `agentRef` and discovered by the new zero-spend
`agentCatalog` method scanning ~/.claude/agents and each attached repo's
.claude/agents (frontmatter name/description/model; unreadable frontmatter
lists the file under its filename rather than hiding it). The role dialog
swaps the endpoint field for the sub-agent picker when claude-code is chosen.

The gym's engineer driver still does not exist (createEngineer remains null);
when it lands, the claude-code branch launches `claude -p` per task with the
agent body as system prompt. Building that adapter now would be dead code
behind a seam nothing calls, so it waits for the driver.

## D-0049 (2026-08-17) Role tools are stored per role, offered by the catalog

zai's web_search (whose quota is shared with Web Reader and Zread, disclosed
in the catalog note) is stored as `role.tools: ["web_search"] | null`. The
catalog's provider `tools` key is what a dialog may offer; the role's list is
what the user turned on. Null never an empty list, same encoding rule as
reasoningEffort. No call path consumes it yet beyond storage and display;
the gym driver will thread it into the request's tools block.

## D-0050 (2026-08-17) Advisories are not warnings in the init checklist

mcp-saturation arrives at level warn so an unknowing client still surfaces
it, but a checklist that counts it into "1 warn" on a successful init sends
the owner hunting for a problem that does not exist (owner field round 5,
verbatim). The TUI classes it as an ADVISORY: counted and rendered as
"1 note" in cyan (the palette level no severity owns, same rule as
kept-yours), never escalating the phase to warn status. The engine's wire
level is unchanged; the classification is a client rendering decision keyed
on the step name.

## D-0051 (2026-08-17) The case rate shows count AND percentage together

Owner override of the count-only display rule: "I want the accuracy rate to
be shown." The count keeps the denominator honest (31 of 34), the percentage
beside it (91.2%) is glanceable; neither alone. format_case_rate is the one
formatter, so every surface moved together.

## D-0052 (2026-08-17) Key discovery is names, never values, and never a disk scan

The owner asked for "scan the entire machine for keys". What shipped is a
picker of POINTER SOURCES: *.key files under the state root's keys/
directory, and environment variable NAMES matching a credential shape
(API_KEY / TOKEN / SECRET). Names only; no value is read, rendered, or
stored. A machine-wide filesystem walk hunting key-shaped files is refused
on three grounds: it is slow, it is invasive, and a program that greps a
disk for credentials is indistinguishable from malware to anyone watching
it. The picker fills the visible field rather than saving behind it, so
what you read is what you save.

## D-0053 (2026-08-17) Step-event stamps are rebased by the client

The engine stamps step events with epoch milliseconds (jobs.js now());
the mock streams job-relative milliseconds; the elapsed column claimed
seconds-into-the-job for both. Fixed in the CLIENT: EventLog rebases any
first-stamp past 1e10 ms against the job's first event. The wire is
unchanged because an epoch is the honest fact and relative time is a
rendering; the threshold is unambiguous (no job runs 116 relative days, no
epoch is below it). The alternative, changing the engine to emit relative
stamps, would have broken any consumer doing its own wall-clock joins.

## D-0054 (2026-08-17) The watcher is universal; the auditor's hand is a closed catalog

Owner ruling, field round 7: watcher and auditor watch the whole tool, not
the gym. Mechanised as systemCheck (zero-spend sweep, board-shaped findings,
computed fresh and never stored - a stored finding keeps reporting a fixed
problem) and systemFix (confirm: true always; the catalog is CLOSED in
watch.js so a fix runs only commands or values written in this codebase).
The severity of leaving the catalog open is concrete: an unavailableHint is
repo-authored text, and executing anything derived from it hands every
attached repo a shell on the owner's machine. Detection selects a fix by
pattern; the fix's command is ours. Paid narration (watcher summaries,
auditor prioritisation) can ride on these rows later; detection itself must
stay free or it will never run. No background loop: the sweep rides every
board load, and action requires the owner's click.

## D-0055 (2026-08-17) The Z.ai realm trap is a detected pattern, not a support answer

Z.ai bills api/paas/v4 (pay-as-you-go) and api/coding/paas/v4 (GLM Coding
Plan) separately; a key subscribed on one answers 429 "insufficient balance"
on the other, which reads exactly like a broken key. The platform's own
driver (ZAI_CODING_BASE_URL) proved the owner's key lives on the coding
realm. Ruled: the catalog default stays api/paas/v4 (the vendor's documented
default; the coding realm 404s for non-subscribers), the catalog note names
both realms, and the watcher flags zai + 429 + default-endpoint as the trap
with the endpoint fix attached. Diagnosed from the platform's committed
config at zero spend; no provider call was made to confirm.

## D-0056 (2026-08-17) The zai default endpoint is the Coding Plan realm - owner override

Reverses half of D-0055 by the owner's explicit ruling ("set by default the
plan one, not the API's"). endpointDefault for zai is now
https://api.z.ai/api/coding/paas/v4. The trade is documented rather than
hidden: pay-as-you-go keys now hit the trap instead of coding-plan keys, so
the watcher's realm detection became TWO-WAY (429 on either known realm
offers the other; fixes zai-coding-endpoint and zai-payg-endpoint, both in
the closed catalog). The catalog note carries both realms and the rule that
a key only works where its plan lives.

## D-0057 (2026-08-17) `daijin update` goes back to where the install came from

The shim's update subcommand reads source.path from the VERSION stamp the
installer wrote, pulls it --ff-only, and re-runs that checkout's installer.
The stamp is the authority because it records where THIS install actually
came from; a hardcoded path or a remote URL would update something else. No
merge resolution: an updater has no business resolving conflicts in the
owner's checkout, and a diverged checkout fails loudly instead.

## D-0058 (2026-08-18) Violations lock the MCP unlock, from the same row the case rate reads

Caught by the dogfood run, not by any suite: mcpUnlock decided on case rate
alone while the contract called violations an enforced floor, so a brain
serving two must-not violations was offered a snippet. Ruled: any recorded
violations > 0 lock the unlock whatever the case rate says, because a
must-not pair surfacing means a wrong answer is being served. scoreHistory
rows now carry violations; rows written before the field carry null, and
null is SAID in the unlock reason (re-run init to enforce), never treated
as zero, because silently zeroing an unrecorded floor is how enforced
floors stop being enforced. The CLI ping identity fix rode the same batch:
servedModelId is the modelUsage entry with the most tokens, since the CLI
reports its housekeeping helper beside the main model.

## D-0059 (2026-08-18) The committee is the auditor role, and the owner admits to the bank

Exam mining's LLM step runs on the AUDITOR role the owner configured (any
provider; claude-code roles run the owner's chosen sub-agent file as the
system prompt with frontmatter stripped). The committee authors each exam's
task and title - the words the student reads - and its reply is strict JSON
with one mechanical extraction allowance and no repair. Three boundaries,
each tested: a selection naming a commit the deterministic filter dropped
fails the job rather than being reinstated; selected exams cannot enter the
runnable bank without the owner's promote click (mining writes draft or
validated, gymStart draws promoted only); and provenance records the
authoring model at write time. Zero discovered gates skips the baseline
check but never the worktree check, and says so on the stream.

## D-0060 (2026-08-18) The gate is a button; the licence is one marked write

Owner ruling: "this gate opening and closing has to be a button." The
invariant "the engine can only ever write the gate blocked" is amended, not
dropped: spendGateSet opens a gate only off an explicit owner action with a
scope, a written reason and recorded consent, and every spending job
re-blocks the gate in its finally, so an authorization cannot outlive its
run. The mutation guard keeps its teeth by moving every gate write into
spend-gate.js and licensing EXACTLY ONE opening write, recognized by an
ownerAction marker that is code (comments are stripped before scanning) and
that lands in the gate file itself. Plants pin both failure modes: a second
marked write and an unmarked authorized write are flagged.

## D-0061 (2026-08-18) The student has no shell, and paths are accepted by mechanics

The live engineer driver confines both transports the same way the exam
committee is confined: the model proposes, mechanics accept. The claude-code
student gets file tools only - no Bash, because the harness owns running
gates and a student with a shell can read its own grader; its created files
come from git's untracked list, which is sound exactly because nothing else
can write. The API student's every path goes through confinePath (lexical,
after resolution, absolute and .. both refused). A malformed protocol reply
is a nudge whose tokens still count, because the spend was real whatever
the reply was worth.

## D-0062 (2026-08-18) The teacher grades inline; the driver binds, the model judges

The inline teacher divides authorship exactly where auditability needs it:
the model proposes scores, citations, verdict and gaps; the driver supplies
runId and both binding digests from the packet, because the digests exist to
stop batch-import mixups and a model asked to echo a sha256 only
manufactures refusals. Validation is shared with the external-batch path so
the inline teacher enjoys no laxer rules. Grading runs only on gradable
modes (the ledger's harness-debug refusal is respected as a boundary);
grading failures leave the attempt pending rather than failing the cycle;
and an unconfigured teacher refuses before consent, because a cycle whose
grades can never arrive is a cycle sold under a wrong description. The
attempt wire verdict prefers the rubric over the run row's null column,
caught live in the first graded run.

## D-0063 (2026-08-18) The goal loop watches for free and acts only through the catalog

The owner asked for a watcher that runs "until the entire project, gates,
exams are bug free" and an auditor that fixes what it finds. Ruled: the
sweep is mechanical and free (systemCheck, the repo's gates actually run,
the exam bank), which is the only way a loop can honestly run indefinitely;
auditor triage is opt-in, takes the gate and consent BEFORE the loop starts,
and stops itself after two consecutive provider failures rather than
spending a quota to re-learn one refusal. The auditor's power is bounded the
same way it was in D-0054: it may decide WHETHER a fix from the closed
catalog runs; it may not decide WHAT runs, and anything outside the catalog
is a recommendation written to the finding's thread. The loop ends on
consecutive clean sweeps so "bug free" is a state it can actually report,
not a promise it makes.

## D-0064 (2026-08-18) The held-out split is mechanical, and draw rules are checked at the call

A held-out split is a sampling decision, so the engine owns it: the exam
committee's heldOut flag is advisory and ignored below five exams, because
reserving the only exam in a bank leaves the gym with nothing to draw (the
owner met exactly that). Draw rules are checked in gymStart BEFORE consent -
a refusal a daemon can make at the click must never arrive as a failed job
the owner already paid for - and the client sends cohort "held-out" when the
owner explicitly picks a held-out exam, which is the explicit act the rule
was written to require.
