# Dijin extraction feasibility report

Read-only scout. Date: 2026-08-15. No writes to the project, no provider calls,
`platform/exam/GATE` untouched, gym not run.

Root under study: `/Users/mfuad16/Documents/Codex/2026-07-21/hand-ai-brain-build-instructions-md/ai-brain-platform`
(referred to below as `<root>`; all cited paths are relative to it).

## Evidence discipline

Every claim below is tagged.

- **VERIFIED**: I read the cited file and line, or ran the cited read-only command and read its output.
- **INFERRED**: derived from things I read, but the conclusion itself is not written anywhere.
- **ASSUMED**: not checked in this session; stated so it can be attacked.

Commands I actually ran this session, with results:

| Command | Result |
|---|---|
| `npm test` | 578 pass / 0 fail, exit 0, 9.15 s. Zero spend. |
| `psql "$DATABASE_URL" -c "SELECT count(*) ..."` | 557 documents, 732 chunks, 399 relationships, 63 exams, 495 exam_runs |
| `psql ... pg_total_relation_size` | chunk table 20 MB, document table 3744 kB, database 37 MB |
| `psql -c "SELECT extname, extversion FROM pg_extension"` | `plpgsql 1.0`, `vector 0.8.5` |
| `psql -c "SELECT version()"` | PostgreSQL 17.10 (Homebrew), aarch64-apple-darwin |
| `find ... \| xargs wc -l` | non-test JS: rag 1660, ingest 794, mcp 529, db 433, export excluding vendored sources 1896, exam 21569 (15896 excluding experiment/launcher/probe scripts) |

**Correction to the project's own docs, dated 2026-08-15.** `<root>/CLAUDE.md` ground rule 6 states the
retrieval gold-set floor as "79.4% case rate / MRR 0.606". The committed baseline file
`platform/rag/retrieval-baseline.json:2-6` records `caseRate 0.9117647058823529` (31 of 34),
`mrr 0.6588935574229692`, `violations 0`, measured 2026-08-14 at commit `7917fab` over a
538-document corpus. CLAUDE.md is stale by roughly one measurement generation. Any re-validation
plan in this report targets the JSON file's numbers, not CLAUDE.md's. (VERIFIED, both files read.)

---

## 1. Coupling inventory

Classification key:

- **TRIVIAL**: a literal that becomes a config field or CLI argument. Hours of work.
- **STRUCTURAL**: needs a real abstraction (an interface, a discovery pass, a schema change).
- **FOUNDATIONAL**: a design assumption that must be rethought before v1 has a coherent shape.

### 1a. Hardcoded project name and Brain path layout

The string `internship-portal` appears as a literal in production (non-test) source in **at least
33 places**. The load-bearing ones:

| File:line | Coupling | Class |
|---|---|---|
| `platform/ingest/index.js:20` | `const projectRoot = path.join(brainRoot, 'projects/internship-portal')` | STRUCTURAL |
| `platform/ingest/index.js:19` | `const brainRoot = path.join(repoRoot, 'ai-brain')` (Brain lives inside the engine repo) | FOUNDATIONAL |
| `platform/exam/run.js:381` | same projectRoot literal, inside `runExamById` | STRUCTURAL |
| `platform/exam/gym.js:36` | same literal | STRUCTURAL |
| `platform/exam/gym.js:578` | `project: 'internship-portal'` passed to `retrieve` | TRIVIAL |
| `platform/exam/gym.js:610-613`, `gym.js:699` | monitoring paths and git-status allowlist keyed on the literal path | STRUCTURAL |
| `platform/exam/monitoring-paths.js:2-3` | dashboard and scorecard output paths | TRIVIAL |
| `platform/exam/verify.js:21` | exams root | STRUCTURAL |
| `platform/exam/verify.js:175` | SQL `WHERE project = 'internship-portal'` | TRIVIAL |
| `platform/rag/retrieval-score.js:31` | `const PROJECT = 'internship-portal'` | TRIVIAL |
| `platform/rag/content-survival.js:32` | same | TRIVIAL |
| `platform/rag/verify.js:11` | same | TRIVIAL |
| `platform/exam/grade.js:25`, `grade.js:183` | projectRoot plus a literal `project: "internship-portal"` inside the generated evaluation front matter | STRUCTURAL |
| `platform/exam/scorecard.js:14`, `scorecard.js:1049` | same pattern | STRUCTURAL |
| `platform/exam/failure-taxonomy.js:12,100` | same pattern | STRUCTURAL |
| `platform/exam/apply-proposals.js:16,52,80` | harvest write-back path and front matter | STRUCTURAL |
| `platform/exam/dashboard.js:13,16` | dashboard output | TRIVIAL |
| `platform/exam/harvest-export.js:184`, `harvest-gym.js:241` | retrieval calls | TRIVIAL |
| `platform/exam/teacher-offline.js:34`, `harvest-offline.js:36` | rubric and answer roots | STRUCTURAL |
| `platform/export/markdown.js:236` | emits `['project', 'internship-portal']` into every exported unit's front matter | STRUCTURAL |
| `platform/export/source-map.js:1` | `const projectRoot = 'ai-brain/projects/internship-portal'` and a hand-written table of source-file to Brain-unit mappings | FOUNDATIONAL |
| `platform/export/transcripts.js:142` | drafts target path | TRIVIAL |
| `platform/mcp/server.js:15-16` | `repoRoot` and `brainRoot` are computed from the module's own location, so the Brain is always a sibling of the code | FOUNDATIONAL |

(All VERIFIED by `grep -rn "internship-portal" platform scripts --include="*.js" --include="*.sql" --exclude-dir=sources`
and by reading each cited file.)

The FOUNDATIONAL entry is not the literal. It is that **the Brain corpus, the engine code, and the
git repository that gets committed to are one and the same directory tree**. `platform/mcp/server.js:15`
resolves `repoRoot` from `import.meta.url`; `platform/ingest/index.js:18-20` does the same;
`platform/rag/retrieve.js:15` does the same and then reads
`platform/rag/curated-retrieval-fixes.json` from it (`retrieve.js:28`). An installed tool must
separate three roots that are currently one: the installed engine, the user's Brain data, and the
user's target repository.

### 1b. This machine and this owner

| File:line | Coupling | Class |
|---|---|---|
| `platform/exam/scheduler.js:22` | `com.mohamedfuad.ai-brain-gym.${mode}` launchd label | TRIVIAL |
| `platform/exam/scheduler.js:56-58` | `~/Library/LaunchAgents`, `launchctl disable/bootout/print-disabled`, `gui/${uid}` domain | STRUCTURAL (macOS only) |
| `platform/exam/provider-service.js:14` | `com.mohamedfuad.ai-brain-provider-router` launchd label | TRIVIAL |
| `platform/exam/deploy-dashboard.js:2,28` | `https://brain.mohamedfuad.com` publish target | TRIVIAL (should be removed from v1) |
| `platform/exam/gym.js:702, 748` | `git push origin main` inside the gym cycle | FOUNDATIONAL |
| `platform/exam/gym.js:307-311` | gym `git add`, `git commit` into the platform repo as part of a run | FOUNDATIONAL |
| `agent/setup.md:117-123` | Homebrew `postgresql@17`, `pgvector`, `ollama`, keg path `/opt/homebrew/opt/postgresql@17/bin` | STRUCTURAL |
| `platform/exam/gates.js:9` | gate env allowlist includes `DEVELOPER_DIR` (Xcode) | TRIVIAL |
| `platform/exam/gates/swiftlint-gate.js:41-55` | `discoverDeveloperDir` scans `/Applications/Xcode*.app` | STRUCTURAL |
| `platform/export/inputs.js:4` | `SOURCE_REPO_PATH=/absolute/path/to/resume-studio-dashboard` in an error string | TRIVIAL |

Good news, VERIFIED by grep: there are **zero `/Users/` absolute paths** in production source. The
only match is `platform/exam/dashboard.js:362`, which is a redaction regex that rewrites `/Users/<x>`
to `/Users/<user>` before publishing. There are **zero `psql` shell-outs**; all database access goes
through the `pg` npm client. Both of these are better than the brief anticipated.

`git push origin main` at `gym.js:702` and `gym.js:748` is FOUNDATIONAL, not trivial: the gym's
definition of a completed cycle includes publishing to a remote. A stranger's install cannot push to
the maintainer's remote and probably should not push at all. The commit-and-push behaviour has to
become an explicit, off-by-default policy.

### 1c. Two surfaces, web and ios, as a closed enum

| File:line | Coupling | Class |
|---|---|---|
| `platform/exam/exams.js:20` | `if (!['web', 'ios'].includes(exam.surface)) throw` | STRUCTURAL |
| `platform/exam/gym.js:83` | cohort selection alternates `desired = desired === 'web' ? 'ios' : 'web'` | STRUCTURAL |
| `platform/exam/gates.js:79-81` | availability probe chooses `swiftlint version` or `xcodebuild -version` when `surface === 'ios'` | STRUCTURAL |
| `platform/exam/verify.js:63-64, 85, 138` | per-surface counting; requires `editor/package.json` for web and `ios/project.yml` for ios | STRUCTURAL |
| `platform/export/setup-sources.js:54`, `examples.js:130`, `inputs.js:28` | iterate literal `['web','ios']` worktrees | STRUCTURAL |
| `platform/export/markdown.js:205` | area default depends on `surface === 'ios'` | TRIVIAL |
| `ai-brain/projects/internship-portal/project.yaml:10-30` | the gate table itself is keyed by surface | STRUCTURAL, but see section 4 |

For a React/web validation target this is mostly dead weight rather than a blocker: a single-surface
repo can declare one surface. But `gym.js:83` will produce a degenerate rotation and
`exams.js:20` will reject any surface name that is not literally `web` or `ios`.

### 1d. Module-path grammar baked into query rewriting

`platform/rag/query.js:1` is a regex that recognises exactly this repository's file shapes:

- `editor/src/...`, `editor/server/...` with extensions js/jsx/ts/tsx/css
- `InternshipPortal/...` and any `*.swift`
- a `mod:` namespace prefix

`query.js:16-26` (`normalizeModulePath`) and `query.js:44-49` (`displayModulePath`) then translate
between `editor/src/x` and `mod:web/src/x`, and between `InternshipPortal/x` and `mod:ios/x`.
`platform/ingest/relationships.js:12-33` writes those same prefixes when it builds the import graph
from `web-client-imports.json`, `web-server-imports.json`, `web-source-dependencies.json`, and
`ios-imports.json`.

Class: **STRUCTURAL**. The `mod:` namespace idea is sound and reusable; the specific directory names
are not. This needs a per-repo path-namespace config (roots, extensions, display mapping) that both
the graph builder and the query rewriter read from one place. (VERIFIED, all three files read.)

### 1e. Document type vocabulary and the `global.` standing namespace

`platform/rag/retrieve.js:16` fixes `ALLOWED_TYPES` to eight strings; `platform/ingest/chunk.js:1-2`
splits the same eight into atomic and windowed sets; `platform/mcp/tools.js:5` repeats them in a Zod
enum; `platform/ingest/documents.js:8` requires front-matter fields
`id, type, project, area, tags, supersedes, source`. `platform/rag/standing.js:29` treats the id
prefix `global.` as the contract for always-present procedural memory.

Class: **STRUCTURAL but low risk**. This vocabulary is genuinely generic (decision, lesson, exemplar,
convention, principle, evaluation, architecture, workflow). It is a coupling to *the Brain schema*,
not to internship-portal. Shipping it as the product's schema is defensible. What must change: the
duplication across four files should collapse to one exported constant.

### 1f. Model, provider, and embedding identity

| File:line | Coupling | Class |
|---|---|---|
| `platform/ingest/embed.js:1` | error string names `localhost:11434` and `brew services start ollama` | TRIVIAL |
| `platform/ingest/embed.js:24` | Ollama base URL default `http://localhost:11434` | TRIVIAL |
| `platform/ingest/embed.js:126-129` | provider switch over `ollama`, `openai`, `voyage` | already parameterized |
| `platform/ingest/embed.js:145-152` | `resolveServedIdentity` refuses a digest drift for Ollama | keep |
| `platform/db/migrations/001-initial-schema.sql:35` | `embedding vector(${EMBEDDING_DIM})` (templated, not literal) | already parameterized |
| `platform/db/migrations/015-hnsw-tuned-index.sql:19-21` | HNSW `m = 16, ef_construction = 200` chosen for 1024 dimensions | TRIVIAL |
| `platform/config/models.example.env` | 60+ env knobs, no values committed | fine |

No model name (`bge-m3`, `glm-5.2`, `gpt-5.6`) is hardcoded in production source; they live in
`.env.local` and `project.yaml`. VERIFIED by reading `platform/config/models.example.env` in full and
`grep -o '^[A-Z_]*=' .env.local`. This is the cleanest area of the codebase.

### 1g. Gate and toolchain assumptions

Deferred to section 4, where they belong.

### 1h. The `agent/` folder layout

`platform/export/source-map.js` encodes a hand-written table mapping specific source files in the
target repo (`agent/web/conventions.md` and friends) to specific Brain unit ids
(`global.convention.conventions`, `global.principle.engineering-principles`, ...). This is not a
convention that a stranger's repo will satisfy.

Class: **FOUNDATIONAL for the export pipeline specifically**. My recommendation: do not ship the
Phase-1 exporter in v1 at all. See section 2.

---

## 2. Portable core

Verdict up front: **the retrieval engine is portable; the exam gym is portable in shape but not in
content; the export pipeline is not portable and should be cut from v1.**

### 2a. Ships nearly as-is

**`platform/ingest/chunk.js` (103 lines). Portability: very high.**
Pure functions, zero imports beyond the language. Type-aware chunking, heading breadcrumbs, 700-token
windows with 80 overlap (`chunk.js:39`), the identity-chunk beacon at ordinal -1 (`chunk.js:13, 69-78`).
Import surface: `tokens`, `identityChunk`, `chunkDocument`, `chunkPolicy`, `IDENTITY_ORDINAL`.
Config to inject: the atomic and windowed type sets (`chunk.js:1-2`) and the window size and overlap
(`chunk.js:39`), which are currently literals in a default parameter. Nothing else.

**`platform/rag/rank.js` (367 lines). Portability: high.**
Pure. Imports only `tokens` from chunk.js and `queryTokens` from query.js (`rank.js:1-2`). This is
the most valuable single artifact in the repository: the reserved-semantic slot allocation
(`rank.js:322-352`, ADR-0158), the per-candidate cap ratio 0.22 (`rank.js:152-163`, ADR-0156), the
supersession-component resolution (`rank.js:77-100`), and the pin-relevance rule requiring
`overlap >= 3` (`rank.js:245`) are each the surviving end of a measured experiment, documented in
place with the counterexample that produced them.
Import surface: `rankRetrieval`, `semanticByDocument`, `supersessionComponent`,
`DEFAULT_SEMANTIC_THRESHOLD`, `DEFAULT_STRUCTURAL_PIN_FLOOR`.
Config to inject: it is already almost entirely parameterized through the `rankRetrieval` options
object. The one hard-coded piece is the bucket vocabulary and structural priority table at
`rank.js:108-109` (`{ decision: 'decisions', lesson: 'lessons', exemplar: 'exemplars' }` and
`{ decisions: 0.5, lessons: 0.35, chunks: 0.75, exemplars: 0 }`). Those numbers are tuned and should
travel with the code, not become user config.

**`fuseRankings` in `platform/rag/retrieve.js:137-170`. Portability: total.**
Pure, no I/O, `RRF_K = 60` (`retrieve.js:119`). The rescale trick (assign the row in fused position i
the i-th largest cosine value so downstream absolute thresholds keep working, `retrieve.js:162-169`)
is the reason RRF composes with the pin floor at all. **This function should be lifted into its own
module** as the first refactor: it is currently trapped in a file that also opens a Postgres client.

**`platform/rag/context.js` (50 lines). Portability: total.** Pure XML-escaping context formatter.
`formatContext(result)` is the only export used.

**`platform/rag/query.js` (81 lines). Portability: medium.**
`queryTokens` (lines 8-14) and `reverseImpact` (lines 51-81) are generic. `PATH_PATTERN` (line 1),
`normalizeModulePath` (16-26), and `displayModulePath` (44-49) are internship-portal grammar.
Splitting this file into `tokens.js` (portable) and `paths.js` (config-driven) is a half-day.

**`platform/rag/standing.js` (59 lines). Portability: high.** One SQL query keyed on an id prefix.
Storage-abstracted trivially.

**`platform/ingest/embed.js` (154 lines). Portability: high.**
Already a three-provider abstraction (`embed.js:126-129`). The alignment and dimension assertions
(`embed.js:51-64`) are hard-won safety and must survive any port; the comment at `embed.js:44-50`
records exactly the silent-corruption failure they prevent. Adding a fourth provider (a local ONNX
embedder) means one more branch in the same switch.

**`platform/mcp/*` (529 lines total). Portability: high.**
`server.js`, `tools.js`, `resources.js`, `prompts.js`, `evaluation.js`. Uses the official
`@modelcontextprotocol/sdk` over stdio (`server.js:5, 33`). Five tools registered at
`tools.js:22, 37, 50, 72, 80`. The only couplings: `server.js:15-16` computes `brainRoot` from the
module's own path, and `resources.js:11` skips a directory literally named `exams`. Both are
one-line changes to accept an injected root.

**`platform/exam/gates.js` (183 lines). Portability: high, and better designed than expected.**
Gate commands are **not** hardcoded in the harness. `gateCommands` (line 60) reads
`project.gates[surface]` from YAML and expands `{{platformRoot}}`, `{{node}}`, `{{sandbox}}`
(lines 68-71). `parseGateMetric` (115-119) and `classifyGateResults` (159-183) are pure. This file is
close to being the gate-discovery engine already; see section 4.

**`platform/exam/sandbox.js` (122 lines). Portability: high.**
Git worktree lifecycle plus diff validation. One coupling: `sandbox.js:28`,
`git clean -fd -e editor/node_modules`, hardcodes this repo's node_modules location. That must become
a configured preserve-list.

**`platform/exam/exam-scope.js` (24 lines) and `task-detail.js` (53 lines).** Pure, portable.

Total portable-core surface: roughly **2,600 lines of non-test JavaScript**, plus their tests.
(INFERRED from the per-file counts above.)

### 2b. Inherently project-bound

**`platform/export/` (1,896 non-test lines excluding the vendored source worktrees).**
`source-map.js` is a hand-authored table of this repository's documentation files. `graph.js` runs
madge over `platform/export/sources/{web,ios}` (`graph.js:15-18`), which are pinned read-only
worktrees of the owner's app repo. `examples.js`, `transcripts.js`, `snapshot.js`, and
`verify-export.js` all serve that pipeline. **Recommendation: do not port. Replace.** The product
question ("where does a stranger's Brain content come from?") is a different question from the one
this pipeline answers ("how do I mirror my own agent/ folder deterministically?").

**`platform/exam/` experiment and launcher scripts.** 21,569 non-test lines total; 15,896 excluding
files matching `*experiment*`, `*launcher*`, `*probe*`. That leftover 5,700 lines is a campaign
archive: `model-53-experiment.js`, `split-budget-experiment.js`, `echo-window-experiment.js`,
`seal-policy-experiment.js`, and their detached launchers. None of it belongs in a shipped product.

**`platform/exam/provider-router.js`, `provider-service.js`, `zai-*.js`, `teacher-rate-limit.js`.**
A loopback HTTP router installed as a launchd KeepAlive agent on `127.0.0.1:43157`, enforcing exact
served-model identity and a shared secret. This is a solution to the owner's specific
multi-provider billing situation. A product should call providers directly and keep the exact-model
attestation idea, not the daemon.

**`platform/exam/gym.js` (1,153 lines).** The orchestration shape is right; the implementation
commits and pushes to git as part of a cycle (`gym.js:307-311, 702, 748`) and hardcodes monitoring
paths (`gym.js:610-613, 699`). Rewrite rather than port.

**`platform/exam/scorecard.js` (1,049+ lines), `dashboard.js`, `deploy-dashboard.js`.** Bound to this
project's graduation thresholds and to a Vercel domain. The scorecard's *metric definitions* (cohort
rate versus graded-attempt rate, the honesty about denominators at `scorecard.js:1049`) are worth
keeping as a spec. The code is not.

**`platform/exam/engineer.js` (1,970 lines).** Genuinely portable in principle: the tool surface is
`list_files`, `read_file`, `search_files`, `edit_file`, `create_file`, `brain_search`,
`submit_solution` (`engineer.js:733-781`) plus `check_build` (`engineer.js:792`), search backed by
the bundled `@vscode/ripgrep` (`engineer.js:6, 644`) so no global `rg` is needed. But it is deeply
entangled with the token-cap, echo-window, tool-window, aging-phase, and seal-policy knobs that came
out of the experiment campaign. This is the file that most needs a deliberate rewrite-versus-port
decision.

---

## 3. Dependency surface

### 3a. What a user must have running today

VERIFIED from `agent/setup.md:5-12, 115-135`, `package.json:engines`, and the live database:

| Dependency | Version in use | How it is required |
|---|---|---|
| Node.js | `>=20.18.1` (`package.json` engines) | ESM, `node --test` |
| PostgreSQL | 17.10 Homebrew (`SELECT version()`) | `pg` npm client, no psql shell-out |
| pgvector | 0.8.5 (`SELECT extname, extversion FROM pg_extension`) | `CREATE EXTENSION vector`, `vector(1024)` |
| Ollama | 0.32.1 per setup.md:122 | `bge-m3`, 1024-dim, digest-pinned |
| git | any recent | worktrees, `diff-tree`, `apply` |
| ripgrep | bundled `@vscode/ripgrep@1.18.0` | no global install needed |
| madge | dev dependency, pinned | export pipeline only |
| Xcode / SwiftLint / xcodegen | optional | iOS gates only |
| D2 | optional | diagram rendering only |

### 3b. What the code actually touches in Postgres and pgvector

This is the honest enumeration the brief asked for. Everything here is VERIFIED by reading the
migrations and the query sites.

**pgvector features used:**

1. `CREATE EXTENSION vector` (`001-initial-schema.sql:1`).
2. Column type `vector(1024)` (`001:35`, dimension templated from `EMBEDDING_DIM`).
3. HNSW index with `vector_cosine_ops` and explicit build parameters `m = 16, ef_construction = 200`
   (`015-hnsw-tuned-index.sql:19-21`).
4. Cosine distance operator `<=>` in both `ORDER BY` and the projection
   `1 - (c.embedding <=> $1::vector) AS score` (`retrieve.js:191, 195, 212, 216, 232, 251, 257`).
5. Query-time session GUCs: `SET hnsw.ef_search = <n>` and `SET hnsw.iterative_scan = 'relaxed_order'`
   (`retrieve.js:183-184`). The `iterative_scan` setting is pgvector 0.8-specific and exists to stop
   post-scan filter starvation.
6. Cast from a JSON array string to vector: `$1::vector` with `JSON.stringify(vector)` as the bind
   value (`retrieve.js:197`, `ingest/index.js:70`).

Note what is **not** used: no `halfvec`, no `sparsevec`, no `bit` quantization, no IVFFlat, no
binary quantization, no `vector_ip_ops` or `vector_l2_ops`. The pgvector surface is narrow.

**Postgres features used beyond vectors:**

1. Full-text search: a `GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` column plus a
   GIN index (`011-chunk-lexical-index.sql:17-21`). The generated-column choice is deliberate and
   documented at `011:14-16`.
2. `websearch_to_tsquery('english', $2)` used as a FROM-clause item, joined against `content_tsv @@ query`,
   ranked by `ts_rank(c.content_tsv, query)` (`retrieve.js:233-239`).
3. `jsonb` throughout: `meta jsonb` on document, exam, exam_run, gym_run; `->>` extraction for
   `d.meta->>'area'` and `coalesce(d.meta->>'draft','false')` (`retrieve.js:93, 100`); and
   `jsonb_typeof(d.meta->'retrieval_provenance') = 'array'` with
   `jsonb_array_length(...) > 0` (`retrieve.js:255-256`).
4. `text[]` array columns with `= ANY($n::text[])` and `<> ALL($n::text[])` filters
   (`retrieve.js:96, 104, 108`; `standing.js:38`).
5. Transactions: explicit `BEGIN` at `ingest/index.js:198`, `db/migrate.js:142`, `db/verify.js:214`,
   `exam/grade.js:326`, `exam/harvest.js:362`, `exam/mark-debug-runs.js:100`. The ingest one is the
   important one: a full rebuild replaces the entire mirror atomically (`data.md:44`).
6. `ON CONFLICT ... DO UPDATE` upserts (7 sites), `RETURNING` (3 sites),
   `bigserial` identity columns, `CHECK` constraints on enum-like text columns
   (`001:47, 70`; `002-exam-run-mode.sql`), foreign keys with `ON DELETE CASCADE` (`001:32`),
   composite primary keys (`001:46`), partial and unique indexes (migration 003).
7. Correlated scalar subquery in the projection for the identity-chunk substitution:
   `CASE WHEN c.ordinal = -1 THEN (SELECT c0.content ...) ELSE c.content END` (`retrieve.js:188-190`).
8. `pg_size_pretty`, `pg_total_relation_size` in verification only.
9. Checksummed, immutable migration ledger (`schema_migration` table, `001:3-8`).

**Application-level lock, not a database lock:** the single-writer guard is a PID file at
`logs/.gym.lock` (`data.md:82-83`, `ingest/runtime.js` `acquireWriterLock`), **not** a Postgres
advisory lock. I grepped for `pg_advisory` and found none. This matters: it means the concurrency
model does not depend on the database at all, which makes a storage swap easier than it looks.

### 3c. Realistic alternatives, judged against that actual usage

**Option A: keep Postgres plus pgvector, require it.**
- Cost to the user: install Postgres 17, install pgvector, create a database. On macOS that is two
  `brew` commands; on Linux it is a package plus a compile-or-package for pgvector; on Windows it is
  painful.
- Cost to the engine: zero. Nothing to re-validate.
- Verdict: correct for a v1 aimed at engineers who already run databases. Wrong for `curl | sh`.

**Option B: SQLite plus sqlite-vec plus FTS5.**
- What maps cleanly: `vector(N)` becomes a sqlite-vec virtual table with cosine distance;
  `to_tsvector`/`websearch_to_tsquery`/`ts_rank` becomes an FTS5 external-content table with `bm25()`;
  transactions map directly; `text[]` becomes a JSON array; `jsonb` becomes SQLite `json_extract`.
- What does **not** map: sqlite-vec has no HNSW. It does brute-force scan (and a partitioned/IVF
  mode in recent versions). At 732 chunks that is a non-issue; the migration comment at
  `015-hnsw-tuned-index.sql:5-6` records that Postgres itself currently seq-scans this corpus in 8 ms
  with exact recall. At 50,000 chunks on a big monorepo it becomes a real question. (INFERRED.)
- What must be re-validated: **everything downstream of the lexical arm**. `ts_rank` and `bm25()` are
  different scoring functions producing different orders. RRF consumes only *ranks*
  (`retrieve.js:137-154`), which is exactly the property that makes this swap survivable, but the
  fused order will still change, so `caseRate` (floor 0.9117647, `retrieval-baseline.json:2`) and
  `violations` (floor 0) must be re-measured. The rescale at `retrieve.js:162-169` preserves the
  cosine distribution, so `DEFAULT_SEMANTIC_THRESHOLD = 0.35` and
  `DEFAULT_STRUCTURAL_PIN_FLOOR = 0.35` (`rank.js:4-5`) do not need recalibration as long as the
  embedder is unchanged. The `content-survival` instrument (`platform/rag/content-survival.js`) does
  not touch the lexical arm and should be unaffected.
- Also to re-validate: the English stemming argument in `011-chunk-lexical-index.sql:8-12` (that
  `statusPinned` and `STATUS_RANK` stem symmetrically, and CJK is kept whole). FTS5's default
  `unicode61` tokenizer does **not** stem at all and does **not** split camelCase; the `trigram`
  tokenizer behaves differently again. The identifier-query behaviour that motivated the lexical arm
  in the first place has to be re-measured on the five identifier cases named at `011:4-5`.
- Verdict: **this is the right target for an installable tool**, with the caveats above priced in.

**Option C: LanceDB.**
- Gives vectors and full-text in one embedded store, no server. But it replaces the *whole* data
  layer including the relational model (documents, chunks, relationships, exams, exam_runs, gym_runs,
  migrations). Sixteen migrations of accumulated schema and constraints (`platform/db/migrations/001`
  through `016`) do not port to a document store without inventing the integrity rules again.
- Verdict: **reject for v1.** It solves the vector problem and creates a relational one.

**Option D: bundled containers.**
- Ships Postgres and Ollama in Docker. Zero code change, zero re-validation.
- Cost: the user needs Docker, cold start pulls gigabytes, and a TUI now supervises containers.
- Verdict: viable as an *escape hatch* (`dijin doctor --docker`), not as the default.

**Option E: ONNX embedder in place of Ollama.**
- `bge-m3` is 568M parameters, 1024 dimensions. An ONNX-quantized bge-m3 or a smaller model
  (bge-small-en-v1.5 at 384 dims, all-MiniLM-L6-v2 at 384 dims) can run in-process via
  `onnxruntime-node` or `transformers.js`, removing the Ollama daemon entirely.
- What must be re-validated: **all of it.** Changing the embedder changes every cosine number.
  `DEFAULT_SEMANTIC_THRESHOLD` 0.35, `DEFAULT_STRUCTURAL_PIN_FLOOR` 0.35 (`rank.js:4-5`), the
  reserved-semantic floor 0.55 (`rank.js:209, 323`), the `max-support` supportFloor 0.3
  (`rank.js:65`), and the gold-set floors all sit on bge-m3's similarity distribution. The migration
  path already exists in code: `assertIndexCompatible` (`ingest/index.js:22-32`) and
  `assertRetrievalIdentity` (`retrieve.js:82-87`) refuse to serve a mismatched index, and
  `EMBEDDING_DIM` is templated into migration 001, so a different dimension is a config change rather
  than a schema edit (`data.md:41-43`).
- Verdict: **do this second, not first.** Swap storage while holding the embedder fixed, measure;
  then swap the embedder while holding storage fixed, measure.

### 3d. Recommendation

Ship **Option B (SQLite plus sqlite-vec plus FTS5) as the default store, with Option A (Postgres plus
pgvector) retained as a supported backend behind the same interface**, and keep Ollama as the default
embedder for v1 with Option E as the v1.1 target.

Rationale: the storage layer is already narrower than it looks (no advisory locks, no psql shell-outs,
no exotic pgvector types, one generated column, one tsquery function), and the two backends can be
validated against each other on the same corpus with the same embedder, which turns "did the swap
break retrieval?" into a controlled experiment rather than a hope.

The seam to build: a `Store` interface with roughly these operations, derived from the actual call
sites in `retrieve.js:172-283`, `standing.js:32`, and `ingest/index.js:36-110`:
`semanticCandidates(vector, filters, limit)`, `lexicalCandidates(queryText, filters, limit)`,
`architectureCandidates(vector, filters)`, `provenanceCandidates(vector, filters)`,
`allDocuments(filters)`, `relationships(kinds)`, `standingUnits(prefix, exclusions)`,
`upsertDocument`, `replaceChunks`, `replaceRelationships`, `transaction(fn)`, `migrate()`.
Fusion, ranking, budgeting, and context formatting all sit above that line and never change.

---

## 4. Gym portability

### 4a. Which gates are hardcoded, and which are not

**The good news, VERIFIED: the gate commands are already data, not code.**
`platform/exam/gates.js:60-62` reads `project.gates[surface]` from `project.yaml` and throws if the
surface has none. The current values, from `ai-brain/projects/internship-portal/project.yaml:10-30`:

```
web:
  cd editor && npm ci && npm run build
  {{node}} {{platformRoot}}/platform/exam/gates/eslint-gate.js --repo {{sandbox}}
  cd editor && npx playwright test
  {{node}} {{platformRoot}}/platform/exam/gates/react-doctor-gate.js --repo {{sandbox}}
ios:
  cd ios && xcodegen generate && xcodebuild -project InternshipPortal.xcodeproj -scheme InternshipPortal -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""
  {{node}} {{platformRoot}}/platform/exam/gates/swiftlint-gate.js --repo {{sandbox}}
contracts:
  node platform/exam/gates/contracts-conform.js
```

Placeholders `{{platformRoot}}`, `{{node}}`, `{{sandbox}}` are expanded at `gates.js:68-71`. The
comment at `gates.js:64-67` states the reason precisely: a sandbox sits at an old base commit, so a
gate that depends on the repository's *current* config cannot run there, and substituting the
platform root lets a gate bring its own tooling.

What **is** hardcoded in the harness:

- A `[CONTRACTS] conformance` gate is appended unconditionally to every surface
  (`gates.js:83-90`), running `platform/exam/gates/contracts-conform.js`. That is an
  internship-portal-specific check (web and iOS client contracts must match) welded into the generic
  path. **STRUCTURAL.** It must become just another discovered gate.
- The availability probe for iOS: `swiftlint version` or `xcodebuild -version` chosen by regex on the
  command (`gates.js:79-81`). **STRUCTURAL**, but the *pattern* (each gate declares how to prove it
  can run) is exactly right and should generalize.
- Build-gate detection: `buildGateCommand` (`gates.js:101-104`) matches
  `/\bxcodebuild\b[\s\S]*\bbuild\b/` or `/\bnpm run build\b/`. The engineer's `check_build` tool
  points at whatever this returns, or is not offered at all if it returns null. **STRUCTURAL.** For
  arbitrary repos this must become a declared role on the gate (`role: build`) rather than a regex.
- `sandbox.js:28`: `git clean -fd -e editor/node_modules`. **TRIVIAL but load-bearing**; forget it and
  every gate re-runs `npm ci` from scratch.
- `platform/exam/verify.js:138`: web exams require `editor/package.json`, iOS exams require
  `ios/project.yml`. **STRUCTURAL.**

The three wrapper gates in `platform/exam/gates/` also carry repo-shaped defaults:
`eslint-gate.js:22` defaults its target to `editor/src`; `react-doctor-gate.js:27` defaults to
`editor`. Both accept a `--dir` override, so they are TRIVIAL to reuse.

### 4b. Baseline versus candidate classification, and dead gates

**VERIFIED mechanism**, from `run.js:179-186, 280-294` and `gates.js:159-183`:

1. Create a worktree at the exam's base commit (`run.js:175`).
2. Run the full gate set. This is the **baseline** (`run.js:180-184`).
3. `sandbox.restore()` (`run.js:186`), which is `git reset --hard <base>` plus `git clean`
   (`sandbox.js:27-29`).
4. Retrieve, run the engineer, restore again, apply the engineer's diff (`run.js:280-281`).
5. Run the same gate set. This is the **candidate** (`run.js:288-292`).
6. `classifyGateResults(baseline, candidate)` (`run.js:293`).

Classification, `gates.js:159-183`, in precedence order:

- If either side is `unavailable`, classification is `unavailable` (`gates.js:163-165`).
- If both sides emitted a parseable `GATE_METRIC` line with the same direction, classification is
  `pass` or `regressed` by comparing the two numbers (`gates.js:121-132`).
- Otherwise: candidate passed becomes `pass`; candidate failed and baseline passed becomes
  `regressed`; candidate failed and baseline also failed becomes **`pre-broken`** (`gates.js:176-181`).

**So a dead gate is detected today, and it is called `pre-broken`.** The insight the project already
paid for, recorded at `gates.js:108-114` and in the `project.yaml:17-27` comment, is that
`pre-broken` is *honest but useless*: a gate that fails on baseline and candidate alike carries no
signal, and an engineer could add a tenth dead import without anything noticing. The response was to
convert those gates to measured gates.

**The `GATE_METRIC` convention.** Defined and parsed at `gates.js:115-119`:

```
GATE_METRIC:<lower-better|higher-better>:<number>
```

Regex: `/GATE_METRIC:(lower-better|higher-better):(-?\d+(?:\.\d+)?)/` applied to the gate's stdout.
Emitters: `eslint-gate.js:46` (`GATE_METRIC:lower-better:<violations>`),
`react-doctor-gate.js:39` (`GATE_METRIC:higher-better:<score>`), and `swiftlint-gate.js` (violation
count, lower-better). The wrapper scripts exit 0 on a successful measurement; the verdict belongs to
the comparison, not to the run (`eslint-gate.js:8-10`).

There is one more classification refinement worth carrying forward: `run.js:302-309` splits a
regression on a *measured* gate (every raw command passed, only a counted metric moved the wrong way)
into status `metric-regressed`, distinct from `gates-regressed`, so a summary line cannot read a
two-lint-violation delta as a compile failure.

### 4c. Sandbox requirements of the host repo

VERIFIED from `sandbox.js` and `run.js`:

- `git worktree add --detach --force <dir> <baseCommit>` run in the source repo (`sandbox.js:22`).
  Requires: a real git repository, a resolvable base commit, and worktree support (git 2.5+).
- Cleanup: `git worktree remove --force`, `rm -rf`, `git worktree prune`, each tolerant of failure
  (`sandbox.js:33-35`).
- Between phases: `git reset --hard <base>` and `git clean -fd -e editor/node_modules`
  (`sandbox.js:27-28`).
- Leak protection: the sandboxes root must be empty *before* a run starts (`run.js:172`, throwing at
  `sandbox.js:43`), and after cleanup only the run's **own** directory must be gone
  (`sandbox.js:50-57`). Foreign leftovers are reported, not thrown (`sandbox.js:61-65`), with the
  reason at `sandbox.js:47-49`: asserting the whole root let an unrelated crashed run discard a
  result that had already been paid for.
- The source repo itself is never mutated. The gym does `git -C <sourceRepo> rev-parse --is-inside-work-tree`
  as a preflight (`gym.js:244`). It does **not** require the source working tree to be clean, because
  it operates on a detached worktree. (INFERRED from the absence of any such check.)
- Diff application: `git apply --check --recount --whitespace=error-all`, then the same without
  `--check` (`sandbox.js:115-117`), preceded by a path allowlist that rejects absolute paths, `..`,
  `.git`, and anything matching `^\.env(\.|$)` (`sandbox.js:73-77`).
- Final diff derivation: `git add --intent-to-add` for created paths, then
  `git diff --binary --no-ext-diff` (`run.js:66-78`).
- Gold diff at grade time: `git diff --binary --no-ext-diff <base> <gold>` in the source repo
  (`grade.js:79-80`).

### 4d. TEACHER.md and the packet round-trip

VERIFIED from `TEACHER.md` and `grade-export.js`:

- `TEACHER.md` is a 431-line human runbook assigning three roles: **student** (writes diffs),
  **teacher** (grades, never writes project code), **auditor** (re-derives verdicts, sets no grades).
  Stated at `TEACHER.md:5-16`.
- The packet round-trip exists because the teacher model is used through a chat window rather than an
  API (`grade-export.js:3-5`). `grade:export` writes one self-contained Markdown file per exam into
  `<root>/teacher-inbox/` containing: task, submitted diff, reference diff, gate results with their
  classifications, retrieved Brain ids, and the list of files the teacher may cite
  (`grade-export.js:38-84`).
- **Identity binding is the load-bearing part.** Each packet states the exact filename the answer must
  be saved as, and that filename contains a **submission digest**; a rubric carrying the wrong digest
  is rejected on import (`grade-export.js:9-14`, `grade-export.js:41-46`). Digests come from
  `teacher-offline.js` (`taskDigest`, `submissionDigest`, `rubricPath`).
- Gates are explicitly marked informational to the teacher, with the three classifications explained
  in the packet itself (`grade-export.js:73-75`).
- Blindness: the teacher sees the gold diff. It does **not** see which model produced the submission
  beyond the bundle preamble naming the student. Grading is blind to *cycle history*, not to the
  reference. (INFERRED from `packetMarkdown`'s field list.)
- Grade binding: `goldCommitBinding` (`grade.js:50-56`) throws if the exam was re-golded between run
  and grade, and `goldDiff` recomputes the reference live (`grade.js:79-80, 266`).

Portability verdict: the packet format is generic. The couplings are the output directory
(`grade-export.js:26`, `teacher-inbox` inside the repo), the rubric root
(`teacher-offline.js:34`, under `ai-brain/projects/internship-portal/`), and the fact that
`TEACHER.md` names GLM-5.2 and GPT-5.6 explicitly (`TEACHER.md:9, 305-ish`). All TRIVIAL to
parameterize; the *document* needs rewriting for a stranger, which is a writing task rather than an
engineering one.

### 4e. Gate discovery: what it would look like

This is the part that does not exist today. Sketch, grounded in what `gates.js` already provides.

**Phase 1: probe.** Read, in order of confidence:

1. `package.json` `scripts`. Classify by name and by the command body:
   - `test`, `test:unit`, `test:ci` becomes role `test`
   - `build`, `compile` becomes role `build` (this is what `buildGateCommand` needs, declared rather
     than regex-matched)
   - `lint`, `lint:*`, `eslint` becomes role `lint`
   - `typecheck`, `tsc`, `types` becomes role `typecheck`
   - `e2e`, `playwright`, `cypress` becomes role `e2e`
2. CI configs: `.github/workflows/*.yml` job steps, `.gitlab-ci.yml`, `Makefile` targets. These
   reveal the commands the repository's own maintainers trust.
3. Tool config presence: `tsconfig.json` implies `tsc --noEmit` is meaningful; `eslint.config.*` or
   `.eslintrc*` implies eslint; `pyproject.toml` implies ruff or pytest; `Cargo.toml` implies
   `cargo test` and `cargo clippy`.
4. Lockfile determines the install command: `package-lock.json` gives `npm ci`, `pnpm-lock.yaml`
   gives `pnpm i --frozen-lockfile`, `yarn.lock` gives `yarn --immutable`.

Each discovered gate carries: `id`, `command`, `role`, `availabilityCommand`, `cwd`, and a
`metricAdapter` (see phase 3).

**Phase 2: liveness classification on a baseline run.** This is the step the current codebase proves
is essential and does not automate. Run every discovered gate at the repository's HEAD, then again
against a deliberately damaged tree, and classify:

- Passes at HEAD, fails when damaged: **live**. Keep as a pass/fail gate.
- Fails at HEAD: **pre-broken**. Do not keep as pass/fail. Attempt metric conversion (phase 3);
  if that fails, mark `advisory` and exclude it from any verdict.
- Passes at HEAD and passes when damaged: **dead**. Refuse to install it. This is the case
  `project.yaml:17-21` records for the iOS gate that exited 65 at code-signing on both sides and let
  exam-0012 submit Swift with a function body deleted while reporting `completed`.
- Availability probe fails: **unavailable**. Record why, following the pattern at `gates.js:146-148`
  which names the usual cause rather than shrugging.

The "deliberately damaged tree" needs a cheap, honest mutation. Candidates, in increasing fidelity:
delete a random exported function body; introduce a syntax error in one source file; revert one
recent commit. The first is enough to catch a dead compile gate. (INFERRED; this is a design
proposal, not something the codebase does.)

**Phase 3: metric conversion.** For a `pre-broken` gate, wrap it so it emits `GATE_METRIC`. The
existing wrappers show three shapes:

- Count violations from a JSON reporter: `eslint-gate.js:42-46`, `swiftlint-gate.js:59-66`
  (`lower-better`).
- Parse a score out of tolerant text: `react-doctor-gate.js:17-21`, which strips ANSI and matches
  `/(\d{1,3})\s*\/\s*100/` (`higher-better`).
- Count failing test cases from a test runner's JSON output (not present today, obvious addition,
  `lower-better`).

A generic wrapper that takes `--parser json-array-length|regex-capture|junit-failures` plus the
underlying command covers most of the space.

**Phase 4: persist.** Write the surviving gate set into the per-repo config, with each gate's
liveness evidence attached and dated, so `dijin doctor` can re-check it later and so a user can see
why a gate was dropped.

### 4f. What breaks for a repo with no commit history

Precisely, with file:line. "No usable history" means one commit, or a shallow clone, or a fresh
`git init`.

1. **Exam mining returns nothing.** `mineHistory` (`mine.js:82-124`) iterates
   `git log <ref> --no-merges` and skips any commit whose parent count is not exactly 1
   (`mine.js:93-95`). A repository's first commit has zero parents, so it is flagged, never a
   candidate. One commit yields zero exams.
2. **Exam validation rejects any exam you try to write by hand.** `exams.js:25-27` requires both
   `base_commit` and `gold_commit` to be full 40-character SHAs. With one commit there is no valid
   base.
3. **Sandbox creation fails.** `sandbox.js:22` runs `git worktree add --detach <dir> <baseCommit>`.
   No base commit, no sandbox, and the failure is at the very start of `executeExam`
   (`run.js:175`).
4. **Baseline gate run never happens**, so `classifyGateResults` has nothing to compare against and
   every candidate gate would fall through to `baselineStatus: 'not-run'` (`gates.js:164, 181`).
   Every failing gate would classify `pre-broken` (`gates.js:180`), which is the dead-gate condition.
5. **Gold diff derivation fails.** `grade.js:79-80` runs
   `git diff <base> <gold>`; without two commits there is no reference implementation, and
   `compareWithGold` (`compare.js`) has nothing to compare to. Layer-1 grading is gone entirely.
6. **Gold-provenance exclusion cannot run.** `provenance.js:57-59` runs
   `git diff-tree --name-only -r <goldCommit>` to find which source files the gold changed, and
   `provenance.js:64-65` runs `git show <base>:<file>` and `git show <gold>:<file>`. Without those,
   the harness cannot remove the answer from the engineer's retrieval, so any exam derived from the
   repo's own documentation would leak.
7. **Scope tier cannot be computed.** `exam-scope.js:1-6` needs file and insertion counts from the
   gold numstat (`parseGoldNumstat`, lines 8-23), which comes from `git diff-tree --numstat`.
8. **Cohort rotation degenerates.** `selectRotatingTraining` (`gym.js:70-85`) needs a bank of
   non-held-out exams; an empty bank returns an empty selection with no error.
9. **The Brain itself is unaffected.** Ingest, chunking, embedding, retrieval, and MCP need no git
   history at all. Only the gym does.

**Consequence:** for a historyless repo the product can ship retrieval and MCP fully, and must ship
the gym in a degraded mode. See section 5 for what that mode can be.

---

## 5. Exam generation

### 5a. How exams are defined today

**Schema**, VERIFIED from `exams.js:8-75`. Required fields (`exams.js:8-11`):
`id`, `surface`, `base_commit`, `gold_commit`, `task`, `difficulty`, `scope_tier`, `scope_files`,
`scope_insertions`, `gold_notes`, `held_out`.

Validation rules, each with its line:

| Rule | Line |
|---|---|
| `id` matches `/^exam-\d{4}$/` | `exams.js:19` |
| `surface` in `['web','ios']` | `exams.js:20` |
| `difficulty` in `['S','M','L']` | `exams.js:21` |
| `scope_tier` in `['S','M','L']` | `exams.js:22` |
| `scope_files` integer >= 1 | `exams.js:23` |
| `scope_insertions` integer >= 0 | `exams.js:24` |
| `base_commit` and `gold_commit` are full 40-hex SHAs | `exams.js:12, 25-27` |
| `held_out` is boolean | `exams.js:28` |
| `benchmark_status` in `['active','quarantined']`, default `active` | `exams.js:29-30` |
| quarantined requires `quarantine_reason` of at least 20 chars | `exams.js:32-34` |
| active must not carry `quarantine_reason` | `exams.js:35` |
| `work_token_cap` integer 100000..1000000, requires `work_token_cap_reason` >= 20 chars | `exams.js:41-50` |
| `task` at least 35 characters | `exams.js:52` |
| `task_detail` validated by `validateTaskDetail` | `exams.js:53-55` |

Optional: `task_detail`, `benchmark_status`, `quarantine_reason`, `work_token_cap`,
`work_token_cap_reason`.

Loading: files matching `/^exam-\d{4}\.yaml$/`, ids must be unique (`exams.js:77-88`).

A real example is `ai-brain/projects/internship-portal/exams/exam-0001.yaml`: 52 lines, an iOS
exam, difficulty M, scope_tier L, 8 files, 520 insertions, held out, with an approved
`task_detail` carrying 5 behaviors, 5 integration points, and 6 acceptance criteria.

### 5b. Base and gold commit selection

**Rule: base is the direct parent of gold.** Enforced at mining time, not at validation time.
`mine.js:93-95` refuses any commit whose `parents.length !== 1`, and `mine.js:108-109` sets
`base_commit: item.parents[0]` and `gold_commit: item.commit`. The exam validator itself
(`exams.js:25-27`) only checks SHA shape, not the parent relationship.

`agent/data.md:52-53` states the invariant as an accepted fact: "Every base commit is the direct
parent of its gold commit and both revisions are checkout-verified." The checkout verification lives
in `platform/exam/verify.js` (run by `npm run verify:exams`), which I did not read line by line.
(INFERRED that verify.js is where the re-check happens; VERIFIED that mine.js is where the rule is
established.)

### 5c. Difficulty and scope tiers

Two different classifications, deliberately separate.

**Scope tier** (gold-diff size), `exam-scope.js:1-6`, exact:

```
if (files > 5 || insertions > 200) return 'L';
return files <= 2 ? 'S' : 'M';
```

So: S is at most 2 files; M is 3 to 5 files; L is more than 5 files or more than 200 insertions.
`insertions` counts added lines only (`exam-scope.js:22`, summing the `added` column of
`git diff-tree --numstat`, with `-` binary markers read as 0 at line 13).

**Size class** used by the miner, `mine.js:36-40`, a *different* formula on *changed* lines
(added plus deleted, `mine.js:72`):

```
if (files <= 5 && changedLines <= 120) return 'S';
if (files <= 15 && changedLines <= 600) return 'M';
return 'L';
```

**Execution difficulty** (`difficulty: S|M|L`) is neither of these. It is a human judgement about how
hard the task is to execute, and it is what drives the token budget. There is no code that derives
it. (VERIFIED by absence: `grep -n "difficulty" mine.js` returns nothing; the miner emits
`size_class`, and `exams.js:21` simply validates whatever a human wrote.)

### 5d. Token budgets

`engineer.js:281-294`, exact:

```
const fallback = examCap ?? (difficulty === 'S' ? 450_000 : 800_000);
return integer(environment.EXAM_ENGINEER_TOTAL_TOKEN_CAP, fallback, 1_000, 1_000_000, ...);
```

So: S gets 450,000 total tokens; M and L both get 800,000. A per-exam `work_token_cap` overrides the
tier; `EXAM_ENGINEER_TOTAL_TOKEN_CAP` overrides everything. History, from the comment at
`engineer.js:282-290`: 200K/400K until 2026-07-30, then 300K/600K, then 450K/800K on 2026-08-10 under
ADR-0149, after cycles 61 to 65 recorded twelve cap-death events with every overrun narrow (S dying
at 307K to 365K against a 300K cap; M at 604K to 667K against 600K).

Related budget knobs: `EXAM_ENGINEER_EXPLORATION_CLOSE_FRACTION` default 0.5
(`engineer.js:296-306`), the fraction of the cap at which exploration closes and the engineer is held
to edit, create, and submit only.

### 5e. What mine.js does and does not do

**Does**, `mine.js:82-124`:
- Walks `git log <ref> --no-merges` over configured refs, default `['refs/heads/web','refs/heads/ios']`
  (`mine.js:82`).
- Deduplicates by commit sha (`mine.js:91-92`).
- Rejects non-single-parent commits (`mine.js:93-95`).
- Gets numstat per commit via `git diff-tree --no-commit-id --numstat -r <sha>` (`mine.js:97-99`).
- Classifies surface from file paths (`mine.js:22-34`), using literal prefixes `ios/`, `editor/`,
  `scripts/`, and the exact filenames `Dockerfile`, `render.yaml`, `vercel.json`.
- Filters out non-exam candidates (`candidateDisposition`, `mine.js:42-51`): no product code, mixed
  surfaces, empty change, generated-or-lockfile only, commits whose subject matches
  `/^(docs|chore\(agents?\)|debug)(:|\()/i`, pure formatting, and giant commits (more than 50 files
  or more than 2,500 changed lines).
- Excludes generated files by regex (`mine.js:9`): lockfiles, `.xcodeproj/`, `.xcworkspace/`.
- Excludes documentation by regex (`mine.js:10`): `agent/`, `docs/`, `decisions/`, `lessons/`,
  `workflows/`, and root `README|CHANGELOG|CLAUDE|AGENTS` Markdown.
- Drafts a task string from the commit subject (`taskDraft`, `mine.js:76-80`): strips the
  conventional-commit prefix, lists up to 4 two-segment directory areas, and produces
  "Address this product need: X. Review the affected A, B areas and preserve existing behavior
  outside the task."

**Does not**, and this is the whole gap:
- Does not assign `difficulty`. Only `size_class`, on a different formula.
- Does not assign `held_out`.
- Does not write any YAML. `main()` at `mine.js:131-142` prints JSON to stdout. A human writes the
  exam file.
- Does not write `gold_notes`. Every one of the 63 exams has a human-written summary of what the
  reference change actually did.
- Does not write `task_detail`. That comes from `enrich-tasks.js`, which is a paid scope
  (`paid-gate.js:28`, scope `task-enrichment`).
- Does not verify the exam is *solvable* or that the task statement is free of leakage.
- Does not detect that a commit's message overclaims relative to its diff. The 2026-07-23 ultra-audit
  found 17 such defects and quarantined 5 exams outright (ADR-0146 context, `decisions.md:2450-2454`).

In the gym, mining is run every cycle but its output is not auto-approved:
`gym.js:754-757` filters mined candidates against known gold commits and records
`autoApproved: 0` as a literal.

### 5f. ADR-0146 and what human approval changes semantically

VERIFIED, `agent/decisions.md:2446-2468`.

The decision (2026-08-05) approved all 34 remaining draft task details. The semantic effect, quoted
from the ADR's Decision paragraph: "Approved details reach the engineer via effectiveTask as
behaviors, integration expectations, and acceptance criteria; taskVersion becomes task-detail-v1 with
the SHA-256 identity bound into every schema-v2 result, so enriched runs can never be compared
against one-liner history unnoticed."

The mechanism is three lines of code:

- `task-detail.js:38`: `if (exam.taskDetail?.status !== 'approved') return exam.task;` Draft and
  rejected details are inert.
- `task-detail.js:39-42`: an approved detail is appended to the task as three labelled sections.
- `task-detail.js:45-51`: `effectiveTaskIdentity` returns version `task-detail-v1` and a SHA-256 of
  the *effective* task, which `run.js:130-132` persists into every result as `taskVersion` and
  `taskDigest`.

The consequences the ADR itself names (`decisions.md:2465-2468`): held-out measurement resets its
baseline at that boundary, and only identical-signature comparisons are valid afterwards.

The second-order effect, which the ADR does not state but `TEACHER.md:306-317` does: the approved
task text is also used as the **retrieval query** (`run.js:191` passes `effectiveTask(exam)` as the
query). So approving changes two things at once, the student's specification and the documents search
returns. `TEACHER.md:310-316` is explicit that this is why approval is withheld during measurement.

**Note a live contradiction in the repository, dated 2026-08-15.** ADR-0146 (2026-08-05) approved all
34 drafts and says the bank reads 38 approved / 6 rejected / 0 draft. `TEACHER.md:306-308` (era note
added 2026-08-08) instructs the teacher that the descriptions "are all deliberately unapproved, and
must stay that way until the owner says otherwise." I did not resolve which is currently true; both
documents are committed and both are dated after the other's premise. **This is exactly the class of
ambiguity a portable product must not inherit.** (VERIFIED that both texts exist and conflict;
UNRESOLVED which describes the current bank.)

**What replaces human approval in a portable tool.** The approval gate is doing two jobs:

1. *Quality control on generated text* (does this description overclaim relative to the gold?).
   Replaceable by a mechanical check plus an LLM check with a cheap escape: compare the claimed
   behaviors against the files the gold actually touched, and refuse a detail that references a file
   or a capability outside the gold diff.
2. *Measurement-boundary control* (do not change the instrument mid-experiment).
   **Not** replaceable by automation; it is a policy. In the product, replace it with an explicit,
   versioned **task profile** on each exam (`task-profile: minimal | enriched`), where changing the
   profile starts a new comparison baseline automatically because the task digest changes. The
   existing digest machinery (`task-detail.js:45-51`, `run.js:130-132`) already does this; it just
   needs the profile to be a first-class selectable field rather than a status that a human flips.

### 5g. What mechanical derivation would need

For a repo **with** history, per candidate commit:

| Field | Mechanically derivable? | How |
|---|---|---|
| `id` | yes | sequential |
| `base_commit`, `gold_commit` | yes | `mine.js:108-109` already does it |
| `surface` | yes, if surfaces are config | replace `mine.js:22-34` with a configured path-to-surface table |
| `scope_files`, `scope_insertions`, `scope_tier` | yes | `exam-scope.js:8-23` from `git diff-tree --numstat` |
| `task` | partially | `taskDraft` (`mine.js:76-80`) is a template over the commit subject. Quality is entirely a function of commit-message quality. |
| `gold_notes` | needs an LLM or nothing | a summary of the gold diff |
| `difficulty` | no | currently pure human judgement. Proxy candidates: number of distinct directories touched, presence of new files, cyclomatic delta. All unvalidated. |
| `held_out` | policy, not derivation | deterministic hash-based split, for example hold out every exam whose id hash mod 5 equals 0, recorded once and never re-rolled |
| `task_detail` | needs an LLM | and needs the leakage validator at `task-detail.js:5-6` retuned, since its `LEAKAGE` regex bans camelCase, snake_case, backticks, braces, hex strings of 7 to 40 chars, and a fixed extension list (`js|jsx|ts|tsx|swift|css|json|ya?ml|md`) |
| `benchmark_status` | yes | start `active`, quarantine on repeated cap-death, following ADR-0148's precedent |
| `work_token_cap` | yes, adaptively | after N cap-deaths, raise with a recorded reason |

The honest summary: **`mine.js` gets you about 60% of an exam file, and the missing 40% is the part
that determines whether the exam measures anything.** (INFERRED, from the field table above.)

The single highest-leverage mechanical addition, which the codebase does not have: **a solvability
pre-check.** Before an exam enters the bank, verify that the gold diff applies cleanly to the base
and that the gates classify `pass` at gold and `pre-broken` or `regressed` at base. An exam whose
gold does not turn the gates green is not measuring the thing it claims to measure. This is cheap
(no LLM, just gate runs) and would have caught the dead-gate class of defect described in
`project.yaml:17-21` at exam-authoring time rather than after exam-0012 passed with a deleted
function body.

### 5h. Fallback for historyless repos

Three options, in decreasing fidelity:

1. **Mutation exams.** Take HEAD, apply a mechanical mutation (delete a function body, invert a
   boundary condition, remove a call site), and make the *inverse* the gold. Base is the mutated
   tree, gold is HEAD. This produces a valid base-parent-of-gold pair by construction because you
   create the base commit yourself. Everything downstream works unchanged: scope tier, gold diff,
   provenance exclusion, gate classification. Task text has to be generated from the mutation
   (deterministic templates per mutation class). **This is my recommendation.** It also produces a
   controlled difficulty knob, which mined exams do not have.
2. **Issue-derived exams.** If the repo has GitHub issues with linked PRs, mine those. Requires
   network and a host API; not zero-spend.
3. **Retrieval-only mode.** Ship the Brain and MCP, disable the gym, and say so loudly in
   `dijin doctor`. Not a fallback so much as an honest degradation.

Option 1 also solves a problem for repos *with* history: the mutation family gives you a stable,
reproducible difficulty ladder that does not depend on how good the maintainers' commit hygiene was.

---

## 6. TUI seam

Constraints, stated first:

- The engine is Node ESM, 20.18.1 or later (`package.json` engines), roughly 2,600 lines of portable
  core plus whatever survives of the gym.
- `posting` is Python on Textual. I could not find it on this machine
  (`find ~ -maxdepth 4 -type d -name posting` returned nothing), so everything I say about its
  structure is **ASSUMED** from the brief: a Textual app with a collection tree, a request pane, and
  a response pane, driven by a local data model.
- An MCP server already exists, speaks JSON-RPC 2.0 over stdio, and exposes five tools
  (`platform/mcp/server.js:33`, `tools.js:22-101`). **VERIFIED.**

### Option 1: Python Textual TUI driving the Node engine as a subprocess over JSON-RPC on stdio

The TUI spawns `dijin-engine --rpc` and speaks line-delimited JSON-RPC over its stdin and stdout.

Arguments for:
- **The transport already exists and is already tested.** `platform/mcp/brain-mcp.js` is an 11-line
  entry point over `StdioServerTransport`, and `npm run verify:mcp` (`platform/mcp/test-mcp.js`)
  exercises tools, resources, and prompts end to end. The MCP SDK handles framing, request ids, and
  errors.
- Zero port cost for the engine. Zero re-validation of retrieval numbers.
- The same daemon serves the TUI **and** any MCP client (Claude Code, Codex) with no second
  implementation. That is a genuine product advantage: the user's editor agent and the user's TUI
  read the same index through the same code path.
- Process isolation means an engine crash does not take down the UI, and the TUI can show the engine
  as unhealthy rather than dying.

Arguments against:
- Two runtimes to install. `curl | sh` must place both a Python environment and a Node runtime.
  Mitigable: ship the Node engine as a single-file binary (Node SEA, or `bun build --compile`, or
  `pkg`), and ship the Python TUI as a PyInstaller or `uv`-managed tool. Two artifacts, one
  installer.
- Streaming progress needs care. Gym runs take minutes; JSON-RPC needs server-to-client notifications
  for progress, which MCP supports but which the current server does not emit.
- Debugging across a process boundary is harder.

### Option 2: full port of the engine to Python

Arguments for: one runtime, one language, direct in-process calls, easiest packaging.

Arguments against, and they are decisive:
- **The value in this codebase is the tuned numbers and the reasons for them**, and those live in
  `rank.js` (367 lines of ranking logic with roughly 80 lines of comment recording which experiment
  produced each constant), `retrieve.js` fusion (34 lines with the rescale rationale), `chunk.js`,
  and the gate classification in `gates.js`. A port is a chance to silently change every one of them.
- The 578-test suite does not port. You would be re-earning correctness that already exists.
- The MCP server would have to be rewritten too, so you lose the "one server, two consumers" benefit
  unless you rewrite that as well.
- The realistic cost is weeks, and the realistic outcome is a retrieval system whose numbers no
  longer match the measured baselines, with no way to tell whether the difference is the port or the
  design.

### Option 3: Textual-lookalike in Node (Ink, blessed, OpenTUI)

Arguments for: one runtime, single binary, no IPC.

Arguments against:
- The brief says the TUI is "cloned structurally from posting." Cloning a Textual app's structure in
  Ink means reimplementing Textual's widget model, CSS-like styling, and focus handling. You get the
  worst of both: not Textual, and not a design you chose.
- Node TUI ecosystems are meaningfully behind Textual for data-dense apps (tables, trees, split
  panes, scrolling).

### Recommendation

**Option 1: Python Textual TUI, Node engine subprocess, JSON-RPC over stdio, MCP-shaped.**

Specifically:

- Keep `@modelcontextprotocol/sdk` as the transport. Do not invent a protocol.
- The engine binary supports two modes from one entry point: `--mcp` (what exists today, for editor
  agents) and `--rpc` (a superset adding the gym and ingest operations the TUI needs). Same
  dispatcher, different tool registry.
- Method surface the TUI needs, beyond today's five tools:
  `brain.ingest` (with progress notifications), `brain.status`, `gym.discoverGates`,
  `gym.listExams`, `gym.runExam` (streaming), `gym.grade`, `repo.attach`, `doctor.check`.
- Long operations emit MCP progress notifications; the TUI renders them. This is the one piece of
  protocol work that is genuinely new.
- Packaging: `dijin` (Python, the TUI and the installer front end) declares a pinned dependency on
  `dijin-engine` (a platform-specific single-file Node binary). The Python side never needs to know
  Node exists.

The seam is: **the TUI owns no engine state.** Every piece of state (the index, the gate config, the
exam bank, run history) lives behind the RPC boundary, so a second consumer (the editor agent through
MCP) sees the same truth. That is the property that stops the TUI and the MCP server from drifting
into two different products.

---

## 7. Install story

### 7a. What `curl | sh` means per dependency choice

**With Postgres plus pgvector plus Ollama required (today's shape):**
The installer cannot install these. It can only detect them and print instructions. Realistic
onboarding is: install script places the binaries, then `dijin doctor` reports three missing
dependencies and links to platform-specific instructions, then the user spends 10 to 40 minutes
installing Postgres and pgvector (pgvector is not in every distro's default repos and often needs a
build). Drop-off will be severe. **Not viable as the default.**

**With SQLite plus sqlite-vec plus FTS5:**
The installer ships everything. sqlite-vec is a loadable extension distributed as a small
platform-specific shared library; `better-sqlite3` or `node:sqlite` loads it. FTS5 is compiled into
essentially every modern SQLite build. Zero external services. **This is what makes `curl | sh` an
honest promise.**

**With Ollama required for embeddings:**
Still a daemon the installer cannot install. But the failure is *soft and legible*: the code already
produces a precise message naming the model and the pull command (`embed.js:36`,
"Ollama model X is not installed; run ollama pull X") and a distinct message for the daemon being
down (`embed.js:1`). Onboarding is: install Ollama (one command on macOS and Linux), `ollama pull bge-m3`
(roughly 1.2 GB download for the Q4 quantization; ASSUMED, not measured this session), then proceed.

**With a bundled ONNX embedder:**
Fully self-contained, at the cost of re-validating every threshold in section 3c. The download is
still hundreds of megabytes for a 1024-dimension model, or roughly 90 MB for a 384-dimension one with
a quality cost that must be measured, not assumed.

**Recommended install story for v1:**
`curl | sh` installs the engine binary and the TUI, with SQLite storage bundled and working
immediately. Embeddings default to Ollama with a clear, actionable message if it is absent, and a
`--embedder onnx` flag for the fully-offline path once its numbers are measured.

### 7b. Cold start on a medium repo

I can bound this from measured data on this machine, but it is a bound and not a measurement of the
target case.

Measured here: **557 documents, 732 chunks, 37 MB database, 20 MB of which is the chunk table**
(mostly the 732 vectors at 1024 float4, roughly 3 MB of raw vector data plus HNSW graph plus the
tsvector column and its GIN index).

For a "medium repo" I take: 1,500 source files, and a Brain built from the repo's own documentation
plus generated architecture units, producing on the order of 2,000 to 5,000 chunks. (ASSUMED.)

Cold start decomposes into:

1. **Gate discovery and baseline liveness run.** Dominated by the repo's own install and build:
   `npm ci` on a medium React repo is 30 to 120 seconds cold, `npm run build` another 20 to 90,
   `tsc --noEmit` 10 to 60, a Playwright suite potentially minutes. The current default gate timeout
   is 900,000 ms, 15 minutes (`run.js:182`). **Realistic: 2 to 10 minutes, and it is the dominant
   term.**
2. **Embedding.** bge-m3 on Ollama with the default batch size of 16 (`embed.js:117`). I did not
   measure throughput this session. On Apple Silicon, bge-m3 embedding of short chunks is commonly
   in the low hundreds per minute. At 3,000 chunks that is **5 to 20 minutes**. (ASSUMED; this is the
   number most worth measuring before committing to an install-time promise.)
3. **Indexing and writes.** Trivially fast at this scale; the current 732-chunk full ingest is
   seconds. HNSW build at `ef_construction = 200` is described in `015-hnsw-tuned-index.sql:14` as a
   one-time cost of seconds at this size.
4. **Exam mining.** `git log` plus one `git diff-tree` per commit (`mine.js:87-99`). On a 5,000-commit
   repo that is 5,000 subprocess spawns. At roughly 10 ms each that is under a minute; at 50 ms each
   it is four minutes. **Worth batching**, and easy to batch: a single `git log --numstat` produces
   everything `mine.js` needs in one process.

**Honest total: 10 to 30 minutes for first useful state, dominated by embedding and by the target
repo's own build.** The install itself is seconds.

Design implication: **cold start must be resumable and must show progress.** A 20-minute opaque wait
in a TUI is a product failure regardless of correctness. The RPC progress-notification work in
section 6 is not a nice-to-have.

### 7c. The three ugliest onboarding failure modes

**1. No Ollama, or Ollama present without the model.**
Today's behaviour is good: `checkOllama` (`embed.js:27-42`) probes `/api/version` and `/api/tags`
with a 5-second timeout and no retries, distinguishes "model not installed" from "daemon down"
(`embed.js:39`), and `resolveServedIdentity` (`embed.js:145-152`) refuses to proceed on a digest
mismatch. The failure is legible.
What is ugly: it happens **at first ingest**, after the user has already installed and configured.
Fix: `dijin doctor` runs at install time and probes every dependency before the user invests
anything. Model the messages on `embed.js:36`, which names the exact command to run.

**2. No toolchain, so every gate is unavailable and the gym silently carries no signal.**
This is the failure the project has already been burned by twice, both recorded in the source: the
iOS gates sat `unavailable` for entire cycles because `xcode-select` pointed at CommandLineTools and
nothing in the record said so (`gates.js:143-146`), and the iOS build gate exited 65 at code signing
on both baseline and candidate so exam-0012 submitted Swift with a function body deleted and still
reported `completed` (`project.yaml:17-21`).
For a stranger's repo this generalizes to: no `node_modules`, no network for `npm ci`, a build that
needs environment variables the user has not set, a test suite that needs a database.
Fix, and it is non-negotiable: the **gate liveness classification of section 4e must run at install
time and must refuse to install a dead gate.** A gym with zero live gates must say "this repo has no
mechanical signal; grading will be teacher-only" in the TUI, permanently and visibly, not in a log.

**3. Monorepo, where "the repo" is not the unit of anything.**
Every assumption in the harness is single-package: one gate list per surface
(`gates.js:60-62`), one `editor/node_modules` preserve path (`sandbox.js:28`), one build command
(`gates.js:101-104`), one lockfile. In a pnpm or Nx or Turborepo workspace, gates are per-package,
a change touches 3 packages, and `npm ci` at the root is a five-minute operation you cannot afford
per exam.
Fix: the surface abstraction already in the schema is the right hook. A monorepo declares one surface
per package, each with its own `cwd`, gate list, and preserve paths. `mine.js`'s `classifySurface`
(`mine.js:22-34`) becomes a configured path-prefix-to-surface table. Cross-package commits map to the
`mixed` disposition that `mine.js:30` already produces and `candidateDisposition` (`mine.js:44`)
already rejects. That rejection is correct for v1 and should stay.

**4 (honourable mention). Giant repo.**
`mine.js` spawns a git process per commit; a 100,000-commit repo is unusable. `mine.js:49` already
rejects commits over 50 files or 2,500 changed lines, so exam quality is protected, but the *scan*
is not bounded. And a 50,000-file repo produces a Brain that takes an hour to embed. Both need a
scan window (`--since`, `--max-commits`) with a sane default, and neither exists today.

---

## 8. Risk ranking

Ordered by expected damage to the endeavour, each with the cheapest experiment that retires it.

**Risk 1. The retrieval quality numbers do not survive contact with a repo that is not this one.**
Every measured constant in `rank.js` (thresholds 0.35 and 0.35 at lines 4-5, cap ratio 0.22 at line
163, reserved-slot floor 0.55 at line 209, pin rule `overlap >= 3` at line 245) was tuned against a
34-case gold set over a 538-document corpus derived from one project's documentation
(`retrieval-baseline.json`). There is no evidence any of them generalizes. This is the risk that
decides whether Dijin is a product or a personal tool with a nicer face.
*Cheapest experiment:* build a Brain from **one** other repository (a mid-size open-source React
project with a real `docs/` and ADR folder), hand-write 15 gold cases, and run `npm run retrieval-score`
against it with the constants unchanged. Cost: a day, zero spend. If case rate lands anywhere near
0.9, the constants generalize. If it lands at 0.5, the product needs per-corpus calibration and that
changes the whole shape of onboarding.

**Risk 2. Gate discovery cannot tell a live gate from a dead one, so the gym reports coverage it does
not have.**
This is the failure mode the project has hit twice already in a repo whose gates were hand-authored
by the owner (`project.yaml:17-21`, `gates.js:143-146`). Automated discovery over strangers' repos
will hit it constantly. A gym that grades against dead gates is worse than no gym, because it
produces confident numbers.
*Cheapest experiment:* implement only the liveness classifier from section 4e (run each candidate
gate at HEAD, then against a tree with one function body deleted) and run it over 10 diverse public
repos. Count how many discovered gates are live, pre-broken, dead, and unavailable. Cost: two days,
zero spend. The distribution tells you whether discovery is viable at all.

**Risk 3. Mechanically derived exams do not measure anything.**
`mine.js` yields base, gold, scope, and a template task from the commit subject. It does not yield
difficulty, gold notes, held-out status, or any check that the task is solvable or that the commit
message matches the diff. The project's own 2026-07-23 ultra-audit found 17 defects in
human-curated exams and quarantined 5 (ADR-0146 context). Automated exams will be worse.
*Cheapest experiment:* run `npm run mine -- --source-repo <other-repo>` on three public repos with
different commit-hygiene levels, take the first 20 candidates from each, and hand-score how many
produce a coherent task statement. Cost: half a day, zero spend. Also implement the solvability
pre-check from section 5g (gates pass at gold, fail at base) and measure what fraction of mined
candidates survive it; that single number is the best available proxy for exam bank quality.

**Risk 4. The engine and Brain and target repo are one directory today, and separating them touches
everything.**
`server.js:15-16`, `ingest/index.js:18-20`, `retrieve.js:15`, `run.js:30`, and every experiment
script derive their roots from `import.meta.url`. The gym additionally commits and pushes to that
same repo (`gym.js:307-311, 702, 748`). Three-root separation is not a refactor with a clean edge;
it is a change to how every entry point boots.
*Cheapest experiment:* pick the smallest end-to-end slice (ingest plus retrieve plus MCP, no gym),
introduce a `Config` object carrying `engineRoot`, `brainRoot`, `repoRoot`, thread it through those
three paths only, and run `npm run verify:retrieve` plus `npm run verify:mcp`. Cost: one to two days,
zero spend. It tells you whether the threading is mechanical or whether hidden root assumptions
appear.

**Risk 5. Storage swap silently degrades the lexical arm.**
`ts_rank` with the `english` configuration and `websearch_to_tsquery` (`retrieve.js:233-239`) is not
FTS5 `bm25()` with `unicode61`. The stemming-symmetry argument for identifier queries at
`011-chunk-lexical-index.sql:8-12` is Postgres-specific and does not hold under FTS5's default
tokenizer. Because RRF consumes ranks only, the failure will be quiet: fused order shifts, a few gold
cases drop, and nothing errors.
*Cheapest experiment:* before writing any adapter, extract the 5 identifier queries named at
`011:4-5` (`STATUS_RANK`, `companyKey`, `statusPinned`, `ADR-0040`, `reapplyAfter`), load the same
732 chunk texts into a scratch SQLite FTS5 table, and compare which chunk ids each backend returns in
the top 40. Cost: two hours, zero spend, no adapter needed. If FTS5 misses identifiers Postgres
finds, you know to configure a trigram or custom tokenizer before committing to the swap.

**Risk 6. Cold start is long enough that users abandon during onboarding.**
Section 7b bounds it at 10 to 30 minutes, dominated by embedding throughput that I did **not**
measure. If bge-m3 on a mid-range laptop does 50 chunks per minute rather than 300, a 5,000-chunk
repo is 100 minutes and the product is dead on arrival for anyone who does not already want it.
*Cheapest experiment:* time `npm run ingest -- --full` on this machine's existing 732-chunk corpus
and divide. Cost: minutes, zero spend, and I should have run it this session. Then repeat with a
384-dimension ONNX model on the same corpus to get the trade curve.

**Risk 7. Two runtimes make packaging and support harder than the engineering suggests.**
The recommended seam (Python Textual plus Node engine) means two toolchains, two failure modes, two
sets of platform binaries, and a class of bug ("the engine subprocess died") that neither side owns.
*Cheapest experiment:* build the thinnest possible vertical slice before committing: a Textual app
with one screen that spawns today's unmodified `platform/mcp/brain-mcp.js`, calls `brain.search`
over stdio, and renders the result. Cost: one day. It proves or kills the transport, the packaging
question, and the progress-reporting question in one artifact.

**Risk 8. The product inherits the project's unresolved policy contradictions.**
Concretely: ADR-0146 says all task details are approved; `TEACHER.md:306-308` says they are all
deliberately unapproved and must stay that way. `CLAUDE.md` states a retrieval floor of 79.4% while
`retrieval-baseline.json` records 91.2%. Both pairs are committed, both dated, both authoritative-looking.
In a single-owner project this is survivable because the owner remembers. In a product, a stranger
reads one of the two and is wrong.
*Cheapest experiment:* before extraction begins, produce a one-page **invariants sheet** listing
every policy statement the product will ship with, each with exactly one authoritative location and
a `Verified by:` command. Cost: half a day. Any statement that cannot be given a verifying command
does not ship.

---

## Appendix: verification commands

```
cd <root>
npm test                                   # 578 pass / 0 fail, zero spend
export $(grep '^DATABASE_URL=' .env.local)
psql "$DATABASE_URL" -c "SELECT (SELECT count(*) FROM document) AS documents, (SELECT count(*) FROM chunk) AS chunks, (SELECT count(*) FROM relationship) AS relationships, (SELECT count(*) FROM exam) AS exams, (SELECT count(*) FROM exam_run) AS exam_runs;"
psql "$DATABASE_URL" -c "SELECT extname, extversion FROM pg_extension;"
psql "$DATABASE_URL" -c "SELECT pg_size_pretty(pg_database_size(current_database()));"
grep -rn "internship-portal" platform scripts --include="*.js" --include="*.sql" --exclude-dir=sources | grep -v "\.test\.js"
grep -rn "/Users/" platform scripts --include="*.js" --exclude-dir=sources | grep -v "\.test\.js"
grep -rn "psql" platform scripts --include="*.js" --include="*.sh" --exclude-dir=sources
grep -rn "'web', 'ios'\|=== 'ios'\|=== 'web'" platform --include="*.js" --exclude-dir=sources | grep -v "\.test\.js"
cat platform/rag/retrieval-baseline.json
```

Files read in full this session: `agent/agent.md`, `agent/architecture.md`, `agent/setup.md`,
`agent/data.md`, `package.json`, `platform/config/models.example.env`, `platform/rag/query.js`,
`platform/rag/rank.js`, `platform/rag/retrieve.js`, `platform/rag/context.js`,
`platform/rag/standing.js`, `platform/ingest/chunk.js`, `platform/ingest/embed.js`,
`platform/ingest/documents.js`, `platform/ingest/relationships.js`, `platform/exam/gates.js`,
`platform/exam/sandbox.js`, `platform/exam/run.js`, `platform/exam/exams.js`,
`platform/exam/exam-scope.js`, `platform/exam/task-detail.js`, `platform/exam/mine.js`,
`platform/exam/provenance.js`, `platform/mcp/tools.js`, `platform/mcp/server.js`,
`platform/mcp/resources.js`, `platform/mcp/setup-harnesses.js`,
`platform/db/migrations/001-initial-schema.sql`, `011-chunk-lexical-index.sql`,
`015-hnsw-tuned-index.sql`, `ai-brain/projects/internship-portal/project.yaml`,
`ai-brain/projects/internship-portal/exams/exam-0001.yaml`, `platform/rag/retrieval-baseline.json`,
`.mcp.json`, `.githooks/post-commit`.

Files read in part: `platform/exam/engineer.js` (token caps, tool list, ripgrep binding),
`platform/exam/grade.js` (gold binding and diff), `platform/exam/grade-export.js` (packet format),
`platform/exam/gym.js` (selection, git operations, preflight), `platform/exam/scheduler.js` (launchd),
`platform/exam/paid-gate.js` (scopes), `platform/exam/gates/{eslint,react-doctor,swiftlint}-gate.js`,
`platform/rag/retrieval-score.js`, `platform/rag/content-survival.js`,
`platform/export/{graph,source-map}.js`, `platform/ingest/index.js`, `TEACHER.md`,
`agent/decisions.md` (ADR-0146 through ADR-0149), `agent/state.md` (first 60 lines).

Not read: the bulk of `platform/exam/` experiment and launcher scripts, `platform/exam/scorecard.js`
and `dashboard.js` beyond their path literals, `platform/export/` beyond `graph.js` and
`source-map.js`, `platform/exam/verify.js` beyond grep hits, all test files.
