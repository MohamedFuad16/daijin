# engine/test-live

Tests that need a live service. **CI never runs this directory.** Its absence from a
green CI run means "not run here", never "covered" (D-0015).

`engine/test/` is hermetic: no network, no live services, injected embedders. Anything
that needs a database or an embedding daemon lives here instead, so the hermetic suite
can be the thing CI gates on.

## Run it

```
cd engine && npm run test:live
```

`npm test` runs the hermetic suite only. The two are separate scripts on purpose.

## What it needs

| Requirement | Used by | How it is found |
| --- | --- | --- |
| PostgreSQL with pgvector | both files | `DAIJIN_TEST_DATABASE_URL`, else the server the platform corpus is configured against |
| A local Ollama serving the pinned embedder | `platform-parity.test.js` | `OLLAMA_BASE_URL`, default `http://localhost:11434` |
| The AI Brain Platform checkout and its indexed corpus | `platform-parity.test.js` | `DAIJIN_PLATFORM_ROOT`, else the path in `src/init/corpora/platform.json` |

Zero spend. Embeddings come from local Ollama; nothing here calls a paid API.

## What lives here

**`platform-parity.test.js`** is the P1 acceptance test. It runs the ported harness
against the platform corpus and asserts the EXACT values committed in that repository's
`platform/rag/retrieval-baseline.json`: `caseRate 0.9117647058823529` (31 of 34),
`violations 0`, at the `k` the baseline itself records. Not a tolerance band, not a
rounded percentage. It reads `baseline.k` rather than hardcoding, so it follows the file
if the file moves.

It is a measurement, not a lookup: the run takes several seconds because it embeds all 34
queries and queries the live index. A version of this test that finished instantly would
be quoting the baseline back at itself.

**`pgvector-conformance.test.js`** runs the shared store conformance suite
(`../test/store-conformance.test.js`) against the pgvector backend, plus the pgvector
specific cases the shared suite does not cover: the migration ledger, the refusal to
migrate a database another tool owns, and the write operations that delete.

## Two safety properties this directory depends on

**Never write to the owner's platform database** (D-0012). Parity runs are read-only
against it. Every write-path test creates and drops its own scratch database. The store
enforces this rather than trusting convention: `migrate()` refuses outright if the target
carries another tool's `schema_migration` ledger, which the platform's database does.

**A missing shared suite is a broken build, not a skip.** The conformance import is
static. A named skip there would be dead coverage the first time the file moves. An
unreachable *database* is a different condition and does skip, with the reason named,
because the live suite is local by design.
