"""Fixtures for the bundled mock engine, shaped to RPC v3.

These values are fictional. They exist so every screen has something to render
before the Node engine lands, and they are NOT measurements of anything. They
are not copied from any report: a fixture that borrows a real number invites
the number to be read back as evidence, and this project has already been
burned by that once.

What is not fictional is the SHAPE and the value conventions, which follow
engine/src/rpc/methods.md v3 exactly:

- caseRate is `{ exact, cases }`. exact is the unrounded ratio; cases is the
  "31 of 34" form. The TUI displays the count form and never a bare rounded
  percentage, because a rounded percentage hides its own denominator.
- mrr is recorded for movement only. It is never a floor and is labelled as
  recorded everywhere it appears.
- perCase rows are `{ caseId, hit, rank, arm, type, area }` so the sub-75
  diagnosis can cluster by type, area, and arm.
- chosenBudget and rationale carry the per-repo budget decision.
"""

from __future__ import annotations

from typing import Any

CONTRACT_VERSION = "5"
ENGINE_VERSION = "0.0.0-mock"
MCP_THRESHOLD = 0.75

# The engine does not publish a phase manifest, so the client carries the
# expected init pipeline order (build plan, "Init pipeline v2"). Unknown phases
# arriving on the stream are appended at runtime. See OPEN QUESTIONS.
INIT_PHASES: list[tuple[str, str]] = [
    ("verify-roles", "Verify model roles"),
    ("identify", "Identify repo"),
    ("brain", "Build brain units"),
    ("chunk-embed", "Chunk and embed"),
    ("gold-set", "Mine gold set"),
    ("retrieval-floor", "Measure retrieval floor"),
    ("mcp-unlock", "Unlock MCP"),
]

GYM_PHASES: list[tuple[str, str]] = [
    ("draw", "Draw exam"),
    ("rounds", "Work rounds"),
    ("submit", "Submit and grade"),
    ("audit", "Criteria audit"),
]

GATES_PHASES: list[tuple[str, str]] = [
    ("probe", "Probe manifests"),
    ("baseline", "Run against baseline"),
    ("classify", "Classify candidates"),
]


def case_rate(hits: int, total: int) -> dict[str, Any]:
    """Build a caseRate in the v3 shape.

    exact stays unrounded on purpose: rounding at the source is how a floor
    quietly moves. The display layer decides precision, never the data.
    """
    return {"exact": (hits / total) if total else 0.0, "cases": f"{hits} of {total}"}


REPOS: list[dict[str, Any]] = [
    {
        "path": "/Users/owner/code/orchard-web",
        "health": "ok",
        "floorScore": 31 / 34,
        "mcpActive": True,
    },
    {
        "path": "/Users/owner/code/lantern-ios",
        "health": "warn",
        "floorScore": 21 / 31,
        "mcpActive": False,
    },
    {
        "path": "/Users/owner/code/kiln-api",
        "health": "no-brain",
        "floorScore": None,
        "mcpActive": False,
    },
]

SPEND_GATE = {"open": False, "path": ".daijin/GATE"}

SERVE_STATUS: dict[str, Any] = {
    "repos": REPOS,
    "ollama": {
        "reachable": True,
        "endpoint": "http://127.0.0.1:11434",
        "embedder": "bge-m3",
        "dimension": 1024,
    },
    "db": {
        "driver": "sqlite-vec",
        "path": "~/.daijin/stores",
        "sizeBytes": 48_233_984,
        "indexDigest": "sha256:41c0d9",
    },
    "spendGate": dict(SPEND_GATE),
}

ANALYZE: dict[str, dict[str, Any]] = {
    "/Users/owner/code/orchard-web": {
        "languages": [
            {"name": "TypeScript", "files": 412, "share": 0.71},
            {"name": "CSS", "files": 88, "share": 0.15},
            {"name": "JavaScript", "files": 51, "share": 0.09},
            {"name": "Shell", "files": 27, "share": 0.05},
        ],
        "commitCount": 3184,
        "structure": {
            "root": "/Users/owner/code/orchard-web",
            "packages": ["."],
            "directories": ["src/app", "src/components", "src/lib", "tests"],
            "fileCount": 578,
        },
        "gateCandidates": [
            {"name": "eslint", "command": "npm run lint", "source": "package.json"},
            {"name": "tsc", "command": "npm run typecheck", "source": "package.json"},
            {"name": "vitest", "command": "npm test", "source": "package.json"},
        ],
        "hasBrainFolder": True,
    },
    "/Users/owner/code/lantern-ios": {
        "languages": [
            {"name": "Swift", "files": 233, "share": 0.88},
            {"name": "Objective-C", "files": 12, "share": 0.07},
            {"name": "Shell", "files": 9, "share": 0.05},
        ],
        "commitCount": 1042,
        "structure": {
            "root": "/Users/owner/code/lantern-ios",
            "packages": ["."],
            "directories": ["Lantern", "LanternTests", "Packages/Core"],
            "fileCount": 254,
        },
        "gateCandidates": [
            {"name": "swiftlint", "command": "swiftlint", "source": "Makefile"},
            {"name": "xcodebuild-test", "command": "make test", "source": "Makefile"},
        ],
        "hasBrainFolder": True,
    },
    "/Users/owner/code/kiln-api": {
        "languages": [
            {"name": "Python", "files": 164, "share": 0.82},
            {"name": "SQL", "files": 22, "share": 0.11},
            {"name": "Shell", "files": 14, "share": 0.07},
        ],
        "commitCount": 617,
        "structure": {
            "root": "/Users/owner/code/kiln-api",
            "packages": ["."],
            "directories": ["kiln", "kiln/routes", "migrations", "tests"],
            "fileCount": 200,
        },
        "gateCandidates": [
            {"name": "ruff", "command": "ruff check .", "source": "pyproject.toml"},
            {"name": "pytest", "command": "pytest", "source": "pyproject.toml"},
        ],
        "hasBrainFolder": False,
    },
}

RETRIEVAL_SCORE: dict[str, dict[str, Any]] = {
    "/Users/owner/code/orchard-web": {
        "caseRate": case_rate(31, 34),
        "mrr": 0.612,
        "violations": 0,
        "chosenBudget": 4000,
        "rationale": "smallest budget within one case of the best sweep score",
        "perCase": [
            {"caseId": "gold-004", "hit": True, "rank": 1, "arm": "fused", "type": "structural", "area": "src/lib"},
            {"caseId": "gold-011", "hit": True, "rank": 2, "arm": "semantic", "type": "commit-archaeology", "area": "src/app"},
            {"caseId": "gold-019", "hit": True, "rank": 1, "arm": "lexical", "type": "identifier", "area": "src/lib"},
            {"caseId": "gold-026", "hit": False, "rank": None, "arm": "semantic", "type": "commit-archaeology", "area": "src/styles"},
            {"caseId": "gold-033", "hit": False, "rank": None, "arm": "fused", "type": "commit-archaeology", "area": "src/styles"},
            {"caseId": "gold-041", "hit": True, "rank": 3, "arm": "fused", "type": "structural", "area": "src/lib"},
            {"caseId": "gold-048", "hit": False, "rank": None, "arm": "lexical", "type": "structural", "area": "src/components"},
            {"caseId": "gold-057", "hit": True, "rank": 1, "arm": "lexical", "type": "identifier", "area": "tests"},
        ],
        "budgetSweep": [
            {"budget": 3000, "caseRate": case_rate(28, 34)},
            {"budget": 4000, "caseRate": case_rate(31, 34)},
            {"budget": 6000, "caseRate": case_rate(31, 34)},
            {"budget": 8000, "caseRate": case_rate(30, 34)},
        ],
    },
    "/Users/owner/code/lantern-ios": {
        "caseRate": case_rate(21, 31),
        "mrr": 0.488,
        "violations": 1,
        "chosenBudget": 6000,
        "rationale": "sweep still climbing at 6k, 8k adds no case",
        "perCase": [
            {"caseId": "gold-002", "hit": False, "rank": None, "arm": "semantic", "type": "structural", "area": "Lantern"},
            {"caseId": "gold-008", "hit": True, "rank": 1, "arm": "lexical", "type": "identifier", "area": "Packages/Core"},
            {"caseId": "gold-015", "hit": False, "rank": None, "arm": "semantic", "type": "commit-archaeology", "area": "Packages/Core"},
            {"caseId": "gold-018", "hit": False, "rank": None, "arm": "semantic", "type": "commit-archaeology", "area": "Packages/Core"},
            {"caseId": "gold-022", "hit": True, "rank": 4, "arm": "fused", "type": "structural", "area": "Lantern"},
            {"caseId": "gold-027", "hit": False, "rank": None, "arm": "fused", "type": "structural", "area": "Lantern"},
            {"caseId": "gold-030", "hit": True, "rank": 2, "arm": "lexical", "type": "identifier", "area": "Lantern"},
        ],
        "budgetSweep": [
            {"budget": 3000, "caseRate": case_rate(18, 31)},
            {"budget": 4000, "caseRate": case_rate(20, 31)},
            {"budget": 6000, "caseRate": case_rate(21, 31)},
            {"budget": 8000, "caseRate": case_rate(21, 31)},
        ],
    },
}

# diagnose returns the mechanical clustering of the missed cases. Zero-spend:
# it is arithmetic over the perCase rows, no model involved.
DIAGNOSE: dict[str, dict[str, Any]] = {
    "/Users/owner/code/lantern-ios": {
        "caseRate": case_rate(21, 31),
        "threshold": MCP_THRESHOLD,
        "missed": 10,
        "total": 31,
        "clusters": {
            "type": [
                {"key": "commit-archaeology", "missed": 6, "of": 9},
                {"key": "structural", "missed": 3, "of": 14},
                {"key": "identifier", "missed": 1, "of": 8},
            ],
            "area": [
                {"key": "Packages/Core", "missed": 6, "of": 12},
                {"key": "Lantern", "missed": 4, "of": 17},
                {"key": "LanternTests", "missed": 0, "of": 2},
            ],
            "arm": [
                {"key": "semantic", "missed": 7, "of": 14},
                {"key": "fused", "missed": 2, "of": 11},
                {"key": "lexical", "missed": 1, "of": 6},
            ],
        },
        "missedCases": [
            {"caseId": "gold-002", "arm": "semantic", "type": "structural", "area": "Lantern"},
            {"caseId": "gold-015", "arm": "semantic", "type": "commit-archaeology", "area": "Packages/Core"},
            {"caseId": "gold-018", "arm": "semantic", "type": "commit-archaeology", "area": "Packages/Core"},
            {"caseId": "gold-027", "arm": "fused", "type": "structural", "area": "Lantern"},
        ],
    },
    "/Users/owner/code/orchard-web": {
        "caseRate": case_rate(31, 34),
        "threshold": MCP_THRESHOLD,
        "missed": 3,
        "total": 34,
        "clusters": {
            "type": [
                {"key": "commit-archaeology", "missed": 2, "of": 10},
                {"key": "structural", "missed": 1, "of": 15},
                {"key": "identifier", "missed": 0, "of": 9},
            ],
            "area": [
                {"key": "src/styles", "missed": 2, "of": 3},
                {"key": "src/components", "missed": 1, "of": 6},
                {"key": "src/lib", "missed": 0, "of": 17},
            ],
            "arm": [
                {"key": "semantic", "missed": 1, "of": 12},
                {"key": "fused", "missed": 1, "of": 13},
                {"key": "lexical", "missed": 1, "of": 9},
            ],
        },
        "missedCases": [
            {"caseId": "gold-026", "arm": "semantic", "type": "commit-archaeology", "area": "src/styles"},
            {"caseId": "gold-033", "arm": "fused", "type": "commit-archaeology", "area": "src/styles"},
            {"caseId": "gold-048", "arm": "lexical", "type": "structural", "area": "src/components"},
        ],
    },
}

DIAGNOSE_NARRATION: dict[str, str] = {
    "/Users/owner/code/lantern-ios": (
        "Six of the nine commit-archaeology cases miss, and six of the ten misses "
        "sit in Packages/Core, which the semantic arm carries alone because the "
        "module has almost no prose to match lexically. The recommendation is a "
        "Layer 2 pass scoped to Packages/Core before any gym spend: enrich the "
        "decision and lesson units there from the real commits, then re-measure. "
        "If the floor still sits below the threshold after that, the gym is the "
        "next step, and it is your spend to approve, not mine."
    ),
    "/Users/owner/code/orchard-web": (
        "The floor is above the threshold, so nothing here is blocking. Two of the "
        "three misses are commit-archaeology cases in src/styles, an area with one "
        "documented decision and a history of format-only commits. Enriching it is "
        "optional and would move a small denominator."
    ),
}

MCP_SNIPPET: dict[str, dict[str, Any]] = {
    "/Users/owner/code/orchard-web": {
        "unlocked": True,
        "threshold": MCP_THRESHOLD,
        "snippet": (
            '{\n'
            '  "mcpServers": {\n'
            '    "daijin-orchard-web": {\n'
            '      "command": "daijin-mcp",\n'
            '      "args": ["--repo", "/Users/owner/code/orchard-web"]\n'
            '    }\n'
            '  }\n'
            '}'
        ),
    },
    "/Users/owner/code/lantern-ios": {
        "unlocked": False,
        "threshold": MCP_THRESHOLD,
        "snippet": None,
    },
}

GATES: dict[str, dict[str, Any]] = {
    "/Users/owner/code/orchard-web": {
        "path": ".daijin/gates.yaml",
        "gates": [
            {
                "name": "eslint",
                "command": "npm run lint",
                "source": "package.json",
                "classification": "measured",
                "metric": "GATE_METRIC:down:0",
                "baselineViolations": 14,
                "evidence": "baseline run 2026-08-16T06:11:02Z, exit 1, 14 warnings, 8.4s",
                "enabled": True,
            },
            {
                "name": "tsc",
                "command": "npm run typecheck",
                "source": "package.json",
                "classification": "live",
                "metric": None,
                "baselineViolations": 0,
                "evidence": "baseline run 2026-08-16T06:11:14Z, exit 0, 12.1s",
                "enabled": True,
            },
            {
                "name": "vitest",
                "command": "npm test",
                "source": "package.json",
                "classification": "live",
                "metric": None,
                "baselineViolations": 0,
                "evidence": "baseline run 2026-08-16T06:11:31Z, exit 0, 41.7s, 318 tests",
                "enabled": True,
            },
            {
                "name": "react-doctor",
                "command": "npx react-doctor",
                "source": "package.json",
                "classification": "pre-broken",
                "metric": None,
                "baselineViolations": 31,
                "evidence": "fails on baseline AND candidate alike, exit 1 both runs, carries no signal",
                "enabled": False,
            },
            {
                "name": "playwright",
                "command": "npx playwright test",
                "source": "package.json",
                "classification": "unavailable",
                "metric": None,
                "baselineViolations": None,
                "evidence": "browser binaries not installed, command exits 127",
                "enabled": False,
            },
        ],
    },
    "/Users/owner/code/lantern-ios": {
        "path": ".daijin/gates.yaml",
        "gates": [
            {
                "name": "swiftlint",
                "command": "swiftlint",
                "source": "Makefile",
                "classification": "measured",
                "metric": "GATE_METRIC:down:0",
                "baselineViolations": 62,
                "evidence": "baseline run 2026-08-16T06:22:40Z, exit 1, 62 violations, 6.9s",
                "enabled": True,
            },
            {
                "name": "xcodebuild-test",
                "command": "make test",
                "source": "Makefile",
                "classification": "live",
                "metric": None,
                "baselineViolations": 0,
                "evidence": "baseline run 2026-08-16T06:24:02Z, exit 0, 233.5s, fresh DerivedData",
                "enabled": True,
            },
        ],
    },
}

SEARCH_CHUNKS: list[dict[str, Any]] = [
    {
        "id": "chunk-1841",
        "documentId": "adr-0044-upload-queue",
        "type": "adr",
        "area": "src/lib",
        "score": 0.7412,
        "tokens": 512,
        "standing": False,
        "text": (
            "ADR-0044: the upload queue retries with exponential backoff capped at "
            "five attempts. The cap exists because the storage provider returns 429 "
            "for the whole bucket, so a longer tail multiplies the outage rather "
            "than surviving it."
        ),
    },
    {
        "id": "chunk-0293",
        "documentId": "card-upload-queue",
        "type": "card",
        "area": "src/lib",
        "score": 0.6688,
        "tokens": 388,
        "standing": False,
        "text": (
            "Architecture card, upload queue. Entry point src/lib/uploadQueue.ts, "
            "consumed by src/app/routes/upload.tsx and src/components/DropZone.tsx. "
            "Persists to IndexedDB via src/lib/store/idb.ts."
        ),
    },
    {
        "id": "chunk-0007",
        "documentId": "conventions",
        "type": "convention",
        "area": None,
        "score": 0.6120,
        "tokens": 264,
        "standing": True,
        "text": (
            "Convention measured over 412 TypeScript files: async work returns a "
            "Result type rather than throwing; 91 percent of call sites follow it."
        ),
    },
    {
        "id": "chunk-1102",
        "documentId": "lesson-0009-retry-storm",
        "type": "lesson",
        "area": "src/lib",
        "score": 0.5904,
        "tokens": 430,
        "standing": False,
        "text": (
            "Lesson 0009: a retry storm took the bucket down in commit 9f2ac1. The "
            "fix added jitter. Validated against the current code on ingest."
        ),
    },
    {
        "id": "chunk-1550",
        "documentId": "src/lib/uploadQueue.ts",
        "type": "code",
        "area": "src/lib",
        "score": 0.5511,
        "tokens": 606,
        "standing": False,
        "text": (
            "export function scheduleUpload(job: UploadJob): Result<Handle, QueueError> "
            "{ const delay = backoff(job.attempt); ... }"
        ),
    },
]

# documents(repoPath, filters?) joined the surface in v4, so the brain browser
# lists a real inventory and browsing is no longer search-only.
DOCUMENTS: dict[str, list[dict[str, Any]]] = {
    "/Users/owner/code/orchard-web": [
        {"id": "adr-0044-upload-queue", "type": "adr", "path": "agent/decisions.md#adr-0044", "title": "Upload queue retries with capped exponential backoff", "area": "src/lib", "tags": ["retry", "storage"]},
        {"id": "adr-0051-feature-flags", "type": "adr", "path": "agent/decisions.md#adr-0051", "title": "Feature flags resolve at build time", "area": "src/lib", "tags": ["build", "flags"]},
        {"id": "card-upload-queue", "type": "card", "path": "agent/cards/upload-queue.md", "title": "Architecture card, upload queue", "area": "src/lib", "tags": ["generated", "layer1"]},
        {"id": "card-routing", "type": "card", "path": "agent/cards/routing.md", "title": "Architecture card, app routing", "area": "src/app", "tags": ["generated", "layer1"]},
        {"id": "card-design-system", "type": "card", "path": "agent/cards/design-system.md", "title": "Architecture card, design system", "area": "src/components", "tags": ["generated", "layer1"]},
        {"id": "lesson-0009-retry-storm", "type": "lesson", "path": "agent/errors.md#lesson-0009", "title": "A retry storm took the bucket down", "area": "src/lib", "tags": ["validated", "incident"]},
        {"id": "conventions", "type": "convention", "path": "agent/conventions.md", "title": "Measured conventions", "area": None, "tags": ["standing", "measured"]},
        {"id": "dependency-census", "type": "evidence", "path": "agent/evidence/dependencies.md", "title": "Dependency census", "area": None, "tags": ["generated", "layer1"]},
        {"id": "import-graph", "type": "evidence", "path": "agent/evidence/import-graph.md", "title": "Import graph and call sites", "area": None, "tags": ["generated", "layer1"]},
        {"id": "co-change-clusters", "type": "evidence", "path": "agent/evidence/co-change.md", "title": "Co-change clusters", "area": None, "tags": ["generated", "layer1"]},
    ],
    "/Users/owner/code/lantern-ios": [
        {"id": "card-sync", "type": "card", "path": "agent/cards/sync.md", "title": "Architecture card, sync coordinator", "area": "Packages/Core", "tags": ["generated", "layer1"]},
        {"id": "card-widgets", "type": "card", "path": "agent/cards/widgets.md", "title": "Architecture card, widget timeline", "area": "Lantern", "tags": ["generated", "layer1"]},
        {"id": "adr-0012-keychain", "type": "adr", "path": "agent/decisions.md#adr-0012", "title": "Keychain access is serialized through one actor", "area": "Packages/Core", "tags": ["security"]},
        {"id": "conventions", "type": "convention", "path": "agent/conventions.md", "title": "Measured conventions", "area": None, "tags": ["standing", "measured"]},
    ],
}

# scoreHistory is the floor over TIME, newest first. It is a different series
# from budgetSweep, which is one measurement across budgets, and the two are
# never drawn under the same caption or in the same widget.
SCORE_HISTORY: dict[str, list[dict[str, Any]]] = {
    "/Users/owner/code/orchard-web": [
        {"at": "2026-08-16T09:04:00Z", "caseRate": case_rate(31, 34), "chosenBudget": 4000},
        {"at": "2026-08-15T18:20:00Z", "caseRate": case_rate(30, 34), "chosenBudget": 4000},
        {"at": "2026-08-14T11:02:00Z", "caseRate": case_rate(27, 34), "chosenBudget": 4000},
        {"at": "2026-08-12T16:45:00Z", "caseRate": case_rate(24, 33), "chosenBudget": 3000},
        {"at": "2026-08-11T09:30:00Z", "caseRate": case_rate(21, 31), "chosenBudget": 3000},
    ],
    "/Users/owner/code/lantern-ios": [
        {"at": "2026-08-16T08:50:00Z", "caseRate": case_rate(21, 31), "chosenBudget": 6000},
        {"at": "2026-08-15T14:10:00Z", "caseRate": case_rate(20, 31), "chosenBudget": 6000},
        {"at": "2026-08-13T10:05:00Z", "caseRate": case_rate(18, 30), "chosenBudget": 4000},
    ],
}

# examList rows carry the two orthogonal status axes plus the split flag.
# status is the authoring pipeline; benchmarkStatus is measurement integrity.
EXAMS: list[dict[str, Any]] = [
    {
        "examId": "exam-0058",
        "title": "Restore the ordering guarantee in the upload queue",
        "status": "promoted",
        "benchmarkStatus": "active",
        "heldOut": False,
        "tier": "M",
        "provenance": {
            "repoPath": "/Users/owner/code/orchard-web",
            "baseCommit": "9f2ac1d",
            "goldCommit": "3be7710",
            "source": "commit-archaeology",
            "selectedBy": "auditor",
            "supersedes": None,
            "note": "Ordering guarantee in the upload queue. Nine attempts under the natural-stop loop.",
        },
    },
    {
        "examId": "exam-0061",
        "title": "Add jitter to the retry backoff",
        "status": "promoted",
        "benchmarkStatus": "quarantined",
        "quarantineReason": "cap death at round 40 left no result row, so the drawn cohort denominator cannot be trusted for this exam",
        "heldOut": False,
        "tier": "S",
        "provenance": {
            "repoPath": "/Users/owner/code/orchard-web",
            "baseCommit": "3be7710",
            "goldCommit": "a10c4e2",
            "source": "commit-archaeology",
            "selectedBy": "auditor",
            "supersedes": "exam-0053",
            "note": "Jitter on the retry backoff. Latest wins, exam-0053 became Layer 2 brain material.",
        },
    },
    {
        "examId": "exam-0072",
        "title": "Extract the sync coordinator from the view model",
        "status": "validated",
        "benchmarkStatus": "active",
        "heldOut": True,
        "tier": "L",
        "provenance": {
            "repoPath": "/Users/owner/code/lantern-ios",
            "baseCommit": "77b1e05",
            "goldCommit": "c4419aa",
            "source": "commit-archaeology",
            "selectedBy": "auditor",
            "supersedes": None,
            "note": "Extract the sync coordinator from the view model. Held out of the training split.",
        },
    },
    {
        "examId": "exam-0074",
        "title": "Serialize keychain reads through the existing actor",
        "status": "draft",
        "benchmarkStatus": "active",
        "heldOut": False,
        "tier": "S",
        "provenance": {
            "repoPath": "/Users/owner/code/lantern-ios",
            "baseCommit": "c4419aa",
            "goldCommit": "e91b3d0",
            "source": "commit-archaeology",
            "selectedBy": "auditor",
            "supersedes": None,
            "note": "Awaiting mechanical validation gates and auditor review.",
        },
    },
    {
        "examId": "exam-0069",
        "title": "Rewrite the design system token pipeline",
        "status": "vetoed",
        "benchmarkStatus": "active",
        "heldOut": False,
        "tier": "M",
        "provenance": {
            "repoPath": "/Users/owner/code/orchard-web",
            "baseCommit": "1d0ba47",
            "goldCommit": "6c2f118",
            "source": "commit-archaeology",
            "selectedBy": "auditor",
            "supersedes": None,
            "note": "Vetoed by the user: the statement cannot be written without leaking the fix.",
        },
    },
]

EXAM_DETAIL: dict[str, dict[str, Any]] = {
    "exam-0058": {
        "axes": [
            {"name": "correctness", "score": 0.82, "max": 1.0},
            {"name": "integration", "score": 0.74, "max": 1.0},
            {"name": "conventions", "score": 0.91, "max": 1.0},
            {"name": "evidence", "score": 0.63, "max": 1.0},
            {"name": "restraint", "score": 0.88, "max": 1.0},
        ],
        "attempts": [
            {"n": 1, "tokens": 118_400, "mode": "harness-debug", "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.31, "integration": 0.22, "conventions": 0.55, "evidence": 0.18, "restraint": 0.40}},
            {"n": 2, "tokens": 142_900, "mode": "harness-debug", "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.38, "integration": 0.30, "conventions": 0.60, "evidence": 0.25, "restraint": 0.48}},
            {"n": 3, "tokens": 166_100, "mode": "experiment", "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.44, "integration": 0.35, "conventions": 0.66, "evidence": 0.31, "restraint": 0.52}},
            {"n": 4, "tokens": 201_800, "mode": "sideways", "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.51, "integration": 0.41, "conventions": 0.71, "evidence": 0.36, "restraint": 0.59}},
            {"n": 5, "tokens": 238_500, "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.58, "integration": 0.47, "conventions": 0.74, "evidence": 0.42, "restraint": 0.63}},
            {"n": 6, "tokens": 274_300, "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.63, "integration": 0.52, "conventions": 0.79, "evidence": 0.47, "restraint": 0.70}},
            {"n": 7, "tokens": 318_700, "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.70, "integration": 0.61, "conventions": 0.83, "evidence": 0.51, "restraint": 0.76}},
            {"n": 8, "tokens": 366_200, "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.76, "integration": 0.68, "conventions": 0.87, "evidence": 0.57, "restraint": 0.81}},
            {"n": 9, "tokens": 401_900, "mode": "evaluation", "verdict": "pass", "ungradedCode": None, "grades": {"correctness": 0.82, "integration": 0.74, "conventions": 0.91, "evidence": 0.63, "restraint": 0.88}},
        ],
        "provenance": EXAMS[0]["provenance"],
    },
    "exam-0061": {
        "axes": [
            {"name": "correctness", "score": 0.55, "max": 1.0},
            {"name": "integration", "score": 0.48, "max": 1.0},
            {"name": "conventions", "score": 0.72, "max": 1.0},
            {"name": "evidence", "score": 0.39, "max": 1.0},
            {"name": "restraint", "score": 0.66, "max": 1.0},
        ],
        "attempts": [
            {"n": 1, "tokens": 74_200, "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.28, "integration": 0.20, "conventions": 0.51, "evidence": 0.15, "restraint": 0.44}},
            {"n": 2, "tokens": 96_800, "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.35, "integration": 0.29, "conventions": 0.58, "evidence": 0.22, "restraint": 0.51}},
            {"n": 3, "tokens": 121_500, "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.47, "integration": 0.38, "conventions": 0.65, "evidence": 0.31, "restraint": 0.60}},
            {"n": 4, "tokens": 149_300, "verdict": "fail", "ungradedCode": None, "grades": {"correctness": 0.55, "integration": 0.48, "conventions": 0.72, "evidence": 0.39, "restraint": 0.66}},
        ],
        "provenance": EXAMS[1]["provenance"],
    },
    "exam-0072": {
        # null, NOT zeros. An empty or zeroed axis list plots on a radar
        # exactly like a student who scored nothing on every axis, when the
        # truth is that nobody graded it.
        "axes": None,
        "attempts": [],
        "provenance": EXAMS[2]["provenance"],
    },
    "exam-0074": {
        # null, NOT zeros. An empty or zeroed axis list plots on a radar
        # exactly like a student who scored nothing on every axis, when the
        # truth is that nobody graded it.
        "axes": None,
        # The only path visible today: rubric persistence does not exist yet,
        # so axes is null on every attempt in every real database.
        "attempts": [
            {
                "n": 1,
                "tokens": 12_400,
                "verdict": None,
                "axes": None,
                "ungradedCode": "unsubmitted",
                "ungradedReason": "The student stopped before submitting; there is no answer to grade.",
                "grades": None,
            },
            {
                "n": 2,
                "tokens": 31_900,
                "verdict": None,
                "axes": None,
                "ungradedCode": "apply-error",
                "ungradedReason": "The patch did not apply to the base worktree, so the run produced no gradable diff.",
                "grades": None,
            },
            {
                "n": 3,
                "tokens": 8_100,
                "verdict": None,
                "axes": None,
                "ungradedCode": "pending",
                "ungradedReason": "Submitted, waiting for the teacher.",
                "grades": None,
            },
        ],
        "provenance": EXAMS[3]["provenance"],
    },
    "exam-0069": {
        # null, NOT zeros. An empty or zeroed axis list plots on a radar
        # exactly like a student who scored nothing on every axis, when the
        # truth is that nobody graded it.
        "axes": None,
        "attempts": [],
        "provenance": EXAMS[4]["provenance"],
    },
}

GYM_STATUS: dict[str, Any] = {
    "cycles": [
        {"n": 1, "examId": "exam-0058", "verdict": "fail", "tokens": 118_400, "rounds": 22, "durationS": 641},
        {"n": 2, "examId": "exam-0058", "verdict": "fail", "tokens": 142_900, "rounds": 27, "durationS": 712},
        {"n": 3, "examId": "exam-0061", "verdict": "fail", "tokens": 96_800, "rounds": 19, "durationS": 508},
        {"n": 4, "examId": "exam-0058", "verdict": "fail", "tokens": 238_500, "rounds": 38, "durationS": 1_104},
        {"n": 5, "examId": "exam-0058", "verdict": "pass", "tokens": 401_900, "rounds": 44, "durationS": 1_733},
    ],
    "activeRun": {
        "jobId": "job-gym-0005",
        "examId": "exam-0058",
        "round": 44,
        "state": "completed",
        "mode": "harness-debug",
        "edits": [
            {"file": "src/lib/uploadQueue.ts", "added": 41, "removed": 18, "rounds": 6},
            {"file": "src/lib/backoff.ts", "added": 22, "removed": 4, "rounds": 3},
            {"file": "tests/uploadQueue.test.ts", "added": 63, "removed": 0, "rounds": 4},
            {"file": "src/app/routes/upload.tsx", "added": 9, "removed": 9, "rounds": 2},
        ],
        "checks": [
            {"name": "eslint", "verdict": "pass", "kind": "measured", "before": 14, "after": 12},
            {"name": "tsc", "verdict": "pass", "kind": "live", "before": None, "after": None},
            {"name": "vitest", "verdict": "pass", "kind": "live", "before": None, "after": None},
            {"name": "react-doctor", "verdict": "excluded", "kind": "pre-broken", "before": None, "after": None},
        ],
        "extensions": [
            {"round": 24, "requested": 400_000, "verdict": "granted", "reason": "boundary check passed, work in progress"},
            {"round": 31, "requested": 400_000, "verdict": "granted", "reason": "boundary check passed, work in progress"},
            {"round": 38, "requested": 400_000, "verdict": "granted", "reason": "boundary check passed, work in progress"},
            {"round": 42, "requested": 400_000, "verdict": "refused", "reason": "boundary check failed, no edit in the last two rounds"},
        ],
        "boundary": [
            {"round": 24, "result": "pass", "detail": "edits inside scope, no gold strings"},
            {"round": 31, "result": "pass", "detail": "edits inside scope, no gold strings"},
            {"round": 38, "result": "pass", "detail": "edits inside scope, no gold strings"},
            {"round": 42, "result": "fail", "detail": "no edit in the last two rounds"},
        ],
        "criteriaAudit": [
            {"criterion": "scope respected", "result": "pass", "detail": "4 files touched, all inside the declared scope"},
            {"criterion": "gates pass on submit", "result": "pass", "detail": "eslint measured down 14 to 12, tsc and vitest green"},
            {"criterion": "no gold leakage", "result": "pass", "detail": "forbidden-strings guard clean across 44 rounds"},
            {"criterion": "quarantine held", "result": "pass", "detail": "mode harness-debug, zero scored writes"},
            {"criterion": "rubric present", "result": "pass", "detail": "five-axis rubric attached before grading"},
        ],
        "rollbacks": [
            {"round": 29, "discardedEdits": 3, "reason": "gate regression, tsc"},
        ],
    },
    "ledger": {
        "mode": "harness-debug",
        "scoredWrites": 0,
        "drawnFromResultFiles": 6,
        "rowsWritten": 5,
        "certifications": [
            {"examId": "exam-0058", "verdict": "pass", "attempt": 9, "scored": False},
        ],
        # Present because the v4 codified ledger shape carries it. The exams
        # screen deliberately reads examList instead: the bank is examList's
        # job, and two sources for one list is how they drift apart.
        "exams": EXAMS,
    },
}

BOARD_ROWS: list[dict[str, Any]] = [
    {
        "id": "f-0031",
        "ts": "2026-08-16T09:12:04Z",
        "source": "watcher",
        "severity": "critical",
        "category": "health",
        "target": "served-model-id",
        "evidence": "job-gym-0005#ev-1188",
        "status": "open",
        "summary": "Served model id drifted from the pinned id on the student role.",
        "thread": [
            {"at": "2026-08-16T09:12:04Z", "by": "watcher", "text": "pinned glm-4.6, served glm-4.5-air on 3 of 40 calls"},
        ],
    },
    {
        "id": "f-0030",
        "ts": "2026-08-16T08:47:51Z",
        "source": "watcher",
        "severity": "warn",
        "category": "gates",
        "target": "react-doctor",
        "evidence": "job-gym-0005#ev-0904",
        "status": "triaged",
        "summary": "Dead-gate transition, live to pre-broken.",
        "thread": [
            {"at": "2026-08-16T08:47:51Z", "by": "watcher", "text": "react-doctor failed on baseline and candidate alike"},
            {"at": "2026-08-16T08:59:12Z", "by": "auditor", "text": "verdict: reclassify as measured, GATE_METRIC:down:0. Dead coverage otherwise."},
        ],
    },
    {
        "id": "f-0029",
        "ts": "2026-08-16T08:31:19Z",
        "source": "engine",
        "severity": "info",
        "category": "cycles",
        "target": "exam-0058",
        "evidence": "job-gym-0005#ev-0771",
        "status": "resolved",
        "summary": "Extension refused at round 42, boundary check failed.",
        "thread": [
            {"at": "2026-08-16T08:31:19Z", "by": "engine", "text": "no edit in the last two rounds, extension refused"},
            {"at": "2026-08-16T08:36:02Z", "by": "auditor", "text": "verdict: correct refusal, natural stop reached. Resolved."},
        ],
    },
    {
        "id": "f-0028",
        "ts": "2026-08-16T07:58:40Z",
        "source": "auditor",
        "severity": "warn",
        "category": "brain-drift",
        "target": "/Users/owner/code/lantern-ios",
        "evidence": "job-init-0003#ev-0442",
        "status": "open",
        "summary": "Sampled citation validation dropped 4 of 30 claims.",
        "thread": [
            {"at": "2026-08-16T07:58:40Z", "by": "auditor", "text": "4 units cite paths that no longer exist. Recommend a Layer 2 pass on Packages/Core."},
        ],
    },
    {
        "id": "f-0027",
        "ts": "2026-08-16T07:41:03Z",
        "source": "watcher",
        "severity": "warn",
        "category": "ledger",
        "target": "orphaned-artifacts",
        "evidence": "job-gym-0004#ev-0210",
        "status": "open",
        "summary": "Drawn cohort counted from result files reads 6, rows written 5.",
        "thread": [
            {"at": "2026-08-16T07:41:03Z", "by": "watcher", "text": "one drawn exam left no row, consistent with a cap death"},
        ],
    },
    {
        "id": "f-0026",
        "ts": "2026-08-16T07:02:55Z",
        "source": "watcher",
        "severity": "info",
        "category": "health",
        "target": "ttft",
        "evidence": "job-init-0003#ev-0031",
        "status": "resolved",
        "summary": "Teacher role TTFT drifted above the 900 ms band, recovered.",
        "thread": [
            {"at": "2026-08-16T07:02:55Z", "by": "watcher", "text": "TTFT 1,240 ms on 2 pings"},
            {"at": "2026-08-16T07:20:11Z", "by": "auditor", "text": "verdict: transient, provider side. Resolved."},
        ],
    },
]

# Findings the mock pushes as boardFinding notifications. They are NOT job
# scoped and arrive with no job running, which is exactly the case the TUI has
# to handle: the first one is critical and must surface immediately.
BOARD_FINDING_PUSHES: list[dict[str, Any]] = [
    {
        "ts": "2026-08-16T09:31:00Z",
        "source": "watcher",
        "severity": "critical",
        "category": "health",
        "target": "embedding-identity",
        "evidence": "watch-0044#ev-0007",
        "status": "open",
        "summary": "Index digest does not match the served embedder.",
    },
    {
        "ts": "2026-08-16T09:31:06Z",
        "source": "watcher",
        "severity": "warn",
        "category": "gates",
        "target": "playwright",
        "evidence": "watch-0044#ev-0009",
        "status": "open",
        "summary": "Gate unavailable, browser binaries missing.",
    },
    {
        "ts": "2026-08-16T09:31:12Z",
        "source": "auditor",
        "severity": "info",
        "category": "ledger",
        "target": "quarantine",
        "evidence": "watch-0044#ev-0011",
        "status": "triaged",
        "summary": "Quarantine held across the last cycle, zero scored writes.",
    },
]

AGENT_FILES: dict[str, dict[str, Any]] = {
    "student": {
        "content": (
            "# Student\n\n"
            "You work inside a sandboxed worktree. Read the brain before you edit.\n"
            "Integration first: make the change reach its call sites in the same round\n"
            "it is written. Respect the declared scope; edits outside it are discarded.\n"
        ),
        "defaultHash": "sha256:1a4f9c",
        "currentHash": "sha256:1a4f9c",
        "modified": False,
    },
    "teacher": {
        "content": (
            "# Teacher\n\n"
            "Grade blind on five axes with citations and gap tags. You never see the\n"
            "student's reasoning, only its diff and its gate results.\n\n"
            "2026-08-16, dated in place: the evidence axis now requires a cited path\n"
            "that resolves in the repo. The earlier wording accepted a plausible path,\n"
            "which is WITHDRAWN rather than deleted so the change is readable.\n"
        ),
        "defaultHash": "sha256:0c31ea",
        "currentHash": "sha256:77b0d2",
        "modified": True,
    },
    "auditor": {
        "content": (
            "# Auditor\n\n"
            "Scheduled judgment, never silent action. Triage watcher findings with a\n"
            "written verdict. Spend and destructive actions always need the user's hand.\n"
        ),
        "defaultHash": "sha256:be1147",
        "currentHash": "sha256:be1147",
        "modified": False,
    },
    "watcher": {
        "content": (
            "# Watcher\n\n"
            "Continuous detection, never judgment, never action. Cheapest model.\n"
            "Beat: health, gates, live cycles, ledger. Report, do not decide.\n\n"
            "Era note, 2026-08-16: extension grants moved to 400k x8, so the old\n"
            "cap-event thresholds in this file no longer describe the harness.\n"
        ),
        "defaultHash": "sha256:5d7c11",
        "currentHash": "sha256:39aa08",
        "modified": True,
    },
}

SETTINGS: dict[str, Any] = {
    "roles": [
        {
            "role": "engineer",
            "preset": "GLM",
            "model": "glm-4.6",
            "endpoint": "https://open.bigmodel.cn/api/paas/v4",
            "keyRef": "env:DAIJIN_ENGINEER_KEY",
            "keyMasked": "mk-mock-********9f2a",
            "ping": {
                "httpStatus": 200,
                "ttftMs": 412,
                "latencyMs": 1_884,
                "servedModelId": "glm-4.6",
                "at": "2026-08-16T09:04:11Z",
            },
        },
        {
            "role": "teacher",
            "preset": "Claude",
            "model": "claude-opus-5",
            "endpoint": "https://api.anthropic.com/v1",
            "keyRef": "env:DAIJIN_TEACHER_KEY",
            "keyMasked": "mk-mock-********c4d1",
            "ping": {
                "httpStatus": 200,
                "ttftMs": 688,
                "latencyMs": 3_102,
                "servedModelId": "claude-opus-5",
                "at": "2026-08-16T09:04:14Z",
            },
        },
        {
            "role": "auditor",
            "preset": "GPT",
            "model": "gpt-5.2",
            "endpoint": "https://api.openai.com/v1",
            "keyRef": "env:DAIJIN_AUDITOR_KEY",
            "keyMasked": "mk-mock-********1b70",
            "ping": {
                "httpStatus": 200,
                "ttftMs": 733,
                "latencyMs": 2_540,
                "servedModelId": "gpt-5.2-2026-05-01",
                "at": "2026-08-16T09:04:18Z",
            },
        },
        {
            "role": "watcher",
            "preset": "DeepSeek",
            "model": "deepseek-v4",
            "endpoint": "https://api.deepseek.com/v1",
            "keyRef": "env:DAIJIN_WATCHER_KEY",
            "keyMasked": "mk-mock-********0ae3",
            "ping": None,
        },
    ],
    "retrieval": {
        "tokenBudget": 4000,
        "k": 10,
        "rrfK": 60,
        "perCandidateCapRatio": 0.22,
        "slotFloor": 0.55,
        "standingOutsideBudget": True,
    },
    # The v4 codified settings shape carries instructionFiles alongside the
    # agentFile* methods. Both describe the same four files; the settings screen
    # reads agentFileGet, which also carries the content the editor needs.
    "instructionFiles": [
        {
            "name": name,
            "path": f".daijin/agents/{name}.md",
            "hash": record["currentHash"],
            "defaultHash": record["defaultHash"],
            "modified": record["modified"],
        }
        for name, record in AGENT_FILES.items()
    ],
    "storage": {"driver": "sqlite-vec", "embedder": "bge-m3", "dimension": 1024},
    "spendGate": dict(SPEND_GATE),
    "charts": {"radarMode": "radar", "motion": "full"},
}

# budgetEstimate is a contract method as of v5, and it is ZERO-SPEND on purpose:
# an estimate that itself called a provider would defeat the dialog it feeds.
# Keyed by (repoPath, mode). basis is the one-line derivation the dialog shows,
# so the user can see where the number came from rather than trusting it.
BUDGET_ESTIMATE: dict[tuple[str, str], dict[str, Any]] = {
    ("/Users/owner/code/orchard-web", "layer1+layer2"): {
        "estimatedTokens": 736_000,
        "basis": "578 files, 3,184 commits, 138 narration calls at about 5,300 tokens each",
    },
    ("/Users/owner/code/lantern-ios", "layer1+layer2"): {
        "estimatedTokens": 471_000,
        "basis": "254 files, 1,042 commits, 88 narration calls at about 5,350 tokens each",
    },
    ("/Users/owner/code/kiln-api", "layer1+layer2"): {
        "estimatedTokens": 339_000,
        "basis": "200 files, 617 commits, 63 narration calls at about 5,380 tokens each",
    },
    ("/Users/owner/code/orchard-web", "gym"): {
        "estimatedTokens": 412_000,
        "basis": "tier M exam, 44 rounds at the ADR-0167 defaults, 4,000 token context each round",
    },
    ("/Users/owner/code/lantern-ios", "gym"): {
        "estimatedTokens": 604_000,
        "basis": "tier L exam, 44 rounds at the ADR-0167 defaults, 6,000 token context each round",
    },
}


def init_script(job_id: str, repo_path: str, mode: str) -> list[dict[str, Any]]:
    """Build the init step-event stream.

    Shape per the frozen contract: { ts, jobId, phase, step, detail, counts?, level }.
    ts is a millisecond offset from the job start in the mock; the real engine's
    clock convention is an open question.
    """

    def ev(offset_ms, phase, step, detail, counts=None, level="info"):
        row = {
            "ts": offset_ms,
            "jobId": job_id,
            "phase": phase,
            "step": step,
            "detail": detail,
            "level": level,
        }
        if counts is not None:
            row["counts"] = counts
        return row

    layer2 = mode == "layer1+layer2"
    ingest = mode == "ingest"
    events: list[dict[str, Any]] = [
        ev(0, "verify-roles", "check", "engineer, glm-4.6, last verified 09:04", {"ready": 1, "of": 4}),
        ev(420, "verify-roles", "check", "teacher, claude-opus-5, last verified 09:04", {"ready": 2, "of": 4}),
        ev(880, "verify-roles", "check", "auditor, gpt-5.2, served id gpt-5.2-2026-05-01", {"ready": 3, "of": 4}),
        ev(1_330, "verify-roles", "check", "watcher never verified, layer 1 needs no key", {"ready": 3, "of": 4}, "warn"),
        ev(1_700, "identify", "git-walk", f"reading history of {repo_path}", {"commits": 0}),
        ev(2_200, "identify", "git-walk", "walking git log with numstat", {"commits": 617}),
        ev(2_600, "identify", "languages", "Python 82 percent, SQL 11 percent, Shell 7 percent", {"languages": 3}),
        ev(2_900, "identify", "structure", "single package, 200 files, 4 top directories", {"files": 200}),
        ev(3_250, "identify", "gates", "probing package manifests and CI configs", {"candidates": 2}),
        ev(3_600, "identify", "gates", "ruff live, pytest live, 0 pre-broken", {"live": 2, "preBroken": 0}),
    ]

    if ingest:
        events += [
            ev(4_000, "brain", "ingest", "existing agent folder found, ingesting as is", {"files": 9}),
            ev(4_500, "brain", "drift-check", "auditor sampling claims for validation", {"sampled": 30}),
            ev(5_200, "brain", "drift-check", "26 claims validated, 4 cited paths missing", {"validated": 26, "dropped": 4}, "warn"),
        ]
    else:
        events += [
            ev(4_000, "brain", "layer1", "building the import graph", {"edges": 0}),
            ev(4_450, "brain", "layer1", "import graph, function definitions and call sites", {"edges": 1_204, "symbols": 863}),
            ev(4_900, "brain", "layer1", "dependency census and co-change clusters", {"deps": 41, "clusters": 12}),
            ev(5_350, "brain", "layer1", "conventions measured statistically", {"conventions": 7}),
            ev(5_800, "brain", "layer1", "architecture cards written from evidence", {"units": 18}),
        ]
        if layer2:
            events += [
                ev(6_300, "brain", "layer2", "auditor narrating prose over the evidence tables", {"proposed": 0}),
                ev(7_100, "brain", "layer2", "commit archaeology into decision candidates", {"proposed": 14}),
                ev(7_900, "brain", "layer2", "doc distillation", {"proposed": 22}),
                ev(8_500, "brain", "validate", "validating every citation against the repo", {"checked": 22}),
                ev(9_100, "brain", "validate", "19 accepted, 3 dropped for missing citations", {"accepted": 19, "dropped": 3}, "warn"),
                ev(9_300, "brain", "errors", "no history of fix or revert commits, errors.md starts empty", {"lessons": 0}),
            ]
        else:
            events += [
                ev(6_300, "brain", "errors", "layer 1 only, errors.md starts empty", {"lessons": 0}),
            ]

    events += [
        ev(9_600, "chunk-embed", "chunk", "chunking with type cores preserved", {"chunks": 0}),
        ev(10_200, "chunk-embed", "chunk", "content-survival gate on typed cores", {"chunks": 1_482, "survived": 1_482}),
        ev(10_900, "chunk-embed", "embed", "bge-m3, dimension 1024, local", {"embedded": 512, "of": 1_482}),
        ev(11_700, "chunk-embed", "embed", "bge-m3, dimension 1024, local", {"embedded": 1_482, "of": 1_482}),
        ev(12_200, "chunk-embed", "store", "writing the per repo sqlite-vec store", {"bytes": 21_884_416}),
        ev(12_500, "chunk-embed", "identity", "index digest matches the served embedder", {"dimension": 1024}),
        ev(12_900, "gold-set", "mine", "commit archaeology cases", {"cases": 10}),
        ev(13_400, "gold-set", "mine", "structural self reference cases", {"cases": 15}),
        ev(13_800, "gold-set", "mine", "identifier cases", {"cases": 9}),
        ev(14_200, "gold-set", "gates", "existence, leakage, staleness, provenance, diversity", {"passed": 5, "of": 5}),
        ev(14_600, "gold-set", "certify", "auditor certifies the gauge fit to measure", {"cases": 34, "pointsPerCase": 1 / 34}),
        ev(15_000, "retrieval-floor", "sweep", "budget 3,000, 28 of 34", {"hits": 28, "cases": 34}),
        ev(15_900, "retrieval-floor", "sweep", "budget 4,000, 31 of 34", {"hits": 31, "cases": 34}),
        ev(16_800, "retrieval-floor", "sweep", "budget 6,000, 31 of 34", {"hits": 31, "cases": 34}),
        ev(17_700, "retrieval-floor", "sweep", "budget 8,000, 30 of 34", {"hits": 30, "cases": 34}),
        ev(18_100, "retrieval-floor", "pick", "smallest budget within one case of best, 4,000", {"chosenBudget": 4_000}),
        ev(18_500, "retrieval-floor", "score", "case rate 31 of 34, MRR 0.612 recorded, 0 violations", {"hits": 31, "cases": 34, "violations": 0}),
        ev(18_900, "mcp-unlock", "unlock", "floor above the 0.75 threshold, MCP unlocked", {"hits": 31, "cases": 34}),
        ev(19_200, "mcp-unlock", "snippet", "paste ready MCP snippet available from mcpSnippet", None, "info"),
        ev(19_400, "done", "complete", "brain ready", {"units": 37, "chunks": 1_482, "cases": 34}, "info"),
    ]
    return events


def gym_script(job_id: str, exam_id: str) -> list[dict[str, Any]]:
    """Build the gym step-event stream, same shape as the init stream."""

    def ev(offset_ms, phase, step, detail, counts=None, level="info"):
        row = {
            "ts": offset_ms,
            "jobId": job_id,
            "phase": phase,
            "step": step,
            "detail": detail,
            "level": level,
        }
        if counts is not None:
            row["counts"] = counts
        return row

    return [
        ev(0, "draw", "draw", f"{exam_id} drawn from the bank, tier M", {"drawn": 1}),
        ev(300, "draw", "worktree", "worktree at base commit 9f2ac1d", None),
        ev(900, "draw", "baseline", "baseline gates pass on base, eslint 14 warnings", {"gates": 3, "preBroken": 1}),
        ev(1_300, "draw", "guard", "forbidden-strings guard armed with gold", {"strings": 11}),
        ev(1_700, "rounds", "round", "round 1, reading the brain", {"round": 1, "tokens": 8_400}),
        ev(2_100, "rounds", "search", "brain_search, upload queue ordering", {"round": 1, "tokens": 11_100, "chunks": 6}),
        ev(2_600, "rounds", "edit", "src/lib/uploadQueue.ts, +18 -4", {"round": 3, "tokens": 24_700}),
        ev(3_100, "rounds", "check", "tsc pass, vitest pass", {"round": 3, "tokens": 26_200}),
        ev(3_700, "rounds", "edit", "src/lib/backoff.ts, +22 -4", {"round": 7, "tokens": 48_900}),
        ev(4_200, "rounds", "check", "eslint 14 to 13, measured down", {"round": 7, "tokens": 51_300}),
        ev(4_800, "rounds", "edit", "tests/uploadQueue.test.ts, +63 -0", {"round": 12, "tokens": 88_600}),
        ev(5_400, "rounds", "boundary", "round 24 boundary check, edits inside scope", {"round": 24, "tokens": 168_200}),
        ev(5_800, "rounds", "extension", "extension granted, 400,000 tokens", {"round": 24, "granted": 1, "tokens": 168_200}),
        ev(6_400, "rounds", "rollback", "gate regression on tsc, 3 edits discarded", {"round": 29, "discarded": 3, "tokens": 205_400}, "warn"),
        ev(7_000, "rounds", "boundary", "round 31 boundary check, edits inside scope", {"round": 31, "tokens": 241_800}),
        ev(7_400, "rounds", "extension", "extension granted, 400,000 tokens", {"round": 31, "granted": 2, "tokens": 241_800}),
        ev(8_000, "rounds", "edit", "src/app/routes/upload.tsx, +9 -9", {"round": 34, "tokens": 288_100}),
        ev(8_600, "rounds", "boundary", "round 38 boundary check, edits inside scope", {"round": 38, "tokens": 331_500}),
        ev(9_000, "rounds", "extension", "extension granted, 400,000 tokens", {"round": 38, "granted": 3, "tokens": 331_500}),
        ev(9_600, "rounds", "boundary", "round 42 boundary check failed, no edit in two rounds", {"round": 42, "tokens": 388_700}, "warn"),
        ev(10_000, "rounds", "extension", "extension refused, natural stop", {"round": 42, "refused": 1, "tokens": 388_700}, "warn"),
        ev(10_600, "submit", "submit", "submit rehearsal, student meets its judge", {"round": 44, "tokens": 397_100}),
        ev(11_200, "submit", "gates", "eslint 14 to 12, tsc pass, vitest pass", {"passed": 3, "of": 3}),
        ev(11_800, "submit", "grade", "teacher grading blind on five axes", {"tokens": 401_900}),
        ev(12_400, "submit", "grade", "correctness 0.82, integration 0.74, conventions 0.91", None),
        ev(12_900, "submit", "grade", "evidence 0.63, restraint 0.88, verdict pass", None),
        ev(13_400, "audit", "criteria", "scope respected, 4 files inside the declared scope", {"passed": 1, "of": 5}),
        ev(13_800, "audit", "criteria", "gates pass on submit", {"passed": 2, "of": 5}),
        ev(14_200, "audit", "criteria", "no gold leakage across 44 rounds", {"passed": 3, "of": 5}),
        ev(14_600, "audit", "criteria", "quarantine held, mode harness-debug, 0 scored writes", {"passed": 4, "of": 5}),
        ev(15_000, "audit", "criteria", "rubric present before grading", {"passed": 5, "of": 5}),
        ev(15_400, "audit", "denominator", "drawn cohort counted from result files, 6 drawn 5 rows", {"drawn": 6, "rows": 5}, "warn"),
        ev(15_800, "done", "complete", "cycle complete, verdict pass, nothing scored", {"tokens": 401_900, "rounds": 44}),
    ]


def gates_script(job_id: str, repo_path: str) -> list[dict[str, Any]]:
    """gatesDiscover streams on the same channel as init and gym."""

    def ev(offset_ms, phase, step, detail, counts=None, level="info"):
        row = {"ts": offset_ms, "jobId": job_id, "phase": phase, "step": step, "detail": detail, "level": level}
        if counts is not None:
            row["counts"] = counts
        return row

    return [
        ev(0, "probe", "manifest", "reading package.json scripts", {"candidates": 4}),
        ev(500, "probe", "ci", "reading .github/workflows", {"candidates": 5}),
        ev(900, "probe", "make", "no Makefile", {"candidates": 5}),
        ev(1_400, "baseline", "run", "eslint on baseline, exit 1, 14 warnings", {"ran": 1, "of": 5}),
        ev(2_100, "baseline", "run", "tsc on baseline, exit 0", {"ran": 2, "of": 5}),
        ev(3_000, "baseline", "run", "vitest on baseline, exit 0, 318 tests", {"ran": 3, "of": 5}),
        ev(3_700, "baseline", "run", "react-doctor on baseline, exit 1", {"ran": 4, "of": 5}),
        ev(4_200, "baseline", "run", "playwright, exit 127, command not found", {"ran": 5, "of": 5}, "warn"),
        ev(4_700, "classify", "classify", "eslint measured, pre-existing violations, GATE_METRIC:down:0", {"measured": 1}),
        ev(5_100, "classify", "classify", "tsc live, vitest live", {"live": 2}),
        ev(5_600, "classify", "classify", "react-doctor pre-broken, excluded and labelled", {"preBroken": 1}, "warn"),
        ev(6_000, "classify", "classify", "playwright unavailable", {"unavailable": 1}, "warn"),
        ev(6_400, "done", "complete", f"gates.yaml written for {repo_path}", {"gates": 5}),
    ]
