# Daijin TUI (P5 shell)

A Python Textual client for the Daijin engine, built against RPC contract
**v5** (`engine/src/rpc/methods.md`). It is a pure client: every value on
screen comes from a contract method or from a server notification. The TUI
computes no brain data, scores no retrieval, and makes no network calls of its
own.

The engine does not exist yet, so the package ships a mock engine that speaks
the same JSON-RPC 2.0 envelopes, serves every v5 method, and emits both
notification streams. Every screen renders against it today.

## Run it

```
cd tui
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
.venv/bin/daijin . --mock
```

Useful flags:

- `--mock` run against the bundled mock engine (required until an engine exists)
- `--mock-speed 0.2` compress the step-event stream timing, `0` emits instantly
- `--mock-gate open` the explicit demo flag: opens the simulated owner spend
  gate so `gymStart`'s confirmed path is reachable in the mock. **Blocked is the
  default**, matching the product rule that the gate moves by the owner's hand
- `--mock-contract 99` make the mock report a different contract version, which
  renders the upgrade screen
- `--engine 'node engine/src/rpc/daemon.js'` talk to the real engine daemon over
  stdio. `daemon.js` is the process entry point; `server.js` is the library it
  imports, and launching that gets a process that exits 0 without ever answering

The mock engine can also run as a real stdio server, which is how the stdio
client is tested end to end:

```
.venv/bin/python -m daijin_tui.rpc --speed 0
```

## Tests

```
cd tui && .venv/bin/python -m pytest
```

## Spend model

The contract enumerates the spend-touching methods exhaustively: `gymStart`,
`rolePing`, `initBrain` with mode `layer1+layer2`, and `diagnoseNarrate`. The
client carries that same list in `rpc.SPEND_TOUCHING`, and a test parses the
sentence out of `methods.md` and fails if the two ever disagree.

Four rules hold in the shell:

1. **Nothing spends on a screen opening.** A test walks all eight views, mounts
   and reloads each, and asserts the engine recorded zero spend-touching calls.
2. **Every paid call carries `confirm: true`, collected on that call.** The
   dialog shows what it costs and returns "no" on escape, so walking away never
   spends. `initBrain layer1+layer2` additionally echoes the `budget` the user
   was shown, so what was agreed to is recorded, not just that something was.
3. **An open gate is not consent.** Since v5 the engine refuses an unconfirmed
   spend-touching call with `-32050` even when the owner gate is open. The gate
   is permission to spend at all; the dialog is permission for this call. The
   gym asks even when the gate reads open, and a parametrized test asserts all
   four methods refuse without confirmation.
4. **The client never pre-empts the engine's gate.** The gym screen reads
   `serveStatus().spendGate` and says the gate reads blocked, but it leaves the
   button live: the engine is the authority on its own gate, and a greyed-out
   button would hide the engine's own refusal text when the client's reading is
   stale.

The number in every spend dialog comes from `budgetEstimate`, which is
zero-spend by construction, and its `basis` line is displayed alongside it: an
estimate the user cannot trace is one they can only take on trust, and this
dialog exists to be trusted.

## Value conventions

`caseRate` is `{ exact, cases }`. The shell shows the **count form** ("31 of
34") and never a bare rounded percentage, because a rounded percentage hides its
own denominator. `case_rate_value` accepts `exact` as either a number or an
`"n/m"` string, since the contract calls it "the rational value" without fixing
its JSON type. `mrr` is labelled recorded-for-movement everywhere it appears and
is never presented as a floor. `caseRate` and `violations` are the enforced
floors.

## Navigation

Number keys 1 through 8 and clicks on the nav bar reach the same eight views.

| key | view | RPC methods it reads |
| --- | --- | --- |
| 1 | Repo home | `serveStatus`, `analyze`, `retrievalScore`, `scoreHistory`, `repoAttach`, `repoDetach` |
| 2 | Init activity feed | `initBrain`, `budgetEstimate`, `jobCancel`, plus the step stream |
| 3 | Brain, inventory, tester, diagnosis | `retrievalScore`, `documents`, `search`, `mcpSnippet`, `diagnose`, `diagnoseNarrate` |
| 4 | Gates | `gatesGet`, `gatesSet`, `gatesDiscover`, plus the step stream |
| 5 | Gym | `gymStatus`, `gymStart`, `budgetEstimate`, `jobCancel`, `serveStatus`, plus the step stream |
| 6 | Exams | `examList`, `examDetail`, `examVeto`, `examUpdate`, `settingsGet/Set` |
| 7 | Board | `board`, plus `boardFinding` notifications |
| 8 | Settings | `settingsGet/Set`, `rolePing`, `agentFileGet/Set` |

Other keys: `ctrl+r` reloads the current view, `r` on the exams screen switches
the radar between the unicode canvas and the horizontal-bar fallback, `q` quits,
`?` opens the key panel.

## Deferred engine capabilities

The engine answers a contract method whose capability has not shipped yet with
`-32001` and a `data.phase` such as `P4 (gym port)`. That is not a failure, so
the shell does not dress it as one: the screen's banner reads "Not built yet. It
arrives in P4 (gym port)" followed by the engine's hint verbatim, and the toast
is informational. `-32601` stays reserved for a method absent from the contract
entirely, which on a frozen surface should never happen and is surfaced loudly.

The reason this matters is what it looked like before: against the real daemon
the exams screen rendered a bare table header with a blank banner, which a user
cannot tell apart from "there are no exams". A test now asserts that every
deferred capability leaves a banner naming its phase, and a second asserts a
genuine error is still styled as an error.

## Notifications

Two channels. `step` carries the job-scoped jsonl event that drives the init
feed, the gym live view, and gates discovery. `boardFinding` is **not** job
scoped and arrives with no job running, so it is handled at the app level: a
`critical` finding rings the bell and raises a toast on whatever screen the user
is looking at, without navigating them away. Lower severities render on the
board view only.

## Layout

```
daijin_tui/
  app.py            App shell, modes, handshake, critical-finding notifications
  rpc.py            JSON-RPC client (stdio and in process), MockEngine, stdio server
  mock_data.py      Mock fixtures and the three step-event scripts
  daijin.tcss       Styles
  screens/          One module per view, plus dialogs.py and upgrade.py
  widgets/          Reusable widgets, each chart with a pure renderer
tests/              pytest suite, no async plugin required
```

Every chart exposes a pure function that returns a list of strings
(`sparkline`, `radar_lines`, `bar_lines`, `plot_bar`, `plot_line`), so the
drawing is asserted in a test without a running app.

## Two series that are never conflated

The repo card sparkline is the floor **over time**, from `scoreHistory`, which
arrives newest first and is drawn oldest to newest. The **budget sweep** is one
measurement across budgets, from `retrievalScore(sweep=true)`, and it lives on
the brain view under its own caption. They answer different questions, and
drawing them under one caption would invite reading a sweep as progress.

## Method coverage

Every request method the v5 method tables declare is served by the mock and
called by a screen. A test parses the tables (30 methods at v5; the
tables are the count, not this sentence), asserts each has a
`MockEngine` handler and a call site in `screens/` or `app.py`, and fails if the
parse itself finds nothing, so a broken parse cannot pass vacuously. `hello` is
the one exception, checked at its real call site in `RpcClient.handshake`.

## Gaps the contract does not cover

None remain. v5 closed the last two: `examList` rows now carry a `title`, which
the bank renders, and `budgetEstimate` supplies the spend dialog's numbers.

A stub that outlives its gap is worse than no stub, because it is false on
screen. That is exactly what the document-inventory stub became when v4 added
`documents`, so a test fails if any `StubPanel` denies the existence of a method
the contract declares. With no stubs left the check would be vacuous, so it
first runs its own detector against a synthetic offender and fails if that does
not trip: a dead gate is worse than no gate.

Filter keys get the same treatment from the engine side. `documents` accepts
exactly `q`, `type`, and `area`, and an unknown key is an error rather than
being ignored, because an ignored filter returns the whole inventory while
reading as "nothing matched".

## Constraints held

No em dashes or en dashes anywhere, checked by a test that scans both the source
and the composited screen output of all eight views. No network calls, no
provider calls, no spend. Nothing is written outside this directory.
