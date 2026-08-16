# Gym RPC shapes: what the six deferred methods call, and what they return

Handover from gym-porter to the extractor, who owns `engine/src/rpc/methods.js`. The six gym
methods there currently answer `-32001` with `data.phase` P4. Everything they need now exists.

This document is the CALL SHAPE only. It changes no contract: `methods.md` v5 already states
the wire shapes, and where this document and v5 disagree, v5 wins and this is the stale one.

Nothing here spends. Every module below runs against injected providers, and the one paid
seam (the student) is `engineer.next()`, which the daemon supplies.

## Imports

```js
import { GymLedger, gymDatabasePath } from '../gym/ledger.js';
import { runGymCycle, runExamAttempt } from '../gym/cycle.js';
import { examListRow, parseExamRecord, quarantineExam, vetoExam } from '../gym/exams.js';
import { loadResultFiles } from '../gym/result-files.js';
import { assertSpendGate } from '../gym/spend-gate.js';
import { studentRules } from '../gym/agent-files.js';
import { resolveBudgetPolicy } from '../gym/budget.js';
```

The ledger is synchronous (better-sqlite3) and opens per repo:

```js
const ledger = GymLedger.open(gymDatabasePath(repoPath));
```

It REFUSES to open a database carrying brain tables, so a mis-pointed path fails loudly on
open rather than growing gym tables inside a user's brain.

## `gymStart({ repoPath, config, confirm })` -> `{ jobId }`

Order matters and is already right in your file: gate first, then consent, then work. Keep it.

```js
await assertSpendGate('gym-cycle', { repoPath });          // -32050 with data.gate
requireConsent('gymStart', params, '...');                 // -32050, yours, unchanged

const ledger = GymLedger.open(gymDatabasePath(repoPath));
const exams = ledger.listExams({ benchmarkStatus: 'active', status: 'promoted' });
// Draw is the caller's policy (rotation, cohort size). examDrawRefusal() in exams.js is the
// per-exam guard and runExamAttempt calls it again, so a bad draw fails before any spend.

const job = jobs.start(async ({ logger, abortSignal }) => runGymCycle({
  exams: drawn,                       // full records from ledger.getExam(), not list rows
  mode: config.mode ?? 'harness-debug',
  cohort: config.cohort ?? 'training',
  ledger,
  gates,                              // from the discovered gates.yaml, as data
  engineer,                           // THE PROVIDER SEAM: { next(context) -> action }
  rules: await studentRules(repoPath),
  documents,                          // brain documents; required for a certifiable run
  retrieveContext: async ({ query, excludeDocumentIds }) =>
    formatContext(await retrieve({ query, excludeDocumentIds, ... })),
  policy: config.policy ?? {},        // resolveBudgetPolicy validates; throws on a bad one
  repoPath,
  sourceRepo: repoPath,
  engineRoot,
  sandboxesRoot,
  resultDir,
  logger,                             // your jobs logger; step events are already the shape
  emitFinding,                        // async (finding) => void, boardFinding notification
  abortSignal,                        // jobCancel wires here
}));
return { jobId: job.id };
```

Two things to know rather than discover:

- `runGymCycle` CLOSES THE GATE when the cycle ends (`closeGateAfter`, default true). One
  authorization spends once, the platform's discipline. Pass `closeGateAfter: false` only if
  the owner asks for a multi-cycle authorization, which is a product decision, not a default.
- `documents` is optional and its absence is not an error: a repo with no brain still runs.
  What it cannot do is earn a certification, because certification requires the exclusion
  record that computing over documents produces.

### The engineer seam

```js
engineer.next({ prompt, sandbox, examId, mode, round, workTokens, tokenCap, extensionsGranted, forced, message })
  -> { kind: 'edit' | 'read' | 'check' | 'submit', tokens, created?: string[], explanation? }
```

`tokens` is the work tokens the round consumed, read from provider usage. `message` is
harness feedback from the previous round (a pre-seal warning, a rehearsal refusal, a refused
submit) and a live driver appends it to the transcript. `created` declares files the student
created, without which a new file is invisible to the worktree diff.

## `gymStatus({ jobId? })` -> `{ cycles, activeRun?, ledger }`

```js
const files = await loadResultFiles(resultDir);        // null when the set cannot be trusted
return {
  cycles: ledger.database.prepare('SELECT * FROM cycle ORDER BY id DESC').all(),
  activeRun: jobs.activeGymRun(jobId) ?? undefined,    // yours; the live view reads it
  ledger: ledger.summary({ resultFiles: files }),      // the v5 payload, exactly
};
```

`ledger.summary()` returns `{ mode, scoredWrites, drawnFromResultFiles, rowsWritten,
certifications, exams }`. `drawnFromResultFiles` is NULL whenever the denominator is not
derivable (no preceding cycle, an untrustworthy file set). Render the null as "not derivable"
and never as 0: a zero that means "four exams vanished" is the exact defect the rule exists
to remove.

## `examList({ filters? })` -> rows

```js
return ledger.listExams(filters ?? {});   // already examListRow shape, v5 fields included
```

Filters accepted: `status`, `benchmarkStatus`, `heldOut`. An empty bank is a legitimate
state, not an error.

## `examDetail({ examId })` -> `{ axes, attempts, provenance }`

```js
const exam = ledger.getExam(examId);
if (!exam) throw invalidParams(...);
const attempts = ledger.database.prepare(
  'SELECT * FROM run WHERE exam_id = ? ORDER BY id DESC').all(examId);
return { exam, attempts, provenance: exam.provenance, axes: gradesFor(attempts) };
```

[REVISED 2026-08-16, after P7 landed. The previous text said grading was not built and told
you to return an empty axes object. Grading exists now; what follows replaces that.]

`axes` is populated from RUBRICS, and a rubric exists only for an attempt a teacher graded.
Three states, and the distinction is the whole point of the field:

| state | `axes` | why |
| --- | --- | --- |
| the attempt has a rubric | the five axis scores with their citations | graded |
| the attempt produced a diff but has no rubric yet | `null` | awaiting grading, which is a real state a TUI should show as such |
| the attempt produced NO diff (`unsubmitted`) | `null`, with the attempt's status saying why | P7 clause 5: no rubric may be written for a run that never answered, so an empty axes object here would imply a grade of zero where there is no grade at all |

Render `null` as "not graded" and never as zeroed axes. An EMPTY OBJECT is a forbidden value
here, per methods.md: zeroed axes on a radar read exactly like measured ones.

[ALIGNED 2026-08-16 to methods.md at 61faf40, finding 79. The three states above were carried
into the contract; the SHAPE is the contract's ruling and differs from what this document
implied.]

WIRE SHAPE: a LIST of `{ name, score, max }` in the canonical five-axis order, not a by-name
object. The wire serves rendering and order matters on a radar, so the order is part of the
payload rather than a convention the client has to know.

The engine's internal keying stays BY NAME, because a validator wants to look an axis up
rather than search for it: `engine/src/gym/grading.js` exports `AXES` as the canonical
ordered five, and a stored rubric carries
`{ runId, axes: { <axis>: { score, citations } }, verdict, gaps, author, reportedAuthor? }`.
Mapping by-name to the ordered list happens at the DAEMON BOUNDARY, which is the extractor's
side:

```js
axes: rubric ? AXES.map((name) => ({ name, score: rubric.axes[name].score, max: 5 })) : null
```

`AXES` is exported in canonical order for exactly this, so the daemon never hand-writes the
order and a sixth axis could not silently arrive out of place.

The rubric and batch TABLES are not in the ledger yet, by ruling: they land with this wiring,
and their shape is specified jointly by the daemon and the gym rather than invented ahead of
the consumer. Until they exist, `examDetail` returns `axes: null` for every attempt, which is
honest rather than empty.

## `examVeto({ examId, reason })` and `examUpdate({ examId, patch })`

```js
ledger.putExam(vetoExam(ledger.getExam(examId), reason));         // >= 20 char reason
ledger.putExam(parseExamRecord({ ...ledger.getExam(examId), ...patch }, examId));
```

`putExam` validates through `parseExamRecord`, so an invalid patch throws before it is
stored. Map that throw to `invalidParams` with the message verbatim: every one of them names
the field and the rule.

Quarantine goes through `quarantineExam(exam, reason)` for the same reason: the parser and
the helper both enforce the 20-character minimum, and a record reaching the store any other
way would carry "broken" as its whole audit trail.

## Error mapping

| condition | code | note |
| --- | --- | --- |
| `SpendRefusedError` from any gym module | its own `-32050` and `data` | already shaped; rethrow as is |
| exam draw refusal (quarantined, vetoed, not promoted, held-out) | `invalidParams` | the message is written for a person and names the reason |
| `parseExamRecord` throw | `invalidParams` | names the field and the rule |
| ledger row refusal (no applied diff) | internal | this is a defect in the caller, not user input |
| `AUDITOR_NOT_WIRED` from `selectBankWithAuditor` | `-32001`, phase P4 | the exam miner's judgment step is deliberately unwired |

## What is deliberately NOT here

- [SUPERSEDED 2026-08-16: this bullet said grading, rubric import and harvest were queued.
  They landed as P7, registered at docs/verification/p7-grading-harvest-acceptance.md, commit
  1cdc2b8. The modules are `grading.js` and `harvest.js`; what remains unwired is their
  STORAGE, per the row above.] Rubric and harvest-batch persistence: the tables land with this
  wiring, specified jointly rather than ahead of the consumer.
- The auditor's exam selection. `selectBankWithAuditor` refuses without an injected auditor
  rather than approximating one, and hands back the completed deterministic funnel so the
  TUI can show the work without the judgment.
- Any spend path other than the student. If wiring one of these methods seems to need a
  provider call, that is a contract change (methods.md error convention), not an
  implementation detail.
